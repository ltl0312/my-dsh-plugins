// packages/tlmemory/tests/node-crud.spec.ts
// 记忆编辑 / 手工新增 / 工程重命名 API 契约固化：
// 1. db.createLeaf：手工新增叶子，默认断言计数 1、自动建目录骨架、FTS5 可检索、
//    保留完整 Markdown 原文（不做 80 字截断）、同路径同名覆盖不递增强化；
// 2. db.updateNode：标题与正文编辑（FTS 同步更新）、目录迁移（后代路径前缀修正 +
//    空目录剪枝）、同目录同名冲突抛错、不存在 id 返回 null；
// 3. reinforceByIds：召回强化精确递增；
// 4. server 层：POST /api/nodes（工程 / 全局 / 400）、PUT /api/nodes/:id（200 / 404）、
//    POST /api/projects/rename（200 / 400）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryDB } from '../src/db.js'
import { MemoryServer } from '../src/server.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForPort(server: MemoryServer, timeoutMs = 5000): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const port = server.actualPort
    if (port > 0) return port
    await delay(50)
  }
  throw new Error('server did not start listening in time')
}

describe('db 层：记忆新增与编辑', () => {
  let db: MemoryDB

  beforeEach(() => {
    db = new MemoryDB(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('createLeaf 新增记忆叶子：默认断言计数 1、自动建目录骨架、FTS5 可检索', () => {
    const leaf = db.createLeaf(
      'repo:test1234',
      '/DSH客户端插件/样式优化/',
      '客户端深浅主题切换规程',
      '客户端主题切换必须经 postMessage 双协议同步，看板配色只走令牌层。',
      ['主题', '样式'],
    )

    expect(leaf.is_leaf).toBe(1)
    expect(leaf.reinforce_count).toBe(1)
    expect(leaf.tree_type).toBe('repo:test1234')
    expect(leaf.path).toBe('/DSH客户端插件/样式优化/')
    expect(leaf.name).toBe('客户端深浅主题切换规程')

    // 目录骨架自动创建（is_leaf=0）
    const dirs = db.getAllNodes('repo:test1234').filter((n) => n.is_leaf === 0)
    expect(dirs.map((d) => d.path)).toContain('/DSH客户端插件/')
    expect(dirs.map((d) => d.path)).toContain('/DSH客户端插件/样式优化/')

    // FTS5 全文检索命中
    const hits = db.search('双协议', { treeType: 'repo:test1234' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].name).toBe('客户端深浅主题切换规程')
  })

  it('createLeaf 保留手工 Markdown 原文，不做 80 字截断', () => {
    const long = Array.from({ length: 20 }, (_, i) => `第${i}行：这是一段足够长的手工记忆正文，用来验证不被截断。`).join('\n')
    const leaf = db.createLeaf('repo:test1234', '笔记', '长文', long)
    expect(leaf.content).toBe(long)
    expect(leaf.content!.length).toBeGreaterThan(80)
  })

  it('createLeaf 空目录输入回退到「未分类」，含空白的标题保留空格语义', () => {
    const leaf = db.createLeaf('repo:test1234', '', '空 目录 记忆', '正文内容', [])
    expect(leaf.path).toBe('/未分类/')
    expect(leaf.name).toBe('空 目录 记忆')
  })

  it('createLeaf 同路径同名冲突时覆盖内容但不递增强化计数', () => {
    db.createLeaf('repo:test1234', '笔记', '条目', '第一版内容', [])
    const again = db.createLeaf('repo:test1234', '笔记', '条目', '第二版内容', [])
    expect(again.reinforce_count).toBe(1)
    expect(again.content).toBe('第二版内容')
  })

  it('createLeaf 必填校验：空标题 / 空正文 / 空作用域抛错', () => {
    expect(() => db.createLeaf('repo:test1234', '', '', '有正文')).toThrow(/标题/)
    expect(() => db.createLeaf('repo:test1234', '', '有标题', '   ')).toThrow(/正文/)
    expect(() => db.createLeaf('', '', '有标题', '有正文')).toThrow(/作用域/)
  })

  it('updateNode 修改标题与正文，FTS5 索引同步更新（旧词失配、新词命中）', () => {
    const leaf = db.createLeaf('repo:test1234', '技术选型', '构建工具', '旧内容里记录 webpack 的选型结论', [])
    const updated = db.updateNode(leaf.id, { title: '打包器选型', content: '新内容确定采用 vite 作为统一构建链' })

    expect(updated).not.toBeNull()
    expect(updated!.name).toBe('打包器选型')
    expect(updated!.content).toContain('vite')
    expect(Number(updated!.updated_at)).toBeGreaterThanOrEqual(leaf.updated_at)

    expect(db.search('webpack', { treeType: 'repo:test1234' })).toHaveLength(0)
    expect(db.search('vite', { treeType: 'repo:test1234' }).length).toBeGreaterThan(0)
  })

  it('updateNode 支持目录迁移：后代物化路径前缀同步修正，旧空目录链被剪枝', () => {
    const a = db.createLeaf('repo:test1234', '旧目录', '甲', '甲的内容断言', [])
    const b = db.createLeaf('repo:test1234', '旧目录', '乙', '乙的内容断言', [])
    const dir = db.getAllNodes('repo:test1234').find((n) => n.is_leaf === 0 && n.path === '/旧目录/')
    expect(dir).toBeDefined()

    // 迁移目录并同时改名：旧目录名不应残留
    const moved = db.updateNode(dir!.id, { path: '新目录/子目录', title: '已迁移目录' })
    expect(moved!.path).toBe('/新目录/子目录/')
    expect(moved!.name).toBe('已迁移目录')

    const aAfter = db.getNode(a.id)!
    const bAfter = db.getNode(b.id)!
    expect(aAfter.path).toBe('/新目录/子目录/')
    expect(aAfter.parent_id).toBe(moved!.id)
    expect(bAfter.path).toBe('/新目录/子目录/')

    // 旧目录空壳剪枝
    expect(db.getAllNodes('repo:test1234').some((n) => n.name === '旧目录')).toBe(false)
    // 迁移后 FTS 依旧可命中
    expect(db.search('甲的内容断言', { treeType: 'repo:test1234' }).length).toBeGreaterThan(0)
  })

  it('updateNode 同目录同名冲突抛错且原数据不变', () => {
    db.createLeaf('repo:test1234', '笔记', '甲', '甲内容', [])
    const b = db.createLeaf('repo:test1234', '笔记', '乙', '乙内容', [])
    expect(() => db.updateNode(b.id, { title: '甲' })).toThrow(/同名/)
    expect(db.getNode(b.id)!.name).toBe('乙')
  })

  it('updateNode 空标题 / 叶子空正文抛错；不存在的 id 返回 null', () => {
    const leaf = db.createLeaf('repo:test1234', '笔记', '条目', '正文内容', [])
    expect(() => db.updateNode(leaf.id, { title: '   ' })).toThrow(/标题/)
    expect(() => db.updateNode(leaf.id, { content: '   ' })).toThrow(/正文/)
    expect(db.updateNode('999999', { content: 'x' })).toBeNull()
  })

  it('reinforceByIds 精确递增断言计数，非法 id 自动过滤', () => {
    const leaf = db.createLeaf('repo:test1234', '笔记', '强化目标', '内容断言', [])
    const other = db.createLeaf('repo:test1234', '笔记', '无关目标', '其他断言', [])
    const before = db.getNode(leaf.id)!.reinforce_count

    db.reinforceByIds([leaf.id, '999999', 'abc', -1])
    expect(db.getNode(leaf.id)!.reinforce_count).toBe(before + 1)
    expect(db.getNode(other.id)!.reinforce_count).toBe(1)
  })

  it('getNode 返回完整节点；缺失时返回 null', () => {
    const leaf = db.createLeaf('repo:test1234', '笔记', '条目', '正文内容', [])
    expect(db.getNode(leaf.id)?.name).toBe('条目')
    expect(db.getNode('424242')).toBeNull()
  })
})

describe('server 层：新增 / 编辑 / 重命名 API', () => {
  let db: MemoryDB
  let server: MemoryServer
  let port: number
  let base: string

  const CURRENT = { scope: 'repo:aaaaaaaaaaaa', name: 'my-dsh-plugins', root: 'D:/Code/my-dsh-plugins' }

  beforeEach(async () => {
    db = new MemoryDB(':memory:')
    db.registerProject('repo:aaaaaaaaaaaa', 'my-dsh-plugins', 'D:/Code/my-dsh-plugins')
    db.upsertLeaf('repo:aaaaaaaaaaaa', ['工程化', '包管理'], 'pnpm放行', 'pnpm 11 需要配置原生依赖构建放行键', ['pnpm'])
    // 第 5 参 null：关闭宿主工作区白名单过滤（本用例 scope 为合成种子数据）
    server = new MemoryServer(db, 0, undefined, CURRENT, null)
    server.start()
    port = await waitForPort(server)
    base = `http://127.0.0.1:${port}`
  })

  afterEach(() => {
    server.stop()
    db.close()
  })

  it('POST /api/nodes 创建工程记忆：按可读工程名收敛 scope，返回 201 与完整节点', async () => {
    const res = await fetch(`${base}/api/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        project: 'my-dsh-plugins',
        path: '/工程化/包管理/',
        title: 'registry镜像',
        content: '镜像源不可用时显式回退官方 registry 完成发布。',
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.tree_type).toBe('repo:aaaaaaaaaaaa')
    expect(body.data.path).toBe('/工程化/包管理/')
    expect(body.data.name).toBe('registry镜像')
    expect(body.data.reinforce_count).toBe(1)

    // 立即可检索
    const search = await fetch(`${base}/api/search?q=registry&scope=project&project=my-dsh-plugins`)
    const searchBody = await search.json()
    expect(searchBody.data.length).toBeGreaterThan(0)
  })

  it('POST /api/nodes 全局偏好落 global 树', async () => {
    const res = await fetch(`${base}/api/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'global',
        project: 'my-dsh-plugins',
        path: '/用户偏好/',
        title: '中文回复',
        content: '所有工程交互回复统一使用中文表达。',
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.tree_type).toBe('global')
  })

  it('POST /api/nodes 缺标题或正文返回 400；scope=project 缺工程返回 400', async () => {
    const noTitle = await fetch(`${base}/api/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', title: '', content: '正文' }),
    })
    expect(noTitle.status).toBe(400)

    const noContent = await fetch(`${base}/api/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', title: '标题', content: '  ' }),
    })
    expect(noContent.status).toBe(400)

    const noProject = await fetch(`${base}/api/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', project: '', title: '标题', content: '正文' }),
    })
    expect(noProject.status).toBe(400)
  })

  it('PUT /api/nodes/:id 更新标题与正文，返回更新后完整节点且检索同步', async () => {
    const create = await fetch(`${base}/api/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', path: '/笔记/', title: '原始标题', content: '原始正文提到 webpack' }),
    })
    const created = (await create.json()).data

    const res = await fetch(`${base}/api/nodes/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '改名后的标题', content: '改成 vite 之后的结论' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.name).toBe('改名后的标题')
    expect(body.data.content).toContain('vite')

    const searchOld = await fetch(`${base}/api/search?q=webpack&scope=global`)
    expect(((await searchOld.json()).data) ?? []).toHaveLength(0)
    const searchNew = await fetch(`${base}/api/search?q=vite&scope=global`)
    expect((await searchNew.json()).data.length).toBeGreaterThan(0)
  })

  it('PUT /api/nodes/:id 不存在的节点返回 404；空补丁返回 400', async () => {
    const missing = await fetch(`${base}/api/nodes/424242`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    })
    expect(missing.status).toBe(404)

    const empty = await fetch(`${base}/api/nodes/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(empty.status).toBe(400)
  })

  it('POST /api/projects/rename 支持按可读工程名定位并重命名', async () => {
    const res = await fetch(`${base}/api/projects/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectKey: 'my-dsh-plugins', newName: '插件工厂' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.some((p: { name: string }) => p.name === '插件工厂')).toBe(true)

    // 重命名后按新名即可直接取树（命中原工程记忆）；手工命名不被 registerProject 覆盖
    db.registerProject('repo:aaaaaaaaaaaa', '不应生效的自动名', null)
    const nodes = await fetch(`${base}/api/nodes?scope=project&project=插件工厂`)
    expect(nodes.status).toBe(200)
    const nodeNames = (((await nodes.json()).data) ?? []).map((n: { name: string }) => n.name)
    expect(nodeNames).toContain('pnpm放行')
    const found = db.listProjects().find((p) => p.scope === 'repo:aaaaaaaaaaaa')
    expect(found?.name).toBe('插件工厂')
  })

  it('POST /api/projects/rename 缺字段返回 400', async () => {
    const res = await fetch(`${base}/api/projects/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectKey: 'my-dsh-plugins' }),
    })
    expect(res.status).toBe(400)
  })
})
