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
  ChannelConfig,
  InboundAction,
  InboundReply,
  Notification,
  PersistedState,
  RawEvent,
  TlnotifyConfig,
  TurnSnapshot,
} from './types.js'
import { INTERVENTION_KINDS } from './types.js'
import { Config, configPath, ensureDir, mergeConfig, persistEffectiveConfig, readConfigFile, readJsonFile, resolveChannelSettings, resolveDataDir, saveConfigFile, statePath, writeJsonFile } from './config.js'
import { FileLogger, joinLog, type HostLogger } from './log.js'
import {
  extractToolCallEvents,
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
import { describeChannelScope, helpText, ModeState, parseCommand, type ModeCommand } from './mode.js'
import { InteractionBridge, isInteractionAction, matchAnswer, SessionInjector, type AgentLike, type AnswerTarget, type PendingSettlement } from './inject.js'
import { ChannelManager } from './channels/index.js'
import { channelCaresAboutSession, channelSessionScope } from './config.js'
import { ProvisionManager, type ProvisionCredentials } from './provision.js'
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
  RPC_METHODS,
  RPC_ROUTE_PREFIX,
  rpcRoutePath,
  type BindPayload,
  type ChannelSessionSummary,
  type PatchPayload,
  type PendingBind,
  type ProvisionSnapshot,
  type QrPayload,
  type RpcMethod,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
  type RpcResult,
  type SessionListPayload,
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
/** 攥住的作答最多认多久（超时后按普通发言注入，免得消息石沉大海）。 */
const WAITING_ANSWER_TTL_MS = 3 * 60 * 1000
/** 攥住的作答等不到 pending 时，多久之后退回「注入成普通发言」。 */
const WAITING_ANSWER_FALLBACK_MS = 60 * 1000

/**
 * 最近一条等待类通知，以及它攥住的答案。
 *
 * 现场（用户 m04327 复验）：`tool/call` 那条路先把「等待我回答」发了出去，用户立刻在
 * QQ 里回「1」——那一刻 `InteractionBridge.#pending` 里什么都没有，于是这句话被当普通
 * 发言注入（用户看到的就是「回复的文本在对话框上面，像是一个补充语句」），**50 秒后**
 * waterfall 才跑、pending 才出现，用户只好再回一次。
 *
 * 所以「像作答」的文本先攥在这里，`#onPending` 一进来就替他答（见 `#consumeHeldAnswer`）。
 * 拿不准的一律不攥（照常注入）——宁可少答一次，也不要把用户跟模型说的话吞掉。
 */
interface WaitingIntervention {
  at: number
  /** 只有等待类事件（`INTERVENTION_KINDS`）才记，所以这里是窄化的三种。 */
  kind: AnswerTarget['kind']
  labels: string[]
  multiSelect?: boolean
  /** 攥住的文本作答。 */
  text?: string
  /** 用户是从哪台机器人答的（结算后回显到那台）。 */
  channelId?: string
  timer?: ReturnType<typeof setTimeout>
}

/**
 * 宿主「客户端连接」服务的 cordis 服务名。
 *
 * ⚠️ **是 `connection`，不是 `client-connection`**。两个名字的权威出处：
 *   - 服务名：`@deepseek-ai/dsh-client-connection/lib/index.js:566`——`HostConnectionService`
 *     的构造函数写的是 `super(ctx, "connection")`；
 *   - 第一方用法：`@deepseek-ai/dsh-api-gateway/lib/types/index.js:83`
 *     `ctx.inject(['connection'], (c) => c.connection.rpc.intercept(…))`，以及同文件
 *     `:286` 的 `this.ctx.get('connection')`；
 *   - 而 `dsh-client-connection/lib/index.js:788` 的 `const name = "client-connection"`
 *     只是该 cordis 插件自己的**模块名**（注释原文「Stable Cordis plugin name.」），
 *     与服务名无关。
 *
 * 曾经误用后者：`ctx.get('client-connection')` 永远返回 `undefined`，40 次重试全部
 * 落空，设置页永远停在「正在读取配置…」。`tests/install-rpc.spec.ts` 现在锁死这一点。
 */
const CONNECTION_SERVICE = 'connection'

/**
 * 宿主「会话清单」服务的名字（设置页「选会话」用）。
 *
 * 出处：`@deepseek-ai/dsh-api-session-controller/lib/index.js:2847`
 * `super(ctx, "sessionController", { namespace: "session" })`；同文件 `:2954` 的
 * `async list(_request, signal) { return { items: await this.listState.list(signal) } }`
 * 是**本进程内的真实实现**（不是远程桩），所以能直接调它的 `list()`。
 * 官方生态里 dsh-im 的宿主也是注入这两个服务（`plugin-src/host/index.mjs:110`
 * `['sessionController', 'workspaceController']`）。
 *
 * 与 `connection` 一样**不进插件级 `inject`**：那是激活门，headless 或不带这套
 * 服务的部署会整插件不激活。取不到就是「列不出会话」，设置页退回手填会话 id。
 */
const SESSION_CONTROLLER_SERVICE = 'sessionController'

/**
 * 取服务失败后的重试间隔。
 *
 * bundle 层是按包名顺序组合的，插件之间没有装载顺序保证；`ctx.get` 在 strict 模式
 * 下一个还没 ACTIVE 的服务会返回 `undefined`，所以「第一次取不到」不能当判决。
 */
const RPC_RETRY_INTERVAL_MS = 500
/** 重试上限（40 × 500ms ≈ 20s）；超过只警告一次，不刷日志。 */
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
   * 取服务统一走 `readConnectionFetch()`（模块级函数）。
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
 * `connection` 服务的结构化视图（真实类型在 `@deepseek-ai/dsh-client-connection`
 * 里，插件不依赖那个包，所以只描述用到的那一面）。
 */
interface HostConnectionLike {
  fetch?: HostConnectionFetchLike
  rpc?: unknown
}

/**
 * `connection.fetch` 的注册面——插件把 HTTP 端点交给浏览器半边的**官方通道**。
 *
 * 为什么只用它、不用同级的 `connection.rpc.handle`，见 `#installRpc` 的注释。
 */
interface HostConnectionFetchLike {
  /** 注册一条路由，返回注销函数。路径必须挂在 `/api/` 下。 */
  register(route: HostFetchRoute): unknown
}

/** 一条 exact Fetch 路由（`registerFetchRoute` 入参的形状）。 */
interface HostFetchRoute {
  path: string
  methods: readonly string[]
  /** Connection 只把它原样存进路由表；带上以对齐 dsh-im 的用法。 */
  requestBody?: 'buffered' | 'stream'
  fetch(request: HostFetchRequestLike): unknown
}

/** 我们真正用到的那两个 `Request` 成员（Node 18+ 的 Web 标准 Request）。 */
interface HostFetchRequestLike {
  method: string
  json(): Promise<unknown>
}

/**
 * Node 18+ 的全局 `Response`。
 *
 * 宿主 tsconfig 不带 DOM，所以这里只声明用到的那一个静态方法（模块级声明会遮蔽
 * 全局同名声明，与 `@types/node` 自带的 undici 类型不冲突）。
 */
declare const Response: {
  json(body: unknown, init?: { status?: number; headers?: Record<string, string> }): unknown
}

/**
 * 安全地取宿主「客户端连接」服务的 **fetch 注册面**；取不到返回 `undefined`，
 * **任何情况下都不抛**。
 *
 * 两条路径都是安全的：
 *   ① `ctx.get(name)` —— 反射服务的取值入口，注释原文（`@deepseek-ai/cordis/lib/index.js:755-772`）
 *      「Read a service from the store without the inject requirement … or `undefined`
 *      when not (yet) provided」，未就绪时返回 `undefined`；
 *   ② `ctx[name]` —— 服务真在 store 里时 Proxy 顺着 fiber 链能解析出来，但取不到时
 *      **会抛**，所以整段包在 try/catch 里兜住（见 `TlnotifyHost.connection` 的注释）。
 *
 * 只返回 `fetch.register` 可用的服务：拿到服务却没有注册面，跟没拿到是同一件事——
 * 都只能降级成「直接改 config.json」。
 */
function readConnectionFetch(ctx: TlnotifyHost): HostConnectionFetchLike | undefined {
  let service: HostConnectionLike | undefined
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(CONNECTION_SERVICE)
      if (viaGet) service = viaGet as HostConnectionLike
    }
  } catch {
    // 取服务本身抛错＝这个宿主没有客户端半边，降级。
  }
  if (!service) {
    try {
      const viaProperty = (ctx as unknown as Record<string, unknown>)[CONNECTION_SERVICE]
      if (viaProperty) service = viaProperty as HostConnectionLike
    } catch {
      // Proxy 抛错不是异常情况，是「没有这个服务」的正常表达方式。
    }
  }
  const fetch = service?.fetch
  return fetch && typeof fetch.register === 'function' ? fetch : undefined
}

// ---------------------------------------------------------------------------
// 会话列表（设置页「选会话」用）
// ---------------------------------------------------------------------------

/**
 * 宿主会话清单服务的最小视图。
 *
 * 真正的服务是 `@deepseek-ai/dsh-api-session-controller` 的 `sessionController`
 * （`lib/index.js:2847` `super(ctx, "sessionController", { namespace: "session" })`），
 * 它的 `list()`（`:2954`）是本进程内的真实实现、不是远程桩，所以能直接调。
 * 官方生态里 dsh-im 也是这么注入的（`plugin-src/host/index.mjs:110`）。
 *
 * 只要这两样：能列出、能 await。字段一律按 `unknown` 读——这个服务是别的包提供
 * 的，形状变了应该降级成「列不出来」，而不是让设置页整页崩掉。
 */
interface HostSessionControllerLike {
  list?: (request: unknown, signal?: unknown) => unknown
}

/** 一行会话摘要（宿主侧的 `SessionSummary`，只声明我们读的那几个字段）。 */
interface HostSessionSummaryLike {
  sessionId?: unknown
  updatedAt?: unknown
  running?: unknown
  origin?: unknown
  cwd?: unknown
  projections?: unknown
}

/**
 * 安全地取宿主会话清单服务；取不到返回 `undefined`，**任何情况下都不抛**。
 *
 * 与 `readConnectionFetch()` 同一个道理：`ctx.get` 未就绪返回 `undefined`，
 * 属性访问取不到会抛，所以整段 try/catch。这里**不重试、不警告**——设置页点
 * 「刷新」会重新调一次，比后台轮询更贴近实际需要。
 */
function readSessionController(ctx: TlnotifyHost): HostSessionControllerLike | undefined {
  try {
    if (typeof ctx.get !== 'function') return undefined
    const service = ctx.get(SESSION_CONTROLLER_SERVICE) as HostSessionControllerLike | undefined
    return service && typeof service.list === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

/** 从 `projections.values.title` 里读标题——宿主列表行本身没有 title 字段。 */
function sessionTitleOf(summary: HostSessionSummaryLike): string {
  const projections = summary.projections
  if (!projections || typeof projections !== 'object') return ''
  const values = (projections as { values?: unknown }).values
  if (!values || typeof values !== 'object') return ''
  const title = (values as Record<string, unknown>).title
  return typeof title === 'string' ? title.trim() : ''
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
  /**
   * 「扫码创建 QQ 机器人」的会话表（`provision.begin/poll/cancel`）。
   *
   * 生命周期与插件一致：构造时建、`dispose()` 时清。放在这里而不是按需 new，
   * 是因为每次 `begin` 都会起一个还在向腾讯轮询的会话，必须有一个确定的收口点。
   */
  readonly #provision: ProvisionManager
  readonly #sessions = new Map<string, SessionLike>()
  readonly #claimedRequests = new Set<string>()
  /**
   * 已经**投递过通知**的等待请求 id。
   *
   * 同一条等待会从两条路进来：`session/event` 的 `tool/call`（`#maybePending`，用真实
   * `seq` 去重）和 InteractionBridge 的 waterfall（`#onPending`，用 requestId 合成的负数
   * `seq` 去重）。两者的去重键不同，于是同一条「等待我回答」被投了两遍（现场日志里
   * 05:51:18 与 05:51:19 就是这样一对）。这里按 requestId 兜一层，谁先到谁发。
   */
  readonly #deliveredRequests = new Set<string>()
  /** 每个会话最近一条等待类通知，以及「提问还没准备好」时攥住的作答（见 `WaitingIntervention`）。 */
  readonly #waiting = new Map<string, WaitingIntervention>()
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
  /** 注销所有端点路由的函数（`fetch.register` 的返回值汇总）。 */
  #unregisterRpc: (() => void) | undefined = undefined
  /** 等 `connection` 服务就绪的定时器（见 `#scheduleRpcRetry`）。 */
  #rpcTimer: ReturnType<typeof setTimeout> | undefined = undefined
  #rpcRetries = 0
  /** `#installRpc()` 只走一次：重复注册会撞 Connection 的重复路由检查并抛错。 */
  #rpcStarted = false
  /** 路由是否真的挂上了（诊断用）。 */
  #rpcMounted = false

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

    this.#provision = new ProvisionManager({
      log: this.#log,
      // 写配置 + 重建通道都在这一句里；抛错会被 ProvisionManager 折叠成
      // `state: 'failed'` 与一条脱敏后的提示，不会冒到 RPC 层。
      onCredentials: (channelId, credentials) => this.#applyProvisionCredentials(channelId, credentials),
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
    this.#provision.dispose()
    this.#gate.close()
    this.#accumulator.clear()
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer)
      this.#saveTimer = undefined
    }
    for (const sessionId of [...this.#waiting.keys()]) this.#clearWaiting(sessionId)
    this.#clearRpcTimer()
    this.#saveState()
    await this.#channels.stop()
    this.#log.info('tlnotify 已卸载')
  }

  // ── 设置页 RPC ──────────────────────────────────────────────────────────

  /**
   * 把设置页的 5 条端点挂到宿主的 `/api` 浏览器传输上。
   *
   * ## 为什么是 `connection.fetch.register`，而不是 `connection.rpc.handle`
   *
   * `rpc.handle(channel, handler)` 看起来才像「原生通道」，但它在 DSH 里**用不了**：
   * 它内部执行 `owner.webServer.register(route)`
   * （`@deepseek-ai/dsh-client-connection/lib/index.js:640-657`），而 `owner` 是
   * **读这个服务的那个 ctx**——`Service` 把 `this.ctx` 重绑到读者派生出来的 ctx 上
   * （`@deepseek-ai/cordis/lib/index.js:84-158` 的 `getTraceable`/`createShadow`，
   * 探针实测 `owner.fiber.name` 就是读者插件名）。插件自己的 ctx 没有声明
   * `webServer`，于是注册内部抛 `cannot get property "webServer" without inject`。
   * 五条救法全部**实测失败**：插件 `inject` 里加上 webServer、只加 connection、
   * 改用属性访问、用真 `ctx.inject(['webServer','connection'], …)` 造子 fiber、
   * 以及在沙箱里调到 `ctx.inject`（沙箱根本不暴露 `inject`）。根因是 cordis 的
   * 属性访问要求**祖先 fiber 的 `store` 里有这个服务**（`lib/index.js:660-699` 的
   * 解析循环），子 fiber 也不满足。
   *
   * 失败的样子极其隐蔽：注册抛的错被我们自己的 catch 吞成一行 warn，路由从没进过
   * webserver，浏览器的 `POST /tlnotify/state` 掉进 `dsh-host-frontend-static` 的
   * 兜底静态座位（该文件 `:87-92`「non-GET/HEAD is 405」），页面显示
   * `transport failure for /tlnotify/state: HTTP 405`。
   *
   * `fetch.register` 只用到 `owner.effect(...)`（`registerFetchRoute`，`:625-639`），
   * **完全不碰 `owner.webServer`**，所以在没有任何 inject 声明的插件 ctx 上也成功。
   * 生态里就是这么做的：`@xmanrui/dsh-im/plugin-src/management-rpc.mjs:41-72`。
   *
   * ## 安全性没有让步
   *
   * `/api` 那条前缀路由由 Connection 自己挂（`dsh-client-connection/lib/index.js:820-844`），
   * 它的 handler 先做 `connection.admit(req)`：Host / Origin 校验 + 浏览器登录态，
   * 不通过直接 401/403。端点路由在这之后才被查到（`createSharedFetchHandler` 先查
   * exact Fetch 路由再查拦截器，`lib/index.js:608-623`），所以方案 §4.3「只允许本机
   * 来源、拒绝跨站、限制体积」依然由宿主统一保证。
   *
   * ## 降级
   *
   * 宿主没有 Web 半边（headless）时这里只是少一个设置页，插件其余部分照常工作——
   * 所以降级路径是 warn 而不是抛错，`connection` 也**不写进**插件自己的 `inject`
   * （`inject` 是一道激活门，那会让 headless 部署永不激活）。
   *
   * 事故记录之二：历史上这里写的是 `this.#host.connection?.rpc`，它在 cordis 的
   * Context Proxy 上抛 `cannot get property "connection" without inject`——`start()`
   * 因此在写出第一行 plugin.log **之前**就 reject，表现为「设置页永远停在『正在读取
   * 配置…』、plugin.log 一行都没有」。取服务必须走 `readConnectionFetch()`（取不到
   * 只返回 `undefined`，永不抛）。
   */
  #installRpc(): void {
    if (this.#disposed || this.#rpcStarted) return // 幂等：重复注册会撞 Connection 的重复路由检查
    this.#rpcStarted = true
    // 服务可能比我们晚 ACTIVE（bundle 层按包名组合，插件间没有装载顺序保证），
    // 所以第一次取不到不能当判决：有界重试，到上限才判定「这个宿主没有 Web 半边」。
    if (!this.#mountRpc()) this.#scheduleRpcRetry()
  }

  /**
   * 注册 5 条端点路由；拿不到服务返回 `false`（交给重试）。
   *
   * 单条注册失败会先撤掉已经挂上的那几条再报错：半成功比全失败更糟——路由挂着但
   * 缺一条，页面上表现为「某个操作莫名 404」，比彻底不可用更难查。
   */
  #mountRpc(): boolean {
    if (this.#disposed || this.#unregisterRpc) return true
    const fetch = readConnectionFetch(this.#host)
    if (!fetch) return false

    const disposers: (() => void)[] = []
    try {
      for (const method of RPC_METHODS) {
        const disposer = fetch.register({
          path: rpcRoutePath(method),
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => this.#serveRpc(method, request),
        })
        if (typeof disposer === 'function') disposers.push(disposer as () => void)
      }
    } catch (error) {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 注销失败没有补救手段，忽略（下次启动会重新注册）。
        }
      }
      this.#log.warn('挂载设置页 RPC 失败（设置页不可用，插件其余功能不受影响）', error)
      return true // 不是瞬态问题，别重试刷日志
    }

    this.#unregisterRpc = () => {
      for (const dispose of disposers) dispose()
    }
    this.#rpcMounted = true
    this.#rpcRetries = 0
    this.#clearRpcTimer()
    // 用 info 而不是 debug：设置页能不能用是用户会踩到的第一件事，而失败诊断全靠
    // plugin.log（DSH 宿主不落任何日志文件）。一次启动一行，不吵。
    this.#log.info(
      `设置页 RPC 已挂载：${RPC_ROUTE_PREFIX}/<${RPC_METHODS.join('|')}>（${CONNECTION_SERVICE}.fetch）`,
    )
    return true
  }

  /**
   * 一条端点路由的处理器：自己解 Connection 的信封，自己封回去。
   *
   * 信封形状照抄 `@xmanrui/dsh-im/plugin-src/management-rpc.mjs:33-72`：请求
   * `{type:'client-request',rpcId,method,payload}`，响应
   * `{type:'server-response',rpcId,result}`；`rpcId` 必须原样回显，浏览器侧的
   * `parseConnectionResponse`（`dsh-client-connection/lib/client.js:1288-1304`）
   * 会核对它。
   *
   * 业务失败一律走 `fail(...)` 的 `RpcResult`（HTTP 200），这样页面上能显示「哪一项
   * 没通过校验」；只有信封本身就不对才回 HTTP 4xx——那种情况没有 `rpcId` 可以回显。
   *
   * 到这里的请求已经过 Connection 的 `admit`（Host/Origin 校验 + 浏览器登录态），
   * 见 `#installRpc` 的注释。
   */
  async #serveRpc(method: RpcMethod, request: HostFetchRequestLike): Promise<unknown> {
    if (request.method !== 'POST') {
      return Response.json({ ok: false, message: 'method-not-allowed' }, { status: 405 })
    }
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return Response.json({ ok: false, message: 'invalid-json' }, { status: 400 })
    }
    const envelope = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<RpcRequestEnvelope>
    const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : ''
    if (envelope.type !== 'client-request' || rpcId.length === 0) {
      return Response.json({ ok: false, message: 'invalid-envelope' }, { status: 400 })
    }
    const result = (await this.#rpcHandle(method, envelope.payload)) as RpcResult<unknown>
    const body: RpcResponseEnvelope = { type: 'server-response', rpcId, result }
    return Response.json(body)
  }

  /**
   * 反射取值路径专用的重试。
   *
   * bundle 层是按包名顺序组合的，插件之间没有装载顺序保证；`ctx.get` 在 strict
   * 模式下一个还没 ACTIVE 的服务会返回 `undefined`，所以「第一次取不到」不能当
   * 判决。重试到上限才认定这个宿主真的没有 Web 半边。
   */
  #scheduleRpcRetry(): void {
    if (this.#disposed || this.#rpcTimer || this.#unregisterRpc) return
    if (this.#rpcRetries >= RPC_RETRY_LIMIT) {
      this.#warnRpcUnavailable()
      return
    }
    this.#rpcRetries += 1
    const timer = setTimeout(() => {
      this.#rpcTimer = undefined
      if (this.#disposed) return
      if (this.#mountRpc()) return
      this.#scheduleRpcRetry()
    }, RPC_RETRY_INTERVAL_MS)
    // 不让这个定时器拖住进程退出（探针脚本、`dsh rescue` 这类短命进程）。
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.#rpcTimer = timer
  }

  #clearRpcTimer(): void {
    if (!this.#rpcTimer) return
    clearTimeout(this.#rpcTimer)
    this.#rpcTimer = undefined
  }

  #warnRpcUnavailable(): void {
    this.#log.warn(
      `宿主没有提供客户端 RPC 通道（${CONNECTION_SERVICE} 服务或它的 fetch 注册表），设置页不可用；可以直接编辑 ${join(this.#dataDir, 'config.json')}`,
    )
  }

  async #uninstallRpc(): Promise<void> {
    const unregister = this.#unregisterRpc
    this.#unregisterRpc = undefined
    this.#rpcMounted = false
    if (!unregister) return
    try {
      unregister()
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
        case 'provision.begin':
          return await this.#rpcProvisionBegin(payload)
        case 'provision.poll':
          return this.#rpcProvisionPoll(payload)
        case 'provision.cancel':
          return this.#rpcProvisionCancel(payload)
        case 'sessions.list':
          return await this.#rpcSessionsList()
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
    // 补丁按 `protocol.ts` 的契约包在 `patch` 字段里：`patch: { request: { patch: TlnotifyPatch } }`。
    //
    // ⚠️ 这里曾经把整个 `payload` 直接交给 `applyPatch`，于是客户端发来的
    // `{ patch: { … } }` 里的 `patch` 变成了未知顶层键、被白名单拒掉。后果是设置页
    // **每一次写入都失败**（页面上弹「patch 期望 以下之一：enabled, mode, …」），
    // 而这些写入里包含「扫码接入机器人」的第一步——它要先整表保存新通道、再向宿主
    // 申请二维码，保存失败就直接 return。于是扫码那一步在界面上表现为「点了没反应、
    // 也没有二维码」。读接口（`state`）不受影响，所以页面看起来是好的。
    const patch =
      payload !== null && typeof payload === 'object'
        ? (payload as Record<string, unknown>).patch
        : undefined
    if (patch === undefined || patch === null) {
      return fail('invalid-patch', '请求里没有 patch 字段。', {
        path: 'patch',
        expected: 'TlnotifyPatch',
      })
    }

    const outcome = applyPatch(this.#config, patch)
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
      // 总开关翻转。关的时候只停通道、不摘事件源：`#canPush` 已经会拦住所有
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

  // ── 扫码创建机器人（provision.*）─────────────────────────────────────────
  //
  // 三个端点都是 **QQ 专用**：飞书自建应用不需要扫码创建（AppID/AppSecret 在开放
  // 平台后台自己建），`ProvisionManager` 会直接回 `unsupported` 并附上正确流程，
  // 所以设置页可以对着任意类型的机器人无条件调用。

  #provisionTarget(payload: unknown): { requested?: string; channel?: ChannelConfig } {
    const requested = this.#channelIdOf(payload)
    const channel = requested
      ? this.#config.channels.find((item) => item.id === requested)
      : undefined
    return { requested, channel }
  }

  #noProvisionChannel(requested: string | undefined): RpcResult<ProvisionSnapshot> {
    return fail(
      'no-channel',
      requested
        ? `配置里没有 id 为「${requested}」的通道，请刷新设置页再试。`
        : '缺少 channelId：设置页要说明这次扫码是为哪个机器人。',
      requested ? { channelId: requested } : {},
    )
  }

  async #rpcProvisionBegin(payload: unknown): Promise<RpcResult<ProvisionSnapshot>> {
    const { requested, channel } = this.#provisionTarget(payload)
    if (!channel) return this.#noProvisionChannel(requested)
    // 会一直挂到第一张二维码就绪（或超时/失败）才返回，所以必须是 await。
    return await this.#provision.begin(channel)
  }

  #rpcProvisionPoll(payload: unknown): RpcResult<ProvisionSnapshot> {
    const { requested, channel } = this.#provisionTarget(payload)
    if (!channel) return this.#noProvisionChannel(requested)
    const attemptId = this.#attemptIdOf(payload)
    if (!attemptId) return fail('bad-request', '缺少 attemptId：请重新发起一次扫码。', {})
    return this.#provision.poll(channel, attemptId)
  }

  #rpcProvisionCancel(payload: unknown): RpcResult<ProvisionSnapshot> {
    const { requested, channel } = this.#provisionTarget(payload)
    if (!channel) return this.#noProvisionChannel(requested)
    const attemptId = this.#attemptIdOf(payload)
    if (!attemptId) return fail('bad-request', '缺少 attemptId：没法确认要取消哪一次扫码。', {})
    return this.#provision.cancel(channel, attemptId)
  }

  /**
   * 列出现有会话，供设置页「选会话」用（单会话模式绑定 / 指定多个会话）。
   *
   * 为什么要有这个端点：以前「指定会话」是在文本域里手打会话 id，而设置页从不
   * 显示标题——同时开着几个会话时根本认不出哪个是哪个，选错了要到通知发出来才
   * 发现。这里把标题、项目目录、最近活动一起给出去，界面上才谈得上「选」。
   *
   * 标题按 DSH 自己的回退顺序算好（会话标题 → 项目目录名 → 会话 id）：标题是
   * 懒生成的（首条用户提问走 LLM），拿不到是常态，不能因此显示空白行。
   *
   * **读不到会话服务不算业务失败**：回 `ok` + `unavailable` 原因，让设置页显示
   * 「可以手填会话 id」，而不是弹一个用户无法处理的错误。
   */
  async #rpcSessionsList(): Promise<RpcResult<SessionListPayload>> {
    const controller = readSessionController(this.#host)
    if (!controller?.list) {
      return ok({
        sessions: [],
        unavailable: `宿主没有提供 ${SESSION_CONTROLLER_SERVICE} 服务，列不出会话；可以直接填会话 id。`,
      })
    }
    let items: unknown
    try {
      const reply = (await controller.list({}, undefined)) as { items?: unknown } | undefined
      items = reply?.items
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return ok({
        sessions: [],
        unavailable: `读取会话列表失败：${redactText(message)}`,
      })
    }
    if (!Array.isArray(items)) {
      return ok({ sessions: [], unavailable: '宿主返回的会话列表形状不对。' })
    }

    const sessions: ChannelSessionSummary[] = []
    for (const entry of items) {
      if (!entry || typeof entry !== 'object') continue
      const summary = entry as HostSessionSummaryLike
      const id = typeof summary.sessionId === 'string' ? summary.sessionId : ''
      if (id.length === 0) continue
      const cwd = typeof summary.cwd === 'string' ? summary.cwd : ''
      const project = cwd ? projectName({ id, header: { cwd } }) : ''
      const title = sessionTitleOf(summary)
      sessions.push({
        id,
        // 三段回退：真标题 → 项目目录名 → 会话 id。
        title: title || project || id,
        project,
        cwd,
        subagent: summary.origin === 'subagent',
        updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : 0,
        running: summary.running === true,
      })
    }
    // 子 Agent 会话排最后（一般不该单独绑给机器人），其余按最近活动倒序。
    sessions.sort((a, b) => {
      if (a.subagent !== b.subagent) return a.subagent ? 1 : -1
      return b.updatedAt - a.updatedAt
    })
    return ok({ sessions })
  }

  /**
   * 扫码成功后把凭据写进配置并让通道生效。
   *
   * 由 `ProvisionManager` 调用，**抛错即等于接入失败**（它会折叠成
   * `state: 'failed'` 并把错误文本脱敏），所以这里不做 try/catch。
   *
   * 四个字段一起改：`appId` / `appSecret` 是刚拿到的凭据；`targetChatId` 用扫码人的
   * openid——腾讯在授权时已经告诉我们「这个机器人属于谁」，用户不必再去猜自己的
   * openid；顺带把通道置为启用，因为此时凭据已经齐了，这正是 dsh-im 那种「扫完就
   * 上线」的体感，也让新机器人不至于是一张哑巴卡片。
   */
  async #applyProvisionCredentials(
    channelId: string,
    credentials: ProvisionCredentials,
  ): Promise<void> {
    const channel = this.#config.channels.find((item) => item.id === channelId)
    if (!channel) throw new Error(`通道「${channelId}」已经不在配置里了。`)

    const next: TlnotifyConfig = {
      ...this.#config,
      channels: this.#config.channels.map((item) => {
        if (item.id !== channelId) return item
        return {
          ...item,
          appId: credentials.appId,
          appSecret: credentials.appSecret,
          ...(credentials.targetId ? { targetChatId: credentials.targetId } : {}),
          enabled: true,
        }
      }),
    }

    // 先落盘再改内存：写不进去就让调用方看到失败，避免「界面上好了、重启后没了」。
    saveConfigFile(this.#dataDir, next)
    this.#config = next

    if (this.#attached && this.#config.enabled) {
      await this.#channels.stop()
      await this.#channels.start(this.#config.channels, this.#config.defaultChannelId)
    }

    this.#log.info(
      `扫码创建 QQ 机器人：凭据已写入配置并重建通道（通道 ${channelId}，appId=${credentials.appId}）`,
    )
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

  #attemptIdOf(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined
    const value = (payload as Record<string, unknown>).attemptId
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
    if (!this.#canPush()) return
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
    // 一次 `ask_user_question` 可能带多个问题：每个问题各自走一遍判断（每条有自己的
    // requestId / questionId / seq），否则第 2..N 问永远不会产生通知。
    for (const raw of extractToolCallEvents(session, event)) this.#maybePendingOne(raw)
  }

  #maybePendingOne(raw: RawEvent): void {
    const requestId = raw.detail.requestId
    if (requestId && this.#claimedRequests.has(requestId)) return
    if (requestId && this.#deliveredRequests.has(requestId)) {
      this.#log.info(`这条等待通知已经发过了（req ${requestId}），跳过重复投递`)
      return
    }
    // 上面两条按 requestId 判断，而 waterfall 在宿主没给 callId 时会自己合成一个 id
    // （`question-<n>-<时间戳>`），两边永远对不上，于是同一个提问被两条路各发一条通知
    // （现场 08:54:58.419/.430、15:05:20.142/.286、15:41:38.317/.332）。这里问一句桥：
    // 桥已经在等这个提问了，兜底就不该再发。判据是活着的 pending，不是时间窗，所以
    // 同一会话连着问两个问题不会被误吞。
    //
    // 注意这条只在**桥先注册**时管用；15:41:38 那次是兜底先跑，所以真正的去重是
    // `#announceOnce`（按「会话 + 题目 id」认，与顺序无关），见下面 `#deliver`。
    if ((raw.kind === 'question' || raw.kind === 'plan') && this.#bridge.hasLivePending(raw.sessionId, raw.kind)) {
      this.#log.info(`这条等待通知已经由 waterfall 发过了（${raw.sessionId} · ${raw.kind}），跳过日志兜底`)
      return
    }
    if (!this.#canPush()) return
    if (!this.#dedupe.accept(raw.sessionId, raw.seq)) {
      this.#noteSkippedIntervention(raw, `被判成重复事件（seq ${raw.seq}）`)
      return
    }
    if (requestId) this.#markDelivered(requestId)
    this.#log.info(`等待通知来自日志兜底（req ${requestId ?? '宿主没给 id'}）`)
    void this.#deliver(raw)
  }

  /** InteractionBridge 识别出一条「有人在等」的事件。 */
  async #onPending(event: RawEvent): Promise<void> {
    const requestId = event.detail.requestId
    if (requestId) this.#claim(requestId)
    if (requestId && this.#deliveredRequests.has(requestId)) {
      // 留 info：这条是「重复投递被拦住」的直接证据，调 logLevel 之前就靠它。
      this.#log.info(`这条等待通知已经发过了（req ${requestId}），跳过重复投递`)
      return
    }
    if (!this.#canPush()) return
    if (!this.#dedupe.accept(event.sessionId, event.seq)) {
      this.#noteSkippedIntervention(event, `被判成重复事件（seq ${event.seq}）`)
      return
    }
    if (requestId) this.#markDelivered(requestId)
    // 用户可能抢在 waterfall 之前就答了（见 WaitingIntervention）。命中就替他答，
    // 不再发第二条通知——那条通知正是他「回两次才生效」的原因。
    if (await this.#consumeHeldAnswer(event)) return
    this.#log.info(`等待通知来自 waterfall（req ${requestId ?? '合成 id'}）`)
    return this.#deliver(event)
  }

  #claim(requestId: string): void {
    this.#claimedRequests.add(requestId)
    if (this.#claimedRequests.size > CLAIMED_REQUEST_LIMIT) {
      const oldest = this.#claimedRequests.values().next().value
      if (oldest !== undefined) this.#claimedRequests.delete(oldest)
    }
  }

  #markDelivered(requestId: string): void {
    this.#deliveredRequests.add(requestId)
    if (this.#deliveredRequests.size > CLAIMED_REQUEST_LIMIT) {
      const oldest = this.#deliveredRequests.values().next().value
      if (oldest !== undefined) this.#deliveredRequests.delete(oldest)
    }
  }

  // ── 攥住「比提问先到」的作答 ──────────────────────────────────────────────
  //
  // 现场（用户 m04327 第二次复验）：`tool/call` 那条路 19:21:06 就把「等待我回答」
  // 发了出去，用户立刻回「1」，可 `InteractionBridge.#pending` 里那一刻**什么都
  // 没有**——于是这句话被当普通发言注进会话（用户看到的就是「回复的文本在对话框
  // 上面，像是一个补充语句」），50 秒后 waterfall 才注册 pending，用户只好再回
  // 一次。所以「像作答」的话先攥在这里，pending 一出现就替他答。

  /** 记下「这个会话在等作答」，并把通知里给出的选项留住（只对等待类事件）。 */
  #rememberWaiting(event: RawEvent): void {
    // 窄化到三种等待类事件：`INTERVENTION_KINDS` 里只有它们是「有选项可答」的。
    const kind: AnswerTarget['kind'] | undefined =
      event.kind === 'question' || event.kind === 'approval' || event.kind === 'plan'
        ? event.kind
        : undefined
    if (!kind) return
    const previous = this.#waiting.get(event.sessionId)
    this.#waiting.set(event.sessionId, {
      at: Date.now(),
      kind,
      labels: (event.detail.options ?? []).map((option) => option.label),
      ...(event.detail.multiSelect === true ? { multiSelect: true } : {}),
      // 已经攥住的答案不能被新通知冲掉——它等的就是这个 pending。
      ...(previous?.text !== undefined ? { text: previous.text } : {}),
      ...(previous?.channelId !== undefined ? { channelId: previous.channelId } : {}),
      ...(previous?.timer ? { timer: previous.timer } : {}),
    })
  }

  /** 取这个会话「刚发过、还没过期」的等待记录；过期的顺手清掉。 */
  #freshWaiting(sessionId: string): WaitingIntervention | undefined {
    const held = this.#waiting.get(sessionId)
    if (!held) return undefined
    if (Date.now() - held.at > WAITING_ANSWER_TTL_MS) {
      this.#clearWaiting(sessionId)
      return undefined
    }
    return held
  }

  /** 这个会话是不是刚发过等待类通知（按钮点空时用它给出更准的提示）。 */
  #hasFreshWaiting(sessionId: string): boolean {
    return this.#freshWaiting(sessionId) !== undefined
  }

  /**
   * 文本对不上任何 pending 时，判它像不像「对还没就绪的提问的作答」。
   *
   * 像就攥住并返回 true（调用方**不要**再注入）；不像返回 false，照常注入。
   * 判据是通知里**真实给出的选项**，而且刻意与 `settleText` 用同一套判读
   * （`matchAnswer` 就是 `settleText` 内部那条规则）——所以「攥住」永远不会比
   * 「pending 已经在」时的行为更激进：pending 若在，这句话本来也会被结算掉。
   * 等不到 pending 就按普通发言退回（`WAITING_ANSWER_FALLBACK_MS`）。
   */
  async #holdTextAnswer(channelId: string, sessionId: string, text: string): Promise<boolean> {
    const held = this.#freshWaiting(sessionId)
    if (!held) return false
    const target: AnswerTarget = {
      kind: held.kind,
      labels: held.labels,
      ...(held.multiSelect ? { multiSelect: true } : {}),
    }
    if (!matchAnswer(target, text)) return false
    if (held.timer) clearTimeout(held.timer)
    const timer = setTimeout(() => {
      const current = this.#waiting.get(sessionId)
      // 期间被结算掉、或被另一句顶掉了，就别再补投。
      if (!current || current.text !== text) return
      this.#clearWaiting(sessionId)
      const result = this.#injector.deliver(sessionId, text)
      this.#log.info(
        `攥住的作答一直没等到提问就绪，按普通发言投递（${this.#label(sessionId)}）：` +
          (result.ok ? '已投递' : (result.reason ?? '失败')),
      )
      void this.#echo(
        channelId,
        result.ok
          ? `已发给 ${this.#label(sessionId)}（提问一直没就绪，按普通发言投递）`
          : `没能投递：${result.reason ?? '未知原因'}`,
      )
    }, WAITING_ANSWER_FALLBACK_MS)
    timer.unref?.()
    this.#waiting.set(sessionId, { ...held, text, channelId, timer })
    this.#log.info(
      `这条作答比提问先到（${this.#label(sessionId)}），先攥住，等 pending 一出现就替它答：${text}`,
    )
    // 立刻回一句，别让用户觉得消息石沉大海——他要的就是「我的回复不是补充语句」。
    await this.#echo(channelId, `已收到「${text}」，等提问就绪就替你答。`)
    return true
  }

  /**
   * pending 刚就绪：用户要是已经先答了，就用攥住的答案替他结算掉。
   *
   * 返回 true 表示已经处理（不再发第二条通知）——那条迟到的通知正是他「回两次才
   * 生效」的原因。
   */
  async #consumeHeldAnswer(event: RawEvent): Promise<boolean> {
    const held = this.#freshWaiting(event.sessionId)
    if (!held || held.text === undefined) return false
    const settlement = this.#bridge.settleText(event.sessionId, held.text)
    if (!settlement) return false
    if (!settlement.ok && settlement.armed) {
      // 他抢在 pending 就绪前回的是「自定义回答」那个序号：桥已经进入等待状态，这句
      // 「4」本身不是答案——清掉攥住的记录，别让它 60 秒后被当普通发言补投出去。
      // 通知他早就收到过（攥住的前提就是发过等待通知），所以这里不再补发。
      this.#clearWaiting(event.sessionId)
      this.#log.info(
        `抢在提问就绪前选了「自定义回答」（${this.#label(event.sessionId)}），等他把答案发过来`,
      )
      if (held.channelId) {
        await this.#echo(held.channelId, settlement.reason ?? '好，把你要自定义的答案发过来。')
      }
      return true
    }
    if (!settlement.ok) return false
    this.#clearWaiting(event.sessionId)
    this.#log.info(
      `抢在提问就绪前回过来的作答已经生效（${this.#label(event.sessionId)}）：${settlement.echo ?? ''}`,
    )
    if (held.channelId) await this.#echo(held.channelId, settlement.echo ?? '已处理')
    return true
  }

  #clearWaiting(sessionId: string): void {
    const held = this.#waiting.get(sessionId)
    if (held?.timer) clearTimeout(held.timer)
    this.#waiting.delete(sessionId)
  }

  /**
   * 与接收方无关的总闸门：插件是否可用。
   *
   * **这里不再看会话**。「推哪些会话」是每台机器人各自的 `sessionScope`，在
   * `#wants()` 里判。历史上这里还有一道全局单会话开关（`#mode.shouldPush`），
   * 结果是「一台机器人被设成单会话，其它勾了『关心全部』的机器人也全哑」——
   * 用户要的是「不同的机器人可以关心单一 / 多个 / 全局」，所以那道闸门已删除。
   * `config.mode` / `config.session.targetSessionId` 只剩兼容读写。
   */
  #canPush(): boolean {
    return !this.#disposed && this.#config.enabled
  }

  /**
   * 这台机器人关心这条事件吗？（《每机器人设置方案》§3）
   *
   * 三层都是每台机器人各自的：会话范围（`channelCaresAboutSession`）、事件开关
   * （`resolveChannelSettings`）、子 Agent 折叠。`switchesOf()` 会把全局的
   * `global.includeSubagent` 并进来——那是「所有机器人都带上子 Agent」的粗粒度
   * 开关，仍然要生效。
   */
  #wants(config: ChannelConfig, event: RawEvent): boolean {
    if (!channelCaresAboutSession(config, event.sessionId)) return false
    const { events } = resolveChannelSettings(this.#config, config)
    const switches = switchesOf({ events, global: this.#config.global })
    if (!isKindEnabled(event.kind, switches)) return false
    if (isSubagent(this.#sessions.get(event.sessionId)) && !switches.includeSubagent) return false
    return true
  }

  // ── 投递 ────────────────────────────────────────────────────────────────

  /**
   * 一条事件被静默丢掉时留一行日志。
   *
   * 等待类（提问 / 审批 / 计划）用 info：用户看不到通知的时候，日志必须说清为什么
   * ——「有时候不提醒」（m04327）就是被这类静默跳过坑的。其余仍是 debug，免得日志
   * 被没勾选的事件刷屏。
   */
  #noteSkippedIntervention(event: RawEvent, why: string): void {
    const line = `没投递这条事件（${event.kind}，会话 ${shortSessionId(event.sessionId)}）：${why}`
    if (INTERVENTION_KINDS.has(event.kind)) this.#log.info(line)
    else this.#log.debug(line)
  }

  /** 逐台列出「这条事件为什么没发给它」，只在等待类事件没人接时打一次。 */
  #explainSkips(event: RawEvent): string {
    const candidates = this.#channels.candidates()
    if (candidates.length === 0) return '没有已启用的机器人'
    return candidates
      .map((config) => {
        const scope = channelSessionScope(config)
        if (!channelCaresAboutSession(config, event.sessionId)) {
          if (scope === 'single') return `${config.id}（只关心 ${config.sessionId ? shortSessionId(config.sessionId) : '还没选会话'}）`
          if (scope === 'filter') return `${config.id}（名单 ${config.sessionFilter?.length ?? 0} 个，不含这个会话）`
          return `${config.id}（范围 all 却不匹配，配置可能刚被改过）`
        }
        const { events } = resolveChannelSettings(this.#config, config)
        const switches = switchesOf({ events, global: this.#config.global })
        if (!isKindEnabled(event.kind, switches)) return `${config.id}（没勾这一类事件）`
        if (isSubagent(this.#sessions.get(event.sessionId)) && !switches.includeSubagent) {
          return `${config.id}（子 Agent 会话且没开 includeSubagent）`
        }
        return `${config.id}（原因未知）`
      })
      .join('；')
  }

  /**
   * 同一个提问的两条生产者路径（日志兜底 / waterfall）只能有一条真的发通知。
   *
   * 两条路算出来的 requestId 可能对不上（现场：`call_00_dGHQUzZz9ZWpxg1gDB906158` vs
   * `question-1-1791042098331`），而且谁先谁后不定（08:54:58 与 15:05:20 是 waterfall 先，
   * 15:41:38 是日志兜底先），所以只按 id 去重必然漏。改成按两条路都拿得到的身份认：
   * `会话 + 题目 id`（`ask_user_question` 的 `questions[0].id`）。
   *
   * 闸门必须放在**真正投递的那一刻**，而不是各自算完 id 之后：`#deliver` 里有 await，
   * 晚到的那条只有在这里才拦得住。
   */
  #announceOnce(event: RawEvent): boolean {
    if (event.kind !== 'question') return true
    if (this.#bridge.announceQuestion(event.sessionId, event.detail.questionId)) return true
    this.#log.info(
      `这条等待通知已经发过了（${event.sessionId} · 题目 id ${event.detail.questionId ?? '未知'}），跳过重复投递`,
    )
    return false
  }

  async #deliver(event: RawEvent): Promise<void> {
    if (this.#disposed) return
    if (!this.#announceOnce(event)) return
    const targets = new Set(
      this.#channels
        .candidates()
        .filter((config) => this.#wants(config, event))
        .map((config) => config.id),
    )
    if (targets.size === 0) {
      // 所有机器人都没勾这一类事件，或都不关心这个会话：安静跳过。
      // 「等待我回答 / 审批 / 计划」例外——静默跳过就是用户看到的「有时候不提醒」
      // （m04327：等待的时候并没有发信息提醒），所以这一类留一行 info 说明原因。
      this.#noteSkippedIntervention(event, this.#explainSkips(event))
      return
    }
    // 正文是**逐通道**渲染的：事件开关、正文细节、历史轮数都是每台机器人各自的
    // 配置。投递也是逐台的（`sendEach`）：谁勾了谁收到，两台都勾同一会话就各收
    // 一条——用户画的是一台一台的订阅，不是「一台成功就停」的故障转移。
    const rendered = new Map<string, Notification>()
    const results = await this.#channels.sendEach((channelId, config) => {
      if (!targets.has(channelId)) return undefined
      const notification = this.#render(event, config)
      rendered.set(channelId, notification)
      return notification
    })
    if (results.length === 0) return
    for (const result of results) {
      const notification = rendered.get(result.channelId)
      if (!notification) continue
      this.#route.record({
        messageId: result.messageId,
        sessionId: event.sessionId,
        text: `${notification.title}\n${notification.body}`,
        ...(result.refIdx ? { refIdx: result.refIdx } : {}),
        intervention: INTERVENTION_KINDS.has(event.kind),
      })
      this.#pushed += 1
    }
    if (INTERVENTION_KINDS.has(event.kind)) this.#rememberWaiting(event)
    const first = rendered.get(results[0]!.channelId)
    // 等待类事件把 requestId 一起打出来：同一条等待会从 `tool/call`（`data.callId`）与
    // waterfall（`req.wait.callId`）两条路进来，两条路算出的 id 若不同，
    // `#deliveredRequests` 就拦不住重复投递。日志里并排看两个 id 才能定性。
    const requestId = event.detail.requestId
    this.#log.info(
      `已通知：${first ? first.title : event.kind}` +
        `（${results.length} 台：${results.map((result) => result.channelId).join('、')}）` +
        (requestId ? ` [req ${requestId}]` : ''),
    )
    this.#scheduleSave()
  }

  #render(event: RawEvent, config: ChannelConfig): Notification {
    const sessionId = event.sessionId
    // 结束类事件的轮次已经被 endTurn 推进历史，等待类事件则还在进行中；
    // 先问进行中的，再退回历史最后一条，两种情况都能拿到对的快照。
    const snapshot = this.#accumulator.liveSnapshot(sessionId) ?? this.#accumulator.previousTurns(sessionId, 1)[0]
    return renderNotification(event, snapshot, this.#renderOptions(sessionId, snapshot, config))
  }

  #renderOptions(
    sessionId: string,
    snapshot: TurnSnapshot | undefined,
    config: ChannelConfig,
  ): RenderOptions {
    // 历史轮数是每台机器人各自的：没填就跟随全局 `session.context.previousTurns`，
    // 填 0 表示这台机器人不带历史（用户要的是「设置页可以选择是否显示历史记录」）。
    const wanted = Math.max(0, config.historyTurns ?? this.#config.session.context.previousTurns)
    let previousTurns = wanted > 0 ? this.#accumulator.previousTurns(sessionId, wanted + 1) : []
    // 结束类事件的快照本身就是历史里最后一条，不要既当正文又当「前 N 轮」。
    const last = previousTurns[previousTurns.length - 1]
    if (snapshot && last && last.turn === snapshot.turn && last.startedAt === snapshot.startedAt) {
      previousTurns = previousTurns.slice(0, -1)
    }
    return {
      // 「这台机器人只关心一个会话」＝正文带那个会话的上下文（用户要的「单会话
      // 模式一定要显示上下文」）。关心多个 / 全部的机器人默认不带，想带就回一句
      // `detail` 把那个会话升到详细模式。
      //
      // 注意这里读的是**收件方那台机器人自己的** `sessionScope`，不是全局开关。
      mode: channelSessionScope(config) === 'single' ? 'session' : 'global',
      detailed: this.#mode.isDetailed(sessionId),
      // 正文细节是每台机器人各自的：没开自定义就是全局值。
      content: resolveChannelSettings(this.#config, config).content,
      session: this.#config.session,
      global: this.#config.global,
      previousTurns,
    }
  }

  // ── 入站：文本 ──────────────────────────────────────────────────────────

  async #onInbound(channelId: string, reply: InboundReply): Promise<void> {
    try {
      const text = (reply.text ?? '').trim()
      // 入站第一现场：把身份与长度先记下来。这里以前只有静默 return，导致「用户说发了、
      // 插件说没收到」时无法判断停在哪一步（qq-2 的 08:55 就是这种现场）。
      this.#log.info(
        `入站（${channelId}）：id=${reply.messageId || '(无)'} ` +
          `sender=${reply.senderId || '(无)'} 文本=${text.length} 字` +
          `${reply.quotedMessageId ? '（引用了一条消息）' : ''}`,
      )
      if (reply.messageId) {
        if (this.#seenInbound.has(reply.messageId)) {
          this.#log.info(`忽略平台重投的入站消息 ${reply.messageId}（这条已经处理过）`)
          return
        }
        this.#rememberInbound(reply.messageId)
      }
      if (text.length === 0) {
        this.#log.warn(`入站消息 ${reply.messageId || '(无 id)'} 没有正文（图片 / 语音 / 空消息），已忽略`)
        return
      }

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

      // 文本作答：QQ 单聊的按钮在老客户端 / 桌面端会被吞掉，用户只能回复文字。
      // 先试结算等待中的提问/审批（宿主正在等的那件事），结算成功就不再当普通发言
      // 注入——否则 DSH 会一直等，而用户那句话会变成一条「补充语句」（用户 m04327）。
      if (await this.#settleByText(channelId, reply, text)) return

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

  /**
   * 把一条入站文本先当「对等待中请求的作答」试一次。
   *
   * 返回 true 表示已经结算并回过执，调用方不要再当普通发言注入。候选会话按可靠度
   * 排：① 这台机器人绑定的会话（`sessionScope: 'single'`——用户就是在它的窗口里回
   * 话的）；② 路由解析出来的会话（引用 / 前缀 / 最新通知）。都没有等待中的请求时
   * 返回 false，走原来的注入路径。
   */
  async #settleByText(channelId: string, reply: InboundReply, text: string): Promise<boolean> {
    const config = this.#config.channels.find((channel) => channel.id === channelId)
    const candidates: string[] = []
    if (config && channelSessionScope(config) === 'single' && config.sessionId) {
      candidates.push(config.sessionId)
    }
    const resolved = this.#resolveTarget(reply)
    if (resolved.sessionId) candidates.push(resolved.sessionId)

    for (const sessionId of candidates) {
      const settlement = this.#bridge.settleText(sessionId, text)
      if (!settlement) continue
      if (!settlement.ok) {
        if (settlement.armed) {
          this.#log.info(
            `用户选了「自定义回答」（${channelId} → ${this.#label(sessionId)}），等他把答案发过来`,
          )
        }
        await this.#echo(channelId, settlement.reason ?? '这条回复没能对上等待中的请求')
        return true
      }
      this.#log.info(
        `文本作答结算了等待中的请求（${channelId} → ${this.#label(sessionId)}）：${settlement.echo ?? ''}`,
      )
      this.#clearWaiting(sessionId)
      await this.#echo(channelId, settlement.echo ?? '已处理')
      return true
    }
    // 一个 pending 都没对上，但这台机器人刚发过「等待我回答」、而这句话又确实像
    // 通知里给出的某个选项：说明 waterfall 还没跑（现场是 50 秒后才跑）。先攥住，
    // 别让用户的话变成「补充语句」（用户 m04327 报的就是这个）。
    for (const sessionId of candidates) {
      if (await this.#holdTextAnswer(channelId, sessionId, text)) return true
    }
    return false
  }

  async #runCommand(channelId: string, command: ModeCommand): Promise<void> {
    switch (command.kind) {
      case 'show':
        return this.#echo(channelId, this.#describeScopeOf(channelId))
      case 'help':
        return this.#echo(channelId, helpText())
      case 'set-global': {
        // `/mode` 一律只改**发命令的这台机器人**：多台机器人各有各的会话范围，
        // 一个全局开关会把「某台关心全部」悄悄压掉（用户报的就是这个）。
        const ok = await this.#setChannelScope(channelId, 'all')
        return this.#echo(
          channelId,
          ok
            ? '这台机器人已改成关心全部会话（其它机器人不受影响）'
            : '没找到这台机器人的配置，改不动——先在设置页保存一次',
        )
      }
      case 'set-session': {
        const target = command.shortId ? this.#findSession(command.shortId) : undefined
        if (!target) {
          return this.#echo(
            channelId,
            command.shortId ? `找不到会话 ${command.shortId}` : '用法：/mode session <短id>',
          )
        }
        const ok = await this.#setChannelScope(channelId, 'single', target)
        return this.#echo(
          channelId,
          ok
            ? `这台机器人已绑定会话 ${this.#label(target)}，之后只推这一个会话`
            : '没找到这台机器人的配置，改不动——先在设置页保存一次',
        )
      }
      default:
        return
    }
  }

  /** `/mode` 的回显：只看**发命令那台机器人**自己的配置。 */
  #describeScopeOf(channelId: string): string {
    const config = this.#config.channels.find((channel) => channel.id === channelId)
    if (!config) {
      return '这台机器人还没写进配置里（可能刚加上还没保存），先在设置页保存一次再看。'
    }
    return describeChannelScope(channelSessionScope(config), {
      ...(config.sessionId ? { sessionId: config.sessionId } : {}),
      filterCount: config.sessionFilter?.length ?? 0,
      labelOf: (id) => this.#label(id),
    })
  }

  /**
   * 改一台机器人的会话范围并落盘（IM 里的 `/mode` 走这里）。
   *
   * 与 `#applyProvisionCredentials()` 同一套路：**先落盘再改内存**，最后重建通道——
   * 通道实例与 `ChannelManager` 手上的都是 `start()` 那一刻的快照，不重建的话新范围
   * 要等下次重启才生效，用户会以为命令没起作用。
   */
  async #setChannelScope(
    channelId: string,
    scope: 'all' | 'single' | 'filter',
    sessionId?: string,
  ): Promise<boolean> {
    const index = this.#config.channels.findIndex((channel) => channel.id === channelId)
    if (index < 0) return false
    const next = {
      ...this.#config,
      channels: this.#config.channels.map((channel, position) =>
        // 切回「关心全部」时**不清空** `sessionId` / `sessionFilter`：用户可能只是临时
        // 回到全局，回头还要切回原来那个会话（《每机器人设置方案》§6）。
        position === index
          ? { ...channel, sessionScope: scope, ...(sessionId !== undefined ? { sessionId } : {}) }
          : channel,
      ),
    }
    try {
      saveConfigFile(this.#dataDir, next)
    } catch (error) {
      this.#log.error('保存会话范围失败', error)
      return false
    }
    this.#config = next
    if (this.#attached && this.#config.enabled) {
      try {
        await this.#channels.stop()
        await this.#channels.start(this.#config.channels, this.#config.defaultChannelId)
      } catch (error) {
        this.#log.error('按新的会话范围重建通道失败', error)
      }
    }
    return true
  }

  // ── 入站：按钮 ──────────────────────────────────────────────────────────

  async #onAction(channelId: string, action: InboundAction): Promise<void> {
    try {
      const value = action.value

      // 审批 / 提问 / 计划确认：交给交互桥结算。
      if (isInteractionAction(value)) {
        const settlement = this.#bridge.settle(value)
        // 按钮是「点一次就发出去了」的东西，攥不住（攥住再丢会更糟），所以这里
        // 只把原因说清楚：刚发过等待类通知 ⇒ 多半是 waterfall 还没跑。
        const pendingHint = this.#hasFreshWaiting(value.sessionId)
          ? '（提问还在准备中，稍等几秒再点一次）'
          : ''
        const text = settlement.ok
          ? (settlement.echo ?? '已处理')
          : `没有生效：${settlement.reason ?? '未知原因'}${pendingHint}`
        if (settlement.ok) this.#clearWaiting(value.sessionId)
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
