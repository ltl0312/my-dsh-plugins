// packages/tlnotify/tests/aggregate.spec.ts
//
// 正文聚合挂在 `session/event` 热路径上，所有方法都必须是同步且绝不抛异常的。
// 这里把「累积什么、忽略什么、什么时候定格」逐条钉死。

import { describe, expect, it } from 'vitest'
import { TurnAccumulator, blocksToText, formatDuration, summarizeTools } from '../src/aggregate.js'
import type { ToolCallRecord } from '../src/types.js'

const S = 'session-519cc141-4fdd-4ba7-82d1-441b071ab878'

describe('blocksToText', () => {
  it('字符串原样返回', () => {
    expect(blocksToText('你好')).toBe('你好')
  })

  it('只拼 text 块，忽略 reasoning / image / tool-call', () => {
    const content = [
      { type: 'reasoning', text: '内心独白' },
      { type: 'text', text: '第一段' },
      { type: 'image', url: 'x' },
      { type: 'text', text: '第二段' },
      { type: 'tool-call', name: 'read' },
    ]
    expect(blocksToText(content)).toBe('第一段第二段')
  })

  it('畸形输入一律返回空串而不是抛错', () => {
    expect(blocksToText(undefined)).toBe('')
    expect(blocksToText(null)).toBe('')
    expect(blocksToText(42)).toBe('')
    expect(blocksToText([null, 'str', 7, {}])).toBe('')
  })
})

describe('TurnAccumulator', () => {
  it('没有 beginTurn 过时 endTurn 返回 undefined', () => {
    const acc = new TurnAccumulator()
    expect(acc.endTurn(S, 1, 100)).toBeUndefined()
  })

  it('累积助手正文、工具、耗时并定格成快照', () => {
    const acc = new TurnAccumulator()
    acc.beginTurn(S, 3, 1000)
    acc.recordUserMessage(S, [{ type: 'text', text: '帮我改一下' }], { kind: 'user' })
    acc.recordAssistant(S, [{ type: 'text', text: '好的，' }], undefined)
    acc.recordAssistant(S, [{ type: 'text', text: '改完了。' }], { inputTokens: 100, outputTokens: 20 })
    acc.recordToolCall(S, 'read', 'c1', '{"p":"a"}')
    acc.recordToolResult(S, 'c1', false, undefined)
    acc.recordToolCall(S, 'edit', 'c2', '{}')
    acc.recordToolResult(S, 'c2', true, '文件不存在')

    const snapshot = acc.endTurn(S, 3, 6000)!
    expect(snapshot.turn).toBe(3)
    expect(snapshot.startedAt).toBe(1000)
    expect(snapshot.endedAt).toBe(6000)
    expect(snapshot.durationMs).toBe(5000)
    expect(snapshot.assistantText).toBe('好的，改完了。')
    expect(snapshot.userPrompt).toBe('帮我改一下')
    expect(snapshot.tokens).toEqual({ input: 100, output: 20, total: 120 })
    expect(snapshot.tools).toHaveLength(2)
    expect(snapshot.tools[0]).toMatchObject({ name: 'read', callId: 'c1', ok: true })
    expect(snapshot.tools[1]).toMatchObject({ name: 'edit', callId: 'c2', ok: false, error: '文件不存在' })
  })

  it('只有 source.kind === "user" 的消息才算真人提问', () => {
    const acc = new TurnAccumulator()
    acc.beginTurn(S, 1, 0)
    acc.recordUserMessage(S, 'goal 自动续跑', { kind: 'goal' })
    expect(acc.liveSnapshot(S)?.userPrompt).toBeUndefined()
    acc.recordUserMessage(S, '我真正说的话', { kind: 'user' })
    expect(acc.liveSnapshot(S)?.userPrompt).toBe('我真正说的话')
  })

  it('空白提问不覆盖已有提问', () => {
    const acc = new TurnAccumulator()
    acc.beginTurn(S, 1, 0)
    acc.recordUserMessage(S, '第一句', { kind: 'user' })
    acc.recordUserMessage(S, '   ', { kind: 'user' })
    expect(acc.liveSnapshot(S)?.userPrompt).toBe('第一句')
  })

  it('没见过对应 call 的错误结果也记下来（跨进程恢复场景）', () => {
    const acc = new TurnAccumulator()
    acc.beginTurn(S, 1, 0)
    acc.recordToolResult(S, 'ghost', true, 'boom')
    const tools = acc.liveSnapshot(S)!.tools
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: 'unknown', callId: 'ghost', ok: false, error: 'boom' })
  })

  it('没有 beginTurn 时所有 record 都静默忽略', () => {
    const acc = new TurnAccumulator()
    expect(() => {
      acc.recordUserMessage(S, 'x', { kind: 'user' })
      acc.recordAssistant(S, 'y', undefined)
      acc.recordToolCall(S, 'read', 'c', '')
      acc.recordToolResult(S, 'c', true, 'e')
    }).not.toThrow()
    expect(acc.liveSnapshot(S)).toBeUndefined()
  })

  it('全零 usage 不产生 tokens 字段', () => {
    const acc = new TurnAccumulator()
    acc.beginTurn(S, 1, 0)
    acc.recordAssistant(S, '正文', { inputTokens: 0, outputTokens: 0 })
    expect(acc.liveSnapshot(S)?.tokens).toBeUndefined()
  })

  it('liveSnapshot 在轮次进行中可用，endTurn 后转为历史', () => {
    const acc = new TurnAccumulator()
    acc.beginTurn(S, 1, 0)
    acc.recordAssistant(S, '进行中', undefined)
    expect(acc.liveSnapshot(S)?.assistantText).toBe('进行中')
    acc.endTurn(S, 1, 10)
    expect(acc.liveSnapshot(S)).toBeUndefined()
    expect(acc.previousTurns(S, 1)[0]!.assistantText).toBe('进行中')
  })

  it('previousTurns 由旧到新返回最近 n 轮', () => {
    const acc = new TurnAccumulator()
    for (let turn = 1; turn <= 5; turn += 1) {
      acc.beginTurn(S, turn, turn * 1000)
      acc.recordAssistant(S, `第${turn}轮`, undefined)
      acc.endTurn(S, turn, turn * 1000 + 10)
    }
    expect(acc.previousTurns(S, 2).map((t) => t.assistantText)).toEqual(['第4轮', '第5轮'])
    expect(acc.previousTurns(S, 0)).toEqual([])
    expect(acc.previousTurns(S, 99)).toHaveLength(5)
  })

  it('历史超过 12 轮时丢掉最老的', () => {
    const acc = new TurnAccumulator()
    for (let turn = 1; turn <= 15; turn += 1) {
      acc.beginTurn(S, turn, turn)
      acc.recordAssistant(S, `第${turn}轮`, undefined)
      acc.endTurn(S, turn, turn + 1)
    }
    const all = acc.previousTurns(S, 99)
    expect(all).toHaveLength(12)
    expect(all[0]!.assistantText).toBe('第4轮')
  })

  it('不同会话互不干扰，forget / clear 能彻底清掉', () => {
    const acc = new TurnAccumulator()
    acc.beginTurn('s1', 1, 0)
    acc.beginTurn('s2', 1, 0)
    acc.recordAssistant('s1', 'A', undefined)
    acc.recordAssistant('s2', 'B', undefined)
    expect(acc.liveSnapshot('s1')?.assistantText).toBe('A')
    expect(acc.liveSnapshot('s2')?.assistantText).toBe('B')
    acc.forget('s1')
    expect(acc.liveSnapshot('s1')).toBeUndefined()
    expect(acc.liveSnapshot('s2')?.assistantText).toBe('B')
    acc.clear()
    expect(acc.liveSnapshot('s2')).toBeUndefined()
  })

  it('宿主在没有 turn/start 的情况下补 closer 时仍按累积内容出快照', () => {
    const acc = new TurnAccumulator()
    acc.beginTurn(S, 7, 100)
    acc.recordAssistant(S, '半路中断前写的', undefined)
    // 宿主补的 turn/end 可能带着对不上的轮号
    const snapshot = acc.endTurn(S, 999, 200)!
    expect(snapshot.turn).toBe(7)
    expect(snapshot.assistantText).toBe('半路中断前写的')
  })
})

describe('summarizeTools', () => {
  const tool = (name: string): ToolCallRecord => ({ name, callId: name, arguments: '', ok: true })

  it('空列表返回空串', () => {
    expect(summarizeTools([])).toBe('')
  })

  it('按次数降序聚合，次数为 1 时不显示 ×1', () => {
    expect(summarizeTools([tool('read'), tool('read'), tool('read'), tool('bash')])).toBe('read ×3, bash')
  })

  it('超过 limit 时追加「…等 N 种」', () => {
    const tools = ['a', 'b', 'c', 'd'].map(tool)
    expect(summarizeTools(tools, 2)).toBe('a, b, …等 4 种')
  })

  it('名称为空时归到 unknown', () => {
    expect(summarizeTools([{ name: '', callId: 'c', arguments: '', ok: true }])).toBe('unknown')
  })
})

describe('formatDuration', () => {
  it('毫秒级', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(-5)).toBe('0s')
    expect(formatDuration(Number.NaN)).toBe('0s')
    expect(formatDuration(250)).toBe('250ms')
  })

  it('秒级：小于 10 秒保留一位小数', () => {
    expect(formatDuration(1000)).toBe('1.0s')
    expect(formatDuration(1234)).toBe('1.2s')
    expect(formatDuration(12345)).toBe('12s')
  })

  it('分钟级补零', () => {
    expect(formatDuration(60000)).toBe('1m00s')
    expect(formatDuration(184000)).toBe('3m04s')
  })
})
