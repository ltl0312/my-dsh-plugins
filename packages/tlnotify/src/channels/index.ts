// packages/tlnotify/src/channels/index.ts
//
// 通道管理器：把 config 里的 `channels[]` 实例化成活的通道，并负责
// 「一条通知发到哪个通道、发失败了怎么办、太长怎么分片」。
//
// 设计上的两个取舍：
//
// 1. **故障转移**。设计方案 §7 把「单通道单点」列为风险。这里不是选一个通道
//    就完事，而是按 `defaultChannelId` 优先、其余按配置顺序依次尝试，只要有一个
//    成功就停。全部失败才记错误——通知丢了要能在日志里查得到。
// 2. **分片在这里做**。每个通道自己声明 `maxChars`（QQ 比飞书短得多），
//    平台限制属于通道的知识，不该泄漏到 render 层。

import type {
  Channel,
  ChannelConfig,
  ChannelLogger,
  ChannelStartContext,
  InboundAction,
  InboundReply,
  Notification,
} from '../types.js'
import { shardNotification } from '../render.js'
import { QqChannel } from './qq.js'
import { FeishuChannel } from './feishu.js'

export interface ChannelStatus {
  id: string
  type: string
  enabled: boolean
  connected: boolean
  /** 最近一次错误信息，供 `/status` 与日志排查用。 */
  lastError?: string
  sent: number
  failed: number
}

export interface SendResult {
  channelId: string
  messageId: string
  refIdx?: string
  /** 实际发了几片。 */
  shards: number
}

export interface ChannelManagerOptions {
  log: ChannelLogger
  onInbound: (channelId: string, reply: InboundReply) => void | Promise<void>
  onAction: (channelId: string, action: InboundAction) => void | Promise<void>
}

export class ChannelManager {
  readonly #log: ChannelLogger
  readonly #options: ChannelManagerOptions
  readonly #channels = new Map<string, Channel>()
  readonly #configs = new Map<string, ChannelConfig>()
  readonly #status = new Map<string, ChannelStatus>()
  #defaultChannelId: string | undefined
  #stopped = false

  constructor(options: ChannelManagerOptions) {
    this.#log = options.log
    this.#options = options
  }

  get size(): number {
    return this.#channels.size
  }

  get statuses(): ChannelStatus[] {
    return [...this.#status.values()]
  }

  has(channelId: string): boolean {
    return this.#channels.has(channelId)
  }

  /**
   * 按配置实例化并启动所有启用的通道。
   *
   * 单个通道启动失败**不会**影响其他通道，也不会让插件装载失败——QQ 的
   * AppSecret 填错、飞书 SDK 没装，都不该让你连 Web GUI 都用不了。
   */
  async start(configs: readonly ChannelConfig[], defaultChannelId?: string): Promise<void> {
    this.#defaultChannelId = defaultChannelId
    for (const config of configs) {
      this.#configs.set(config.id, config)
      if (!config.enabled) {
        this.#status.set(config.id, {
          id: config.id,
          type: config.type,
          enabled: false,
          connected: false,
          sent: 0,
          failed: 0,
        })
        continue
      }

      const status: ChannelStatus = {
        id: config.id,
        type: config.type,
        enabled: true,
        connected: false,
        sent: 0,
        failed: 0,
      }
      this.#status.set(config.id, status)

      let channel: Channel
      try {
        channel = this.#create(config)
      } catch (error) {
        status.lastError = messageOf(error)
        this.#log.error(`通道「${config.id}」创建失败：${status.lastError}`)
        continue
      }
      this.#channels.set(config.id, channel)

      const context: ChannelStartContext = {
        onInbound: (reply) => this.#options.onInbound(config.id, reply),
        onAction: (action) => this.#options.onAction(config.id, action),
        log: this.#scoped(config.id),
      }
      try {
        await channel.start(context)
        status.connected = true
        this.#log.info(`通道「${config.id}」（${config.type}）已启动`)
      } catch (error) {
        status.lastError = messageOf(error)
        this.#log.error(`通道「${config.id}」启动失败：${status.lastError}`)
      }
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true
    const channels = [...this.#channels.values()]
    this.#channels.clear()
    for (const channel of channels) {
      try {
        await channel.stop()
      } catch (error) {
        this.#log.warn(`通道「${channel.id}」停止时出错`, error)
      }
    }
    for (const status of this.#status.values()) status.connected = false
  }

  /**
   * 发送一条通知：默认通道优先，失败逐个回退。
   *
   * 返回实际成功的通道与消息 id（分片时是**第一片**的 id，因为按钮挂在首片，
   * 路由反查也该按首片来）。
   */
  async send(notification: Notification): Promise<SendResult | undefined> {
    if (this.#stopped) return undefined
    const order = this.#sendOrder(notification.sessionId)
    if (order.length === 0) {
      this.#log.warn('没有可用的通道，通知被丢弃')
      return undefined
    }

    for (const channel of order) {
      const status = this.#status.get(channel.id)
      try {
        const result = await this.#sendSharded(channel, notification)
        if (status) {
          status.sent += 1
          status.connected = true
          delete status.lastError
        }
        return result
      } catch (error) {
        const text = messageOf(error)
        if (status) {
          status.failed += 1
          status.lastError = text
        }
        this.#log.error(`通道「${channel.id}」发送失败，尝试下一个通道：${text}`)
      }
    }
    this.#log.error(`所有通道都发送失败，通知「${notification.title}」被丢弃`)
    return undefined
  }

  /**
   * 指定通道发送，不做回退。
   *
   * 用于**回执**：用户在哪个通道里说话，就在哪个通道里回他——回退到另一个
   * 通道会让对话看起来断片。
   */
  async sendTo(channelId: string, notification: Notification): Promise<SendResult | undefined> {
    if (this.#stopped) return undefined
    const channel = this.#channels.get(channelId)
    if (!channel) {
      this.#log.warn(`通道「${channelId}」不存在，回执被丢弃`)
      return undefined
    }
    try {
      return await this.#sendSharded(channel, notification)
    } catch (error) {
      this.#log.warn(`通道「${channelId}」发送回执失败`, error)
      return undefined
    }
  }

  /** 把一条已发出的通知改成结算态（按钮点完摘掉按钮）。 */
  async update(channelId: string, messageId: string, patch: Partial<Notification>): Promise<void> {
    const channel = this.#channels.get(channelId)
    if (!channel || !messageId) return
    try {
      await channel.update(messageId, patch)
    } catch (error) {
      this.#log.warn(`通道「${channelId}」更新消息 ${messageId} 失败`, error)
    }
  }

  async #sendSharded(channel: Channel, notification: Notification): Promise<SendResult> {
    const limit = channel.maxChars
    const shards = limit && limit > 0 ? shardNotification(notification, limit) : [notification]
    let first: { messageId: string; refIdx?: string } | undefined
    for (const shard of shards) {
      const sent = await channel.send(shard)
      first ??= sent
    }
    if (!first) throw new Error('通道没有返回消息 id')
    return {
      channelId: channel.id,
      messageId: first.messageId,
      ...(first.refIdx ? { refIdx: first.refIdx } : {}),
      shards: shards.length,
    }
  }

  /**
   * 默认通道优先，然后按配置顺序。
   *
   * `sessionFilter` 在这里生效：填了过滤列表的通道只接收列表里的会话，
   * 于是「工作机器人只推工作项目」这种需求不需要额外的路由层。
   */
  #sendOrder(sessionId: string): Channel[] {
    const all = [...this.#channels.values()].filter((channel) => {
      const filter = this.#configs.get(channel.id)?.sessionFilter
      if (!Array.isArray(filter) || filter.length === 0) return true
      return filter.includes(sessionId)
    })
    const preferred = this.#defaultChannelId
    if (!preferred) return all
    const index = all.findIndex((channel) => channel.id === preferred)
    if (index <= 0) return all
    return [all[index]!, ...all.slice(0, index), ...all.slice(index + 1)]
  }

  #scoped(channelId: string): ChannelLogger {
    return this.#log.child?.(`channel:${channelId} `) ?? this.#log
  }

  #create(config: ChannelConfig): Channel {
    switch (config.type) {
      case 'qq':
        return new QqChannel({ config, log: this.#scoped(config.id) })
      case 'feishu':
        return new FeishuChannel({ config, log: this.#scoped(config.id) })
      default:
        throw new Error(`未知的通道类型「${String(config.type)}」，目前支持 qq / feishu`)
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
