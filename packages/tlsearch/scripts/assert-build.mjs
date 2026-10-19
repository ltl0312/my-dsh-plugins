// scripts/assert-build.mjs
//
// 构建产物的机械断言（`pnpm --filter dsh-plugin-tlsearch run assert:build`）。
//
// 断言三件事，任何一条不成立都说明「装到宿主里会坏」：
//
//  1. 包元数据对得上宿主契约（v1.0.0、`./client` 导出、`dsh.client.platform`、files）；
//  2. `dist` 里导出的 `Config` 真的带 `meta.volatile`，校验产物真的是「引用」——
//     设置页据此生成表单，宿主 Loader 据此原地热更新（不重启插件）；
//  3. 把 `dist` 单独拷进一个**没有任何 node_modules** 的临时目录后仍能加载并跑通，
//     也就是零运行时外部依赖；设置页产物 `web/client.js` 按 `__ModuleLoader__.load`
//     注册且 id 等于包名。
//
// 第 2/3 条是重点：bundled schemastery + cosmokit 如果哪天被改成 external，或者 volatile
// 标记被重构掉，这个脚本会立刻失败，而不是等用户在宿主机上看到 `Cannot find module`
// 或「设置页一片空白」。

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const pkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
const PACKAGE_NAME = pkgJson.name
const failures = []
const pass = (line) => console.log(`  ok  ${line}`)
const fail = (line) => {
  failures.push(line)
  console.log(`  FAIL ${line}`)
}

// ── 1. 包元数据 ────────────────────────────────────────────────────────────
console.log(`\n[1/4] ${PACKAGE_NAME}@${pkgJson.version} 包元数据`)
if (pkgJson.version === '1.0.0') pass('version = 1.0.0')
else fail(`version = ${String(pkgJson.version)}（期望 1.0.0）`)
if (pkgJson.exports?.['./client'] === './web/client.js') pass('exports["./client"] = ./web/client.js')
else fail(`exports["./client"] = ${JSON.stringify(pkgJson.exports?.['./client'])}`)
if (pkgJson.dsh?.client?.platform === 'web') pass('dsh.client.platform = web')
else fail(`dsh.client.platform = ${JSON.stringify(pkgJson.dsh?.client?.platform)}`)
if ((pkgJson.dsh?.client?.external ?? []).includes('react')) pass('dsh.client.external 含 react')
else fail('dsh.client.external 未声明 react')
if ((pkgJson.files ?? []).includes('web/client.js')) pass('files 含 web/client.js')
else fail('files 未包含 web/client.js')

// ── 2. dist：volatile 标记 + 零运行时依赖 ──────────────────────────────────
console.log('\n[2/4] dist 产物：volatile 标记与零运行时依赖')

const distDir = join(pkgRoot, 'dist')
const esmFile = join(distDir, 'index.js')
const cjsFile = join(distDir, 'index.cjs')
for (const file of [esmFile, cjsFile]) {
  try {
    readFileSync(file, 'utf8')
    pass(`${file.slice(pkgRoot.length + 1)} 存在`)
  } catch {
    fail(`${file.slice(pkgRoot.length + 1)} 不存在（先跑 build）`)
  }
}

// 把 dist 拷到一个空壳目录：那里没有 node_modules，任何裸导入都会立刻失败。
const sandbox = mkdtempSync(join(tmpdir(), 'tlsearch-dist-'))
try {
  copyFileSync(esmFile, join(sandbox, 'index.js'))
  copyFileSync(cjsFile, join(sandbox, 'index.cjs'))
  copyFileSync(join(here, 'probe-dist.mjs'), join(sandbox, 'probe.mjs'))

  const run = spawnSync(process.execPath, [join(sandbox, 'probe.mjs'), 'index.js', 'index.cjs'], {
    cwd: sandbox,
    encoding: 'utf8',
  })
  if (run.status !== 0) {
    const stderr = (run.stderr ?? '').trim().split('\n').slice(0, 6).join(' | ')
    fail(`临时目录加载失败 (exit ${String(run.status)}): ${stderr}`)
  } else {
    const parsed = JSON.parse(run.stdout.trim().split('\n').pop())
    const steps = new Map(parsed.steps.map(([key, ...rest]) => [key, rest]))
    pass('在无 node_modules 的临时目录里加载成功（ESM import + CJS require）')

    const volatileTop = steps.get('volatile-top')?.[0] ?? []
    const expectTop = [
      'apiKey',
      'baseUrl',
      'chain',
      'cx',
      'includeAnswer',
      'language',
      'maxResults',
      'maxSnippetChars',
      'outputFormat',
      'provider',
      'timeoutMs',
    ]
    if (expectTop.every((key) => volatileTop.includes(key))) {
      pass(`顶层 volatile 字段齐全: ${volatileTop.join(', ')}`)
    } else {
      fail(`顶层 volatile 字段缺失: ${expectTop.filter((key) => !volatileTop.includes(key)).join(', ')}`)
    }

    const fallbackLeaves = steps.get('volatile-fallback')?.[0] ?? []
    if (['apiKey', 'baseUrl', 'cx', 'provider'].every((key) => fallbackLeaves.includes(key))) {
      pass(`fallback 叶子 volatile: ${fallbackLeaves.join(', ')}`)
    } else fail(`fallback 叶子 volatile 不全: ${fallbackLeaves.join(', ')}`)

    if (steps.get('fallback-node-volatile')?.[0] === false) {
      pass('fallback 容器本身不是 volatile（表单不会被压成一段 JSON）')
    } else fail('fallback 容器被标成 volatile')

    if (steps.get('apiKey-role')?.[0] === 'secret') pass("apiKey 标了 role='secret'（宿主 describe 脱敏，不回显）")
    else fail(`apiKey 的 role = ${JSON.stringify(steps.get('apiKey-role')?.[0])}`)
    if (steps.get('fallback-apiKey-role')?.[0] === 'secret') pass("fallback.apiKey 标了 role='secret'")
    else fail(`fallback.apiKey 的 role = ${JSON.stringify(steps.get('fallback-apiKey-role')?.[0])}`)

    if (steps.get('ref-apiKey')?.[0] === true) {
      pass(`校验产出引用带全局写符号（apiKey.get() = ${String(steps.get('ref-apiKey')?.[1])}）`)
    } else fail('校验没有产出 volatile 引用')
    if (steps.get('ref-maxResults')?.[1] === 7) pass('maxResults 引用带显式值')
    else fail(`maxResults 引用值 = ${JSON.stringify(steps.get('ref-maxResults'))}`)
    if (steps.get('ref-chain')?.[0] === true) pass('chain 整节点是引用')
    else fail('chain 不是引用')
    if (steps.get('ref-fallback-leaf')?.[0] === true) pass('fallback.apiKey 是引用')
    else fail('fallback.apiKey 不是引用')
    if (steps.get('no-key-usable-error')?.[0] === true) pass('无 key 时给出可读的不可用原因（不抛异常）')
    else fail('无 key 时没有给出不可用原因')
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

// ── 3. 客户端产物 ──────────────────────────────────────────────────────────
console.log('\n[3/4] web/client.js 客户端模块协议')
const clientFile = join(pkgRoot, 'web', 'client.js')
let clientSource = ''
try {
  clientSource = readFileSync(clientFile, 'utf8')
  pass('web/client.js 存在')
} catch {
  fail('web/client.js 不存在（先跑 build:client）')
}
if (clientSource) {
  if (clientSource.includes('window.__ModuleLoader__.load(')) pass('包含 window.__ModuleLoader__.load 注册')
  else fail('缺少 window.__ModuleLoader__.load 注册')
  if (clientSource.includes(`id: ${JSON.stringify(PACKAGE_NAME)}`)) pass(`注册 id = ${PACKAGE_NAME}`)
  else fail('注册 id 与包名不一致')

  // 唯一允许的裸 require 是 react（其余全部打进 bundle）。
  const requires = [...clientSource.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1])
  const bare = [...new Set(requires)].filter((name) => !name.startsWith('.'))
  if (bare.every((name) => name === 'react')) pass(`裸 require 只有 react（实际: ${bare.join(', ') || '无'}）`)
  else fail(`产物里有未声明的裸依赖: ${bare.join(', ')}`)

  if (clientSource.includes('settings.section')) pass('注册到 settings.section 插槽')
  else fail('没有注册 settings.section 插槽')
  if (clientSource.includes('settings.tlsearch')) pass('声明了 settings.tlsearch 文案命名空间')
  else fail('没有声明 settings.tlsearch 文案命名空间')
}

// ── 4. 结论 ────────────────────────────────────────────────────────────────
console.log('\n[4/4] 结论')
if (failures.length > 0) {
  console.error(`assert-build: ${failures.length} 项失败`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log('assert-build: 全部通过')
