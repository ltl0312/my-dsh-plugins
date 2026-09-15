// packages/tlmemory/tests/recall-quality.spec.ts
// P1 检索质量回归（2026-09-15 代码评审 P1-3 / P1-4）：
// 1. is_pinned = 1 的记忆在检索中强制置顶；
// 2. reinforce_count 纳入打分（召回即强化的设计承诺落地）；
// 3. <3 字符短词经 LIKE 回退不再静默零命中；
// 4. tlmemory_query 与召回引擎共用 expandQueryCandidates（长句可命中）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryDB } from '../src/db.js'
import { expandQueryCandidates } from '../src/query-expand.js'

describe('检索质量门禁（P1-3 / P1-4）', () => {
  let db: MemoryDB

  beforeEach(() => {
    db = new MemoryDB(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('P1-3: is_pinned=1 的记忆必须排在 BM25 更相关但未置顶的记忆之前', () => {
    db.upsertLeaf('global', ['构建'], '强相关普通记忆', 'pnpm 原生依赖需要构建放行配置', ['pnpm'])
    const pinned = db.upsertLeaf('global', ['安全'], '置顶但弱相关', 'pnpm 相关的置顶断言占位内容', ['pnpm'])
    // 直接 SQL 置顶（看板尚无置顶入口，此处模拟未来置顶操作）
    ;(db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
      .prepare('UPDATE nodes SET is_pinned = 1 WHERE id = ?')
      .run(Number(pinned.id))

    const hits = db.search('pnpm')
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits[0].id).toBe(pinned.id)
  })

  it('P1-3: reinforce_count 越高得分越高（同 BM25 基线时强化记忆胜出）', () => {
    const a = db.upsertLeaf('global', ['工程化'], '低频记忆甲', 'pnpm 构建放行的第一条断言内容', ['pnpm'])
    const b = db.upsertLeaf('global', ['工程化'], '高频记忆乙', 'pnpm 构建放行的第二条断言内容', ['pnpm'])
    // 对乙反复强化（模拟多轮召回命中）
    for (let i = 0; i < 5; i++) {
      db.upsertLeaf('global', ['工程化'], '高频记忆乙', 'pnpm 构建放行的第二条断言内容', ['pnpm'])
    }
    const hits = db.search('构建放行')
    expect(hits.length).toBeGreaterThanOrEqual(2)
    const scoreB = hits.find((h) => h.id === b.id)!.score
    const scoreA = hits.find((h) => h.id === a.id)!.score
    expect(scoreB).toBeGreaterThan(scoreA)
  })

  it('P1-4: 2 字符短词经 LIKE 回退可命中（Trigram 最小粒度问题的兜底）', () => {
    db.upsertLeaf('global', ['语言'], 'Go并发规约', 'Go 项目并发原语统一使用 errgroup 封装', ['go', 'goroutine'])
    const hits = db.search('Go')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].name).toBe('Go并发规约')
  })

  it('P1-4: expandQueryCandidates 为共享模块，长句尾部概念词生成滑窗候选', () => {
    const candidates = expandQueryCandidates('我们在调试 pnpm 构建拦截问题，最后发现是 better-sqlite3 的 ABI 不匹配')
    // 整句必在候选首位
    expect(candidates[0]).toContain('ABI')
    // 滑窗 Trigram 子串存在（3 字粒度）
    expect(candidates.some((c) => c.length === 3 && /[\u4e00-\u9fa5]/.test(c))).toBe(true)
    // 截断上限 16
    expect(candidates.length).toBeLessThanOrEqual(16)
    // 空输入安全
    expect(expandQueryCandidates('')).toEqual([])
  })
})
