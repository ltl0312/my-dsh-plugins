// packages/tlmemory/src/client/logic.ts
// DSH 客户端插件（浏览器半边）的纯逻辑层：看板地址、健康探测、面板状态机
// 与「中心列单占」协议常量。
//
// 本模块不 import 任何 React / DSH 运行时包、不触碰 DOM，可在 Node 侧直接单测；
// DOM 注入层见 sidebar-entry.ts / panel-mount.ts，注入样式见 styles.ts。
//
// 架构（与宿主内既有全局一级主视图「任务看板 / SSH / 技能中心」同规格）：
//   * 宿主 sidebar shell 未向外部插件开放任何顶部导航插槽；
//   * 中心列（conversation 主视口）是单占席位（ui-conversation 持有），
//     外部插件既不能声明插槽、也无法通过服务 API 切换。
//   因此家族插件统一采用 DOM 级接管：
//     1) 侧栏入口行注入到 shell 的 New Session 行之后（sidebar-entry.ts）；
//     2) 面板容器作为中心列的尾部子节点注入，经 <html> 上的激活属性控制显隐
//        （panel-mount.ts + styles.ts），会话子树保持挂载、状态不丢。
// 单占协调：激活时清除既有面板的 <html> 标记并广播 dsh-panel-activate；
// 收到兄弟面板的广播时主动退场。
//
// 主题桥：看板是跨源 iframe，主题无法继承，故本模块同时定义宿主 ⇄ 看板的
// postMessage 协议常量与消息构造（DOM 侧的读数与订阅见 theme.ts）。

/**
 * 构建期注入的服务端口（scripts/build-client.mjs 经 esbuild define 写入）。
 * 与服务端 config.serverPort 的对应关系：构建客户端 bundle 时通过
 * TLMEMORY_SERVER_PORT 环境变量指定（默认 4890）。运行时未注入（如 vitest
 * 单测直接加载 TS 源码）时回退默认端口，typeof 守卫保证未定义标识符安全。
 */
declare const __TLMEMORY_SERVER_PORT__: number | undefined

function resolveInjectedPort(): number {
  // typeof 守卫：未注入 define 时该标识符在运行时不存在，typeof 读取是唯一安全路径
  if (typeof __TLMEMORY_SERVER_PORT__ === 'number' && Number.isFinite(__TLMEMORY_SERVER_PORT__)) {
    return __TLMEMORY_SERVER_PORT__
  }
  return 4890
}

/** 看板服务端口（构建期内联，与 MemoryServer 的 config.serverPort 保持一致） */
export const DASHBOARD_SERVER_PORT = resolveInjectedPort()

/** 看板服务源地址（由 Node 侧 MemoryServer 严格绑定 127.0.0.1 回环提供服务） */
export const DASHBOARD_ORIGIN = `http://127.0.0.1:${DASHBOARD_SERVER_PORT}`

/** 入口与视图的统一显示名 */
export const DASHBOARD_LABEL = '记忆看板'

/** 回到会话的操作文案（面板头部回退按钮） */
export const BACK_TO_CONVERSATION_LABEL = '返回会话'

/** L2 语义属性取值（skins / 语义属性契约用） */
export const PLUGIN_ID = 'tlmemory'

/** 侧栏入口行的稳定属性：幂等键 + 样式作用域 + 家族排序键 */
export const ENTRY_ATTRIBUTE = 'data-dsh-tlmemory-entry'

/** 侧栏入口行选择器 */
export const ENTRY_SELECTOR = `[${ENTRY_ATTRIBUTE}]`

/** 中心主视口容器属性 */
export const VIEW_ATTRIBUTE = 'data-dsh-tlmemory-view'

/** 中心主视口容器选择器 */
export const VIEW_SELECTOR = `[${VIEW_ATTRIBUTE}]`

/** 注入样式表的 id（同一页面生命周期内只注入一次） */
export const STYLE_ID = 'dsh-plugin-tlmemory/client-view.css'

/** <html> 上的本面板激活标记 */
export const ACTIVE_ATTRIBUTE = 'data-dsh-tlmemory-active'

/** 中心列既有占用者的激活标记：本面板激活时必须一并清除 */
export const SIBLING_ACTIVE_ATTRIBUTES: readonly string[] = [
  'data-dsh-taskboard-active',
  'data-dsh-ssh-active',
]

/** 跨插件中心列占用广播事件（家族协议常量） */
export const PANEL_ACTIVATE_EVENT = 'dsh-panel-activate'

/** 本面板在广播中的 detail 值 */
export const PANEL_NAME = 'tlmemory'

/** 兄弟面板的 detail 值：收到它们的广播即主动退场 */
export const SIBLING_PANEL_NAMES: readonly string[] = ['taskboard', 'ssh']

/**
 * 侧栏家族排序选择器（与任务看板 / SSH / 技能中心并列常驻）。
 * 入口行插到家族块末尾，因此始终排在技能中心之后；把自身选择器也列入，
 * 使已有自身行时锚点计算稳定（放置守卫会跳过已在根内的行）。
 */
export const SIDEBAR_FAMILY_SELECTORS: readonly string[] = [
  '[data-dsh-taskboard-entry]',
  '[data-dsh-ssh-entry]',
  '[data-dsh-skill-explorer-entry]',
  `[${ENTRY_ATTRIBUTE}]`,
]

/** 中心列选择器（0.1.0-rc.6+ AppFrame 用 centerCol，旧 shell 用 data-pane） */
export const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'

/**
 * 侧栏中「点击即应交还会话」的行选择器：会话行 / 项目行 / 搜索结果 /
 * New Session。捕获相位监听，先于 shell 处理点击时收拢面板。
 */
export const SIDEBAR_SESSION_ROW_SELECTOR = [
  '[class*="sessionRow"]',
  '[class*="projectRow"]',
  '[class*="searchResultRow"]',
  '[class*="searchResultWorkspace"]',
  '[class*="newSession"]',
].join(', ')

/** 健康探测超时（毫秒），离线时快速失败、不悬挂 UI */
export const PROBE_TIMEOUT_MS = 2500

/** 健康探测轮询间隔（毫秒） */
export const PROBE_INTERVAL_MS = 15000

/** 看板完整 URL（可追加 path 参数以便未来支持子路由） */
export function dashboardUrl(origin: string = DASHBOARD_ORIGIN): string {
  return `${origin.replace(/\/+$/, '')}/`
}

/**
 * 探测看板服务是否在线：GET /api/health（两字节级响应）且返回 2xx 视为在线。
 * P2-1：此前用 GET /api/nodes 当探针，记忆树到几千节点后每 15s 一次全表
 * dump + JSON 序列化，纯为判断在线与否 —— 现切到服务端专用轻量探针端点。
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
    const res = await fetcher(`${origin.replace(/\/+$/, '')}/api/health`, { signal: controller.signal })
    return res.status >= 200 && res.status < 300
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 中心列占用状态机（打开 / 关闭 / 切换 + 订阅），与 DOM 完全解耦 */
export interface PanelState {
  isOpen(): boolean
  setOpen(open: boolean): void
  toggle(): void
  subscribe(listener: () => void): () => void
}

/**
 * 创建面板状态机。
 * @param initial - 初始打开状态
 * @returns 状态读写与订阅面
 */
export function createPanelState(initial = false): PanelState {
  let open = initial
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 单个订阅者异常不得影响其它订阅者与状态本身。
      }
    }
  }
  return {
    isOpen: () => open,
    setOpen: (next: boolean) => {
      if (open === next) return
      open = next
      notify()
    },
    toggle: () => {
      open = !open
      notify()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * 本面板激活时需要广播的 detail 序列。
 *
 * 既有面板（任务看板 / SSH）只在收到「自身 siblingPanelName」的广播时退场：
 * SSH 的 sibling 是 `taskboard`，任务看板的 sibling 是 `ssh`。它们不认识
 * `tlmemory`，所以除了广播自身，还要按它们各自的语义各播一次，中心列
 * 才能真正让给本面板（同时清除它们的 <html> 标记作为兜底）。
 */
export function activationBroadcasts(): readonly string[] {
  return [...SIBLING_PANEL_NAMES, PANEL_NAME]
}

/** 广播事件上的来源标记键：自播事件必须能被自己的监听端识别并忽略 */
export const PANEL_ACTIVATE_ORIGIN_KEY = '__dshPanelActivateOrigin'

/**
 * 给广播事件打上本面板的来源标记。
 * 激活时要替兄弟面板「代播」它们的 detail 让它们退场，若不加标记，本面板
 * 自己的监听端会把这条广播当成兄弟激活而立刻自我退场（打开即关闭）。
 * @param event - 即将 dispatch 的 dsh-panel-activate 事件
 */
export function markPanelActivation(event: object): void {
  ;(event as Record<string, unknown>)[PANEL_ACTIVATE_ORIGIN_KEY] = PANEL_NAME
}

/**
 * 该广播是否由本面板自身发出。
 * @param event - dsh-panel-activate 事件
 */
export function isSelfActivation(event: object): boolean {
  return (event as Record<string, unknown>)[PANEL_ACTIVATE_ORIGIN_KEY] === PANEL_NAME
}

/**
 * 收到广播时是否应主动退场（中心列单占）。
 * 自身广播（含代播的兄弟 detail）与陌生 detail 都不退场。
 * @param event - dsh-panel-activate 事件
 */
export function shouldRelinquishColumn(event: object): boolean {
  if (isSelfActivation(event)) return false
  const detail = (event as { detail?: unknown }).detail
  return typeof detail === 'string' && SIBLING_PANEL_NAMES.includes(detail)
}

/* --- 主题桥协议（宿主 ⇄ 看板 iframe） ------------------------------------- */

/**
 * 配色模式。
 *
 * 看板是跨源 iframe（回环 127.0.0.1），与宿主的文档、CSS 变量、<html> 属性
 * 全部隔离 —— 主题无法通过 CSS 继承跟随，只能显式传递，因此需要这条协议。
 */
export type ThemeMode = 'light' | 'dark'

/** 宿主 → 看板：推送当前配色模式（规范协议，见 THEME_CHANGE_MESSAGE_TYPE） */
export const THEME_MESSAGE_TYPE = 'dsh-tlmemory:theme'

/**
 * 宿主 → 看板：推送当前配色模式（规范协议）。
 *
 * 消息形如 { type: 'dsh-theme-change', theme: 'dark' | 'light' }；看板侧两种
 * 形态都接收（旧 { type: 'dsh-tlmemory:theme', mode } 保留一个兼容周期，
 * 覆盖「宿主 HMR 已换新 client.js、iframe 里还是旧 web/dist」的混合窗口）。
 */
export const THEME_CHANGE_MESSAGE_TYPE = 'dsh-theme-change'

/** 看板 → 宿主：就绪握手（宿主据此补推一次主题，避免首帧丢失） */
export const READY_MESSAGE_TYPE = 'dsh-tlmemory:ready'

/**
 * 宿主深色主题标记属性（宿主 shell 与家族插件 @linxin666/dsh-client-ui-skin-center
 * 共同使用的权威标记位）。
 */
export const DARK_THEME_ATTRIBUTE = 'data-ds-dark-theme'

/** 宿主显式浅色主题标记属性 */
export const LIGHT_THEME_ATTRIBUTE = 'data-ds-light-theme'

/** 取值型主题标记属性（值为 light / dark），兼容宿主换用通用属性名的情形 */
export const THEME_VALUE_ATTRIBUTES: readonly string[] = ['data-theme', 'data-dsw-theme']

/**
 * 主题观察属性集：宿主切换配色时必然改动其中之一。
 * `class` 用于兼容 class 形态的深色模式（如 `body.dark`）；
 * `style` 用于捕获宿主 boot 脚本对内联 color-scheme 的改写（浅色态唯一显式信号）。
 */
export const THEME_WATCH_ATTRIBUTES: readonly string[] = [
  DARK_THEME_ATTRIBUTE,
  LIGHT_THEME_ATTRIBUTE,
  ...THEME_VALUE_ATTRIBUTES,
  'class',
  'style',
]

/** 系统配色媒体查询（宿主未声明主题时的回落依据） */
export const THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)'

/** class 形态的主题标记：宿主可能直接在顶层元素挂 dark / light 类 */
export const THEME_CLASS_DARK = 'dark'

/** class 形态的主题标记（浅色） */
export const THEME_CLASS_LIGHT = 'light'

/** 旧协议消息体（兼容周期内继续发送，见 THEME_CHANGE_MESSAGE_TYPE 注释） */
export interface ThemeMessage {
  type: typeof THEME_MESSAGE_TYPE
  mode: ThemeMode
}

/** 规范协议消息体：宿主 → 看板的主题推送 */
export interface ThemeChangeMessage {
  type: typeof THEME_CHANGE_MESSAGE_TYPE
  theme: ThemeMode
}

/**
 * 构造旧协议消息体（兼容发送）。
 * @param mode - 当前配色模式
 */
export function legacyThemeMessage(mode: ThemeMode): ThemeMessage {
  return { type: THEME_MESSAGE_TYPE, mode }
}

/**
 * 构造规范协议消息体 { type: 'dsh-theme-change', theme }。
 * @param mode - 当前配色模式
 */
export function themeMessage(mode: ThemeMode): ThemeChangeMessage {
  return { type: THEME_CHANGE_MESSAGE_TYPE, theme: mode }
}

/**
 * 解析看板发来的握手消息。非本协议消息一律返回 undefined（宿主文档上会流经
 * 大量无关 postMessage，不能误判）。
 * @param data - message 事件负载
 */
export function parseDashboardMessage(data: unknown): { type: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const type = (data as { type?: unknown }).type
  if (type !== READY_MESSAGE_TYPE) return undefined
  return { type }
}

/**
 * 该消息是否来自看板 iframe。
 * @param origin - message 事件的 origin
 * @param expected - 看板源地址
 */
export function isDashboardOrigin(origin: string, expected: string = DASHBOARD_ORIGIN): boolean {
  return origin === expected.replace(/\/+$/, '')
}
