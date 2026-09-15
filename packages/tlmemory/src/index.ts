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
import { MemoryCompactor } from './compactor.js'
import { registerMemoryTools } from './tools.js'
import { MemoryRecallEngine } from './recall.js'
import { MemoryServer } from './server.js'
import { TurnTracker } from './turn-tracker.js'
import type {
  AssistantMessageEventData,
  SearchResult,
  TurnEndEventData,
  TurnStartEventData,
  TurnTrackItem,
  UserMessageEventData,
} from './types.js'

// 阶段一交付物再导出（保证包构建产物完整性与回归断言通过）
export { MemoryDB } from './db.js'
export { MemoryExtractor } from './extractor.js'
export { MemoryCompactor } from './compactor.js'
export { registerMemoryTools } from './tools.js'
export { MemoryRecallEngine } from './recall.js'
// 阶段三/六交付物：嵌入式 REST 与 WebSocket 实时中继服务 + 轮次跟踪器
export { MemoryServer } from './server.js'
export { TurnTracker } from './turn-tracker.js'
export type {
  MemoryNode,
  MemoryScope,
  MemoryCategory,
  ProjectSummary,
  SearchOptions,
  SearchResult,
  RawReflectionItem,
  ReflectionResponse,
  SaveMemoryArgs,
  QueryMemoryArgs,
  TurnTrackItem,
} from './types.js'
export type { CurrentProject } from './server.js'

export interface Config {
  dbPath?: string
  serverPort?: number
  maxRecallCount?: number
  enableAutoReflection?: boolean
  /** 是否启用内嵌 127.0.0.1 HTTP/WS 服务。多宿主并存时（GUI 宿主与常驻内存服务
   * 宿主共用同一 SQLite 文件）可置 false，避免 4890 端口重复绑定。 */
  serverEnabled?: boolean
  /** M3 compaction 间隔：每累计 N 次静默沉淀触发一轮强化衰减 + 矛盾检测（默认 20） */
  compactionInterval?: number
}

export const Config: Schema<Config> = Schema.object({
  dbPath: Schema.string().description('SQLite 数据库物理文件路径（默认置于全局 ~/.dsh/tlmemory.db）'),
  serverPort: Schema.number().default(4890).description('侧边栏与 REST API 服务端口'),
  maxRecallCount: Schema.number().default(5).description('单轮最大系统提示词注入记忆条数'),
  enableAutoReflection: Schema.boolean().default(true).description('是否开启会话结束异步自动反思提炼'),
  serverEnabled: Schema.boolean().default(true).description('是否启动内嵌 127.0.0.1 HTTP/WS 管理服务'),
  compactionInterval: Schema.number()
    .default(20)
    .description('M3 compaction 间隔：每累计 N 次静默沉淀触发一轮强化衰减与矛盾检测'),
})

export const name = 'tlmemory'
export const inject = ['tools', 'llm', 'systemPrompt']

/** 工程身份三元组：不可读的 scope 哈希 + 可读工程名 + 物理根目录 */
export interface ProjectIdentity {
  scope: string
  name: string
  root: string
}

/**
 * 解析当前进程所在的工程身份。
 *
 * 工作区根目录来源优先级：显式入参（DSH 会话传入的 workspaceDir）>
 * 环境变量 DSH_WORKSPACE_DIR > 从 process.cwd() 向上回溯 .git 根目录。
 *
 * scope 仍是「repo 根目录绝对路径」的 sha256 前 12 位，与历史版本逐字节一致 ——
 * 这样既有记忆库的 tree_type 不会因为本次改造发生漂移；额外带出根目录 basename
 * 作为可读工程名，交给 db.registerProject 落库，看板下拉框才能显示
 * my-dsh-plugins / TLToolBox 这类人类可读的名字，杜绝裸哈希 repo:<hash> 充当展示名。
 */
export function resolveProjectIdentity(workspaceDir?: string): ProjectIdentity {
  const fallbackRoot = path.normalize(process.cwd())
  let root = fallbackRoot
  const explicit = workspaceDir ?? process.env.DSH_WORKSPACE_DIR
  let currentDir = explicit ? path.normalize(explicit) : fallbackRoot
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, '.git'))) {
      root = path.normalize(currentDir)
      break
    }
    currentDir = path.dirname(currentDir)
  }
  const hash = crypto.createHash('sha256').update(root).digest('hex')
  return { scope: `repo:${hash.slice(0, 12)}`, name: path.basename(root) || 'unknown-project', root }
}

/** 事件载荷判型守卫：事件类型不匹配时返回 null，防御宿主未来新增同类事件名 */
function eventDataOf<T>(
  event: { type: string; data: unknown },
  type: 'user/message' | 'assistant/message' | 'turn/start' | 'turn/end',
): T | null {
  return event.type === type ? (event.data as T) : null
}

/** P2-4 单次提炼任务的超时上限：宿主 LLM 流异常挂起时强制中止，后台任务不再永久悬挂 */
const EXTRACTION_TIMEOUT_MS = 60_000

/**
 * M2 决策表述探测：与干活信号（tool_use 块）并列的零成本门控信号。
 * 命中「决定 / 约定 / 以后一律 / 规则 / 偏好」等沉淀价值表述的回合，
 * 即便没有工具调用也值得付费提炼。
 */
const DECISION_PHRASE_PATTERN =
  /(决定|约定|敲定|以后(都|一律|统一|默认|不再)|一律|统一使用|必须|切记|不要再|规则|偏好|习惯|踩坑|避坑)/

/**
 * M2 写路径门控第一层（LLM 调用之前，零成本）：
 * 只有「本轮 agent 真的干了活（出现过工具调用块）」或「人类输入/助手结论中
 * 带有决策表述」的回合才派发 LLM 提炼 —— 成本从每回合一次降为
 * 有价值回合一次，闲聊与纯问答回合零开销。
 */
function shouldConsolidate(item: TurnTrackItem): boolean {
  if (item.hasToolActivity) return true
  return DECISION_PHRASE_PATTERN.test(`${item.userText}\n${item.assistantText}`)
}

/**
 * 从会话对象防御式提取 workspace 目录线索。
 * 宿主 session 对象结构未在官方契约中冻结，这里按常见命名做鸭子类型探测，
 * 全部不命中返回 undefined（由调用方回退进程级身份）。
 */
function extractSessionWorkspaceDir(session: unknown): string | undefined {
  if (!session || typeof session !== 'object') return undefined
  const record = session as Record<string, unknown>
  for (const key of ['workspaceDir', 'workspace', 'cwd', 'root']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

export function apply(ctx: Context, config: Config): () => void {
  ctx.logger?.info?.(`[tlmemory] 插件装配启动中...`)

  const serverEnabled = config.serverEnabled ?? true
  const db = new MemoryDB(config.dbPath)
  const recallEngine = new MemoryRecallEngine(db)
  const turnTracker = new TurnTracker()
  const extractor = new MemoryExtractor(ctx, db)
  // M3 异步 compaction：强化衰减（确定性）+ 矛盾检测（LLM 成本按批摊薄），
  // 在提炼链尾部串行执行，绝不与提炼并行、绝不阻塞会话流
  const compactor = new MemoryCompactor(ctx, db, config.compactionInterval ?? 20)

  // 工程身份：解析当前仓库根目录 → scope 哈希 + 可读工程名，并登记进 projects 登记表。
  // 登记之后再打开看板，下拉框里出现的才是 my-dsh-plugins 这样的名字而非 repo:<hash>。
  const project = resolveProjectIdentity()
  const projectScope = project.scope
  db.registerProject(project.scope, project.name, project.root)

  // P1-5 会话级工程身份解析：GUI 宿主可能同时服务多个 workspace 的会话，
  // 进程级固定 scope 会把 A 仓库的沉淀写进 B 仓库的记忆树（记忆错账）。
  // 事件回调携带 session 对象时，优先从其 workspace 线索按会话解析身份并缓存
  // （WeakMap 随会话对象生命周期自动回收）；解析不出回退进程级身份。
  const sessionIdentityCache = new WeakMap<object, ProjectIdentity>()
  const registeredScopes = new Set<string>([projectScope])
  const resolveSessionScope = (session: unknown): string => {
    if (!session || typeof session !== 'object') return projectScope
    const cached = sessionIdentityCache.get(session)
    if (cached) return cached.scope
    const workspaceDir = extractSessionWorkspaceDir(session)
    if (!workspaceDir) return projectScope
    const identity = resolveProjectIdentity(workspaceDir)
    sessionIdentityCache.set(session, identity)
    // 每个新解析出的工程身份都登记（保留用户手工命名），保证看板下拉框可见
    if (!registeredScopes.has(identity.scope)) {
      registeredScopes.add(identity.scope)
      db.registerProject(identity.scope, identity.name, identity.root)
    }
    return identity.scope
  }

  // P2-4 沉淀链路限流：多轮快速结算时多个提炼任务并行无上限（token 费用 +
  // SQLite 写竞争），这里把并行度收敛为 1（链式串行），并为每次调用挂
  // 60s AbortController 超时 —— 宿主 LLM 流异常挂起时后台任务不再永久悬挂。
  let extractionChain: Promise<void> = Promise.resolve()
  let activeExtractionAbort: AbortController | null = null
  let disposed = false

  const dispatchExtraction = (item: TurnTrackItem, scope: string): void => {
    const controller = new AbortController()
    const run = extractionChain
      .then(() => {
        if (disposed) return
        activeExtractionAbort = controller
        const timer = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS)
        return extractor
          .extractAndConsolidate(item, scope, { signal: controller.signal })
          .then(() => server.notifyTreeChanged(scope))
          .catch((err) => ctx.logger?.error?.('[tlmemory] 后台静默沉淀任务异常:', err))
          .finally(() => {
            clearTimeout(timer)
            if (activeExtractionAbort === controller) activeExtractionAbort = null
          })
      })
      .then(() => {
        // M3：每累计 N 次沉淀，在链尾串行执行一轮 compaction
        //（强化衰减 + 矛盾检测）。挂在同一链上保证与提炼互斥，注销 disposed 兜底。
        if (disposed) return
        if (!compactor.noteSedimented()) return
        return compactor.compact().catch((err) =>
          ctx.logger?.error?.('[tlmemory] compaction 任务异常:', err),
        )
      })
    extractionChain = run
  }

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
  const server = new MemoryServer(db, config.serverPort ?? 4890, ctx.logger, project)
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
      // P1-5：按会话解析工程作用域（多 workspace 宿主下记忆归属不再错账）
      const sessionScope = resolveSessionScope(session)

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
          activeRecalledMemories = recallEngine.recall(text, sessionScope, config.maxRecallCount ?? 5)
          activePromptSectionText = recallEngine.formatPromptBlock(activeRecalledMemories)
          server.broadcastHits(sessionScope, activeRecalledMemories.map((m) => m.id))
        }
      }

      // 3) 轮次结束：completed 轮次派发无感静默沉淀（非阻塞后台微任务）
      const turnEnd = eventDataOf<TurnEndEventData>(event, 'turn/end')
      if (turnEnd) {
        const item = turnTracker.endTurn(turnEnd.turn, turnEnd.reason.kind)
        // 清空注入缓存，避免上一轮记忆残留进下一轮提示词
        activePromptSectionText = ''

        if (item && (config.enableAutoReflection ?? true) && shouldConsolidate(item)) {
          // 主响应流已完成结算，进入后台执行：M2 干活信号门控通过后
          // 才付费调用 LLM（见 shouldConsolidate），链式串行 + 超时中止（P2-4），
          // 提炼失败仅记日志，绝不阻塞、绝不打扰会话对话流
          dispatchExtraction(item, sessionScope)
        } else if (item) {
          ctx.logger?.info?.('[tlmemory] 本轮无干活信号与决策表述，跳过 LLM 提炼（零成本门控）')
        }
      }
    } catch (err) {
      // 双保险：事件热路径的任何意外均收敛为一条日志
      ctx.logger?.error?.('[tlmemory] 会话事件处理异常（已隔离）:', err)
    }
  })

  return () => {
    ctx.logger?.info?.('[tlmemory] 正在执行全量副作用注销...')
    // P2-4：先中止在途提炼任务（60s 超时控制器 + 显式 abort），db.close 推迟到
    // 提炼链收尾之后 —— 避免 close 后仍触发写入报错。
    disposed = true
    activeExtractionAbort?.abort()
    unregisterSection()
    unregisterTools()
    unregisterSessionEvent()
    turnTracker.reset()
    server.stop()
    void extractionChain
      .catch(() => {})
      .then(() => {
        db.close()
        ctx.logger?.info?.('[tlmemory] 插件已彻底安全注销')
      })
  }
}