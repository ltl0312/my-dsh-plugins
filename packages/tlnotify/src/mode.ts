// packages/tlnotify/src/mode.ts
//
// 每台机器人各自的会话范围（《每机器人设置方案》§3）与 IM 命令解析。
//
//   关心全部（all）    ：所有主会话都推，正文默认精简，回复要走 route.ts 的三层路由。
//   只关心一个（single）：只推 `sessionId` 绑定的那一个，正文给全上下文，回复零歧义。
//   只关心多个（filter）：按 `sessionFilter` 白名单推，正文默认精简。
//
// 三者共用事件源、通道、路由表、按钮、门控与去重——差别只在「推哪些会话」和
// 「正文多详细」。
//
// **这里没有全局模式了**：投递的唯一依据是每台机器人自己的 `sessionScope`。
// 一台机器人选「关心全部」不会再被另一个全局开关压掉——那正是「所有机器人还是
// 一个样」的根因（见 src/index.ts 的 `#canPush()`）。`RunMode` /
// `config.mode` / `config.session.targetSessionId` 只剩兼容读写。
//
// 调整有三条途径：
//   ① 设置页里点选（写 config.json 的 `channels[].sessionScope`/`sessionId`/`sessionFilter`）
//   ② IM 里发 `/mode` / `/mode global` / `/mode session <短id>`
//      —— 作用对象是**收到这条命令的那台机器人**
//   ③ 回复 `detail`，把**单个**会话临时升到详细（存 state.json）
//
// 第 ③ 条是「关心多个/全部」时的减压阀：平时一行摘要，真关心某个会话时回一句
// `detail`，之后就只对它给全上下文，直到 `/undetail`。

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
 * 基本规则是「整条消息就是命令」。用户在正文里写「顺便说下 detail」不该触发
 * 任何东西——IM 里没有「命令模式」，误判的代价是把用户的话吃掉。
 *
 * 唯一的例外是 detail 家族的开关：通知里给出的提示就是「回复 detail off 恢复
 * 精简」，用户整句复制回来时后半句只是解释，不该让命令失效（用户 m01934 就
 * 这么踩空过一次）。所以 `detail` 后面只认开关词 on/off（及「开/关」），其后的
 * 解释文字忽略；第二个词不是开关词时仍按普通正文处理，不会被吃掉。
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

  if (lower === 'undetail' || lower === 'brief' || lower === '精简') {
    return { kind: 'detail', on: false }
  }

  // `detail` / `详细` 可带开关词，后面允许跟解释（通知提示的原文就是整句）。
  if (head === 'detail' || head === '详细') {
    const sub = parts[1]?.toLowerCase()
    if (!sub || sub === 'on' || sub === '开') return { kind: 'detail', on: true }
    if (sub === 'off' || sub === '关') return { kind: 'detail', on: false }
    return undefined
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
 * 临时状态：被 `detail` 升级过的会话集合。
 *
 * `mode` 与 `targetSessionId` 是**遗留字段**（老配置文件里还有）：投递已经不看它们
 * 了，只负责原样读进来、原样写回去，别把用户的老配置弄丢。
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

  /** @deprecated 遗留：不再参与投递判断，只为兼容老配置。 */
  get mode(): RunMode {
    return this.#mode
  }

  /** @deprecated 遗留：不再参与投递判断，只为兼容老配置。 */
  get targetSessionId(): string | undefined {
    return this.#targetSessionId
  }

  /** @deprecated 遗留：不再参与投递判断，只为兼容老配置。 */
  setMode(mode: RunMode, targetSessionId?: string): void {
    this.#mode = mode
    this.#targetSessionId = targetSessionId
  }

  /** 这个会话是否被 `detail` 升级到详细模式。 */
  isDetailed(sessionId: string): boolean {
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

/**
 * 「这台机器人关心哪些会话」的回显文案（`/mode` 不带参数时）。
 *
 * 作用对象是**收到命令的那台机器人**，不是全局——多台机器人可以各有各的答案。
 */
export function describeChannelScope(
  scope: 'all' | 'single' | 'filter',
  options: {
    sessionId?: string
    filterCount?: number
    labelOf?: (sessionId: string) => string
  } = {},
): string {
  const lines: string[] = []
  if (scope === 'single') {
    const target = options.sessionId
    if (target) {
      lines.push(`这台机器人：只关心一个会话 → ${options.labelOf?.(target) ?? target}`)
    } else {
      lines.push('这台机器人：只关心一个会话，但还没选是哪一个')
      lines.push('用 `/mode session <短会话id>` 选一个，或在设置页的「会话过滤」里点选——没选之前谁都推不到。')
    }
  } else if (scope === 'filter') {
    const count = options.filterCount ?? 0
    lines.push(
      count > 0
        ? `这台机器人：只关心名单里的 ${count} 个会话`
        : '这台机器人：只关心名单里的会话，但名单还是空的（等于不推）',
    )
    lines.push('名单在设置页的「会话过滤」里勾选。')
  } else {
    lines.push('这台机器人：关心全部会话')
  }
  lines.push(
    '',
    '`/mode global` 这台改成关心全部 · `/mode session <短id>` 只关心一个 · `detail` 升级当前会话 · `/undetail` 取消 · `/stop` 中止',
  )
  return lines.join('\n')
}

/** 命令清单。`/mode` 系列只影响发命令的那台机器人；`detail` 是会话级的。 */
export function helpText(): string {
  return [
    'tlnotify 命令（`/mode` 系列只改**发命令的这台机器人**）：',
    '· `/mode` —— 查看这台机器人关心哪些会话',
    '· `/mode global` —— 这台机器人改为关心全部会话（默认）',
    '· `/mode session <短会话id>` —— 这台机器人只关心绑定的那一个会话',
    '· `detail` —— 把当前会话升到详细模式（对所有机器人有效）',
    '· `/undetail` —— 取消详细模式（`detail off` 等价）',
    '· `/stop` —— 中止当前会话正在跑的任务',
    '',
    '其它回复都会当作消息发给目标会话。长按通知引用回复最稳；也可以写 `<短会话id> 你的话` 定向。',
  ].join('\n')
}
