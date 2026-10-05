// packages/tlnotify/src/render.ts
//
// 渲染（设计方案 §4.3 / §4.5）：把 RawEvent + 轮次快照变成一条 Notification，
// 再按平台长度上限分片。
//
// 标题是固定的三段式，任何模式都不变：
//
//     DSH · <项目目录名> · <短会话id> · <事件>
//
// 例：`DSH · DSH · 519cc141 · 权限请求`
//
// 正文才随模式变。全局模式默认「精简」——只留开头一段，因为一台手机上同时开着
// 好几个项目的会话时，正文越长越没人看。
//
// 但「短」不等于「折成一行」。以前精简模式会把整段正文 `oneLine()` 折平，助手回复
// 动辄上千字，折完就是一堵没有换行、没有分节的墙——现场反馈「没有任何格式可言，
// 完全不能快速定位重要信息」。行结构（段落、`【标题】`、`· 列表`）本身就是 IM 里
// 最有用的格式，所以现在一个字都不截、一行都不折，见 `structuredText`。
//
// 单会话模式默认给全上下文。

import { formatDuration, summarizeTools } from './aggregate.js'
import { shortSessionId } from './events.js'
import { toPlainText } from './markdown.js'
import { EVENT_LABELS, LEVEL_BY_KIND } from './types.js'
import type {
  ActionValue,
  EventKind,
  GlobalModeConfig,
  Notification,
  NotificationAction,
  RawEvent,
  SessionModeConfig,
  TurnSnapshot,
} from './types.js'

export interface RenderOptions {
  mode: 'global' | 'session'
  /** 当前会话是否被临时升级成详细（全局模式下回复 `detail` 的产物）。 */
  detailed?: boolean
  content: {
    includeMetadata: boolean
    includeUserPrompt: boolean
    maxBodyChars: number
  }
  session: SessionModeConfig
  global: GlobalModeConfig
  /** 单会话模式下要附带的历史轮次，由旧到新。 */
  previousTurns?: readonly TurnSnapshot[]
}

// ---------------------------------------------------------------------------
// 标题
// ---------------------------------------------------------------------------

export function renderTitle(project: string, shortId: string, kind: EventKind): string {
  return `DSH · ${project} · ${shortId} · ${EVENT_LABELS[kind]}`
}

// ---------------------------------------------------------------------------
// 正文片段
// ---------------------------------------------------------------------------

function truncate(text: string, limit: number): string {
  if (limit <= 0) return ''
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

/** 折叠空白，把多行压成一行（列表项、按钮标签这类必须单行的位置用）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 自由文本入口的转换器。
 *
 * 同一条通知要产出两版正文：`body` 是压平后的纯文本（飞书、以及任何只认纯文本的
 * 通道），`markdown` 是原样的 Markdown（QQ 的 `msg_type: 2`）。两版的差别**只在**
 * 这些入口上，所以把它抽成一个参数往下传，而不是渲染两遍不同的代码路径——那样两边
 * 迟早会长歪。
 *
 * 注意 `PLAIN` 只能对每一处自由文本各跑一次（`toPlainText` 不是幂等的，见
 * `markdown.ts` 顶部），所以正文末尾没有统一的兜底。
 */
type TextMode = (raw: string) => string

const PLAIN: TextMode = (raw) => toPlainText(raw)
const MARKDOWN: TextMode = (raw) => raw

/**
 * 精简模式的正文：**保留行结构**，只做规范化，一个字符都不删。
 *
 * 这里原来是把整段 `oneLine()` 折成一行，理由是「一行讲清楚」。但助手回复动辄上千
 * 字，折平之后用户收到的就是一大段没有换行、没有分节的文字——现场反馈是「没有任何
 * 格式可言，完全不能快速定位重要信息」。段落、`【标题】`、`· 列表`、缩进这些结构
 * 本身就是 IM 里最有用的格式，比省几个字值钱得多。
 *
 * 所以这里只做两件事：去掉行尾空白、把三个以上连续换行收成一个空行。长度不在这里
 * 管——上限由 `content.maxBodyChars` 和 `shardNotification()` 负责，需要少看就调配置。
 *
 * `text` 必须是已经过 `toPlainText` 的纯文本：表格要靠「表头 + 分隔行」相邻才能
 * 认出来，`primaryText` 是那个唯一的 choke point，别挪。
 */
function structuredText(text: string): string {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function metadataLine(snapshot: TurnSnapshot | undefined, includeTiming: boolean): string {
  if (!snapshot) return ''
  const parts: string[] = []
  if (includeTiming && snapshot.durationMs > 0) parts.push(`耗时 ${formatDuration(snapshot.durationMs)}`)
  if (snapshot.tokens?.total) parts.push(`tokens ${snapshot.tokens.total}`)
  if (snapshot.tools.length > 0) parts.push(`工具 ${snapshot.tools.length} 次`)
  return parts.join(' · ')
}

/** 出错时优先展示错误文本，其余情况展示助手正文。 */
function primaryText(event: RawEvent, snapshot: TurnSnapshot | undefined, text: TextMode): string {
  // 必须先压成纯文本：表格要靠「表头 + 分隔行」相邻才能认出来，一旦被折成一行，
  // 就再也认不出块结构了（见 markdown.ts 顶部的顺序约束）。
  if (event.detail.text) return text(event.detail.text)
  if (snapshot?.assistantText) return text(snapshot.assistantText)
  return ''
}

function failedTools(snapshot: TurnSnapshot | undefined, text: TextMode): string[] {
  if (!snapshot) return []
  // 工具报错是外部程序吐出来的自由文本，里面出现 `##`、代码围栏、表格都不稀奇。
  // 这里只压平标记、不折行：折行交给调用方——详细模式要把它塞进 `· ` 项目符号
  // （必须单行），精简模式要留住行结构（见 `structuredText`）。
  return snapshot.tools
    .filter((tool) => !tool.ok)
    .map((tool) => text(`${tool.name}: ${tool.error ?? '失败'}`))
}

/** 精简正文：元信息一行，正文另起一段，正文一字不删（行结构保留）。 */
function briefBody(
  event: RawEvent,
  snapshot: TurnSnapshot | undefined,
  options: RenderOptions,
  text: TextMode,
): string {
  const meta = options.content.includeMetadata ? metadataLine(snapshot, true) : ''
  // 元信息必须单独占一行。以前是 `耗时 5.0s — 正文` 挤在一行里，那行既是数据又是
  // 正文，扫一眼分不清哪是哪，正文一长就彻底糊在一起。
  const withMeta = (body: string): string => [meta, body].filter(Boolean).join('\n\n')
  const primary = structuredText(primaryText(event, snapshot, text))

  switch (event.kind) {
    case 'completed':
      // `meta` 可能因为关掉 includeMetadata 或没有快照而为空——那时不能留下
      // 「已完成\n\n正文」这种前后半截重复的正文，也不能因为 primary 为空就
      // 整条通知没有正文，所以兜底只作用在整串上。
      return withMeta(primary) || '已完成'
    case 'error':
    case 'blocked':
    case 'interrupted': {
      const failures = failedTools(snapshot, text)
      return withMeta(primary || structuredText(failures[0] ?? '')) || EVENT_LABELS[event.kind]
    }
    case 'aborted':
      return withMeta(primary || '已被中止')
    case 'max-tokens':
      return withMeta('达到输出上限，可能需要说「继续」')
    case 'question':
      return questionBody(event, false, text)
    case 'approval':
      return approvalBody(event, text)
    case 'plan':
      return '等待你确认这份计划\n回复「批准」或「不批准」即可。'
    default:
      return primary
  }
}

/** 「自定义回答」那一行的文案。序号由调用处拼（候选数 + 1），见 `questionBody`。 */
const CUSTOM_ANSWER_LABEL = '自定义回答（先输入序号再输入文本）'

/**
 * 提问正文：问题 + 编号选项。
 *
 * 选项**一律编号分行**（用户 m00524 要的）：`可选：` 一行，后面 `1. …` `2. …` 各占一行。
 * 原来精简模式是一行 `可选：甲 / 乙 / 丙`，选项一多就糊成一片；编号分行的另一个好处是
 * 那个序号**正好**就是文本作答时要回的数字（见 `InteractionBridge.settleText`）。
 *
 * 单选提问再补一行「N+1. 自定义回答」——它不是宿主给的选项，是插件自己的约定：回这个
 * 序号就进入「等你说自定义答案」的状态，下一句话原样当答案。多选不加：多选按空格拆
 * token，再塞一个「先回序号再发文本」的流程进去只会跟它打架。
 */
function questionBody(event: RawEvent, withOptions: boolean, text: TextMode): string {
  const lines: string[] = []
  // 一次请求带了多个问题：写清这是第几问。否则用户不知道后面还有没有、也不知道该按什么
  // 顺序答（文本作答按「最早一条」落位，见 `InteractionBridge.settleText`）。
  const total = event.detail.questionTotal
  if (typeof total === 'number' && total > 1) {
    const index = typeof event.detail.questionIndex === 'number' ? event.detail.questionIndex : 0
    lines.push(`（本次共 ${total} 问 · 这是第 ${index + 1} 问，按顺序作答即可）`)
  }
  // 问题和选项都是模型写的，照样可能是 Markdown。选项标签一律 `oneLine`——它要
  // 跟在「1. 」后面，折行会把这个前缀冲掉。
  if (event.detail.text) lines.push(text(event.detail.text))
  const options = event.detail.options ?? []
  if (options.length > 0) {
    lines.push('可选：')
    options.forEach((option, index) => {
      const label = oneLine(text(option.label))
      const description = withOptions && option.description ? ` —— ${oneLine(text(option.description))}` : ''
      lines.push(`${index + 1}. ${label}${description}`)
    })
    if (!event.detail.multiSelect) lines.push(`${options.length + 1}. ${CUSTOM_ANSWER_LABEL}`)
  }
  if (event.detail.multiSelect) lines.push('（可多选）')
  // QQ 单聊的按钮在桌面端 / 老版本上根本不渲染，正文里的这句话才是真正可用的作答
  // 入口（文本作答由 InteractionBridge.settleText 结算）。别删。
  lines.push(
    event.detail.multiSelect ? '回复序号或选项文字即可作答，多个用空格隔开。' : '回复序号或选项文字即可作答。',
  )
  return lines.join('\n')
}

function approvalBody(event: RawEvent, text: TextMode): string {
  // 工具名原来裹着反引号（`` 工具 `Bash` ``）。lark_md 不认行内代码，QQ 更是纯
  // 文本，两边的用户看到的都是多余的反引号，所以这里直接不要标记。
  const tool = event.detail.toolName ? `工具 ${event.detail.toolName}` : '一个工具'
  const reason = event.detail.text ? `\n原因：${oneLine(text(event.detail.text))}` : ''
  return `${tool} 正在申请权限。${reason}\n回复「允许」或「拒绝」即可。`
}

/** 详细正文：单会话模式 / detail 升级后的全局模式。 */
function detailedBody(
  event: RawEvent,
  snapshot: TurnSnapshot | undefined,
  options: RenderOptions,
  text: TextMode,
): string {
  const lines: string[] = []

  if (event.kind === 'question') {
    lines.push(questionBody(event, true, text))
  } else if (event.kind === 'approval') {
    lines.push(approvalBody(event, text))
  } else if (event.kind === 'plan') {
    lines.push('等待你确认这份计划：')
    if (event.detail.plan) {
      lines.push(
        '',
        truncate(text(event.detail.plan), Math.max(200, Math.floor(options.content.maxBodyChars * 0.6))),
      )
    }
    lines.push('', '回复「批准」或「不批准」即可。')
  } else {
    const primary = primaryText(event, snapshot, text)
    if (primary) lines.push(truncate(primary, options.content.maxBodyChars))
    const failures = failedTools(snapshot, text)
    if (failures.length > 0) {
      lines.push('', '失败的工具：')
      for (const failure of failures.slice(0, 5)) lines.push(`· ${truncate(oneLine(failure), 200)}`)
    }
  }

  const useSessionContext = options.mode === 'session'
  const context = useSessionContext ? options.session.context : undefined

  const toolSummary = summarizeTools(snapshot?.tools ?? [])
  if (toolSummary && (!context || context.includeTools)) lines.push('', `工具：${toolSummary}`)

  const meta = metadataLine(snapshot, context ? context.includeTiming : true)
  if (meta && options.content.includeMetadata) lines.push(meta)

  const showUserPrompt = options.content.includeUserPrompt || context?.includeUserPrompt === true
  if (showUserPrompt && snapshot?.userPrompt) {
    // 真人提问也可能整段贴的是 Markdown，所以同样先压再 `oneLine()`——顺序不能反。
    lines.push('', `你刚才问：${truncate(oneLine(text(snapshot.userPrompt)), 300)}`)
  }

  // 只看数组本身：轮数已经由调用方按**这台机器人**的配置算好了（`historyTurns`
  // 可以另给一个轮数、也可以给 0）。这里再去看全局的 `context.previousTurns`，
  // 就会让「全局 0 轮、某台机器人单独要 3 轮」这种组合失效。
  const previousTurns = options.previousTurns ?? []
  if (previousTurns.length > 0) {
    lines.push('', `最近 ${previousTurns.length} 轮：`)
    for (const turn of previousTurns) {
      const prompt = turn.userPrompt ? truncate(oneLine(text(turn.userPrompt)), 120) : '(无提问)'
      const tools = turn.tools.length > 0 ? ` [${summarizeTools(turn.tools, 3)}]` : ''
      lines.push(`· ${prompt}${tools}`)
    }
  }

  return lines.join('\n').trim()
}

// ---------------------------------------------------------------------------
// 按钮
// ---------------------------------------------------------------------------

function action(kind: ActionValue['kind'], label: string, sessionId: string, extra: Partial<ActionValue> = {}, tone?: NotificationAction['tone']): NotificationAction {
  const value: ActionValue = { v: 1, kind, sessionId, ...extra }
  return tone ? { label, value, tone } : { label, value }
}

/** 一次通知最多摆几个按钮——手机上超过这个数就点不准了。 */
export const MAX_ACTION_BUTTONS = 6

function buildActions(event: RawEvent, options: RenderOptions): NotificationAction[] {
  const sessionId = event.sessionId
  const actions: NotificationAction[] = []

  switch (event.kind) {
    case 'approval': {
      if (event.detail.requestId) {
        actions.push(action('approval', '允许', sessionId, { requestId: event.detail.requestId, choice: 'allow' }, 'primary'))
        actions.push(action('approval', '拒绝', sessionId, { requestId: event.detail.requestId, choice: 'reject' }, 'danger'))
      }
      break
    }
    case 'question': {
      const requestId = event.detail.requestId
      // 题目 id 一并带上：通知可能由另一条生产者路径投递，那时 `requestId` 和桥注册的键
      // 对不上，结算要靠这个两条路都认得的身份找回来（见 `ActionValue.questionId`）。
      const questionId = event.detail.questionId
      const options_ = event.detail.options ?? []
      if (requestId && options_.length > 0) {
        options_.slice(0, MAX_ACTION_BUTTONS).forEach((option, index) => {
          actions.push(
            action(
              'question',
              truncate(option.label, 20),
              sessionId,
              { requestId, ...(questionId ? { questionId } : {}), choice: option.label, optionIndex: index },
              'primary',
            ),
          )
        })
      }
      break
    }
    case 'plan': {
      const requestId = event.detail.requestId
      const questionId = event.detail.questionId
      if (requestId) {
        const identity = { requestId, ...(questionId ? { questionId } : {}) }
        actions.push(action('plan', '批准计划', sessionId, { ...identity, choice: 'approve' }, 'primary'))
        actions.push(action('plan', '不批准', sessionId, { ...identity, choice: 'reject' }, 'danger'))
      }
      break
    }
    default:
      break
  }

  // 「打开会话」对所有事件都有用；「升级详情」只在全局模式且未升级时给。
  if (actions.length < MAX_ACTION_BUTTONS) {
    actions.push(action('goto', '打开会话', sessionId))
  }
  if (options.mode === 'global' && !options.detailed && actions.length < MAX_ACTION_BUTTONS) {
    actions.push(action('detail', '详细模式', sessionId))
  }

  return actions.slice(0, MAX_ACTION_BUTTONS)
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function renderNotification(event: RawEvent, snapshot: TurnSnapshot | undefined, options: RenderOptions): Notification {
  const title = renderTitle(event.detail.project, shortSessionId(event.sessionId), event.kind)

  const detailed =
    options.mode === 'session' || options.detailed === true || options.global.verbosity === 'normal'

  // 同一套渲染代码跑两遍，只有自由文本入口的转换器不同：`body` 是压平的纯文本，
  // `markdown` 是原样的 Markdown。这样两版正文永远同源，不会各自漂移。
  const build = (text: TextMode): string => {
    const raw = detailed ? detailedBody(event, snapshot, options, text) : briefBody(event, snapshot, options, text)
    return truncate(raw || EVENT_LABELS[event.kind], options.content.maxBodyChars)
  }

  // 这里**不要**再统一跑一遍 `toPlainText`。它会把代码块与行内代码还原成原文，
  // 而还原出来的 `# 注释`、`- 参数`、`**a**` 在第二遍里就会被当成标记吃掉——
  // 也就是说它不是幂等的。所以正文里每一处自由文本都在它自己的位置先压平
  // （`primaryText` / `questionBody` / `approvalBody` / plan / userPrompt /
  // previousTurns / failedTools），别在末尾兜底。
  const body = build(PLAIN)

  return {
    title,
    body,
    markdown: build(MARKDOWN),
    actions: buildActions(event, options),
    level: LEVEL_BY_KIND[event.kind],
    sessionId: event.sessionId,
    tag: `${event.sessionId}:${event.kind}:${event.seq}`,
    kind: event.kind,
  }
}

// ---------------------------------------------------------------------------
// 分片
// ---------------------------------------------------------------------------

/** 标题之外留给正文的默认预算（QQ 文本消息上限约 4000 字节，中文按 3 字节算）。 */
export const DEFAULT_SHARD_CHARS = 1200

/**
 * 按长度上限切分正文。
 *
 * 第一片带按钮（设计方案 §4.5），后续片只带标题后缀 `(2/3)`。只切正文不切
 * 标题——标题是「哪个会话的什么事件」，每一片都需要它来保持可读性。
 *
 * `body` 与 `markdown` 各切各的：同一段内容在两版里的长度不一样（`## `、`**`、
 * 表格分隔行都只在 Markdown 版里），拿一套偏移量去套另一套必然错位。两版的片数
 * 通常相同；万一不同就以多的为准，少的一边补空串——总比把整段正文重复发一遍强。
 */
export function shardNotification(notification: Notification, limit = DEFAULT_SHARD_CHARS): Notification[] {
  const max = Math.max(200, Math.floor(limit))
  const bodySource = notification.body ?? ''
  const markdownSource = notification.markdown
  if (bodySource.length <= max && (markdownSource === undefined || markdownSource.length <= max)) {
    return [notification]
  }

  const bodies = sliceInto(bodySource, max)
  const markdowns = markdownSource === undefined ? undefined : sliceInto(markdownSource, max)
  const total = Math.max(bodies.length, markdowns?.length ?? 0)

  return Array.from({ length: total }, (_unused, index) => {
    const suffix = total > 1 ? `\n\n(${index + 1}/${total})` : ''
    // 片数不一样时短的那边补另一版的同一片：纯文本是合法的 Markdown，反过来不是，
    // 但两边都**不能丢内容**——丢一片就是用户少看一段。
    return {
      ...notification,
      body: `${bodies[index] ?? markdowns?.[index] ?? ''}${suffix}`,
      ...(markdowns === undefined ? {} : { markdown: `${markdowns[index] ?? bodies[index] ?? ''}${suffix}` }),
      actions: index === 0 ? notification.actions : [],
      // tag 加后缀，让通道侧的去重不会把后续分片当成重复消息。
      tag: index === 0 ? notification.tag : `${notification.tag}#${index + 1}`,
    }
  })
}

/** 切块：优先在换行处断开，其次在空格处，最后硬切；最多 12 片。 */
function sliceInto(source: string, max: number): string[] {
  if (source.length <= max) return [source]

  const chunks: string[] = []
  let rest = source
  while (rest.length > 0 && chunks.length < 12) {
    if (rest.length <= max) {
      chunks.push(rest)
      // 必须清空，否则下面「还有剩余内容」的判断会把这一片再算成一次省略，
      // 凭空多出一片「…（后续内容已省略）」。
      rest = ''
      break
    }
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max)
    if (cut < max * 0.5) cut = max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest.length > 0) chunks.push(`…（后续内容已省略，共 ${source.length} 字）`)
  return chunks
}
