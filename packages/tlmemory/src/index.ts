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
import { MemoryDB } from './db.js'
import { MemoryExtractor } from './extractor.js'
import { MemoryCompactor } from './compactor.js'
import { registerMemoryTools } from './tools.js'
import { MemoryRecallEngine } from './recall.js'
import { MemoryServer } from './server.js'
import { TurnTracker } from './turn-tracker.js'
import { loadWorkspaceRegistry, projectScopeOf, type WorkspaceRegistry } from './workspaces.js'
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
export { registerMemoryTools, toContentBlocks, toToolResult } from './tools.js'
export type { ToolResultEnvelope, ToolTextBlock, ScopeResolver } from './tools.js'
export { MemoryRecallEngine } from './recall.js'
// 阶段三/六交付物：嵌入式 REST 与 WebSocket 实时中继服务 + 轮次跟踪器
export { MemoryServer, isFetchForbiddenPort } from './server.js'
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
// 宿主工作区白名单读取层（看板「工程 ↔ 工作区」对齐的唯一事实来源）
export {
  loadWorkspaceRegistry,
  projectScopeOf,
  resolveDshHome,
  workspaceRegistryPath,
} from './workspaces.js'
export type { WorkspaceRegistry } from './workspaces.js'
export type { ProjectPruneOptions, OrphanMergeOptions, OrphanMergeResult } from './db.js'

export interface Config {
  dbPath?: string
  serverPort?: number
  maxRecallCount?: number
  enableAutoReflection?: boolean
  /** M3 compaction 间隔：每累计 N 次静默沉淀触发一轮强化衰减 + 矛盾检测（默认 20） */
  compactionInterval?: number
}

export const Config: Schema<Config> = Schema.object({
  dbPath: Schema.string().description('SQLite 数据库物理文件路径（默认置于全局 ~/.dsh/tlmemory.db）'),
  serverPort: Schema.number().default(4890).description('侧边栏与 REST API 服务端口'),
  maxRecallCount: Schema.number().default(5).description('单轮最大系统提示词注入记忆条数'),
  enableAutoReflection: Schema.boolean().default(true).description('是否开启会话结束异步自动反思提炼'),
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
 * scope 仍是「repo 根目录绝对路径」的 sha256 前 12 位，与历史版本逐字节一致（算法已
 * 收敛到 workspaces.ts 的 projectScopeOf，与工作区白名单共用同一实现）—— 这样既有
 * 记忆库的 tree_type 不会因为本次改造发生漂移；额外带出根目录 basename 作为可读工程名，
 * 交给 db.registerProject 落库，看板下拉框才能显示
 * my-dsh-plugins / TLToolBox 这类人类可读的名字，杜绝裸哈希 repo:<hash> 充当展示名。
 */
export function resolveProjectIdentity(workspaceDir?: string): ProjectIdentity {
  const fallbackRoot = path.normalize(process.cwd())
  const explicit = workspaceDir ?? process.env.DSH_WORKSPACE_DIR
  // v0.6.6 修复（ZhuanZ 事故根因）：显式会话目录向上找不到 .git 时，根目录取
  // **会话目录本身** —— 旧实现会静默回退到 process.cwd()，宿主以用户主目录启动时
  // 所有会话的记忆都被打上终端启动目录的 project_key。
  let currentDir = explicit ? path.normalize(explicit) : fallbackRoot
  let root = currentDir
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, '.git'))) {
      root = path.normalize(currentDir)
      break
    }
    currentDir = path.dirname(currentDir)
  }
  const hashRoot = path.normalize(root)
  return { scope: projectScopeOf(hashRoot), name: path.basename(hashRoot) || 'unknown-project', root: hashRoot }
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
 *
 * v0.6.9 关键补充：DSH 宿主的 `SessionService` 把会话工作目录收在 **`session.header.cwd`**，
 * 顶层**没有** `workspaceDir / workspace / cwd / root` 任何一键 —— 旧实现四键全落空，
 * 只能回退进程级身份（宿主 cwd，常为用户主目录），造成「会话记忆归到主目录伪工程」的
 * 作用域错账（召回 0 命中 + 沉淀写错树，且当主目录恰在白名单内时防漂移闸门不触发，
 * 错账完全静默）。
 *
 * `header.cwd` 是宿主认可的工作区根权威值：`dsh-workspace` 在把会话挂到工作区时
 * 强制 `header.cwd` realpath === `workspace.record.path`（宿主源码
 * `dsh-workspace/lib/index.js:114-123`），系统提示词的 `cwd` 变量也取同一字段
 * （`dsh-agent-loop/lib/index.js:1536`）。
 */
function extractSessionWorkspaceDir(session: unknown): string | undefined {
  if (!session || typeof session !== 'object') return undefined
  const record = session as Record<string, unknown>
  // 旧四键优先：兼容「直接把工作目录挂在顶层」的宿主形态与非 DSH 宿主
  for (const key of ['workspaceDir', 'workspace', 'cwd', 'root']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  // DSH 宿主真实形态：cwd 收在会话创建头里
  const header = record.header
  if (header && typeof header === 'object') {
    const cwd = (header as Record<string, unknown>).cwd
    if (typeof cwd === 'string' && cwd.trim()) return cwd
  }
  return undefined
}

export function apply(ctx: Context, config: Config): () => void {
  ctx.logger?.info?.(`[tlmemory] 插件装配启动中...`)

  const db = new MemoryDB(config.dbPath)
  const recallEngine = new MemoryRecallEngine(db)
  const turnTracker = new TurnTracker()
  const extractor = new MemoryExtractor(ctx, db)
  // M3 异步 compaction：强化衰减（确定性）+ 矛盾检测（LLM 成本按批摊薄），
  // 在提炼链尾部串行执行，绝不与提炼并行、绝不阻塞会话流
  const compactor = new MemoryCompactor(ctx, db, config.compactionInterval ?? 20)

  // 工程身份：解析当前仓库根目录 → scope 哈希 + 可读工程名。
  // 但**登记前必须先过宿主工作区白名单**：插件可能被宿主以任意工作目录拉起
  // （例如直接在用户主目录下启动），此时算出的 scope 既不是仓库、也不属于任何已
  // 登记工作区；把它登记进去只会在看板里凭空多出一个幽灵工程。白名单不可读
  // （registry === null）时视为「无从判定」，退回旧行为以保证记忆不丢。
  const project = resolveProjectIdentity()
  const projectScope = project.scope
  // 会话作用域可观测性（v0.6.9）：进程级身份是「会话未携带工作区线索时的兜底降落点」。
  // 若它不是仓库根（向上找不到 .git），一旦宿主以任意目录启动，所有会话记忆都会归到该目录；
  // 且当该目录恰在宿主白名单内时，下面的防漂移闸门不会触发，错账**完全静默**
  // （2026-09-18 实证：宿主 cwd = 用户主目录，召回永远 0 命中、沉淀写进主目录伪工程，
  //  靠对照实验的 projects.updated_at 才反推出来）。这里只告警不阻断：
  // 进程级身份也可能是合法选择（宿主确实运行在无 .git 的目录）。
  if (!fs.existsSync(path.join(project.root, '.git'))) {
    ctx.logger?.warn?.(
      `[tlmemory] 进程级工程身份 ${project.scope}（${project.root}）不是仓库根（未找到 .git）。` +
        '会话未携带工作区线索时将回退到它 —— 若这不是预期，请从含 .git 的目录启动宿主，' +
        '或设置 DSH_WORKSPACE_DIR 指向目标仓库。',
    )
  }
  const workspaceRegistry: WorkspaceRegistry | null = loadWorkspaceRegistry()
  /** 宿主工作区白名单判定：登记表不可读时全部放行（宁可多显示，也不误删用户记忆） */
  const isAllowedWorkspaceScope = (scope: string): boolean =>
    workspaceRegistry === null || workspaceRegistry.has(scope)
  /** 当前工程是否属于宿主合法工作区 —— 决定它能否登记、能否当看板锚点 */
  const projectIsAllowed = isAllowedWorkspaceScope(projectScope)
  /**
   * 当前工程即便不属于任何已登记工作区，只要**它已经有记忆数据**，也必须登记 ——
   * 「有记忆的工程绝不隐藏」：少了登记项，看板只能拿裸 scope 哈希当工程名展示。
   */
  const projectHasData = db.countNodes(projectScope) > 0

  if (projectIsAllowed || projectHasData) {
    // 登记之后再打开看板，下拉框里出现的才是 my-dsh-plugins 这样的名字而非 repo:<hash>。
    db.registerProject(project.scope, project.name, project.root)
  } else {
    ctx.logger?.warn?.(
      `[tlmemory] 当前目录不属于宿主已登记工作区且尚无记忆，跳过工程登记（记忆看板不会显示该空壳工程）: ${project.root}`,
    )
  }

  // v0.6.6 防漂移降级：白名单首位合法工作区（scope + 标题）。仅在「进程/会话作用域
  // 被判定为孤儿」时作为记忆写入的降落点 —— 严禁以用户主目录之类的名单外目录建工程。
  const fallbackWorkspace = (): { scope: string; name: string } | null => {
    if (workspaceRegistry === null) return null
    for (const [scope, title] of workspaceRegistry.scopes) {
      return { scope, name: title }
    }
    return null
  }
  /** 启用降级工作区：首次使用时补登记（可读名 = 工作区标题），保证看板不出现裸哈希 */
  const useFallbackWorkspace = (): string | null => {
    const fallback = fallbackWorkspace()
    if (!fallback) return null
    if (!registeredScopes.has(fallback.scope)) {
      registeredScopes.add(fallback.scope)
      identityByScope.set(fallback.scope, { scope: fallback.scope, name: fallback.name, root: '' })
      db.registerProject(fallback.scope, fallback.name, null)
    }
    return fallback.scope
  }
  /**
   * 作用域安全防线（防漂移最后一道闸）：候选 scope 必须属于宿主合法工作区；
   * 名单外目录（如用户主目录 C:\Users\ZhuanZ）一律降级到白名单首位合法工作区。
   * 白名单不可读（registry === null，isAllowedWorkspaceScope 恒 true）时维持旧行为 ——
   * 「读不到名单」不等于「名单为空」，无从判定绝不搬家。
   */
  const resolveSafeScope = (candidate: string): string => {
    if (isAllowedWorkspaceScope(candidate)) return candidate
    const fallback = useFallbackWorkspace()
    if (fallback !== null) {
      ctx.logger?.warn?.(
        `[tlmemory] 作用域 ${candidate} 不属于宿主合法工作区，已降级写入合法工作区 ${fallback}（防止生成幽灵工程）`,
      )
      return fallback
    }
    return candidate
  }

  // v0.6.6 孤儿工程热归并（装配期一次，幂等）：先把白名单外 scope 的存量记忆
  // 迁入合法工作区（同名对齐优先，否则落白名单首位），随后 maintainProjects
  // 才能安全收紧 —— 归并优先于清理，记忆一条不少，只是搬回家。
  try {
    const titleToScope = new Map<string, string>()
    if (workspaceRegistry !== null) {
      for (const [scope, title] of workspaceRegistry.scopes) {
        titleToScope.set(title.trim().toLowerCase(), scope)
      }
    }
    const merges = db.mergeOrphanScopes({
      keepScope: projectIsAllowed ? projectScope : null,
      // 兜底降落点：进程级工作区合法时优先（记忆大概率来自当前宿主目录），
      // 否则取白名单首位 —— 绝不落在任何名单外目录
      fallbackScope: (projectIsAllowed ? projectScope : fallbackWorkspace()?.scope) ?? null,
      isScopeAllowed: workspaceRegistry === null ? null : isAllowedWorkspaceScope,
      titleToScope: workspaceRegistry === null ? null : titleToScope,
    })
    for (const merged of merges) {
      ctx.logger?.warn?.(
        `[tlmemory] 孤儿工程记忆已归并: ${merged.from} → ${merged.to}（迁移 ${merged.movedNodes} 个节点，合并 ${merged.mergedLeaves} 条同位冲突叶子）`,
      )
    }
  } catch (err) {
    ctx.logger?.error?.('[tlmemory] 孤儿工程归并异常（跳过本轮，不影响启动）:', err)
  }

  // 工程清单自愈：清掉**零节点的空壳登记**（以用户主目录启动产生的临时登记、宿主已删除
  // 的历史目录留下的空记录）与名单内的零记忆工程，并把重名工程收敛为唯一名；
  // keepScope 只豁免「当前正在打开的工程」—— 它零记忆也保留，作为「当前工程就绪」的
  // 看板锚点。**有记忆的工程永远不会被这里清掉**（第一铁律）。每次启动都跑一次，
  // 看板不必等到打开才被清理。
  try {
    const maintenance = db.maintainProjects({
      keepScope: projectIsAllowed || projectHasData ? projectScope : null,
      isScopeAllowed: workspaceRegistry === null ? null : isAllowedWorkspaceScope,
      workspaceTitles: workspaceRegistry?.titles ?? null,
    })
    if (maintenance.purgedScopes.length > 0) {
      ctx.logger?.info?.(
        `[tlmemory] 自动清理 ${maintenance.purgedScopes.length} 个工程（零记忆或不属于宿主合法工作区）: ${maintenance.purgedScopes.join(', ')}`,
      )
    }
    for (const change of maintenance.renamed) {
      ctx.logger?.warn?.(`[tlmemory] 工程重名自愈: ${change.scope} 「${change.from}」→「${change.to}」`)
    }
  } catch (err) {
    ctx.logger?.error?.('[tlmemory] 工程清单维护异常:', err)
  }

  // P1-5 会话级工程身份解析：GUI 宿主可能同时服务多个 workspace 的会话，
  // 进程级固定 scope 会把 A 仓库的沉淀写进 B 仓库的记忆树（记忆错账）。
  // 事件回调携带 session 对象时，优先从其 workspace 线索按会话解析身份并缓存
  // （WeakMap 随会话对象生命周期自动回收）；解析不出回退进程级身份。
  //
  // v0.6.9 修正（会话作用域错账的第二处根因）：缓存的是**经防漂移闸门解析后**
  // 的作用域，而不是原始 ProjectIdentity。旧实现缓存原始身份并在后续事件直接
  // 返回 `identity.scope`，导致「名单外会话只有第一个事件被降级，其后的
  // user/message 召回与 turn/end 提炼仍用名单外原始 scope 落库」。
  // 真实宿主里同一会话的全部事件共用同一个 SessionService 实例，缓存必然命中，
  // 因此该缺陷在真实环境是常态而非边缘情况（2026-09-18 由 scope-guard 新增用例暴露：
  // 旧测试每次 emit 都传新对象字面量，WeakMap 永不命中，所以一直没测出来）。
  const sessionScopeCache = new WeakMap<object, string>()
  const registeredScopes = new Set<string>([projectScope])
  /** scope → 工程身份（可读名 / 根目录），沉淀前据此重建可能已被维护清掉的登记项 */
  const identityByScope = new Map<string, ProjectIdentity>([[projectScope, project]])
  const resolveSessionScope = (session: unknown): string => {
    if (!session || typeof session !== 'object') return resolveSafeScope(projectScope)
    const cached = sessionScopeCache.get(session)
    if (cached) return cached
    const workspaceDir = extractSessionWorkspaceDir(session)
    if (!workspaceDir) return resolveSafeScope(projectScope)
    const identity = resolveProjectIdentity(workspaceDir)
    identityByScope.set(identity.scope, identity)
    // 每个新解析出的**合法工作区**工程身份都登记（保留用户手工命名），保证看板下拉框可见；
    // 工作区之外的目录不登记 —— 它只会在看板里制造幽灵工程，随后被维护周期清掉。
    if (!registeredScopes.has(identity.scope) && isAllowedWorkspaceScope(identity.scope)) {
      registeredScopes.add(identity.scope)
      db.registerProject(identity.scope, identity.name, identity.root)
    }
    // v0.6.6 防漂移：会话工作区不在白名单（如宿主会话游离在用户主目录）时，
    // 记忆降级写入合法工作区，绝不把名单外 scope 当 project_key 落库
    const resolved = resolveSafeScope(identity.scope)
    sessionScopeCache.set(session, resolved)
    return resolved
  }

  /**
   * 沉淀前确保登记项在位（幂等 upsert）。
   * 为什么必须重复登记：零记忆工程会被看板读取/启动时的维护周期清理（合规要求），
   * 而登记项是「可读工程名」的唯一来源 —— 少了它，新落库的记忆会让看板
   * 以裸 scope 哈希显示整个工程。每次沉淀前补登记，成本可忽略（沉淀本身要调 LLM）。
   *
   * 白名单外的工程：原本一并跳过，但**只要它已经或即将持有记忆数据就必须登记** ——
   * 「有记忆的工程绝不隐藏」是硬要求，而裸 `repo:<hash>` 当工程名同样属于「没好好
   * 显示」。只有当它确实是零记忆的空壳时才不补登记，避免再造幽灵工程。
   */
  const ensureProjectRegistered = (scope: string): void => {
    const identity = identityByScope.get(scope)
    if (!identity) return
    // 名单外的空壳不补登记（避免再造幽灵工程）；已有数据的必须登记，否则看板只能
    // 拿裸 repo:<hash> 当工程名 —— 「有记忆的工程绝不隐藏」包含「绝不匿名显示」。
    if (!isAllowedWorkspaceScope(scope) && db.countNodes(scope) === 0) return
    db.registerProject(identity.scope, identity.name, identity.root)
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
        try {
          ensureProjectRegistered(scope)
        } catch (err) {
          ctx.logger?.error?.('[tlmemory] 工程登记补录异常:', err)
        }
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

  // v0.6.6 作用域动态感知：工具执行时按宿主 exec 上下文携带的 session 解析工程作用域；
  // 无会话线索时先取进程级身份（合法才用），孤儿进程目录一律降级白名单首位合法工作区
  // —— 严禁以 process.cwd()（如用户主目录）直接建工程，杜绝 ZhuanZ 幽灵工程再生。
  const unregisterTools = registerMemoryTools(ctx, db, (session) => {
    if (session && typeof session === 'object') return resolveSessionScope(session)
    return resolveSafeScope(projectScope)
  })

  // 阶段三：内嵌回环网络服务（零配置自启，随插件挂载自动拉起）。
  // 端口被前序 tlmemory 实例占用时健康探测确认同名进程后自动复用；
  // 被无关进程占用时自动顺延端口；彻底失败时打印 EADDRINUSE 解决指引。
  // 旧拓扑（serverEnabled:false 的多宿主手工分工）由上述自愈机制自动取代。
  //
  // 宿主当前工程仅在**属于合法工作区**时上报：非合法工作区（例如以用户主目录启动）
  // 绝不能作为看板锚点呈现；工作区白名单读取器一并注入，服务端每次读清单都会校验。
  const server = new MemoryServer(
    db,
    config.serverPort ?? 4890,
    ctx.logger,
    projectIsAllowed ? project : undefined,
    () => loadWorkspaceRegistry(),
  )
  void server.start()

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