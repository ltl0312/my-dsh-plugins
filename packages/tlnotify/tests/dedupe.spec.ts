// packages/tlnotify/tests/dedupe.spec.ts
//
// 去重是「不刷屏」的第一道闸：宿主 resume 崩溃会话时会重放尾部事件，
// 同一条 turn/end 也可能既被日志路径又被兜底路径看到。

import { describe, expect, it } from 'vitest'
import { Dedupe } from '../src/dedupe.js'

describe('Dedupe.key', () => {
  it('键是 `<会话id>:<seq>`，数字与字符串 seq 等价', () => {
    expect(Dedupe.key('s1', 7)).toBe('s1:7')
    expect(Dedupe.key('s1', '7')).toBe('s1:7')
  })
})

describe('Dedupe.accept', () => {
  it('第一次见到返回 true，重复返回 false', () => {
    const dedupe = new Dedupe()
    expect(dedupe.accept('s1', 1)).toBe(true)
    expect(dedupe.accept('s1', 1)).toBe(false)
    expect(dedupe.size).toBe(1)
  })

  it('不同会话的同一个 seq 互不影响', () => {
    const dedupe = new Dedupe()
    expect(dedupe.accept('s1', 1)).toBe(true)
    expect(dedupe.accept('s2', 1)).toBe(true)
    expect(dedupe.size).toBe(2)
  })

  it('has 只查询不写入', () => {
    const dedupe = new Dedupe()
    expect(dedupe.has('s1', 1)).toBe(false)
    expect(dedupe.size).toBe(0)
    dedupe.accept('s1', 1)
    expect(dedupe.has('s1', 1)).toBe(true)
  })

  it('mark 手动登记一个键（按钮结算后防止二次通知）', () => {
    const dedupe = new Dedupe()
    dedupe.mark('s1', 'req-1')
    expect(dedupe.has('s1', 'req-1')).toBe(true)
    expect(dedupe.has('s1', 'req-2')).toBe(false)
    // mark 过的键同样会挡住 accept，这正是「结算过就不再重复通知」的依据
    expect(dedupe.accept('s1', 'req-1')).toBe(false)
    expect(dedupe.size).toBe(1)
  })

  it('超过 TTL 的条目被自动清掉，同一条 seq 可以再次通过', () => {
    let now = 1_000_000
    const dedupe = new Dedupe({ ttlMs: 1000 })
    expect(dedupe.accept('s1', 1, now)).toBe(true)
    expect(dedupe.accept('s1', 1, now + 500)).toBe(false)
    expect(dedupe.accept('s1', 1, now + 2000)).toBe(true)
  })

  it('超过条目上限时按插入顺序丢掉最老的一批', () => {
    const dedupe = new Dedupe({ maxEntries: 3, ttlMs: 60 * 60 * 1000 })
    for (let i = 0; i < 3; i += 1) dedupe.accept('s', i)
    expect(dedupe.size).toBe(3)
    dedupe.accept('s', 3)
    expect(dedupe.size).toBe(3)
    // 最老的 s:0 被挤掉了，可以重新进来
    expect(dedupe.has('s', 0)).toBe(false)
    expect(dedupe.has('s', 3)).toBe(true)
  })

  it('clear 清空全部', () => {
    const dedupe = new Dedupe()
    dedupe.accept('s1', 1)
    dedupe.clear()
    expect(dedupe.size).toBe(0)
  })
})
