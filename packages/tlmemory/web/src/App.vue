<!-- packages/tlmemory/web/src/App.vue -->
<script setup lang="ts">
import { onMounted } from 'vue'
import { useMemoryStore } from './stores/memory'
import MemoryTree from './components/MemoryTree.vue'

const store = useMemoryStore()

onMounted(() => {
  store.fetchNodes()
  store.setupWebSocket()
})
</script>

<template>
  <div class="h-screen w-full flex flex-col bg-slate-900 text-slate-100 text-xs font-sans select-none">
    <header class="flex border-b border-slate-800 bg-slate-950 p-2 gap-2 items-center">
      <div class="font-bold text-sky-400 px-1 tracking-wider">TL·MEMORY</div>
      <div class="flex-1 flex gap-1 justify-end">
        <button
          @click="store.currentTree = 'project'"
          :class="[
            'px-2 py-1 rounded transition-colors',
            store.currentTree === 'project' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
          ]"
        >
          当前工程
        </button>
        <button
          @click="store.currentTree = 'global'"
          :class="[
            'px-2 py-1 rounded transition-colors',
            store.currentTree === 'global' ? 'bg-sky-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
          ]"
        >
          全局偏好
        </button>
      </div>
    </header>

    <div class="p-2 border-b border-slate-800">
      <input
        v-model="store.searchQuery"
        @input="store.performSearch(store.searchQuery)"
        type="text"
        placeholder="FTS5 全文搜索记忆..."
        class="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500"
      />
    </div>

    <main class="flex-1 overflow-y-auto p-2">
      <div v-if="store.searchQuery.trim().length > 0">
        <div class="text-slate-500 mb-2 font-mono">全文检索匹配结果 ({{ store.searchResults.length }})</div>
        <div
          v-for="item in store.searchResults"
          :key="item.id"
          class="p-2 rounded mb-1 bg-slate-800/60 border border-slate-700/50"
        >
          <div class="flex justify-between items-center text-slate-400 font-mono text-[10px]">
            <span>{{ item.path }}{{ item.name }}</span>
            <span class="text-sky-400 font-bold">score: {{ item.score?.toFixed(1) }}</span>
          </div>
          <div class="mt-1 text-slate-200">{{ item.content }}</div>
        </div>
      </div>
      <div v-else>
        <MemoryTree />
      </div>
    </main>

    <footer class="border-t border-slate-800 bg-slate-950 px-3 py-1 flex justify-between text-[10px] text-slate-500">
      <span>已载入节点: {{ store.nodes.length }}</span>
      <span
        class="flex items-center gap-1"
        :class="store.wsConnected ? 'text-emerald-500' : 'text-rose-500'"
      >
        ● {{ store.wsConnected ? '实时链路正常' : '实时链路断开' }}
      </span>
    </footer>
  </div>
</template>
