// tools/dsh-plugin-cmd/install.mjs
// 把 `dsh plugin` 增强层安装进全局的 @deepseek-ai/dsh 安装。
//
// 为什么要安装而不是直接改包：dsh CLI 是**全局已安装的第三方包**，其 lib/*.js 是
// 构建产物（带 hash 的文件名）。直接手改会有两个后果：升级即丢失、改坏即整个 CLI 报废。
// 因此本安装器的原则是：
//   * 业务代码放独立目录 lib/commands/，可整体重装刷新；
//   * 对 bin.js 只做若干处**幂等、可校验的最小替换**（含 P1-3：plugin 子命令改用
//     透传选项、`--profile` 给两次显式报错），替换前先备份、替换后先语法校验再落盘；
//   * 任一步不满足预期就中止且不写盘（宁可没装上，不能把 CLI 弄坏）。
//
// 用法：
//   node tools/dsh-plugin-cmd/install.mjs               # 安装（幂等，可重复执行刷新代码）
//   node tools/dsh-plugin-cmd/install.mjs --uninstall   # 还原 bin.js 并移除 lib/commands
//   node tools/dsh-plugin-cmd/install.mjs --dsh <路径>  # 指定 dsh 包目录
//   node tools/dsh-plugin-cmd/install.mjs --dry-run     # 只报告将做的改动

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { pathDirs } from './forward.mjs'
import { pluginHelpText } from './core.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 需要复制进 <dsh>/lib/commands/ 的文件（源名 → 目标名） */
const MODULE_MAP = [
  ['core.mjs', 'core.mjs'],
  ['pnpm.mjs', 'pnpm.mjs'],
  ['forward.mjs', 'forward.mjs'],
  ['pipeline.mjs', 'pipeline.mjs'],
  ['command.mjs', 'plugin.js'],
]

/** 安装标记：bin.js 里出现它即认为已打过补丁 */
const DISPATCH_MARKER = './commands/plugin.js'

/** bin.js 备份前缀 */
const BACKUP_PREFIX = 'bin.js.bak-dsh-plugin-'

/** plugin 子命令独有的参数描述：用作定位固化帮助文本的锚点 */
const PLUGIN_ARGS_DESCRIPTION =
  '"pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)"'

/** plugin 子命令的 `.argument(...)` 调用整体（透传选项就加在它前面） */
const PLUGIN_ARGUMENT_CALL = `.argument("[args...]", ${PLUGIN_ARGS_DESCRIPTION})`

/** `.passThroughOptions()` 的目标形态 */
const PLUGIN_PASSTHROUGH =
  '.passThroughOptions().enablePositionalOptions().argument("[args...]", ' + PLUGIN_ARGS_DESCRIPTION + ')'

/** `--profile` 选项的三种形态：上游原始 / 增强层 v1 / 增强层 v2（当前目标） */
const PROFILE_OPTION_UPSTREAM =
  '.requiredOption("--profile <name>", "the profile whose plugins to manage (initialized on first use)")'
const PROFILE_OPTION_V1 =
  '.option("--profile <name>", "the profile whose plugins to manage (default: web; initialized on first use)")'
const PROFILE_OPTION_V2 =
  '.option("--profile <name>", "the profile whose plugins to manage (default: web; initialized on first use)", collectProfile)'

/** `--profile` 为可选后，官方那句 `rejectElectronProfile(plugin, options.profile)` 会因
 *  undefined.toLowerCase() 抛错并被 commander 的 catch 静默吞成 exit 1 —— 于是
 *  `dsh plugin`（无参数）与 `dsh plugin --help` 都变成「零输出 + 退出码 1」。这里把调用
 *  收进 undefined 判断，重复给值也一并显式报错（P1-3）。 */
const PROFILE_GUARD =
  '\t\tif (Array.isArray(options.profile)) program.error("error: --profile was given more than once: " + ' +
  'options.profile.map((value) => JSON.stringify(value)).join(", ") + " — it must appear once, before the pnpm arguments");\n' +
  '\t\tif (options.profile !== void 0) rejectElectronProfile(plugin, options.profile);\n'

/** 守卫已就位的判据（用于幂等/迁移判断） */
const PROFILE_GUARD_MARKER = 'if (options.profile !== void 0) rejectElectronProfile(plugin, options.profile);'

/** 注入的收集器定义：让「`--profile` 给两次」变成可判定的错误而不是静默覆盖（P1-3） */
const PROFILE_COLLECTOR = [
  '/** `--profile` 给两次是错误，不是静默覆盖 —— 保留两个值交给命令自己去拒绝。 */',
  'const collectProfile = (value, previous) => previous === void 0 ? value : [...(Array.isArray(previous) ? previous : [previous]), value];',
].join('\n')

/* ------------------------------------------------------------ 定位安装 */

/**
 * 定位全局 @deepseek-ai/dsh 包目录。
 * 依次尝试：显式参数 → 环境变量 → 与当前 node 同级/上级的 node_modules →
 * 常见全局目录 → APPDATA 下的 npm 全局目录。
 * @param explicit - `--dsh` 传入的路径
 * @returns 绝对路径；找不到返回 undefined
 */
export function resolveDshDir(explicit) {
  const candidates = []
  if (typeof explicit === 'string' && explicit !== '') candidates.push(explicit)
  if (process.env.DSH_CLI_HOME) candidates.push(process.env.DSH_CLI_HOME)

  const nodeDir = path.dirname(process.execPath)
  candidates.push(
    path.join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh'),
    path.join(nodeDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  )
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  candidates.push(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh', '/usr/lib/node_modules/@deepseek-ai/dsh')

  // 沿 PATH 找 dsh 垫片旁边的包目录。这条覆盖「跑安装器的 node 与装了 dsh 的 node
  // 不是同一个前缀」的常见情况（本机就是：managed node 之外另有一套全局 dsh），
  // 否则用户必须手工传 --dsh 才能装上。
  for (const dir of pathDirs(process.env, process.platform)) {
    candidates.push(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh'))
    candidates.push(path.resolve(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  }

  for (const candidate of candidates) {
    const dir = path.resolve(candidate)
    if (fs.existsSync(path.join(dir, 'lib', 'bin.js'))) return dir
  }
  return undefined
}

/* --------------------------------------------------------- bin.js 补丁 */

/**
 * 生成打过补丁的 bin.js 内容。
 *
 * 每一步都锚定在 dsh CLI 里的**唯一**文本上，且都带「已应用」判据，因此本函数
 * 幂等 —— 重复执行、以及在旧版增强层（v1）之上做升级，结果都一样。
 * 任一步骤锚点缺失即整体返回失败，由调用方中止（避免「只改了一半」的半残状态）。
 * @param source - bin.js 原文
 * @param help - `dsh plugin --help` 的正文（安装时固化进去）
 * @returns `{ ok: true, text, applied }` 或 `{ ok: false, missing }`
 */
export function patchBinJs(source, help) {
  const applied = []
  const missing = []
  let text = source

  /**
   * 应用一条替换。
   * @param step - `{ name, from: string|string[], to: string|function, already?: (text) => boolean }`
   */
  const apply = (step) => {
    if (typeof step.already === 'function' && step.already(text)) return
    const candidates = Array.isArray(step.from) ? step.from : [step.from]
    const from = candidates.find((candidate) => text.includes(candidate))
    if (from === undefined) {
      missing.push(step.name)
      return
    }
    const index = text.indexOf(from)
    const replacement = typeof step.to === 'function' ? step.to(from) : step.to
    text = text.slice(0, index) + replacement + text.slice(index + from.length)
    applied.push(step.name)
  }

  apply({
    name: 'profile 选项改为可选且重复即报错（P1-3）',
    from: [PROFILE_OPTION_UPSTREAM, PROFILE_OPTION_V1],
    to: PROFILE_OPTION_V2,
    already: (value) => value.includes(PROFILE_OPTION_V2),
  })
  apply({
    name: '注入 --profile 收集器',
    from: 'const collect = (value, previous = []) => [...previous, value];',
    to: (matched) => `${matched}\n${PROFILE_COLLECTOR}`,
    already: (value) => value.includes('const collectProfile ='),
  })
  apply({
    name: 'plugin 子命令改为透传选项（P1-3）',
    from: PLUGIN_ARGUMENT_CALL,
    to: (matched) => `.passThroughOptions().enablePositionalOptions()${matched}`,
    already: (value) => value.includes(PLUGIN_PASSTHROUGH),
  })
  apply({
    name: '重复/缺省 --profile 的处理（P1-3）',
    from: '\t\trejectElectronProfile(plugin, options.profile);\n',
    to: PROFILE_GUARD,
    already: (value) => value.includes(PROFILE_GUARD_MARKER),
  })
  apply({
    name: '注入 plugin 子命令帮助',
    from: PLUGIN_ARGUMENT_CALL,
    to: (matched) => `${matched}.addHelpText("after", ${JSON.stringify(help)})`,
    // 官方 bin.js 自己也有 addHelpText（根命令的示例），因此只在 plugin 的参数
    // 描述**紧邻**处判断是否已注入，避免把根命令的那一处误判为「已应用」
    already: (value) => value.includes(`${PLUGIN_ARGUMENT_CALL}.addHelpText(`),
  })
  apply({
    name: '无参数时改为打印帮助',
    from: '\t\tif (args.length === 0) program.error("error: plugin needs pnpm arguments to forward (e.g. add <package>)");\n',
    to: '',
    already: (value) => !value.includes('plugin needs pnpm arguments to forward'),
  })

  if (text.includes(DISPATCH_MARKER)) {
    applied.push('分发入口（已存在，跳过）')
  } else {
    const importPattern = /const \{ runPlugin \} = await import\((["'])\.\/plugin-[^"']+\1\);/
    if (importPattern.test(text)) {
      text = text.replace(importPattern, `const { runPluginCommand } = await import("./commands/plugin.js");`)
      applied.push('替换分发模块导入')
    } else {
      missing.push('替换分发模块导入')
    }
    const callPattern = 'process.exit(runPlugin(invocation.profile, invocation.args));'
    if (text.includes(callPattern)) {
      text = text.replace(
        callPattern,
        'process.exit(await runPluginCommand(invocation.profile, invocation.args));',
      )
      applied.push('替换分发调用')
    } else {
      missing.push('替换分发调用')
    }
  }

  if (missing.length > 0) return { ok: false, missing, applied }
  return { ok: true, text, applied }
}

/**
 * 刷新已安装版本里固化的帮助文本。
 *
 * 帮助正文是安装时写进 bin.js 的字符串常量，因此改了 core.mjs 的帮助内容后，
 * 重装必须把它同步过去，否则 `dsh plugin --help` 会一直显示旧文案。
 * 定位方式：锚在 plugin 子命令独有的 parameters 描述后紧跟的那个 addHelpText 上，
 * 用「扫描到未转义引号」的方式取出整个字符串字面量，避免正则截断转义序列。
 * @param source - 已是增强版的 bin.js
 * @param help - 新的帮助正文
 * @returns `{ ok, text, changed }`
 */
export function refreshHelpText(source, help) {
  const anchor = source.indexOf(PLUGIN_ARGS_DESCRIPTION)
  if (anchor === -1) return { ok: false, text: source, changed: false, reason: '未找到 plugin 子命令的参数描述锚点' }
  const callIndex = source.indexOf('.addHelpText("after", ', anchor)
  if (callIndex === -1) return { ok: false, text: source, changed: false, reason: '未找到固化的帮助文本调用' }
  const quoteStart = callIndex + '.addHelpText("after", '.length
  if (source[quoteStart] !== '"') return { ok: false, text: source, changed: false, reason: '帮助文本不是字符串字面量' }
  let i = quoteStart + 1
  while (i < source.length) {
    const char = source[i]
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '"') break
    i += 1
  }
  if (i >= source.length) return { ok: false, text: source, changed: false, reason: '帮助文本字面量未闭合' }
  const current = source.slice(quoteStart, i + 1)
  const next = JSON.stringify(help)
  if (current === next) return { ok: true, text: source, changed: false }
  return { ok: true, text: source.slice(0, quoteStart) + next + source.slice(i + 1), changed: true }
}

/** 用当前 node 做语法校验（在 dsh 包内建临时文件，好让 type: module 生效） */
function syntaxCheck(targetDir, content) {
  const probe = path.join(targetDir, '.bin-cmdcheck.js')
  try {
    fs.writeFileSync(probe, content, 'utf8')
    const result = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' })
    return { ok: result.status === 0, detail: (result.stderr ?? '').split('\n').slice(0, 4).join('\n') }
  } finally {
    try {
      fs.unlinkSync(probe)
    } catch {
      // 临时文件不存在也无所谓
    }
  }
}

/* ---------------------------------------------------------------- 主流程 */

const STAMP = (() => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
})()

/** 备份所有 bin.js.bak-dsh-plugin-* 里最新的一个 */
function latestBackup(libDir) {
  let best
  for (const file of fs.readdirSync(libDir)) {
    if (!file.startsWith(BACKUP_PREFIX)) continue
    if (best === undefined || file > best) best = file
  }
  return best === undefined ? undefined : path.join(libDir, best)
}

/** 用法说明 */
function usage() {
  return `用法：node tools/dsh-plugin-cmd/install.mjs [选项]

选项：
  （无）            安装 / 刷新增强层（幂等：模块整体重刷，bin.js 只在需要时改）
  --uninstall      从最近的 bin.js 备份还原，并移除 lib/commands
  --dry-run        只报告将做的改动，不落盘
  --dsh <路径>     指定 @deepseek-ai/dsh 包目录（默认自动探测）
  -h, --help       显示本说明

为什么需要这个安装器：
  dsh CLI 是全局已安装的第三方包，其 lib/*.js 是带 hash 的构建产物。
  **每次升级 / 重装 @deepseek-ai/dsh 都会覆盖 bin.js，增强层随之丢失** ——
  升级后重新执行一次本脚本即可恢复（不必重装任何 npm 包）。
  lib/commands/ 下是独立文件，重刷不影响 dsh 自身逻辑。

回滚：
  node tools/dsh-plugin-cmd/install.mjs --uninstall
  备份为 <dsh>/lib/bin.js.bak-dsh-plugin-<时间戳>。
`
}

function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(usage())
    return 0
  }
  const dryRun = argv.includes('--dry-run')
  const uninstall = argv.includes('--uninstall')
  const dshArgIndex = argv.indexOf('--dsh')
  const explicit = dshArgIndex === -1 ? undefined : argv[dshArgIndex + 1]

  const dshDir = resolveDshDir(explicit)
  if (dshDir === undefined) {
    console.error('未能定位 @deepseek-ai/dsh 安装目录；请用 --dsh <路径> 指定')
    return 1
  }
  const libDir = path.join(dshDir, 'lib')
  const binFile = path.join(libDir, 'bin.js')
  const commandsDir = path.join(libDir, 'commands')
  console.log(`dsh 安装目录：${dshDir}`)

  if (uninstall) {
    const backup = latestBackup(libDir)
    if (backup === undefined) {
      console.error(`未找到备份（${BACKUP_PREFIX}*），无法还原 bin.js`)
      return 1
    }
    console.log(`还原：${path.basename(backup)} → bin.js`)
    if (!dryRun) {
      fs.copyFileSync(backup, binFile)
      fs.rmSync(commandsDir, { recursive: true, force: true })
    }
    console.log(dryRun ? '（--dry-run，未落盘）' : '已卸载增强层，`dsh plugin` 恢复为原样转发 pnpm')
    return 0
  }

  const original = fs.readFileSync(binFile, 'utf8')
  const help = pluginHelpText()

  // 幂等：无论 bin.js 是上游原文、增强层 v1 还是当前版本，都收敛到同一目标形态
  const patched = patchBinJs(original, help)
  if (!patched.ok) {
    console.error('bin.js 补丁未命中以下位置，已中止（未写任何文件）：')
    for (const name of patched.missing) console.error(`  - ${name}`)
    console.error('这通常意味着 dsh 版本变化导致 CLI 结构改动，请人工核对 lib/bin.js 后再安装。')
    return 1
  }
  const refreshed = refreshHelpText(patched.text, help)
  if (!refreshed.ok) {
    console.error(`bin.js 帮助文本刷新失败，已中止（未写任何文件）：${refreshed.reason}`)
    return 1
  }
  const patchedText = refreshed.text
  const binChanged = patchedText !== original
  const applied = patched.applied.filter((name) => !name.includes('已存在'))

  const check = syntaxCheck(libDir, patchedText)
  if (!check.ok) {
    console.error('打过补丁的 bin.js 语法校验失败，已中止（未写任何文件）：')
    console.error(check.detail)
    return 1
  }

  if (dryRun) {
    console.log('将执行的改动：')
    for (const name of applied) console.log(`  ✔ ${name}`)
    if (refreshed.changed) console.log('  ✔ 刷新固化的帮助文本')
    if (!binChanged) console.log('  · bin.js 已是目标形态，无需改动')
    console.log(`  ✔ 复制模块到 ${commandsDir}`)
    for (const [from, to] of MODULE_MAP) console.log(`      ${from} → commands/${to}`)
    console.log('（--dry-run，未落盘）')
    return 0
  }

  // 1) 先铺业务模块（bin.js 引用它，必须先就位）
  fs.mkdirSync(commandsDir, { recursive: true })
  for (const [from, to] of MODULE_MAP) {
    fs.copyFileSync(path.join(here, from), path.join(commandsDir, to))
    console.log(`  ✔ 复制 ${from} → lib/commands/${to}`)
  }

  // 2) 再补 bin.js（已是目标形态时一个字节都不动）
  if (binChanged) {
    const backupPath = `${binFile}.bak-dsh-plugin-${STAMP}`
    fs.copyFileSync(binFile, backupPath)
    fs.writeFileSync(binFile, patchedText, 'utf8')
    console.log(`  ✔ 备份 bin.js → ${path.basename(backupPath)}`)
    for (const name of applied) console.log(`  ✔ ${name}`)
    if (refreshed.changed) console.log('  ✔ 刷新固化的帮助文本')
  } else {
    console.log('  · bin.js 已是最新增强版，无需改动')
  }

  console.log('')
  console.log('安装完成。验证：')
  console.log('  dsh plugin --help')
  console.log('  dsh plugin --profile web list')
  return 0
}

/* v8 ignore next 3 -- 直接执行入口 */
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exit(main(process.argv.slice(2)))

export { main, MODULE_MAP }
