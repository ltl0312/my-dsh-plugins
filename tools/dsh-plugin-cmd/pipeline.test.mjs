// tools/dsh-plugin-cmd/pipeline.test.mjs
// 编排层集成测试：在**真实临时目录**里搭一个最小 profile（package.json /
// pnpm-workspace.yaml / cordis.patch.yml / node_modules/<pkg>），跑完整的
// add / remove / list 管线。pnpm 用假的适配器注入（不真的装包），其余全是真文件 IO，
// 因此这里能抓到的正是「文件被写坏」「幂等失效」这类真问题。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { listMountedEntries, findMountedEntry, BUILD_PLACEHOLDER } from './core.mjs'
import {
  applyAddWrites,
  applyRemoveWrites,
  collectPluginStatus,
  diffDependencies,
  planAddWrites,
  readModules,
  readProfileManifest,
  renderPluginTable,
  resolveInstalledDir,
  resolveSpecPackageName,
  walkDependencyClosure,
} from './pipeline.mjs'

/* ------------------------------------------------------------- 脚手架 */

const REAL_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
- id: skin
  name: dsh-skin
  disabled: true
`

const REAL_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
allowBuilds:
  cloudflared: true
  sharp: ${BUILD_PLACEHOLDER}
`

/** 建一个临时 profile 目录，返回其路径与清理函数 */
function makeProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-test-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-t', private: true, dependencies: {} }, null, 2))
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), REAL_PATCH)
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), REAL_WORKSPACE)
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

/** 在 profile 里“装”一个包（照 pnpm 的结果写 package.json 与 node_modules） */
function installPackage(profileDir, manifest, files = []) {
  const dir = path.join(profileDir, 'node_modules', manifest.name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  for (const file of files) fs.writeFileSync(path.join(dir, file), '')
  const profileManifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  profileManifest.dependencies = { ...profileManifest.dependencies, [manifest.name]: manifest.version ?? '1.0.0' }
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(profileManifest, null, 2))
}

/** 收集日志的 ctx */
function makeCtx(profileDir, overrides = {}) {
  const logs = []
  const warns = []
  return {
    ctx: {
      profileDir,
      cwd: profileDir,
      stamp: 'teststamp',
      log: (line) => logs.push(line),
      warn: (line) => warns.push(line),
      runPnpmRemove: () => 0,
      ...overrides,
    },
    logs,
    warns,
  }
}

/* ------------------------------------------------ 纯函数：spec 解析与 diff */

test('resolveSpecPackageName 解析 file: 与相对路径形态', () => {
  const { dir, cleanup } = makeProfile()
  try {
    const local = path.join(dir, 'local-plugin')
    fs.mkdirSync(local, { recursive: true })
    fs.writeFileSync(path.join(local, 'package.json'), JSON.stringify({ name: 'local-plugin', version: '1.0.0' }))
    assert.equal(resolveSpecPackageName(dir, `file:${local}`, dir), 'local-plugin')
    assert.equal(resolveSpecPackageName(dir, './local-plugin', dir), 'local-plugin')
    assert.equal(resolveSpecPackageName(dir, 'dsh-plugin-tlmemory', dir), 'dsh-plugin-tlmemory')
    assert.equal(resolveSpecPackageName(dir, '@scope/pkg@^2.0.0', dir), '@scope/pkg')
    assert.equal(resolveSpecPackageName(dir, 'npm:other-pkg@1', dir), 'other-pkg')
    // 远端 / 归档形态交给依赖 diff
    assert.equal(resolveSpecPackageName(dir, 'github:user/repo#abc', dir), undefined)
    assert.equal(resolveSpecPackageName(dir, 'https://x/y.tgz', dir), undefined)
  } finally {
    cleanup()
  }
})

test('diffDependencies 只报新增项', () => {
  const added = diffDependencies({ dependencies: { a: '1' } }, { dependencies: { a: '1', b: '2' } })
  assert.deepEqual(added, ['b'])
})

/* ------------------------------------------------------------- add 管线 */

test('add：给声明了 dsh 元数据的插件自动落补丁，并放行原生模块', () => {
  const { dir, cleanup } = makeProfile()
  try {
    // 模拟 pnpm 刚装好：插件 + 它的原生依赖 better-sqlite3
    installPackage(dir, { name: 'better-sqlite3', version: '11.8.0', scripts: { install: 'prebuild-install || node-gyp rebuild' }, dependencies: {} })
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: { platform: 'web' } }, dependencies: { 'better-sqlite3': '^11.8.0' } })

    const { ctx } = makeCtx(dir)
    const summary = applyAddWrites(ctx, ['dsh-plugin-tlmemory'], { mount: true })

    // 补丁写入
    assert.equal(summary.mounts[0].action, 'insert')
    assert.ok(summary.mounts[0].block.includes('id: "dsh-plugin-tlmemory"'))
    assert.ok(summary.mounts[0].block.includes('name: "dsh-plugin-tlmemory"'))
    const after = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    assert.ok(findMountedEntry(after, 'dsh-plugin-tlmemory'))
    // 原文件表头与既有项保持原样
    assert.ok(after.startsWith(REAL_PATCH.trimEnd()))
    // 备份生成
    assert.ok(summary.backups.some((file) => file.endsWith('cordis.patch.yml.bak-dsh-plugin-teststamp')))

    // 原生模块放行：闭包探测到 better-sqlite3
    assert.deepEqual(summary.allow.added, ['better-sqlite3'])
    const ws = fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')
    assert.ok(ws.includes('better-sqlite3: true'))
    // 不相关的占位项不动
    assert.ok(ws.includes(`sharp: ${BUILD_PLACEHOLDER}`))
  } finally {
    cleanup()
  }
})

test('add：幂等 —— 已挂载的插件不重复插入', () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    const { ctx } = makeCtx(dir)
    applyAddWrites(ctx, ['dsh-plugin-tlmemory'], { mount: true })
    const first = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    assert.equal(listMountedEntries(first).length, 1)

    const { ctx: ctx2 } = makeCtx(dir)
    const second = applyAddWrites(ctx2, ['dsh-plugin-tlmemory'], { mount: true })
    assert.equal(second.mounts[0].action, 'skip-mounted')
    const after = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    assert.equal(after, first)
    assert.equal(listMountedEntries(after).length, 1)
  } finally {
    cleanup()
  }
})

test('add：bundle 类插件交给层栈托管，不写补丁', () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-context', version: '0.47.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    const { ctx } = makeCtx(dir)
    const summary = applyAddWrites(ctx, ['dsh-context'], { mount: true })
    assert.equal(summary.mounts[0].action, 'skip-bundle')
    assert.ok(!findMountedEntry(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), 'dsh-context'))
  } finally {
    cleanup()
  }
})

test('add：普通库只提示、绝不自动挂载（挂错会让 profile 起不来）', () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'lodash', version: '4.17.21' })
    const { ctx, warns } = makeCtx(dir)
    const summary = applyAddWrites(ctx, ['lodash'], { mount: true })
    assert.equal(summary.mounts[0].action, 'skip-library')
    assert.ok(!findMountedEntry(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), 'lodash'))
    assert.deepEqual(warns, [])
  } finally {
    cleanup()
  }
})

test('add：--no-mount 与自定义 --id/--config', () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-x', version: '1.0.0', dsh: { client: {} } })
    const { ctx } = makeCtx(dir)
    const skipped = applyAddWrites(ctx, ['dsh-plugin-x'], { mount: false })
    assert.equal(skipped.mounts[0].action, 'skip-flag')

    const { ctx: ctx2 } = makeCtx(dir)
    applyAddWrites(ctx2, ['dsh-plugin-x'], { mount: true, id: 'my-x', config: { serverEnabled: true, port: 4891 } })
    const text = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    assert.ok(text.includes('id: "my-x"'))
    assert.ok(text.includes('serverEnabled: true'))
    assert.ok(text.includes('port: 4891'))
    assert.equal(listMountedEntries(text)[0].id, 'my-x')
  } finally {
    cleanup()
  }
})

test('add：--dry-run 不产生任何写入', () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-dry', version: '1.0.0', dsh: { client: {} } })
    const patchBefore = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    const wsBefore = fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')
    const { ctx } = makeCtx(dir)
    const summary = applyAddWrites(ctx, ['dsh-plugin-dry'], { mount: true, dryRun: true })
    assert.equal(summary.mounts[0].action, 'insert')
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), patchBefore)
    assert.equal(fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8'), wsBefore)
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.bak-')).length, 0)
  } finally {
    cleanup()
  }
})

test('add：pnpm 的 pendingBuilds 在本闭包内也被认可（含 git 型构建）', () => {
  const { dir, cleanup } = makeProfile()
  try {
    // 该包没有 install 脚本也没有 binding.gyp → 我方判定看不到，只能靠 pendingBuilds
    installPackage(dir, { name: 'git-hosted-plugin', version: '1.0.0', dsh: { client: {} }, dependencies: { helper: '1.0.0' } })
    installPackage(dir, { name: 'helper', version: '1.0.0' })
    fs.writeFileSync(
      path.join(dir, 'node_modules', '.modules.yaml'),
      JSON.stringify({ pendingBuilds: ['helper', 'unrelated-pkg'], allowBuilds: {} }, null, 2),
    )
    const { ctx, warns } = makeCtx(dir)
    const summary = applyAddWrites(ctx, ['git-hosted-plugin'], { mount: true })
    assert.deepEqual(summary.allow.added, ['helper'])
    // 与本次无关的待批项只提示、不代用户批准
    assert.ok(warns.some((line) => line.includes('unrelated-pkg')))
    const ws = fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')
    assert.ok(ws.includes('helper: true'))
    assert.ok(!ws.includes('unrelated-pkg'))
  } finally {
    cleanup()
  }
})

test('add：allowBuilds 里用户显式 false 不被覆盖', () => {
  const { dir, cleanup } = makeProfile()
  try {
    fs.writeFileSync(
      path.join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - .\nallowBuilds:\n  better-sqlite3: false\n',
    )
    installPackage(dir, { name: 'better-sqlite3', version: '11.8.0', scripts: { install: 'node-gyp rebuild' } })
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} }, dependencies: { 'better-sqlite3': '^11' } })
    const { ctx, warns } = makeCtx(dir)
    applyAddWrites(ctx, ['dsh-plugin-tlmemory'], { mount: true })
    const ws = fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')
    assert.ok(ws.includes('better-sqlite3: false'))
    assert.ok(warns.some((line) => line.includes('better-sqlite3')))
  } finally {
    cleanup()
  }
})

/* ---------------------------------------------------------- remove 管线 */

test('remove：先摘补丁再卸依赖，且清掉专属注释', () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    const { ctx } = makeCtx(dir)
    applyAddWrites(ctx, ['dsh-plugin-tlmemory'], { mount: true })

    const calls = []
    const { ctx: ctx2 } = makeCtx(dir, { runPnpmRemove: (names) => (calls.push(names), 0) })
    const result = applyRemoveWrites(ctx2, ['dsh-plugin-tlmemory'], {})
    assert.equal(result.removed[0].removed, 1)
    assert.deepEqual(calls, [['dsh-plugin-tlmemory']])
    const after = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    assert.equal(findMountedEntry(after, 'dsh-plugin-tlmemory'), undefined)
    // 既有的 skin 覆盖项与文件表头必须留下
    assert.ok(after.includes('name: dsh-skin'))
    assert.ok(after.includes('# Your patch layer for this dsh profile'))
    assert.ok(result.backups.length > 0)
  } finally {
    cleanup()
  }
})

test('remove：未挂载的包不写文件、不报错', () => {
  const { dir, cleanup } = makeProfile()
  try {
    const before = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    const { ctx } = makeCtx(dir)
    const result = applyRemoveWrites(ctx, ['not-mounted'], {})
    assert.equal(result.removed[0].removed, 0)
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), before)
    assert.equal(result.backups.length, 0)
  } finally {
    cleanup()
  }
})

/* ------------------------------------------------------------ list 视图 */

test('list：区分层栈 / 补丁挂载 / 未挂载 / 仅依赖 / 悬空挂载', () => {
  const { dir, cleanup } = makeProfile()
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    manifest.dependencies = {
      'dsh-context': '0.47.0',
      'dsh-plugin-tlmemory': '0.2.2',
      'dsh-plugin-loose': '1.0.0',
      lodash: '4.17.21',
    }
    manifest.dsh = { profile: { bundles: ['dsh-context'] } }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
    installPackage(dir, { name: 'dsh-context', version: '0.47.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    installPackage(dir, { name: 'dsh-plugin-loose', version: '1.0.0', dsh: { client: {} } })
    installPackage(dir, { name: 'lodash', version: '4.17.21' })

    const { ctx } = makeCtx(dir)
    applyAddWrites(ctx, ['dsh-plugin-tlmemory'], { mount: true })
    // 悬空挂载：补丁里挂了但依赖里没有
    fs.appendFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: ghost\n      name: "ghost-plugin"\n')

    const status = collectPluginStatus(dir)
    const byName = Object.fromEntries(status.rows.map((row) => [row.name, row.state]))
    assert.equal(byName['dsh-context'], 'layers')
    assert.equal(byName['dsh-plugin-tlmemory'], 'patched')
    assert.equal(byName['dsh-plugin-loose'], 'unmounted')
    assert.equal(byName.lodash, 'dep-only')
    assert.equal(byName['ghost-plugin'], 'dangling')

    const table = renderPluginTable(dir, status.rows)
    assert.ok(table.includes('层栈'))
    assert.ok(table.includes('悬空挂载'))
    assert.ok(table.includes('dsh plugin remove'))
  } finally {
    cleanup()
  }
})

/* ------------------------------------------------------- 读取与闭包工具 */

test('readModules 容忍缺失与非法内容', () => {
  const { dir, cleanup } = makeProfile()
  try {
    assert.deepEqual(readModules(dir), { pendingBuilds: [], allowBuilds: {} })
    fs.writeFileSync(path.join(dir, 'node_modules', '.modules.yaml'), '{ 坏 JSON')
    assert.deepEqual(readModules(dir), { pendingBuilds: [], allowBuilds: {} })
  } finally {
    cleanup()
  }
})

test('walkDependencyClosure 走依赖树并标出需要构建的包', () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'root-plugin', version: '1.0.0', dependencies: { mid: '1' } })
    installPackage(dir, { name: 'mid', version: '1.0.0', dependencies: { 'native-leaf': '1' } })
    installPackage(dir, { name: 'native-leaf', version: '1.0.0' }, ['binding.gyp'])
    const { nodes, natives } = walkDependencyClosure(dir, ['root-plugin'])
    assert.deepEqual([...nodes].sort(), ['mid', 'native-leaf', 'root-plugin'])
    assert.deepEqual([...natives], ['native-leaf'])
  } finally {
    cleanup()
  }
})

/** 在 .pnpm/<encoded>@<ver>/node_modules/<name> 里造一个包（isolated 链接布局） */
function installIsolated(profileDir, manifest, files = []) {
  const encoded = manifest.name.startsWith('@') ? manifest.name.replace('/', '+') : manifest.name
  const dir = path.join(profileDir, 'node_modules', '.pnpm', `${encoded}@${manifest.version}`, 'node_modules', manifest.name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  for (const file of files) fs.writeFileSync(path.join(dir, file), '')
  return dir
}

test('resolveInstalledDir 兼容 pnpm 默认 isolated 布局（传递依赖不在顶层）', () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'root-plugin', version: '1.0.0', dependencies: { 'native-leaf': '1' } })
    installIsolated(dir, { name: 'native-leaf', version: '1.2.3' }, ['binding.gyp'])
    // 顶层没有 native-leaf，只有 root-plugin
    assert.deepEqual(fs.readdirSync(path.join(dir, 'node_modules')).filter((f) => f === 'native-leaf'), [])
    assert.ok(resolveInstalledDir(dir, 'native-leaf')?.includes('.pnpm'))
    const { nodes, natives } = walkDependencyClosure(dir, ['root-plugin'])
    assert.ok(nodes.has('native-leaf'))
    assert.deepEqual([...natives], ['native-leaf'])
  } finally {
    cleanup()
  }
})

test('resolveInstalledDir 支持 scope 包的 .pnpm 编码（@scope/name → @scope+name）', () => {
  const { dir, cleanup } = makeProfile()
  try {
    const installed = installIsolated(dir, { name: '@scope/native', version: '2.0.0' }, ['binding.gyp'])
    assert.equal(resolveInstalledDir(dir, '@scope/native'), installed)
  } finally {
    cleanup()
  }
})

test('add：本次安装新出现的 allowBuilds 占位项被自动批准，历史占位项不动', () => {
  const { dir, cleanup } = makeProfile()
  try {
    // 历史遗留占位项（与本次无关，必须留着）；本包自身无需构建（无 install 脚本）
    fs.writeFileSync(
      path.join(dir, 'pnpm-workspace.yaml'),
      `packages:\n  - .\nallowBuilds:\n  heavy-old-native: ${BUILD_PLACEHOLDER}\n`,
    )
    installPackage(dir, { name: 'dsh-plugin-gitish', version: '1.0.0', dsh: { client: {} } })
    // pnpm 在本次安装后新增了一条占位项（git 型 prepare 脚本，我方判定看不到）
    fs.writeFileSync(
      path.join(dir, 'pnpm-workspace.yaml'),
      `packages:\n  - .\nallowBuilds:\n  heavy-old-native: ${BUILD_PLACEHOLDER}\n  fromthis-install: ${BUILD_PLACEHOLDER}\n`,
    )
    const { ctx } = makeCtx(dir)
    // 模拟 runPluginCommand：安装前先取一次占位快照
    const pre = ['heavy-old-native']
    applyAddWrites({ ...ctx }, ['dsh-plugin-gitish'], { mount: true, preInstallPlaceholders: pre })
    const ws = fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')
    assert.ok(ws.includes('fromthis-install: true'), ws)
    assert.ok(ws.includes(`heavy-old-native: ${BUILD_PLACEHOLDER}`), ws)
  } finally {
    cleanup()
  }
})

test('readProfileManifest 对缺失文件返回空对象', () => {
  assert.deepEqual(readProfileManifest(path.join(os.tmpdir(), 'definitely-missing-dir-xyz')), {})
})
