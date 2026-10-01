/**
 * 设置页 RPC 的线上契约（设计方案《设置页方案》§4.3）。
 *
 * 这个文件**只放契约**：类型、常量、方法名。宿主侧的校验与落盘逻辑在
 * `./rpc.ts`，浏览器侧的调用封装在 `./client/rpc.ts`。两边都从这里取类型，
 * 保证「设置页改了哪一项、宿主认哪些字段」永远只有一份定义。
 *
 * ## 与方案文档的对应关系
 *
 * 方案里写的是四个 HTTP 端点：
 *
 * | 方案文档                        | 实际实现                                        |
 * | ------------------------------- | ----------------------------------------------- |
 * | `GET  /tlnotify/rpc/state`      | `call(RPC_CHANNEL, 'state')`                    |
 * | `POST /tlnotify/rpc/patch`      | `call(RPC_CHANNEL, 'patch', { patch })`         |
 * | `POST /tlnotify/rpc/test`       | `call(RPC_CHANNEL, 'test',  { channelId? })`    |
 * | `POST /tlnotify/rpc/qr`         | `call(RPC_CHANNEL, 'qr',    { channelId? })`    |
 *
 * 我们**不走自建 HTTP 路由**，而是用 DSH 原生的客户端 RPC 通道
 *（宿主 `ctx.connection.rpc.handle(channel, handler)`，
 *  浏览器 `ctx.connection.rpc.call(channel, endpoint, payload)`）。
 * 理由：
 *
 * 1. 原生通道自带鉴权与来源校验（DSH 已经做了 Host/Origin 校验与浏览器
 *    登录态绑定），我们不用自己实现 loopback 白名单、Origin 校验、
 *    请求体上限这一整套，也就不存在把它们写错的风险；
 * 2. 方案 §4.3 的安全约束（只允许本机来源、拒绝跨站、限制体积）由宿主统一
 *    保证，比插件各写一份更可靠；
 * 3. 断线重连、多标签页、桌面端与 Web 端共用同一条链路，不需要额外的
 *    轮询与重试逻辑。
 *
 * 因此方案文档里「只监听 127.0.0.1」这条约束在此实现下是**天然成立**的：
 * 通道本身只在已鉴权的客户端连接上可用。
 *
 * ## 信封
 *
 * 每个方法都返回 `RpcResult<T>`。失败一律走 `{ ok: false, error }`，
 * 而不是抛异常——抛出去会被连接层折叠成一句没有上下文的报错，用户看不到
 * 「哪一项没通过校验」。
 */

/** 客户端 RPC 通道名（绝对前缀，与 `rpc.handle` 的参数一致）。 */
export const RPC_CHANNEL = '/tlnotify'

/** 支持的 RPC 方法。 */
export type RpcMethod = 'state' | 'patch' | 'test' | 'qr' | 'bind'

/** 方法清单，宿主用它做白名单（未知方法直接拒绝，不进业务分支）。 */
export const RPC_METHODS: readonly RpcMethod[] = Object.freeze([
  'state',
  'patch',
  'test',
  'qr',
  'bind',
] as const)

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
  sessionFilter: string[]
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
  sessionFilter?: string[]
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
// 方法 → 请求/响应 的映射
// ---------------------------------------------------------------------------

export interface RpcContract {
  state: { request: undefined; response: StatePayload }
  patch: { request: { patch: TlnotifyPatch }; response: PatchPayload }
  test: { request: TestRequest; response: TestPayload }
  qr: { request: QrRequest; response: QrPayload }
  bind: { request: BindRequest; response: BindPayload }
}
