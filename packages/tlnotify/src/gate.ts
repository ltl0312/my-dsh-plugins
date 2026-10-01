// packages/tlnotify/src/gate.ts
//
// 完成门控（设计方案 §4.5）：`turn/end` 只说明「这一轮结束了」，不等于「Agent
// 停下来了」。排队中的 followup、goal 的自动续跑、`steer` 注入的下一步，都会让
// 宿主在一个 `turn/end` 之后立刻开下一个 `turn/start`。如果每个 `turn/end` 都发
// 一条「任务完成」，用户手机上就是一串毫无信息量的「完成」。
//
// 所以：结束类事件先押在门里，等该会话「安静」一段时间**并且** Agent 真的
// `status === 'idle'` 才放行；期间如果又开了新轮，旧的那条直接作废（它描述的状态
// 已经不是最新状态了）。
//
// 需要人介入的事件（等待提问 / 等待授权 / 等待计划确认）**不进这道门**——那些
// 事件的语义就是「现在就卡住了，需要你看一眼」，延迟只会让它更没用。

import type { RawEvent } from './types.js'

/** Agent 的活体视图，只需要一个 `status`。 */
export interface AgentStatusLike {
  readonly status: 'idle' | 'running'
}

/** 拿 Agent 的回调；返回 undefined 表示会话已经没了。 */
export type AgentLookup = (sessionId: string) => AgentStatusLike | undefined

export interface GateOptions {
  /** 静默窗口：事件之后等这么久没有新动静才考虑放行。 */
  quietMs?: number
  /**
   * 静默窗口到了但 Agent 还在跑时，最多再等几轮。
   * 兜底用——万一 `agent/status` 卡在 running 却再也不变，也不能把通知永远扣住。
   */
  maxRetries?: number
  /** 放行回调。门里保证不会并发调用同一个会话。 */
  flush: (event: RawEvent) => void | Promise<void>
  /** 调试用。 */
  onDebug?: (message: string) => void
}

interface Pending {
  event: RawEvent
  timer: ReturnType<typeof setTimeout>
  retries: number
}

const DEFAULT_QUIET_MS = 1200
const DEFAULT_MAX_RETRIES = 8

/**
 * 每会话一个槽位的完成门。
 *
 * 「每会话一个槽位」是刻意的：同一会话后到的结束事件覆盖先到的，天然实现了
 * 「只报最后一次状态」。不同会话各自独立，互不阻塞。
 */
export class CompletionGate {
  readonly #pending = new Map<string, Pending>()
  readonly #quietMs: number
  readonly #maxRetries: number
  readonly #flush: (event: RawEvent) => void | Promise<void>
  readonly #debug: ((message: string) => void) | undefined
  #agentLookup: AgentLookup | undefined
  #closed = false

  constructor(options: GateOptions) {
    this.#quietMs = options.quietMs ?? DEFAULT_QUIET_MS
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.#flush = options.flush
    this.#debug = options.onDebug
  }

  setAgentLookup(lookup: AgentLookup): void {
    this.#agentLookup = lookup
  }

  /** 押入（或替换）一个结束类事件。 */
  schedule(event: RawEvent): void {
    if (this.#closed) return
    const existing = this.#pending.get(event.sessionId)
    if (existing) {
      clearTimeout(existing.timer)
      this.#debug?.(`门控：${event.sessionId} 的待发通知被新的 ${event.kind} 取代`)
    }
    const timer = setTimeout(() => {
      void this.#attempt(event.sessionId)
    }, this.#quietMs)
    // Node 的定时器不该把进程钉住（宿主退出时我们不想被它拖住）。
    timer.unref?.()
    this.#pending.set(event.sessionId, { event, timer, retries: 0 })
  }

  /**
   * 该会话开了新轮——把门里那条作废。
   *
   * 注意这不只是「重置计时器」：新轮开始意味着上一轮的结束状态已经过期，
   * 发出去只会误导。真正需要人介入的事件不走这里。
   */
  supersede(sessionId: string): void {
    const pending = this.#pending.get(sessionId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pending.delete(sessionId)
    this.#debug?.(`门控：${sessionId} 开了新轮，丢弃待发的 ${pending.event.kind}`)
  }

  /** 会话被销毁 / 被显式取消时清掉。 */
  drop(sessionId: string): void {
    const pending = this.#pending.get(sessionId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pending.delete(sessionId)
  }

  /** 插件卸载时把还押着的事件全部放行，避免用户永远收不到最后一条。 */
  async drain(): Promise<void> {
    const entries = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of entries) clearTimeout(entry.timer)
    for (const entry of entries) {
      try {
        await this.#flush(entry.event)
      } catch {
        /* flush 自己负责报错 */
      }
    }
  }

  close(): void {
    this.#closed = true
    for (const entry of this.#pending.values()) clearTimeout(entry.timer)
    this.#pending.clear()
  }

  get size(): number {
    return this.#pending.size
  }

  async #attempt(sessionId: string): Promise<void> {
    const pending = this.#pending.get(sessionId)
    if (!pending || this.#closed) return

    const agent = this.#agentLookup?.(sessionId)
    if (agent && agent.status === 'running' && pending.retries < this.#maxRetries) {
      // 还在跑：再等一个静默窗口。会话可能只是排队了下一步。
      pending.retries += 1
      this.#debug?.(`门控：${sessionId} 仍在运行，第 ${pending.retries} 次重试`)
      clearTimeout(pending.timer)
      const timer = setTimeout(() => {
        void this.#attempt(sessionId)
      }, this.#quietMs)
      timer.unref?.()
      pending.timer = timer
      return
    }

    this.#pending.delete(sessionId)
    try {
      await this.#flush(pending.event)
    } catch {
      /* flush 自己负责报错 */
    }
  }
}
