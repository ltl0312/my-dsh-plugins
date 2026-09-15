// @vitest-environment jsdom
// packages/tlmemory/tests/client-dom.spec.ts
// 客户端插件的 DOM 注入层测试（真实 jsdom）：侧栏入口行的注入 / 排序 / 自愈 /
// 幂等 / 高亮与卸载，以及中心列面板容器的注入 / 单占协调（<html> 标记、
// 广播让步、会话行点击收拢）/ 整树重建重挂 / 卸载还原。样式表注入单独校验。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ACTIVE_ATTRIBUTE,
  PANEL_ACTIVATE_EVENT,
  PLUGIN_ID,
  SIBLING_ACTIVE_ATTRIBUTES,
  createPanelState,
} from '../src/client/logic.js'
import { ENTRY_ICON, mountSidebarEntry, newSessionButton, sidebarRoot } from '../src/client/sidebar-entry.js'
import { conversationColumn, mountCenterPanel } from '../src/client/panel-mount.js'
import { CLIENT_CSS, STYLE_SELECTOR, ensureClientStyles, removeClientStyles } from '../src/client/styles.js'

const ENTRY_ATTRIBUTE = 'data-dsh-tlmemory-entry'
const ENTRY_SELECTOR = `[${ENTRY_ATTRIBUTE}]`
const VIEW_ATTRIBUTE = 'data-dsh-tlmemory-view'
const VIEW_SELECTOR = `[${VIEW_ATTRIBUTE}]`

/** 让 MutationObserver 的微任务回调结算 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 构造一个贴近真实 shell 的侧栏骨架（可选带上家族插件的既有入口行） */
function buildSidebar(options: { family?: boolean } = {}): HTMLElement {
  const family = options.family === true
    ? '<button type="button" data-dsh-taskboard-entry></button>' +
      '<button type="button" data-dsh-ssh-entry></button>' +
      '<button type="button" data-dsh-skill-explorer-entry></button>'
    : ''
  document.body.innerHTML =
    '<div data-pane="sidebar">' +
    '<div class="wrap">' +
    '<div class="hHd-Xa_root">' +
    '<div class="hHd-Xa_logoRow"><span>brand</span></div>' +
    '<button type="button" class="hHd-Xa_newSession">新会话</button>' +
    family +
    '<div class="hHd-Xa_regionArea"></div>' +
    '<div class="hHd-Xa_footArea"></div>' +
    '</div>' +
    '</div>' +
    '</div>'
  return document.querySelector<HTMLElement>('.hHd-Xa_root')!
}

/** 构造中心列骨架（会话子树 + 输入区） */
function buildCenterColumn(): HTMLElement {
  document.body.innerHTML =
    '<div class="appFrame">' +
    '<div class="wSkVaW_root" data-pane="conversation">' +
    '<div data-slot="conversation.session" style="display: contents">' +
    '<div class="wSkVaW_viewArea">chat</div>' +
    '</div>' +
    '<div class="wSkVaW_composerSeat">composer</div>' +
    '</div>' +
    '</div>'
  return document.querySelector<HTMLElement>('[data-pane="conversation"]')!
}

/** 入口挂载的默认配置 */
function entryOptions(state = createPanelState(), onToggle = vi.fn()) {
  return {
    rowAttribute: ENTRY_ATTRIBUTE,
    rowSelector: ENTRY_SELECTOR,
    plugin: PLUGIN_ID,
    icon: ENTRY_ICON,
    label: () => '记忆看板',
    tooltip: () => '记忆看板',
    position: 'after' as const,
    familySelectors: [
      '[data-dsh-taskboard-entry]',
      '[data-dsh-ssh-entry]',
      '[data-dsh-skill-explorer-entry]',
      ENTRY_SELECTOR,
    ],
    state,
    onToggle,
    doc: document,
  }
}

/** 已挂载资源的清理队列 */
const disposers: Array<() => void> = []

function track(dispose: () => void): void {
  disposers.push(dispose)
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(ACTIVE_ATTRIBUTE)
  for (const attribute of SIBLING_ACTIVE_ATTRIBUTES) document.documentElement.removeAttribute(attribute)
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  removeClientStyles(document)
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(ACTIVE_ATTRIBUTE)
})

describe('侧栏入口行注入', () => {
  it('无家族入口时插在 New Session 行与工作区之间', () => {
    const root = buildSidebar()
    track(mountSidebarEntry(entryOptions()))

    const entry = root.querySelector<HTMLElement>(ENTRY_SELECTOR)
    expect(entry).not.toBeNull()
    const order = Array.from(root.children)
    expect(order.indexOf(entry!)).toBe(order.indexOf(newSessionButton(root)!) + 1)
    expect(order.indexOf(entry!)).toBeLessThan(order.indexOf(root.querySelector('.hHd-Xa_regionArea')!))
  })

  it('有家族入口时插到家族块末尾（任务看板 / SSH / 技能中心之后）', () => {
    const root = buildSidebar({ family: true })
    track(mountSidebarEntry(entryOptions()))

    const children = Array.from(root.children)
    const entryIndex = children.findIndex((el) => el.hasAttribute(ENTRY_ATTRIBUTE))
    const skillIndex = children.findIndex((el) => el.hasAttribute('data-dsh-skill-explorer-entry'))
    expect(entryIndex).toBe(skillIndex + 1)
    // 家族次序稳定：任务看板 → SSH → 技能中心 → 记忆看板
    expect(children.findIndex((el) => el.hasAttribute('data-dsh-taskboard-entry'))).toBeLessThan(
      children.findIndex((el) => el.hasAttribute('data-dsh-ssh-entry')),
    )
    expect(children.findIndex((el) => el.hasAttribute('data-dsh-ssh-entry'))).toBeLessThan(skillIndex)
    // 仍落在工作区之前
    expect(entryIndex).toBeLessThan(children.findIndex((el) => el.classList.contains('hHd-Xa_regionArea')))
  })

  it('入口携带语义属性、图标与文案，点击回调开合面板', () => {
    const root = buildSidebar()
    const onToggle = vi.fn()
    track(mountSidebarEntry(entryOptions(createPanelState(), onToggle)))

    const entry = root.querySelector<HTMLButtonElement>(ENTRY_SELECTOR)!
    expect(entry.tagName).toBe('BUTTON')
    expect(entry.getAttribute('data-dsh-plugin')).toBe('tlmemory')
    expect(entry.getAttribute('data-dsh-part')).toBe('sidebar-entry')
    expect(entry.getAttribute('aria-label')).toBe('记忆看板')
    expect(entry.getAttribute('title')).toBe('记忆看板')
    expect(entry.querySelector('[data-dsh-tlmemory-icon] svg')).not.toBeNull()
    expect(entry.querySelector('[data-dsh-tlmemory-label]')?.textContent).toBe('记忆看板')

    entry.click()
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('面板打开时高亮当前入口，关闭时移除标记', () => {
    const root = buildSidebar()
    const state = createPanelState()
    track(mountSidebarEntry(entryOptions(state)))
    const entry = root.querySelector<HTMLElement>(ENTRY_SELECTOR)!

    expect(entry.hasAttribute('data-active')).toBe(false)
    state.setOpen(true)
    expect(entry.getAttribute('data-active')).toBe('')
    state.setOpen(false)
    expect(entry.hasAttribute('data-active')).toBe(false)
  })

  it('入口被 React 重渲染顶掉后同帧自愈（MutationObserver）', async () => {
    const root = buildSidebar()
    track(mountSidebarEntry(entryOptions()))
    const entry = root.querySelector<HTMLElement>(ENTRY_SELECTOR)!

    entry.remove()
    expect(root.querySelector(ENTRY_SELECTOR)).toBeNull()
    await flush()
    expect(root.querySelector(ENTRY_SELECTOR)).toBe(entry)
  })

  it('侧栏晚于 apply 渲染时等待并落位', async () => {
    document.body.innerHTML = ''
    track(mountSidebarEntry(entryOptions()))
    expect(document.querySelector(ENTRY_SELECTOR)).toBeNull()

    buildSidebar()
    await flush()
    expect(document.querySelector(ENTRY_SELECTOR)).not.toBeNull()
  })

  it('DOM 级幂等：已存在入口行时不再挂第二份，且返回空 Disposer', () => {
    const root = buildSidebar()
    track(mountSidebarEntry(entryOptions()))
    const before = root.querySelectorAll(ENTRY_SELECTOR).length

    const noop = mountSidebarEntry(entryOptions())
    expect(root.querySelectorAll(ENTRY_SELECTOR)).toHaveLength(before)
    expect(noop).toBeTypeOf('function')
    noop()
    expect(root.querySelectorAll(ENTRY_SELECTOR)).toHaveLength(before)
  })

  it('卸载后入口行与观察者一并回收（不再自愈）', async () => {
    const root = buildSidebar()
    const dispose = mountSidebarEntry(entryOptions())
    expect(root.querySelector(ENTRY_SELECTOR)).not.toBeNull()

    dispose()
    expect(root.querySelector(ENTRY_SELECTOR)).toBeNull()

    // 卸载后新的侧栏出现也不应再注入
    buildSidebar()
    await flush()
    expect(document.querySelector(ENTRY_SELECTOR)).toBeNull()
  })

  it('sidebarRoot / newSessionButton 对新旧外壳都能定位', () => {
    buildSidebar()
    const root = sidebarRoot(document)!
    expect(root.classList.contains('hHd-Xa_root')).toBe(true)
    expect(newSessionButton(root)?.textContent).toBe('新会话')
  })
})

describe('中心列面板接管', () => {
  const panelOptions = (state = createPanelState()) => {
    const mountCalls = { count: 0, unmounts: 0 }
    const dispose = mountCenterPanel({
      state,
      plugin: 'tlmemory',
      viewDatasetKey: 'dshTlmemoryView',
      mount: (container) => {
        mountCalls.count += 1
        container.textContent = 'panel'
        return () => {
          mountCalls.unmounts += 1
        }
      },
      doc: document,
    })
    return { state, mountCalls, dispose }
  }

  it('容器作为中心列尾部子节点注入，默认不激活', () => {
    const column = buildCenterColumn()
    const { dispose } = panelOptions()
    track(dispose)

    const container = column.querySelector<HTMLElement>(VIEW_SELECTOR)
    expect(container).not.toBeNull()
    expect(container!.parentElement).toBe(column)
    expect(column.lastElementChild).toBe(container)
    expect(container!.getAttribute('data-dsh-plugin')).toBe('tlmemory')
    expect(document.documentElement.hasAttribute(ACTIVE_ATTRIBUTE)).toBe(false)
  })

  it('打开时置 <html> 标记、清除兄弟占用者并按其语义广播', () => {
    buildCenterColumn()
    const { state, dispose } = panelOptions()
    track(dispose)

    document.documentElement.setAttribute(SIBLING_ACTIVE_ATTRIBUTES[0]!, '')
    const details: unknown[] = []
    const onActivate = (event: Event): void => {
      details.push((event as CustomEvent).detail)
    }
    document.addEventListener(PANEL_ACTIVATE_EVENT, onActivate)

    state.setOpen(true)
    expect(document.documentElement.hasAttribute(ACTIVE_ATTRIBUTE)).toBe(true)
    expect(SIBLING_ACTIVE_ATTRIBUTES.some((a) => document.documentElement.hasAttribute(a))).toBe(false)
    expect(details).toEqual(['taskboard', 'ssh', 'tlmemory'])

    state.setOpen(false)
    expect(document.documentElement.hasAttribute(ACTIVE_ATTRIBUTE)).toBe(false)
    document.removeEventListener(PANEL_ACTIVATE_EVENT, onActivate)
  })

  it('收到兄弟面板广播时主动退场，归还中心列', () => {
    buildCenterColumn()
    const { state, dispose } = panelOptions()
    track(dispose)

    state.setOpen(true)
    document.dispatchEvent(new CustomEvent(PANEL_ACTIVATE_EVENT, { detail: 'ssh' }))
    expect(state.isOpen()).toBe(false)
    expect(document.documentElement.hasAttribute(ACTIVE_ATTRIBUTE)).toBe(false)

    // 自身广播与陌生 detail 不应影响本面板
    state.setOpen(true)
    document.dispatchEvent(new CustomEvent(PANEL_ACTIVATE_EVENT, { detail: 'tlmemory' }))
    expect(state.isOpen()).toBe(true)
  })

  it('点击侧栏会话行即收拢面板（捕获相位）', () => {
    const column = buildCenterColumn()
    const { state, dispose } = panelOptions()
    track(dispose)

    const row = document.createElement('button')
    row.className = 'hHd_sessionRow'
    column.append(row)
    state.setOpen(true)

    row.click()
    expect(state.isOpen()).toBe(false)
  })

  it('中心列被整体重建时重新注入容器并重挂面板树', async () => {
    buildCenterColumn()
    const { mountCalls, dispose } = panelOptions()
    track(dispose)
    expect(mountCalls.count).toBe(1)

    document.querySelector('[data-pane="conversation"]')!.remove()
    await flush()
    buildCenterColumn()
    await flush()

    expect(mountCalls.count).toBe(2)
    expect(mountCalls.unmounts).toBe(1)
    expect(document.querySelectorAll(VIEW_SELECTOR)).toHaveLength(1)
  })

  it('卸载后容器、<html> 标记与监听一并还原', () => {
    buildCenterColumn()
    const { state, dispose } = panelOptions()
    state.setOpen(true)
    dispose()

    expect(document.querySelector(VIEW_SELECTOR)).toBeNull()
    expect(document.documentElement.hasAttribute(ACTIVE_ATTRIBUTE)).toBe(false)

    // 事件监听已摘除：再收广播也不会改动状态（仅断言不抛错且状态不变）
    expect(() => document.dispatchEvent(new CustomEvent(PANEL_ACTIVATE_EVENT, { detail: 'ssh' }))).not.toThrow()
    expect(state.isOpen()).toBe(true)
  })

  it('中心列尚未渲染时不报错，出现后自动接管', async () => {
    document.body.innerHTML = ''
    const { dispose } = panelOptions()
    track(dispose)
    expect(document.querySelector(VIEW_SELECTOR)).toBeNull()

    buildCenterColumn()
    await flush()
    expect(document.querySelector(VIEW_SELECTOR)).not.toBeNull()
  })

  it('conversationColumn 同时识别新外壳与旧外壳', () => {
    buildCenterColumn()
    expect(conversationColumn(document)).toBe(document.querySelector('[data-pane="conversation"]'))

    document.body.innerHTML = '<div class="dshFrame_centerCol">x</div>'
    expect(conversationColumn(document)?.classList.contains('dshFrame_centerCol')).toBe(true)

    document.body.innerHTML = ''
    expect(conversationColumn(document)).toBeUndefined()
  })
})

describe('客户端样式表', () => {
  it('首次注入返回 true，重复注入返回 false（幂等）', () => {
    expect(ensureClientStyles(document)).toBe(true)
    expect(ensureClientStyles(document)).toBe(false)
    expect(document.querySelectorAll(STYLE_SELECTOR)).toHaveLength(1)
  })

  it('样式表带插件归属标记，可被精确移除', () => {
    ensureClientStyles(document)
    const tag = document.querySelector<HTMLStyleElement>(STYLE_SELECTOR)!
    expect(tag.dataset.plugin).toBe('dsh-plugin-tlmemory')
    removeClientStyles(document)
    expect(document.querySelector(STYLE_SELECTOR)).toBeNull()
  })

  it('接管规则：仅在兄弟面板均未激活时显示，并隐藏会话内容', () => {
    ensureClientStyles(document)
    const tag = document.querySelector<HTMLStyleElement>(STYLE_SELECTOR)!
    const css = tag.textContent ?? CLIENT_CSS

    // 容器显隐由 <html> 标记驱动，且要求两个兄弟标记都不存在
    expect(css).toContain(`html[${ACTIVE_ATTRIBUTE}]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [${VIEW_ATTRIBUTE}]`)
    // 激活期间隐藏中心列里除本容器以外的直接子节点
    expect(css).toContain(`> :not([${VIEW_ATTRIBUTE}])`)
    expect(css).toContain('display: none !important')
    // 容器与 iframe 的铺满规则
    expect(css).toContain('position: absolute')
    expect(css).toContain('inset: 0')
    // 侧栏入口行与图标盒几何
    expect(css).toContain(`[${ENTRY_ATTRIBUTE}]`)
    expect(css).toContain('width: 24px')
    // 折叠轨
    expect(css).toContain('[data-sidebar-collapsed]')
  })

  it('透明透传：容器 / 面板 / 承载区 / iframe 一律不铺底色', () => {
    ensureClientStyles(document)
    const css = document.querySelector<HTMLStyleElement>(STYLE_SELECTOR)!.textContent ?? CLIENT_CSS

    // 宿主背景要能穿透到看板之下，因此承载链路四层都不得自带底色
    expect(css).toContain(`[${VIEW_ATTRIBUTE}] {`)
    expect(css).toMatch(new RegExp(`\\[${VIEW_ATTRIBUTE}\\]\\s*\\{[^}]*background:\\s*transparent`))
    expect(css).toMatch(/\.tlmemory-panel\s*\{[^}]*background:\s*transparent/)
    expect(css).toMatch(/\.tlmemory-body\s*\{[^}]*background:\s*transparent/)
    expect(css).toMatch(/\.tlmemory-frame\s*\{[^}]*background:\s*transparent/)
    // 容器不再使用 dsh 的不透明底令牌
    expect(css).not.toMatch(new RegExp(`\\[${VIEW_ATTRIBUTE}\\]\\s*\\{[^}]*var\\(--dsw-alias-bg-base`))
    // 唯一的例外：加载 / 离线遮罩必须自带不透明底才能读清
    expect(css).toMatch(/\.tlmemory-overlay\s*\{[^}]*var\(--dsw-alias-bg-base/)
  })

  it('主题感知：面板外框带 data-theme 驱动的 color-scheme', () => {
    ensureClientStyles(document)
    const css = document.querySelector<HTMLStyleElement>(STYLE_SELECTOR)!.textContent ?? CLIENT_CSS

    expect(css).toContain(".tlmemory-panel[data-theme='light']")
    expect(css).toContain(".tlmemory-panel[data-theme='dark']")
    expect(css).toContain('color-scheme: light')
    expect(css).toContain('color-scheme: dark')
  })

  it('标题栏：右侧留出宿主安全区，状态胶囊为紧凑次级标签', () => {
    ensureClientStyles(document)
    const css = document.querySelector<HTMLStyleElement>(STYLE_SELECTOR)!.textContent ?? CLIENT_CSS

    // 宿主安全区：中心列整幅接管时，面板右上角与宿主右上角的抽屉折叠按钮重叠，
    // 顶部标题栏必须留白，任何贴右控件都会盖住宿主自己的图标。
    expect(css).toMatch(/\.tlmemory-header\s*\{[^}]*padding-right:\s*48px/)
    // 标题 + 状态胶囊 + 重试按钮共处一个左对齐标题组
    expect(css).toMatch(/\.tlmemory-heading\s*\{[^}]*display:\s*flex/)
    expect(css).toMatch(/\.tlmemory-heading\s*\{[^}]*gap:\s*8px/)
    // 标题不再自身撑满整行 —— 那正是把状态指示器挤到视口最右端的根因
    expect(css).toMatch(/\.tlmemory-title\s*\{[^}]*flex:\s*0 1 auto/)
    // 状态指示器：紧凑次级胶囊 + 半透明底（令牌优先，不写死纯色）
    expect(css).toMatch(/\.tlmemory-status\s*\{[^}]*padding:\s*2px 8px/)
    expect(css).toMatch(/\.tlmemory-status\s*\{[^}]*border-radius:\s*9999px/)
    expect(css).toMatch(/\.tlmemory-status\s*\{[^}]*font-size:\s*12px/)
    expect(css).toMatch(/\.tlmemory-status\s*\{[^}]*background:\s*var\(--dsw-alias-interactive-bg-hover/)
  })
})
