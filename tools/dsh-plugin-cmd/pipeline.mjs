// tools/dsh-plugin-cmd/pipeline.mjs
// `dsh plugin add / remove / list` 的编排层。
//
// 设计要点：
//   * 只依赖 node: 内置模块 + 本目录的 core.mjs —— 因此可以在仓库里用真实临时
//     目录做端到端单测，不需要 dsh 运行时；
//   * pnpm 的实际执行通过 ctx 注入（真实实现复用 dsh 官方的 runPlugin，从而
//     完整保留「首次使用自动初始化 profile」与「bundle 层栈 reconcile」）；
//   * 所有写文件操作前先备份，写入后立即用 core 的扫描器复读校验；
//   * 失败模式一律「宁可少写、不许写坏」：profile 的 cordis.patch.yml 一旦写进
//     不合法的补丁，下一次 `dsh web` 就起不来。

import fs from 'node:fs'
import path from 'node:path'

import {
  PATCH_FILENAME,
  WORKSPACE_FILENAME,
  appendPatchItem,
  classifyDshPackage,
  declaredDefaultConfig,
  deriveEntryId,
  findMountedEntry,
  listBuildPlaceholders,
  listMountedEntries,
  parsePluginSubcommand,
  planAllowBuildsEdit,
  planPatchRemoval,
  pluginHelpText,
  renderInsertBlock,
  requiresNativeBuild,
} from './core.mjs'

/** 备份文件名前缀（与既有的 `cordis.patch.yml.bak-plugin-manager` 约定一致） */
const BACKUP_PREFIX = 'dsh-plugin'

/** 依赖树探测的上限，避免超大依赖图拖慢命令 */
const MAX_WALK_NODES = 400

/* ----------------------------------------------------------------- 文件 IO */

/** 读文本，不存在返回 '' */
export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 读 JSON，失败返回 undefined */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 写文本前先备份（返回备份路径；文件不存在时返回 undefined） */
export function backup(file, stamp) {
  if (!fs.existsSync(file)) return undefined
  const target = `${file}.bak-${BACKUP_PREFIX}-${stamp}`
  fs.copyFileSync(file, target)
  return target
}

/** 备份 + 写入 */
export function writeWithBackup(file, text, stamp) {
  const backupPath = backup(file, stamp)
  fs.writeFileSync(file, text, 'utf8')
  return backupPath
}

/* ---------------------------------------------------------- profile 读取 */

/** profile 的 cordis.patch.yml 路径 */
export function patchFile(profileDir) {
  return path.join(profileDir, PATCH_FILENAME)
}

/** profile 的 pnpm-workspace.yaml 路径 */
export function workspaceFile(profileDir) {
  return path.join(profileDir, WORKSPACE_FILENAME)
}

/** profile 的 package.json */
export function readProfileManifest(profileDir) {
  return readJson(path.join(profileDir, 'package.json')) ?? {}
}

/** 判断路径是否为目录 */
function isDir(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * 定位一个已安装包的目录，兼容 pnpm 的两种链接布局：
 *   1. `nodeLinker: hoisted`（本仓库用的 profile 形态）：`node_modules/<包名>` 平铺；
 *   2. 默认的 isolated：只有直接依赖在顶层，传递依赖落在
 *      `node_modules/.pnpm/<包名编码>@<版本>/node_modules/<包名>`。
 * 只按布局 1 找的话，**传递依赖（如 better-sqlite3）会找不到**，原生模块放行就会漏。
 * @param profileDir - profile 目录
 * @param packageName - 包名
 * @returns 包目录绝对路径；找不到返回 undefined
 */
export function resolveInstalledDir(profileDir, packageName) {
  const direct = path.join(profileDir, 'node_modules', packageName)
  if (isDir(direct)) return direct

  // @scope/name → @scope+name（pnpm 的 .pnpm 目录编码）
  const encoded = packageName.startsWith('@') ? packageName.replace('/', '+') : packageName
  const pnpmDir = path.join(profileDir, 'node_modules', '.pnpm')
  let entries = []
  try {
    entries = fs.readdirSync(pnpmDir)
  } catch {
    return undefined
  }
  const matches = entries.filter((entry) => entry === encoded || entry.startsWith(`${encoded}@`)).sort().reverse()
  for (const match of matches) {
    const candidate = path.join(pnpmDir, match, 'node_modules', packageName)
    if (isDir(candidate)) return candidate
  }
  return undefined
}

/** 兼容旧名（同一语义） */
export const installedDir = resolveInstalledDir

/** 已安装依赖的 package.json（兼容 hoisted 与 isolated 两种布局） */
export function installedManifest(profileDir, packageName) {
  const dir = resolveInstalledDir(profileDir, packageName)
  return dir === undefined ? undefined : readJson(path.join(dir, 'package.json'))
}

/**
 * 读 pnpm 的 node_modules/.modules.yaml（实测是合法 JSON）。
 * 里面的 `pendingBuilds` 是 pnpm 自己的「等待批准构建」名单 —— 比我们自己
 * 猜原生模块可靠得多。
 * @param profileDir - profile 目录
 */
export function readModules(profileDir) {
  const file = path.join(profileDir, 'node_modules', '.modules.yaml')
  const text = readText(file)
  if (text === '') return { pendingBuilds: [], allowBuilds: {} }
  try {
    const parsed = JSON.parse(text)
    const pending = Array.isArray(parsed.pendingBuilds) ? parsed.pendingBuilds.filter((x) => typeof x === 'string') : []
    const allow = parsed.allowBuilds !== null && typeof parsed.allowBuilds === 'object' ? parsed.allowBuilds : {}
    return { pendingBuilds: pending, allowBuilds: allow }
  } catch {
    // 兼容极老版本：只做保守的文本兜底，取不到就当作空
    const pending = /"pendingBuilds"\s*:\s*\[([^\]]*)\]/.exec(text)
    const names =
      pending === null
        ? []
        : pending[1]
            .split(',')
            .map((item) => item.trim().replace(/^"|"$/g, ''))
            .filter((item) => item !== '')
    return { pendingBuilds: names, allowBuilds: {} }
  }
}

/**
 * 走一遍依赖闭包（BFS + 节点上限）。
 *
 * nodeLinker: hoisted 下依赖是平铺在 node_modules 里的，按名字即可解析；
 * 返回两份结果：全部节点，以及其中需要执行构建脚本的节点。
 * @param profileDir - profile 目录
 * @param roots - 起点包名
 * @returns `{ nodes, natives }`
 */
export function walkDependencyClosure(profileDir, roots) {
  const nodes = new Set()
  const natives = new Set()
  const visited = new Set()
  const queue = [...roots]
  while (queue.length > 0 && visited.size < MAX_WALK_NODES) {
    const name = queue.shift()
    if (typeof name !== 'string' || name === '' || visited.has(name)) continue
    visited.add(name)
    nodes.add(name)
    const dir = installedDir(profileDir, name)
    const manifest = readJson(path.join(dir, 'package.json'))
    if (manifest === undefined) continue
    let files = []
    try {
      files = fs.readdirSync(dir)
    } catch {
      files = []
    }
    if (requiresNativeBuild(manifest, files)) natives.add(name)
    for (const field of ['dependencies', 'optionalDependencies']) {
      const deps = manifest[field]
      if (deps === null || typeof deps !== 'object') continue
      for (const child of Object.keys(deps)) if (!visited.has(child)) queue.push(child)
    }
  }
  return { nodes, natives }
}

/**
 * 在一个已安装包的依赖闭包内，找出需要执行构建脚本的包（复刻 pnpm 的判定）。
 * @param profileDir - profile 目录
 * @param roots - 起点包名
 * @returns 包名集合
 */
export function collectNativeDeps(profileDir, roots) {
  return walkDependencyClosure(profileDir, roots).natives
}

/* ---------------------------------------------------------------- 工具 */

/** 把 pnpm 的 spec 解析成包名（能解析就解析，解析不了返回 undefined，交给依赖 diff） */
export function resolveSpecPackageName(profileDir, spec, cwd) {
  const value = String(spec)
  if (value.startsWith('npm:')) return resolveSpecPackageName(profileDir, value.slice(4), cwd)
  const fileMatch = /^(?:file|link):(.+)$/.exec(value)
  const looksRelative = /^\.{1,2}([/\\]|$)/.test(value)
  if (fileMatch !== null || looksRelative) {
    const target = fileMatch !== null ? fileMatch[1] : value
    const dir = path.resolve(cwd, target)
    const manifest = readJson(path.join(dir, 'package.json'))
    return typeof manifest?.name === 'string' ? manifest.name : undefined
  }
  // 远端 / 归档 / git 形态：只有 pnpm 才知道最终包名，交给依赖 diff
  if (/^(?:https?:|git\+|github:|gitlab:|bitbucket:)/.test(value)) return undefined
  if (value.includes('#') || value.endsWith('.tgz') || value.endsWith('.tar.gz')) return undefined
  const bare = /^(@[^/\s]+\/[^@\s]+|[^@/\s]+)(?:@[^\s]*)?$/.exec(value)
  return bare === null ? undefined : bare[1]
}

/** 依赖名 diff */
export function diffDependencies(before, after) {
  const beforeDeps = before?.dependencies ?? {}
  const afterDeps = after?.dependencies ?? {}
  return Object.keys(afterDeps).filter((name) => !(name in beforeDeps))
}

/** 当前时间戳（用于备份文件名），形如 20260915-133600 */
export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/* ------------------------------------------------------------- add 管线 */

/**
 * 规划 add 的写入内容（纯计算，不落盘；`--dry-run` 与真实执行共用同一条路径）。
 * @param profileDir - profile 目录
 * @param names - 本次涉及（新增或已存在）的包名
 * @param flags - `{ id, config, mount }`
 */
export function planAddWrites(profileDir, names, flags) {
  const patchText = readText(patchFile(profileDir))
  const workspaceText = readText(workspaceFile(profileDir))
  const modules = readModules(profileDir)
  const closure = walkDependencyClosure(profileDir, names)

  // 原生构建放行 = 本次依赖闭包内「需要构建脚本」的包
  //   ∪ pnpm 记在 pendingBuilds 里、且落在本次闭包内的包（覆盖 git prepare 等
  //     我方判定看不到的情形）
  //   ∪ **本次安装新产生的 allowBuilds 占位项** ——
  //     pnpm 拦下构建时会把占位值 `set this to true or false` 写进
  //     pnpm-workspace.yaml，这是它最直接的「等你批准」记录；比对安装前后的占位
  //     集合即可精确挑出「因本次安装而出现」的项。
  // 刻意都不碰与本次无关的历史占位项：那是用户自己的待决事项，
  // 不该被 `dsh plugin add` 顺手批掉（可能是 sharp / tesseract.js 这类重编译包）。
  // `preInstallPlaceholders` 缺省时**完全不动占位项**（拿不到安装前快照就不猜），
  // 失败的默认方向必须是「少做」而不是「替用户批准一堆构建脚本」。
  const preInstall = flags.preInstallPlaceholders === undefined ? undefined : new Set(flags.preInstallPlaceholders)
  const approvals = new Set(closure.natives)
  const unrelatedPending = []
  for (const pending of modules.pendingBuilds) {
    if (closure.nodes.has(pending)) approvals.add(pending)
    else unrelatedPending.push(pending)
  }
  if (preInstall !== undefined) {
    for (const placeholder of listBuildPlaceholders(workspaceText)) {
      if (!preInstall.has(placeholder)) approvals.add(placeholder)
    }
  }
  const allowPlan = planAllowBuildsEdit(workspaceText, [...approvals].sort())

  const mounts = []
  for (const name of names) {
    const manifest = installedManifest(profileDir, name)
    const verdict = classifyDshPackage(manifest)
    const existing = findMountedEntry(patchText, name)
    if (verdict.kind === 'bundle') {
      mounts.push({ name, action: 'skip-bundle', detail: verdict.reason })
      continue
    }
    if (existing !== undefined) {
      mounts.push({ name, action: 'skip-mounted', detail: `已在第 ${existing.start + 1} 行挂载（id: ${existing.id || '未命名'}）` })
      continue
    }
    if (verdict.kind === 'library') {
      mounts.push({ name, action: 'skip-library', detail: verdict.reason })
      continue
    }
    if (flags.mount === false) {
      mounts.push({ name, action: 'skip-flag', detail: '--no-mount' })
      continue
    }
    const config = flags.config ?? declaredDefaultConfig(manifest)
    const id = flags.id ?? deriveEntryId(name)
    mounts.push({ name, action: 'insert', id, config, block: renderInsertBlock({ id, name, config }) })
  }
  return { allowPlan, mounts, patchText, unrelatedPending, closure }
}

/**
 * 执行 add 管线的写入部分。
 * @param ctx - `{ profileDir, cwd, log, warn, stamp }`
 * @param names - 本次涉及的包名
 * @param flags - `{ id, config, mount, dryRun }`
 * @returns 写入摘要
 */
export function applyAddWrites(ctx, names, flags) {
  const { profileDir } = ctx
  const plan = planAddWrites(profileDir, names, flags)
  const summary = { allow: { added: [], approved: [], backup: undefined }, mounts: plan.mounts, backups: [] }

  // 1) 原生模块放行
  if (plan.allowPlan.added.length > 0 || plan.allowPlan.approved.length > 0) {
    if (!flags.dryRun) {
      summary.allow.backup = writeWithBackup(workspaceFile(profileDir), plan.allowPlan.text, ctx.stamp)
      if (summary.allow.backup !== undefined) summary.backups.push(summary.allow.backup)
    }
    summary.allow.added = plan.allowPlan.added
    summary.allow.approved = plan.allowPlan.approved
  }
  if (plan.allowPlan.skipped.length > 0) {
    ctx.warn(`以下包在 allowBuilds 中被显式置 false，保持原样（不覆盖你的决定）：${plan.allowPlan.skipped.join(', ')}`)
  }
  if (plan.unrelatedPending.length > 0) {
    ctx.warn(
      `pnpm 还有与本次安装无关的待批构建：${plan.unrelatedPending.join(', ')}` +
        '（如需放行请执行 pnpm approve-builds，本命令不会替你决定）',
    )
  }

  // 2) 补丁挂载
  const inserts = plan.mounts.filter((mount) => mount.action === 'insert')
  if (inserts.length > 0) {
    let text = plan.patchText
    for (const mount of inserts) text = appendPatchItem(text, mount.block)
    if (!flags.dryRun) {
      const backupPath = writeWithBackup(patchFile(profileDir), text, ctx.stamp)
      if (backupPath !== undefined) summary.backups.push(backupPath)
      // 写完立即复读校验：缺一条就说明手术失败，必须立刻暴露而不是等下次启动炸
      const verify = readText(patchFile(profileDir))
      const missing = inserts.filter((mount) => findMountedEntry(verify, mount.name) === undefined).map((mount) => mount.name)
      if (missing.length > 0) throw new Error(`补丁写入后校验失败，未找到条目：${missing.join(', ')}（备份见 ${summary.backups.join(', ')}）`)
    }
  }
  return summary
}

/* ---------------------------------------------------------- remove 管线 */

/**
 * 执行 remove 管线：先摘补丁再卸依赖。
 *
 * 顺序是刻意的 —— 若先 `pnpm remove` 而补丁还留着，profile 会去加载一个已不存在的
 * 包，下一次启动直接失败；反过来（补丁先摘、依赖卸载失败）最坏也只是少装一个包。
 * @param ctx - `{ profileDir, runPnpmRemove, log, warn, stamp }`
 * @param names - 要移除的包名
 * @param flags - `{ dryRun }`
 */
export function applyRemoveWrites(ctx, names, flags) {
  const { profileDir } = ctx
  const file = patchFile(profileDir)
  let text = readText(file)
  const removed = []
  const backups = []

  for (const name of names) {
    const plan = planPatchRemoval(text, name)
    if (plan.removed === 0) {
      removed.push({ name, removed: 0, spans: [] })
      continue
    }
    text = plan.text
    removed.push({ name, removed: plan.removed, spans: plan.spans })
  }

  const touched = removed.filter((item) => item.removed > 0)
  if (touched.length > 0 && flags.dryRun !== true) {
    const backupPath = writeWithBackup(file, text, ctx.stamp)
    if (backupPath !== undefined) backups.push(backupPath)
    const verify = readText(file)
    for (const item of touched) {
      if (findMountedEntry(verify, item.name) !== undefined) {
        throw new Error(`补丁移除后校验失败，条目仍在：${item.name}（备份见 ${backups.join(', ')}）`)
      }
    }
  }

  let exitCode = 0
  if (flags.dryRun !== true) {
    exitCode = ctx.runPnpmRemove(names)
    if (exitCode !== 0) ctx.warn('pnpm remove 未成功；补丁已先行摘除，profile 不会残留悬空挂载')
  }
  return { removed, backups, exitCode }
}

/* ------------------------------------------------------------ list 视图 */

/**
 * 汇总 profile 的插件挂载状态。
 * @param profileDir - profile 目录
 * @returns `{ mounted, rows }`；rows 每项 `{ name, version, state, detail }`
 */
export function collectPluginStatus(profileDir) {
  const manifest = readProfileManifest(profileDir)
  const dependencies = manifest.dependencies ?? {}
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const mounted = listMountedEntries(readText(patchFile(profileDir)))
  const mountedNames = new Set(mounted.map((entry) => entry.name))
  const bundleSet = new Set(bundles)

  const rows = []
  for (const name of Object.keys(dependencies).sort()) {
    const installed = installedManifest(profileDir, name)
    const version = typeof installed?.version === 'string' ? installed.version : ''
    const verdict = classifyDshPackage(installed)
    let state
    let detail
    if (bundleSet.has(name)) {
      state = 'layers'
      detail = 'bundle 层栈（dsh.profile.bundles）'
    } else if (mountedNames.has(name)) {
      const entry = mounted.find((item) => item.name === name)
      state = 'patched'
      detail = `cordis.patch.yml 第 ${entry.line} 行（id: ${entry.id || '未命名'}）`
    } else if (verdict.kind === 'plugin') {
      state = 'unmounted'
      detail = `${verdict.reason} —— 尚未挂载，可执行 dsh plugin add ${name}`
    } else {
      state = 'dep-only'
      detail = verdict.reason
    }
    rows.push({ name, version, state, detail })
  }

  // 补丁里挂了但已不在依赖列表（悬空挂载）—— 这是启动失败的常见根因，必须报出来
  for (const entry of mounted) {
    if (Object.prototype.hasOwnProperty.call(dependencies, entry.name)) continue
    if (bundleSet.has(entry.name)) continue
    rows.push({
      name: entry.name,
      version: '',
      state: 'dangling',
      detail: `cordis.patch.yml 第 ${entry.line} 行挂了它，但 package.json 里没有该依赖`,
    })
  }

  return { mounted, rows }
}

/** 把状态行渲染成对齐的文本表 */
export function renderPluginTable(profileDir, rows) {
  const label = { layers: '层栈', patched: '补丁挂载', unmounted: '未挂载', 'dep-only': '仅依赖', dangling: '悬空挂载' }
  const width = Math.max(4, ...rows.map((row) => [...row.name].length))
  const lines = [`profile: ${profileDir}`, '']
  if (rows.length === 0) {
    lines.push('（该 profile 还没有任何插件依赖）')
    return lines.join('\n')
  }
  for (const row of rows) {
    const pad = ' '.repeat(Math.max(0, width - [...row.name].length))
    const flag = row.state === 'dangling' || row.state === 'unmounted' ? '!' : ' '
    lines.push(`${flag} ${row.name}${pad}  ${String(row.version).padEnd(12)} ${label[row.state] ?? row.state}  ${row.detail}`)
  }
  const dangling = rows.filter((row) => row.state === 'dangling').length
  const unmounted = rows.filter((row) => row.state === 'unmounted').length
  if (dangling > 0) lines.push('', `! ${dangling} 个悬空挂载会让 profile 启动失败，建议执行 dsh plugin remove <包名> 清理`)
  if (unmounted > 0) lines.push('', `! ${unmounted} 个已安装但未挂载的 dsh 插件，执行 dsh plugin add <包名> 即可挂载`)
  return lines.join('\n')
}

/* ------------------------------------------------------------ 命令分发 */

/** 解析 `--config` 的 JSON；非法则抛错（在任何写盘之前失败） */
function parseConfigFlag(raw) {
  if (raw === undefined) return undefined
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`--config 不是合法 JSON：${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--config 必须是 JSON 对象，例如 --config \'{"serverEnabled":true}\'')
  }
  return parsed
}

/**
 * 执行一条 `dsh plugin` 命令（除 pnpm 之外的全部逻辑都在这里，因而可被仓库单测覆盖）。
 *
 * `api` 需要提供：
 *   - `resolveProfileDir(profile)`：解析 profile 目录（官方实现会处理 $DSH_HOME 与合法名校验）
 *   - `forwardPnpm(profile, pnpmArgs)`：把参数转发给 pnpm（复用官方 runPlugin，
 *     从而保留首次初始化 profile 与 bundle 层栈 reconcile 这两项既有行为）
 *   - `cwd`、`stdout(line)`、`stderr(line)`、`now()`
 * @param options - `{ profile, args, api }`
 * @returns 进程退出码
 */
export function runPluginCommand({ profile, args, api }) {
  const parsed = parsePluginSubcommand(args)

  if (parsed.kind === 'help') {
    api.stdout(pluginHelpText(profile))
    return 0
  }

  if (parsed.kind === 'passthrough') {
    // 既有行为一字不改：why / update / outdated / install / add -D ... 全部原样转发
    return api.forwardPnpm(profile, parsed.args)
  }

  const profileDir = api.resolveProfileDir(profile)
  const stamp = timestamp(api.now?.() ?? new Date())
  const ctx = {
    profileDir,
    cwd: api.cwd,
    stamp,
    log: (line) => api.stdout(line),
    warn: (line) => api.stderr(`dsh: warning: ${line}`),
  }

  if (parsed.kind === 'list') {
    // 兼容既有用法：`dsh plugin list --depth 0` 以前是转发给 pnpm list 的
    if (parsed.extra.length > 0) api.forwardPnpm(profile, ['list', ...parsed.extra])
    const status = collectPluginStatus(profileDir)
    api.stdout(renderPluginTable(profileDir, status.rows))
    return 0
  }

  if (parsed.kind === 'add') {
    let config
    try {
      config = parseConfigFlag(parsed.own.configRaw)
    } catch (error) {
      api.stderr(`dsh: error: ${error.message}`)
      return 1
    }
    if (parsed.specs.length === 0) {
      api.stderr('dsh: error: add 需要至少一个包名或路径（dsh plugin --profile <名称> add <包名|路径>）')
      return 1
    }

    const before = readProfileManifest(profileDir)
    const collectTargets = (reference) => {
      const names = new Set(diffDependencies(reference, readProfileManifest(profileDir)))
      for (const spec of parsed.specs) {
        const name = resolveSpecPackageName(profileDir, spec, api.cwd)
        if (name !== undefined) names.add(name)
      }
      return [...names]
    }

    let targets = []
    let gatedBuilds = false
    // 安装前的 allowBuilds 占位快照：用于精确识别「因本次安装而新增」的待批项
    const preInstallPlaceholders = listBuildPlaceholders(readText(workspaceFile(profileDir)))
    if (parsed.own.dryRun !== true) {
      // 依赖安装（复用官方实现：首次使用会初始化 profile，装完会 reconcile bundle 层栈）
      const exitCode = api.forwardPnpm(profile, ['add', ...parsed.specs])
      targets = collectTargets(before)
      if (exitCode !== 0) {
        // 关键分支：pnpm 在「依赖已装好、但拦下了构建脚本」时**同样返回非 0**
        // （ERR_PNPM_IGNORED_BUILDS）。此时中止等于把任务丢回给用户手工做那两步，
        // 正是本命令要消灭的痛点。因此这里用**安装后的真实状态**而不是退出码来判定：
        // 目标依赖已写进 package.json 且已落到 node_modules → 视为可继续修复。
        const landed = targets.filter((name) => installedManifest(profileDir, name) !== undefined)
        if (landed.length === 0) {
          api.stderr(`dsh: error: pnpm add 失败（退出码 ${exitCode}），未改动 cordis.patch.yml`)
          return exitCode
        }
        gatedBuilds = true
        ctx.warn(
          `pnpm add 返回非 0，但 ${landed.join(', ')} 已安装到 profile —— ` +
            '判定为「构建脚本被 pnpm 拦下」，继续放行并重跑安装',
        )
      } else {
        ctx.log('✔ 依赖安装完成')
      }
    } else {
      targets = collectTargets(before)
      ctx.log('· --dry-run：跳过 pnpm，仅预览将要写入的内容')
    }

    if (targets.length === 0) {
      ctx.log('· 未识别到需要处理的插件（可能已在依赖列表中且无法从 spec 解析包名）')
      return 0
    }

    const flags = {
      id: parsed.own.id,
      config,
      mount: parsed.own.mount,
      dryRun: parsed.own.dryRun,
      preInstallPlaceholders,
    }
    let summary
    try {
      summary = applyAddWrites({ ...ctx, dryRun: parsed.own.dryRun }, targets, flags)
    } catch (error) {
      api.stderr(`dsh: error: ${error.message}`)
      return 1
    }

    const allowChanged = summary.allow.added.length > 0 || summary.allow.approved.length > 0
    if (allowChanged) {
      const parts = []
      if (summary.allow.approved.length > 0) parts.push(`填实占位 ${summary.allow.approved.join(', ')}`)
      if (summary.allow.added.length > 0) parts.push(`新增 ${summary.allow.added.join(', ')}`)
      ctx.log(`✔ 原生模块放行（pnpm-workspace.yaml › allowBuilds）：${parts.join('；')}`)
    } else {
      ctx.log('· 原生模块无需放行')
    }
    if (summary.backups.length > 0) ctx.log(`  备份：${summary.backups.join('、')}`)

    // 被拦下的构建必须真正跑一遍，否则原生模块只有目录没有二进制
    if (gatedBuilds && allowChanged && parsed.own.dryRun !== true) {
      ctx.log('· 放行后重跑 pnpm install，以真正编译原生模块…')
      const second = api.forwardPnpm(profile, ['install'])
      if (second !== 0) {
        ctx.warn('pnpm install 仍返回非 0，原生模块可能未编译成功（请检查上方 pnpm 输出）')
      } else {
        ctx.log('✔ 原生模块编译完成')
      }
    }

    for (const mount of summary.mounts) {
      if (mount.action === 'insert') {
        ctx.log(`✔ 补丁声明挂载：${mount.name} → cordis.patch.yml（id: ${mount.id}）`)
      } else if (mount.action === 'skip-mounted') {
        ctx.log(`· 已挂载，跳过：${mount.name}（${mount.detail}）`)
      } else if (mount.action === 'skip-bundle') {
        ctx.log(`· 跳过：${mount.name} —— ${mount.detail}`)
      } else if (mount.action === 'skip-library') {
        ctx.log(`· 不挂载：${mount.name} —— ${mount.detail}`)
      } else if (mount.action === 'skip-flag') {
        ctx.log(`· --no-mount：跳过挂载 ${mount.name}`)
      }
    }
    if (summary.mounts.some((mount) => mount.action === 'insert') && parsed.own.dryRun !== true) {
      ctx.log('→ 重启宿主（或 dsh web 会自动热重载 patch）后生效')
    }
    return 0
  }

  if (parsed.kind === 'remove') {
    if (parsed.specs.length === 0) {
      api.stderr('dsh: error: remove 需要至少一个包名（dsh plugin --profile <名称> remove <包名>）')
      return 1
    }
    // 只接受包名（不接受路径 / 版本区间），否则补丁里的 name 对不上
    const names = parsed.specs.map((spec) => resolveSpecPackageName(profileDir, spec, api.cwd) ?? spec)
    let result
    try {
      result = applyRemoveWrites(
        { ...ctx, runPnpmRemove: (targets) => api.forwardPnpm(profile, ['remove', ...targets]) },
        names,
        parsed.own,
      )
    } catch (error) {
      api.stderr(`dsh: error: ${error.message}`)
      return 1
    }
    for (const item of result.removed) {
      if (item.removed === 0) {
        ctx.log(`· ${item.name}：cordis.patch.yml 中没有挂载条目，无需摘除`)
        continue
      }
      const ranges = item.spans.map((span) => (span.from === span.to ? `第 ${span.from} 行` : `第 ${span.from}-${span.to} 行`)).join('、')
      ctx.log(`✔ 补丁摘除：${item.name}（已删除 ${ranges}）`)
    }
    if (result.backups.length > 0) ctx.log(`  备份：${result.backups.join('、')}`)
    if (parsed.own.dryRun === true) {
      ctx.log('· --dry-run：未落盘、未执行 pnpm remove')
      return 0
    }
    if (result.exitCode === 0) ctx.log('✔ 依赖卸载完成')
    return result.exitCode
  }

  // 理论上不可达：parsePluginSubcommand 的判别联合已穷尽
  throw new Error(`dsh: unhandled plugin subcommand ${JSON.stringify(parsed.kind)}`)
}
