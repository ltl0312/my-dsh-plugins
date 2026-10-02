// packages/tlmemory/web/src/lib/graph.ts
// 记忆树 → 树状图谱的纯计算层（无 Vue、无 DOM，便于单测覆盖）。
//
// 三段式：
//   1. buildGraphTree    —— 依据 parent_id 把扁平节点还原成多叉树，合成 Level 0 根节点；
//   2. 布局             —— 经典「子树跨度 + 逐层居中」紧凑排布，父节点恒居于子节点跨度正中；
//   3. 高亮             —— 命中叶子到根的整条路径标记，供渲染层做发光 / 淡化。
//
// 两个方向共用同一套算法，只把「主轴（兄弟轴）/ 次轴（层轴）」对调（见 layoutNodes）：
//   * vertical   自顶向下，兄弟沿 x 轴排开、层沿 y 轴下探（深树可读）；
//   * horizontal 自左向右，兄弟沿 y 轴排开、层沿 x 轴右推（宽树可读：兄弟摊在更便宜的竖轴上）。
// 留白口径与方向无关，方向只决定它落在哪条轴上：GRAPH_H_GAP 恒为同层兄弟间距，
// GRAPH_V_GAP 恒为相邻层留白（即生长轴上的留白）。卡片则在 x 轴占宽、在 y 轴占高 ——
// 谁当生长轴，谁就按「该轴的卡片尺寸 + GRAPH_V_GAP」逐层推进，两张卡才不会叠在一起。
//
// 为什么用 parent_id 而不是按 path 切分：path 是物化路径，叶子节点与其所属目录共用
// 同一个 path 字面（叶子的 path 就是父目录的 path），按 path 切分会把叶子错挂一层。
import type { MemoryNodeDto } from '../stores/memory'

export type GraphNodeKind = 'root' | 'dir' | 'leaf'

/** 图谱排布方向：竖向（自顶向下）/ 横向（自左向右） */
export type GraphDirection = 'vertical' | 'horizontal'

/** 合成根节点（Level 0）的固定 id：不与数据库自增 id 冲突 */
export const GRAPH_ROOT_ID = '__tlmemory_root__'

/** 各层节点的卡片尺寸（Level 0 略大，观感上确立「根」的层级）。
 *  尺寸必须容纳卡片固定内边距（左右各 12px）+ 标题 + 计数徽标，见 style.css 的 .tlm-gnode。 */
export const GRAPH_NODE_SIZE: Record<GraphNodeKind, { width: number; height: number }> = {
  root: { width: 200, height: 54 },
  dir: { width: 164, height: 42 },
  leaf: { width: 208, height: 52 },
}

/** 同层兄弟节点之间的间距（与方向无关：竖向落在 x 轴、横向落在 y 轴） */
export const GRAPH_H_GAP = 22

/** 相邻层级之间的留白，不含卡片自身尺寸（即生长轴上的留白；竖向落在 y 轴、横向落在 x 轴） */
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

/** 布局后的连线（竖向为三次贝塞尔：父底边中点 → 子顶边中点；横向为父右边中点 → 子左边中点） */
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
  /** 本次排布使用的方向，供渲染层据此显示提示文案 */
  direction: GraphDirection
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

/** 布局选项：排布方向（默认竖向，保持既有调用点的行为不变） */
export interface GraphLayoutOptions {
  direction?: GraphDirection
}

/**
 * 计算树状图谱布局。
 *
 * 排布算法（两个方向共用）：
 *   1. 兄弟轴上先自底向上量出每个节点的「子树分配跨度」
 *      （= max(自身卡片在兄弟轴上的尺寸, 子节点分配跨度之和 + GRAPH_H_GAP)），
 *      再自顶向下把这段跨度切成若干区间：子节点在各自区间内居中，父节点对准首尾子节点
 *      可见卡片的跨度中点并夹回自己的分配区间 —— 分配跨度永不小于子跨度与自身卡片尺寸，
 *      所以兄弟子树之间绝不会重叠；
 *   2. 生长轴上逐层推进：层厚 = 该层卡片在生长轴上的最大尺寸 + GRAPH_V_GAP，
 *      相邻两层因此永不叠压（横向曾误用卡片高度当层厚，结果层与层叠成一团）。
 *
 * 竖向：兄弟在 x 轴排开、层沿 y 轴下探；横向：兄弟在 y 轴排开、层沿 x 轴右推。
 */
export function buildGraphLayout(
  nodes: readonly MemoryNodeDto[],
  rootLabel: string,
  highlight: GraphHighlight = {},
  options: GraphLayoutOptions = {},
): GraphLayout {
  const direction: GraphDirection = options.direction === 'horizontal' ? 'horizontal' : 'vertical'
  const horizontal = direction === 'horizontal'
  const hitIds = highlight.hitIds ?? EMPTY_HITS
  const searching = highlight.searching === true
  const root = buildGraphTree(nodes, rootLabel)

  // 1) 子树分配跨度 = 在**兄弟轴**上占的宽度：竖向取卡片宽、横向取卡片高
  const subtreeSpan = new Map<string, number>()
  const measure = (node: GraphTreeNode): number => {
    const size = GRAPH_NODE_SIZE[node.kind]
    const own = horizontal ? size.height : size.width
    const siblingGap = GRAPH_H_GAP
    let span = own
    if (node.children.length > 0) {
      let childrenSpan = 0
      node.children.forEach((child, index) => {
        childrenSpan += measure(child)
        if (index > 0) childrenSpan += siblingGap
      })
      span = Math.max(own, childrenSpan)
    }
    subtreeSpan.set(node.id, span)
    return span
  }
  const mainCanvasSpan = measure(root)

  // 2) 逐层分配生长轴基准线：层厚 = 该层卡片在**生长轴**上的最大尺寸（竖向取高、横向取宽），
  //    再加固定的层间留白 GRAPH_V_GAP。
  //    踩过的坑（有测试守着）：早先两个方向都按「卡片高度 + GRAPH_V_GAP」推进层带，
  //    横向时卡片宽 208px 却只前进 108px，相邻两层直接叠压成一团。
  const flat: GraphTreeNode[] = []
  const collect = (node: GraphTreeNode): void => {
    flat.push(node)
    for (const child of node.children) collect(child)
  }
  collect(root)

  const levelThickness = new Map<number, number>()
  for (const item of flat) {
    const size = GRAPH_NODE_SIZE[item.kind]
    const thickness = horizontal ? size.width : size.height
    levelThickness.set(item.depth, Math.max(levelThickness.get(item.depth) ?? 0, thickness))
  }
  const maxDepth = flat.reduce((max, item) => Math.max(max, item.depth), 0)
  const levelCenter: number[] = []
  let levelCursor = 0
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const fallback = GRAPH_NODE_SIZE.dir
    const thickness = levelThickness.get(depth) ?? (horizontal ? fallback.width : fallback.height)
    levelCenter.push(levelCursor + thickness / 2)
    levelCursor += thickness + GRAPH_V_GAP
  }
  const crossCanvasSpan = Math.max(levelCursor - GRAPH_V_GAP, 0)

  // 3) 自顶向下切区间
  const mainCenter = new Map<string, number>()
  const place = (node: GraphTreeNode, start: number): void => {
    const size = GRAPH_NODE_SIZE[node.kind]
    const ownEdge = horizontal ? size.height : size.width
    const siblingGap = GRAPH_H_GAP
    const own = subtreeSpan.get(node.id) ?? ownEdge
    mainCenter.set(node.id, start + own / 2)
    if (node.children.length === 0) return

    let childrenSpan = 0
    node.children.forEach((child, index) => {
      childrenSpan += subtreeSpan.get(child.id) ?? 0
      if (index > 0) childrenSpan += siblingGap
    })
    let cursor = start + (own - childrenSpan) / 2
    for (const child of node.children) {
      place(child, cursor)
      cursor += (subtreeSpan.get(child.id) ?? 0) + siblingGap
    }

    // 父节点对准「首尾子节点可见卡片的跨度中点」——子树分配跨度里含预留空白，
    // 按分配跨度居中会让父节点偏离肉眼看到的子树中心。随后再把结果夹回自己的
    // 分配区间（夹取区间恒非空，因为分配跨度不小于自身卡片尺寸），
    // 这样既视觉居中，又不会越界压到相邻兄弟子树。
    const first = mainCenter.get(node.children[0]!.id)
    const last = mainCenter.get(node.children[node.children.length - 1]!.id)
    if (first === undefined || last === undefined) return
    const half = ownEdge / 2
    mainCenter.set(node.id, Math.min(Math.max((first + last) / 2, start + half), start + own - half))
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
  //    坐标映射：竖向 主轴→x、次轴→y；横向 主轴→y、次轴→x（即把主轴与次轴对调）
  const layoutNodes: GraphLayoutNode[] = flat.map((item) => {
    const size = GRAPH_NODE_SIZE[item.kind]
    const hit = hitIds.has(item.id)
    const onPath = onHitPath.has(item.id)
    const main = mainCenter.get(item.id) ?? 0
    const cross = levelCenter[item.depth] ?? 0
    return {
      id: item.id,
      kind: item.kind,
      label: item.label,
      x: horizontal ? cross : main,
      y: horizontal ? main : cross,
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
    // 竖向：父底边中点 → 子顶边中点；横向：父右边中点 → 子左边中点。
    // 对称三次贝塞尔（两个控制点分别自两端轴向推出半个落差），视觉上是一致的手感。
    let d: string
    if (horizontal) {
      const x1 = parent.x + parent.width / 2
      const y1 = parent.y
      const x2 = item.x - item.width / 2
      const y2 = item.y
      const bend = (x2 - x1) * 0.5
      d = `M ${round2(x1)} ${y1} C ${round2(x1 + bend)} ${y1}, ${round2(x2 - bend)} ${y2}, ${round2(x2)} ${y2}`
    } else {
      const x1 = parent.x
      const y1 = parent.y + parent.height / 2
      const x2 = item.x
      const y2 = item.y - item.height / 2
      const bend = (y2 - y1) * 0.5
      d = `M ${x1} ${round2(y1)} C ${x1} ${round2(y1 + bend)}, ${x2} ${round2(y2 - bend)}, ${x2} ${round2(y2)}`
    }
    const onPath = onHitPath.has(item.id)
    links.push({
      id: `${parent.id}->${item.id}`,
      from: parent.id,
      to: item.id,
      d,
      hit: onPath,
      dim: searching && !onPath,
    })
  }

  return {
    nodes: layoutNodes,
    links,
    width: round2(horizontal ? crossCanvasSpan : mainCanvasSpan),
    height: round2(horizontal ? mainCanvasSpan : crossCanvasSpan),
    direction,
  }
}

/** 可视区尺寸（CSS 像素） */
export interface FitViewport {
  width: number
  height: number
}

/** 画布坐标系里的矩形（左上角 + 尺寸） */
export interface FitRect {
  left: number
  top: number
  width: number
  height: number
}

export interface FitViewOptions {
  /** 全览时四周预留的呼吸空间 */
  margin?: number
  /** 手动缩放的下限（滚轮仍可一直缩到这里看全局地形） */
  minScale?: number
  maxScale?: number
  /** 「一键居中」的保底缩放：宁可只给用户看局部，也不给一片看不清的森林 */
  readableScale?: number
}

export interface FitView {
  scale: number
  offsetX: number
  offsetY: number
  /** canvas = 整棵树都装得下，全览居中；root = 装不下，退化为把根节点钉在左上角 */
  anchored: 'canvas' | 'root'
}

/**
 * 「一键居中」的视口计算（纯函数，便于单测，组件只负责把结果写到 transform 上）。
 *
 * 整棵树装得下可视区时，照旧全览居中；装不下时**不再无底线地往下缩** ——
 * 真实记忆树是「又宽又浅」的，缩到 25% 只剩一团灰，什么也读不出来。
 * 此时保底到 readableScale，并把根节点卡片钉在左上角 margin 处，
 * 让用户从根开始自己拖拽查看局部（滚轮仍可缩到 minScale 看全局地形）。
 */
export function computeFitView(
  viewport: FitViewport,
  canvas: { width: number; height: number },
  root: FitRect,
  options: FitViewOptions = {},
): FitView {
  const margin = options.margin ?? 24
  const minScale = options.minScale ?? 0.25
  const maxScale = options.maxScale ?? 2.2
  const readableScale = options.readableScale ?? 0.6
  const contentWidth = Math.max(canvas.width, 1)
  const contentHeight = Math.max(canvas.height, 1)
  const raw = Math.min(
    (viewport.width - margin * 2) / contentWidth,
    (viewport.height - margin * 2) / contentHeight,
    1,
  )

  if (raw >= readableScale) {
    const scale = Math.min(maxScale, Math.max(minScale, raw))
    return {
      scale,
      offsetX: (viewport.width - contentWidth * scale) / 2,
      offsetY: (viewport.height - contentHeight * scale) / 2,
      anchored: 'canvas',
    }
  }

  // 装不下：保底可读，把根节点卡片的左上角对准 (margin, margin)
  const scale = Math.min(maxScale, Math.max(minScale, readableScale))
  return {
    scale,
    offsetX: margin - root.left * scale,
    offsetY: margin - root.top * scale,
    anchored: 'root',
  }
}
