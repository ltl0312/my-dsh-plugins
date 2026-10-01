// packages/tlnotify/src/channels/feishu.ts
//
// 飞书自建应用通道（设计方案 §2 的备选通道，也是「多平台」的接口验证）。
//
// 选它的理由：官方 `@larksuiteoapi/node-sdk` 提供 **WebSocket 长连接**（免公网），
// 卡片按钮表达能力比 QQ 强，而且 `im.message.patch` 能**真正编辑**已发出的消息——
// 所以这个通道的 `update()` 是实打实能用的，按钮点完可以把卡片改成「✅ 已允许」
// 并摘掉按钮。
//
// 依赖是 **optionalDependencies**：`@larksuiteoapi/node-sdk` 解包后 30MB 左右，
// 绝大多数只用 QQ 的人没必要装。没装的时候 `start()` 会抛出带安装命令的清晰错误，
// 通道标记为不可用，但**不影响插件本身装载**。

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

// ── SDK 的最小结构化视图 ────────────────────────────────────────────────────

interface LarkClientLike {
  im: {
    message: {
      create(payload: unknown): Promise<{ data?: { message_id?: string } }>
      reply(payload: unknown): Promise<{ data?: { message_id?: string } }>
      patch(payload: unknown): Promise<{ data?: { message_id?: string } }>
    }
  }
}

interface LarkModuleLike {
  Client: new (options: Record<string, unknown>) => LarkClientLike
  WSClient: new (options: Record<string, unknown>) => {
    start(payload: { eventDispatcher: unknown }): Promise<void> | void
  }
  EventDispatcher: new (options?: Record<string, unknown>) => {
    register(handlers: Record<string, (payload: unknown) => unknown>): unknown
  }
  LoggerLevel?: Record<string, number>
}

interface FeishuMessageEventLike {
  sender?: { sender_id?: { open_id?: string; user_id?: string; union_id?: string } }
  message?: {
    message_id?: string
    root_id?: string
    parent_id?: string
    chat_id?: string
    message_type?: string
    content?: string
    chat_type?: string
  }
}

interface FeishuCardActionLike {
  action?: { value?: unknown; tag?: string }
  open_message_id?: string
  open_chat_id?: string
  operator?: { open_id?: string; user_id?: string }
}

const TEXT_LIMIT = 4000

export interface FeishuChannelOptions {
  config: ChannelConfig
  log: ChannelLogger
}

export class FeishuChannel implements Channel {
  readonly id: string
  readonly type = 'feishu'
  readonly #config: ChannelConfig
  readonly #log: ChannelLogger
  #client: LarkClientLike | undefined
  #ws: { start(payload: { eventDispatcher: unknown }): Promise<void> | void } | undefined
  #started = false
  /** 话题根 id → 我们发出的完整文本（引用反查用）。 */
  readonly #sentText = new Map<string, string>()

  constructor(options: FeishuChannelOptions) {
    this.id = options.config.id
    this.#config = options.config
    this.#log = options.log
  }

  get connected(): boolean {
    return this.#started
  }

  async start(context: ChannelStartContext): Promise<void> {
    const appId = this.#config.feishuAppId
    const appSecret = this.#config.feishuAppSecret
    if (!appId || !appSecret) throw new Error(`飞书通道「${this.id}」缺少 feishuAppId / feishuAppSecret`)
    if (!this.#config.feishuReceiveId) throw new Error(`飞书通道「${this.id}」缺少 feishuReceiveId`)

    let Lark: LarkModuleLike
    try {
      // 变量化 specifier：tsup 不会把它静态解析掉，没装依赖时也只是运行时抛错。
      const specifier = '@larksuiteoapi/node-sdk'
      Lark = (await import(specifier)) as unknown as LarkModuleLike
    } catch (error) {
      throw new Error(
        `飞书通道「${this.id}」需要 @larksuiteoapi/node-sdk，但它没有安装。请运行：pnpm add @larksuiteoapi/node-sdk（原始错误：${
          error instanceof Error ? error.message : String(error)
        }）`,
      )
    }

    const client = new Lark.Client({
      appId,
      appSecret,
      loggerLevel: Lark.LoggerLevel?.info,
    })
    this.#client = client

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (payload: unknown) => {
        void this.#onMessage(payload as FeishuMessageEventLike, context)
        return undefined
      },
      'card.action.trigger': (payload: unknown) => {
        void this.#onCardAction(payload as FeishuCardActionLike, context)
        return undefined
      },
      // 这两个事件我们不用，但注册成 noop 可以让 SDK 不报「未注册事件」警告。
      'im.message.reaction.created_v1': () => undefined,
      'im.message.reaction.deleted_v1': () => undefined,
    })

    const ws = new Lark.WSClient({
      appId,
      appSecret,
      loggerLevel: Lark.LoggerLevel?.info,
      onReady: () => this.#log.info(`飞书通道「${this.id}」长连接已就绪`),
      onError: (error: unknown) => this.#log.warn(`飞书通道「${this.id}」长连接错误`, error),
      onReconnecting: () => this.#log.warn(`飞书通道「${this.id}」长连接重连中`),
      onReconnected: () => this.#log.info(`飞书通道「${this.id}」长连接已重连`),
    })
    this.#ws = ws
    this.#started = true
    // 同 QQ：start 之后连接常驻，不能 await。
    void Promise.resolve(ws.start({ eventDispatcher: dispatcher })).catch((error: unknown) => {
      this.#log.error(`飞书通道「${this.id}」长连接结束`, error)
    })
  }

  async stop(): Promise<void> {
    this.#started = false
    // SDK 没有暴露显式的 stop；把引用丢掉即可（底层 ws 会随进程退出关闭）。
    this.#ws = undefined
    this.#client = undefined
  }

  // ── 发送 ────────────────────────────────────────────────────────────────

  async send(notification: Notification): Promise<{ messageId: string; refIdx?: string }> {
    const client = this.#client
    if (!client) throw new Error(`飞书通道「${this.id}」尚未连接`)

    const text = `${notification.title}\n${notification.body}`.trim()
    const data = this.#buildMessageData(text, notification)
    const response = await client.im.message.create({
      params: { receive_id_type: this.#config.feishuReceiveIdType ?? 'open_id' },
      data: { receive_id: this.#config.feishuReceiveId, ...data },
    })
    const messageId = String(response?.data?.message_id ?? '')
    if (messageId) this.#sentText.set(messageId, text)
    return { messageId }
  }

  /**
   * 飞书支持编辑消息，所以按钮点完之后可以把卡片改成结算态。
   *
   * 注意：只有 `msg_type: 'interactive'`（卡片）才能 patch 正文；纯文本消息
   * patch 会失败。失败时返回 undefined，让调用方退化成再发一条确认。
   */
  async update(messageId: string, patch: Partial<Notification>): Promise<{ messageId?: string } | undefined> {
    const client = this.#client
    if (!client || !messageId) return undefined
    try {
      const body = patch.body ?? ''
      const title = patch.title ?? 'DSH'
      const card = buildCard(title, body, [])
      const response = await client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
      return { messageId: response?.data?.message_id ?? messageId }
    } catch (error) {
      this.#log.warn(`飞书通道「${this.id}」更新消息失败，将退化为再发一条`, error)
      return undefined
    }
  }

  #buildMessageData(text: string, notification: Notification): Record<string, unknown> {
    if (notification.actions.length === 0) {
      return { msg_type: 'text', content: JSON.stringify({ text: text.slice(0, TEXT_LIMIT) }) }
    }
    // 有按钮就走卡片——飞书的按钮只能放在卡片里。
    const card = buildCard(notification.title, notification.body, notification.actions)
    return { msg_type: 'interactive', content: JSON.stringify(card) }
  }

  // ── 入站 ────────────────────────────────────────────────────────────────

  async #onMessage(event: FeishuMessageEventLike, context: ChannelStartContext): Promise<void> {
    try {
      const message = event.message
      if (!message) return
      const senderId = event.sender?.sender_id?.open_id ?? ''
      if (!this.#isAllowedSender(senderId)) {
        this.#log.warn(`飞书通道「${this.id}」忽略了非授权来源的消息（sender=${senderId}）`)
        return
      }

      let text = ''
      if (message.message_type === 'text') {
        text = parseFeishuText(message.content)
      } else {
        // 非文本（图片 / 语音 / 文件）暂时只提示，不做多模态。
        text = `[${message.message_type ?? '非文本'}消息]`
      }

      const reply: InboundReply = { text, senderId }
      if (message.message_id) reply.messageId = message.message_id
      // 飞书的引用回复给的是 parent_id（被引用消息）与 root_id（话题根）。
      const quotedId = message.parent_id ?? message.root_id
      if (quotedId) reply.quotedMessageId = quotedId
      const quotedText = quotedId ? this.#sentText.get(quotedId) : undefined
      if (quotedText) reply.quotedText = quotedText

      const asAction = safeJson(text)
      const value = toActionValue(asAction)
      if (value) {
        await context.onAction({ value, senderId, ...(message.message_id ? { messageId: message.message_id } : {}) })
        return
      }
      await context.onInbound(reply)
    } catch (error) {
      this.#log.error(`飞书通道「${this.id}」处理入站消息失败`, error)
    }
  }

  async #onCardAction(event: FeishuCardActionLike, context: ChannelStartContext): Promise<void> {
    try {
      const senderId = event.operator?.open_id ?? ''
      if (!this.#isAllowedSender(senderId)) {
        this.#log.warn(`飞书通道「${this.id}」忽略了非授权来源的按钮点击（sender=${senderId}）`)
        return
      }
      const value = toActionValue(event.action?.value)
      if (!value) {
        this.#log.warn(`飞书通道「${this.id}」收到无法解析的卡片回调`)
        return
      }
      await context.onAction({
        value,
        senderId,
        ...(event.open_message_id ? { messageId: event.open_message_id } : {}),
      })
    } catch (error) {
      this.#log.error(`飞书通道「${this.id}」处理卡片回调失败`, error)
    }
  }

  #isAllowedSender(senderId: string): boolean {
    const allowed = this.#config.feishuReceiveId
    if (!allowed) return false
    const type = this.#config.feishuReceiveIdType ?? 'open_id'
    // 只有当接收方就是 open_id 时才能做 sender 比对；chat_id 场景下不限制发送者。
    if (type !== 'open_id') return true
    return senderId === allowed
  }
}

// ---------------------------------------------------------------------------
// 卡片构造
// ---------------------------------------------------------------------------

function buildCard(title: string, body: string, actions: readonly NotificationAction[]): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    { tag: 'div', text: { tag: 'lark_md', content: body || ' ' } },
  ]
  if (actions.length > 0) {
    elements.push({
      tag: 'action',
      actions: actions.map((action) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: action.label },
        type: action.tone === 'primary' ? 'primary' : action.tone === 'danger' ? 'danger' : 'default',
        // 飞书的按钮 value 可以是任意 JSON 对象，不需要像 QQ 那样字符串化。
        value: action.value,
      })),
    })
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  }
}

function parseFeishuText(content: string | undefined): string {
  if (!content) return ''
  try {
    const parsed = JSON.parse(content) as { text?: string }
    return typeof parsed.text === 'string' ? parsed.text : ''
  } catch {
    return ''
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
