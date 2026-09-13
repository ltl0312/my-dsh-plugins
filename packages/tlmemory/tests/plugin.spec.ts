// packages/tlmemory/tests/plugin.spec.ts
// 核心存储与召回质量门禁：物化路径构建与强化、FTS5 Trigram 中英文混排检索、
// Prompt 格式化器注入转义、级联剪枝与全文索引同步清理。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryDB } from '../src/db.js'
import { MemoryRecallEngine } from '../src/recall.js'

describe('dsh-plugin-tlmemory 核心存储与召回测试', () => {
  let db: MemoryDB
  let recall: MemoryRecallEngine

  beforeEach(() => {
    db = new MemoryDB(':memory:')
    recall = new MemoryRecallEngine(db)
  })

  afterEach(() => {
    db.close()
  })

  it('应当正确递归构建物化路径并完成原子规则入库与强化', () => {
    const leaf = db.upsertLeaf(
      'global',
      ['规范', 'TypeScript'],
      '严禁any',
      '工程内必须开启严格类型模式且禁止滥用any',
      ['ts', 'strict', 'any'],
    )

    expect(leaf.path).toBe('/规范/TypeScript/')
    expect(leaf.reinforce_count).toBe(1)

    // 目录节点应作为 is_leaf=0 的分类骨架存在
    const dirs = db.getAllNodes('global').filter((n) => n.is_leaf === 0)
    expect(dirs.map((d) => d.path + d.name)).toEqual(['/规范/规范', '/规范/TypeScript/TypeScript'])

    const reinforced = db.upsertLeaf(
      'global',
      ['规范', 'TypeScript'],
      '严禁any',
      '工程内必须开启严格类型模式且禁止滥用any（强化更新）',
      ['ts'],
    )
    expect(reinforced.reinforce_count).toBe(2)
    expect(reinforced.content).toContain('强化更新')
  })

  it('FTS5 Trigram 应当有效检索中英文混排关键词', () => {
    db.upsertLeaf(
      'repo:test1234',
      ['踩坑', '依赖构建'],
      'pnpm构建拦截',
      'pnpm v11遇到原生C++模块时需使用approve-builds放行',
      ['pnpm', 'better-sqlite3', 'approve-builds'],
    )

    const hitsZh = db.search('原生C++', { treeType: 'repo:test1234' })
    expect(hitsZh.length).toBeGreaterThan(0)
    expect(hitsZh[0].name).toBe('pnpm构建拦截')
    expect(hitsZh[0].score).toBeGreaterThan(0)
    expect(hitsZh[0].bm25_rank).toBe(1)

    const hitsEn = db.search('approve-builds', { treeType: 'repo:test1234' })
    expect(hitsEn.length).toBeGreaterThan(0)

    // 作用域隔离：跨树检索不泄漏
    const crossTree = db.search('原生C++', { treeType: 'global' })
    expect(crossTree.length).toBe(0)
  })

  it('Prompt 格式化器必须对潜在注入实体进行字符转义', () => {
    db.upsertLeaf(
      'global',
      ['安全规约'],
      '标签隔离',
      '必须对 <system> 与 <script> 进行安全转义编码',
      ['security'],
    )

    const hits = db.search('标签隔离')
    expect(hits.length).toBeGreaterThan(0)
    const prompt = recall.formatPromptBlock(hits)

    expect(prompt).not.toContain('<system>')
    expect(prompt).not.toContain('<script>')
    expect(prompt).toContain('&lt;system&gt;')
    expect(prompt).toContain('&lt;script&gt;')
    expect(prompt).toContain('<long_term_memory_context>')
    expect(prompt).toContain('</long_term_memory_context>')

    // 空召回时格式化器必须返回空串，避免向系统提示词注入空壳标签
    expect(recall.formatPromptBlock([])).toBe('')
  })

  it('级联剪枝应同步清理子树叶子与 FTS 索引', () => {
    db.upsertLeaf(
      'repo:test1234',
      ['踩坑', '依赖构建'],
      'pnpm构建拦截',
      'pnpm v11遇到原生C++模块时需使用approve-builds放行',
      ['pnpm', 'approve-builds'],
    )
    db.upsertLeaf('repo:test1234', ['踩坑'], '顶层避坑', 'repo 顶层叶子断言内容', ['top'])
    db.upsertLeaf('global', ['安全规约'], '标签隔离', '全局树叶子不受级联删除影响', ['security'])

    const all = db.getAllNodes('repo:test1234')
    const pitDir = all.find((n) => n.name === '踩坑' && n.path === '/踩坑/')
    expect(pitDir).toBeDefined()

    // 删除目录分支：整棵子树（含顶层叶子与嵌套目录下的叶子）应一并清空
    expect(db.deleteNode(String(pitDir!.id))).toBe(true)
    expect(db.getAllNodes('repo:test1234').length).toBe(0)

    // FTS 索引同步清理：已剪枝记忆不得再被全文检索命中
    expect(db.search('approve-builds', { treeType: 'repo:test1234' }).length).toBe(0)
    expect(db.search('原生C++', {}).length).toBe(0)

    // 其他树作用域不受波及
    expect(db.getAllNodes('global').length).toBe(2)
    expect(db.search('标签隔离', { treeType: 'global' }).length).toBe(1)
  })
})