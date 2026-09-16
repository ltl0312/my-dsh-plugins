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
  /** 来源标记：'auto'（静默沉淀）/'manual'（看板或工具手工写入） */
  source?: string
  /** 审核状态：'pending' 待确认（不参与召回）/ 'confirmed' 正常入库 */
  status?: string
  /** 检索结果附带的重合度评分（/api/search 返回 SearchResult 时存在） */
  score?: number
}

/** GET /api/projects 的条目：工程作用域的对外摘要 */
export interface ProjectDto {
  scope: string
  name: string
  root: string | null
  /**
   * 所属**宿主工作区**名称（服务端按 DSH 工作区登记表附带）。
   * 与 `name` 不同：`name` 可被用户手工重命名，本字段始终是宿主侧的工作区标题，
   * 用于回答「这个工程到底属于哪个工作区」；无从判定（宿主登记表不可读）时为 null。
   */
  workspaceName?: string | null
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
  /** 服务端上报的宿主当前工程名；当前工程零记忆时不占清单位，靠它如实展示方位 */
  const currentProjectName = ref<string>('')
  /** /api/projects 是否已结算（成功或失败）：决定顶栏显示「加载中」还是真实空态 */
  const projectsLoading = ref(true)
  const viewMode = ref<ViewMode>('list')
  const nodes = ref<MemoryNodeDto[]>([])
  const activeHitIds = ref<Set<string>>(new Set())
  const searchQuery = ref('')
  const searchResults = ref<MemoryNodeDto[]>([])
  const wsConnected = ref(false)
  /** 最近一次操作的可读错误提示（P2-7：此前 4xx/5xx 完全静默）；空串表示无错误 */
  const actionError = ref('')
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
        entry = { scope, name, root: null, workspaceName: null, nodeCount: 0, leafCount: 0, updatedAt: 0 }
        map.set(scope, entry)
      }
      entry.nodeCount += 1
      if (Number(node.is_leaf) === 1) entry.leafCount += 1
    }
    return Array.from(map.values())
  })

  /** 当前选中的工程（未选中、或该工程零记忆不占清单位时为 null） */
  const currentProject = computed<ProjectDto | null>(
    () => projectOptions.value.find((item) => item.scope === currentProjectScope.value) ?? null,
  )

  /**
   * 当前工程所属的宿主工作区名称；未选择工程 / 不属于任何已登记工作区时为 ''。
   * 顶栏工程名旁据此展示工作区标识，让「这个工程属于哪个工作区」一目了然。
   */
  const currentWorkspaceName = computed<string>(() => currentProject.value?.workspaceName ?? '')

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
    if (currentProject.value !== null) return currentProject.value.name
    // 当前工程零记忆时不占清单位（服务端已按「零记忆即清理」维护），
    // 但仍要如实告诉用户「你在哪个工程、它还没有记忆」，而不是笼统的「当前工程」
    return currentProjectName.value ? `${currentProjectName.value}（无记忆）` : '当前工程'
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
      const list = (json.data || []) as ProjectDto[]
      projects.value = list
      const reported = typeof json.current === 'string' ? json.current : ''
      currentProjectName.value = typeof json.currentName === 'string' ? json.currentName : ''
      // 用户已选过则以用户选择为准，否则用后端上报的当前工程（默认选中项的
      // 最终兜底在 bootstrap 里做，那里还能看到节点反推的工程清单）。
      if (!currentProjectScope.value) {
        currentProjectScope.value = reported
      } else if (!list.some((item) => item.scope === currentProjectScope.value)) {
        // 选中的工程已不在清单里（删掉最后一个记忆 → 服务端自动清理了该工程）：
        // 回落到宿主当前工程，再退回清单首项，避免顶栏停在一个已不存在的工程上。
        // 注意当前工程零记忆时也不在清单里，但仍是合法落点，所以优先回落到它。
        currentProjectScope.value = reported || list[0]?.scope || ''
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

  async function deleteNode(id: string): Promise<boolean> {
    actionError.value = ''
    try {
      const res = await fetch(`/api/nodes/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        // P2-7：失败不再静默 —— 给出可读提示（actionError 驱动顶栏错误条）
        const detail = await res.json().catch(() => null)
        actionError.value = `删除记忆失败（HTTP ${res.status}）${detail?.error ? `：${detail.error}` : ''}`
        console.error('删除记忆失败:', res.status, detail)
        return false
      }
    } catch (e) {
      actionError.value = '删除记忆失败：网络异常'
      console.error('删除记忆失败:', e)
      return false
    }
    await fetchNodes()
    await fetchProjects()
    await refreshSearch()
    return true
  }

  /**
   * 在线编辑保存：PUT /api/nodes/:id。
   * 成功后同步三处视图：树列表（fetchNodes）、工程计数（fetchProjects）、
   * 检索命中（refreshSearch），并把抽屉当前节点替换为服务端回传的更新后节点，
   * Markdown 渲染区无缝切换回阅读态。
   */
  async function updateNode(
    id: string,
    patch: { title?: string; content?: string },
  ): Promise<MemoryNodeDto | null> {
    try {
      const res = await fetch(`/api/nodes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) return null
      const json = await res.json()
      const updated = (json.data ?? null) as MemoryNodeDto | null
      if (updated !== null && selectedNode.value?.id === updated.id) {
        selectedNode.value = updated
      }
      await Promise.all([fetchNodes(), fetchProjects()])
      await refreshSearch()
      return updated
    } catch (e) {
      console.error('保存记忆失败:', e)
      return null
    }
  }

  /** 手工新增记忆：POST /api/nodes，成功后刷新树与工程清单并返回新节点（供自动定位） */
  async function createNode(payload: {
    scope: 'project' | 'global'
    project?: string
    path: string
    title: string
    content: string
  }): Promise<MemoryNodeDto | null> {
    try {
      const res = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) return null
      const json = await res.json()
      const created = (json.data ?? null) as MemoryNodeDto | null
      await Promise.all([fetchNodes(), fetchProjects()])
      await refreshSearch()
      return created
    } catch (e) {
      console.error('新增记忆失败:', e)
      return null
    }
  }

  /**
   * 工程重命名：PATCH /api/projects，成功后刷新工程清单（下拉框与树根名随之更新）。
   * 服务端强制工程名唯一 —— 撞名时回 409 与占用者名字，这里原样透出给弹层展示，
   * 不再笼统坍缩成「失败，请稍后重试」。
   */
  async function renameProject(scope: string, name: string): Promise<{ ok: boolean; error: string }> {
    try {
      const res = await fetch('/api/projects', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, name }),
      })
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string }
      if (!res.ok || !json.success) {
        const message = typeof json.error === 'string' && json.error ? json.error : '重命名失败，请稍后重试'
        return { ok: false, error: message }
      }
      await fetchProjects()
      return { ok: true, error: '' }
    } catch (e) {
      console.error('工程重命名失败:', e)
      return { ok: false, error: '重命名失败：网络异常' }
    }
  }

  /** 检索防抖间隔（P2-7：快速输入不再每次按键都打一次 /api/search） */
  const SEARCH_DEBOUNCE_MS = 300
  let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined
  /** 在途检索请求的 AbortController：新请求到来即中止旧请求，防止旧响应覆盖新响应 */
  let searchAbort: AbortController | null = null

  /** 实际发起检索：竞态保护 + 状态码检查（被新请求中止时静默退出） */
  async function performSearchNow(query: string): Promise<void> {
    searchAbort?.abort()
    const controller = new AbortController()
    searchAbort = controller
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&${scopeQuery.value}`, {
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      if (!res.ok) {
        console.error(`检索失败: HTTP ${res.status}`)
        actionError.value = `检索失败（HTTP ${res.status}）`
        return
      }
      const json = await res.json()
      if (controller.signal.aborted) return
      actionError.value = ''
      searchResults.value = json.data || []
    } catch (e) {
      // 请求被新检索取代（AbortError）属正常竞态，静默；真正的网络异常才提示
      if ((e as Error)?.name === 'AbortError') return
      console.error('检索失败:', e)
      actionError.value = '检索失败：网络异常'
    }
  }

  /**
   * P2-7：对外检索入口 —— 300ms 防抖 + AbortController 竞态保护。
   * 快速输入时旧响应不可能再覆盖新响应；Promise 在防抖后的真实请求结算后 resolve。
   */
  /** M1 待确认区审核：确认（confirmed）后重新参与召回；拒绝由调用方转译为删除 */
  async function setNodeStatus(id: string, status: 'confirmed' | 'pending'): Promise<boolean> {
    actionError.value = ''
    try {
      const res = await fetch(`/api/nodes/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => null)
        actionError.value = `更新审核状态失败（HTTP ${res.status}）${detail?.error ? `：${detail.error}` : ''}`
        console.error('更新审核状态失败:', res.status, detail)
        return false
      }
    } catch (e) {
      actionError.value = '更新审核状态失败：网络异常'
      console.error('更新审核状态失败:', e)
      return false
    }
    // 本地同步三处视图状态，避免整树重拉造成闪烁
    const apply = (list: MemoryNodeDto[]) => {
      const target = list.find((item) => item.id === id)
      if (target !== undefined) target.status = status
      return list
    }
    nodes.value = apply(nodes.value)
    searchResults.value = apply(searchResults.value)
    if (selectedNode.value?.id === id) selectedNode.value = { ...selectedNode.value, status }
    return true
  }

  async function performSearch(query: string): Promise<void> {
    if (searchDebounceTimer !== undefined) {
      clearTimeout(searchDebounceTimer)
      searchDebounceTimer = undefined
    }
    if (!query.trim()) {
      searchAbort?.abort()
      searchAbort = null
      actionError.value = ''
      searchResults.value = []
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = undefined
        void performSearchNow(query).finally(resolve)
      }, SEARCH_DEBOUNCE_MS)
    })
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

  /** P2-11 重连退避区间：3s 起步指数翻倍，30s 封顶（服务长期下线时不再无限 3s 空转） */
  const WS_RECONNECT_MIN_MS = 3000
  const WS_RECONNECT_MAX_MS = 30000

  let wsInstance: WebSocket | undefined
  let wsReconnectDelay = WS_RECONNECT_MIN_MS
  let wsReconnectTimer: ReturnType<typeof setTimeout> | undefined

  function setupWebSocket() {
    // 幂等防重入：已有连接在建 / 打开时不再叠一份（重连定时器与手动调用竞争）
    if (wsInstance && (wsInstance.readyState === WebSocket.OPEN || wsInstance.readyState === WebSocket.CONNECTING)) {
      return
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}`
    const ws = new WebSocket(wsUrl)
    wsInstance = ws

    ws.onopen = () => {
      wsConnected.value = true
      // 连接恢复：退避立即重置
      wsReconnectDelay = WS_RECONNECT_MIN_MS
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
      // 收到任何合法广播即证明链路健康，重置退避
      wsReconnectDelay = WS_RECONNECT_MIN_MS
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
      wsInstance = undefined
      // P2-11：指数退避重连（3s → 6s → 12s → 24s → 30s 封顶），
      // 收到消息 / 探测恢复时重置（见 onopen / onmessage）
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = undefined
        setupWebSocket()
      }, wsReconnectDelay)
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX_MS)
    }

    ws.onerror = () => {
      ws.close()
    }
  }

  /** P2-11：看板卸载时清理 —— 取消挂起重连定时器并关闭连接（App.vue onBeforeUnmount 调用） */
  function disposeWebSocket() {
    if (wsReconnectTimer !== undefined) {
      clearTimeout(wsReconnectTimer)
      wsReconnectTimer = undefined
    }
    wsReconnectDelay = WS_RECONNECT_MIN_MS
    const ws = wsInstance
    wsInstance = undefined
    if (ws !== undefined) {
      ws.onclose = null
      ws.onerror = null
      ws.onmessage = null
      ws.close()
    }
    wsConnected.value = false
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
    currentWorkspaceName,
    scopeQuery,
    scopeLabel,
    scopedNodes,
    isSearching,
    searchHitIds,
    actionError,
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
    updateNode,
    createNode,
    renameProject,
    setNodeStatus,
    isActiveHit,
    setupWebSocket,
    disposeWebSocket,
    openDetail,
    closeDetail,
  }
})
