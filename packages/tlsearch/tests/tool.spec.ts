// packages/tlsearch/tests/tool.spec.ts
//
// 端到端回归：以假 Cordis 上下文 + 假 fetch 走通「装配 → 注册 → 调用 → 注销」全链路。
//
// 重点验证三类只有集成起来才能暴露的行为：
//   1. 返回值的三层契约（信封 → schema → render 块数组）；
//   2. 熔断在连续失败后开启，且**调用方中断不计入熔断**；
//   3. 注销路径（apply 返回值 / ctx.on('dispose') / ctx.tools 缺失降级）都不留副作用。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'cordis'
import { SEARCH_TOOL_NAME, apply } from '../src/index.js'
import { BREAKER_THRESHOLD, LIMITS } from '../src/providers.js'

const originalFetch = globalThis.fetch

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

/** 已注册工具的最小结构（对应宿主 dsh-tools 消费的字段） */
interface RegisteredTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  timeoutMs?: number
  isConcurrencySafe?: (args: unknown) => boolean
  output: {
    schema: Record<string, unknown>
    render: (...params: unknown[]) => Array<{ type: string; text: string }>
  }
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>
}

/** 假宿主上下文：记录注册与日志，捕获 dispose 监听器 */
function createHarness() {
  const registered: RegisteredTool[] = []
  const logs: Array<{ level: string; message: string }> = []
  const disposeListeners: Array<() => void> = []
  const push = (level: string) => (...args: unknown[]) => {
    logs.push({ level, message: args.map((arg) => String(arg)).join(' ') })
  }
  const ctx = {
    logger: { info: push('info'), warn: push('warn'), error: push('error') },
    tools: {
      register: (tool: unknown) => {
        const typed = tool as RegisteredTool
        registered.push(typed)
        return () => {
          const index = registered.indexOf(typed)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    on: (name: string, listener: () => void) => {
      if (name === 'dispose') disposeListeners.push(listener)
      return () => {}
    },
  } as unknown as Context
  return { ctx, registered, logs, disposeListeners }
}

/** 用固定 JSON 载荷替换 fetch，并记录收到的请求 */
function stubJson(payload: unknown, status = 200): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(payload), { status })
  }) as unknown as typeof fetch
  return calls
}

/** 永不 resolve、仅在中止时 reject 的 fetch（模拟挂起的后端） */
function stubHanging(): void {
  globalThis.fetch = vi.fn((_url: string, init: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal
      const abort = (): void => reject(new DOMException('aborted', 'AbortError'))
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort)
    })
  }) as unknown as typeof fetch
}

/** 装配插件并取回工具；返回注销器 */
function mount(overrides: Record<string, unknown> = {}) {
  const harness = createHarness()
  const dispose = apply(harness.ctx, { provider: 'tavily', apiKey: 'test-key', ...overrides })
  const tool = harness.registered[0]
  if (!tool) throw new Error('工具未注册')
  return { ...harness, dispose, tool }
}

/** 宿主 render 之后会做的形状检查 */
function expectValidBlocks(blocks: unknown): void {
  expect(Array.isArray(blocks)).toBe(true)
  const list = blocks as Array<{ type: string; text: string }>
  expect(list.length).toBeGreaterThan(0)
  for (const block of list) {
    expect(block.type).toBe('text')
    expect(typeof block.text).toBe('string')
  }
}

describe('装配与注册', () => {
  it('注册名为 tlsearch 的工具，并声明宿主消费的两个策略字段', () => {
    const { tool, registered, dispose } = mount()
    expect(registered).toHaveLength(1)
    expect(tool.name).toBe(SEARCH_TOOL_NAME)
    // 宿主超时略大于本插件 HTTP 超时：先由本插件给出分类错误，宿主再兜底硬停
    expect(tool.timeoutMs).toBe(LIMITS.defaultTimeoutMs + 5_000)
    // 无共享可变状态（除熔断计数），允许宿主并行调度多路检索
    expect(tool.isConcurrencySafe?.({})).toBe(true)
    dispose()
  })

  it('output.schema 声明 content 数组且 render 已就位', () => {
    const { tool, dispose } = mount()
    const schema = tool.output.schema as {
      required: string[]
      properties: { content: { type: string; items: { required: string[] } } }
    }
    expect(schema.required).toContain('content')
    expect(schema.properties.content.type).toBe('array')
    expect(schema.properties.content.items.required).toEqual(['type', 'text'])
    expect(typeof tool.output.render).toBe('function')
    dispose()
  })

  it('参数 schema 只暴露 query 与可选 maxResults（模型可见 schema 也要省 Token）', () => {
    const { tool, dispose } = mount()
    const parameters = tool.parameters as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(Object.keys(parameters.properties).sort()).toEqual(['maxResults', 'query'])
    expect(parameters.required).toEqual(['query'])
    dispose()
  })

  it('装配日志自述生效配置，但绝不泄漏 apiKey', () => {
    const harness = createHarness()
    apply(harness.ctx, { provider: 'brave', apiKey: 'super-secret-key' })
    const text = harness.logs.map((entry) => entry.message).join('\n')
    expect(text).toContain('provider=brave')
    expect(text).toContain('endpoint=https://api.search.brave.com')
    expect(text).not.toContain('super-secret-key')
  })

  it('缺凭据时只告警，工具仍保持注册（调用时才返回分类错误）', () => {
    const harness = createHarness()
    apply(harness.ctx, { provider: 'tavily' })
    expect(harness.registered).toHaveLength(1)
    expect(harness.logs.some((entry) => entry.level === 'warn' && entry.message.includes('不可用'))).toBe(true)
  })

  it('ctx.tools 未就绪时降级为无操作而非抛错', () => {
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      on: () => () => {},
    } as unknown as Context
    expect(() => apply(ctx, {})).not.toThrow()
  })
})

describe('注销', () => {
  it('apply 返回的注销器摘除工具且幂等', () => {
    const { registered, dispose } = mount()
    expect(registered).toHaveLength(1)
    dispose()
    expect(registered).toHaveLength(0)
    expect(() => dispose()).not.toThrow()
    expect(registered).toHaveLength(0)
  })

  it('ctx.on("dispose") 也能触发注销（Cordis 3 会丢弃 apply 的返回值）', () => {
    const { registered, disposeListeners } = mount()
    expect(disposeListeners).toHaveLength(1)
    expect(registered).toHaveLength(1)
    for (const listener of disposeListeners) listener()
    expect(registered).toHaveLength(0)
  })

  it('注销时中止在途请求', async () => {
    stubHanging()
    const { tool, dispose } = mount()
    const pending = tool.execute({ query: 'hang' }, {}).catch((caught: unknown) => caught)
    dispose()
    const error = (await pending) as { code?: string }
    expect(error.code).toBe('aborted')
  })
})

describe('成功路径与返回契约', () => {
  it('清洗后的紧凑 Markdown，且返回值满足信封 + schema + render 三层契约', async () => {
    stubJson({
      results: [
        {
          title: '<b>DeepSeek Harness</b>',
          url: 'https://ds.example/docs?utm_source=news',
          content: '<p>Compact &amp; fast</p>',
        },
      ],
    })
    const { tool, dispose } = mount()

    const value = await tool.execute({ query: 'dsh' }, {})
    expect(value).toEqual({
      content: [{ type: 'text', text: '1. DeepSeek Harness — https://ds.example/docs\n   Compact & fast' }],
    })

    // 第 2 步：宿主按 output.schema 校验（此处做等价的结构检查）
    expect(Array.isArray(value.content)).toBe(true)
    expectValidBlocks(value.content)

    // 第 3 步：宿主以 (args, value) 双参调用 render，必须返回块数组
    expect(tool.output.render({ query: 'dsh' }, value)).toEqual(value.content)
    // 旧宿主的单位调用形态同样收敛为块数组
    expectValidBlocks(tool.output.render(value, undefined))
    dispose()
  })

  it('json 模式返回可解析的裸数组', async () => {
    stubJson({ results: [{ title: 'T', url: 'https://e.example/a', content: 'snip' }] })
    const { tool, dispose } = mount({ outputFormat: 'json' })
    const value = await tool.execute({ query: 'q' }, {})
    expect(JSON.parse(value.content[0]!.text)).toEqual([
      { title: 'T', url: 'https://e.example/a', snippet: 'snip' },
    ])
    dispose()
  })

  it('零命中给确定性提示而非空串', async () => {
    stubJson({ results: [] })
    const { tool, dispose } = mount()
    const value = await tool.execute({ query: 'zzz' }, {})
    expect(value.content[0]!.text).toBe('No results for "zzz".')
    dispose()
  })

  it('maxResults 覆盖被钳制在 1-10 之间', async () => {
    const calls = stubJson({ results: [] })
    const { tool, dispose } = mount()
    await tool.execute({ query: 'q', maxResults: 999 }, {})
    expect((JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>).max_results).toBe(
      LIMITS.maxResults,
    )
    await tool.execute({ query: 'q', maxResults: 0 }, {})
    expect((JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>).max_results).toBe(
      LIMITS.minResults,
    )
    dispose()
  })

  it('未指定 maxResults 时使用配置默认值', async () => {
    const calls = stubJson({ results: [] })
    const { tool, dispose } = mount({ maxResults: 7 })
    await tool.execute({ query: 'q' }, {})
    expect((JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>).max_results).toBe(7)
    dispose()
  })
})

describe('失败路径', () => {
  it('query 为空或非字符串时拒绝', async () => {
    const { tool, dispose } = mount()
    await expect(tool.execute({ query: '   ' }, {})).rejects.toMatchObject({ code: 'config' })
    await expect(tool.execute({}, {})).rejects.toMatchObject({ code: 'config' })
    await expect(tool.execute({ query: 42 }, {})).rejects.toMatchObject({ code: 'config' })
    dispose()
  })

  it('缺 API Key 时返回 credential 错误且不发起请求', async () => {
    const calls = stubJson({ results: [] })
    const { tool, dispose } = mount({ apiKey: '' })
    await expect(tool.execute({ query: 'q' }, {})).rejects.toMatchObject({ code: 'credential' })
    expect(calls).toHaveLength(0)
    dispose()
  })

  it('SearXNG 缺 baseUrl 时返回 config 错误并指明去配置 baseUrl', async () => {
    const { tool, dispose } = mount({ provider: 'searxng', apiKey: '', baseUrl: '' })
    const error = (await tool.execute({ query: 'q' }, {}).catch((caught: unknown) => caught)) as {
      code: string
      message: string
    }
    expect(error.code).toBe('config')
    expect(error.message).toContain('baseUrl')
    dispose()
  })

  it('连续失败达阈值后熔断，且熔断期内不再发起网络请求', async () => {
    const calls = stubJson({ error: 'boom' }, 500)
    const { tool, dispose } = mount()

    for (let attempt = 0; attempt < BREAKER_THRESHOLD; attempt += 1) {
      await expect(tool.execute({ query: 'q' }, {})).rejects.toMatchObject({ code: 'http' })
    }
    expect(calls).toHaveLength(BREAKER_THRESHOLD)

    await expect(tool.execute({ query: 'q' }, {})).rejects.toMatchObject({ code: 'circuit-open' })
    // 关键断言：熔断期内一次网络请求都没有发出
    expect(calls).toHaveLength(BREAKER_THRESHOLD)
    dispose()
  })

  it('配置错误不计入熔断：补好密钥后立刻可用，且错误信息不被 circuit-open 盖掉', async () => {
    // 前 3 次因缺密钥失败（远超熔断阈值），若实现把 credential 计入熔断，
    // 第 4 次会变成 circuit-open，且用户补好密钥后还要白等 60 秒冷却
    const noKey = mount({ apiKey: '' })
    for (let attempt = 0; attempt < BREAKER_THRESHOLD + 2; attempt += 1) {
      await expect(noKey.tool.execute({ query: 'q' }, {})).rejects.toMatchObject({ code: 'credential' })
    }
    noKey.dispose()

    // 同一个后端、配好密钥后立即恢复正常
    const calls = stubJson({ results: [{ title: 'T', url: 'https://e.example/a', content: 's' }] })
    const withKey = mount({ apiKey: 'good-key' })
    await expect(withKey.tool.execute({ query: 'q' }, {})).resolves.toBeDefined()
    expect(calls).toHaveLength(1)
    withKey.dispose()
  })

  it('调用方中断不计入熔断（否则一次用户取消就会打垮健康后端）', async () => {
    stubHanging()
    const { tool, dispose } = mount()
    const controller = new AbortController()
    controller.abort()

    // 连续中断远超熔断阈值，若实现有误，最后几次会变成 circuit-open
    for (let attempt = 0; attempt < BREAKER_THRESHOLD + 2; attempt += 1) {
      await expect(tool.execute({ query: 'q' }, { signal: controller.signal })).rejects.toMatchObject({
        code: 'aborted',
      })
    }
    dispose()
  })

  it('成功一次后熔断计数复位', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    let fail = true
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return fail
        ? new Response('boom', { status: 500 })
        : new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const { tool, dispose } = mount()
    // 差一次就熔断（阈值 - 1 次失败）
    for (let attempt = 0; attempt < BREAKER_THRESHOLD - 1; attempt += 1) {
      await expect(tool.execute({ query: 'q' }, {})).rejects.toMatchObject({ code: 'http' })
    }
    fail = false
    await expect(tool.execute({ query: 'q' }, {})).resolves.toBeDefined()
    // 复位后再连续失败 threshold 次才会再次熔断
    fail = true
    for (let attempt = 0; attempt < BREAKER_THRESHOLD; attempt += 1) {
      await expect(tool.execute({ query: 'q' }, {})).rejects.toMatchObject({ code: 'http' })
    }
    await expect(tool.execute({ query: 'q' }, {})).rejects.toMatchObject({ code: 'circuit-open' })
    dispose()
  })
})
