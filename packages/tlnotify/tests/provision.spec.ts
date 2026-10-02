// packages/tlnotify/tests/provision.spec.ts
//
// 「扫码创建 QQ 机器人」宿主侧状态机（`src/provision.ts`）。
//
// 全程用注入的假 QQ 适配器：不碰网络、不碰真 SDK、也不真的等 15 秒。这里钉的是
// 几件**静默**的坏法：
//
//   * 把厂商 URL 当成图片去渲染 / 忘了写进 `qrText` → 设置页永远看不到二维码；
//   * 取消或超时之后没 dispose → 腾讯那边留下一个还在轮询的会话；
//   * 终态之后 SDK 的迟到回调又改状态 → 用户看着「已取消」下一秒变「失败」；
//   * 日志或快照里出现 appSecret → 密钥进了 plugin.log、宿主终端和浏览器；
//   * 同一通道重复 `begin` 没作废旧的 → 每次点按钮都多一个活会话。
//
// 「等码超时」不靠真等：`qrTimeoutMs` 是构造参数，测试里配合 `vi.useFakeTimers()`
// 把它压到几十毫秒，时钟也只推进那么一点点（默认值另有一条单独的断言）。

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MockedFunction } from 'vitest'

import {
  DEFAULT_QR_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  ProvisionManager,
  QR_SOURCE,
  QR_TTL_MS,
} from '../src/provision.js'
import type { ProvisionCredentials, QqAdapter, QqQrCallbacks } from '../src/provision.js'
import type { RpcFailure, RpcResult, ProvisionSnapshot } from '../src/protocol.js'
import type { ChannelConfig, ChannelLogger } from '../src/types.js'

afterEach(() => {
  vi.useRealTimers()
})

const QR_URL_1 = 'https://q.qq.com/qqbot/openapi/v2/bind?task_id=TASK-1&source=deepseek-harness'
const QR_URL_2 = 'https://q.qq.com/qqbot/openapi/v2/bind?task_id=TASK-2&source=deepseek-harness'

function channel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return { id: 'qq-main', type: 'qq', enabled: true, sessionFilter: [], ...overrides }
}

/** 取出成功结果；失败时把 error 打出来，否则断言失败只看得到 undefined。 */
function unwrap(result: RpcResult<ProvisionSnapshot>): ProvisionSnapshot {
  if (!result.ok) throw new Error(`期望成功，实际：${result.error.code} ${result.error.message}`)
  return result.value
}

/** 取出失败原因；成功时直接报错。 */
function failure(result: RpcResult<ProvisionSnapshot>): RpcFailure {
  if (result.ok) throw new Error(`期望失败，实际成功：${JSON.stringify(result.value)}`)
  return result.error
}

// ---------------------------------------------------------------------------
// 假适配器与假 logger
// ---------------------------------------------------------------------------

interface QqCallOptions {
  displayQrCodeToConsole: boolean
  source: string
  signal: AbortSignal
}

interface FakeQq {
  adapter: QqAdapter
  /** 每次适配器被调用时收到的回调集合（按调用顺序）。 */
  callbacks: QqQrCallbacks[]
  /** 每次适配器被调用时收到的选项。 */
  options: QqCallOptions[]
  /** `session.dispose()` 被调用了几次。 */
  disposed: number
  /** 最新一次的回调集合（SDK 侧回调就是这样推过来的）。 */
  latest(): QqQrCallbacks
  latestOptions(): QqCallOptions
}

function fakeQq(): FakeQq {
  const fake: FakeQq = {
    adapter: () => ({ dispose: () => {} }),
    callbacks: [],
    options: [],
    disposed: 0,
    latest(): QqQrCallbacks {
      const callbacks = fake.callbacks[fake.callbacks.length - 1]
      if (!callbacks) throw new Error('适配器还没被调用过')
      return callbacks
    },
    latestOptions(): QqCallOptions {
      const options = fake.options[fake.options.length - 1]
      if (!options) throw new Error('适配器还没被调用过')
      return options
    },
  }
  fake.adapter = (callbacks, options) => {
    fake.callbacks.push(callbacks)
    fake.options.push(options)
    return { dispose: () => void (fake.disposed += 1) }
  }
  return fake
}

/**
 * 等适配器被调用到第 n 次。
 *
 * 注入适配器时 `begin` 是一路同步走到 `adapter(...)` 的，所以这通常第一次就让过；
 * 留着它只是为了不把测试写成「依赖实现恰好是同步的」。
 */
async function waitForCalls(fake: FakeQq, n: number): Promise<void> {
  for (let i = 0; i < 100 && fake.callbacks.length < n; i += 1) await Promise.resolve()
  if (fake.callbacks.length < n) {
    throw new Error(`适配器只被调用了 ${fake.callbacks.length} 次，期望 ${n} 次`)
  }
}

/** 收集日志行的假 logger；故意比 `ChannelLogger` 多一个 `debug`（真实现也有）。 */
type CollectingLogger = ChannelLogger & { debug?: (message: string) => void }

function collectingLogger(lines: string[]): CollectingLogger {
  const line = (message: string, error?: unknown): string =>
    error === undefined ? message : `${message} | ${String(error)}`
  return {
    info: (message) => void lines.push(message),
    warn: (message, error) => void lines.push(line(message, error)),
    error: (message, error) => void lines.push(line(message, error)),
    debug: (message) => void lines.push(message),
  }
}

type OnCredentials = (channelId: string, credentials: ProvisionCredentials) => Promise<void>

interface Harness {
  manager: ProvisionManager
  fake: FakeQq
  lines: string[]
  onCredentials: MockedFunction<OnCredentials>
}

function harness(overrides: { onCredentials?: OnCredentials; qrTimeoutMs?: number } = {}): Harness {
  const fake = fakeQq()
  const lines: string[] = []
  const onCredentials = vi.fn<OnCredentials>(overrides.onCredentials ?? (async () => {}))
  const manager = new ProvisionManager({
    log: collectingLogger(lines),
    onCredentials,
    qq: fake.adapter,
    ...(overrides.qrTimeoutMs === undefined ? {} : { qrTimeoutMs: overrides.qrTimeoutMs }),
  })
  return { manager, fake, lines, onCredentials }
}

/** 走完「begin → 第一张码」这一小段，返回 begin 给的快照。 */
async function beginWithQr(h: Harness, config: ChannelConfig = channel(), url = QR_URL_1): Promise<ProvisionSnapshot> {
  // 先记下调用次数再 begin：注入适配器时 begin 会同步走到 adapter(...)，
  // 事后再取 length 就已经把这一次算进去了，等它会一直等下一次调用。
  const before = h.fake.callbacks.length
  const pending = h.manager.begin(config)
  await waitForCalls(h.fake, before + 1)
  h.fake.latest().onQrDisplayed(url)
  return unwrap(await pending)
}

// ---------------------------------------------------------------------------
// begin
// ---------------------------------------------------------------------------

describe('begin：等到第一张码', () => {
  it('有码就返回 waiting；二维码只给 qrText，宿主不画图片', async () => {
    const h = harness()
    const pending = h.manager.begin(channel())
    await waitForCalls(h.fake, 1)

    // 选项必须在宿主侧关掉控制台打印，并带上调用来源
    expect(h.fake.latestOptions().displayQrCodeToConsole).toBe(false)
    expect(h.fake.latestOptions().source).toBe(QR_SOURCE)
    expect(h.fake.latestOptions().signal.aborted).toBe(false)

    const before = Date.now()
    h.fake.latest().onQrDisplayed(QR_URL_1)
    const snapshot = unwrap(await pending)

    expect(snapshot.state).toBe('waiting')
    expect(snapshot.qrText).toBe(QR_URL_1)
    // 宿主侧不渲染图片：qrDataUrl 必须留空，设置页才会走 qrText + 内置 qrcode
    expect(snapshot.qrDataUrl).toBeUndefined()
    expect(snapshot.attemptId).toMatch(/^[0-9a-f-]{36}$/)
    expect(snapshot.channelId).toBe('qq-main')
    expect(snapshot.type).toBe('qq')
    expect(snapshot.pollIntervalMs).toBe(POLL_INTERVAL_MS)
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.expiresAt).toBeGreaterThanOrEqual(before + QR_TTL_MS)
    expect(snapshot.expiresAt).toBeLessThanOrEqual(Date.now() + QR_TTL_MS)
    // 二维码 URL 带一次性绑定任务 id，不进日志
    expect(h.lines.join('\n')).not.toContain(QR_URL_1)
  })

  it('默认等码超时是 15 秒（下面那条用注入的小值，不真等）', () => {
    expect(DEFAULT_QR_TIMEOUT_MS).toBe(15_000)
    expect(POLL_INTERVAL_MS).toBe(1000)
  })

  it('适配器不出码：到点返回 qr-timeout，并且不再留着活的 SDK 会话', async () => {
    vi.useFakeTimers()
    const h = harness({ qrTimeoutMs: 30 })
    const pending = h.manager.begin(channel())
    await waitForCalls(h.fake, 1)

    // 只推进「等码」这一个定时器：30ms 就够，不用等 15 秒
    await vi.advanceTimersByTimeAsync(31)

    const error = failure(await pending)
    expect(error.code).toBe('qr-timeout')
    expect(error.message).toBe('腾讯那边没有返回二维码，请稍后重试')
    // 超时了就不能再挂着腾讯那边的轮询
    expect(h.fake.disposed).toBe(1)
    expect(h.fake.latestOptions().signal.aborted).toBe(true)
  })

  it('SDK 同步抛（装坏 / 加载失败）→ qr-failed，且不留会话', async () => {
    const lines: string[] = []
    const throwing: QqAdapter = () => {
      throw new Error('qrcode-terminal 加载失败')
    }
    const manager = new ProvisionManager({
      log: collectingLogger(lines),
      onCredentials: vi.fn<OnCredentials>(async () => {}),
      qq: throwing,
    })

    const error = failure(await manager.begin(channel()))
    expect(error.code).toBe('qr-failed')
    expect(error.message).toBe('qrcode-terminal 加载失败')
    expect(lines.join('\n')).toContain('SDK 启动失败')
  })
})

// ---------------------------------------------------------------------------
// 扫码成功 → 写配置
// ---------------------------------------------------------------------------

describe('扫码成功之后', () => {
  it('onSuccess → onCredentials 收到 appId/appSecret/targetId，之后 poll 是 done', async () => {
    const h = harness()
    const first = await beginWithQr(h)

    h.fake.latest().onSuccess([
      { appId: '102000001', appSecret: 'SECRET-VALUE', userOpenid: 'USER-OPENID' },
    ])
    // connecting 是同步置上的：写配置之前设置页就该看到进度
    expect(unwrap(h.manager.poll(channel(), first.attemptId)).state).toBe('connecting')

    await vi.waitFor(() => {
      expect(unwrap(h.manager.poll(channel(), first.attemptId)).state).toBe('done')
    })

    expect(h.onCredentials).toHaveBeenCalledTimes(1)
    expect(h.onCredentials.mock.calls[0]![0]).toBe('qq-main')
    expect(h.onCredentials.mock.calls[0]![1]).toEqual({
      appId: '102000001',
      appSecret: 'SECRET-VALUE',
      targetId: 'USER-OPENID',
    })

    const done = unwrap(h.manager.poll(channel(), first.attemptId))
    expect(done.filledField).toBe('appId')
    expect(done.filledTargetId).toBe('USER-OPENID')
    expect(done.error).toBeUndefined()
    expect(h.fake.disposed).toBe(1)

    // 日志里只该出现 appId 与 userOpenid，永远不该出现 appSecret
    const logs = h.lines.join('\n')
    expect(logs).not.toContain('SECRET-VALUE')
    expect(logs).toContain('102000001')
    expect(logs).toContain('USER-OPENID')
  })

  it('onCredentials 抛错 → failed，且 error 就是那句 message', async () => {
    const h = harness({
      onCredentials: async () => {
        throw new Error('写入配置失败：磁盘满了')
      },
    })
    const first = await beginWithQr(h)

    h.fake.latest().onSuccess([
      { appId: '102000001', appSecret: 'SECRET-VALUE', userOpenid: 'USER-OPENID' },
    ])

    await vi.waitFor(() => {
      expect(unwrap(h.manager.poll(channel(), first.attemptId)).state).toBe('failed')
    })
    const snapshot = unwrap(h.manager.poll(channel(), first.attemptId))
    expect(snapshot.error).toBe('写入配置失败：磁盘满了')
    expect(snapshot.filledField).toBeUndefined()
    // 失败也要收掉 SDK 会话
    expect(h.fake.disposed).toBe(1)
  })

  it('onCredentials 的报错里带了 appSecret → 快照与日志里都先抹掉', async () => {
    const h = harness({
      onCredentials: async () => {
        throw new Error('写盘失败: {"appSecret":"SECRET-VALUE"}')
      },
    })
    const first = await beginWithQr(h)

    h.fake.latest().onSuccess([
      { appId: '102000001', appSecret: 'SECRET-VALUE', userOpenid: 'USER-OPENID' },
    ])

    await vi.waitFor(() => {
      expect(unwrap(h.manager.poll(channel(), first.attemptId)).state).toBe('failed')
    })
    const snapshot = unwrap(h.manager.poll(channel(), first.attemptId))
    expect(snapshot.error).not.toContain('SECRET-VALUE')
    expect(snapshot.error).toContain('[redacted]')
    expect(h.lines.join('\n')).not.toContain('SECRET-VALUE')
  })

  it('凭据不完整 → failed（空数组、缺 userOpenid 都算）', async () => {
    const empty = harness()
    const first = await beginWithQr(empty)
    empty.fake.latest().onSuccess([])
    const blank = unwrap(empty.manager.poll(channel(), first.attemptId))
    expect(blank.state).toBe('failed')
    expect(blank.error).toContain('凭据不完整')
    expect(empty.onCredentials).not.toHaveBeenCalled()
    // 凭据不完整也不该留着 SDK 会话
    expect(empty.fake.disposed).toBe(1)

    const partial = harness()
    const second = await beginWithQr(partial)
    partial.fake.latest().onSuccess([{ appId: '102000001', appSecret: 'SECRET-VALUE' }])
    const snapshot = unwrap(partial.manager.poll(channel(), second.attemptId))
    expect(snapshot.state).toBe('failed')
    expect(snapshot.error).toContain('凭据不完整')
    expect(partial.onCredentials).not.toHaveBeenCalled()
  })

  it('onFailure → failed；未知错误给中文兜底，不把 [object Object] 甩给用户', async () => {
    const h = harness()
    const first = await beginWithQr(h)
    h.fake.latest().onFailure(new Error('获取绑定任务失败: 网络不可达'))
    const snapshot = unwrap(h.manager.poll(channel(), first.attemptId))
    expect(snapshot.state).toBe('failed')
    expect(snapshot.error).toBe('获取绑定任务失败: 网络不可达')
    expect(h.fake.disposed).toBe(1)

    const other = harness()
    const second = await beginWithQr(other)
    other.fake.latest().onFailure({ code: 500 })
    const fallback = unwrap(other.manager.poll(channel(), second.attemptId))
    expect(fallback.state).toBe('failed')
    expect(fallback.error).toBe('扫码创建 QQ 机器人失败（腾讯返回了未知错误），请稍后重试')
  })
})

// ---------------------------------------------------------------------------
// 取消、过期换码、dispose
// ---------------------------------------------------------------------------

describe('取消与清理', () => {
  it('cancel → cancelled、dispose 一次；迟到的 onFailure 改不回来', async () => {
    const h = harness()
    const first = await beginWithQr(h)

    const cancelled = unwrap(h.manager.cancel(channel(), first.attemptId))
    expect(cancelled.state).toBe('cancelled')
    expect(h.fake.disposed).toBe(1)
    expect(h.fake.latestOptions().signal.aborted).toBe(true)

    // SDK 的 signal 一 abort 就会回调 onFailure(new Error('已取消'))
    // （dist/esm/qr-connect.js 里就是 `r.onFailure(new Error("已取消"))`），
    // 它不能把已经落定的 cancelled 改成 failed
    h.fake.latest().onFailure(new Error('已取消'))
    expect(unwrap(h.manager.poll(channel(), first.attemptId)).state).toBe('cancelled')

    // cancel 幂等：不会重复 dispose，也不会改状态
    expect(unwrap(h.manager.cancel(channel(), first.attemptId)).state).toBe('cancelled')
    expect(h.fake.disposed).toBe(1)
  })

  it('过期不是终点：腾讯换发新码后回到 waiting，且旧会话还活着', async () => {
    const h = harness()
    const first = await beginWithQr(h)

    h.fake.latest().onQrExpired()
    const expired = unwrap(h.manager.poll(channel(), first.attemptId))
    expect(expired.state).toBe('expired')

    h.fake.latest().onQrDisplayed(QR_URL_2)
    const refreshed = unwrap(h.manager.poll(channel(), first.attemptId))
    expect(refreshed.state).toBe('waiting')
    expect(refreshed.qrText).toBe(QR_URL_2)
    expect(refreshed.expiresAt).toBeGreaterThanOrEqual(expired.expiresAt!)
    // 换码是 SDK 内部重试，不该把会话收掉
    expect(h.fake.disposed).toBe(0)
  })

  it('同一通道再次 begin：上一次被作废并 dispose，不留下第二个活会话', async () => {
    const h = harness()
    const firstAttempt = await beginWithQr(h)
    const secondAttempt = await beginWithQr(h)

    expect(h.fake.callbacks.length).toBe(2)
    expect(h.fake.disposed).toBe(1)
    expect(unwrap(h.manager.poll(channel(), firstAttempt.attemptId)).state).toBe('cancelled')
    expect(unwrap(h.manager.poll(channel(), secondAttempt.attemptId)).state).toBe('waiting')
  })

  it('dispose() 收掉所有会话与定时器；之后再 poll 只报「找不到」，不抛', async () => {
    vi.useFakeTimers()
    const h = harness({ qrTimeoutMs: 30 })
    const attemptA = await beginWithQr(h, channel())
    const attemptB = await beginWithQr(h, channel({ id: 'qq-second' }))

    h.manager.dispose()
    expect(h.fake.disposed).toBe(2)
    expect(h.fake.options[0]!.signal.aborted).toBe(true)
    expect(h.fake.options[1]!.signal.aborted).toBe(true)

    // 记录已经作废：给出去的 attemptId 只能报「找不到」
    expect(failure(h.manager.poll(channel(), attemptA.attemptId)).code).toBe('no-attempt')
    expect(failure(h.manager.poll(channel({ id: 'qq-second' }), attemptB.attemptId)).code).toBe(
      'no-attempt',
    )

    // 重复 dispose 不抛，等码定时器也已经清掉（推进时钟不再有任何副作用）
    expect(() => h.manager.dispose()).not.toThrow()
    await vi.advanceTimersByTimeAsync(100)
    expect(h.fake.disposed).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 不支持与找不到
// ---------------------------------------------------------------------------

describe('飞书与找不到的尝试', () => {
  it('feishu 一律 unsupported，且完全不碰适配器', async () => {
    const h = harness()
    const feishu = channel({ id: 'fs-main', type: 'feishu' })

    const beginError = failure(await h.manager.begin(feishu))
    expect(beginError.code).toBe('unsupported')
    expect(beginError.message).toContain('AppLink')
    expect(beginError.message).toContain('不需要扫码创建应用')

    expect(failure(h.manager.poll(feishu, 'whatever')).code).toBe('unsupported')
    expect(failure(h.manager.cancel(feishu, 'whatever')).code).toBe('unsupported')
    expect(h.fake.callbacks.length).toBe(0)
  })

  it('未知 attemptId → no-attempt；跨通道也算未知', async () => {
    const h = harness()
    const missing = failure(h.manager.poll(channel(), 'nope'))
    expect(missing.code).toBe('no-attempt')
    expect(missing.message).toContain('nope')
    expect(failure(h.manager.cancel(channel(), 'nope')).code).toBe('no-attempt')

    // 通道对不上也是「找不到」：绝不把 A 通道的扫码结果交给 B 通道
    const first = await beginWithQr(h)
    expect(failure(h.manager.poll(channel({ id: 'qq-other' }), first.attemptId)).code).toBe(
      'no-attempt',
    )
    expect(failure(h.manager.cancel(channel({ id: 'qq-other' }), first.attemptId)).code).toBe(
      'no-attempt',
    )
    // 而本通道仍然正常
    expect(unwrap(h.manager.poll(channel(), first.attemptId)).state).toBe('waiting')
  })
})
