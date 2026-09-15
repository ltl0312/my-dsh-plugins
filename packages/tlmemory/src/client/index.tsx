// packages/tlmemory/src/client/index.tsx
// DSH 客户端插件（浏览器半边）：把 tlmemory 看板做成与「任务看板 / SSH /
// 技能中心」同规格的全局一级主视图。
//
// 形态（对照宿主内既有家族实现 @linxin666/dsh-ssh 与
// @linxin666/dsh-client-ui-task-board）：
//   1. 入口：左侧边栏顶部（New Session 行之后的家族块），与任务看板 / SSH /
//      技能中心并列常驻，不随会话变化；折叠轨（rail）退化为圆形图标按钮；
//   2. 视图：点击后在中心主视口整幅内嵌 http://127.0.0.1:4890，顶部带标准
//      「‹ 返回会话 | 记忆看板」回退头，左右外壳与会话子树保持挂载；
//   3. 绝不弹出外部窗口：所有降级都发生在中心视口内的遮罩层里（离线提示 +
//      重试），入口本身永不静默失败。
//
// 为什么不注册插槽：宿主 sidebar shell 没有「顶部导航入口」插槽，中心列
// （conversation 单占席位，ui-conversation 持有）也不允许外部插件声明插槽 ——
// 家族插件统一采用 DOM 级接管（详见 sidebar-entry.ts / panel-mount.ts）。
//
// 安全：看板仅回环地址 127.0.0.1:4890，宿主未启动管线时显示离线遮罩，
//      绝不影响会话主流程；插件卸载时入口、容器、样式随纤程全部回收。

import type { Context } from 'cordis'
import React from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ACTIVE_ATTRIBUTE,
  BACK_TO_CONVERSATION_LABEL,
  DASHBOARD_LABEL,
  DASHBOARD_ORIGIN,
  ENTRY_ATTRIBUTE,
  ENTRY_SELECTOR,
  PANEL_NAME,
  PLUGIN_ID,
  PROBE_INTERVAL_MS,
  SIDEBAR_FAMILY_SELECTORS,
  VIEW_ATTRIBUTE,
  VIEW_SELECTOR,
  createPanelState,
  dashboardUrl,
  isDashboardOrigin,
  legacyThemeMessage,
  parseDashboardMessage,
  probeDashboardHealth,
  themeMessage,
  type PanelState,
  type ThemeMode,
} from './logic.js'
import { ENTRY_ICON, mountSidebarEntry } from './sidebar-entry.js'
import { mountCenterPanel } from './panel-mount.js'
import { applyFrameTransparency } from './frame.js'
import { detectThemeMode, watchThemeMode } from './theme.js'
import { ensureClientStyles, removeClientStyles } from './styles.js'

// 客户端模块的公开面：cordis 加载所需（apply / inject）+ 供自检与单测使用的
// 逻辑、挂载与样式入口（与家族插件不同，本插件把纯逻辑一并导出以便单测）。
export * from './logic.js'
export { ENTRY_ICON, mountSidebarEntry, sidebarRoot, newSessionButton } from './sidebar-entry.js'
export { mountCenterPanel, conversationColumn } from './panel-mount.js'
export { ensureClientStyles, removeClientStyles, CLIENT_CSS, STYLE_SELECTOR } from './styles.js'
export { detectThemeMode, watchThemeMode } from './theme.js'
export { applyFrameTransparency, TRANSPARENT_BACKGROUND } from './frame.js'
export { ACTIVE_ATTRIBUTE, VIEW_ATTRIBUTE }

/**
 * 客户端插件的服务依赖：DOM 级接管不需要任何客户端服务，
 * 因此显式声明为空 —— apply 立即执行，由 MutationObserver 等待外壳渲染。
 */
export const inject: string[] = []

/** 健康探测的三态 */
type Health = 'probing' | 'online' | 'offline'

/** 面板容器的 dataset 键（→ data-dsh-tlmemory-view） */
const VIEW_DATASET_KEY = 'dshTlmemoryView'

/** 三个状态点颜色（令牌优先，带中性回落） */
const DOT_COLOR: Record<Health, string> = {
  probing: 'var(--dsw-alias-state-warn-primary, #eab308)',
  online: 'var(--dsw-alias-state-success-primary, #22c55e)',
  offline: 'var(--dsw-alias-state-error-primary, #ef4444)',
}

/**
 * 订阅宿主配色模式：面板内容只由宿主主题驱动，不做任何本地假想。
 * 宿主在切换 light / dark 时改动 <html> / body 上的主题标记，本 hook 据此重渲染。
 */
function useThemeMode(): ThemeMode {
  const [mode, setMode] = React.useState<ThemeMode>(() =>
    typeof document === 'undefined' ? 'light' : detectThemeMode(document),
  )

  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined
    // 挂载瞬间宿主可能尚未结算主题标记，先校正一次再进入观察。
    setMode(detectThemeMode(document))
    return watchThemeMode(document, (next) => {
      setMode(next)
    })
  }, [])

  return mode
}

/**
 * 中心主视口面板：标准回退头 + 健康状态点 + 全幅透明 iframe。
 *
 * 高度自适应由宿主结构保证：容器是中心列内的 `position:absolute; inset:0`，
 * 面板 `height:100%`、iframe `flex:1; min-height:0`，无需任何 vh 估算。
 * 加载态与离线态都以视口内遮罩呈现，不弹窗、不开新窗口。
 *
 * 主题链路（看板是跨源 iframe，CSS 无法继承）：
 *   1. 宿主侧读出当前配色（theme.ts，data-* 标记 / 内联 color-scheme / class 令牌三类来源），
 *      iframe 就绪与主题变更时 postMessage 推送（规范协议 dsh-theme-change + 旧协议兼容双发）；
 *   2. iframe 主动发就绪握手，宿主收到即补推一次，覆盖「推送早于监听注册」的时序；
 *   3. iframe 元素的 color-scheme 保持 normal（styles.ts 声明），绝不设 light/dark ——
 *      任何非 normal 值都会让 Chromium 涂白 iframe 画布，破坏透明透传。
 */
function MemoryDashboardPanel(props: { state: PanelState }): ReactElement {
  const { state } = props
  const [health, setHealth] = React.useState<Health>('probing')
  const [frameLoaded, setFrameLoaded] = React.useState(false)
  const [reloadNonce, setReloadNonce] = React.useState(0)
  const healthRef = React.useRef<Health>('probing')
  const frameRef = React.useRef<HTMLIFrameElement | null>(null)
  const theme = useThemeMode()
  const themeRef = React.useRef<ThemeMode>(theme)

  React.useEffect(() => {
    healthRef.current = health
  }, [health])

  React.useEffect(() => {
    themeRef.current = theme
  }, [theme])

  /**
   * 向看板推送当前配色；主题值走 ref，回调因此可以不随主题变化重建。
   *
   * 双发两个协议形态：规范协议 { type: 'dsh-theme-change', theme } 与旧协议
   * { type: 'dsh-tlmemory:theme', mode }。iframe 里的 web/dist 与宿主 client.js
   * 的更新时机并不保证同步（HMR 只热换宿主半边，iframe 要等自身重载），
   * 双发让混合版本窗口内的任何一侧都能听懂对方。
   */
  const pushTheme = React.useCallback(() => {
    const target = frameRef.current?.contentWindow
    if (target === null || target === undefined) return
    try {
      target.postMessage(themeMessage(themeRef.current), DASHBOARD_ORIGIN)
      target.postMessage(legacyThemeMessage(themeRef.current), DASHBOARD_ORIGIN)
    } catch {
      // 跨源目标被拒绝（理论上不会，源固定为回环地址）不应打断看板渲染。
    }
  }, [])

  // iframe 元素每次重载都会重建（key=reloadNonce），因此透明属性必须在该依赖上
  // 重放，而不是只在挂载时执行一次。刻意不设置 iframe 元素的 color-scheme：
  // 任何非 normal 值都会让 Chromium 把 iframe 画布涂成不透明白（见 frame.ts）。
  React.useEffect(() => {
    const frame = frameRef.current
    if (frame === null || frame === undefined) return
    applyFrameTransparency(frame)
  }, [reloadNonce])

  // 看板文档加载完成即推主题：此时看板的监听端已就绪，首帧不会用错配色。
  React.useEffect(() => {
    if (frameLoaded) pushTheme()
  }, [frameLoaded, theme, pushTheme])

  // 看板就绪握手 → 补推主题（覆盖 iframe 文档晚于首次推送才建立监听的时序）。
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onMessage = (event: MessageEvent): void => {
      if (!isDashboardOrigin(event.origin)) return
      if (parseDashboardMessage(event.data) === undefined) return
      pushTheme()
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
    }
  }, [pushTheme])

  /** 把一次探测结果落到 UI；离线时撤下已加载标记，由离线遮罩接管 */
  const applyHealth = React.useCallback((ok: boolean) => {
    const wasOffline = healthRef.current === 'offline'
    const next: Health = ok ? 'online' : 'offline'
    healthRef.current = next
    setHealth(next)
    if (!ok) {
      setFrameLoaded(false)
      return
    }
    // 离线恢复：iframe 里可能停着上一轮的错误页，强制重载一次。
    if (wasOffline) {
      setFrameLoaded(false)
      setReloadNonce((value) => value + 1)
    }
  }, [])

  const probe = React.useCallback(() => {
    void probeDashboardHealth(DASHBOARD_ORIGIN).then((ok) => {
      applyHealth(ok)
    })
  }, [applyHealth])

  // 初次探测 + 周期探测（服务随宿主启停，面板打开期间持续跟踪）。
  React.useEffect(() => {
    probe()
    const timer = setInterval(probe, PROBE_INTERVAL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [probe])

  // 每次打开面板时重新探测，避免显示上一次的陈旧状态。
  React.useEffect(
    () =>
      state.subscribe(() => {
        if (state.isOpen()) probe()
      }),
    [probe, state],
  )

  const retry = (): void => {
    setFrameLoaded(false)
    setReloadNonce((value) => value + 1)
    probe()
  }

  const statusText = health === 'probing' ? '连接中' : health === 'online' ? '服务在线' : '服务未启动'
  const showOverlay = health === 'offline' || !frameLoaded

  const overlay = !showOverlay
    ? null
    : health === 'offline'
      ? React.createElement(
          'div',
          { className: 'tlmemory-overlay' },
          React.createElement(
            'div',
            { className: 'tlmemory-overlay-card' },
            React.createElement('span', { className: 'tlmemory-overlay-title' }, '记忆看板服务未启动'),
            React.createElement(
              'span',
              { className: 'tlmemory-overlay-hint' },
              `未能连接 ${DASHBOARD_ORIGIN}。请确认 DSH 宿主已启动（配置项 serverEnabled: true）。`,
            ),
            React.createElement('button', { type: 'button', className: 'tlmemory-retry', onClick: retry }, '重试'),
          ),
        )
      : React.createElement(
          'div',
          { className: 'tlmemory-overlay' },
          React.createElement(
            'div',
            { className: 'tlmemory-overlay-card' },
            React.createElement('span', { className: 'tlmemory-spinner' }),
            React.createElement('span', { className: 'tlmemory-overlay-hint' }, '正在加载记忆看板…'),
          ),
        )

  return React.createElement(
    'div',
    { className: 'tlmemory-panel', 'data-dsh-plugin': PLUGIN_ID, 'data-theme': theme },
    // 标题栏布局（右上角安全区）：
    //   [‹ 返回会话] [记忆看板] [● 服务在线] [重试?] ………右侧整段留空………
    // 状态指示器与标题同基准线紧邻成一个左对齐标题组，**不再推到最右端** ——
    // 中心列整幅接管时，面板右上角与宿主右上角的抽屉折叠按钮是同一块区域，
    // 任何贴右的控件都会盖住宿主自己的图标。安全区由 .tlmemory-header 的
    // padding-right 保证（见 styles.ts）。
    React.createElement(
      'header',
      { className: 'tlmemory-header' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'tlmemory-back',
          // 家族协议：中心视图回退控件的共享钩子（skin / 移动端适配据此定位）。
          'data-dsh-center-view-back': '',
          'aria-label': BACK_TO_CONVERSATION_LABEL,
          title: BACK_TO_CONVERSATION_LABEL,
          onClick: () => {
            state.setOpen(false)
          },
        },
        React.createElement('span', { 'aria-hidden': 'true' }, '‹'),
        React.createElement('span', null, BACK_TO_CONVERSATION_LABEL),
      ),
      React.createElement(
        'div',
        { className: 'tlmemory-heading' },
        React.createElement('h2', { className: 'tlmemory-title' }, DASHBOARD_LABEL),
        React.createElement(
          'span',
          {
            className: 'tlmemory-status',
            'data-dsh-part': 'panel-status',
            title: statusText,
            role: 'status',
            'aria-live': 'polite',
          },
          React.createElement('span', { className: 'tlmemory-dot', style: { color: DOT_COLOR[health] } }, '●'),
          React.createElement('span', { className: 'tlmemory-status-text' }, statusText),
        ),
        health === 'offline'
          ? React.createElement('button', { type: 'button', className: 'tlmemory-retry', onClick: retry }, '重试')
          : null,
      ),
    ),
    React.createElement(
      'div',
      { className: 'tlmemory-body' },
      // 透明底：iframe 自身不铺底色（透明属性在 effect 里经 ref 落到真实元素上，
      // 不依赖 React 对不同版本的遗留属性白名单），宿主背景得以穿透到看板之下。
      React.createElement('iframe', {
        key: reloadNonce,
        ref: frameRef,
        className: 'tlmemory-frame',
        src: dashboardUrl(DASHBOARD_ORIGIN),
        title: DASHBOARD_LABEL,
        onLoad: () => {
          setFrameLoaded(true)
        },
      }),
      overlay,
    ),
  )
}

/**
 * 装配客户端半边：注入样式表 + 挂载侧栏入口行与中心面板。
 *
 * 失败策略与家族插件一致：DOM 挂载问题只记日志、绝不抛出 ——
 * 客户端插件 apply 抛错会把整个 web boot 拖垮，外部插件不允许造成这种后果。
 * @param ctx - 客户端根上下文
 */
export function apply(ctx: Context): void {
  if (typeof document === 'undefined') return

  // DOM 级幂等：入口行或面板容器已存在（重复 apply / HMR 重注入 / 残留的旧
  // 模块）即直接返回，绝不挂第二份。整页刷新是唯一的终极重置手段。
  if (document.querySelector(ENTRY_SELECTOR) !== null) return
  if (document.querySelector(VIEW_SELECTOR) !== null) return

  const stylesCreated = ensureClientStyles()
  const state = createPanelState(false)
  const disposers: Array<() => void> = []

  try {
    disposers.push(
      mountSidebarEntry({
        rowAttribute: ENTRY_ATTRIBUTE,
        rowSelector: ENTRY_SELECTOR,
        plugin: PLUGIN_ID,
        icon: ENTRY_ICON,
        label: () => DASHBOARD_LABEL,
        tooltip: () => DASHBOARD_LABEL,
        position: 'after',
        familySelectors: SIDEBAR_FAMILY_SELECTORS,
        state,
        onToggle: () => {
          state.toggle()
        },
      }),
    )
    disposers.push(
      mountCenterPanel({
        state,
        plugin: PANEL_NAME,
        viewDatasetKey: VIEW_DATASET_KEY,
        mount: (container) => {
          const root = createRoot(container)
          root.render(React.createElement(MemoryDashboardPanel, { state }))
          return () => {
            root.unmount()
          }
        },
      }),
    )
  } catch (error) {
    // DOM 失败只降级本插件的界面，绝不牵连 GUI。
    console.warn('[tlmemory] 客户端界面挂载失败：', error)
  }

  ctx.effect(
    () => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // 单个卸载失败不阻断其余回收。
        }
      }
      // 仅当本纤程是样式表的创建者时才移除（重复 apply 时后到者不拥有它）。
      if (stylesCreated) removeClientStyles()
    },
    'tlmemory: client mounts',
  )
}
