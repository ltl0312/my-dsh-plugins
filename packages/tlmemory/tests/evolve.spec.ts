// packages/tlmemory/tests/evolve.spec.ts
// 1.3.0「自动进化、零审核」的两条确定性能力回归：
// 1. supersede / restoreSuperseded：旧结论被取代后退出召回，但原文与取代关系保留、可回滚；
// 2. mergeSimilarDirectories：同父目录下的近义兄弟目录合成一棵，只改结构不动内容。
//
// 这里刻意只测确定性部分：语义质量靠 LLM，测试不该假装能验证它。
import { describe, expect, it } from 'vitest'
import { MemoryDB } from '../src/db.js'

describe('自动淘汰（supersede / restoreSuperseded）', () => {
  it('旧结论退出召回但保留原文与取代关系，可回滚', () => {
    const db = new MemoryDB(':memory:')
    const oldNode = db.upsertLeaf('repo:p2t', ['工程化'], '包管理器选型', '本项目统一使用 npm 管理全部依赖', ['npm'])
    const newNode = db.upsertLeaf('repo:p2t', ['工程化'], '包管理器迁移', '本项目已迁移到 pnpm 管理全部依赖', ['pnpm'])

    expect(db.supersede(oldNode.id, newNode.id, '包管理器结论互斥')).toBe(true)

    const replaced = db.getNode(oldNode.id)!
    expect(replaced.status).toBe('superseded')
    expect(replaced.merged_into).toBe(Number(newNode.id))
    // 召回口径必须排除 superseded，否则新旧结论会同时注入
    expect(db.search('npm 管理全部依赖', { treeType: 'repo:p2t' }).map((hit) => hit.id)).not.toContain(oldNode.id)
    expect(db.search('pnpm 管理全部依赖', { treeType: 'repo:p2t' }).map((hit) => hit.id)).toContain(newNode.id)
    // 看板仍能看到它（可回滚的前提）
    expect(db.getAllNodes('repo:p2t').map((node) => node.id)).toContain(oldNode.id)

    expect(db.restoreSuperseded(oldNode.id)).toBe(true)
    const restored = db.getNode(oldNode.id)!
    expect(restored.status).toBe('confirmed')
    expect(restored.merged_into).toBeNull()
    expect(db.search('npm 管理全部依赖', { treeType: 'repo:p2t' }).map((hit) => hit.id)).toContain(oldNode.id)
    // 二次回滚无副作用
    expect(db.restoreSuperseded(oldNode.id)).toBe(false)
    db.close()
  })

  it('自我取代、跨树取代、非法 id 一律拒绝', () => {
    const db = new MemoryDB(':memory:')
    const a = db.upsertLeaf('repo:p2t', ['工程化'], '甲结论', '甲结论的内容足够长以便入库', ['甲'])
    const b = db.upsertLeaf('repo:p2t', ['工程化'], '乙结论', '乙结论的内容足够长以便入库', ['乙'])
    const other = db.upsertLeaf('repo:other', ['工程化'], '丙结论', '丙结论的内容足够长以便入库', ['丙'])

    expect(db.supersede(a.id, a.id)).toBe(false)
    expect(db.supersede(a.id, other.id)).toBe(false)
    expect(db.supersede('0', b.id)).toBe(false)
    expect(db.supersede('abc', b.id)).toBe(false)
    expect(db.supersede('999999', b.id)).toBe(false)
    expect(db.getNode(a.id)!.status).toBe('confirmed')
    db.close()
  })
})

describe('自动进化（mergeSimilarDirectories）', () => {
  it('同父目录下的近义目录合并成一棵，节点内容不变', () => {
    const db = new MemoryDB(':memory:')
    const left = db.upsertLeaf('repo:p2t', ['部署运维'], '进程守护', 'systemd 负责进程守护与自启', ['systemd'])
    const right = db.upsertLeaf('repo:p2t', ['部署与运维'], '日志轮转', 'journald 负责日志轮转与清理', ['journald'])
    // 干扰项：与上面两个都不同义的兄弟目录
    const keep = db.upsertLeaf('repo:p2t', ['前端'], '构建工具', 'vite 负责前端构建与热更新', ['vite'])

    const result = db.mergeSimilarDirectories()
    expect(result.mergedDirs).toBeGreaterThanOrEqual(1)
    expect(result.movedNodes).toBeGreaterThanOrEqual(1)

    const leftAfter = db.getNode(left.id)!
    const rightAfter = db.getNode(right.id)!
    // 内容与名称原样保留，只有挂载位置变了
    expect(leftAfter.content).toBe('systemd 负责进程守护与自启')
    expect(rightAfter.content).toBe('journald 负责日志轮转与清理')
    // 两条现在共享同一父目录
    expect(rightAfter.parent_id).toBe(leftAfter.parent_id)
    expect(leftAfter.path).toBe(rightAfter.path)
    // 不同义目录未被牵连
    expect(db.getNode(keep.id)!.path).toBe('/前端/')
    db.close()
  })

  it('不同义目录不合并（前后端不会被并到一起）', () => {
    const db = new MemoryDB(':memory:')
    db.upsertLeaf('repo:p2t', ['前端'], '构建工具', 'vite 负责前端构建与热更新', ['vite'])
    db.upsertLeaf('repo:p2t', ['后端'], '接口框架', 'fastify 负责后端接口', ['fastify'])
    expect(db.mergeSimilarDirectories()).toEqual({ mergedDirs: 0, movedNodes: 0 })
    db.close()
  })

  it('空库与单目录库是零成本空操作', () => {
    const db = new MemoryDB(':memory:')
    expect(db.mergeSimilarDirectories()).toEqual({ mergedDirs: 0, movedNodes: 0 })
    db.upsertLeaf('repo:p2t', ['工程化'], '唯一记忆', '库里只有这一条记忆内容', ['唯一'])
    expect(db.mergeSimilarDirectories()).toEqual({ mergedDirs: 0, movedNodes: 0 })
    db.close()
  })
})
