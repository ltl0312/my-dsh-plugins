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
  /** /api/projects 是否已结算（成功或失败）：决定顶栏显示「加载中」还是真实空态 */
  const projectsLoading = ref(true)
  const viewMode = ref<ViewMode>('list')
  const nodes = ref<MemoryNodeDto[]>([])
  const activeHitIds = ref<Set<string>>(new Set())
  const searchQuery = ref('')
  const searchResults = ref<MemoryNodeDto[]>([])
  const wsConnected = ref(false)
  /** 详情抽屉当前展示的记忆项；null 表示抽屉关闭 */
  const selectedNode = ref<MemoryNodeDto | null>(null)

  /**
   * 工程下拉的选项清单。
   *
   * /api/projects 失败或滞后（首帧竞态）时，从已加载的节点按 tree_type 反推工程
   * 清单 —— 下方明明有节点数据，顶栏却出现「暂无工程记忆」禁用态就是误报，
   * 这里兜底保证「有节点必有可选项」。反推项拿不到服务端的可读工程名，用
   * scope 哈希前缀代称；/api/projects 恢复后由正规清单整体替换。
   */
  const projectOptions = computed<ProjectDto[]>(() => {
    if (projects.value.length > 0) return projects.value
    const map = new Map<string, ProjectDto>()
    for (const node of nodes.value) {
      const scope = node.tree_type
      if (!scope || scope === 'global') continue
      let entry = map.get(scope)
      if (entry === undefined) {
        const name = scope.startsWith('repo:') ? `工程 ${scope.slice(5, 13)}` : scope
        entry = { scope, name, root: null, nodeCount: 0, leafCount: 0, updatedAt: 0 }
        map.set(scope, entry)
      }
      entry.nodeCount += 1
      if (Number(node.is_leaf) === 1) entry.leafCount += 1
    }
    return Array.from(map.values())
  })

  /** 当前选中的工程（未选中或工程已消失时为 null） */
  const currentProject = computed<ProjectDto | null>(
    () => projectOptions.value.find((item) => item.scope === currentProjectScope.value) ?? null,
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
    projectsLoading.value = true
    try {
      const res = await fetch('/api/projects')
      const json = await res.json()
      projects.value = json.data || []
      // 用户已选过则以用户选择为准，否则用后端上报的当前工程（默认选中项的
      // 最终兜底在 bootstrap 里做，那里还能看到节点反推的工程清单）。
      if (!currentProjectScope.value) {
        currentProjectScope.value = json.current || ''
      }
    } catch (e) {
      console.error('拉取工程列表失败:', e)
    } finally {
      projectsLoading.value = false
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

  /** 首次加载：工程清单与节点树并行拉取，最后统一确定默认选中工程 */
  async function bootstrap() {
    const scopeBefore = currentProjectScope.value
    await Promise.all([fetchProjects(), fetchNodes()])
    if (!currentProjectScope.value) {
      // 后端未上报当前工程：退回到清单第一项（含节点反推的兜底项）。
      currentProjectScope.value = projectOptions.value[0]?.scope ?? ''
    }
    // 并行首拉时作用域尚未确定（空 scope = 全工程查询）。默认工程确定后若发生过
    // 变化，按最终作用域重拉一次节点，保证顶栏选中与下方树一致。
    if (!scopeBefore && currentProjectScope.value) {
      await fetchNodes()
    }
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

  /** MEMORY_HITS 微光的自动熄灭定时器：新广播到来时重置，避免旧定时器提前熄灭新高亮 */
  let hitTimer: ReturnType<typeof setTimeout> | undefined

  function setupWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}`
    const ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      wsConnected.value = true
    }

    ws.onmessage = (event) => {
      // 服务端只发 JSON，但握手脚本 / 代理异常时可能流入任意文本：解析失败静默忽略。
      let payload: { type?: unknown; hitNodeIds?: unknown } | null = null
      try {
        payload = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (payload === null || typeof payload !== 'object') return
      if (payload.type === 'MEMORY_HITS') {
        const ids = Array.isArray(payload.hitNodeIds) ? payload.hitNodeIds : []
        activeHitIds.value = new Set(ids.map(String))
        if (hitTimer !== undefined) clearTimeout(hitTimer)
        // 微光感知：5 秒后自动熄灭，避免残留高亮干扰
        hitTimer = setTimeout(() => {
          activeHitIds.value = new Set()
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
    projectsLoading,
    projectOptions,
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
