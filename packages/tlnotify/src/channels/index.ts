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
import { channelCaresAboutSession } from '../config.js'
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
   * 按发送顺序交出**配置里启用的**通道（含「启用了但启动失败」的那几个）。
   *
   * 给调用方做「这台机器人关心这条事件吗」的判断用——判断需要事件上下文
   * （快照、模式、正文渲染），那是 `Tlnotify` 的私有状态，不该泄进这里。
   *
   * 有意**不**把启动失败的通道剔掉：那台机器人是用户明确打开的，它掉线应该表现成
   * 日志里一条「发送失败」，而不是无声无息地少推一条通知。真正决定「送不送得出去」
   * 的是发送阶段的故障转移与失败计数（`#fanout`）。
   */
  candidates(): ChannelConfig[] {
    const result: ChannelConfig[] = []
    for (const channel of this.#ordered()) {
      const config = this.#configs.get(channel.id)
      if (config) result.push(config)
    }
    return result
  }

  /**
   * 按配置实例化并启动所有启用的通道。
   *
   * 单个通道启动失败**不会**影响其他通道，也不会让插件装载失败——QQ 的
   * AppSecret 填错、飞书 SDK 没装，都不该让你连 Web GUI 都用不了。
   */
  async start(configs: readonly ChannelConfig[], defaultChannelId?: string): Promise<void> {
    // stop() 之后必须能被重新 start()：设置页改完通道配置就走这条路径
    // （stop → start）。少了这一行，重启后的管理器会一直停在「已停止」状态，
    // send() 直接返回 undefined，表现为「配置保存成功了但通知再也不发」。
    this.#stopped = false
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
    // 清掉旧配置与旧状态：重启一次就该只反映新配置。留着旧状态会让设置页
    // 在删掉一个通道之后仍然显示它「未连接」。
    this.#configs.clear()
    this.#status.clear()
  }

  /**
   * 发送一条通知：默认通道优先，失败逐个回退。
   *
   * 返回实际成功的通道与消息 id（分片时是**第一片**的 id，因为按钮挂在首片，
   * 路由反查也该按首片来）。
   */
  async send(notification: Notification): Promise<SendResult | undefined> {
    return this.#fanout(
      (channel) => {
        const config = this.#configs.get(channel.id)
        if (config && !channelCaresAboutSession(config, notification.sessionId)) return undefined
        return notification
      },
      { warnWhenSkipped: true },
    )
  }

  /**
   * 按调用方给的「选片函数」发送（《每机器人设置方案》§3）。
   *
   * 与 `send()` 的区别只有一个：正文由调用方**逐通道**渲染，因为事件开关与正文
   * 细节现在都是每台机器人各自的。`select` 返回 undefined 就表示「这台不关心
   * 这个事件」，跳过且不计失败。
   *
   * 故障转移语义不变：同一事件**只有一个**机器人真正发包（默认通道优先，
   * 失败才轮到下一台）——否则三台机器人都开着就变成三条重复通知。
   */
  async sendSelected(
    select: (channelId: string, config: ChannelConfig) => Notification | undefined,
  ): Promise<SendResult | undefined> {
    return this.#fanout((channel) => {
      const config = this.#configs.get(channel.id)
      return config ? select(channel.id, config) : undefined
    }, { warnWhenSkipped: false })
  }

  /**
   * 默认通道优先 → 依次尝试 → 第一台成功即停。
   *
   * `warnWhenSkipped` 区分两种「一个都没发」：`send()` 是「没有通道接这条会话」
   * （该报），`sendSelected()` 是「调用方自己判断没人关心」（跳过是正常的，
   * 报出来只会把日志刷满）。
   */
  async #fanout(
    pick: (channel: Channel) => Notification | undefined,
    options: { warnWhenSkipped: boolean },
  ): Promise<SendResult | undefined> {
    if (this.#stopped) return undefined
    const order = this.#ordered()
    let attempted = 0
    let last: Notification | undefined
    for (const channel of order) {
      const notification = pick(channel)
      if (!notification) continue
      attempted += 1
      last = notification
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
    if (attempted === 0) {
      if (options.warnWhenSkipped) this.#log.warn('没有可用的通道，通知被丢弃')
      return undefined
    }
    this.#log.error(`所有通道都发送失败，通知「${last?.title ?? ''}」被丢弃`)
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
   * 会话过滤不在这里做：`send()` 走 `channelCaresAboutSession()`，`sendSelected()`
   * 走调用方自己的选片函数——两台机器人的「关心什么」现在可以完全不同。
   */
  #ordered(): Channel[] {
    const all = [...this.#channels.values()]
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
