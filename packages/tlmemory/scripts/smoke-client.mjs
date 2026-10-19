// 一次性集成冒烟（不属于测试套件）：在 jsdom 里加载真实产物 web/client.js，
// 用桩替换 react / react-dom/client，验证 apply() 的完整装配链路。
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:8080/',
  pretendToBeVisual: true,
})
const { window } = dom
const g = globalThis
// 注意：绝不能把 setTimeout / setInterval / clearTimeout / clearInterval 换成
// jsdom 的实现 —— jsdom 内部计时器（Window.js timerInitializationSteps）引用的
// 裸 setTimeout 在桩替换后会指回 window.setTimeout，造成同步无限递归
// （P2-10 客户端加了低频巡查 setInterval 后首次暴露）。客户端插件用 Node 原生
// 计时器语义完全等价；结尾统一走 Disposer 清理，不留活定时器阻塞进程退出。
for (const key of [
  'document', 'MutationObserver', 'CustomEvent', 'HTMLElement', 'Element', 'Node',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'AbortController',
]) {
  if (window[key] !== undefined) {
    // navigator 之类在 Node 上是只读 getter，统一用 defineProperty 覆盖。
    Object.defineProperty(g, key, { value: window[key], configurable: true, writable: true })
  }
}
g.window = window

const rootMounts = []
const reactLike = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  // 忠实还原 React 的惰性初始值语义：传函数时取返回值（面板用 useState(() => …)
  // 读宿主配色，若不展开成函数会让后续结构断言拿到一个函数而不是字符串）。
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useMemo: (fn) => fn(),
  Fragment: 'Fragment',
}

window.__ModuleLoader__ = {
  load({ id, factory }) {
    const require = (name) => {
      if (name === 'react') return { __esModule: true, default: reactLike, ...reactLike }
      if (name === 'react/jsx-runtime') {
        return { jsx: reactLike.createElement, jsxs: reactLike.createElement, Fragment: 'Fragment' }
      }
      if (name === 'react-dom/client') {
        return {
          createRoot: (container) => {
            const root = {
              render: (element) => rootMounts.push({ container, element }),
              unmount: () => rootMounts.push({ container, unmounted: true }),
            }
            return root
          },
        }
      }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error('unexpected require: ' + name)
    }
    g.__loaded = { id, exports: factory(require) }
  },
}

new Function(readFileSync('./web/client.js', 'utf8'))()

const { id, exports: plugin } = g.__loaded
const fail = []
const check = (label, ok) => {
  console.log((ok ? '  OK   ' : '  FAIL ') + label)
  if (!ok) fail.push(label)
}

console.log('module id =', id)
check('模块 id 为包名', id === 'dsh-plugin-tlmemory')
check('导出 apply', typeof plugin.apply === 'function')
// 0.2.1 客户端 ctx 是白名单代理：`remote.settings` 是独立的 dotted inject 项，
// 不是 `remote` 的子属性（漏声明时 createConfigStore 直接抛 cannot get property），
// 因此这里必须连它一起断言，否则产物能过冒烟、真宿主却白屏。
check('inject 声明了设置面板所需的四个客户端服务', Array.isArray(plugin.inject) && plugin.inject.join(',') === 'slots,locale,remote,remote.settings')
check('不再导出已废弃的页签 API', plugin.activateViewTab === undefined && plugin.openDashboardForSession === undefined)

document.body.innerHTML = `
<div class="appFrame">
  <div data-pane="sidebar"><div class="wrap"><div class="shellRoot hHd-Xa_root">
    <div class="hHd-Xa_logoRow"><span>brand</span></div>
    <button type="button" class="hHd-Xa_newSession">新会话</button>
    <button type="button" data-dsh-taskboard-entry></button>
    <button type="button" data-dsh-ssh-entry></button>
    <button type="button" data-dsh-skill-explorer-entry></button>
    <div class="hHd-Xa_regionArea"></div>
    <div class="hHd-Xa_footArea"></div>
  </div></div></div>
  <div class="wSkVaW_root" data-pane="conversation">
    <div data-slot="conversation.session" style="display: contents"><div class="wSkVaW_viewArea">chat</div></div>
    <div class="wSkVaW_composerSeat">composer</div>
  </div>
</div>`

const effects = []
plugin.apply({ effect: (callback, label) => { effects.push({ callback, label }); return () => {} } })

const sidebarRoot = document.querySelector('.shellRoot')
const children = Array.from(sidebarRoot.children)
const entry = document.querySelector('[data-dsh-tlmemory-entry]')
const container = document.querySelector('[data-dsh-tlmemory-view]')
const styleTag = document.querySelector('style[data-plugin-css]')

console.log('sidebar children =', children.map((el) => el.getAttribute('data-dsh-plugin') ?? el.className).join(' | '))
check('注入样式表', styleTag !== null)
check('注入侧栏入口行', entry !== null)
check('入口排在技能中心之后', children.indexOf(entry) === children.findIndex((el) => el.hasAttribute('data-dsh-skill-explorer-entry')) + 1)
check('入口语义属性齐全', entry?.getAttribute('data-dsh-plugin') === 'tlmemory' && entry?.getAttribute('data-dsh-part') === 'sidebar-entry')
check('入口含图标与文案', entry?.querySelector('[data-dsh-tlmemory-icon] svg') !== null && entry?.querySelector('[data-dsh-tlmemory-label]')?.textContent === '记忆看板')
check('中心列注入面板容器', container !== null && container.parentElement === document.querySelector('[data-pane="conversation"]'))
check('面板容器是中心列尾部子节点', document.querySelector('[data-pane="conversation"]').lastElementChild === container)
check('面板树已挂载（createRoot 被调用）', rootMounts.length === 1)
check('apply 注册了生命周期副作用', effects.length === 1 && effects[0].label === 'tlmemory: client mounts')

// 面板标题栏结构：直接调用函数组件拿到元素树再走查。
// 回归背景：状态指示器曾被 flex:1 的标题推到视口最右端，盖住宿主右上角的
// 「右侧抽屉折叠」按钮 —— 因此这里既断言它不贴右端，也断言它与标题同组同基准线。
const panelTree = rootMounts[0].element.type(rootMounts[0].element.props)
const childrenOf = (node) => node?.children ?? []
const pick = (node, className) => childrenOf(node).find((child) => child?.props?.className === className)
const headerEl = pick(panelTree, 'tlmemory-header')
const headingEl = pick(headerEl, 'tlmemory-heading')
const titleEl = pick(headingEl, 'tlmemory-title')
const statusEl = pick(headingEl, 'tlmemory-status')
const headerChildren = childrenOf(headerEl)

console.log(
  'header children =',
  headerChildren.map((el) => el?.props?.className ?? el?.type).join(' | '),
  '| heading children =',
  childrenOf(headingEl).map((el) => el?.props?.className ?? el?.type).join(' | '),
)
check('标题栏存在', headerEl !== undefined)
check('标题栏直接子节点只有 回退按钮 + 标题组（右侧不再挂任何控件）', headerChildren.length === 2)
check('标题组含标题与状态胶囊', titleEl !== undefined && statusEl !== undefined)
check('标题组内顺序为 标题 → 状态胶囊', childrenOf(headingEl).indexOf(titleEl) < childrenOf(headingEl).indexOf(statusEl))
check('状态胶囊不贴标题栏右端（不侵占宿主安全区）', headerChildren.includes(statusEl) === false)
check('状态胶囊带语义钩子', statusEl?.props?.['data-dsh-part'] === 'panel-status')
check('状态胶囊文案可截断（窄面板不撑破标题组）', pick(statusEl, 'tlmemory-status-text') !== undefined)

// 点击入口 → 打开中心列
entry.click()
const html = document.documentElement
check('点击入口后置 <html> 激活标记', html.hasAttribute('data-dsh-tlmemory-active'))
check('入口高亮', entry.hasAttribute('data-active'))

// 兄弟面板广播 → 自动退场
document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'ssh' }))
check('兄弟面板激活即退场（撤销激活标记）', !html.hasAttribute('data-dsh-tlmemory-active') && !entry.hasAttribute('data-active'))

// 再次打开，然后点会话行收拢
entry.click()
const sessionRow = document.createElement('div')
sessionRow.className = 'hHd_sessionRow'
document.body.append(sessionRow)
sessionRow.click()
check('点击会话行即收拢面板', !html.hasAttribute('data-dsh-tlmemory-active'))

// 重复 apply 幂等
plugin.apply({ effect: () => () => {} })
check('重复 apply 不产生第二份入口/容器', document.querySelectorAll('[data-dsh-tlmemory-entry]').length === 1 && document.querySelectorAll('[data-dsh-tlmemory-view]').length === 1)

// ── 设置页分区装配（1.0.0 新增能力）────────────────────────────────────────
// 用完整假上下文（slots / locale / remote.settings）走一遍真实注册链路：
// 词典注册 → 插槽注册 → describe 读取 → 渲染 → 保存。
// 注意这里是在 DOM 已挂载之后再次 apply：设置分区必须照常注册（不得被
// DOM 幂等短路吃掉），这正是宿主 HMR 重注入时的路径。
const settingsEffects = []
const observed = { slots: [], locale: [], events: [], sections: [], describeCalls: 0, writes: [] }
/** 与 schemastery toJSON() 同形的引用图（真实形状由 tests/config.spec.ts 断言） */
const projection = {
  uid: 6,
  refs: {
    1: { type: 'string', meta: { volatile: true, description: '库路径' } },
    2: { type: 'number', meta: { volatile: true, default: 4890, description: '端口' } },
    3: { type: 'number', meta: { volatile: true, default: 5, description: '召回条数' } },
    4: { type: 'boolean', meta: { volatile: true, default: true, description: '自动提炼' } },
    5: { type: 'number', meta: { volatile: true, default: 20, description: '间隔' } },
    7: { type: 'boolean', meta: { volatile: true, default: true, description: '归并' } },
    6: {
      type: 'object',
      meta: { default: {} },
      dict: { dbPath: 1, serverPort: 2, maxRecallCount: 3, enableAutoReflection: 4, compactionInterval: 5, enableAutoMerge: 7 },
    },
  },
}
let fakeRevision = 1
const fakeSettings = {
  async describe() {
    observed.describeCalls += 1
    return {
      ok: true,
      value: {
        writable: true,
        hasDocument: true,
        namespaces: [
          {
            ns: 'dsh-plugin-tlmemory',
            revision: fakeRevision,
            schema: projection,
            value: { serverPort: 4890, maxRecallCount: 5, enableAutoReflection: true, compactionInterval: 20, enableAutoMerge: true },
            base: {},
            user: {},
          },
        ],
      },
    }
  },
  async update(ns, patch, revision) {
    observed.writes.push({ method: 'update', ns, patch, revision })
    fakeRevision += 1
    return { ok: true, value: { ns, revision: fakeRevision } }
  },
  async mutate(ns, ops, revision) {
    observed.writes.push({ method: 'mutate', ns, ops, revision })
    fakeRevision += 1
    return { ok: true, value: { ns, revision: fakeRevision } }
  },
}

const settingsCtx = {
  effect: (callback, label) => {
    settingsEffects.push({ callback, label })
    return () => {}
  },
  locale: {
    bind: (ns) => (key) => `${ns}:${key}`,
    register: (ns, dict) => {
      observed.locale.push({ ns, dict })
      return () => {}
    },
  },
  slots: {
    inject: (name, callback) => {
      observed.slots.push(name)
      return callback()
    },
    register: (spec, Component) => {
      observed.sections.push({ spec, Component })
      return () => {}
    },
  },
  remote: {
    settings: fakeSettings,
    $on: (event, callback) => {
      observed.events.push({ event, callback })
      return () => {}
    },
  },
}
plugin.apply(settingsCtx)
await new Promise((resolve) => setTimeout(resolve, 0))

check('设置分区注入 settings.section 插槽', observed.slots.length === 1 && observed.slots[0] === 'settings.section')
check('注册词典 settings.tlmemory（zh + en）', observed.locale.length === 1 && observed.locale[0].ns === 'settings.tlmemory' && 'zh' in observed.locale[0].dict && 'en' in observed.locale[0].dict)
check('订阅 settings/document-updated 以跟随外部改动', observed.events.some((entry) => entry.event === 'settings/document-updated'))
const section = observed.sections[0]
check('分区注册项形态正确（id/order/label/locale/inject）', section?.spec.name === 'settings.section' && section.spec.id === 'tlmemory' && section.spec.order === 30 && section.spec.locale === 'settings.tlmemory' && typeof section.spec.label === 'function' && typeof section.spec.inject === 'function')
check('导航标签走词典', section?.spec.label() === 'settings.tlmemory:nav')

const injected = section?.spec.inject()
await new Promise((resolve) => setTimeout(resolve, 0))
const snapshot = injected.controller.getSnapshot()
console.log('settings snapshot =', JSON.stringify({ status: snapshot.status, ns: snapshot.ns, revision: snapshot.revision, fields: snapshot.fields.map((f) => f.key) }))
check('控制器读到命名空间与 6 个字段', snapshot.status === 'ready' && snapshot.ns === 'dsh-plugin-tlmemory' && snapshot.fields.length === 6)
check('字段值来自宿主当前值', snapshot.draft.maxRecallCount === '5' && snapshot.draft.enableAutoReflection === true && snapshot.draft.dbPath === '')

const findNode = (node, predicate) => {
  if (node === null || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = findNode(child, predicate)
    if (hit !== undefined) return hit
  }
  return undefined
}
const tree = section.Component(injected)
check('分区可渲染为 ready 表单', tree?.props?.['data-tlmemory-settings'] === 'ready')
const fieldKeys = []
const collect = (node) => {
  if (node === null || typeof node !== 'object') return
  const key = node.props?.['data-tlmemory-field']
  if (typeof key === 'string') fieldKeys.push(key)
  for (const child of node.children ?? []) collect(child)
}
collect(tree)
check('六个字段行全部渲染', ['dbPath', 'serverPort', 'maxRecallCount', 'enableAutoReflection', 'compactionInterval', 'enableAutoMerge'].every((key) => fieldKeys.includes(key)))
const saveButton = findNode(tree, (node) => node.type === 'button' && node.children?.[0] === 'settings.tlmemory:save')
check('保存按钮存在（初始因无改动而禁用）', saveButton !== undefined && saveButton.props.disabled === true)

injected.controller.setDraft('maxRecallCount', '8')
await injected.controller.save()
console.log('writes =', JSON.stringify(observed.writes))
check('保存写入 patch 并带 revision', observed.writes.length === 1 && observed.writes[0].method === 'update' && observed.writes[0].patch.maxRecallCount === 8 && observed.writes[0].revision === 1)
check('保存后重新 load 最新值', observed.describeCalls === 2 && injected.controller.getSnapshot().messageKey === 'saved')

for (const effect of settingsEffects) {
  const disposer = effect.callback()
  if (typeof disposer === 'function') disposer()
}
check('设置分区副作用可回收', settingsEffects.length === 1 && settingsEffects[0].label === 'tlmemory: settings section')

// 卸载还原
for (const effect of effects) {
  const disposer = effect.callback()
  if (typeof disposer === 'function') disposer()
}
check('卸载后入口行移除', document.querySelector('[data-dsh-tlmemory-entry]') === null)
check('卸载后面板容器移除', document.querySelector('[data-dsh-tlmemory-view]') === null)
check('<html> 激活标记已清空', !html.hasAttribute('data-dsh-tlmemory-active'))
check('卸载后样式表移除', document.querySelector('style[data-plugin-css]') === null)

console.log(fail.length === 0 ? '\n全部冒烟检查通过' : `\n失败 ${fail.length} 项：${fail.join(' / ')}`)
process.exit(fail.length === 0 ? 0 : 1)
