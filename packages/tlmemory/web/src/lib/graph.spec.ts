// packages/tlmemory/web/src/lib/graph.spec.ts
// 树状图谱布局的质量门禁：建树容错、紧凑排布不重叠、父节点居中、命中路径高亮传播。
import { describe, it, expect } from 'vitest'
import type { MemoryNodeDto } from '../stores/memory'
import {
  GRAPH_ROOT_ID,
  buildGraphLayout,
  buildGraphTree,
  type GraphLayoutNode,
} from './graph'

/** 构造测试节点；默认是「目录节点」 */
function makeNode(overrides: Partial<MemoryNodeDto> & { id: string; name: string }): MemoryNodeDto {
  return {
    tree_type: 'repo:test',
    parent_id: null,
    path: '/',
    is_leaf: 0,
    content: null,
    keywords: null,
    reinforce_count: 1,
    is_pinned: 0,
    ...overrides,
  }
}

/**
 * 一棵两分支的样例树：
 *   root
 *   ├── 工程化 (dir 10)
 *   │   ├── pnpm放行 (leaf 11, ×3)
 *   │   └── 构建缓存 (leaf 12, ×1)
 *   └── 安全 (dir 20)
 *       └── 令牌隔离 (leaf 21, ×2)
 */
function sampleNodes(): MemoryNodeDto[] {
  return [
    makeNode({ id: '10', name: '工程化', path: '/工程化/' }),
    makeNode({ id: '11', name: 'pnpm放行', parent_id: '10', path: '/工程化/', is_leaf: 1, reinforce_count: 3 }),
    makeNode({ id: '12', name: '构建缓存', parent_id: '10', path: '/工程化/', is_leaf: 1 }),
    makeNode({ id: '20', name: '安全', path: '/安全/' }),
    makeNode({ id: '21', name: '令牌隔离', parent_id: '20', path: '/安全/', is_leaf: 1, reinforce_count: 2 }),
  ]
}

/** 同层卡片不得重叠：按中心 x 排序后，前一张的右边界不得超过后一张的左边界 */
function assertNoOverlap(nodes: readonly GraphLayoutNode[]): void {
  const byDepth = new Map<number, GraphLayoutNode[]>()
  for (const node of nodes) {
    const bucket = byDepth.get(node.depth)
    if (bucket === undefined) byDepth.set(node.depth, [node])
    else bucket.push(node)
  }
  for (const group of byDepth.values()) {
    const sorted = [...group].sort((a, b) => a.x - b.x)
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1] as GraphLayoutNode
      const current = sorted[index] as GraphLayoutNode
      expect(previous.x + previous.width / 2).toBeLessThanOrEqual(current.x - current.width / 2)
    }
  }
}

function findNode(nodes: readonly GraphLayoutNode[], id: string): GraphLayoutNode {
  const found = nodes.find((node) => node.id === id)
  if (found === undefined) throw new Error(`未找到节点 ${id}`)
  return found
}

describe('buildGraphTree 建树与容错', () => {
  it('应当按 parent_id 还原出以合成根为顶的多叉树', () => {
    const root = buildGraphTree(sampleNodes(), 'my-dsh-plugins')

    expect(root.id).toBe(GRAPH_ROOT_ID)
    expect(root.kind).toBe('root')
    expect(root.label).toBe('my-dsh-plugins')
    expect(root.depth).toBe(0)
    expect(root.leafTotal).toBe(3)

    // 目录名顺序取决于 locale 排序规则，这里只断言「同为目录」这一语义，不钉死次序
    const dirNames = root.children.map((child) => child.label).sort()
    expect(dirNames).toEqual(['安全', '工程化'])

    const engineering = root.children.find((child) => child.label === '工程化')!
    expect(engineering.kind).toBe('dir')
    expect(engineering.depth).toBe(1)
    expect(engineering.leafTotal).toBe(2)
    // 叶子按断言数降序：pnpm放行(×3) 排在 构建缓存(×1) 之前
    expect(engineering.children.map((child) => child.label)).toEqual(['pnpm放行', '构建缓存'])
    expect(engineering.children.every((child) => child.depth === 2)).toBe(true)
  })

  it('叶子节点必须先于目录出现在同一层（排序稳定）', () => {
    const nodes = sampleNodes()
    // 与安全同级补一个叶子
    nodes.push(makeNode({ id: '30', name: '顶层叶子', is_leaf: 1, reinforce_count: 9 }))
    const root = buildGraphTree(nodes, 'root')
    expect(root.children.map((child) => child.kind)).toEqual(['dir', 'dir', 'leaf'])
  })

  it('parent_id 缺失 / 指向自身 / 指向叶子时一律挂到根，不丢节点', () => {
    const nodes = [
      makeNode({ id: '1', name: '孤儿', parent_id: '999' }),
      makeNode({ id: '2', name: '自环', parent_id: '2' }),
      makeNode({ id: '3', name: '挂在叶子上', parent_id: '4' }),
      makeNode({ id: '4', name: '某叶子', is_leaf: 1 }),
    ]
    const root = buildGraphTree(nodes, 'root')
    expect(root.children.map((child) => child.label).sort()).toEqual(
      ['孤儿', '自环', '挂在叶子上', '某叶子'].sort(),
    )
  })

  it('父子成环的脏数据必须断环收敛而不是无限递归', () => {
    const nodes = [
      makeNode({ id: '1', name: '环A', parent_id: '2' }),
      makeNode({ id: '2', name: '环B', parent_id: '1' }),
    ]
    const root = buildGraphTree(nodes, 'root')
    expect(root.children.map((child) => child.label).sort()).toEqual(['环A', '环B'])

    const layout = buildGraphLayout(nodes, 'root')
    expect(layout.nodes).toHaveLength(3)
    expect(() => assertNoOverlap(layout.nodes)).not.toThrow()
  })

  it('空集合也要给出唯一的根节点，供空态之外的渲染逻辑复用', () => {
    const layout = buildGraphLayout([], '全局偏好')
    expect(layout.nodes).toHaveLength(1)
    expect(layout.nodes[0]?.kind).toBe('root')
    expect(layout.links).toHaveLength(0)
  })
})

describe('buildGraphLayout 布局', () => {
  it('父节点必须居于子节点跨度正中，且整层不重叠', () => {
    const layout = buildGraphLayout(sampleNodes(), 'my-dsh-plugins')
    assertNoOverlap(layout.nodes)

    const root = findNode(layout.nodes, GRAPH_ROOT_ID)
    const engineering = findNode(layout.nodes, '10')
    const security = findNode(layout.nodes, '20')
    expect(root.x).toBeCloseTo((engineering.x + security.x) / 2, 5)

    const pnpm = findNode(layout.nodes, '11')
    const cache = findNode(layout.nodes, '12')
    expect(engineering.x).toBeCloseTo((pnpm.x + cache.x) / 2, 5)
  })

  it('层级自顶向下递增，连线数等于非根节点数', () => {
    const layout = buildGraphLayout(sampleNodes(), 'my-dsh-plugins')
    const root = findNode(layout.nodes, GRAPH_ROOT_ID)
    expect(root.y).toBeLessThan(findNode(layout.nodes, '10').y)
    expect(findNode(layout.nodes, '10').y).toBeLessThan(findNode(layout.nodes, '11').y)
    expect(layout.links).toHaveLength(layout.nodes.length - 1)
    expect(layout.links.every((link) => link.d.startsWith('M ') && link.d.includes(' C '))).toBe(true)
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
  })

  it('节点计数：叶子显示断言数，目录与根显示子树记忆总数', () => {
    const layout = buildGraphLayout(sampleNodes(), 'my-dsh-plugins')
    expect(findNode(layout.nodes, '11').count).toBe(3)
    expect(findNode(layout.nodes, '12').count).toBe(1)
    expect(findNode(layout.nodes, '10').count).toBe(2)
    expect(findNode(layout.nodes, GRAPH_ROOT_ID).count).toBe(3)
  })
})

describe('buildGraphLayout 检索高亮', () => {
  it('命中叶子 → 自身发光、祖先路径标记、其余节点淡化、路径连线加粗', () => {
    const layout = buildGraphLayout(sampleNodes(), 'my-dsh-plugins', {
      hitIds: new Set(['11']),
      searching: true,
    })

    expect(findNode(layout.nodes, '11').hit).toBe(true)
    expect(findNode(layout.nodes, '11').dim).toBe(false)

    // 祖先链：工程化目录 → 根
    expect(findNode(layout.nodes, '10').onHitPath).toBe(true)
    expect(findNode(layout.nodes, GRAPH_ROOT_ID).onHitPath).toBe(true)

    // 未命中的另一条分支整体淡化
    expect(findNode(layout.nodes, '21').dim).toBe(true)
    expect(findNode(layout.nodes, '20').dim).toBe(true)
    expect(findNode(layout.nodes, '12').dim).toBe(true)

    // 命中路径上的边 = 其「子端」落在命中路径上的边：根→工程化、工程化→pnpm放行。
    // 根自身没有父边，故不会（也不应）出现在这里。
    const onPath = layout.links.filter((link) => link.hit).map((link) => link.to).sort()
    expect(onPath).toEqual(['10', '11'])
    expect(layout.links.every((link) => (link.hit ? true : link.dim))).toBe(true)
  })

  it('未处于检索态时不得出现任何淡化', () => {
    const layout = buildGraphLayout(sampleNodes(), 'my-dsh-plugins', {
      hitIds: new Set(['11']),
      searching: false,
    })
    expect(layout.nodes.every((node) => node.dim === false)).toBe(true)
    expect(layout.links.every((link) => link.dim === false)).toBe(true)
  })

  it('检索无命中时全树淡化，不残留任何高亮', () => {
    const layout = buildGraphLayout(sampleNodes(), 'my-dsh-plugins', {
      hitIds: new Set(),
      searching: true,
    })
    expect(layout.nodes.every((node) => node.hit === false)).toBe(true)
    expect(layout.nodes.every((node) => node.onHitPath === false)).toBe(true)
    expect(layout.nodes.every((node) => node.dim === true)).toBe(true)
  })
})
