/**
 * 直接对话的等待登记表。
 *
 * 这里只回答一个问题：**「这一轮模型回复该发给谁」**。
 *
 * 通知模式是「宿主主动说话 → 用户被通知」，所以正文由事件自己带出来，投递目标
 * 从订阅规则里算。对话模式反过来：用户在 QQ 里说了句话，我们把它送进会话，
 * 然后**必须等这一轮结束**才能把回复发回去——中间这段时间，`turn/end` 事件里
 * 只有 `sessionId`，没有「这句话是从哪个 QQ 来的」。
 *
 * 所以入站时登记一条，`turn/end` 时取走一条。表在这里，判定在 `index.ts`：
 * 这一层不认识 DSH 的会话、也不认识 QQ 的通道，只认 `sessionId`。
 *
 * 三条纪律：
 * 1. **同一会话只留一条**。用户连发两句时，第一句那轮的回复已经没人等了——留着
 *    它只会在两轮先后结束时把两条回复都发出去，看起来像复读。所以 `begin()`
 *    直接覆盖，旧条目的定时器由调用方在覆盖前清掉。
 * 2. **超时自己删自己**。模型卡住时不能让条目烂在表里，否则下一轮结束会把陈年
 *    回复发给刚问问题的人。超时回调里先 `take()` 再回话，顺序反了就会重复发。
 * 3. **不抛异常**。这里挂在事件热路径上，抛一次会污染宿主的分发循环。
 */

export interface ChatPending {
  /** 入站消息来自哪条通道（`channels[].id`）。 */
  readonly channelId: string
  /** 通道侧的目标标识（QQ 号 / 群号），用来结束「正在输入」。 */
  readonly chatId?: string
  /** 登记时刻（epoch ms），日志里用来算等了多久。 */
  readonly startedAt: number
  /** 超时定时器；`take()`/`clear()` 负责清掉。没设超时时是 `undefined`。 */
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface ChatBeginInput {
  sessionId: string
  channelId: string
  chatId?: string
  /** 等多久算超时；`<= 0` 表示不设超时（一直等下去）。 */
  timeoutMs: number
  /**
   * 超时那一刻回调。
   *
   * 第二个参数是刚被摘掉的那条——`#pending` 里已经没有了，超时回话要用
   * `channelId` 才知道发回哪个窗口，所以必须随回调带出去。
   */
  onTimeout?: (sessionId: string, entry: ChatPending) => void
}

export class ChatRegistry {
  readonly #pending = new Map<string, ChatPending>()

  get size(): number {
    return this.#pending.size
  }

  has(sessionId: string): boolean {
    return this.#pending.has(sessionId)
  }

  get(sessionId: string): ChatPending | undefined {
    return this.#pending.get(sessionId)
  }

  /**
   * 登记一轮。同一会话已有等待项时先清掉旧的（定时器一起清）。
   *
   * 返回新登记的那条，调用方拿它记日志用。
   */
  begin(input: ChatBeginInput): ChatPending {
    this.#drop(input.sessionId)

    const entry: ChatPending = {
      channelId: input.channelId,
      ...(input.chatId ? { chatId: input.chatId } : {}),
      startedAt: Date.now(),
      timer: undefined,
    }

    // `setTimeout` 的回调在 `#pending` 里查自己：如果期间被 `take()` 走了，
    // 说明正常结束已经接管，这里就什么都不做（否则会重复回一条超时）。
    if (input.timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (!this.#pending.has(input.sessionId)) return
        this.#pending.delete(input.sessionId)
        input.onTimeout?.(input.sessionId, entry)
      }, input.timeoutMs)
      timer.unref?.()
      entry.timer = timer
    }

    this.#pending.set(input.sessionId, entry)
    return entry
  }

  /** 取走并清掉一条（正常结束 / 主动放弃都走这里）。 */
  take(sessionId: string): ChatPending | undefined {
    const entry = this.#pending.get(sessionId)
    if (!entry) return undefined
    this.#pending.delete(sessionId)
    if (entry.timer) clearTimeout(entry.timer)
    return entry
  }

  /** 插件卸载时清干净，别把定时器留给下一个进程。 */
  clear(): void {
    for (const sessionId of [...this.#pending.keys()]) this.take(sessionId)
  }

  #drop(sessionId: string): void {
    const previous = this.#pending.get(sessionId)
    if (!previous) return
    this.#pending.delete(sessionId)
    if (previous.timer) clearTimeout(previous.timer)
  }
}
