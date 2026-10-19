// scripts/smoke-client.mjs
//
// 客户端产物的**运行时**冒烟测试：把 `web/client.js` 当成宿主 shell 去加载。
//
// 为什么需要它（assert-build 只做字符串断言，拦不住这类事故）：
//   - bundle 语法/打包错误、`__ModuleLoader__` 工厂返回错东西 —— 只有真跑一次才知道；
//   - `inject` 列表写错（少一个 `remote` 就会在白名单代理上抛）；
//   - 插槽注册 id / order / locale 写错，或者 `label()` 抛错；
//   - store 与 `remote.settings` 的接线（describe → 快照 → mutate 带 revision）。
//
// 不引 jsdom：这里**不渲染**组件（渲染需要 DOM 与 react-dom），只验证 apply() 的装配
// 行为。组件本身由 TypeScript + 手工 UI 验证覆盖。

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const pkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
const source = readFileSync(join(pkgRoot, 'web', 'client.js'), 'utf8')

const failures = []
const pass = (line) => console.log(`  ok  ${line}`)
const fail = (line) => {
  failures.push(line)
  console.log(`  FAIL ${line}`)
}
const assert = (condition, okLine, failLine = okLine) => (condition ? pass(okLine) : fail(failLine))

// ── 最小 DOM 桩：只够 apply() 与 ensureClientStyles() 跑完 ──────────────────
function makeElement() {
  return {
    style: {},
    textContent: '',
    children: [],
    setAttribute() {},
    appendChild(child) {
      this.children.push(child)
      return child
    },
    remove() {},
  }
}
const documentStub = {
  documentElement: { getAttribute: () => 'zh', lang: 'zh', classList: { contains: () => false } },
  head: makeElement(),
  body: makeElement(),
  createElement: () => makeElement(),
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
}
class MutationObserverStub {
  observe() {}
  disconnect() {}
}

// ── shell 的模块加载器桩 ───────────────────────────────────────────────────
const loaded = []
const windowStub = {
  __ModuleLoader__: {
    load(entry) {
      loaded.push(entry)
    },
  },
}
const nodeRequire = createRequire(import.meta.url)
const requireStub = (name) => {
  if (name === 'react') return nodeRequire('react')
  throw new Error(`客户端 bundle 申请了未声明的外部模块: ${name}`)
}

const sandbox = {
  window: windowStub,
  document: documentStub,
  MutationObserver: MutationObserverStub,
  navigator: { language: 'zh-CN' },
  console,
  setTimeout,
  clearTimeout,
  require: requireStub,
}
sandbox.globalThis = sandbox
sandbox.self = sandbox

console.log('\n[1/4] 通过 __ModuleLoader__ 加载 web/client.js')
try {
  vm.runInNewContext(source, sandbox, { filename: 'web/client.js' })
  assert(loaded.length === 1, '加载器收到一次 load() 调用', `加载器收到 ${String(loaded.length)} 次 load()`)
} catch (error) {
  fail(`加载 web/client.js 抛错: ${error instanceof Error ? error.message : String(error)}`)
}

const entry = loaded[0]
if (entry === undefined) {
  console.log('\n冒烟失败：bundle 没有注册自己，后续检查全部跳过。')
  process.exit(1)
}
assert(entry.id === pkgJson.name, `注册 id = ${String(entry.id)}`, `注册 id 应为 ${pkgJson.name}，实际 ${String(entry.id)}`)

console.log('\n[2/4] 工厂返回 apply / inject')
const mod = entry.factory(requireStub)
assert(typeof mod.apply === 'function', 'apply 是函数')
assert(
  JSON.stringify(mod.inject) === JSON.stringify(['slots', 'locale', 'remote']),
  `inject = ${JSON.stringify(mod.inject)}`,
)

console.log('\n[3/4] apply() 装配：插槽 / 文案 / store')
const calls = { describe: 0, mutate: [], register: [], locale: [], listeners: [], label: null }
// 宿主的两种返回形状（dsh-api-settings-controller/lib/index.js:271-292, :398）：
//   describe() → { writable, hasDocument, namespaces: [namespaceView…] }
//   mutate()   → namespaceView 本身（{ ns, revision, applies, value, secrets }）
const namespaceView = (revision, value) => ({
  ns: pkgJson.name,
  revision,
  applies: 'live',
  value,
  secrets: [{ path: ['apiKey'], set: true }],
})
const describeView = (revision, value) => ({
  ok: true,
  value: { writable: true, hasDocument: true, namespaces: [namespaceView(revision, value)] },
})
const mutateView = (revision, value) => ({ ok: true, value: namespaceView(revision, value) })
const remote = {
  settings: {
    async describe() {
      calls.describe += 1
      // apiKey 已脱敏：宿主的 value 里没有它，只有 secrets[] 里的 set 标记
      return describeView(3, { provider: 'tavily', maxResults: 7 })
    },
    async update(ns, patch, revision) {
      calls.mutate.push({ ns, ops: [{ op: 'set', path: Object.keys(patch), value: Object.values(patch)[0] }], revision })
      return mutateView(revision + 1, { provider: 'tavily', maxResults: 9 })
    },
    async mutate(ns, ops, revision) {
      calls.mutate.push({ ns, ops, revision })
      return mutateView(revision + 1, { provider: 'tavily', maxResults: 9 })
    },
  },
  $on(event, listener) {
    calls.listeners.push(event)
    void listener
    return () => {}
  },
}

let sectionRegistered = null
let effectDisposer = null
const ctx = {
  get: () => undefined,
  slots: {
    inject(name, callback) {
      if (name !== 'settings.section') fail(`插槽名不对: ${name}`)
      return callback()
    },
    register(spec, component) {
      sectionRegistered = { spec, component }
      return () => {}
    },
  },
  locale: {
    register(namespace, dictionaries) {
      calls.locale.push({ namespace, keys: Object.keys(dictionaries) })
      return () => {}
    },
    bind(namespace) {
      calls.locale.push({ bound: namespace })
      return (key) => `${namespace}:${key}`
    },
  },
  remote,
  effect(callback) {
    effectDisposer = callback()
    return () => {}
  },
}

try {
  mod.apply(ctx)
} catch (error) {
  fail(`apply() 抛错: ${error instanceof Error ? error.message : String(error)}`)
}

assert(sectionRegistered !== null, '注册了 settings.section 插槽', '没有注册 settings.section 插槽')
if (sectionRegistered) {
  const { spec, component } = sectionRegistered
  assert(spec.name === 'settings.section', `spec.name = ${String(spec.name)}`)
  assert(spec.id === 'tlsearch', `spec.id = ${String(spec.id)}`)
  assert(spec.order === 31, `spec.order = ${String(spec.order)}`, `spec.order 应为 31，实际 ${String(spec.order)}`)
  assert(spec.locale === 'settings.tlsearch', `spec.locale = ${String(spec.locale)}`)
  const label = typeof spec.label === 'function' ? spec.label() : spec.label
  assert(label === 'settings.tlsearch:nav', `label() = ${String(label)}`)
  assert(typeof component === 'function', '插槽组件是函数')
  const face = spec.inject()
  assert(face && typeof face.store === 'object', 'inject() 返回 store')
}

assert(
  calls.locale.some((call) => call.namespace === 'settings.tlsearch' && call.keys.join(',') === 'zh,en'),
  'locale.register("settings.tlsearch", {zh,en}) 被调用',
)
assert(calls.listeners.includes('settings/document-updated'), '订阅了 settings/document-updated')

console.log('\n[4/4] store 与 remote.settings 的接线')
await new Promise((resolveTick) => setTimeout(resolveTick, 0))
const store = sectionRegistered?.spec.inject().store
if (store === undefined) {
  fail('拿不到 store，跳过接线检查')
} else {
  const snapshot = store.getSnapshot()
  assert(snapshot.status === 'ready', `首次 describe 后状态 = ${snapshot.status}`)
  assert(snapshot.revision === 3, `快照 revision = ${String(snapshot.revision)}`)
  assert(snapshot.values.maxResults === 7, `快照 maxResults = ${String(snapshot.values.maxResults)}`)
  assert(
    snapshot.secrets.some((slot) => slot.path.join('.') === 'apiKey' && slot.set === true),
    '脱敏字段的「已保存」标记传到了快照',
  )

  const result = await store.mutate([{ op: 'set', path: ['maxResults'], value: 9 }])
  assert(result.ok === true, 'mutate 成功')
  const write = calls.mutate[0]
  assert(write?.ns === pkgJson.name, `写入命名空间 = ${String(write?.ns)}`)
  assert(write?.revision === 3, `写入带回 revision = ${String(write?.revision)}`)
  assert(
    JSON.stringify(write?.ops) === JSON.stringify([{ op: 'set', path: ['maxResults'], value: 9 }]),
    '写入的是路径化操作（未触碰脱敏字段）',
  )
  assert(store.getSnapshot().values.maxResults === 9, '写入后用宿主回传值刷新快照')
}

if (typeof effectDisposer === 'function') {
  try {
    effectDisposer()
    pass('ctx.effect 的回收函数可执行')
  } catch (error) {
    fail(`回收函数抛错: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\n结论')
if (failures.length > 0) {
  console.error(`smoke-client: ${failures.length} 项失败`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log('smoke-client: 全部通过')
