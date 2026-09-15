<!-- packages/tlmemory/web/src/App.vue
     记忆看板主视图。所有配色走 style.css 的 --tlm-* 令牌层（由 <html data-theme>
     驱动），组件内不写死任何颜色，因此宿主切浅色 / 深色时整块看板同步响应。 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { useMemoryStore } from './stores/memory'
import MemoryTree from './components/MemoryTree.vue'
import MemoryDetailDrawer from './components/MemoryDetailDrawer.vue'
import { setupThemeBridge } from './theme'

const store = useMemoryStore()

/** 主题桥的卸载函数（组件销毁时摘掉 postMessage 监听） */
let disposeThemeBridge: (() => void) | undefined

onMounted(() => {
  // 先接主题再取数据：避免首屏用错配色。
  disposeThemeBridge = setupThemeBridge()
  store.fetchNodes()
  store.setupWebSocket()
})

onBeforeUnmount(() => {
  disposeThemeBridge?.()
})
</script>

<template>
  <div class="tlm-app">
    <header class="tlm-header">
      <span class="tlm-brand">
        TL·MEMORY
        <span class="tlm-brand-count">{{ store.nodes.length }} 条</span>
      </span>
      <span class="tlm-spacer" />
      <div class="tlm-segment">
        <button
          type="button"
          class="tlm-segment-btn"
          :aria-pressed="store.currentTree === 'project'"
          @click="store.currentTree = 'project'"
        >
          当前工程
        </button>
        <button
          type="button"
          class="tlm-segment-btn"
          :aria-pressed="store.currentTree === 'global'"
          @click="store.currentTree = 'global'"
        >
          全局偏好
        </button>
      </div>
    </header>

    <div class="tlm-searchbar">
      <input
        v-model="store.searchQuery"
        class="tlm-search"
        type="text"
        placeholder="FTS5 全文搜索记忆…"
        aria-label="全文搜索记忆"
        @input="store.performSearch(store.searchQuery)"
      />
    </div>

    <main class="tlm-main">
      <div class="tlm-main-inner">
        <template v-if="store.searchQuery.trim().length > 0">
          <div class="tlm-section-label">
            <span>全文检索匹配结果</span>
            <span class="tlm-chip">{{ store.searchResults.length }}</span>
          </div>
          <div v-if="store.searchResults.length === 0" class="tlm-empty">没有命中的记忆</div>
          <!-- 检索结果同样点击进入详情抽屉 -->
          <div
            v-for="item in store.searchResults"
            :key="item.id"
            class="tlm-hit-item"
            role="button"
            tabindex="0"
            @click="store.openDetail(item)"
            @keydown.enter.prevent="store.openDetail(item)"
            @keydown.space.prevent="store.openDetail(item)"
          >
            <div class="tlm-hit-meta">
              <span>{{ item.path }}{{ item.name }}</span>
              <span v-if="item.score !== undefined" class="tlm-hit-score">score {{ item.score.toFixed(1) }}</span>
            </div>
            <p class="tlm-clamp-2">{{ item.content }}</p>
          </div>
        </template>

        <MemoryTree v-else />
      </div>
    </main>

    <footer class="tlm-footer">
      <span>已载入节点 {{ store.nodes.length }}</span>
      <span class="tlm-conn" :class="{ 'is-online': store.wsConnected }">
        <span class="tlm-conn-dot" aria-hidden="true" />
        {{ store.wsConnected ? '实时链路正常' : '实时链路断开' }}
      </span>
    </footer>

    <!-- 详情抽屉：完整渲染所选记忆的 Markdown 全文 -->
    <MemoryDetailDrawer :node="store.selectedNode" @close="store.closeDetail()" />
  </div>
</template>
