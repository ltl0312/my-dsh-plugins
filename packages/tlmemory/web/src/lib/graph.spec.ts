// packages/tlmemory/web/src/lib/graph.spec.ts
// 树状图谱布局的质量门禁：建树容错、紧凑排布不重叠、父节点居中、命中路径高亮传播。
import { describe, it, expect } from 'vitest'
import type { MemoryNodeDto } from '../stores/memory'
import {
  GRAPH_H_GAP,
  GRAPH_ROOT_ID,
  GRAPH_V_GAP,
  buildGraphLayout,
  buildGraphTree,
  computeFitView,
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

/** 同层卡片不得重叠：按中心 y 排序后，前一张的下边界不得超过后一张的上边界 */
function assertNoOverlapY(nodes: readonly GraphLayoutNode[]): void {
  const byDepth = new Map<number, GraphLayoutNode[]>()
  for (const node of nodes) {
    const bucket = byDepth.get(node.depth)
    if (bucket === undefined) byDepth.set(node.depth, [node])
    else bucket.push(node)
  }
  for (const group of byDepth.values()) {
    const sorted = [...group].sort((a, b) => a.y - b.y)
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1] as GraphLayoutNode
      const current = sorted[index] as GraphLayoutNode
      expect(previous.y + previous.height / 2).toBeLessThanOrEqual(current.y - current.height / 2)
    }
  }
}

/**
 * 相邻两层不得叠压：按 depth 求出每层在该轴上的 [起始, 结束] 区间，逐层两两比较。
 * 这是「横向重叠」那个 bug 的守门测试 —— 层厚若没按生长轴上的卡片尺寸推进，
 * 这里会立刻炸（同一层的自重叠由 assertNoOverlap / assertNoOverlapY 覆盖）。
 */
function assertLevelsSeparated(nodes: readonly GraphLayoutNode[], axis: 'x' | 'y'): void {
  const bands = new Map<number, { start: number; end: number }>()
  for (const node of nodes) {
    const center = axis === 'x' ? node.x : node.y
    const half = (axis === 'x' ? node.width : node.height) / 2
    const previous = bands.get(node.depth)
    if (previous === undefined) {
      bands.set(node.depth, { start: center - half, end: center + half })
      continue
    }
    previous.start = Math.min(previous.start, center - half)
    previous.end = Math.max(previous.end, center + half)
  }
  const depths = [...bands.keys()].sort((a, b) => a - b)
  for (let index = 1; index < depths.length; index += 1) {
    const previous = bands.get(depths[index - 1] as number) as { start: number; end: number }
    const current = bands.get(depths[index] as number) as { start: number; end: number }
    expect(previous.end).toBeLessThanOrEqual(current.start)
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

describe('buildGraphLayout 横向布局', () => {
  const horizontal = (highlight: Parameters<typeof buildGraphLayout>[2] = {}) =>
    buildGraphLayout(sampleNodes(), 'my-dsh-plugins', highlight, { direction: 'horizontal' })

  it('方向默认竖向，显式传入横向时方向随之改变', () => {
    expect(buildGraphLayout(sampleNodes(), 'root').direction).toBe('vertical')
    expect(horizontal().direction).toBe('horizontal')
  })

  it('层级自左向右递增，同层兄弟沿 y 轴排开且不重叠', () => {
    const layout = horizontal()
    assertNoOverlapY(layout.nodes)

    const root = findNode(layout.nodes, GRAPH_ROOT_ID)
    expect(root.x).toBeLessThan(findNode(layout.nodes, '10').x)
    expect(findNode(layout.nodes, '10').x).toBeLessThan(findNode(layout.nodes, '11').x)
    expect(layout.links).toHaveLength(layout.nodes.length - 1)
  })

  it('父节点居于子节点纵向跨度正中（主轴与次轴对调后仍然成立）', () => {
    const layout = horizontal()
    const root = findNode(layout.nodes, GRAPH_ROOT_ID)
    const engineering = findNode(layout.nodes, '10')
    const security = findNode(layout.nodes, '20')
    expect(root.y).toBeCloseTo((engineering.y + security.y) / 2, 5)

    const pnpm = findNode(layout.nodes, '11')
    const cache = findNode(layout.nodes, '12')
    expect(engineering.y).toBeCloseTo((pnpm.y + cache.y) / 2, 5)
  })

  it('连线自父卡片右边中点出发、落在子卡片左边中点（横向三次贝塞尔）', () => {
    const layout = horizontal()
    const engineering = findNode(layout.nodes, '10')
    const pnpm = findNode(layout.nodes, '11')
    const link = layout.links.find((item) => item.to === '11')!

    // d = M x1 y1 C ... , x2 y2 —— 起点 x 为父卡片右边界、终点 x 为子卡片左边界，y 取各自中心
    const match = /^M ([\d.-]+) ([\d.-]+) C .+, ([\d.-]+) ([\d.-]+)$/.exec(link.d)!
    expect(Number(match[1])).toBeCloseTo(engineering.x + engineering.width / 2, 5)
    expect(Number(match[2])).toBeCloseTo(engineering.y, 5)
    expect(Number(match[3])).toBeCloseTo(pnpm.x - pnpm.width / 2, 5)
    expect(Number(match[4])).toBeCloseTo(pnpm.y, 5)
  })

  it('两条轴各自用自己的口径：生长轴按卡片宽度推进、兄弟轴按卡片高度铺开', () => {
    const vertical = buildGraphLayout(sampleNodes(), 'my-dsh-plugins')
    const layout = horizontal()

    // 生长轴（横向 = x）：逐层取该层最宽的卡片 + 层间留白 GRAPH_V_GAP
    const levelBandSpan = 200 + GRAPH_V_GAP + 164 + GRAPH_V_GAP + 208
    expect(layout.width).toBeCloseTo(levelBandSpan, 5)
    expect(layout.width).toBeCloseTo(684, 5)

    // 兄弟轴（横向 = y）：3 张叶子 × 卡片高 52 + 2 段同层间距 GRAPH_H_GAP
    expect(layout.height).toBeCloseTo(3 * 52 + 2 * GRAPH_H_GAP, 5)
    expect(layout.height).toBeCloseTo(200, 5)

    // 竖向口径保持原样：生长轴（y）取卡片高 + GRAPH_V_GAP，兄弟轴（x）取卡片宽 + GRAPH_H_GAP
    expect(vertical.height).toBeCloseTo(54 + GRAPH_V_GAP + 42 + GRAPH_V_GAP + 52, 5)
    expect(vertical.height).toBeCloseTo(260, 5)
    expect(vertical.width).toBeCloseTo(208 + GRAPH_H_GAP + 208 + GRAPH_H_GAP + 208, 5)
    expect(vertical.width).toBeCloseTo(668, 5)

    // 两个方向的层与层都必须真的分开
    assertLevelsSeparated(vertical.nodes, 'y')
    assertLevelsSeparated(layout.nodes, 'x')
  })

  it('相邻层不得叠压：横向层厚必须按卡片宽度推进（曾经的横向重叠 bug）', () => {
    const layout = horizontal()
    assertLevelsSeparated(layout.nodes, 'x')

    const root = findNode(layout.nodes, GRAPH_ROOT_ID)
    const engineering = findNode(layout.nodes, '10')
    const pnpm = findNode(layout.nodes, '11')

    // 父卡右边界 → 子卡左边界，恰好留出一段 GRAPH_V_GAP：
    // 旧实现用「卡片高度 52 + GRAPH_V_GAP」当层厚，横向每层只前进 108px，
    // 而卡片宽 208px，父子卡片直接叠掉 100px —— 这里就是那个回归点。
    expect(root.x + root.width / 2).toBeCloseTo(engineering.x - engineering.width / 2 - GRAPH_V_GAP, 5)
    expect(engineering.x + engineering.width / 2).toBeCloseTo(pnpm.x - pnpm.width / 2 - GRAPH_V_GAP, 5)
    expect(root.width).toBeGreaterThan(0)
  })

  it('深树横竖互换：竖向是细高条，横向翻成扁宽条', () => {
    // 六层链式目录（根 + 四个中间目录 + 一个叶子，每层只有一个子节点）：深度跨度远大于兄弟跨度
    const deep: MemoryNodeDto[] = [
      makeNode({ id: 'a', name: 'A', path: '/A/' }),
      makeNode({ id: 'b', name: 'B', parent_id: 'a', path: '/A/B/' }),
      makeNode({ id: 'c', name: 'C', parent_id: 'b', path: '/A/B/C/' }),
      makeNode({ id: 'd', name: 'D', parent_id: 'c', path: '/A/B/C/D/' }),
      makeNode({ id: 'e', name: 'E', parent_id: 'd', path: '/A/B/C/D/', is_leaf: 1 }),
    ]
    const vertical = buildGraphLayout(deep, 'root')
    const layout = buildGraphLayout(deep, 'root', {}, { direction: 'horizontal' })

    // 竖向：宽度只有单张最宽卡片（叶子 208），高度是 6 层累加 —— 层厚 54 + 42×4 + 52，层间 5 段 GRAPH_V_GAP
    expect(vertical.width).toBeCloseTo(208, 5)
    expect(vertical.height).toBeCloseTo(54 + 42 * 4 + 52 + GRAPH_V_GAP * 5, 5)
    expect(vertical.height).toBeCloseTo(554, 5)
    expect(vertical.height).toBeGreaterThan(vertical.width)

    // 横向：同一棵树把深度摊到 x 轴上 —— 逐层「该层最宽卡片 + GRAPH_V_GAP」，末层不再加留白。
    // 兄弟轴只剩根卡片高度 54，于是它又宽又扁。
    expect(layout.width).toBeCloseTo(
      (200 + GRAPH_V_GAP) + (164 + GRAPH_V_GAP) * 4 + (208 + GRAPH_V_GAP) - GRAPH_V_GAP,
      5,
    )
    expect(layout.width).toBeCloseTo(1344, 5)
    expect(layout.height).toBeCloseTo(54, 5)
    expect(layout.width).toBeGreaterThan(layout.height)

    assertLevelsSeparated(layout.nodes, 'x')
  })

  it('横向布局同样传播检索高亮', () => {
    const layout = horizontal({ hitIds: new Set(['11']), searching: true })
    expect(findNode(layout.nodes, '11').hit).toBe(true)
    expect(findNode(layout.nodes, '10').onHitPath).toBe(true)
    expect(findNode(layout.nodes, GRAPH_ROOT_ID).onHitPath).toBe(true)
    expect(findNode(layout.nodes, '21').dim).toBe(true)
    expect(layout.links.filter((link) => link.hit).map((link) => link.to).sort()).toEqual(['10', '11'])
  })
})

describe('computeFitView 一键居中', () => {
  const fitOptions = { margin: 24, minScale: 0.25, maxScale: 2.2, readableScale: 0.6 }
  const viewport = { width: 1100, height: 700 }
  const rootRect = { left: 44, top: 44, width: 200, height: 54 }

  it('整棵树装得下时全览居中（与旧行为一致）', () => {
    const canvas = { width: 600, height: 400 }
    const view = computeFitView(viewport, canvas, rootRect, fitOptions)
    const expected = Math.min((1100 - 48) / 600, (700 - 48) / 400, 1)
    expect(view.anchored).toBe('canvas')
    expect(view.scale).toBeCloseTo(expected, 5)
    expect(view.offsetX).toBeCloseTo((1100 - 600 * view.scale) / 2, 5)
    expect(view.offsetY).toBeCloseTo((700 - 400 * view.scale) / 2, 5)
  })

  it('装不下时保底可读并把根节点钉在左上角，不再缩成 25% 的一团灰', () => {
    // 真实库里最宽的作用域：竖向画布 11630×476（含两侧 CANVAS_PAD 44）
    const canvas = { width: 11630 + 88, height: 476 + 88 }
    const view = computeFitView(viewport, canvas, rootRect, fitOptions)
    expect(view.anchored).toBe('root')
    expect(view.scale).toBeCloseTo(0.6, 5)
    // 根卡片左上角正好落在 margin 处，用户从根开始往右/往下拖
    expect(rootRect.left * view.scale + view.offsetX).toBeCloseTo(24, 5)
    expect(rootRect.top * view.scale + view.offsetY).toBeCloseTo(24, 5)
    // 旧的「无底线缩小」算法在这个画布上会得到比可读下限更小的值
    const oldScale = Math.min((1100 - 48) / canvas.width, (700 - 48) / canvas.height, 1)
    expect(oldScale).toBeLessThan(0.6)
  })

  it('缩放下限夹取：可读下限低于 minScale 时以 minScale 为准；适配本身不把树放大超过 1 倍', () => {
    const canvas = { width: 11630 + 88, height: 476 + 88 }
    const capped = computeFitView(viewport, canvas, rootRect, { ...fitOptions, minScale: 0.8 })
    expect(capped.scale).toBeCloseTo(0.8, 5)
    expect(capped.anchored).toBe('root')

    const huge = computeFitView({ width: 5000, height: 5000 }, { width: 100, height: 100 }, rootRect, fitOptions)
    expect(huge.anchored).toBe('canvas')
    expect(huge.scale).toBeCloseTo(1, 5)
    expect(huge.offsetX).toBeCloseTo((5000 - 100) / 2, 5)
  })
})
