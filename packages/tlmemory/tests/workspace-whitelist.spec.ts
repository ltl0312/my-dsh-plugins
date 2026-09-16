// packages/tlmemory/tests/workspace-whitelist.spec.ts
// 「记忆看板按 DSH 工作区对齐」的契约固化：
// 1. 工作区白名单读取层只认宿主自己的登记表（$DSH_HOME/storages/workspace.json），
//    登记表缺失 / 损坏 / 为空一律返回 null（无从判定），调用方据此关闭过滤 —— 绝不误删；
// 2. **第一铁律：有记忆的工程绝不剔除。** pruneEmptyProjects（落库侧）只清理「零节点的
//    空壳登记」；v0.6.3 曾按 scope 无条件剔除，配合 hash 规范化口径变更把存量工程连同
//    真实记忆整棵删掉，这是「看板下拉框空掉、记忆归零」的事故根因，本文件把修复后的
//    契约钉死；
// 3. **v0.6.6 归并优先（ZhuanZ 幽灵工程根治）**：名单外孤儿 scope 的记忆先被
//    mergeOrphanScopes 整体迁入合法工作区（同名对齐优先，否则落兜底工作区），随后展示
//    侧收紧 —— 名单外孤儿绝不单独出现在 GET /api/projects，孤儿 current 也不作锚点；
// 4. 方案 B 锚点约束：只有归属明确（scope 命中白名单或工程名对齐工作区）的当前工程
//    在零记忆时才保留为 `工程名 [工作区名] (0)` 锚点；
// 5. GET /api/projects 的每条清单项带 workspaceName，且**同一目录的历史 hash 变体**
//    与**与工作区同名的存量工程**都被认作该工作区的归属（hash 容错与同名对齐）；
// 6. GET /api/nodes 对失效作用域不再 404，回空树 + 可读提示。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryDB } from '../src/db.js'
import { MemoryServer } from '../src/server.js'
import {
  loadWorkspaceRegistry,
  normalizeRoot,
  projectScopeOf,
  projectScopeVariants,
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
    expect(loaded.roots.has(normalizeRoot(PLUGINS_ROOT))).toBe(true)
    expect(loaded.titles.has('my-dsh-plugins')).toBe(true)
    expect(loaded.titles.has('TLToolBox')).toBe(true)
  })

  it('hash 容错：同一目录的历史 hash 变体全部算合法工作区（存量记忆不再被判孤儿）', () => {
    const loaded = buildRegistry()
    const variants = projectScopeVariants(PLUGINS_ROOT)

    // 权威值排第一，且四种写法（小写正斜杠 / 原样 / 原大小写正斜杠 / 小写反斜杠）都覆盖
    expect(variants[0]).toBe(PLUGINS_SCOPE)
    expect(variants.length).toBeGreaterThan(1)
    expect(variants).toContain(projectScopeOf('D:\\Code\\my-dsh-plugins'))

    // 关键断言：白名单对**每一个历史变体**都认账，且都能取到工作区标题
    for (const variant of variants) {
      expect(loaded.has(variant)).toBe(true)
      expect(loaded.nameOf(variant)).toBe('my-dsh-plugins')
    }
    // 大小写/分隔符写法差异不再产生「同名不同 scope」的孪生判定
    expect(loaded.has(projectScopeOf('d:/code/my-dsh-plugins'))).toBe(true)
    // 别的工作区不会串味
    expect(loaded.nameOf(projectScopeOf('d:/code/rust/tltoolbox'))).toBe('TLToolBox')
    // scopes 只保留权威值（不含别名），避免清单里出现重复的同一工作区
    expect(loaded.scopes.size).toBe(2)
  })

  it('同名对齐：工程名与某个合法工作区同名时视同属于该工作区', () => {
    const loaded = buildRegistry()
    expect(loaded.alignTitleByName('my-dsh-plugins')).toBe('my-dsh-plugins')
    expect(loaded.alignTitleByName('  TLToolBox ')).toBe('TLToolBox')
    expect(loaded.alignTitleByName('不存在的名字')).toBeNull()
    expect(loaded.alignTitleByName('')).toBeNull()
  })

  it('pruneEmptyProjects：有记忆的工程绝不剔除，只有零节点空壳才被清理', () => {
    const loaded = buildRegistry()
    const db = new MemoryDB(':memory:')

    // ① 名单外、但**有真实记忆**的工程（对应真实的「主目录启动」工程 + 存量 hash 漂移工程）
    db.registerProject(ORPHAN_SCOPE, 'ZhuanZ', 'C:/Users/ZhuanZ')
    db.upsertLeaf(ORPHAN_SCOPE, ['规范'], 'API约定', '对外 HTTP 路由统一 kebab-case 命名', ['api'])
    // ② 名单外、零节点的空壳登记（宿主历史上以某个临时目录启动过一次）
    db.registerProject('repo:000000000001', '临时目录', 'D:/tmp/whatever')
    // ③ 合法工作区：一个零记忆（当前工程锚点）、一个有记忆
    db.registerProject(PLUGINS_SCOPE, 'my-dsh-plugins', 'D:/Code/my-dsh-plugins')
    db.registerProject(TOOLBOX_SCOPE, 'TLToolBox', 'D:/Code/Rust/TLToolBox')
    db.upsertLeaf(TOOLBOX_SCOPE, ['架构'], 'P0修复', '审计路线图 P0 阶段集中修复阻断级问题', ['audit'])
    // ④ 全局偏好树永远不属于任何工作区，必须毫发无伤
    db.upsertLeaf('global', ['通用偏好'], '中文回复', '跨工程通用的回复语言偏好断言', ['i18n'])

    const purged = db.pruneEmptyProjects({
      keepScope: ORPHAN_SCOPE,
      isScopeAllowed: (scope) => loaded.has(scope),
      workspaceTitles: loaded.titles,
    })

    // 第一铁律：名单外但有记忆的工程**必须原样保留**（登记项 + 记忆一条不少）
    expect(purged).not.toContain(ORPHAN_SCOPE)
    expect(db.hasProject(ORPHAN_SCOPE)).toBe(true)
    expect(db.getNodesByScope(ORPHAN_SCOPE).filter((n) => n.is_leaf === 1)).toHaveLength(1)
    // 名单外且零节点的空壳：照旧清理
    expect(purged).toContain('repo:000000000001')
    expect(db.hasProject('repo:000000000001')).toBe(false)
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
      workspaceTitles: loaded.titles,
    })
    expect(second).not.toContain(PLUGINS_SCOPE)
    expect(db.hasProject(PLUGINS_SCOPE)).toBe(true)
    // 名单外的空壳即使被指定为 keepScope 也留不下来（锚点豁免只发给合法工作区）
    db.registerProject('repo:000000000002', '另一个临时目录', 'D:/tmp/another')
    db.pruneEmptyProjects({
      keepScope: 'repo:000000000002',
      isScopeAllowed: (scope) => loaded.has(scope),
      workspaceTitles: loaded.titles,
    })
    expect(db.hasProject('repo:000000000002')).toBe(false)
  })

  it('pruneEmptyProjects：同名对齐的存量 scope 与其记忆一起保留', () => {
    const loaded = buildRegistry()
    const db = new MemoryDB(':memory:')
    // 存量形态：scope 是别的目录（如宿主 profile 目录），但工程名与合法工作区同名
    db.registerProject('repo:1c5b8d3f3502', 'my-dsh-plugins', 'C:/Users/ZhuanZ/.dsh/profiles/web')
    db.upsertLeaf('repo:1c5b8d3f3502', ['DSH客户端插件'], '视图切换', '由 conversationStore.view 驱动', ['dsh'])

    const purged = db.pruneEmptyProjects({
      isScopeAllowed: (scope) => loaded.has(scope),
      workspaceTitles: loaded.titles,
    })

    expect(purged).not.toContain('repo:1c5b8d3f3502')
    expect(db.hasProject('repo:1c5b8d3f3502')).toBe(true)
    expect(db.getNodesByScope('repo:1c5b8d3f3502').filter((n) => n.is_leaf === 1)).toHaveLength(1)
  })

  it('mergeOrphanScopes：同名对齐孤儿整树迁入权威 scope，骨架合并、冲突叶子取大收敛、登记项清理', () => {
    const loaded = buildRegistry()
    const db = new MemoryDB(':memory:')

    // 目标权威 scope 已有一棵树：一条与孤儿同位的叶子（名字相同、路径相同、内容更旧）
    db.registerProject(PLUGINS_SCOPE, 'my-dsh-plugins', 'D:/Code/my-dsh-plugins')
    const conflictBefore = db.upsertLeaf(PLUGINS_SCOPE, ['安全红线', '前端XSS'], '富文本禁v-html', '旧版本断言内容', ['xss'])
    // 目标树自有的一条无关叶子，迁移后必须毫发无伤
    db.upsertLeaf(PLUGINS_SCOPE, ['工程化'], 'pnpm放行', 'pnpm 11 原生构建放行键统一写 allowBuilds 映射', ['pnpm'])

    // 孤儿工程（ZhuanZ 场景）：带两层目录骨架 + 叶子，其中一条与目标树同位冲突
    // （后写入，updated_at 更新 ⇒ 「新者胜」语义下孤儿的断言内容应胜出）
    db.registerProject(ORPHAN_SCOPE, 'ZhuanZ', 'C:/Users/ZhuanZ')
    db.upsertLeaf(ORPHAN_SCOPE, ['安全红线', '前端XSS'], '富文本禁v-html', '前端渲染富文本严禁使用 v-html', ['xss'])
    db.upsertLeaf(ORPHAN_SCOPE, ['工程化', 'API规范'], 'kebab-case命名', '对外 HTTP API 路由统一 kebab-case', ['api'])

    const titleToScope = new Map<string, string>()
    for (const [scope, title] of loaded.scopes) titleToScope.set(title.toLowerCase(), scope)

    const merges = db.mergeOrphanScopes({
      isScopeAllowed: (scope) => loaded.has(scope),
      titleToScope,
      // 孤儿工程名 ZhuanZ 对齐不到任何工作区 → 落兜底目标
      fallbackScope: PLUGINS_SCOPE,
    })

    expect(merges).toEqual([{ from: ORPHAN_SCOPE, to: PLUGINS_SCOPE, movedNodes: 6, mergedLeaves: 1 }])

    // 源 scope 连根消失（节点 + 登记项）
    expect(db.countNodes(ORPHAN_SCOPE)).toBe(0)
    expect(db.hasProject(ORPHAN_SCOPE)).toBe(false)
    // 目录骨架完整迁入（两层目录 + 根下目录）
    const targetNodes = db.getNodesByScope(PLUGINS_SCOPE)
    expect(targetNodes.some((n) => n.is_leaf === 0 && n.path === '/安全红线/' && n.name === '安全红线')).toBe(true)
    expect(targetNodes.some((n) => n.is_leaf === 0 && n.path === '/安全红线/前端XSS/' && n.name === '前端XSS')).toBe(true)
    // 冲突叶子按取大合并：reinforce_count 取大（1+1 沉淀 → 2 vs 目标 1 → 2）、内容新者胜
    const merged = targetNodes.find((n) => n.is_leaf === 1 && n.name === '富文本禁v-html')
    expect(merged).toBeDefined()
    expect(merged!.content).toBe('前端渲染富文本严禁使用 v-html')
    expect(merged!.reinforce_count).toBeGreaterThanOrEqual(conflictBefore.reinforce_count)
    expect(targetNodes.filter((n) => n.is_leaf === 1 && n.name === '富文本禁v-html')).toHaveLength(1)
    // 无关叶子毫发无伤
    expect(targetNodes.some((n) => n.is_leaf === 1 && n.name === 'pnpm放行')).toBe(true)
    // 同位冲突目录（/工程化/）被复用而不是重建第二份
    expect(targetNodes.filter((n) => n.is_leaf === 0 && n.path === '/工程化/' && n.name === '工程化')).toHaveLength(1)
    // FTS 检索命中迁移后的记忆（触发器重索引正确）
    const hits = db.search('kebab-case', { treeType: PLUGINS_SCOPE })
    expect(hits.some((h) => h.name === 'kebab-case命名')).toBe(true)

    // 幂等：第二轮运行无孤儿可迁
    expect(
      db.mergeOrphanScopes({ isScopeAllowed: (scope) => loaded.has(scope), titleToScope, fallbackScope: PLUGINS_SCOPE }),
    ).toEqual([])
  })

  it('mergeOrphanScopes：白名单内 scope 原样保留，keepScope 豁免，无从判定时整体关闭', () => {
    const loaded = buildRegistry()
    const db = new MemoryDB(':memory:')

    db.registerProject(TOOLBOX_SCOPE, 'TLToolBox', 'D:/Code/Rust/TLToolBox')
    db.upsertLeaf(TOOLBOX_SCOPE, ['架构'], 'P0修复', '审计路线图 P0 阶段集中修复阻断级问题', ['audit'])
    db.registerProject(ORPHAN_SCOPE, 'ZhuanZ', 'C:/Users/ZhuanZ')
    db.upsertLeaf(ORPHAN_SCOPE, ['临时'], '临时结论', '以用户主目录启动产生的临时工程记忆', ['tmp'])

    const titleToScope = new Map<string, string>()
    for (const [scope, title] of loaded.scopes) titleToScope.set(title.toLowerCase(), scope)

    // keepScope 豁免：孤儿被指定为 keepScope 时不迁移（宿主明确豁免的场景）
    expect(
      db.mergeOrphanScopes({
        keepScope: ORPHAN_SCOPE,
        isScopeAllowed: (scope) => loaded.has(scope),
        titleToScope,
        fallbackScope: PLUGINS_SCOPE,
      }),
    ).toEqual([])
    expect(db.countNodes(ORPHAN_SCOPE)).toBeGreaterThan(0)

    // 无从判定（三个线索全 null）：整体关闭，绝不清空、绝不搬家
    expect(db.mergeOrphanScopes({})).toEqual([])
    expect(db.countNodes(ORPHAN_SCOPE)).toBeGreaterThan(0)
    expect(db.hasProject(ORPHAN_SCOPE)).toBe(true)

    // 正常判定：合法 scope 原样保留，孤儿迁入兜底目标
    const merges = db.mergeOrphanScopes({
      isScopeAllowed: (scope) => loaded.has(scope),
      titleToScope,
      fallbackScope: PLUGINS_SCOPE,
    })
    expect(merges).toEqual([{ from: ORPHAN_SCOPE, to: PLUGINS_SCOPE, movedNodes: 2, mergedLeaves: 0 }])
    expect(db.countNodes(TOOLBOX_SCOPE)).toBe(2)
    expect(
      db.getNodesByScope(TOOLBOX_SCOPE).some((n) => n.is_leaf === 1 && n.name === 'P0修复'),
    ).toBe(true)
    expect(db.getNodesByScope(PLUGINS_SCOPE).some((n) => n.is_leaf === 1 && n.name === '临时结论')).toBe(true)
  })

  it('GET /api/projects：名单外有记忆的孤儿被归并进同名工作区后原 scope 消失，零节点空壳被静默清理', async () => {
    const loaded = buildRegistry()
    const db = new MemoryDB(':memory:')
    // 名单外 + 有记忆（存量 hash 漂移工程，名字与工作区同名 ⇒ 同名对齐 → 归并目标）
    db.registerProject('repo:1c5b8d3f3502', 'my-dsh-plugins', 'C:/Users/ZhuanZ/.dsh/profiles/web')
    db.upsertLeaf('repo:1c5b8d3f3502', ['DSH客户端插件'], '视图切换', '由 conversationStore.view 驱动', ['dsh'])
    // 名单外 + 零节点（纯空壳登记）
    db.registerProject(ORPHAN_SCOPE, 'ZhuanZ', 'C:/Users/ZhuanZ')
    // 名单内 + 有记忆
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

    const scopes = body.data.map((item) => item.scope)
    // v0.6.6 归并优先：孤儿 scope 的记忆先迁入合法工作区，原 scope 不再单独展示
    expect(scopes).not.toContain('repo:1c5b8d3f3502')
    expect(db.hasProject('repo:1c5b8d3f3502')).toBe(false)
    expect(db.countNodes('repo:1c5b8d3f3502')).toBe(0)
    // 记忆一条不少：迁入 my-dsh-plugins 权威 scope，归属字段正确
    expect(scopes).toContain(PLUGINS_SCOPE)
    const plugins = body.data.find((item) => item.scope === PLUGINS_SCOPE)
    expect(plugins?.leafCount).toBe(1)
    expect(plugins?.workspaceName).toBe('my-dsh-plugins')
    expect(
      db.getNodesByScope(PLUGINS_SCOPE).some((n) => n.is_leaf === 1 && n.name === '视图切换'),
    ).toBe(true)
    // 零节点空壳：既不出现在响应里，也被真正落库清理
    expect(scopes).not.toContain(ORPHAN_SCOPE)
    expect(body.data.map((item) => item.name)).not.toContain('ZhuanZ')
    expect(db.hasProject(ORPHAN_SCOPE)).toBe(false)
    // 合法工作区照常展示，并带上所属工作区名称
    const toolbox = body.data.find((item) => item.scope === TOOLBOX_SCOPE)
    expect(toolbox?.workspaceName).toBe('TLToolBox')
    expect(toolbox?.leafCount).toBe(1)
  })

  it('名单外有记忆的孤儿 current 不作锚点：记忆归并进合法工作区，current 回 null 由前端自愈', async () => {
    const loaded = buildRegistry()
    const db = new MemoryDB(':memory:')
    db.registerProject(ORPHAN_SCOPE, 'ZhuanZ', 'C:/Users/ZhuanZ')
    db.upsertLeaf(ORPHAN_SCOPE, ['规范'], 'JWT约定', 'access token 2 小时、refresh token 7 天', ['jwt'])

    const base = await startServer(
      db,
      { scope: ORPHAN_SCOPE, name: 'ZhuanZ', root: 'C:/Users/ZhuanZ' },
      () => loaded,
    )
    const body = (await (await fetch(`${base}/api/projects`)).json()) as {
      data: Array<{ scope: string; leafCount: number }>
      current: string | null
    }

    // v0.6.6：孤儿 current 的记忆已迁入白名单首位合法工作区（buildRegistry 中 my-dsh-plugins 居首）
    expect(db.countNodes(ORPHAN_SCOPE)).toBe(0)
    expect(db.hasProject(ORPHAN_SCOPE)).toBe(false)
    expect(body.data.map((item) => item.scope)).not.toContain(ORPHAN_SCOPE)
    const plugins = body.data.find((item) => item.scope === PLUGINS_SCOPE)
    expect(plugins?.leafCount).toBe(1)
    expect(
      db.getNodesByScope(PLUGINS_SCOPE).some((n) => n.is_leaf === 1 && n.name === 'JWT约定'),
    ).toBe(true)
    // 孤儿绝不作为当前工程上报（前端据 null 自愈回退到第一个有记忆的工程）
    expect(body.current).toBeNull()
  })

  it('GET /api/nodes 对失效作用域回空树而不是 404（看板不再记忆归零）', async () => {
    const loaded = buildRegistry()
    const db = new MemoryDB(':memory:')
    const base = await startServer(db, undefined, () => loaded)

    const res = await fetch(`${base}/api/nodes?scope=project&project=repo:deadbeefcafe`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
    expect(body.nodes).toEqual([])
    expect(body.message).toContain('repo:deadbeefcafe')
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
