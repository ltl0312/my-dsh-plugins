// packages/tlsearch/tests/http.spec.ts
//
// 网络层回归：熔断状态机与错误分类。
//
// 这两件事都发生在「失败路径」上，而失败路径恰恰是最难靠手工验证的部分：
// 超时、401、非 JSON 响应在真实环境里都是间歇出现的。这里用可注入的假 fetch
// 与可注入的时间戳把它们变成确定性用例。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CircuitBreaker, SearchError, fetchJson } from '../src/http.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

/** 用固定响应替换全局 fetch */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): void {
  globalThis.fetch = vi.fn(handler) as unknown as typeof fetch
}

/** 一个永不 resolve 的 fetch，仅在 signal 中止时 reject（模拟挂起的后端） */
function stubHangingFetch(): void {
  stubFetch((_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal
      const abort = (): void => reject(new DOMException('aborted', 'AbortError'))
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort)
    })
  })
}

function request(overrides: Partial<Parameters<typeof fetchJson>[0]> = {}): Parameters<typeof fetchJson>[0] {
  return {
    url: 'https://search.example.com/search',
    init: { method: 'GET' },
    timeoutMs: 5_000,
    provider: 'tavily',
    ...overrides,
  }
}

describe('CircuitBreaker', () => {
  it('未达阈值保持 closed，达到阈值转 open', () => {
    const breaker = new CircuitBreaker(3, 1_000)
    expect(breaker.state(0)).toBe('closed')
    breaker.onFailure(0)
    breaker.onFailure(0)
    expect(breaker.state(0)).toBe('closed')
    expect(breaker.allow(0)).toBe(true)
    breaker.onFailure(0)
    expect(breaker.state(0)).toBe('open')
    expect(breaker.allow(0)).toBe(false)
  })

  it('冷却期内持续 open，冷却期满转 half-open 并放行一次试探', () => {
    const breaker = new CircuitBreaker(1, 1_000)
    breaker.onFailure(0)
    expect(breaker.state(500)).toBe('open')
    expect(breaker.allow(500)).toBe(false)
    expect(breaker.retryAfterMs(500)).toBe(500)
    expect(breaker.state(1_000)).toBe('half-open')
    expect(breaker.allow(1_000)).toBe(true)
    expect(breaker.retryAfterMs(1_000)).toBe(0)
  })

  it('half-open 试探失败立即重新熔断（不退回闭合并重新数满阈值）', () => {
    const breaker = new CircuitBreaker(3, 1_000)
    breaker.onFailure(0)
    breaker.onFailure(0)
    breaker.onFailure(0)
    expect(breaker.state(1_000)).toBe('half-open')
    breaker.onFailure(1_000)
    // 若实现有误（退回 closed），此处会因计数仅 1 而返回 closed
    expect(breaker.state(1_000)).toBe('open')
    expect(breaker.state(1_500)).toBe('open')
  })

  it('成功一次即完全复位', () => {
    const breaker = new CircuitBreaker(1, 1_000)
    breaker.onFailure(0)
    expect(breaker.state(0)).toBe('open')
    breaker.onSuccess()
    expect(breaker.state(0)).toBe('closed')
    expect(breaker.retryAfterMs(0)).toBe(0)
    // 复位后阈值重新从 0 计起
    breaker.onFailure(0)
    expect(breaker.state(0)).toBe('open')
  })

  it('reset() 清空计数与熔断时间', () => {
    const breaker = new CircuitBreaker(2, 1_000)
    breaker.onFailure(0)
    breaker.reset()
    breaker.onFailure(0)
    expect(breaker.state(0)).toBe('closed')
  })
})

describe('fetchJson 成功路径', () => {
  it('解析 JSON 响应', async () => {
    stubFetch(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }))
    await expect(fetchJson(request())).resolves.toEqual({ results: [] })
  })

  it('把调用方的 abort 信号透传给 fetch', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    stubFetch(async (_url, init) => {
      seen = init.signal ?? undefined
      return new Response('{}', { status: 200 })
    })
    await fetchJson(request({ signal: controller.signal }))
    expect(seen).toBeDefined()
    expect(seen?.aborted).toBe(false)
  })
})

describe('fetchJson 失败路径', () => {
  it('401/403 归类为 credential，并带上状态码与响应摘要', async () => {
    stubFetch(async () => new Response('{"error":"invalid api key"}', { status: 401 }))
    const error = await fetchJson(request()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SearchError)
    expect((error as SearchError).code).toBe('credential')
    expect((error as SearchError).status).toBe(401)
    expect((error as SearchError).message).toContain('invalid api key')
  })

  it('HTML 错误页被清洗后再截断，不会把整页 HTML 塞进错误信息', async () => {
    stubFetch(async () => new Response('<html><body><h1>Forbidden</h1></body></html>', { status: 403 }))
    const error = (await fetchJson(request()).catch((caught: unknown) => caught)) as SearchError
    expect(error.code).toBe('credential')
    expect(error.message).toContain('Forbidden')
    expect(error.message).not.toContain('<h1>')
  })

  it('429 归类为 http 并提示限流', async () => {
    stubFetch(async () => new Response('slow down', { status: 429 }))
    const error = (await fetchJson(request()).catch((caught: unknown) => caught)) as SearchError
    expect(error.code).toBe('http')
    expect(error.status).toBe(429)
    expect(error.message).toContain('rate-limited')
  })

  it('非 JSON 响应归类为 response；SearXNG 额外给出 formats 提示', async () => {
    stubFetch(async () => new Response('<html>search page</html>', { status: 200 }))
    const error = (await fetchJson(request({ provider: 'searxng' })).catch((caught: unknown) => caught)) as SearchError
    expect(error.code).toBe('response')
    expect(error.message).toContain('settings.yml')
  })

  it('超过体积上限（content-length 声明）直接拒绝', async () => {
    stubFetch(
      async () =>
        new Response('{}', { status: 200, headers: { 'content-length': String(9_000_000) } }),
    )
    const error = (await fetchJson(request()).catch((caught: unknown) => caught)) as SearchError
    expect(error.code).toBe('response')
    expect(error.message).toContain('safety cap')
  })

  it('超时归类为 timeout（而不是 network）', async () => {
    stubHangingFetch()
    const error = (await fetchJson(request({ timeoutMs: 20 })).catch((caught: unknown) => caught)) as SearchError
    expect(error.code).toBe('timeout')
    expect(error.message).toContain('20ms')
  })

  it('调用方主动中止归类为 aborted（区别于超时，便于调用方不计入熔断）', async () => {
    stubHangingFetch()
    const controller = new AbortController()
    const pending = fetchJson(request({ signal: controller.signal })).catch((caught: unknown) => caught)
    controller.abort()
    const error = (await pending) as SearchError
    expect(error.code).toBe('aborted')
  })

  it('已中止的信号在发起请求前即快速失败', async () => {
    let called = 0
    // 真实 fetch 对已中止的信号立即以 AbortError 结算（不产生网络流量），
    // 因此桩必须复刻这一语义，否则测不出「前置中止」这条路径。
    globalThis.fetch = vi.fn((_url: string, init: RequestInit) => {
      called += 1
      const signal = init.signal
      return new Promise<Response>((_resolve, reject) => {
        const abort = (): void => reject(new DOMException('aborted', 'AbortError'))
        if (signal?.aborted) {
          abort()
          return
        }
        signal?.addEventListener('abort', abort)
      })
    }) as unknown as typeof fetch

    const controller = new AbortController()
    controller.abort()
    const error = (await fetchJson(request({ signal: controller.signal })).catch(
      (caught: unknown) => caught,
    )) as SearchError
    expect(error.code).toBe('aborted')
    expect(called).toBe(1)
  })

  it('传输层异常归类为 network', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed')
    })
    const error = (await fetchJson(request()).catch((caught: unknown) => caught)) as SearchError
    expect(error.code).toBe('network')
    expect(error.message).toContain('fetch failed')
  })

  it('插件自身的分类错误不会被二次包装成 network', async () => {
    stubFetch(async () => new Response('nope', { status: 500 }))
    const error = (await fetchJson(request()).catch((caught: unknown) => caught)) as SearchError
    expect(error.code).toBe('http')
    expect(error.status).toBe(500)
  })
})
