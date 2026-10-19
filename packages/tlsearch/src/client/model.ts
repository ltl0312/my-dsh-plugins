// packages/tlsearch/src/client/model.ts
//
// 浏览器半边对「配置长什么样」的独立模型。
//
// 为什么不在客户端 import 服务端的 `Config`：那份 schema 是 schemastery 的实例，
// 打进客户端 bundle 等于把整套校验器 + cosmokit 塞进浏览器，而且服务端模块还牵着
// `node:` 那一侧的用法。这里只复刻**字段表**（键名、范围、可选值），并在
// `tests/client-model.spec.ts` 里与服务端 `PROVIDER_IDS` / 默认值做一致性断言，
// 防止两边悄悄漂移。

/** 设置命名空间 = 宿主 profile 里的插件条目 id，必须等于包名。 */
export const CLIENT_NAMESPACE = 'dsh-plugin-tlsearch'

/** 服务端 `PROVIDER_IDS` 的镜像；顺序只影响下拉框观感。 */
export const PROVIDER_IDS = ['tavily', 'brave', 'searxng', 'google', 'exa'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

/** 下拉框显示名。后端品牌名不翻译。 */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  tavily: 'Tavily',
  brave: 'Brave Search',
  searxng: 'SearXNG',
  google: 'Google',
  exa: 'Exa',
}

/** 与服务端 `LIMITS` 对齐（`src/providers.ts`）。表单只做提示，真正的钳制在服务端。 */
export const LIMITS = {
  minResults: 1,
  maxResults: 10,
  minSnippetChars: 40,
  maxSnippetChars: 2000,
  minTimeoutMs: 1000,
  maxTimeoutMs: 60000,
} as const

/** 一个后端（主后端 / 备用后端 / 后端链里的一项）的表单值。 */
export interface BackendValues {
  provider: string
  apiKey: string
  baseUrl: string
  cx: string
}

export interface FormValues {
  provider: string
  apiKey: string
  baseUrl: string
  cx: string
  fallback: BackendValues
  chain: Array<Record<string, unknown>>
  maxResults: number
  maxSnippetChars: number
  timeoutMs: number
  language: string
  includeAnswer: boolean
  outputFormat: 'markdown' | 'json'
}

/** 表单空白值。与服务端默认值一致：主后端 tavily，5 条，250 字符，15 秒，markdown。 */
export const DEFAULTS: FormValues = {
  provider: 'tavily',
  apiKey: '',
  baseUrl: '',
  cx: '',
  fallback: { provider: 'none', apiKey: '', baseUrl: '', cx: '' },
  chain: [],
  maxResults: 5,
  maxSnippetChars: 250,
  timeoutMs: 15000,
  language: '',
  includeAnswer: false,
  outputFormat: 'markdown',
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function asString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

export function asBoolean(value: unknown): boolean {
  return value === true
}

/** 数字字段：非法就给回落值；合法则钳到 `[min, max]`（服务端还会再钳一次）。 */
export function asNumberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(asString(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** 把宿主给的表单值（可能字段缺失）补成本页需要的样子。 */
export function normalizeValues(raw: unknown): FormValues {
  const source = asRecord(raw)
  const fallback = asRecord(source.fallback)
  const chain = Array.isArray(source.chain)
    ? source.chain.filter((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
    : []
  const format = asString(source.outputFormat)
  return {
    provider: asString(source.provider) || DEFAULTS.provider,
    apiKey: asString(source.apiKey),
    baseUrl: asString(source.baseUrl),
    cx: asString(source.cx),
    fallback: {
      provider: asString(fallback.provider) || 'none',
      apiKey: asString(fallback.apiKey),
      baseUrl: asString(fallback.baseUrl),
      cx: asString(fallback.cx),
    },
    chain: chain as Array<Record<string, unknown>>,
    maxResults: asNumberInRange(source.maxResults, DEFAULTS.maxResults, LIMITS.minResults, LIMITS.maxResults),
    maxSnippetChars: asNumberInRange(
      source.maxSnippetChars,
      DEFAULTS.maxSnippetChars,
      LIMITS.minSnippetChars,
      LIMITS.maxSnippetChars,
    ),
    timeoutMs: asNumberInRange(source.timeoutMs, DEFAULTS.timeoutMs, LIMITS.minTimeoutMs, LIMITS.maxTimeoutMs),
    language: asString(source.language),
    includeAnswer: asBoolean(source.includeAnswer),
    outputFormat: format === 'json' ? 'json' : 'markdown',
  }
}

/** 读一个后端字段（主后端或备用后端）。 */
export function backendOf(values: FormValues, which: 'primary' | 'fallback'): BackendValues {
  if (which === 'fallback') return values.fallback
  return { provider: values.provider, apiKey: values.apiKey, baseUrl: values.baseUrl, cx: values.cx }
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// 后端链：JSON 文本 ↔ 结构化数组
// ---------------------------------------------------------------------------

export type ChainParse =
  | { ok: true; items: Array<Record<string, unknown>> }
  | { ok: false; index: number; error: string }

/** 把链数组序列化成编辑框里的文本（缩进 2，稳定可读）。 */
export function formatChain(items: Array<Record<string, unknown>>): string {
  if (items.length === 0) return '[]'
  return JSON.stringify(items, null, 2)
}

/**
 * 解析编辑框里的 JSON。
 *
 * 比「`JSON.parse` 成功就算过」严格一点：必须是数组，每一项必须是对象，`provider`
 * 必须是已知后端（写错后端名在运行期只会得到一句「未知后端」，很难查）。未知键保留
 * ——配置里可能有本版本还不认识的字段，不能因为一次编辑把它们抹掉。
 */
export function parseChain(text: string): ChainParse {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, items: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return { ok: false, index: -1, error: error instanceof Error ? error.message : String(error) }
  }
  if (!Array.isArray(parsed)) return { ok: false, index: -1, error: 'expected a JSON array' }
  const items: Array<Record<string, unknown>> = []
  for (const [index, entry] of parsed.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, index, error: 'expected an object' }
    }
    const record = entry as Record<string, unknown>
    if (record.provider !== undefined && !isProviderId(record.provider)) {
      return { ok: false, index, error: `unknown provider ${JSON.stringify(record.provider)}` }
    }
    items.push(record)
  }
  return { ok: true, items }
}

// ---------------------------------------------------------------------------
// 每个后端还缺什么（服务端 `usableError` 的镜像，只用于页面提示）
// ---------------------------------------------------------------------------

export type Missing = 'apiKey' | 'baseUrl' | 'cx' | null

export interface BackendVerdict {
  /** 显示名，已含「备用」等前缀。 */
  label: string
  provider: string
  missing: Missing
}

/** 各后端的必填项（与服务端 `adapter.requires*` 表一致）。 */
const REQUIREMENTS: Record<ProviderId, Array<'apiKey' | 'baseUrl' | 'cx'>> = {
  tavily: ['apiKey'],
  brave: ['apiKey'],
  exa: ['apiKey'],
  searxng: ['baseUrl'],
  google: ['apiKey', 'cx'],
}

function verdictFor(label: string, backend: BackendValues): BackendVerdict | undefined {
  if (backend.provider === 'none' || !isProviderId(backend.provider)) return undefined
  const required = REQUIREMENTS[backend.provider]
  const missing = required.find((field) => backend[field].trim() === '') ?? null
  return { label, provider: backend.provider, missing }
}

/**
 * 列出「会参与尝试」的后端以及各自缺什么。
 *
 * 只看这张表单里的值：环境变量（`TAVILY_API_KEY` 等）也可能把空缺补上，浏览器读不到
 * 环境变量，所以这里的判断是提示而不是判决——页面文案里写明了这一点。
 */
export function verdicts(values: FormValues): BackendVerdict[] {
  const list: BackendVerdict[] = []
  const primary = verdictFor(PROVIDER_LABELS[(values.provider as ProviderId) ?? 'tavily'] ?? values.provider, backendOf(values, 'primary'))
  if (primary) list.push(primary)
  const fallback = verdictFor(values.fallback.provider, values.fallback)
  if (fallback) list.push(fallback)
  for (const [index, item] of values.chain.entries()) {
    const provider = asString(item.provider)
    const label = `${provider || 'tavily'} #${index + 1}`
    const verdict = verdictFor(label, {
      provider: provider || 'tavily',
      apiKey: asString(item.apiKey),
      baseUrl: asString(item.baseUrl),
      cx: asString(item.cx),
    })
    if (verdict) list.push(verdict)
  }
  return list
}

/** 一个都不剩时，服务端仍会装配（无 key 降级），页面只需给出提示。 */
export function hasUsableBackend(list: BackendVerdict[]): boolean {
  return list.some((verdict) => verdict.missing === null)
}
