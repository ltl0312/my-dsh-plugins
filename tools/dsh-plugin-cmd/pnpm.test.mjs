// tools/dsh-plugin-cmd/pnpm.test.mjs
// pnpm 层的单测：可执行定位、`-w` 注入、环境翻译、输出解码、失败分类学、
// 版本探测与 tee 启动（含超时/启动失败）。P2-1 / P2-2 / P3-2 的判据都在这里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import {
  PNPM_FAILURE_RULES,
  TIMEOUT_EXIT,
  buildApprovalHint,
  buildApprovalKey,
  classifyPnpmFailure,
  decodeOutput,
  extractShimTargets,
  forwardEnv,
  injectWorkspaceRootFlag,
  isWorkspaceRoot,
  pathDirs,
  readPnpmVersion,
  resolvePnpmInvocation,
  runPnpm,
} from './pnpm.mjs'
import { BUILD_APPROVAL_KEYS } from './core.mjs'

function makeTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pnpm-test-'))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** 假子进程：可控制事件时序 */
function makeFakeChild({ exitCode = 0, signal = undefined, stdout = 'out\n', stderr = 'err\n', autoClose = true } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = 0
  child.kill = () => {
    child.killed += 1
    return true
  }
  if (autoClose) {
    setImmediate(() => {
      if (stdout !== '') child.stdout.emit('data', Buffer.from(stdout))
      if (stderr !== '') child.stderr.emit('data', Buffer.from(stderr))
      child.emit('close', exitCode, signal)
    })
  }
  return child
}

/* ------------------------------------------------------------ 定位 */

test('pathDirs 按平台拆分 PATH 并去掉引号', () => {
  assert.deepEqual(pathDirs({ PATH: 'C:\\a;"C:\\b c";;' }, 'win32'), ['C:\\a', 'C:\\b c'])
  assert.deepEqual(pathDirs({ PATH: '/usr/bin:/usr/local/bin:' }, 'linux'), ['/usr/bin', '/usr/local/bin'])
})

test('extractShimTargets 从 pnpm 垫片里取出真实目标', () => {
  const standalone = '@ECHO off\r\n"%dp0%\\node_modules\\pnpm\\pnpm.exe"   %*\r\n'
  assert.deepEqual(extractShimTargets(standalone), ['node_modules/pnpm/pnpm.exe'])
  const npmGlobal = '"%_prog%"  "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*'
  assert.deepEqual(extractShimTargets(npmGlobal), ['node_modules/pnpm/bin/pnpm.cjs'])
  assert.deepEqual(extractShimTargets('"$basedir/../pnpm/bin/pnpm.cjs"'), [])
})

test('resolvePnpmInvocation：垫片指向 pnpm.exe 时直接用真可执行文件', () => {
  const { dir, cleanup } = makeTemp()
  try {
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(path.join(bin, 'node_modules', 'pnpm'), { recursive: true })
    fs.writeFileSync(path.join(bin, 'pnpm.cmd'), '"%dp0%\\node_modules\\pnpm\\pnpm.exe" %*\n')
    fs.writeFileSync(path.join(bin, 'node_modules', 'pnpm', 'pnpm.exe'), '')
    const invocation = resolvePnpmInvocation({ platform: 'win32', env: { PATH: bin } })
    assert.equal(invocation.kind, 'exe')
    assert.equal(invocation.command, path.join(bin, 'node_modules', 'pnpm', 'pnpm.exe'))
    assert.deepEqual(invocation.args, [])
  } finally {
    cleanup()
  }
})

test('resolvePnpmInvocation：只有 .cmd + JS 入口时改用当前 node 直跑（不经 shell）', () => {
  const { dir, cleanup } = makeTemp()
  try {
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(path.join(bin, 'node_modules', 'pnpm', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(bin, 'pnpm.cmd'), '"%_prog%" "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\n')
    fs.writeFileSync(path.join(bin, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '')
    const invocation = resolvePnpmInvocation({ platform: 'win32', env: { PATH: bin }, nodePath: 'NODE' })
    assert.equal(invocation.kind, 'node')
    assert.equal(invocation.command, 'NODE')
    assert.deepEqual(invocation.args, [path.join(bin, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')])
  } finally {
    cleanup()
  }
})

test('resolvePnpmInvocation：PATH 上没有可用的 pnpm 时返回 undefined（不再有不可达的 ENOENT 分支）', () => {
  const { dir, cleanup } = makeTemp()
  try {
    const empty = path.join(dir, 'empty')
    fs.mkdirSync(empty, { recursive: true })
    fs.writeFileSync(path.join(empty, 'pnpm.cmd'), 'echo nothing to see here\n')
    assert.equal(resolvePnpmInvocation({ platform: 'win32', env: { PATH: empty } }), undefined)
    assert.equal(resolvePnpmInvocation({ platform: 'linux', env: { PATH: '/opt/bin' }, exists: () => false }), undefined)
  } finally {
    cleanup()
  }
})

test('resolvePnpmInvocation：POSIX 上直接使用自带 shebang 的 pnpm', () => {
  const invocation = resolvePnpmInvocation({
    platform: 'linux',
    env: { PATH: '/usr/bin:/usr/local/bin' },
    exists: () => true,
  })
  assert.equal(invocation.kind, 'shim')
  assert.equal(invocation.command, path.join('/usr/bin', 'pnpm'))
})

/* ------------------------------------------------- P2-2：-w 注入 */

test('isWorkspaceRoot 只认 packages 段里的 `.`', () => {
  const { dir, cleanup } = makeTemp()
  try {
    const profile = path.join(dir, 'profile')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    assert.equal(isWorkspaceRoot(profile), true)

    fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n  - ./\n')
    assert.equal(isWorkspaceRoot(profile), true)

    fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    assert.equal(isWorkspaceRoot(profile), false)

    fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'allowBuilds:\n  sharp: true\n')
    assert.equal(isWorkspaceRoot(profile), false)

    fs.rmSync(path.join(profile, 'pnpm-workspace.yaml'))
    assert.equal(isWorkspaceRoot(profile), false)
  } finally {
    cleanup()
  }
})

test('injectWorkspaceRootFlag 的判定表', () => {
  const root = { workspaceRoot: true }
  assert.deepEqual(injectWorkspaceRootFlag(['add', 'pkg'], root), ['add', '-w', 'pkg'])
  assert.deepEqual(injectWorkspaceRootFlag(['remove', 'pkg'], root), ['remove', '-w', 'pkg'])
  assert.deepEqual(injectWorkspaceRootFlag(['update'], root), ['update', '-w'])
  // 查询类与不需要 -w 的子命令不动
  for (const sub of ['why', 'list', 'outdated', 'install', 'approve-builds']) {
    assert.deepEqual(injectWorkspaceRootFlag([sub, 'pkg'], root), [sub, 'pkg'])
  }
  // 已经给了就不再补
  assert.deepEqual(injectWorkspaceRootFlag(['add', '-w', 'pkg'], root), ['add', '-w', 'pkg'])
  // 与 -w 互斥的用户意图要保留
  assert.deepEqual(injectWorkspaceRootFlag(['add', '-r', 'pkg'], root), ['add', '-r', 'pkg'])
  assert.deepEqual(injectWorkspaceRootFlag(['add', '--filter=web', 'pkg'], root), ['add', '--filter=web', 'pkg'])
  // 非 workspace root 不补
  assert.deepEqual(injectWorkspaceRootFlag(['add', 'pkg'], { workspaceRoot: false }), ['add', 'pkg'])
  assert.deepEqual(injectWorkspaceRootFlag([], root), [])
})

/* ------------------------------------------------- 环境翻译与解码 */

test('forwardEnv 翻译代理变量并在 TTY 下要求颜色，且不覆盖既有 npm_config_*', () => {
  const env = forwardEnv(
    { HTTP_PROXY: 'http://127.0.0.1:7892', HTTPS_PROXY: 'http://127.0.0.1:7892', NO_PROXY: 'localhost' },
    'linux',
    { tty: true },
  )
  assert.equal(env.npm_config_https_proxy, 'http://127.0.0.1:7892')
  assert.equal(env.npm_config_proxy, 'http://127.0.0.1:7892')
  assert.equal(env.npm_config_noproxy, 'localhost')
  assert.equal(env.FORCE_COLOR, '1')

  const kept = forwardEnv({ HTTPS_PROXY: 'a', npm_config_https_proxy: 'b' }, 'linux', { tty: false })
  assert.equal(kept.npm_config_https_proxy, 'b', '用户/上游已设的 npm_config_* 优先')
  assert.equal(kept.FORCE_COLOR, undefined)
})

test('decodeOutput 如实标记非 UTF-8 字节（不猜代码页）', () => {
  const ascii = decodeOutput([Buffer.from('Progress: resolved 3, done\n')])
  assert.equal(ascii.lossy, false)
  assert.equal(ascii.replacementChars, 0)
  assert.ok(ascii.bytes > 0)

  // 0x80 起头是 GBK 的典型首字节，按 UTF-8 解码会得到替换字符
  const gbk = decodeOutput([Buffer.from([0x64, 0x80, 0x6f, 0x6b])])
  assert.equal(gbk.lossy, true)
  assert.ok(gbk.replacementChars > 0)
})

/* ----------------------------------------------------- 失败分类学 */

test('classifyPnpmFailure 覆盖评审点名的关键失败形态', () => {
  const cases = [
    ['ERR_PNPM_ADDING_TO_ROOT\nRun this command in a workspace root', 'adding-to-root', true],
    ['Ignored build scripts: better-sqlite3\nRun "pnpm approve-builds"', 'ignored-builds', true],
    ['ERR_PNPM_PREPARE_PACKAGE  Failed to prepare git-hosted package', 'git-prepare-not-allowed', true],
    ['ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/nope: Not Found', 'fetch-404', false],
    ['Error: ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST  Cannot resolve latest version', 'fetch-404', false],
    ['EBUSY: resource busy or locked, rename node_modules/x', 'windows-file-locked', true],
    ['request to https://registry.npmjs.org/x failed, reason: getaddrinfo ENOTFOUND', 'network', true],
    ['ERR_PNPM_NO_MATCHING_VERSION  No matching version found', 'no-matching-version', false],
    ['ERR_PNPM_MINIMUM_RELEASE_AGE  version published too recently (minimumReleaseAge)', 'release-age-violation', false],
    ['Unsupported engine: wanted node >=20', 'unsupported-engine', false],
    ['ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"', 'lockfile-outdated', true],
    ['ERR_PNPM_SOMETHING_NEW went wrong', 'pnpm-error', false],
    ['plain failure without codes', 'pnpm-failed', false],
  ]
  for (const [output, code, recoverable] of cases) {
    const result = classifyPnpmFailure(output, 1)
    assert.equal(result.code, code, `${output} → ${result.code}`)
    assert.equal(result.recoverable, recoverable, `${code} recoverable`)
    assert.ok(result.detail.length > 0)
  }
})

test('classifyPnpmFailure 的证据行跳过进度噪音、只留一行并截断超长行', () => {
  const noisy = 'Progress: resolved 1, reused 0\nPackages: +3\n Done in 1s\nERR_PNPM_FETCH_404 not found\nmore'
  assert.equal(classifyPnpmFailure(noisy, 1).evidence, 'ERR_PNPM_FETCH_404 not found')
  const long = `x${'y'.repeat(400)}`
  assert.ok(classifyPnpmFailure(`ERR_PNPM_FETCH_404 ${long}`, 1).evidence.length <= 201)
})

test('失败分类规则表是具名常量，便于扩展与测试（建议 #15）', () => {
  assert.ok(PNPM_FAILURE_RULES.length >= 9)
  for (const rule of PNPM_FAILURE_RULES) {
    assert.equal(typeof rule.code, 'string')
    assert.ok(rule.test instanceof RegExp)
    assert.equal(typeof rule.recoverable, 'boolean')
    assert.ok(rule.detail.length > 0)
  }
})

/* ------------------------------------------------- 版本感知（P3-2） */

test('readPnpmVersion 解析主版本并缓存结果', () => {
  let calls = 0
  const spawnSync = () => {
    calls += 1
    return { status: 0, stdout: 'v10.9.0\n', stderr: '' }
  }
  const invocation = { kind: 'exe', command: 'pnpm', args: [] }
  const first = readPnpmVersion(invocation, { spawnSync, env: {} })
  assert.equal(first.major, 10)
  assert.equal(first.raw, 'v10.9.0')
  readPnpmVersion(invocation, { spawnSync, env: {} })
  assert.equal(calls, 1, '同一 invocation 只探测一次')
  assert.equal(readPnpmVersion(undefined, { spawnSync }), undefined)
})

test('buildApprovalKey / buildApprovalHint 随 pnpm 大版本切换键名', () => {
  assert.equal(buildApprovalKey(9), BUILD_APPROVAL_KEYS.legacy)
  assert.equal(buildApprovalKey(10), BUILD_APPROVAL_KEYS.legacy)
  assert.equal(buildApprovalKey(11), BUILD_APPROVAL_KEYS.modern)
  assert.equal(buildApprovalKey(undefined), BUILD_APPROVAL_KEYS.modern)

  const legacy = buildApprovalHint({ major: 9, workspaceFile: 'D:/p/pnpm-workspace.yaml' })
  assert.ok(legacy.includes('onlyBuiltDependencies'))
  assert.ok(legacy.includes('大版本为 9'))
  const modern = buildApprovalHint({ major: 12, workspaceFile: 'D:/p/pnpm-workspace.yaml' })
  assert.ok(modern.includes('allowBuilds'))
  assert.ok(!modern.includes('onlyBuiltDependencies'))
})

/* ------------------------------------------- 启动：tee / 超时 / 启动失败 */

test('runPnpm：真实子进程的输出被 tee（既转发给注入的流，又留在结果里）', async () => {
  const { dir, cleanup } = makeTemp()
  try {
    const probe = path.join(dir, 'probe.cjs')
    fs.writeFileSync(
      probe,
      "process.stdout.write('to-stdout\\n');\nprocess.stderr.write('to-stderr\\n');\nprocess.exit(3);\n",
    )
    const forwarded = { out: '', err: '' }
    const result = await runPnpm({
      invocation: { kind: 'node', command: process.execPath, args: [probe] },
      args: [],
      cwd: dir,
      env: process.env,
      platform: process.platform,
      stdout: { write: (chunk) => { forwarded.out += chunk.toString() } },
      stderr: { write: (chunk) => { forwarded.err += chunk.toString() } },
    })
    assert.equal(result.exitCode, 3)
    assert.ok(result.stdout.includes('to-stdout'), result.stdout)
    assert.ok(result.stderr.includes('to-stderr'), result.stderr)
    assert.ok(forwarded.out.includes('to-stdout'), '实时转发的字节也要到达父进程流')
    assert.ok(forwarded.err.includes('to-stderr'))
    assert.equal(result.timedOut, false)
    assert.equal(result.lossy, false)
    assert.ok(result.stdoutBytes > 0)
  } finally {
    cleanup()
  }
})

test('runPnpm：始终 shell:false + 双管道，并把代理环境翻译后交给子进程', async () => {
  const seen = {}
  const spawn = (command, args, options) => {
    Object.assign(seen, { command, args, options })
    return makeFakeChild({ exitCode: 0 })
  }
  const result = await runPnpm({
    invocation: { kind: 'exe', command: 'pnpm.exe', args: [] },
    args: ['add', 'x'],
    cwd: '/profile',
    env: { HTTPS_PROXY: 'http://127.0.0.1:7892', PATH: '' },
    platform: 'win32',
    spawn,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  })
  assert.equal(seen.command, 'pnpm.exe')
  assert.deepEqual(seen.args, ['add', 'x'])
  assert.equal(seen.options.shell, false, 'P0-2 的核心：绝不经过 shell')
  assert.deepEqual(seen.options.stdio, ['inherit', 'pipe', 'pipe'])
  assert.equal(seen.options.env.npm_config_https_proxy, 'http://127.0.0.1:7892')
  assert.equal(result.exitCode, 0)
})

test('runPnpm：超时后终止子进程并返回 124', async () => {
  let child
  const spawn = () => {
    child = makeFakeChild({ autoClose: false })
    return child
  }
  const result = await runPnpm({
    invocation: { kind: 'exe', command: 'pnpm.exe', args: [] },
    args: ['install'],
    cwd: '/profile',
    env: {},
    platform: 'win32',
    timeoutMs: 30,
    spawn,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  })
  assert.equal(result.exitCode, TIMEOUT_EXIT)
  assert.equal(result.timedOut, true)
  assert.ok(child.killed >= 1, '必须向子进程发终止信号')
})

test('runPnpm：启动失败（ENOENT）返回退出码 2 且不抛异常', async () => {
  const spawn = () => {
    const child = makeFakeChild({ autoClose: false })
    setImmediate(() => {
      const error = new Error('spawn pnpm ENOENT')
      error.code = 'ENOENT'
      child.emit('error', error)
    })
    return child
  }
  const result = await runPnpm({
    invocation: { kind: 'exe', command: 'pnpm.exe', args: [] },
    args: [],
    cwd: '/profile',
    env: {},
    platform: 'win32',
    spawn,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  })
  assert.equal(result.exitCode, 2)
  assert.equal(result.error.code, 'ENOENT')
})

test('runPnpm：子进程被信号终止（无退出码）时给退出码 1 与说明', async () => {
  const spawn = () => makeFakeChild({ exitCode: null, signal: 'SIGKILL' })
  const result = await runPnpm({
    invocation: { kind: 'exe', command: 'pnpm.exe', args: [] },
    args: [],
    cwd: '/profile',
    env: {},
    platform: 'win32',
    spawn,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  })
  assert.equal(result.exitCode, 1)
  assert.ok(String(result.error?.message).includes('SIGKILL'), String(result.error?.message))
})
