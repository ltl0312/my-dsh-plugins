// packages/tlsearch/src/index.ts
//
// 插件入口与装配中心。
//
// 目标：替代/补充 DSH 原生 web_search，把「一次搜索」的上下文成本压到最低，
// 同时让后端可插拔（Tavily / SearXNG / Google CSE / Brave / Exa）、端点可自建，
// 并支持**主备自动切换**：主后端失败或熔断时静默改用备用后端。
//
// 装配期只做四件事，且全部可能失败的环节都不抛错：
//   1. 解析运行期配置（补默认值 / 读环境变量 / 钳制边界）；
//   2. 打印一行可核对的生效配置（含缺失凭据的告警，但不阻断装载）；
//   3. 注册工具（ctx.tools 未就绪时告警降级）；
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
import type { ProviderId, SearchPluginConfig } from './types.js'

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
export type { SearchToolArgs, SearchToolRuntime } from './tool.js'
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
export type {
  BackendConfig,
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
 */
export type Config = SearchPluginConfig

/** 插件配置 Schema：在 DSH 设置界面渲染表单，并在装载时补默认值 */
export const Config: Schema<SearchPluginConfig> = Schema.object({
  provider: Schema.union([...PROVIDER_IDS])
    .default('tavily')
    .description('主后端：tavily / searxng（自建，无需密钥）/ google（CSE，免费额度最大）/ brave / exa'),
  apiKey: Schema.string()
    .default('')
    .description('主后端 API Key；SearXNG 可留空。留空时回退环境变量 TLSEARCH_API_KEY 或各后端专用变量'),
  baseUrl: Schema.string()
    .default('')
    .description('主后端端点根地址（SearXNG 必填）。可指向自建实例或中转网关；留空用后端默认端点'),
  cx: Schema.string()
    .default('')
    .description('Google CSE 的引擎 ID（provider=google 时必填）。回退环境变量 TLSEARCH_CX / GOOGLE_CSE_ID'),
  fallback: Schema.object({
    provider: Schema.union(['none', ...PROVIDER_IDS])
      .default('none')
      .description('备用后端；none 表示不启用。等价于 chain 的第一个元素（兼容旧配置）'),
    apiKey: Schema.string().default('').description('备用后端 API Key；留空回退该后端的环境变量'),
    baseUrl: Schema.string().default('').description('备用后端端点根地址（备用为 SearXNG 时必填）'),
    cx: Schema.string().default('').description('备用后端的 Google CSE 引擎 ID（仅备用为 google 时用）'),
  }).description('单备用后端（简写）。多级调度建议用 chain'),
  chain: Schema.array(
    Schema.object({
      // provider 故意给默认值而不是必填：链里写错一项只会被跳过，
      // 绝不因为一个笔误让整条 profile 起不来
      provider: Schema.union(['none', ...PROVIDER_IDS]).default('none').description('该级后端'),
      apiKey: Schema.string().default('').description('该级 API Key；留空回退该后端的环境变量'),
      baseUrl: Schema.string().default('').description('该级端点根地址（SearXNG 必填）'),
      cx: Schema.string().default('').description('该级 Google CSE 引擎 ID（仅 google 用）'),
    }),
  ).description('后备后端链：主后端失败/熔断时按数组顺序依次尝试。重复的 provider 只保留首次出现'),
  maxResults: Schema.number()
    .min(LIMITS.minResults)
    .max(LIMITS.maxResults)
    .default(LIMITS.defaultResults)
    .description(`单次搜索返回条数上限（${LIMITS.minResults}-${LIMITS.maxResults}），默认 ${LIMITS.defaultResults}`),
  maxSnippetChars: Schema.number()
    .min(LIMITS.minSnippetChars)
    .max(LIMITS.maxSnippetChars)
    .default(LIMITS.defaultSnippetChars)
    .description(`单条摘要字符上限，默认 ${LIMITS.defaultSnippetChars}；这是控制 Token 膨胀的主要旋钮`),
  timeoutMs: Schema.number()
    .min(LIMITS.minTimeoutMs)
    .max(LIMITS.maxTimeoutMs)
    .default(LIMITS.defaultTimeoutMs)
    .description(`单次请求超时（毫秒），默认 ${LIMITS.defaultTimeoutMs}；超时即中止并计入熔断`),
  language: Schema.string()
    .default('')
    .description('检索语言（如 zh / en）；留空由后端自行判定'),
  includeAnswer: Schema.boolean()
    .default(false)
    .description('是否附带后端给出的一句话答案（Tavily answer / SearXNG answers），默认 false 以省 Token'),
  outputFormat: Schema.union(['markdown', 'json'])
    .default('markdown')
    .description('模型可见结果的呈现格式：markdown（默认，最省 Token）/ json（结构化，便于精确解析）'),
})

/** Cordis 插件名（与 package.json 的包名解耦：宿主日志与补丁文件里显示这个名字） */
export const name = 'tlsearch'

/** 依赖注入：没有工具服务就没有可注册的对象，因此显式声明硬依赖 */
export const inject = ['tools']

/**
 * 插件装配。
 *
 * @param ctx    Cordis 上下文（宿主已挂载 tools 服务）
 * @param config 已由 Config schema 校验的配置
 * @returns      幂等注销函数（对消费 apply 返回值的宿主有效；不消费也无副作用残留）
 */
export function apply(ctx: Context, config: Config = {}): () => void {
  const resolved = resolveRuntime(config)

  // 生效配置自述：用户排查「到底打到哪个端点」时，这一行日志比翻配置文件快得多。
  // 整条**调度链**按尝试顺序打印 —— 这行日志就是调度规则的可执行说明。
  // 只打印端点与限额，绝不打印 apiKey。
  const describe = (backend: { provider: ProviderId; baseUrl: string }): string =>
    `${backend.provider}@${backend.baseUrl.length > 0 ? backend.baseUrl : '(未配置端点)'}`
  const chainText = resolved.backends
    .map((backend, index) => `${index === 0 ? '主' : `备${index}`}=${describe(backend)}`)
    .join(' → ')
  ctx.logger?.info?.(
    `[tlsearch] 装配: ${chainText}` +
      ` maxResults=${resolved.maxResults} maxSnippetChars=${resolved.maxSnippetChars}` +
      ` timeoutMs=${resolved.timeoutMs} format=${resolved.outputFormat}` +
      ` language=${resolved.language.length > 0 ? resolved.language : '(auto)'}` +
      ` includeAnswer=${resolved.includeAnswer}`,
  )

  // 可用性只在「调用时」判定，但装配期就要告警：
  // 缺凭据时工具**保持注册**（与宿主原生 web 服务一致），调用返回分类错误，
  // 让模型能把「去哪儿补配置」原样转述给用户，而不是让整个 profile 装载失败。
  // 逐个后端检查，把不可用的挑出来 —— 链里坏掉一两级仍能正常工作，只是少一层兜底，
  // 所以「全部不可用」才算故障，部分不可用只是提示。
  const verdicts = resolved.backends.map((backend) => ({ backend, problem: usableError(backend) }))
  const unusable = verdicts.flatMap((verdict) =>
    verdict.problem ? [{ provider: verdict.backend.provider, message: verdict.problem.message }] : [],
  )
  const detail = unusable.map((entry) => `${entry.provider} — ${entry.message}`).join(' | ')
  if (unusable.length === verdicts.length) {
    ctx.logger?.warn?.(`[tlsearch] 所有后端都不可用（工具仍注册，调用时会返回分类错误）: ${detail}`)
  } else if (unusable.length > 0) {
    // 链上坏掉一两级仍能正常搜索（只是少一层兜底），所以这是提示而非告警。
    // 降为 info 也是为了让「真的全挂了」那条 warn 保持信噪比。
    ctx.logger?.info?.(`[tlsearch] 链上有 ${unusable.length} 级后端暂不可用，将被自动跳过: ${detail}`)
  }

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

  const runtime: SearchToolRuntime = {
    ctx,
    config: resolved,
    breakerFor,
    track(controller) {
      inFlight.add(controller)
      return () => {
        inFlight.delete(controller)
      }
    },
  }

  const disposers: Array<() => void> = [registerSearchTools(runtime)]
  let disposed = false

  /** 幂等注销：中止在途请求 → 复位熔断 → 摘除工具（逐个隔离异常，一个失败不影响其余） */
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const controller of inFlight) controller.abort()
    inFlight.clear()
    for (const breaker of breakers.values()) breaker.reset()
    breakers.clear()
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
