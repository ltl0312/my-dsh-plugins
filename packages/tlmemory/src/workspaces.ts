// packages/tlmemory/src/workspaces.ts
// 宿主合法工作区白名单（DSH Workspaces）读取层。
//
// 为什么需要这一层：插件可以以任意工作目录被宿主拉起来（例如宿主直接在用户主目录
// `C:\Users\ZhuanZ` 下启动时），此时 `resolveProjectIdentity` 会算出 `repo:<hash>`
// 并把它登记成工程 —— 看板下拉框里于是冒出一个既不是仓库、也不属于任何已登记工作区
// 的幽灵工程；同理，宿主里早已被删除的历史工作区目录也会在登记表里长期残留。
//
// 判据只有一个：**DSH 宿主自己的工作区登记表**。宿主把已打开/已创建的工作区写在
// `$DSH_HOME/storages/workspace.json` 的 `tables.workspaces[].path` 里，本模块把它
// 投影成「合法 scope 集合 + scope → 工作区标题」两张表，供工程登记维护与看板展示使用。
//
// 失败降级是刚需：登记表缺失 / 损坏 / 空 ⇒ 返回 null（表示「无从判定」），调用方据此
// 关闭白名单过滤、退回旧行为 —— 绝不能在读不到宿主配置时把用户的记忆当孤儿清空。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 路径规范化（**scope 计算前必须跑的唯一前置步骤**）。
 *
 * 为什么必须收敛：同一个目录在 Windows 上至少有三种常见写法 ——
 * `D:\Code\x`（资源管理器 / `path.normalize`）、`D:/Code/x`（配置里手写的正斜杠）、
 * `d:\code\x`（大小写不敏感的盘符/目录名）。旧实现直接拿 `path.normalize(root)`
 * 参与 sha256，于是**同一个工作区算出多个不同 scope**，看板里凭空多出「同名但不同
 * scope」的孪生工程，白名单还会把只认其中一个 hash 的存量记忆判成非法孤儿。
 *
 * 统一规则：`path.normalize` → 反斜杠转正斜杠 → 去尾斜杠 → 全小写。
 * `projectScopeOf` 与本模块的别名集合都以此为准。
 */
export function normalizeRoot(root: string): string {
  const raw = String(root ?? '').trim()
  if (!raw) return ''
  return path
    .normalize(raw)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * 工程作用域（SQLite tree_type）的规范算法：`repo:` + 规范化路径 sha256 前 12 位。
 *
 * 收敛为单一实现是硬性要求 —— 历史记忆库的 tree_type 由它决定，任何一处算法漂移
 * 都会让既有记忆「找不到家」。`resolveProjectIdentity` 与工作区白名单必须逐字节一致。
 */
export function projectScopeOf(root: string): string {
  return `repo:${sha12(normalizeRoot(root))}`
}

/**
 * 同一根目录在**历史版本**下可能算出的全部 scope（权威值排第一）。
 *
 * 为什么需要别名：hash 输入一旦变过（旧版用 `path.normalize` 原文，含反斜杠与原
 * 大小写），存量记忆的 tree_type 就停留在旧值上。若白名单只认新 hash，这些**有真实
 * 记忆**的工程会被当成「不属于任何工作区」的孤儿 —— 这正是「有记忆的工程被误杀」
 * 的根因。这里把四种写法全部登记为合法别名，做到「同一目录的任何历史 hash 都认」。
 */
export function projectScopeVariants(root: string): string[] {
  const raw = String(root ?? '').trim()
  if (!raw) return []
  const normalized = path.normalize(raw)
  const canonical = normalizeRoot(raw)
  const inputs = [
    canonical, // 权威：小写 + 正斜杠
    normalized, // 旧版 v0.1–v0.6：path.normalize 原文（Windows 反斜杠 + 原大小写）
    normalized.replace(/\\/g, '/'), // 原大小写 + 正斜杠
    normalized.toLowerCase(), // 小写 + 反斜杠
  ]
  const out: string[] = []
  for (const input of inputs) {
    const scope = `repo:${sha12(input)}`
    if (!out.includes(scope)) out.push(scope)
  }
  return out
}

function sha12(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12)
}

/** 宿主合法工作区白名单（不可变视图） */
export interface WorkspaceRegistry {
  /** 合法工作区 scope → 工作区标题（DSH 里展示的名字；仅权威 hash，不含历史别名） */
  readonly scopes: ReadonlyMap<string, string>
  /** 合法工作区根目录（已规范化，小写用于跨平台比较） */
  readonly roots: ReadonlySet<string>
  /** 合法工作区标题集合（原样大小写，供「工程名与工作区同名」的存量数据对齐） */
  readonly titles: ReadonlySet<string>
  /**
   * 该 scope 是否属于宿主已登记工作区。
   * **包含历史 hash 别名** —— 老版本算出的 scope 同样算数，避免存量记忆被判孤儿。
   */
  has(scope: string): boolean
  /** 取所属工作区标题（含别名）；未登记返回 null */
  nameOf(scope: string): string | null
  /**
   * 「同名对齐」容错：工程名与某个合法工作区标题同名（忽略大小写与首尾空白）时，
   * 返回该工作区标题，否则 null。
   *
   * 解决的是存量数据的归属问题：宿主从别的目录启动时，插件可能把工程登记成
   * `名称=my-dsh-plugins、scope=别的 hash` 的形态；仅凭 scope 判断会把它当孤儿，
   * 而它其实明确指向某个已登记工作区。
   */
  alignTitleByName(projectName: string): string | null
}

/** 解析 DSH 家目录：优先环境变量（测试与多 profile 场景），否则 `~/.dsh` */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.normalize(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** 宿主工作区登记表的物理路径 */
export function workspaceRegistryPath(dshHome: string = resolveDshHome()): string {
  return path.join(dshHome, 'storages', 'workspace.json')
}

/** 从宿主登记表 JSON 构建白名单；结构不符或没有任何工作区时返回 null */
function buildRegistry(parsed: unknown): WorkspaceRegistry | null {
  if (!parsed || typeof parsed !== 'object') return null
  const tables = (parsed as { tables?: unknown }).tables
  if (!tables || typeof tables !== 'object') return null
  const workspaces = (tables as { workspaces?: unknown }).workspaces
  if (!workspaces || typeof workspaces !== 'object') return null

  const scopes = new Map<string, string>()
  const aliases = new Map<string, string>()
  const roots = new Set<string>()
  const titles = new Set<string>()
  const byTitle = new Map<string, string>()
  for (const entry of Object.values(workspaces as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const rawPath = record.path
    if (typeof rawPath !== 'string' || !rawPath.trim()) continue
    const root = path.normalize(rawPath.trim())
    const rawTitle = record.title
    const title =
      typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : path.basename(root) || 'workspace'
    const variants = projectScopeVariants(root)
    if (variants.length === 0) continue
    const [canonical, ...legacy] = variants
    if (!scopes.has(canonical)) scopes.set(canonical, title)
    // 历史 hash 变体同样算合法工作区作用域（存量记忆的 tree_type 可能是旧算法产出的）
    for (const alias of legacy) {
      if (!scopes.has(alias) && !aliases.has(alias)) aliases.set(alias, title)
    }
    roots.add(normalizeRoot(root))
    titles.add(title)
    const titleKey = title.toLowerCase()
    if (!byTitle.has(titleKey)) byTitle.set(titleKey, title)
  }
  if (scopes.size === 0) return null

  /** 权威 scope 与历史别名合并成一张查询表（权威优先） */
  const lookup = (scope: unknown): string | null => {
    const key = String(scope ?? '').trim()
    if (!key) return null
    return scopes.get(key) ?? aliases.get(key) ?? null
  }

  return {
    scopes,
    roots,
    titles,
    has(scope: string): boolean {
      return lookup(scope) !== null
    },
    nameOf(scope: string): string | null {
      return lookup(scope)
    },
    alignTitleByName(projectName: string): string | null {
      const key = String(projectName ?? '').trim().toLowerCase()
      if (!key) return null
      return byTitle.get(key) ?? null
    },
  }
}

/**
 * 读取宿主合法工作区白名单。
 *
 * 返回 null 表示**无从判定**（宿主登记表不存在、不可读、结构不符或为空），
 * 调用方此时必须关闭白名单过滤 —— 「读不到名单」不等于「名单为空」，
 * 把后者当默认会让插件在宿主配置异常时清空用户的工程登记。
 *
 * 按 `mtime + size` 缓存解析结果：宿主新增工作区后无需重启插件即可生效，
 * 同时避免看板每次轮询都重复解析 JSON。
 */
let cache: { file: string; mtimeMs: number; size: number; value: WorkspaceRegistry | null } | null = null

export function loadWorkspaceRegistry(dshHome: string = resolveDshHome()): WorkspaceRegistry | null {
  const file = workspaceRegistryPath(dshHome)
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    // 宿主目录/登记表不存在：无从判定
    cache = null
    return null
  }
  if (cache !== null && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.value
  }
  let value: WorkspaceRegistry | null = null
  try {
    value = buildRegistry(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    value = null
  }
  cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, value }
  return value
}

/** 仅供测试使用的缓存重置入口（保证用例之间互不串味） */
export function resetWorkspaceRegistryCache(): void {
  cache = null
}
