<!-- packages/tlmemory/web/src/App.vue
     记忆看板主视图。所有配色走 style.css 的 --tlm-* 令牌层（由 <html data-theme>
     驱动），组件内不写死任何颜色，因此宿主切浅色 / 深色时整块看板同步响应。

     顶部工具栏三组控件，职责严格分开：
       1. 工程下拉框 —— 列出数据库中所有存在记忆的工程，切换即换整棵树；
       2. [全局偏好] 独立胶囊 —— 与工程记忆明确区隔，再点一次回到工程记忆；
       3. 视图模式滑块 —— 📋 目录列表 / 🌲 树状图谱，两视图用 v-show 切换，
          因而选中工程、搜索关键词、图谱的平移缩放状态都原样保留。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useMemoryStore } from './stores/memory'
import MemoryTree from './components/MemoryTree.vue'
import MemoryGraphTree from './components/MemoryGraphTree.vue'
import MemoryDetailDrawer from './components/MemoryDetailDrawer.vue'
import { setupThemeBridge } from './theme'

const store = useMemoryStore()

/** 主题桥的卸载函数（组件销毁时摘掉 postMessage 监听） */
let disposeThemeBridge: (() => void) | undefined

/** 是否处于全文检索态：列表模式下用它决定展示检索结果还是完整目录 */
const searching = computed(() => store.isSearching)

onMounted(() => {
  // 先接主题再取数据：避免首屏用错配色。
  disposeThemeBridge = setupThemeBridge()
  void store.bootstrap()
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
        <span class="tlm-brand-count">{{ store.scopedNodes.length }} 条</span>
      </span>
      <span class="tlm-spacer" />

      <!-- 工程选择器：选项来自 GET /api/projects（数据库中所有存在记忆记录的工程） -->
      <div class="tlm-pickwrap" :class="{ 'is-idle': store.currentTree === 'global' }">
        <svg
          class="tlm-pick-icon"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M1.8 13.2V3.4a.9.9 0 0 1 .9-.9h3.1l1.4 1.7h5.1a.9.9 0 0 1 .9.9v8.1a.9.9 0 0 1-.9.9H2.7a.9.9 0 0 1-.9-.9Z" />
        </svg>
        <select
          class="tlm-select"
          :value="store.currentProjectScope"
          aria-label="选择工程记忆"
          title="切换工程记忆树"
          @click="store.activateProject()"
          @change="store.selectProject(($event.target as HTMLSelectElement).value)"
        >
          <option v-if="store.projects.length === 0" value="">暂无工程记忆</option>
          <option v-for="project in store.projects" :key="project.scope" :value="project.scope">
            {{ project.name }}（{{ project.leafCount }}）
          </option>
        </select>
      </div>

      <!-- 全局偏好：独立胶囊，与工程记忆明确区分 -->
      <button
        type="button"
        class="tlm-pill"
        :aria-pressed="store.currentTree === 'global'"
        title="查看跨工程通用的全局偏好"
        @click="store.toggleGlobal()"
      >
        全局偏好
      </button>

      <!-- 视图模式滑块：列表 / 图谱 -->
      <div class="tlm-segment" role="group" aria-label="视图模式">
        <button
          type="button"
          class="tlm-segment-btn"
          :aria-pressed="store.viewMode === 'list'"
          @click="store.setViewMode('list')"
        >
          📋 目录列表
        </button>
        <button
          type="button"
          class="tlm-segment-btn"
          :aria-pressed="store.viewMode === 'graph'"
          @click="store.setViewMode('graph')"
        >
          🌲 树状图谱
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
      <!-- 目录列表模式：检索态展示命中列表，否则展示完整折叠目录 -->
      <div v-show="store.viewMode === 'list'" class="tlm-main-inner">
        <template v-if="searching">
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

      <!-- 树状图谱模式：检索时在画布内做命中高亮与未命中淡化 -->
      <MemoryGraphTree
        v-show="store.viewMode === 'graph'"
        :active="store.viewMode === 'graph'"
      />
    </main>

    <footer class="tlm-footer">
      <span>已载入节点 {{ store.scopedNodes.length }}</span>
      <span class="tlm-conn" :class="{ 'is-online': store.wsConnected }">
        <span class="tlm-conn-dot" aria-hidden="true" />
        {{ store.wsConnected ? '实时链路正常' : '实时链路断开' }}
      </span>
    </footer>

    <!-- 详情抽屉：完整渲染所选记忆的 Markdown 全文 -->
    <MemoryDetailDrawer :node="store.selectedNode" @close="store.closeDetail()" />
  </div>
</template>
