// packages/tlnotify/tests/route.spec.ts
//
// 回复路由是本插件最容易出错的地方：用户在 IM 里回一句「继续」，必须准确落进
// 正确的会话。这里把三层机制与兜底逐条钉死，尤其是**顺序不可颠倒**这条约束。

import { describe, expect, it } from 'vitest'
import { RouteTable, matchesShortId, type RouteTableOptions } from '../src/route.js'
import type { ActionValue } from '../src/types.js'

const A = 'session-519cc141-4fdd-4ba7-82d1-441b071ab878'
const B = 'session-aabbccdd-1111-2222-3333-444455556666'

function table(options: RouteTableOptions = {}): RouteTable {
  return new RouteTable(options)
}

describe('matchesShortId', () => {
  it('去掉 session- 前缀后做前缀匹配', () => {
    expect(matchesShortId(A, '519cc141')).toBe(true)
    expect(matchesShortId(A, '519c')).toBe(true)
    expect(matchesShortId(A, '519CC141')).toBe(true)
    expect(matchesShortId(A, '519cc142')).toBe(false)
  })

  it('也接受完整的 session-<uuid> 原串', () => {
    expect(matchesShortId(A, A)).toBe(true)
    expect(matchesShortId(A, A.toUpperCase())).toBe(true)
  })
})

describe('RouteTable.record + toJSON/fromJSON', () => {
  it('登记后落盘再读回，三层反查仍然可用', () => {
    const first = table()
    first.record({ messageId: 'm1', sessionId: A, text: 'DSH · 519cc141 · 权限请求', refIdx: 'r1', threadId: 't1' })
    const restored = RouteTable.fromJSON(JSON.parse(JSON.stringify(first.toJSON())))
    expect(restored.resolve({ text: '继续', quotedMessageId: 'm1' }).sessionId).toBe(A)
    expect(restored.resolve({ text: '继续', quotedMessageId: 'r1' }).sessionId).toBe(A)
    expect(restored.resolve({ text: '继续', threadId: 't1' }).sessionId).toBe(A)
    expect(restored.resolve({ text: '继续' }).source).toBe('fallback-latest')
  })

  it('记录 latest 与 lastIntervention 两条兜底指针', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A })
    routes.record({ messageId: 'm2', sessionId: B, intervention: true })
    expect(routes.resolve({ text: 'hi' }).sessionId).toBe(B)
    expect(routes.knownSessions.sort()).toEqual([A, B].sort())
  })

  it('没有 intervention 标记时不会覆盖 lastIntervention', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A, intervention: true })
    routes.record({ messageId: 'm2', sessionId: B })
    // latest 是 B，但 B 被 isLive 否掉后应退到 A
    const gated = table({ isLive: (id) => id !== B })
    gated.record({ messageId: 'm1', sessionId: A, intervention: true })
    gated.record({ messageId: 'm2', sessionId: B })
    expect(gated.resolve({ text: 'hi' }).sessionId).toBe(A)
    expect(gated.resolve({ text: 'hi' }).source).toBe('fallback-intervention')
    expect(routes.resolve({ text: 'hi' }).sessionId).toBe(B)
  })
})

describe('第一层：按钮', () => {
  it('value 自带 sessionId，零歧义，且直接采信', () => {
    const routes = table()
    const value: ActionValue = { v: 1, kind: 'approval', sessionId: A, requestId: 'req-1', choice: 'allow' }
    const resolution = routes.fromAction(value)
    expect(resolution.sessionId).toBe(A)
    expect(resolution.source).toBe('action')
  })

  it('按钮的 text 从 value 里取（有就带上，没有就是空串）', () => {
    const routes = table()
    expect(routes.fromAction({ v: 1, kind: 'goto', sessionId: A }).text).toBe('')
    expect(routes.fromAction({ v: 1, kind: 'question', sessionId: A, text: '选项一' }).text).toBe('选项一')
  })
})

describe('第二层：长按引用回复', () => {
  it('引用平台 messageId 命中', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A })
    const hit = routes.resolve({ text: '继续', quotedMessageId: 'm1' })
    expect(hit.sessionId).toBe(A)
    expect(hit.source).toBe('quoted-id')
    expect(hit.text).toBe('继续')
  })

  it('引用 QQ 的 ref_idx 命中（QQ 入站事件没有 message_reference）', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A, refIdx: 'REF-9' })
    const hit = routes.resolve({ text: '继续', quotedMessageId: 'REF-9' })
    expect(hit.sessionId).toBe(A)
    expect(hit.source).toBe('quoted-id')
  })

  it('引用飞书话题根 id 命中', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A, threadId: 'root-7' })
    const hit = routes.resolve({ text: '继续', threadId: 'root-7' })
    expect(hit.sessionId).toBe(A)
    expect(hit.source).toBe('quoted-id')
  })

  it('引用正文完全一致时命中（byContent 哈希）', () => {
    const routes = table()
    const text = 'DSH · my-dsh-plugins · 519cc141 · 任务完成\n已改完 3 个文件'
    routes.record({ messageId: 'm1', sessionId: A, text })
    const hit = routes.resolve({ text: '继续', quotedText: text })
    expect(hit.sessionId).toBe(A)
    expect(hit.source).toBe('quoted-text')
  })

  it('引用正文被平台截断时按前缀匹配，且优先最近发出的一条', () => {
    const routes = table()
    const older = 'DSH · proj · 519cc141 · 任务完成\n很久以前的那条正文，后面还有很多字'
    const newer = 'DSH · proj · 519cc141 · 任务完成\n刚刚发出的那条正文，后面也还有很多字'
    routes.record({ messageId: 'm1', sessionId: A, text: older })
    routes.record({ messageId: 'm2', sessionId: B, text: newer })
    const hit = routes.resolve({ text: '继续', quotedText: 'DSH · proj · 519cc141 · 任务完成\n刚刚发出的那条正文' })
    expect(hit.sessionId).toBe(B)
    expect(hit.source).toBe('quoted-text')
  })

  it('引用一个完全无关的短文本不会误命中', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A, text: 'DSH · proj · 519cc141 · 任务完成\n正文' })
    const hit = routes.resolve({ text: '继续', quotedText: '嗯' })
    expect(hit.source).toBe('fallback-latest')
  })

  it('引用的目标会话已经不存在时，退回兜底而不是硬塞', () => {
    const routes = table({ isLive: (id) => id !== A })
    routes.record({ messageId: 'm1', sessionId: A })
    routes.record({ messageId: 'm2', sessionId: B })
    expect(routes.resolve({ text: '继续', quotedMessageId: 'm1' }).sessionId).toBe(B)
  })
})

describe('第三层：显式短 id 前缀', () => {
  it('`519cc141 继续` 定向到该会话，并剥掉前缀', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A })
    routes.record({ messageId: 'm2', sessionId: B })
    const hit = routes.resolve({ text: '519cc141 继续' })
    expect(hit.sessionId).toBe(A)
    expect(hit.source).toBe('prefix')
    expect(hit.text).toBe('继续')
    expect(hit.shortId).toBe('519cc141')
  })

  it('中文冒号、逗号与空格都能分隔', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A })
    expect(routes.resolve({ text: '519cc141：继续' }).text).toBe('继续')
    expect(routes.resolve({ text: '519cc141，继续' }).text).toBe('继续')
    expect(routes.resolve({ text: '519cc141   继续' }).text).toBe('继续')
  })

  it('前缀写得像会话 id 但查不到时返回 none 并带 shortId，绝不把整句发出去', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A })
    const hit = routes.resolve({ text: 'deadbeef 你好' })
    expect(hit.source).toBe('none')
    expect(hit.sessionId).toBeUndefined()
    expect(hit.shortId).toBe('deadbeef')
  })

  it('allowPrefix 为 false 时整段文本按兜底处理', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A })
    const hit = routes.resolve({ text: '519cc141 继续' }, { allowPrefix: false })
    expect(hit.source).toBe('fallback-latest')
    expect(hit.text).toBe('519cc141 继续')
  })

  it('引用优先于前缀：两者同时存在时按引用走', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A })
    routes.record({ messageId: 'm2', sessionId: B })
    const hit = routes.resolve({ text: '519cc141 继续', quotedMessageId: 'm2' })
    expect(hit.sessionId).toBe(B)
    expect(hit.source).toBe('quoted-id')
  })
})

describe('兜底与 TTL', () => {
  it('没有引用也没有前缀时发给最新一条通知的会话', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A })
    routes.record({ messageId: 'm2', sessionId: B })
    const hit = routes.resolve({ text: '在吗' })
    expect(hit.sessionId).toBe(B)
    expect(hit.source).toBe('fallback-latest')
    expect(hit.text).toBe('在吗')
  })

  it('fallback=intervention 时优先「最近一次需要人介入」的会话', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A, intervention: true })
    routes.record({ messageId: 'm2', sessionId: B })
    const hit = routes.resolve({ text: '在吗' }, { fallback: 'intervention' })
    expect(hit.sessionId).toBe(A)
    expect(hit.source).toBe('fallback-intervention')
  })

  it('fallback=intervention 但没有人需要介入时，仍然退到最新通知', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: B })
    const hit = routes.resolve({ text: '在吗' }, { fallback: 'intervention' })
    expect(hit.sessionId).toBe(B)
    expect(hit.source).toBe('fallback-latest')
  })

  it('fallback=none 时明确返回 none', () => {
    const routes = table()
    routes.record({ messageId: 'm1', sessionId: A })
    expect(routes.resolve({ text: '在吗' }, { fallback: 'none' }).source).toBe('none')
  })

  it('一张空表明确返回 none（「没有可投递的会话」）', () => {
    expect(table().resolve({ text: '在吗' }).source).toBe('none')
  })

  it('超过 TTL 的条目不再命中', () => {
    let now = 1_000_000
    const routes = table({ ttlDays: 7, now: () => now })
    routes.record({ messageId: 'm1', sessionId: A, text: '正文' })
    expect(routes.resolve({ text: '继续', quotedMessageId: 'm1' }).sessionId).toBe(A)

    now += 8 * 24 * 60 * 60 * 1000
    expect(routes.resolve({ text: '继续', quotedMessageId: 'm1' }).source).toBe('none')
    expect(routes.resolve({ text: '继续', quotedText: '正文' }).source).toBe('none')
  })

  it('prune 清掉过期条目并报告改动', () => {
    let now = 1_000_000
    const routes = table({ ttlDays: 1, now: () => now })
    routes.record({ messageId: 'm1', sessionId: A })
    expect(routes.prune()).toBe(false)
    now += 2 * 24 * 60 * 60 * 1000
    expect(routes.prune()).toBe(true)
    expect(routes.knownSessions).toEqual([])
  })

  it('fromJSON 读取时顺手清掉过期条目', () => {
    const raw = {
      byMessage: { m1: { sessionId: A, time: 1 } },
      byThread: {},
      byRefIdx: {},
      byContent: {},
      latest: { sessionId: A, time: 1 },
    }
    const restored = RouteTable.fromJSON(raw, { now: () => 10 * 24 * 60 * 60 * 1000 })
    expect(restored.knownSessions).toEqual([])
    expect(restored.resolve({ text: 'hi' }).source).toBe('none')
  })

  it('fromJSON 对畸形输入退化成空表而不是抛错', () => {
    expect(RouteTable.fromJSON(null).resolve({ text: 'hi' }).source).toBe('none')
    expect(RouteTable.fromJSON('nonsense').resolve({ text: 'hi' }).source).toBe('none')
    expect(RouteTable.fromJSON({ byMessage: undefined }).knownSessions).toEqual([])
  })
})
