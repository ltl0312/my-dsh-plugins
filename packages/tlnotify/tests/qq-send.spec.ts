/**
 * QQ 的发送载荷（`buildSendPayload` / `composeQqText`）。
 *
 * 这个文件存在的唯一理由：纯文本与原生 Markdown 是**互斥**的两种载荷。
 *
 *   msg_type: 0 → `content: <文本>`
 *   msg_type: 2 → `markdown: { content: <Markdown> }`，**不能再带外层 `content`**
 *
 * 多带一个 `content` 会被 QQ 按纯文本处理（甚至直接报错），而这种错误在宿主里完全
 * 静默——用户只会觉得「怎么还是没渲染」。所以载荷形状必须有单测钉住。
 *
 * 顺带钉住标题的拼法：Markdown 里单个换行是「软换行」，标题与正文之间必须空一行，
 * 否则标题会被并进正文第一段。
 */
import { describe, expect, it } from 'vitest'

import { applyMarkdownPolicy, buildSendPayload, composeQqText } from '../src/channels/qq.js'
import type { Notification, NotificationAction, ReplyTargetLike } from '../src/channels/qq.js'

const TARGET: ReplyTargetLike = { scope: 'c2c', targetId: 'openid-1' }

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    title: 'DSH · my-dsh-plugins · ec622380 · 等待我回答',
    body: '正文（纯文本）',
    actions: [],
    level: 'info',
    sessionId: 'sess-1',
    tag: 'sess-1:question:1',
    kind: 'question',
    ...overrides,
  }
}

const action: NotificationAction = {
  label: '保持 1800',
  tone: 'primary',
  value: { v: 1, kind: 'question', sessionId: 'sess-1', requestId: 'req-1', choice: '保持 1800' },
}

describe('QQ 发送载荷', () => {
  it('有 Markdown 正文时发 msg_type: 2 + markdown.content，且不带外层 content', () => {
    const payload = buildSendPayload(
      notification({ markdown: '## 标题\n\n- 一条\n- 两条' }),
      TARGET,
    )
    expect(payload.msgType).toBe(2)
    expect(payload.markdown?.content).toContain('## 标题')
    // 互斥：Markdown 载荷里出现 content 就会退化成纯文本。
    expect(payload).not.toHaveProperty('content')
  })

  it('没有 Markdown 正文时退回 msg_type: 0 + content', () => {
    const payload = buildSendPayload(notification(), TARGET)
    expect(payload.msgType).toBe(0)
    expect(payload.content).toBe('DSH · my-dsh-plugins · ec622380 · 等待我回答\n正文（纯文本）')
    expect(payload).not.toHaveProperty('markdown')
  })

  it('Markdown 版标题加粗、与正文之间空一行；纯文本版仍是单换行', () => {
    expect(composeQqText(notification({ markdown: '正文' }))).toBe(
      '**DSH · my-dsh-plugins · ec622380 · 等待我回答**\n\n正文',
    )
    expect(composeQqText(notification())).toBe('DSH · my-dsh-plugins · ec622380 · 等待我回答\n正文（纯文本）')
  })

  it('按钮（内联键盘）与 Markdown 可以同时带上', () => {
    const payload = buildSendPayload(notification({ markdown: '正文', actions: [action] }), TARGET)
    expect(payload.msgType).toBe(2)
    expect(payload.keyboard?.content.rows[0]?.buttons[0]?.render_data.label).toBe('保持 1800')
  })

  it('被动回复窗口的 msg_seq 通过 extra 透传', () => {
    const payload = buildSendPayload(notification(), { ...TARGET, msgId: 'msg-1' }, { msg_seq: 2 })
    expect(payload.extra).toEqual({ msg_seq: 2 })
  })
})

/**
 * 「QQ 的 markdown 卡片在电脑上只有手机宽」——`msg_type: 2` 的卡片宽度由 QQ
 * 客户端写死（桌面端实测约 600px，同一窗口的普通文本气泡约 850px），插件改不了。
 * 于是把卡片改成**显式开启**，缺省走纯文本，让通知的观感与普通消息一致。
 */
describe('QQ 通道的 Markdown 开关（缺省 = 纯文本）', () => {
  const card = notification({ markdown: '## 标题\n\n**正文**' })

  it('未设置 markdown 时降级成纯文本载荷', () => {
    const payload = buildSendPayload(applyMarkdownPolicy(card, undefined), TARGET)
    expect(payload.msgType).toBe(0)
    expect(payload).not.toHaveProperty('markdown')
    expect(payload.content).not.toContain('##')
  })

  it('显式 markdown: false 一样降级', () => {
    const payload = buildSendPayload(applyMarkdownPolicy(card, false), TARGET)
    expect(payload.msgType).toBe(0)
    expect(payload.content).toBe('DSH · my-dsh-plugins · ec622380 · 等待我回答\n正文（纯文本）')
  })

  it('markdown: true 才发卡片', () => {
    const payload = buildSendPayload(applyMarkdownPolicy(card, true), TARGET)
    expect(payload.msgType).toBe(2)
    expect(payload.markdown?.content).toContain('## 标题')
  })

  it('通知本来就没有 Markdown 正文时，开关不改变结果', () => {
    const payload = buildSendPayload(applyMarkdownPolicy(notification(), true), TARGET)
    expect(payload.msgType).toBe(0)
    expect(payload).not.toHaveProperty('markdown')
  })
})
