#!/usr/bin/env node
/**
 * 产物契约断言：把 web/client.js 当成「宿主要吞下去的字节」来校验，而不是当成源码。
 *
 * 检查四件事，任何一条不成立就非零退出：
 *  1. 产物里出现了 `window.__ModuleLoader__.load({ id, factory })` 这个装载入口；
 *  2. `id` 严格等于 package.json 的 name（宿主用包名去索引插件，写错就静默不挂载）；
 *  3. 产物里每个 `require('<spec>')` 的 spec 都是**宿主 node_modules 里真实存在**的包
 *     —— 这是实机最容易翻车的地方：写一个宿主没有的包名，`runtime.factory` 一执行就抛，
 *     整个设置页变空白，而构建期毫无警告。所以要逐个 fs 校验。
 *  4. package.json 的 `exports['./client']` / `files` 与 dsh.client 三处口径自洽。
 *
 * 宿主目录默认取 0.2.1-rc.2 的 asar 解包副本，可用 DSH_HOST_NODE_MODULES 覆盖。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const bundlePath = join(packageRoot, 'web', 'client.js')
const bundle = readFileSync(bundlePath, 'utf8')

const HOST_NODE_MODULES =
  process.env.DSH_HOST_NODE_MODULES ?? 'D:\\tmp\\dsh-asar\\dsh\\node_modules'

const failures = []
const check = (label, run) => {
  try {
    run()
    console.log(`  ok  ${label}`)
  } catch (error) {
    failures.push(`${label}\n      ${error.message}`)
    console.log(`  FAIL ${label}\n      ${error.message}`)
  }
}

// ── 1. 装载入口 ─────────────────────────────────────────────────────────────
check('产物里有 window.__ModuleLoader__.load({...})', () => {
  assert.match(bundle, /window\.__ModuleLoader__\.load\(\{/, '找不到 __ModuleLoader__.load 调用')
})

// ── 2. id 必须等于包名 ──────────────────────────────────────────────────────
const idMatch = /window\.__ModuleLoader__\.load\(\{\s*id:\s*(['"])(.*?)\1/.exec(bundle)
check(`id 严格等于包名 ${pkg.name}`, () => {
  assert.ok(idMatch, 'load 调用里没有 id 字段（或不是字面量）')
  assert.equal(idMatch[2], pkg.name)
})

check('factory 是函数签名 (require) => {...}', () => {
  assert.match(bundle, /factory:\s*\(\s*require\s*\)\s*=>\s*\{/, 'factory 形状不对')
})

// ── 3. 逐个 fs 校验 require 的宿主包 ────────────────────────────────────────
// esbuild 把外置依赖写成 `__require("react")`（它自己的运行时 shim，运行期再落到
// factory 的 `require` 形参上），普通调用写 `require("x")`。两种都要认。
const specifiers = new Set()
for (const match of bundle.matchAll(/\b(?:__require|require)\(\s*(['"])([^'"]+)\1\s*\)/g)) {
  specifiers.add(match[2])
}
const list = [...specifiers].sort()

/**
 * 宿主提供的模块分两类，必须分开判：
 *  a) 落盘的 npm 包（`@deepseek-ai/*`）→ 直接 fs 看 `node_modules/<name>/package.json`；
 *  b) **由浏览器外壳在 runtime 里注入的模块**（`react` / `react-dom` / `react/jsx-runtime`
 *     等）→ 这些在宿主的 node_modules 里**根本没有目录**（实测 0.2.1-rc.2 的
 *     `D:\tmp\dsh-asar\dsh\node_modules` 下没有 react），是外壳的 provider 表在
 *     装载时喂给 factory 的 `require`。所以不能拿 fs 当唯一判据，否则会误报。
 *
 * 判据改成「官方插件也这么 require」：扫宿主里每个官方包的 lib/client.js，把它们实际用到的
 * specifier，并集即外壳的 provider 表真相。我们的产物只要落在并集里，就一定能被解析
 * ——这是可复算的证据，不是硬编码白名单。
 */
const hostSpecifiers = new Set()
const officialBundles = []
if (existsSync(HOST_NODE_MODULES)) {
  for (const name of readdirSync(join(HOST_NODE_MODULES, '@deepseek-ai'))) {
    const bundle = join(HOST_NODE_MODULES, '@deepseek-ai', name, 'lib', 'client.js')
    if (!existsSync(bundle)) continue
    officialBundles.push(`@deepseek-ai/${name}`)
    for (const match of readFileSync(bundle, 'utf8').matchAll(/\b(?:__require|require)\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      hostSpecifiers.add(match[2])
    }
  }
}

const classify = (spec) => {
  // 只校验裸包名；相对路径是产物内部的东西，不归宿主管。
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return 'skip'
  const parts = spec.split('/')
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (existsSync(join(HOST_NODE_MODULES, name, 'package.json'))) return 'package'
  if (hostSpecifiers.has(spec)) return 'shell'
  return 'missing'
}

check(
  `产物 require 的宿主模块都可解析（落盘包 or 外壳注入；官方产物 ${officialBundles.length} 个）`,
  () => {
    assert.ok(list.length > 0, '产物里一个 require 都没有，说明打包方式变了')
    assert.ok(officialBundles.length > 0, `没在 ${HOST_NODE_MODULES} 找到任何官方 client.js，判据失效`)
    const missing = list.filter((spec) => classify(spec) === 'missing')
    assert.deepEqual(missing, [], `宿主解析不到的模块：${missing.join(', ')}`)
    for (const spec of list) console.log(`        ${spec} → ${classify(spec)}`)
  },
)

// ── 4. package.json 三方口径 ────────────────────────────────────────────────
check('exports["./client"] 与 files 指向同一个真实文件', () => {
  const clientExport = pkg.exports?.['./client']
  assert.ok(typeof clientExport === 'string', 'exports["./client"] 不是字符串')
  const relative = clientExport.replace(/^\.\//, '')
  assert.ok(existsSync(join(packageRoot, relative)), `exports 指向的文件不存在：${clientExport}`)
  const listed = (pkg.files ?? []).map((entry) => entry.replace(/^\.\//, ''))
  assert.ok(listed.includes(relative), `files 里没有 ${relative}`)
})

check('dsh.client 形状与 0.2.1 官方插件一致', () => {
  const client = pkg.dsh?.client
  assert.ok(client, '缺少 dsh.client')
  assert.equal(client.platform, 'web')
  assert.ok(Array.isArray(client.inject), 'dsh.client.inject 必须是数组')
  if (client.external !== undefined) {
    assert.ok(Array.isArray(client.external), 'dsh.client.external 必须是数组')
    const declared = new Set(client.external)
    const undeclared = list.filter((spec) => classify(spec) !== 'skip' && !declared.has(spec))
    assert.deepEqual(
      undeclared,
      [],
      `产物 require 了未在 dsh.client.external 声明的宿主包：${undeclared.join(', ')}`,
    )
  }
})

check('版本号是 1.0.0', () => {
  assert.equal(pkg.version, '1.0.0')
})

if (failures.length > 0) {
  console.error(`\n[assert-client-contract] ${failures.length} 项失败`)
  process.exit(1)
}
console.log('\n[assert-client-contract] 全部通过')
