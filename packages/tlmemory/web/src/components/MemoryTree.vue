<!-- packages/tlmemory/web/src/components/MemoryTree.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMemoryStore, type MemoryNodeDto } from '../stores/memory'

const store = useMemoryStore()
const collapsedPaths = ref<Set<string>>(new Set())

function toggleCollapse(path: string) {
  if (collapsedPaths.value.has(path)) {
    collapsedPaths.value.delete(path)
  } else {
    collapsedPaths.value.add(path)
  }
}

const filteredNodes = computed(() => {
  return store.nodes.filter((n) => {
    if (store.currentTree === 'global') {
      return n.tree_type === 'global'
    } else {
      return n.tree_type !== 'global'
    }
  })
})

const groupedNodes = computed(() => {
  const map: Record<string, MemoryNodeDto[]> = {}
  for (const n of filteredNodes.value) {
    const p = n.path || '/'
    if (!map[p]) map[p] = []
    map[p].push(n)
  }
  return map
})
</script>

<template>
  <div class="flex flex-col gap-2 font-mono">
    <div v-if="Object.keys(groupedNodes).length === 0" class="text-center text-slate-600 py-8">
      当前记忆树暂无叶子沉淀
    </div>
    <div
      v-for="(items, path) in groupedNodes"
      :key="path"
      class="border border-slate-800/80 rounded bg-slate-950/40 overflow-hidden"
    >
      <div
        @click="toggleCollapse(path)"
        class="bg-slate-800/40 px-2 py-1 flex items-center justify-between cursor-pointer hover:bg-slate-800/70"
      >
        <div class="flex items-center gap-1 text-slate-300 font-semibold">
          <span>{{ collapsedPaths.has(path) ? '▶' : '▼' }}</span>
          <span>📁 {{ path }}</span>
        </div>
        <span class="text-[10px] text-slate-500 bg-slate-800 px-1 rounded">{{ items.length }}</span>
      </div>

      <div v-if="!collapsedPaths.has(path)" class="p-1 flex flex-col gap-1">
        <div
          v-for="leaf in items"
          :key="leaf.id"
          :class="[
            'p-2 rounded border transition-all duration-300',
            store.activeHitIds.has(leaf.id)
              ? 'bg-sky-950/80 border-sky-400 shadow-sm shadow-sky-500/50'
              : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
          ]"
        >
          <div class="flex justify-between items-center mb-1">
            <span class="font-bold text-sky-300 flex items-center gap-1">
              <span v-if="leaf.is_pinned" class="text-amber-400">📌</span>
              {{ leaf.name }}
            </span>
            <div class="flex gap-1 items-center">
              <span class="text-[10px] text-slate-500">×{{ leaf.reinforce_count }}</span>
              <button
                @click="store.deleteNode(leaf.id)"
                class="text-rose-400 hover:text-rose-300 px-1 rounded"
              >
                ×
              </button>
            </div>
          </div>
          <div class="text-slate-300 font-sans leading-relaxed text-[11px]">
            {{ leaf.content }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
