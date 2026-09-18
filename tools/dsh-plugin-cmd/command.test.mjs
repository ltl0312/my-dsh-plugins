// tools/dsh-plugin-cmd/command.test.mjs
// 命令分发层单测：参数决策表 + add/remove/list 全链路（含阶段日志、失败兜底）。
// api 用假实现注入，profile 目录是真的临时目录，因此这里验证的是真实落盘行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  findForwardedProfileFlag,
  findMountedEntry,
  isInstallingSubcommand,
  parsePluginSubcommand,
  pluginHelpText,
} from './core.mjs'
import { DIAGNOSE_PREFIX, EXIT } from './forward.mjs'
import { runPluginCommand } from './pipeline.mjs'

/* ------------------------------------------------------------- 脚手架 */

const PATCH_TEMPLATE = `# profile 的补丁层
- id: skin
  name: dsh-skin
  disabled: true
`

function makeProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-cmd-test-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-t', private: true, dependencies: {} }, null, 2))
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), PATCH_TEMPLATE)
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function installPackage(profileDir, manifest, files = []) {
  const dir = path.join(profileDir, 'node_modules', manifest.name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  for (const file of files) fs.writeFileSync(path.join(dir, file), '')
  const profileManifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  profileManifest.dependencies = { ...profileManifest.dependencies, [manifest.name]: manifest.version ?? '1.0.0' }
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(profileManifest, null, 2))
}

/** 构造假的 api；forwardPnpm 记录调用，并模拟 pnpm 真的把依赖写进了 package.json */
function makeApi(profileDir, options = {}) {
  const out = []
  const err = []
  const calls = []
  return {
    out,
    err,
    calls,
    api: {
      cwd: profileDir,
      resolveProfileDir: (name) => {
        if (options.invalidProfile === true) throw new Error(`dsh: invalid profile name ${JSON.stringify(name)}`)
        return profileDir
      },
      forwardPnpm: (profile, pnpmArgs) => {
        calls.push({ profile, pnpmArgs })
        if (options.pnpmExit !== undefined) return options.pnpmExit
        if (pnpmArgs[0] === 'add' && options.installOnAdd !== undefined) {
          installPackage(profileDir, options.installOnAdd, options.installFiles ?? [])
        }
        return 0
      },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      now: () => new Date('2026-09-15T13:40:00'),
    },
  }
}

/* --------------------------------------------------------- 参数决策表 */

test('parsePluginSubcommand：空参数与 --help 都走帮助', async () => {
  assert.equal(parsePluginSubcommand([]).kind, 'help')
  assert.equal(parsePluginSubcommand([]).reason, 'empty')
  assert.equal(parsePluginSubcommand(['--help']).kind, 'help')
  assert.equal(parsePluginSubcommand(['-h']).kind, 'help')
  assert.equal(parsePluginSubcommand(['help']).kind, 'help')
})

test('parsePluginSubcommand：add 抽出自身旗标、其余留给 pnpm', async () => {
  const parsed = parsePluginSubcommand(['add', 'pkg-a', '--id', 'my-id', '-D', '--config={"a":1}', 'pkg-b', '--dry-run'])
  assert.equal(parsed.kind, 'add')
  assert.equal(parsed.own.id, 'my-id')
  assert.equal(parsed.own.dryRun, true)
  assert.deepEqual(parsed.own.configRaw, '{"a":1}')
  assert.deepEqual(parsed.specs, ['pkg-a', '-D', 'pkg-b'])
  assert.equal(parsed.own.mount, true)
})

test('parsePluginSubcommand：--no-mount 与 --config 空格写法', async () => {
  const parsed = parsePluginSubcommand(['add', 'pkg', '--no-mount', '--config', '{"x":2}'])
  assert.equal(parsed.own.mount, false)
  assert.equal(parsed.own.configRaw, '{"x":2}')
})

test('parsePluginSubcommand：remove 支持 rm / uninstall 别名', async () => {
  for (const alias of ['remove', 'rm', 'uninstall']) {
    const parsed = parsePluginSubcommand([alias, 'pkg-a'])
    assert.equal(parsed.kind, 'remove')
    assert.deepEqual(parsed.specs, ['pkg-a'])
  }
  assert.equal(parsePluginSubcommand(['rm', 'pkg', '--dry-run']).own.dryRun, true)
})

test('parsePluginSubcommand：list 保留多余参数（兼容旧的 pnpm list 用法）', async () => {
  const parsed = parsePluginSubcommand(['list', '--depth', '0'])
  assert.equal(parsed.kind, 'list')
  assert.deepEqual(parsed.extra, ['--depth', '0'])
  assert.equal(parsePluginSubcommand(['ls']).kind, 'list')
})

test('parsePluginSubcommand：其余子命令一律原样透传给 pnpm', async () => {
  for (const sub of ['why', 'update', 'outdated', 'install', 'approve-builds']) {
    const parsed = parsePluginSubcommand([sub, 'pkg'])
    assert.equal(parsed.kind, 'passthrough')
    assert.deepEqual(parsed.args, [sub, 'pkg'])
  }
})

test('pluginHelpText 覆盖 add / remove / list 与三步自动化', async () => {
  const help = pluginHelpText('web')
  for (const token of ['add', 'remove', 'list', 'allowBuilds', 'cordis.patch.yml', '--dry-run', 'dsh plugin --profile web add']) {
    assert.ok(help.includes(token), `帮助文本缺少 ${token}`)
  }
})

/* ------------------------------------------------------------ 命令执行 */

test('runPluginCommand：--help 只打印帮助、不碰 pnpm', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const { api, out, calls } = makeApi(dir)
    assert.equal(await runPluginCommand({ profile: 'web', args: ['--help'], api }), 0)
    assert.ok(out.join('\n').includes('add'))
    assert.equal(calls.length, 0)
  } finally {
    cleanup()
  }
})

test('runPluginCommand：未知子命令原样转发（既有行为不变）', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const { api, calls } = makeApi(dir)
    assert.equal(await runPluginCommand({ profile: 'web', args: ['why', 'dsh-plugin-tlmemory'], api }), 0)
    assert.deepEqual(calls, [{ profile: 'web', pnpmArgs: ['why', 'dsh-plugin-tlmemory'] }])
  } finally {
    cleanup()
  }
})

test('runPluginCommand add：三步全链路（安装 → 放行 → 挂载）', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const { api, out, calls } = makeApi(dir, {
      installOnAdd: { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: { platform: 'web' } }, dependencies: { 'better-sqlite3': '^11' } },
    })
    // 原生依赖随插件一起被 pnpm 装上
    installPackage(dir, { name: 'better-sqlite3', version: '11.8.0', scripts: { install: 'node-gyp rebuild' } })
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'dsh-profile-t', dependencies: { 'better-sqlite3': '^11' } }, null, 2),
    )

    const code = await runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory'], api })
    assert.equal(code, 0)
    assert.deepEqual(calls[0].pnpmArgs, ['add', 'dsh-plugin-tlmemory'])

    const log = out.join('\n')
    assert.ok(log.includes('✔ 依赖安装完成'), log)
    assert.ok(log.includes('✔ 原生模块放行'), log)
    assert.ok(log.includes('✔ 补丁声明挂载'), log)
    assert.ok(log.includes('better-sqlite3'))

    const patch = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    assert.ok(findMountedEntry(patch, 'dsh-plugin-tlmemory'))
    // 既有内容原样保留
    assert.ok(patch.includes('name: dsh-skin'))
    const ws = fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')
    assert.ok(ws.includes('better-sqlite3: true'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand add：pnpm 失败时立刻中止、不写补丁', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const before = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    const { api, err } = makeApi(dir, { pnpmExit: 1 })
    assert.equal(await runPluginCommand({ profile: 'web', args: ['add', 'pkg'], api }), 1)
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), before)
    assert.ok(err.join('\n').includes('pnpm add 失败'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand add：pnpm 因拦下构建脚本返回非 0 时自动放行并重跑 install', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    // 忠实复现实测到的 pnpm 行为：依赖已写入 package.json 与 node_modules、
    // pnpm-workspace.yaml 里出现占位值，但 **退出码是 1**（ERR_PNPM_IGNORED_BUILDS）。
    const calls = []
    const out = []
    const err = []
    const api = {
      cwd: dir,
      resolveProfileDir: () => dir,
      forwardPnpm: (profile, pnpmArgs) => {
        calls.push(pnpmArgs)
        if (pnpmArgs[0] === 'add') {
          installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} }, dependencies: { 'better-sqlite3': '^11' } })
          // 传递依赖只落在 node_modules（不进 profile 的 dependencies）
          const nativeDir = path.join(dir, 'node_modules', 'better-sqlite3')
          fs.mkdirSync(nativeDir, { recursive: true })
          fs.writeFileSync(
            path.join(nativeDir, 'package.json'),
            JSON.stringify({ name: 'better-sqlite3', version: '11.8.0', scripts: { install: 'node-gyp rebuild' } }),
          )
          fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'allowBuilds:\n  better-sqlite3: set this to true or false\n')
          return 1
        }
        return 0
      },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      now: () => new Date('2026-09-15T13:40:00'),
    }

    const code = await runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory'], api })
    assert.equal(code, 0, '恢复成功应返回 0，而不是把 pnpm 的非 0 透出去')
    assert.deepEqual(calls, [['add', 'dsh-plugin-tlmemory'], ['install']])
    assert.ok(err.join('\n').includes('已安装到 profile'), err.join('\n'))

    const log = out.join('\n')
    assert.ok(log.includes('✔ 原生模块放行'), log)
    assert.ok(log.includes('✔ 原生模块编译完成'), log)
    assert.ok(log.includes('✔ 补丁声明挂载'), log)
    assert.ok(fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8').includes('better-sqlite3: true'))
    assert.ok(findMountedEntry(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), 'dsh-plugin-tlmemory'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand add：--config 非法 JSON 在任何副作用之前失败', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const before = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    const { api, err, calls } = makeApi(dir)
    assert.equal(await runPluginCommand({ profile: 'web', args: ['add', 'pkg', '--config', '{oops'], api }), 1)
    assert.equal(calls.length, 0)
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), before)
    assert.ok(err.join('\n').includes('--config'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand add：缺少包名报错退出', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const { api, err, calls } = makeApi(dir)
    assert.equal(await runPluginCommand({ profile: 'web', args: ['add'], api }), 1)
    assert.equal(calls.length, 0)
    assert.ok(err.join('\n').includes('至少一个包名'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand add：--dry-run 不执行 pnpm、不落盘', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    const before = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    const { api, out, calls } = makeApi(dir)
    assert.equal(await runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory', '--dry-run'], api }), 0)
    assert.equal(calls.length, 0)
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), before)
    assert.ok(out.join('\n').includes('--dry-run'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand add：已挂载则幂等跳过', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    const mounted = `${PATCH_TEMPLATE}- insert:\n    - id: tlmemory-runtime\n      name: "dsh-plugin-tlmemory"\n`
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), mounted)
    const { api, out } = makeApi(dir)
    assert.equal(await runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory'], api }), 0)
    assert.ok(out.join('\n').includes('已挂载，跳过'))
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), mounted)
  } finally {
    cleanup()
  }
})

test('runPluginCommand remove：摘补丁 + 转发 pnpm remove', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    const { api, out, calls } = makeApi(dir, {
      installOnAdd: { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } },
    })
    await runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory'], api })
    calls.length = 0
    out.length = 0

    assert.equal(await runPluginCommand({ profile: 'web', args: ['remove', 'dsh-plugin-tlmemory'], api }), 0)
    assert.deepEqual(calls, [{ profile: 'web', pnpmArgs: ['remove', 'dsh-plugin-tlmemory'] }])
    const log = out.join('\n')
    assert.ok(log.includes('✔ 补丁摘除'), log)
    assert.ok(log.includes('✔ 依赖卸载完成'), log)
    assert.equal(findMountedEntry(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), 'dsh-plugin-tlmemory'), undefined)
  } finally {
    cleanup()
  }
})

test('runPluginCommand remove：--dry-run 只预览行范围', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const mounted = `${PATCH_TEMPLATE}- insert:\n    - id: x\n      name: "pkg-x"\n`
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), mounted)
    const { api, out, calls } = makeApi(dir)
    assert.equal(await runPluginCommand({ profile: 'web', args: ['remove', 'pkg-x', '--dry-run'], api }), 0)
    assert.equal(calls.length, 0)
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), mounted)
    assert.ok(out.join('\n').includes('第 5-7 行'), out.join('\n'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand remove：未挂载也照常卸载依赖且不报错', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const { api, out, calls } = makeApi(dir)
    assert.equal(await runPluginCommand({ profile: 'web', args: ['remove', 'never-mounted'], api }), 0)
    assert.deepEqual(calls, [{ profile: 'web', pnpmArgs: ['remove', 'never-mounted'] }])
    assert.ok(out.join('\n').includes('没有挂载条目'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand list：打印状态表；带多余参数时兼容旧的 pnpm list 转发', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-loose', version: '1.0.0', dsh: { client: {} } })
    const { api, out, calls } = makeApi(dir)
    assert.equal(await runPluginCommand({ profile: 'web', args: ['list'], api }), 0)
    assert.equal(calls.length, 0)
    assert.ok(out.join('\n').includes('未挂载'))

    out.length = 0
    assert.equal(await runPluginCommand({ profile: 'web', args: ['list', '--depth', '0'], api }), 0)
    assert.deepEqual(calls, [{ profile: 'web', pnpmArgs: ['list', '--depth', '0'] }])
    assert.ok(out.join('\n').includes('profile:'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand：非法 profile 名由 api 抛错（不吞异常）', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const { api } = makeApi(dir, { invalidProfile: true })
    await assert.rejects(runPluginCommand({ profile: '../etc', args: ['list'], api }), /invalid profile name/)
  } finally {
    cleanup()
  }
})

/* ------------------------------------------- P1-3：--profile 的位置与重复 */

test('findForwardedProfileFlag / isInstallingSubcommand 判定表', async () => {
  assert.equal(findForwardedProfileFlag(['add', 'pkg']), undefined)
  assert.equal(findForwardedProfileFlag(['add', 'pkg', '--profile=1']), '--profile=1')
  assert.equal(findForwardedProfileFlag(['add', '--profile', '1']), '--profile')
  for (const sub of ['install', 'i', 'add', 'update', 'up']) assert.equal(isInstallingSubcommand([sub]), true)
  for (const sub of ['why', 'list', 'outdated', 'approve-builds']) assert.equal(isInstallingSubcommand([sub]), false)
  assert.equal(isInstallingSubcommand([]), false)
})

test('P1-3：--profile 出现在子命令之后一律显式失败（既不放行也不改道）', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    for (const argv of [
      ['add', 'pkg', '--profile=1'],
      ['install', '--profile', '1'],
      ['why', 'pkg', '--profile=evil'],
    ]) {
      const { api, err, calls } = makeApi(dir)
      assert.equal(await runPluginCommand({ profile: 'web', args: argv, api }), 1)
      assert.equal(calls.length, 0, '任何 pnpm 调用都不该发生')
      assert.ok(err.join('\n').includes('不能出现在子命令之后'), err.join('\n'))
    }
  } finally {
    cleanup()
  }
})

/* ------------------------------------------- P1-2：装了但不生效的审计接线 */

test('P1-2：passthrough 里改动依赖的子命令会做激活审计并打印稳定前缀诊断', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const out = []
    const err = []
    const calls = []
    const api = {
      cwd: dir,
      resolveProfileDir: () => dir,
      forwardPnpm: (profile, pnpmArgs) => {
        calls.push(pnpmArgs)
        return 0
      },
      audit: () => ({
        hints: [{ name: 'dsh-plugin-tlmemory', code: 'client-plugin-not-activated', detail: '已安装但未挂载' }],
        unresolved: [],
      }),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      now: () => new Date('2026-09-15T13:40:00'),
    }
    assert.equal(await runPluginCommand({ profile: 'web', args: ['install'], api }), 0)
    assert.deepEqual(calls, [['install']])
    assert.ok(out.length >= 0)
    assert.ok(
      err.join('\n').includes(`${DIAGNOSE_PREFIX} client-plugin-not-activated: dsh-plugin-tlmemory`),
      err.join('\n'),
    )

    // 查询类子命令不产生噪音
    err.length = 0
    assert.equal(await runPluginCommand({ profile: 'web', args: ['why', 'pkg'], api }), 0)
    assert.deepEqual(err, [])
  } finally {
    cleanup()
  }
})

test('P1-2：审计发现状态未知的依赖时以退出码 4 结束', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const { api: baseApi, err } = makeApi(dir)
    const api = {
      ...baseApi,
      audit: () => ({
        hints: [],
        unresolved: [{ name: '@furongjun1999/dsh-memory', code: 'dependency-unresolved', detail: '解析不到包目录' }],
      }),
    }
    assert.equal(await runPluginCommand({ profile: 'web', args: ['install'], api }), EXIT.reconcileInconsistent)
    assert.ok(err.join('\n').includes('dependency-unresolved'), err.join('\n'))
  } finally {
    cleanup()
  }
})

test('P1-2：add 完成后同样做一次审计，且拿到的是写入之后的补丁正文', async () => {  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    const auditCalls = []
    const { api: baseApi } = makeApi(dir)
    const api = {
      ...baseApi,
      audit: (input) => {
        auditCalls.push(input.mountText)
        return { hints: [], unresolved: [] }
      },
    }
    assert.equal(await runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory'], api }), 0)
    assert.equal(auditCalls.length, 1)
    assert.ok(auditCalls[0].includes('dsh-plugin-tlmemory'), auditCalls[0])
  } finally {
    cleanup()
  }
})

test('--dry-run 面对解析不到的依赖不崩溃（也给出结构化诊断而非原始异常）', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    manifest.dependencies = { ghost: '1.0.0' }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
    const { api, err, out } = makeApi(dir)
    const code = await runPluginCommand({ profile: 'web', args: ['add', 'ghost', '--dry-run'], api })
    assert.equal(code, 0, '未安装的依赖在 dry-run 下只是无可预览，不是错误')
    assert.ok(out.join('\n').includes('--dry-run'), out.join('\n'))
    assert.ok(!err.join('\n').includes('must be of type string'), err.join('\n'))
  } finally {
    cleanup()
  }
})

/* ------------------------------------- --json 契约：结构化报告（建议 #9） */
/** 在既有 api 上挂一个报告收集器 */
function withReport(api) {
  const reports = []
  return { api: { ...api, report: (report) => reports.push(report) }, reports }
}

test('--json 契约：add 的管线报告带 phase / 挂载 / 放行 / 防重复诊断', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    const base = makeApi(dir)
    const { api, reports } = withReport(base.api)
    const code = await runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory', '--json'], api })
    assert.equal(code, 0)
    assert.equal(reports.length, 1)
    const report = reports[0]
    assert.equal(report.command, 'plugin')
    assert.equal(report.phase, 'add')
    assert.equal(report.exitCode, 0)
    assert.equal(report.profile, 'web')
    assert.equal(report.profileDir, dir)
    assert.deepEqual(report.targets, ['dsh-plugin-tlmemory'])
    const mount = report.mounts.find((item) => item.name === 'dsh-plugin-tlmemory')
    assert.equal(mount.action, 'insert')
    assert.equal(mount.id, 'dsh-plugin-tlmemory')
    assert.deepEqual(report.allowBuilds, { added: [], approved: [], skipped: [] })
    assert.ok(Number.isFinite(report.durationMs))
    // 报告里不该出现 undefined 之外的意外键；关键字段必须可 JSON 序列化
    assert.doesNotThrow(() => JSON.stringify(report))
  } finally {
    cleanup()
  }
})

test('--json 契约：list 报告带 rows 与 bundles；passthrough 报告带 phase', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    const listBase = withReport(makeApi(dir).api)
    await runPluginCommand({ profile: 'web', args: ['list'], api: listBase.api })
    const listReport = listBase.reports[0]
    assert.equal(listReport.phase, 'list')
    assert.equal(listReport.rows.length, 1)
    assert.equal(listReport.rows[0].state, 'unmounted')
    assert.deepEqual(listReport.bundles, [])

    const passBase = withReport(makeApi(dir).api)
    await runPluginCommand({ profile: 'web', args: ['why', 'pkg'], api: passBase.api })
    assert.equal(passBase.reports[0].phase, 'passthrough')
  } finally {
    cleanup()
  }
})

test('--json 契约：报告里的诊断与 stderr 的 dsh: diagnose: 行一一对应', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const base = makeApi(dir)
    const { api, reports } = withReport({
      ...base.api,
      audit: () => ({
        hints: [{ name: 'demo-client', code: 'client-plugin-not-activated', detail: '已安装但未挂载' }],
        unresolved: [],
      }),
    })
    await runPluginCommand({ profile: 'web', args: ['install'], api })
    const report = reports[0]
    assert.deepEqual(
      report.diagnostics.map((item) => item.code),
      ['client-plugin-not-activated'],
    )
    assert.ok(
      base.err.join('\n').includes(`${DIAGNOSE_PREFIX} client-plugin-not-activated: demo-client`),
      base.err.join('\n'),
    )
  } finally {
    cleanup()
  }
})

test('全局旗标：--timeout 非法值在任何动作之前失败并给出用法错误', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    const base = makeApi(dir)
    const { api, reports } = withReport(base.api)
    const code = await runPluginCommand({ profile: 'web', args: ['add', 'pkg', '--timeout=ten'], api })
    assert.equal(code, 1)
    assert.equal(base.calls.length, 0, '非法旗标不得触发 pnpm')
    assert.equal(reports.length, 1)
    assert.equal(reports[0].exitCode, 1)
  } finally {
    cleanup()
  }
})

test('全局旗标：--json 出现在 add 的 spec 位置时不会被当成包名', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'demo-lib', version: '1.0.0' })
    const base = makeApi(dir)
    const { api } = withReport(base.api)
    const code = await runPluginCommand({ profile: 'web', args: ['add', '--json', 'demo-lib'], api })
    assert.equal(code, 0)
    assert.deepEqual(base.calls[0].pnpmArgs, ['add', 'demo-lib'], '--json 不能被当作 spec 转发给 pnpm')
  } finally {
    cleanup()
  }
})

/* --------------------------------- 前置条件失败不得被「已落盘」启发式掩盖 */

test('前置条件失败（锁被占用 / 用法错误）时 add 必须中止，不得当成「构建被拦下」继续', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    // 目标依赖「已落盘」，正是会触发继续启发式的形态
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    const before = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    const cases = [
      ['lock-held', EXIT.usage],
      ['timeout', EXIT.timeout],
      ['manifest-invalid', EXIT.manifestInvalid],
      ['pnpm-not-found', EXIT.pnpmMissing],
    ]
    for (const [blocked, exitCode] of cases) {
      const base = makeApi(dir)
      const api = {
        ...base.api,
        forwardPnpm: () => exitCode,
        lastForward: () => ({ exitCode, blocked }),
      }
      const { api: reported, reports } = withReport(api)
      const code = await runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory'], api: reported })
      assert.equal(code, exitCode, `${blocked} 必须原样中止`)
      assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), before, '中止时不得写补丁')
      assert.ok(
        base.err.join('\n').includes('前置条件未满足'),
        `${blocked} 的报错应说明是前置条件问题：${base.err.join('\n')}`,
      )
      assert.equal(reports[0].exitCode, exitCode)
    }
  } finally {
    cleanup()
  }
})

test('pnpm 自己的退出码 1 不被误判为前置条件失败（仍走「已落盘则继续修复」）', async () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    const calls = []
    const base = makeApi(dir)
    const api = {
      ...base.api,
      forwardPnpm: (profile, pnpmArgs) => {
        calls.push(pnpmArgs)
        if (pnpmArgs[0] === 'add') {
          // 复现 ERR_PNPM_IGNORED_BUILDS 的落盘效果：占位值出现、退出码为 1
          fs.writeFileSync(
            path.join(dir, 'pnpm-workspace.yaml'),
            'allowBuilds:\n  better-sqlite3: set this to true or false\n',
          )
          return 1
        }
        return 0
      },
      // 没跑过 pnpm 的标记为 undefined ⇒ 说明这次 1 来自 pnpm 本身
      lastForward: () => ({ exitCode: 1, blocked: undefined }),
      audit: () => ({ hints: [], unresolved: [] }),
    }
    const code = await runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory'], api })
    assert.equal(code, 0, '识别为可修复路径后应恢复成功')
    assert.deepEqual(calls, [
      ['add', 'dsh-plugin-tlmemory'],
      ['install'],
    ])
    assert.ok(fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8').includes('better-sqlite3: true'))
  } finally {
    cleanup()
  }
})
