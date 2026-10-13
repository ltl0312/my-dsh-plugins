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

import { extractToolCallEvent, extractToolCallEvents } from '../src/events.js'
import type { SessionEventLike, SessionLike } from '../src/events.js'
import { renderNotification } from '../src/render.js'

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

  it('一次带多个问题时逐条出事件：id / seq 都区分开，并标出第几问', () => {
    const raws = extractToolCallEvents(
      session,
      toolCall('ask_user_question', {
        questions: [
          { id: 'engine', question: '谁判定？' },
          { id: 'domain', question: '怎么落盘？' },
          { id: 'surface', question: '入口放哪？' },
        ],
      }),
    )
    expect(raws.map((raw) => raw.detail.questionId)).toEqual(['engine', 'domain', 'surface'])
    expect(raws.map((raw) => raw.detail.requestId)).toEqual([
      'call_00_dGHQUzZz9ZWpxg1gDB906158',
      'call_00_dGHQUzZz9ZWpxg1gDB906158#1',
      'call_00_dGHQUzZz9ZWpxg1gDB906158#2',
    ])
    expect(raws.map((raw) => raw.detail.questionIndex)).toEqual([0, 1, 2])
    expect(raws.map((raw) => raw.detail.questionTotal)).toEqual([3, 3, 3])
    // 第 0 条沿用调用本身的 seq，其余是稳定的负数序号——index.ts 的 Dedupe 按
    // (sessionId, seq) 认重，共用 seq 会让第 2、3 条被当成重复事件丢掉。
    expect(raws[0]!.seq).toBe(408)
    expect(new Set(raws.map((raw) => raw.seq)).size).toBe(3)
  })
})

/**
 * 多选标记的**字段名**：两种拼法都必须认。
 *
 * 现场（2026-10-13，用户验收多选）：QQ 上收到的那张卡片是**单选**的样子——没有 ☐、
 * 没有「提交所选」，反而多出一行「6. 自定义回答（先输入序号再输入文本）」。日志显示真正
 * 投递的是**日志兜底**那条路（waterfall 被去重），而它解析的是模型原始工具参数：
 *
 *   {"questions":[{"header":"多选自测","id":"multiselect-smoke","multi_select":true,…}]}
 *
 * `parseQuestion` 当时只认驼峰 `multiSelect`，于是 `detail.multiSelect` 是 falsy。
 * 两种拼法都是真的：宿主给模型的 schema 用下划线，宿主自己的请求对象（waterfall 读到的）
 * 用驼峰——所以两条路都要能读懂。下面第一组参数就是从 session 日志里原样抄下来的。
 */
describe('多选标记的字段名：multi_select 与 multiSelect 都认', () => {
  /** 生产环境里那份原始参数（`multi_select`，下划线）。 */
  const productionArgs = {
    questions: [
      {
        header: '多选自测',
        id: 'multiselect-smoke',
        multi_select: true,
        options: [
          { description: '点选项后能收到 ☑/☐ 清单回执', label: '回执正常' },
          { label: '暂时不改' },
        ],
      },
    ],
  }

  it('原始参数里的 multi_select（宿主 schema 的下划线拼法）算多选', () => {
    const raw = extractToolCallEvent(session, toolCall('ask_user_question', productionArgs))
    expect(raw?.detail.multiSelect).toBe(true)
    expect(raw?.detail.questionId).toBe('multiselect-smoke')
  })

  it('宿主请求对象用的 multiSelect（驼峰）照旧算多选', () => {
    const raw = extractToolCallEvent(
      session,
      toolCall('ask_user_question', {
        questions: [{ id: 'q1', multiSelect: true, options: [{ label: '甲' }] }],
      }),
    )
    expect(raw?.detail.multiSelect).toBe(true)
  })

  it('没写或写 false 时仍然是单选（不能把单选当多选）', () => {
    for (const questions of [
      [{ id: 'q1', options: [{ label: '甲' }] }],
      [{ id: 'q1', multiSelect: false, options: [{ label: '甲' }] }],
      [{ id: 'q1', multi_select: false, options: [{ label: '甲' }] }],
    ]) {
      const raw = extractToolCallEvent(session, toolCall('ask_user_question', { questions }))
      expect(raw?.detail.multiSelect).toBe(false)
    }
  })

  it('端到端：这份原始参数渲染出来必须带 ☐ 与「提交所选」', () => {
    // 这条才是用户看得见的那一层：兜底路径 → 渲染 → QQ 卡片。
    const raw = extractToolCallEvent(session, toolCall('ask_user_question', productionArgs))
    expect(raw).toBeDefined()
    const notification = renderNotification(raw!, undefined, {
      mode: 'global',
      content: { includeMetadata: true, includeUserPrompt: false, maxBodyChars: 1800 },
      session: {
        context: {
          includeAssistant: true,
          includeTools: true,
          includeTiming: true,
          previousTurns: 3,
          includeUserPrompt: true,
        },
      },
      global: {
        verbosity: 'brief',
        includeSessionLabel: true,
        includeSummaryLine: true,
        includeSubagent: false,
      },
    })

    expect(notification.body).toContain('可选：\n☐ 1. 回执正常\n☐ 2. 暂时不改\n（可多选）')
    expect(notification.body).not.toContain('自定义回答')
    const submit = notification.actions.filter((action) => action.value.submit === true)
    expect(submit).toHaveLength(1)
    expect(submit[0]?.label).toBe('提交所选')
  })
})
