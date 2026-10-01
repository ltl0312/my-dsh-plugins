// packages/tlnotify/src/mode.ts
//
// 运行模式（设计方案 §4.7）与 IM 命令解析。
//
//   单会话模式（session）：只推绑定的那一个会话，正文给全上下文，回复零歧义。
//   全局模式（global）  ：所有主会话都推，正文默认精简，回复要走 route.ts 的三层路由。
//
// 两者共用事件源、通道、路由表、按钮、门控与去重——差别只在「推哪些会话」和
// 「正文多详细」。
//
// 切换有三条途径：
//   ① 改 config.json 的 `mode` / `session.targetSessionId`
//   ② IM 里发 `/mode session <短id>` / `/mode global` / `/mode`
//   ③ 全局模式下回复 `detail`，把**单个**会话临时升到详细（存 state.json）
//
// 第 ③ 条是全局模式的减压阀：平时一行摘要，真关心某个会话时回一句 `detail`，
// 之后就只对它给全上下文，直到 `/undetail`。

export type RunMode = 'global' | 'session'

export interface ModeSnapshot {
  mode: RunMode
  targetSessionId?: string
  detailSessions: string[]
}

export type ModeCommand =
  | { kind: 'show' }
  | { kind: 'help' }
  | { kind: 'set-global' }
  | { kind: 'set-session'; shortId?: string }
  | { kind: 'detail'; on: boolean }
  | { kind: 'stop' }

/** 命令文本的识别：允许带 `/` 前缀，也允许裸词（设计方案的示例就是裸 `detail`）。 */
function normalizeCommandText(text: string): string {
  return text.trim().replace(/^\//, '').trim()
}

/**
 * 解析一条 IM 文本是否是控制命令。
 *
 * 只认**整条消息**就是命令的情况。用户在正文里写「顺便说下 detail」不该触发
 * 任何东西——IM 里没有「命令模式」，误判的代价是把用户的话吃掉。
 */
export function parseCommand(text: string): ModeCommand | undefined {
  const raw = normalizeCommandText(text)
  if (raw.length === 0) return undefined
  const lower = raw.toLowerCase()

  if (lower === 'mode' || lower === 'mode?' || lower === '模式') return { kind: 'show' }
  if (lower === 'help' || lower === '?' || lower === '帮助') return { kind: 'help' }

  const parts = raw.split(/\s+/)
  const head = parts[0]!.toLowerCase()

  if (head === 'mode') {
    const sub = parts[1]?.toLowerCase()
    if (!sub || sub === 'show' || sub === '?') return { kind: 'show' }
    if (sub === 'global' || sub === 'all' || sub === '全局') return { kind: 'set-global' }
    if (sub === 'session' || sub === 'single' || sub === '单会话') {
      const shortId = parts[2]?.trim()
      return shortId ? { kind: 'set-session', shortId } : { kind: 'set-session' }
    }
    // `/mode <短id>` 是常见笔误，按绑定解释。
    if (/^(?:session-)?[0-9a-f]{4,12}$/i.test(sub)) return { kind: 'set-session', shortId: sub }
    return { kind: 'help' }
  }

  if (lower === 'detail' || lower === '详细') return { kind: 'detail', on: true }
  if (lower === 'undetail' || lower === 'brief' || lower === '精简') {
    return { kind: 'detail', on: false }
  }
  if (lower === 'stop' || lower === '中止' || lower === '停止') return { kind: 'stop' }

  return undefined
}

/** 判断一段文本是不是「纯粹的 detail 请求」（用于全局模式下的快捷升级）。 */
export function isDetailRequest(text: string): boolean {
  const command = parseCommand(text)
  return command?.kind === 'detail' && command.on
}

// ---------------------------------------------------------------------------
// 模式状态
// ---------------------------------------------------------------------------

export interface ModeStateOptions {
  mode: RunMode
  targetSessionId?: string
  detailSessions?: readonly string[]
}

/**
 * 运行模式 + detail 集合的可变状态。
 *
 * `mode` 与 `targetSessionId` 的权威来源是 config.json（由调用方负责落盘）；
 * `detailSessions` 只进 state.json——它是临时的、会话级的、重启后保留但用户
 * 从不显式编辑的东西。
 */
export class ModeState {
  #mode: RunMode
  #targetSessionId: string | undefined
  readonly #detail = new Set<string>()

  constructor(options: ModeStateOptions) {
    this.#mode = options.mode
    this.#targetSessionId = options.targetSessionId
    for (const id of options.detailSessions ?? []) this.#detail.add(id)
  }

  get mode(): RunMode {
    return this.#mode
  }

  get targetSessionId(): string | undefined {
    return this.#targetSessionId
  }

  setMode(mode: RunMode, targetSessionId?: string): void {
    this.#mode = mode
    this.#targetSessionId = targetSessionId
  }

  /** 单会话模式下是否该推送这个会话。 */
  shouldPush(sessionId: string): boolean {
    if (this.#mode === 'global') return true
    return this.#targetSessionId === sessionId
  }

  /** 这个会话是否处于详细模式（单会话模式天然是）。 */
  isDetailed(sessionId: string): boolean {
    if (this.#mode === 'session') return this.#targetSessionId === sessionId
    return this.#detail.has(sessionId)
  }

  setDetailed(sessionId: string, on: boolean): boolean {
    if (on) {
      if (this.#detail.has(sessionId)) return false
      this.#detail.add(sessionId)
      return true
    }
    return this.#detail.delete(sessionId)
  }

  get detailSessions(): string[] {
    return [...this.#detail]
  }

  snapshot(): ModeSnapshot {
    return {
      mode: this.#mode,
      ...(this.#targetSessionId ? { targetSessionId: this.#targetSessionId } : {}),
      detailSessions: this.detailSessions,
    }
  }
}

// ---------------------------------------------------------------------------
// 回显文案
// ---------------------------------------------------------------------------

export function describeMode(state: ModeSnapshot, labelOf?: (sessionId: string) => string): string {
  const lines: string[] = []
  if (state.mode === 'session') {
    const target = state.targetSessionId
    const label = target ? (labelOf?.(target) ?? target) : '（未绑定）'
    lines.push(`当前：单会话模式 → ${label}`)
    if (!target) lines.push('还没绑定会话。用 `/mode session <短会话id>` 绑定，或 `/mode global` 回到全局。')
  } else {
    lines.push('当前：全局模式（所有主会话）')
    if (state.detailSessions.length > 0) {
      const names = state.detailSessions.map((id) => labelOf?.(id) ?? id).join('、')
      lines.push(`详细模式：${names}`)
    }
  }
  lines.push('', '`/mode global` 全局 · `/mode session <短id>` 单会话 · `detail` 升级当前会话 · `/undetail` 取消 · `/stop` 中止')
  return lines.join('\n')
}

export function helpText(): string {
  return [
    'tlnotify 命令：',
    '· `/mode` —— 查看当前模式',
    '· `/mode global` —— 所有主会话都推（默认）',
    '· `/mode session <短会话id>` —— 只推绑定的那个会话',
    '· `detail` —— 把当前会话升到详细模式（全局模式下）',
    '· `/undetail` —— 取消详细模式',
    '· `/stop` —— 中止当前会话正在跑的任务',
    '',
    '其它回复都会当作消息发给目标会话。长按通知引用回复最稳；也可以写 `<短会话id> 你的话` 定向。',
  ].join('\n')
}
