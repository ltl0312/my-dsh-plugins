// packages/tlmemory/tests/workspace-whitelist.spec.ts
// 「记忆看板按 DSH 工作区对齐」的契约固化：
// 1. 工作区白名单读取层只认宿主自己的登记表（$DSH_HOME/storages/workspace.json），
//    登记表缺失 / 损坏 / 为空一律返回 null（无从判定），调用方据此关闭过滤 —— 绝不误删；
// 2. 不属于宿主合法工作区的孤儿工程（以用户主目录启动产生的临时工程、宿主已删除的
//    历史目录）**连同其记忆与登记项**被彻底剔除，且**不因它是宿主当前工程而豁免**；
// 3. 方案 B 锚点约束：只有「宿主当前正在打开的**合法**工作区」在零记忆时才保留为
//    `工程名 [工作区名] (0)` 锚点；非合法工作区即使当前被传入也绝不呈现；
// 4. GET /api/projects 的每条清单项带 workspaceName（工程 ↔ 工作区归属一目了然）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryDB } from '../src/db.js'
import { MemoryServer } from '../src/server.js'
import {
  loadWorkspaceRegistry,
  projectScopeOf,
  resetWorkspaceRegistryCache,
  type WorkspaceRegistry,
} from '../src/workspaces.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询等待服务完成监听并返回实际端口（port=0 时为系统临时端口） */
async function waitForPort(server: MemoryServer, timeoutMs = 5000): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const port = server.actualPort
    if (port > 0) return port
    await delay(50)
  }
  throw new Error('server did not start listening in time')
}

// 三个作用域：两个合法工作区 + 一个「以用户主目录启动」产生的孤儿（对应真实的 ZhuanZ）
const PLUGINS_ROOT = path.normalize('D:/Code/my-dsh-plugins')
const PLUGINS_SCOPE = projectScopeOf(PLUGINS_ROOT)
const TOOLBOX_ROOT = path.normalize('D:/Code/Rust/TLToolBox')
const TOOLBOX_SCOPE = projectScopeOf(TOOLBOX_ROOT)
/** 孤儿工程：既不是仓库，也不在宿主工作区登记表里 */
const ORPHAN_ROOT = path.normalize('C:/Users/ZhuanZ')
const ORPHAN_SCOPE = projectScopeOf(ORPHAN_ROOT)

/** 在临时目录里写一份合成的工作区登记表，返回该 DSH 家目录 */
function writeFixtureDshHome(workspaces: Array<{ path: string; title: string }>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-dsh-home-'))
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
  const table: Record<string, unknown> = {}
  workspaces.forEach((item, index) => {
    table[`ws-${index + 1}`] = { path: item.path, title: item.title, sessionIds: [], createdAt: '', updatedAt: '' }
  })
  fs.writeFileSync(
    path.join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: Object.keys(table) },
      tables: { workspaces: table },
    }),
    'utf8',
  )
  return home
}

describe('dsh-plugin-tlmemory 按 DSH 工作区对齐工程', () => {
  const tempDirs: string[] = []
  const servers: Array<{ server: MemoryServer; db: MemoryDB }> = []

  let registry: WorkspaceRegistry | null = null

  beforeEach(() => {
    resetWorkspaceRegistryCache()
    registry = null
  })

  afterEach(() => {
    while (servers.length > 0) {
      const item = servers.pop()!
      item.server.stop()
      item.db.close()
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // 临时目录清理失败不影响断言
      }
    }
    resetWorkspaceRegistryCache()
  })

  /** 构造合成工作区登记表并读回白名单 */
  function buildRegistry(): WorkspaceRegistry {
    const home = writeFixtureDshHome([
      { path: 'D:\\Code\\my-dsh-plugins', title: 'my-dsh-plugins' },
      { path: 'D:\\Code\\Rust\\TLToolBox', title: 'TLToolBox' },
    ])
    tempDirs.push(home)
    const loaded = loadWorkspaceRegistry(home)
    expect(loaded).not.toBeNull()
    registry = loaded
    return loaded!
  }

  async function startServer(
    db: MemoryDB,
    current: { scope: string; name: string; root: string } | undefined,
    provider: (() => WorkspaceRegistry | null) | null,
  ): Promise<string> {
    const server = new MemoryServer(db, 0, undefined, current, provider)
    servers.push({ server, db })
    await server.start()
    const port = await waitForPort(server)
    return `http://127.0.0.1:${port}`
  }

  it('工作区白名单只认宿主登记表：合法 scope 命中，孤儿 scope 不在名单内', () => {
    const loaded = buildRegistry()

    expect(loaded.scopes.size).toBe(2)
    expect(loaded.has(PLUGINS_SCOPE)).toBe(true)
    expect(loaded.has(TOOLBOX_SCOPE)).toBe(true)
    expect(loaded.nameOf(PLUGINS_SCOPE)).toBe('my-dsh-plugins')
    expect(loaded.has(ORPHAN_SCOPE)).toBe(false)
    expect(loaded.nameOf(ORPHAN_SCOPE)).toBeNull()
    // 归属以**宿主登记表的标题**为准，与 basename 解耦
    expect(loaded.roots.has(PLUGINS_ROOT.toLowerCase())).toBe(true)
  })

  it('登记表缺失 / 结构不符 / 无任何工作区时返回 null（无从判定 ⇒ 调用方关闭过滤）', () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-dsh-empty-'))
    tempDirs.push(emptyHome)
    resetWorkspaceRegistryCache()
    expect(loadWorkspaceRegistry(emptyHome)).toBeNull()

    resetWorkspaceRegistryCache()
    expect(loadWorkspaceRegistry(path.join(emptyHome, 'not-exist'))).toBeNull()

    // 结构不符：tables 缺失
    const brokenHome = writeFixtureDshHome([])
    tempDirs.push(brokenHome)
    fs.writeFileSync(path.join(brokenHome, 'storages', 'workspace.json'), '{"tables":{}}', 'utf8')
    resetWorkspaceRegistryCache()
    expect(loadWorkspaceRegistry(brokenHome)).toBeNull()
  })

  it('pruneEmptyProjects：白名单外的孤儿工程连同记忆与登记项一并剔除', () => {
    const loaded = buildRegistry()
    const db = new MemoryDB(':memory:')

    // 孤儿工程：有真实记忆、也占着登记位，但不在宿主工作区名单里
    db.registerProject(ORPHAN_SCOPE, 'ZhuanZ', 'C:/Users/ZhuanZ')
    db.upsertLeaf(ORPHAN_SCOPE, ['临时'], '临时结论', '以用户主目录启动产生的临时工程记忆', ['tmp'])
    // 合法工作区：一个零记忆（当前工程锚点）、一个有记忆
    db.registerProject(PLUGINS_SCOPE, 'my-dsh-plugins', 'D:/Code/my-dsh-plugins')
    db.registerProject(TOOLBOX_SCOPE, 'TLToolBox', 'D:/Code/Rust/TLToolBox')
    db.upsertLeaf(TOOLBOX_SCOPE, ['架构'], 'P0修复', '审计路线图 P0 阶段集中修复阻断级问题', ['audit'])
    // 全局偏好树永远不属于任何工作区，必须毫发无伤
    db.upsertLeaf('global', ['通用偏好'], '中文回复', '跨工程通用的回复语言偏好断言', ['i18n'])

    const purged = db.pruneEmptyProjects({
      keepScope: ORPHAN_SCOPE,
      isScopeAllowed: (scope) => loaded.has(scope),
    })

    // 孤儿虽被指定为 keepScope（模拟「它正是宿主当前工程」），白名单也不放过它
    expect(purged).toContain(ORPHAN_SCOPE)
    expect(db.hasProject(ORPHAN_SCOPE)).toBe(false)
    expect(db.getNodesByScope(ORPHAN_SCOPE)).toHaveLength(0)
    // 合法工作区但零记忆、且不是当前工程：照旧按「零记忆」规则清理（豁免只发给当前工程）
    expect(purged).toContain(PLUGINS_SCOPE)
    expect(db.hasProject(PLUGINS_SCOPE)).toBe(false)
    // 合法且有记忆的工作区不受影响（记忆叶子仍在，目录骨架一并保留）
    expect(db.getNodesByScope(TOOLBOX_SCOPE).filter((n) => n.is_leaf === 1)).toHaveLength(1)
    // 全局偏好树不受任何影响
    expect(db.getNodesByScope('global').filter((n) => n.is_leaf === 1)).toHaveLength(1)

    // 第二轮：合法工作区成为「当前正在打开的工作区」时，零记忆也保留为 (0) 锚点
    db.registerProject(PLUGINS_SCOPE, 'my-dsh-plugins', 'D:/Code/my-dsh-plugins')
    const second = db.pruneEmptyProjects({
      keepScope: PLUGINS_SCOPE,
      isScopeAllowed: (scope) => loaded.has(scope),
    })
    expect(second).not.toContain(PLUGINS_SCOPE)
    expect(db.hasProject(PLUGINS_SCOPE)).toBe(true)
    // 锚点约束只对合法工作区生效：孤儿若再次出现仍被剔除
    db.registerProject(ORPHAN_SCOPE, 'ZhuanZ', 'C:/Users/ZhuanZ')
    db.pruneEmptyProjects({ keepScope: ORPHAN_SCOPE, isScopeAllowed: (scope) => loaded.has(scope) })
    expect(db.hasProject(ORPHAN_SCOPE)).toBe(false)
  })

  it('GET /api/projects：非白名单工作区即使作为当前工程传入也绝不呈现，且被静默清理', async () => {
    const loaded = buildRegistry()
    const db = new MemoryDB(':memory:')
    db.registerProject(ORPHAN_SCOPE, 'ZhuanZ', 'C:/Users/ZhuanZ')
    db.upsertLeaf(ORPHAN_SCOPE, ['临时'], '临时结论', '以用户主目录启动产生的临时工程记忆', ['tmp'])
    db.registerProject(TOOLBOX_SCOPE, 'TLToolBox', 'D:/Code/Rust/TLToolBox')
    db.upsertLeaf(TOOLBOX_SCOPE, ['架构'], 'P0修复', '审计路线图 P0 阶段集中修复阻断级问题', ['audit'])

    const base = await startServer(
      db,
      { scope: ORPHAN_SCOPE, name: 'ZhuanZ', root: 'C:/Users/ZhuanZ' },
      () => loaded,
    )

    const body = (await (await fetch(`${base}/api/projects`)).json()) as {
      data: Array<{ scope: string; name: string; workspaceName: string | null; leafCount: number }>
      current: string | null
      currentName: string | null
    }

    expect(body.data.map((item) => item.scope)).not.toContain(ORPHAN_SCOPE)
    expect(body.data.map((item) => item.name)).not.toContain('ZhuanZ')
    // 非合法工作区不能充当「当前工程」锚点
    expect(body.current).toBeNull()
    expect(body.currentName).toBeNull()
    // 干净落库：登记项与记忆都被清理，而不是只在响应里过滤
    expect(db.hasProject(ORPHAN_SCOPE)).toBe(false)
    expect(db.getNodesByScope(ORPHAN_SCOPE)).toHaveLength(0)
    // 合法工作区照常展示，并带上所属工作区名称
    const toolbox = body.data.find((item) => item.scope === TOOLBOX_SCOPE)
    expect(toolbox?.workspaceName).toBe('TLToolBox')
    expect(toolbox?.leafCount).toBe(1)
  })

  it('方案 B 锚点只发给合法工作区：零记忆的当前工作区保留 (0)，其余零记忆工作区被清理', async () => {
    const loaded = buildRegistry()
    const db = new MemoryDB(':memory:')
    db.registerProject(PLUGINS_SCOPE, 'my-dsh-plugins', 'D:/Code/my-dsh-plugins')
    db.registerProject(TOOLBOX_SCOPE, 'TLToolBox', 'D:/Code/Rust/TLToolBox')

    const base = await startServer(
      db,
      { scope: PLUGINS_SCOPE, name: 'my-dsh-plugins', root: 'D:/Code/my-dsh-plugins' },
      () => loaded,
    )

    const body = (await (await fetch(`${base}/api/projects`)).json()) as {
      data: Array<{ scope: string; name: string; workspaceName: string | null; leafCount: number }>
      current: string | null
      currentName: string | null
    }

    const anchor = body.data.find((item) => item.scope === PLUGINS_SCOPE)
    expect(anchor).toBeDefined()
    expect(anchor?.leafCount).toBe(0)
    expect(anchor?.workspaceName).toBe('my-dsh-plugins')
    expect(body.current).toBe(PLUGINS_SCOPE)
    expect(body.currentName).toBe('my-dsh-plugins')
    // 同在白名单内但非当前工程的零记忆工作区，照旧被清理
    expect(body.data.map((item) => item.scope)).not.toContain(TOOLBOX_SCOPE)
  })

  it('白名单读取器传 null（无从判定）时退回旧行为：只按零记忆清理，不做工作区过滤', async () => {
    const db = new MemoryDB(':memory:')
    db.registerProject(ORPHAN_SCOPE, 'ZhuanZ', 'C:/Users/ZhuanZ')
    db.upsertLeaf(ORPHAN_SCOPE, ['临时'], '临时结论', '以用户主目录启动产生的临时工程记忆', ['tmp'])

    const base = await startServer(
      db,
      { scope: ORPHAN_SCOPE, name: 'ZhuanZ', root: 'C:/Users/ZhuanZ' },
      null,
    )

    const body = (await (await fetch(`${base}/api/projects`)).json()) as {
      data: Array<{ scope: string; workspaceName: string | null }>
      current: string | null
    }

    // 有记忆 ⇒ 保留；归类字段无从判定 ⇒ null
    expect(body.data.map((item) => item.scope)).toContain(ORPHAN_SCOPE)
    expect(body.data.find((item) => item.scope === ORPHAN_SCOPE)?.workspaceName).toBeNull()
    expect(body.current).toBe(ORPHAN_SCOPE)
  })
})
