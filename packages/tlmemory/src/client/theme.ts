// packages/tlmemory/src/client/theme.ts
// 宿主配色模式的读数与订阅（主题桥的宿主半边）。
//
// 看板运行在跨源 iframe 内，宿主切换 light / dark 不会自动传播过去，必须由本
// 模块把宿主的当前配色读出来，经 postMessage 推给看板（推送时序见 index.tsx）。
//
// 读数优先级（与宿主 dsh-client-ui-theme boot 脚本的真实语义对齐）：
//   1. body / html 上的 data-ds-dark-theme —— 宿主深色主题的权威标记位；
//   2. body / html 上的 data-ds-light-theme —— 显式浅色标记位（当前宿主不写，留作兼容）；
//   3. body / html 上的 data-theme / data-dsw-theme 文本值（light / dark）；
//   4. body / html 的**内联 color-scheme** —— boot 脚本把最终判定写在这里，
//      浅色态唯一显式信号（浅色 = 不落任何 data 标记）；
//   5. body / html 的 class 令牌（dark / light）—— class 形态的主题标记；
//   6. 五者皆无（宿主未声明主题）回落 matchMedia('(prefers-color-scheme: dark)')。
//
// 订阅用 MutationObserver 精确盯住 documentElement 与 body 的主题相关属性，
// 外加媒体查询变化监听（覆盖「未声明主题、跟随系统」的情形）。

import {
  DARK_THEME_ATTRIBUTE,
  LIGHT_THEME_ATTRIBUTE,
  THEME_CLASS_DARK,
  THEME_CLASS_LIGHT,
  THEME_MEDIA_QUERY,
  THEME_VALUE_ATTRIBUTES,
  THEME_WATCH_ATTRIBUTES,
  type ThemeMode,
} from './logic.js'

/** 观察属性过滤集（MutationObserver 的 attributeFilter 不接受只读数组） */
const OBSERVED_ATTRIBUTES: string[] = [...THEME_WATCH_ATTRIBUTES]

/** 第 1~2 层：显式 data 标记（深色权威位 / 显式浅色位） */
function modeFromThemeAttributes(element: Element): ThemeMode | undefined {
  if (element.hasAttribute(DARK_THEME_ATTRIBUTE)) return 'dark'
  if (element.hasAttribute(LIGHT_THEME_ATTRIBUTE)) return 'light'
  return undefined
}

/** 第 3 层：取值型 data 属性（data-theme / data-dsw-theme = light / dark） */
function modeFromThemeValueAttributes(element: Element): ThemeMode | undefined {
  for (const name of THEME_VALUE_ATTRIBUTES) {
    const value = element.getAttribute(name)
    if (value === 'dark' || value === 'light') return value
  }
  return undefined
}

/**
 * 第 4 层：内联 color-scheme。
 *
 * 至关重要：宿主 boot 主题脚本（dsh-client-ui-theme）的实际语义是「浅色 = 不落
 * 任何 data 标记」，只把最终判定写进 documentElement.style.colorScheme
 * （'dark' | 'light'）。若跳过这一层，浅色宿主会被 matchMedia 兜底误判成
 * 「跟随操作系统」——OS 深色而宿主页面渲染浅色时（boot 一次性结算后 OS 再切换，
 * 宿主页面不会跟着变），桥就会推错主题，看板表现为浅色底上浮一层幽灵般的浅色文字。
 * 只读内联值不读 computed —— computed 会解析出 UA 默认值，毫无判别力。
 */
function modeFromInlineColorScheme(element: Element): ThemeMode | undefined {
  if (!(element instanceof HTMLElement) || element.style === undefined) return undefined
  const inlineScheme = element.style.colorScheme
  if (inlineScheme === 'dark') return 'dark'
  if (inlineScheme === 'light') return 'light'
  return undefined
}

/** 第 5 层：class 令牌（body.dark / html.light）。严禁子串匹配（会误伤 dark-mode 等类名）。 */
function modeFromClassTokens(element: Element): ThemeMode | undefined {
  try {
    if (element.classList.contains(THEME_CLASS_DARK)) return 'dark'
    if (element.classList.contains(THEME_CLASS_LIGHT)) return 'light'
  } catch {
    // classList 不可用（极端环境）：跳过该层判定。
  }
  return undefined
}

/**
 * 读出宿主当前配色模式。
 *
 * 分层跨元素判定：机器写入的显式信号（data 属性 → 取值型属性 → 内联
 * color-scheme）在 body 与 html 两个元素上都先于 class 令牌；同一层内 body
 * 优先于 html（宿主把权威位落在 body 上）。全部无标记才回落系统配色。
 * @param doc - 宿主文档（单测可注入）
 */
export function detectThemeMode(doc: Document): ThemeMode {
  const elements: Array<Element | null> = [doc.body, doc.documentElement]
  const layers: Array<(element: Element) => ThemeMode | undefined> = [
    modeFromThemeAttributes,
    modeFromThemeValueAttributes,
    modeFromInlineColorScheme,
    modeFromClassTokens,
  ]
  for (const layer of layers) {
    for (const element of elements) {
      if (element === null) continue
      const mode = layer(element)
      if (mode !== undefined) return mode
    }
  }
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
