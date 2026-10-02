// packages/tlnotify/src/provision.ts
//
// 「扫码创建 QQ 机器人」的宿主侧实现（设计方案《每机器人设置方案》§4）。
//
// 流程：设置页点「扫码创建」→ 宿主调腾讯官方的连接器 SDK → SDK 拿到一张二维码
// URL 并开始轮询 → 用户用手机 QQ 扫码授权 → SDK 回调凭据（appId / appSecret /
// userOpenid）→ 宿主回调 `onCredentials()` 把凭据写进配置并重启通道。
//
// 三条刻意的设计约束：
//
// 1. **二维码不在宿主侧渲染成图片**。SDK 给的是 URL，原样放进
//    `ProvisionSnapshot.qrText`，由设置页里已有的 `qrcode` 打包件画出来——这
//    正是协议里 `qrText` 字段存在的理由（`protocol.ts:452-453`）。所以这个模块
//    不需要任何图片编码依赖，`qrDataUrl` 永远留空。
// 2. **SDK 是动态 import 的**。它只在这一条流程里用得上，而且「没装 / 装坏」是
//    可预期的（用户可能只装了插件本体），失败必须折叠成一句可行动的提示
//    （`missing-dependency`），不能让异常冒到 RPC 层被连接层吞掉。
// 3. **每次尝试都是一个可终结的会话**：一个 `AbortController` + 一个 SDK 的
//    dispose 句柄 + 一个「等第一张码」的定时器。`cancel()` / `dispose()` / 写配置
//    失败都必须把它们清干净，否则每点一次按钮就留下一个还在向腾讯轮询的循环。
//
// ── SDK 事实（v1.2.0，按类型声明与实现逐条核对）─────────────────────────
//
// * `startQrConnect(callbacks, options)` 的返回值是**那个 dispose 函数本身**，
//   不是 `{ dispose() }` 对象——所以下面的适配器要自己包一层。出处：
//   `node_modules/.pnpm/@tencent-connect+qqbot-connector@1.2.0/node_modules/@tencent-connect/qqbot-connector/dist/esm/qr-connect.d.ts:65`
//   `export declare function startQrConnect(callbacks: QrConnectCallbacks, options?: QrConnectOptions): () => void;`
// * 回调与选项的声明在同文件 `:15-24`（`onQrDisplayed` / `onQrExpired` 是**可选**
//   回调，`onSuccess` 收 `QrConnectCredentials[]`，`onFailure` 收 `Error`）与
//   `:25-38`（`displayQrCodeToConsole` / `signal` / `source`）。
// * `dist/esm/index.d.ts:1` 只有一次 re-export，没有默认导出。
// * 实现 `dist/esm/qr-connect.js` 里还有三件直接影响本模块的事：
//   - 内部轮询间隔是 2000ms（`const p=2e3`），所以宿主只报 `pollIntervalMs`，
//     绝不自己轮询；
//   - **过期不是终点**：拿到 EXPIRED 会先 `onQrExpired()` 再 `onQrDisplayed()`
//     换发一张新码，所以 `expired` 之后必须还能回到 `waiting`；
//   - `options.signal` 一旦 abort，SDK 会回调 `onFailure(new Error('已取消'))`
//     ——这就是「终态之后迟到的回调一律丢弃」这条防线的由来（`settled`）。

import { randomUUID } from 'node:crypto'

import type { ProvisionSnapshot, RpcResult } from './protocol.js'
// `ok` / `fail` 住在 `rpc.ts`（协议文件 `protocol.ts` 只放类型与常量，见
// `rpc.ts:39` 与 `rpc.ts:44`）。这里 import 它**不成环**：`rpc.ts` 只依赖
// `protocol.ts` / `types.ts` / `config.ts`，`index.ts` 才是同时引用两者的那层。
import { fail, ok } from './rpc.js'
import type { ChannelConfig, ChannelLogger } from './types.js'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 二维码在设置页上的有效期（毫秒）。
 *
 * 只用于设置页的倒计时：真实过期由腾讯决定，SDK 会回调 `onQrExpired()` 并换发
 * 新码，所以这个值偏大偏小都不会让流程卡住。
 */
export const QR_TTL_MS = 5 * 60 * 1000

/** 等第一张二维码的上限（毫秒）。SDK 网络不通时不至于让设置页一直转圈。 */
export const DEFAULT_QR_TIMEOUT_MS = 15_000

/** `poll` 建议间隔。SDK 自己按 2000ms 轮询厂商，这里只告诉设置页多久问一次宿主。 */
export const POLL_INTERVAL_MS = 1000

/** 拼进二维码 URL 的调用来源标识（SDK 的 `options.source`）。 */
export const QR_SOURCE = 'deepseek-harness'

/** 装不上/装坏时要提示的那个包名。 */
const CONNECTOR_PACKAGE = '@tencent-connect/qqbot-connector'

/**
 * 飞书为什么不走这条路。
 *
 * 飞书自建机器人**不需要**扫码创建应用：AppID/AppSecret 在开放平台后台自己建，
 * 拿到之后要么推导 AppLink、要么直接给机器人发一条消息把 receive_id 回填回来
 * （见 `rpc.ts` 的 `feishuBotApplink()` 与 `bind` 流程）。这里明确拒绝是为了让
 * 设置页能把三个 provision 端点当成「QQ 专用」无条件调用，不必自己判断通道类型。
 */
const FEISHU_UNSUPPORTED =
  '飞书不需要扫码创建应用：按「填 AppID/AppSecret → 打开机器人 AppLink → 发一条消息回填目标」的流程接入即可'

/** 依赖缺失时的可行动提示（让用户知道在哪、敲什么）。 */
const MISSING_CONNECTOR_HINT =
  `扫码创建 QQ 机器人需要 ${CONNECTOR_PACKAGE}，请在插件目录执行 pnpm add ${CONNECTOR_PACKAGE}`

/** 未知错误的兜底文案。绝不把 `[object Object]` 甩给用户。 */
const UNKNOWN_ERROR_HINT = '扫码创建 QQ 机器人失败（腾讯返回了未知错误），请稍后重试'

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

/** 一次成功扫码拿到的凭据。 */
export interface ProvisionCredentials {
  appId: string
  appSecret: string
  /** QQ 扫码会连 userOpenid 一起给，可以直接当默认投递目标。 */
  targetId?: string
}

/** SDK 回调 → 本模块的适配面（测试注入假实现用）。 */
export interface QqQrCallbacks {
  onQrDisplayed(url: string): void
  onQrExpired(): void
  onSuccess(credentials: readonly { appId?: string; appSecret?: string; userOpenid?: string }[]): void
  onFailure(error: unknown): void
}

export interface QqQrSession {
  dispose(): void
}

export type QqAdapter = (
  callbacks: QqQrCallbacks,
  options: { displayQrCodeToConsole: boolean; source: string; signal: AbortSignal },
) => QqQrSession

export interface ProvisionOptions {
  log: ChannelLogger
  /** 拿到凭据后回调（由调用方写配置并重启通道）。抛错即视为接入失败。 */
  onCredentials: (channelId: string, credentials: ProvisionCredentials) => Promise<void>
  /** 测试注入；缺省用真的 `@tencent-connect/qqbot-connector`。 */
  qq?: QqAdapter
  /**
   * 等第一张二维码的上限（毫秒），缺省 {@link DEFAULT_QR_TIMEOUT_MS}。
   *
   * 单独开这个口子是为了测试：配合假时钟把 15 秒调成几十毫秒，测试不必真的等
   * ——也免得有人为了「测试快一点」去动生产默认值。
   */
  qrTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// 内部结构
// ---------------------------------------------------------------------------

/** `begin` 被唤醒的原因，决定它返回 `ok` 还是哪一种 `fail`。 */
type WakeReason = 'qr' | 'timeout' | 'failed'

interface Attempt {
  snapshot: ProvisionSnapshot
  readonly controller: AbortController
  session?: QqQrSession
  /** 终态标记：`done` / `failed` / `cancelled` 之后 SDK 的迟到回调一律丢弃。 */
  settled: boolean
  /** 「等第一张码」的定时器；码到手就清掉。 */
  timer?: ReturnType<typeof setTimeout>
  /** 唤醒 `begin` 的等待者；重复调用无副作用。 */
  wake?: (reason: WakeReason) => void
  /** 第一次唤醒的原因（只有第一次有意义）。 */
  firstWake?: WakeReason
}

/**
 * 日志面。
 *
 * `ChannelLogger`（`types.ts:220-226`）只有 `info/warn/error`，**没有 `debug`**；
 * 而真实的实现 `FileLogger`（`log.ts:71`）有。所以这里按「可选 debug」持有它：
 * 真实现能出 debug 行，`NULL_LOGGER` 之类的精简实现也不会炸。
 */
type ProvisionLogger = ChannelLogger & { debug?: (message: string) => void }

// ---------------------------------------------------------------------------
// ProvisionManager
// ---------------------------------------------------------------------------

export class ProvisionManager {
  readonly #options: ProvisionOptions
  readonly #log: ProvisionLogger
  readonly #attempts = new Map<string, Attempt>()
  readonly #qrTimeoutMs: number

  constructor(options: ProvisionOptions) {
    this.#options = options
    this.#log = options.log
    const timeout = options.qrTimeoutMs
    this.#qrTimeoutMs =
      typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
        ? timeout
        : DEFAULT_QR_TIMEOUT_MS
  }

  /**
   * 发起一次扫码，**等到第一张码就绪才返回**。
   *
   * 唤醒前就一直挂着（最多 {@link DEFAULT_QR_TIMEOUT_MS}）：
   * * 码到手 → `ok(snapshot)`，`state === 'waiting'`；
   * * 超时 → `fail('qr-timeout', …)`；
   * * SDK 先报错 / 同步抛 → `fail('qr-failed', …)`（错误文本来自 SDK）。
   *
   * 后两种情况下记录会从表里丢掉：失败结果里没有 `attemptId` 这个字段，设置页
   * 拿不到 id 也就问不到它，留着只会变成一条没人能引用的死记录。
   */
  async begin(channel: ChannelConfig): Promise<RpcResult<ProvisionSnapshot>> {
    if (channel.type === 'feishu') return fail('unsupported', FEISHU_UNSUPPORTED)

    // 同一通道上还挂着的旧 attempt 先作废：设置页只认识最后一次 `begin` 返回的
    // attemptId，留着旧的只会多一个没人再看、却还在向腾讯轮询的会话。
    this.#supersedeChannel(channel.id)

    const injected = this.#options.qq
    let adapter: QqAdapter
    if (injected) {
      adapter = injected
    } else {
      try {
        adapter = await loadQqAdapter()
      } catch (error) {
        this.#log.error(`扫码创建 QQ 机器人不可用（通道 ${channel.id}）：连接器加载失败`, error)
        return fail('missing-dependency', MISSING_CONNECTOR_HINT)
      }
    }

    const attemptId = randomUUID()
    let resolveFirstWake: () => void = () => {}
    const firstWake = new Promise<void>((resolve) => {
      resolveFirstWake = resolve
    })

    const attempt: Attempt = {
      snapshot: {
        attemptId,
        channelId: channel.id,
        type: 'qq',
        state: 'starting',
        pollIntervalMs: POLL_INTERVAL_MS,
      },
      controller: new AbortController(),
      settled: false,
    }
    attempt.wake = (reason) => {
      attempt.firstWake ??= reason
      resolveFirstWake()
    }
    this.#attempts.set(attemptId, attempt)
    this.#log.info(`扫码创建 QQ 机器人：开始（通道 ${channel.id}，attempt ${attemptId}）`)

    // 只管「第一张码还没来」这一段时间；码到手后过期与换码都由 SDK 自己管。
    attempt.timer = setTimeout(() => {
      if (attempt.settled) return
      this.#settleAttempt(attempt, { state: 'failed', error: '腾讯那边没有返回二维码，请稍后重试' })
      this.#cleanupAttempt(attempt)
      this.#log.warn(
        `扫码创建 QQ 机器人：等二维码超时（通道 ${channel.id}，${this.#qrTimeoutMs}ms）`,
      )
      attempt.wake?.('timeout')
    }, this.#qrTimeoutMs)

    const callbacks: QqQrCallbacks = {
      onQrDisplayed: (url) => {
        if (attempt.settled) return
        // 过期换码时 SDK 会再调一次，所以这里**不能**标记 settled，只是把状态推回
        // waiting。二维码 URL 本身**不进日志**：它带着一次性的绑定任务 id。
        const refreshed = attempt.snapshot.state === 'expired'
        this.#clearTimer(attempt)
        attempt.snapshot.state = 'waiting'
        attempt.snapshot.qrText = url
        attempt.snapshot.expiresAt = Date.now() + QR_TTL_MS
        attempt.wake?.('qr')
        this.#log.info(
          refreshed
            ? `扫码创建 QQ 机器人：腾讯换发了新二维码（通道 ${channel.id}）`
            : `扫码创建 QQ 机器人：二维码已就绪（通道 ${channel.id}）`,
        )
      },

      onQrExpired: () => {
        if (attempt.settled) return
        attempt.snapshot.state = 'expired'
        this.#log.info(`扫码创建 QQ 机器人：二维码已过期，等待腾讯换发新码（通道 ${channel.id}）`)
      },

      onSuccess: (credentials) => {
        if (attempt.settled) return
        const first = credentials[0]
        const appId = typeof first?.appId === 'string' ? first.appId.trim() : ''
        const appSecret = typeof first?.appSecret === 'string' ? first.appSecret : ''
        const userOpenid = typeof first?.userOpenid === 'string' ? first.userOpenid.trim() : ''
        if (!appId || appSecret.trim().length === 0 || !userOpenid) {
          const message = 'QQ 授权返回的凭据不完整（缺少 appId / appSecret / userOpenid），请重新扫码'
          this.#settleAttempt(attempt, { state: 'failed', error: message })
          this.#cleanupAttempt(attempt)
          this.#log.warn(`扫码创建 QQ 机器人：${message}（通道 ${channel.id}）`)
          attempt.wake?.('failed')
          return
        }
        attempt.snapshot.state = 'connecting'
        // 只打 appId 与 openid，**appSecret 一个字符都不进日志**。
        this.#log.info(
          `扫码创建 QQ 机器人：已拿到凭据（通道 ${channel.id}，appId=${appId}，userOpenid=${userOpenid}），正在写入配置`,
        )
        void this.#applyCredentials(attempt, channel.id, { appId, appSecret, targetId: userOpenid })
      },

      onFailure: (error) => {
        if (attempt.settled) return
        const message = safeErrorText(error)
        this.#settleAttempt(attempt, { state: 'failed', error: message })
        this.#cleanupAttempt(attempt)
        this.#log.warn(`扫码创建 QQ 机器人：接入失败（通道 ${channel.id}）：${message}`)
        attempt.wake?.('failed')
      },
    }

    try {
      attempt.session = adapter(callbacks, {
        // 一定关掉：宿主的终端不是用户看二维码的地方，URL 由设置页画。
        displayQrCodeToConsole: false,
        source: QR_SOURCE,
        signal: attempt.controller.signal,
      })
    } catch (error) {
      const message = safeErrorText(error)
      this.#settleAttempt(attempt, { state: 'failed', error: message })
      this.#cleanupAttempt(attempt)
      this.#log.warn(`扫码创建 QQ 机器人：SDK 启动失败（通道 ${channel.id}）：${message}`)
      attempt.wake?.('failed')
    }

    await firstWake

    const snapshot: ProvisionSnapshot = { ...attempt.snapshot }
    if (attempt.firstWake === 'qr') return ok(snapshot)
    // 失败结果里不带 attemptId，设置页无从引用这次尝试，记录直接丢掉。
    this.#attempts.delete(attemptId)
    if (attempt.firstWake === 'timeout') {
      return fail('qr-timeout', '腾讯那边没有返回二维码，请稍后重试')
    }
    return fail('qr-failed', snapshot.error ?? UNKNOWN_ERROR_HINT)
  }

  /**
   * 查询进度。
   *
   * 只有「这次尝试不存在」才失败；`state === 'failed'` 的尝试仍然返回 `ok`，
   * 让设置页照着 `error` 渲染——RPC 成功与业务失败是两回事。
   */
  poll(channel: ChannelConfig, attemptId: string): RpcResult<ProvisionSnapshot> {
    if (channel.type === 'feishu') return fail('unsupported', FEISHU_UNSUPPORTED)
    const attempt = this.#find(channel, attemptId)
    if (!attempt) return fail('no-attempt', noAttemptMessage(attemptId))
    this.#log.debug?.(
      `扫码创建 QQ 机器人：poll（通道 ${channel.id}，attempt ${attemptId}，state=${attempt.snapshot.state}）`,
    )
    return ok({ ...attempt.snapshot })
  }

  /** 用户取消：dispose SDK、状态置 `cancelled`。已经落定的尝试原样返回（幂等）。 */
  cancel(channel: ChannelConfig, attemptId: string): RpcResult<ProvisionSnapshot> {
    if (channel.type === 'feishu') return fail('unsupported', FEISHU_UNSUPPORTED)
    const attempt = this.#find(channel, attemptId)
    if (!attempt) return fail('no-attempt', noAttemptMessage(attemptId))
    if (!attempt.settled) {
      this.#settleAttempt(attempt, { state: 'cancelled' })
      this.#cleanupAttempt(attempt)
      this.#log.info(`扫码创建 QQ 机器人：用户已取消（通道 ${channel.id}）`)
    }
    return ok({ ...attempt.snapshot })
  }

  /**
   * 插件卸载：dispose 所有 attempt。
   *
   * 记录一并丢掉——插件都卸了，再 `poll` 只能报 `no-attempt`（不会抛），设置页
   * 看到的就是「请重新发起扫码」。重复调用无副作用。
   */
  dispose(): void {
    const attempts = [...this.#attempts.values()]
    this.#attempts.clear()
    for (const attempt of attempts) {
      // 先标记终态：清完之后 SDK 的迟到回调不能再改状态，更不能再去写配置。
      attempt.settled = true
      this.#cleanupAttempt(attempt)
    }
    if (attempts.length > 0) {
      this.#log.debug?.(`扫码创建 QQ 机器人：dispose 掉 ${attempts.length} 个会话`)
    }
  }

  // -- 内部 ------------------------------------------------------------------

  /** 找 attempt；通道对不上也算找不到（见 {@link noAttemptMessage}）。 */
  #find(channel: ChannelConfig, attemptId: string): Attempt | undefined {
    const attempt = this.#attempts.get(attemptId)
    if (!attempt) return undefined
    // 跨通道一律当「找不到」：宁可让设置页重新发起，也不要把 A 通道的扫码结果
    // 交给 B 通道去写配置。
    if (attempt.snapshot.channelId !== channel.id) return undefined
    return attempt
  }

  /** 把同一通道上还没落定的尝试全部作废（被新的 `begin` 取代）。 */
  #supersedeChannel(channelId: string): void {
    for (const attempt of this.#attempts.values()) {
      if (attempt.snapshot.channelId !== channelId || attempt.settled) continue
      this.#settleAttempt(attempt, { state: 'cancelled' })
      this.#cleanupAttempt(attempt)
      this.#log.info(`扫码创建 QQ 机器人：上一次扫码被新的请求取代（通道 ${channelId}）`)
    }
  }

  /** 写进度并标记终态。之后 `#cleanupAttempt()` 才安全。 */
  #settleAttempt(attempt: Attempt, patch: Partial<ProvisionSnapshot>): void {
    Object.assign(attempt.snapshot, patch)
    attempt.settled = true
    this.#clearTimer(attempt)
  }

  /**
   * 收掉宿主侧资源：先中断 AbortSignal（兜底——万一适配器没理 dispose 也会看到
   * signal 变成 aborted），再 dispose SDK 会话。幂等，且自己吞掉 dispose 的异常：
   * 清理失败不能连累已经落定的状态。
   */
  #cleanupAttempt(attempt: Attempt): void {
    this.#clearTimer(attempt)
    if (!attempt.controller.signal.aborted) attempt.controller.abort()
    const session = attempt.session
    attempt.session = undefined
    if (!session) return
    try {
      session.dispose()
    } catch (error) {
      this.#log.warn(
        `扫码创建 QQ 机器人：dispose 会话时出错（通道 ${attempt.snapshot.channelId}）`,
        error,
      )
    }
  }

  #clearTimer(attempt: Attempt): void {
    if (attempt.timer === undefined) return
    clearTimeout(attempt.timer)
    attempt.timer = undefined
  }

  /** 把凭据交给宿主回调；成功与失败都要落定在快照上。 */
  async #applyCredentials(
    attempt: Attempt,
    channelId: string,
    credentials: ProvisionCredentials,
  ): Promise<void> {
    try {
      await this.#options.onCredentials(channelId, credentials)
      this.#settleAttempt(attempt, {
        state: 'done',
        filledField: 'appId',
        filledTargetId: credentials.targetId,
      })
      this.#log.info(`扫码创建 QQ 机器人：接入成功（通道 ${channelId}，appId=${credentials.appId}）`)
    } catch (error) {
      const message = scrubSecret(safeErrorText(error), credentials.appSecret)
      this.#settleAttempt(attempt, { state: 'failed', error: message })
      this.#log.warn(`扫码创建 QQ 机器人：写入凭据失败（通道 ${channelId}）：${message}`)
    } finally {
      this.#cleanupAttempt(attempt)
    }
  }
}

// ---------------------------------------------------------------------------
// 真适配器
// ---------------------------------------------------------------------------

/**
 * 动态 import `@tencent-connect/qqbot-connector` 并包成本模块的 {@link QqAdapter}。
 *
 * 签名核对见文件头；要点是 SDK 返回 dispose 函数本身，且它自己的
 * `onQrDisplayed` / `onQrExpired` 都是可选回调——我们一律补齐，否则
 * `displayQrCodeToConsole: false` 时连 URL 都拿不到。
 */
async function loadQqAdapter(): Promise<QqAdapter> {
  const mod = await import('@tencent-connect/qqbot-connector')
  if (typeof mod.startQrConnect !== 'function') {
    throw new TypeError(`${CONNECTOR_PACKAGE} 没有导出 startQrConnect（版本可能不对）`)
  }
  return (callbacks, options) => {
    const stop = mod.startQrConnect(
      {
        onSuccess: (credentials) => callbacks.onSuccess(credentials),
        onFailure: (error) => callbacks.onFailure(error),
        onQrDisplayed: (url) => callbacks.onQrDisplayed(url),
        onQrExpired: () => callbacks.onQrExpired(),
      },
      {
        displayQrCodeToConsole: options.displayQrCodeToConsole,
        signal: options.signal,
        source: options.source,
      },
    )
    return { dispose: () => stop() }
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 未知错误的兜底文案；已知错误取它 trim 过的 message。 */
function safeErrorText(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim()
    return message.length > 0 ? message : UNKNOWN_ERROR_HINT
  }
  if (typeof error === 'string' && error.trim().length > 0) return error.trim()
  return UNKNOWN_ERROR_HINT
}

/**
 * 兜底脱敏：错误文本里若带了本次拿到的 appSecret（例如宿主的 `onCredentials`
 * 自己把它拼进了报错），进日志与快照之前先抹掉。
 *
 * 这里**故意不 import `rpc.ts` 的 `redactText()`**：本模块会被 `index.ts` /
 * `rpc.ts` 反过来引用，互相 import 会成环。按已知明文精确替换就够用，也不需要
 * 处理正则转义。
 */
function scrubSecret(text: string, secret: string | undefined): string {
  if (!secret) return text
  return text.split(secret).join('[redacted]')
}

function noAttemptMessage(attemptId: string): string {
  return `找不到这次扫码创建的记录（${attemptId}），它可能已完成、已取消或插件已重载，请重新发起扫码`
}
