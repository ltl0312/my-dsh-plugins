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
import path from 'node:path'
import fs from 'node:fs'
import { Config, liveConfig, resolveDbPath } from './config.js'
import { MemoryDB } from './db.js'
import { MemoryExtractor } from './extractor.js'
import { MemoryCompactor } from './compactor.js'
import { MemoryConsolidator } from './consolidator.js'
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
// 归并能力的纯函数出口：scripts/merge-preview.mjs 直接复用同一套聚类规则，
// 避免「预览用一套、执行用另一套」的双实现漂移。
export { MemoryConsolidator, clusterCandidates, diceCoefficient, pathsAreSimilar } from './consolidator.js'
export type { MergeCluster, ConsolidateReport } from './consolidator.js'
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

// 配置 schema 与运行期读取器统一收敛在 config.ts（宿主设置页的 schema 来源）。
// 这里**只做转出**：`export { Config }` 同时转出该名字的类型与值两个含义，
// 因此历史调用方 `import { Config } from '../src/index.js'` 的语义不变。
export { Config } from './config.js'

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

/** 随提炼派发的会话级 LLM 上下文（宿主 llm.stream 契约必需项） */
interface ExtractionRouteContext {
  route?: { provider: string; model: string }
  sessionId?: string
}

/**
 * 从会话对象防御式提取宿主 LLM 路由（provider+model）与会话 id。
 * DSH 宿主的 SessionService 暴露 requestHeader()（对 request/header 事件的缓存折叠），
 * 其 config 携带 {provider, model, ...}；宿主自身的后台 LLM 调用（dsh-session-title-llm）
 * 正是取该值构造 stream options 的 route。非 DSH 宿主 / 未发过请求的会话返回空对象。
 */
function extractSessionRouteContext(session: unknown): ExtractionRouteContext {
  if (!session || typeof session !== 'object') return {}
  const record = session as Record<string, unknown>
  const context: ExtractionRouteContext = {}
  if (typeof record.id === 'string' && record.id.trim()) context.sessionId = record.id
  if (typeof record.requestHeader === 'function') {
    try {
      const headerFold = (record.requestHeader as () => unknown)()
      const config = headerFold && typeof headerFold === 'object'
        ? (headerFold as Record<string, unknown>).config
        : undefined
      if (config && typeof config === 'object') {
        const { provider, model } = config as Record<string, unknown>
        if (typeof provider === 'string' && provider.trim() && typeof model === 'string' && model.trim()) {
          context.route = { provider, model }
        }
      }
    } catch {
      // requestHeader 在极早期会话可能抛错（日志折叠未初始化），按无 route 降级
    }
  }
  return context
}

export function apply(ctx: Context, config: Config): () => void {
  // 运行期实时配置读口（绝不缓存装配期快照）：宿主改设置后会把新 config 写回
  // fiber 并重启插件，热路径上的阈值仍逐次回读，保证「保存即生效」没有窗口期。
  const readConfig = liveConfig(ctx, config)
  const dbFile = resolveDbPath(readConfig())
  ctx.logger?.info?.(
    `[tlmemory] 插件装配启动中... db=${dbFile ?? '(默认 ~/.dsh/tlmemory.db)'}`,
  )

  const db = new MemoryDB(dbFile)
  const recallEngine = new MemoryRecallEngine(db)
  const turnTracker = new TurnTracker()
  const extractor = new MemoryExtractor(ctx, db)
  // M3 异步 compaction：强化衰减（确定性）+ 矛盾检测（LLM 成本按批摊薄），
  // 在提炼链尾部串行执行，绝不与提炼并行、绝不阻塞会话流
  // 记忆归并（1.1.0）：确定性聚类 + 一次 LLM 归纳 → 父子结构落库（可回滚）。
  // 开关与 compactor 一样走运行期读取，设置页改完立即生效。
  const consolidator = new MemoryConsolidator(ctx, db)
  const compactor = new MemoryCompactor(
    ctx,
    db,
    () => readConfig().compactionInterval ?? 20,
    consolidator,
    () => readConfig().enableAutoMerge ?? true,
  )

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
  /**
   * 宿主工作区白名单的**实时**读取入口（v0.8.2 根因修复：不再在装配期冻结快照）。
   *
   * 为什么必须实时：`workspace.json` 是宿主在**运行期间**持续改写的文件 —— 用户新建
   * 工作区（本例是中文名工作区「磁盘清理 / 炎火云服务器8c8g」）时，宿主把新工作区追加
   * 进去，而插件进程可能已经跑了很久。旧实现把装配那一刻的白名单缓存进闭包
   * （`const workspaceRegistry = loadWorkspaceRegistry()`），此后新建的工作区**永远
   * 不在名单里**：
   *   1. 会话作用域被误判成「不属于宿主合法工作区」→ `resolveSafeScope` 把记忆
   *      改道写入白名单首位那个**与用户当前项目毫无关系**的工程（实测落到
   *      repo:82252c8a4eb6 / deskcraft，抽取日志与库里都留有证据）；
   *   2. 真正的工作区一条记忆都收不到 ⇒ 被「零记忆即清理」的维护周期从看板清单里
   *      摘掉 ⇒ 用户看到的正是「中文工作区不自动记录记忆 / 记忆列表里找不到工作区」。
   * 读取器自身按 mtime+size 缓存，逐次调用只是一次 statSync；宿主改名 / 新增 / 删除
   * 工作区都能立刻生效，无需重启宿主。
   */
  const workspaceRegistryNow = (): WorkspaceRegistry | null => loadWorkspaceRegistry()
  /** 宿主工作区白名单判定：登记表不可读时全部放行（宁可多显示，也不误删用户记忆） */
  const isAllowedWorkspaceScope = (scope: string): boolean => {
    const registry = workspaceRegistryNow()
    return registry === null || registry.has(scope)
  }
  /** 装配期的白名单快照：仅供启动时的一次性归并 / 维护使用，绝不参与逐事件判定 */
  const workspaceRegistry: WorkspaceRegistry | null = workspaceRegistryNow()
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

  /**
   * 作用域安全防线（v1.2.0 起改为**只告警、不改道**）。
   *
   * 历史事故（本函数即元凶）：旧实现把「不属于宿主合法工作区」的候选 scope
   * **改道写进白名单首位那个工程**。`workspace.json` 的 `workspaceIds` 顺序是用户
   * 历史创建顺序，首位往往是一个与当前工作毫无关系的旧仓库 —— 于是各工程的记忆被
   * 一条条搬进同一棵树，用户看到的就是「一千条记忆全混在一个工程里」。
   * 实证：`repo:72eb91503d39`（hnust-easyweibo，恰好是 `workspaceIds[0]`）累计 1003
   * 条叶子，而 `repo:08cb8c15f46d`（my-dsh-plugins）只有个位数。
   *
   * 现在的口径：**记忆永远留在它自己的作用域里**。名单外目录（用户主目录、临时目录）
   * 至多产生一个「不在下拉框白名单内」的工程，这是可接受的展示噪声；把 A 工程的记忆
   * 塞进 B 工程则是不可逆的数据污染 —— 宁可多一个工程，不可错一条归属。
   * 幽灵工程由 `maintainProjects`（只清零节点空壳）兜底，不靠搬记忆。
   */
  const resolveSafeScope = (candidate: string): string => {
    if (!isAllowedWorkspaceScope(candidate)) {
      ctx.logger?.warn?.(
        `[tlmemory] 作用域 ${candidate} 不属于宿主已登记工作区，仍按自身作用域写入（v1.2.0 起不再改道，避免记忆混入无关工程）`,
      )
    }
    return candidate
  }

  // v1.2.0 移除了装配期的「孤儿工程热归并」。
  // 旧行为：把白名单外 scope 的存量记忆按「同名对齐，否则白名单首位」迁走 —— 它既是
  // 上面那条错账的放大器，也把「工程名撞车」当成同一工程的证据（两个不同仓库同名即
  // 被强行合并）。`db.mergeOrphanScopes` 保留，仅由显式修复入口调用，不再随启动执行。

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

  const dispatchExtraction = (item: TurnTrackItem, scope: string, extra: ExtractionRouteContext = {}): void => {
    const controller = new AbortController()
    // v0.8.2：提炼提示词必须带上「当前项目是谁」—— 否则模型只能凭常识猜
    // global / project，项目内的部署运维结论会被判成通用经验写进全局树。
    const project = identityByScope.get(scope)
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
          .extractAndConsolidate(item, scope, {
            signal: controller.signal,
            project: { scope, name: project?.name, root: project?.root },
            ...extra,
          })
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
      // 记忆内容属于用户数据，绝不能当模板插值：0.2.1-rc.2 只注册 provider/model，
      // 记忆里任何 {{...}} 都会让整轮抛 unknown prompt variable 而失败。
      // cordis 3.x 的 section 类型尚未声明该字段，运行时由 DSH 0.2.1+ 读取。
      interpolate: false,
      text: () => activePromptSectionText,
    } as any) ?? (() => {})

  // v0.6.6 作用域动态感知：工具执行时按宿主 exec 上下文携带的 session 解析工程作用域；
  // 无会话线索时先取进程级身份（合法才用），孤儿进程目录一律降级白名单首位合法工作区
  // —— 严禁以 process.cwd()（如用户主目录）直接建工程，杜绝 ZhuanZ 幽灵工程再生。
  const unregisterTools = registerMemoryTools(
    ctx,
    db,
    (session) => {
      if (session && typeof session === 'object') return resolveSessionScope(session)
      return resolveSafeScope(projectScope)
    },
    consolidator,
  )

  // 阶段三：内嵌回环网络服务（零配置自启，随插件挂载自动拉起）。
  // 端口被前序 tlmemory 实例占用时健康探测确认同名进程后自动复用；
  // 被无关进程占用时自动顺延端口；彻底失败时打印 EADDRINUSE 解决指引。
  // 旧拓扑（serverEnabled:false 的多宿主手工分工）由上述自愈机制自动取代。
  //
  // 宿主当前工程仅在**属于合法工作区**时上报：非合法工作区（例如以用户主目录启动）
  // 绝不能作为看板锚点呈现；工作区白名单读取器一并注入，服务端每次读清单都会校验。
  const server = new MemoryServer(
    db,
    readConfig().serverPort ?? 4890,
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
          activeRecalledMemories = recallEngine.recall(
            text,
            sessionScope,
            readConfig().maxRecallCount ?? 5,
          )
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

        if (item && (readConfig().enableAutoReflection ?? true) && shouldConsolidate(item)) {
          // 主响应流已完成结算，进入后台执行：M2 干活信号门控通过后
          // 才付费调用 LLM（见 shouldConsolidate），链式串行 + 超时中止（P2-4），
          // 提炼失败仅记日志，绝不阻塞、绝不打扰会话对话流。
          // D2：随派发携带会话 route（provider/model）与 sessionId —— 宿主
          // llm.stream 契约必需，缺 route 会导致后台调用拿到空流。
          dispatchExtraction(item, sessionScope, extractSessionRouteContext(session))
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
