// packages/tlmemory/web/src/theme.ts
// 看板侧的宿主主题接收端（主题桥的 iframe 半边）+ 本地主题偏好。
//
// 看板运行在宿主中心列的跨源 iframe 内（宿主可能是 file:// / app:// 等本地源，
// 看板固定 http://127.0.0.1:4890），两边的文档、CSS 变量与 <html> 属性完全隔离。
// 因此配色来源与优先级：
//   1. 本地主题偏好（顶栏主题按钮，localStorage 持久化）：light / dark 强制生效，
//      **不依赖宿主页面** —— 旧版宿主页面（未加载新 client.js）推错主题时，
//      手动强制是唯一可靠的出口；
//   2. 「跟随宿主」（auto，默认）：以宿主经 postMessage 推送的模式为准。两种
//      消息形态都收：规范 { type: 'dsh-theme-change', theme } 与旧
//      { type: 'dsh-tlmemory:theme', mode }（兼容周期）；
//   3. 宿主缺席（浏览器单独打开 / 旧宿主从未推送）时回落系统配色。
//
// 收到模式后把状态写到 <html> 上：data-theme 属性（style.css 令牌层的主开关）+
// dark / light 响应式 class（等价的 class 形态钩子）。其余全部交给 style.css 的
// 令牌层 —— 组件里不出现任何写死的颜色。

/** 配色模式（与宿主侧 ThemeMode 对齐） */
export type ThemeMode = 'light' | 'dark'

/** 主题偏好：跟随宿主（auto，默认）/ 强制浅色 / 强制深色 */
export type ThemePreference = 'auto' | ThemeMode

/** 宿主 → 看板：规范主题推送消息类型 */
export const THEME_CHANGE_MESSAGE_TYPE = 'dsh-theme-change'

/** 宿主 → 看板：旧主题推送消息类型（兼容周期） */
export const THEME_MESSAGE_TYPE = 'dsh-tlmemory:theme'

/** 看板 → 宿主：就绪握手消息类型 */
export const READY_MESSAGE_TYPE = 'dsh-tlmemory:ready'

/** 偏好持久化键（看板源自己的 localStorage） */
const PREF_STORAGE_KEY = 'tlmemory:theme-preference'

/** 宿主最近一次推送的模式（auto 模式的权威来源）；undefined = 尚未收到推送 */
let hostMode: ThemeMode | undefined

/** 当前偏好（模块加载时从 localStorage 恢复） */
let preference: ThemePreference = loadThemePreference()

/** 从 localStorage 恢复偏好；损坏 / 缺失一律回 auto */
function loadThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage?.getItem(PREF_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored
  } catch {
    // 隐私模式 / 存储被禁：保持 auto。
  }
  return 'auto'
}

/** 系统配色（宿主缺席时的回落依据） */
function systemMode(): ThemeMode {
  try {
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches === true) return 'dark'
  } catch {
    // matchMedia 不可用：按浅色。
  }
  return 'light'
}

/** 按偏好解析当前生效模式 */
function resolveMode(): ThemeMode {
  if (preference === 'auto') return hostMode ?? systemMode()
  return preference
}

/** 按当前偏好解析并落到文档根节点 */
function apply(): void {
  applyThemeMode(resolveMode())
}

/**
 * 把配色模式落到文档根节点。
 *
 * 同时落两种钩子：`data-theme` 属性与 dark / light class。令牌层以 data-theme
 * 为准；class 只是等价的响应式标记，不承载配色职责。
 *
 * 刻意**不写** `documentElement.style.colorScheme`：按 CSS Color Adjust 规范，
 * 根元素背景为 transparent 时画布会用所用色彩方案的基础色填充，一旦在 :root 上
 * 声明 color-scheme: dark，iframe 画布就被涂成不透明深色，宿主的主题背景再也透
 * 不上来。滚动条 / 表单控件的配色改由 style.css 在具体元素上声明 color-scheme。
 */
export function applyThemeMode(mode: ThemeMode): void {
  const root = document.documentElement
  root.dataset.theme = mode
  root.classList.toggle('dark', mode === 'dark')
  root.classList.toggle('light', mode === 'light')
}

/** 当前生效的配色模式（偏好 + 宿主推送 + 系统回落的综合结果） */
export function currentThemeMode(): ThemeMode {
  return resolveMode()
}

/** 读取本地主题偏好 */
export function getThemePreference(): ThemePreference {
  return preference
}

/**
 * 设置本地主题偏好并立即生效、持久化。
 * @param next - auto（跟随宿主）/ light（强制浅色）/ dark（强制深色）
 */
export function setThemePreference(next: ThemePreference): void {
  preference = next
  try {
    window.localStorage?.setItem(PREF_STORAGE_KEY, next)
  } catch {
    // 存储不可用：仅本次会话生效。
  }
  apply()
}

/**
 * 从主题消息负载里解析出配色模式（两种协议形态都认，其余一律拒绝）。
 * @param data - message 事件负载
 */
export function parseThemeMessage(data: unknown): ThemeMode | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const payload = data as { type?: unknown; theme?: unknown; mode?: unknown }
  if (payload.type === THEME_CHANGE_MESSAGE_TYPE) {
    if (payload.theme === 'light' || payload.theme === 'dark') return payload.theme
    return undefined
  }
  if (payload.type === THEME_MESSAGE_TYPE) {
    if (payload.mode === 'light' || payload.mode === 'dark') return payload.mode
    return undefined
  }
  return undefined
}

/**
 * 建立主题桥：监听宿主推送、主动握手一次，并按当前偏好立即落一次主题。
 *
 * 为什么需要握手：iframe 的 src 先加载、React 面板后挂载，宿主的首次推送可能早于
 * 本文档注册监听；握手让宿主在收到 ready 后补推一次，两端都不必猜测时序。
 * @returns 卸载监听的 Disposer
 */
export function setupThemeBridge(): () => void {
  const onMessage = (event: MessageEvent): void => {
    const mode = parseThemeMessage(event.data)
    if (mode === undefined) return
    hostMode = mode
    // 手动偏好优先：宿主推送只记录，不覆盖用户的强制选择。
    if (preference === 'auto') apply()
  }

  window.addEventListener('message', onMessage)

  // 独立打开时 window.parent === window，这条握手只会回到自己（类型不匹配即被忽略），
  // 因此无需判断是否处于 iframe 中。
  try {
    window.parent.postMessage({ type: READY_MESSAGE_TYPE }, '*')
  } catch {
    // 宿主缺席 / 被策略拦截：保持系统配色即可，绝不让看板在这里挂掉。
  }

  apply()

  return () => {
    window.removeEventListener('message', onMessage)
  }
}
