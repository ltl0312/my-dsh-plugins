// tools/dsh-plugin-cmd/command.test.mjs
// 命令分发层单测：参数决策表 + add/remove/list 全链路（含阶段日志、失败兜底）。
// api 用假实现注入，profile 目录是真的临时目录，因此这里验证的是真实落盘行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { findMountedEntry, parsePluginSubcommand, pluginHelpText } from './core.mjs'
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

test('parsePluginSubcommand：空参数与 --help 都走帮助', () => {
  assert.equal(parsePluginSubcommand([]).kind, 'help')
  assert.equal(parsePluginSubcommand([]).reason, 'empty')
  assert.equal(parsePluginSubcommand(['--help']).kind, 'help')
  assert.equal(parsePluginSubcommand(['-h']).kind, 'help')
  assert.equal(parsePluginSubcommand(['help']).kind, 'help')
})

test('parsePluginSubcommand：add 抽出自身旗标、其余留给 pnpm', () => {
  const parsed = parsePluginSubcommand(['add', 'pkg-a', '--id', 'my-id', '-D', '--config={"a":1}', 'pkg-b', '--dry-run'])
  assert.equal(parsed.kind, 'add')
  assert.equal(parsed.own.id, 'my-id')
  assert.equal(parsed.own.dryRun, true)
  assert.deepEqual(parsed.own.configRaw, '{"a":1}')
  assert.deepEqual(parsed.specs, ['pkg-a', '-D', 'pkg-b'])
  assert.equal(parsed.own.mount, true)
})

test('parsePluginSubcommand：--no-mount 与 --config 空格写法', () => {
  const parsed = parsePluginSubcommand(['add', 'pkg', '--no-mount', '--config', '{"x":2}'])
  assert.equal(parsed.own.mount, false)
  assert.equal(parsed.own.configRaw, '{"x":2}')
})

test('parsePluginSubcommand：remove 支持 rm / uninstall 别名', () => {
  for (const alias of ['remove', 'rm', 'uninstall']) {
    const parsed = parsePluginSubcommand([alias, 'pkg-a'])
    assert.equal(parsed.kind, 'remove')
    assert.deepEqual(parsed.specs, ['pkg-a'])
  }
  assert.equal(parsePluginSubcommand(['rm', 'pkg', '--dry-run']).own.dryRun, true)
})

test('parsePluginSubcommand：list 保留多余参数（兼容旧的 pnpm list 用法）', () => {
  const parsed = parsePluginSubcommand(['list', '--depth', '0'])
  assert.equal(parsed.kind, 'list')
  assert.deepEqual(parsed.extra, ['--depth', '0'])
  assert.equal(parsePluginSubcommand(['ls']).kind, 'list')
})

test('parsePluginSubcommand：其余子命令一律原样透传给 pnpm', () => {
  for (const sub of ['why', 'update', 'outdated', 'install', 'approve-builds']) {
    const parsed = parsePluginSubcommand([sub, 'pkg'])
    assert.equal(parsed.kind, 'passthrough')
    assert.deepEqual(parsed.args, [sub, 'pkg'])
  }
})

test('pluginHelpText 覆盖 add / remove / list 与三步自动化', () => {
  const help = pluginHelpText('web')
  for (const token of ['add', 'remove', 'list', 'allowBuilds', 'cordis.patch.yml', '--dry-run', 'dsh plugin --profile web add']) {
    assert.ok(help.includes(token), `帮助文本缺少 ${token}`)
  }
})

/* ------------------------------------------------------------ 命令执行 */

test('runPluginCommand：--help 只打印帮助、不碰 pnpm', () => {
  const { dir, cleanup } = makeProfile()
  try {
    const { api, out, calls } = makeApi(dir)
    assert.equal(runPluginCommand({ profile: 'web', args: ['--help'], api }), 0)
    assert.ok(out.join('\n').includes('add'))
    assert.equal(calls.length, 0)
  } finally {
    cleanup()
  }
})

test('runPluginCommand：未知子命令原样转发（既有行为不变）', () => {
  const { dir, cleanup } = makeProfile()
  try {
    const { api, calls } = makeApi(dir)
    assert.equal(runPluginCommand({ profile: 'web', args: ['why', 'dsh-plugin-tlmemory'], api }), 0)
    assert.deepEqual(calls, [{ profile: 'web', pnpmArgs: ['why', 'dsh-plugin-tlmemory'] }])
  } finally {
    cleanup()
  }
})

test('runPluginCommand add：三步全链路（安装 → 放行 → 挂载）', () => {
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

    const code = runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory'], api })
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

test('runPluginCommand add：pnpm 失败时立刻中止、不写补丁', () => {
  const { dir, cleanup } = makeProfile()
  try {
    const before = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    const { api, err } = makeApi(dir, { pnpmExit: 1 })
    assert.equal(runPluginCommand({ profile: 'web', args: ['add', 'pkg'], api }), 1)
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), before)
    assert.ok(err.join('\n').includes('pnpm add 失败'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand add：pnpm 因拦下构建脚本返回非 0 时自动放行并重跑 install', () => {
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

    const code = runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory'], api })
    assert.equal(code, 0, '恢复成功应返回 0，而不是把 pnpm 的非 0 透出去')
    assert.deepEqual(calls, [['add', 'dsh-plugin-tlmemory'], ['install']])
    assert.ok(err.join('\n').includes('构建脚本'), err.join('\n'))

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

test('runPluginCommand add：--config 非法 JSON 在任何副作用之前失败', () => {
  const { dir, cleanup } = makeProfile()
  try {
    const before = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    const { api, err, calls } = makeApi(dir)
    assert.equal(runPluginCommand({ profile: 'web', args: ['add', 'pkg', '--config', '{oops'], api }), 1)
    assert.equal(calls.length, 0)
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), before)
    assert.ok(err.join('\n').includes('--config'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand add：缺少包名报错退出', () => {
  const { dir, cleanup } = makeProfile()
  try {
    const { api, err, calls } = makeApi(dir)
    assert.equal(runPluginCommand({ profile: 'web', args: ['add'], api }), 1)
    assert.equal(calls.length, 0)
    assert.ok(err.join('\n').includes('至少一个包名'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand add：--dry-run 不执行 pnpm、不落盘', () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    const before = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    const { api, out, calls } = makeApi(dir)
    assert.equal(runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory', '--dry-run'], api }), 0)
    assert.equal(calls.length, 0)
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), before)
    assert.ok(out.join('\n').includes('--dry-run'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand add：已挂载则幂等跳过', () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    const mounted = `${PATCH_TEMPLATE}- insert:\n    - id: tlmemory-runtime\n      name: "dsh-plugin-tlmemory"\n`
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), mounted)
    const { api, out } = makeApi(dir)
    assert.equal(runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory'], api }), 0)
    assert.ok(out.join('\n').includes('已挂载，跳过'))
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), mounted)
  } finally {
    cleanup()
  }
})

test('runPluginCommand remove：摘补丁 + 转发 pnpm remove', () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } })
    const { api, out, calls } = makeApi(dir, {
      installOnAdd: { name: 'dsh-plugin-tlmemory', version: '0.2.2', dsh: { client: {} } },
    })
    runPluginCommand({ profile: 'web', args: ['add', 'dsh-plugin-tlmemory'], api })
    calls.length = 0
    out.length = 0

    assert.equal(runPluginCommand({ profile: 'web', args: ['remove', 'dsh-plugin-tlmemory'], api }), 0)
    assert.deepEqual(calls, [{ profile: 'web', pnpmArgs: ['remove', 'dsh-plugin-tlmemory'] }])
    const log = out.join('\n')
    assert.ok(log.includes('✔ 补丁摘除'), log)
    assert.ok(log.includes('✔ 依赖卸载完成'), log)
    assert.equal(findMountedEntry(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), 'dsh-plugin-tlmemory'), undefined)
  } finally {
    cleanup()
  }
})

test('runPluginCommand remove：--dry-run 只预览行范围', () => {
  const { dir, cleanup } = makeProfile()
  try {
    const mounted = `${PATCH_TEMPLATE}- insert:\n    - id: x\n      name: "pkg-x"\n`
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), mounted)
    const { api, out, calls } = makeApi(dir)
    assert.equal(runPluginCommand({ profile: 'web', args: ['remove', 'pkg-x', '--dry-run'], api }), 0)
    assert.equal(calls.length, 0)
    assert.equal(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), mounted)
    assert.ok(out.join('\n').includes('第 5-7 行'), out.join('\n'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand remove：未挂载也照常卸载依赖且不报错', () => {
  const { dir, cleanup } = makeProfile()
  try {
    const { api, out, calls } = makeApi(dir)
    assert.equal(runPluginCommand({ profile: 'web', args: ['remove', 'never-mounted'], api }), 0)
    assert.deepEqual(calls, [{ profile: 'web', pnpmArgs: ['remove', 'never-mounted'] }])
    assert.ok(out.join('\n').includes('没有挂载条目'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand list：打印状态表；带多余参数时兼容旧的 pnpm list 转发', () => {
  const { dir, cleanup } = makeProfile()
  try {
    installPackage(dir, { name: 'dsh-plugin-loose', version: '1.0.0', dsh: { client: {} } })
    const { api, out, calls } = makeApi(dir)
    assert.equal(runPluginCommand({ profile: 'web', args: ['list'], api }), 0)
    assert.equal(calls.length, 0)
    assert.ok(out.join('\n').includes('未挂载'))

    out.length = 0
    assert.equal(runPluginCommand({ profile: 'web', args: ['list', '--depth', '0'], api }), 0)
    assert.deepEqual(calls, [{ profile: 'web', pnpmArgs: ['list', '--depth', '0'] }])
    assert.ok(out.join('\n').includes('profile:'))
  } finally {
    cleanup()
  }
})

test('runPluginCommand：非法 profile 名由 api 抛错（不吞异常）', () => {
  const { dir, cleanup } = makeProfile()
  try {
    const { api } = makeApi(dir, { invalidProfile: true })
    assert.throws(() => runPluginCommand({ profile: '../etc', args: ['list'], api }), /invalid profile name/)
  } finally {
    cleanup()
  }
})
