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
// 正文才随模式变。全局模式默认「精简」——一行讲清楚发生了什么，因为一台手机上
// 同时开着好几个项目的会话时，正文越长越没人看。单会话模式默认给全上下文。

import { formatDuration, summarizeTools } from './aggregate.js'
import { shortSessionId } from './events.js'
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

/** 折叠空白，把多行正文压成一行（精简模式用）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
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
function primaryText(event: RawEvent, snapshot: TurnSnapshot | undefined): string {
  if (event.detail.text) return event.detail.text
  if (snapshot?.assistantText) return snapshot.assistantText
  return ''
}

function failedTools(snapshot: TurnSnapshot | undefined): string[] {
  if (!snapshot) return []
  return snapshot.tools.filter((tool) => !tool.ok).map((tool) => `${tool.name}: ${tool.error ?? '失败'}`)
}

/** 精简正文：一行。 */
function briefBody(event: RawEvent, snapshot: TurnSnapshot | undefined, options: RenderOptions): string {
  const meta = options.content.includeMetadata ? metadataLine(snapshot, true) : ''
  const primary = oneLine(primaryText(event, snapshot))

  switch (event.kind) {
    case 'completed':
      // `meta` 可能因为关掉 includeMetadata 或没有快照而为空——那时不能留下
      // 「已完成 — 正文」这种前后半截重复的正文，也不能因为 primary 为空就
      // 整条通知没有正文，所以兜底只作用在整串上。
      return [meta, primary].filter(Boolean).join(' — ') || '已完成'
    case 'error':
    case 'blocked':
    case 'interrupted': {
      const failures = failedTools(snapshot)
      const detail = primary || failures[0] || ''
      return [meta, detail].filter(Boolean).join(' — ') || EVENT_LABELS[event.kind]
    }
    case 'aborted':
      return [meta, primary || '已被中止'].filter(Boolean).join(' — ')
    case 'max-tokens':
      return [meta, '达到输出上限，可能需要说「继续」'].filter(Boolean).join(' — ')
    case 'question':
      return questionBody(event, false)
    case 'approval':
      return approvalBody(event)
    case 'plan':
      return '等待你确认这份计划'
    default:
      return primary
  }
}

/** 提问正文：问题 + 编号选项。 */
function questionBody(event: RawEvent, withOptions: boolean): string {
  const lines: string[] = []
  if (event.detail.text) lines.push(event.detail.text)
  const options = event.detail.options ?? []
  if (withOptions && options.length > 0) {
    options.forEach((option, index) => {
      const description = option.description ? ` —— ${option.description}` : ''
      lines.push(`${index + 1}. ${option.label}${description}`)
    })
  } else if (options.length > 0) {
    lines.push(`可选：${options.map((option) => option.label).join(' / ')}`)
  }
  if (event.detail.multiSelect) lines.push('（可多选）')
  return lines.join('\n')
}

function approvalBody(event: RawEvent): string {
  const tool = event.detail.toolName ? `工具 \`${event.detail.toolName}\`` : '一个工具'
  const reason = event.detail.text ? `\n原因：${event.detail.text}` : ''
  return `${tool} 正在申请权限。${reason}`
}

/** 详细正文：单会话模式 / detail 升级后的全局模式。 */
function detailedBody(event: RawEvent, snapshot: TurnSnapshot | undefined, options: RenderOptions): string {
  const lines: string[] = []

  if (event.kind === 'question') {
    lines.push(questionBody(event, true))
  } else if (event.kind === 'approval') {
    lines.push(approvalBody(event))
  } else if (event.kind === 'plan') {
    lines.push('等待你确认这份计划：')
    if (event.detail.plan) lines.push('', truncate(event.detail.plan, Math.max(200, Math.floor(options.content.maxBodyChars * 0.6))))
  } else {
    const primary = primaryText(event, snapshot)
    if (primary) lines.push(truncate(primary, options.content.maxBodyChars))
    const failures = failedTools(snapshot)
    if (failures.length > 0) {
      lines.push('', '失败的工具：')
      for (const failure of failures.slice(0, 5)) lines.push(`· ${truncate(failure, 200)}`)
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
    lines.push('', `你刚才问：${truncate(oneLine(snapshot.userPrompt), 300)}`)
  }

  const previousTurns = options.previousTurns ?? []
  if (context && context.previousTurns > 0 && previousTurns.length > 0) {
    lines.push('', `最近 ${previousTurns.length} 轮：`)
    for (const turn of previousTurns) {
      const prompt = turn.userPrompt ? truncate(oneLine(turn.userPrompt), 120) : '(无提问)'
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
      const options_ = event.detail.options ?? []
      if (requestId && options_.length > 0) {
        options_.slice(0, MAX_ACTION_BUTTONS).forEach((option, index) => {
          actions.push(
            action('question', truncate(option.label, 20), sessionId, { requestId, choice: option.label, optionIndex: index }, 'primary'),
          )
        })
      }
      break
    }
    case 'plan': {
      if (event.detail.requestId) {
        actions.push(action('plan', '批准计划', sessionId, { requestId: event.detail.requestId, choice: 'approve' }, 'primary'))
        actions.push(action('plan', '不批准', sessionId, { requestId: event.detail.requestId, choice: 'reject' }, 'danger'))
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
  const raw = detailed ? detailedBody(event, snapshot, options) : briefBody(event, snapshot, options)
  const body = truncate(raw || EVENT_LABELS[event.kind], options.content.maxBodyChars)

  return {
    title,
    body,
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
 * 按平台长度上限切分正文。
 *
 * 第一片带按钮（设计方案 §4.5），后续片只带标题后缀 `(2/3)`。只切正文不切
 * 标题——标题是「哪个会话的什么事件」，每一片都需要它来保持可读性。
 */
export function shardNotification(notification: Notification, limit = DEFAULT_SHARD_CHARS): Notification[] {
  const max = Math.max(200, Math.floor(limit))
  const body = notification.body ?? ''
  if (body.length <= max) return [notification]

  const chunks: string[] = []
  let rest = body
  while (rest.length > 0 && chunks.length < 12) {
    if (rest.length <= max) {
      chunks.push(rest)
      // 必须清空，否则下面「还有剩余内容」的判断会把这一片再算成一次省略，
      // 凭空多出一片「…（后续内容已省略）」。
      rest = ''
      break
    }
    // 优先在换行处断开，其次在空格处，最后硬切。
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max)
    if (cut < max * 0.5) cut = max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest.length > 0) chunks.push(`…（后续内容已省略，共 ${body.length} 字）`)

  const total = chunks.length
  return chunks.map((chunk, index) => ({
    ...notification,
    body: total > 1 ? `${chunk}\n\n(${index + 1}/${total})` : chunk,
    actions: index === 0 ? notification.actions : [],
    // tag 加后缀，让通道侧的去重不会把后续分片当成重复消息。
    tag: index === 0 ? notification.tag : `${notification.tag}#${index + 1}`,
  }))
}
