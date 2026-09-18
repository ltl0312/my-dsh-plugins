// tools/dsh-plugin-cmd/forward.mjs
// 确定性的 pnpm 转发器 —— 取代官方 `lib/plugin-<hash>.js` 里的 runPlugin。
//
// 为什么不再复用官方实现（评审结论 P0-1 / P0-2 / P1-1）：
//   * P0-2：官方 `spawnSync(..., { shell: process.platform === "win32" })` 在
//     Windows 上把命令行交给 cmd.exe，而 Node 对 `shell: true` 的构造是
//     `[file, ...args].join(" ")`，**不做任何转义或引用** —— 含空格的 spec 被拆成
//     多个参数（`file:D:/My Plugins/x` → `file:D:/My` + `Plugins/x`），`&` / `^`
//     之类的 cmd 元字符会被 cmd.exe 当成命令分隔符**额外执行**。本模块一律
//     `shell: false`：优先用真正的可执行文件（pnpm.exe），退而用当前 node 直接跑
//     pnpm 的 JS 入口（.cjs/.mjs），两者都不经 shell，argv 逐字到达。
//   * P0-1：官方 exportsPatch 的 try 只包住 resolveBundleDir，紧随其后的清单读取
//     抛 SyntaxError 时直接穿透到进程顶层 —— 原始堆栈外泄、归并中止，而 pnpm
//     已经改写过 profile，形成无提示的不一致状态。本模块把所有清单读取纳入保护，
//     解析类错误一律变成带稳定前缀的干净诊断 + 明确的退出码。
//   * P1-1：官方把「解析不到」与「不是 bundle」合并成同一个 false，于是「依赖仍在
//     依赖列表、但 node_modules 里已解析不到」会让层栈被**静默剔除**。本模块用
//     三态（bundle / plain / unknown）判定：unknown 一律保留现值 + 报错 + 非零退出。
//
// P2/P3 追加的四件事（都在这一层收口，见 pnpm.mjs）：
//   * P2-1：捕获 pnpm 输出（tee，实时转发 + 持有字节）、失败分类学、超时、代理翻译；
//   * P2-2：profile 自己是 workspace root 时自动补 `-w`（pnpm 9 上不补必失败）；
//   * P2-3：无模板的 profile 名首次创建必须显式确认（不再静默产出半成品 profile）；
//   * P2-4：清单回写前备份 + profile 互斥锁（stale 可接管）。
//
// 语义上与官方保持一致的部分：按「已安装状态」而非「依赖 diff」归并（`update` 后
// 新增声明 dsh.bundle 的包会自动进入层栈）；模板内置的非依赖 bundle 永不触碰；
// 相对路径 spec 锚定到调用目录；仅在确实发生变更时才回写清单。
//
// 全部副作用都通过注入的 `boot`（官方 app-boot 的公开 API）与 `runPnpmImpl` 完成，
// 因此可以在仓库里用真实临时目录做端到端单测，不需要 dsh 运行时。

import fs from 'node:fs'
import path from 'node:path'

import {
  BUILD_APPROVAL_KEYS,
  GIT_SPEC_PATTERN,
  LOCK_FILENAME,
  LOCK_STALE_MS,
  MANIFEST_BACKUP_SUFFIX,
  classifyDshPackage,
  listMountedEntries,
  timestamp,
} from './core.mjs'
import {
  TIMEOUT_EXIT,
  buildApprovalHint,
  classifyPnpmFailure,
  injectWorkspaceRootFlag,
  isWorkspaceRoot,
  readPnpmVersion,
  resolvePnpmInvocation,
  runPnpm,
} from './pnpm.mjs'

/** 所有诊断行的稳定前缀：上游/agent 可以用它替代「正则猜根因」 */
export const DIAGNOSE_PREFIX = 'dsh: diagnose:'

/**
 * 稳定退出码分类（评审 §5.5 + P2-1 的超时）。
 * `0` 成功 / `1` 用法或前置条件不满足 / `2` pnpm 缺失或起不来 /
 * `3` 清单非法 / `4` 归并不一致（未知态）/ `124` pnpm 超时被终止。
 * 其余情况原样透传 pnpm 自己的退出码。
 */
export const EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  pnpmMissing: 2,
  manifestInvalid: 3,
  reconcileInconsistent: 4,
  timeout: TIMEOUT_EXIT,
})

/** profile 的 package.json 不可用（读不到 / 非法 JSON / 不是对象）时抛出的错误 */
export class ProfileManifestError extends Error {
  constructor(detail) {
    super(detail)
    this.name = 'ProfileManifestError'
  }
}

/* --------------------------------------------------------------- 小工具 */

/** 单行化错误信息（诊断行必须一行一条，便于上游字符串匹配） */
function oneLine(value) {
  return String(value).replace(/\s*\n\s*/g, ' ').trim()
}

/** 该路径是否为已存在的普通文件 */
function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

/* ------------------------------------------------------- 参数锚定（§2.4） */

/** 仅匹配「以 `.` / `..` 开头」的路径型 spec，可带 file:/link: 前缀 */
const RELATIVE_SPEC = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/

/**
 * 把相对路径 spec 锚定到调用目录。
 *
 * pnpm 的 cwd 是 profile 目录，因此裸 `.` / `../plugin`（及其 file:/link: 形态）会被
 * 静默解析到 profile 内部 —— `add .` 会把 profile 链接到自己。只重写路径型参数，
 * `.hidden-pkg` 这类以点开头的**包名**不会被误伤（正则要求点后有分隔符）。
 *
 * 已知取舍：`--filter=.` / `--dir=./x` 这类「旗标携带路径值」的写法保持原样 ——
 * pnpm 的 `--filter` 相对的是 workspace root（正是 profile 目录），改成相对调用目录
 * 反而会把过滤目标指向 workspace 之外。
 * @param argument - 一个原始参数
 * @param cwd - `dsh` 的调用目录
 * @returns 锚定后的参数
 */
export function anchorPathSpec(argument, cwd) {
  const match = RELATIVE_SPEC.exec(String(argument))
  if (match?.groups?.path === undefined) return String(argument)
  return `${match.groups.prefix ?? ''}${path.resolve(cwd, match.groups.path)}`
}

/** 批量锚定 */
export function anchorArgs(args, cwd) {
  return args.map((argument) => anchorPathSpec(argument, cwd))
}

/* ---------------------------------------------- profile 锁（P2-4） */

/** 该 pid 是否还活着（EPERM 说明存在但没权限，同样算活着） */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * 取 profile 互斥锁（`<profile>/.dsh-plugin.lock`，O_EXCL 创建）。
 *
 * 为什么需要：`读清单 → 跑 pnpm → 读清单 → 写清单` 这条窗口里若有第二条 `dsh plugin`
 * （或 dshmarket / 用户手工编辑）也在改同一份清单，后写者会静默覆盖先写者。
 * 陈旧锁（超过 {@link LOCK_STALE_MS} 或持有者进程已消失）会被接管一次。
 * @param profileDir - profile 目录
 * @param options - `{ staleMs, pid, now }`
 * @returns `{ ok, file, code?, detail? }`
 */
export function acquireLock(profileDir, options = {}) {
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const pid = options.pid ?? process.pid
  const now = options.now ?? Date.now
  const file = path.join(profileDir, LOCK_FILENAME)

  const attempt = (retried) => {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, at: now() }), { encoding: 'utf8', flag: 'wx' })
      return { ok: true, file }
    } catch (error) {
      if (error.code !== 'EEXIST') {
        return { ok: false, file, code: 'lock-io-error', detail: oneLine(error.message) }
      }
      let info
      try {
        info = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        info = undefined
      }
      const age = typeof info?.at === 'number' ? now() - info.at : Number.POSITIVE_INFINITY
      const holderAlive = typeof info?.pid === 'number' ? isProcessAlive(info.pid) : false
      if (!retried && (age > staleMs || !holderAlive)) {
        try {
          fs.rmSync(file, { force: true })
        } catch {
          // 删不掉就按「仍被持有」处理
        }
        return attempt(true)
      }
      return {
        ok: false,
        file,
        code: 'lock-held',
        detail: `另一条 dsh plugin（pid ${info?.pid ?? '未知'}，${Math.round(age / 1000)}s 前取的锁）正在操作该 profile；如确认没有并发操作，可删除 ${file} 或加 --no-lock`,
      }
    }
  }
  return attempt(false)
}

/** 释放 profile 锁（尽力而为：锁文件残留有陈旧接管兜底） */
export function releaseLock(lock) {
  if (lock?.file === undefined || lock.ok !== true) return
  try {
    fs.rmSync(lock.file, { force: true })
  } catch {
    // 已经被别人清掉也无妨
  }
}

/* ------------------------------------------------ 依赖状态的三态判定（P0-1/P1-1） */

/**
 * 判定一个依赖当前的安装状态。
 *
 *   - `bundle`：解析得到包目录、清单合法、声明了 `dsh.bundle.patch`；
 *   - `plain` ：解析得到包目录、清单合法，但没有 `dsh.bundle` 声明（普通库或
 *     客户端型插件）—— 这是**确定**的事实；
 *   - `unknown`：解析不到包目录，或清单读不到 / 不是合法 JSON —— 这是**未知**，
 *     绝不能被当成「不是 bundle」（P1-1 的静默剔除正源于此合并）。
 * @param context - `{ name, profileDir, installAnchor, boot }`
 */
export function dependencyState({ name, profileDir, installAnchor, boot }) {
  let dir
  try {
    dir = boot.resolveBundleDir('dsh', name, installAnchor, profileDir)
  } catch (error) {
    return { state: 'unknown', code: 'dependency-unresolved', reason: `解析不到包目录（${oneLine(error.message)}）` }
  }
  const manifestPath = path.join(dir, 'package.json')
  let raw
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
  } catch (error) {
    return { state: 'unknown', code: 'manifest-unreadable', reason: `${manifestPath} 读不到（${error.code ?? 'ERR'}）` }
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    return {
      state: 'unknown',
      code: 'manifest-invalid',
      reason: `${manifestPath} 不是合法 JSON（${oneLine(error.message)}）`,
      dir,
    }
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { state: 'unknown', code: 'manifest-invalid', reason: `${manifestPath} 必须是 JSON 对象`, dir }
  }
  return manifest.dsh?.bundle?.patch !== undefined
    ? { state: 'bundle', code: 'bundle', reason: '声明了 dsh.bundle.patch', dir, manifest }
    : { state: 'plain', code: 'plain', reason: plainReason(manifest), dir, manifest }
}

/** 给「已解析、但不是 bundle」的包一句准确定位（含客户端型插件的激活提示） */
function plainReason(manifest) {
  const verdict = classifyDshPackage(manifest)
  if (verdict.kind === 'plugin') {
    return `声明了 dsh 元数据但不是 bundle（${verdict.reason}）—— 客户端型插件需要 cordis.patch.yml 挂载或 market 激活，装进去本身不会生效`
  }
  return `${verdict.reason}（普通库，不需要也不应该挂载）`
}

/**
 * 读取 profile 清单；任何失败都收敛为 {@link ProfileManifestError}。
 * @param profileDir - profile 目录
 * @param boot - 官方 app-boot 的公开 API
 */
export function readManifestOrThrow(profileDir, boot) {
  try {
    return boot.readProfileManifest('dsh', profileDir)
  } catch (error) {
    throw new ProfileManifestError(oneLine(error.message))
  }
}

/* --------------------------------------------------------- 归并（§2.3 + P1-1） */

/** 原子回写 profile 清单：先备份，再临时文件 + rename（P2-4） */
export function writeManifestAtomic(profileDir, manifest, options = {}) {
  const target = path.join(profileDir, 'package.json')
  const stamp = options.stamp ?? timestamp(options.now?.() ?? new Date())
  let backup
  if (options.backup !== false && fs.existsSync(target)) {
    backup = `${target}.${MANIFEST_BACKUP_SUFFIX}-${stamp}`
    try {
      fs.copyFileSync(target, backup)
    } catch {
      backup = undefined
    }
  }
  const temporary = `${target}.${MANIFEST_BACKUP_SUFFIX}-tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  fs.renameSync(temporary, target)
  return { backup, target }
}

/**
 * 按「已安装状态」归并 `dsh.profile.bundles`。
 *
 * 与官方的差异只有一处，但很关键：**未知态再也不会被当成「不是 bundle」**。
 *   - 依赖已不在列表 → 正常移除（可读日志）；
 *   - 依赖仍在、清单合法但没有 dsh.bundle 声明 → 移除 + 明确报出名字（官方是静默的）；
 *   - 依赖仍在、但解析不到/清单非法（unknown）→ **保留层栈现值** + 稳定前缀诊断 +
 *     退出码 4 —— 依赖仍在而包解析不到是真实的状态丢失，不允许无声掉项。
 * @param context - `{ profileDir, before, boot, installAnchor, log, warn, diagnose, stamp, now }`
 * @returns `{ changed, bundles, added, removed, issues, manifest, backup }`
 */
export function reconcileBundles({
  profileDir,
  before,
  boot,
  installAnchor,
  log = () => {},
  warn = () => {},
  diagnose = () => {},
  stamp,
  now,
}) {
  const after = readManifestOrThrow(profileDir, boot)
  const dependencies = Object.keys(after.dependencies ?? {})
  const optional = new Set(Object.keys(after.optionalDependencies ?? {}))
  const rawBundles = after.dsh?.profile?.bundles
  const plugins = Array.isArray(rawBundles) ? [...rawBundles] : []
  const beforeDeps = new Set(Object.keys(before?.dependencies ?? {}))

  // 单遍求值：依赖 ∪ 层栈各解析一次，两个分支共用结果（官方做了两遍）
  const names = [...new Set([...dependencies, ...optional, ...plugins])]
  const states = new Map(names.map((name) => [name, dependencyState({ name, profileDir, installAnchor, boot })]))

  const issues = []
  const added = []
  const removed = []

  // 新增分支：解析为 bundle 且尚未在层栈 → 追加（保持依赖顺序）
  for (const name of dependencies) {
    const state = states.get(name)
    if (state.state === 'bundle') {
      if (!plugins.includes(name)) {
        plugins.push(name)
        added.push(name)
      }
      continue
    }
    if (beforeDeps.has(name)) continue
    if (state.state === 'unknown') {
      issues.push({ name, code: state.code, detail: state.reason })
      continue
    }
    warn(`${name}：${state.reason}。已作为普通依赖安装，不属于 dsh.profile.bundles 层栈`)
  }

  // 移除分支：区分「依赖已删除」（正常）与「依赖仍在但状态未知」（异常，绝不静默）
  for (const name of [...plugins]) {
    const stillDependency = dependencies.includes(name) || optional.has(name)
    // 模板内置的非依赖 bundle（如 @deepseek-ai/dsh-base）：既不是依赖、也不曾是依赖，永不触碰
    if (!stillDependency && !beforeDeps.has(name)) continue
    if (!stillDependency) {
      plugins.splice(plugins.indexOf(name), 1)
      removed.push(name)
      log(`· 层栈移除 ${name}：已不再是 profile 依赖`)
      continue
    }
    const state = states.get(name)
    if (state.state === 'bundle') continue
    if (state.state === 'unknown') {
      // 保留层栈现值：宁可让启动时显式报错，也不能把已激活的插件无声掉线
      issues.push({ name, code: state.code, detail: state.reason })
      continue
    }
    plugins.splice(plugins.indexOf(name), 1)
    removed.push(name)
    warn(`${name} 仍在依赖中，但当前版本未声明 dsh.bundle.patch，已从层栈移除（旧版自动激活，新版不再生效）`)
  }

  for (const issue of issues) {
    diagnose(issue.code, `${issue.name}: ${issue.detail}（层栈保持原值不变，请修复后重跑）`)
  }
  if (removed.length > 0 && issues.length > 0) {
    warn(`本次从层栈移除：${removed.join(', ')}`)
  }

  const changed = added.length > 0 || removed.length > 0
  const manifest = changed
    ? { ...after, dsh: { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } } }
    : after
  let backup
  if (changed) {
    const written = writeManifestAtomic(profileDir, manifest, { stamp, now })
    backup = written.backup
    if (backup !== undefined) log(`  备份：${backup}`)
  }
  return { changed, bundles: plugins, added, removed, issues, manifest, backup }
}

/* -------------------------------------------------- 客户端插件的激活审计（P1-2） */

/**
 * 审计「已安装但不会生效」的插件。
 *
 * `dsh plugin <非 add 子命令>`（install / update…）只做依赖落盘，**不写**
 * cordis.patch.yml；而声明 `dsh.client` 的客户端型插件既不进 bundle 层栈、也不在
 * 补丁里 —— 结果就是 `exit 0` + 装了但不生效。这里把它变成一条可执行的提示。
 * @param context - `{ profileDir, boot, installAnchor, mountText, profile }`
 * @returns `{ hints, unresolved }`
 */
export function auditActivation({ profileDir, boot, installAnchor, mountText = '', profile = 'web' }) {
  const hints = []
  const unresolved = []
  let manifest
  try {
    manifest = readManifestOrThrow(profileDir, boot)
  } catch {
    // 清单读不出来时不做猜测：由调用方的归并阶段负责报错
    return { hints, unresolved }
  }
  const dependencies = Object.keys(manifest.dependencies ?? {})
  if (dependencies.length === 0) return { hints, unresolved }
  const bundled = new Set(Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [])
  const mounted = new Set(listMountedEntries(mountText).map((entry) => entry.name))

  for (const name of dependencies) {
    if (bundled.has(name) || mounted.has(name)) continue
    const state = dependencyState({ name, profileDir, installAnchor, boot })
    if (state.state === 'unknown') {
      unresolved.push({ name, code: state.code, detail: state.reason })
      continue
    }
    if (state.state !== 'plain') continue
    if (classifyDshPackage(state.manifest).kind !== 'plugin') continue
    hints.push({
      name,
      code: 'client-plugin-not-activated',
      detail: `已安装但未挂载：执行 dsh plugin --profile ${profile} add ${name} 会自动写入 cordis.patch.yml（或由 market 激活）`,
    })
  }
  return { hints, unresolved }
}

/* -------------------------------------------------------------- 四阶段编排 */

/** 构造一份空的运行报告（`--json` 的骨架，也是人读日志的结构化副本） */
export function emptyReport(profile) {
  return {
    command: 'plugin',
    profile,
    profileDir: undefined,
    phase: undefined,
    exitCode: 0,
    durationMs: 0,
    /** 前置条件不满足的原因码（此时 pnpm 根本没跑）；正常路径为 undefined */
    blocked: undefined,
    pnpm: undefined,
    lock: { acquired: false, path: undefined },
    workspaceRoot: false,
    targets: [],
    addedBundles: [],
    removedBundles: [],
    bundles: undefined,
    mounts: [],
    skipped: [],
    allowBuilds: { added: [], approved: [], skipped: [] },
    patchRemovals: undefined,
    rows: undefined,
    audit: undefined,
    backups: [],
    buildRetry: undefined,
    diagnostics: [],
  }
}

/**
 * 合并「前向器报告」与「管线报告」。
 *
 * 前向器的字段更具体（pnpm 调用、锁、层栈变更），管线的字段更贴近用户动作
 * （挂载、放行、审计）；两者都要保留，且一次 `add` 可能触发多次转发
 * （安装 → 放行后重跑 install），因此 pnpm 字段取**最后一次**调用。
 * 诊断行按 code+detail 去重，避免同一条被两级各报一次。
 * @param base - 管线报告（`--json` 的骨架）
 * @param forwarded - 前向器报告数组
 * @param diagnostics - command 层额外收集的诊断（顶层兜底等）
 */
export function mergeRunReports(base, forwarded = [], diagnostics = []) {
  const merged = { ...base }
  for (const item of forwarded) {
    for (const [key, value] of Object.entries(item)) {
      if (key === 'diagnostics' || key === 'lock') continue
      if (Array.isArray(value) && value.length === 0) continue
      if (value === undefined) continue
      merged[key] = value
    }
  }
  // 锁：本次命令只要有一轮真正持过锁就算持过（`add` 可能先装、再放行重跑）
  const locks = [base?.lock, ...forwarded.map((item) => item.lock)].filter((item) => item !== undefined)
  merged.lock = locks.find((item) => item?.acquired === true) ?? locks[locks.length - 1] ?? base?.lock
  const seen = new Set()
  // 诊断可能来自三处：管线报告、各轮前向器报告、调用方的顶层兜底。
  // 同一个 code+detail 只留一份（两级会各报一次同一条），顺序按首次出现。
  const all = [...(base?.diagnostics ?? []), ...forwarded.flatMap((item) => item?.diagnostics ?? []), ...diagnostics]
  merged.diagnostics = all.filter((item) => {
    const key = `${item?.code}\u0000${item?.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return merged
}

/**
 * 执行一次 `dsh plugin` 转发。
 *
 * ① 定位 pnpm（**先于任何落盘**，缺 pnpm 不再留下半成品 profile）；
 * ② 首次使用初始化 profile（无模板的名字必须显式确认）；
 * ③ 取 profile 锁 + 快照清单 + 原样转发 pnpm（shell:false，tee 捕获）；
 * ④ 退出码为 0 时按已安装状态归并层栈，随后释放锁。
 * @param options - `{ profile, args, boot, installAnchor, cwd, platform, env, flags, runPnpmImpl, resolvePnpm, log, warn, diagnose, now }`
 * @returns `{ exitCode, report }`
 */
export async function runForward({
  profile,
  args,
  boot,
  installAnchor,
  cwd = process.cwd(),
  platform = process.platform,
  env = process.env,
  flags = {},
  runPnpmImpl = runPnpm,
  resolvePnpm = resolvePnpmInvocation,
  readVersion = readPnpmVersion,
  // pnpm 输出实时转发到哪两条流（`--json` 模式下两者都指向 stderr，保证 stdout 只剩结果 JSON）
  stdout = process.stdout,
  stderr = process.stderr,
  log = () => {},
  warn = () => {},
  diagnose: diagnoseFn = () => {},
  now = () => new Date(),
}) {
  const startedAt = Date.now()
  const report = emptyReport(profile)
  const diagnostics = report.diagnostics
  const diagnose = (code, detail) => {
    diagnostics.push({ code, detail })
    diagnoseFn(code, detail)
  }
  const done = (exitCode, blocked) => {
    report.exitCode = exitCode
    // 前置条件不满足（pnpm 根本没跑）时留下**显式**标记：数字退出码会与 pnpm 自己的
    // 退出码撞车（pnpm 也用 1），因此不能靠数字判断「该不该继续」。
    if (blocked !== undefined) report.blocked = blocked
    report.durationMs = Date.now() - startedAt
    return { exitCode, report }
  }

  const argv = Array.isArray(args) ? args.map(String) : []

  // 本层全局旗标的用法校验（在任何落盘之前）
  if (flags.timeoutRaw !== undefined && flags.timeoutMs === undefined) {
    diagnose('timeout-invalid', `--timeout 的值 ${JSON.stringify(flags.timeoutRaw)} 无法解析；支持 1500 / 30s / 5m`)
    warn('dsh: error: --timeout 需要毫秒数或带单位的值（1500 / 30s / 5m）')
    return done(EXIT.usage, 'flag-invalid')
  }

  const bootApi = ['resolveProfileDir', 'initProfile', 'readProfileManifest']
  const missing = bootApi.filter((key) => typeof boot?.[key] !== 'function')
  if (missing.length > 0) {
    diagnose('boot-api-missing', `@deepseek-ai/dsh-app-boot 缺少 ${missing.join(', ')} —— 增强层与当前 dsh 版本不匹配，请重跑 install:cli 或还原 --uninstall`)
    return done(EXIT.usage, 'boot-api-missing')
  }

  // ① pnpm 可执行存在性先于落盘（P3-1：这条分支在 Windows 上必须真正可达）
  const pnpm = resolvePnpm({ platform, env, nodePath: process.execPath })
  if (pnpm === undefined) {
    warn('dsh: pnpm not found on PATH — install pnpm to manage profile plugins')
    diagnose('pnpm-not-found', `PATH 上没找到可执行的 pnpm（平台 ${platform}）`)
    return done(EXIT.pnpmMissing, 'pnpm-not-found')
  }

  // ② 定位 profile 目录（非法名字在这里就抛错，早于任何落盘）
  const dir = boot.resolveProfileDir(profile)
  report.profileDir = dir

  const manifestPath = path.join(dir, 'package.json')
  if (!isFile(manifestPath)) {
    const templates = boot.PROFILE_TEMPLATES ?? {}
    const template = templates[profile]
    if (template === undefined && flags.newProfile !== true) {
      // P2-3：无模板的名字若静默按 DEFAULT_PROFILE_BUNDLES 初始化，手误就会留下一个
      // 几乎是空的 profile 目录（评审 T17 的实际后果）。这里要求显式确认。
      diagnose('profile-template-missing', `profile「${profile}」没有内置模板；首次创建会以 ${(boot.DEFAULT_PROFILE_BUNDLES ?? []).join(', ') || '空'} 作为层栈`)
      warn(
        `dsh: error: 拒绝首次创建未知 profile「${profile}」——它没有内置模板。` +
          `确认要走这一步请加 --yes（别名 --new-profile），或改用内置 profile 名：${Object.keys(templates).join(' / ') || '（无）'}`,
      )
      return done(EXIT.usage, 'profile-template-missing')
    }
    boot.initProfile(dir, template?.bundles ?? boot.DEFAULT_PROFILE_BUNDLES, template?.patchReload)
    log(`dsh: initialized profile ${profile} at ${dir}`)
  }

  // ③ 取锁（P2-4）：只对会写盘的调用加锁，查询类命令不加锁
  let held
  const mutating = /^(?:add|remove|rm|uninstall|install|i|update|up|import|prune)$/.test(argv[0] ?? '')
  if (mutating && flags.lock !== false) {
    const lock = acquireLock(dir, { now: () => Date.now() })
    report.lock = { acquired: lock.ok, path: lock.file }
    if (!lock.ok) {
      diagnose(lock.code ?? 'lock-unavailable', lock.detail ?? '')
      warn(`dsh: error: 无法获取 profile 锁（${lock.file}）`)
      return done(EXIT.usage, 'lock-held')
    }
    held = lock
  }

  try {
    let before
    try {
      before = readManifestOrThrow(dir, boot)
    } catch (error) {
      diagnose('profile-manifest-invalid', `${manifestPath}: ${oneLine(error.message)}`)
      warn('dsh: error: profile 的 package.json 读不出来，已中止（未执行 pnpm、未改动任何文件）')
      return done(EXIT.manifestInvalid, 'manifest-invalid')
    }

    // P2-2：profile 自己就是 workspace root 时必须补 -w，否则 pnpm 9 上必失败
    const workspaceRoot = isWorkspaceRoot(dir)
    report.workspaceRoot = workspaceRoot
    const anchored = anchorArgs(argv, cwd)
    const pnpmArgs = injectWorkspaceRootFlag(anchored, { workspaceRoot })

    const version = readVersion(pnpm, { env, cwd: dir })
    const result = await runPnpmImpl({
      invocation: pnpm,
      args: pnpmArgs,
      cwd: dir,
      env,
      platform,
      timeoutMs: flags.timeoutMs,
      stdout,
      stderr,
    })

    report.pnpm = {
      command: result.command ?? pnpm.command,
      args: result.args ?? pnpmArgs,
      version: version?.raw,
      exitCode: result.exitCode,
      timedOut: result.timedOut === true,
      lossy: result.lossy === true,
      stdoutBytes: result.stdoutBytes ?? 0,
      stderrBytes: result.stderrBytes ?? 0,
    }

    if (result.timedOut === true) {
      diagnose('pnpm-timeout', `pnpm 超过 ${flags.timeoutMs} ms 未结束，已终止（退出码 ${EXIT.timeout}）`)
      warn(`dsh: error: pnpm 超时被终止（${flags.timeoutMs} ms）；profile 可能处于中间状态，请重跑`)
      return done(EXIT.timeout, 'timeout')
    }

    if (result.lossy === true) {
      // Windows 上被 pnpm 拉起的原生程序可能按 OEM 代码页写字节；不猜代码页，只如实标记
      diagnose('output-not-utf8', 'pnpm 输出里含非 UTF-8 字节（可能是 cmd.exe / 原生工具的 OEM 代码页），分类与证据行可能不完整')
    }

    if (result.error !== undefined) {
      const code = result.error.code ?? 'ERR'
      diagnose('pnpm-spawn-failed', `${code}: ${oneLine(result.error.message)}`)
      if (result.exitCode === EXIT.pnpmMissing) {
        warn('dsh: pnpm not found on PATH — install pnpm to manage profile plugins')
        return done(EXIT.pnpmMissing)
      }
      throw result.error
    }

    const exitCode = result.exitCode ?? 1
    if (exitCode !== 0) {
      warn(`dsh: pnpm failed in profile directory ${dir}`)
      const classified = classifyPnpmFailure(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, exitCode)
      diagnose(classified.code, `${classified.detail}${classified.recoverable ? '（可修复）' : ''}${classified.evidence ? ` — 证据：${classified.evidence}` : ''}`)
      if (argv.some((argument) => GIT_SPEC_PATTERN.test(argument))) {
        warn(buildApprovalHint({ major: version?.major, workspaceFile: path.join(dir, 'pnpm-workspace.yaml') }))
      }
      return done(exitCode)
    }

    // ④ 归并
    let reconciled
    try {
      reconciled = reconcileBundles({
        profileDir: dir,
        before,
        boot,
        installAnchor,
        log,
        warn,
        diagnose,
        stamp: timestamp(now()),
        now,
      })
    } catch (error) {
      if (error instanceof ProfileManifestError) {
        diagnose('profile-manifest-invalid', `${manifestPath}: ${error.message}`)
        warn(
          'dsh: error: profile 清单解析失败，dsh.profile.bundles 未归并 —— ' +
            'dependencies 已由 pnpm 改写而层栈仍是旧值，请修好清单后重跑本命令',
        )
        return done(EXIT.manifestInvalid)
      }
      throw error
    }

    report.addedBundles = reconciled.added
    report.removedBundles = reconciled.removed
    report.bundles = reconciled.bundles
    if (reconciled.added.length > 0) log(`✔ 层栈新增 ${reconciled.added.join(', ')}`)
    if (reconciled.issues.length > 0) {
      warn(`dsh: ${reconciled.issues.length} 个依赖的安装状态无法判定（见上方 ${DIAGNOSE_PREFIX} 行），层栈未被改动`)
      return done(EXIT.reconcileInconsistent)
    }
    return done(EXIT.ok)
  } finally {
    releaseLock(held)
  }
}

/* ---------------------------------------------------------- 兼容导出 */

/** @deprecated 直接用 `pnpm.mjs` 的导出；这里保留转发以免既有引用断裂 */
export { pathDirs, extractShimTargets, resolvePnpmInvocation } from './pnpm.mjs'
export { BUILD_APPROVAL_KEYS }
