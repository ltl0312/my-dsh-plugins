// packages/tlnotify/src/aggregate.ts
//
// 正文聚合：实时累积一轮对话里的助手文字、工具调用与耗时。
//
// 为什么不用 `session.events` 回读：设计方案 §4.5 明确要求「实时累积、不依赖
// `session.events`」。原因有二——
//   1. 回读要按 seq 拉整段日志，一轮长对话能到几百个事件，纯为拼一行摘要不值；
//   2. 回读是异步的，而通知要在 `turn/end` 后立刻发出（见 gate.ts 的门控），
//      异步回读会把「完成→通知」的延迟拉长到不可控。
// 代价是进程重启会丢掉未完成轮次的累积状态。可以接受：重启后那一轮本身也不会
// 再发 `turn/end`（宿主会补一个 `interrupted` closer，那时正文为空、只报「异常
// 中断」，正是我们想要的语义）。

import type { TurnSnapshot, ToolCallRecord } from './types.js'

export interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

interface LiveTurn {
  turn: number
  startedAt: number
  assistantParts: string[]
  tools: ToolCallRecord[]
  userPrompt?: string
  tokens?: { input: number; output: number; total?: number }
  errors: string[]
}

/** 每个会话最多保留多少条历史轮次（供单会话模式的 `previousTurns` 用）。 */
const HISTORY_LIMIT = 12
/** 单个会话累积的助手文字上限，防止一个话痨轮次把内存撑起来。 */
const TEXT_LIMIT = 32_000

/** 从 `ContentBlock[]` 里抽出纯文本（忽略 reasoning / image / tool-call 等）。 */
export function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('')
}

function numbersOf(usage: UsageLike | undefined): { input: number; output: number; total?: number } | undefined {
  if (!usage) return undefined
  const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0
  const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
  if (input === 0 && output === 0 && typeof usage.totalTokens !== 'number') return undefined
  const total = typeof usage.totalTokens === 'number' ? usage.totalTokens : input + output
  return { input, output, total }
}

/**
 * 按会话累积轮次内容。
 *
 * 所有方法都是同步的、绝不抛异常——它挂在 `session/event` 热路径上，
 * 抛一次就会污染整个事件分发。
 */
export class TurnAccumulator {
  readonly #live = new Map<string, LiveTurn>()
  readonly #history = new Map<string, TurnSnapshot[]>()

  beginTurn(sessionId: string, turn: number, time: number): void {
    this.#live.set(sessionId, {
      turn,
      startedAt: time,
      assistantParts: [],
      tools: [],
      errors: [],
    })
  }

  /** 记录用户提问。只有 `source.kind === 'user'` 的才算真人输入。 */
  recordUserMessage(sessionId: string, content: unknown, source: unknown): void {
    const live = this.#live.get(sessionId)
    if (!live) return
    const kind =
      typeof source === 'object' && source !== null
        ? (source as Record<string, unknown>).kind
        : undefined
    if (kind !== 'user') return // inject / goal-continuation 之类的合成输入不算提问
    const text = blocksToText(content).trim()
    if (text.length > 0) live.userPrompt = text
  }

  recordAssistant(sessionId: string, content: unknown, usage: UsageLike | undefined): void {
    const live = this.#live.get(sessionId)
    if (!live) return
    const text = blocksToText(content)
    if (text.length > 0 && live.assistantParts.join('').length < TEXT_LIMIT) {
      live.assistantParts.push(text)
    }
    const tokens = numbersOf(usage)
    if (tokens) live.tokens = tokens
  }

  recordToolCall(sessionId: string, name: string, callId: string, args: string): void {
    const live = this.#live.get(sessionId)
    if (!live) return
    live.tools.push({ name, callId, arguments: args, ok: true })
  }

  recordToolResult(sessionId: string, callId: string, isError: boolean, reason: string | undefined): void {
    const live = this.#live.get(sessionId)
    if (!live) return
    const record = live.tools.find((entry) => entry.callId === callId)
    if (record) {
      record.ok = !isError
      if (reason) record.error = reason
    } else if (isError) {
      // 没见过对应的 call（比如跨进程恢复），也把错误记下来。
      live.tools.push({ name: 'unknown', callId, arguments: '', ok: false, error: reason })
    }
  }

  /** 关闭一轮，返回快照并推入历史。没有 beginTurn 过就返回 undefined。 */
  endTurn(sessionId: string, _turn: number, time: number): TurnSnapshot | undefined {
    const live = this.#live.get(sessionId)
    if (!live) return undefined
    this.#live.delete(sessionId)
    // 宿主在没有 turn/start 的情况下补 `interrupted` closer 时（崩溃恢复），
    // `turn` 可能对不上。仍然按累积内容发快照，轮号以 beginTurn 记下的为准。
    const snapshot: TurnSnapshot = {
      turn: live.turn,
      startedAt: live.startedAt,
      endedAt: time,
      durationMs: Math.max(0, time - live.startedAt),
      assistantText: live.assistantParts.join('').trim(),
      tools: live.tools,
      errors: live.errors,
    }
    if (live.userPrompt) snapshot.userPrompt = live.userPrompt
    if (live.tokens) snapshot.tokens = live.tokens
    const history = this.#history.get(sessionId) ?? []
    history.push(snapshot)
    while (history.length > HISTORY_LIMIT) history.shift()
    this.#history.set(sessionId, history)
    return snapshot
  }

  /** 取最近 n 轮（不含当前正在进行的），由旧到新。 */
  previousTurns(sessionId: string, n: number): TurnSnapshot[] {
    if (n <= 0) return []
    const history = this.#history.get(sessionId)
    if (!history || history.length === 0) return []
    return history.slice(Math.max(0, history.length - n))
  }

  /** 当前正在累积的轮次（用于「等待提问」这类中途事件带上下文）。 */
  liveSnapshot(sessionId: string): TurnSnapshot | undefined {
    const live = this.#live.get(sessionId)
    if (!live) return undefined
    return {
      turn: live.turn,
      startedAt: live.startedAt,
      endedAt: Date.now(),
      durationMs: Math.max(0, Date.now() - live.startedAt),
      assistantText: live.assistantParts.join('').trim(),
      tools: live.tools,
      errors: live.errors,
      ...(live.userPrompt ? { userPrompt: live.userPrompt } : {}),
      ...(live.tokens ? { tokens: live.tokens } : {}),
    }
  }

  forget(sessionId: string): void {
    this.#live.delete(sessionId)
    this.#history.delete(sessionId)
  }

  clear(): void {
    this.#live.clear()
    this.#history.clear()
  }
}

/** 工具列表 → 一行摘要，如 `Read ×3, Bash ×2`。 */
export function summarizeTools(tools: readonly ToolCallRecord[], limit = 6): string {
  if (tools.length === 0) return ''
  const counts = new Map<string, number>()
  for (const tool of tools) {
    const name = tool.name || 'unknown'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const shown = entries.slice(0, limit).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
  if (entries.length > limit) shown.push(`…等 ${entries.length} 种`)
  return shown.join(', ')
}

/** 毫秒 → 人类可读，如 `1.2s` / `3m04s`。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m${String(rest).padStart(2, '0')}s`
}
