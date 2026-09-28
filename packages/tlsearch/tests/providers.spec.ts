// packages/tlsearch/tests/providers.spec.ts
//
// 后端适配层回归：配置解析、可用性判定、请求组装、响应解析、归一化管线。
//
// 这里刻意使用各后端**真实响应形状**的载荷（含 HTML 高亮、埋点参数、重复 URL、
// 缺失标题等真实脏数据），因为「解析得对」与「解析得省」正是本插件的核心价值。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BASE_URL,
  LIMITS,
  PROVIDERS,
  clampNumber,
  fetchQuotaLine,
  normalizeHits,
  resolveRuntime,
  runProviderSearch,
  usableError,
} from '../src/providers.js'
import type { ResolvedConfig } from '../src/types.js'

const originalFetch = globalThis.fetch
/** 用例开始前先清掉所有相关环境变量，避免开发机上的真实密钥泄漏进断言 */
const ENV_KEYS = [
  'TLSEARCH_API_KEY',
  'TLSEARCH_BASE_URL',
  'TAVILY_API_KEY',
  'TAVILY_BASE_URL',
  'BRAVE_SEARCH_API_KEY',
  'BRAVE_API_KEY',
  'BRAVE_BASE_URL',
  'SEARXNG_BASE_URL',
]

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

/**
 * 覆盖式构造运行期配置。
 *
 * 必须把覆盖项交给 resolveRuntime **重新解析**，而不是解析完再展开覆盖：
 * baseUrl 是按 provider 派生的（Brave 的默认端点与 Tavily 不同），
 * 先解析再改 provider 会留下「Brave 后端 + Tavily 端点」这种现实中不存在的组合。
 */
function runtime(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return resolveRuntime({ apiKey: 'test-key', ...overrides })
}

/** 用固定 JSON 载荷替换全局 fetch，并记录收到的请求 */
function stubJson(payload: unknown, status = 200): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(payload), { status })
  }) as unknown as typeof fetch
  return calls
}

describe('clampNumber', () => {
  it('钳制到边界内', () => {
    expect(clampNumber(3, 1, 10, 5)).toBe(3)
    expect(clampNumber(999, 1, 10, 5)).toBe(10)
    expect(clampNumber(0, 1, 10, 5)).toBe(1)
    expect(clampNumber(-5, 40, 2000, 250)).toBe(40)
  })

  it('「未提供」与「提供了 0」严格区分：空值退回 fallback 而非被压成下限', () => {
    // 设置界面留空时的常见形态：若依赖 Number() 隐式转换，null/''/false 都会变成 0，
    // 再经钳制就成了下限（maxResults 会静默变成 1 条），而不是默认值
    for (const empty of [undefined, null, '', '   ', false, true, [], {}]) {
      expect(clampNumber(empty, 1, 10, 5)).toBe(5)
    }
    // 显式提供的 0 才是「越界值」，应钳制到下限
    expect(clampNumber(0, 1, 10, 5)).toBe(1)
  })

  it('非有限数与非数值退回 fallback（绝不把 NaN 带进 URL 与配置）', () => {
    expect(clampNumber(Number.NaN, 1, 10, 5)).toBe(5)
    // Infinity 无法表示为一个合法条数，同样退回 fallback 而非钳到 max
    expect(clampNumber(Number.POSITIVE_INFINITY, 1, 10, 5)).toBe(5)
    expect(clampNumber('abc', 1, 10, 5)).toBe(5)
  })

  it('数字字符串被接受，小数向下取整', () => {
    expect(clampNumber('7', 1, 10, 5)).toBe(7)
    expect(clampNumber(3.9, 1, 10, 5)).toBe(3)
  })
})

describe('resolveRuntime', () => {
  it('全部走默认值：tavily + 官方端点 + 5 条 + 250 字符 + 15s + markdown', () => {
    const rt = resolveRuntime({})
    expect(rt.provider).toBe('tavily')
    expect(rt.baseUrl).toBe(DEFAULT_BASE_URL.tavily)
    expect(rt.maxResults).toBe(LIMITS.defaultResults)
    expect(rt.maxSnippetChars).toBe(LIMITS.defaultSnippetChars)
    expect(rt.timeoutMs).toBe(LIMITS.defaultTimeoutMs)
    expect(rt.outputFormat).toBe('markdown')
    expect(rt.includeAnswer).toBe(false)
    expect(rt.apiKey).toBe('')
  })

  it('越界配置被钳制到 LIMITS 边界', () => {
    const rt = resolveRuntime({
      maxResults: 500,
      maxSnippetChars: 1,
      timeoutMs: 10_000_000,
    })
    expect(rt.maxResults).toBe(LIMITS.maxResults)
    expect(rt.maxSnippetChars).toBe(LIMITS.minSnippetChars)
    expect(rt.timeoutMs).toBe(LIMITS.maxTimeoutMs)
  })

  it('非法 provider 回退到默认后端（而非抛错中断插件装载）', () => {
    expect(resolveRuntime({ provider: 'bing' as never }).provider).toBe('tavily')
  })

  it('outputFormat 仅接受 json，其余一律回退 markdown', () => {
    expect(resolveRuntime({ outputFormat: 'json' }).outputFormat).toBe('json')
    expect(resolveRuntime({ outputFormat: 'yaml' as never }).outputFormat).toBe('markdown')
  })

  it('apiKey 从配置或环境变量读取，配置优先', () => {
    process.env.TAVILY_API_KEY = 'env-key'
    expect(resolveRuntime({}).apiKey).toBe('env-key')
    expect(resolveRuntime({ apiKey: 'explicit' }).apiKey).toBe('explicit')
    // 通用变量优先于后端专用变量
    process.env.TLSEARCH_API_KEY = 'generic'
    expect(resolveRuntime({}).apiKey).toBe('generic')
  })

  it('baseUrl 从配置或环境变量读取；SearXNG 无内置默认端点', () => {
    process.env.SEARXNG_BASE_URL = 'https://searx.env.example'
    expect(resolveRuntime({ provider: 'searxng' }).baseUrl).toBe('https://searx.env.example')
    expect(resolveRuntime({ provider: 'searxng', baseUrl: 'https://own.example' }).baseUrl).toBe(
      'https://own.example',
    )
    expect(resolveRuntime({ provider: 'searxng' }).baseUrl).toBe('https://searx.env.example')
    delete process.env.SEARXNG_BASE_URL
    expect(resolveRuntime({ provider: 'searxng' }).baseUrl).toBe('')
  })

  it('空白字符串视为未配置', () => {
    expect(resolveRuntime({ apiKey: '   ' }).apiKey).toBe('')
    expect(resolveRuntime({ baseUrl: '  ' }).baseUrl).toBe(DEFAULT_BASE_URL.tavily)
  })
})

describe('usableError', () => {
  it('需要密钥的后端缺密钥时给出 credential 错误与配置路径', () => {
    const error = usableError(runtime({ apiKey: '' }))
    expect(error?.code).toBe('credential')
    expect(error?.message).toContain('Plugin configuration')
  })

  it('SearXNG 缺 baseUrl 时给出 config 错误（不要求密钥）', () => {
    const error = usableError(runtime({ provider: 'searxng', apiKey: '', baseUrl: '' }))
    expect(error?.code).toBe('config')
    expect(error?.message).toContain('baseUrl')
  })

  it('SearXNG 配好 baseUrl 且无密钥时可用', () => {
    expect(usableError(runtime({ provider: 'searxng', apiKey: '', baseUrl: 'https://s.example' }))).toBeNull()
  })

  it('Brave 缺密钥不可用，配好后可用', () => {
    expect(usableError(runtime({ provider: 'brave', apiKey: '' }))?.code).toBe('credential')
    expect(usableError(runtime({ provider: 'brave', apiKey: 'k' }))).toBeNull()
  })
})

describe('请求组装', () => {
  /**
   * build 的签名是 (backend, settings, query, limit, signal)：
   * 主备双后端共用一个 settings（限额/语言/输出格式），但各自持有连接参数。
   * 单后端用例里两者同源，用这个助手避免每处都写两遍 rt。
   */
  const build = (
    adapter: (typeof PROVIDERS)[keyof typeof PROVIDERS],
    rt: ResolvedConfig,
    query: string,
    limit: number,
  ) => adapter.build(rt, rt, query, limit)

  it('Tavily：POST /search，禁用 raw_content 与 images，密钥同时走头与请求体', () => {
    const request = build(PROVIDERS.tavily, runtime({ maxResults: 5 }), 'hello world', 5)
    expect(request.url).toBe('https://api.tavily.com/search')
    expect(request.init.method).toBe('POST')
    expect(request.provider).toBe('tavily')

    const headers = request.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer test-key')

    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>
    expect(body.query).toBe('hello world')
    expect(body.max_results).toBe(5)
    // 这两项若开启，单条结果可达数万字符，直接摧毁上下文预算
    expect(body.include_raw_content).toBe(false)
    expect(body.include_images).toBe(false)
    expect(body.include_answer).toBe(false)
    expect(body.api_key).toBe('test-key')
    // 计费按请求而非按条数：search_depth 恒为 basic（1 credit），绝不用 advanced（2 credits）
    expect(body.search_depth).toBe('basic')
  })

  it('Tavily：自定义 baseUrl 带结尾斜杠与路径前缀都能正确拼接', () => {
    expect(
      build(PROVIDERS.tavily, runtime({ baseUrl: 'https://proxy.example/tavily/' }), 'q', 3).url,
    ).toBe('https://proxy.example/tavily/search')
  })

  it('Brave：GET /res/v1/web/search，关闭文本装饰并限定 web 垂直', () => {
    const request = build(PROVIDERS.brave, runtime({ provider: 'brave', language: 'en' }), 'hello world', 5)
    const url = new URL(request.url)
    expect(url.origin).toBe('https://api.search.brave.com')
    expect(url.pathname).toBe('/res/v1/web/search')
    expect(url.searchParams.get('q')).toBe('hello world')
    expect(url.searchParams.get('count')).toBe('5')
    expect(url.searchParams.get('text_decorations')).toBe('false')
    expect(url.searchParams.get('result_filter')).toBe('web')
    expect(url.searchParams.get('search_lang')).toBe('en')

    const headers = request.init.headers as Record<string, string>
    expect(headers['x-subscription-token']).toBe('test-key')
  })

  it('Brave：language 为空时不发送 search_lang', () => {
    const request = build(PROVIDERS.brave, runtime({ provider: 'brave' }), 'q', 5)
    expect(new URL(request.url).searchParams.has('search_lang')).toBe(false)
  })

  it('SearXNG：GET /search 且 format=json', () => {
    const request = build(
      PROVIDERS.searxng,
      runtime({ provider: 'searxng', apiKey: '', baseUrl: 'https://searx.example' }),
      'hello',
      4,
    )
    const url = new URL(request.url)
    expect(url.origin).toBe('https://searx.example')
    expect(url.pathname).toBe('/search')
    expect(url.searchParams.get('format')).toBe('json')
    expect(url.searchParams.get('q')).toBe('hello')
    // 未配置密钥时不得发送空的 Authorization 头
    expect((request.init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('Google CSE：GET /customsearch/v1，key 与 cx 同时作为查询参数', () => {
    const request = build(
      PROVIDERS.google,
      runtime({ provider: 'google', cx: 'engine-123', language: 'zh' }),
      'hello world',
      7,
    )
    const url = new URL(request.url)
    expect(url.origin).toBe('https://www.googleapis.com')
    expect(url.pathname).toBe('/customsearch/v1')
    expect(url.searchParams.get('key')).toBe('test-key')
    expect(url.searchParams.get('cx')).toBe('engine-123')
    expect(url.searchParams.get('q')).toBe('hello world')
    expect(url.searchParams.get('num')).toBe('7')
    expect(url.searchParams.get('hl')).toBe('zh')
    // Google 用查询参数传密钥，绝不能同时把它塞进请求头（会泄漏进日志）
    expect((request.init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('Google CSE：num 被钳在 10 以内（API 硬上限）', () => {
    const request = build(PROVIDERS.google, runtime({ provider: 'google', cx: 'c' }), 'q', 50)
    expect(new URL(request.url).searchParams.get('num')).toBe('10')
  })

  it('Exa：POST /search，密钥走 x-api-key，并显式请求 contents.text', () => {
    const request = build(PROVIDERS.exa, runtime({ provider: 'exa', maxSnippetChars: 300 }), 'hello', 4)
    expect(request.url).toBe('https://api.exa.ai/search')
    expect(request.init.method).toBe('POST')

    const headers = request.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('test-key')

    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>
    expect(body.query).toBe('hello')
    expect(body.numResults).toBe(4)
    // Exa 默认不返回正文；不请求 contents 就会得到一堆空摘要
    expect((body.contents as { text: { maxCharacters: number } }).text.maxCharacters).toBe(300)
  })
})

describe('响应解析', () => {
  it('Tavily：取 content 作摘要，清洗 HTML 与实体；includeAnswer 控制 answer', () => {
    const payload = {
      query: 'x',
      answer: '42 &amp; more',
      results: [
        { title: 'A <b>title</b>', url: 'https://a.example/p?utm_source=n', content: '<p>snip &amp; text</p>', score: 0.9 },
      ],
    }
    const withAnswer = PROVIDERS.tavily.parse(payload, runtime({ includeAnswer: true }))
    expect(withAnswer.answer).toBe('42 & more')
    expect(withAnswer.hits[0]).toEqual({
      title: 'A <b>title</b>',
      url: 'https://a.example/p?utm_source=n',
      snippet: '<p>snip &amp; text</p>',
    })

    const withoutAnswer = PROVIDERS.tavily.parse(payload, runtime({ includeAnswer: false }))
    expect(withoutAnswer.answer).toBeUndefined()
  })

  it('Tavily：畸形载荷不抛错，退化为空结果', () => {
    expect(PROVIDERS.tavily.parse(null, runtime()).hits).toEqual([])
    expect(PROVIDERS.tavily.parse({ results: 'nope' }, runtime()).hits).toEqual([])
    expect(PROVIDERS.tavily.parse({ results: [null, 42] }, runtime()).hits).toEqual([
      { title: '', url: '', snippet: '' },
      { title: '', url: '', snippet: '' },
    ])
  })

  it('Brave：从 web.results 取 description，支持缺失 web 字段', () => {
    const payload = {
      web: {
        results: [
          { title: 'B <strong>hit</strong>', url: 'https://b.example/x', description: 'desc &quot;q&quot;', age: '2 days ago' },
        ],
      },
    }
    expect(PROVIDERS.brave.parse(payload, runtime({ provider: 'brave' })).hits).toEqual([
      { title: 'B <strong>hit</strong>', url: 'https://b.example/x', snippet: 'desc &quot;q&quot;' },
    ])
    expect(PROVIDERS.brave.parse({}, runtime({ provider: 'brave' })).hits).toEqual([])
  })

  it('SearXNG：取 content，answers 仅在 includeAnswer 时并入', () => {
    const payload = {
      results: [{ url: 'https://s.example/1', title: 'S1', content: 'c1', engine: 'google' }],
      answers: ['直接答案'],
    }
    expect(PROVIDERS.searxng.parse(payload, runtime({ provider: 'searxng', includeAnswer: true })).answer).toBe(
      '直接答案',
    )
    expect(PROVIDERS.searxng.parse(payload, runtime({ provider: 'searxng', includeAnswer: false })).answer).toBeUndefined()
  })
})

describe('normalizeHits 归一化管线', () => {
  // 直接给出字面量：resolveRuntime 会把 maxSnippetChars 钳到 40 的下限，
  // 而本组用例需要一个更小的上限来断言截断行为
  const rt: ResolvedConfig = {
    provider: 'tavily',
    apiKey: '',
    baseUrl: 'https://api.tavily.com',
    cx: '',
    fallback: null,
    maxResults: 5,
    maxSnippetChars: 20,
    timeoutMs: 5_000,
    language: '',
    includeAnswer: false,
    outputFormat: 'markdown',
  }

  it('清洗标题与摘要，剔除埋点参数', () => {
    const hits = normalizeHits(
      [{ title: '<b>T</b>', url: 'https://e.example/a?utm_source=x&id=1', snippet: 'a &amp; b' }],
      rt,
      5,
    )
    expect(hits).toEqual([{ title: 'T', url: 'https://e.example/a?id=1', snippet: 'a & b' }])
  })

  it('丢弃无 URL 的条目，标题缺失时退化为 URL', () => {
    const hits = normalizeHits(
      [
        { title: 'ok', url: '', snippet: 'x' },
        { title: '   ', url: 'https://e.example/b', snippet: 'y' },
      ],
      rt,
      5,
    )
    expect(hits).toEqual([{ title: 'https://e.example/b', url: 'https://e.example/b', snippet: 'y' }])
  })

  it('按归一化后的 URL 去重（埋点参数不同的同一篇文章只留一条）', () => {
    const hits = normalizeHits(
      [
        { title: 'first', url: 'https://e.example/a?utm_source=x', snippet: 's1' },
        { title: 'second', url: 'https://e.example/a?utm_source=y', snippet: 's2' },
        { title: 'third', url: 'https://e.example/b', snippet: 's3' },
      ],
      rt,
      5,
    )
    expect(hits.map((hit) => hit.title)).toEqual(['first', 'third'])
  })

  it('先去重再截断：镜像不会先占满名额再被去重', () => {
    const raw = [
      { title: 'm1', url: 'https://e.example/a?utm_source=1', snippet: 's' },
      { title: 'm2', url: 'https://e.example/a?utm_source=2', snippet: 's' },
      { title: 'real', url: 'https://e.example/b', snippet: 's' },
    ]
    const hits = normalizeHits(raw, rt, 2)
    expect(hits.map((hit) => hit.title)).toEqual(['m1', 'real'])
  })

  it('摘要按 maxSnippetChars 截断', () => {
    const hits = normalizeHits([{ title: 'T', url: 'https://e.example/a', snippet: 'x'.repeat(100) }], rt, 5)
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(21)
    expect(hits[0]!.snippet.endsWith('…')).toBe(true)
  })

  it('标题超长时也被截断（异常端点可能把整段 HTML 当标题）', () => {
    const hits = normalizeHits([{ title: 'T'.repeat(1000), url: 'https://e.example/a', snippet: '' }], rt, 5)
    expect(hits[0]!.title.length).toBeLessThanOrEqual(301)
  })
})

describe('runProviderSearch 端到端（假 fetch）', () => {
  it('Tavily 全链路：请求 → 解析 → 清洗 → 截断', async () => {
    const calls = stubJson({
      results: [
        { title: '<b>DeepSeek Harness</b>', url: 'https://ds.example/docs?utm_campaign=x', content: '<p>Compact &amp; fast</p>' },
      ],
    })
    const outcome = await runProviderSearch(runtime(), 'dsh', 5)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.tavily.com/search')
    expect(outcome.hits).toEqual([
      { title: 'DeepSeek Harness', url: 'https://ds.example/docs', snippet: 'Compact & fast' },
    ])
  })

  it('可用性判定先于网络请求：缺密钥时直接失败且不发起请求', async () => {
    const calls = stubJson({ results: [] })
    await expect(runProviderSearch(runtime({ apiKey: '' }), 'q', 5)).rejects.toMatchObject({
      code: 'credential',
    })
    expect(calls).toHaveLength(0)
  })

  it('HTTP 失败被分类上抛', async () => {
    stubJson({ error: 'bad key' }, 401)
    await expect(runProviderSearch(runtime(), 'q', 5)).rejects.toMatchObject({ code: 'credential', status: 401 })
  })

  it('limit 决定请求条数上限', async () => {
    const calls = stubJson({ results: [] })
    await runProviderSearch(runtime(), 'q', 3)
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body.max_results).toBe(3)
  })
})

describe('Google / Exa 响应解析', () => {
  it('Google：取 items[].title / link / snippet', () => {
    const payload = {
      items: [
        { title: 'G <b>hit</b>', link: 'https://g.example/a', snippet: 'gsnip &amp; more', displayLink: 'g.example' },
      ],
    }
    expect(PROVIDERS.google.parse(payload, runtime({ provider: 'google', cx: 'c' })).hits).toEqual([
      { title: 'G <b>hit</b>', url: 'https://g.example/a', snippet: 'gsnip &amp; more' },
    ])
  })

  it('Google：畸形载荷退化为空结果', () => {
    expect(PROVIDERS.google.parse(null, runtime({ provider: 'google', cx: 'c' })).hits).toEqual([])
    expect(PROVIDERS.google.parse({ items: 'nope' }, runtime({ provider: 'google', cx: 'c' })).hits).toEqual([])
  })

  it('Exa：text 优先，缺失时用 highlights 兜底', () => {
    const payload = {
      results: [
        { title: 'E1', url: 'https://e1.example', text: 'full text here', highlights: ['ignored'] },
        { title: 'E2', url: 'https://e2.example', highlights: ['hl one', 'hl two'] },
        { title: 'E3', url: 'https://e3.example' },
      ],
    }
    expect(PROVIDERS.exa.parse(payload, runtime({ provider: 'exa' })).hits).toEqual([
      { title: 'E1', url: 'https://e1.example', snippet: 'full text here' },
      { title: 'E2', url: 'https://e2.example', snippet: 'hl one hl two' },
      { title: 'E3', url: 'https://e3.example', snippet: '' },
    ])
  })
})

describe('主备（fallback）配置解析', () => {
  it('未配置 fallback、或 provider 为 none 时为 null', () => {
    expect(resolveRuntime({}).fallback).toBeNull()
    expect(resolveRuntime({ fallback: { provider: 'none' } }).fallback).toBeNull()
  })

  it('备用后端与主后端相同时忽略（同源备用只会让一次失败变成两次失败）', () => {
    expect(resolveRuntime({ provider: 'tavily', fallback: { provider: 'tavily' } }).fallback).toBeNull()
  })

  it('备用后端独立解析自己的端点与密钥', () => {
    const rt = resolveRuntime({
      provider: 'tavily',
      apiKey: 'primary-key',
      fallback: { provider: 'searxng', baseUrl: 'https://searx.example' },
    })
    expect(rt.provider).toBe('tavily')
    expect(rt.apiKey).toBe('primary-key')
    expect(rt.fallback).toEqual({ provider: 'searxng', apiKey: '', baseUrl: 'https://searx.example', cx: '' })
  })

  it('备用后端的密钥与端点也可来自环境变量', () => {
    process.env.EXA_API_KEY = 'env-exa'
    const rt = resolveRuntime({ provider: 'tavily', apiKey: 'k', fallback: { provider: 'exa' } })
    expect(rt.fallback).toEqual({ provider: 'exa', apiKey: 'env-exa', baseUrl: 'https://api.exa.ai', cx: '' })
    delete process.env.EXA_API_KEY
  })

  it('cx 只对 google 生效，其余后端恒为空串（避免日志暗示一个不存在的配置项）', () => {
    expect(resolveRuntime({ provider: 'google', cx: 'engine-1' }).cx).toBe('engine-1')
    expect(resolveRuntime({ provider: 'tavily', cx: 'engine-1' }).cx).toBe('')
  })

  it('cx 可来自环境变量', () => {
    process.env.GOOGLE_CSE_ID = 'env-cx'
    expect(resolveRuntime({ provider: 'google' }).cx).toBe('env-cx')
    delete process.env.GOOGLE_CSE_ID
  })
})

describe('Google CSE 的 cx 是必需项', () => {
  it('缺 cx 时给出 config 错误并指明去哪儿建', () => {
    const error = usableError(resolveRuntime({ provider: 'google', apiKey: 'k' }))
    expect(error?.code).toBe('config')
    expect(error?.message).toContain('cx')
    expect(error?.message).toContain('programmablesearchengine.google.com')
  })

  it('key 与 cx 齐全时可用', () => {
    expect(usableError(resolveRuntime({ provider: 'google', apiKey: 'k', cx: 'c' }))).toBeNull()
  })

  it('缺 key 优先报 credential（先补最基础的凭据）', () => {
    expect(usableError(resolveRuntime({ provider: 'google', cx: 'c' }))?.code).toBe('credential')
  })
})

describe('Google 配额耗尽不再被误判为密钥无效', () => {
  it('403 + dailyLimitExceeded 归类为 http 配额错误，并提示可配 fallback', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: "Quota exceeded for quota metric 'Queries'",
              errors: [{ reason: 'dailyLimitExceeded' }],
            },
          }),
          { status: 403 },
        ),
    ) as unknown as typeof fetch

    const error = (await runProviderSearch(runtime({ provider: 'google', cx: 'c' }), 'q', 5).catch(
      (caught: unknown) => caught,
    )) as { code: string; message: string }

    expect(error.code).toBe('http')
    expect(error.message).toContain('quota exhausted')
    expect(error.message).toContain('fallback')
    // 关键：不能把用户引向「密钥无效」这个错误方向
    expect(error.message).not.toContain('API key is missing')
  })

  it('403 但没有配额特征时仍是 credential（密钥真的无效）', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 403, message: 'API key not valid' } }), { status: 403 }),
    ) as unknown as typeof fetch
    await expect(runProviderSearch(runtime({ provider: 'google', cx: 'c' }), 'q', 5)).rejects.toMatchObject({
      code: 'credential',
    })
  })
})

describe('fetchQuotaLine', () => {
  it('Tavily：渲染一行「已用/总额 + 剩余」', async () => {
    stubJson({ account: { current_plan: 'Researcher', plan_usage: 137, plan_limit: 1000 } })
    const line = await fetchQuotaLine(runtime(), 5_000)
    expect(line).toBe(
      'Tavily "Researcher": 137/1000 credits used this cycle; 863 remaining (each search costs 1 credit).',
    )
  })

  it('Tavily：无月度上限时如实说明，不编数字', async () => {
    stubJson({ account: { current_plan: 'PAYG', plan_usage: 12, plan_limit: null } })
    expect(await fetchQuotaLine(runtime(), 5_000)).toBe(
      'Tavily "PAYG": 12 credits used this cycle (no monthly cap reported).',
    )
  })

  it('非 Tavily 后端如实说明没有机器可读的额度接口', async () => {
    const line = await fetchQuotaLine(resolveRuntime({ provider: 'searxng', baseUrl: 'https://s.example' }), 5_000)
    expect(line).toContain('no machine-readable quota endpoint')
  })

  it('缺凭据时先抛分类错误，不发起请求', async () => {
    const calls = stubJson({})
    await expect(fetchQuotaLine(runtime({ apiKey: '' }), 5_000)).rejects.toMatchObject({ code: 'credential' })
    expect(calls).toHaveLength(0)
  })
})
