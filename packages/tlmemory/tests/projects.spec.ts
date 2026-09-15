// packages/tlmemory/tests/projects.spec.ts
// 多项目记忆选择的契约固化：
// 1. projects 登记表把不可读的 repo:<hash> 反解为可读工程名，且用户手工命名不被自动登记覆盖；
// 2. GET /api/projects 覆盖「所有存在记忆记录的工程」并补上尚无记忆的当前工程；
// 3. GET /api/nodes 的 scope/project 组合能精确收敛到单棵工程树，全局偏好树与工程树互不串味；
// 4. /api/search 与 /api/nodes 共用同一套作用域语义（图谱高亮与列表命中必须来自同一棵树）。
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

describe('dsh-plugin-tlmemory 多项目记忆选择', () => {
  let db: MemoryDB
  let server: MemoryServer
  let port: number
  let base: string

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

    server = new MemoryServer(db, 0, undefined, CURRENT)
    server.start()
    port = await waitForPort(server)
    base = `http://127.0.0.1:${port}`
  })

  afterEach(() => {
    server.stop()
    db.close()
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
    // 无记忆记录但已登记的当前工程也要出现在下拉框里
    expect(names).toContain('deskcraft')
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

  it('未知工程名返回 404，而不是静默给出一棵空树', async () => {
    const res = await fetch(`${base}/api/nodes?scope=project&project=不存在的工程`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('不存在的工程')
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
