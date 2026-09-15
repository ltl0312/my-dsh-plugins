// packages/tlmemory/src/client/theme.ts
// 宿主配色模式的读数与订阅（主题桥的宿主半边）。
//
// 看板运行在跨源 iframe 内，宿主切换 light / dark 不会自动传播过去，必须由本
// 模块把宿主的当前配色读出来，经 postMessage 推给看板（推送时序见 index.tsx）。
//
// 读数优先级（与宿主内家族插件 @linxin666/dsh-client-ui-skin-center 的判定一致）：
//   1. body / html 上的 data-ds-dark-theme —— 宿主深色主题的权威标记位；
//   2. body / html 上的 data-ds-light-theme —— 宿主显式浅色标记位；
//   3. body / html 上的 data-theme / data-dsw-theme 文本值（light / dark）；
//   4. 三者皆无（宿主未声明主题）回落 matchMedia('(prefers-color-scheme: dark)')。
//
// 订阅用 MutationObserver 精确盯住 documentElement 与 body 的主题相关属性，
// 外加媒体查询变化监听（覆盖「未声明主题、跟随系统」的情形）。

import {
  DARK_THEME_ATTRIBUTE,
  LIGHT_THEME_ATTRIBUTE,
  THEME_MEDIA_QUERY,
  THEME_VALUE_ATTRIBUTES,
  THEME_WATCH_ATTRIBUTES,
  type ThemeMode,
} from './logic.js'

/** 观察属性过滤集（MutationObserver 的 attributeFilter 不接受只读数组） */
const OBSERVED_ATTRIBUTES: string[] = [...THEME_WATCH_ATTRIBUTES]

/** 读取单个元素上的主题标记；无标记返回 undefined */
function modeFromElement(element: Element | null): ThemeMode | undefined {
  if (element === null) return undefined
  if (element.hasAttribute(DARK_THEME_ATTRIBUTE)) return 'dark'
  if (element.hasAttribute(LIGHT_THEME_ATTRIBUTE)) return 'light'
  for (const name of THEME_VALUE_ATTRIBUTES) {
    const value = element.getAttribute(name)
    if (value === 'dark' || value === 'light') return value
  }
  return undefined
}

/**
 * 读出宿主当前配色模式。
 * @param doc - 宿主文档（单测可注入）
 */
export function detectThemeMode(doc: Document): ThemeMode {
  const declared = modeFromElement(doc.body) ?? modeFromElement(doc.documentElement)
  if (declared !== undefined) return declared
  // 宿主未声明主题：跟随系统配色（jsdom 未实现 matchMedia，需逐层容错）。
  const query = doc.defaultView?.matchMedia?.(THEME_MEDIA_QUERY)
  return query?.matches === true ? 'dark' : 'light'
}

/**
 * 订阅宿主配色变化：仅在读数真正改变时回调一次（属性抖动不重复通知）。
 * @param doc - 宿主文档
 * @param listener - 新模式回调
 * @returns 取消订阅的 Disposer
 */
export function watchThemeMode(doc: Document, listener: (mode: ThemeMode) => void): () => void {
  let current = detectThemeMode(doc)

  const sync = (): void => {
    const next = detectThemeMode(doc)
    if (next === current) return
    current = next
    try {
      listener(next)
    } catch {
      // 订阅者异常不得打断观察链。
    }
  }

  // 主题属性只落在 documentElement / body 上，因此按元素精确观察而非整树 subtree
  // （深度观察会让每一次 hover 类名变化都触发读数）。
  const observer = new MutationObserver(sync)
  const targets: Element[] = [doc.documentElement]
  if (doc.body !== null) targets.push(doc.body)
  for (const target of targets) {
    observer.observe(target, { attributes: true, attributeFilter: OBSERVED_ATTRIBUTES })
  }

  // 「未声明主题 → 跟随系统」时需要媒体查询兜底；旧内核只支持 addListener。
  const query = doc.defaultView?.matchMedia?.(THEME_MEDIA_QUERY)
  const media = query as (MediaQueryList & { addListener?: (fn: () => void) => void }) | undefined
  if (media?.addEventListener !== undefined) media.addEventListener('change', sync)
  else media?.addListener?.(sync)

  return () => {
    observer.disconnect()
    if (media?.removeEventListener !== undefined) media.removeEventListener('change', sync)
    else media?.removeListener?.(sync)
  }
}
