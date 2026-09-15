// packages/tlmemory/tests/client-logic.spec.ts
// 客户端插件纯逻辑测试（Node 环境，不碰 DOM）：看板地址、健康探测降级、
// 面板状态机，以及「中心列单占」协议常量与广播序列。
import { describe, it, expect, vi } from 'vitest'
import {
  ACTIVE_ATTRIBUTE,
  CONVERSATION_COLUMN_SELECTOR,
  DASHBOARD_LABEL,
  DASHBOARD_ORIGIN,
  ENTRY_ATTRIBUTE,
  ENTRY_SELECTOR,
  PANEL_ACTIVATE_EVENT,
  PANEL_NAME,
  PLUGIN_ID,
  PROBE_INTERVAL_MS,
  SIBLING_ACTIVE_ATTRIBUTES,
  SIBLING_PANEL_NAMES,
  SIDEBAR_FAMILY_SELECTORS,
  SIDEBAR_SESSION_ROW_SELECTOR,
  VIEW_ATTRIBUTE,
  VIEW_SELECTOR,
  activationBroadcasts,
  createPanelState,
  dashboardUrl,
  isSelfActivation,
  markPanelActivation,
  probeDashboardHealth,
  shouldRelinquishColumn,
} from '../src/client/logic.js'

describe('看板地址与属性常量', () => {
  it('默认源为回环 4890 且 URL 归一化无重复斜杠', () => {
    expect(DASHBOARD_ORIGIN).toBe('http://127.0.0.1:4890')
    expect(dashboardUrl()).toBe('http://127.0.0.1:4890/')
    expect(dashboardUrl('http://127.0.0.1:4890/')).toBe('http://127.0.0.1:4890/')
  })

  it('入口 / 容器属性与选择器严格对应（样式表与幂等键都依赖这一致性）', () => {
    expect(PLUGIN_ID).toBe('tlmemory')
    expect(DASHBOARD_LABEL).toBe('记忆看板')
    expect(ENTRY_ATTRIBUTE).toBe('data-dsh-tlmemory-entry')
    expect(ENTRY_SELECTOR).toBe('[data-dsh-tlmemory-entry]')
    expect(VIEW_ATTRIBUTE).toBe('data-dsh-tlmemory-view')
    expect(VIEW_SELECTOR).toBe('[data-dsh-tlmemory-view]')
    expect(ACTIVE_ATTRIBUTE).toBe('data-dsh-tlmemory-active')
    // 两种标记必须互不相同，否则会出现「未激活也显示」或「激活后不显示」
    expect(ACTIVE_ATTRIBUTE).not.toBe(VIEW_ATTRIBUTE)
  })

  it('中心列选择器同时覆盖新外壳（centerCol）与旧外壳（data-pane）', () => {
    expect(CONVERSATION_COLUMN_SELECTOR).toContain('[data-pane="conversation"]')
    expect(CONVERSATION_COLUMN_SELECTOR).toContain('[class*="centerCol"]')
  })

  it('侧栏家族排序包含任务看板 / SSH / 技能中心与自身', () => {
    expect(SIDEBAR_FAMILY_SELECTORS).toContain('[data-dsh-taskboard-entry]')
    expect(SIDEBAR_FAMILY_SELECTORS).toContain('[data-dsh-ssh-entry]')
    expect(SIDEBAR_FAMILY_SELECTORS).toContain('[data-dsh-skill-explorer-entry]')
    expect(SIDEBAR_FAMILY_SELECTORS).toContain(ENTRY_SELECTOR)
    // 自身排在家族末尾：入口行插到家族块之后 → 出现在技能中心之后
    expect(SIDEBAR_FAMILY_SELECTORS[SIDEBAR_FAMILY_SELECTORS.length - 1]).toBe(ENTRY_SELECTOR)
  })

  it('点击会话行即归还中心列的选择器覆盖会话/项目/搜索/新建', () => {
    for (const token of ['sessionRow', 'projectRow', 'searchResultRow', 'searchResultWorkspace', 'newSession']) {
      expect(SIDEBAR_SESSION_ROW_SELECTOR).toContain(token)
    }
  })

  it('轮询间隔为 15s（服务随宿主启停，面板打开期间持续跟踪）', () => {
    expect(PROBE_INTERVAL_MS).toBe(15000)
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

  it('非 2xx（如 503）视为离线', async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 503 })
    await expect(probeDashboardHealth(DASHBOARD_ORIGIN, 100, fetcher)).resolves.toBe(false)
  })

  it('超时（abort）收敛为离线', async () => {
    const fetcher = vi.fn().mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<{ status: number }>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    await expect(probeDashboardHealth(DASHBOARD_ORIGIN, 20, fetcher)).resolves.toBe(false)
  })
})

describe('createPanelState 面板状态机', () => {
  it('初始状态可指定，setOpen 幂等不重复通知', () => {
    const state = createPanelState(true)
    const listener = vi.fn()
    state.subscribe(listener)
    expect(state.isOpen()).toBe(true)

    state.setOpen(true)
    expect(listener).not.toHaveBeenCalled()

    state.setOpen(false)
    expect(state.isOpen()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('toggle 反复翻转', () => {
    const state = createPanelState()
    const seen: boolean[] = []
    state.subscribe(() => seen.push(state.isOpen()))
    state.toggle()
    state.toggle()
    state.toggle()
    expect(seen).toEqual([true, false, true])
  })

  it('退订后不再收到通知', () => {
    const state = createPanelState()
    const listener = vi.fn()
    const unsubscribe = state.subscribe(listener)
    state.setOpen(true)
    unsubscribe()
    state.setOpen(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('单个订阅者抛错不影响其它订阅者与状态本身', () => {
    const state = createPanelState()
    const healthy = vi.fn()
    state.subscribe(() => {
      throw new Error('boom')
    })
    state.subscribe(healthy)
    expect(() => state.setOpen(true)).not.toThrow()
    expect(state.isOpen()).toBe(true)
    expect(healthy).toHaveBeenCalledTimes(1)
  })
})

describe('中心列单占协议', () => {
  it('既有占用者只有任务看板与 SSH', () => {
    expect(SIBLING_ACTIVE_ATTRIBUTES).toEqual(['data-dsh-taskboard-active', 'data-dsh-ssh-active'])
    expect(SIBLING_PANEL_NAMES).toEqual(['taskboard', 'ssh'])
    expect(PANEL_ACTIVATE_EVENT).toBe('dsh-panel-activate')
    expect(PANEL_NAME).toBe('tlmemory')
  })

  it('激活广播序列按兄弟语义先让步、再宣告自身', () => {
    expect(activationBroadcasts()).toEqual(['taskboard', 'ssh', 'tlmemory'])
  })

  it('兄弟面板广播即退场；自身广播（含代播的兄弟 detail）与陌生 detail 不影响', () => {
    const sibling = (detail: unknown): object => ({ detail })
    expect(shouldRelinquishColumn(sibling('taskboard'))).toBe(true)
    expect(shouldRelinquishColumn(sibling('ssh'))).toBe(true)
    expect(shouldRelinquishColumn(sibling('tlmemory'))).toBe(false)
    expect(shouldRelinquishColumn(sibling(undefined))).toBe(false)
    expect(shouldRelinquishColumn(sibling(42))).toBe(false)

    // 关键回归：本面板为让兄弟退场而代播它们的 detail 时，
    // 该事件带自身来源标记，必须被自己的监听端忽略（否则打开即关闭）。
    for (const detail of activationBroadcasts()) {
      const event = { detail }
      markPanelActivation(event)
      expect(isSelfActivation(event)).toBe(true)
      expect(shouldRelinquishColumn(event)).toBe(false)
    }
  })
})
