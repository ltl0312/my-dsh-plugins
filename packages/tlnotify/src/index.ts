// packages/tlnotify/src/index.ts
//
// dsh-plugin-tlnotify —— 把所有 DSH 会话的事件聚合到一个 IM 通道，并且能**回话**。
//
// 这个文件只做「接线」：把事件源（events.ts）、累积器（aggregate.ts）、完成门
// （gate.ts）、去重（dedupe.ts）、渲染（render.ts）、路由（route.ts）、模式
// （mode.ts）、注入（inject.ts）、通道（channels/）按设计方案的顺序串起来。
// 每一块的内部逻辑都在各自的文件里，这里不重复实现。
//
// ── 主流程 ──────────────────────────────────────────────────────────────────
//
//   session/event ──► TurnAccumulator（累积正文与工具）
//                  └► extractTurnEnd ──► Dedupe ──► CompletionGate ──┐
//   approval/request / user-questions/request ──► InteractionBridge ──┤
//   tool/call 兜底 ──────────────────────────────────────────────────┤
//                                                                    ▼
//                                              render ──► ChannelManager ──► IM
//                                                                    │
//                                          RouteTable.record ◄───────┘
//
//   IM 入站 ──► parseCommand（模式命令）
//           └► RouteTable.resolve（按钮 / 引用 / 前缀 / 兜底）──► SessionInjector
//
// ── 为什么 apply 的返回值不能当卸载路径 ─────────────────────────────────────
//
// Cordis 3.0.0 的 MainScope.apply 是 `this.ensure(async () => plugin.apply(...))`，
// **apply 的返回值被直接丢弃**。所以真正的卸载路径是绑在 ctx 上的副作用
// （`ctx.on('dispose', …)`），同时仍然返回一个幂等 dispose 供测试和会消费返回值
// 的宿主使用。这一点与仓库里 tlsearch 的写法一致。

import { join } from 'node:path'
import type { Context } from 'cordis'

import type {
  InboundAction,
  InboundReply,
  Notification,
  PersistedState,
  RawEvent,
  TlnotifyConfig,
  TurnSnapshot,
} from './types.js'
import { INTERVENTION_KINDS } from './types.js'
import { Config, ensureDir, mergeConfig, persistEffectiveConfig, readConfigFile, readJsonFile, resolveDataDir, saveConfigFile, statePath, writeJsonFile } from './config.js'
import { FileLogger, joinLog, type HostLogger } from './log.js'
import {
  extractToolCallEvent,
  extractTurnEnd,
  isSubagent,
  projectName,
  shortSessionId,
  switchesOf,
  isKindEnabled,
  type SessionEventLike,
  type SessionLike,
} from './events.js'
import { TurnAccumulator, type UsageLike } from './aggregate.js'
import { CompletionGate } from './gate.js'
import { Dedupe } from './dedupe.js'
import { renderNotification, type RenderOptions } from './render.js'
import { RouteTable, matchesShortId, type RouteResolution } from './route.js'
import { describeMode, helpText, ModeState, parseCommand, type ModeCommand } from './mode.js'
import { InteractionBridge, isInteractionAction, SessionInjector, type AgentLike } from './inject.js'
import { ChannelManager } from './channels/index.js'

// ---------------------------------------------------------------------------
// 插件契约
// ---------------------------------------------------------------------------

export const name = 'tlnotify'

/**
 * 只依赖 `agents`。
 *
 * 会话事件从 `session/event` 来，不需要额外的服务；把消息注回会话要靠
 * `ctx.agents.get(id).followup()`，所以 `agents` 是唯一的硬依赖。
 * 等它就绪再 apply，能避免「插件装上了但注不回去」的半死状态。
 */
export const inject = ['agents']

export { Config }

/** 状态落盘的防抖窗口——路由表每发一条通知都会变，不值得每次都写盘。 */
const STATE_SAVE_DEBOUNCE_MS = 1500
/** 已认领的 requestId 只用于日志兜底去重，留最近这么多条足够。 */
const CLAIMED_REQUEST_LIMIT = 500
/** 入站消息 id 去重表的上限（平台重投防护）。 */
const SEEN_INBOUND_LIMIT = 800

// ---------------------------------------------------------------------------
// 宿主对象的结构化视图
// ---------------------------------------------------------------------------

interface AgentRegistryLike {
  get(id: string): AgentLike | undefined
}

interface LooseContext {
  on(name: string, listener: (...args: never[]) => unknown, options?: unknown): (() => void) | undefined
}

interface TlnotifyHost {
  agents?: AgentRegistryLike
  logger?: HostLogger
}

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------

class Tlnotify {
  readonly #host: TlnotifyHost
  readonly #bus: LooseContext
  readonly #dataDir: string
  readonly #log: FileLogger
  readonly #accumulator = new TurnAccumulator()
  readonly #dedupe = new Dedupe()
  readonly #gate: CompletionGate
  readonly #route: RouteTable
  readonly #mode: ModeState
  readonly #injector: SessionInjector
  readonly #bridge: InteractionBridge
  readonly #channels: ChannelManager
  readonly #sessions = new Map<string, SessionLike>()
  readonly #claimedRequests = new Set<string>()
  readonly #seenInbound = new Set<string>()
  #config: TlnotifyConfig
  #disposers: (() => void)[] = []
  #saveTimer: ReturnType<typeof setTimeout> | undefined
  #disposed = false

  constructor(ctx: Context, rawConfig: Partial<TlnotifyConfig>) {
    this.#host = ctx as unknown as TlnotifyHost
    this.#bus = ctx as unknown as LooseContext
    this.#dataDir = resolveDataDir(rawConfig)
    ensureDir(this.#dataDir)

    const fromFile = readConfigFile(this.#dataDir)
    this.#config = applyRuntimeOverrides(mergeConfig(rawConfig, fromFile), fromFile)
    this.#log = new FileLogger(joinLog(this.#dataDir), this.#config.logLevel, this.#host.logger)

    // 把有效配置落到 config.json：`channels` 始终以有效值为准，其余字段只在
    // 文件里本来没有时才补——避免把 GUI 的意图固化成文件后用户改不动 GUI。
    persistEffectiveConfig(this.#dataDir, this.#config, rawConfig)

    const state = readState(this.#dataDir)
    this.#mode = new ModeState({
      mode: this.#config.mode,
      ...(this.#config.session.targetSessionId ? { targetSessionId: this.#config.session.targetSessionId } : {}),
      detailSessions: state.detailSessions,
    })
    for (const id of state.seenInbound) this.#seenInbound.add(id)

    this.#route = RouteTable.fromJSON(state.routes, {
      ttlDays: this.#config.routing.tableTtlDays,
      isLive: (sessionId) => this.#injector.isLive(sessionId),
      labelOf: (sessionId) => this.#label(sessionId),
    })
    this.#injector = new SessionInjector((sessionId) => this.#agentOf(sessionId))

    this.#gate = new CompletionGate({
      flush: (event) => this.#deliver(event),
      onDebug: (message) => this.#log.debug(message),
    })
    this.#gate.setAgentLookup((sessionId) => this.#agentOf(sessionId))

    this.#bridge = new InteractionBridge({
      onPending: (event) => this.#onPending(event),
      log: (message, error) => this.#log.warn(message, error),
    })

    this.#channels = new ChannelManager({
      log: this.#log,
      onInbound: (channelId, reply) => this.#onInbound(channelId, reply),
      onAction: (channelId, action) => this.#onAction(channelId, action),
    })
  }

  async start(): Promise<void> {
    if (!this.#config.enabled) {
      this.#log.info('tlnotify 已禁用（enabled=false），不启动任何通道')
      return
    }

    // 先装交互钩子、再连通道：慢连接不该让审批 / 提问的钩子缺失。
    this.#bridge.install(this.#bus)
    this.#disposers.push(
      this.#bus.on('session/event', (session, event) =>
        this.#onSessionEvent(session as SessionLike, event as SessionEventLike),
      ) ?? noop,
    )
    this.#disposers.push(this.#bus.on('dispose', () => void this.dispose()) ?? noop)

    await this.#channels.start(this.#config.channels, this.#config.defaultChannelId)

    const enabled = this.#config.channels.filter((channel) => channel.enabled)
    this.#log.info(
      `tlnotify 已就绪：模式=${this.#config.mode}，通道=${enabled.length > 0 ? enabled.map((c) => `${c.id}(${c.type})`).join(', ') : '无'}`,
    )
    if (enabled.length === 0) {
      this.#log.warn(`还没有配置任何通道，通知不会送达。配置文件：${join(this.#dataDir, 'config.json')}`)
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    for (const disposer of this.#disposers.splice(0)) {
      try {
        disposer()
      } catch (error) {
        this.#log.warn('卸载监听器时出错（已隔离）', error)
      }
    }
    this.#bridge.dispose()
    this.#gate.close()
    this.#accumulator.clear()
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer)
      this.#saveTimer = undefined
    }
    this.#saveState()
    await this.#channels.stop()
    this.#log.info('tlnotify 已卸载')
  }

  // ── 事件源 ──────────────────────────────────────────────────────────────

  #onSessionEvent(session: SessionLike, event: SessionEventLike): void {
    try {
      if (!session?.id) return
      this.#sessions.set(session.id, session)
      const data = (event.data ?? {}) as Record<string, unknown>

      switch (event.type) {
        case 'turn/start':
          this.#accumulator.beginTurn(session.id, numberOf(data.turn), event.time)
          // 新轮开始意味着上一轮的结束状态已过期，直接把槽位丢掉。
          this.#gate.supersede(session.id)
          return

        case 'user/message':
          this.#accumulator.recordUserMessage(session.id, data.content, data.source)
          return

        case 'assistant/message': {
          const message = data.message as { content?: unknown } | undefined
          this.#accumulator.recordAssistant(session.id, message?.content, data.usage as UsageLike | undefined)
          return
        }

        case 'tool/call': {
          const name = String(data.name ?? '')
          const callId = String(data.callId ?? '')
          this.#accumulator.recordToolCall(session.id, name, callId, String(data.arguments ?? ''))
          this.#maybePending(session, event)
          return
        }

        case 'tool/result': {
          const message = data.message as { toolCallId?: string; isError?: boolean } | undefined
          const error = data.error as { reason?: string; name?: string } | undefined
          this.#accumulator.recordToolResult(
            session.id,
            String(message?.toolCallId ?? ''),
            message?.isError === true,
            error?.reason ?? error?.name,
          )
          return
        }

        case 'turn/end': {
          this.#accumulator.endTurn(session.id, numberOf(data.turn), event.time)
          const raw = extractTurnEnd(session, event)
          if (raw) this.#onTurnEnd(raw)
          return
        }

        default:
          return
      }
    } catch (error) {
      // 事件处理器抛错会污染宿主的 emit 循环；这里全部吞掉并记日志。
      this.#log.warn(`处理会话事件 ${event.type} 时出错（已忽略）`, error)
    }
  }

  #onTurnEnd(event: RawEvent): void {
    if (!this.#shouldPush(event)) return
    if (!this.#dedupe.accept(event.sessionId, event.seq)) {
      this.#log.debug(`跳过重复的结束事件 ${event.sessionId}:${event.seq}`)
      return
    }
    this.#gate.schedule(event)
  }

  /**
   * 日志兜底：`tool/call` 里的等待类工具。
   *
   * 正常情况下 InteractionBridge 的 waterfall 会先一步认领同一个 callId，这里
   * 就不再发。只有当别的 answerer 抢先认领且不调 `next()`（我们的 waterfall
   * 根本没跑）时，才轮到这条路径。
   */
  #maybePending(session: SessionLike, event: SessionEventLike): void {
    const raw = extractToolCallEvent(session, event)
    if (!raw) return
    const requestId = raw.detail.requestId
    if (requestId && this.#claimedRequests.has(requestId)) return
    if (!this.#shouldPush(raw)) return
    if (!this.#dedupe.accept(raw.sessionId, raw.seq)) return
    void this.#deliver(raw)
  }

  /** InteractionBridge 识别出一条「有人在等」的事件。 */
  #onPending(event: RawEvent): void | Promise<void> {
    const requestId = event.detail.requestId
    if (requestId) this.#claim(requestId)
    if (!this.#shouldPush(event)) return
    if (!this.#dedupe.accept(event.sessionId, event.seq)) return
    return this.#deliver(event)
  }

  #claim(requestId: string): void {
    this.#claimedRequests.add(requestId)
    if (this.#claimedRequests.size > CLAIMED_REQUEST_LIMIT) {
      const oldest = this.#claimedRequests.values().next().value
      if (oldest !== undefined) this.#claimedRequests.delete(oldest)
    }
  }

  #shouldPush(event: RawEvent): boolean {
    if (this.#disposed || !this.#config.enabled) return false
    const switches = switchesOf(this.#config)
    if (!isKindEnabled(event.kind, switches)) return false
    if (isSubagent(this.#sessions.get(event.sessionId)) && !switches.includeSubagent) return false
    // 单会话模式：只推绑定的那一个会话。
    if (!this.#mode.shouldPush(event.sessionId)) return false
    return true
  }

  // ── 投递 ────────────────────────────────────────────────────────────────

  async #deliver(event: RawEvent): Promise<void> {
    if (this.#disposed) return
    const notification = this.#render(event)
    const result = await this.#channels.send(notification)
    if (!result) return
    this.#route.record({
      messageId: result.messageId,
      sessionId: event.sessionId,
      text: `${notification.title}\n${notification.body}`,
      ...(result.refIdx ? { refIdx: result.refIdx } : {}),
      intervention: INTERVENTION_KINDS.has(event.kind),
    })
    this.#scheduleSave()
    this.#log.info(`已通知：${notification.title}（通道 ${result.channelId}，${result.shards} 片）`)
  }

  #render(event: RawEvent): Notification {
    const sessionId = event.sessionId
    // 结束类事件的轮次已经被 endTurn 推进历史，等待类事件则还在进行中；
    // 先问进行中的，再退回历史最后一条，两种情况都能拿到对的快照。
    const snapshot = this.#accumulator.liveSnapshot(sessionId) ?? this.#accumulator.previousTurns(sessionId, 1)[0]
    return renderNotification(event, snapshot, this.#renderOptions(sessionId, snapshot))
  }

  #renderOptions(sessionId: string, snapshot: TurnSnapshot | undefined): RenderOptions {
    const wanted = Math.max(0, this.#config.session.context.previousTurns)
    let previousTurns = wanted > 0 ? this.#accumulator.previousTurns(sessionId, wanted + 1) : []
    // 结束类事件的快照本身就是历史里最后一条，不要既当正文又当「前 N 轮」。
    const last = previousTurns[previousTurns.length - 1]
    if (snapshot && last && last.turn === snapshot.turn && last.startedAt === snapshot.startedAt) {
      previousTurns = previousTurns.slice(0, -1)
    }
    return {
      mode: this.#mode.mode,
      detailed: this.#mode.isDetailed(sessionId),
      content: this.#config.content,
      session: this.#config.session,
      global: this.#config.global,
      previousTurns,
    }
  }

  // ── 入站：文本 ──────────────────────────────────────────────────────────

  async #onInbound(channelId: string, reply: InboundReply): Promise<void> {
    try {
      if (reply.messageId) {
        if (this.#seenInbound.has(reply.messageId)) {
          this.#log.debug(`忽略平台重投的入站消息 ${reply.messageId}`)
          return
        }
        this.#rememberInbound(reply.messageId)
      }
      const text = (reply.text ?? '').trim()
      if (text.length === 0) return

      const command = parseCommand(text)
      if (command) {
        if (command.kind === 'stop') {
          const target = this.#resolveTarget(reply)
          if (!target.sessionId) return this.#echo(channelId, this.#noTargetText(target))
          const result = this.#injector.cancel(target.sessionId)
          return this.#echo(
            channelId,
            result.ok ? `已请求中止 ${this.#label(target.sessionId)}` : `中止失败：${result.reason}`,
          )
        }
        if (command.kind === 'detail') {
          const target = this.#resolveTarget(reply)
          if (!target.sessionId) return this.#echo(channelId, this.#noTargetText(target))
          this.#mode.setDetailed(target.sessionId, command.on)
          this.#scheduleSave()
          return this.#echo(
            channelId,
            command.on
              ? `${this.#label(target.sessionId)} 已升级为详细模式（回复 detail off 恢复精简）`
              : `${this.#label(target.sessionId)} 已恢复精简模式`,
          )
        }
        return this.#runCommand(channelId, command)
      }

      const target = this.#resolveTarget(reply)
      if (!target.sessionId) return this.#echo(channelId, this.#noTargetText(target))

      const delivered = this.#injector.deliver(target.sessionId, target.text)
      if (!delivered.ok) {
        return this.#echo(channelId, `发给 ${this.#label(target.sessionId)} 失败：${delivered.reason}`)
      }
      if (this.#config.routing.echoTarget) {
        const via =
          target.source === 'fallback-latest' || target.source === 'fallback-intervention'
            ? '（没有引用，按最新通知投递）'
            : ''
        return this.#echo(channelId, `已发给 ${this.#label(target.sessionId)}${via}`)
      }
      return
    } catch (error) {
      this.#log.error('处理入站消息失败', error)
    }
  }

  async #runCommand(channelId: string, command: ModeCommand): Promise<void> {
    switch (command.kind) {
      case 'show':
        return this.#echo(channelId, describeMode(this.#mode.snapshot(), (id) => this.#label(id)))
      case 'help':
        return this.#echo(channelId, helpText())
      case 'set-global':
        this.#mode.setMode('global')
        this.#persistMode()
        return this.#echo(channelId, '已切到全局模式：所有主会话的事件都会推送')
      case 'set-session': {
        const target = command.shortId ? this.#findSession(command.shortId) : undefined
        if (!target) {
          return this.#echo(
            channelId,
            command.shortId ? `找不到会话 ${command.shortId}` : '用法：/mode session <短id>',
          )
        }
        this.#mode.setMode('session', target)
        this.#persistMode()
        return this.#echo(channelId, `已绑定会话 ${this.#label(target)}，之后只推这一个会话`)
      }
      default:
        return
    }
  }

  // ── 入站：按钮 ──────────────────────────────────────────────────────────

  async #onAction(channelId: string, action: InboundAction): Promise<void> {
    try {
      const value = action.value

      // 审批 / 提问 / 计划确认：交给交互桥结算。
      if (isInteractionAction(value)) {
        const settlement = this.#bridge.settle(value)
        const text = settlement.ok
          ? (settlement.echo ?? '已处理')
          : `没有生效：${settlement.reason ?? '未知原因'}`
        await this.#echo(channelId, text)
        if (settlement.ok && action.messageId) {
          // 摘掉按钮并把正文改成结算态，避免用户重复点。
          await this.#channels.update(channelId, action.messageId, {
            body: `${text}（原请求已结算）`,
            actions: [],
          })
        }
        return
      }

      switch (value.kind) {
        case 'stop': {
          const result = this.#injector.cancel(value.sessionId)
          return this.#echo(
            channelId,
            result.ok ? `已请求中止 ${this.#label(value.sessionId)}` : `中止失败：${result.reason}`,
          )
        }
        case 'detail': {
          this.#mode.setDetailed(value.sessionId, true)
          this.#scheduleSave()
          return this.#echo(
            channelId,
            `${this.#label(value.sessionId)} 已升级为详细模式（回复 detail off 恢复精简）`,
          )
        }
        case 'goto':
          return this.#echo(
            channelId,
            `会话 ${this.#label(value.sessionId)} 的短 id 是 ${shortSessionId(value.sessionId)}。` +
              `在 Web 界面打开它，或直接回复「${shortSessionId(value.sessionId)} 你的话」定向投递。`,
          )
        case 'mode':
          return this.#runCommand(channelId, { kind: 'show' })
        default:
          return
      }
    } catch (error) {
      this.#log.error('处理按钮回调失败', error)
    }
  }

  // ── 路由 ────────────────────────────────────────────────────────────────

  #resolveTarget(reply: InboundReply): RouteResolution {
    return this.#route.resolve(
      {
        text: reply.text,
        ...(reply.quotedMessageId ? { quotedMessageId: reply.quotedMessageId } : {}),
        ...(reply.quotedText ? { quotedText: reply.quotedText } : {}),
      },
      { allowPrefix: this.#config.routing.allowPrefix, fallback: this.#config.routing.fallback },
    )
  }

  #noTargetText(resolution: RouteResolution): string {
    if (resolution.shortId) {
      return `找不到会话 ${resolution.shortId}——请核对短 id，或用「/mode」看看当前绑定。`
    }
    return '没有可投递的会话：还没有发出过任何通知，也没有绑定会话。'
  }

  #label(sessionId: string): string {
    const session = this.#sessionOf(sessionId)
    return `${projectName(session)} · ${shortSessionId(sessionId)}`
  }

  #sessionOf(sessionId: string): SessionLike | undefined {
    const cached = this.#sessions.get(sessionId)
    if (cached) return cached
    const session = this.#agentOf(sessionId)?.session as SessionLike | undefined
    if (session?.id) this.#sessions.set(sessionId, session)
    return session
  }

  #agentOf(sessionId: string): AgentLike | undefined {
    const agents = this.#host.agents
    if (!agents || typeof agents.get !== 'function') return undefined
    try {
      return agents.get(sessionId)
    } catch {
      return undefined
    }
  }

  #findSession(candidate: string): string | undefined {
    const needle = candidate.trim()
    if (needle.length === 0) return undefined
    const ids = new Set<string>([...this.#sessions.keys(), ...this.#route.knownSessions])
    for (const id of ids) if (matchesShortId(id, needle)) return id
    return undefined
  }

  // ── 模式持久化 ──────────────────────────────────────────────────────────

  #persistMode(): void {
    const snapshot = this.#mode.snapshot()
    const next: TlnotifyConfig = {
      ...this.#config,
      mode: snapshot.mode,
      session: {
        ...this.#config.session,
        ...(snapshot.targetSessionId ? { targetSessionId: snapshot.targetSessionId } : {}),
      },
    }
    this.#config = next
    if (!saveConfigFile(this.#dataDir, next)) {
      this.#log.warn('写入 config.json 失败，模式变更在重启后会丢失')
    }
    this.#scheduleSave()
  }

  // ── 回执 ────────────────────────────────────────────────────────────────

  /**
   * 在**收到消息的那个通道**上回一句话。
   *
   * 不走 `ChannelManager.send()`：那条路会做故障转移，回执跑到另一个通道上会
   * 让对话看起来断片。
   */
  async #echo(channelId: string, text: string): Promise<void> {
    const notification: Notification = {
      title: 'DSH · tlnotify',
      body: text,
      actions: [],
      level: 'info',
      sessionId: '',
      tag: `echo:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
      kind: 'echo',
    }
    await this.#channels.sendTo(channelId, notification)
  }

  // ── 状态落盘 ────────────────────────────────────────────────────────────

  #rememberInbound(messageId: string): void {
    this.#seenInbound.add(messageId)
    if (this.#seenInbound.size > SEEN_INBOUND_LIMIT) {
      const oldest = this.#seenInbound.values().next().value
      if (oldest !== undefined) this.#seenInbound.delete(oldest)
    }
    this.#scheduleSave()
  }

  #scheduleSave(): void {
    if (this.#disposed || this.#saveTimer) return
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined
      this.#saveState()
    }, STATE_SAVE_DEBOUNCE_MS)
    this.#saveTimer.unref?.()
  }

  #saveState(): void {
    const state: PersistedState = {
      version: 1,
      routes: this.#route.toJSON(),
      detailSessions: this.#mode.detailSessions,
      seenInbound: [...this.#seenInbound],
      lastMode: this.#mode.mode,
    }
    if (!writeJsonFile(statePath(this.#dataDir), state)) {
      this.#log.warn('写入 state.json 失败，路由表 / 模式在重启后会丢失')
    }
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function noop(): void {}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * `mode` 与 `session.targetSessionId` 是**运行时权威**字段。
 *
 * `/mode` 命令会写 config.json；下次启动必须让它盖过 GUI / 补丁里的旧值，
 * 否则用户改完模式一重启就丢。其余字段仍然遵守「显式配置 > 文件 > 默认」。
 */
function applyRuntimeOverrides(
  config: TlnotifyConfig,
  fromFile: Partial<TlnotifyConfig> | undefined,
): TlnotifyConfig {
  if (!fromFile) return config
  const out: TlnotifyConfig = { ...config }
  if (fromFile.mode === 'global' || fromFile.mode === 'session') out.mode = fromFile.mode
  const target = fromFile.session?.targetSessionId
  if (typeof target === 'string' && target.length > 0) {
    out.session = { ...out.session, targetSessionId: target }
  }
  return out
}

function readState(dataDir: string): PersistedState {
  const raw = readJsonFile<Partial<PersistedState>>(statePath(dataDir))
  const detailSessions = raw?.detailSessions
  const seenInbound = raw?.seenInbound
  return {
    version: 1,
    routes: raw?.routes ?? { byMessage: {}, byThread: {}, byRefIdx: {}, byContent: {} },
    detailSessions: Array.isArray(detailSessions) ? detailSessions.filter((id) => typeof id === 'string') : [],
    seenInbound: Array.isArray(seenInbound) ? seenInbound.filter((id) => typeof id === 'string') : [],
    ...(raw?.lastMode ? { lastMode: raw.lastMode } : {}),
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx: Context, config: Partial<TlnotifyConfig> = {}): () => void {
  const runtime = new Tlnotify(ctx, config)
  void runtime.start().catch((error: unknown) => {
    const host = ctx as unknown as TlnotifyHost
    host.logger?.error?.('[tlnotify] 启动失败', error)
  })
  // Cordis 会丢弃 apply 的返回值，真正生效的是内部 ctx.on('dispose')；
  // 这里返回幂等 dispose 是为了测试与消费返回值的宿主。
  return () => {
    void runtime.dispose()
  }
}

export type { TlnotifyConfig } from './types.js'
export type { ActionValue, ChannelLogger, InboundAction, InboundReply } from './types.js'
