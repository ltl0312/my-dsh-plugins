/**
 * 设置页 RPC 的线上契约（设计方案《设置页方案》§4.3）。
 *
 * 这个文件**只放契约**：类型、常量、方法名。宿主侧的校验与落盘逻辑在
 * `./rpc.ts`，浏览器侧的调用封装在 `./client/rpc.ts`。两边都从这里取类型，
 * 保证「设置页改了哪一项、宿主认哪些字段」永远只有一份定义。
 *
 * ## 与方案文档的对应关系
 *
 * 方案里写的是几个 HTTP 端点，实际实现是 Connection 的 exact Fetch 路由
 * （每个方法一条 `POST /api/tlnotify/<method>`）：
 *
 * | 方案文档                        | 实际实现                                            |
 * | ------------------------------- | --------------------------------------------------- |
 * | `GET  /tlnotify/rpc/state`      | `call('/api', 'tlnotify/state')`  → `POST /api/tlnotify/state` |
 * | `POST /tlnotify/rpc/patch`      | `call('/api', 'tlnotify/patch', { … })`              |
 * | `POST /tlnotify/rpc/test`       | `call('/api', 'tlnotify/test',  { … })`              |
 * | `POST /tlnotify/rpc/qr`         | `call('/api', 'tlnotify/qr',    { … })`              |
 * | （方案 §7 的扫码绑定轮询）        | `call('/api', 'tlnotify/bind',  { … })`              |
 *
 * 我们**不走自建 HTTP 路由**：宿主侧用 `ctx.get('connection').fetch.register(...)`
 * 把每条端点挂到 Connection 的 `/api` 浏览器传输上
 * （`@xmanrui/dsh-im/plugin-src/management-rpc.mjs:41-72` 是同一套做法），
 * 浏览器侧用 `connection.rpc.call('/api', endpoint, payload)` 调它。
 * 理由：
 *
 * 1. `/api` 那条前缀路由由 Connection 自己挂，它的 handler 先做
 *    `connection.admit(req)`（Host / Origin 校验 + 浏览器登录态），不通过直接
 *    401/403。方案 §4.3 的安全约束（只允许本机来源、拒绝跨站、限制体积）因此
 *    仍由宿主统一保证，插件不需要（也不应该）自己再实现一遍；
 * 2. 方案文档里「只监听 127.0.0.1」这条约束在此实现下**天然成立**；
 * 3. 断线重连、多标签页、桌面端与 Web 端共用同一条链路。
 *
 * ## 信封
 *
 * 请求 `{ type: 'client-request', rpcId, method, payload }`、
 * 响应 `{ type: 'server-response', rpcId, result }` —— 由 Connection 定义
 * （`@deepseek-ai/dsh-client-connection/lib/index.js` 的 `clientRequestSchema` /
 * `serverResponseSchema`）。`rpcId` 必须原样回显，浏览器侧会核对。
 *
 * 业务结果一律是 `RpcResult<T>`：失败走 `{ ok: false, error }` 而不是抛异常，
 * 也不做成 HTTP 4xx——抛出去会被连接层折叠成一句没有上下文的报错，用户就看不到
 * 「哪一项没通过校验」了。只有「信封本身就不对」才回 HTTP 400（那种情况没有
 * `rpcId` 可以回显）。
 */

import type { ContentConfig, EventsConfig } from './types.js'

/**
 * 浏览器 `rpc.call(channel, …)` 的 channel：Connection 自己挂在 `/api` 上的
 * 浏览器传输（`@deepseek-ai/dsh-client-connection/lib/index.js:820-844`）。
 */
export const RPC_API_CHANNEL = '/api'

/** 本插件所有端点的 endpoint 前缀；路由路径去掉 `/api/` 就是它。 */
export const RPC_ENDPOINT_PREFIX = 'tlnotify'

/** 宿主注册用的路由前缀。必须挂在 `/api/` 下（Connection 的 `assertFetchRoute` 硬要求）。 */
export const RPC_ROUTE_PREFIX = `${RPC_API_CHANNEL}/${RPC_ENDPOINT_PREFIX}`

/** 支持的 RPC 方法。 */
export type RpcMethod =
  | 'state'
  | 'patch'
  | 'test'
  | 'qr'
  | 'bind'
  // 扫码创建机器人：厂商 SDK 的长轮询在宿主里跑，这三个端点只是遥控器。
  | 'provision.begin'
  | 'provision.poll'
  | 'provision.cancel'
  // 设置页「选会话」用：列出现有会话（带标题/目录/最近活动）。
  | 'sessions.list'

/** 方法清单，宿主用它做白名单（未知方法直接拒绝，不进业务分支）。 */
export const RPC_METHODS: readonly RpcMethod[] = Object.freeze([
  'state',
  'patch',
  'test',
  'qr',
  'bind',
  'provision.begin',
  'provision.poll',
  'provision.cancel',
  'sessions.list',
] as const)

/**
 * 某个方法的 endpoint（＝路由路径去掉 `/api/`）：`tlnotify/state`。
 *
 * 它同时是请求信封里的 `method`：Connection 用它做端点归属校验，所以宿主注册的
 * 路径、浏览器拼的 endpoint 必须出自这一个函数。
 */
export function rpcEndpoint(method: RpcMethod): string {
  return `${RPC_ENDPOINT_PREFIX}/${method}`
}

/** 某个方法的 HTTP 路由路径：`/api/tlnotify/state`。 */
export function rpcRoutePath(method: RpcMethod): string {
  return `${RPC_API_CHANNEL}/${rpcEndpoint(method)}`
}

/** 失败原因；`code` 供程序判断，`message` 直接展示给用户。 */
export interface RpcFailure {
  code: string
  message: string
  /** 结构化补充信息，例如 `{ path: 'content.maxBodyChars', expected: '1..20000' }`。 */
  details: Record<string, unknown>
}

/** 统一的返回信封。 */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcFailure }

// ---------------------------------------------------------------------------
// Connection 的信封（浏览器 ↔ 宿主）
// ---------------------------------------------------------------------------

/** 浏览器 → 宿主。字段名与 `clientRequestSchema` 一致，`method` 就是 `rpcEndpoint()`。 */
export interface RpcRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

/** 宿主 → 浏览器。`rpcId` 原样回显；`result` 就是 `RpcResult`。 */
export interface RpcResponseEnvelope {
  type: 'server-response'
  rpcId: string
  result: RpcResult<unknown>
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** 密钥只报「配没配」，回显末四位是为了让用户确认自己填的是哪一把。 */
export interface SecretState {
  configured: boolean
  /** 形如 `••••a1b2`；未配置时是空串。 */
  hint: string
}

/** 脱敏后的通道配置：密钥字段换成 {@link SecretState}。 */
export interface RedactedChannel {
  id: string
  type: 'qq' | 'feishu'
  enabled: boolean
  /** 别名；空串表示界面回退到 `id`。 */
  label: string
  /** 关心全部会话 / 只关心绑定的那一个 / 只关心列表里的。 */
  sessionScope: 'all' | 'single' | 'filter'
  /** 单会话模式绑定的会话 id；空串 = 还没选。 */
  sessionId: string
  sessionFilter: string[]
  /**
   * 事件开关是否覆盖全局。
   *
   * 下面两个字段**始终是「当前生效值」**：不覆盖时它们就是全局值的快照。
   * 设置页因此可以直接照着渲染开关，不必自己再合并一次——但保存时只有
   * `override* === true` 的那一份会被写进通道配置。
   */
  overrideEvents: boolean
  events: EventsConfig
  overrideContent: boolean
  content: ContentConfig
  /**
   * 正文附带该会话最近几轮历史。
   *
   * **缺省（`undefined`）表示跟随全局** `config.session.context.previousTurns`；
   * 设置页靠这个区分「跟随全局」和「显式 0 轮（这台机器人不带历史）」。
   */
  historyTurns?: number
  appId?: string
  targetChatId?: string
  groupChatId?: string
  feishuAppId?: string
  feishuReceiveId?: string
  feishuReceiveIdType: 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email'
  mode: 'active' | 'passive'
  /** 用户从 IM 平台复制的绑定链接；有它才渲染二维码。 */
  bindUrl?: string
  appSecret: SecretState
  feishuAppSecret: SecretState
}

/** 运行状态快照，渲染页面底部的状态条。 */
export interface StatusSnapshot {
  /** 插件运行时是否已启动（`enabled=false` 时为 false）。 */
  running: boolean
  enabled: boolean
  mode: 'global' | 'session'
  targetSessionId?: string
  /** 被单独升级成完整上下文的会话短 id 列表。 */
  detailSessions: string[]
  /** 进程内累计推送条数（重启归零，用于「已推送 N 条」）。 */
  pushed: number
  startedAt: number
  dataDir: string
  configPath: string
  statePath: string
  /** 当前挂起的扫码绑定流程；没有就是 undefined。 */
  pendingBind?: PendingBind
  channels: {
    id: string
    type: string
    enabled: boolean
    connected: boolean
    sent: number
    failed: number
    lastError?: string
  }[]
}

/** 一次 `state` 调用的完整返回值。 */
export interface StatePayload {
  config: {
    enabled: boolean
    mode: 'global' | 'session'
    defaultChannelId?: string
    logLevel: 'debug' | 'info' | 'warn' | 'error'
    dataDir: string
    channels: RedactedChannel[]
    events: {
      onTurnEnd: boolean
      onError: boolean
      onAborted: boolean
      onPending: boolean
      onMaxTokens: boolean
      includeSubagent: boolean
    }
    content: { includeMetadata: boolean; includeUserPrompt: boolean; maxBodyChars: number }
    routing: {
      allowPrefix: boolean
      fallback: 'latest' | 'intervention' | 'none'
      tableTtlDays: number
      echoTarget: boolean
    }
    session: {
      targetSessionId?: string
      context: {
        includeAssistant: boolean
        includeTools: boolean
        includeTiming: boolean
        previousTurns: number
        includeUserPrompt: boolean
      }
    }
    global: {
      verbosity: 'brief' | 'normal'
      includeSessionLabel: boolean
      includeSummaryLine: boolean
      includeSubagent: boolean
    }
  }
  status: StatusSnapshot
}

// ---------------------------------------------------------------------------
// patch
// ---------------------------------------------------------------------------

/**
 * 一个通道的补丁。
 *
 * 密钥字段的三态语义（三个值必须能区分开，否则「保持原样」与「清空」会被
 * 混成同一个动作）：
 *
 * - **省略**（`undefined`）→ 保持原值不动；
 * - `null` → 清空；
 * - 字符串 → 写入（空串按「清空」处理）。
 *
 * 之所以要「保持原值」，是因为 `state` 从不回显密钥明文，设置页拿不到原值，
 * 只能靠「没改就不发」来避免把自己刚看到的那把密钥抹掉。
 */
export interface ChannelPatch {
  id: string
  type?: 'qq' | 'feishu'
  enabled?: boolean
  label?: string | null
  sessionScope?: 'all' | 'single' | 'filter'
  /** 单会话模式绑定的会话 id；空串 / `null` = 清空（清空后单会话模式谁都不推）。 */
  sessionId?: string | null
  sessionFilter?: string[]
  /**
   * 正文附带的历史轮数。`null` = 回到「跟随全局」，`0` = 这台机器人不带历史。
   */
  historyTurns?: number | null
  overrideEvents?: boolean
  /** `null` = 丢掉这份覆盖（同时把 `overrideEvents` 复位成 false）。 */
  events?: EventsConfig | null
  overrideContent?: boolean
  /** `null` = 丢掉这份覆盖（同时把 `overrideContent` 复位成 false）。 */
  content?: ContentConfig | null
  appId?: string | null
  appSecret?: string | null
  targetChatId?: string | null
  groupChatId?: string | null
  feishuAppId?: string | null
  feishuAppSecret?: string | null
  feishuReceiveId?: string | null
  feishuReceiveIdType?: 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email'
  mode?: 'active' | 'passive'
  bindUrl?: string | null
}

/**
 * 一次保存提交的补丁。
 *
 * `channels` 出现时是**整表替换**（和 `config.ts` 里 `mergeConfig` 对
 * `channels` 的处理保持一致）：设置页永远发完整列表，避免「只发改动的那一条」
 * 被逐项合并成半截通道配置。
 */
export interface TlnotifyPatch {
  enabled?: boolean
  mode?: 'global' | 'session'
  defaultChannelId?: string | null
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  channels?: ChannelPatch[]
  events?: Partial<StatePayload['config']['events']>
  content?: Partial<StatePayload['config']['content']>
  routing?: Partial<StatePayload['config']['routing']>
  session?: {
    targetSessionId?: string | null
    context?: Partial<StatePayload['config']['session']['context']>
  }
  global?: Partial<StatePayload['config']['global']>
}

/** `patch` 的返回值。 */
export interface PatchPayload {
  /**
   * `hot` = 已经生效；`restart-required` = 写盘了但要重启 DSH 才生效。
   *
   * 目前只有 `dataDir` 属于后者，而 `dataDir` 不在补丁白名单里，所以实际
   * 恒为 `hot`；保留这个字段是为了让设置页不必随实现变化改文案。
   */
  applied: 'hot' | 'restart-required'
  /** 实际发生变化的顶层字段，供设置页提示「已保存 N 项」。 */
  changed: string[]
  /** 回写之后的完整脱敏配置，前端直接用它刷新，不用再打一次 `state`。 */
  config: StatePayload['config']
  /** 通道配置变了会重连，这里回报重连结果。 */
  channelsReloaded?: boolean
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

export interface TestRequest {
  /** 不填则用默认通道。 */
  channelId?: string
}

export interface TestPayload {
  channelId: string
  messageId: string
  shards: number
  /** 给用户看的一句结论，例如「测试消息已送达（QQ 单聊）」。 */
  summary: string
}

/**
 * 测试连接失败时的可执行提示。
 *
 * 方案 §5.3 明确要求失败要给「可行动」的提示，而不是把平台原始错误码原样抛给
 * 用户。映射表在 `./rpc.ts` 的 `explainTestFailure()`。
 */
export interface TestFailureHint {
  /** 原始错误文本（已脱敏），放在「详情」折叠区里。 */
  raw: string
  /** 一句话说清该怎么办。 */
  advice: string
}

// ---------------------------------------------------------------------------
// qr / bind：扫码绑定
// ---------------------------------------------------------------------------

/** 绑定流程的有效期（毫秒）。 */
export const BIND_TTL_MS = 10 * 60 * 1000

export interface QrRequest {
  channelId?: string
}

/**
 * 一次挂起的绑定：宿主等一条「从没见过的发送者」发来的入站消息，
 * 把人拿到手之后回填成目标 id。
 */
export interface PendingBind {
  channelId: string
  /** 随机令牌；设置页拿它对 `bind` 轮询，避免两个标签页抢同一次绑定。 */
  token: string
  /** 毫秒时间戳。 */
  expiresAt: number
}

export interface QrPayload {
  channelId: string
  type: 'qq' | 'feishu'
  token: string
  expiresAt: number
  /**
   * 要编码进二维码的内容；没有可扫的链接时是 undefined，此时设置页只展示
   * `instructions`，不画二维码（不画假二维码）。
   */
  qrText?: string
  /** 链接是否是从 App ID 推导出来的（否则是用户手填的 `bindUrl`）。 */
  derived: boolean
  /** 为什么没有 `qrText`；有 `qrText` 时是 undefined。 */
  missing?: string
  /** 分步说明（换行分隔）。 */
  instructions: string
}

export interface BindRequest {
  channelId: string
  token: string
}

export interface BindPayload {
  /** 是否已经拿到目标 id。 */
  bound: boolean
  /** 绑定成功时的目标 id（QQ 是 openid，飞书是 receive_id）。 */
  targetId?: string
  /** 绑定成功时，写入的是哪个配置字段（`targetChatId` 或 `feishuReceiveId`）。 */
  field?: 'targetChatId' | 'feishuReceiveId'
  /** 是否已过期。 */
  expired: boolean
}

// ---------------------------------------------------------------------------
// 扫码创建机器人（《每机器人设置方案》§4）
// ---------------------------------------------------------------------------

/**
 * 扫码创建机器人的阶段。
 *
 * `starting` = 已发起、二维码还没出来；`waiting` = 二维码在等扫；
 * `scanned` = 扫到了、平台在处理（飞书有这一步）；`connecting` = 凭据已到手、
 * 正在建连；`done` = 完成（设置页这时重新拉一次 `state` 即能看到新机器人）；
 * `expired` = 码过期（重新 begin 即可）；`cancelled` = 用户自己取消；
 * `failed` = 失败，看 `error`。
 */
export type ProvisionState =
  | 'starting'
  | 'waiting'
  | 'scanned'
  | 'connecting'
  | 'done'
  | 'expired'
  | 'cancelled'
  | 'failed'

/**
 * 一次扫码创建流程的快照。
 *
 * **只回二维码的 data URL，不回厂商原始链接**——厂商链接里可能带一次性凭据，
 * 而 `dsh-im` 的硬契约也是这么做的（`FORBIDDEN_PUBLIC_KEYS.verificationUrl`）。
 */
export interface ProvisionSnapshot {
  attemptId: string
  channelId: string
  type: 'qq' | 'feishu'
  state: ProvisionState
  /** 二维码图片（`data:image/png;base64,…`）。 */
  qrDataUrl?: string
  /** 退化路径：厂商只给链接时，交给设置页用内置 qrcode 渲染。 */
  qrText?: string
  /** 过期时间戳（毫秒）。 */
  expiresAt?: number
  /** 建议轮询间隔（毫秒，500..10000）。 */
  pollIntervalMs: number
  /** 完成时写入了哪个字段。 */
  filledField?: 'appId' | 'feishuAppId'
  /** 完成时顺手带上的投递目标（QQ 扫码会连 userOpenid 一起给）。 */
  filledTargetId?: string
  error?: string
}

export interface ProvisionRequest {
  channelId: string
}

export interface ProvisionPollRequest extends ProvisionRequest {
  attemptId: string
}

// ---------------------------------------------------------------------------
// 会话列表（每机器人绑定会话用）
// ---------------------------------------------------------------------------

/**
 * 设置页「选会话」里的一行。
 *
 * 标题的回退顺序在宿主里就算好（会话标题 → 项目目录名 → 会话 id），设置页直接
 * 显示 `title`，不必自己再推一遍；`project` / `cwd` / `updatedAt` 是给用户确认
 * 「选的是哪个会话」的上下文——只有 id 的话，几个会话同时开着时根本认不出来。
 */
export interface ChannelSessionSummary {
  /** 完整会话 id（`sessionId` / `sessionFilter` 里存的就是它）。 */
  id: string
  /** 可直接显示的标题（已按上面的回退顺序算好）。 */
  title: string
  /** 项目目录 basename（`session.header.cwd`）。 */
  project: string
  /** 完整工作目录；宿主拿不到就是空串。 */
  cwd: string
  /** 是否是子 Agent 会话（这类会话一般不该单独绑给机器人）。 */
  subagent: boolean
  /** 最近活动时间戳（毫秒）；拿不到就是 0。 */
  updatedAt: number
  /** 此刻是否有轮次在跑。 */
  running: boolean
}

/** `sessions.list` 的返回值。 */
export interface SessionListPayload {
  sessions: ChannelSessionSummary[]
  /**
   * 读不到会话列表时的原因（宿主没有那个服务）。
   *
   * 有值时 `sessions` 为空数组：设置页据此提示「可以手填会话 id」，而不是把
   * 「一个会话都没有」当成真的没有会话。
   */
  unavailable?: string
}

// ---------------------------------------------------------------------------
// 方法 → 请求/响应 的映射
// ---------------------------------------------------------------------------

export interface RpcContract {
  state: { request: undefined; response: StatePayload }
  patch: { request: { patch: TlnotifyPatch }; response: PatchPayload }
  test: { request: TestRequest; response: TestPayload }
  qr: { request: QrRequest; response: QrPayload }
  bind: { request: BindRequest; response: BindPayload }
  'provision.begin': { request: ProvisionRequest; response: ProvisionSnapshot }
  'provision.poll': { request: ProvisionPollRequest; response: ProvisionSnapshot }
  'provision.cancel': { request: ProvisionPollRequest; response: ProvisionSnapshot }
  'sessions.list': { request: undefined; response: SessionListPayload }
}
