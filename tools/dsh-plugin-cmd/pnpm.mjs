// tools/dsh-plugin-cmd/pnpm.mjs
// pnpm 的定位、启动与失败分类 —— 评审 P2-1 / P2-2 / P3-2 / 建议 #11 #12 的落点。
//
// 三件事在这里收口：
//   1. **定位**：Windows 上 `.cmd`/`.bat` 不能直接 spawn（Node 自 CVE-2024-27980 起对
//      `shell:false` 的 .cmd 抛 EINVAL），而「拼字符串交给 cmd.exe」正是 P0-2 的病根。
//      于是按 pnpm.exe → 垫片指向的 .exe → 垫片指向的 JS 入口（当前 node 直跑）逐级下探。
//   2. **启动**：`stdio: ['inherit','pipe','pipe']` + 边收边转发 —— 既保留 `inherit` 的
//      实时体验，又把字节握在手里（官方 `stdio:'inherit'` 等于把诊断责任全推给下游）。
//      同时支持超时（信号终止 + 退出码 124）与代理环境翻译（HTTP(S)_PROXY → npm_config_*）。
//   3. **解读**：把 pnpm 的输出映射成**稳定的错误码**（`dsh: diagnose: <code>: …`，
//      带 recoverable 标记），让上游不必各自重建一份失败分类学。
//
// 本模块只依赖 node: 内置模块与 core.mjs 的常量，因此可被仓库单测直接覆盖。

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { BUILD_APPROVAL_KEYS, PROXY_ENV_MAP } from './core.mjs'

/** 超时的退出码（沿用 GNU timeout 的惯例，与 pnpm 自身的退出码不会撞车） */
export const TIMEOUT_EXIT = 124

/** pnpm 缺失/无法启动的退出码（与 forward.EXIT.pnpmMissing 同值） */
export const PNPM_MISSING_EXIT = 2

/* ------------------------------------------------------------ 定位（P0-2/P3-1） */

/** 把 PATH 拆成目录列表（Windows 用 `;`，其余用 `:`），去掉引号与空项 */
export function pathDirs(env = process.env, platform = process.platform) {
  const raw = platform === 'win32' ? (env.PATH ?? env.Path ?? '') : (env.PATH ?? '')
  const separator = platform === 'win32' ? ';' : ':'
  return raw
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry !== '')
}

/**
 * 从 pnpm 的 `.cmd` 垫片里取出它真正启动的目标。
 * 垫片内容形如 `"%dp0%\node_modules\pnpm\pnpm.exe" %*`（pnpm 12 的独立安装）
 * 或 `"%dp0%\node_modules\pnpm\bin\pnpm.cjs" %*`（一般 npm 全局安装）。
 * @param text - 垫片正文
 * @returns 相对垫片目录的候选目标（已统一为正斜杠）
 */
export function extractShimTargets(text) {
  const targets = []
  const pattern = /%(?:~)?dp0%?[\\/]([^"'\s]+\.(?:exe|cjs|mjs|js))/gi
  let match
  while ((match = pattern.exec(text)) !== null) targets.push(match[1].replace(/\\/g, '/'))
  return targets
}

/** 把候选目标按「真正的可执行文件 / 交给当前 node 的 JS 入口」分类 */
function invocationFor(target, nodePath) {
  if (target === undefined) return undefined
  return /\.exe$/i.test(target)
    ? { kind: 'exe', command: target, args: [] }
    : { kind: 'node', command: nodePath, args: [target] }
}

/** 该路径是否为已存在的普通文件 */
function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

/**
 * 定位一个可以**不经 shell** 启动的 pnpm：pnpm.exe → 垫片指向的 .exe → 垫片指向的
 * JS 入口（用当前 node 跑）→ 几个约定位置。找不到返回 undefined，由调用方以退出码 2
 * 明确失败 —— 这正是官方那条「ENOENT → 127」在 Windows 上不可达的分支（P3-1）。
 * @param options - `{ platform, env, exists, readText, nodePath }`（测试注入用）
 * @returns `{ kind, command, args }`；找不到返回 undefined
 */
export function resolvePnpmInvocation(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? isFile
  const nodePath = options.nodePath ?? process.execPath
  const readText =
    options.readText ??
    ((file) => {
      try {
        return fs.readFileSync(file, 'utf8')
      } catch {
        return ''
      }
    })
  const shimNames = platform === 'win32' ? ['pnpm.cmd', 'pnpm.bat'] : ['pnpm', 'pnpm.sh']
  const guesses = [
    'node_modules/pnpm/pnpm.exe',
    'node_modules/pnpm/bin/pnpm.cjs',
    'node_modules/pnpm/bin/pnpm.mjs',
    '../lib/node_modules/pnpm/bin/pnpm.cjs',
    'pnpm.cjs',
  ]

  for (const dir of pathDirs(env, platform)) {
    if (platform !== 'win32') {
      // POSIX 上的 `pnpm` 是自带 shebang 的可执行脚本，shell:false 也能起
      const shim = path.join(dir, 'pnpm')
      if (exists(shim)) return { kind: 'shim', command: shim, args: [] }
      continue
    }
    const direct = path.join(dir, 'pnpm.exe')
    if (exists(direct)) return invocationFor(direct, nodePath)
    for (const shim of shimNames) {
      for (const relative of extractShimTargets(readText(path.join(dir, shim)))) {
        const target = path.resolve(dir, relative)
        if (exists(target)) return invocationFor(target, nodePath)
      }
    }
    for (const relative of guesses) {
      const target = path.resolve(dir, relative)
      if (exists(target)) return invocationFor(target, nodePath)
    }
  }
  return undefined
}

/* ------------------------------------------------- 版本感知（P3-2） */

const versionCache = new Map()

/**
 * 读 pnpm 的版本（只影响提示文案与放行键名，失败不致命）。
 * @param invocation - {@link resolvePnpmInvocation} 的结果
 * @param options - `{ env, cwd, spawnSync }`
 * @returns `{ raw, major }`；读不到返回 undefined
 */
export function readPnpmVersion(invocation, options = {}) {
  if (invocation === undefined) return undefined
  const spawnVersion = options.spawnSync ?? spawnSync
  const key = `${invocation.command} ${invocation.args.join(' ')}`
  if (versionCache.has(key)) return versionCache.get(key)
  let result
  try {
    result = spawnVersion(invocation.command, [...invocation.args, '--version'], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 10_000,
    })
  } catch {
    result = undefined
  }
  const raw = typeof result?.stdout === 'string' ? result.stdout.trim() : ''
  const match = /^v?(\d+)\./.exec(raw)
  const value = match === null ? undefined : { raw, major: Number(match[1]) }
  versionCache.set(key, value)
  return value
}

/**
 * 该 pnpm 大版本下，「允许执行构建脚本」的配置键名（P3-2）。
 * pnpm 10 用数组式的 `onlyBuiltDependencies`，pnpm 11+ 用映射式的 `allowBuilds`。
 * @param major - pnpm 主版本号；未知时按 11 处理（本增强层的写入形态）
 */
export function buildApprovalKey(major) {
  return (major ?? 11) >= 11 ? BUILD_APPROVAL_KEYS.modern : BUILD_APPROVAL_KEYS.legacy
}

/** 生成 git 形态 spec 的构建放行指引（键名随 pnpm 大版本变化） */
export function buildApprovalHint({ major, workspaceFile }) {
  const key = buildApprovalKey(major)
  const note =
    major === undefined || major >= 11
      ? ''
      : `（本机 pnpm 大版本为 ${major}：正确键名是 ${BUILD_APPROVAL_KEYS.legacy}；本增强层写的是 pnpm 11+ 的 ${BUILD_APPROVAL_KEYS.modern}，请以 pnpm 自己打印的那行为准）`
  return (
    'dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — ' +
    `add the exact key pnpm printed above under ${key} in ${workspaceFile}, then re-run${note}`
  )
}

/* ------------------------------------- workspace root 与 -w 注入（P2-2） */

/** 会在 workspace root 上被 pnpm 拒绝「直接改依赖」的子命令 */
const ROOT_SENSITIVE_UNSUPPORTED = new Set(['add', 'remove', 'rm', 'uninstall', 'update', 'up', 'import'])

/** 与 `-w` 互斥的旗标：用户显式给了就尊重用户 */
const WORKSPACE_SCOPING_FLAGS = new Set(['-w', '--workspace-root', '-r', '--recursive', '--filter', '--filter-prod', '-F'])

/**
 * profile 目录是否本身就是一个 pnpm workspace root。
 *
 * `initProfile` 写的 `pnpm-workspace.yaml` 是 `packages: ["."]` —— 即**凡是 CLI 自己
 * 创建的 profile 都是 workspace root**。pnpm 9 在 root 上执行 `add` 会以
 * ERR_PNPM_ADDING_TO_ROOT 失败，因此必须补 `-w`（P2-2）。
 * @param profileDir - profile 目录
 */
export function isWorkspaceRoot(profileDir) {
  let text
  try {
    text = fs.readFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), 'utf8')
  } catch {
    return false
  }
  const lines = text.split(/\r\n|\n/)
  const start = lines.findIndex((line) => /^packages\s*:/.test(line))
  if (start === -1) return false
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    if (/^\S/.test(line)) break // 回到列 0：packages 段结束
    const item = /^\s*-\s*(.*?)\s*$/.exec(line)
    if (item === null) continue
    const value = item[1].replace(/^['"]|['"]$/g, '')
    if (value === '.' || value === './') return true
  }
  return false
}

/**
 * 需要时给 pnpm 参数补上 `-w`。
 *
 * 语义要点：只在「profile 自己是 workspace root」且「子命令会在 root 上改依赖」时补；
 * 用户显式传了 `-r` / `--filter` 就原样尊重（那是有意的跨包操作，且与 `-w` 互斥）。
 * @param args - 待转发参数
 * @param options - `{ workspaceRoot }`
 * @returns 新参数数组（不需要改动时返回等价副本）
 */
export function injectWorkspaceRootFlag(args, { workspaceRoot }) {
  const argv = Array.isArray(args) ? args.map(String) : []
  if (workspaceRoot !== true || argv.length === 0) return argv
  if (!ROOT_SENSITIVE_UNSUPPORTED.has(argv[0])) return argv
  const scoped = argv.some(
    (token) => WORKSPACE_SCOPING_FLAGS.has(token) || token.startsWith('--filter=') || token.startsWith('--filter-prod='),
  )
  if (scoped) return argv
  return [argv[0], '-w', ...argv.slice(1)]
}

/* ------------------------------------------------ 环境翻译与输出解码（#12） */

/**
 * 构造子进程环境：翻译代理变量 + 在父进程是 TTY 时显式要求颜色。
 *
 * 输出改成管道之后，子进程不再自带 TTY（进度条与颜色会退化），因此父进程在 TTY 上
 * 时补 `FORCE_COLOR`。代理翻译是为了把 dshmarket 自备的那套 `HTTP(S)_PROXY →
 * npm_config_*` 下沉到 CLI，减少每个消费者的重复实现。
 * @param env - 父进程环境
 * @param platform - 平台（保留参数以便将来按平台微调）
 * @param options - `{ tty }`
 */
export function forwardEnv(env = process.env, platform = process.platform, options = {}) {
  const next = { ...env }
  for (const [from, to] of PROXY_ENV_MAP) {
    const value = env[from]
    if (typeof value === 'string' && value !== '' && next[to] === undefined) next[to] = value
  }
  const tty = options.tty ?? process.stdout?.isTTY === true
  if (tty && next.FORCE_COLOR === undefined) next.FORCE_COLOR = '1'
  void platform
  return next
}

/**
 * 解码一段 pnpm 输出。
 *
 * Windows 上被 pnpm 拉起的原生程序（git、node-gyp、cmd.exe 包装器）可能按 OEM 代码页
 * 写字节，到 UTF-8 世界里就是替换字符。我们**不猜代码页**（无依赖可用），而是如实标记
 * `lossy`，让上游知道这段文本不可完全信任 —— 同时原始字节数一并给出。
 * @param chunks - Buffer 列表
 * @returns `{ text, lossy, bytes, replacementChars }`
 */
export function decodeOutput(chunks) {
  const buffer = Buffer.concat(chunks)
  const text = buffer.toString('utf8')
  const replacementChars = (text.match(/\uFFFD/g) ?? []).length
  return { text, lossy: replacementChars > 0, bytes: buffer.length, replacementChars }
}

/* ------------------------------------------------------ 失败分类（P2-1） */

/**
 * pnpm 失败分类学（评审 §四 P2-1 指出下游被迫自建的那份）。
 * 顺序敏感：从最具体到最泛化；`recoverable` 表示「按提示修一下就能重跑成功」。
 */
export const PNPM_FAILURE_RULES = Object.freeze([
  {
    code: 'adding-to-root',
    recoverable: true,
    test: /adding to root|ERR_PNPM_ADDING_TO_ROOT|--workspace-root/i,
    detail: 'pnpm 拒绝在 workspace root 上直接改依赖：本命令会自动补 -w；若你显式传了 -r/--filter，请去掉后再试',
  },
  {
    code: 'ignored-builds',
    recoverable: true,
    test: /Ignored build scripts|ERR_PNPM_IGNORED_BUILDS|approve-builds/i,
    detail: '构建脚本被 pnpm 拦下：在 pnpm-workspace.yaml 的 allowBuilds 里放行对应包后重跑（dsh plugin add 会自动放行本次依赖闭包内的包）',
  },
  {
    code: 'git-prepare-not-allowed',
    recoverable: true,
    test: /ERR_PNPM_PREPARE|prepare script|git-hosted|allowBuilds|onlyBuiltDependencies|could not find a package\.json/i,
    detail: 'git 形态依赖的 prepare 脚本被构建放行机制拦下：按 pnpm 打印的键名写入 pnpm-workspace.yaml 后重跑',
  },
  {
    code: 'windows-file-locked',
    recoverable: true,
    test: /EBUSY|EPERM|EACCES|being used by another process|另一个程序正在使用|拒绝访问|resource busy/i,
    detail: '文件被占用（杀软 / 编辑器 / 仍在运行的宿主进程）：关闭占用方后重跑，必要时删除 node_modules 重装',
  },
  {
    code: 'network',
    recoverable: true,
    test: /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_FAIL|fetch failed|socket hang up/i,
    detail: '网络不可达：检查代理（HTTP(S)_PROXY 会被翻译成 npm_config_*）或换镜像源后重跑',
  },
  {
    code: 'fetch-404',
    recoverable: false,
    test: /ERR_PNPM_FETCH_404|404 Not Found|E404|Not Found - GET|ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST/i,
    detail: '包或版本在 registry 上不存在：核对包名/版本/scope 与 registry 配置',
  },
  {
    code: 'release-age-violation',
    recoverable: false,
    test: /minimumReleaseAge|release age|ERR_PNPM_MINIMUM_RELEASE_AGE/i,
    detail: '命中了 registry 的最短发布时长（供应链）策略：稍后重试或显式指定更早的版本',
  },
  {
    code: 'no-matching-version',
    recoverable: false,
    test: /ERR_PNPM_NO_MATCHING_VERSION|No matching version found/i,
    detail: '版本区间解析不到可用版本：核对包名拼写与版本范围（也可先 pnpm view <包名> versions）',
  },
  {
    code: 'unsupported-engine',
    recoverable: false,
    test: /Unsupported engine|ERR_PNPM_UNSUPPORTED_ENGINE/i,
    detail: '依赖要求的 Node 版本与当前运行时不符：切换 Node 版本后重跑',
  },
  {
    code: 'lockfile-outdated',
    recoverable: true,
    test: /ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile/i,
    detail: '锁文件与 package.json 不一致：去掉 --frozen-lockfile 或先执行 pnpm install',
  },
])

/**
 * 把一次 pnpm 失败映射成稳定错误码。
 * @param output - 合并后的 pnpm 输出文本（含 pnpm 自己打印的 ERR_PNPM_* 行）
 * @param exitCode - pnpm 的退出码
 * @returns `{ code, detail, recoverable, evidence }`
 */
export function classifyPnpmFailure(output, exitCode) {
  const text = typeof output === 'string' ? output : ''
  const evidence = firstMeaningfulLine(text)
  for (const rule of PNPM_FAILURE_RULES) {
    if (rule.test.test(text)) {
      return { code: rule.code, detail: rule.detail, recoverable: rule.recoverable, evidence }
    }
  }
  const known = /(ERR_PNPM_[A-Z0-9_]+)/.exec(text)
  if (known !== null) {
    return {
      code: 'pnpm-error',
      detail: `pnpm 以 ${known[1]} 失败（未归类，请按输出原文处理）`,
      recoverable: false,
      evidence,
    }
  }
  return {
    code: 'pnpm-failed',
    detail: `pnpm 以退出码 ${exitCode} 失败（输出中没有可识别的错误码）`,
    recoverable: false,
    evidence,
  }
}

/** 取输出里第一条有内容的行（诊断行只带一行证据，避免刷屏） */
function firstMeaningfulLine(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trim()
    if (line === '') continue
    if (/^(Progress|Packages|Done|Reusing|Resolving)/i.test(line)) continue
    return line.length > 200 ? `${line.slice(0, 200)}…` : line
  }
  return ''
}

/* ------------------------------------------------- 启动（P2-1：tee + 超时） */

/** 打包一次子进程的输出与结果 */
function payloadOf(outChunks, errChunks, extra) {
  const stdout = decodeOutput(outChunks)
  const stderr = decodeOutput(errChunks)
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    lossy: stdout.lossy || stderr.lossy,
    ...extra,
  }
}

/**
 * 启动 pnpm 并把输出**边收边转发**。
 *
 * 与官方的 `stdio: 'inherit'` 相比：同样实时（每个 chunk 立即写回父进程对应流），
 * 但字节被保留下来，因此可以按平台解码、按错误码分类、按需交给上游。
 * @param options - `{ invocation, args, cwd, env, timeoutMs, platform, onChunk, spawn, log, warn }`
 * @returns `{ command, args, exitCode, timedOut, signal, error, stdout, stderr, lossy, bytes }`
 */
export function runPnpm(options) {
  const {
    invocation,
    args = [],
    cwd,
    env = process.env,
    timeoutMs,
    platform = process.platform,
    onChunk,
    spawn: spawnImpl = spawn,
    stdout = process.stdout,
    stderr: stderrStream = process.stderr,
  } = options
  const argv = [...invocation.args, ...args]
  const command = invocation.command

  return new Promise((resolve) => {
    const outChunks = []
    const errChunks = []
    let timedOut = false
    let settled = false
    let timer
    let killTimer

    const finish = (payload) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      resolve({ command, args: argv, ...payloadOf(outChunks, errChunks, payload) })
    }

    let child
    try {
      child = spawnImpl(command, argv, {
        cwd,
        env: forwardEnv(env, platform),
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      })
    } catch (error) {
      resolve({ command, args: argv, exitCode: PNPM_MISSING_EXIT, error, timedOut: false, ...payloadOf(outChunks, errChunks, {}) })
      return
    }

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGTERM')
        } catch {
          // 进程可能已退出
        }
        // 兜底：SIGTERM 之后仍不退出（或 close 事件迟迟不来）时强杀并收尾，
        // 保证这个 Promise 一定会有结果，不会把调用方挂死。
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // 同上
          }
          finish({
            exitCode: TIMEOUT_EXIT,
            error: new Error(`pnpm 超时（${timeoutMs} ms）且未在宽限期内退出，已强杀`),
            timedOut: true,
            signal: 'SIGKILL',
          })
        }, 5_000)
      }, timeoutMs)
    }

    child.stdout?.on('data', (chunk) => {
      outChunks.push(chunk)
      if (typeof onChunk === 'function') onChunk('stdout', chunk)
      else stdout.write(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      errChunks.push(chunk)
      if (typeof onChunk === 'function') onChunk('stderr', chunk)
      else stderrStream.write(chunk)
    })
    child.on('error', (error) => {
      const missing = error.code === 'ENOENT' || error.code === 'EINVAL' || error.code === 'EACCES'
      finish({ exitCode: missing ? PNPM_MISSING_EXIT : 1, error, timedOut, signal: undefined })
    })
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({ exitCode: TIMEOUT_EXIT, error: undefined, timedOut: true, signal })
        return
      }
      if (code === null) {
        finish({ exitCode: 1, error: new Error(`pnpm 被信号 ${signal ?? 'unknown'} 终止`), timedOut: false, signal })
        return
      }
      finish({ exitCode: code, error: undefined, timedOut: false, signal })
    })
  })
}
