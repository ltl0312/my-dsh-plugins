import { describe, expect, it, vi } from 'vitest'

import { ChatRegistry } from '../src/chat.js'

/**
 * 对话登记表的行为契约。
 *
 * 这张表管的是「这一轮模型回复该发给谁」，它错了会直接表现成两种线上事故：
 * 回复发错窗口（覆盖没生效）、或者同一句话回两遍（超时和正常结束都发了）。
 * 下面每条用例对应其中一个。
 */

describe('ChatRegistry', () => {
  it('登记后能取走，取走后表里就没有了', () => {
    const registry = new ChatRegistry()
    registry.begin({ sessionId: 's1', channelId: 'onebot-1', chatId: '10001', timeoutMs: 0 })

    expect(registry.has('s1')).toBe(true)
    expect(registry.size).toBe(1)

    const entry = registry.take('s1')
    expect(entry?.channelId).toBe('onebot-1')
    expect(entry?.chatId).toBe('10001')
    expect(registry.has('s1')).toBe(false)
    expect(registry.take('s1')).toBeUndefined()
  })

  it('同一会话再登记会覆盖旧条目，旧定时器不再回调', async () => {
    vi.useFakeTimers()
    const first = vi.fn()
    const registry = new ChatRegistry()

    registry.begin({ sessionId: 's1', channelId: 'onebot-1', timeoutMs: 1000, onTimeout: first })
    // 用户连发第二句：第一句那轮的回复已经没人等了。
    registry.begin({ sessionId: 's1', channelId: 'onebot-1', timeoutMs: 1000 })

    expect(registry.size).toBe(1)
    vi.advanceTimersByTime(1500)
    expect(first).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('超时回调带上 channelId，调用方才知道发回哪个窗口', async () => {
    vi.useFakeTimers()
    const seen: Array<{ sessionId: string; channelId: string }> = []
    const registry = new ChatRegistry()

    registry.begin({
      sessionId: 's1',
      channelId: 'onebot-9',
      chatId: '20002',
      timeoutMs: 500,
      onTimeout: (sessionId, entry) => seen.push({ sessionId, channelId: entry.channelId }),
    })

    vi.advanceTimersByTime(600)
    expect(seen).toEqual([{ sessionId: 's1', channelId: 'onebot-9' }])
    // 超时之后表里要干净，否则下一轮结束会把陈年回复发给刚提问的人。
    expect(registry.has('s1')).toBe(false)
    vi.useRealTimers()
  })

  it('正常结束先取走时，超时不会再补一条', async () => {
    vi.useFakeTimers()
    const timeout = vi.fn()
    const registry = new ChatRegistry()

    registry.begin({ sessionId: 's1', channelId: 'onebot-1', timeoutMs: 1000, onTimeout: timeout })
    registry.take('s1')

    vi.advanceTimersByTime(2000)
    expect(timeout).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('timeoutMs <= 0 表示一直等，不建定时器', () => {
    const registry = new ChatRegistry()
    const entry = registry.begin({ sessionId: 's1', channelId: 'onebot-1', timeoutMs: 0 })
    expect(entry.timer).toBeUndefined()
    expect(registry.has('s1')).toBe(true)
    registry.clear()
    expect(registry.size).toBe(0)
  })

  it('clear 把多会话一起收干净', () => {
    const registry = new ChatRegistry()
    registry.begin({ sessionId: 's1', channelId: 'onebot-1', timeoutMs: 0 })
    registry.begin({ sessionId: 's2', channelId: 'onebot-2', timeoutMs: 0 })
    expect(registry.size).toBe(2)
    registry.clear()
    expect(registry.size).toBe(0)
    expect(registry.has('s1')).toBe(false)
    expect(registry.has('s2')).toBe(false)
  })
})
