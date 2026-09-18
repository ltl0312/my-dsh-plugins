// packages/tlmemory/tests/behavior-indicators.spec.ts
// 「行为检测判定标记」的干净性回归固化（2026-09-18 取证整改）。
//
// 事故背景：插件的两个「决定性写标记」都曾被**非目标链路**写入，使
// `probe/tlmemory-detect.mjs` 的判定出现假阳性/假阴性：
//
//   ① 自动记录标记 nodes.source='auto'
//      旧实现 upsertLeaf 的 options 缺省 {} 且内部取 `options.source ?? 'auto'`，
//      而 tools.ts 的 tlmemory_save 调用时不传 options ⇒ **模型显式存记忆也落 'auto'**，
//      与 turn/end 后台提炼链路在库中完全不可区分。
//      （建表处 SQL 列默认值 'manual' 因两条 INSERT 都显式绑定该列而从未生效。）
//
//   ② 自动调用/注入标记 nodes.reinforce_count
//      「召回即强化」虽是读取面写副作用，但同字段还被
//      upsertNode 的 ON CONFLICT 重沉淀分支（+1）、extractor 的近似去重强化（+1）、
//      decayStaleReinforce（减半）改写 ⇒ 增减都不能单独归因于注入。
//
// 修复后本文件钉死下列不变式：
//   A. source 缺省值恒为 'manual'；只有显式 source:'auto' 才是自动沉淀；
//   B. 新增 last_injected_at 作为**单调、唯一写入点**的注入指示器；
//   C. last_injected_at 与 reinforce_count 严格分离：重沉淀/衰减只动后者；
//   D. 迁移补列默认 0（绝不伪造「刚刚注入过」的时间戳）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Context } from 'cordis'
import { MemoryDB } from '../src/db.js'
import { MemoryRecallEngine } from '../src/recall.js'
import { registerMemoryTools } from '../src/tools.js'

const SCOPE = 'repo:indicator'

let db: MemoryDB

/** 伪宿主：捕获注册的工具定义，供端到端调用工具链路 */
function createToolHost(scope: string) {
  const tools: Array<{
    name: string
    execute: (args: unknown, exec?: unknown) => Promise<unknown>
  }> = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: {
      register: (definition: unknown) => {
        tools.push(definition as (typeof tools)[number])
        return () => {}
      },
    },
  }
  registerMemoryTools(ctx as unknown as Context, db, () => scope)
  return { ctx: ctx as unknown as Context, get: (name: string) => tools.find((t) => t.name === name)! }
}

/** 建一个「已存在但从未注入」的 auto 叶子，返回其 id */
function seedAutoLeaf(name: string, content: string): string {
  return db.upsertLeaf(SCOPE, ['工程化'], name, content, ['kw'], { source: 'auto' }).id
}

/**
 * 把 created_at / updated_at 拨回过去。
 * 衰减判定用 `< cutoff` 严格比较，若靠「刚写完就衰减」会撞上毫秒边界而偶发不过，
 * 因此必须显式回溯时间而非依赖时序。
 */
function backdate(id: string, msAgo: number): void {
  ;(db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
    .prepare('UPDATE nodes SET updated_at = ?, created_at = ? WHERE id = ?')
    .run(Date.now() - msAgo, Date.now() - msAgo, Number(id))
}

beforeEach(() => {
  db = new MemoryDB(':memory:')
})

afterEach(() => {
  db.close()
})

describe('标记 ①：source —— 自动记录的唯一依据', () => {
  it('upsertLeaf 不传 options ⇒ manual（缺省值不得泄漏为 auto）', () => {
    const leaf = db.upsertLeaf(SCOPE, ['工程化'], '不传选项的写入', '断言内容足够长以通过校验', ['kw'])
    expect(leaf.source).toBe('manual')
    expect(leaf.status).toBe('confirmed')
    // 目录亦同：不得因缺省而伪装成自动沉淀
    const dir = db.getAllNodes(SCOPE).find((n) => n.name === '工程化')!
    expect(dir.source).toBe('manual')
  })

  it('只有显式 source:"auto" 落 auto；createLeaf 恒 manual', () => {
    expect(seedAutoLeaf('显式自动沉淀', '由提炼链路写入的断言内容')).toBeTruthy()
    expect(db.getAllNodes(SCOPE).find((n) => n.name === '显式自动沉淀')!.source).toBe('auto')

    const manual = db.createLeaf(SCOPE, ['笔记'], '看板手工条目', '看板写入的正文内容', [])
    expect(manual.source).toBe('manual')
  })

  it('tlmemory_save 工具链路端到端 ⇒ manual（不再伪装成自动沉淀）', () => {
    const host = createToolHost(SCOPE)
    return host
      .get('tlmemory_save')
      .execute({
        tree_scope: 'project',
        path_segments: ['工程化'],
        rule_name: '工具写入的规则',
        content: '模型显式调用工具持久化的断言内容',
        keywords: ['kw'],
      })
      .then(() => {
        const node = db.getAllNodes(SCOPE).find((n) => n.name === '工具写入的规则')
        expect(node, '工具写入的节点必须落库').toBeTruthy()
        // 这条断言就是本次整改的核心：工具写入**不是**自动记录
        expect(node!.source).toBe('manual')
        // 工具写入同样不该留下注入痕迹
        expect(node!.last_injected_at).toBe(0)
      })
  })

  it('冲突重沉淀不动既有 source（重沉淀不改变审计结论）', () => {
    seedAutoLeaf('同名规则', '第一版断言内容足够长')
    // 同一 (tree_type, path, name) 再次沉淀 ⇒ 走 ON CONFLICT 更新分支
    const again = db.upsertLeaf(SCOPE, ['工程化'], '同名规则', '第二版断言内容足够长', ['kw'], {
      source: 'auto',
    })
    expect(again.source).toBe('auto')

    // 即便后续调用方以 manual 名义重写，既有行的 source 也不被改写
    const manualAttempt = db.upsertLeaf(SCOPE, ['工程化'], '同名规则', '第三版断言内容足够长', ['kw'], {
      source: 'manual',
    })
    expect(manualAttempt.source).toBe('auto')
  })
})

describe('标记 ②：last_injected_at —— 注入的唯一依据', () => {
  it('recall() 命中叶子后同时刷新 last_injected_at 与 reinforce_count', () => {
    const id = seedAutoLeaf('检索命中规则', '本项目统一使用 pnpm 管理依赖')
    const before = db.getNode(id)!
    expect(before.last_injected_at).toBe(0)

    const engine = new MemoryRecallEngine(db)
    const hits = engine.recall('pnpm 管理依赖', SCOPE, 5)
    expect(hits.map((h) => h.id)).toContain(id)

    const after = db.getNode(id)!
    expect(after.last_injected_at).toBeGreaterThan(0)
    expect(after.reinforce_count).toBe(before.reinforce_count + 1)
  })

  it('重沉淀只加 reinforce_count，绝不动 last_injected_at（两标记严格分离）', () => {
    const id = seedAutoLeaf('反复沉淀规则', '重复沉淀的断言内容足够长')
    const baseline = db.getNode(id)!

    db.upsertLeaf(SCOPE, ['工程化'], '反复沉淀规则', '第二版重复沉淀内容足够长', ['kw'], { source: 'auto' })
    db.upsertLeaf(SCOPE, ['工程化'], '反复沉淀规则', '第三版重复沉淀内容足够长', ['kw'], { source: 'auto' })

    const after = db.getNode(id)!
    expect(after.reinforce_count).toBe(baseline.reinforce_count + 2) // 重沉淀确实抬权重
    expect(after.last_injected_at).toBe(0) // 但注入标记纹丝不动
  })

  it('decayStaleReinforce 只减 reinforce_count，不动 last_injected_at（免疫假阴性）', () => {
    const id = seedAutoLeaf('待衰减规则', '衰减窗口外的断言内容足够长')
    db.reinforceByIds([id])
    db.reinforceByIds([id])
    const engine = new MemoryRecallEngine(db)
    engine.recall('衰减窗口外的断言', SCOPE, 5)
    const before = db.getNode(id)!
    expect(before.last_injected_at).toBeGreaterThan(0)

    // 回溯 60s 再以 30s 窗口衰减 —— 避免「刚写完就衰减」撞毫秒边界
    backdate(id, 60_000)
    const decayed = db.decayStaleReinforce(30_000)
    expect(decayed).toBeGreaterThan(0)

    const after = db.getNode(id)!
    expect(after.reinforce_count).toBeLessThan(before.reinforce_count) // 权重被削
    expect(after.last_injected_at).toBe(before.last_injected_at) // 注入事实不可被衰减抹掉
  })

  it('markInjected 只认叶子、单调不回退、过滤非法 id', () => {
    const leafId = seedAutoLeaf('叶子规则', '叶子断言内容足够长')
    const dirId = db.getAllNodes(SCOPE).find((n) => n.name === '工程化')!.id

    expect(db.markInjected([leafId, dirId, 'abc', -1, 0, 999999])).toBe(1)
    const stamp = db.getNode(leafId)!.last_injected_at
    expect(stamp).toBeGreaterThan(0)
    expect(db.getNode(dirId)!.last_injected_at).toBe(0) // 目录不进召回

    // 单调：重复标记不回退（MAX 语义）
    db.markInjected([leafId])
    expect(db.getNode(leafId)!.last_injected_at).toBeGreaterThanOrEqual(stamp)
    expect(db.markInjected([])).toBe(0)
  })
})

describe('迁移与保真', () => {
  let legacyFile: string | null = null

  afterEach(() => {
    // 必须先关库再删文件：否则 Windows 下 sqlite 句柄未释放，rmSync 抛 EBUSY
    db.close()
    if (legacyFile !== null && fs.existsSync(legacyFile)) {
      fs.rmSync(legacyFile, { force: true })
      legacyFile = null
    }
  })

  it('旧库（无 last_injected_at 列）打开后自动补列，默认 0 而非伪造时间戳', () => {
    legacyFile = path.join(os.tmpdir(), `tlmemory-indicator-${Date.now()}.db`)
    const require = createRequire(import.meta.url)
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const legacy = new Database(legacyFile)
    // 整改前的 schema：已有 source/status，但**没有** last_injected_at
    legacy.exec(`
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_type TEXT NOT NULL,
        parent_id INTEGER REFERENCES nodes(id),
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        is_leaf INTEGER NOT NULL DEFAULT 0,
        content TEXT,
        keywords TEXT,
        reinforce_count INTEGER NOT NULL DEFAULT 1,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'confirmed',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (tree_type, path, name)
      );
    `)
    legacy
      .prepare(
        `INSERT INTO nodes (tree_type, parent_id, path, name, is_leaf, content, keywords, reinforce_count, is_pinned, source, status, created_at, updated_at)
         VALUES ('repo:legacy', NULL, '/旧目录/', '存量记忆', 1, '存量断言内容', NULL, 7, 0, 'auto', 'confirmed', 1, 1)`,
      )
      .run()
    legacy.close()

    db.close()
    db = new MemoryDB(legacyFile)
    const rows = db.getAllNodes('repo:legacy')
    expect(rows).toHaveLength(1)
    // 存量行补列后必须恒为 0：reinforce_count=7 里掺有重沉淀成分，
    // 回填成时间戳等于伪造审计痕迹
    expect(rows[0].last_injected_at).toBe(0)
    expect(rows[0].reinforce_count).toBe(7)

    // 补列后注入标记仍可正常写入
    expect(db.markInjected([rows[0].id])).toBe(1)
    expect(db.getNode(rows[0].id)!.last_injected_at).toBeGreaterThan(0)
  })

  it('孤儿归并保真 source 与 last_injected_at', () => {
    const leafId = seedAutoLeaf('待搬家规则', '需要跨工程搬运的断言内容')
    db.markInjected([leafId])
    const before = db.getNode(leafId)!

    const merges = db.mergeOrphanScopes({
      keepScope: 'repo:target',
      fallbackScope: 'repo:target',
      isScopeAllowed: (scope: string) => scope === 'repo:target',
      titleToScope: null,
    })
    expect(merges.length).toBeGreaterThan(0)

    const moved = db
      .getAllNodes('repo:target')
      .find((n) => n.name === '待搬家规则' && n.is_leaf === 1)
    expect(moved, '叶子必须被搬到目标工程').toBeTruthy()
    expect(moved!.source).toBe('auto') // 旧实现硬编码 manual，会悄悄改写审计来源
    expect(moved!.last_injected_at).toBe(before.last_injected_at)
    expect(moved!.reinforce_count).toBe(before.reinforce_count)
    expect(db.getAllNodes('repo:indicator')).toHaveLength(0)
  })
})
