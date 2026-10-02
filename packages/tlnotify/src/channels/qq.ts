// packages/tlnotify/src/channels/qq.ts
//
// QQ 单聊机器人通道（设计方案 §2 的首选通道）。
//
// 选它的理由：官方有 WebSocket 网关（**不需要公网 IP**）、有按钮、有
// `INTERACTION_CREATE` 回调、主动消息额度够（1000 条/天/用户，20 qpm）。
// 唯一硬限制：用户可以在 QQ 客户端里关掉「允许主动发送」，关掉之后主动消息
// 一律失败——那时候只能等他先说一句话，我们借被动回复窗口回。
//
// ── 两个必须记住的坑 ────────────────────────────────────────────────────────
//
// 1. 构造时一定要 `markdownSupport: false`。否则 SDK 会自动把 `msg_type` 改成 2
//    并注入它自己的 `message_reference`，我们就失去了对消息形态的控制权。
//
// 2. **`C2CMessageEvent` 类型里根本没有 `message_reference` 字段。** QQ 的「长按
//    引用回复」在入站侧只能靠 `message_scene.ext` 里的 `ref_msg_idx` 还原，而
//    被引用消息的**正文**在 `msg_elements[0].content`。所以引用反查需要两张表：
//    `ref_idx → 会话` 和 `正文 → 会话`（见 route.ts）。只靠 message_id 是行不通的。

import type {
  Channel,
  ChannelConfig,
  ChannelLogger,
  ChannelStartContext,
  InboundReply,
  Notification,
  NotificationAction,
} from '../types.js'
import { toActionValue } from '../inject.js'

// ── SDK 的最小结构化视图（@tencent-connect/qqbot-nodejs 是 ESM，只能动态 import）──

interface KeyboardButtonLike {
  id: string
  render_data: { label: string; visited_label: string; style: number }
  action: { type: number; permission: { type: number }; data: string; click_limit?: number; unsupport_tips?: string }
}

interface InlineKeyboardLike {
  content: { rows: { buttons: KeyboardButtonLike[] }[] }
}

interface ReplyTargetLike {
  scope: 'c2c' | 'group'
  targetId: string
  msgId?: string
}

interface SendMessageOptionsLike {
  target: ReplyTargetLike
  msgType?: number
  content?: string
  keyboard?: InlineKeyboardLike
  extra?: Record<string, unknown>
}

interface MessageResponseLike {
  id: string
  timestamp: number | string
  ext_info?: { ref_idx?: string }
}

interface InboundMessageLike {
  rawEventType: string
  kind: string
  senderId: string
  content: string
  messageId: string
  timestamp: string
  refMsgIdx?: string
  msgIdx?: string
  msgElements?: { msg_idx?: string; content?: string }[]
  replyTarget: ReplyTargetLike
}

interface InteractionEventLike {
  id: string
  type: number
  user_openid?: string
  data: {
    type: number
    resolved: {
      button_data?: string
      button_id?: string
      user_id?: string
      message_id?: string
    }
  }
}

interface QQBotLike {
  on(event: string, handler: (...args: unknown[]) => void): unknown
  start(signal?: AbortSignal): Promise<void>
  stop(): void
  send(options: SendMessageOptionsLike): Promise<MessageResponseLike>
  acknowledgeInteraction(interactionId: string, code?: number, data?: unknown): Promise<void>
}

interface QQBotCtor {
  new (options: Record<string, unknown>): QQBotLike
}

/** 被动回复窗口：60 分钟内、同一个 msg_id 最多 4 片。 */
const PASSIVE_WINDOW_MS = 60 * 60 * 1000
const PASSIVE_MAX_SEQ = 4
/** 按钮一行最多几个。 */
const BUTTONS_PER_ROW = 3

export interface QqChannelOptions {
  config: ChannelConfig
  log: ChannelLogger
}

export class QqChannel implements Channel {
  readonly id: string
  readonly type = 'qq'
  readonly #config: ChannelConfig
  readonly #log: ChannelLogger
  #bot: QQBotLike | undefined
  #started = false
  /** 最近一条入站消息，用于借被动回复窗口。 */
  #lastInbound: { msgId: string; target: ReplyTargetLike; time: number } | undefined
  /** 每个被动 msg_id 已经用掉的 msg_seq。 */
  readonly #seqByMsgId = new Map<string, number>()
  /** 出站消息 id → 我们发出去的完整文本（引用正文反查用）。 */
  readonly #sentText = new Map<string, string>()

  constructor(options: QqChannelOptions) {
    this.id = options.config.id
    this.#config = options.config
    this.#log = options.log
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async start(context: ChannelStartContext): Promise<void> {
    const { appId, appSecret } = this.#config
    if (!appId || !appSecret) throw new Error(`QQ 通道「${this.id}」缺少 appId / appSecret`)
    if (!this.#config.targetChatId && !this.#config.groupChatId) {
      throw new Error(`QQ 通道「${this.id}」缺少 targetChatId（你的 openid）或 groupChatId`)
    }

    const mod = (await import('@tencent-connect/qqbot-nodejs')) as unknown as { QQBot: QQBotCtor }
    const QQBot = mod.QQBot
    if (typeof QQBot !== 'function') throw new Error('@tencent-connect/qqbot-nodejs 没有导出 QQBot')

    const bot = new QQBot({
      appId,
      appSecret,
      // 关掉 markdown 自动处理：否则 SDK 会替我们决定 msg_type 与 message_reference。
      markdownSupport: false,
      transport: 'websocket',
      tokenPrefetch: 'sync',
      logger: this.#sdkLogger(),
    })
    this.#bot = bot

    bot.on('ready', (...args: unknown[]) => {
      this.#log.info(`QQ 通道「${this.id}」已连接（${describeReady(args[0])}）`)
    })
    bot.on('resumed', () => {
      this.#log.info(`QQ 通道「${this.id}」会话已恢复`)
    })
    bot.on('error', (...args: unknown[]) => {
      this.#log.warn(`QQ 通道「${this.id}」连接错误`, args[0])
    })
    bot.on('message', (...args: unknown[]) => {
      void this.#onMessage(args[args.length - 1] as InboundMessageLike, context)
    })
    bot.on('interaction', (...args: unknown[]) => {
      void this.#onInteraction(args[args.length - 1] as InteractionEventLike, context)
    })

    this.#started = true
    // start() 的 Promise 要等到 stop/abort 才 resolve，不能 await——否则 apply 就挂住了。
    void bot.start().catch((error: unknown) => {
      this.#log.error(`QQ 通道「${this.id}」长连接结束`, error)
    })
  }

  async stop(): Promise<void> {
    this.#started = false
    const bot = this.#bot
    this.#bot = undefined
    if (!bot) return
    try {
      bot.stop()
    } catch (error) {
      this.#log.warn(`QQ 通道「${this.id}」关闭时出错`, error)
    }
  }

  get connected(): boolean {
    return this.#started
  }

  // ── 发送 ────────────────────────────────────────────────────────────────

  async send(notification: Notification): Promise<{ messageId: string; refIdx?: string }> {
    const bot = this.#bot
    if (!bot) throw new Error(`QQ 通道「${this.id}」尚未连接`)

    const text = `${notification.title}\n${notification.body}`.trim()
    const keyboard = buildKeyboard(notification.actions)
    const target = this.#outboundTarget()

    const response = await bot.send({
      target,
      msgType: 0, // 纯文本
      content: text,
      ...(keyboard ? { keyboard } : {}),
      ...(target.msgId ? { extra: { msg_seq: this.#nextSeq(target.msgId) } } : {}),
    })

    const messageId = String(response?.id ?? '')
    if (messageId) this.#sentText.set(messageId, text)
    const refIdx = response?.ext_info?.ref_idx
    return refIdx ? { messageId, refIdx } : { messageId }
  }

  /**
   * QQ 没有「编辑消息」的 API，所以这里诚实地返回 undefined。
   *
   * 调用方（index.ts）看到 undefined 会退化成再发一条简短确认（「✅ 已允许」）。
   * 这比撤回重发温和得多——撤回会让用户手机上那条通知凭空消失。
   */
  async update(): Promise<undefined> {
    return undefined
  }

  /** 主动推送目标：有群就发群，否则发单聊；`mode:'passive'` 时借用被动回复窗口。 */
  #outboundTarget(): ReplyTargetLike {
    const base: ReplyTargetLike = this.#config.groupChatId
      ? { scope: 'group', targetId: this.#config.groupChatId }
      : { scope: 'c2c', targetId: this.#config.targetChatId ?? '' }

    if (this.#config.mode !== 'passive') return base
    const last = this.#lastInbound
    if (!last) return base
    if (Date.now() - last.time > PASSIVE_WINDOW_MS) return base
    if ((this.#seqByMsgId.get(last.msgId) ?? 0) >= PASSIVE_MAX_SEQ) {
      this.#log.warn(`QQ 通道「${this.id}」被动回复已用完 4 片，改为主动推送`)
      return base
    }
    return { ...last.target, msgId: last.msgId }
  }

  /** `msg_seq` 必须对同一个 `msg_id` 唯一，否则平台会去重掉。 */
  #nextSeq(msgId: string): number {
    const next = (this.#seqByMsgId.get(msgId) ?? 0) + 1
    this.#seqByMsgId.set(msgId, next)
    // 被动窗口只有 60 分钟，表项过期就没意义了；超过 200 条直接清空重来。
    if (this.#seqByMsgId.size > 200) this.#seqByMsgId.clear()
    return next
  }

  // ── 入站 ────────────────────────────────────────────────────────────────

  async #onMessage(msg: InboundMessageLike, context: ChannelStartContext): Promise<void> {
    try {
      if (!msg) return
      // 群消息只有被 @ 时才算「在跟机器人说话」，普通群消息一律忽略。
      if (msg.kind === 'group' && msg.rawEventType !== 'GROUP_AT_MESSAGE_CREATE') return
      if (!this.#isAllowedSender(msg)) {
        this.#log.warn(`QQ 通道「${this.id}」忽略了非授权来源的消息（sender=${msg.senderId}）`)
        return
      }

      this.#lastInbound = { msgId: msg.messageId, target: msg.replyTarget, time: Date.now() }

      const quoted = this.#resolveQuoted(msg)
      const reply: InboundReply = {
        text: msg.content ?? '',
        messageId: msg.messageId,
        senderId: msg.senderId,
      }
      if (quoted.id) reply.quotedMessageId = quoted.id
      if (quoted.text) reply.quotedText = quoted.text

      // 用户可能直接把按钮的 data 贴回来（老客户端点了按钮会以文本形式送达），
      // 群里还会带上「@机器人 」前缀，所以剥一次再认。
      const asAction = toActionValue(safeJson(reply.text)) ?? toActionValue(safeJson(stripMention(reply.text)))
      if (asAction) {
        await context.onAction({ value: asAction, senderId: msg.senderId, messageId: msg.messageId })
        return
      }
      await context.onInbound(reply)
    } catch (error) {
      this.#log.error(`QQ 通道「${this.id}」处理入站消息失败`, error)
    }
  }

  async #onInteraction(event: InteractionEventLike, context: ChannelStartContext): Promise<void> {
    try {
      if (!event) return
      const senderId = event.data?.resolved?.user_id ?? event.user_openid ?? ''
      if (!this.#isAllowedSenderId(senderId, event.user_openid)) {
        this.#log.warn(`QQ 通道「${this.id}」忽略了非授权来源的按钮点击（sender=${senderId}）`)
        // 还是要回执，否则客户端会一直转圈。
        await this.#ack(event.id)
        return
      }
      const value = toActionValue(safeJson(event.data?.resolved?.button_data ?? ''))
      if (!value) {
        this.#log.warn(`QQ 通道「${this.id}」收到无法解析的按钮回调`)
        await this.#ack(event.id)
        return
      }
      await this.#ack(event.id)
      await context.onAction({
        value,
        senderId,
        ...(event.data?.resolved?.message_id ? { messageId: event.data.resolved.message_id } : {}),
      })
    } catch (error) {
      this.#log.error(`QQ 通道「${this.id}」处理按钮回调失败`, error)
    }
  }

  async #ack(interactionId: string): Promise<void> {
    try {
      await this.#bot?.acknowledgeInteraction(interactionId, 0)
    } catch (error) {
      this.#log.warn(`QQ 通道「${this.id}」按钮回执失败`, error)
    }
  }

  /**
   * 还原被引用的消息。
   *
   * QQ 只给 `ref_msg_idx`（被引用消息的 index），而我们的路由表既能按 ref_idx 查，
   * 也能按正文查。两个都返回，让 route.ts 决定用哪个。
   */
  #resolveQuoted(msg: InboundMessageLike): { id?: string; text?: string } {
    const id = msg.refMsgIdx ?? (msg.msgElements?.[0]?.msg_idx || undefined)
    const text = msg.msgElements?.[0]?.content
    const result: { id?: string; text?: string } = {}
    if (id) result.id = id
    if (typeof text === 'string' && text.length > 0) result.text = text
    return result
  }

  /**
   * 来源白名单。
   *
   * 这不是可选的礼貌检查——没有它，任何找到这个机器人 openid 的人都能往用户的
   * DSH 会话里注入消息。所以：单聊必须来自 targetChatId，群聊必须来自
   * groupChatId 且发送者是 targetChatId。
   */
  #isAllowedSender(msg: InboundMessageLike): boolean {
    if (msg.kind === 'group') {
      if (!this.#config.groupChatId) return false
      // 群消息的 senderId 是成员 openid，和单聊的 user_openid 是同一个空间。
      return this.#config.targetChatId ? msg.senderId === this.#config.targetChatId : true
    }
    return this.#isAllowedSenderId(msg.senderId)
  }

  #isAllowedSenderId(senderId: string, fallback?: string): boolean {
    const allowed = this.#config.targetChatId
    if (!allowed) return false
    if (senderId && senderId === allowed) return true
    return fallback !== undefined && fallback === allowed
  }

  #sdkLogger(): { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; debug(...a: unknown[]): void } {
    const log = this.#log
    return {
      info: (...args: unknown[]) => log.info(`[qq-sdk] ${args.map(stringify).join(' ')}`),
      warn: (...args: unknown[]) => log.warn(`[qq-sdk] ${args.map(stringify).join(' ')}`),
      error: (...args: unknown[]) => log.error(`[qq-sdk] ${args.map(stringify).join(' ')}`),
      debug: () => {},
    }
  }
}

function safeJson(text: string): unknown {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 把通知里的按钮翻成 QQ 的内联键盘。
 *
 * 单独抽成模块级函数是为了能直接单测——`action.type` 写错一次就会让所有按钮变成
 * 「点了没反应」（见下面 type 的注释），而这种错误在宿主里完全静默。
 */
export function buildKeyboard(actions: readonly NotificationAction[]): InlineKeyboardLike | undefined {
  if (actions.length === 0) return undefined
  const buttons: KeyboardButtonLike[] = actions.map((action, index) => ({
    id: `${action.value.kind}-${index}`,
    render_data: {
      label: action.label,
      visited_label: action.label,
      style: action.tone === 'primary' ? 1 : 0,
    },
    action: {
      // type 1 = 回调按钮：点击后 QQ 回调后台接口，data 经 INTERACTION_CREATE 送回来。
      // type 2 是**指令按钮**，它只会把 data 插进输入框当普通文本发出去，永远不会
      // 触发 INTERACTION_CREATE——原来写的是 2，所以按钮点了没反应、`#onInteraction`
      // 那条路一次都没被走过（用户 m04327 报的「QQ 没有弹出选项」）。
      type: 1,
      permission: { type: 2 }, // 所有人可点；真实访问控制在路由层（只认配置里的目标）
      // action.data 在协议里是**字符串**，所以结构化 value 必须 JSON.stringify。
      data: JSON.stringify(action.value),
      unsupport_tips: '你的 QQ 版本不支持按钮，请直接回复序号或文字作答',
    },
  }))

  const rows: { buttons: KeyboardButtonLike[] }[] = []
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push({ buttons: buttons.slice(i, i + BUTTONS_PER_ROW) })
  }
  return { content: { rows } }
}

/**
 * 剥掉群消息正文前面的「@机器人 」。
 *
 * 群里 @ 机器人时，平台会把被 @ 的名字当正文前缀带过来；老客户端把按钮 data 贴回来
 * 时也会带上它，于是 `JSON.parse` 失败、载荷认不出来。单聊没有这个前缀，剥不到就
 * 原样返回。
 */
function stripMention(text: string): string {
  return text.replace(/^@\S+\s+/, '').trim()
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function describeReady(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'ready'
  const record = value as Record<string, unknown>
  const user = record.user as Record<string, unknown> | undefined
  const id = user?.id ?? record.id
  return id ? `bot ${String(id)}` : 'ready'
}
