// packages/tlmemory/src/client/logic.ts
// DSH 客户端插件（浏览器半边）的纯逻辑层：看板地址、健康探测与视图激活。
// 本模块不 import 任何 React / DSH 运行时包，可在 Node 侧直接单测；
// 浏览器侧由 src/client/index.tsx 消费（构建时打入 web/client.js 捆绑包）。

/** 看板服务源地址（由 Node 侧 MemoryServer 严格绑定 127.0.0.1 回环提供服务） */
export const DASHBOARD_ORIGIN = 'http://127.0.0.1:4890'

/** conversation.view 插槽注册 id（会话头部「记忆看板」页签 + 中心主视口嵌入） */
export const VIEW_ID = 'tlmemory-dashboard'

/** sidebar.footer.action 插槽注册 id（左侧导航栏底部图标入口） */
export const SIDEBAR_ACTION_ID = 'tlmemory-dashboard-action'

/** 页签与侧边栏入口的统一显示名 */
export const DASHBOARD_LABEL = '记忆看板'

/** 健康探测超时（毫秒），离线时快速失败、不悬挂 UI */
export const PROBE_TIMEOUT_MS = 2500

/** 看板完整 URL（可追加 path 参数以便未来支持子路由） */
export function dashboardUrl(origin: string = DASHBOARD_ORIGIN): string {
  return `${origin.replace(/\/+$/, '')}/`
}

/**
 * 探测看板服务是否在线：GET /api/nodes 且返回 2xx 视为在线。
 * 任何网络/CORS/超时异常一律视为离线，绝不向上抛错（浏览器侧静默降级）。
 */
export async function probeDashboardHealth(
  origin: string = DASHBOARD_ORIGIN,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  fetcher: (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }> = (url, init) =>
    fetch(url, init),
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetcher(`${origin.replace(/\/+$/, '')}/api/nodes`, { signal: controller.signal })
    return res.status >= 200 && res.status < 300
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 会话服务最小结构（与 DSH 客户端 sessions 服务逐字段对齐） */
export interface SessionsLike {
  list: {
    getSnapshot(): { current?: string }
  }
  binding(sessionId: string): unknown
}

/** uiConversation 服务最小结构（binding().activate 为视图激活唯一入口） */
export interface UiConversationLike {
  binding(sessionId: string): {
    activate(view: string): void
  }
}

/**
 * 打开记忆看板：激活当前会话的 tlmemory 视图。
 * 无当前会话（如 New Session 英雄页）时返回 false，调用方应静默忽略。
 */
export function openDashboardForSession(
  sessions: SessionsLike,
  uiConversation: UiConversationLike,
): boolean {
  const current = sessions.list.getSnapshot().current
  if (!current) return false
  try {
    uiConversation.binding(current).activate(VIEW_ID)
    return true
  } catch {
    return false
  }
}
