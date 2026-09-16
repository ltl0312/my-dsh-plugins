// packages/tlmemory/tests/p2-fixes.spec.ts
// 2026-09-15 代码评审 P2 部分回归固化：
// 1. P2-1  GET /api/health 轻量探针（不再拉全量节点表判断在线）；
// 2. P2-3  expandQueryCandidates 配额分配：token 保底 + 滑窗轮转，尾部概念词不被截掉；
// 3. P2-5  单轮提炼截断 ≤5 条 + 名称相似去重（强化覆盖而非新建）；
// 4. P2-6  目录创建不再虚增 reinforce_count；叶/目录同名冲突后 is_leaf 归位；
// 5. P2-8  DELETE 非法 id 返回 false（服务端 404/200 success:false，不再 500）；
// 6. P2-9  请求体按字节计数，超限返回 413。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Context } from 'cordis'
import { MemoryDB } from '../src/db.js'
import { MemoryServer } from '../src/server.js'
import { MemoryExtractor } from '../src/extractor.js'
import { expandQueryCandidates } from '../src/query-expand.js'
import type { ReflectionResponse } from '../src/types.js'

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

describe('P2-1 / P2-8 / P2-9：服务端契约', () => {
  let db: MemoryDB
  let server: MemoryServer
  let base: string

  beforeEach(async () => {
    db = new MemoryDB(':memory:')
    db.upsertLeaf('repo:p2test', ['工程化'], 'pnpm放行', 'pnpm 11 需要配置原生依赖构建放行键', ['pnpm'])
    server = new MemoryServer(db, 0)
    server.start()
    const port = await waitForPort(server)
    base = `http://127.0.0.1:${port}`
  })

  afterEach(() => {
    server.stop()
    db.close()
  })

  it('P2-1: GET /api/health 返回 200 与 {ok:true}，且不携带节点数据', async () => {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok?: boolean; data?: unknown }
    expect(json.ok).toBe(true)
    expect(json.data).toBeUndefined()
  })

  it('P2-8: DELETE /api/nodes/abc 收敛为 success:false，不再以 500 暴露内部异常', async () => {
    const res = await fetch(`${base}/api/nodes/abc`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { success: boolean }
    expect(json.success).toBe(false)
  })

  it('P2-9: 超过 256KB 字节上限的请求体返回 413，而不是缺字段 400 / 内部 500', async () => {
    const oversized = 'x'.repeat(300 * 1024)
    const res = await fetch(`${base}/api/nodes/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: oversized }),
    })
    expect(res.status).toBe(413)
  })

  it('P2-9: 256KB 以内的正常请求不受影响（中文正文按真实字节计数）', async () => {
    const chinese = '这是一段中文正文，用来验证字节计数语义。'.repeat(100)
    const res = await fetch(`${base}/api/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', title: '字节计数', content: chinese }),
    })
    expect(res.status).toBe(201)
  })

  it('P2-9: 超限 413 必须可靠投递（连续 10 次大体积上传，不得退化为 ECONNRESET）', async () => {
    // 回归固化（2026-09-16 加固）：旧实现在响应结束后 req.destroy()，与对端仍在途的请求体
    // 赛跑 —— RST 会让对端内核丢弃接收缓冲里的 413，客户端拿到 ECONNRESET。
    // 2MB 上传下旧实现几乎必然失败（8MB 实测 20/20 失败），故本用例对回归有确定性拦截力。
    const oversized = 'x'.repeat(2 * 1024 * 1024)
    const payload = JSON.stringify({ content: oversized })
    const statuses: number[] = []
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${base}/api/nodes/1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
      statuses.push(res.status)
      // 响应体必须完整可读（不只是状态码「碰巧」回来了）
      const json = (await res.json()) as { error?: string }
      expect(json.error).toContain('字节上限')
    }
    expect(statuses).toEqual(new Array(10).fill(413))
  })

  it('P2-9: 超限请求被拒后连接可继续复用（不残留半关闭连接）', async () => {
    const oversized = 'x'.repeat(400 * 1024)
    const rejected = await fetch(`${base}/api/nodes/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: oversized }),
    })
    expect(rejected.status).toBe(413)
    // 紧随其后的小请求必须照常成功：证明超限拒绝没有把服务的请求管道带偏
    const healthy = await fetch(`${base}/api/health`)
    expect(healthy.status).toBe(200)
    expect((await healthy.json()) as { service?: string }).toMatchObject({ ok: true, service: 'tlmemory' })
  })
})

describe('P2-3：查询候选展开配额分配', () => {
  it('滑窗候选吃满上限时，每个 token 与其中英文分段仍有保底名额', () => {
    const query = '我们在调试 pnpm 构建拦截问题，最后发现是 better-sqlite3 的 ABI 不匹配'
    const candidates = expandQueryCandidates(query)
    expect(candidates[0]).toBe(query)
    expect(candidates.length).toBeLessThanOrEqual(16)
    for (const token of ['pnpm', 'better-sqlite3', 'ABI']) {
      expect(candidates).toContain(token)
    }
    // 滑窗 Trigram 子串仍然存在（3 字粒度）
    expect(candidates.some((c) => c.length === 3 && /[\u4e00-\u9fa5]/.test(c))).toBe(true)
  })

  it('多段长中文输入：尾部段落的概念词（滑窗子串）按轮转分配不再被整体截掉', () => {
    const query = '首先是很长的第一段背景描述内容铺垫，其次是第二段背景描述内容也很长，最后提到的那个坑'
    const candidates = expandQueryCandidates(query)
    expect(candidates.length).toBeLessThanOrEqual(16)
    // 整句必在首位
    expect(candidates[0]).toBe(query)
    // 三个中文长段都必须至少贡献一个滑窗名额（旧实现里尾段被截得干干净净）
    expect(candidates).toContain('最后提')
    expect(candidates).toContain('提到的')
  })

  it('短输入不受配额影响：全部候选原样保留', () => {
    expect(expandQueryCandidates('pnpm 构建放行')).toContain('pnpm 构建放行')
    expect(expandQueryCandidates('')).toEqual([])
  })
})

describe('P2-6 / P2-8：db 层修复', () => {
  let db: MemoryDB

  beforeEach(() => {
    db = new MemoryDB(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('P2-6: 反复沉淀同一路径，目录 reinforce_count 恒为 1 不再虚增', () => {
    for (let i = 0; i < 3; i++) {
      db.upsertLeaf('repo:p2test', ['工程化', '包管理'], `规则${i}`, `第${i}条断言内容`, [])
    }
    const dirs = db.getAllNodes('repo:p2test').filter((n) => n.is_leaf === 0)
    expect(dirs.length).toBe(2)
    for (const dir of dirs) {
      expect(dir.reinforce_count).toBe(1)
    }
  })

  it('P2-6: 叶子与既有目录同名同路径冲突时，冲突更新后该行转为叶子（is_leaf=1）', () => {
    // 先沉淀一条路径较深的记忆，使「样式」成为目录
    db.upsertLeaf('repo:p2test', ['样式', '主题'], '深浅色规程', '主题切换必须双协议同步', [])
    // 再沉淀 pathSegments=['样式'] 的记忆：目录链复用 /样式/ 后，
    // 叶子 (path='/样式/', name='样式') 与既有目录行精确冲突（UNIQUE 命中）
    const leaf = db.upsertLeaf('repo:p2test', ['样式'], '样式', '样式目录被同名叶子占位', [])
    const row = db.getNode(leaf.id)!
    expect(row.is_leaf).toBe(1)
    expect(row.content).toBe('样式目录被同名叶子占位')
    // 冲突行在 FTS 中不再以目录身份出现：按正文检索可命中
    expect(db.search('样式目录被同名叶子占位', { treeType: 'repo:p2test' }).length).toBeGreaterThan(0)
  })

  it('P2-8: deleteNode 非整数 / 非正数 id 返回 false，不再抛异常', () => {
    db.upsertLeaf('repo:p2test', ['笔记'], '条目', '正文断言', [])
    expect(db.deleteNode('abc')).toBe(false)
    expect(db.deleteNode('NaN')).toBe(false)
    expect(db.deleteNode('0')).toBe(false)
    expect(db.deleteNode('-1')).toBe(false)
  })
})

describe('P2-5：提炼数量截断与相似去重', () => {
  let db: MemoryDB

  /** 构造一个可输出固定 JSON 的假 LLM 上下文（MemoryExtractor 只消费 ctx.llm / ctx.logger） */
  function makeCtx(payload: string): Context {
    return {
      llm: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield { delta: payload }
          },
        }),
      },
      logger: { info() {}, warn() {}, error() {} },
    } as unknown as Context
  }

  function reflection(name: string, content: string): RawReflectionItem {
    return { tree: 'project', path_segments: ['工程化', '包管理'], name, content, keywords: [name] }
  }

  beforeEach(() => {
    db = new MemoryDB(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('单轮超过 5 条 reflections 时只入库前 5 条', async () => {
    // 条目名彼此完全不同主题，避免触发 P2-5 相似去重干扰截断断言
    const names = ['pnpm构建放行', '中文回复偏好', 'vite插件规约', '目录结构约定', '提交信息规范', '分支命名规则', '错误处理约定', '日志级别约定']
    const payload = JSON.stringify({
      reflections: names.map((name, i) => reflection(name, `第${i}条独立断言内容超过四字`)),
    } satisfies ReflectionResponse)
    const extractor = new MemoryExtractor(makeCtx(payload), db)
    await extractor.extractAndConsolidate(
      { turn: 1, userText: '请记住这一整轮的踩坑与结论，内容足够长', assistantText: '好的，本轮结论如下，内容足够长' },
      'repo:p2test',
    )
    const leaves = db.getAllNodes('repo:p2test').filter((n) => n.is_leaf === 1)
    expect(leaves.length).toBe(5)
  })

  it('同一经验换个措辞再次沉淀时走强化覆盖，不新建第二条', async () => {
    const first = JSON.stringify({
      reflections: [reflection('pnpm依赖构建放行', 'pnpm 原生依赖需要构建放行配置')],
    } satisfies ReflectionResponse)
    const second = JSON.stringify({
      reflections: [reflection('pnpm依赖构建放行的问题', 'pnpm 构建放行的最新结论覆盖版')],
    } satisfies ReflectionResponse)

    const extractor1 = new MemoryExtractor(makeCtx(first), db)
    await extractor1.extractAndConsolidate(
      { turn: 1, userText: '这一轮确认了 pnpm 构建放行的问题，内容足够长', assistantText: '结论已整理，内容足够长' },
      'repo:p2test',
    )
    const extractor2 = new MemoryExtractor(makeCtx(second), db)
    await extractor2.extractAndConsolidate(
      { turn: 2, userText: 'pnpm 构建放行问题又有新进展，内容足够长', assistantText: '补充结论如下，内容足够长' },
      'repo:p2test',
    )

    const leaves = db.getAllNodes('repo:p2test').filter((n) => n.is_leaf === 1)
    expect(leaves.length).toBe(1)
    expect(leaves[0].content).toBe('pnpm 构建放行的最新结论覆盖版')
    expect(leaves[0].reinforce_count).toBe(2)
  })

  it('不同主题的相似措辞不会被误判为重复', async () => {
    const first = JSON.stringify({
      reflections: [reflection('测试规范约定', '单元测试必须覆盖核心路径断言')],
    } satisfies ReflectionResponse)
    const second = JSON.stringify({
      reflections: [reflection('测试策略调整', '集成测试优先覆盖边界场景断言')],
    } satisfies ReflectionResponse)
    const extractor1 = new MemoryExtractor(makeCtx(first), db)
    await extractor1.extractAndConsolidate(
      { turn: 1, userText: '本轮确定了测试规范约定，内容足够长', assistantText: '已记录，内容足够长' },
      'repo:p2test',
    )
    const extractor2 = new MemoryExtractor(makeCtx(second), db)
    await extractor2.extractAndConsolidate(
      { turn: 2, userText: '测试策略调整的另一件事，内容足够长', assistantText: '结论不同，内容足够长' },
      'repo:p2test',
    )
    const leaves = db.getAllNodes('repo:p2test').filter((n) => n.is_leaf === 1)
    expect(leaves.length).toBe(2)
  })
})
