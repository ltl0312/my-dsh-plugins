// packages/tlmemory/tests/projects.spec.ts
// 多项目记忆选择的契约固化：
// 1. projects 登记表把不可读的 repo:<hash> 反解为可读工程名，且用户手工命名不被自动登记覆盖；
// 2. GET /api/projects 覆盖「所有存在记忆记录的工程」，并在读取前**自动清理零记忆工程**
//    （保留宿主当前工程）—— 看板不再堆积空工程；
// 3. 工程名全局唯一：自动登记遇同名自动加 scope 短标识，重命名撞名回 409，历史脏数据自愈；
// 4. GET /api/nodes 的 scope/project 组合能精确收敛到单棵工程树，全局偏好树与工程树互不串味；
// 5. /api/search 与 /api/nodes 共用同一套作用域语义（图谱高亮与列表命中必须来自同一棵树）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryDB } from '../src/db.js'
import { MemoryServer } from '../src/server.js'

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

/** 直连底层 SQLite 的测试通道：仅用于制造「历史脏数据」（重名工程）以验证自愈逻辑 */
function rawSql(db: MemoryDB, sql: string): void {
  ;(db as unknown as { db: { exec: (statement: string) => void } }).db.exec(sql)
}

describe('dsh-plugin-tlmemory 多项目记忆选择', () => {
  let db: MemoryDB
  let server: MemoryServer
  let port: number
  let base: string
  const extras: Array<{ server: MemoryServer; db: MemoryDB }> = []

  const CURRENT = { scope: 'repo:aaaaaaaaaaaa', name: 'my-dsh-plugins', root: 'D:/Code/my-dsh-plugins' }

  beforeEach(async () => {
    db = new MemoryDB(':memory:')

    // 三个工程 + 一棵全局树；其中 deskcraft 尚无记忆记录，仅存在于登记表
    db.registerProject('repo:aaaaaaaaaaaa', 'my-dsh-plugins', 'D:/Code/my-dsh-plugins')
    db.registerProject('repo:bbbbbbbbbbbb', 'TLToolBox', 'D:/Code/TLToolBox')
    db.registerProject('repo:cccccccccccc', 'deskcraft', 'D:/Code/deskcraft')

    db.upsertLeaf('global', ['通用偏好'], '中文回复', '跨工程通用的回复语言偏好断言', ['i18n'])
    db.upsertLeaf(
      'repo:aaaaaaaaaaaa',
      ['工程化', '包管理'],
      'pnpm放行',
      'pnpm 11 需要配置原生依赖构建放行键',
      ['pnpm', 'allowBuilds'],
    )
    db.upsertLeaf('repo:bbbbbbbbbbbb', ['架构', '审计'], 'P0修复', '审计路线图 P0 阶段集中修复阻断级问题', ['audit'])

    // 第 5 参传 null：关闭宿主工作区白名单过滤 —— 本用例的 scope 是合成种子数据，
    // 不该受开发机上真实 DSH 工作区登记表影响（白名单专项断言见 workspace-whitelist.spec.ts）
    server = new MemoryServer(db, 0, undefined, CURRENT, null)
    server.start()
    port = await waitForPort(server)
    base = `http://127.0.0.1:${port}`
  })

  afterEach(() => {
    server.stop()
    db.close()
    while (extras.length > 0) {
      const extra = extras.pop()!
      extra.server.stop()
      extra.db.close()
    }
  })

  it('listProjects 聚合出所有存在记忆记录的工程，且登记名优先于不可读 scope', () => {
    const projects = db.listProjects()
    const byScope = new Map(projects.map((project) => [project.scope, project]))

    expect(byScope.get('repo:aaaaaaaaaaaa')?.name).toBe('my-dsh-plugins')
    expect(byScope.get('repo:aaaaaaaaaaaa')?.leafCount).toBe(1)
    expect(byScope.get('repo:bbbbbbbbbbbb')?.name).toBe('TLToolBox')
    // 全局树不属于工程清单
    expect(projects.some((project) => project.scope === 'global')).toBe(false)
  })

  it('未登记过的历史作用域回退为 scope 原文，不伪造工程名', () => {
    db.upsertLeaf('repo:deadbeefcafe', ['遗留'], '历史记忆', '改造前入库的历史记忆断言内容', ['legacy'])
    const found = db.listProjects().find((project) => project.scope === 'repo:deadbeefcafe')
    expect(found).toBeDefined()
    expect(found?.name).toBe('repo:deadbeefcafe')
    expect(found?.root).toBeNull()
  })

  it('registerProject 不得覆盖用户的手工命名', () => {
    db.renameProject('repo:deadbeefcafe', '旧工程')
    db.registerProject('repo:deadbeefcafe', '不应该生效', 'D:/Code/whatever')

    const found = db.listProjects().find((project) => project.scope === 'repo:deadbeefcafe')
    expect(found?.name).toBe('旧工程')
  })

  it('findProjectScope 同时接受 scope 原文与可读工程名（忽略大小写）', () => {
    expect(db.findProjectScope('repo:bbbbbbbbbbbb')).toBe('repo:bbbbbbbbbbbb')
    expect(db.findProjectScope('TLToolBox')).toBe('repo:bbbbbbbbbbbb')
    expect(db.findProjectScope('tltoolbox')).toBe('repo:bbbbbbbbbbbb')
    expect(db.findProjectScope('不存在的工程')).toBeNull()
  })

  it('GET /api/projects 返回工程清单并标记宿主当前所在工程', async () => {
    const res = await fetch(`${base}/api/projects`)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.current).toBe('repo:aaaaaaaaaaaa')
    expect(body.currentName).toBe('my-dsh-plugins')

    const names = body.data.map((project: { name: string }) => project.name)
    expect(names).toContain('my-dsh-plugins')
    expect(names).toContain('TLToolBox')
  })

  it('GET /api/projects 自动清理零记忆工程：登记表与清单同步移除', async () => {
    // 夹具里的 deskcraft 只有登记、从未写过任何记忆
    expect(db.findProjectScope('deskcraft')).toBe('repo:cccccccccccc')

    const res = await fetch(`${base}/api/projects`)
    const body = await res.json()
    const names = body.data.map((project: { name: string }) => project.name)
    expect(names).not.toContain('deskcraft')
    // 不只是「过滤显示」：登记表里已经物理删除，按名解析也不再到得到
    expect(db.findProjectScope('deskcraft')).toBeNull()
  })

  it('删除最后一条记忆后，该工程连同空目录骨架一起自动消失', async () => {
    const scope = 'repo:bbbbbbbbbbbb'
    const listed = await (await fetch(`${base}/api/projects`)).json()
    expect(listed.data.map((project: { name: string }) => project.name)).toContain('TLToolBox')

    const leaf = db.getNodesByScope(scope).find((node) => node.is_leaf === 1)
    expect(leaf).toBeDefined()
    db.deleteNode(leaf!.id)

    // deleteNode 只删子树、不剪父目录：目录骨架仍在 nodes 里，这正是必须连带清理的原因
    expect(db.getNodesByScope(scope).length).toBeGreaterThan(0)

    const after = await (await fetch(`${base}/api/projects`)).json()
    expect(after.data.map((project: { name: string }) => project.name)).not.toContain('TLToolBox')
    expect(db.getNodesByScope(scope)).toHaveLength(0)
    expect(db.findProjectScope('TLToolBox')).toBeNull()
  })

  it('方案 B：零记忆的宿主当前工程被保留展示（标记 0 条，可切入空树并新建）', async () => {
    const db2 = new MemoryDB(':memory:')
    const current2 = { scope: 'repo:cccccccccccc', name: 'deskcraft', root: 'D:/Code/deskcraft' }
    db2.registerProject(current2.scope, current2.name, current2.root)
    const extra = new MemoryServer(db2, 0, undefined, current2, null)
    extras.push({ server: extra, db: db2 })
    await extra.start()
    const extraBase = `http://127.0.0.1:${await waitForPort(extra)}`

    const body = await (await fetch(`${extraBase}/api/projects`)).json()
    expect(body.current).toBe('repo:cccccccccccc')
    expect(body.currentName).toBe('deskcraft')
    // 当前活跃工程零记忆也保留展示，并明确标记为 0 条（看板据此显示 deskcraft (0)）
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      scope: 'repo:cccccccccccc',
      name: 'deskcraft',
      leafCount: 0,
      nodeCount: 0,
    })
    // 登记项是被 keepScope 豁免保留的，而不是只在响应里临时兜底
    expect(db2.findProjectScope('deskcraft')).toBe('repo:cccccccccccc')

    // 可切入空树（200 + 空数组），而不是 404
    const tree = await fetch(`${extraBase}/api/nodes?scope=project&project=deskcraft`)
    expect(tree.status).toBe(200)
    expect((await tree.json()).data).toHaveLength(0)

    // 新建第一条记忆后计数 0 → 1，工程名保持人类可读
    const created = await fetch(`${extraBase}/api/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        project: 'repo:cccccccccccc',
        title: '首条记忆',
        content: '当前工程作为新建记忆默认落点的验证内容',
      }),
    })
    expect(created.status).toBe(201)

    const after = await (await fetch(`${extraBase}/api/projects`)).json()
    expect(after.data).toHaveLength(1)
    expect(after.data[0]).toMatchObject({ name: 'deskcraft', leafCount: 1 })
  })

  it('删掉当前工程最后一条记忆后，该工程作为 0 计数锚点继续保留', async () => {
    const scope = 'repo:aaaaaaaaaaaa'
    const leaf = db.getNodesByScope(scope).find((node) => node.is_leaf === 1)
    expect(leaf).toBeDefined()
    db.deleteNode(leaf!.id)

    const body = await (await fetch(`${base}/api/projects`)).json()
    expect(body.current).toBe(scope)
    const entry = body.data.find((project: { scope: string }) => project.scope === scope)
    expect(entry).toMatchObject({ name: 'my-dsh-plugins', leafCount: 0 })
  })

  it('pruneEmptyProjects 豁免 keepScope：当前工程保留，其余零记忆工程彻底清理', () => {
    const db2 = new MemoryDB(':memory:')
    db2.registerProject('repo:aaaaaaaaaaaa', '当前工程', null)
    db2.registerProject('repo:bbbbbbbbbbbb', '历史遗留', null)
    db2.registerProject('repo:cccccccccccc', '路径漂移', null)

    const purged = db2.pruneEmptyProjects({ keepScope: 'repo:aaaaaaaaaaaa' })
    expect(purged.sort()).toEqual(['repo:bbbbbbbbbbbb', 'repo:cccccccccccc'])
    expect(db2.findProjectScope('当前工程')).toBe('repo:aaaaaaaaaaaa')
    expect(db2.findProjectScope('历史遗留')).toBeNull()
    expect(db2.findProjectScope('路径漂移')).toBeNull()

    // 严格模式（不传 keepScope）：连当前工程一起清理
    expect(db2.pruneEmptyProjects()).toEqual(['repo:aaaaaaaaaaaa'])
    expect(db2.findProjectScope('当前工程')).toBeNull()
    db2.close()
  })

  it('自动登记遇同名工程时追加 scope 短标识，清单内绝不出现重名', async () => {
    // 两个不同路径下的同名仓库（basename 相撞是真实场景）
    db.registerProject('repo:dddddddddddd', 'TLToolBox', 'E:/Work/TLToolBox')

    const names = db.listProjects().map((project) => project.name)
    expect(names).toContain('TLToolBox')
    expect(names).toContain('TLToolBox (dddddd)')
    expect(new Set(names).size).toBe(names.length)
    // 按名解析不再有歧义
    expect(db.findProjectScope('TLToolBox')).toBe('repo:bbbbbbbbbbbb')
    expect(db.findProjectScope('TLToolBox (dddddd)')).toBe('repo:dddddddddddd')
  })

  it('冲突方被清理后，自动登记会摘掉重名后缀（自愈且幂等）', async () => {
    db.registerProject('repo:dddddddddddd', 'TLToolBox', 'E:/Work/TLToolBox')
    expect(db.listProjects().map((project) => project.name)).toContain('TLToolBox (dddddd)')

    // 让原主彻底消失（删掉它唯一的记忆 → 清单读取时连带清理登记项）
    const owner = db.getNodesByScope('repo:bbbbbbbbbbbb').find((node) => node.is_leaf === 1)
    db.deleteNode(owner!.id)
    await fetch(`${base}/api/projects`)
    expect(db.findProjectScope('TLToolBox')).toBeNull()

    // 再次自动登记即拿回干净的原名
    db.registerProject('repo:dddddddddddd', 'TLToolBox', 'E:/Work/TLToolBox')
    expect(db.findProjectScope('TLToolBox')).toBe('repo:dddddddddddd')
  })

  it('重命名撞名被拒（409 + 可读理由）且原数据零改动', async () => {
    const before = db.listProjects()

    const res = await fetch(`${base}/api/projects`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'repo:aaaaaaaaaaaa', name: 'TLToolBox' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('TLToolBox')
    expect(body.error).toContain('另一个工程占用')
    expect(db.listProjects()).toEqual(before)
  })

  it('POST /api/projects/rename 与 PATCH 共用同一道重名闸门（忽略大小写）', async () => {
    const res = await fetch(`${base}/api/projects/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectKey: 'repo:aaaaaaaaaaaa', newName: 'tltoolbox' }),
    })
    expect(res.status).toBe(409)
    // 冲突对方名字必与所求名字相同，提示不重复念同一个名字，改为点明冲突性质
    const error = (await res.json()).error as string
    expect(error).toContain('tltoolbox')
    expect(error).toContain('另一个工程占用')
  })

  it('方案 B：0 记忆的当前活跃工程可正常重命名，且重命名后仍保留展示', async () => {
    const db2 = new MemoryDB(':memory:')
    const current2 = { scope: 'repo:cccccccccccc', name: 'deskcraft', root: 'D:/Code/deskcraft' }
    db2.registerProject(current2.scope, current2.name, current2.root)
    const extra = new MemoryServer(db2, 0, undefined, current2, null)
    extras.push({ server: extra, db: db2 })
    await extra.start()
    const extraBase = `http://127.0.0.1:${await waitForPort(extra)}`

    // 顶栏重命名入口对 0 记忆的锚点必须可用
    const res = await fetch(`${extraBase}/api/projects`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'repo:cccccccccccc', name: '写字台' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)

    // 重命名后仍是零记忆锚点（手工命名不会被「零记忆清理」带走）
    const after = await (await fetch(`${extraBase}/api/projects`)).json()
    expect(after.data).toHaveLength(1)
    expect(after.data[0]).toMatchObject({ name: '写字台', leafCount: 0 })
    expect(db2.findProjectScope('写字台')).toBe('repo:cccccccccccc')
  })

  it('历史库遗留的同名工程：零记忆者先被清理，有记忆者保留原名', async () => {
    // 直接写底层表制造历史脏数据：registerProject/renameProject 已有唯一性闸门，无法再造重名
    rawSql(
      db,
      `INSERT INTO projects (scope, name, root, is_manual, created_at, updated_at)
       VALUES ('repo:eeeeeeeeeeee', 'LegacyApp', 'E:/legacy-a', 0, 1, 1),
              ('repo:ffffffffffff', 'LegacyApp', 'E:/legacy-b', 0, 1, 2);`,
    )
    // 其中 eeee 有 1 条记忆，ffff 只有登记（零记忆）→ 后者应被清理而非改名
    db.upsertLeaf('repo:eeeeeeeeeeee', ['遗留'], '老记忆', '历史库中的既有记忆内容断言', ['legacy'])

    const res = await fetch(`${base}/api/projects`)
    const body = await res.json()
    const names = body.data.map((project: { name: string }) => project.name)

    expect(new Set(names).size).toBe(names.length) // 清单内无重名
    expect(names).toContain('LegacyApp')
    expect(db.findProjectScope('LegacyApp')).toBe('repo:eeeeeeeeeeee')
    // 零记忆的 ffff 被整体清理（登记项与节点）
    expect(db.findProjectScope('repo:ffffffffffff')).toBeNull()
  })

  it('两个同名工程都有记忆时，保留手工命名者、另一者追加短标识', async () => {
    rawSql(
      db,
      `INSERT INTO projects (scope, name, root, is_manual, created_at, updated_at)
       VALUES ('repo:eeeeeeeeeeee', 'LegacyApp', 'E:/legacy-a', 1, 1, 1),
              ('repo:ffffffffffff', 'LegacyApp', 'E:/legacy-b', 0, 1, 2);`,
    )
    db.upsertLeaf('repo:eeeeeeeeeeee', ['遗留'], '老记忆', '历史库中的既有记忆内容断言', ['legacy'])
    db.upsertLeaf('repo:ffffffffffff', ['遗留'], '另一份记忆', '同名工程的另一份记忆内容断言', ['legacy'])

    const res = await fetch(`${base}/api/projects`)
    const body = await res.json()
    const names = body.data.map((project: { name: string }) => project.name)

    expect(new Set(names).size).toBe(names.length)
    expect(db.findProjectScope('LegacyApp')).toBe('repo:eeeeeeeeeeee')
    expect(db.findProjectScope('LegacyApp (ffffff)')).toBe('repo:ffffffffffff')
  })

  it('当前活跃工程与既有工程同名时，重名自愈同样覆盖它（有记忆者保留原名）', async () => {
    const db2 = new MemoryDB(':memory:')
    db2.registerProject('repo:bbbbbbbbbbbb', 'TLToolBox', null)
    db2.upsertLeaf('repo:bbbbbbbbbbbb', ['架构'], '既有记忆', '占用该工程名的既有记忆内容断言', ['audit'])

    // 当前工程零记忆但被豁免保留，basename 与既有工程同名
    const current2 = { scope: 'repo:999999999999', name: 'TLToolBox', root: 'E:/another/TLToolBox' }
    const extra = new MemoryServer(db2, 0, undefined, current2, null)
    extras.push({ server: extra, db: db2 })
    await extra.start()
    const extraBase = `http://127.0.0.1:${await waitForPort(extra)}`

    // 首次读取清单即完成重名自愈：有记忆者保留原名，当前零记忆工程带短标识（仍保留展示）
    const first = await (await fetch(`${extraBase}/api/projects`)).json()
    const firstNames = first.data.map((project: { name: string }) => project.name)
    expect(new Set(firstNames).size).toBe(firstNames.length)
    expect(firstNames).toContain('TLToolBox')
    expect(firstNames).toContain('TLToolBox (999999)')
    expect(db2.findProjectScope('TLToolBox')).toBe('repo:bbbbbbbbbbbb')
    expect(db2.findProjectScope('TLToolBox (999999)')).toBe('repo:999999999999')

    const created = await fetch(`${extraBase}/api/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        project: 'repo:999999999999',
        title: '当前工程首条',
        content: '当前工程与既有工程同名时的写入验证内容',
      }),
    })
    expect(created.status).toBe(201)

    // 写入后名字保持稳定（登记项已在位，不会再叠一层后缀）
    const body = await (await fetch(`${extraBase}/api/projects`)).json()
    const names = body.data.map((project: { name: string }) => project.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('TLToolBox (999999)')
    expect(db2.findProjectScope('TLToolBox (999999)')).toBe('repo:999999999999')
  })

  it('GET /api/nodes 按 scope 精确收敛：全局树 / 指定工程 / 全部工程', async () => {
    const globalRes = await fetch(`${base}/api/nodes?scope=global`)
    const globalBody = await globalRes.json()
    expect(globalBody.data.every((node: { tree_type: string }) => node.tree_type === 'global')).toBe(true)
    expect(globalBody.data.some((node: { name: string }) => node.name === '中文回复')).toBe(true)

    const scopedRes = await fetch(`${base}/api/nodes?scope=project&project=TLToolBox`)
    const scopedBody = await scopedRes.json()
    expect(scopedBody.data.every((node: { tree_type: string }) => node.tree_type === 'repo:bbbbbbbbbbbb')).toBe(true)
    expect(scopedBody.data.some((node: { name: string }) => node.name === 'P0修复')).toBe(true)
    expect(scopedBody.data.some((node: { name: string }) => node.name === 'pnpm放行')).toBe(false)

    const allProjectsRes = await fetch(`${base}/api/nodes?scope=project`)
    const allProjectsBody = await allProjectsRes.json()
    expect(allProjectsBody.data.every((node: { tree_type: string }) => node.tree_type !== 'global')).toBe(true)

    const allRes = await fetch(`${base}/api/nodes`)
    const allBody = await allRes.json()
    expect(allBody.data.length).toBeGreaterThan(allProjectsBody.data.length)
  })

  it('未知工程名不再 404：回 200 + 空树 + 可读提示（避免看板记忆归零与下拉死锁）', async () => {
    const res = await fetch(`${base}/api/nodes?scope=project&project=不存在的工程`)
    expect(res.status).toBe(200)
    const body = await res.json()
    // 契约：data 与 nodes 双字段空数组 + 可读 message + 原样回显请求的工程标识
    expect(body.data).toEqual([])
    expect(body.nodes).toEqual([])
    expect(body.message).toContain('不存在的工程')
    expect(body.resolved).toBe(false)

    // /api/search 共用同一份容错语义
    const search = await fetch(`${base}/api/search?q=pnpm&scope=project&project=不存在的工程`)
    expect(search.status).toBe(200)
    const searchBody = await search.json()
    expect(searchBody.data).toEqual([])
    expect(searchBody.message).toContain('不存在的工程')
  })

  it('GET /api/memories?tree=global 的历史契约保持不变', async () => {
    const res = await fetch(`${base}/api/memories?tree=global`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const names = body.data.map((node: { name: string }) => node.name)
    expect(names).toContain('中文回复')
    expect(names).not.toContain('pnpm放行')
  })

  it('GET /api/search 与 /api/nodes 作用域一致：跨工程不串味', async () => {
    const scoped = await fetch(`${base}/api/search?q=pnpm&scope=project&project=my-dsh-plugins`)
    const scopedBody = await scoped.json()
    expect(scopedBody.data.length).toBeGreaterThan(0)
    expect(scopedBody.data.every((hit: { tree_type: string }) => hit.tree_type === 'repo:aaaaaaaaaaaa')).toBe(true)

    // 换到 TLToolBox 后同一关键词应当无命中
    const other = await fetch(`${base}/api/search?q=pnpm&scope=project&project=TLToolBox`)
    const otherBody = await other.json()
    expect(otherBody.data).toHaveLength(0)

    // 全局偏好作用域同样不该检索到工程记忆
    const global = await fetch(`${base}/api/search?q=pnpm&scope=global`)
    const globalBody = await global.json()
    expect(globalBody.data).toHaveLength(0)
  })

  it('PATCH /api/projects 可给历史遗留作用域补一个可读名字', async () => {
    db.upsertLeaf('repo:deadbeefcafe', ['遗留'], '历史记忆', '改造前入库的历史记忆断言内容', ['legacy'])

    const res = await fetch(`${base}/api/projects`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'repo:deadbeefcafe', name: '旧工程' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.some((project: { name: string }) => project.name === '旧工程')).toBe(true)

    // 改名后按可读名即可直接取树
    const nodesRes = await fetch(`${base}/api/nodes?scope=project&project=旧工程`)
    expect(nodesRes.status).toBe(200)
    const nodesBody = await nodesRes.json()
    expect(nodesBody.data.some((node: { name: string }) => node.name === '历史记忆')).toBe(true)
  })

  it('PATCH /api/projects 缺字段时返回 400 且不改动任何数据', async () => {
    const names = () => db.listProjects().map((project) => project.name)
    const before = names()

    const res = await fetch(`${base}/api/projects`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'repo:aaaaaaaaaaaa' }),
    })
    expect(res.status).toBe(400)
    expect(names()).toEqual(before)
  })
})
