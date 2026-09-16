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
 * 工程作用域（SQLite tree_type）的规范算法：`repo:` + 仓库根目录绝对路径 sha256 前 12 位。
 *
 * 收敛为单一实现是硬性要求 —— 历史记忆库的 tree_type 由它决定，任何一处算法漂移
 * 都会让既有记忆「找不到家」。`resolveProjectIdentity` 与工作区白名单必须逐字节一致。
 */
export function projectScopeOf(root: string): string {
  const hash = crypto.createHash('sha256').update(path.normalize(root)).digest('hex')
  return `repo:${hash.slice(0, 12)}`
}

/** 宿主合法工作区白名单（不可变视图） */
export interface WorkspaceRegistry {
  /** 合法工作区 scope → 工作区标题（DSH 里展示的名字） */
  readonly scopes: ReadonlyMap<string, string>
  /** 合法工作区根目录（已规范化，小写用于跨平台比较） */
  readonly roots: ReadonlySet<string>
  /** 该 scope 是否属于宿主已登记工作区 */
  has(scope: string): boolean
  /** 取所属工作区标题；未登记返回 null */
  nameOf(scope: string): string | null
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
  const roots = new Set<string>()
  for (const entry of Object.values(workspaces as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const rawPath = record.path
    if (typeof rawPath !== 'string' || !rawPath.trim()) continue
    const root = path.normalize(rawPath.trim())
    const scope = projectScopeOf(root)
    const rawTitle = record.title
    const title =
      typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : path.basename(root) || scope
    if (!scopes.has(scope)) scopes.set(scope, title)
    roots.add(root.toLowerCase())
  }
  if (scopes.size === 0) return null

  return {
    scopes,
    roots,
    has(scope: string): boolean {
      return scopes.has(String(scope ?? '').trim())
    },
    nameOf(scope: string): string | null {
      return scopes.get(String(scope ?? '').trim()) ?? null
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
