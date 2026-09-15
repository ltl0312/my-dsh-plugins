// packages/tlmemory/web/src/theme.ts
// 看板侧的宿主主题接收端。
//
// 看板运行在宿主中心列的跨源 iframe 内（宿主可能是 file:// / app:// 等本地源，
// 看板固定 http://127.0.0.1:4890），两边的文档、CSS 变量与 <html> 属性完全隔离。
// 因此配色只有两条来源：
//   1. 宿主经 postMessage 推送的 { type: 'dsh-tlmemory:theme', mode }（权威）；
//   2. 宿主缺席（在浏览器里单独打开看板）时用系统配色（index.html 里已预设）。
//
// 收到模式后只做一件事：把 data-theme 写到 <html> 上。其余全部交给 style.css 的
// 令牌层 —— 组件里不出现任何写死的颜色。

/** 配色模式（与宿主侧 ThemeMode 对齐） */
export type ThemeMode = 'light' | 'dark'

/** 宿主 → 看板：主题推送消息类型 */
export const THEME_MESSAGE_TYPE = 'dsh-tlmemory:theme'

/** 看板 → 宿主：就绪握手消息类型 */
export const READY_MESSAGE_TYPE = 'dsh-tlmemory:ready'

/**
 * 把配色模式落到文档根节点（data-theme 驱动 style.css 的令牌层）。
 *
 * 刻意**不写** `documentElement.style.colorScheme`：按 CSS Color Adjust 规范，
 * 根元素背景为 transparent 时画布会用所用色彩方案的基础色填充，一旦在 :root 上
 * 声明 color-scheme: dark，iframe 画布就被涂成不透明深色，宿主的主题背景再也透
 * 不上来。滚动条 / 表单控件的配色改由 style.css 在具体元素上声明 color-scheme。
 */
export function applyThemeMode(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode
}

/**
 * 建立主题桥：监听宿主推送并主动握手一次。
 *
 * 为什么需要握手：iframe 的 src 先加载、React 面板后挂载，宿主的首次推送可能早于
 * 本文档注册监听；握手让宿主在收到 ready 后补推一次，两端都不必猜测时序。
 * @returns 卸载监听的 Disposer
 */
export function setupThemeBridge(): () => void {
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown; mode?: unknown } | null | undefined
    if (data === null || data === undefined || typeof data !== 'object') return
    if (data.type !== THEME_MESSAGE_TYPE) return
    if (data.mode !== 'light' && data.mode !== 'dark') return
    applyThemeMode(data.mode)
  }

  window.addEventListener('message', onMessage)

  // 独立打开时 window.parent === window，这条握手只会回到自己（类型不匹配即被忽略），
  // 因此无需判断是否处于 iframe 中。
  try {
    window.parent.postMessage({ type: READY_MESSAGE_TYPE }, '*')
  } catch {
    // 宿主缺席 / 被策略拦截：保持系统配色即可，绝不让看板在这里挂掉。
  }

  return () => {
    window.removeEventListener('message', onMessage)
  }
}
