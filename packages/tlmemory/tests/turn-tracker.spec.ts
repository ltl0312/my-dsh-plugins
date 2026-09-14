// packages/tlmemory/tests/turn-tracker.spec.ts
// 轮次生命周期跟踪器测试：轮次折叠、来源过滤、完成态门禁、有界缓冲与静默收敛。
import { describe, it, expect } from 'vitest'
import {
  TurnTracker,
  extractTextFromBlocks,
  MAX_TURN_BUFFER_CHARS,
  MIN_USER_TEXT_CHARS,
} from '../src/turn-tracker.js'

const LONG_USER = '请帮我为当前仓库搭建一套完整的单元测试基础设施，包括 vitest 配置、覆盖率门禁与 CI 脚本。'
const LONG_ASSISTANT =
  '已完成测试基础设施搭建：配置 vitest 于 packages/tlmemory，新增 coverage 门禁，核心断言全部通过。'

describe('extractTextFromBlocks', () => {
  it('仅提取 text 块，跳过 reasoning / image / tool-call 等其余块', () => {
    const blocks = [
      { type: 'text', text: '第一段' },
      { type: 'reasoning', text: '思考过程不应进入记忆素材' },
      { type: 'image', attachment: { id: 'x' } },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
      { type: 'text', text: '第二段' },
    ]
    expect(extractTextFromBlocks(blocks)).toBe('第一段\n第二段')
  })

  it('畸形输入静默返回空串，绝不抛错', () => {
    expect(extractTextFromBlocks(null)).toBe('')
    expect(extractTextFromBlocks(undefined)).toBe('')
    expect(extractTextFromBlocks([{ type: 'text' }])).toBe('')
    expect(extractTextFromBlocks('string')).toBe('')
  })
})

describe('TurnTracker 轮次折叠', () => {
  it('completed 轮次正确折叠人类输入与助手文本并清空缓冲', () => {
    const tracker = new TurnTracker()
    tracker.onTurnStart(3)
    tracker.addUserMessage(
      [{ type: 'text', text: LONG_USER }],
      'user',
    )
    tracker.addUserMessage([{ type: 'text', text: '补充一句：CI 使用 pnpm approve-builds 放行原生模块。' }], 'user')
    tracker.addAssistantMessage([{ type: 'text', text: LONG_ASSISTANT }])

    const item = tracker.endTurn(3, 'completed')
    expect(item).not.toBeNull()
    expect(item!.turn).toBe(3)
    expect(item!.userText).toContain('单元测试基础设施')
    expect(item!.userText).toContain('pnpm approve-builds')
    expect(item!.assistantText).toContain('配置 vitest')

    // 结算后缓冲必须清空，下一轮从零开始
    expect(tracker.endTurn(4, 'completed')).toBeNull()
  })

  it('非 completed 结局（aborted/error/blocked/max-tokens/interrupted）一律丢弃素材', () => {
    for (const reason of ['aborted', 'error', 'blocked', 'max-tokens', 'interrupted', 'unknown-reason']) {
      const tracker = new TurnTracker()
      tracker.onTurnStart(1)
      tracker.addUserMessage([{ type: 'text', text: LONG_USER }], 'user')
      tracker.addAssistantMessage([{ type: 'text', text: LONG_ASSISTANT }])
      expect(tracker.endTurn(1, reason)).toBeNull()
    }
  })

  it('插件注入上下文（source.kind !== user）不得进入用户素材', () => {
    const tracker = new TurnTracker()
    tracker.onTurnStart(1)
    tracker.addUserMessage([{ type: 'text', text: LONG_USER }], 'user')
    // 文件变更通知 / 技能内容 / 上游消息等注入来源
    tracker.addUserMessage([{ type: 'text', text: '这是文件变更通知注入内容' }], 'plugin')
    tracker.addUserMessage([{ type: 'text', text: '这是工具回填内容' }], 'tool')
    tracker.addAssistantMessage([{ type: 'text', text: LONG_ASSISTANT }])

    const item = tracker.endTurn(1, 'completed')
    expect(item!.userText).toBe(LONG_USER)
  })

  it('素材低于最低门槛时不出产（寒暄轮次不沉淀）', () => {
    const tracker = new TurnTracker()
    tracker.onTurnStart(1)
    tracker.addUserMessage([{ type: 'text', text: '好的' }], 'user')
    tracker.addAssistantMessage([{ type: 'text', text: 'ok' }])
    expect(tracker.endTurn(1, 'completed')).toBeNull()
  })

  it('畸形 turn/start 残留缓冲会被防御式清空，不产生跨轮串扰', () => {
    const tracker = new TurnTracker()
    tracker.onTurnStart(1)
    tracker.addUserMessage([{ type: 'text', text: LONG_USER }], 'user')
    tracker.addAssistantMessage([{ type: 'text', text: LONG_ASSISTANT }])
    // 未结算即开启新轮次（宿主异常恢复路径）
    tracker.onTurnStart(2)
    expect(tracker.endTurn(2, 'completed')).toBeNull()
  })

  it('有界缓冲：超长输入截断至封顶，不无界膨胀', () => {
    const tracker = new TurnTracker(MAX_TURN_BUFFER_CHARS)
    tracker.onTurnStart(1)
    tracker.addUserMessage([{ type: 'text', text: LONG_USER }], 'user')
    // 追加 8 轮足以超出 8000 字符封顶的注入文本
    for (let i = 0; i < 40; i++) {
      tracker.addUserMessage([{ type: 'text', text: '注入文本填充。'.repeat(40) }], 'user')
    }
    tracker.addAssistantMessage([{ type: 'text', text: LONG_ASSISTANT }])
    const item = tracker.endTurn(1, 'completed')
    expect(item!.userText.length).toBeLessThanOrEqual(MAX_TURN_BUFFER_CHARS + 1)
    expect(item!.userText.length).toBeGreaterThan(MIN_USER_TEXT_CHARS)
  })
})