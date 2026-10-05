// packages/tlnotify/src/events.ts
//
// 事件源：把宿主的 `session/event` 日志流归一化成 9 类事件里的「可判定」部分。
//
// 两类事件不从这里出：
//   - `approval`（等待授权）与 `question`/`plan`（等待提问/计划确认）由
//     inject.ts 的 InteractionBridge 从 cordis 的 **waterfall** 钩子上产生。
//     理由：日志事件 `approval/asked` 里**没有工具参数**，而且真正「有人在等」
//     的时刻就是 waterfall 被调用的时刻——审批策略为 `never` 时根本不等人，
//     那时不该发通知。日志侧仅作兜底（见 extractToolCallEvent）。
//
// 一个必须记住的宿主事实：Token 上限的 kind 字面量是 **`'max-tokens'`**（带连
// 字符），不是设计方案里写的 `maxTokens`。下面两种都接受。

import type { EventDetail, EventKind, RawEvent } from './types.js'
import { basename } from 'node:path'

// ---------------------------------------------------------------------------
// 宿主对象的最小结构化视图（避免运行时 import @deepseek-ai/*）
// ---------------------------------------------------------------------------

export interface SessionHeaderLike {
  cwd?: string
  origin?: string
  delegationDepth?: number
  parentSession?: string
}

export interface SessionLike {
  id: string
  header?: SessionHeaderLike
}

export interface SessionEventLike {
  type: string
  seq: number
  time: number
  data?: unknown
}

/** 工具名常量（与宿主 `@deepseek-ai/dsh-tool-ask-user` / `dsh-plan-mode` 对齐）。 */
export const ASK_USER_QUESTION_TOOL = 'ask_user_question'
export const EXIT_PLAN_MODE_TOOL = 'exit_plan_mode'

// ---------------------------------------------------------------------------
// 会话标签
// ---------------------------------------------------------------------------

/** 项目目录名 = `session.header.cwd` 的 basename；没有 cwd 时退回 `DSH`。 */
export function projectName(session: SessionLike | undefined): string {
  const cwd = session?.header?.cwd?.trim()
  if (!cwd) return 'DSH'
  const base = basename(cwd.replace(/[\\/]+$/, ''))
  return base.length > 0 ? base : 'DSH'
}

/** 短会话 id：去掉 `session-` 前缀后取前 8 位（设计方案 §4.3）。 */
export function shortSessionId(id: string): string {
  const trimmed = (id ?? '').replace(/^session-/, '')
  return trimmed.slice(0, 8) || 'unknown'
}

/**
 * 主会话判定。
 *
 * 设计方案的判据是 `header.origin !== 'subagent'`；实测宿主里 `origin` 只在
 * 子 Agent 上出现，`delegationDepth` 也是 0 起步。两个判据取或，任一命中即
 * 视为子 Agent——宁可多静默一个，也不要让子 Agent 刷屏。
 */
export function isSubagent(session: SessionLike | undefined): boolean {
  const header = session?.header
  if (!header) return false
  if (header.origin === 'subagent') return true
  const depth = header.delegationDepth
  return typeof depth === 'number' && depth > 0
}

// ---------------------------------------------------------------------------
// turn/end 归一化
// ---------------------------------------------------------------------------

interface TurnEndReasonLike {
  kind?: string
  reason?: { kind?: string }
  error?: unknown
}

/** `reason.kind` → EventKind；不通知的 kind 返回 undefined。 */
export function turnEndKind(reason: TurnEndReasonLike | undefined): EventKind | undefined {
  const kind = reason?.kind
  switch (kind) {
    case 'completed':
      return 'completed'
    case 'error':
      return 'error'
    case 'blocked':
      return 'blocked'
    case 'max-tokens':
    case 'maxTokens': // 设计方案里的写法，宿主实际不发；兼容以防将来改名
      return 'max-tokens'
    case 'interrupted':
      return 'interrupted'
    case 'aborted': {
      // 只报「用户主动中止」。parent / hook / disposed 都是系统行为，
      // 推给用户只会变成噪音。
      const cause = reason?.reason?.kind
      return cause === 'user' ? 'aborted' : undefined
    }
    case 'forked':
    default:
      return undefined
  }
}

function errorText(error: unknown): string | undefined {
  if (!error) return undefined
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    for (const key of ['message', 'reason', 'code', 'name']) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    try {
      return JSON.stringify(error)
    } catch {
      return undefined
    }
  }
  return String(error)
}

function reasonText(reason: TurnEndReasonLike | undefined): string | undefined {
  if (!reason) return undefined
  const direct = errorText(reason.error)
  if (direct) return direct
  const nested = reason.reason as Record<string, unknown> | undefined
  if (nested) {
    const text = errorText(nested.reason) ?? errorText(nested.message)
    if (text) return text
    if (typeof nested.kind === 'string') return nested.kind
  }
  return undefined
}

/** 判断 `session/event` 是否是「turn 结束」且值得通知；是则返回 RawEvent。 */
export function extractTurnEnd(session: SessionLike, event: SessionEventLike): RawEvent | undefined {
  if (event.type !== 'turn/end') return undefined
  const data = (event.data ?? {}) as { turn?: number; reason?: TurnEndReasonLike }
  const kind = turnEndKind(data.reason)
  if (!kind) return undefined
  const detail: EventDetail = { project: projectName(session) }
  const text = reasonText(data.reason)
  if (text) detail.text = text
  return {
    kind,
    sessionId: session.id,
    seq: event.seq,
    time: event.time,
    detail,
  }
}

// ---------------------------------------------------------------------------
// tool/call 归一化（兜底：等待提问 / 等待计划确认）
// ---------------------------------------------------------------------------

export interface ToolCallLike {
  name?: string
  callId?: string
  arguments?: string
}

/** 解析模型产出的原始 JSON 参数；失败时原样返回字符串。 */
export function parseToolArguments(raw: string | undefined): unknown {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * 从 `ask_user_question` 的参数里抽选项。
 *
 * 宿主的工具参数形如 `{ questions: [{ id, question, header, options:[{label,description}], multiSelect }] }`；
 * 但模型偶尔会写 `options: ["A","B"]` 这种简写，所以两种都吃。
 */
/** 一条提问（`questions[i]`）里我们关心的那几样。 */
export interface ParsedQuestion {
  text?: string
  options: { label: string; description?: string }[]
  multiSelect: boolean
  questionId?: string
}

/**
 * 抽出**全部**问题。
 *
 * 一次 `ask_user_question` 可以带多个问题（模型传 `questions: [...]`，宿主自己的 UI 是
 * 一问一答走完再一起提交）。调用方必须逐个渲染、逐个结算——只取第一个会让第 2..N 问在
 * IM 上完全不可见（现场：`session-5bc7441e` 一次问了 engine/domain/surface 三个，只有
 * 第一个到了 QQ，模型只好反复重问，任务卡住）。
 */
export function extractQuestionList(args: unknown): ParsedQuestion[] {
  const root = asRecord(args)
  const questions = root?.questions
  const list = Array.isArray(questions) ? (questions as unknown[]) : []
  const source = list.length > 0 ? list : [root]
  const out: ParsedQuestion[] = []
  for (const entry of source) {
    const one = parseQuestion(entry)
    if (one) out.push(one)
  }
  // 解析不出任何东西时也给一条空壳，保持老行为（事件照发，正文退回 EVENT_LABELS）。
  if (out.length === 0) out.push({ options: [], multiSelect: false })
  return out
}

function parseQuestion(entry: unknown): ParsedQuestion | undefined {
  const first = asRecord(entry)
  if (!first) return undefined

  const questionText =
    typeof first.question === 'string'
      ? first.question
      : typeof first.header === 'string'
        ? first.header
        : undefined

  const rawOptions = Array.isArray(first.options) ? (first.options as unknown[]) : []
  const options: { label: string; description?: string }[] = []
  for (const entry of rawOptions) {
    if (typeof entry === 'string') {
      options.push({ label: entry })
      continue
    }
    const record = asRecord(entry)
    if (!record) continue
    const label =
      typeof record.label === 'string'
        ? record.label
        : typeof record.value === 'string'
          ? record.value
          : undefined
    if (!label) continue
    const description = typeof record.description === 'string' ? record.description : undefined
    options.push(description ? { label, description } : { label })
  }

  const questionId = typeof first.id === 'string' ? first.id : undefined
  const multiSelect = first.multiSelect === true
  const parsed: ParsedQuestion = { options, multiSelect }
  if (questionText) parsed.text = questionText
  if (questionId) parsed.questionId = questionId
  return parsed
}

/** 兼容旧调用：只关心第一个问题的地方（既有的单问题测试）用这个。 */
export function extractQuestions(args: unknown): ParsedQuestion {
  return extractQuestionList(args)[0] ?? { options: [], multiSelect: false }
}

/** 从 `exit_plan_mode` 的参数里抽计划正文。 */
export function extractPlan(args: unknown): string | undefined {
  const root = asRecord(args)
  if (!root) return typeof args === 'string' ? args : undefined
  for (const key of ['plan', 'plan_markdown', 'planMarkdown', 'content', 'markdown', 'summary']) {
    const value = root[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

/**
 * 兜底路径：把一次 pending 类 `tool/call` 变成 RawEvent。
 *
 * 只在 InteractionBridge 的 waterfall 没有先认领同一个 callId 时才应该被使用，
 * 由调用方（index.ts）通过 `seenRequestIds` 判定。
 */
/**
 * 兜底路径：把一次 pending 类 `tool/call` 变成 RawEvent（**一个调用可能出多条**）。
 *
 * 只在 InteractionBridge 的 waterfall 没有先认领同一个 callId 时才应该被使用，
 * 由调用方（index.ts）通过 `seenRequestIds` 判定。一次 `ask_user_question` 可以带多个
 * 问题，每个问题都要有自己的通知，所以这里返回数组：第 0 条沿用调用本身的 `seq`，其余
 * 各给一个由 `callId#i` 算出的稳定负数 `seq`——`Dedupe` 按 `(sessionId, seq)` 认重，共用
 * `seq` 会让第 2..N 条被当成重复事件丢掉；`requestId` 也逐条区分，否则按钮 / 文本结算
 * 会全部落到第 0 问上。
 */
export function extractToolCallEvents(session: SessionLike, event: SessionEventLike): RawEvent[] {
  if (event.type !== 'tool/call') return []
  const data = (event.data ?? {}) as ToolCallLike
  const name = data.name
  if (name !== ASK_USER_QUESTION_TOOL && name !== EXIT_PLAN_MODE_TOOL) return []
  const args = parseToolArguments(data.arguments)
  const base: EventDetail = {
    project: projectName(session),
    requestId: data.callId,
    toolName: name,
    toolArguments: args,
  }
  if (name === EXIT_PLAN_MODE_TOOL) {
    const detail: EventDetail = { ...base }
    const plan = extractPlan(args)
    if (plan) detail.plan = plan
    return [{ kind: 'plan', sessionId: session.id, seq: event.seq, time: event.time, detail }]
  }

  const parsed = extractQuestionList(args)
  return parsed.map((item, index) => {
    const detail: EventDetail = { ...base }
    if (index > 0) detail.requestId = `${data.callId}#${index}`
    if (item.text) detail.text = item.text
    if (item.options.length > 0) detail.options = item.options
    if (item.questionId) detail.questionId = item.questionId
    detail.multiSelect = item.multiSelect
    if (parsed.length > 1) {
      detail.questionIndex = index
      detail.questionTotal = parsed.length
    }
    const raw: RawEvent = {
      kind: 'question',
      sessionId: session.id,
      seq: index === 0 ? event.seq : syntheticSeq(`${data.callId}#${index}`),
      time: event.time,
      detail,
    }
    return raw
  })
}

/** 兼容旧调用：只要第一条。 */
export function extractToolCallEvent(session: SessionLike, event: SessionEventLike): RawEvent | undefined {
  return extractToolCallEvents(session, event)[0]
}

/** 稳定的负数序号：等待类事件没有真实 seq 时占位（去重仍按 requestId）。 */
function syntheticSeq(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return -Math.abs(hash || 1)
}

// ---------------------------------------------------------------------------
// 事件开关
// ---------------------------------------------------------------------------

export interface EventSwitches {
  onTurnEnd: boolean
  onError: boolean
  onAborted: boolean
  onPending: boolean
  onMaxTokens: boolean
  includeSubagent: boolean
}

/** 按配置判断某类事件是否应该推送。 */
export function isKindEnabled(kind: EventKind, switches: EventSwitches): boolean {
  switch (kind) {
    case 'completed':
      return switches.onTurnEnd
    case 'error':
      return switches.onError
    case 'aborted':
      return switches.onAborted
    case 'max-tokens':
      return switches.onMaxTokens
    case 'question':
    case 'approval':
    case 'plan':
      return switches.onPending
    // blocked / interrupted 没有独立开关，跟随错误类（它们都是「出事了」）。
    case 'blocked':
    case 'interrupted':
      return switches.onError
    default:
      return false
  }
}

/** 从完整配置里取出事件开关。 */
export function switchesOf(config: {
  events: EventSwitches
  global?: { includeSubagent?: boolean }
}): EventSwitches {
  return {
    onTurnEnd: config.events.onTurnEnd,
    onError: config.events.onError,
    onAborted: config.events.onAborted,
    onPending: config.events.onPending,
    onMaxTokens: config.events.onMaxTokens,
    includeSubagent: config.events.includeSubagent || config.global?.includeSubagent === true,
  }
}
