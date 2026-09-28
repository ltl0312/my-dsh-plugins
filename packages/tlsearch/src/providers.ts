// packages/tlsearch/src/providers.ts
//
// 搜索引擎后端适配层：Tavily / Brave / SearXNG。
//
// 每个适配器只做两件事——「把查询翻译成一次 HTTP 请求」与「把响应翻译成 SearchHit[]」。
// 清洗、去重、截断、限流全部由共享的下游管线负责，新增后端不需要重复实现这些逻辑。
//
// 三个后端的响应形状差异极大（Tavily 用 content、Brave 用 description 且带 HTML、
// SearXNG 用 content 且可能是聚合结果），因此解析必须逐后端显式编写，
// 绝不做「猜字段名」的通用兜底——猜错的代价是把引擎的报错信息当成摘要喂给模型。
//
// 官方文档：
//   Tavily  https://docs.tavily.com/documentation/api-reference/endpoint/search
//   Brave   https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
//   SearXNG https://docs.searxng.org/dev/search_api.html

import { SearchError, fetchJson, type JsonRequest } from './http.js'
import { cleanSnippet, cleanText, cleanTitle, normalizeUrl, truncateText } from './sanitize.js'
import type { ProviderId, ResolvedConfig, SearchHit, SearchOutcome, SearchPluginConfig } from './types.js'

/** 默认后端：Tavily（结构化 JSON、字段干净、有免费额度） */
export const DEFAULT_PROVIDER: ProviderId = 'tavily'

/** 合法的后端标识（供 schema 与运行期防御式校验共用） */
export const PROVIDER_IDS: readonly ProviderId[] = ['tavily', 'brave', 'searxng']

/** 后端内置默认端点；SearXNG 没有公共实例，必须由用户显式配置 */
export const DEFAULT_BASE_URL: Partial<Record<ProviderId, string>> = {
  tavily: 'https://api.tavily.com',
  brave: 'https://api.search.brave.com',
}

/**
 * API Key 的环境变量回退（顺序即优先级）。
 *
 * 存在两个层次：`TLSEARCH_API_KEY` 是本插件的通用变量（切换后端时不必改部署脚本），
 * 其后是各后端的惯用变量名（复用已有部署、避免密钥写进配置文件）。
 */
const API_KEY_ENV: Record<ProviderId, readonly string[]> = {
  tavily: ['TLSEARCH_API_KEY', 'TAVILY_API_KEY'],
  brave: ['TLSEARCH_API_KEY', 'BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY'],
  searxng: ['TLSEARCH_API_KEY'],
}

/** 端点地址的环境变量回退 */
const BASE_URL_ENV: Record<ProviderId, readonly string[]> = {
  tavily: ['TLSEARCH_BASE_URL', 'TAVILY_BASE_URL'],
  brave: ['TLSEARCH_BASE_URL', 'BRAVE_BASE_URL'],
  searxng: ['TLSEARCH_BASE_URL', 'SEARXNG_BASE_URL'],
}

/** 插件 UA：部分 SearXNG 实例与网关会拒绝无 UA 的请求 */
const PLUGIN_UA = 'dsh-plugin-tlsearch (+https://github.com/ltl0312/my-dsh-plugins)'

/** 配置边界（同时用于 schemastery 与运行期钳制，保证手改配置也无法越界） */
export const LIMITS = {
  minResults: 1,
  maxResults: 10,
  defaultResults: 5,
  minSnippetChars: 40,
  maxSnippetChars: 2000,
  defaultSnippetChars: 250,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 60_000,
  defaultTimeoutMs: 15_000,
} as const

/** 连续失败多少轮触发熔断 */
export const BREAKER_THRESHOLD = 3
/** 熔断冷却时长（毫秒） */
export const BREAKER_COOLDOWN_MS = 60_000

/**
 * 数值钳制：非有限数一律退回 fallback，绝不把 NaN 带进 URL 与配置。
 *
 * 「未提供」与「提供了 0」必须区分开，且不能依赖 Number() 的隐式转换——
 * `Number(null) === 0`、`Number('') === 0`、`Number(false) === 0`、`Number([]) === 0`，
 * 若直接喂给 Number() 再钳制，一个 `maxResults: ''`（设置界面留空时的常见形态）
 * 会被静默压成下限 1 条，而不是回到默认值 5 条。因此这里先显式判定类型：
 * 只有数字与非空数字字符串算「提供了值」，其余一律视为未提供。
 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  let numeric: number
  if (typeof value === 'number') numeric = value
  else if (typeof value === 'string' && value.trim().length > 0) numeric = Number(value)
  else return fallback
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.floor(numeric)))
}

/** 环境变量读取（空串视为未设置） */
function envValue(keys: readonly string[]): string {
  for (const key of keys) {
    const raw = process.env[key]
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
  }
  return ''
}

/** 拼接端点路径：容忍 baseUrl 带/不带结尾斜杠，也容忍它自带路径前缀（自建代理常见） */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/** 载荷宽化：只接受非 null 对象，其余一律当作「无此字段」 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** 数组字段读取：非数组一律返回空数组 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 字符串字段读取：非字符串返回空串（交由清洗层决定是否丢弃） */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 后端适配器接口 */
export interface ProviderAdapter {
  readonly id: ProviderId
  readonly label: string
  /** 是否必须提供 API Key */
  readonly requiresKey: boolean
  /** 是否必须提供端点地址（无内置默认值） */
  readonly requiresBaseUrl: boolean
  /** 组装一次请求 */
  build: (rt: ResolvedConfig, query: string, limit: number, signal?: AbortSignal) => JsonRequest
  /** 解析响应为原始命中（尚未清洗/去重/截断） */
  parse: (payload: unknown, rt: ResolvedConfig) => SearchOutcome
}

/**
 * Tavily。
 *
 * 请求体刻意写死 `include_raw_content: false` 与 `include_images: false`：
 * raw_content 是整页正文（单条可达数万字符），images 是图片数组——两者都会
 * 直接摧毁本插件的上下文预算，且与「返回可引用的来源摘要」这一目标无关。
 *
 * 密钥同时以 `Authorization: Bearer` 与请求体 `api_key` 两种形式携带：
 * 官方端点接受前者并忽略重复字段；new-api 这类自建/中转网关往往只读请求体。
 * 两条路径都覆盖，用户换端点时不必改插件。
 */
const tavily: ProviderAdapter = {
  id: 'tavily',
  label: 'Tavily',
  requiresKey: true,
  requiresBaseUrl: false,
  build(rt, query, limit, signal) {
    const body: Record<string, unknown> = {
      query,
      max_results: limit,
      search_depth: 'basic',
      include_answer: rt.includeAnswer,
      include_raw_content: false,
      include_images: false,
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': PLUGIN_UA,
    }
    if (rt.apiKey.length > 0) {
      headers.authorization = `Bearer ${rt.apiKey}`
      body.api_key = rt.apiKey
    }
    return {
      url: joinUrl(rt.baseUrl, '/search'),
      init: { method: 'POST', headers, body: JSON.stringify(body) },
      timeoutMs: rt.timeoutMs,
      provider: 'tavily',
      signal,
    }
  },
  parse(payload, rt) {
    const record = asRecord(payload)
    if (!record) return { hits: [] }
    const hits = asArray(record.results).map((entry) => {
      const item = asRecord(entry)
      return {
        title: asString(item?.title),
        url: asString(item?.url),
        snippet: asString(item?.content),
      }
    })
    const answer = rt.includeAnswer ? cleanText(record.answer) : ''
    return answer.length > 0 ? { hits, answer } : { hits }
  },
}

/**
 * Brave Search API。
 *
 * `text_decorations=false` 让 Brave 不要把命中词包进 `<strong>`/`<em>`：
 * 这是**从源头**省掉一批标签，比事后剥离更省字符串处理，也让摘要更易读。
 * `result_filter=web` 只取网页垂直，避免 infobox / faq / 视频等结构化噪声
 * （它们既占带宽又几乎不会成为有效引用）。
 * `count` 上限 20，这里已由 LIMITS.maxResults=10 约束在更安全的范围内。
 */
const brave: ProviderAdapter = {
  id: 'brave',
  label: 'Brave Search',
  requiresKey: true,
  requiresBaseUrl: false,
  build(rt, query, limit, signal) {
    const params = new URLSearchParams({
      q: query,
      count: String(limit),
      text_decorations: 'false',
      result_filter: 'web',
    })
    if (rt.language.length > 0) params.set('search_lang', rt.language)
    return {
      url: `${joinUrl(rt.baseUrl, '/res/v1/web/search')}?${params.toString()}`,
      init: {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-subscription-token': rt.apiKey,
          'user-agent': PLUGIN_UA,
        },
      },
      timeoutMs: rt.timeoutMs,
      provider: 'brave',
      signal,
    }
  },
  parse(payload) {
    const web = asRecord(asRecord(payload)?.web)
    const hits = asArray(web?.results).map((entry) => {
      const item = asRecord(entry)
      return {
        title: asString(item?.title),
        url: asString(item?.url),
        snippet: asString(item?.description),
      }
    })
    return { hits }
  },
}

/**
 * SearXNG（自建/公共实例）。
 *
 * 无需密钥，但**必须**显式给出 baseUrl：SearXNG 是自托管元搜索引擎，没有官方
 * 公共端点，任何内置默认值都等于把用户查询发往一台陌生服务器。
 *
 * 另一个关键前提：SearXNG 默认只对浏览器提供 HTML，必须在 `settings.yml` 的
 * `search.formats` 中加入 `json` 才会返回 JSON。这里无法事先探测，因此把该提示
 * 放进「非 JSON 响应」的错误文案里（见 http.ts 的 nonJsonHint）。
 */
const searxng: ProviderAdapter = {
  id: 'searxng',
  label: 'SearXNG',
  requiresKey: false,
  requiresBaseUrl: true,
  build(rt, query, limit, signal) {
    const params = new URLSearchParams({ q: query, format: 'json', pageno: '1' })
    if (rt.language.length > 0) params.set('language', rt.language)
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': PLUGIN_UA,
    }
    if (rt.apiKey.length > 0) headers.authorization = `Bearer ${rt.apiKey}`
    return {
      url: `${joinUrl(rt.baseUrl, '/search')}?${params.toString()}`,
      init: { method: 'GET', headers },
      timeoutMs: rt.timeoutMs,
      provider: 'searxng',
      signal,
    }
  },
  parse(payload, rt) {
    const record = asRecord(payload)
    const hits = asArray(record?.results).map((entry) => {
      const item = asRecord(entry)
      return {
        title: asString(item?.title),
        url: asString(item?.url),
        snippet: asString(item?.content),
      }
    })
    // SearXNG 的 answers 是「引擎直接给出结论」的短数组（如计算、天气），
    // 仅在显式开启 includeAnswer 时并入，且只取第一条，避免拼成一整段。
    if (!rt.includeAnswer) return { hits }
    const answer = asArray(record?.answers).find((entry) => typeof entry === 'string' && entry.length > 0)
    return typeof answer === 'string' ? { hits, answer: cleanText(answer) } : { hits }
  },
}

/** 后端注册表 */
export const PROVIDERS: Record<ProviderId, ProviderAdapter> = { tavily, brave, searxng }

/** 判定任意值是否为受支持的后端标识 */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

/**
 * 把插件配置解析为运行期配置：补默认值、读环境变量、按 LIMITS 钳制。
 *
 * 刻意**不抛错**：DSH 的插件装载发生在宿主启动路径上，配置缺一个密钥就抛异常
 * 会让整条 profile 装载失败，而正确行为是「工具照常注册，调用时返回可据以行动的
 * 错误」（与宿主原生 web 服务一致：缺凭据时 schema 仍保持注册）。
 * 可用性判定交给 usableError()，在每次调用前执行。
 */
export function resolveRuntime(config: SearchPluginConfig = {}): ResolvedConfig {
  const provider: ProviderId = isProviderId(config.provider) ? config.provider : DEFAULT_PROVIDER
  const explicitBaseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : ''
  const baseUrl = explicitBaseUrl.length > 0
    ? explicitBaseUrl
    : envValue(BASE_URL_ENV[provider]) || DEFAULT_BASE_URL[provider] || ''
  const explicitKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  const apiKey = explicitKey.length > 0 ? explicitKey : envValue(API_KEY_ENV[provider])
  const language = typeof config.language === 'string' ? config.language.trim() : ''

  return {
    provider,
    apiKey,
    baseUrl,
    maxResults: clampNumber(config.maxResults, LIMITS.minResults, LIMITS.maxResults, LIMITS.defaultResults),
    maxSnippetChars: clampNumber(
      config.maxSnippetChars,
      LIMITS.minSnippetChars,
      LIMITS.maxSnippetChars,
      LIMITS.defaultSnippetChars,
    ),
    timeoutMs: clampNumber(config.timeoutMs, LIMITS.minTimeoutMs, LIMITS.maxTimeoutMs, LIMITS.defaultTimeoutMs),
    language,
    includeAnswer: config.includeAnswer === true,
    outputFormat: config.outputFormat === 'json' ? 'json' : 'markdown',
  }
}

/**
 * 可用性前置判定：配置不完整时返回分类错误，否则返回 null。
 *
 * 错误文案必须点到「去哪儿改」——模型读到它时，唯一能做的就是转述给用户并给出
 * 具体路径；只说 "missing apiKey" 会让用户在自己的配置文件里盲找。
 */
export function usableError(rt: ResolvedConfig): SearchError | null {
  const adapter = PROVIDERS[rt.provider]
  if (!adapter) {
    return new SearchError(
      `unknown search provider "${rt.provider}" (supported: ${PROVIDER_IDS.join(', ')}).`,
      'config',
    )
  }
  if (adapter.requiresBaseUrl && rt.baseUrl.length === 0) {
    return new SearchError(
      `provider "${adapter.id}" requires a baseUrl: SearXNG is self-hosted and has no default endpoint. ` +
        'Set it under Settings > Plugins > Plugin configuration > tlsearch, or via the TLSEARCH_BASE_URL environment variable.',
      'config',
    )
  }
  if (adapter.requiresKey && rt.apiKey.length === 0) {
    return new SearchError(
      `provider "${adapter.id}" requires an API key. ` +
        'Set it under Settings > Plugins > Plugin configuration > tlsearch (apiKey), ' +
        `or via the TLSEARCH_API_KEY / ${API_KEY_ENV[adapter.id][1] ?? 'provider-specific'} environment variable.`,
      'credential',
    )
  }
  return null
}

/** 标题字符上限：标题本应很短，超长只可能来自异常端点或整段 HTML 被当作标题 */
const MAX_TITLE_CHARS = 300

/**
 * 归一化管线：清洗 → 剔除无 URL 的条目 → 按 URL 去重 → 截断到 limit。
 *
 * 顺序有意义：必须在**去重之后**才按 limit 截断，否则同一篇文章的多个镜像
 * 会先占满名额再被去重，最终返回的条目数远少于请求数。
 */
export function normalizeHits(raw: readonly SearchHit[], rt: ResolvedConfig, limit: number): SearchHit[] {
  const out: SearchHit[] = []
  const seen = new Set<string>()
  for (const hit of raw) {
    const url = normalizeUrl(hit.url)
    if (url.length === 0 || seen.has(url)) continue
    seen.add(url)
    const title = cleanTitle(hit.title)
    out.push({
      // 标题缺失时退化为 URL：既保住「可引用」，也避免渲染出孤零零的「1. — url」
      title: title.length > 0 ? truncateText(title, MAX_TITLE_CHARS) : url,
      url,
      snippet: cleanSnippet(hit.snippet, rt.maxSnippetChars),
    })
    if (out.length >= limit) break
  }
  return out
}

/**
 * 执行一次搜索：可用性判定 → 组装请求 → 网络 → 解析 → 归一化。
 *
 * 这里是唯一需要感知「后端差异」之上的公共逻辑的位置，因此熔断计数（由调用方
 * 基于本函数的结果决定）之外的一切都收敛在此，tool.ts 只负责策略与呈现。
 */
export async function runProviderSearch(
  rt: ResolvedConfig,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const unavailable = usableError(rt)
  if (unavailable) throw unavailable

  const adapter = PROVIDERS[rt.provider]
  const payload = await fetchJson(adapter.build(rt, query, limit, signal))
  const outcome = adapter.parse(payload, rt)
  return { ...outcome, hits: normalizeHits(outcome.hits, rt, limit) }
}
