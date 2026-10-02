/**
 * QQ 内联键盘的构造（`buildKeyboard`）。
 *
 * 这个文件存在的唯一理由：`action.type` 的语义**反直觉**，写错一次所有按钮就变成
 * 「点了没反应」，而且宿主侧完全静默——用户 m04327 报的「QQ 没有弹出选项」就是它。
 *
 * 官方文档（`https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html`）：
 *   type 0 = 跳转按钮（link / 小程序）
 *   type 1 = 回调按钮：点击后 QQ 回调后台接口，`data` 经 INTERACTION_CREATE 送回来
 *   type 2 = **指令按钮**：把 `data` 插进输入框当普通文本发出去
 *
 * 所以走 `INTERACTION_CREATE` 的必须写 1，不是 2。
 */
import { describe, expect, it } from 'vitest'

import { buildKeyboard } from '../src/channels/qq.js'
import type { NotificationAction } from '../src/types.js'

function action(label: string, tone?: NotificationAction['tone']): NotificationAction {
  return {
    label,
    ...(tone ? { tone } : {}),
    value: { v: 1, kind: 'question', sessionId: 'sess-1', requestId: 'req-1', choice: label },
  }
}

describe('QQ 内联键盘', () => {
  it('每个按钮都是 type 1（回调），不是 type 2（指令）', () => {
    const keyboard = buildKeyboard([action('允许', 'primary'), action('拒绝', 'danger')])
    const buttons = keyboard?.content.rows.flatMap((row) => row.buttons) ?? []
    expect(buttons).toHaveLength(2)
    for (const button of buttons) expect(button.action.type).toBe(1)
  })

  it('按钮的 data 是结构化 value 的 JSON 字符串（协议要求字符串）', () => {
    const keyboard = buildKeyboard([action('方案甲')])
    const button = keyboard?.content.rows[0]?.buttons[0]
    expect(typeof button?.action.data).toBe('string')
    expect(JSON.parse(button?.action.data ?? '{}')).toMatchObject({
      v: 1,
      kind: 'question',
      sessionId: 'sess-1',
      requestId: 'req-1',
      choice: '方案甲',
    })
  })

  it('不支持的客户端要看到「回复文字」的兜底提示', () => {
    const keyboard = buildKeyboard([action('允许')])
    expect(keyboard?.content.rows[0]?.buttons[0]?.action.unsupport_tips).toContain('回复')
  })

  it('label 与 visited_label 一致，危险按钮样式不同', () => {
    const keyboard = buildKeyboard([action('允许', 'primary'), action('拒绝', 'danger')])
    const [first, second] = keyboard?.content.rows[0]?.buttons ?? []
    expect(first?.render_data).toEqual({ label: '允许', visited_label: '允许', style: 1 })
    expect(second?.render_data.style).toBe(0)
  })

  it('每行最多 3 个按钮，多出来的另起一行', () => {
    const keyboard = buildKeyboard([1, 2, 3, 4, 5, 6, 7].map((index) => action(`选项${index}`)))
    const rows = keyboard?.content.rows ?? []
    expect(rows.map((row) => row.buttons.length)).toEqual([3, 3, 1])
  })

  it('没有按钮时不给键盘字段', () => {
    expect(buildKeyboard([])).toBeUndefined()
  })
})
