// packages/tlmemory/src/index.ts
// 插件入口与装配中心（阶段六生产版）：
// - 依赖注入：tools / llm / systemPrompt 三服务显式声明；
// - 同步切片：systemPrompt.section 只消费内存预热缓存，严禁异步 I/O；
// - 事件联动：依据 DSH 官方 `session/event` 契约（(session, event) 双参、事件统一
//   { type, seq, time, data } 信封）完成三件事：
//     1. user/message（source.kind === 'user'）同步预热召回缓存 + 广播命中微光；
//     2. assistant/message / turn/start 折叠进 TurnTracker 轮次素材缓冲；
//     3. turn/end（reason.kind === 'completed'）非阻塞派发无感静默沉淀，
//        异步 LLM 提炼 + FTS5 入库，全程 try-catch 静默降级；
// - 可逆注销：全部副作用（切片/工具/监听/服务/数据库）收敛于单一 Disposer。
// Cordis 上下文声明合并统一收敛于 types.ts，此处严禁重复声明以免属性签名冲突。
import type { Context } from 'cordis'
import Schema from 'schemastery'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { MemoryDB } from './db.js'
import { MemoryExtractor } from './extractor.js'
import { registerMemoryTools } from './tools.js'
import { MemoryRecallEngine } from './recall.js'
import { MemoryServer } from './server.js'
import { TurnTracker } from './turn-tracker.js'
import type {
  AssistantMessageEventData,
  SearchResult,
  TurnEndEventData,
  TurnStartEventData,
  UserMessageEventData,
} from './types.js'

// 阶段一交付物再导出（保证包构建产物完整性与回归断言通过）
export { MemoryDB } from './db.js'
export { MemoryExtractor } from './extractor.js'
export { registerMemoryTools } from './tools.js'
// 阶段三/六交付物：嵌入式 REST 与 WebSocket 实时中继服务 + 轮次跟踪器
export { MemoryServer } from './server.js'
export { TurnTracker } from './turn-tracker.js'
export type {
  MemoryNode,
  MemoryScope,
  MemoryCategory,
  SearchOptions,
  SearchResult,
  RawReflectionItem,
  ReflectionResponse,
  SaveMemoryArgs,
  QueryMemoryArgs,
  TurnTrackItem,
} from './types.js'

export interface Config {
  dbPath?: string
  serverPort?: number
  maxRecallCount?: number
  enableAutoReflection?: boolean
  /** 是否启用内嵌 127.0.0.1 HTTP/WS 服务。多宿主并存时（GUI 宿主与常驻内存服务
   * 宿主共用同一 SQLite 文件）可置 false，避免 4890 端口重复绑定。 */
  serverEnabled?: boolean
}

export const Config: Schema<Config> = Schema.object({
  dbPath: Schema.string().description('SQLite 数据库物理文件路径（默认置于全局 ~/.dsh/tlmemory.db）'),
  serverPort: Schema.number().default(4890).description('侧边栏与 REST API 服务端口'),
  maxRecallCount: Schema.number().default(5).description('单轮最大系统提示词注入记忆条数'),
  enableAutoReflection: Schema.boolean().default(true).description('是否开启会话结束异步自动反思提炼'),
  serverEnabled: Schema.boolean().default(true).description('是否启动内嵌 127.0.0.1 HTTP/WS 管理服务'),
})

export const name = 'tlmemory'
export const inject = ['tools', 'llm', 'systemPrompt']

/** 递归探测 .git 根目录并哈希截断生成项目作用域标识（repo:<12位sha256>） */
function resolveProjectScope(): string {
  let currentDir = process.cwd()
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, '.git'))) {
      const hash = crypto.createHash('sha256').update(path.normalize(currentDir)).digest('hex')
      return `repo:${hash.slice(0, 12)}`
    }
    currentDir = path.dirname(currentDir)
  }
  const fallbackHash = crypto.createHash('sha256').update(path.normalize(process.cwd())).digest('hex')
  return `repo:${fallbackHash.slice(0, 12)}`
}

/** 事件载荷判型守卫：事件类型不匹配时返回 null，防御宿主未来新增同类事件名 */
function eventDataOf<T>(
  event: { type: string; data: unknown },
  type: 'user/message' | 'assistant/message' | 'turn/start' | 'turn/end',
): T | null {
  return event.type === type ? (event.data as T) : null
}

export function apply(ctx: Context, config: Config): () => void {
  ctx.logger?.info?.(`[tlmemory] 插件装配启动中...`)

  const serverEnabled = config.serverEnabled ?? true
  const db = new MemoryDB(config.dbPath)
  const recallEngine = new MemoryRecallEngine(db)
  const turnTracker = new TurnTracker()
  const extractor = new MemoryExtractor(ctx, db)
  const projectScope = resolveProjectScope()

  let activeRecalledMemories: SearchResult[] = []
  let activePromptSectionText = ''

  // 挂载系统提示词切片：text 必须为纯同步函数，直接消费内存预热缓存，严禁异步 I/O
  const unregisterSection =
    ctx.systemPrompt?.section?.({
      name: 'tlmemory:injected-context',
      order: 115,
      text: () => activePromptSectionText,
    }) ?? (() => {})

  const unregisterTools = registerMemoryTools(ctx, db, () => projectScope)

  // 阶段三：内嵌回环网络服务。禁用时（serverEnabled:false）不监听端口，
  // 看板由共享 SQLite 的另一宿主实例提供，本实例仅承担事件沉淀与召回职责。
  const server = new MemoryServer(db, config.serverPort ?? 4890, ctx.logger)
  if (serverEnabled) {
    server.start()
  } else {
    ctx.logger?.info?.('[tlmemory] serverEnabled=false，内嵌服务不监听端口（看板由常驻宿主提供）')
  }

  // 会话事件流监听（官方契约：'session/event'(session, event)）。
  // 根上下文监听器观察全部会话；易失监听抛错会被宿主隔离，但本插件仍采用
  // 防御式读取 + 双保险 try-catch，保证事件热路径零异常上抛。
  const unregisterSessionEvent = ctx.on('session/event', (session, event) => {
    try {
      // 1) 轮次素材折叠：turn/start 开户、assistant/message 聚合可见文本
      const turnStart = eventDataOf<TurnStartEventData>(event, 'turn/start')
      if (turnStart) {
        turnTracker.onTurnStart(turnStart.turn)
      }

      const assistantMsg = eventDataOf<AssistantMessageEventData>(event, 'assistant/message')
      if (assistantMsg) {
        turnTracker.addAssistantMessage(assistantMsg.message?.content)
      }

      // 2) 人类输入：同步预热召回缓存并注入系统提示词切片
      const userMsg = eventDataOf<UserMessageEventData>(event, 'user/message')
      if (userMsg) {
        const text = userMsg.content
          ?.filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim()

        turnTracker.addUserMessage(userMsg.content, userMsg.source?.kind)

        if (text) {
          activeRecalledMemories = recallEngine.recall(text, projectScope, config.maxRecallCount ?? 5)
          activePromptSectionText = recallEngine.formatPromptBlock(activeRecalledMemories)
          server.broadcastHits(projectScope, activeRecalledMemories.map((m) => m.id))
        }
      }

      // 3) 轮次结束：completed 轮次派发无感静默沉淀（非阻塞后台微任务）
      const turnEnd = eventDataOf<TurnEndEventData>(event, 'turn/end')
      if (turnEnd) {
        const item = turnTracker.endTurn(turnEnd.turn, turnEnd.reason.kind)
        // 清空注入缓存，避免上一轮记忆残留进下一轮提示词
        activePromptSectionText = ''

        if (item && (config.enableAutoReflection ?? true)) {
          // 主响应流已完成结算，setImmediate 进入后台执行：
          // 提炼失败仅记日志，绝不阻塞、绝不打扰会话对话流
          setImmediate(() => {
            extractor
              .extractAndConsolidate(item, projectScope)
              .then(() => server.notifyTreeChanged(projectScope))
              .catch((err) => ctx.logger?.error?.('[tlmemory] 后台静默沉淀任务异常:', err))
          })
        }
      }
    } catch (err) {
      // 双保险：事件热路径的任何意外均收敛为一条日志
      ctx.logger?.error?.('[tlmemory] 会话事件处理异常（已隔离）:', err)
    }
  })

  return () => {
    ctx.logger?.info?.('[tlmemory] 正在执行全量副作用注销...')
    unregisterSection()
    unregisterTools()
    unregisterSessionEvent()
    turnTracker.reset()
    server.stop()
    db.close()
    ctx.logger?.info?.('[tlmemory] 插件已彻底安全注销')
  }
}