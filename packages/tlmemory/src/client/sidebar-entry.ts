// packages/tlmemory/src/client/sidebar-entry.ts
// 侧栏顶部入口行（全局一级导航席位）。
//
// 宿主 sidebar shell 的插槽表里没有「顶部导航入口」这一项（只有 brand /
// workspaces / settings / footer.action），因此家族插件（任务看板 / SSH /
// 技能中心）统一把入口行以纯 DOM 注入到 shell 的 New Session 行之后，
// 与工作区分隔；本模块沿用同一做法与同一自愈策略：
//   * 纯 DOM、不进 React 树 → 不可能干扰 shell 的 reconciliation；
//   * MutationObserver 自愈 → React 重渲染顶掉入口时同帧插回（绘制前，无闪烁）；
//   * 家族块相对定位 → 兄弟插件（任务看板 / SSH / 技能中心）无论重排顺序如何，
//     各入口的最终次序都稳定；
//   * DOM 级幂等 → 重复 apply / HMR 重注入绝不产生第二份入口。

import {
  SIDEBAR_FAMILY_SELECTORS,
  type PanelState,
} from './logic.js'

/** 入口行的图标：外壳导航图标的同族 16px 描边风格（数据库 / 记忆柱体） */
export const ENTRY_ICON =
  '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<ellipse cx="8" cy="3.9" rx="5.2" ry="2.15"/>' +
  '<path d="M2.8 3.9v8.2c0 1.19 2.33 2.15 5.2 2.15s5.2-0.96 5.2-2.15V3.9"/>' +
  '<path d="M2.8 8c0 1.19 2.33 2.15 5.2 2.15s5.2-0.96 5.2-2.15"/>' +
  '</svg>'

/** 侧栏列选择器（0.1.0-rc.6+ 用 sidebarCol，旧 shell 用 data-pane） */
const SIDEBAR_COLUMN_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"]'

/** 入口行的三个样式钩子（与注入样式表、家族插件的类名语义一一对应） */
export const ENTRY_PART_ATTRIBUTES = {
  icon: 'data-dsh-tlmemory-icon',
  label: 'data-dsh-tlmemory-label',
} as const

/**
 * P2-10 灾难性重建的兜底巡查间隔：
 * 放置成功后 body 级整树观察降级为侧栏父级的窄范围观察（长会话里宿主每次
 * hover / 流式输出都不再触发回调）；若整个外壳面板被替换导致窄观察目标脱离
 * 文档（不再产生突变事件），由这条低频定时器发现并重新拉起 body 级观察。
 */
const RECHECK_INTERVAL_MS = 2000

/** 挂载侧栏入口行所需的外部面 */
export interface SidebarEntryOptions {
  /** 幂等键与样式作用域属性名，如 `data-dsh-tlmemory-entry` */
  rowAttribute: string
  /** 命中入口行的选择器，如 `[data-dsh-tlmemory-entry]` */
  rowSelector: string
  /** L2 语义属性取值 */
  plugin: string
  /** 内联图标标记 */
  icon: string
  /** 入口文案（aria-label + 可见文本 + 默认 title） */
  label(): string
  /** 可选 tooltip 文案 */
  tooltip?(): string
  /** 点击动作（开合中心面板） */
  onToggle(): void
  /** 家族块的插位：'before' 插在家族块之前，'after' 插在家族块之后 */
  position: 'before' | 'after'
  /** 参与排序的兄弟插件入口行选择器 */
  familySelectors: readonly string[]
  /** 面板打开状态源：用于高亮当前入口 */
  state: PanelState
  /** 文档对象（默认取全局 document，单测可注入） */
  doc?: Document
}

/** 取得 shell 的侧栏 UI 根元素；未挂载时返回 undefined */
export function sidebarRoot(doc: Document): HTMLElement | undefined {
  const column = doc.querySelector<HTMLElement>(SIDEBAR_COLUMN_SELECTOR)
  if (column === null) return undefined
  // 现行 shell 的结构是 column > wrapper > root（logoRow 的持有者）。
  // 优先取 logoRow 的父元素——那才是真正的侧栏 UI 根；旧 shell 退化为首个子元素。
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** New Session 按钮：现行 shell 嵌在 logoRow 内，旧 shell 是根元素的直接子按钮 */
export function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of Array.from(root.children)) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** 计算入口行的插入锚点（family 为空时退回到 New Session 行之后） */
export function resolveEntryAnchor(
  root: HTMLElement,
  button: HTMLButtonElement,
  options: Pick<SidebarEntryOptions, 'familySelectors' | 'position'>,
): Element | null {
  const row = button.closest('[class*="logoRow"]')
  const base = row !== null && row.parentElement === root ? row : button
  const family = Array.from(root.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.matches(options.familySelectors.join(', ')),
  )
  if (family.length === 0) return base.nextElementSibling
  return options.position === 'before'
    ? family[0]!
    : family[family.length - 1]!.nextElementSibling
}

/** 创建入口行元素（游离状态，待 shell 就绪后插入） */
function createEntry(options: SidebarEntryOptions): HTMLButtonElement {
  const doc = options.doc ?? document
  const entry = doc.createElement('button')
  entry.type = 'button'
  entry.setAttribute(options.rowAttribute, '')
  entry.setAttribute('data-dsh-plugin', options.plugin)
  entry.setAttribute('data-dsh-part', 'sidebar-entry')

  const iconSpan = doc.createElement('span')
  iconSpan.setAttribute(ENTRY_PART_ATTRIBUTES.icon, '')
  iconSpan.innerHTML = options.icon
  const labelSpan = doc.createElement('span')
  labelSpan.setAttribute(ENTRY_PART_ATTRIBUTES.label, '')

  entry.append(iconSpan, labelSpan)
  const applyLabel = (): void => {
    const label = options.label()
    entry.setAttribute('aria-label', label)
    entry.setAttribute('title', options.tooltip === undefined ? label : options.tooltip())
    labelSpan.textContent = label
  }
  applyLabel()
  entry.addEventListener('click', () => {
    options.onToggle()
  })
  return entry
}

/** 把入口行插到家族块位置；侧栏尚未渲染出 New Session 行时返回 false */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement, options: SidebarEntryOptions): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    root.insertBefore(entry, resolveEntryAnchor(root, button, options))
  }
  return true
}

/**
 * 挂载侧栏入口行：等待 shell 渲染，并在后续 React 重渲染顶掉入口时自愈。
 * @param options - 入口的属性 / 图标 / 文案 / 动作 / 排序配置
 * @returns 卸载入口与全部观察者的 Disposer
 */
export function mountSidebarEntry(options: SidebarEntryOptions): () => void {
  const doc = options.doc ?? document
  // 幂等：无论哪条路径先挂过（重复 apply / HMR 重注入 / 未卸载的旧模块），
  // 都绝不再挂第二份；整页刷新是唯一的终极重置手段。
  if (doc.querySelector(options.rowSelector) !== null) return () => {}

  const entry = createEntry(options)
  let root: HTMLElement | undefined
  let placed = false

  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) placed = placeEntry(root, entry, options)
  })

  // P2-10：观察目标可在「body 级兜底」与「侧栏父级窄范围」之间切换。
  // 同一观察者实例重新 observe，避免多实例叠加。
  let observeTarget: Node | undefined
  const armWaitObserver = (target: Node): void => {
    if (observeTarget === target) return
    observeTarget = target
    waitObserver.disconnect()
    waitObserver.observe(target, { childList: true, subtree: true })
  }
  const armBodyWaitObserver = (): void => {
    armWaitObserver(doc.body ?? doc.documentElement)
  }

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      // shell 整个重建了侧栏面板：根观察者已随旧树消失，重置后重新查询。
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      // 廉价短路：入口仍挂在文档里即无需重新查询。
      if (entry.isConnected) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot(doc)
    if (root === undefined) {
      // 放置失败阶段：保持 body 级观察等待外壳渲染
      armBodyWaitObserver()
      return
    }
    placed = placeEntry(root, entry, options)
    if (placed) {
      rootObserver.observe(root, { childList: true, subtree: true })
      // P2-10：放置成功后把兜底观察降级为侧栏父级的窄范围，
      // 只有入口被顶掉 / 侧栏局部重排时才会触发回调
      armWaitObserver(root.parentElement ?? doc.body ?? doc.documentElement)
    }
  }

  // body 级观察者作为「整树重建」兜底：只有它能发现新的侧栏面板挂载。
  // 极早期 boot 阶段 body 可能尚未建立，退回观察 documentElement（body 也在其内）。
  const waitObserver = new MutationObserver(() => {
    tryPlace()
  })
  armBodyWaitObserver()

  // P2-10：窄观察目标整棵脱离文档时不再产生突变事件（灾难性整树重建），
  // 低频巡查发现入口失联后重新拉起 body 级观察并尝试重放置
  const recheckTimer = setInterval(() => {
    if (entry.isConnected) return
    armBodyWaitObserver()
    tryPlace()
  }, RECHECK_INTERVAL_MS)

  // 反映面板打开状态（当前入口高亮）。注意：给 dataset.active 赋 undefined 会
  // 写出 data-active="undefined" 造成永久高亮，必须用 removeAttribute。
  const syncActive = (): void => {
    if (options.state.isOpen()) entry.setAttribute('data-active', '')
    else entry.removeAttribute('data-active')
  }
  const unsubscribeActive = options.state.subscribe(syncActive)
  syncActive()

  tryPlace()

  return () => {
    clearInterval(recheckTimer)
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribeActive()
    entry.remove()
  }
}

/** 便捷构造：本插件的侧栏入口配置常量 */
export const TL_MEMORY_ENTRY_FAMILY = SIDEBAR_FAMILY_SELECTORS
