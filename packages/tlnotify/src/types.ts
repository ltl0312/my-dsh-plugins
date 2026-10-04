// packages/tlnotify/src/types.ts
//
// 全插件共享的词汇表。这里刻意**不** import 任何 @deepseek-ai/* 运行时模块：
// 插件安装在自己的 profile 里，`@deepseek-ai/*` 位于 DSH 宿主自己的
// node_modules 下，bare specifier 从插件文件出发解析不到。所有宿主类型都通过
// `import type`（编译期擦除）或下面这些结构化的最小接口来表达。

// ---------------------------------------------------------------------------
// 事件种类
// ---------------------------------------------------------------------------

/**
 * 归一化后的 9 类事件。
 *
 * 与设计方案 §4.1 一一对应；注意宿主里 Token 上限的 kind 字面量是
 * **带连字符的 `'max-tokens'`**，不是 `maxTokens`——`events.ts` 两种都兼容。
 */
export type EventKind =
  | 'completed' // 任务完成：turn/end + reason.kind='completed'
  | 'error' // 执行错误：reason.kind='error'
  | 'blocked' // 执行被阻塞：reason.kind='blocked'
  | 'aborted' // 手动中止：reason.kind='aborted'（只报 kind='user'）
  | 'max-tokens' // Token 达到上限：reason.kind='max-tokens'
  | 'interrupted' // 异常中断：心跳超时 / 进程消失
  | 'question' // 等待我回答：tool/call name='ask_user_question'
  | 'approval' // 等待授权：approval/asked
  | 'plan' // 等待计划确认：tool/call name='exit_plan_mode'

export const EVENT_KINDS: readonly EventKind[] = Object.freeze([
  'completed',
  'error',
  'blocked',
  'aborted',
  'max-tokens',
  'interrupted',
  'question',
  'approval',
  'plan',
])

/** 标题里那一段中文短标签（设计方案 §4.3 的第三段）。 */
export const EVENT_LABELS: Readonly<Record<EventKind, string>> = Object.freeze({
  completed: '任务完成',
  error: '执行错误',
  blocked: '执行被阻塞',
  aborted: '手动中止',
  'max-tokens': 'Token 达到上限',
  interrupted: '异常中断',
  question: '等待我回答',
  approval: '权限请求',
  plan: '等待计划确认',
})

/** 需要人介入的事件——路由兜底会优先选「最近一次需要人介入的会话」。 */
export const INTERVENTION_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'question',
  'approval',
  'plan',
  'error',
  'blocked',
  'max-tokens',
])

export type NotificationLevel = 'info' | 'warn' | 'error'

export const LEVEL_BY_KIND: Readonly<Record<EventKind, NotificationLevel>> = Object.freeze({
  completed: 'info',
  error: 'error',
  blocked: 'warn',
  aborted: 'warn',
  'max-tokens': 'warn',
  interrupted: 'error',
  question: 'warn',
  approval: 'warn',
  plan: 'warn',
})

// ---------------------------------------------------------------------------
// 事件 → 通知
// ---------------------------------------------------------------------------

/** 从 `session/event` 里抽出来的、与宿主解耦的事件快照。 */
export interface RawEvent {
  kind: EventKind
  sessionId: string
  /** 该会话内单调递增的 seq，去重键的一半。 */
  seq: number
  /** epoch ms。 */
  time: number
  /** 事件专属细节：错误信息、工具名、提问正文…… */
  detail: EventDetail
}

export interface EventDetail {
  /** 项目目录（`session.header.cwd` 的 basename）。 */
  project: string
  /** 错误文本 / 阻塞原因 / 提问正文，用于正文渲染。 */
  text?: string
  /** 结构化请求 id：审批用 approval/asked 的 id，提问用 callId。 */
  requestId?: string
  /** 工具名（审批 / 阻塞场景）。 */
  toolName?: string
  /** 工具参数（已解析，失败则留原文）。 */
  toolArguments?: unknown
  /** 提问的选项列表。 */
  options?: readonly QuestionOption[]
  /** 提问里第一题的 id（`ask_user_question` 的 `questions[0].id`）。
   *  两条生产者路径（`tool/call` 兜底与 waterfall）都拿得到它，用来认「这是同一个提问」。 */
  questionId?: string
  /** 是否允许多选。 */
  multiSelect?: boolean
  /** 计划正文（exit_plan_mode 的 plan markdown）。 */
  plan?: string
  /** 本 turn 累计的助手正文与工具调用，由 aggregate.ts 提供。 */
  body?: string
  /** 本 turn 耗时（ms）。 */
  durationMs?: number
  /** 本 turn 使用的 token 数（若宿主给了 usage）。 */
  tokens?: number
}

export interface QuestionOption {
  label: string
  description?: string
}

/** 一轮里的一次工具调用（aggregate.ts 累积）。 */
export interface ToolCallRecord {
  name: string
  callId: string
  /** 模型产出的原始参数 JSON 字符串。 */
  arguments: string
  /** 有 tool/result 且不是错误时为 true；未结算时保持 true。 */
  ok: boolean
  error?: string
}

/** 一轮结束时定格的快照（aggregate.ts 产出，render.ts 消费）。 */
export interface TurnSnapshot {
  turn: number
  /** epoch ms。 */
  startedAt: number
  endedAt: number
  durationMs: number
  /** 本轮的助手纯文本（拼接后的）。 */
  assistantText: string
  tools: ToolCallRecord[]
  /** 本轮的真人提问。 */
  userPrompt?: string
  tokens?: { input: number; output: number; total?: number }
  errors: string[]
}

/** 按钮回传的结构化 value（设计方案 §4.3）。 */
export interface ActionValue {
  /** 版本号，将来协议变更时用来兼容旧按钮。 */
  v: 1
  kind: 'approval' | 'question' | 'plan' | 'stop' | 'goto' | 'detail' | 'mode'
  sessionId: string
  /** 审批 id / 提问 callId。 */
  requestId?: string
  /**
   * 提问的题目 id（`questions[0].id`）。
   *
   * 按钮上的 `requestId` 是**投递这条通知的那条生产者路径**算出来的：`session/event` 的
   * `tool/call` 带真实 callId，而 `user-questions/request` waterfall 在宿主没给 callId 时
   * 会自己合成 `question-<n>-<时间戳>`。两条路都可能抢到投递权（现场 05:20:39 是日志兜底
   * 先跑），于是通知里的 id 和桥注册 pending 用的键对不上，点按钮就是「这个请求已经结束
   * 或过期了」。题目 id 是两条路都认得的身份，`InteractionBridge#resolvePending` 拿它做
   * 兜底匹配（见 inject.ts）。
   */
  questionId?: string
  /** 审批：'allow' | 'reject'；提问：选项 label。 */
  choice?: string
  /** 提问：选项下标（label 可能重复，下标不会）。 */
  optionIndex?: number
  /** 提问自定义回答 / 模式命令参数。 */
  text?: string
}

export interface NotificationAction {
  label: string
  value: ActionValue
  /** 危险操作（拒绝 / 中止）用不同样式。 */
  tone?: 'primary' | 'default' | 'danger'
}

/**
 * 通知的「种类」。
 *
 * 除了 9 类事件，还有一类 `echo`——就是我们自己回给用户的操作回执
 * （「已发给 X」「已允许」「没有可投递的会话」）。它走完全相同的通道与分片
 * 管道，但不属于任何会话事件，所以单独列一个值而不是硬塞进 EventKind。
 */
export type NotificationKind = EventKind | 'echo'

/** 送进通道的最终形态。 */
export interface Notification {
  /** 标题：`DSH · <项目> · <短id> · <事件>` */
  title: string
  /** 纯文本正文：Markdown 已经压平，给飞书这类只认 `text` / `lark_md` 的通道用。 */
  body: string
  /**
   * 原生 Markdown 正文，与 `body` 同源、同长度上限。
   *
   * QQ 现在发 `msg_type: 2`（原生 Markdown，见 `channels/qq.ts`），助手回复里的
   * `##`、`**`、表格、代码块都能真的渲染出来；飞书没有这个能力，所以两版正文一起
   * 产出，由通道自己挑（`notification.markdown ?? notification.body`）。
   */
  markdown?: string
  actions: readonly NotificationAction[]
  level: NotificationLevel
  sessionId: string
  /** 去重键：`<sessionId>:<kind>:<seq>` */
  tag: string
  kind: NotificationKind
}

// ---------------------------------------------------------------------------
// 通道统一接口（设计方案 §3.2，4 个方法）
// ---------------------------------------------------------------------------

/** 用户在 IM 里回复的一条文本。 */
export interface InboundReply {
  text: string
  /** 平台侧被引用消息的 id（QQ 用 refMsgIdx，飞书用 parent_id/root_id）。 */
  quotedMessageId?: string
  /** 被引用消息的正文——QQ 没有 message_reference 字段，只能靠正文兜底反查。 */
  quotedText?: string
  /** 本条入站消息的平台 id（被动回复窗口要用）。 */
  messageId?: string
  senderId?: string
}

/** 用户点了按钮。 */
export interface InboundAction {
  value: ActionValue
  senderId?: string
  /** 承载按钮的那条通知的平台消息 id。 */
  messageId?: string
}

export interface ChannelLogger {
  info(message: string): void
  warn(message: string, error?: unknown): void
  error(message: string, error?: unknown): void
  /** 只写进 verbose/debug 级别的细碎日志；实现可以省略（调用方需容忍 undefined）。 */
  debug?(message: string): void
  /** 带前缀的子 logger；实现可以省略（调用方需容忍 undefined）。 */
  child?(prefix: string): ChannelLogger
}

export interface ChannelStartContext {
  onInbound(reply: InboundReply): void | Promise<void>
  onAction(action: InboundAction): void | Promise<void>
  log: ChannelLogger
}

export interface Channel {
  readonly id: string
  readonly type: string
  /** 单条消息的正文上限（字符数），分片用；不填则用 render 的默认值。 */
  readonly maxChars?: number
  start(context: ChannelStartContext): Promise<void>
  stop(): Promise<void>
  send(notification: Notification): Promise<{ messageId: string; refIdx?: string }>
  /**
   * 原地更新一条已发出的通知（按钮点完后把正文改成「已允许」并摘掉按钮）。
   *
   * 返回新的平台消息 id（当平台不支持编辑、只能撤回重发时）；无法更新时
   * 返回 undefined，调用方应静默接受——通知本身已经送达，更新失败不该报错。
   */
  update(messageId: string, patch: Partial<Notification>): Promise<{ messageId?: string } | undefined>
}

// ---------------------------------------------------------------------------
// 配置（设计方案 §4.6）
// ---------------------------------------------------------------------------

export type ChannelType = 'qq' | 'feishu'

export interface ChannelConfig {
  id: string
  type: ChannelType
  enabled: boolean
  // ---- 每机器人独立设置（设计方案《每机器人设置方案》§2）----
  /** 别名。只在设置页显示，不参与任何标识；空串 = 显示 `id`。 */
  label?: string
  /**
   * 关心的会话范围。
   *
   * `'all'` = **关心全局**（任何会话的事件都能投给它）；`'single'` = 只推
   * `sessionId` 绑定的那一个会话；`'filter'` = 只接收 `sessionFilter` 列表里的
   * 会话。缺省时按 `sessionId` / `sessionFilter` 是否有值推断，以保持
   * 「留空 = 全部」的老语义。
   */
  sessionScope?: 'all' | 'single' | 'filter'
  /**
   * 单会话模式绑定的会话 id（完整 id，不是短 id）。
   *
   * 空串 = 还没选：这时 `sessionScope === 'single'` 不会推任何会话（宁可安静，
   * 也不要因为「没选就给全部」而突然刷屏）。设置页选定后会自动带上会话标题，
   * 见 `ChannelSessionSummary`。
   */
  sessionId?: string
  /** 通道只接收这些会话的事件；`sessionScope === 'filter'` 时才生效。 */
  sessionFilter?: string[]
  /** 事件开关是否覆盖全局（false / 缺省 = 跟随全局 `config.events`）。 */
  overrideEvents?: boolean
  /** 覆盖用的事件开关；仅 `overrideEvents === true` 时生效。 */
  events?: EventsConfig
  /** 正文内容是否覆盖全局（false / 缺省 = 跟随全局 `config.content`）。 */
  overrideContent?: boolean
  /** 覆盖用的正文设置；仅 `overrideContent === true` 时生效。 */
  content?: ContentConfig
  /**
   * 正文里附上该会话最近几轮历史。
   *
   * 三态：`undefined` = 跟随全局 `session.context.previousTurns`；`0` = 这台
   * 机器人**不带**历史；`N > 0` = 带最近 N 轮（上限 20）。
   */
  historyTurns?: number
  // ---- QQ ----
  /** 机器人 AppID（QQ 开放平台）。 */
  appId?: string
  /** 机器人 AppSecret（QQ 开放平台）。 */
  appSecret?: string
  /** 单聊目标 openid（就是你自己）；也是默认投递目标。 */
  targetChatId?: string
  /** 群聊 openid；填了就投递到群，否则投到 targetChatId 的单聊。 */
  groupChatId?: string
  /**
   * QQ 用原生 Markdown（`msg_type: 2`）发正文，默认 **false**。
   *
   * 为什么默认关：QQ 客户端把 markdown 消息画在一张**固定宽度**的卡片里（实测
   * 桌面端约 600px，而同一窗口里普通文本气泡约 850px），且不随窗口自适应；
   * 关掉之后正文走纯文本（`msg_type: 0`），观感与普通消息一致。见 README
   * 「QQ 原生 Markdown」一节。
   */
  markdown?: boolean
  // ---- 飞书 ----
  /** 飞书自建应用 App ID。 */
  feishuAppId?: string
  /** 飞书自建应用 App Secret。 */
  feishuAppSecret?: string
  /** 飞书接收方 open_id / chat_id。 */
  feishuReceiveId?: string
  /** 飞书 receive_id_type，默认 open_id。 */
  feishuReceiveIdType?: 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email'
  // ---- 通用 ----
  /** 投递模式：active=主动推送，passive=只借被动回复窗口（更省配额）。 */
  mode?: 'active' | 'passive'
  /**
   * 扫码绑定用的链接（用户从 IM 平台后台复制的机器人分享链接）。
   *
   * 飞书在没填这项时能用 AppID 推导出 applink；QQ 推导不出来，只能填这里，
   * 或者走「给机器人发一条消息」的无扫码绑定路径。见 `rpc.ts` 的
   * `deriveBindLink()`。
   */
  bindUrl?: string
}

export interface EventsConfig {
  onTurnEnd: boolean
  onError: boolean
  onAborted: boolean
  onPending: boolean
  onMaxTokens: boolean
  /** 是否把子 Agent（header.origin==='subagent'）的事件也推出来。 */
  includeSubagent: boolean
}

export interface ContentConfig {
  /** 是否在正文里带耗时 / token 等元信息。 */
  includeMetadata: boolean
  /** 是否把用户上一轮的提问也带进正文。 */
  includeUserPrompt: boolean
  /** 正文硬上限，超出部分截断（不是分片）。 */
  maxBodyChars: number
}

export interface RoutingConfig {
  /** 是否允许「<短id> 继续」这种显式前缀定向。 */
  allowPrefix: boolean
  /** 无引用时的兜底策略。 */
  fallback: 'latest' | 'intervention' | 'none'
  /** 路由表 TTL（天）。 */
  tableTtlDays: number
  /** 是否回显「已发给 X」。 */
  echoTarget: boolean
}

export interface SessionModeConfig {
  targetSessionId?: string
  context: {
    includeAssistant: boolean
    includeTools: boolean
    includeTiming: boolean
    /** 正文里附上最近 N 轮的用户提问。 */
    previousTurns: number
    includeUserPrompt: boolean
  }
}

export interface GlobalModeConfig {
  verbosity: 'brief' | 'normal'
  includeSessionLabel: boolean
  includeSummaryLine: boolean
  includeSubagent: boolean
}

export interface TlnotifyConfig {
  enabled: boolean
  mode: 'global' | 'session'
  defaultChannelId?: string
  channels: ChannelConfig[]
  events: EventsConfig
  content: ContentConfig
  routing: RoutingConfig
  session: SessionModeConfig
  global: GlobalModeConfig
  /** 日志级别。 */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** 关闭时用哪个目录存放 config.json / state.json / plugin.log。 */
  dataDir?: string
}

// ---------------------------------------------------------------------------
// 持久化状态
// ---------------------------------------------------------------------------

export interface RouteEntry {
  sessionId: string
  time: number
}

export interface RouteState {
  /** 平台消息 id → 会话。 */
  byMessage: Record<string, RouteEntry>
  /** 平台会话/话题根 id → 会话（飞书 parent_id/root_id）。 */
  byThread: Record<string, RouteEntry>
  /** QQ ref_msg_idx → 会话。 */
  byRefIdx: Record<string, RouteEntry>
  /** 通知正文 sha1 前 16 位 → 会话（QQ 引用回复只能拿到正文）。 */
  byContent: Record<string, RouteEntry>
  /** 最新一条通知的会话。 */
  latest?: RouteEntry
  /** 最近一次需要人介入的会话。 */
  lastIntervention?: RouteEntry
}

export interface PersistedState {
  version: 1
  routes: RouteState
  /** 全局模式下被临时升级成详细模式的会话。 */
  detailSessions: string[]
  /** 已处理过的入站消息 id（防平台重投）。 */
  seenInbound: string[]
  /** 最近一次运行模式，便于重启后恢复（config.json 才是权威）。 */
  lastMode?: 'global' | 'session'
}
