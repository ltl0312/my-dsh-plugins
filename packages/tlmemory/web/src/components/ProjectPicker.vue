<!-- packages/tlmemory/web/src/components/ProjectPicker.vue
     工程选择器：真正的下拉选择框（按钮 + 弹出清单）。
     * 按钮常显当前工程名称与记忆数（如 my-dsh-plugins (4)）；
     * 下拉列出所有可用工程（含各自的记忆数），点击即切换整棵树；
     * 加载中 / 真空态有明确占位 —— 只有「工程清单与节点数据都为空」才显示
       暂无工程记忆，绝不误报（/api/projects 失败时由 store 用节点数据反推兜底）。
     配色全部走 style.css 的 --tlm-* 令牌层，跨源 iframe 内随宿主主题自适应。 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useMemoryStore } from '../stores/memory'

const store = useMemoryStore()

const rootEl = ref<HTMLElement | null>(null)
const open = ref(false)

function toggle(): void {
  if (store.projectsLoading || store.projectOptions.length === 0) return
  open.value = !open.value
}

function choose(scope: string): void {
  open.value = false
  if (scope === store.currentProjectScope && store.currentTree === 'project') return
  void store.selectProject(scope)
}

/** 点击面板外任意处收起清单 */
function onDocPointerDown(event: MouseEvent): void {
  if (!open.value) return
  if (rootEl.value !== null && event.target instanceof Node && rootEl.value.contains(event.target)) {
    return
  }
  open.value = false
}

/** Esc 收起清单（焦点可以停在按钮上，因此绑在 document 上） */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onDocPointerDown)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocPointerDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="rootEl" class="tlm-pick" :class="{ 'is-idle': store.currentTree === 'global' }">
    <button
      type="button"
      class="tlm-pick-btn"
      :disabled="store.projectsLoading || store.projectOptions.length === 0"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :title="open ? '收起工程清单' : '切换工程记忆树'"
      @click="toggle"
    >
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
        <path
          d="M1.8 13.2V3.4a.9.9 0 0 1 .9-.9h3.1l1.4 1.7h5.1a.9.9 0 0 1 .9.9v8.1a.9.9 0 0 1-.9.9H2.7a.9.9 0 0 1-.9-.9Z"
        />
      </svg>
      <span class="tlm-pick-label">
        {{
          store.projectsLoading
            ? '工程加载中…'
            : store.projectOptions.length === 0
              ? '暂无工程记忆'
              : (store.currentProject?.name ?? store.scopeLabel)
        }}
      </span>
      <span v-if="!store.projectsLoading && store.currentProject !== null" class="tlm-pick-count">
        ({{ store.currentProject.leafCount }})
      </span>
      <svg
        class="tlm-pick-chevron"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M4 6.2 8 10.2l4-4" />
      </svg>
    </button>

    <Transition name="tlm-pop">
      <div v-if="open" class="tlm-pick-menu" role="listbox" aria-label="工程记忆清单">
        <button
          v-for="project in store.projectOptions"
          :key="project.scope"
          type="button"
          class="tlm-pick-item"
          :class="{ 'is-current': project.scope === store.currentProjectScope }"
          role="option"
          :aria-selected="project.scope === store.currentProjectScope && store.currentTree === 'project'"
          :title="`${project.name} · ${project.leafCount} 条记忆`"
          @click="choose(project.scope)"
        >
          <svg
            v-if="project.scope === store.currentProjectScope && store.currentTree === 'project'"
            class="tlm-pick-item-check"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
          </svg>
          <span class="tlm-pick-item-name">{{ project.name }}</span>
          <span class="tlm-pick-item-count">({{ project.leafCount }})</span>
        </button>
      </div>
    </Transition>
  </div>
</template>
