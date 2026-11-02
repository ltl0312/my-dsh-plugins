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
  /** 提问里这一题的 id（`ask_user_question` 的 `questions[i].id`）。
   *  两条生产者路径（`tool/call` 兜底与 waterfall）都拿得到它，用来认「这是同一个提问」。 */
  questionId?: string
  /** 一次请求带多个问题时，这是第几问（0 起）。只在 `questionTotal > 1` 时填。 */
  questionIndex?: number
  /** 一次请求带了多少个问题。只在 `> 1` 时填（单问题事件的形状与以前完全一致）。 */
  questionTotal?: number
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
  /**
   * 「提交所选」按钮（只有多选提问才有）。
   *
   * 多选提问里，选项按钮一下去只是**勾上 / 取消一个候选**、并不结算；把已经勾好的
   * 候选一起交给宿主的是这个按钮。少了它，第一次点击就把整题答了，用户点第二个只会
   * 拿到「这个请求已经结束或过期了」——他看到的正是「只能选一个」。
   */
  submit?: true
  /** 提问自定义回答 / 模式命令参数。 */
  text?: string
}

export interface NotificationAction {
  label: string
  value: ActionValue
  /** 危险操作（拒绝 / 中止）用不同样式。 */
  tone?: 'primary' | 'default' | 'danger'
  /**
   * 「点过之后按钮上显示什么」（QQ 的 `render_data.visited_label`）。
   *
   * 多选拿它把按钮变成复选框：`label` 是 `☐ 甲`，点一下客户端换成 `visited_label`
   * 的 `☑ 甲`。这是**客户端本地**的显示，取消勾选不会变回去——真正的勾选态以回执清单
   * 为准。通道不支持这个概念时（飞书）忽略即可。
   */
  visitedLabel?: string
}

/**
 * 通知的「种类」。
 *
 * 除了 9 类事件，还有一类 `echo`——就是我们自己回给用户的操作回执
 * （「已发给 X」「已允许」「没有可投递的会话」）。它走完全相同的通道与分片
 * 管道，但不属于任何会话事件，所以单独列一个值而不是硬塞进 EventKind。
 */
export type NotificationKind = EventKind | 'echo' | 'chat'

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
  /**
   * 按钮自己能不能表达「这颗点过了」（QQ 的 `render_data.visited_label`）。
   *
   * 能表达时，多选勾选**不再逐次回执**：点一下按钮由 ☐ 变 ☑ 就是反馈，回执只在
   * 「取消勾选」——按钮说不清的那种情况——补一条（见 `index.ts#onAction`）。
   * 每次点击都回一条消息会把 QQ 对话刷成一串「当前勾选」，实测用户明确反对。
   */
  readonly showsPressedState?: boolean
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

export type ChannelType = 'qq' | 'feishu' | 'onebot'

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
  // ---- 夺舍 QQ（OneBot v11：NapCat / Lagrange / go-cqhttp 系）----
  /**
   * 是否开启「夺舍 QQ 直接对话」。
   *
   * 与官方机器人通道是两条独立的路：官方 Bot 走开放平台被动回复窗口（有发言
   * 配额、要审核），夺舍 QQ 走 OneBot 协议直连一个**真人 QQ 号**，想说什么说什么。
   * 默认关：它要求的 QQ 号与凭据属于用户自己的账号，不该被静默启用。
   */
  takeoverEnabled?: boolean
  /** 被夺舍的 QQ 号（OneBot 的 `self_id`）。回声锁与群 @ 判定都靠它。 */
  selfId?: string
  /** 反向 WS 的挂载路径，默认 `/tlnotify/onebot/ws`；OneBot 端填同一个地址。 */
  wsPath?: string
  /** 正向 WS 地址（`ws://host:3001`）；填了就由我们主动连过去，与反向二选一。 */
  wsUrl?: string
  /** OneBot HTTP API 地址（`http://host:3000`）；发消息与输入状态都走它。 */
  httpUrl?: string
  /** OneBot 的 access_token；留空表示服务端未开启鉴权。 */
  accessToken?: string
  /**
   * 允许私聊直接对话的 QQ 号。
   *
   * `['*']` = 任何人（**不建议**，等于把模型暴露给所有陌生人）；留空 = 谁都不放行。
   */
  allowedPrivateUsers?: string[]
  /** 允许触发对话的群号；留空 = 任何群都不响应。 */
  allowedGroups?: string[]
  /** 群聊触发方式：被 @ 或以 `groupPrefix` 开头 / 只认前缀 / 全部消息都算。 */
  groupTriggerMode?: 'at_or_prefix' | 'prefix_only' | 'all'
  /** 群聊触发前缀，默认角色名「流萤」。 */
  groupPrefix?: string
  /** 出站 Markdown 策略：原生 MD 节点 / 失败自动回退 / 直接纯文本。 */
  mdRenderMode?: 'native_md' | 'auto_fallback' | 'plain'
  /** 对话固定使用的 DSH 会话 id；留空则用 `session.targetSessionId` / 最近会话。 */
  chatSessionId?: string
  /**
   * 这条通道自己的「直接对话」开关组。
   *
   * 挂在通道上而不是全局：一个通道是不是聊天窗口，取决于它连的是什么。
   * 官方 Bot 走通知订阅，夺舍 QQ 才是真人对话；同一个人完全可能挂三个通知
   * 机器人、只让其中一个能聊天。缺省时由 `config.ts` 的 `defaultChatMode()` 补齐。
   */
  chat?: ChatModeConfig
  /**
   * 这条通道在 tlrp 里用哪个角色（`tlrp` 的 `characters[].id`）。
   *
   * 空串/缺省 = 跟随 tlrp 的全局 `activeCharacterId`。挂在通道上是因为
   * 「通知用的机器人」和「聊天用的机器人」往往不是同一个号，角色也该分开。
   */
  tlrpCharacterId?: string
  /**
   * 这条通道在 tlrp 里用哪个形态（`tlrp` 的 `modes[].id`，如 `rp`/`work`/`sam`）。
   *
   * 空串/缺省 = 跟随 tlrp 的全局 `mode`（通常 `auto`，按关键词自动判定）。
   * 填具体 id 就是给这条通道锁死形态——群里排障用 `work`、私聊陪聊用 `rp`。
   */
  tlrpMode?: string
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

/**
 * 直接对话（Interactive Chat）全局设置。
 *
 * 与「通知」是两回事：通知是 DSH 有事要告诉你，对话是你在 QQ 里问 DSH。虽然
 * 共用同一个通道，但对话要多走一遍**模型回合**，所以它的开关、超时与护栏都在
 * 这里，而不是散落在每个通道里。
 */
export interface ChatModeConfig {
  /** 对话总开关；关掉后 OneBot 通道只做通知，入站消息一律无视。 */
  enabled: boolean
  /**
   * 等待模型回复的上限毫秒数。
   *
   * 超时不代表失败：DSH 的回合可能还在跑，只是没在时限内收尾。超时后仍然
   * 会把已产出的内容发出去（有内容）或回一句「还在想」（没内容），绝不静默丢弃。
   */
  replyTimeoutMs: number
  /**
   * 是否把 `tlrp` 的模式判定、触发词与角色设定注入到 QQ 对话里。
   *
   * 开着时，QQ 里说话与在本机会话里说话看到的是同一个「她」；关掉则 QQ 只
   * 走裸模型，不注入任何角色。缺 tlrp 服务时整段静默跳过。
   */
  injectTlrp: boolean
  /**
   * RP 态下是否屏蔽运维工具。
   *
   * 聊天时不该突然去翻服务器目录——这既是观感问题，也是安全问题：QQ 那一侧
   * 的输入来自任何人（白名单内），而工具权限是本机的。
   */
  blockToolsInRp: boolean
  /** 回复前是否先发一个「正在输入」提示（协议支持时）。 */
  typingIndicator: boolean
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
