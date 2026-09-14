// packages/tlmemory/tests/client-logic.spec.ts
// DSH 客户端插件纯逻辑测试：看板地址、健康探测降级与当前会话视图激活。
import { describe, it, expect, vi } from 'vitest'
import {
  DASHBOARD_ORIGIN,
  VIEW_ID,
  SIDEBAR_ACTION_ID,
  dashboardUrl,
  probeDashboardHealth,
  openDashboardForSession,
} from '../src/client/logic.js'

describe('看板地址常量', () => {
  it('默认源为回环 4890 且 URL 归一化无重复斜杠', () => {
    expect(DASHBOARD_ORIGIN).toBe('http://127.0.0.1:4890')
    expect(dashboardUrl()).toBe('http://127.0.0.1:4890/')
    expect(dashboardUrl('http://127.0.0.1:4890/')).toBe('http://127.0.0.1:4890/')
  })

  it('注册 id 与标签稳定且唯一', () => {
    expect(VIEW_ID).toBe('tlmemory-dashboard')
    expect(SIDEBAR_ACTION_ID).toBe('tlmemory-dashboard-action')
    expect(VIEW_ID).not.toBe(SIDEBAR_ACTION_ID)
  })
})

describe('probeDashboardHealth 健康探测', () => {
  it('2xx 视为在线', async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 200 })
    await expect(probeDashboardHealth(DASHBOARD_ORIGIN, 100, fetcher)).resolves.toBe(true)
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:4890/api/nodes', expect.any(Object))
  })

  it('网络失败/CORS 拒绝静默降级为离线，绝不抛错', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(probeDashboardHealth(DASHBOARD_ORIGIN, 100, fetcher)).resolves.toBe(false)
  })

  it('非 2xx（如 500）视为离线', async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 503 })
    await expect(probeDashboardHealth(DASHBOARD_ORIGIN, 100, fetcher)).resolves.toBe(false)
  })
})

describe('openDashboardForSession 视图激活', () => {
  it('存在当前会话时激活 tlmemory 视图并返回 true', () => {
    const activate = vi.fn()
    const sessions = { list: { getSnapshot: () => ({ current: 'session-1' }) }, binding: vi.fn() }
    const uiConversation = { binding: vi.fn().mockReturnValue({ activate }) }

    expect(openDashboardForSession(sessions as never, uiConversation as never)).toBe(true)
    expect(uiConversation.binding).toHaveBeenCalledWith('session-1')
    expect(activate).toHaveBeenCalledWith(VIEW_ID)
  })

  it('无当前会话（New Session 英雄页）静默返回 false', () => {
    const sessions = { list: { getSnapshot: () => ({}) }, binding: vi.fn() }
    const uiConversation = { binding: vi.fn() }
    expect(openDashboardForSession(sessions as never, uiConversation as never)).toBe(false)
    expect(uiConversation.binding).not.toHaveBeenCalled()
  })

  it('激活过程抛错（会话失效等）静默返回 false', () => {
    const sessions = { list: { getSnapshot: () => ({ current: 'session-9' }) }, binding: vi.fn() }
    const uiConversation = {
      binding: vi.fn().mockImplementation(() => {
        throw new Error('session unavailable')
      }),
    }
    expect(openDashboardForSession(sessions as never, uiConversation as never)).toBe(false)
  })
})