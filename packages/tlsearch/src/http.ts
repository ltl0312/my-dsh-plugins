// packages/tlsearch/src/http.ts
//
// 网络层：超时、熔断、响应体积上限与错误分类。
//
// 设计前提：本插件运行在**对话热路径**上。一次搜索卡住 90 秒，模型与用户就一起
// 卡住 90 秒；一个挂掉的搜索后端被连续重试，会把每一次工具调用都拖成全量超时。
// 因此这里做三件事，且全部是确定性的：
//   1. 每次请求都挂 AbortController 超时（宿主 timeoutMs 是第一道，这里是兜底）；
//   2. 连续失败达阈值即熔断，冷却期内直接快速失败，不再发起网络请求；
//   3. 响应体积设硬上限，避免恶意/异常端点把内存与后续 JSON 解析拖垮。

import { cleanText, truncateText } from './sanitize.js'

/** 错误分类：模型与日志可据此区分「该改配置」还是「该重试」 */
export type SearchErrorCode =
  | 'config'
  | 'credential'
  | 'timeout'
  | 'aborted'
  | 'http'
  | 'network'
  | 'response'
  | 'circuit-open'

/**
 * 插件对外抛出的唯一错误类型。
 *
 * 宿主会把 execute 抛出的错误渲染成工具错误结果交给模型，因此 message 必须
 * **可据以行动**：说清是哪个后端、哪个环节、下一步该做什么，而不是复述堆栈。
 */
export class SearchError extends Error {
  readonly code: SearchErrorCode
  readonly status?: number

  constructor(message: string, code: SearchErrorCode, status?: number) {
    super(message)
    this.name = 'SearchError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

/** 响应体字符上限（约 2MB）：正常搜索结果 JSON 比这个小两个数量级 */
const MAX_RESPONSE_CHARS = 2_000_000

/** 错误详情摘录上限：够看清 401 的 reason 或 429 的提示即可 */
const ERROR_DETAIL_CHARS = 240

/**
 * 熔断器（closed → open → half-open）。
 *
 * 语义：
 *   - closed：正常放行，每次失败累加计数；
 *   - open：连续失败达到阈值后进入，冷却期内 allow() 返回 false，调用方快速失败；
 *   - half-open：冷却期满后放行**一次**试探。试探失败立即重新 open（而不是退回
 *     closed 重新数满阈值）—— 否则后端持续挂掉时，每轮都要白打 threshold 次请求。
 */
export class CircuitBreaker {
  private failures = 0
  /** < 0 表示从未熔断；>= 0 表示熔断发生的时刻 */
  private openedAt = -1

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  /** 当前状态（时间可注入，便于测试） */
  state(now: number = Date.now()): 'closed' | 'open' | 'half-open' {
    if (this.openedAt < 0) return 'closed'
    return now - this.openedAt >= this.cooldownMs ? 'half-open' : 'open'
  }

  /** 本次调用是否允许发起网络请求 */
  allow(now: number = Date.now()): boolean {
    return this.state(now) !== 'open'
  }

  /** 距离下一次可试探的剩余毫秒数（未熔断时为 0） */
  retryAfterMs(now: number = Date.now()): number {
    if (this.openedAt < 0) return 0
    return Math.max(0, this.cooldownMs - (now - this.openedAt))
  }

  onSuccess(): void {
    this.failures = 0
    this.openedAt = -1
  }

  onFailure(now: number = Date.now()): void {
    // half-open 试探失败：立即重新熔断，不退回闭合并重新数满阈值
    if (this.openedAt >= 0) {
      this.openedAt = now
      this.failures = 0
      return
    }
    this.failures += 1
    if (this.failures >= this.threshold) {
      this.openedAt = now
      this.failures = 0
    }
  }

  reset(): void {
    this.failures = 0
    this.openedAt = -1
  }
}

/** 组装请求参数 */
export interface JsonRequest {
  url: string
  init: RequestInit
  /** 本次请求的硬超时（毫秒） */
  timeoutMs: number
  /** 调用方（宿主）信号：用户中断工具调用时触发 */
  signal?: AbortSignal
  /** 后端标识，仅用于错误措辞 */
  provider: string
}

/** HTML 错误页摘录：先清洗（错误页常常整段 HTML）再截断，保证错误信息本身不膨胀 */
function detailOf(rawBody: string): string {
  const cleaned = cleanText(rawBody)
  return cleaned.length === 0 ? '' : truncateText(cleaned, ERROR_DETAIL_CHARS)
}

/**
 * 配额耗尽的响应特征。
 *
 * 为什么必须单独识别：Google CSE 把「当天免费额度用完」也报成 **HTTP 403**，
 * 与「密钥无效」同码。若不区分，用户会看到「密钥无效」而去反复检查一个
 * 其实完全正确的密钥 —— 错误信息把人引向了错误的排查方向。
 */
const QUOTA_EXHAUSTED =
  /dailyLimitExceeded|rateLimitExceeded|userRateLimitExceeded|quotaExceeded|quota exceeded|usage limit|plan limit/i

/** 按状态码生成「可据以行动」的错误 */
function httpErrorOf(provider: string, status: number, rawBody: string): SearchError {
  const detail = detailOf(rawBody)
  const suffix = detail.length > 0 ? ` — ${detail}` : ''

  if ((status === 403 || status === 432) && QUOTA_EXHAUSTED.test(rawBody)) {
    return new SearchError(
      `${provider} quota exhausted (HTTP ${status}): the plan's allowance or rate limit is used up. ` +
        'Configure a fallback backend (fallback.provider) so searches degrade instead of failing, or wait for the quota to reset.' +
        suffix,
      'http',
      status,
    )
  }
  if (status === 401 || status === 403) {
    return new SearchError(
      `${provider} rejected the request (HTTP ${status}): the API key is missing, invalid, or not authorized for this endpoint.${suffix}`,
      'credential',
      status,
    )
  }
  if (status === 429) {
    return new SearchError(
      `${provider} rate-limited the request (HTTP 429).${suffix}`,
      'http',
      status,
    )
  }
  return new SearchError(`${provider} returned HTTP ${status}.${suffix}`, 'http', status)
}

/** 判定 JSON 解析失败时的针对性提示 */
function nonJsonHint(provider: string): string {
  if (provider === 'searxng') {
    return ' SearXNG only serves JSON when the `json` format is enabled in its settings.yml (search.formats); an HTML response means the endpoint is a browser-facing page, not the JSON API.'
  }
  return ''
}

/**
 * 发起一次 JSON 请求：超时 + 体积上限 + 错误分类。
 *
 * 超时与调用方取消被区分开：前者是 'timeout'（值得熔断），后者是 'aborted'
 * （用户主动中断，不是后端故障，绝不能计入熔断计数——由调用方决定是否上报）。
 */
export async function fetchJson(request: JsonRequest): Promise<unknown> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, request.timeoutMs)

  const external = request.signal
  const forwardAbort = (): void => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', forwardAbort, { once: true })
  }

  try {
    const response = await fetch(request.url, { ...request.init, signal: controller.signal })

    if (!response.ok) {
      // 读一小段正文用于诊断：错误页可能是 HTML，交给 detailOf 清洗
      const rawBody = await response.text().catch(() => '')
      throw httpErrorOf(request.provider, response.status, rawBody)
    }

    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_CHARS) {
      throw new SearchError(
        `${request.provider} response declared ${declaredLength} bytes, above the ${MAX_RESPONSE_CHARS}-char safety cap.`,
        'response',
      )
    }

    const body = await response.text()
    if (body.length > MAX_RESPONSE_CHARS) {
      throw new SearchError(
        `${request.provider} response exceeded the ${MAX_RESPONSE_CHARS}-char safety cap.`,
        'response',
      )
    }

    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new SearchError(
        `${request.provider} returned a body that is not valid JSON.${nonJsonHint(request.provider)}`,
        'response',
      )
    }
  } catch (error) {
    // 已经是分类过的插件错误（HTTP 状态、体积超限、非 JSON）直接上抛，
    // 否则会被这里重新包装成 'network'，丢掉真正的失败原因。
    if (error instanceof SearchError) throw error
    if (timedOut) {
      throw new SearchError(
        `${request.provider} did not respond within ${request.timeoutMs}ms (request aborted).`,
        'timeout',
      )
    }
    if (external?.aborted) {
      throw new SearchError(`${request.provider} search was cancelled by the caller.`, 'aborted')
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new SearchError(`${request.provider} request failed: ${message}`, 'network')
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', forwardAbort)
  }
}
