// tools/dsh-plugin-cmd/forward.test.mjs
// 转发器单测：覆盖评审 §6.1 #16 列出的全部复现位点 —— 非法 JSON 清单、包目录缺失、
// 含空格 spec、`&` / `^` 元字符、pnpm 缺失、非 0 退出、`.` / `file:.` 锚定 —— 以及
// P2/P3 新增的失败分类、`-w` 注入、超时、锁、备份、无模板 profile 的确认闸门。
// 默认用假 pnpm（可控探针）驱动；P0-2 的那一条走**真实 spawn**（把 argv 写进文件核对），
// 因此这里既验证实现细节，也验证真实行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  EXIT,
  ProfileManifestError,
  acquireLock,
  anchorArgs,
  anchorPathSpec,
  auditActivation,
  dependencyState,
  emptyReport,
  mergeRunReports,
  reconcileBundles,
  runForward,
  writeManifestAtomic,
} from './forward.mjs'
import { LOCK_FILENAME } from './core.mjs'
import { runPnpm } from './pnpm.mjs'

/* ------------------------------------------------------------- 脚手架 */

/**
 * 一个最小的 app-boot 替身：语义与官方一致（清单非法 JSON 直接抛、bundle 解析
 * 先 profile 目录、initProfile 写模板 bundles），但只认临时目录。
 */
function makeBoot(root) {
  return {
    resolveProfileDir: (name) => path.join(root, 'profiles', name),
    readProfileManifest: (binName, dir) => {
      const file = path.join(dir, 'package.json')
      let raw
      try {
        raw = fs.readFileSync(file, 'utf8')
      } catch (error) {
        throw new Error(`${binName}: failed to read profile manifest ${file}: ${String(error)}`)
      }
      // 故意不包 try：与官方一致，非法 JSON 以 SyntaxError 抛出
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${binName}: profile manifest ${file} must hold a JSON object`)
      }
      return parsed
    },
    writeProfileManifest: (dir, manifest) => {
      fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
    },
    resolveBundleDir: (binName, name, anchor, dir) => {
      const candidate = path.join(dir, 'node_modules', name)
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
      throw new Error(`${binName}: cannot resolve profile bundle ${JSON.stringify(name)}`)
    },
    initProfile: (dir, bundles, patchReload = 'startup') => {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        `${JSON.stringify(
          {
            name: `dsh-profile-${path.basename(dir)}`,
            private: true,
            dependencies: {},
            dsh: { profile: { bundles: [...bundles], patchReload } },
          },
          undefined,
          2,
        )}\n`,
      )
      fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    },
    DEFAULT_PROFILE_BUNDLES: ['@deepseek-ai/dsh-base'],
    PROFILE_TEMPLATES: {
      web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' },
    },
  }
}

function makeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-forward-test-'))
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** 写一个 profile 的 package.json（默认附 workspace root 形态的 pnpm-workspace.yaml） */
function writeProfile(root, name, manifest, options = {}) {
  const dir = path.join(root, 'profiles', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  if (options.workspaceRoot !== false) {
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), options.workspaceYaml ?? 'packages:\n  - .\n')
  }
  return dir
}

/** 在 profile 的 node_modules 下放一个包 */
function installDep(profileDir, manifest, rawText) {
  const dir = path.join(profileDir, 'node_modules', manifest.name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), rawText ?? `${JSON.stringify(manifest, undefined, 2)}\n`)
  return dir
}

/** 直接改写 profile 清单里的 dependencies */
function setDependencies(profileDir, dependencies) {
  const file = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  manifest.dependencies = dependencies
  fs.writeFileSync(file, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

/** 读 profile 清单里的 bundles */
function bundlesOf(profileDir) {
  return JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles
}

/** 收集三个输出通道 */
function makeSink() {
  const log = []
  const warn = []
  const diagnostics = []
  return {
    log,
    warn,
    diagnostics,
    stream: {
      log: (line) => log.push(line),
      warn: (line) => warn.push(line),
      diagnose: (code, detail) => diagnostics.push(`${code}: ${detail}`),
    },
  }
}

/** 假 pnpm：记录调用、可选地真实改写 profile、返回预设结果 */
function makeFakeRunPnpm(result = {}) {
  const calls = []
  const runPnpmImpl = async (options) => {
    calls.push({ command: options.invocation.command, args: options.args, cwd: options.cwd, timeoutMs: options.timeoutMs })
    if (typeof result.mutate === 'function') result.mutate(options.cwd)
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    return {
      command: options.invocation.command,
      args: [...options.invocation.args, ...options.args],
      exitCode: result.exitCode ?? 0,
      timedOut: result.timedOut === true,
      signal: undefined,
      error: undefined,
      stdout,
      stderr,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
      lossy: result.lossy === true,
    }
  }
  return { calls, runPnpmImpl }
}

/** 定位 pnpm 的替身 + 版本探测替身（后者避免测试去真跑 pnpm --version） */
const FAKE_PNPM = { resolvePnpm: () => ({ kind: 'exe', command: 'pnpm', args: [] }), readVersion: () => undefined }

/** 组装一次 runForward 的公共参数 */
function forwardArgs(options) {
  return {
    boot: options.boot,
    installAnchor: path.join(options.root, 'anchor.json'),
    cwd: options.root,
    platform: 'win32',
    flags: {},
    ...FAKE_PNPM,
    ...options.extra,
  }
}

/* ------------------------------------------------- 参数锚定（§2.4） */

test('anchorPathSpec 只重写路径型 spec，包名与绝对 spec 原样通过', () => {
  const cwd = '/work/plugin'
  assert.equal(anchorPathSpec('.', cwd), path.resolve(cwd, '.'))
  assert.equal(anchorPathSpec('./dist', cwd), path.resolve(cwd, './dist'))
  assert.equal(anchorPathSpec('../peer', cwd), path.resolve(cwd, '../peer'))
  assert.equal(anchorPathSpec('..', cwd), path.resolve(cwd, '..'))
  assert.equal(anchorPathSpec('file:.', cwd), `file:${path.resolve(cwd, '.')}`)
  assert.equal(anchorPathSpec('link:../peer', cwd), `link:${path.resolve(cwd, '../peer')}`)
  // 以点开头的**包名**不能被误伤（正则要求点后跟分隔符）
  assert.equal(anchorPathSpec('.hidden-pkg', cwd), '.hidden-pkg')
  assert.equal(anchorPathSpec('dsh-plugin-tlmemory', cwd), 'dsh-plugin-tlmemory')
  assert.equal(anchorPathSpec('@scope/pkg', cwd), '@scope/pkg')
  // 绝对 spec（含空格）不该被改写：它的问题在转发侧，不在锚定侧
  assert.equal(anchorPathSpec('file:D:/My Plugins/x', cwd), 'file:D:/My Plugins/x')
  assert.equal(anchorPathSpec('--filter=.', cwd), '--filter=.')
  assert.deepEqual(anchorArgs(['add', '.', '--save-dev'], cwd), ['add', path.resolve(cwd, '.'), '--save-dev'])
})

/* ------------------------------- P0-2：真实 spawn 下的 argv 保真（含空格与元字符） */

test('P0-2：含空格的 spec 与 & / ^ 元字符逐字到达子进程（不经 cmd.exe）', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    // 探针：把真正收到的 argv 写成 JSON 落盘
    const probe = path.join(root, 'probe.cjs')
    const argvFile = path.join(root, 'argv.json')
    fs.writeFileSync(
      probe,
      "const fs = require('node:fs');\n" +
        "fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n",
    )
    writeProfile(root, 'web', { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })
    const { stream } = makeSink()
    const { exitCode } = await runForward({
      profile: 'web',
      args: ['add', 'file:D:/My Plugins/x', 'x&ver', 'a^b|c', 'dsh-plugin-tlmemory', '.'],
      boot,
      installAnchor: path.join(root, 'anchor.json'),
      cwd: '/work/plugin',
      platform: 'win32',
      flags: {},
      readVersion: () => undefined,
      // 关键：走**真实的** runPnpm（shell:false + tee），用当前 node 直跑探针
      resolvePnpm: () => ({ kind: 'node', command: process.execPath, args: [probe, argvFile] }),
      runPnpmImpl: (options) => runPnpm({ ...options, stdout: { write: () => {} }, stderr: { write: () => {} } }),
      ...stream,
    })
    assert.equal(exitCode, EXIT.ok)
    const received = JSON.parse(fs.readFileSync(argvFile, 'utf8'))
    // profile 自己就是 workspace root，因此 pnpm 收到的是 `add -w <specs...>`
    assert.deepEqual(received, [
      'add',
      '-w',
      'file:D:/My Plugins/x',
      'x&ver',
      'a^b|c',
      'dsh-plugin-tlmemory',
      path.resolve('/work/plugin', '.'),
    ])
    assert.equal(received.length, 7, '含空格/元字符的 spec 不能被拆断或截断')
  } finally {
    cleanup()
  }
})

/* --------------------------------------------------------- P0-1：清单解析 */

test('P0-1：profile 清单非法 JSON 时干净失败（退出码 3、有稳定前缀、不碰 pnpm）', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', { name: 'p' })
    fs.writeFileSync(path.join(profileDir, 'package.json'), '{ "name": "p", ') // 截断成非法 JSON
    const { calls, runPnpmImpl } = makeFakeRunPnpm()
    const sink = makeSink()
    const { exitCode } = await runForward({
      profile: 'web',
      args: ['add', 'pkg'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      ...sink.stream,
    })
    assert.equal(exitCode, EXIT.manifestInvalid)
    assert.equal(calls.length, 0, '清单不可用时不得执行 pnpm')
    assert.ok(sink.diagnostics.some((line) => line.startsWith('profile-manifest-invalid:')), sink.diagnostics.join('\n'))
    assert.ok(sink.warn.join('\n').includes('未执行 pnpm'), sink.warn.join('\n'))
  } finally {
    cleanup()
  }
})

test('P0-1：某个依赖的 package.json 非法时层栈保持原值、报错并以退出码 4 结束', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', {
      name: 'p',
      dependencies: { 'demo-bundle': '1.0.0' },
      dsh: { profile: { bundles: ['dsh-base-inbox', 'demo-bundle'] } },
    })
    installDep(profileDir, { name: 'demo-bundle' }, '{ "name": "demo-bundle", ') // 非法 JSON
    const { runPnpmImpl } = makeFakeRunPnpm()
    const sink = makeSink()
    const { exitCode } = await runForward({
      profile: 'web',
      args: ['add', 'demo-bundle'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      ...sink.stream,
    })
    assert.equal(exitCode, EXIT.reconcileInconsistent)
    assert.deepEqual(bundlesOf(profileDir), ['dsh-base-inbox', 'demo-bundle'], '未知态不得改动层栈')
    assert.ok(
      sink.diagnostics.some((line) => line.startsWith('manifest-invalid: demo-bundle')),
      sink.diagnostics.join('\n'),
    )
    assert.ok(sink.warn.join('\n').includes('无法判定'), sink.warn.join('\n'))
  } finally {
    cleanup()
  }
})

/* --------------------------------- P1-1：解析失败不再被当作「不是 bundle」 */

test('P1-1（实测 S4）：依赖仍在、包目录缺失时不再静默剔除层栈', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', {
      name: 'p',
      dependencies: { 'demo-bundle': '1.0.0' },
      dsh: { profile: { bundles: ['dsh-base-inbox', 'demo-bundle'] } },
    })
    // 故意不装 demo-bundle：正是「store 损坏 / 手工清理 / file: 源目录被移动」的形态
    const { runPnpmImpl } = makeFakeRunPnpm()
    const sink = makeSink()
    const { exitCode } = await runForward({
      profile: 'web',
      args: ['list'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      ...sink.stream,
    })
    assert.equal(exitCode, EXIT.reconcileInconsistent)
    assert.deepEqual(bundlesOf(profileDir), ['dsh-base-inbox', 'demo-bundle'], '层栈必须保持原值')
    assert.ok(
      sink.diagnostics.some((line) => line.startsWith('dependency-unresolved: demo-bundle')),
      sink.diagnostics.join('\n'),
    )
  } finally {
    cleanup()
  }
})

test('P1-1：依赖被真的删除时才从层栈移除，并打印可读日志', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', {
      name: 'p',
      dependencies: { 'demo-bundle': '1.0.0' },
      dsh: { profile: { bundles: ['dsh-base-inbox', 'demo-bundle'] } },
    })
    // 假 pnpm 真实复现 `pnpm remove` 的效果：依赖从清单里消失
    const { runPnpmImpl } = makeFakeRunPnpm({ mutate: () => setDependencies(profileDir, {}) })
    const sink = makeSink()
    const { exitCode } = await runForward({
      profile: 'web',
      args: ['remove', 'demo-bundle'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      ...sink.stream,
    })
    assert.equal(exitCode, EXIT.ok)
    assert.deepEqual(bundlesOf(profileDir), ['dsh-base-inbox'], '模板内置的非依赖 bundle 不能被误删')
    assert.ok(sink.log.join('\n').includes('层栈移除 demo-bundle'), sink.log.join('\n'))
    assert.deepEqual(sink.diagnostics, [])
  } finally {
    cleanup()
  }
})

test('P1-1：依赖仍在但新版不再声明 dsh.bundle 时，移除有明确告警（不再静默）', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', {
      name: 'p',
      dependencies: { 'demo-bundle': '2.0.0' },
      dsh: { profile: { bundles: ['demo-bundle'] } },
    })
    installDep(profileDir, { name: 'demo-bundle', version: '2.0.0' })
    const { runPnpmImpl } = makeFakeRunPnpm()
    const sink = makeSink()
    const { exitCode } = await runForward({
      profile: 'web',
      args: ['update'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      ...sink.stream,
    })
    assert.equal(exitCode, EXIT.ok)
    assert.deepEqual(bundlesOf(profileDir), [])
    assert.ok(sink.warn.join('\n').includes('demo-bundle'), sink.warn.join('\n'))
  } finally {
    cleanup()
  }
})

/* ----------------------------------------------------- 归并主路径（§2.3） */

test('归并：新依赖声明 dsh.bundle 时按依赖顺序进入层栈，写前留备份、无临时残留', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', {
      name: 'p',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })
    installDep(profileDir, { name: 'demo-bundle', version: '1.0.0', dsh: { bundle: { patch: './patch.yml' } } })
    installDep(profileDir, { name: 'plain-lib', version: '1.0.0' })
    // 假 pnpm 复现 `pnpm add demo-bundle plain-lib` 的落盘效果
    const { runPnpmImpl } = makeFakeRunPnpm({
      mutate: () => setDependencies(profileDir, { 'demo-bundle': '1.0.0', 'plain-lib': '1.0.0' }),
    })
    const sink = makeSink()
    const { exitCode, report } = await runForward({
      profile: 'web',
      args: ['add', 'demo-bundle', 'plain-lib'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      ...sink.stream,
    })
    assert.equal(exitCode, EXIT.ok)
    assert.deepEqual(bundlesOf(profileDir), ['@deepseek-ai/dsh-base', 'demo-bundle'])
    assert.deepEqual(report.addedBundles, ['demo-bundle'])
    assert.deepEqual(report.removedBundles, [])
    // P2-4：回写前留了一份 manifest 备份，且没有临时文件残留
    const leftovers = fs.readdirSync(profileDir)
    assert.ok(leftovers.some((file) => file.startsWith('package.json.bak-dsh-plugin-manifest-')), leftovers.join(', '))
    assert.ok(leftovers.every((file) => !file.endsWith('-tmp')), leftovers.join(', '))
    assert.ok(sink.log.join('\n').includes('层栈新增 demo-bundle'), sink.log.join('\n'))
    // 普通库：只提示、不入层栈
    assert.ok(sink.warn.join('\n').includes('plain-lib'), sink.warn.join('\n'))
  } finally {
    cleanup()
  }
})

test('归并：模板内置的非依赖 bundle 永不被触碰', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', {
      name: 'p',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    })
    const sink = makeSink()
    const { runPnpmImpl } = makeFakeRunPnpm()
    const { exitCode } = await runForward({
      profile: 'web',
      args: ['list'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      ...sink.stream,
    })
    assert.equal(exitCode, EXIT.ok)
    assert.deepEqual(bundlesOf(profileDir), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  } finally {
    cleanup()
  }
})

test('依赖状态三态判定：bundle / plain / unknown 各归其位', () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', { name: 'p', dependencies: {} })
    installDep(profileDir, { name: 'a-bundle', dsh: { bundle: { patch: './p.yml' } } })
    installDep(profileDir, { name: 'a-lib' })
    installDep(profileDir, { name: 'a-client', dsh: { client: { platform: 'web' } } })
    const at = { profileDir, installAnchor: path.join(root, 'anchor.json'), boot }
    assert.equal(dependencyState({ ...at, name: 'a-bundle' }).state, 'bundle')
    assert.equal(dependencyState({ ...at, name: 'a-lib' }).state, 'plain')
    const client = dependencyState({ ...at, name: 'a-client' })
    assert.equal(client.state, 'plain')
    assert.ok(client.reason.includes('客户端型插件'), client.reason)
    const missing = dependencyState({ ...at, name: 'ghost' })
    assert.equal(missing.state, 'unknown')
    assert.equal(missing.code, 'dependency-unresolved')
  } finally {
    cleanup()
  }
})

/* ---------------------------------------- P2-2：workspace root 自动补 -w */

test('P2-2：profile 自己是 workspace root 时给 add/remove 补 -w', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    writeProfile(root, 'web', { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })
    const { calls, runPnpmImpl } = makeFakeRunPnpm()
    const sink = makeSink()
    const { report } = await runForward({
      profile: 'web',
      args: ['add', 'demo-lib'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      ...sink.stream,
    })
    assert.deepEqual(calls[0].args, ['add', '-w', 'demo-lib'])
    assert.equal(report.workspaceRoot, true)
  } finally {
    cleanup()
  }
})

test('P2-2：查询类子命令不补 -w；用户显式给 -r/--filter 时尊重用户', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    writeProfile(root, 'web', { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })
    const quiet = { log: () => {}, warn: () => {}, diagnose: () => {} }

    const query = makeFakeRunPnpm()
    await runForward({
      profile: 'web',
      args: ['why', 'demo-lib'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl: query.runPnpmImpl } }),
      ...quiet,
    })
    assert.deepEqual(query.calls[0].args, ['why', 'demo-lib'])

    const recursive = makeFakeRunPnpm()
    await runForward({
      profile: 'web',
      args: ['add', '-r', 'demo-lib'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl: recursive.runPnpmImpl } }),
      ...quiet,
    })
    assert.deepEqual(recursive.calls[0].args, ['add', '-r', 'demo-lib'])

    const filtered = makeFakeRunPnpm()
    await runForward({
      profile: 'web',
      args: ['add', '--filter=web', 'demo-lib'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl: filtered.runPnpmImpl } }),
      ...quiet,
    })
    assert.deepEqual(filtered.calls[0].args, ['add', '--filter=web', 'demo-lib'])
  } finally {
    cleanup()
  }
})

test('P2-2：非 workspace root 的 profile 不补 -w', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    writeProfile(root, 'web', { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } }, { workspaceRoot: false })
    const { calls, runPnpmImpl } = makeFakeRunPnpm()
    await runForward({
      profile: 'web',
      args: ['add', 'demo-lib'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      log: () => {},
      warn: () => {},
      diagnose: () => {},
    })
    assert.deepEqual(calls[0].args, ['add', 'demo-lib'])
  } finally {
    cleanup()
  }
})

/* ---------------------------------------- P2-1：失败分类、超时、非 UTF-8 */

test('P2-1：pnpm 非 0 时透传退出码，并给出分类诊断与证据行', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    writeProfile(root, 'web', { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })
    const { runPnpmImpl } = makeFakeRunPnpm({
      exitCode: 1,
      stderr: ' ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/nope: Not Found - 404\n',
    })
    const sink = makeSink()
    const { exitCode, report } = await runForward({
      profile: 'web',
      args: ['add', 'nope'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      ...sink.stream,
    })
    assert.equal(exitCode, 1)
    assert.ok(sink.diagnostics.some((line) => line.startsWith('fetch-404:')), sink.diagnostics.join('\n'))
    assert.ok(sink.diagnostics.some((line) => line.includes('证据：')), sink.diagnostics.join('\n'))
    assert.equal(report.pnpm.exitCode, 1)
  } finally {
    cleanup()
  }
})

test('P2-1：git 形态 spec 的放行指引随 pnpm 大版本给出正确键名（P3-2）', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    writeProfile(root, 'web', { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })
    const { runPnpmImpl } = makeFakeRunPnpm({ exitCode: 1, stderr: 'ERR_PNPM_PREPARE_PACKAGE failed\n' })
    const sink = makeSink()
    await runForward({
      profile: 'web',
      args: ['add', 'github:foo/bar'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl, readVersion: () => ({ raw: '9.15.0', major: 9 }) } }),
      ...sink.stream,
    })
    const hint = sink.warn.join('\n')
    assert.ok(hint.includes('onlyBuiltDependencies'), hint)
    assert.ok(hint.includes('大版本为 9'), hint)
    assert.ok(
      sink.diagnostics.some((line) => line.startsWith('git-prepare-not-allowed:')),
      sink.diagnostics.join('\n'),
    )
  } finally {
    cleanup()
  }
})

test('P2-1：超时被终止时退出码 124 并给出诊断（--timeout 语义）', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    writeProfile(root, 'web', { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })
    const { runPnpmImpl } = makeFakeRunPnpm({ exitCode: 124, timedOut: true })
    const sink = makeSink()
    const { exitCode } = await runForward({
      profile: 'web',
      args: ['install'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      flags: { timeoutMs: 50 },
      ...sink.stream,
    })
    assert.equal(exitCode, EXIT.timeout)
    assert.ok(sink.diagnostics.some((line) => line.startsWith('pnpm-timeout:')), sink.diagnostics.join('\n'))
  } finally {
    cleanup()
  }
})

test('P2-1：--timeout 值非法时在任何落盘之前失败', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const { calls, runPnpmImpl } = makeFakeRunPnpm()
    const sink = makeSink()
    const { exitCode } = await runForward({
      profile: 'brand-new',
      args: ['install'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      flags: { timeoutRaw: 'ten minutes', timeoutMs: undefined },
      ...sink.stream,
    })
    assert.equal(exitCode, EXIT.usage)
    assert.equal(calls.length, 0)
    assert.equal(fs.existsSync(path.join(root, 'profiles', 'brand-new')), false)
    assert.ok(sink.diagnostics.some((line) => line.startsWith('timeout-invalid:')), sink.diagnostics.join('\n'))
  } finally {
    cleanup()
  }
})

test('P2-1：输出含非 UTF-8 字节时给出 lossy 诊断（不猜代码页）', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    writeProfile(root, 'web', { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })
    const { runPnpmImpl } = makeFakeRunPnpm({ lossy: true, stdout: 'ok' })
    const sink = makeSink()
    const { report } = await runForward({
      profile: 'web',
      args: ['install'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      ...sink.stream,
    })
    assert.ok(sink.diagnostics.some((line) => line.startsWith('output-not-utf8:')), sink.diagnostics.join('\n'))
    assert.equal(report.pnpm.lossy, true)
  } finally {
    cleanup()
  }
})

test('pnpm 缺失：退出码 2、给出可操作提示，且**不创建半成品 profile**', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const sink = makeSink()
    const { exitCode } = await runForward({
      profile: 'brand-new',
      args: ['add', 'pkg'],
      boot,
      installAnchor: path.join(root, 'anchor.json'),
      cwd: root,
      flags: {},
      resolvePnpm: () => undefined,
      readVersion: () => undefined,
      ...sink.stream,
    })
    assert.equal(exitCode, EXIT.pnpmMissing)
    assert.equal(fs.existsSync(path.join(root, 'profiles', 'brand-new')), false, '缺 pnpm 时不该落盘')
    assert.ok(sink.warn.join('\n').includes('pnpm not found'), sink.warn.join('\n'))
    assert.ok(sink.diagnostics.some((line) => line.startsWith('pnpm-not-found:')))
  } finally {
    cleanup()
  }
})

/* --------------------------- P2-3：无模板 profile 的首次创建必须显式确认 */

test('P2-3：无模板的 profile 名首次创建被拒绝，加 --yes 才放行', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const sink = makeSink()
    const denied = await runForward({
      profile: 'typ0',
      args: ['add', 'pkg'],
      ...forwardArgs({ root, boot }),
      ...sink.stream,
    })
    assert.equal(denied.exitCode, EXIT.usage)
    assert.equal(fs.existsSync(path.join(root, 'profiles', 'typ0')), false, '拒绝后不得留下目录')
    assert.ok(sink.diagnostics.some((line) => line.startsWith('profile-template-missing:')), sink.diagnostics.join('\n'))
    assert.ok(sink.warn.join('\n').includes('--yes'), sink.warn.join('\n'))

    const allowed = makeSink()
    const { runPnpmImpl } = makeFakeRunPnpm()
    const granted = await runForward({
      profile: 'typ0',
      args: ['install'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      flags: { newProfile: true },
      ...allowed.stream,
    })
    assert.equal(granted.exitCode, EXIT.ok)
    const profileDir = path.join(root, 'profiles', 'typ0')
    assert.ok(fs.existsSync(path.join(profileDir, 'package.json')))
    assert.deepEqual(bundlesOf(profileDir), ['@deepseek-ai/dsh-base'], '无模板时按 DEFAULT_PROFILE_BUNDLES 初始化')
  } finally {
    cleanup()
  }
})

test('首次使用自动初始化内置模板 profile（含 pnpm-workspace.yaml）', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const sink = makeSink()
    const { runPnpmImpl } = makeFakeRunPnpm()
    const { exitCode } = await runForward({
      profile: 'web',
      args: ['why', 'x'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      ...sink.stream,
    })
    assert.equal(exitCode, EXIT.ok)
    const profileDir = path.join(root, 'profiles', 'web')
    assert.deepEqual(bundlesOf(profileDir), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    assert.ok(sink.log.join('\n').includes('initialized profile web'), sink.log.join('\n'))
  } finally {
    cleanup()
  }
})

/* ------------------------------------------------- P2-4：profile 锁 */

test('P2-4：写操作拿不到锁时明确失败；--no-lock 可跳过；陈旧锁会被接管', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })
    const lockFile = path.join(profileDir, LOCK_FILENAME)
    const quiet = { log: () => {}, warn: () => {}, diagnose: () => {} }

    // 活着的持有者 → 拒绝
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }))
    const blocked = makeSink()
    const held = await runForward({
      profile: 'web',
      args: ['install'],
      ...forwardArgs({ root, boot }),
      ...blocked.stream,
    })
    assert.equal(held.exitCode, EXIT.usage)
    assert.ok(blocked.diagnostics.some((line) => line.startsWith('lock-held:')), blocked.diagnostics.join('\n'))

    // --no-lock 跳过
    const bypass = makeFakeRunPnpm()
    const skipped = await runForward({
      profile: 'web',
      args: ['install'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl: bypass.runPnpmImpl } }),
      flags: { lock: false },
      ...quiet,
    })
    assert.equal(skipped.exitCode, EXIT.ok)
    assert.equal(bypass.calls.length, 1)

    // 陈旧锁（持有者进程不存在且已过期）→ 接管
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999, at: Date.now() - 60 * 60 * 1000 }))
    const takeover = makeFakeRunPnpm()
    const taken = await runForward({
      profile: 'web',
      args: ['install'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl: takeover.runPnpmImpl } }),
      ...quiet,
    })
    assert.equal(taken.exitCode, EXIT.ok)
    assert.equal(fs.existsSync(lockFile), false, '成功结束后要释放锁')
  } finally {
    cleanup()
  }
})

test('P2-4：只读子命令不拿锁（list 不会被锁阻塞）', async () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })
    fs.writeFileSync(path.join(profileDir, LOCK_FILENAME), JSON.stringify({ pid: process.pid, at: Date.now() }))
    const { runPnpmImpl } = makeFakeRunPnpm()
    const { exitCode } = await runForward({
      profile: 'web',
      args: ['list'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      log: () => {},
      warn: () => {},
      diagnose: () => {},
    })
    assert.equal(exitCode, EXIT.ok)
  } finally {
    cleanup()
  }
})

test('acquireLock 的语义：先到者持有、活着的持有者被拒、持有者消失后可接管、释放后可用', () => {
  const { root, cleanup } = makeHome()
  try {
    const dir = fs.mkdtempSync(path.join(root, 'lock-'))
    const clock = { value: 1_000_000 }
    const first = acquireLock(dir, { pid: process.pid, now: () => clock.value })
    assert.equal(first.ok, true)
    const second = acquireLock(dir, { pid: 222, now: () => clock.value + 10 })
    assert.equal(second.ok, false, '持有者进程还活着 → 拒绝')
    assert.equal(second.code, 'lock-held')
    assert.ok(second.detail.includes(String(process.pid)), second.detail)
    // 持有者已消失（不存在的 pid）+ 超过陈旧窗口 → 接管
    fs.writeFileSync(first.file, JSON.stringify({ pid: 999_999, at: clock.value - 11 * 60 * 1000 }))
    const takeover = acquireLock(dir, { pid: 333, now: () => clock.value })
    assert.equal(takeover.ok, true)
    assert.equal(JSON.parse(fs.readFileSync(takeover.file, 'utf8')).pid, 333)
    // 释放后可再次获取
    fs.rmSync(takeover.file, { force: true })
    assert.equal(acquireLock(dir, { pid: 444, now: () => clock.value }).ok, true)
  } finally {
    cleanup()
  }
})

/* --------------------------------------------------- 转发失败面 / 兜底 */

test('app-boot API 不匹配时明确失败，而不是静默降级', async () => {
  const { root, cleanup } = makeHome()
  try {
    const sink = makeSink()
    const { exitCode } = await runForward({
      profile: 'web',
      args: ['list'],
      boot: { resolveProfileDir: () => root },
      installAnchor: path.join(root, 'anchor.json'),
      cwd: root,
      flags: {},
      ...FAKE_PNPM,
      ...sink.stream,
    })
    assert.equal(exitCode, EXIT.usage)
    assert.ok(sink.diagnostics.some((line) => line.startsWith('boot-api-missing:')), sink.diagnostics.join('\n'))
  } finally {
    cleanup()
  }
})

/* ------------------------------------------------ P1-2：装了但不生效的审计 */

test('P1-2：客户端型插件不在层栈也不在补丁里时给出可执行提示', () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', {
      name: 'p',
      dependencies: { 'dsh-plugin-tlmemory': 'file:../tlmemory', 'a-bundle': '1.0.0' },
      dsh: { profile: { bundles: ['a-bundle'] } },
    })
    installDep(profileDir, { name: 'dsh-plugin-tlmemory', dsh: { client: {} } })
    installDep(profileDir, { name: 'a-bundle', dsh: { bundle: { patch: './p.yml' } } })
    const audit = auditActivation({ profileDir, boot, installAnchor: path.join(root, 'anchor.json'), profile: 'web' })
    assert.deepEqual(audit.unresolved, [])
    assert.equal(audit.hints.length, 1)
    assert.equal(audit.hints[0].code, 'client-plugin-not-activated')
    assert.ok(audit.hints[0].detail.includes('dsh plugin --profile web add dsh-plugin-tlmemory'))
  } finally {
    cleanup()
  }
})

test('P1-2：已在层栈或已在 cordis.patch.yml 挂载的插件不再提示', () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', {
      name: 'p',
      dependencies: { 'a-client': '1.0.0', 'b-client': '1.0.0' },
      dsh: { profile: { bundles: ['a-client'] } },
    })
    installDep(profileDir, { name: 'a-client', dsh: { client: {} } })
    installDep(profileDir, { name: 'b-client', dsh: { client: {} } })
    const mountText = '- insert:\n    - id: b\n      name: "b-client"\n'
    const audit = auditActivation({ profileDir, boot, installAnchor: path.join(root, 'anchor.json'), mountText })
    assert.deepEqual(audit.hints, [])
    assert.deepEqual(audit.unresolved, [])
  } finally {
    cleanup()
  }
})

test('P1-2：状态判不出来的依赖进入 unresolved（触发退出码 4）', () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', {
      name: 'p',
      dependencies: { '@furongjun1999/dsh-memory': '1.0.0' },
      dsh: { profile: { bundles: [] } },
    })
    // 复现真实 profile 的形态：目录只剩一个 data 子目录、没有 package.json
    fs.mkdirSync(path.join(profileDir, 'node_modules', '@furongjun1999', 'dsh-memory', 'data'), { recursive: true })
    const audit = auditActivation({ profileDir, boot, installAnchor: path.join(root, 'anchor.json') })
    assert.equal(audit.hints.length, 0)
    assert.equal(audit.unresolved.length, 1)
    assert.equal(audit.unresolved[0].code, 'dependency-unresolved')
  } finally {
    cleanup()
  }
})

/* -------------------------------------------------------- 纯函数直测 */

test('reconcileBundles 在清单不可读时抛 ProfileManifestError（由编排层收敛成语义化退出码）', () => {
  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    const profileDir = writeProfile(root, 'web', { name: 'p', dependencies: {} })
    fs.writeFileSync(path.join(profileDir, 'package.json'), 'not json')
    assert.throws(
      () => reconcileBundles({ profileDir, before: {}, boot, installAnchor: path.join(root, 'anchor.json') }),
      ProfileManifestError,
    )
  } finally {
    cleanup()
  }
})

test('writeManifestAtomic：留下备份、原子替换、不含临时残留', () => {
  const { root, cleanup } = makeHome()
  try {
    const dir = fs.mkdtempSync(path.join(root, 'atomic-'))
    const file = path.join(dir, 'package.json')
    fs.writeFileSync(file, '{ "name": "before" }\n')
    const { backup } = writeManifestAtomic(dir, { name: 'after' }, { stamp: '20260918-000000' })
    assert.ok(backup !== undefined && fs.existsSync(backup), '必须留下备份')
    assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8')).name, 'before')
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).name, 'after')
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('-tmp')), [])
  } finally {
    cleanup()
  }
})

test('报告骨架：exitCode / pnpm / lock / diagnostics 齐备（供 --json 消费）', async () => {  const { root, cleanup } = makeHome()
  try {
    const boot = makeBoot(root)
    writeProfile(root, 'web', { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })
    const { runPnpmImpl } = makeFakeRunPnpm()
    const { report } = await runForward({
      profile: 'web',
      args: ['install'],
      ...forwardArgs({ root, boot, extra: { runPnpmImpl } }),
      log: () => {},
      warn: () => {},
      diagnose: () => {},
    })
    assert.equal(report.command, 'plugin')
    assert.equal(report.profile, 'web')
    assert.equal(report.exitCode, 0)
    assert.equal(report.pnpm.command, 'pnpm')
    assert.deepEqual(report.pnpm.args, ['install'])
    assert.equal(report.pnpm.timedOut, false)
    assert.equal(report.lock.acquired, true)
    assert.deepEqual(report.diagnostics, [])
    assert.ok(Number.isFinite(report.durationMs))
  } finally {
    cleanup()
  }
})

test('mergeRunReports：管线字段与（多次）前向器字段合并，诊断去重、pnpm 取最后一次', () => {
  const base = {
    ...emptyReport('web'),
    phase: 'add',
    mounts: [{ name: 'demo-client', action: 'insert', id: 'demo-client' }],
    diagnostics: [{ code: 'client-plugin-not-activated', detail: 'demo-client: 未挂载' }],
  }
  const first = {
    ...emptyReport('web'),
    pnpm: { command: 'pnpm', args: ['add', '-w', 'x'], exitCode: 0 },
    addedBundles: ['demo-bundle'],
    lock: { acquired: true, path: 'D:/p/.dsh-plugin.lock' },
    diagnostics: [{ code: 'output-not-utf8', detail: '含非 UTF-8 字节' }],
  }
  const second = { ...emptyReport('web'), pnpm: { command: 'pnpm', args: ['install'], exitCode: 0 } }
  const merged = mergeRunReports(base, [first, second], [
    { code: 'client-plugin-not-activated', detail: 'demo-client: 未挂载' },
    { code: 'unexpected-error', detail: 'Error —— 本次未完成' },
  ])
  assert.equal(merged.phase, 'add')
  assert.deepEqual(merged.addedBundles, ['demo-bundle'], '前向器的层栈变更要合并进来')
  assert.equal(merged.mounts.length, 1, '管线的挂载信息要保留')
  assert.deepEqual(merged.pnpm.args, ['install'], '多次转发时 pnpm 字段取最后一次')
  assert.equal(merged.lock.acquired, true)
  // 同一条诊断（两级都报）只留一份；两边各自的诊断都在
  assert.deepEqual(
    merged.diagnostics.map((item) => item.code),
    ['client-plugin-not-activated', 'output-not-utf8', 'unexpected-error'],
  )
  assert.deepEqual(mergeRunReports(emptyReport('web'), [], []).diagnostics, [])
})
