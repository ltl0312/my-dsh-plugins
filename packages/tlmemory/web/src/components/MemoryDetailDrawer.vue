<!-- packages/tlmemory/web/src/components/MemoryDetailDrawer.vue
     记忆详情抽屉（Slide-over Drawer）：从右侧滑出，完整渲染该条记忆的 Markdown。
     顶部是路径面包屑 + 一键关闭，底部是「复制 Markdown 原文」。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { MemoryNodeDto } from '../stores/memory'
import { renderMarkdown } from '../lib/markdown'

const props = defineProps<{ node: MemoryNodeDto | null }>()
const emit = defineEmits<{ (event: 'close'): void }>()

const closeButton = ref<HTMLButtonElement | null>(null)
const body = ref<HTMLElement | null>(null)
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

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

/** Esc 关闭：绑在 document 上，焦点在正文任意位置都能触发 */
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.stopPropagation()
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

          <button ref="closeButton" type="button" class="tlm-close" title="关闭（Esc）" aria-label="关闭详情" @click="close">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <!-- Markdown 全文（已收口渲染，见 lib/markdown.ts） -->
        <div ref="body" class="tlm-drawer-body">
          <article v-if="rendered" class="tlm-md" v-html="rendered" />
          <p v-else class="tlm-empty">该记忆暂无正文内容。</p>
        </div>

        <footer class="tlm-drawer-foot">
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
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>
