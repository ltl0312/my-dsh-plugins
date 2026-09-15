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
check('inject 为空数组（不再依赖客户端服务）', Array.isArray(plugin.inject) && plugin.inject.length === 0)
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
