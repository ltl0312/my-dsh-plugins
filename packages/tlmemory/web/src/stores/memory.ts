// packages/tlmemory/web/src/stores/memory.ts
// 响应式状态流：工程作用域切换、节点树拉取、FTS5 全文检索、级联剪枝删除与 WebSocket 实时双向监听。
//
// 作用域模型（后端 tree_type 的对外投影）：
//   * 全局偏好树固定为 tree_type === 'global'；
//   * 工程记忆树是 tree_type === 'repo:<12位sha256>'，一个仓库一个作用域。
//     /api/projects 负责把哈希反解成可读工程名，本 store 据此提供下拉框数据。
// 拉取节点与全文检索共用同一套作用域查询串，保证「图谱里高亮的命中」与
// 「列表里列出的命中」永远来自同一棵树。
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export interface MemoryNodeDto {
  id: string
  tree_type: string
  parent_id: string | null
  path: string
  name: string
  is_leaf: number
  content: string | null
  keywords: string | null
  reinforce_count: number
  is_pinned: number
  /** 检索结果附带的重合度评分（/api/search 返回 SearchResult 时存在） */
  score?: number
}

/** GET /api/projects 的条目：工程作用域的对外摘要 */
export interface ProjectDto {
  scope: string
  name: string
  root: string | null
  nodeCount: number
  leafCount: number
  updatedAt: number
}

/** 顶部作用域页签：工程记忆 / 全局偏好 */
export type TreeTab = 'project' | 'global'

/** 视图模式：折叠目录列表 / 自顶向下树状图谱 */
export type ViewMode = 'list' | 'graph'

export const useMemoryStore = defineStore('memory', () => {
  const currentTree = ref<TreeTab>('project')
  /** 当前选中的工程 scope（tree_type 原文）；空串表示尚未确定，后端会回退为全部工程 */
  const currentProjectScope = ref<string>('')
  const projects = ref<ProjectDto[]>([])
  const viewMode = ref<ViewMode>('list')
  const nodes = ref<MemoryNodeDto[]>([])
  const activeHitIds = ref<Set<string>>(new Set())
  const searchQuery = ref('')
  const searchResults = ref<MemoryNodeDto[]>([])
  const wsConnected = ref(false)
  /** 详情抽屉当前展示的记忆项；null 表示抽屉关闭 */
  const selectedNode = ref<MemoryNodeDto | null>(null)

  /** 当前选中的工程（未选中或工程已消失时为 null） */
  const currentProject = computed<ProjectDto | null>(
    () => projects.value.find((item) => item.scope === currentProjectScope.value) ?? null,
  )

  /**
   * 作用域查询串：/api/nodes 与 /api/search 共用。
   * 全局偏好走 scope=global；工程记忆带 project=<scope> 精确收敛到单棵树。
   */
  const scopeQuery = computed<string>(() => {
    if (currentTree.value === 'global') return 'scope=global'
    if (currentProjectScope.value) {
      return `scope=project&project=${encodeURIComponent(currentProjectScope.value)}`
    }
    return 'scope=project'
  })

  /** 图谱根节点标题 / 列表分组标题 */
  const scopeLabel = computed<string>(() => {
    if (currentTree.value === 'global') return '全局偏好'
    return currentProject.value?.name ?? '当前工程'
  })

  /** 当前作用域内的节点（后端已按作用域收敛，这里仅做防御式过滤） */
  const scopedNodes = computed<MemoryNodeDto[]>(() =>
    currentTree.value === 'global'
      ? nodes.value.filter((node) => node.tree_type === 'global')
      : nodes.value.filter((node) => node.tree_type !== 'global'),
  )

  /** 全文检索是否处于激活状态（决定图谱是否进入「命中高亮 / 未命中淡化」模式） */
  const isSearching = computed<boolean>(() => searchQuery.value.trim().length > 0)

  /** 命中的节点 id 集合（图谱与列表共用同一份命中数据） */
  const searchHitIds = computed<Set<string>>(
    () => new Set(searchResults.value.map((item) => item.id)),
  )

  /** 拉取工程清单；首次加载时把默认选中项锁定到宿主当前所在工程 */
  async function fetchProjects() {
    try {
      const res = await fetch('/api/projects')
      const json = await res.json()
      projects.value = json.data || []
      // 用户已选过则以用户选择为准，否则用后端上报的当前工程，最后退回叶子最多的工程
      if (!currentProjectScope.value) {
        currentProjectScope.value = json.current || projects.value[0]?.scope || ''
      }
    } catch (e) {
      console.error('拉取工程列表失败:', e)
    }
  }

  async function fetchNodes() {
    try {
      const res = await fetch(`/api/nodes?${scopeQuery.value}`)
      const json = await res.json()
      nodes.value = json.data || []
    } catch (e) {
      console.error('拉取节点数据失败:', e)
    }
  }

  /** 首次加载：工程清单与节点树并行拉取 */
  async function bootstrap() {
    await fetchProjects()
    await fetchNodes()
  }

  /** 切换工程：立即切换到工程记忆并重新拉取该工程的树与检索结果 */
  async function selectProject(scope: string) {
    if (!scope) return
    currentTree.value = 'project'
    currentProjectScope.value = scope
    await fetchNodes()
    await refreshSearch()
  }

  /** 切到工程记忆页签（不改动已选工程） */
  async function activateProject() {
    if (currentTree.value === 'project') return
    currentTree.value = 'project'
    await fetchNodes()
    await refreshSearch()
  }

  /** 切到全局偏好页签 */
  async function activateGlobal() {
    if (currentTree.value === 'global') return
    currentTree.value = 'global'
    await fetchNodes()
    await refreshSearch()
  }

  /** 全局偏好胶囊：已激活时再点一次回到工程记忆（胶囊式双向切换） */
  async function toggleGlobal() {
    if (currentTree.value === 'global') await activateProject()
    else await activateGlobal()
  }

  function setViewMode(mode: ViewMode) {
    viewMode.value = mode
  }

  /** 切换工程后按当前关键词重跑检索，保证高亮与列表不指向上一棵树 */
  async function refreshSearch() {
    if (!searchQuery.value.trim()) {
      searchResults.value = []
      return
    }
    await performSearch(searchQuery.value)
  }

  /** 打开详情抽屉（点击列表项 / 图谱叶子节点即进入 Markdown 全文阅读） */
  function openDetail(node: MemoryNodeDto) {
    selectedNode.value = node
  }

  /** 关闭详情抽屉 */
  function closeDetail() {
    selectedNode.value = null
  }

  async function deleteNode(id: string) {
    await fetch(`/api/nodes/${id}`, { method: 'DELETE' })
    await fetchNodes()
    await fetchProjects()
    await refreshSearch()
  }

  async function performSearch(query: string) {
    if (!query.trim()) {
      searchResults.value = []
      return
    }
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&${scopeQuery.value}`)
    const json = await res.json()
    searchResults.value = json.data || []
  }

  /**
   * 图谱与列表高亮共用的「实时命中」查询：给定节点 id 集合，判断是否处于微光态。
   * （来自 WebSocket MEMORY_HITS 广播，数秒后自动熄灭。）
   */
  function isActiveHit(id: string): boolean {
    return activeHitIds.value.has(id)
  }

  function setupWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}`
    const ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      wsConnected.value = true
    }

    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data)
      if (payload.type === 'MEMORY_HITS') {
        activeHitIds.value = new Set(payload.hitNodeIds || [])
        // 微光感知：5 秒后自动熄灭，避免残留高亮干扰
        setTimeout(() => {
          activeHitIds.value.clear()
        }, 5000)
      } else if (payload.type === 'TREE_CHANGED') {
        void fetchNodes()
        void fetchProjects()
      }
    }

    ws.onclose = () => {
      wsConnected.value = false
      setTimeout(setupWebSocket, 3000)
    }

    ws.onerror = () => {
      ws.close()
    }
  }

  return {
    currentTree,
    currentProjectScope,
    projects,
    viewMode,
    nodes,
    activeHitIds,
    searchQuery,
    searchResults,
    wsConnected,
    selectedNode,
    currentProject,
    scopeQuery,
    scopeLabel,
    scopedNodes,
    isSearching,
    searchHitIds,
    fetchProjects,
    fetchNodes,
    bootstrap,
    selectProject,
    activateProject,
    activateGlobal,
    toggleGlobal,
    setViewMode,
    refreshSearch,
    performSearch,
    deleteNode,
    isActiveHit,
    setupWebSocket,
    openDetail,
    closeDetail,
  }
})
