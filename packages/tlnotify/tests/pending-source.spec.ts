// packages/tlnotify/tests/pending-source.spec.ts
//
// 日志兜底那条路（`extractToolCallEvent`）与 waterfall 那条路（InteractionBridge）必须能算出
// **同一个身份**，否则同一个提问会被通知两次。
//
// 现场证据（2026-10-03T15:41:38Z）：
//   15:41:38.317 等待通知来自日志兜底（req call_00_dGHQUzZz9ZWpxg1gDB906158）
//   15:41:38.332 等待通知来自 waterfall（req question-1-1791042098331）
//   15:41:38.725 / .848 已通知：… 等待我回答（1 台：qq-2）        ← 两条
// 两条路算出的 requestId 对不上（宿主没给 waterfall 那条 callId，桥自己合成），所以只能按
// 「会话 + 题目 id」认重——这个文件就是钉住「兜底那条路拿得到题目 id」。

import { describe, expect, it } from 'vitest'

import { extractToolCallEvent } from '../src/events.js'
import type { SessionEventLike, SessionLike } from '../src/events.js'

const session: SessionLike = { id: 'sess-1', header: { cwd: 'D:\\demo\\proj' } }

function toolCall(name: string, args: unknown, callId = 'call_00_dGHQUzZz9ZWpxg1gDB906158'): SessionEventLike {
  return {
    type: 'tool/call',
    seq: 408,
    time: 1791042097931,
    data: { name, callId, arguments: JSON.stringify(args) },
  }
}

describe('日志兜底路径认得出「这是哪一道题」', () => {
  it('ask_user_question：detail.questionId 就是 questions[0].id', () => {
    const raw = extractToolCallEvent(
      session,
      toolCall('ask_user_question', {
        questions: [{ id: 'card-release-test', question: '选一个', options: [{ label: '甲' }] }],
      }),
    )
    expect(raw?.kind).toBe('question')
    expect(raw?.detail.questionId).toBe('card-release-test')
    expect(raw?.detail.requestId).toBe('call_00_dGHQUzZz9ZWpxg1gDB906158')
    expect(raw?.detail.options).toEqual([{ label: '甲' }])
  })

  it('选项写成裸字符串简写时也拿得到题目 id', () => {
    const raw = extractToolCallEvent(
      session,
      toolCall('ask_user_question', { questions: [{ id: 'q1', options: ['甲', '乙'] }] }),
    )
    expect(raw?.detail.questionId).toBe('q1')
    expect(raw?.detail.options).toEqual([{ label: '甲' }, { label: '乙' }])
  })

  it('题目没有 id 时不编一个，留空（桥那边也拿不到，两边一起退化成不认重）', () => {
    const raw = extractToolCallEvent(
      session,
      toolCall('ask_user_question', { questions: [{ question: '选一个' }] }),
    )
    expect(raw?.kind).toBe('question')
    expect(raw?.detail.questionId).toBeUndefined()
  })

  it('exit_plan_mode 是计划不是提问，不带 questionId', () => {
    const raw = extractToolCallEvent(session, toolCall('exit_plan_mode', { plan: '# 计划' }))
    expect(raw?.kind).toBe('plan')
    expect(raw?.detail.questionId).toBeUndefined()
  })

  it('别的工具完全不产生等待事件', () => {
    expect(extractToolCallEvent(session, toolCall('pwsh', { command: 'ls' }))).toBeUndefined()
    expect(extractToolCallEvent(session, { type: 'turn/end', seq: 1, time: 1 })).toBeUndefined()
  })
})
