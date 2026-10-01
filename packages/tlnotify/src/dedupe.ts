// packages/tlnotify/src/dedupe.ts
//
// 去重（设计方案 §4.5）：按 `<会话id>:<seq>` 判重，24 小时窗口、最多 2000 条。
//
// 为什么需要它——`session/event` 在几种情况下会重复到达：
//   · 宿主 resume 一个崩溃会话时会重放尾部事件；
//   · 我们的门控（gate.ts）在插件重新装载后可能重新收到同一批事件；
//   · 同一条 `turn/end` 可能既被日志路径又被兜底路径看到。
// 去重键用 `seq` 而不是时间戳，因为 seq 在同一会话内单调递增且稳定。

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 2000

export interface DedupeOptions {
  ttlMs?: number
  maxEntries?: number
}

export class Dedupe {
  readonly #seen = new Map<string, number>()
  readonly #ttlMs: number
  readonly #maxEntries: number

  constructor(options: DedupeOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  static key(sessionId: string, seq: number | string): string {
    return `${sessionId}:${seq}`
  }

  /** 第一次见到返回 true（应该继续处理）；重复返回 false。 */
  accept(sessionId: string, seq: number | string, now = Date.now()): boolean {
    this.#prune(now)
    const key = Dedupe.key(sessionId, seq)
    if (this.#seen.has(key)) return false
    this.#seen.set(key, now)
    if (this.#seen.size > this.#maxEntries) this.#prune(now, true)
    return true
  }

  /** 只查询不写入，用于「这条是不是刚发过」的判断。 */
  has(sessionId: string, seq: number | string): boolean {
    return this.#seen.has(Dedupe.key(sessionId, seq))
  }

  /**
   * 手动登记一条（例如按钮结算后要保证同一 requestId 不再触发第二条通知）。
   *
   * 参数形态与 `accept` / `has` 保持一致，都吃 `(sessionId, seq)`，
   * 免得调用方记两套约定、把整条 key 传进来却查不到。
   */
  mark(sessionId: string, seq: number | string, now = Date.now()): void {
    this.#seen.set(Dedupe.key(sessionId, seq), now)
  }

  get size(): number {
    return this.#seen.size
  }

  clear(): void {
    this.#seen.clear()
  }

  #prune(now: number, force = false): void {
    const cutoff = now - this.#ttlMs
    for (const [key, time] of this.#seen) {
      if (time < cutoff) this.#seen.delete(key)
    }
    if (!force || this.#seen.size <= this.#maxEntries) return
    // 还超限说明 24h 内的条目本身就多于上限：按插入顺序（Map 保证）
    // 丢掉最老的一批，直到回到上限。
    const overflow = this.#seen.size - this.#maxEntries
    let dropped = 0
    for (const key of this.#seen.keys()) {
      this.#seen.delete(key)
      if (++dropped >= overflow) break
    }
  }
}
