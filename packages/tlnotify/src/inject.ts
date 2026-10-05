// packages/tlnotify/src/inject.ts
//
// 两条方向相反的通路：
//
//   SessionInjector   —— IM 的回复 → 宿主会话（`ctx.agents.get(id).followup(...)`）
//   InteractionBridge —— 宿主的等待 → IM 的通知 + 按钮回执
//
// ── 关于「认领 waterfall」这件事 ──────────────────────────────────────────────
//
// 宿主里「等待授权」和「等待提问」都没有「按 id 答复」的 API；唯一能插手的点是
// 两个 cordis waterfall 钩子：
//
//   'approval/request'       (req, next) => Promise<ApprovalOutcome>
//   'user-questions/request' (req, next) => Promise<AskUserQuestionAnswer>
//
// waterfall 的规则是「不调用 next() 即否决后续监听器」。如果我们直接返回自己的
// 答案，Web GUI 上的审批弹窗和提问卡片就**永远不出现**了——那是不能接受的：用户
// 可能正坐在电脑前。
//
// 所以我们**先调 next()**（让 GUI 照常工作），再把自己的答案 Promise 和它的
// Promise 放进 `Promise.race`。谁先到用谁。IM 先到时，宿主会记录我们的答案并把
// 提问标记为已结算，GUI 的卡片随之消失；GUI 先到时，我们的 Promise 就烂在那里，
// 由 `finally` 清掉 pending 表项。
//
// 代价是并发回答（两边同时点）会以先到的为准，另一边的答案变成「迟到的回答」。
// 宿主对迟到回答的处理是把它作为一条 user message steer 进去——语义上完全说得通。

import type { ActionValue, EventDetail, EventKind, InboundAction, Notification, RawEvent } from './types.js'
import { ASK_USER_QUESTION_TOOL, EXIT_PLAN_MODE_TOOL, projectName } from './events.js'

// ---------------------------------------------------------------------------
// 宿主对象的最小结构化视图
// ---------------------------------------------------------------------------

export interface UserMessageLike {
  id: string
  role: 'user'
  content: { type: 'text'; text: string }[]
  source: { kind: 'user' }
}

export interface AgentLike {
  readonly status: 'idle' | 'running'
  readonly session?: { id: string; header?: { cwd?: string; origin?: string; delegationDepth?: number } }
  followup(message: UserMessageLike): void
  cancel(cause: { kind: 'user' }): void
}

/** MessageId 在宿主里就是一个 UUID 字符串，不需要 import 宿主的工厂函数。 */
function newMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `tlnotify-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// ---------------------------------------------------------------------------
// 注入：IM → 会话
// ---------------------------------------------------------------------------

export interface DeliverResult {
  ok: boolean
  /** 失败原因，直接回给用户。 */
  reason?: string
}

export class SessionInjector {
  readonly #getAgent: (sessionId: string) => AgentLike | undefined

  constructor(getAgent: (sessionId: string) => AgentLike | undefined) {
    this.#getAgent = getAgent
  }

  /**
   * 把一段用户文本送进目标会话。
   *
   * 用 `followup` 而不是 `inject`：`inject` 只把内容塞进模型可见上下文、**不唤醒**
   * driver，所以如果会话正闲着，那条消息会一直躺到下一次有别的动静才被看到。
   * 用户从 IM 回话的意图是「让这个会话动起来」，`followup` 正是「排队一个独立的
   * 普通 turn 并唤醒 driver」。
   */
  deliver(sessionId: string, text: string): DeliverResult {
    const trimmed = text.trim()
    if (trimmed.length === 0) return { ok: false, reason: '内容为空' }
    const agent = this.#getAgent(sessionId)
    if (!agent) return { ok: false, reason: '这个会话已经结束了' }
    try {
      agent.followup({
        id: newMessageId(),
        role: 'user',
        content: [{ type: 'text', text: trimmed }],
        source: { kind: 'user' },
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 中止目标会话正在跑的任务。 */
  cancel(sessionId: string): DeliverResult {
    const agent = this.#getAgent(sessionId)
    if (!agent) return { ok: false, reason: '这个会话已经结束了' }
    try {
      agent.cancel({ kind: 'user' })
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 会话是否还在——路由兜底前必须先问这一句，否则消息会掉进黑洞。 */
  isLive(sessionId: string): boolean {
    return this.#getAgent(sessionId) !== undefined
  }
}

// ---------------------------------------------------------------------------
// 交互桥：等待授权 / 等待提问 → 通知 + 回执
// ---------------------------------------------------------------------------

/** 宿主 `ApprovalOutcome` 里我们会用到的两个值。 */
export type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface ApprovalRequestLike {
  agent?: AgentLike
  toolName: string
  callId?: string
  reason?: string
  displayReason?: { en?: string; [locale: string]: string | undefined }
  signal?: AbortSignal
}

export interface AskUserQuestionItemLike {
  id: string
  question: string
  detail?: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
  intent?: { kind?: string; approve?: string; callId?: string }
}

export interface AskUserQuestionRequestLike {
  questions: AskUserQuestionItemLike[]
  agent?: AgentLike
  signal?: AbortSignal
  wait?: { callId?: string; timed?: boolean }
}

export interface AskUserQuestionAnswerLike {
  answers: { id: string; selected: string[]; custom?: string }[]
}

export interface PendingSettlement {
  ok: boolean
  /** 失败原因（过期 / 找不到）。 */
  reason?: string
  /** 结算后要回给用户的确认文案。 */
  echo?: string
  /**
   * true = **还没**结算，只是进了「等你说自定义答案」的状态（用户回了「N+1. 自定义
   * 回答」那个序号）。调用方照常把 `reason` 回给用户，但别清等待记录。
   */
  armed?: boolean
}

interface PendingBase {
  requestId: string
  sessionId: string
  kind: 'approval' | 'question' | 'plan'
  createdAt: number
  expireTimer: ReturnType<typeof setTimeout>
}

interface PendingApproval extends PendingBase {
  kind: 'approval'
  resolve: (outcome: ApprovalOutcomeLike) => void
}

interface PendingQuestion extends PendingBase {
  kind: 'question' | 'plan'
  questionId: string
  /** 认「这是同一个问题」用的键（会话 + 题目 id），用于压掉重复通知。 */
  questionKey?: string
  /**
   * 这一条属于哪一次请求（一次 `ask_user_question`）。
   *
   * 一次请求可以带多个问题，那时会话里会同时有好几条 pending。文本作答要按「最新那次
   * 请求优先、同一次请求内按题目顺序」挑，所以得知道每条 pending 属于哪一组。
   */
  group?: string
  /** 批准选项的 label（plan-review 才有）。 */
  approveLabel?: string
  /** 所有候选 label，用于校验按钮回传的 choice。 */
  labels: string[]
  /** 宿主说这题可以多选。文本作答时用来把「1 3」拆成两个选项。 */
  multiSelect?: boolean
  /**
   * 用户已经回了「自定义回答」那个序号，正等着他把答案发过来。
   *
   * 这条路径存在的理由：QQ 单聊的按钮不一定渲染，而「自定义回答」不是一个真选项——
   * 它得两段式（先回序号，再发文本），中间那句「4」不能被当成答案。
   */
  awaitingCustom?: boolean
  resolve: (answer: AskUserQuestionAnswerLike) => void
}

type Pending = PendingApproval | PendingQuestion

export interface InteractionBridgeOptions {
  /** 一条等待类事件被识别出来时调用（用于渲染并投递通知）。 */
  onPending: (event: RawEvent) => void | Promise<void>
  log?: (message: string, error?: unknown) => void
  /** 等待多久没人理就放弃认领（毫秒）。默认 30 分钟。 */
  ttlMs?: number
  now?: () => number
}

const DEFAULT_TTL_MS = 30 * 60 * 1000

/**
 * 「这条提问已经有人发过通知了」这笔账最多记多久。
 *
 * 正常情况下这笔账会在提问被结算时（`#finish`）就抹掉，这个上限只是给「只有日志兜底
 * 发过、桥从来没注册过 pending」那种情况兜底，免得表一直涨。
 */
const ANNOUNCE_TTL_MS = 2 * 60 * 1000

/**
 * 把这次交互的取消信号接过来，返回一个「这次交互结束了」的释放函数。
 *
 * 宿主的提问 / 授权是当「转发 Remote event」送到浏览器的（`dsh-api-gateway`）：宿主侧
 * `request.signal` 会被单独抽出来当那条 pending event 的取消信号（不进 JSON 载荷），
 * 浏览器拿到的是重新挂上的 delivery signal。只有宿主 `cancelRemoteEvent`（也就是这个
 * signal abort）时，浏览器才会收到 `cancel` 帧、把那张卡片释放掉。
 *
 * 麻烦在于这个 signal 就是工具调用自己的 signal：**别人抢答之后它永远不会 abort**。
 * 于是 QQ 里回一句话把提问结算了，网页上那张卡片却留在原地——连会话结束都不消失
 * （`dsh-client-ui-user-questions` 的 `reconcile()` 要求 `hasWaterfall()` 为假，
 * `dsh-client-ui-approval` 的 `PendingApproval` 也只认这个 signal 的 abort）。
 *
 * 所以我们在 `proceed()` **之前**把 `request.signal` 换成「原信号 + 我们自己那条」的复合
 * 信号：cordis 的 `next()` 传的是同一个对象引用，下游读到的就是它，网关那边还会校验
 * `instanceof AbortSignal`（复合出来的正好是）。等这次交互真结束了再 abort 自己那条，
 * 宿主就会给浏览器发 cancel 帧，卡片跟着消失。
 *
 * @param request - 宿主给的请求对象；`signal` 会被就地替换。
 * @returns 交互结束时调用。只 abort 我们自己那条，原信号不受影响；对象被冻住时退化成空操作。
 */
function holdRemoteEvent(request: { signal?: AbortSignal }): () => void {
  const lifetime = new AbortController()
  const original = request.signal
  if (original !== undefined) {
    if (original.aborted) lifetime.abort(original.reason)
    else original.addEventListener('abort', () => lifetime.abort(original.reason), { once: true })
  }
  try {
    request.signal = lifetime.signal
  } catch {
    // 请求对象被冻住（或 signal 只读）：退回老行为——卡片只能靠网页自己点掉。
    return () => {}
  }
  return () => lifetime.abort(new Error('tlnotify：这次交互已经在别处结算了'))
}

/**
 * 把宿主的两个 waterfall 钩子接到 IM 上。
 *
 * `install(ctx)` 需要传 cordis 的 `Context`——这里按 any 收，因为插件的
 * `inject` 列表里没有 `agents` 之类的服务名可以约束，而 `ctx.on` 的签名在
 * 编译期也拿不到（插件不 import 宿主类型）。
 */
export class InteractionBridge {
  readonly #pending = new Map<string, Pending>()
  /** 「会话 + 题目 id」→ 正在等作答的 requestId，用来认出被重复投递的同一个问题。 */
  readonly #liveQuestions = new Map<string, string>()
  /** 「会话 + 题目 id」→ 这条提问的通知是什么时候发出去的，两条生产者路径共用的一道闸。 */
  readonly #announced = new Map<string, number>()
  readonly #options: InteractionBridgeOptions
  readonly #ttlMs: number
  readonly #now: () => number
  #disposers: (() => void)[] = []
  #counter = 0

  constructor(options: InteractionBridgeOptions) {
    this.#options = options
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#now = options.now ?? (() => Date.now())
  }

  get pendingCount(): number {
    return this.#pending.size
  }

  /**
   * 这个会话现在有没有正在等作答的请求。
   *
   * 给日志兜底路径（`index.ts` 的 `#maybePending`）用。那条路原本只靠 requestId 判断
   * 「waterfall 是不是已经认领了同一个提问」，但 waterfall 在宿主没给 callId 时会自己
   * 合成一个 id（`question-<n>-<时间戳>`），两边永远对不上，于是同一个提问被两条路各发了
   * 一条通知。按「会话 + 类型」问一句就不依赖 id 了。
   */
  hasLivePending(sessionId: string, kind: 'approval' | 'question' | 'plan'): boolean {
    for (const pending of this.#pending.values()) {
      if (pending.sessionId !== sessionId) continue
      if (pending.kind !== kind) continue
      return true
    }
    return false
  }

  /**
   * 「这条提问的通知已经有人发过了吗」——两条生产者路径共用的一道闸。
   *
   * 同一个提问会从两条路进来：`session/event` 的 `tool/call`（`index.ts#maybePending`，
   * 带真实 callId）和 `user-questions/request` waterfall（本桥）。两条路算出来的 requestId
   * 可能对不上（现场：`call_00_dGHQUzZz9ZWpxg1gDB906158` vs `question-1-1791042098331`），
   * 而且谁先谁后不定（08:54:58 / 15:05:20 是 waterfall 先，15:41:38 是兜底先），所以只按 id
   * 去重必然漏。改成按两条路都拿得到的身份认：`会话 + 题目 id`。
   *
   * 先到的那条记一笔并返回 true（照发），后到的那条返回 false（跳过通知，但 pending 照旧
   * 注册——哪条路上来的作答都要能结算）。这笔账在提问被结算时抹掉，所以同一会话隔一会儿
   * 用同一个题目 id 再问一次不会被误吞。
   *
   * @param sessionId - 会话 id。
   * @param questionId - `questions[0].id`；拿不到时不认重（返回 true），退化成老行为。
   * @returns 这条提问是不是第一次被通知。
   */
  announceQuestion(sessionId: string, questionId?: string): boolean {
    if (!questionId) return true
    const key = `${sessionId}|${questionId}`
    const now = this.#now()
    const at = this.#announced.get(key)
    if (at !== undefined && now - at < ANNOUNCE_TTL_MS) return false
    this.#announced.set(key, now)
    if (this.#announced.size > 64) {
      for (const [other, when] of this.#announced) {
        if (now - when >= ANNOUNCE_TTL_MS) this.#announced.delete(other)
      }
    }
    return true
  }

  install(ctx: { on: (name: string, listener: (...args: unknown[]) => unknown) => (() => void) | undefined }): void {
    const approvalDisposer = ctx.on('approval/request', (request, next) => this.#handleApproval(request, next))
    if (typeof approvalDisposer === 'function') this.#disposers.push(approvalDisposer)

    const questionDisposer = ctx.on('user-questions/request', (request, next) => this.#handleQuestion(request, next))
    if (typeof questionDisposer === 'function') this.#disposers.push(questionDisposer)
  }

  dispose(): void {
    for (const disposer of this.#disposers) {
      try {
        disposer()
      } catch {
        /* 忽略 */
      }
    }
    this.#disposers = []
    for (const pending of this.#pending.values()) clearTimeout(pending.expireTimer)
    this.#pending.clear()
    this.#liveQuestions.clear()
    this.#announced.clear()
  }

  /**
   * 这个按钮该结算哪一条 pending。
   *
   * 先用按钮自带的 `requestId`（两条生产者路径算出同一个 id 时就是它）。对不上时再用
   * **两条路都认得的身份**找一次：先按「会话 + 题目 id」（`#liveQuestions`，精确），再退化到
   * 「这个会话里唯一一条同种类的 pending」（审批没有题目 id）。
   *
   * 为什么必须有这一层：同一个提问会从 `session/event` 的 `tool/call`（带真实 callId）和
   * `user-questions/request` waterfall（宿主没给 callId 时桥自己合成 `question-<n>-<时间戳>`）
   * 各来一次，而**通知可能是任意一条投递的**——日志兜底那条先跑时，通知里的按钮带的就是
   * `call_00_…`，`#pending` 里却只有桥合成的那个 id，点下去只会得到「这个请求已经结束或
   * 过期了」（现场 05:20:40 那条「等待我回答」，用户点了没反应）。文本作答不受影响，因为它
   * 本来就是按「会话 + 最新一条」找的（`settleText`）。
   *
   * 唯一性判据是必要的：同种类有两条以上等待时宁可拒绝，也不能拿一个旧按钮去结算新请求。
   */
  #resolvePending(value: ActionValue): Pending | undefined {
    const requestId = value.requestId
    if (requestId) {
      const exact = this.#pending.get(requestId)
      // 同一条请求带多个问题时每问各一条 pending。按钮若同时带了题目 id，就以题目 id 为准
      // ——id 派生规则将来变了，也不会把第 3 问的点击算到第 1 问头上。
      if (exact && (exact.kind === 'approval' || !value.questionId || exact.questionId === value.questionId)) {
        return exact
      }
    }

    if (value.questionId) {
      const live = this.#liveQuestions.get(`${value.sessionId}|${value.questionId}`)
      const byQuestion = live === undefined ? undefined : this.#pending.get(live)
      if (byQuestion) return byQuestion
    }

    const wanted: Pending['kind'] | undefined =
      value.kind === 'approval' ? 'approval' : value.kind === 'plan' ? 'plan' : value.kind === 'question' ? 'question' : undefined
    if (wanted === undefined) return undefined

    let found: Pending | undefined
    for (const pending of this.#pending.values()) {
      if (pending.sessionId !== value.sessionId) continue
      if (pending.kind !== wanted) continue
      if (found) return undefined
      found = pending
    }
    return found
  }

  /** 按钮 / 文本回复结算一个等待中的请求。 */
  settle(value: ActionValue): PendingSettlement {
    const requestId = value.requestId
    if (!requestId && !value.questionId) return { ok: false, reason: '这个按钮没有携带请求 id' }
    const pending = this.#resolvePending(value)
    if (!pending) return { ok: false, reason: '这个请求已经结束或过期了' }
    const key = pending.requestId
    if (requestId && requestId !== key) {
      // 留 info：这就是「按钮点了没反应」的直接证据（通知由另一条生产者路径投递）。
      this.#options.log?.(`按钮带的 id（${requestId}）不是注册的那条（${key}），按会话身份结算`)
    }

    if (pending.kind === 'approval') {
      const allow = value.choice === 'allow'
      this.#finish(key, pending)
      pending.resolve(allow ? 'allowed-once' : 'rejected')
      return { ok: true, echo: allow ? '已允许' : '已拒绝' }
    }

    // question / plan
    const chosen = this.#pickOption(pending, value)
    if (!chosen.ok) return { ok: false, reason: chosen.reason }
    this.#finish(key, pending)
    pending.resolve({ answers: [{ id: pending.questionId, selected: [chosen.label] }] })
    return { ok: true, echo: `已选择「${chosen.label}」` }
  }

  /**
   * 文本作答：按会话找等待中的请求，把「1」「允许」「选项文字」翻成答案。
   *
   * 为什么必须有这条路径：QQ 单聊的按钮只在手机端新版本才渲染（桌面端 / 老版本会显示
   * 我们写的 `unsupport_tips`），而宿主那边只要没人结算就会一直等。用户 m04327 报的
   * 正是这个——「QQ 没有弹出选项，我回复文本，DSH 却还在等我选择，那段文本被当成了
   * 补充语句」。文本作答不依赖任何客户端能力，所以它才是兜底的那条路。
   *
   * **多条等待时挑哪一条**（一次请求带多个问题就会有多条）：① 已经 armed 的那条——用户
   * 刚回了「N+1. 自定义回答」，这一句就是它的答案；② 文本正好等于某一问的候选 label
   * （大小写无关），那他大概率就是照着那条通知回的；③ 都不中则「最新那次请求优先、同一次
   * 请求内按题目顺序」——一次请求带 3 个问题时用户回「1」是在答第 1 问，跨请求时用户回的
   * 则多半是刚收到的那条通知。
   *
   * 返回 `undefined` 表示「这条消息不是答案」（没有等待中的请求，或者文本明显是别的
   * 意思），调用方照常把它当普通发言注入会话。`{ok:false, armed:true}` 是第三态：已经
   * 进入等自定义答案的状态，调用方别清等待记录。
   */
  settleText(sessionId: string, text: string): PendingSettlement | undefined {
    const trimmed = text.trim()
    if (trimmed.length === 0) return undefined

    const candidates: Pending[] = []
    for (const pending of this.#pending.values()) {
      if (pending.sessionId !== sessionId) continue
      candidates.push(pending)
    }
    if (candidates.length === 0) return undefined
    // 排列顺序：**最新的一次请求优先，同一次请求里的多个问题按题目顺序（最早在前）**。
    //
    // 不能简单地「取最新一条」：一次请求带 3 个问题时，用户回「1」通常是在答第 1 问，
    // 按「最新一条」会把答案算到第 3 问头上（这正是这次要修的那个 bug 的另一半）。而跨
    // 请求时（两个提问前后脚进来）用户回的多半是刚收到的那条通知，所以仍然是「先看最新
    // 那一组」——这也保住了老行为。
    const keyOf = (pending: Pending): string =>
      pending.kind === 'approval' ? pending.requestId : (pending.group ?? pending.requestId)
    const groupStart = new Map<string, number>()
    for (const pending of candidates) {
      const key = keyOf(pending)
      const at = groupStart.get(key)
      if (at === undefined || pending.createdAt < at) groupStart.set(key, pending.createdAt)
    }
    candidates.sort((a, b) => {
      const byGroup = (groupStart.get(keyOf(b)) ?? 0) - (groupStart.get(keyOf(a)) ?? 0)
      return byGroup !== 0 ? byGroup : a.createdAt - b.createdAt
    })

    const armed = candidates.find(
      (pending): pending is PendingQuestion => pending.kind !== 'approval' && pending.awaitingCustom === true,
    )
    if (armed) return this.#settleTextOne(armed, trimmed)

    const needle = trimmed.toLowerCase()
    const byLabel = candidates.filter(
      (pending): pending is PendingQuestion =>
        pending.kind !== 'approval' &&
        pending.labels.some((label) => label.trim().toLowerCase() === needle),
    )
    if (byLabel.length === 1) {
      const settled = this.#settleTextOne(byLabel[0]!, trimmed)
      if (settled) return settled
    }

    for (const pending of candidates) {
      const settled = this.#settleTextOne(pending, trimmed)
      if (settled) return settled
    }
    return undefined
  }

  /** 把一句话当作**这一条**等待的回答来判读（该挑哪一条见 `settleText`）。 */
  #settleTextOne(pending: Pending, trimmed: string): PendingSettlement | undefined {
    const requestId = pending.requestId
    if (pending.kind === 'approval') {
      const allow = readApprovalAnswer(trimmed)
      if (allow === undefined) return undefined
      this.#finish(requestId, pending)
      pending.resolve(allow ? 'allowed-once' : 'rejected')
      return { ok: true, echo: allow ? '已允许' : '已拒绝' }
    }

    // 到这儿只剩提问 / 计划。收进一个 const：闭包里用 `pending` 会把窄化丢掉。
    const question = pending

    // 已经进了「等你说自定义答案」的状态：这一句原样就是答案，不再当选项解析
    // （否则用户答「2」会被当成选了第二个选项）。
    if (question.awaitingCustom) {
      question.awaitingCustom = false
      this.#finish(requestId, question)
      question.resolve({ answers: [{ id: question.questionId, selected: [], custom: trimmed }] })
      return { ok: true, echo: `已按自定义答案「${trimmed}」作答` }
    }

    // 「N+1. 自定义回答」：只是**进入**等待状态，这一句本身不是答案。
    if (readCustomRequest(question, trimmed)) {
      question.awaitingCustom = true
      return {
        ok: false,
        armed: true,
        reason: '好，把你要自定义的答案发过来（下一条消息就是答案）。',
      }
    }

    const chosen = readOptionAnswer(question, trimmed)
    if (!chosen || chosen.length === 0) return undefined
    this.#finish(requestId, question)
    // 不在候选里的就是自由文本。宿主的形状是 `selected: [] + custom: <文本>`，GUI 的
    // 输入框回传的也是 `custom`——把自由文本塞进 `selected` 会让模型以为用户点了某个
    // 名字很奇怪的选项。
    const selected = chosen.filter((item) => question.labels.includes(item))
    const custom = chosen.filter((item) => !question.labels.includes(item))
    question.resolve({
      answers: [
        {
          id: question.questionId,
          selected,
          ...(custom.length > 0 ? { custom: custom.join(' ') } : {}),
        },
      ],
    })
    return { ok: true, echo: `已选择「${chosen.join('、')}」` }
  }

  #pickOption(pending: PendingQuestion, value: ActionValue): { ok: true; label: string } | { ok: false; reason: string } {
    if (value.text) return { ok: true, label: value.text }
    if (value.choice) {
      // 按钮回传的 choice 就是 label；下标也回传了，优先用下标（label 可能重复）。
      if (typeof value.optionIndex === 'number' && pending.labels[value.optionIndex]) {
        return { ok: true, label: pending.labels[value.optionIndex]! }
      }
      if (pending.labels.includes(value.choice)) return { ok: true, label: value.choice }
      // plan 的批准按钮走的是 approveLabel，它一定在 labels 里；到这里说明按钮过期了。
      return { ok: false, reason: `选项「${value.choice}」已不在候选里` }
    }
    return { ok: false, reason: '没有拿到选择' }
  }

  #finish(requestId: string, pending: Pending): void {
    clearTimeout(pending.expireTimer)
    this.#pending.delete(requestId)
    if (pending.kind !== 'approval' && pending.questionKey) {
      // 只清理自己登记的那条：同一个问题可能有两个 pending 共用一个 key，先结算的
      // 那个不该把后来者的登记抹掉。
      if (this.#liveQuestions.get(pending.questionKey) === requestId) {
        this.#liveQuestions.delete(pending.questionKey)
      }
      // 提问结束了，这笔「已经通知过」的账也抹掉：同一个题目 id 以后还能再问一次。
      this.#announced.delete(pending.questionKey)
    }
  }

  // ── approval/request ────────────────────────────────────────────────────

  async #handleApproval(request: unknown, next: unknown): Promise<unknown> {
    const req = request as ApprovalRequestLike
    const proceed = next as () => Promise<ApprovalOutcomeLike>

    // 先让宿主自己的 UI 接手，再和我们的答案赛跑。接管取消信号必须赶在 proceed() 之前
    // ——`next()` 传的是同一个对象引用，改晚了网关就看不见了，见 holdRemoteEvent。
    const release = holdRemoteEvent(req)
    const hostPromise = typeof proceed === 'function' ? proceed() : Promise.resolve<ApprovalOutcomeLike>('unavailable')
    const sessionId = req.agent?.session?.id
    if (!sessionId) return hostPromise

    const requestId = req.callId ?? `approval-${++this.#counter}-${this.#now()}`
    const imPromise = new Promise<ApprovalOutcomeLike>((resolve) => {
      const expireTimer = setTimeout(() => {
        // 过期：只把表项清掉，Promise 永远挂着——race 已经由宿主那边决出胜负，
        // 我们不再干扰。用户之后点旧按钮会拿到「已过期」。
        this.#pending.delete(requestId)
      }, this.#ttlMs)
      expireTimer.unref?.()
      const pending: PendingApproval = {
        requestId,
        sessionId,
        kind: 'approval',
        createdAt: this.#now(),
        expireTimer,
        resolve,
      }
      this.#pending.set(requestId, pending)
    })

    const event = this.#approvalEvent(req, sessionId, requestId)
    try {
      await this.#options.onPending(event)
    } catch (error) {
      this.#options.log?.('投递授权通知失败', error)
    }

    try {
      return await Promise.race([hostPromise, imPromise])
    } finally {
      // 宿主先答的话，表项要清掉，免得按钮一直显示成可点。
      const still = this.#pending.get(requestId)
      if (still) this.#finish(requestId, still)
      // 这次交互结束了（不管是谁答的），让宿主给浏览器发 cancel 帧，把那张卡片收掉。
      release()
    }
  }

  #approvalEvent(req: ApprovalRequestLike, sessionId: string, requestId: string): RawEvent {
    const detail: EventDetail = {
      project: projectName(req.agent?.session),
      requestId,
      toolName: req.toolName,
    }
    const reason = req.displayReason?.zh ?? req.displayReason?.en ?? req.reason
    if (reason) detail.text = reason
    return { kind: 'approval', sessionId, seq: this.#syntheticSeq(requestId), time: this.#now(), detail }
  }

  // ── user-questions/request ──────────────────────────────────────────────

  async #handleQuestion(request: unknown, next: unknown): Promise<unknown> {
    const req = request as AskUserQuestionRequestLike
    const proceed = next as () => Promise<AskUserQuestionAnswerLike>
    // 接管取消信号必须赶在 proceed() 之前，见 holdRemoteEvent。
    const release = holdRemoteEvent(req)
    const hostPromise = typeof proceed === 'function' ? proceed() : Promise.resolve({ answers: [] })

    const sessionId = req.agent?.session?.id
    const items = (req.questions ?? []).filter((item): item is AskUserQuestionItemLike => Boolean(item))
    const first = items[0]
    if (!sessionId || !first) return hostPromise

    // 宿主没给 callId 时自己合成一个。多问题时每条 pending 的 id 由它派生（第 0 问用 base、
    // 第 i 问用 `${base}#${i}`）：`#pending` 里每条唯一，按钮带的 id 只会命中它自己那一问；
    // 日志兜底那条路的派生规则与这里一致（见 `events.ts#extractToolCallEvents`）。
    const baseRequestId = req.wait?.callId ?? first.intent?.callId ?? `question-${++this.#counter}-${this.#now()}`
    const isPlan = first.intent?.kind === 'plan-review'
    const total = items.length

    // 一次请求可能带多个问题（模型的 `ask_user_question` 支持 `questions: [...]`，宿主自己的
    // UI 是一问一答走完再一起提交）。**每个问题各登记一条 pending、各发一条通知**——只处理
    // 第一个会让第 2..N 问在 IM 上完全看不见（现场 `session-5bc7441e`：一次问了
    // engine/domain/surface 三个，只有 engine 到了 QQ，模型只好反复重问，任务卡住）。
    // 全部答完才把 N 个答案一起回给宿主，形状就是 `{ answers: [...] }`，一问一个元素。
    // 每题一个槽位：答案按**题目顺序**回给宿主（与宿主自己的 UI 一致），不受用户点按顺序影响。
    const slots: (AskUserQuestionAnswerLike['answers'][number] | undefined)[] = new Array(total)
    let remaining = total
    let settleGroup!: (answer: AskUserQuestionAnswerLike) => void
    const imPromise = new Promise<AskUserQuestionAnswerLike>((resolve) => {
      settleGroup = resolve
    })
    const registered: string[] = []

    for (const [index, item] of items.entries()) {
      const requestId = index === 0 ? baseRequestId : `${baseRequestId}#${index}`
      // 同一个问题被两条路（宿主的 `tool/call` 与 waterfall）各投一次时，按「会话 + 题目 id」
      // 认重：pending 照旧注册（哪条路上来的解答都要能结算），只是第二条通知不再发。
      const questionKey = `${sessionId}|${item.id}`
      const labels = (item.options ?? []).map((option) => option.label)
      const duplicated = this.#liveQuestions.has(questionKey)
      this.#liveQuestions.set(questionKey, requestId)
      registered.push(requestId)

      const expireTimer = setTimeout(() => {
        this.#pending.delete(requestId)
        if (this.#liveQuestions.get(questionKey) === requestId) this.#liveQuestions.delete(questionKey)
      }, this.#ttlMs)
      expireTimer.unref?.()
      const pending: PendingQuestion = {
        requestId,
        sessionId,
        kind: isPlan ? 'plan' : 'question',
        createdAt: this.#now(),
        expireTimer,
        questionId: item.id,
        questionKey,
        group: baseRequestId,
        labels,
        // 每答一问填一个槽位；最后一问也答完时，整组（按题目顺序）一起交给宿主。
        resolve: (answer) => {
          slots[index] = answer.answers?.[0]
          remaining -= 1
          if (remaining <= 0) {
            settleGroup({ answers: slots.filter((slot): slot is NonNullable<typeof slot> => slot !== undefined) })
          }
        },
      }
      if (item.intent?.approve) pending.approveLabel = item.intent.approve
      if (item.multiSelect === true) pending.multiSelect = true
      this.#pending.set(requestId, pending)

      if (duplicated) {
        this.#options.log?.(`同一个问题又被投递了一次（${questionKey}），不再发第二条等待通知`)
        continue
      }
      const event = this.#questionEvent(req, item, sessionId, requestId, isPlan, index, total)
      try {
        await this.#options.onPending(event)
      } catch (error) {
        this.#options.log?.('投递提问通知失败', error)
      }
    }

    try {
      return await Promise.race([hostPromise, imPromise])
    } finally {
      // 整组一起收尾：宿主要么自己答完（那我们这边整组作废），要么由我们答完。
      for (const requestId of registered) {
        const still = this.#pending.get(requestId)
        if (still) this.#finish(requestId, still)
      }
      // 这次交互结束了（不管是谁答的），让宿主给浏览器发 cancel 帧，把那张卡片收掉。
      release()
    }
  }

  #questionEvent(
    req: AskUserQuestionRequestLike,
    item: AskUserQuestionItemLike,
    sessionId: string,
    requestId: string,
    isPlan: boolean,
    index = 0,
    total = 1,
  ): RawEvent {
    const kind: EventKind = isPlan ? 'plan' : 'question'
    const detail: EventDetail = {
      project: projectName(req.agent?.session),
      requestId,
      toolName: isPlan ? EXIT_PLAN_MODE_TOOL : ASK_USER_QUESTION_TOOL,
      text: item.question,
    }
    if (item.detail) {
      if (isPlan) detail.plan = item.detail
      else detail.text = item.detail
    }
    if (item.options && item.options.length > 0) detail.options = item.options
    detail.multiSelect = item.multiSelect === true
    // 日志兜底那条路（`extractToolCallEvent`）也会填这个字段，两条路靠它认重。
    if (item.id) detail.questionId = item.id
    // 一次请求多个问题时，正文里要写清「第几问 / 共几问」，否则用户不知道后面还有没有。
    if (total > 1) {
      detail.questionIndex = index
      detail.questionTotal = total
    }
    return { kind, sessionId, seq: this.#syntheticSeq(requestId), time: this.#now(), detail }
  }

  /** 等待类事件没有 session seq，用一个稳定的负数序号占位（去重仍按 requestId）。 */
  #syntheticSeq(requestId: string): number {
    let hash = 0
    for (let i = 0; i < requestId.length; i += 1) hash = (hash * 31 + requestId.charCodeAt(i)) | 0
    return -Math.abs(hash || 1)
  }
}

/** 便于测试与调试：从 ActionValue 判断这是不是需要 InteractionBridge 的按钮。 */
export function isInteractionAction(value: ActionValue): boolean {
  return value.kind === 'approval' || value.kind === 'question' || value.kind === 'plan'
}

/** 通道回传的按钮载荷可能带 `Notification` 上的信息，这里统一转成 ActionValue。 */
export function toActionValue(raw: unknown): ActionValue | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (record.v !== 1) return undefined
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) return undefined
  const kind = record.kind
  if (
    kind !== 'approval' &&
    kind !== 'question' &&
    kind !== 'plan' &&
    kind !== 'stop' &&
    kind !== 'goto' &&
    kind !== 'detail' &&
    kind !== 'mode'
  ) {
    return undefined
  }
  return record as unknown as ActionValue
}

/**
 * 「允许 / 拒绝」的口语说法。
 *
 * 命中不了就**不结算**，让这条消息照常进会话——宁可少答一次，也不要把用户正在
 * 跟模型说的话吞成一句审批结果。
 */
const ALLOW_WORDS = ['允许', '同意', '通过', '批准', '可以', '好的', '好', 'allow', 'yes', 'y', 'ok', '1']
const REJECT_WORDS = ['拒绝', '不同意', '不通过', '不批准', '驳回', '不行', 'deny', 'no', 'n', '2']

function readApprovalAnswer(text: string): boolean | undefined {
  const normalized = text.trim().toLowerCase()
  if (ALLOW_WORDS.includes(normalized)) return true
  if (REJECT_WORDS.includes(normalized)) return false
  return undefined
}

/**
 * 判读一段文本需要的最小信息。
 *
 * `PendingQuestion` 结构上就满足它——单独抽出来是为了让**还没有 pending** 的场合
 * （通知先发出去、waterfall 还没跑，见 index.ts 的 `#waiting`）也能判「这句话像不像
 * 一个作答」，从而不把它当普通发言注入会话。
 */
export interface AnswerTarget {
  kind: 'question' | 'plan' | 'approval'
  labels: readonly string[]
  multiSelect?: boolean
}

/**
 * 这段文本像不像对这条等待的作答？
 *
 * 用于「提问还没准备好接收作答」的窗口：命中就先把答案攥住，等 pending 一出现再替他答；
 * 不命中就照常当普通发言注入（宁可少答一次，也不要把用户跟模型说的话吞掉）。
 */
export function matchAnswer(target: AnswerTarget, text: string): boolean {
  if (target.kind === 'approval') return readApprovalAnswer(text) !== undefined
  // 「自定义回答」也得算「像作答」：它落在候选之外，`readOptionAnswer` 认不出来，可它
  // 确实是作答（只是还要再等一句话），不然那句「4」会被当普通发言注进会话。
  if (readCustomRequest(target, text)) return true
  return readOptionAnswer(target, text) !== undefined
}

/**
 * 「自定义回答」那一行的序号＝候选数 + 1（`render.ts#questionBody` 就是这么编的）。
 *
 * 它**不是**宿主的选项，所以只有单选提问才有：多选的作答按空格拆 token，塞不进这套
 * 两段式；plan-review 只认「批准 / 不批准」和序号，也不该多出一个自定义口子。
 */
function customSlotIndex(target: AnswerTarget): number | undefined {
  if (target.kind !== 'question') return undefined
  if (target.multiSelect === true) return undefined
  return target.labels.length + 1
}

/** 这句文本是不是「我要自己写答案」？（只认那个序号） */
function readCustomRequest(target: AnswerTarget, text: string): boolean {
  const slot = customSlotIndex(target)
  if (slot === undefined) return false
  const index = /^(\d{1,2})\s*[.、)）]?$/.exec(text.trim())
  return index !== null && Number(index[1]) === slot
}

/**
 * 把一段文本翻成选项。
 *
 * 顺序：先认序号（客户端把按钮吞掉时，正文里的「1. xxx」还在），再认 label 原文，
 * 最后——**只对提问**——按自由文本作答。计划（plan-review）只认前两种，免得用户
 * 随手一句话就把计划批了。
 */
function readOptionAnswer(target: AnswerTarget, text: string): string[] | undefined {
  const tokens =
    target.multiSelect === true ? text.split(/[,，、\s]+/).filter((token) => token.length > 0) : [text]
  const picked: string[] = []
  for (const token of tokens) {
    const label = readOneOption(target, token)
    if (label === undefined) return undefined
    picked.push(label)
  }
  return picked.length > 0 ? picked : undefined
}

function readOneOption(target: AnswerTarget, text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const index = /^(\d{1,2})\s*[.、)）]?$/.exec(trimmed)
  if (index) {
    const at = Number(index[1]) - 1
    return at >= 0 && at < target.labels.length ? target.labels[at] : undefined
  }
  const lower = trimmed.toLowerCase()
  const hit = target.labels.find((label) => label.trim().toLowerCase() === lower)
  if (hit) return hit
  if (target.kind === 'plan') return undefined
  return trimmed
}

export type { InboundAction, Notification }
