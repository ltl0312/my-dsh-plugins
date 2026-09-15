// tools/dsh-plugin-cmd/command.mjs
// dsh 安装内的运行时外壳（安装后落盘为 <dsh>/lib/commands/plugin.js）。
//
// 职责边界：本文件**只做与 dsh 运行时耦合的事** —— 定位官方模块、装配 api、读写
// 标准流；全部业务判断都在 core.mjs / pipeline.mjs 里，因而那两份可被仓库单测覆盖。
//
// 关键设计：把 pnpm 转发继续交给**官方 runPlugin**，从而完整保留两项既有行为：
//   1. 首次使用时自动初始化 profile（initProfile + 模板 bundles）；
//   2. 装完后 reconcile `dsh.profile.bundles` 层栈。
// 官方模块的文件名带构建 hash（plugin-XXXX.js），因此**不写死**：先从 bin.js 里
// 解析出真实的动态 import 目标，找不到再按 `plugin-*.js` 命名约定兜底。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { runPluginCommand as dispatch } from './pipeline.mjs'
import { parsePluginSubcommand } from './core.mjs'

/** 未显式指定 --profile 时使用的 profile */
export const DEFAULT_PROFILE = 'web'

/** 本文件位于 <dsh>/lib/commands/ 下 */
const here = path.dirname(fileURLToPath(import.meta.url))
const libDir = path.resolve(here, '..')

/** 载入官方 app-boot（提供 resolveProfileDir / initProfile 等公开 API） */
async function loadBootApi() {
  return import('@deepseek-ai/dsh-app-boot')
}

/**
 * 从 bin.js 里解析官方 runPlugin 模块的真实文件名。
 * 不写死 hash：dsh 升级后文件名会变，解析得到才能真正复用官方逻辑。
 * @returns 候选文件名列表
 */
function runPluginCandidates() {
  const candidates = []
  try {
    const text = fs.readFileSync(path.join(libDir, 'bin.js'), 'utf8')
    for (const line of text.split('\n')) {
      if (!line.includes('runPlugin')) continue
      const match = /import\(\s*["']\.\/([^"']+\.js)["']\s*\)/.exec(line)
      if (match !== null) candidates.push(match[1])
    }
  } catch {
    // bin.js 读不到就走命名约定兜底
  }
  try {
    for (const file of fs.readdirSync(libDir)) {
      if (/^plugin-.*\.js$/.test(file)) candidates.push(file)
    }
  } catch {
    // 目录读不到：交给调用方的降级路径
  }
  return [...new Set(candidates)]
}

/** 载入官方 runPlugin；找不到返回 undefined */
async function loadOriginalRunPlugin() {
  for (const file of runPluginCandidates()) {
    try {
      const mod = await import(pathToFileURL(path.join(libDir, file)).href)
      if (typeof mod.runPlugin === 'function') return mod.runPlugin
    } catch {
      // 单个候选模块导入失败不影响其它候选
    }
  }
  return undefined
}

/**
 * 降级转发器：官方模块定位失败时使用。
 * 仍会按官方规则初始化 profile 并转发 pnpm，但**跳过 bundles 层栈协调**，
 * 因此必须显式告警而不是静默降级。
 * @param boot - app-boot 的导出面
 */
function makeFallbackForwarder(boot) {
  return (profile, pnpmArgs) => {
    const dir = boot.resolveProfileDir(profile)
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      const template = boot.PROFILE_TEMPLATES?.[profile]
      boot.initProfile(dir, template?.bundles ?? boot.DEFAULT_PROFILE_BUNDLES, template?.patchReload)
      process.stderr.write(`dsh: initialized profile ${profile} at ${dir}\n`)
    }
    const result = spawnSync('pnpm', pnpmArgs, {
      cwd: dir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (result.error !== undefined) {
      if (result.error.code === 'ENOENT') {
        process.stderr.write('dsh: pnpm not found on PATH — install pnpm to manage profile plugins\n')
        return 127
      }
      throw result.error
    }
    const exitCode = result.status ?? 1
    if (exitCode === 0) {
      process.stderr.write(
        'dsh: warning: 未定位到官方 plugin 模块，本次跳过了 dsh.profile.bundles 层栈协调；' +
          '若该插件是 bundle，请重新安装 @deepseek-ai/dsh 后重试\n',
      )
    }
    return exitCode
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
  // 只在真的要干活时提示默认值：`dsh plugin --help` 不该被这句噪音打扰
  if (!explicit && parsePluginSubcommand(argv).kind !== 'help') {
    process.stderr.write(`dsh: 未指定 --profile，使用默认 profile「${effectiveProfile}」\n`)
  }

  const original = await loadOriginalRunPlugin()
  const api = {
    cwd: process.cwd(),
    resolveProfileDir: (name) => boot.resolveProfileDir(name),
    forwardPnpm: original ?? makeFallbackForwarder(boot),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date(),
  }
  return dispatch({ profile: effectiveProfile, args: argv, api })
}
