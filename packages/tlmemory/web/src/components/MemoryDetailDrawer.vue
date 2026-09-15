<!-- packages/tlmemory/web/src/components/MemoryDetailDrawer.vue
     记忆详情抽屉（Slide-over Drawer）：从右侧滑出，完整渲染该条记忆的 Markdown。
     顶部是路径面包屑 + 「编辑」+ 一键关闭；底部是「复制 Markdown 原文」，
     编辑态下切换为「取消 / 保存」。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { MemoryNodeDto } from '../stores/memory'
import { useMemoryStore } from '../stores/memory'
import { renderMarkdown } from '../lib/markdown'

const props = defineProps<{ node: MemoryNodeDto | null }>()
const emit = defineEmits<{ (event: 'close'): void }>()

const store = useMemoryStore()

const closeButton = ref<HTMLButtonElement | null>(null)
const body = ref<HTMLElement | null>(null)
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

/** 在线编辑态：标题输入 / 正文 Textarea / 提交中标记 / 错误提示 */
const editing = ref(false)
const editTitle = ref('')
const editContent = ref('')
const saving = ref(false)
const saveError = ref('')
const titleField = ref<HTMLInputElement | null>(null)
const contentField = ref<HTMLTextAreaElement | null>(null)

/** 抽屉是否打开 */
const open = computed(() => props.node !== null)

/** Markdown 正文（收口渲染：原始 HTML 转义、危险链接降级、图片不外链） */
const rendered = computed(() => renderMarkdown(props.node?.content))

/**
 * 面包屑：目录前缀（原样保留，含首尾斜杠）+ 节点名。
 * 拆成两段而不是按 '/' 切分后重新拼——切分再拼会把首部斜杠吃掉，渲染出的路径
 * 与后端记录的 path 字面不一致；这里两段相邻内联，视觉上就是完整的一条路径。
 */
const breadcrumb = computed(() => {
  const node = props.node
  if (node === null) return { dir: '', name: '' }
  const dir = node.path ?? ''
  const lastSegment = dir.replace(/\/+$/, '').split('/').pop()
  // path 末段已与节点名相同时不再重复显示，避免「透明透传透明透传」
  return { dir, name: lastSegment === node.name ? '' : node.name }
})

/** 关键词标签（后端以逗号 / 换行分隔存储） */
const keywords = computed(() =>
  (props.node?.keywords ?? '')
    .split(/[,，\n]/)
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword !== ''),
)

/** 元数据行：断言强化次数与是否置顶 */
const metaText = computed(() => {
  const node = props.node
  if (node === null) return ''
  return `断言强化 ×${node.reinforce_count}${node.is_pinned ? ' · 已置顶' : ''}`
})

function close() {
  emit('close')
}

/** 进入编辑模式：以当前节点内容填充表单，聚焦标题输入框 */
async function startEdit() {
  if (props.node === null) return
  editTitle.value = props.node.name
  editContent.value = props.node.content ?? ''
  saveError.value = ''
  editing.value = true
  await nextTick()
  autosizeContent()
  titleField.value?.focus()
}

/** 取消编辑：丢弃未保存改动，切回 Markdown 阅读态 */
function cancelEdit() {
  editing.value = false
  saveError.value = ''
}

/** Textarea 自适应高度：按 scrollHeight 伸展，封顶 480px 后交给抽屉滚动 */
function autosizeContent() {
  const el = contentField.value
  if (el === null) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 480)}px`
}

/** 保存编辑：调用 PUT /api/nodes/:id，成功后无缝切回渲染视图 */
async function saveEdit() {
  if (props.node === null || saving.value) return
  if (editTitle.value.trim() === '') {
    saveError.value = '标题不能为空'
    return
  }
  saving.value = true
  saveError.value = ''
  const updated = await store.updateNode(props.node.id, {
    title: editTitle.value.trim(),
    content: editContent.value,
  })
  saving.value = false
  if (updated !== null) {
    editing.value = false
  } else {
    saveError.value = '保存失败，请稍后重试'
  }
}

/** 复制 Markdown 原文；Clipboard API 不可用时退回 execCommand */
async function copyMarkdown() {
  const text = props.node?.content ?? ''
  let done = false
  try {
    await navigator.clipboard.writeText(text)
    done = true
  } catch {
    done = legacyCopy(text)
  }
  copied.value = done
  if (copiedTimer !== undefined) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copied.value = false
  }, 1800)
}

/** 旧内核 / 无剪贴板权限时的兜底复制 */
function legacyCopy(text: string): boolean {
  try {
    const helper = document.createElement('textarea')
    helper.value = text
    helper.setAttribute('readonly', '')
    helper.style.position = 'fixed'
    helper.style.opacity = '0'
    document.body.append(helper)
    helper.select()
    const ok = document.execCommand('copy')
    helper.remove()
    return ok
  } catch {
    return false
  }
}

/** M1 待确认区审核：提交中标记 + 确认/拒绝动作（拒绝 = 删除该记忆） */
const reviewing = ref(false)

async function review(status: 'confirmed' | 'pending') {
  if (props.node === null || reviewing.value) return
  reviewing.value = true
  const ok = await store.setNodeStatus(props.node.id, status)
  reviewing.value = false
  if (ok && status === 'confirmed') close()
}

async function rejectPending() {
  if (props.node === null || reviewing.value) return
  reviewing.value = true
  const ok = await store.deleteNode(props.node.id)
  reviewing.value = false
  if (ok) close()
}

/** Esc 关闭：编辑态先取消编辑，阅读态直接收起抽屉（焦点在正文任意位置都能触发） */
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.stopPropagation()
    if (editing.value) {
      cancelEdit()
      return
    }
    close()
  }
}

document.addEventListener('keydown', onKeydown)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (copiedTimer !== undefined) clearTimeout(copiedTimer)
})

/** 打开时把焦点移进抽屉（无障碍：键盘用户立刻可 Esc 退出） */
watch(open, async (isOpen) => {
  copied.value = false
  if (!isOpen) return
  await nextTick()
  closeButton.value?.focus()
  if (body.value !== null) body.value.scrollTop = 0
})

/** 切换到另一条记忆时退出编辑态，避免上一条的表单内容串台 */
watch(
  () => props.node?.id,
  () => {
    editing.value = false
    saveError.value = ''
  },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="tlm-scrim">
      <div v-if="open" class="tlm-scrim" @click="close" />
    </Transition>
    <Transition name="tlm-drawer">
      <aside
        v-if="open && node"
        class="tlm-drawer"
        role="dialog"
        aria-modal="true"
        :aria-label="`记忆详情：${node.name}`"
      >
        <header class="tlm-drawer-head">
          <div style="flex: 1; min-width: 0">
            <!-- 原路径面包屑：目录前缀 + 节点名（两段相邻内联，读作一条完整路径） -->
            <div class="tlm-crumbs" :title="`${node.path}${node.name}`">
              <span data-dsh-tlmemory-crumb="dir">{{ breadcrumb.dir }}</span><span
                class="tlm-crumb-current"
                data-dsh-tlmemory-crumb="name"
              >{{ breadcrumb.name }}</span>
            </div>
            <div class="tlm-tagrow">
              <span class="tlm-tag">{{ metaText }}</span>
              <span v-if="node.is_leaf" class="tlm-tag">叶子沉淀</span>
              <span v-else class="tlm-tag">分支节点</span>
              <span v-for="keyword in keywords" :key="keyword" class="tlm-tag">{{ keyword }}</span>
            </div>
          </div>

          <!-- 编辑按钮：仅阅读态展示，点击进入在线编辑 -->
          <button
            v-if="!editing"
            type="button"
            class="tlm-edit-btn"
            title="编辑这条记忆"
            aria-label="编辑记忆"
            @click="startEdit"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M11.3 2.3a1.6 1.6 0 0 1 2.3 2.3L5.6 12.6l-3.1 0.8 0.8-3.1z" />
            </svg>
            编辑
          </button>

          <button ref="closeButton" type="button" class="tlm-close" title="关闭（Esc）" aria-label="关闭详情" @click="close">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <!-- 阅读态：Markdown 全文（已收口渲染，见 lib/markdown.ts）；
             编辑态：标题输入 + 自适应 Markdown Textarea -->
        <div ref="body" class="tlm-drawer-body">
          <!-- M1 待确认区审核横幅：pending 条目不参与召回，用户在此裁定去留 -->
          <div v-if="!editing && node.status === 'pending'" class="tlm-pending-banner" role="status">
            <span>该条记忆由自动沉淀产生、尚未通过审核，当前不参与召回。</span>
            <span class="tlm-pending-actions">
              <button
                type="button"
                class="tlm-btn is-primary"
                :disabled="reviewing"
                @click="review('confirmed')"
              >
                {{ reviewing ? '处理中…' : '确认收录' }}
              </button>
              <button type="button" class="tlm-btn" :disabled="reviewing" @click="rejectPending">
                拒绝
              </button>
            </span>
          </div>
          <template v-if="editing">
            <div class="tlm-edit-form">
              <label class="tlm-field">
                <span class="tlm-field-label">标题</span>
                <input
                  ref="titleField"
                  v-model="editTitle"
                  class="tlm-input"
                  type="text"
                  maxlength="120"
                  placeholder="记忆标题"
                  @keydown.enter.prevent="saveEdit"
                />
              </label>
              <label class="tlm-field">
                <span class="tlm-field-label">正文（Markdown）</span>
                <textarea
                  ref="contentField"
                  v-model="editContent"
                  class="tlm-textarea"
                  placeholder="支持 Markdown 语法…"
                  @input="autosizeContent"
                />
              </label>
              <p v-if="saveError" class="tlm-form-error" role="alert">{{ saveError }}</p>
            </div>
          </template>
          <template v-else>
            <article v-if="rendered" class="tlm-md" v-html="rendered" />
            <p v-else class="tlm-empty">该记忆暂无正文内容。</p>
          </template>
        </div>

        <footer class="tlm-drawer-foot">
          <template v-if="editing">
            <span class="tlm-foot-hint">编辑中 · 未保存的改动在取消后丢弃</span>
            <button type="button" class="tlm-btn" :disabled="saving" @click="cancelEdit">取消</button>
            <button type="button" class="tlm-btn is-primary" :disabled="saving" @click="saveEdit">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </template>
          <template v-else>
            <span class="tlm-foot-hint">Markdown 原文 · {{ (node.content ?? '').length }} 字符</span>
            <button type="button" class="tlm-btn" :class="{ 'is-done': copied }" @click="copyMarkdown">
              <svg v-if="copied" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
              </svg>
              <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
                <path d="M10.5 3.5H4a1.5 1.5 0 0 0-1.5 1.5v6.5" />
              </svg>
              {{ copied ? '已复制' : '复制 Markdown' }}
            </button>
          </template>
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>
