// packages/tlmemory/src/index.ts
// 插件入口与装配中心（阶段二）：
// - 依赖注入：tools / llm / systemPrompt 三服务显式声明；
// - 同步切片：systemPrompt.section 只消费内存预热缓存，严禁异步 I/O；
// - 事件联动：user/message 预热召回缓存，turn/end 派发非阻塞反思提炼；
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
import type { SearchResult } from './types.js'

// 阶段一交付物再导出（保证包构建产物完整性与回归断言通过）
export { MemoryDB } from './db.js'
export { MemoryExtractor } from './extractor.js'
export { registerMemoryTools } from './tools.js'
// 阶段三交付物：嵌入式 REST 与 WebSocket 实时中继服务（供主包与测试用例引用）
export { MemoryServer } from './server.js'
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
} from './types.js'

export interface Config {
  dbPath?: string
  serverPort?: number
  maxRecallCount?: number
  enableAutoReflection?: boolean
}

export const Config: Schema<Config> = Schema.object({
  dbPath: Schema.string().description('SQLite 数据库物理文件路径（默认置于全局 ~/.dsh/tlmemory.db）'),
  serverPort: Schema.number().default(4890).description('侧边栏与 REST API 服务端口'),
  maxRecallCount: Schema.number().default(5).description('单轮最大系统提示词注入记忆条数'),
  enableAutoReflection: Schema.boolean().default(true).description('是否开启会话结束异步自动反思提炼'),
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

export function apply(ctx: Context, config: Config): () => void {
  ctx.logger?.info?.(`[tlmemory] 插件装配启动中...`)

  const db = new MemoryDB(config.dbPath)
  const recallEngine = new MemoryRecallEngine(db)
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

  // 阶段二：网络服务为桩实现，仅承载生命周期接口
  const server = new MemoryServer(db, config.serverPort ?? 4890, ctx.logger)
  server.start()

  let lastUserMessage = ''

  // 监听会话事件流：用户输入同步预热召回缓存，轮次结束非阻塞派发反思提炼
  const unregisterSessionEvent = ctx.on('session/event' as any, (event: any) => {
    if (event?.type === 'user/message') {
      const text = typeof event.content === 'string' ? event.content : event.content?.text ?? ''
      lastUserMessage = text

      activeRecalledMemories = recallEngine.recall(text, projectScope, config.maxRecallCount ?? 5)
      activePromptSectionText = recallEngine.formatPromptBlock(activeRecalledMemories)

      server.broadcastHits(projectScope, activeRecalledMemories.map((m) => m.id))
    }

    if (event?.type === 'turn/end' && (config.enableAutoReflection ?? true)) {
      const assistantText = event.last_assistant_message ?? ''
      if (lastUserMessage && assistantText) {
        // 非阻塞后台微任务：主响应流完成后再执行反思提炼，对会话性能零损耗
        setImmediate(() => {
          extractor
            .extractAndConsolidate(lastUserMessage, assistantText, projectScope)
            .then(() => server.notifyTreeChanged(projectScope))
            .catch((err) => ctx.logger?.error?.('[tlmemory] 后台提炼长叶失败:', err))
        })
      }
      activePromptSectionText = ''
      lastUserMessage = ''
    }
  })

  return () => {
    ctx.logger?.info?.('[tlmemory] 正在执行全量副作用注销...')
    unregisterSection()
    unregisterTools()
    unregisterSessionEvent()
    server.stop()
    db.close()
    ctx.logger?.info?.('[tlmemory] 插件已彻底安全注销')
  }
}