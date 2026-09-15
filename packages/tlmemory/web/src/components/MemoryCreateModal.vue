<!-- packages/tlmemory/web/src/components/MemoryCreateModal.vue
     「+ 新建记忆」轻量级表单弹窗：归属工程（默认当前工程，可勾选设为全局偏好）、
     路径目录（datalist 快捷选择现有目录）、记忆标题与 Markdown 正文。
     提交调用 POST /api/nodes，成功后自动定位至新节点（打开详情抽屉）。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useMemoryStore } from '../stores/memory'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (event: 'close'): void }>()

const store = useMemoryStore()

const asGlobal = ref(false)
const dirInput = ref('/')
const titleInput = ref('')
const contentInput = ref('')
const error = ref('')
const submitting = ref(false)
const titleField = ref<HTMLInputElement | null>(null)

/** 归属工程展示名（全局勾选后仅作提示，不再参与提交） */
const targetProjectName = computed<string>(
  () => store.currentProject?.name ?? store.scopeLabel ?? '当前工程',
)

/** 现有目录快捷选择：从当前作用域节点推导全部去重目录前缀，排序后供 datalist */
const dirOptions = computed<string[]>(() => {
  const set = new Set<string>()
  for (const node of store.scopedNodes) {
    if (node.path) set.add(node.path)
  }
  return Array.from(set).sort()
})

/** 弹窗打开时重置表单并聚焦标题输入框 */
watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    asGlobal.value = store.currentTree === 'global'
    dirInput.value = '/'
    titleInput.value = ''
    contentInput.value = ''
    error.value = ''
    await nextTick()
    titleField.value?.focus()
  },
)

/** Esc / 背板点击关闭：提交中不响应 */
function requestClose() {
  if (submitting.value) return
  emit('close')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.open) {
    event.stopPropagation()
    requestClose()
  }
}

document.addEventListener('keydown', onKeydown)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
})

async function submit() {
  if (submitting.value) return
  if (titleInput.value.trim() === '') {
    error.value = '请填写记忆标题'
    return
  }
  if (contentInput.value.trim() === '') {
    error.value = '请填写 Markdown 正文'
    return
  }
  submitting.value = true
  error.value = ''
  const created = await store.createNode({
    scope: asGlobal.value ? 'global' : 'project',
    project: store.currentProjectScope || undefined,
    path: dirInput.value,
    title: titleInput.value.trim(),
    content: contentInput.value,
  })
  submitting.value = false
  if (created === null) {
    error.value = '创建失败，请稍后重试'
    return
  }
  // 创建成功：自动定位至新节点（打开详情抽屉），树图与列表已由 store 刷新
  store.openDetail(created)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="tlm-fade">
      <div v-if="open" class="tlm-modal-scrim" @click="requestClose" />
    </Transition>
    <Transition name="tlm-pop">
      <div v-if="open" class="tlm-modal-card" role="dialog" aria-modal="true" aria-label="新建记忆">
        <header class="tlm-modal-head">
          <span class="tlm-modal-title">新建记忆</span>
          <button type="button" class="tlm-close" title="关闭（Esc）" aria-label="关闭弹窗" @click="requestClose">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <form class="tlm-modal-body" @submit.prevent="submit">
          <div class="tlm-field-row">
            <label class="tlm-field" style="flex: 1; min-width: 0">
              <span class="tlm-field-label">归属工程</span>
              <input class="tlm-input" type="text" :value="targetProjectName" disabled />
            </label>
            <label class="tlm-checkbox-row" title="跨工程通用的偏好与规约存入全局树">
              <input v-model="asGlobal" type="checkbox" />
              <span>设为全局偏好</span>
            </label>
          </div>

          <label class="tlm-field">
            <span class="tlm-field-label">路径目录（以 / 分隔，可从下拉快捷选择）</span>
            <input v-model="dirInput" class="tlm-input" type="text" list="tlm-dir-options" placeholder="/分类一级/分类二级/" />
            <datalist id="tlm-dir-options">
              <option v-for="dir in dirOptions" :key="dir" :value="dir" />
            </datalist>
          </label>

          <label class="tlm-field">
            <span class="tlm-field-label">记忆标题</span>
            <input
              ref="titleField"
              v-model="titleInput"
              class="tlm-input"
              type="text"
              maxlength="120"
              placeholder="如：客户端深浅主题切换规程"
            />
          </label>

          <label class="tlm-field">
            <span class="tlm-field-label">Markdown 正文</span>
            <textarea
              v-model="contentInput"
              class="tlm-textarea"
              style="min-height: 140px"
              placeholder="支持 Markdown 语法…"
            />
          </label>

          <p v-if="error" class="tlm-form-error" role="alert">{{ error }}</p>
        </form>

        <footer class="tlm-modal-foot">
          <button type="button" class="tlm-btn" :disabled="submitting" @click="requestClose">取消</button>
          <button type="button" class="tlm-btn is-primary" :disabled="submitting" @click="submit">
            {{ submitting ? '创建中…' : '创建记忆' }}
          </button>
        </footer>
      </div>
    </Transition>
  </Teleport>
</template>
