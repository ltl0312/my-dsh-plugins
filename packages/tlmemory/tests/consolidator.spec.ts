// packages/tlmemory/tests/consolidator.spec.ts
// 记忆归并（1.1.0）契约固化：
// 1. 聚类必须**保守**：路径逐段近义才聚；仅关键词重叠而主题不同的条目绝不并簇
//    （实测宽口径会把 /RAG/Web服务/ 与 /架构决策/项目更名/ 连成一簇）；
// 2. 模型输出不可信：cluster_id 不匹配、source_ids 越界、摘要过短一律丢弃；
// 3. 归并是父子结构：摘要父节点正常参与召回，来源叶子 status='merged' 退出召回；
// 4. 撤销必须完整复原：来源恢复 confirmed、摘要节点删除、二次撤销返回 null；
// 5. 老库迁移幂等：同一文件重复 open 不报错，且补列/建表只发生一次。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryDB } from '../src/db.js'
import {
  MemoryConsolidator,
  clusterCandidates,
  clusterKey,
  commonPathPrefix,
  diceCoefficient,
  parseSummaryResponse,
  pathsAreSimilar,
  type MergeCluster,
} from '../src/consolidator.js'
import type { MergeCandidate } from '../src/db.js'

function candidate(overrides: Partial<MergeCandidate> & { id: string }): MergeCandidate {
  return {
    tree_type: 'global',
    path: '/部署运维/服务规约/',
    name: '规则',
    content: '内容',
    keywords: '',
    ...overrides,
  }
}

/** 假 ctx：只提供 consolidator 需要的 llm.stream 与 logger */
function fakeCtx(reply: string) {
  const logs: string[] = []
  return {
    logs,
    llm: {
      stream() {
        return (async function* () {
          yield { delta: reply }
        })()
      },
    },
    logger: { info: (msg: string) => logs.push(msg), warn: (msg: string) => logs.push(msg) },
  }
}

describe('consolidator：确定性聚类', () => {
  it('路径逐段近义（段数相同、逐段 Dice ≥ 0.6）会被并簇', () => {
    const clusters = clusterCandidates([
      candidate({ id: '1', path: '/部署运维/服务规约/', name: '服务仅绑本地回环' }),
      candidate({ id: '2', path: '/部署与运维/服务规约/', name: 'rag-web绑定铁律' }),
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0].sources.map((s) => s.id)).toEqual(['1', '2'])
  })

  it('仅关键词重叠、主题不同（路径不近义、名称不相似）绝不并簇', () => {
    const clusters = clusterCandidates([
      candidate({ id: '1', path: '/RAG/Web服务/', name: 'RAGWeb服务托管方式', keywords: 'rag 服务 部署' }),
      candidate({ id: '2', path: '/架构决策/项目更名/', name: 'TLRAG知识库更名范围', keywords: 'rag 服务 命名' }),
    ])
    expect(clusters).toHaveLength(0)
  })

  it('名称相似且关键词重叠 ≥2 才并簇', () => {
    const clusters = clusterCandidates([
      candidate({ id: '1', path: '/前端/安全规范/', name: '富文本渲染禁用v-html', keywords: '前端 安全 富文本' }),
      candidate({ id: '2', path: '/安全红线/前端XSS/', name: '富文本禁v-html', keywords: '前端 安全 富文本' }),
    ])
    expect(clusters).toHaveLength(1)
  })

  it('同一输入必得同一输出（确定性）', () => {
    const input = [
      candidate({ id: '1', path: '/a/b/', name: '甲乙丙丁' }),
      candidate({ id: '2', path: '/a/b/', name: '甲乙丙戊' }),
      candidate({ id: '3', path: '/x/y/', name: '完全不同' }),
    ]
    const first = clusterCandidates(input)
    const second = clusterCandidates([...input].reverse())
    expect(first.map((c) => c.sources.map((s) => s.id).sort())).toEqual(
      second.map((c) => c.sources.map((s) => s.id).sort()),
    )
  })

  it('公共路径前缀与段相似度辅助函数', () => {
    expect(commonPathPrefix(['/部署运维/服务规约/', '/部署运维/网络隔离/'])).toBe('/部署运维/')
    expect(commonPathPrefix(['/a/b/', '/c/d/'])).toBe('/a/b/')
    expect(pathsAreSimilar('/部署运维/服务规约/', '/部署与运维/服务规约/')).toBe(true)
    expect(pathsAreSimilar('/部署运维/', '/部署运维/服务规约/')).toBe(false)
    expect(diceCoefficient('服务规约', '服务规约')).toBe(1)
  })
})

describe('consolidator：模型输出校验', () => {
  const clusters: MergeCluster[] = [
    {
      treeType: 'global',
      path: '/a/',
      sources: [
        { id: '1', name: '甲', content: '内容一' },
        { id: '2', name: '乙', content: '内容二' },
      ],
      name: '',
      summary: '',
      keywords: '',
    },
  ]

  it('合法输出被接受', () => {
    const parsed = parseSummaryResponse(
      JSON.stringify({
        summaries: [
          { cluster_id: clusterKey(clusters[0]), name: '摘要标题', summary: '这是一段足够长的归并摘要，用来满足最小长度要求。' },
        ],
      }),
      clusters,
    )
    expect(parsed?.size).toBe(1)
  })

  it('越界 cluster_id / 越界 source_ids / 过短摘要一律丢弃', () => {
    const key = clusterKey(clusters[0])
    expect(parseSummaryResponse(JSON.stringify({ summaries: [{ cluster_id: 'nope', summary: '够长够长够长够长够长够长够长' }] }), clusters)).toBeNull()
    expect(
      parseSummaryResponse(
        JSON.stringify({ summaries: [{ cluster_id: key, source_ids: ['1', '9'], summary: '够长够长够长够长够长够长够长' }] }),
        clusters,
      ),
    ).toBeNull()
    expect(parseSummaryResponse(JSON.stringify({ summaries: [{ cluster_id: key, summary: '太短' }] }), clusters)).toBeNull()
  })

  it('畸形 JSON 收敛为 null', () => {
    expect(parseSummaryResponse('not json at all', clusters)).toBeNull()
    expect(parseSummaryResponse('{"summaries": "x"}', clusters)).toBeNull()
  })
})

describe('consolidator：落库、召回可见性与回滚', () => {
  let db: MemoryDB

  beforeEach(() => {
    db = new MemoryDB(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  function seed(): { first: string; second: string } {
    const first = db.createLeaf('global', ['部署运维', '服务规约'], '服务仅绑本地回环', 'rag-web 必须仅绑定 127.0.0.1', ['部署', '回环'])
    const second = db.createLeaf('global', ['部署运维', '服务规约'], 'rag-web绑定铁律', 'rag-web.service 必须仅绑 127.0.0.1', ['部署', '回环'])
    return { first: first.id, second: second.id }
  }

  it('归并后来源叶子退出召回、摘要父节点可被检索', () => {
    const { first, second } = seed()
    const record = db.applyMerge({
      treeType: 'global',
      path: '/部署运维/服务规约/',
      name: '服务绑定规约',
      summary: 'rag-web 仅绑 127.0.0.1；对外统一经 Nginx 反代；禁止直连公网端口。',
      keywords: '部署 回环',
      sourceIds: [first, second],
    })
    expect(record).not.toBeNull()

    const hits = db.search('127.0.0.1', { treeType: 'global', limit: 10 })
    const ids = hits.map((hit) => hit.id)
    expect(ids).not.toContain(first)
    expect(ids).not.toContain(second)

    const summaryHit = db.search('反代', { treeType: 'global', limit: 10 })
    expect(summaryHit.map((hit) => hit.id)).toContain(String(record!.summaryNodeId))
  })

  it('撤销归并：来源恢复 confirmed、摘要删除、二次撤销返回 null', () => {
    const { first, second } = seed()
    const record = db.applyMerge({
      treeType: 'global',
      path: '/部署运维/服务规约/',
      name: '服务绑定规约',
      summary: 'rag-web 仅绑 127.0.0.1；对外统一经 Nginx 反代；禁止直连公网端口。',
      keywords: '部署',
      sourceIds: [first, second],
    })!
    const reverted = db.revertMerge(record.mergeId)
    expect(reverted).toEqual({ restored: 2, removedSummary: true })
    expect(db.search('127.0.0.1', { treeType: 'global', limit: 10 }).map((hit) => hit.id)).toContain(first)
    expect(db.getNode(String(record.summaryNodeId))).toBeNull()
    expect(db.revertMerge(record.mergeId)).toBeNull()
  })

  it('来源状态不合法（pending / pinned / 跨树 / 已折叠）整次放弃', () => {
    const a = db.createLeaf('global', ['a'], '甲规则', '甲规则内容足够长', [])
    const b = db.createLeaf('global', ['a'], '乙规则', '乙规则内容足够长', [])
    db.setStatus(b.id, 'pending')
    expect(
      db.applyMerge({ treeType: 'global', path: '/a/', name: '摘要', summary: '足够长的摘要内容足够长', keywords: '', sourceIds: [a.id, b.id] }),
    ).toBeNull()

    const c = db.createLeaf('global', ['a'], '丙规则', '丙规则内容足够长', [])
    expect(
      db.applyMerge({ treeType: 'repo:xyz', path: '/a/', name: '摘要', summary: '足够长的摘要内容足够长', keywords: '', sourceIds: [a.id, c.id] }),
    ).toBeNull()
  })

  it('整轮 consolidate（dryRun 不写库；执行后写库并可从报告拿到 mergeId）', async () => {
    const { first, second } = seed()
    const clusterPath = '/部署运维/服务规约/'
    const reply = JSON.stringify({
      summaries: [
        {
          cluster_id: `global|${clusterPath}|${[first, second].sort((x, y) => Number(x) - Number(y)).join(',')}`,
          name: '服务绑定规约',
          summary: 'rag-web 仅绑 127.0.0.1；对外统一经 Nginx 反代；禁止直连公网端口，Qdrant 与 New API 仅内网通信。',
        },
      ],
    })
    const dryCtx = fakeCtx(reply)
    const dryReport = await new MemoryConsolidator(dryCtx as never, db).consolidate({ dryRun: true })
    expect(dryReport.summarized).toBe(true)
    expect(dryReport.applied).toHaveLength(0)
    expect(db.listMergeRecords()).toHaveLength(0)
    expect(db.search('127.0.0.1', { treeType: 'global', limit: 10 }).map((hit) => hit.id)).toContain(first)

    const report = await new MemoryConsolidator(fakeCtx(reply) as never, db).consolidate({ dryRun: false })
    expect(report.applied).toHaveLength(1)
    expect(db.listMergeRecords()).toHaveLength(1)
  })

  it('开关关闭时不落库；LLM 不可用时静默跳过', async () => {
    seed()
    const reply = JSON.stringify({ summaries: [] })
    const disabled = new MemoryConsolidator(fakeCtx(reply) as never, db, { enabled: () => false })
    const report = await disabled.consolidate({ dryRun: false })
    expect(report.applied).toHaveLength(0)
    expect(report.skipped[0]?.reason).toContain('enableAutoMerge')

    const noLlm = new MemoryConsolidator({ logger: { info() {}, warn() {} } } as never, db)
    const silent = await noLlm.consolidate({ dryRun: false })
    expect(silent.applied).toHaveLength(0)
    expect(silent.summarized).toBe(false)
  })
})

describe('consolidator：老库迁移幂等', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlmemory-merge-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('同一文件重复打开不报错，merged_into 列与 merges 表只建一次', () => {
    const file = path.join(dir, 'memory.db')
    const first = new MemoryDB(file)
    first.createLeaf('global', ['a'], '甲', '甲内容足够长', [])
    first.close()

    const second = new MemoryDB(file)
    const columns = (second as unknown as { db: { pragma(name: string): Array<{ name: string }> } }).db
      .pragma('table_info(nodes)')
      .map((column) => column.name)
    expect(columns).toContain('merged_into')
    expect(second.listMergeRecords()).toEqual([])
    second.close()

    const third = new MemoryDB(file)
    expect(third.listMergeRecords()).toEqual([])
    third.close()
  })
})
