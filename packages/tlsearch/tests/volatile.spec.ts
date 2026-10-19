// packages/tlsearch/tests/volatile.spec.ts
//
// 「设置页改完立即生效」的协议级回归。
//
// 这里刻意**不**依赖宿主代码：断言的是本插件与宿主之间的契约——
//   1. `Config` 的每个叶子字段都带 `meta.volatile`（设置页据此生成表单）；
//   2. 校验结果在这些路径上产出引用，且引用带 `Symbol.for('cosmokit.volatile.write')`
//      （宿主用这个全局符号识别/写入跨副本的引用）；
//   3. 宿主写完引用后，下一次工具调用**立刻**用新值（证明没有缓存快照）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'cordis'
import { Config, SEARCH_TOOL_NAME, USAGE_TOOL_NAME, apply } from '../src/index.js'
import { createVolatileRef, isVolatileRef, unwrapVolatile, volatile, withVolatileRefs } from '../src/volatile.js'
import Schema from 'schemastery'

/** 宿主 cosmokit 使用的写符号（全局注册表，跨副本同一个） */
const WRITE = Symbol.for('cosmokit.volatile.write')

/** 用一个引用扮演宿主：写入新值，模拟 `_commitVolatile` → `updateVolatile` */
function hostWrite(ref: unknown, value: unknown): void {
  ;(ref as Record<symbol, (next: unknown) => void>)[WRITE](value)
}

/** 走真实 Config schema 校验，拿到「宿主会交给 apply 的那个对象」 */
function validateConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const result = Config['~standard'].validate(raw) as { value?: Record<string, unknown>; issues?: unknown }
  if (result.issues !== undefined) throw new Error(`配置校验失败: ${JSON.stringify(result.issues)}`)
  return result.value as Record<string, unknown>
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  for (const key of ['TLSEARCH_API_KEY', 'TLSEARCH_BASE_URL', 'TAVILY_API_KEY', 'TAVILY_BASE_URL']) {
    delete process.env[key]
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('volatile schema 标记', () => {
  it('每个叶子字段都带 meta.volatile，对象与数组容器本身按宿主规则处理', () => {
    const schema = Config as unknown as {
      type: string
      dict: Record<string, { meta: Record<string, unknown>; dict?: Record<string, { meta: Record<string, unknown> }> }>
    }
    expect(schema.type).toBe('object')
    // 顶层标量字段：全部 volatile
    for (const key of ['provider', 'apiKey', 'baseUrl', 'cx', 'maxResults', 'maxSnippetChars', 'timeoutMs', 'language', 'includeAnswer', 'outputFormat']) {
      expect(schema.dict[key]?.meta.volatile, `${key} 应为 volatile`).toBe(true)
    }
    // chain 整节点 volatile：数组元素没有固定路径（dsh-app-boot validateVolatilePlacement）
    expect(schema.dict.chain?.meta.volatile).toBe(true)
    // fallback 本身不是 volatile（否则设置页会退化成一段 JSON），叶子是
    expect(schema.dict.fallback?.meta.volatile).not.toBe(true)
    for (const key of ['provider', 'apiKey', 'baseUrl', 'cx']) {
      expect(schema.dict.fallback?.dict?.[key]?.meta.volatile, `fallback.${key} 应为 volatile`).toBe(true)
    }
  })

  it('重复标记同一 schema 会报错（与官方 .volatile() 行为一致）', () => {
    const schema = volatile(Schema.string())
    expect(() => volatile(schema)).toThrow(/already wrapped/)
  })
})

describe('校验产出引用（宿主协议）', () => {
  it('标量字段被包成带全局写符号的引用，get() 返回当前值', () => {
    const value = validateConfig({ provider: 'tavily', apiKey: 'tvly-secret', maxResults: 7 })

    expect(isVolatileRef(value.apiKey)).toBe(true)
    const apiKey = value.apiKey as { get: () => string }
    expect(apiKey.get()).toBe('tvly-secret')

    // 宿主认的就是这个全局符号（cosmokit isVolatile）
    expect(WRITE in (value.apiKey as object)).toBe(true)

    // 宿主写入后，同一引用的 get() 立刻变化
    hostWrite(value.apiKey, 'tvly-new')
    expect(apiKey.get()).toBe('tvly-new')
  })

  it('未提供的字段也有引用（默认值/空串），宿主不需要特殊分支', () => {
    const value = validateConfig({})
    expect(isVolatileRef(value.language)).toBe(true)
    expect((value.language as { get: () => string }).get()).toBe('')
    expect(isVolatileRef(value.chain)).toBe(true)
    expect((value.chain as { get: () => unknown }).get()).toEqual([])
  })

  it('fallback 的叶子是引用，容器仍是普通对象（宿主按固定路径写 patch）', () => {
    const value = validateConfig({ fallback: { provider: 'exa', apiKey: 'e' } })
    const fallback = value.fallback as Record<string, unknown>
    expect(isVolatileRef(fallback)).toBe(false)
    expect(isVolatileRef(fallback.provider)).toBe(true)
    expect((fallback.apiKey as { get: () => string }).get()).toBe('e')
  })

  it('引用里的快照是深冻结的：插件侧不可能顺手改掉配置', () => {
    const value = validateConfig({ chain: [{ provider: 'exa', apiKey: 'e' }] })
    const chain = (value.chain as { get: () => Array<Record<string, string>> }).get()
    expect(Object.isFrozen(chain)).toBe(true)
    expect(Object.isFrozen(chain[0])).toBe(true)
  })

  it('unwrapVolatile 把引用摊平回普通 JSON（用于现取现用的解析）', () => {
    const value = validateConfig({ apiKey: 'k', chain: [{ provider: 'exa' }], fallback: { cx: 'c' } })
    const plain = unwrapVolatile(value)
    expect(plain).toEqual({
      provider: 'tavily',
      apiKey: 'k',
      baseUrl: '',
      cx: '',
      fallback: { provider: 'none', apiKey: '', baseUrl: '', cx: 'c' },
      chain: [{ provider: 'exa', apiKey: '', baseUrl: '', cx: '' }],
      maxResults: 5,
      maxSnippetChars: 250,
      timeoutMs: 15000,
      language: '',
      includeAnswer: false,
      outputFormat: 'markdown',
    })
    // 摊平后是全新对象，改它不会影响引用
    ;(plain as Record<string, unknown>).apiKey = 'mutated'
    expect((value.apiKey as { get: () => string }).get()).toBe('k')
  })

  it('withVolatileRefs 幂等：重复包裹不叠加', () => {
    const schema = withVolatileRefs(Schema.object({ a: volatile(Schema.string().default('')) }))
    const again = withVolatileRefs(schema)
    expect(again).toBe(schema)
    const result = schema['~standard'].validate({}) as { value?: { a?: unknown } }
    expect(isVolatileRef(result.value?.a)).toBe(true)
  })

  it('校验失败时原样返回 issues，绝不吞掉（否则装配期会静默拿到空配置）', () => {
    const schema = Schema.object({ n: Schema.number() })
    const wrapped = withVolatileRefs(schema)
    const result = wrapped['~standard'].validate({ n: 'not-a-number' }) as { issues?: unknown[] }
    expect(Array.isArray(result.issues)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 端到端：宿主写完引用后，下一次工具调用立刻用新值
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string
  timeoutMs?: number
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>
}

function createHarness() {
  const registered: RegisteredTool[] = []
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
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
    on: (name: string, listener: (...args: unknown[]) => void) => {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
  } as unknown as Context
  const emit = (name: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }
  return { ctx, registered, emit }
}

describe('热更新落到调用期（没有快照）', () => {
  it('改 maxResults 后下一次调用立刻使用新值', async () => {
    const value = validateConfig({ provider: 'tavily', apiKey: 'k', maxResults: 2 })
    const harness = createHarness()
    const dispose = apply(harness.ctx, value)
    const tool = harness.registered.find((entry) => entry.name === SEARCH_TOOL_NAME)
    expect(tool).toBeDefined()

    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await tool?.execute({ query: 'q' }, {})
    expect(bodies[0]?.max_results).toBe(2)

    // 宿主 _commitVolatile：写入引用后发事件
    hostWrite(value.maxResults, 9)
    harness.emit('loader/volatile-update', [['maxResults']])

    await tool?.execute({ query: 'q' }, {})
    expect(bodies[1]?.max_results).toBe(9)

    dispose()
  })

  it('把 Tavily 加进链后，额度工具在热更新时被注册；移出后又被摘除', () => {
    const value = validateConfig({ provider: 'searxng', apiKey: '', baseUrl: 'https://s.example' })
    const harness = createHarness()
    const dispose = apply(harness.ctx, value)

    const names = (): string[] => harness.registered.map((entry) => entry.name).sort()
    expect(names()).toEqual([SEARCH_TOOL_NAME])

    // 改主后端为 tavily（两个字段一起变，宿主会把两次写入都发出来）
    hostWrite(value.provider, 'tavily')
    hostWrite(value.apiKey, 'tvly-x')
    harness.emit('loader/volatile-update', [['provider'], ['apiKey']])
    expect(names()).toEqual([SEARCH_TOOL_NAME, USAGE_TOOL_NAME].sort())

    // 再改回 searxng：额度工具必须被摘掉（工具清单是结构性的）
    hostWrite(value.provider, 'searxng')
    hostWrite(value.apiKey, '')
    harness.emit('loader/volatile-update', [['provider'], ['apiKey']])
    expect(names()).toEqual([SEARCH_TOOL_NAME])

    dispose()
  })

  it('热更新监听器自身抛错不会外溢（会让宿主回滚整次保存）', () => {
    const value = validateConfig({ provider: 'tavily', apiKey: 'k' })
    const harness = createHarness()
    const dispose = apply(harness.ctx, value)

    // 传一个畸形的 paths：内部要能兜住
    expect(() => harness.emit('loader/volatile-update', 'not-an-array')).not.toThrow()
    expect(() => harness.emit('loader/volatile-update', [[null]])).not.toThrow()

    dispose()
  })

  it('createVolatileRef 的写入是深冻结快照（宿主写入的值也不能被引用持有者改动）', () => {
    const ref = createVolatileRef({ a: 1 })
    const next = { a: 2 }
    ;(ref as unknown as Record<symbol, (v: unknown) => void>)[WRITE](next)
    expect(ref.get()).toEqual({ a: 2 })
    // 外部随后修改源对象不会影响引用内快照
    next.a = 3
    expect(ref.get()).toEqual({ a: 2 })
  })
})
