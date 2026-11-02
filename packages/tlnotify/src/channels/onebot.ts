// packages/tlnotify/src/channels/onebot.ts
//
// OneBot v11 通道（俗称「夺舍 QQ」），对接 NapCat / Lagrange。
//
// ── 协议假设 ────────────────────────────────────────────────────────────────
//
// 1. 事件是 OneBot v11 的 JSON：`post_type: 'message'`，`message_type` 为
//    `'private' | 'group'`，正文在 `message`（消息段数组）里，`raw_message` 是
//    CQ 码兜底。消息段只对 `text` 取字；`at` 段用来判断「这条是不是在叫我们」。
// 2. `/send_private_msg`、`/send_group_msg`、`/set_input_status` 都按 v11 的
//    「动作名 + 参数对象」形态调用，响应是 `{ status, retcode, data, wording }`。
//    `retcode === 0` 或 `status === 'ok' | 'async'` 才算成功。
// 3. **NapCat 是 QQ 的另一种登录方式，不是另一个账号体系**：这条通道发出去的消息
//    会真的落在你手机上的 QQ 对话里，机器人自己也在同一个账号里，所以「自己发的话
//    又作为事件回来」是常态而不是异常。下面两条纪律全部是为了这件事。
// 4. 三种连接方式，优先级从高到低：
//    - 反向 WebSocket（首选）：NapCat 主动连过来，不需要公网 IP、不用轮询。
//      路径与 upgrade 由宿主 `webServer.registerUpgrade` 提供，本模块**不碰 ctx**，
//      只接受注入进来的 `registerUpgrade`。
//    - 正向 WebSocket（备选）：给了 `wsUrl` 就用全局 `WebSocket` 连过去。
//    - HTTP API（最后兜底）：只有 `httpUrl` 时能发不能收，`connected` 恒为 false，
//      入站直接不可用——这是「宁可能发不能收，也别整台机器人静默失效」的取舍。
//
// ── 回声锁（Self-Echo Guard）为什么必须有 ───────────────────────────────────
//
// 我们的入站会把文本交给宿主当「用户在 IM 里说话」，宿主可能顺手把结果再推回来；
// 而 NapCat 又会把自己账号收发的消息原样作为事件吐出来。两件事叠在一起就是：
// 通知 → 入站 → 生成回复 → 再通知 → 再入站 …… 一个永不停止的自问自答，几秒钟就能
// 把对话刷成几百条。所以这里维护一个容量 200 的 LRU，记住本通道发出的
// `message_id` 与正文摘要；凡是 `user_id === selfId` 的消息，**只有控制台指令**
// （`/rp` `/work` `/auto` `/char` `/scene` `/tlrp` `/status`）才放行，其余一律
// debug 丢弃。指令放行是有意为之：那样我们就能在 QQ 里直接用手机切模式，而不是
// 只能坐在电脑前点设置页。
//
// ── 白名单为什么必须有 ─────────────────────────────────────────────────────
//
// QQ 号是**可以被猜到的公开标识**，而这条通道能让任何给它发消息的人驱动本地
// DSH 会话（包括授权工具调用）。所以默认只认「私聊白名单」（`'*'` 或号码数组），
// **群默认一个都不收**：群成员不可控，一个误拉进来的群就等于把控制台公开了。
// 群必须显式把群号写进 `allowedGroups` 才会被监听。
//
// ── 降级策略（每一层都留日志，不静默失败）─────────────────────────────────
//
// - 宿主没给 `registerUpgrade` → 记一条 info，改用 `wsUrl` 或 HTTP。
// - 运行环境没有全局 `WebSocket`（Node < 21 / 未注入实现）→ warn，降级为 HTTP。
// - 原生 Markdown 发送失败（NapCat 未开 `markdown` 扩展、版本太老）→ warn 带上
//   `retcode` / `wording`，回退纯文本；再失败回退合并转发。
// - `set_input_status` 失败 → 只是少了「正在输入」的观感，debug 记一笔即可。
// - 任何网络 / 解析异常都只写 `log.warn`，**绝不 throw 出通道管理器**。

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { createHash, timingSafeEqual } from 'node:crypto'

import type {
  Channel,
  ChannelConfig,
  ChannelLogger,
  ChannelStartContext,
  InboundReply,
  Notification,
} from '../types.js'

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 反向 WS 默认挂载路径（`wsPath` 可覆盖）。 */
const DEFAULT_REVERSE_PATH = '/tlnotify/onebot/ws'
/** 单条纯文本消息的字符上限。NapCat 默认放行到 4500 左右，留点余量给分段。 */
const DEFAULT_MAX_CHARS = 4000
/** 等待 HTTP API / WS RPC 响应的上限。 */
const DEFAULT_TIMEOUT_MS = 10_000
/** 回声锁容量。够覆盖「我们刚发出去的几十条」，又不会无限涨。 */
const DEFAULT_ECHO_CAPACITY = 200
/** 群里默认的指令前缀。与 `config.ts` 里 `groupPrefix` 的默认值保持一致（角色名）。 */
const DEFAULT_GROUP_PREFIX = '流萤'
/** 重连退避：1s 起，翻倍，封顶 30s。 */
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** 单帧上限；超过按 1009（消息过大）断开，防止一条报文把内存吃光。 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024
/** WebSocket 心跳间隔。 */
const HEARTBEAT_MS = 30_000
/** 合并转发里单个节点的字符上限（NapCat 对节点正文也有限制）。 */
const FORWARD_NODE_CHARS = 1_200
/** 合并转发最多几个节点，超过就截断（再多也没人看）。 */
const FORWARD_MAX_NODES = 5
/** WebSocket 握手用的固定 GUID（RFC 6455 §1.3）。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * 控制台指令：只有这些能从「自己的账号」发出来还继续向上转发。
 *
 * 与 mode.ts 认的模式命令保持同一套前缀，多一个 `/status`——那是最常用来
 * 在手机上探活的一条，漏掉它就会表现为「发了 /status 没反应」。
 */
const CONTROL_COMMAND_RE = /^\/(rp|work|auto|char|scene|tlrp|status)\b/

// ── 与宿主 / 网络解耦的结构化类型 ───────────────────────────────────────────

/** 只用到这几个成员，避免为了一层 fetch 把 DOM / undici 类型引进编译单元。 */
export interface HttpResponseLike {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal?: AbortSignal
  },
) => Promise<HttpResponseLike>

/**
 * 宿主 `webServer.registerUpgrade(route)` 的结构化视图。
 *
 * 字段与宿主 `WebUpgradeRoute` 逐字一致（`path` + `handler(req, socket, head)`），
 * 所以接线方可以原样转交：`(route) => ctx.webServer.registerUpgrade(route)`。
 */
export interface OneBotUpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

export type OneBotRegisterUpgrade = (route: OneBotUpgradeRoute) => () => void

/** 全局 `WebSocket` 的最小视图（@types/node 20 不带这个全局类型，所以自己声明）。 */
interface WebSocketLike {
  readyState?: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener?(type: string, listener: (event: unknown) => void): void
  on?(type: string, listener: (...args: unknown[]) => void): void
}

type WebSocketCtor = new (url: string, protocols?: unknown) => WebSocketLike

// ── 配置（局部收窄，不改 types.ts）─────────────────────────────────────────

/**
 * OneBot 的额外配置项。
 *
 * 全部可选、全部有默认值：主控以后往 `ChannelConfig` 里加同名字段时，这里的
 * `extends` 会自动跟着变宽，本文件不需要改。
 *
 * 复用已有的两个字段（设置页已经能编辑它们，不必再发明一套）：
 * - `targetChatId` → 单聊目标 QQ 号；
 * - `groupChatId`  → 群号（填了就发群）。
 */
export interface OneBotChannelConfig extends ChannelConfig {
  // 下面这组与 `types.ts` 里的同名字段**类型逐字相同**。重复声明是有意的：
  // 这样无论主控有没有把字段落进 `ChannelConfig`，本文件都能编译；等它们正式
  // 落地后这里就退化成一份自洽的文档（TS 允许同类型重复声明）。
  /** OneBot HTTP API 根地址，如 `http://127.0.0.1:3000`。 */
  httpUrl?: string
  /** 正向 WS 地址，如 `ws://127.0.0.1:3001`。给了它且宿主没给 registerUpgrade 才用。 */
  wsUrl?: string
  /** Bearer token；反向 WS 校验它，正向 WS / HTTP 带上它。 */
  accessToken?: string
  /** 机器人自己的 QQ 号。不给就从事件的 `self_id` 里学（第一个事件之后就知道了）。 */
  selfId?: string
  /** 反向 WS 路径，默认 `/tlnotify/onebot/ws`。 */
  wsPath?: string
  /** 是否开启夺舍；本模块不判断它（由通道管理器决定是否实例化），声明只为配置自洽。 */
  takeoverEnabled?: boolean
  /** 私聊白名单；数组里含 `'*'` 表示任何人，留空表示谁都不放行。 */
  allowedPrivateUsers?: string[]
  /** 群白名单；留空 = **一个群都不收**（见文件头的动机）。 */
  allowedGroups?: string[]
  /** 群触发方式，默认 `at_or_prefix`。 */
  groupTriggerMode?: 'at_or_prefix' | 'prefix_only' | 'all'
  /** 群触发前缀，默认角色名（与 config.ts 的默认值一致）。 */
  groupPrefix?: string
  /** 出站 Markdown 策略（对话回复用；本模块只提供发送原语）。 */
  mdRenderMode?: 'native_md' | 'auto_fallback' | 'plain'
  /** 对话固定使用的会话 id；本模块不消费，声明只为配置自洽。 */
  chatSessionId?: string

  // 下面是本模块自己的旋钮，`types.ts` 里没有（也不需要有）。
  /** 回声锁容量，默认 200。 */
  echoCapacity?: number
  /** 单条消息字符上限，默认 4000。 */
  maxChars?: number
  /** 强制连接方式；默认 `auto`（反向优先，其次正向，最后 HTTP）。 */
  connection?: 'auto' | 'reverse' | 'forward'
  /** 单聊目标 QQ 号（优先于 `targetChatId`）。 */
  targetUserId?: string
  /** 群号（优先于 `groupChatId`）。 */
  targetGroupId?: string
}

export interface OneBotChannelOptions {
  log: ChannelLogger
  /** 宿主注入的反向 WS 挂载器；不传就只走正向 / HTTP。 */
  registerUpgrade?: OneBotRegisterUpgrade
  /** 注入的 fetch 实现；缺省用 `globalThis.fetch`。 */
  fetch?: FetchLike
  /** 注入的 WebSocket 构造器；缺省用全局 `WebSocket`。 */
  webSocket?: WebSocketCtor
}

/** `getStatus()` 的形状。 */
export interface OneBotStatus {
  connected: boolean
  mode: 'reverse' | 'forward' | 'http' | 'none'
  url?: string
  selfId?: string
  inbound: number
  outbound: number
  lastError?: string
}

/** 发送目标。 */
export type OneBotTarget =
  | { kind: 'private'; userId: string }
  | { kind: 'group'; groupId: string }

/** 原生 Markdown 的三级渲染策略。 */
export type OneBotSendMode = 'native_md' | 'auto_fallback' | 'plain'

export interface OneBotSendResult {
  ok: boolean
  /** 实际成功（或最后尝试失败）的那一级。 */
  via: 'native_md' | 'text' | 'forward'
  error?: string
  /** 平台消息 id；合并转发可能没有。 */
  messageId?: string
}

export interface OneBotSendDeps {
  /** 发送用的 HTTP / WS 客户端。 */
  api: OneBotApi
  log: ChannelLogger
  /** `auto_fallback` 降级用的纯文本；缺省用 mdText 原样。 */
  fallbackText?: string
  /** 合并转发节点的显示名。 */
  forwardName?: string
  /** 合并转发节点要用的机器人 QQ 号。 */
  selfId?: string
  /** 发送成功后回填回声锁。 */
  remember?: (messageId: string, text: string) => void
}

/** 入站回执；在 `InboundReply` 上补两个 OneBot 专属字段（结构子类型，不改 types.ts）。 */
export interface OneBotInboundReply extends InboundReply {
  /** 是否由我们自己（selfId）发出——控制台指令走这条。 */
  fromSelf?: boolean
  /** 群号；私聊时没有。 */
  groupId?: string
}

// ── 错误 ────────────────────────────────────────────────────────────────────

/** OneBot 侧返回了 `status !== 'ok'`；带上 retcode / wording 供降级日志引用。 */
export class OneBotApiError extends Error {
  readonly retcode: number
  readonly wording: string | undefined

  constructor(message: string, retcode: number, wording?: string) {
    super(message)
    this.name = 'OneBotApiError'
    this.retcode = retcode
    this.wording = wording
  }
}

interface OneBotCallResult {
  status: string
  retcode: number
  data?: unknown
  wording?: string
  message?: string
}

// ── HTTP / WS 统一的动作调用器 ──────────────────────────────────────────────

export interface OneBotApiOptions {
  httpUrl?: string
  accessToken?: string
  fetch?: FetchLike
  timeoutMs?: number
  log?: ChannelLogger
}

/**
 * 动作调用器：有 `httpUrl` 走 HTTP，否则走当前 WebSocket 连接（反向 / 正向都行）。
 *
 * 为什么两条路都要：NapCat 常常只开「反向 WS」不开 HTTP。那种部署下如果只实现
 * HTTP，通道就变成「能收不能发」——用户会看到事件进来了、回复却永远送不出去。
 * 反向 WS 里我们同样可以主动下发 `{ action, params, echo }`，NapCat 会用同一个
 * socket 回 `{ status, retcode, data, echo }`，所以这里加一条 RPC 通道。
 */
export class OneBotApi {
  readonly #httpUrl: string | undefined
  readonly #accessToken: string | undefined
  readonly #fetch: FetchLike | undefined
  readonly #timeoutMs: number
  readonly #log: ChannelLogger | undefined
  #socketCall: ((action: string, params: Record<string, unknown>) => Promise<OneBotCallResult>) | undefined
  /** 某些实现只暴露通用端点 `POST / {action, params}`；404 之后切过去记住。 */
  #genericEndpoint = false
  #warnedNoFetch = false

  constructor(options: OneBotApiOptions) {
    const httpUrl = options.httpUrl?.trim()
    this.#httpUrl = httpUrl ? httpUrl.replace(/\/+$/, '') : undefined
    this.#accessToken = options.accessToken?.trim() || undefined
    this.#fetch = options.fetch
    this.#timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
    this.#log = options.log
  }

  /** 有没有任何可用的发送通道。 */
  get configured(): boolean {
    return Boolean(this.#httpUrl) || Boolean(this.#socketCall)
  }

  /** 当前是否走 HTTP（诊断用）。 */
  get usesHttp(): boolean {
    return Boolean(this.#httpUrl)
  }

  get httpUrl(): string | undefined {
    return this.#httpUrl
  }

  /** 绑定 / 解绑 WebSocket RPC 通道（连接建立与断开时调用）。 */
  setSocketCall(call: ((action: string, params: Record<string, unknown>) => Promise<OneBotCallResult>) | undefined): void {
    this.#socketCall = call
  }

  /**
   * 调用一个 OneBot 动作。
   *
   * 失败**会**抛（`OneBotApiError` 或普通 Error）：调用方（`send()` / `sendMarkdown()`）
   * 需要知道失败才能降级，通道管理器也靠它记失败计数。抛在这里不会穿到管理器外——
   * 管理器对每个通道都包了 try/catch。
   */
  async call(action: string, params: Record<string, unknown>): Promise<OneBotCallResult> {
    if (this.#httpUrl) return this.#httpCall(action, params)
    const socketCall = this.#socketCall
    if (socketCall) return socketCall(action, params)
    throw new Error('OneBot 没有可用的发送通道（既没有 httpUrl，也没有已建立的 WebSocket 连接）')
  }

  async #httpCall(action: string, params: Record<string, unknown>): Promise<OneBotCallResult> {
    const base = this.#httpUrl ?? ''
    const firstUrl = this.#genericEndpoint ? base : `${base}/${action}`
    const firstBody = this.#genericEndpoint ? JSON.stringify({ action, params }) : JSON.stringify(params)

    let response: HttpResponseLike
    try {
      response = await this.#request(firstUrl, firstBody)
    } catch (error) {
      throw new Error(`调用 ${action} 失败（网络错误）：${messageOf(error)}`)
    }

    // 只实现了通用端点的服务端（少数分叉）对 `/send_private_msg` 会回 404。
    if (response.status === 404 && !this.#genericEndpoint) {
      this.#genericEndpoint = true
      this.#log?.warn(`OneBot HTTP 端点 /${action} 返回 404，改用通用端点 POST /（后续都走这条）`)
      try {
        response = await this.#request(base, JSON.stringify({ action, params }))
      } catch (error) {
        throw new Error(`调用 ${action} 失败（通用端点网络错误）：${messageOf(error)}`)
      }
    }

    const text = await response.text().catch(() => '')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new OneBotApiError(
        `调用 ${action} 返回了非 JSON 响应（HTTP ${response.status}）：${clip(text, 200)}`,
        -1,
      )
    }

    const record = isRecord(parsed) ? parsed : {}
    const retcode = Number(record.retcode ?? 0)
    const status = str(record.status) || (retcode === 0 ? 'ok' : 'failed')
    const wording = str(record.wording) || str(record.msg) || undefined

    if (status !== 'ok' && status !== 'async') {
      throw new OneBotApiError(
        `调用 ${action} 失败：status=${status} retcode=${retcode} HTTP ${response.status}` +
          (wording ? `，wording=${wording}` : ''),
        retcode,
        wording,
      )
    }

    const result: OneBotCallResult = { status, retcode }
    if (record.data !== undefined) result.data = record.data
    if (wording) result.wording = wording
    const message = str(record.message) || str(record.msg)
    if (message) result.message = message
    return result
  }

  async #request(url: string, body: string): Promise<HttpResponseLike> {
    const fetchImpl = this.#resolveFetch()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    unrefTimer(timer)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.#accessToken) headers.authorization = `Bearer ${this.#accessToken}`
    try {
      return await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  #resolveFetch(): FetchLike {
    if (this.#fetch) return this.#fetch
    const impl = globalFetch()
    if (impl) return impl
    if (!this.#warnedNoFetch) {
      this.#warnedNoFetch = true
      this.#log?.warn('运行环境没有全局 fetch（Node < 18），OneBot HTTP 通道不可用')
    }
    throw new Error('运行环境没有全局 fetch')
  }
}

// ── 回声锁（LRU）────────────────────────────────────────────────────────────

/**
 * 记录「我们自己发出去的」消息，用来认出回环。
 *
 * 命中判定先看 `message_id`（最硬），再看正文摘要（OneBot 在部分实现里会把
 * 我们的消息以新的 id 回吐）。两者都只用于**自我消息**那一条分支，不会误伤
 * 别人发的同样文本。
 */
class EchoGuard {
  readonly #capacity: number
  /** messageId → 正文摘要。Map 的插入顺序就是 LRU 顺序。 */
  readonly #byId = new Map<string, string>()

  constructor(capacity: number) {
    this.#capacity = capacity > 0 ? capacity : DEFAULT_ECHO_CAPACITY
  }

  get size(): number {
    return this.#byId.size
  }

  remember(messageId: string, text: string): void {
    if (!messageId) return
    this.#byId.delete(messageId)
    this.#byId.set(messageId, digest(text))
    while (this.#byId.size > this.#capacity) {
      const oldest = this.#byId.keys().next()
      if (oldest.done) break
      this.#byId.delete(oldest.value)
    }
  }

  /** 是回声吗？返回命中方式，便于日志区分。 */
  classify(messageId: string, text: string): 'id' | 'text' | undefined {
    if (messageId && this.#byId.has(messageId)) {
      const summary = this.#byId.get(messageId) ?? ''
      this.#byId.delete(messageId)
      this.#byId.set(messageId, summary)
      return 'id'
    }
    const target = digest(text)
    if (!target) return undefined
    for (const summary of this.#byId.values()) {
      if (summary === target) return 'text'
    }
    return undefined
  }
}

// ── 反向连接：手写 RFC 6455 帧 ──────────────────────────────────────────────

type FrameParse =
  | { kind: 'incomplete' }
  | { kind: 'error'; code: number; reason: string }
  | { kind: 'frame'; consumed: number; fin: boolean; opcode: number; payload: Buffer }

/**
 * 从缓冲区里切一帧出来。
 *
 * 客户端 → 服务端的帧**必须**带掩码（RFC 6455 §5.1），没带就是协议错误；
 * 这里不宽容，因为宽容等于接受一个能被中间人随意构造的帧。
 */
function parseFrame(buffer: Buffer): FrameParse {
  if (buffer.length < 2) return { kind: 'incomplete' }
  const first = buffer[0] ?? 0
  const second = buffer[1] ?? 0
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2

  if (length === 126) {
    if (buffer.length < 4) return { kind: 'incomplete' }
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return { kind: 'incomplete' }
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(MAX_FRAME_BYTES)) return { kind: 'error', code: 1009, reason: 'frame too large' }
    length = Number(big)
    offset = 10
  }
  if (length > MAX_FRAME_BYTES) return { kind: 'error', code: 1009, reason: 'frame too large' }
  if (!masked) return { kind: 'error', code: 1002, reason: 'client frame must be masked' }

  if (buffer.length < offset + 4) return { kind: 'incomplete' }
  const mask = buffer.subarray(offset, offset + 4)
  offset += 4
  if (buffer.length < offset + length) return { kind: 'incomplete' }

  const payload = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i += 1) {
    payload[i] = (buffer[offset + i] ?? 0) ^ (mask[i % 4] ?? 0)
  }
  return { kind: 'frame', consumed: offset + length, fin, opcode, payload }
}

/**
 * 一条已升级（握手完成）的 socket 上的收发。
 *
 * 明确分工：**握手与路径匹配不在这里**——路径匹配由宿主 `registerUpgrade` 负责，
 * 101 应答由 `handleUpgrade` 写。本类只做「给我一个会说 WebSocket 帧的双工流」。
 */
class ReverseSocketLink {
  readonly #socket: Duplex
  readonly #label: string
  readonly #log: ChannelLogger
  readonly #onText: (text: string) => void
  readonly #onClose: () => void
  #buffer: Buffer
  #fragments: Buffer[] = []
  #fragmentOpcode = 0
  #closed = false
  #awaitingPong = false
  #heartbeat: ReturnType<typeof setInterval> | undefined

  constructor(options: {
    socket: Duplex
    initial: Buffer
    label: string
    log: ChannelLogger
    onText: (text: string) => void
    onClose: () => void
  }) {
    this.#socket = options.socket
    this.#buffer = options.initial
    this.#label = options.label
    this.#log = options.log
    this.#onText = options.onText
    this.#onClose = options.onClose
  }

  get closed(): boolean {
    return this.#closed
  }

  start(): void {
    // `setNoDelay` 在 `net.Socket` 上有、在任意 `Duplex` 的类型上没有；结构探测一下。
    const tunable = this.#socket as Duplex & { setNoDelay?: (noDelay?: boolean) => void }
    try {
      tunable.setNoDelay?.(true)
    } catch {
      // 不支持就算了，只影响小包延迟，不影响收发。
    }
    this.#socket.on('data', (chunk: Buffer) => this.#onData(chunk))
    this.#socket.on('error', (error: unknown) => {
      this.#log.warn(`${this.#label} 连接出错`, error)
      this.#shutdown()
    })
    this.#socket.on('close', () => this.#shutdown())
    this.#socket.on('end', () => this.#shutdown())
    // 握手时 head 里可能已经带着第一帧的字节，先灌进去再说。
    if (this.#buffer.length > 0) this.#drain()
    this.#startHeartbeat()
  }

  /** 发一段文本（一个完整的文本帧）。 */
  send(text: string): void {
    if (this.#closed) return
    this.#writeFrame(0x1, Buffer.from(text, 'utf8'))
  }

  close(code = 1000, reason = ''): void {
    if (this.#closed) return
    const body = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'))
    body.writeUInt16BE(code, 0)
    body.write(reason, 2)
    this.#writeFrame(0x8, body)
    this.#shutdown()
    try {
      this.#socket.end()
    } catch {
      // 对端可能已经走了，end 失败没有补救手段。
    }
  }

  #shutdown(): void {
    if (this.#closed) return
    this.#closed = true
    this.#stopHeartbeat()
    try {
      this.#socket.destroy()
    } catch {
      // 已经在销毁过程中了。
    }
    this.#onClose()
  }

  #startHeartbeat(): void {
    this.#heartbeat = setInterval(() => {
      if (this.#closed) return
      if (this.#awaitingPong) {
        this.#log.warn(`${this.#label} 心跳超时（${HEARTBEAT_MS}ms 内没有 pong），断开这条连接`)
        this.close(1001, 'heartbeat timeout')
        return
      }
      this.#awaitingPong = true
      this.#writeFrame(0x9, Buffer.alloc(0))
    }, HEARTBEAT_MS)
    unrefTimer(this.#heartbeat)
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat)
      this.#heartbeat = undefined
    }
  }

  #onData(chunk: Buffer): void {
    if (this.#closed) return
    this.#buffer = this.#buffer.length > 0 ? Buffer.concat([this.#buffer, chunk]) : chunk
    this.#drain()
  }

  #drain(): void {
    while (!this.#closed) {
      const parsed = parseFrame(this.#buffer)
      if (parsed.kind === 'incomplete') return
      if (parsed.kind === 'error') {
        this.#log.warn(`${this.#label} 协议错误（${parsed.code} ${parsed.reason}），断开`)
        this.close(parsed.code, parsed.reason)
        return
      }
      this.#buffer = this.#buffer.subarray(parsed.consumed)
      this.#awaitingPong = false
      this.#onFrame(parsed.fin, parsed.opcode, parsed.payload)
      if (this.#buffer.length === 0) return
    }
  }

  #onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case 0x0: {
        // 续帧：并进正在拼的那条消息。
        if (this.#fragmentOpcode === 0) {
          this.#log.warn(`${this.#label} 收到没有起始帧的续帧，忽略`)
          return
        }
        this.#fragments.push(payload)
        if (fin) this.#flushFragments()
        return
      }
      case 0x1:
      case 0x2: {
        if (fin) {
          if (opcode === 0x1) this.#deliver(payload)
          return
        }
        this.#fragmentOpcode = opcode
        this.#fragments = [payload]
        return
      }
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000
        this.#log.info(`${this.#label} 对端发起关闭（code=${code}）`)
        this.close(code >= 1000 && code <= 4999 ? code : 1000)
        return
      }
      case 0x9: {
        this.#writeFrame(0xa, payload)
        return
      }
      case 0xa: {
        this.#awaitingPong = false
        return
      }
      default: {
        this.#log.warn(`${this.#label} 收到未知 opcode=${opcode}，忽略`)
      }
    }
  }

  #flushFragments(): void {
    const opcode = this.#fragmentOpcode
    const payload = Buffer.concat(this.#fragments)
    this.#fragments = []
    this.#fragmentOpcode = 0
    if (opcode === 0x1) this.#deliver(payload)
  }

  #deliver(payload: Buffer): void {
    try {
      this.#onText(payload.toString('utf8'))
    } catch (error) {
      this.#log.warn(`${this.#label} 分发入站消息失败`, error)
    }
  }

  #writeFrame(opcode: number, payload: Buffer): void {
    if (this.#closed) return
    const length = payload.length
    let header: Buffer
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length])
    } else if (length < 65_536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    try {
      this.#socket.write(length < 126 ? Buffer.concat([header, payload]) : Buffer.concat([header, payload]))
    } catch (error) {
      this.#log.warn(`${this.#label} 写帧失败`, error)
      this.#shutdown()
    }
  }
}

// ── 通道本体 ────────────────────────────────────────────────────────────────

export class OneBotChannel implements Channel {
  readonly id: string
  readonly type = 'onebot'
  /** OneBot 没有「点过了」的按钮语义，多选只能靠回执。 */
  readonly showsPressedState = false
  readonly maxChars: number

  readonly #config: OneBotChannelConfig
  readonly #log: ChannelLogger
  readonly #registerUpgrade: OneBotRegisterUpgrade | undefined
  readonly #fetch: FetchLike | undefined
  readonly #webSocket: WebSocketCtor | undefined
  readonly #api: OneBotApi
  readonly #echo: EchoGuard

  #context: ChannelStartContext | undefined
  #mode: OneBotStatus['mode'] = 'none'
  #connected = false
  #selfId: string | undefined
  #inbound = 0
  #outbound = 0
  #lastError: string | undefined
  #stopped = true

  #disposeUpgrade: (() => void) | undefined
  #reverse: ReverseSocketLink | undefined

  #ws: WebSocketLike | undefined
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #reconnectDelay = RECONNECT_MIN_MS
  #headerSupported: boolean | undefined

  /** 反向 / 正向连接上的主动调用（OneBotApi 的 socket 通道）。 */
  #pending = new Map<string, { resolve: (value: OneBotCallResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  #rpcSeq = 0
  #warnedNoToken = false

  constructor(config: ChannelConfig, options: OneBotChannelOptions) {
    const narrowed = config as OneBotChannelConfig
    this.id = config.id
    this.#config = narrowed
    this.#log = options.log
    this.#registerUpgrade = options.registerUpgrade
    this.#fetch = options.fetch
    this.#webSocket = options.webSocket
    this.#selfId = narrowed.selfId?.trim() || undefined
    this.maxChars = narrowed.maxChars && narrowed.maxChars > 0 ? narrowed.maxChars : DEFAULT_MAX_CHARS
    this.#echo = new EchoGuard(narrowed.echoCapacity ?? DEFAULT_ECHO_CAPACITY)
    this.#api = new OneBotApi({
      httpUrl: narrowed.httpUrl,
      accessToken: narrowed.accessToken,
      fetch: options.fetch,
      log: options.log,
    })
  }

  // ── 对外只读视图 ────────────────────────────────────────────────────────

  /** 给 Markdown 渲染模块拼 `OneBotSendDeps` 用。 */
  get api(): OneBotApi {
    return this.#api
  }

  get selfId(): string | undefined {
    return this.#selfId
  }

  get connected(): boolean {
    return this.#connected
  }

  getStatus(): OneBotStatus {
    const status: OneBotStatus = {
      connected: this.#connected,
      mode: this.#mode,
      inbound: this.#inbound,
      outbound: this.#outbound,
    }
    const url = this.#mode === 'forward' ? this.#config.wsUrl : this.#mode === 'http' ? this.#config.httpUrl : this.#config.wsPath ?? DEFAULT_REVERSE_PATH
    if (url) status.url = url
    if (this.#selfId) status.selfId = this.#selfId
    if (this.#lastError) status.lastError = this.#lastError
    return status
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async start(context: ChannelStartContext): Promise<void> {
    this.#context = context
    this.#stopped = false
    this.#lastError = undefined

    const config = this.#config
    // 填了 `wsUrl` 就走正向：用户既然手写了地址，就该按他写的连。
    // 没填才回落到反向（宿主给了 registerUpgrade 时）。反过来先试反向的话，
    // 宿主永远有 registerUpgrade，`wsUrl` 就永远是一段被忽略的死配置。
    const hasForward = Boolean(config.wsUrl?.trim())
    const wantsForward = config.connection !== 'reverse' && hasForward
    const wantsReverse =
      config.connection !== 'forward' && !hasForward && typeof this.#registerUpgrade === 'function'

    if (wantsReverse) {
      // 首选：宿主把路径与 upgrade 交给我们。
      if (this.#mountReverse()) {
        this.#mode = 'reverse'
        this.#checkSecurity()
        return
      }
    } else if (!wantsForward && config.connection !== 'forward') {
      this.#log.info(
        `OneBot 通道「${this.id}」没有拿到 registerUpgrade（宿主未注入 webServer 反向路由），` +
          `反向 WebSocket 不可用，将尝试正向 / HTTP`,
      )
    }

    if (wantsForward) {
      this.#mode = 'forward'
      this.#checkSecurity()
      this.#connectForward()
      return
    }

    if (config.httpUrl?.trim()) {
      this.#mode = 'http'
      this.#checkSecurity()
      this.#log.warn(
        `OneBot 通道「${this.id}」只有 HTTP API，能发不能收：QQ 里的回复不会进到 DSH。` +
          `要双向对话请配置 wsUrl，或让宿主注入 registerUpgrade。`,
      )
      return
    }

    throw new Error(
      `OneBot 通道「${this.id}」没有任何可用的连接方式：请填 httpUrl，或填 wsUrl，` +
        `或让宿主注入 registerUpgrade（反向 WS）`,
    )
  }

  async stop(): Promise<void> {
    this.#stopped = true
    this.#clearReconnect()

    const dispose = this.#disposeUpgrade
    this.#disposeUpgrade = undefined
    if (dispose) {
      try {
        dispose()
      } catch (error) {
        this.#log.warn(`OneBot 通道「${this.id}」撤销反向 WS 路由失败`, error)
      }
    }

    this.#reverse?.close(1001, 'channel stopped')
    this.#reverse = undefined

    const ws = this.#ws
    this.#ws = undefined
    if (ws) {
      try {
        ws.close(1000, 'channel stopped')
      } catch (error) {
        this.#log.warn(`OneBot 通道「${this.id}」关闭正向连接失败`, error)
      }
    }

    this.#failPending('通道已停止')
    this.#connected = false
    this.#mode = 'none'
  }

  // ── 反向 WS ─────────────────────────────────────────────────────────────

  #mountReverse(): boolean {
    const path = this.#config.wsPath?.trim() || DEFAULT_REVERSE_PATH
    try {
      const dispose = this.#registerUpgrade?.({
        path,
        handler: (req, socket, head) => this.#handleUpgrade(req, socket, head),
      })
      if (typeof dispose === 'function') this.#disposeUpgrade = dispose
      this.#log.info(`OneBot 通道「${this.id}」已挂载反向 WebSocket 路由 ${path}（等待 NapCat / Lagrange 连入）`)
      return true
    } catch (error) {
      this.#lastError = messageOf(error)
      this.#log.warn(
        `OneBot 通道「${this.id}」挂载反向 WebSocket 失败（${this.#lastError}），改用其它连接方式`,
        error,
      )
      return false
    }
  }

  /** `registerUpgrade` 的 handler：校验 token → 写 101 → 交给帧层。 */
  #handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const key = headerValue(req, 'sec-websocket-key')
      if (!key) {
        this.#log.warn(`OneBot 通道「${this.id}」收到不像 WebSocket 的 upgrade 请求（缺 Sec-WebSocket-Key）`)
        this.#rejectUpgrade(socket, 400, 'Bad Request')
        return
      }

      const expected = this.#config.accessToken?.trim()
      if (expected) {
        const presented = this.#presentedToken(req)
        if (!tokenEquals(presented, expected)) {
          this.#lastError = '反向 WebSocket 鉴权失败（Authorization / access_token 不匹配）'
          this.#log.warn(`OneBot 通道「${this.id}」拒绝了鉴权失败的反向连接（来源 ${remoteOf(req)}）`)
          this.#rejectUpgrade(socket, 401, 'Unauthorized')
          return
        }
      } else if (!this.#warnedNoToken) {
        this.#warnedNoToken = true
        this.#log.warn(
          `OneBot 通道「${this.id}」没有配置 accessToken：任何能连到 ${this.#config.wsPath ?? DEFAULT_REVERSE_PATH} 的进程` +
            `都能冒充 QQ 客户端下发指令。请务必设置 accessToken。`,
        )
      }

      const accept = createHash('sha1')
        .update(`${key}${WS_GUID}`)
        .digest('base64')
      const response =
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      socket.write(response)
      this.attachReverseSocket(socket, head)
    } catch (error) {
      this.#lastError = messageOf(error)
      this.#log.warn(`OneBot 通道「${this.id}」处理反向连接失败`, error)
      this.#rejectUpgrade(socket, 500, 'Internal Server Error')
    }
  }

  /**
   * 接管一条**已经完成握手**的双工流。
   *
   * `initialBytes` 是 upgrade 事件里 `head` 的残余字节（可能已经含有第一帧）。
   * 旧的连接会被主动关掉：NapCat 重连时总是开新 socket，留着旧的只会收两份事件。
   */
  attachReverseSocket(socket: Duplex, initialBytes?: Buffer): void {
    if (this.#stopped) {
      this.#destroyQuietly(socket)
      return
    }

    const previous = this.#reverse
    if (previous && !previous.closed) {
      this.#log.info(`OneBot 通道「${this.id}」收到新的反向连接，关掉上一条`)
      previous.close(1000, 'replaced')
    }

    const link = new ReverseSocketLink({
      socket,
      initial: initialBytes && initialBytes.length > 0 ? Buffer.from(initialBytes) : Buffer.alloc(0),
      label: `OneBot 通道「${this.id}」`,
      log: this.#log,
      onText: (text) => void this.#handlePayload(text),
      onClose: () => {
        if (this.#reverse === link) {
          this.#reverse = undefined
          this.#connected = false
          this.#api.setSocketCall(undefined)
          this.#failPending('反向连接已断开')
          this.#log.info(`OneBot 通道「${this.id}」反向连接已断开`)
        }
      },
    })
    this.#reverse = link
    link.start()

    this.#connected = true
    this.#mode = 'reverse'
    this.#lastError = undefined
    this.#api.setSocketCall((action, params) => this.#rpcCall(link, action, params))
    this.#log.info(`OneBot 通道「${this.id}」反向 WebSocket 已连接`)
  }

  #presentedToken(req: IncomingMessage): string {
    const header = req.headers.authorization
    const raw = Array.isArray(header) ? header[0] : header
    if (typeof raw === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(raw.trim())
      if (match?.[1]) return match[1].trim()
    }
    // NapCat 的「token」字段常常被填进查询串（浏览器 / 客户端都不方便加头）。
    const url = req.url ?? ''
    const index = url.indexOf('?')
    if (index >= 0) {
      const params = new URLSearchParams(url.slice(index + 1))
      const token = params.get('access_token')
      if (token) return token.trim()
    }
    return ''
  }

  #rejectUpgrade(socket: Duplex, code: number, reason: string): void {
    try {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    } catch {
      // 对端可能已经走了。
    }
    this.#destroyQuietly(socket)
  }

  #destroyQuietly(socket: Duplex): void {
    try {
      socket.destroy()
    } catch {
      // 已经在销毁过程中了。
    }
  }

  // ── 正向 WS ─────────────────────────────────────────────────────────────

  #connectForward(): void {
    if (this.#stopped) return
    const wsUrl = this.#config.wsUrl?.trim()
    if (!wsUrl) return

    const ctor = this.#webSocket ?? globalWebSocketCtor()
    if (!ctor) {
      this.#lastError = '运行环境没有全局 WebSocket'
      this.#log.warn(
        `OneBot 通道「${this.id}」需要 WebSocket 客户端连接 ${wsUrl}，但运行时没有全局 WebSocket` +
          `（Node < 21 或未注入实现）。正向连接不可用：` +
          (this.#api.usesHttp ? '降级为 HTTP 模式（只能发、不能收）。' : '请填写 httpUrl 或注入 WebSocket 实现。'),
      )
      this.#mode = this.#api.usesHttp ? 'http' : 'none'
      return
    }

    const token = this.#config.accessToken?.trim()
    const url = withAccessToken(wsUrl, token)
    let ws: WebSocketLike
    try {
      ws = this.#openSocket(ctor, url, token)
    } catch (error) {
      this.#lastError = messageOf(error)
      this.#log.warn(`OneBot 通道「${this.id}」创建 WebSocket 失败：${this.#lastError}`, error)
      this.#scheduleReconnect()
      return
    }

    this.#ws = ws
    this.#bindSocket(ws, url)
  }

  /**
   * 打开连接。
   *
   * 标准 `WebSocket` 的第二个参数只接受子协议字符串，**不能带自定义头**，所以
   * token 同时放进查询串（NapCat / Lagrange 都认 `?access_token=`）。若注入了支持
   * `{ headers }` 的实现（例如将来的 `ws`），先试带头的那个写法；抛错就退回标准写法。
   */
  #openSocket(ctor: WebSocketCtor, url: string, token: string | undefined): WebSocketLike {
    if (!token || this.#headerSupported === false) return new ctor(url)
    try {
      const ws = new ctor(url, { headers: { authorization: `Bearer ${token}` } })
      if (this.#headerSupported !== true) {
        this.#headerSupported = true
        this.#log.debug?.(`OneBot 通道「${this.id}」WebSocket 实现支持自定义请求头，access_token 走 Authorization`)
      }
      return ws
    } catch {
      this.#headerSupported = false
      this.#log.debug?.(`OneBot 通道「${this.id}」WebSocket 实现不支持自定义请求头，access_token 走查询串`)
      return new ctor(url)
    }
  }

  #bindSocket(ws: WebSocketLike, url: string): void {
    const onOpen = (): void => {
      this.#connected = true
      this.#mode = 'forward'
      this.#reconnectDelay = RECONNECT_MIN_MS
      this.#lastError = undefined
      this.#api.setSocketCall((action, params) => this.#rpcCall(null, action, params))
      this.#log.info(`OneBot 通道「${this.id}」已连上 ${url}`)
    }
    const onMessage = (event: unknown): void => {
      const text = eventText(event)
      if (!text) {
        this.#log.debug?.(`OneBot 通道「${this.id}」收到无法解析的 WebSocket 消息帧，忽略`)
        return
      }
      void this.#handlePayload(text)
    }
    const onClose = (event: unknown): void => {
      this.#connected = false
      this.#ws = undefined
      this.#api.setSocketCall(undefined)
      this.#failPending('正向连接已断开')
      const code = closeCodeOf(event)
      this.#log.warn(`OneBot 通道「${this.id}」连接断开（code=${code}），准备重连`)
      this.#scheduleReconnect()
    }
    const onError = (event: unknown): void => {
      this.#lastError = messageOf(event) || 'WebSocket 错误'
      this.#log.warn(`OneBot 通道「${this.id}」连接出错：${this.#lastError}`)
    }

    const add = ws.addEventListener?.bind(ws)
    if (add) {
      add('open', onOpen)
      add('message', onMessage)
      add('close', onClose)
      add('error', onError)
      return
    }
    if (typeof ws.on === 'function') {
      ws.on('open', onOpen)
      ws.on('message', onMessage)
      ws.on('close', onClose)
      ws.on('error', onError)
      return
    }
    this.#lastError = 'WebSocket 实现既没有 addEventListener 也没有 on'
    this.#log.warn(`OneBot 通道「${this.id}」${this.#lastError}，无法订阅事件`)
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return
    this.#clearReconnect()
    const delay = this.#reconnectDelay
    this.#reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS)
    this.#log.info(`OneBot 通道「${this.id}」${delay}ms 后重连`)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      this.#connectForward()
    }, delay)
    unrefTimer(this.#reconnectTimer)
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = undefined
    }
    this.#reconnectDelay = RECONNECT_MIN_MS
  }

  // ── WS RPC（反向连接上主动下发动作）─────────────────────────────────────

  #rpcCall(target: ReverseSocketLink | null, action: string, params: Record<string, unknown>): Promise<OneBotCallResult> {
    const link = target ?? this.#reverse
    return new Promise<OneBotCallResult>((resolve, reject) => {
      if (!link || link.closed) {
        reject(new Error(`OneBot 通道「${this.id}」没有可用的 WebSocket 连接`))
        return
      }
      this.#rpcSeq += 1
      const echo = `tlnotify-${this.#rpcSeq}`
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        reject(new OneBotApiError(`调用 ${action} 超时（${DEFAULT_TIMEOUT_MS}ms 内没有响应）`, -1))
      }, DEFAULT_TIMEOUT_MS)
      unrefTimer(timer)
      this.#pending.set(echo, { resolve, reject, timer })
      try {
        link.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        this.#pending.delete(echo)
        clearTimeout(timer)
        reject(new Error(`调用 ${action} 失败（写 WebSocket 出错）：${messageOf(error)}`))
      }
    })
  }

  #failPending(reason: string): void {
    for (const [echo, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
      this.#pending.delete(echo)
    }
  }

  // ── 入站 ────────────────────────────────────────────────────────────────

  async #handlePayload(raw: string): Promise<void> {
    try {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        this.#log.warn(`OneBot 通道「${this.id}」收到不是 JSON 的报文：${clip(raw, 200)}`)
        return
      }
      if (!isRecord(parsed)) {
        this.#log.warn(`OneBot 通道「${this.id}」收到非对象报文，忽略`)
        return
      }

      // WS RPC 的响应：有 echo、没有 post_type。
      const echo = str(parsed.echo)
      if (echo && !parsed.post_type) {
        this.#resolveRpc(echo, parsed)
        return
      }

      const postType = str(parsed.post_type)
      const selfId = str(parsed.self_id)
      if (selfId) this.#selfId = selfId

      if (postType === 'meta_event') {
        this.#log.debug?.(
          `OneBot 通道「${this.id}」元事件 ${str(parsed.meta_event_type) || '(未知)'}` +
            (selfId ? ` self_id=${selfId}` : ''),
        )
        return
      }
      if (postType !== 'message' && postType !== 'message_sent') {
        this.#log.debug?.(`OneBot 通道「${this.id}」忽略 post_type=${postType || '(空)'} 的事件`)
        return
      }

      await this.#handleMessage(parsed, postType === 'message_sent')
    } catch (error) {
      // 解析 / 分发失败绝不能穿出去：一条畸形事件不该拖垮整个通道。
      this.#log.warn(`OneBot 通道「${this.id}」处理入站事件失败`, error)
    }
  }

  #resolveRpc(echo: string, payload: Record<string, unknown>): void {
    const entry = this.#pending.get(echo)
    if (!entry) {
      this.#log.debug?.(`OneBot 通道「${this.id}」收到没有等待者的 RPC 响应 echo=${echo}`)
      return
    }
    this.#pending.delete(echo)
    clearTimeout(entry.timer)

    const retcode = Number(payload.retcode ?? 0)
    const status = str(payload.status) || (retcode === 0 ? 'ok' : 'failed')
    if (status !== 'ok' && status !== 'async') {
      const wording = str(payload.wording) || str(payload.msg)
      entry.reject(
        new OneBotApiError(
          `OneBot 返回失败：status=${status} retcode=${retcode}` + (wording ? `，wording=${wording}` : ''),
          retcode,
          wording || undefined,
        ),
      )
      return
    }
    const result: OneBotCallResult = { status, retcode }
    if (payload.data !== undefined) result.data = payload.data
    const wording = str(payload.wording)
    if (wording) result.wording = wording
    entry.resolve(result)
  }

  async #handleMessage(event: Record<string, unknown>, sentBySelf: boolean): Promise<void> {
    const context = this.#context
    if (!context) {
      this.#log.debug?.(`OneBot 通道「${this.id}」在 start() 之前收到消息，丢弃`)
      return
    }

    const messageType = str(event.message_type)
    const selfId = this.#selfId ?? str(event.self_id)
    const userId = str(event.user_id)
    const groupId = messageType === 'group' ? str(event.group_id) : ''
    const messageId = str(event.message_id)
    const segments = normalizeSegments(event.message)
    const atSelf = isAtSelf(segments, selfId)
    const rawText = segmentsToText(segments) || stripCqAt(str(event.raw_message))

    if (userId && selfId && userId === selfId) this.#selfId = selfId

    // ── 1. 回声锁：自己账号发出的消息 ─────────────────────────────────────
    const fromSelf = sentBySelf || Boolean(selfId && userId === selfId)
    if (fromSelf) {
      const hit = this.#echo.classify(messageId, rawText)
      if (CONTROL_COMMAND_RE.test(rawText.trim())) {
        // 控制台指令：放行。手机在 QQ 里发 /rp 就能切模式，这是这条通道最实用的能力之一。
        this.#log.info(
          `OneBot 通道「${this.id}」放行自己发出的控制台指令：${clip(rawText.trim(), 60)}` +
            (hit ? `（回声锁命中 ${hit}，属于预期回环）` : ''),
        )
      } else {
        this.#log.debug?.(
          `OneBot 通道「${this.id}」丢弃自己发出的消息（回声锁${hit ? `命中 ${hit}` : '未命中，按自我消息丢弃'}）：` +
            `id=${messageId || '(无)'} 文本=${clip(rawText.trim(), 40)}`,
        )
        return
      }
    }

    // ── 2. 白名单 ─────────────────────────────────────────────────────────
    if (!fromSelf) {
      if (messageType === 'group') {
        if (!this.#groupAllowed(groupId)) {
          this.#log.debug?.(
            `OneBot 通道「${this.id}」丢弃非白名单群的消息（group=${groupId || '(无)'}），` +
              `当前 allowedGroups=[${this.#groupList().join(', ')}]`,
          )
          return
        }
      } else if (messageType === 'private') {
        if (!this.#privateAllowed(userId)) {
          this.#log.debug?.(
            `OneBot 通道「${this.id}」丢弃非白名单私聊消息（user=${userId || '(无)'}），` +
              `当前 allowedPrivateUsers=${describePrivateAllow(this.#config.allowedPrivateUsers)}`,
          )
          return
        }
      } else {
        this.#log.debug?.(`OneBot 通道「${this.id}」忽略未知 message_type=${messageType || '(空)'}`)
        return
      }
    }

    // ── 3. 群触发方式 ─────────────────────────────────────────────────────
    const prefix = this.#config.groupPrefix ?? DEFAULT_GROUP_PREFIX
    let text = rawText
    if (messageType === 'group') {
      const mode = this.#config.groupTriggerMode ?? 'at_or_prefix'
      const prefixHit = prefix.length > 0 && text.trim().startsWith(prefix)
      // at_or_prefix = 「被 @」**或**「以 prefix 开头」；prefix_only 只认前缀；
      // all = 这个群里的每条消息都算在跟我们说话（白名单已经筛过群了）。
      const accepted = mode === 'all' ? true : mode === 'at_or_prefix' ? atSelf || prefixHit : prefixHit
      if (!accepted) {
        this.#log.debug?.(
          `OneBot 通道「${this.id}」群消息未触发（mode=${mode} at=${atSelf} prefix=${prefixHit}），` +
            `前缀=${clip(text.trim(), 40)}`,
        )
        return
      }
      // 前缀（角色名 / `#` 之类）剥掉，交上去的正文才是纯指令；唯一例外是 `/`，
      // 因为那本来就是宿主认的命令前缀，剥了命令就废了。
      if (prefixHit && prefix !== '/') text = text.trim().slice(prefix.length).trim()
    }

    const trimmed = text.trim()
    if (trimmed.length === 0) {
      this.#log.debug?.(`OneBot 通道「${this.id}」这条消息没有正文（可能只有图片 / 表情），忽略`)
      return
    }

    const reply: OneBotInboundReply = {
      text: trimmed,
      messageId,
      senderId: userId,
    }
    if (groupId) reply.groupId = groupId
    if (fromSelf) reply.fromSelf = true
    const quotedId = quotedMessageIdOf(segments)
    if (quotedId) reply.quotedMessageId = quotedId

    this.#inbound += 1
    this.#log.info(
      `OneBot 通道「${this.id}」收到入站：${messageType} sender=${userId || '(无)'}` +
        (groupId ? ` group=${groupId}` : '') +
        ` id=${messageId || '(无)'} 文本=${trimmed.length} 字` +
        (fromSelf ? '（来自自己）' : ''),
    )

    try {
      await context.onInbound(reply)
    } catch (error) {
      this.#log.warn(`OneBot 通道「${this.id}」把入站交给宿主时出错`, error)
    }
  }

  #groupAllowed(groupId: string): boolean {
    return allowListHas(this.#config.allowedGroups, groupId)
  }

  #groupList(): string[] {
    return allowListOf(this.#config.allowedGroups)
  }

  #privateAllowed(userId: string): boolean {
    return allowListHas(this.#config.allowedPrivateUsers, userId)
  }

  #checkSecurity(): void {
    const token = this.#config.accessToken?.trim()
    if (!token && !this.#warnedNoToken) {
      this.#warnedNoToken = true
      this.#log.warn(
        `OneBot 通道「${this.id}」没有配置 accessToken：能碰到这个 HTTP / WS 端口的进程都可以冒充 QQ 客户端。`,
      )
    }
    // 白名单全空 = 一条入站都不收。这很容易被误当成「通道坏了」，所以明说。
    const privates = allowListOf(this.#config.allowedPrivateUsers)
    const groups = allowListOf(this.#config.allowedGroups)
    if (privates.length === 0 && groups.length === 0) {
      this.#log.warn(
        `OneBot 通道「${this.id}」白名单为空：任何入站消息都会被丢弃（只能推通知）。` +
          `要在 QQ 里对话，请把 QQ 号加进 allowedPrivateUsers，或把群号加进 allowedGroups。`,
      )
    }
    if (groups.length > 0) {
      this.#log.info(
        `OneBot 通道「${this.id}」群触发方式=${this.#config.groupTriggerMode ?? 'at_or_prefix'}，` +
          `前缀=${this.#config.groupPrefix ?? DEFAULT_GROUP_PREFIX}`,
      )
    }
  }

  // ── 出站 ────────────────────────────────────────────────────────────────

  async send(notification: Notification): Promise<{ messageId: string; refIdx?: string }> {
    const target = this.#outboundTarget()
    if (target.kind === 'private' && !target.userId) {
      throw new Error(`OneBot 通道「${this.id}」没有投递目标：请填 targetChatId（QQ 号）或 groupChatId（群号）`)
    }
    if (target.kind === 'group' && !target.groupId) {
      throw new Error(`OneBot 通道「${this.id}」群号为空`)
    }

    // 正文形态由配置的 `mdRenderMode` 决定：`notification.markdown` 是调用方
    // 准备好的 Markdown（对话模式会带上 RP 态的斜体动作与状态面板，Work 态会带
    // 代码块），没有就退回 body 当纯文本发。三级降级在 sendMarkdown 里做，
    // 这里只负责把「发什么、按什么形态发」交给它。
    const markdown = notification.markdown
    const mode = this.#config.mdRenderMode ?? 'auto_fallback'
    const body = notification.body ?? notification.title
    const result = markdown
      ? await this.sendMarkdown(target, markdown, mode)
      : await this.sendMarkdown(target, body, 'plain')
    if (!result.ok) {
      throw new Error(`OneBot 通道「${this.id}」发送失败：${result.error ?? '未知错误'}`)
    }
    return result.messageId ? { messageId: result.messageId } : { messageId: '' }
  }

  /**
   * OneBot 没有编辑消息的 API（只有 `delete_msg` 撤回）。
   *
   * 撤回会让用户手机上那条通知凭空消失，比「多发一条简短回执」更难理解，所以这里
   * 诚实地返回 undefined，让调用方退化成发一条「✅ 已允许」。
   */
  async update(): Promise<undefined> {
    return undefined
  }

  /**
   * 发送原生 Markdown / 纯文本 / 合并转发。
   *
   * 实例方法（模块级 `sendMarkdown()` 的包装）：多做了三件通道内的事——累加投递
   * 计数、把发出的消息写进回声锁、把 selfId 与 api 补进 deps。
   */
  async sendMarkdown(
    target: OneBotTarget,
    mdText: string,
    mode: OneBotSendMode,
    options?: { fallbackText?: string; forwardName?: string },
  ): Promise<OneBotSendResult> {
    const deps: OneBotSendDeps = {
      api: this.#api,
      log: this.#log,
      remember: (messageId, text) => this.#echo.remember(messageId, text),
    }
    if (options?.fallbackText !== undefined) deps.fallbackText = options.fallbackText
    if (options?.forwardName !== undefined) deps.forwardName = options.forwardName
    if (this.#selfId) deps.selfId = this.#selfId

    // 调用的是模块级函数（同名但不同作用域），不是递归。
    const result = await sendMarkdown(target, mdText, mode, deps)
    if (result.ok) this.#outbound += 1
    else this.#lastError = result.error
    return result
  }

  /** 「正在输入…」；失败静默降级（只是少了观感，不是错误）。 */
  async beginTyping(target: OneBotTarget): Promise<void> {
    await this.#setInputStatus(target, true)
  }

  /** 收起「正在输入…」。 */
  async endTyping(target: OneBotTarget): Promise<void> {
    await this.#setInputStatus(target, false)
  }

  async #setInputStatus(target: OneBotTarget, active: boolean): Promise<void> {
    if (target.kind === 'group') {
      // OneBot v11 的 set_input_status 只对私聊有意义；群聊没有这个概念。
      this.#log.debug?.(`OneBot 通道「${this.id}」群聊不支持输入状态，忽略`)
      return
    }
    if (!target.userId) return
    try {
      await this.#api.call('set_input_status', {
        user_id: qqId(target.userId),
        event_type: active ? 1 : 0,
      })
    } catch (error) {
      // NapCat 未开扩展 / 对方不在好友列表都会落到这里，降级即可。
      this.#log.debug?.(`OneBot 通道「${this.id}」设置输入状态失败（已静默降级）：${messageOf(error)}`)
    }
  }

  #outboundTarget(): OneBotTarget {
    const groupId = this.#config.targetGroupId ?? this.#config.groupChatId
    if (groupId !== undefined && groupId !== null && String(groupId).trim().length > 0) {
      return { kind: 'group', groupId: String(groupId).trim() }
    }
    const userId = this.#config.targetUserId ?? this.#config.targetChatId
    return { kind: 'private', userId: userId === undefined || userId === null ? '' : String(userId).trim() }
  }
}

/** `createOneBotChannel(config, options)` 的工厂：主控在 channels/index.ts 的 `#create` 里调用。 */
export function createOneBotChannel(config: ChannelConfig, options: OneBotChannelOptions): OneBotChannel {
  return new OneBotChannel(config, options)
}

// ── 发送原语（Markdown 渲染模块的唯一入口）─────────────────────────────────

/**
 * 按三级策略把一段 Markdown 发出去。
 *
 * - `native_md`：直接发 `{ type: 'markdown' }` 消息段，不降级（调用方要求「要么原生，
 *   要么失败」，多见于已经自己算过降级文本的场景）。
 * - `auto_fallback`：原生 → 纯文本 → 合并转发，每一级失败都 warn（带 retcode/wording）。
 * - `plain`：只发纯文本。
 *
 * **永远不抛**：失败以 `{ ok: false, error }` 返回，因为调用方常常在事件回调里，
 * 抛出只会变成一个没人接的 unhandled rejection。
 */
export async function sendMarkdown(
  target: OneBotTarget,
  mdText: string,
  mode: OneBotSendMode,
  deps: OneBotSendDeps,
): Promise<OneBotSendResult> {
  const log = deps.log
  const plain = deps.fallbackText ?? mdText
  const remember = deps.remember

  const asText = async (): Promise<OneBotSendResult> => {
    try {
      const result = await deps.api.call(sendAction(target), {
        ...targetParams(target),
        message: [{ type: 'text', data: { text: plain } }],
      })
      const messageId = messageIdOf(result.data)
      if (messageId) remember?.(messageId, plain)
      return messageId ? { ok: true, via: 'text', messageId } : { ok: true, via: 'text' }
    } catch (error) {
      return { ok: false, via: 'text', error: messageOf(error) }
    }
  }

  const asNative = async (): Promise<OneBotSendResult> => {
    try {
      const result = await deps.api.call(sendAction(target), {
        ...targetParams(target),
        message: [{ type: 'markdown', data: { content: mdText } }],
      })
      const messageId = messageIdOf(result.data)
      if (messageId) remember?.(messageId, mdText)
      return messageId ? { ok: true, via: 'native_md', messageId } : { ok: true, via: 'native_md' }
    } catch (error) {
      return { ok: false, via: 'native_md', error: describeSendError(error, 'native_md') }
    }
  }

  const asForward = async (): Promise<OneBotSendResult> => {
    const nodes = chunkText(plain, FORWARD_NODE_CHARS)
      .slice(0, FORWARD_MAX_NODES)
      .map((text) => ({
        type: 'node',
        data: {
          uin: deps.selfId ?? '0',
          name: deps.forwardName ?? 'DSH',
          content: [{ type: 'text', data: { text } }],
        },
      }))
    try {
      const result = await deps.api.call('send_forward_msg', {
        ...targetParams(target),
        messages: nodes,
      })
      const messageId = messageIdOf(result.data)
      if (messageId) remember?.(messageId, plain)
      return messageId ? { ok: true, via: 'forward', messageId } : { ok: true, via: 'forward' }
    } catch (error) {
      return { ok: false, via: 'forward', error: describeSendError(error, 'forward') }
    }
  }

  if (mode === 'plain') return asText()

  if (mode === 'native_md') {
    return asNative()
  }

  // auto_fallback
  const native = await asNative()
  if (native.ok) return native
  log.warn(
    `OneBot 原生 Markdown 发送失败（${targetKindLabel(target)}），降级为纯文本：${native.error ?? '未知原因'}`,
  )

  const text = await asText()
  if (text.ok) return text
  log.warn(`OneBot 纯文本发送失败，降级为合并转发：${text.error ?? '未知原因'}`)

  const forward = await asForward()
  if (forward.ok) {
    log.info('OneBot 合并转发成功（正文以 node 形式送达）')
    return forward
  }
  log.warn(`OneBot 合并转发也失败：${forward.error ?? '未知原因'}`)
  return { ok: false, via: 'forward', error: forward.error ?? '所有发送方式都失败' }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function sendAction(target: OneBotTarget): string {
  return target.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
}

function targetParams(target: OneBotTarget): Record<string, unknown> {
  return target.kind === 'group' ? { group_id: qqId(target.groupId) } : { user_id: qqId(target.userId) }
}

function targetKindLabel(target: OneBotTarget): string {
  return target.kind === 'group' ? `群 ${target.groupId}` : `私聊 ${target.userId}`
}

/** QQ 号：纯数字转成 number（多数实现更认数字），其它原样当字符串。 */
function qqId(value: string): number | string {
  const trimmed = value.trim()
  if (/^\d{1,15}$/.test(trimmed)) {
    const parsed = Number(trimmed)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return trimmed
}

function describeSendError(error: unknown, via: string): string {
  if (error instanceof OneBotApiError) {
    return `${via} 失败：retcode=${error.retcode}` + (error.wording ? ` wording=${error.wording}` : '') + `（${error.message}）`
  }
  return `${via} 失败：${messageOf(error)}`
}

function messageIdOf(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  const raw = data.message_id
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw === 'string' && raw.length > 0) return raw
  return undefined
}

function chunkText(text: string, size: number): string[] {
  const limit = size > 0 ? size : FORWARD_NODE_CHARS
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += limit) chunks.push(text.slice(index, index + limit))
  return chunks
}

function normalizeSegments(value: unknown): Array<{ type: string; data: Record<string, unknown> }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ type: string; data: Record<string, unknown> }> = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as { type?: unknown; data?: unknown }
    out.push({
      type: typeof record.type === 'string' ? record.type : '',
      data: isRecord(record.data) ? record.data : {},
    })
  }
  return out
}

function segmentsToText(segments: ReadonlyArray<{ type: string; data: Record<string, unknown> }>): string {
  let text = ''
  for (const segment of segments) {
    if (segment.type === 'text') text += str(segment.data.text)
  }
  return text
}

function quotedMessageIdOf(segments: ReadonlyArray<{ type: string; data: Record<string, unknown> }>): string | undefined {
  for (const segment of segments) {
    if (segment.type !== 'reply') continue
    const id = str(segment.data.id) || str(segment.data.message_id)
    if (id) return id
  }
  return undefined
}

function isAtSelf(segments: ReadonlyArray<{ type: string; data: Record<string, unknown> }>, selfId: string | undefined): boolean {
  if (!selfId) return false
  for (const segment of segments) {
    if (segment.type !== 'at') continue
    const qq = str(segment.data.qq)
    if (qq === selfId) return true
  }
  return false
}

/** `raw_message` 兜底时把 `[CQ:at,qq=123]` 去掉，不然正文里全是 CQ 码。 */
function stripCqAt(text: string): string {
  return text.replace(/\[CQ:at,[^\]]*\]/g, ' ')
}

function digest(text: string): string {
  return clip(text.replace(/\s+/g, ' ').trim(), 120)
}

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name]
  if (Array.isArray(raw)) return raw[0] ?? ''
  return typeof raw === 'string' ? raw : ''
}

function remoteOf(req: IncomingMessage): string {
  const forwarded = headerValue(req, 'x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? forwarded
  return req.socket?.remoteAddress ?? '(未知来源)'
}

function tokenEquals(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function withAccessToken(url: string, token: string | undefined): string {
  if (!token) return url
  try {
    const parsed = new URL(url)
    if (!parsed.searchParams.get('access_token')) parsed.searchParams.set('access_token', token)
    return parsed.toString()
  } catch {
    const joiner = url.includes('?') ? '&' : '?'
    return `${url}${joiner}access_token=${encodeURIComponent(token)}`
  }
}

function eventText(event: unknown): string {
  if (typeof event === 'string') return event
  if (!event || typeof event !== 'object') return ''
  const data = (event as { data?: unknown }).data
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  if (data && typeof data === 'object') {
    const text = (data as { toString?: unknown }).toString
    if (typeof text === 'function' && text !== Object.prototype.toString) return String(data)
  }
  return ''
}

function closeCodeOf(event: unknown): number {
  if (event && typeof event === 'object') {
    const code = (event as { code?: unknown }).code
    if (typeof code === 'number') return code
  }
  return 0 // 0 = 没有给出 code（1006 异常关闭那种）
}

function globalWebSocketCtor(): WebSocketCtor | undefined {
  const scope = globalThis as { WebSocket?: unknown }
  return typeof scope.WebSocket === 'function' ? (scope.WebSocket as WebSocketCtor) : undefined
}

function globalFetch(): FetchLike | undefined {
  const scope = globalThis as { fetch?: unknown }
  return typeof scope.fetch === 'function' ? (scope.fetch as FetchLike) : undefined
}

/** 定时器 unref：别让心跳 / 重连把宿主进程钉住（Electron 退出时会等它）。 */
function unrefTimer(timer: unknown): void {
  if (!timer || typeof timer !== 'object') return
  const unref = (timer as { unref?: unknown }).unref
  if (typeof unref === 'function') (unref as () => void).call(timer)
}

/**
 * 把白名单读成字符串数组。
 *
 * 三件事一起容错：`undefined`（没配）、单个字符串（老配置 / 手改的 config.json
 * 写成了 `"*"`）、数组（正常形态）。`'*'` 一律表示「任何人」。
 */
function allowListOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  return []
}

/** 白名单里放不放行这个 id；空列表 = 一个都不放行（宁可安静）。 */
function allowListHas(value: unknown, id: string): boolean {
  if (!id) return false
  const list = allowListOf(value)
  if (list.length === 0) return false
  if (list.includes('*')) return true
  return list.includes(id)
}

function describePrivateAllow(value: unknown): string {
  const list = allowListOf(value)
  if (list.length === 0) return '[]（谁都不放行）'
  if (list.includes('*')) return "['*']（任何人）"
  return `[${list.join(', ')}]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const wording = (error as { wording?: unknown }).wording
    if (typeof wording === 'string' && wording.length > 0) return wording
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}
