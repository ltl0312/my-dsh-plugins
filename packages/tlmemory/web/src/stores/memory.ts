// packages/tlmemory/web/src/stores/memory.ts
// 响应式状态流：节点树拉取、FTS5 全文检索、级联剪枝删除与 WebSocket 实时双向监听。
import { defineStore } from 'pinia'
import { ref } from 'vue'

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

export const useMemoryStore = defineStore('memory', () => {
  const currentTree = ref<'global' | 'project'>('project')
  const nodes = ref<MemoryNodeDto[]>([])
  const activeHitIds = ref<Set<string>>(new Set())
  const searchQuery = ref('')
  const searchResults = ref<MemoryNodeDto[]>([])
  const wsConnected = ref(false)

  async function fetchNodes() {
    try {
      const res = await fetch(`/api/nodes`)
      const json = await res.json()
      nodes.value = json.data || []
    } catch (e) {
      console.error('拉取节点数据失败:', e)
    }
  }

  async function deleteNode(id: string) {
    await fetch(`/api/nodes/${id}`, { method: 'DELETE' })
    await fetchNodes()
  }

  async function performSearch(query: string) {
    if (!query.trim()) {
      searchResults.value = []
      return
    }
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
    const json = await res.json()
    searchResults.value = json.data || []
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
        fetchNodes()
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
    nodes,
    activeHitIds,
    searchQuery,
    searchResults,
    wsConnected,
    fetchNodes,
    deleteNode,
    performSearch,
    setupWebSocket,
  }
})