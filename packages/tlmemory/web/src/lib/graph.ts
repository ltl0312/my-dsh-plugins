// packages/tlmemory/web/src/lib/graph.ts
// 记忆树 → 自顶向下树状图谱的纯计算层（无 Vue、无 DOM，便于单测覆盖）。
//
// 三段式：
//   1. buildGraphTree    —— 依据 parent_id 把扁平节点还原成多叉树，合成 Level 0 根节点；
//   2. 布局             —— 经典「子树宽度 + 逐层居中」紧凑排布，父节点恒居于子节点跨度正中；
//   3. 高亮             —— 命中叶子到根的整条路径标记，供渲染层做发光 / 淡化。
//
// 为什么用 parent_id 而不是按 path 切分：path 是物化路径，叶子节点与其所属目录共用
// 同一个 path 字面（叶子的 path 就是父目录的 path），按 path 切分会把叶子错挂一层。
import type { MemoryNodeDto } from '../stores/memory'

export type GraphNodeKind = 'root' | 'dir' | 'leaf'

/** 合成根节点（Level 0）的固定 id：不与数据库自增 id 冲突 */
export const GRAPH_ROOT_ID = '__tlmemory_root__'

/** 各层节点的卡片尺寸（Level 0 略大，观感上确立「根」的层级）。
 *  尺寸必须容纳卡片固定内边距（左右各 12px）+ 标题 + 计数徽标，见 style.css 的 .tlm-gnode。 */
export const GRAPH_NODE_SIZE: Record<GraphNodeKind, { width: number; height: number }> = {
  root: { width: 200, height: 54 },
  dir: { width: 164, height: 42 },
  leaf: { width: 208, height: 52 },
}

/** 同层兄弟节点之间的水平间距 */
export const GRAPH_H_GAP = 22

/** 相邻层级之间的垂直留白（不含卡片自身高度） */
export const GRAPH_V_GAP = 56

/** 树节点（还原出的多叉树；仅用于布局，不直接渲染） */
export interface GraphTreeNode {
  id: string
  kind: GraphNodeKind
  label: string
  node: MemoryNodeDto | null
  parentId: string | null
  depth: number
  /** 该子树包含的记忆叶子总数（叶子自身记 1） */
  leafTotal: number
  children: GraphTreeNode[]
}

/** 布局后的节点（可直接映射为绝对定位的卡片） */
export interface GraphLayoutNode {
  id: string
  kind: GraphNodeKind
  label: string
  /** 卡片中心坐标（画布坐标系，未含画布内边距） */
  x: number
  y: number
  width: number
  height: number
  depth: number
  parentId: string | null
  /** 叶子的断言强化次数；目录 / 根为其子树叶子总数 */
  count: number
  /** 叶子节点原样携带，点击时交给详情抽屉 */
  node: MemoryNodeDto | null
  hit: boolean
  onHitPath: boolean
  dim: boolean
}

/** 布局后的连线（三次贝塞尔，父底边中点 → 子顶边中点） */
export interface GraphLayoutLink {
  id: string
  from: string
  to: string
  d: string
  hit: boolean
  dim: boolean
}

export interface GraphLayout {
  nodes: GraphLayoutNode[]
  links: GraphLayoutLink[]
  /** 画布内容尺寸（不含内边距），供 Pan/Zoom 的适配计算使用 */
  width: number
  height: number
}

/** 检索高亮上下文 */
export interface GraphHighlight {
  /** 全文检索命中的节点 id 集合 */
  hitIds?: ReadonlySet<string>
  /** 检索是否处于激活状态（决定是否进入淡化模式） */
  searching?: boolean
}

const EMPTY_HITS: ReadonlySet<string> = new Set<string>()

/** 保留两位小数：路径字符串短一点，渲染更省事 */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 把扁平节点列表还原为自顶向下多叉树，并在顶部合成 Level 0 根节点。
 *
 * 三条容错约定（脏数据不得让看板白屏）：
 *   * parent_id 指向不存在的节点、指向自身、或指向一个叶子 → 一律挂到根；
 *   * 任何父子环都会导致节点无法从根到达 → 循环执行「从原父节点摘下并挂根」直到全树可达；
 *   * 子节点排序固定为「目录在前、叶子在后；叶子按断言数降序、再按名称」，
 *     保证同一份数据每次布局结果一致（否则刷新一次图谱就换一次形状）。
 */
export function buildGraphTree(
  nodes: readonly MemoryNodeDto[],
  rootLabel: string,
): GraphTreeNode {
  const root: GraphTreeNode = {
    id: GRAPH_ROOT_ID,
    kind: 'root',
    label: rootLabel,
    node: null,
    parentId: null,
    depth: 0,
    leafTotal: 0,
    children: [],
  }

  const byId = new Map<string, GraphTreeNode>()
  for (const node of nodes) {
    const id = node?.id === undefined || node?.id === null ? '' : String(node.id)
    if (!id || id === GRAPH_ROOT_ID || byId.has(id)) continue
    const isLeaf = Number(node.is_leaf) === 1
    byId.set(id, {
      id,
      kind: isLeaf ? 'leaf' : 'dir',
      label: String(node.name ?? ''),
      node,
      parentId: node.parent_id === null || node.parent_id === undefined ? null : String(node.parent_id),
      depth: 0,
      leafTotal: isLeaf ? 1 : 0,
      children: [],
    })
  }

  for (const item of byId.values()) {
    const parent = item.parentId === null ? null : byId.get(item.parentId)
    if (parent === null || parent === undefined || parent.id === item.id || parent.kind === 'leaf') {
      // 挂到合成根的同时把 parentId 一并改写成根 id：否则根连线画不出来，
      // 命中路径的上溯也会在「根的第一层子节点」处断掉。
      item.parentId = GRAPH_ROOT_ID
      root.children.push(item)
    } else {
      parent.children.push(item)
    }
  }

  // 断环：反复把「从根到不了」的节点从原父节点摘下并挂到根，直到全树可达
  for (let guard = 0; guard <= byId.size; guard += 1) {
    const reachable = new Set<string>([root.id])
    const stack: GraphTreeNode[] = [root]
    while (stack.length > 0) {
      const current = stack.pop() as GraphTreeNode
      for (const child of current.children) {
        if (reachable.has(child.id)) continue
        reachable.add(child.id)
        stack.push(child)
      }
    }
    const orphans = Array.from(byId.values()).filter((item) => !reachable.has(item.id))
    if (orphans.length === 0) break
    for (const orphan of orphans) {
      const parent = orphan.parentId === null ? null : byId.get(orphan.parentId)
      if (parent !== null && parent !== undefined) {
        parent.children = parent.children.filter((child) => child.id !== orphan.id)
      }
      orphan.parentId = GRAPH_ROOT_ID
      root.children.push(orphan)
    }
  }

  sortChildren(root)
  assignDepth(root, 0, new Set<string>())
  aggregateLeaves(root)
  return root
}

/** 层级内排序：目录优先，叶子按断言数降序、名称升序 */
function sortChildren(node: GraphTreeNode): void {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    if (a.kind === 'leaf' && b.kind === 'leaf') {
      const diff = (b.node?.reinforce_count ?? 0) - (a.node?.reinforce_count ?? 0)
      if (diff !== 0) return diff
    }
    return a.label.localeCompare(b.label, 'zh-Hans-CN')
  })
  for (const child of node.children) sortChildren(child)
}

/** 自顶向下写深度；visited 守卫确保环状脏数据下也会终止 */
function assignDepth(node: GraphTreeNode, depth: number, visited: Set<string>): void {
  if (visited.has(node.id)) return
  visited.add(node.id)
  node.depth = depth
  for (const child of node.children) assignDepth(child, depth + 1, visited)
}

/** 自底向上聚合子树叶子数 */
function aggregateLeaves(node: GraphTreeNode): number {
  let total = node.kind === 'leaf' ? 1 : 0
  for (const child of node.children) total += aggregateLeaves(child)
  node.leafTotal = total
  return total
}

/**
 * 计算树状图谱布局。
 *
 * 排布算法：先自底向上量出每个节点的「子树分配宽度」
 * （= max(自身卡片宽, 子节点分配宽度之和 + 兄弟间距)），再自顶向下把这段宽度切成
 * 若干区间。子节点跨度在各自区间内居中，父节点对准首尾子节点可见卡片的跨度中点
 * 并夹回自己的分配区间 —— 因为分配宽度永不小于子跨度与自身卡片宽，所以兄弟子树
 * 之间绝不会重叠。
 */
export function buildGraphLayout(
  nodes: readonly MemoryNodeDto[],
  rootLabel: string,
  highlight: GraphHighlight = {},
): GraphLayout {
  const hitIds = highlight.hitIds ?? EMPTY_HITS
  const searching = highlight.searching === true
  const root = buildGraphTree(nodes, rootLabel)

  // 1) 子树分配宽度
  const subtreeWidth = new Map<string, number>()
  const measure = (node: GraphTreeNode): number => {
    const own = GRAPH_NODE_SIZE[node.kind].width
    let width = own
    if (node.children.length > 0) {
      let childrenWidth = 0
      node.children.forEach((child, index) => {
        childrenWidth += measure(child)
        if (index > 0) childrenWidth += GRAPH_H_GAP
      })
      width = Math.max(own, childrenWidth)
    }
    subtreeWidth.set(node.id, width)
    return width
  }
  const canvasWidth = measure(root)

  // 2) 逐层分配纵向基准线（层高取该层最高卡片，层间固定留白）
  const flat: GraphTreeNode[] = []
  const collect = (node: GraphTreeNode): void => {
    flat.push(node)
    for (const child of node.children) collect(child)
  }
  collect(root)

  const levelHeight = new Map<number, number>()
  for (const item of flat) {
    const height = GRAPH_NODE_SIZE[item.kind].height
    levelHeight.set(item.depth, Math.max(levelHeight.get(item.depth) ?? 0, height))
  }
  const maxDepth = flat.reduce((max, item) => Math.max(max, item.depth), 0)
  const levelCenterY: number[] = []
  let verticalCursor = 0
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const height = levelHeight.get(depth) ?? GRAPH_NODE_SIZE.dir.height
    levelCenterY.push(verticalCursor + height / 2)
    verticalCursor += height + GRAPH_V_GAP
  }
  const canvasHeight = Math.max(verticalCursor - GRAPH_V_GAP, 0)

  // 3) 自顶向下切区间
  const centerX = new Map<string, number>()
  const place = (node: GraphTreeNode, left: number): void => {
    const size = GRAPH_NODE_SIZE[node.kind]
    const own = subtreeWidth.get(node.id) ?? size.width
    const ownCenter = left + own / 2
    centerX.set(node.id, ownCenter)
    if (node.children.length === 0) return

    let childrenWidth = 0
    node.children.forEach((child, index) => {
      childrenWidth += subtreeWidth.get(child.id) ?? 0
      if (index > 0) childrenWidth += GRAPH_H_GAP
    })
    let cursor = left + (own - childrenWidth) / 2
    for (const child of node.children) {
      place(child, cursor)
      cursor += (subtreeWidth.get(child.id) ?? 0) + GRAPH_H_GAP
    }

    // 父节点对准「首尾子节点可见卡片的跨度中点」——子树分配宽度里含预留空白，
    // 按分配宽度居中会让父节点偏离肉眼看到的子树中心。随后再把结果夹回自己的
    // 分配区间（夹取区间恒非空，因为分配宽度不小于自身卡片宽度），
    // 这样既视觉居中，又不会越界压到相邻兄弟子树。
    const first = centerX.get(node.children[0]!.id)
    const last = centerX.get(node.children[node.children.length - 1]!.id)
    if (first === undefined || last === undefined) return
    const half = size.width / 2
    centerX.set(node.id, Math.min(Math.max((first + last) / 2, left + half), left + own - half))
  }
  place(root, 0)

  // 4) 高亮：命中节点 → 其上溯到根的整条路径
  const parentOf = new Map<string, string | null>()
  for (const item of flat) parentOf.set(item.id, item.parentId)

  const onHitPath = new Set<string>()
  for (const item of flat) {
    if (!hitIds.has(item.id)) continue
    let cursor: string | null = item.id
    while (cursor !== null && !onHitPath.has(cursor)) {
      onHitPath.add(cursor)
      cursor = parentOf.get(cursor) ?? null
    }
  }

  // 5) 摊平成渲染可直接消费的结构
  const layoutNodes: GraphLayoutNode[] = flat.map((item) => {
    const size = GRAPH_NODE_SIZE[item.kind]
    const hit = hitIds.has(item.id)
    const onPath = onHitPath.has(item.id)
    return {
      id: item.id,
      kind: item.kind,
      label: item.label,
      x: centerX.get(item.id) ?? 0,
      y: levelCenterY[item.depth] ?? 0,
      width: size.width,
      height: size.height,
      depth: item.depth,
      parentId: item.parentId,
      count: item.kind === 'leaf' ? Number(item.node?.reinforce_count ?? 0) : item.leafTotal,
      node: item.node,
      hit,
      onHitPath: onPath,
      dim: searching && !hit && !onPath,
    }
  })

  const nodeIndex = new Map(layoutNodes.map((item) => [item.id, item]))
  const links: GraphLayoutLink[] = []
  for (const item of layoutNodes) {
    if (item.parentId === null) continue
    const parent = nodeIndex.get(item.parentId)
    if (parent === undefined) continue
    const x1 = parent.x
    const y1 = parent.y + parent.height / 2
    const x2 = item.x
    const y2 = item.y - item.height / 2
    const bend = (y2 - y1) * 0.5
    const onPath = onHitPath.has(item.id)
    links.push({
      id: `${parent.id}->${item.id}`,
      from: parent.id,
      to: item.id,
      d: `M ${x1} ${round2(y1)} C ${x1} ${round2(y1 + bend)}, ${x2} ${round2(y2 - bend)}, ${x2} ${round2(y2)}`,
      hit: onPath,
      dim: searching && !onPath,
    })
  }

  return { nodes: layoutNodes, links, width: round2(canvasWidth), height: round2(canvasHeight) }
}
