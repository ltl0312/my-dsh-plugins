// tools/dsh-plugin-cmd/command.mjs
// dsh 安装内的运行时外壳（安装后落盘为 <dsh>/lib/commands/plugin.js）。
//
// 职责边界：本文件**只做与 dsh 运行时耦合的事** —— 载入官方 app-boot、拼出
// INSTALL_ANCHOR、装配 api、读写标准流；全部业务判断都在 core.mjs / pipeline.mjs /
// forward.mjs / pnpm.mjs 里，因而那些模块可被仓库单测覆盖。
//
// 关键设计：
//   1. **不再复用官方 `plugin-<hash>.js` 的 runPlugin**，改为把 pnpm 转发的四个阶段
//      （定位 pnpm / 初始化 / 转发 / 归并）交给 forward.mjs，原因见该文件头部
//      （P0-2 的 cmd.exe 拆参数与注入面、P0-1 的清单解析崩溃、P1-1 的静默剔除）。
//     官方 app-boot 的公开 API 照旧复用，语义不另起一套。
//   2. 输出分两条：人读日志走 stderr，`--json` 时 stdout 只承载一行机器可读结果
//      （评审 §5.5 要求的「结构化失败契约」）。写流用 `fs.writeSync`：`process.stdout.write`
//      在管道场景是异步的，紧跟 `process.exit()` 有截断风险（P3-4）。
//   3. 顶层兜底 catch：绝不外泄原始堆栈，也绝不让异常变成静默的 exit 1。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseGlobalFlags, parsePluginSubcommand } from './core.mjs'
import { DIAGNOSE_PREFIX, auditActivation, emptyReport, mergeRunReports, runForward } from './forward.mjs'
import { runPluginCommand as dispatch } from './pipeline.mjs'

/** 未显式指定 --profile 时使用的 profile */
export const DEFAULT_PROFILE = 'web'

/** 本文件位于 <dsh>/lib/commands/ 下 */
const here = path.dirname(fileURLToPath(import.meta.url))
const libDir = path.resolve(here, '..')

/**
 * 安装锚点 = 本 dsh 安装的 package.json 绝对路径。
 * 与官方 `plugin-<hash>.js` 里的 INSTALL_ANCHOR 同值（src/ 与 lib/ 都在 apps/cli 下一层），
 * bundle 解析因此仍遵循「先 dsh 安装、再 profile 目录」的契约。
 */
export const INSTALL_ANCHOR = path.resolve(libDir, '..', 'package.json')

/** 载入官方 app-boot（提供 resolveProfileDir / initProfile 等公开 API） */
async function loadBootApi() {
  return import('@deepseek-ai/dsh-app-boot')
}

/**
 * 同步写一行 —— 见文件头第 2 点：管道场景下必须同步写，否则可能被 exit 截断。
 * @param fd - 1 = stdout，2 = stderr
 */
function writeLine(fd) {
  return (line) => {
    try {
      fs.writeSync(fd, `${line}\n`)
    } catch {
      // 流被关掉（例如管道下游提前退出）不该让命令失败
    }
  }
}

/**
 * 原始字节写：把 pnpm 的输出**原样**转发到指定 fd（不能经 {@link writeLine}，那会补换行）。
 * @param fd - 1 = stdout，2 = stderr
 */
function rawWrite(fd) {
  return (chunk) => {
    try {
      fs.writeSync(fd, chunk)
    } catch {
      // 同上
    }
  }
}

/**
 * `dsh plugin --profile <名称> …` 的入口（bin.js 调用）。
 * @param profile - profile 名；缺省时回落到 {@link DEFAULT_PROFILE}
 * @param args - `dsh plugin` 之后的参数
 * @returns 进程退出码
 */
export async function runPluginCommand(profile, args) {
  const boot = await loadBootApi()
  const argv = Array.isArray(args) ? args : []
  const explicit = typeof profile === 'string' && profile !== ''
  const effectiveProfile = explicit ? profile : DEFAULT_PROFILE
  const flags = parseGlobalFlags(argv)
  // 只在真的要干活时提示默认值：`dsh plugin --help` 不该被这句噪音打扰
  if (!explicit && parsePluginSubcommand(argv).kind !== 'help') {
    process.stderr.write(`dsh: 未指定 --profile，使用默认 profile「${effectiveProfile}」\n`)
  }

  // json 模式下 stdout **只**放结果 JSON：人读信息与 pnpm 自己的输出都改走 stderr
  const humanOut = flags.json ? writeLine(2) : writeLine(1)
  const jsonOut = writeLine(1)
  const errOut = writeLine(2)
  // pnpm 的实时转发目标：`--json` 时连它的 stdout 也改道 stderr（否则会污染 JSON 流）
  const pnpmStdout = { write: flags.json ? rawWrite(2) : rawWrite(1) }
  const pnpmStderr = { write: rawWrite(2) }
  const diagnostics = []
  const forwardReports = []
  let lastForward = { exitCode: undefined, blocked: undefined }
  const diagnose = (code, detail) => {
    diagnostics.push({ code, detail })
    errOut(`${DIAGNOSE_PREFIX} ${code}: ${detail}`)
  }

  const api = {
    cwd: process.cwd(),
    flags,
    resolveProfileDir: (name) => boot.resolveProfileDir(name),
    // 「上一轮转发是否根本没跑 pnpm」——数字退出码会与 pnpm 自己的码撞车，因此显式给出
    lastForward: () => lastForward,
    // 四阶段转发：定位 pnpm → 初始化 → 无 shell 转发（tee 捕获）→ 三态归并
    forwardPnpm: async (name, pnpmArgs) => {
      const { exitCode, report } = await runForward({
        profile: name,
        args: pnpmArgs,
        boot,
        installAnchor: INSTALL_ANCHOR,
        cwd: process.cwd(),
        flags,
        stdout: pnpmStdout,
        stderr: pnpmStderr,
        log: errOut,
        warn: errOut,
        diagnose,
      })
      forwardReports.push(report)
      lastForward = { exitCode, blocked: report.blocked }
      return exitCode
    },
    // P1-2：客户端型插件「装了但不生效」的审计
    audit: ({ profileDir, mountText }) =>
      auditActivation({ profileDir, boot, installAnchor: INSTALL_ANCHOR, mountText, profile: effectiveProfile }),
    stdout: humanOut,
    stderr: errOut,
    now: () => new Date(),
  }

  let exitCode
  let pipelineReport
  try {
    exitCode = await dispatch({
      profile: effectiveProfile,
      args: argv,
      api: {
        ...api,
        report: (report) => {
          pipelineReport = report
        },
      },
    })
  } catch (error) {
    // 顶层兜底：绝不让原始堆栈外泄（那正是 P0-1 的现场），也绝不让异常变成静默的
    // exit 1。诊断行带稳定前缀，模型的解释与修复建议可以挂在它上面。
    const message = String(error?.message ?? error)
      .replace(/\s*\n\s*/g, ' ')
      .trim()
    errOut(`dsh: error: ${message}`)
    diagnose('unexpected-error', `${error?.name ?? 'Error'} —— 本次未完成，请核对 profile 目录后重试`)
    exitCode = 1
  }

  if (flags.json === true) {
    const merged = mergeRunReports({ ...emptyReport(effectiveProfile), ...(pipelineReport ?? {}) }, forwardReports, diagnostics)
    merged.exitCode = exitCode
    jsonOut(JSON.stringify(merged))
  }

  return exitCode
}
