// packages/tlsearch/src/index.ts
//
// 插件入口与装配中心。
//
// 目标：替代/补充 DSH 原生 web_search，把「一次搜索」的上下文成本压到最低，
// 同时让后端可插拔（Tavily / SearXNG / Google CSE / Brave / Exa）、端点可自建，
// 并支持**主备自动切换**：主后端失败或熔断时静默改用备用后端。
//
// ── 1.0.0 的两条新契约 ──────────────────────────────────────────────────────
// A. **全部配置项可在设置页改，且改完立即生效**
//    `Config` 的每一个叶子字段都标了 volatile（`chain` 整节点 volatile，因为数组元素
//    没有固定路径）。宿主保存时只热替换 volatile 引用、不重启插件
//    （cordis-plugin-loader/lib/index.js:379-422），因此运行期**只持有读取器**
//    （`ConfigReader`）：每次工具调用现读，绝不缓存 `ResolvedConfig` 快照。
//    机制细节与「为什么自己实现协议」见 volatile.ts 顶部注释。
//
// B. **无 key 也能装、能用、能看懂**
//    缺凭据永远不阻断装载：工具照常注册，调用时返回分类错误，文案直接指向
//    「Settings → Plugins → tlsearch」这一处可点的修复位置。
//
// 装配期只做四件事，且全部可能失败的环节都不抛错：
//   1. 打印一行可核对的生效配置（含缺失凭据的告警，但不阻断装载）；
//   2. 注册工具（ctx.tools 未就绪时告警降级）；
//   3. 订阅 volatile 热更新：重新打印生效配置 + 按需增删额度工具；
//   4. 绑定可逆注销：在途请求中止 + 熔断器复位 + 工具摘除。
//
// ── 关于「可逆注销」的一个宿主事实 ───────────────────────────────────────────
// Cordis 3.0.0 的 MainScope.apply 是 `this.ensure(async () => plugin.apply(context, config))`，
// 即 **apply 的返回值被直接丢弃**，宿主不会把它当作 disposer 调用。
// 因此真正的卸载路径必须是「绑定在 ctx 上的副作用」：
//   - 工具注销器由 ctx.tools.register 返回，本身就是一个 ctx effect（自动回收）；
//   - 在途请求的中止、熔断器复位通过 ctx.on('dispose', …) 触发。
// 本文件**同时**返回一个幂等的 dispose 函数：对会消费返回值的宿主（以及单测）
// 它是可用的注销入口，对不消费的宿主则完全无害。

import type { Context } from 'cordis'
import Schema from 'schemastery'
import { CircuitBreaker } from './http.js'
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_THRESHOLD,
  LIMITS,
  PROVIDER_IDS,
  resolveRuntime,
  usableError,
} from './providers.js'
import { SEARCH_TOOL_NAME, registerSearchTools, type SearchToolRuntime } from './tool.js'
import type { ConfigReader, ProviderId, ResolvedConfig, SearchPluginConfig } from './types.js'
import { unwrapVolatile, volatile, withVolatileRefs } from './volatile.js'

// ---------------------------------------------------------------------------
// 对外再导出（构建产物完整性 + 便于嵌入式复用与回归断言）
// ---------------------------------------------------------------------------
export { CircuitBreaker, SearchError, fetchJson } from './http.js'
export type { JsonRequest, SearchErrorCode } from './http.js'
export {
  BREAKER_COOLDOWN_MS,
  BREAKER_THRESHOLD,
  DEFAULT_BASE_URL,
  DEFAULT_PROVIDER,
  LIMITS,
  PROVIDERS,
  PROVIDER_IDS,
  clampNumber,
  fetchQuotaLine,
  isProviderId,
  normalizeHits,
  providerLabel,
  resolveRuntime,
  runBackendSearch,
  runProviderSearch,
  usableError,
} from './providers.js'
export type { ProviderAdapter } from './providers.js'
export {
  TOOL_RESULT_SCHEMA,
  estimateChars,
  renderJson,
  renderMarkdown,
  renderOutcome,
  toContentBlocks,
  toToolResult,
} from './format.js'
export type { ToolResultEnvelope, ToolTextBlock } from './format.js'
export {
  SEARCH_TOOL_DESCRIPTION,
  SEARCH_TOOL_NAME,
  USAGE_TOOL_DESCRIPTION,
  USAGE_TOOL_NAME,
  createSearchTool,
  createUsageTool,
  registerSearchTools,
} from './tool.js'
export type { SearchToolArgs, SearchToolRuntime, ToolRegistration } from './tool.js'
export {
  cleanSnippet,
  cleanText,
  cleanTitle,
  collapseWhitespace,
  decodeEntities,
  normalizeUrl,
  stripHtml,
  truncateText,
} from './sanitize.js'
export { createVolatileRef, isVolatileRef, unwrapVolatile, volatile, withVolatileRefs } from './volatile.js'
export type { VolatileRef } from './volatile.js'
export type {
  BackendConfig,
  ConfigReader,
  FallbackConfig,
  OutputFormat,
  ProviderId,
  ResolvedConfig,
  SearchHit,
  SearchOutcome,
  SearchPluginConfig,
} from './types.js'

/**
 * 插件配置类型别名。
 *
 * 与下面的 `Config` 常量同名但分属类型空间与值空间——这正是 DSH 插件的惯例写法
 * （参照 tlmemory）：`cordis.patch.yml` 里的 config 由 `Config` schema 校验，
 * 而 TypeScript 使用方引用 `Config` 类型。
 *
 * 运行时注意：校验后的对象里，**每个字段都是 volatile 引用**（`{ get() }`），
 * 不是裸值。要裸值请走 `unwrapVolatile()`，或直接用 `apply()` 内部的读取器。
 */
export type Config = SearchPluginConfig

/**
 * 插件配置 Schema：设置页表单 + 装载期校验 + 热更新引用。
 *
 * 每个叶子字段都包了 `volatile()`：
 *   - 设置页只为 volatile 字段生成表单（dsh-settings/lib/index.js:122 `volatileForm`）；
 *   - 保存时 Loader 只热替换引用、不重启插件（这就是「改完立即生效」）。
 *
 * `chain` 是**整节点** volatile：数组元素没有固定路径，宿主
 * `validateVolatilePlacement` 也拒绝「元素 + 外层 volatile」以外的组合
 * （dsh-app-boot/lib/index.js:2611）。所以它在设置页里是一个 JSON 数组编辑器。
 */
export const Config: Schema<SearchPluginConfig> = withVolatileRefs(
  Schema.object({
    provider: volatile(
      Schema.union([...PROVIDER_IDS])
        .default('tavily')
        .description('主后端：tavily / searxng（自建，无需密钥）/ google（CSE，免费额度最大）/ brave / exa'),
    ),
    apiKey: volatile(
      Schema.string()
        .default('')
        // secret：宿主的 describe() 会把该字段从 value 里摘掉，只在 secrets[] 里留
        // `{path, set}`（dsh-settings/lib/index.js:22-60, 73-95）。所以拿不到回显值，
        // 只能知道「配了没」——面板据此显示「已保存（不回显）」且留空即保持原值。
        .role('secret')
        .description('主后端 API Key；SearXNG 可留空。留空时回退环境变量 TLSEARCH_API_KEY 或各后端专用变量'),
    ),
    baseUrl: volatile(
      Schema.string()
        .default('')
        .description('主后端端点根地址（SearXNG 必填）。可指向自建实例或中转网关；留空用后端默认端点'),
    ),
    cx: volatile(
      Schema.string()
        .default('')
        .description('Google CSE 的引擎 ID（provider=google 时必填）。回退环境变量 TLSEARCH_CX / GOOGLE_CSE_ID'),
    ),
    fallback: Schema.object({
      // 只让叶子 volatile：`fallback` 本身是固定路径的对象，标记外层会把
      // 「整个 fallback」变成一个引用，宿主表单就退化成一段 JSON 文本
      provider: volatile(
        Schema.union(['none', ...PROVIDER_IDS])
          .default('none')
          .description('备用后端；none 表示不启用。等价于 chain 的第一个元素（兼容旧配置）'),
      ),
      apiKey: volatile(
        Schema.string().default('').role('secret').description('备用后端 API Key；留空回退该后端的环境变量'),
      ),
      baseUrl: volatile(Schema.string().default('').description('备用后端端点根地址（备用为 SearXNG 时必填）')),
      cx: volatile(Schema.string().default('').description('备用后端的 Google CSE 引擎 ID（仅备用为 google 时用）')),
    }).description('单备用后端（简写）。多级调度建议用 chain'),

    chain: volatile(
      Schema.array(
        Schema.object({
          // provider 故意给默认值而不是必填：链里写错一项只会被跳过，
          // 绝不因为一个笔误让整条 profile 起不来
          provider: Schema.union(['none', ...PROVIDER_IDS]).default('none').description('该级后端'),
          apiKey: Schema.string().default('').description('该级 API Key；留空回退该后端的环境变量'),
          baseUrl: Schema.string().default('').description('该级端点根地址（SearXNG 必填）'),
          cx: Schema.string().default('').description('该级 Google CSE 引擎 ID（仅 google 用）'),
        }),
      ).description(
        '后备后端链：主后端失败/熔断时按数组顺序依次尝试。重复的 provider 只保留首次出现。' +
          '在设置页里以 JSON 数组编辑，例如 [{"provider":"exa","apiKey":"…"}]',
      ),
    ),

    maxResults: volatile(
      Schema.number()
        .min(LIMITS.minResults)
        .max(LIMITS.maxResults)
        .default(LIMITS.defaultResults)
        .description(`单次搜索返回条数上限（${LIMITS.minResults}-${LIMITS.maxResults}），默认 ${LIMITS.defaultResults}`),
    ),
    maxSnippetChars: volatile(
      Schema.number()
        .min(LIMITS.minSnippetChars)
        .max(LIMITS.maxSnippetChars)
        .default(LIMITS.defaultSnippetChars)
        .description(`单条摘要字符上限，默认 ${LIMITS.defaultSnippetChars}；这是控制 Token 膨胀的主要旋钮`),
    ),
    timeoutMs: volatile(
      Schema.number()
        .min(LIMITS.minTimeoutMs)
        .max(LIMITS.maxTimeoutMs)
        .default(LIMITS.defaultTimeoutMs)
        .description(`单次请求超时（毫秒），默认 ${LIMITS.defaultTimeoutMs}；超时即中止并计入熔断`),
    ),
    language: volatile(Schema.string().default('').description('检索语言（如 zh / en）；留空由后端自行判定')),
    includeAnswer: volatile(
      Schema.boolean()
        .default(false)
        .description('是否附带后端给出的一句话答案（Tavily answer / SearXNG answers），默认 false 以省 Token'),
    ),
    outputFormat: volatile(
      Schema.union(['markdown', 'json'])
        .default('markdown')
        .description('模型可见结果的呈现格式：markdown（默认，最省 Token）/ json（结构化，便于精确解析）'),
    ),
  }),
)

/** Cordis 插件名（与 package.json 的包名解耦：宿主日志与补丁文件里显示这个名字） */
export const name = 'tlsearch'

/** 依赖注入：没有工具服务就没有可注册的对象，因此显式声明硬依赖 */
export const inject = ['tools']

/**
 * 在途请求 / 熔断状态。
 *
 * 与配置无关的部分抽成一个小工厂，`apply` 里只负责生命周期编排。
 */
interface RuntimeState {
  inFlight: Set<AbortController>
  breakers: Map<ProviderId, CircuitBreaker>
  breakerFor: (provider: ProviderId) => CircuitBreaker
  track: (controller: AbortController) => () => void
  reset: () => void
}

function createRuntimeState(): RuntimeState {
  /** 在途请求控制器集合：卸载时统一中止，避免请求悬挂到超时 */
  const inFlight = new Set<AbortController>()

  /**
   * 每个后端一个熔断器。
   *
   * 绝不能共用：SearXNG 连续失败会把 Tavily 一起熔断，而 Tavily 明明健康——
   * 那正好摧毁了「主备互补」的全部价值。
   */
  const breakers = new Map<ProviderId, CircuitBreaker>()
  const breakerFor = (provider: ProviderId): CircuitBreaker => {
    const existing = breakers.get(provider)
    if (existing) return existing
    const created = new CircuitBreaker(BREAKER_THRESHOLD, BREAKER_COOLDOWN_MS)
    breakers.set(provider, created)
    return created
  }

  return {
    inFlight,
    breakers,
    breakerFor,
    track(controller) {
      inFlight.add(controller)
      return () => {
        inFlight.delete(controller)
      }
    },
    reset() {
      for (const controller of inFlight) controller.abort()
      inFlight.clear()
      for (const breaker of breakers.values()) breaker.reset()
      breakers.clear()
    },
  }
}

/**
 * 打印一行可核对的生效配置。
 *
 * 用户排查「到底打到哪个端点」时，这一行日志比翻配置文件快得多。
 * 整条**调度链**按尝试顺序打印 —— 这行日志就是调度规则的可执行说明。
 * 只打印端点与限额，绝不打印 apiKey。
 */
function logEffective(ctx: Context, resolved: ResolvedConfig, prefix = '装配'): void {
  const describe = (backend: { provider: ProviderId; baseUrl: string }): string =>
    `${backend.provider}@${backend.baseUrl.length > 0 ? backend.baseUrl : '(未配置端点)'}`
  const chainText = resolved.backends
    .map((backend, index) => `${index === 0 ? '主' : `备${index}`}=${describe(backend)}`)
    .join(' → ')
  ctx.logger?.info?.(
    `[tlsearch] ${prefix}: ${chainText}` +
      ` maxResults=${resolved.maxResults} maxSnippetChars=${resolved.maxSnippetChars}` +
      ` timeoutMs=${resolved.timeoutMs} format=${resolved.outputFormat}` +
      ` language=${resolved.language.length > 0 ? resolved.language : '(auto)'}` +
      ` includeAnswer=${resolved.includeAnswer}`,
  )
}

/**
 * 可用性只在「调用时」判定，但装配期与每次热更新后都要告警：
 * 缺凭据时工具**保持注册**（与宿主原生 web 服务一致），调用返回分类错误，
 * 让模型能把「去哪儿补配置」原样转述给用户，而不是让整个 profile 装载失败。
 *
 * 逐个后端检查：链里坏掉一两级仍能正常工作，只是少一层兜底，
 * 所以「全部不可用」才算故障，部分不可用只是提示。
 */
function reportUsability(ctx: Context, resolved: ResolvedConfig, prefix = ''): void {
  const verdicts = resolved.backends.map((backend) => ({ backend, problem: usableError(backend) }))
  const unusable = verdicts.flatMap((verdict) =>
    verdict.problem ? [{ provider: verdict.backend.provider, message: verdict.problem.message }] : [],
  )
  const detail = unusable.map((entry) => `${entry.provider} — ${entry.message}`).join(' | ')
  if (unusable.length === verdicts.length) {
    ctx.logger?.warn?.(`[tlsearch] ${prefix}所有后端都不可用（工具仍注册，调用时会返回分类错误）: ${detail}`)
  } else if (unusable.length > 0) {
    // 链上坏掉一两级仍能正常搜索（只是少一层兜底），所以这是提示而非告警。
    // 降为 info 也是为了让「真的全挂了」那条 warn 保持信噪比。
    ctx.logger?.info?.(`[tlsearch] ${prefix}链上有 ${unusable.length} 级后端暂不可用，将被自动跳过: ${detail}`)
  }
}

/**
 * 插件装配。
 *
 * @param ctx    Cordis 上下文（宿主已挂载 tools 服务）
 * @param config 已由 Config schema 校验的配置（字段是 volatile 引用，不是裸值）
 * @returns      幂等注销函数（对消费 apply 返回值的宿主有效；不消费也无副作用残留）
 */
export function apply(ctx: Context, config: Config = {}): () => void {
  // 保留**原始**配置对象（字段可能是 volatile 引用），每次需要时现解包 + 现解析。
  // 这就是「不缓存快照」的全部实现：没有 `const resolved = …` 的长期持有。
  const raw = config as unknown as Record<string, unknown>

  /**
   * 双路回读，都是「当前值」，没有一路是陈旧快照：
   *   - 优先 `ctx.fiber.config`：宿主每次写入配置都会更新它（cordis `MainScope.apply`
   *     与 Loader 的 volatile 快路径都会替换 fiber 上的 config），tlmemory 的
   *     `liveConfig()` 走的也是这条路，已在 0.2.1-rc.2 实测有效；
   *   - 退回 `apply` 收到的对象：单测与嵌入式调用传的是纯对象，没有 fiber 可读。
   * 两者都可能是「带 volatile 引用的校验产物」，所以统一 `unwrapVolatile()` 再解析。
   */
  const fiber = (ctx as unknown as { fiber?: { config?: unknown } }).fiber
  const readCurrent = (): unknown => {
    const current = fiber?.config
    return current !== null && typeof current === 'object' ? current : raw
  }
  const reader: ConfigReader = {
    read: () => resolveRuntime(unwrapVolatile(readCurrent()) as SearchPluginConfig),
  }

  logEffective(ctx, reader.read())
  reportUsability(ctx, reader.read())

  const state = createRuntimeState()
  const runtime: SearchToolRuntime = {
    ctx,
    config: reader,
    breakerFor: state.breakerFor,
    track: state.track,
  }

  const registration = registerSearchTools(runtime)
  const disposers: Array<() => void> = [() => registration.dispose()]
  let disposed = false

  /**
   * 热更新钩子。
   *
   * 宿主写完 volatile 引用后发这个事件（cordis-plugin-loader/lib/index.js:415-421），
   * 此时**配置已经生效**，本插件要做的只有两件**结构性**的事：
   *   1. 重新打印生效配置（用户改完立刻能在日志里核对）；
   *   2. 按新配置增删额度工具（工具清单是结构性的，只能注册/注销，不能靠“现读”变出来）。
   * 监听器自身的异常必须吞掉：热更新路径上的异常会让宿主回滚整次保存。
   */
  const offVolatile = (ctx.on as unknown as (name: string, listener: (...args: unknown[]) => void) => unknown)(
    'loader/volatile-update',
    (...args: unknown[]) => {
      try {
        const paths = Array.isArray(args[0]) ? (args[0] as string[][]) : []
        const changed = paths.map((path) => path.join('.')).filter((path) => path.length > 0)
        const resolved = reader.read()
        logEffective(ctx, resolved, changed.length > 0 ? `配置热更新（${changed.join(', ')}）` : '配置热更新')
        reportUsability(ctx, resolved, '热更新后')
        registration.refresh()
      } catch (error) {
        ctx.logger?.warn?.('[tlsearch] 热更新回调异常（配置本身已生效）:', error)
      }
    },
  )
  if (typeof offVolatile === 'function') disposers.push(offVolatile as () => void)

  /** 幂等注销：中止在途请求 → 复位熔断 → 摘除工具（逐个隔离异常，一个失败不影响其余） */
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    state.reset()
    for (const disposer of disposers.splice(0)) {
      try {
        disposer()
      } catch (error) {
        ctx.logger?.error?.('[tlsearch] 注销步骤异常（已隔离）:', error)
      }
    }
    ctx.logger?.info?.(`[tlsearch] 插件已注销（工具 ${SEARCH_TOOL_NAME} 已摘除，在途请求已中止）`)
  }

  // 真正的卸载钩子：Cordis 会在上下文销毁时触发（apply 的返回值宿主并不消费）
  ctx.on('dispose', dispose)
  return dispose
}
