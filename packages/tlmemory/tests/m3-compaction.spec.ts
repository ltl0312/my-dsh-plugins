// packages/tlmemory/tests/m3-compaction.spec.ts
// M3 异步 compaction 回归固化：
// 1. 强化衰减（确定性）：长期未命中的记忆计数减半、下限 1，近期记忆不受影响；
// 2. 矛盾检测（LLM 摊薄）：互斥旧条目降级 pending，畸形输出静默收敛，
//    LLM 输出的越权 id 不被应用；
// 3. 触发节奏：noteSedimented 达阈值才触发；ctx.llm 未就绪时衰减照常、检测跳过。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Context } from 'cordis'
import { MemoryDB } from '../src/db.js'
import { MemoryExtractor } from '../src/extractor.js'
import { MemoryCompactor, REINFORCE_DECAY_WINDOW_MS } from '../src/compactor.js'
import type { RawReflectionItem, ReflectionResponse } from '../src/types.js'

/** 把节点的 updated_at / created_at 拨回过去（模拟「早已入库且长期未被命中」） */
function backdate(db: MemoryDB, id: string, msAgo: number): void {
  ;(db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
    .prepare('UPDATE nodes SET updated_at = ?, created_at = ? WHERE id = ?')
    .run(Date.now() - msAgo, Date.now() - msAgo, Number(id))
}

describe('M3：强化衰减（确定性）', () => {
  it('长期未命中的记忆计数减半（下限 1），近期记忆不受影响', () => {
    const db = new MemoryDB(':memory:')
    const stale = db.upsertLeaf('repo:p2t', ['工程化'], '陈旧记忆', '很久没有命中过的断言', ['旧'])
    const fresh = db.upsertLeaf('repo:p2t', ['工程化'], '新近记忆', '最近还在被命中的断言', ['新'])
    const floor = db.upsertLeaf('repo:p2t', ['工程化'], '下限记忆', '计数已到下限的断言', ['底'])

    // 造强化计数：stale=10、fresh=10、floor 保持初始 1
    for (let i = 0; i < 9; i++) {
      db.reinforceByIds([stale.id, fresh.id])
    }
    // stale 与 floor 都拨回衰减窗口之前：stale 应减半，floor 因「下限 1」不动
    backdate(db, stale.id, REINFORCE_DECAY_WINDOW_MS + 1000)
    backdate(db, floor.id, REINFORCE_DECAY_WINDOW_MS + 1000)

    const changed = db.decayStaleReinforce(REINFORCE_DECAY_WINDOW_MS)
    expect(changed).toBe(1)
    expect(db.getNode(stale.id)!.reinforce_count).toBe(5)
    expect(db.getNode(fresh.id)!.reinforce_count).toBe(10)
    expect(db.getNode(floor.id)!.reinforce_count).toBe(1)
    db.close()
  })
})

describe('M3：矛盾检测（LLM 摊薄）', () => {
  let db: MemoryDB
  let llmStream: ReturnType<typeof vi.fn>

  function makeCtx(llmOutput: string): Context {
    llmStream = vi.fn().mockImplementation(() =>
      (async function* () {
        yield { type: 'delta', delta: llmOutput }
      })(),
    )
    return {
      llm: { stream: llmStream },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as Context
  }

  /** 通过真实提炼链路放入「旧记忆」，返回其 id */
  async function seedOldNode(db: MemoryDB, name: string, content: string): Promise<string> {
    const item: RawReflectionItem = {
      tree: 'project',
      path_segments: ['工程化'],
      name,
      content,
      keywords: [name],
    }
    const payload = JSON.stringify({ reflections: [item] } satisfies ReflectionResponse)
    const ctx = {
      llm: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield { delta: payload }
          },
        }),
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as Context
    await new MemoryExtractor(ctx, db).extractAndConsolidate(
      { turn: 1, userText: '本轮确认了新的工程结论，内容足够长', assistantText: '结论已整理完毕，内容足够长' },
      'repo:p2t',
    )
    return db.getAllNodes('repo:p2t').find((n) => n.name === name)!.id
  }

  beforeEach(() => {
    db = new MemoryDB(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('互斥旧条目被降级为 pending（待确认区，退出召回），新条目保持 confirmed', async () => {
    // compactor 先构造（确定本批窗口起点），再种入「早已存在的旧记忆」
    const compactor = new MemoryCompactor(makeCtx(''), db, 1)
    await seedOldNode(db, '包管理器选型', '本项目统一使用 npm 管理全部依赖')
    const oldId = db.getAllNodes('repo:p2t').find((n) => n.name === '包管理器选型')!.id
    // 旧记忆拨回窗口之前：它不属于本批，而是作为既有记忆参与候选
    backdate(db, oldId, 60_000)

    // 新结论入库（confirmed，created_at 在窗口内）。
    // 必须显式声明 source:'auto'：矛盾检测的取数口径本就是「本批 auto 沉淀」
    // （listLeavesCreatedSince 带 source='auto' 过滤），手写条目（看板/工具）
    // 不该被自动降级为 pending。此前该用例靠 upsertLeaf 的缺省 'auto' 才命中，
    // 属测试固化了有缺陷的缺省值。
    const newNode = db.upsertLeaf(
      'repo:p2t',
      ['工程化'],
      '包管理器迁移',
      '本项目已迁移到 pnpm 管理全部依赖',
      ['pnpm'],
      { source: 'auto' },
    )

    const llmOutput = JSON.stringify({
      conflicts: [{ old_id: oldId, new_id: newNode.id, reason: '包管理器结论互斥' }],
    })
    ;(compactor as unknown as { ctx: Context }).ctx = makeCtx(llmOutput)
    await compactor.compact()

    expect(db.getNode(oldId)!.status).toBe('pending')
    expect(db.getNode(newNode.id)!.status).toBe('confirmed')
    // pending 退出召回
    expect(db.search('npm 管理全部依赖', { treeType: 'repo:p2t' }).map((h) => h.id)).not.toContain(oldId)
  })

  it('LLM 输出畸形 / 越权 id 时静默收敛，不改任何节点状态', async () => {
    const compactor = new MemoryCompactor(makeCtx(''), db, 1)
    await seedOldNode(db, '包管理器选型', '本项目统一使用 npm 管理全部依赖')
    const oldId = db.getAllNodes('repo:p2t').find((n) => n.name === '包管理器选型')!.id
    backdate(db, oldId, 60_000)
    const newNode = db.upsertLeaf('repo:p2t', ['工程化'], '包管理器迁移', '本项目已迁移到 pnpm 管理全部依赖', ['pnpm'])

    const malformed = makeCtx('这里不是 JSON')
    ;(compactor as unknown as { ctx: Context }).ctx = malformed
    await compactor.compact()

    const hijack = makeCtx(
      JSON.stringify({
        conflicts: [{ old_id: newNode.id, new_id: newNode.id, reason: '越权指定任意节点' }],
      }),
    )
    ;(compactor as unknown as { ctx: Context }).ctx = hijack
    await compactor.compact()

    expect(db.getNode(newNode.id)!.status).toBe('confirmed')
    for (const node of db.getAllNodes('repo:p2t')) {
      expect(node.status).toBe('confirmed')
    }
  })

  it('ctx.llm 未就绪：衰减照常执行，矛盾检测静默跳过', async () => {
    const stale = db.upsertLeaf('repo:p2t', ['工程化'], '陈旧记忆', '很久没有命中过的断言', ['旧'])
    for (let i = 0; i < 5; i++) db.reinforceByIds([stale.id])
    backdate(db, stale.id, REINFORCE_DECAY_WINDOW_MS + 1000)

    const ctx = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as Context
    const compactor = new MemoryCompactor(ctx, db, 1)
    await expect(compactor.compact()).resolves.toBeUndefined()
    expect(db.getNode(stale.id)!.reinforce_count).toBe(3)
  })

  it('noteSedimented 达到阈值才触发，随后复位重新计数', () => {
    const ctx = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as Context
    const compactor = new MemoryCompactor(ctx, db, 3)
    expect(compactor.noteSedimented()).toBe(false)
    expect(compactor.noteSedimented()).toBe(false)
    expect(compactor.noteSedimented()).toBe(true)
    expect(compactor.noteSedimented()).toBe(false)
    expect(compactor.noteSedimented()).toBe(false)
    expect(compactor.noteSedimented()).toBe(true)
  })
})
