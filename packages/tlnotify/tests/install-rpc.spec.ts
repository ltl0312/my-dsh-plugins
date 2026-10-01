// packages/tlnotify/tests/install-rpc.spec.ts
//
// 这一组测试锁的是一个**线上故障**，不是防回归的常规覆盖率。
//
// `src/index.ts` 的 `#installRpc()` 曾经写的是 `this.#host.connection?.rpc`。但
// cordis 的 Context 是个 Proxy：读一个既不是自有属性、又没被 `inject` 声明、store
// 里也没有的服务名时，它会**抛错**而不是返回 `undefined`
// （`@deepseek-ai/cordis/lib/index.js:676`：
// `cannot get property "${prop}" without inject`）。而 `connection` 是**浏览器
// 半边**的服务名，宿主上根本不存在（宿主侧叫 `client-connection`）。
//
// 后果是一条完整的因果链：
//   `start()` 第一句就抛 → 返回 rejected promise → `apply` 的 `.catch` 只调了
//   `host.logger.error` → **DSH 宿主自己不落任何日志文件**，于是线索彻底消失
//   → RPC 从未注册 → 设置页永远停在「正在读取配置…」，且 `plugin.log` 一行都没有。
//
// 所以这里的假 ctx **刻意模仿那个 Proxy**：读未知属性直接抛。任何一处忘了
// try/catch、或绕开 `ctx.get` 去直接读服务，都会在这里当场炸出来。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { RPC_CHANNEL } from '../src/protocol.js'

type Host = Parameters<typeof apply>[0]

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tlnotify-install-rpc-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface RpcCalls {
  channels: string[]
  unregistered: number
}

function makeService(): { service: unknown; calls: RpcCalls } {
  const calls: RpcCalls = { channels: [], unregistered: 0 }
  const rpc = {
    handle(channel: string, _handler: unknown): () => Promise<void> {
      calls.channels.push(channel)
      return async () => {
        calls.unregistered += 1
      }
    },
  }
  return { service: { rpc }, calls }
}

interface FakeHost {
  ctx: Host
  /** `ctx.on(name, …)` 记录下来的监听器。 */
  subscriptions: Map<string, unknown>
  /** `ctx.get` 被调用的名字（用来断言重试真的发生了）。 */
  gets: string[]
}

/**
 * 造一个 cordis 风格的宿主 ctx。
 *
 * `serviceAt` 决定第几次 `ctx.get('client-connection')` 开始返回服务——用来模拟
 * 「连接服务排在本插件之后装载」。
 */
function makeHost(options: { service?: unknown; serviceAt?: number; withGet?: boolean; withLogger?: boolean } = {}): FakeHost {
  const subscriptions = new Map<string, unknown>()
  const gets: string[] = []
  let calls = 0
  const target: Record<string, unknown> = {
    on(name: string, listener: unknown) {
      subscriptions.set(name, listener)
      return () => subscriptions.delete(name)
    },
  }
  if (options.withLogger !== false) {
    target.logger = { info() {}, warn() {}, error() {}, debug() {} }
  }
  if (options.withGet !== false) {
    target.get = (name: string) => {
      gets.push(name)
      if (name !== 'client-connection') return undefined
      calls += 1
      const at = options.serviceAt ?? 1
      return calls >= at ? options.service : undefined
    }
  }
  const ctx = new Proxy(target, {
    get(t, prop, receiver) {
      // 与 cordis 的 `isSpecialProperty` 对齐：符号、`then` 直接放行。
      if (typeof prop === 'symbol' || prop === 'then') return Reflect.get(t, prop, receiver)
      if (Reflect.has(t, prop)) return Reflect.get(t, prop, receiver)
      throw new Error(`cannot get property "${prop}" without inject`)
    },
  })
  return { ctx: ctx as unknown as Host, subscriptions, gets }
}

function logOf(dataDir: string): string {
  const path = join(dataDir, 'plugin.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

describe('设置页 RPC 的取服务方式', () => {
  it('读未 inject 的服务名确实会抛（证明这个假 ctx 是忠实的）', () => {
    const { ctx } = makeHost()
    expect(() => (ctx as unknown as Record<string, unknown>)['connection']).toThrow(/without inject/)
    expect(() => (ctx as unknown as Record<string, unknown>)['client-connection']).toThrow(/without inject/)
  })

  it('从 ctx.get 取到服务时注册 RPC，且完全不去读 ctx.connection', async () => {
    const dataDir = tempDir()
    const { service, calls } = makeService()
    const host = makeHost({ service })

    const dispose = apply(host.ctx, { dataDir })
    expect(calls.channels).toEqual([RPC_CHANNEL])

    await dispose()
    expect(calls.unregistered).toBe(1)
  })

  it('ctx 连 client-connection 属性都抛、也没有 get 时，apply 不抛，降级到文件配置', async () => {
    const dataDir = tempDir()
    const host = makeHost({ withGet: false })

    let dispose: (() => void) | undefined
    expect(() => {
      dispose = apply(host.ctx, { dataDir })
    }).not.toThrow()

    // 没有 RPC 也不该影响事件源挂载：审批 / 提问的钩子照旧。
    expect(host.subscriptions.has('approval/request')).toBe(true)
    expect(host.subscriptions.has('user-questions/request')).toBe(true)

    await dispose?.()
  })

  it('取不到服务时按 500ms 重试，等它装载好就自动挂上', async () => {
    vi.useFakeTimers()
    const dataDir = tempDir()
    const { service, calls } = makeService()
    // 第 3 次询问才拿到服务：模拟 bundle 层把 client-connection 排在我们后面。
    const host = makeHost({ service, serviceAt: 3 })

    const dispose = apply(host.ctx, { dataDir })
    expect(calls.channels).toEqual([])

    await vi.advanceTimersByTimeAsync(500)
    expect(calls.channels).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls.channels).toEqual([RPC_CHANNEL])

    await dispose()
  })

  it('一直取不到时只警告一次，并把原因与逃生路径写进 plugin.log', async () => {
    vi.useFakeTimers()
    const dataDir = tempDir()
    const host = makeHost()

    const dispose = apply(host.ctx, { dataDir })
    await vi.advanceTimersByTimeAsync(40 * 500 + 200)

    const log = logOf(dataDir)
    expect(log).toContain('宿主没有提供客户端 RPC 通道')
    expect(log).toContain('client-connection')
    expect(log).toContain(join(dataDir, 'config.json'))
    // 只在耗尽重试后警告一次；重试期间不刷屏。
    expect(log.match(/宿主没有提供客户端 RPC 通道/g)?.length).toBe(1)

    await dispose()
  })

  it('dispose 之后不再重试', async () => {
    vi.useFakeTimers()
    const dataDir = tempDir()
    const host = makeHost()

    const dispose = apply(host.ctx, { dataDir })
    await vi.advanceTimersByTimeAsync(500)
    const before = host.gets.length

    await dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.gets.length).toBe(before)
    expect(logOf(dataDir)).not.toContain('宿主没有提供客户端 RPC 通道')
  })

  it('构造函数抛错时不把异常抛给宿主，并且把「初始化失败」写进 plugin.log', () => {
    vi.useFakeTimers()
    const dataDir = tempDir()
    // 没有 logger 属性 → Proxy 抛 → 构造函数在 FileLogger 那一行就失败。
    const host = makeHost({ withLogger: false })

    let dispose: (() => void) | undefined
    expect(() => {
      dispose = apply(host.ctx, { dataDir })
    }).not.toThrow()
    expect(logOf(dataDir)).toContain('初始化失败')
    dispose?.()
  })
})
