<!-- packages/tlmemory/web/src/components/MemoryTree.vue
     记忆树：按 path 分组的折叠列表。
     列表项只呈现「简介」——名字 + 元数据（置顶 / 断言数）+ 首段摘要（两行省略），
     点击任意一条由 App 打开右侧详情抽屉阅读完整 Markdown。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMemoryStore, type MemoryNodeDto } from '../stores/memory'
import { extractSummary } from '../lib/markdown'

const store = useMemoryStore()

/** 已折叠的分组 path（默认全部展开） */
const collapsedPaths = ref<Set<string>>(new Set())

function toggleCollapse(path: string) {
  // 注意：必须原地增删让 Vue 的集合响应式生效（重新赋值会丢掉与计算属性的关联）。
  if (collapsedPaths.value.has(path)) {
    collapsedPaths.value.delete(path)
  } else {
    collapsedPaths.value.add(path)
  }
}

/** 当前记忆树范围内的节点 */
const filteredNodes = computed(() =>
  store.nodes.filter((n) => (store.currentTree === 'global' ? n.tree_type === 'global' : n.tree_type !== 'global')),
)

/**
 * 预览条目：提前算好简介，避免模板里逐项重复解析 Markdown。
 * 简介为空（正文只有代码块或纯空白）时给一个弱化占位，列表项高度保持一致。
 */
const previews = computed(() =>
  filteredNodes.value.map((node) => ({
    node,
    summary: extractSummary(node.content),
  })),
)

/** 按 path 分组，并把折叠态一并算进结果，让模板的依赖关系保持单一来源 */
const groups = computed(() => {
  const map = new Map<string, Array<{ node: MemoryNodeDto; summary: string }>>()
  for (const preview of previews.value) {
    const path = preview.node.path || '/'
    const bucket = map.get(path)
    if (bucket === undefined) map.set(path, [preview])
    else bucket.push(preview)
  }
  return Array.from(map, ([path, items]) => ({
    path,
    items,
    collapsed: collapsedPaths.value.has(path),
  }))
})

/** 删除前确认：删除是不可逆的级联剪枝，误点代价过高 */
function requestDelete(node: MemoryNodeDto) {
  const label = `${node.path}${node.name}`
  if (!window.confirm(`确认删除「${label}」？该操作会级联删除其子节点，且不可撤销。`)) return
  void store.deleteNode(node.id)
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="groups.length === 0" class="tlm-empty">当前记忆树暂无叶子沉淀</div>

    <section v-for="group in groups" :key="group.path" class="tlm-group">
      <!-- 分组头：整行可点；箭头是统一尺寸的 SVG，旋转过渡表达展开 / 收起 -->
      <button
        type="button"
        class="tlm-group-head"
        :aria-expanded="!group.collapsed"
        :aria-label="`${group.collapsed ? '展开' : '收起'}分组 ${group.path}`"
        @click="toggleCollapse(group.path)"
      >
        <svg
          class="tree-chevron"
          :class="{ expanded: !group.collapsed }"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M6 3.5 10.5 8 6 12.5" />
        </svg>
        <span class="tlm-group-path">{{ group.path }}</span>
        <span class="tlm-chip">{{ group.items.length }}</span>
      </button>

      <div v-show="!group.collapsed" class="tlm-leaves">
        <div
          v-for="item in group.items"
          :key="item.node.id"
          class="tlm-leaf"
          :class="{ 'is-hit': store.activeHitIds.has(item.node.id) }"
          role="button"
          tabindex="0"
          :title="`阅读「${item.node.name}」的完整记忆`"
          @click="store.openDetail(item.node)"
          @keydown.enter.prevent="store.openDetail(item.node)"
          @keydown.space.prevent="store.openDetail(item.node)"
        >
          <div class="tlm-leaf-head">
            <svg
              v-if="item.node.is_pinned"
              class="tlm-pin"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                d="M9.6 1.4a.75.75 0 0 1 1.06 0l3.94 3.94a.75.75 0 0 1-.53 1.28h-1.6l-2.66 2.66.44 2.2a.75.75 0 0 1-1.27.69L6.9 9.68l-2.8 2.8a.75.75 0 0 1-1.06-1.06l2.8-2.8-2.49-2.08a.75.75 0 0 1 .69-1.27l2.2.44 2.66-2.66v-1.6a.75.75 0 0 1 .22-.53Z"
              />
            </svg>
            <span class="tlm-leaf-name">{{ item.node.name }}</span>
            <span class="tlm-reinforce">×{{ item.node.reinforce_count }}</span>
            <button
              type="button"
              class="tlm-iconbtn"
              title="删除该记忆（级联删除子节点）"
              :aria-label="`删除 ${item.node.name}`"
              @click.stop="requestDelete(item.node)"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>

          <!-- 简介视图：最多两行省略打点，次级灰度字体 -->
          <p v-if="item.summary" class="tlm-clamp-2">{{ item.summary }}</p>
          <p v-else class="tlm-clamp-2 tlm-leaf-empty">（该记忆暂无正文）</p>
        </div>
      </div>
    </section>
  </div>
</template>
