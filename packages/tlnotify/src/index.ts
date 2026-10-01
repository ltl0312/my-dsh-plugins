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
import { Config, configPath, ensureDir, mergeConfig, persistEffectiveConfig, readConfigFile, readJsonFile, resolveDataDir, saveConfigFile, statePath, writeJsonFile } from './config.js'
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
import {
  applyPatch,
  createBindToken,
  deriveBindLink,
  explainTestFailure,
  fail,
  ok,
  redactChannel,
  redactConfig,
  redactText,
} from './rpc.js'
import {
  BIND_TTL_MS,
  RPC_CHANNEL,
  RPC_METHODS,
  type BindPayload,
  type PatchPayload,
  type PendingBind,
  type QrPayload,
  type RpcMethod,
  type RpcResult,
  type StatePayload,
  type TestPayload,
} from './protocol.js'

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

/**
 * 宿主「客户端连接」服务的 cordis 服务名。
 *
 * ⚠️ 是 `client-connection`，**不是** `connection`：后者（见
 * `@deepseek-ai/dsh-client-connection/lib/client.js` 的 `ctx.provide("connection", …)`）
 * 是**浏览器半边**的名字，宿主上根本不存在。
 */
const CONNECTION_SERVICE = 'client-connection'
/** 客户端连接服务可能排在本插件之后装载；取不到时按这个间隔再试。 */
const RPC_RETRY_INTERVAL_MS = 500
/** 重试上限（40 × 500ms ≈ 20s）；超过就认定这个宿主没有 Web 半边，只警告一次。 */
const RPC_RETRY_LIMIT = 40

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
  /**
   * 客户端 RPC 通道；Web 半边没装或非 Web 部署时不存在。
   *
   * ⚠️ **绝不要写 `ctx.connection` 去取它**：cordis 的 Context 是个 Proxy，
   * 读一个既不是自有属性、又没被 `inject` 声明、store 里也没有的服务名时它会
   * **抛错**而不是返回 undefined（`@deepseek-ai/cordis/lib/index.js:676`：
   * `cannot get property "${prop}" without inject`），`?.` 挡不住抛异常的 getter。
   * 取服务统一走 `#connection()`。
   */
  connection?: HostConnectionLike
  /**
   * cordis 反射服务的取值入口（`ctx.get(name)`）。
   *
   * 契约（`@deepseek-ai/cordis/lib/index.js:755-772`）：「Read a service from the
   * store without the inject requirement」、**取不到时返回 `undefined` 而不抛**。
   */
  get?: (name: string) => unknown
}

/**
 * `ctx.connection` 的结构化视图（真实的类型在 `@deepseek-ai/dsh-client-connection`
 * 里，插件不依赖那个包，所以只描述用到的那一个方法）。
 *
 * 契约：`handle(channel, handler)` 注册一个「已鉴权的绝对通道前缀」，
 * handler 收到 `(endpoint, payload, signal, peer)`，返回
 * `{ok:true,value} | {ok:false,error}`；返回的函数用来注销。
 */
interface HostConnectionLike {
  rpc?: HostConnectionRpcLike
}

interface HostConnectionRpcLike {
  handle(
    channel: string,
    handler: (
      endpoint: string,
      payload: unknown,
      signal: AbortSignal,
      peer: unknown,
    ) => Promise<unknown>,
  ): () => Promise<void>
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
  /** 事件源与通道是否已经挂上（`enabled` 从 false 翻成 true 时会补挂）。 */
  #attached = false
  /** 进程内累计推送条数；设置页底部的「已推送 N 条」用它。 */
  #pushed = 0
  readonly #startedAt = Date.now()
  /** 正在等待的扫码绑定；同一时刻只允许一个（多标签页抢绑没有意义）。 */
  #pendingBind: PendingBind | undefined = undefined
  /** 绑定期间从 IM 侧观察到的发送者 id；等设置页来 `bind` 取走时才落盘。 */
  #bindObserved: { channelId: string; targetId: string } | undefined = undefined
  #unregisterRpc: (() => Promise<void>) | undefined = undefined
  /** 等待客户端连接服务就绪的重试定时器（见 `#scheduleRpcRetry`）。 */
  #rpcTimer: ReturnType<typeof setTimeout> | undefined = undefined
  #rpcRetries = 0

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
    // 设置页 RPC 必须**先**挂上，而且与 enabled 无关：总开关关掉的时候，
    // 用户唯一的自救手段就是打开设置页把它打开。若这里跟着 enabled 一起提前
    // 返回，关一次就再也开不回来（只能手动去改 config.json）。
    this.#installRpc()

    if (!this.#config.enabled) {
      this.#log.info('tlnotify 已禁用（enabled=false），不启动任何通道')
      return
    }
    await this.#attachRuntime()
  }

  /**
   * 挂上事件源与通道。
   *
   * 抽出来是因为 `enabled` 可以在运行时从 false 翻成 true（设置页的总开关），
   * 那时也要走完全相同的挂载流程；`#attached` 保证只挂一次。
   */
  async #attachRuntime(): Promise<void> {
    if (this.#attached) return
    this.#attached = true

    // 先装交互钩子、再连通道：慢连接不该让审批 / 提问的钩子缺失。
    this.#bridge.install(this.#bus)
    this.#disposers.push(
      this.#bus.on('session/event', (session, event) =>
        this.#onSessionEvent(session as SessionLike, event as SessionEventLike),
      ) ?? noop,
    )
    this.#disposers.push(this.#bus.on('dispose', () => void this.dispose()) ?? noop)

    await this.#channels.start(this.#config.channels, this.#config.defaultChannelId)
    this.#logReady()
  }

  #logReady(): void {
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
    await this.#uninstallRpc()
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
    if (this.#rpcTimer) {
      clearTimeout(this.#rpcTimer)
      this.#rpcTimer = undefined
    }
    this.#saveState()
    await this.#channels.stop()
    this.#log.info('tlnotify 已卸载')
  }

  // ── 设置页 RPC ──────────────────────────────────────────────────────────

  /**
   * 挂上浏览器半边的 RPC 通道。
   *
   * 用宿主原生的 `client-connection` 服务的 `rpc.handle`，而不是自建 HTTP 路由：
   * 鉴权、Host / Origin 校验、请求体上限、只允许 loopback 全由 Connection 负责，
   * 设置页方案 §4.3 的安全约束因此天然成立，插件不需要自己再实现一遍（实现一遍
   * 就多一处漏）。
   *
   * 宿主没装 `dsh-client-connection` 时这里只是少一个设置页，插件其余部分照常
   * 工作——所以降级路径是 warn 而不是抛错。
   *
   * ⚠️ 历史上这里写的是 `this.#host.connection?.rpc`，它会在 cordis 的 Context
   * Proxy 上抛 `cannot get property "connection" without inject`——`start()` 因此
   * 在写出第一行 plugin.log **之前**就 reject，表现为「设置页永远停在『正在读取
   * 配置…』、plugin.log 一行都没有」。取服务必须走 `#connection()`。
   */
  #installRpc(): void {
    if (this.#unregisterRpc) return // 幂等：重复调用不重复注册
    const rpc = this.#connection()?.rpc
    if (!rpc || typeof rpc.handle !== 'function') {
      this.#scheduleRpcRetry()
      return
    }
    try {
      this.#unregisterRpc = rpc.handle(RPC_CHANNEL, (endpoint, payload) => this.#rpcHandle(endpoint, payload))
      this.#rpcRetries = 0
      this.#log.debug(`设置页 RPC 已挂载：${RPC_CHANNEL}`)
    } catch (error) {
      this.#log.warn('挂载设置页 RPC 失败（设置页不可用，插件其余功能不受影响）', error)
    }
  }

  /**
   * 安全地取宿主「客户端连接」服务；取不到返回 `undefined`，**任何情况下都不抛**。
   *
   * 两条路径都被证明是安全的：
   *   ① `ctx.get(name)`——反射服务提供的入口，注释原文「Read a service from the
   *      store without the inject requirement … or `undefined` when not (yet)
   *      provided」；
   *   ② `ctx[name]`——服务真的在 store 里时 Proxy 顺着 fiber 链能解析出来，但
   *      取不到时会抛，所以整段包在 try/catch 里兜住。
   */
  #connection(): HostConnectionLike | undefined {
    const host = this.#host
    try {
      if (typeof host.get === 'function') {
        const viaGet = host.get(CONNECTION_SERVICE)
        if (viaGet) return viaGet as HostConnectionLike
      }
    } catch {
      // 取服务本身出错＝这个宿主没有客户端半边，降级到「直接改 config.json」。
    }
    try {
      const viaProp = (host as unknown as Record<string, unknown>)[CONNECTION_SERVICE]
      if (viaProp) return viaProp as HostConnectionLike
    } catch {
      // 同上：Proxy 抛错不是异常情况，是「没有这个服务」的正常表达方式。
    }
    return undefined
  }

  /**
   * 客户端连接服务排在本插件之后装载时，等它就绪再挂 RPC。
   *
   * bundle 层是按包名顺序组合的，插件之间没有装载顺序保证；`ctx.get` 在 strict
   * 模式下一个还没 ACTIVE 的服务会返回 `undefined`，所以「第一次取不到」不能当
   * 判决。重试到上限才认定这个宿主真的没有 Web 半边。
   */
  #scheduleRpcRetry(): void {
    if (this.#disposed || this.#rpcTimer) return
    if (this.#rpcRetries >= RPC_RETRY_LIMIT) {
      this.#log.warn(
        `宿主没有提供客户端 RPC 通道（${CONNECTION_SERVICE}），设置页不可用；可以直接编辑 ${join(this.#dataDir, 'config.json')}`,
      )
      return
    }
    this.#rpcRetries += 1
    const timer = setTimeout(() => {
      this.#rpcTimer = undefined
      if (this.#disposed) return
      this.#installRpc()
    }, RPC_RETRY_INTERVAL_MS)
    // 不让这个定时器拖住进程退出（探针脚本、`dsh rescue` 这类短命进程）。
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.#rpcTimer = timer
  }

  async #uninstallRpc(): Promise<void> {
    const unregister = this.#unregisterRpc
    this.#unregisterRpc = undefined
    if (!unregister) return
    try {
      await unregister()
    } catch (error) {
      this.#log.warn('注销设置页 RPC 时出错（已隔离）', error)
    }
  }

  async #rpcHandle(endpoint: string, payload: unknown): Promise<unknown> {
    const method = String(endpoint ?? '').replace(/^\/+/, '') as RpcMethod
    if (!RPC_METHODS.includes(method)) {
      return fail('unknown-method', `未知的设置页方法：${endpoint}`, { expected: [...RPC_METHODS] })
    }
    try {
      switch (method) {
        case 'state':
          return ok(this.#rpcState())
        case 'patch':
          return await this.#rpcPatch(payload)
        case 'test':
          return await this.#rpcTest(payload)
        case 'qr':
          return this.#rpcQr(payload)
        case 'bind':
          return await this.#rpcBind(payload)
        default:
          return fail('unknown-method', `未知的设置页方法：${endpoint}`, { expected: [...RPC_METHODS] })
      }
    } catch (error) {
      // 任何内部异常都不该把堆栈原样丢给浏览器：里面可能带凭据或完整 URL。
      const message = error instanceof Error ? error.message : String(error)
      this.#log.warn(`设置页 RPC「${method}」出错`, error)
      return fail('internal-error', redactText(message), {})
    }
  }

  #rpcState(): StatePayload {
    const mode = this.#mode.snapshot()
    return {
      config: redactConfig(this.#config, this.#dataDir),
      status: {
        running: this.#attached && !this.#disposed,
        enabled: this.#config.enabled,
        mode: mode.mode,
        ...(mode.targetSessionId ? { targetSessionId: mode.targetSessionId } : {}),
        detailSessions: [...mode.detailSessions],
        pushed: this.#pushed,
        startedAt: this.#startedAt,
        dataDir: this.#dataDir,
        configPath: configPath(this.#dataDir),
        statePath: statePath(this.#dataDir),
        ...(this.#pendingBind ? { pendingBind: { ...this.#pendingBind } } : {}),
        channels: this.#channels.statuses.map((status) => ({ ...status })),
      },
    }
  }

  async #rpcPatch(payload: unknown): Promise<RpcResult<PatchPayload>> {
    const outcome = applyPatch(this.#config, payload)
    if (!outcome.ok) return outcome

    const { next, changed, channelsChanged } = outcome.value
    if (changed.length === 0) {
      return ok({ applied: 'hot', changed: [], config: redactConfig(this.#config, this.#dataDir) })
    }

    // 先落盘再应用。反过来的话，写盘失败就留下「界面说改了、重启后没改」的状态，
    // 而用户没有任何线索。
    try {
      saveConfigFile(this.#dataDir, next)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#log.warn('保存 config.json 失败', error)
      return fail('save-failed', `配置没有保存成功：${redactText(message)}`, {
        path: configPath(this.#dataDir),
      })
    }

    const previous = this.#config
    this.#config = next

    if (next.logLevel !== previous.logLevel) this.#log.setLevel(next.logLevel)

    // 运行模式 / 绑定会话：配置是权威来源，内存态跟着它走。
    const mode = this.#mode.snapshot()
    if (next.mode !== mode.mode || (next.session.targetSessionId ?? undefined) !== mode.targetSessionId) {
      this.#mode.setMode(next.mode, next.session.targetSessionId)
    }

    let channelsReloaded = false
    if (next.enabled !== previous.enabled) {
      // 总开关翻转。关的时候只停通道、不摘事件源：`#shouldPush` 已经会拦住所有
      // 推送，而重新挂 `InteractionBridge` 要动宿主 waterfall，能不动就不动。
      if (next.enabled && !this.#attached) {
        await this.#attachRuntime()
        channelsReloaded = true
      } else if (this.#attached) {
        if (next.enabled) {
          await this.#channels.start(next.channels, next.defaultChannelId)
          channelsReloaded = true
        } else {
          await this.#channels.stop()
        }
      }
    } else if (channelsChanged && this.#attached) {
      // 通道表变了：整表重建，否则删掉的通道还会继续发、新通道永远不启动。
      await this.#channels.stop()
      if (next.enabled) {
        await this.#channels.start(next.channels, next.defaultChannelId)
        channelsReloaded = true
      }
    }

    this.#scheduleSave()
    this.#log.info(`设置页已更新配置：${changed.join(', ')}`)
    return ok({
      applied: 'hot',
      changed,
      config: redactConfig(this.#config, this.#dataDir),
      ...(channelsReloaded ? { channelsReloaded } : {}),
    })
  }

  async #rpcTest(payload: unknown): Promise<RpcResult<TestPayload>> {
    const requested = this.#channelIdOf(payload)
    const target =
      requested ?? this.#config.defaultChannelId ?? this.#config.channels.find((c) => c.enabled)?.id
    if (!target) {
      return fail('no-channel', '还没有可用的通道。请先填好凭据并勾选「启用」。', {})
    }
    const channel = this.#config.channels.find((item) => item.id === target)
    if (!channel) {
      return fail('no-channel', `配置里没有 id 为「${target}」的通道。`, { channelId: target })
    }
    if (!this.#channels.has(target)) {
      return fail(
        'channel-unavailable',
        `通道「${target}」当前没有启动。请检查凭据是否填全，以及总开关是否打开。`,
        { channelId: target },
      )
    }

    const notification: Notification = {
      title: 'DSH · tlnotify · 测试消息',
      body: '这条消息走的是和真实通知完全相同的发送路径。你能看到它，就说明凭据和目标 id 都是对的。',
      actions: [],
      level: 'info',
      sessionId: '',
      tag: `test:${Date.now()}`,
      kind: 'echo',
    }

    const started = Date.now()
    try {
      const result = await this.#channels.sendTo(target, notification)
      if (!result) {
        return fail('send-failed', '通道没有返回消息 id，消息很可能没有送达。', { channelId: target })
      }
      return ok({
        channelId: result.channelId,
        messageId: result.messageId,
        shards: result.shards,
        summary: `已送达（${channel.type}，${result.shards} 片，${Date.now() - started} ms）。`,
      })
    } catch (error) {
      // `sendTo` 自己只记状态不吞异常，所以这里能拿到平台原始报错去翻译成人话。
      const raw = error instanceof Error ? error.message : String(error)
      const hint = explainTestFailure(raw)
      this.#log.warn(`测试消息发送失败（通道 ${target}）`, error)
      return fail('send-failed', hint.advice, { channelId: target, raw: hint.raw })
    }
  }

  #rpcQr(payload: unknown): RpcResult<QrPayload> {
    const requested = this.#channelIdOf(payload)
    const target = requested ?? this.#config.defaultChannelId ?? this.#config.channels[0]?.id
    const channel = target ? this.#config.channels.find((item) => item.id === target) : undefined
    if (!channel) {
      return fail('no-channel', '还没有可用的通道。先在「通道」里添加一个。', {})
    }

    const link = deriveBindLink(channel)
    if (!link.qrText) {
      // 推不出来就不画二维码——画一个扫不开的码比不画更浪费时间。
      return fail('no-bind-link', link.missing ?? '这个通道没有可用的绑定链接。', {
        channelId: channel.id,
      })
    }

    const token = createBindToken()
    const expiresAt = Date.now() + BIND_TTL_MS
    this.#pendingBind = { channelId: channel.id, token, expiresAt }
    this.#bindObserved = undefined

    return ok({
      channelId: channel.id,
      type: channel.type,
      token,
      expiresAt,
      qrText: link.qrText,
      derived: link.derived,
      instructions:
        channel.type === 'feishu'
          ? '用飞书扫这个码打开机器人，随便发一句话（比如「绑定」）。设置页会自己拿到你的 open_id。'
          : '用 QQ 扫这个码打开机器人并发送「绑定」。若这个码打不开机器人，请到 QQ 开放平台复制机器人的分享链接，粘进上面的「绑定链接」再试。',
    })
  }

  async #rpcBind(payload: unknown): Promise<RpcResult<BindPayload>> {
    const raw = (payload ?? {}) as Record<string, unknown>
    const token = typeof raw.token === 'string' ? raw.token : ''
    const requested = this.#channelIdOf(payload)
    const pending = this.#pendingBind

    if (!pending || (requested && requested !== pending.channelId)) {
      return fail('no-pending-bind', '没有正在等待的绑定。请重新点「扫码绑定」生成一个新的。', {})
    }
    if (token !== pending.token) {
      return fail('bad-token', '绑定令牌对不上。请重新点「扫码绑定」生成一个新的。', {})
    }
    if (Date.now() > pending.expiresAt) {
      this.#pendingBind = undefined
      this.#bindObserved = undefined
      return ok({ bound: false, expired: true })
    }

    const observed = this.#bindObserved
    if (!observed || observed.channelId !== pending.channelId) {
      // 人还没在 IM 里说话：这是正常的轮询结果，不是错误。
      return ok({ bound: false, expired: false })
    }

    const channel = this.#config.channels.find((item) => item.id === pending.channelId)
    if (!channel) {
      return fail('no-channel', `通道「${pending.channelId}」已经不在配置里了。`, {
        channelId: pending.channelId,
      })
    }

    const field: 'targetChatId' | 'feishuReceiveId' = channel.type === 'qq' ? 'targetChatId' : 'feishuReceiveId'
    const next: TlnotifyConfig = {
      ...this.#config,
      channels: this.#config.channels.map((item) => {
        if (item.id !== channel.id) return item
        return field === 'targetChatId'
          ? { ...item, targetChatId: observed.targetId }
          : { ...item, feishuReceiveId: observed.targetId }
      }),
    }

    try {
      saveConfigFile(this.#dataDir, next)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#log.warn('扫码绑定写配置失败', error)
      return fail('save-failed', `已拿到目标 id，但配置没保存下来：${redactText(message)}`, {
        path: configPath(this.#dataDir),
      })
    }

    this.#config = next
    this.#pendingBind = undefined
    this.#bindObserved = undefined

    // 目标 id 变了必须重建通道，否则「测试连接」还会往旧目标发。
    if (this.#attached && this.#config.enabled) {
      await this.#channels.stop()
      await this.#channels.start(this.#config.channels, this.#config.defaultChannelId)
    }

    this.#log.info(`扫码绑定完成：通道「${channel.id}」的 ${field} = ${observed.targetId}`)
    return ok({ bound: true, targetId: observed.targetId, field, expired: false })
  }

  /**
   * 扫码绑定的收信侧：人在 IM 里发的第一句话就是「我是谁」的证明。
   *
   * 只有当前有待绑请求、通道对得上、没超时、且带得出 senderId 时才认。这里**不写
   * 配置**——用户可能只是随手发条消息试试；真正落盘要等设置页来 `bind` 确认。
   *
   * @returns 是否吃掉了这条入站消息（吃掉就不再走路由）。
   */
  #observeBind(channelId: string, reply: InboundReply): boolean {
    const pending = this.#pendingBind
    if (!pending || pending.channelId !== channelId) return false
    if (Date.now() > pending.expiresAt) return false
    const senderId = reply.senderId?.trim()
    if (!senderId) return false
    this.#bindObserved = { channelId, targetId: senderId }
    this.#log.info(`扫码绑定：通道「${channelId}」收到来自 ${senderId} 的消息`)
    return true
  }

  #channelIdOf(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined
    const value = (payload as Record<string, unknown>).channelId
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
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
    this.#pushed += 1
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

      // 扫码绑定期间的第一句话既不是命令也不是回复，是「我是谁」的证明。
      if (this.#observeBind(channelId, reply)) {
        await this.#echo(channelId, '已记下你的账号。回到设置页点「完成绑定」即可。')
        return
      }

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
  let runtime: Tlnotify
  try {
    runtime = new Tlnotify(ctx, config)
  } catch (error) {
    // 构造失败也绝不能把异常抛给宿主：客户端半边 apply 抛错会把整个 web boot
    // 拖垮，宿主半边抛错会让同层的其它插件一起失败。
    reportStartupFailure(ctx, config, '初始化失败', error)
    return () => {}
  }
  void runtime.start().catch((error: unknown) => {
    reportStartupFailure(ctx, config, '启动失败', error)
  })
  // Cordis 会丢弃 apply 的返回值，真正生效的是内部 ctx.on('dispose')；
  // 这里返回幂等 dispose 是为了测试与消费返回值的宿主。
  return () => {
    void runtime.dispose()
  }
}

/**
 * 把启动失败写进 `plugin.log`。
 *
 * 为什么不能只依赖 `host.logger.error`：**DSH 宿主自己不落任何日志文件**——本机
 * `~/.dsh` 下只有 tlmemory 的抽取日志与插件市场的 `log.ndjson`，宿主 stdout 也没
 * 有被重定向。上一次「设置页永远停在『正在读取配置…』」之所以查了很久，正是因为这
 * 条唯一线索去了一个没人接收的地方（`plugin.log` 一行都没写、目录 mtime 也没变）。
 * 所以这里自己开一个 logger 直接落盘，宿主 logger 只当附带。
 */
function reportStartupFailure(
  ctx: Context,
  config: Partial<TlnotifyConfig>,
  stage: string,
  error: unknown,
): void {
  try {
    const dataDir = resolveDataDir(config)
    ensureDir(dataDir)
    const logger = new FileLogger(joinLog(dataDir), config.logLevel ?? 'info')
    logger.error(`[tlnotify] ${stage}`, error)
  } catch {
    // 连落盘都失败时无能为力——至少不让这个错误本身再炸一次。
  }
  try {
    const host = ctx as unknown as TlnotifyHost
    host.logger?.error?.(`[tlnotify] ${stage}`, error)
  } catch {
    // 同上：读 `ctx.logger` 本身也可能被 Proxy 抛（宿主没提供 logger 时）。
    // 这里在「报告失败」的路径上，绝不能再制造第二个异常。
  }
}

export type { TlnotifyConfig } from './types.js'
export type { ActionValue, ChannelLogger, InboundAction, InboundReply } from './types.js'
