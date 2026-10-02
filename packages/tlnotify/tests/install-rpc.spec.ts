// packages/tlnotify/tests/install-rpc.spec.ts
//
// 这一组测试锁的是**四次线上故障**，不是防回归的常规覆盖率。
//
// 第一次：`src/index.ts` 的 `#installRpc()` 曾经写的是 `this.#host.connection?.rpc`。
// cordis 的 Context 是个 Proxy：读一个既不是自有属性、又没被 `inject` 声明、store
// 里也没有的服务名时，它会**抛错**而不是返回 `undefined`
// （`@deepseek-ai/cordis/lib/index.js:676`：
// `cannot get property "${prop}" without inject`）。`?.` 挡不住抛异常的 getter。
//
// 第二次：**认错了宿主服务名**——写成了 `client-connection`，但那其实是
// `dsh-client-connection` 这个 cordis 插件自己的模块名
// （`lib/index.js:788` 的 `const name = …`）。真正的服务名是 `connection`
// （`lib/index.js:566` 的 `super(ctx, "connection")`）。后果是 `ctx.get` 永远返回
// `undefined`，40 次重试全部落空，设置页依旧永远 pending。
//
// 第三次：`ctx.get('connection')` 拿到服务了，但 `rpc.handle` **内部**会执行
// `owner.webServer.register(route)`（`lib/index.js:640-657`），而 `owner` 就是读服务
// 的那个 ctx；插件自己的 ctx 没声明 `webServer`，于是注册抛
// `cannot get property "webServer" without inject`，被自家 catch 吞成一行 warn，
// 路由从没进过 webserver → 浏览器 `POST /tlnotify/state` 掉进
// `dsh-host-frontend-static` 的兜底静态座位 → `HTTP 405`。
//
// 第四次（现在的实现）：改用 `connection.fetch.register`
// （`lib/index.js:625-639` 的 `registerFetchRoute`）。它只碰 `owner.effect(...)`，
// **从不读 `owner.webServer`**，所以在没有任何 inject 声明的插件 ctx 上也能挂上。
// 生态里是同一套做法：`@xmanrui/dsh-im/plugin-src/management-rpc.mjs:41-72`。
//
// 所以这个假 ctx **只对 `connection` 这个名字交出服务**，其余一律抛；假服务的
// `fetch.register` **真的去用 `owner.effect`**、真的登记进一张路由表（重复路径会抛，
// 和 Connection 一样）。任何一处退化——服务名写错、又去读 `webServer`、忘了
// try/catch、忘了注销——都会在这里当场炸出来。
//
// 完整因果链（第一次事故）：`start()` 第一句就抛 → 返回 rejected promise →
// `apply` 的 `.catch` 只调了 `host.logger.error` → **DSH 宿主自己不落任何日志文件**，
// 于是线索彻底消失 → RPC 从未注册 → 设置页永远停在「正在读取配置…」，且
// `plugin.log` 一行都没有。所以「宁可写一条 warn，也不要静默降级」是本文件的前提。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { RPC_METHODS, rpcRoutePath } from '../src/protocol.js'

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

/** 宿主侧 `request.json()` 我们看到的最小面。 */
interface FakeRequest {
  method: string
  json(): Promise<unknown>
}

/** 一条被注册的 Fetch 路由，字段与 Connection 的 `HostFetchRoute` 对齐。 */
interface RegisteredRoute {
  path: string
  methods: readonly string[]
  requestBody?: string
  fetch(request: FakeRequest): unknown
}

interface FetchCalls {
  /** 每次 `register()` 的路径，按调用顺序。 */
  paths: string[]
  /** 当前生效的路由表（键是路径）。 */
  routes: Map<string, RegisteredRoute>
  /** 注销函数被调用了几次＝真的从表里摘掉了几条。 */
  unregistered: number
  /** 假服务真的用了 `owner.effect(...)` 几次。 */
  effects: number
}

interface ServiceHandle {
  raw: unknown
  calls: FetchCalls
  /** 告诉服务「接下来读它的 ctx 是哪个」（真 cordis 的 getTraceable 发生在读取时）。 */
  mark(ctx: unknown): void
}

/**
 * 造一个假 `connection` 服务。
 *
 * `register` 忠实复刻 `HostConnectionService.registerFetchRoute`
 * （`dsh-client-connection/lib/index.js:625-639`）的**形状**：拿 `owner.effect(…)`
 * 登记，返回注销函数；重复路径抛错。关键性质是它**不读 `owner.webServer`**——
 * 这正是第四次修复能成立的原因，所以这里也不读。
 *
 * `failAt` 让第 N 次 `register` 抛错，用来验证「半套路由」会被撤掉。
 */
function makeService(options: { failAt?: number } = {}): ServiceHandle {
  const calls: FetchCalls = { paths: [], routes: new Map(), unregistered: 0, effects: 0 }
  let caller: Record<string, unknown> | undefined

  const raw = {
    fetch: {
      register(route: RegisteredRoute): () => void {
        calls.paths.push(route.path)
        if (options.failAt === calls.paths.length) {
          throw new Error(`client-connection: fetch.register 失败（测试注入，第 ${calls.paths.length} 条）`)
        }
        const effect = caller?.effect
        if (typeof effect !== 'function') throw new Error('connection: fetch.register 找不到 owner.effect')
        calls.effects += 1
        return effect(() => {
          if (calls.routes.has(route.path)) {
            throw new Error(`webserver: duplicate fetch route "${route.path}"`)
          }
          calls.routes.set(route.path, route)
          return () => {
            calls.routes.delete(route.path)
            calls.unregistered += 1
          }
        }) as () => void
      },
    },
  }

  return { raw, calls, mark: (ctx) => { caller = ctx as Record<string, unknown> } }
}

/** 复刻 cordis Context 的 Proxy：未声明的属性名一律抛错。 */
function makeCtx(target: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(target, {
    get(t, prop, receiver) {
      // 与 cordis 的 `isSpecialProperty` 对齐：符号、`then` 直接放行。
      if (typeof prop === 'symbol' || prop === 'then') return Reflect.get(t, prop, receiver)
      if (Reflect.has(t, prop)) return Reflect.get(t, prop, receiver)
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

interface FakeHost {
  ctx: Host
  /** `ctx.on(name, …)` 记录下来的监听器。 */
  subscriptions: Map<string, unknown>
  /** `ctx.get` 被调用的名字（用来断言重试真的发生了、没问错服务名）。 */
  gets: string[]
}

/**
 * 造一个 cordis 风格的宿主 ctx。
 *
 * `serviceAt` 决定第几次 `ctx.get('connection')` 开始返回服务——模拟「服务排在本插件
 * 之后装载」。`ctx.effect` 是 cordis 的动词（沙箱通过 `CTX_VERBS` 转发），
 * 假服务要用它登记，所以**总是**存在。
 */
function makeHost(
  options: {
    service?: ServiceHandle
    serviceAt?: number
    withGet?: boolean
    withLogger?: boolean
  } = {},
): FakeHost {
  const subscriptions = new Map<string, unknown>()
  const gets: string[] = []
  let calls = 0
  // 服务是在「读」的那一刻知道自己属于谁的（真 cordis 用 getTraceable 重绑 ctx）。
  let marked: unknown

  const target: Record<string, unknown> = {
    on(name: string, listener: unknown) {
      subscriptions.set(name, listener)
      return () => subscriptions.delete(name)
    },
    effect(execute: () => unknown) {
      const dispose = execute()
      return () => {
        if (typeof dispose === 'function') (dispose as () => void)()
      }
    },
  }
  if (options.withLogger !== false) {
    target.logger = { info() {}, warn() {}, error() {}, debug() {} }
  }
  if (options.withGet !== false) {
    target.get = (name: string): unknown => {
      gets.push(name)
      if (name !== 'connection') return undefined
      calls += 1
      const at = options.serviceAt ?? 1
      if (calls < at) return undefined
      options.service?.mark(marked)
      return options.service?.raw
    }
  }

  const ctx = makeCtx(target)
  marked = ctx
  return { ctx: ctx as unknown as Host, subscriptions, gets }
}

function logOf(dataDir: string): string {
  const path = join(dataDir, 'plugin.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** 我们只用到 `Response` 的两个成员；宿主 tsconfig 不带 DOM，不引全局类型。 */
interface RawResponse {
  status: number
  json(): Promise<unknown>
}

const asResponse = (value: unknown): RawResponse => value as RawResponse

const postBody = (rpcId: string, payload: unknown = {}): FakeRequest => ({
  method: 'POST',
  json: async () => ({ type: 'client-request', rpcId, method: 'tlnotify/state', payload }),
})

const EXPECTED_PATHS = RPC_METHODS.map((method) => rpcRoutePath(method))

describe('设置页 RPC 的挂载方式', () => {
  it('读未 inject 的服务名确实会抛（证明这个假 ctx 是忠实的）', () => {
    const { ctx } = makeHost()
    const probe = ctx as unknown as Record<string, unknown>
    expect(() => probe['connection']).toThrow(/without inject/)
    expect(() => probe['client-connection']).toThrow(/without inject/)
    expect(() => probe['webServer']).toThrow(/without inject/)
  })

  it('用 connection.fetch 注册 5 条 /api/tlnotify/<method>，全程不碰 webServer', async () => {
    const dataDir = tempDir()
    const service = makeService()
    const host = makeHost({ service })

    const dispose = apply(host.ctx, { dataDir })

    expect([...service.calls.routes.keys()]).toEqual(EXPECTED_PATHS)
    for (const route of service.calls.routes.values()) {
      expect(route.methods).toEqual(['POST'])
      expect(route.requestBody).toBe('buffered')
      expect(typeof route.fetch).toBe('function')
    }
    // 假服务真的走了 `owner.effect`：5 条路由各一次。
    expect(service.calls.effects).toBe(RPC_METHODS.length)
    // 假 ctx 对未声明的属性（含 `webServer`）是**抛**的：注册跑完就说明没读它。
    expect(host.gets).not.toContain('webServer')
    expect(host.gets).not.toContain('client-connection')
    expect(logOf(dataDir)).toContain('设置页 RPC 已挂载')

    await dispose()
  })

  it('问的是服务名 connection，而不是插件名 client-connection', async () => {
    const dataDir = tempDir()
    const host = makeHost({ service: makeService() })

    const dispose = apply(host.ctx, { dataDir })
    expect(host.gets).toContain('connection')
    expect(host.gets).not.toContain('client-connection')

    await dispose()
  })

  it('端到端：注册到的路由真的能应答 Connection 的信封', async () => {
    const dataDir = tempDir()
    const service = makeService()
    const host = makeHost({ service })

    const dispose = apply(host.ctx, { dataDir })
    const route = service.calls.routes.get(rpcRoutePath('state'))
    expect(route).toBeDefined()

    const response = asResponse(await route?.fetch(postBody('r-1')))
    expect(response.status).toBe(200)
    const body = asRecord(await response.json())
    expect(body.type).toBe('server-response')
    // rpcId 必须原样回显：浏览器侧的 parseConnectionResponse 会核对它。
    expect(body.rpcId).toBe('r-1')
    const result = asRecord(body.result)
    expect(result.ok).toBe(true)
    expect(asRecord(asRecord(result.value).status)).toBeTruthy()

    // 信封不对 → 400（这种情况没有 rpcId 可以回显）。
    const bad = asResponse(await route?.fetch({ method: 'POST', json: async () => ({ type: 'nope' }) }))
    expect(bad.status).toBe(400)

    // 非 POST → 405。
    const wrongMethod = asResponse(await route?.fetch({ method: 'GET', json: async () => ({}) }))
    expect(wrongMethod.status).toBe(405)

    await dispose()
  })

  it('服务晚到时按 500ms 重试，取到后只注册一轮', async () => {
    vi.useFakeTimers()
    const dataDir = tempDir()
    const service = makeService()
    // 第 3 次询问才拿到服务：模拟 bundle 层把 connection 服务排在我们后面。
    const host = makeHost({ service, serviceAt: 3 })

    const dispose = apply(host.ctx, { dataDir })
    expect(service.calls.paths).toEqual([])

    await vi.advanceTimersByTimeAsync(1000)
    expect(service.calls.paths).toEqual([...EXPECTED_PATHS])

    // 再久也不会重复注册（Connection 对重复路径会抛）。
    await vi.advanceTimersByTimeAsync(120_000)
    expect(service.calls.paths).toEqual([...EXPECTED_PATHS])
    expect(service.calls.routes.size).toBe(RPC_METHODS.length)
    expect(logOf(dataDir)).not.toContain('宿主没有提供客户端 RPC 通道')

    await dispose()
  })

  it('一直取不到时只警告一次，并把原因与逃生路径写进 plugin.log', async () => {
    vi.useFakeTimers()
    const dataDir = tempDir()
    // 没有 service：这个宿主没有 Web 半边（headless 部署）。
    const host = makeHost()

    const dispose = apply(host.ctx, { dataDir })
    await vi.advanceTimersByTimeAsync(40 * 500 + 200)

    const log = logOf(dataDir)
    expect(log).toContain('宿主没有提供客户端 RPC 通道')
    expect(log).toContain('connection 服务或它的 fetch 注册表')
    expect(log).toContain(join(dataDir, 'config.json'))
    // 只在耗尽重试后警告一次；重试期间不刷屏。
    expect(log.match(/宿主没有提供客户端 RPC 通道/g)?.length).toBe(1)

    await dispose()
  })

  it('单条注册失败时撤掉已经挂上的那些，不留下半套路由', async () => {
    vi.useFakeTimers()
    const dataDir = tempDir()
    const service = makeService({ failAt: 3 })
    const host = makeHost({ service })

    const dispose = apply(host.ctx, { dataDir })

    // 前两条被登记后又被注销：半套路由比彻底不可用更难查（某个操作莫名 404）。
    expect(service.calls.paths).toHaveLength(3)
    expect(service.calls.routes.size).toBe(0)
    expect(service.calls.unregistered).toBe(2)
    expect(logOf(dataDir)).toContain('挂载设置页 RPC 失败')

    // 这不是瞬态问题，不该反复重试刷日志。
    await vi.advanceTimersByTimeAsync(60_000)
    expect(service.calls.paths).toHaveLength(3)

    await dispose()
  })

  it('dispose 后所有路由注销，且不再重试', async () => {
    vi.useFakeTimers()
    const dataDir = tempDir()
    const service = makeService()
    const host = makeHost({ service })

    const dispose = apply(host.ctx, { dataDir })
    expect(service.calls.routes.size).toBe(RPC_METHODS.length)

    await dispose()
    expect(service.calls.routes.size).toBe(0)
    expect(service.calls.unregistered).toBe(RPC_METHODS.length)

    const before = host.gets.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.gets.length).toBe(before)
  })

  it('ctx 连 connection 属性都抛、也没有 get 时，apply 不抛，降级到文件配置', async () => {
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
