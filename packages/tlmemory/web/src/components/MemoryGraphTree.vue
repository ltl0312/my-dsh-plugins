<!-- packages/tlmemory/web/src/components/MemoryGraphTree.vue
     自顶向下树状图谱（Top-down Hierarchy Graph）。

     结构：Level 0 合成根（当前工程名 / 全局偏好）→ 目录分支 → 记忆叶子（标题 + ×断言数）。
     渲染分两层叠在一起，共享同一个 transform：
       * <svg> 负责贝塞尔连线（在节点层之下）；
       * 绝对定位的卡片负责节点本体（用 HTML 卡片而不是 SVG <text>，正文省略号、
         悬停反馈、键盘焦点环都能直接复用看板既有的样式令牌）。
     交互：空白处拖拽平移、滚轮以指针为锚点缩放、右上角 −/+/居中。
     高亮：检索激活时，命中节点发光、未命中节点淡化，命中叶子到根的整条路径连线加粗。
     配色：全部走 style.css 的 --tlm-* 令牌层，组件内不写死任何颜色（跨源 iframe 主题自适应）。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMemoryStore } from '../stores/memory'
import { buildGraphLayout, type GraphLayoutNode } from '../lib/graph'

const props = defineProps<{ active?: boolean }>()
const store = useMemoryStore()

/** 画布四周留白：卡片中心坐标 → 卡片左上角坐标时的固定偏移 */
const CANVAS_PAD = 44
const MIN_SCALE = 0.25
const MAX_SCALE = 2.2
/** 适配留白：一键居中时四周预留的呼吸空间 */
const FIT_MARGIN = 24

const viewport = ref<HTMLElement | null>(null)
const scale = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const panning = ref(false)

/** 图谱布局（纯函数计算，命中高亮随检索关键词实时重算） */
const layout = computed(() =>
  buildGraphLayout(store.scopedNodes, store.scopeLabel, {
    hitIds: store.searchHitIds,
    searching: store.isSearching,
  }),
)

const canvasWidth = computed(() => layout.value.width + CANVAS_PAD * 2)
const canvasHeight = computed(() => layout.value.height + CANVAS_PAD * 2)

const stageStyle = computed(() => ({
  width: `${canvasWidth.value}px`,
  height: `${canvasHeight.value}px`,
  transform: `translate(${offsetX.value}px, ${offsetY.value}px) scale(${scale.value})`,
}))

/** 当前作用域标识：变化时才重新适配视图，避免 WebSocket 推来新节点就重置用户的平移缩放 */
const scopeKey = computed(() => `${store.currentTree}|${store.currentProjectScope}`)
/** 上一次已成功适配的作用域；null 表示尚未适配过（含首次挂载时容器还是 display:none 的情形） */
let fittedKey: string | null = null

/** 卡片左上角定位：中心坐标 + 画布留白 − 半个卡片尺寸 */
function nodeStyle(node: GraphLayoutNode) {
  return {
    left: `${node.x + CANVAS_PAD - node.width / 2}px`,
    top: `${node.y + CANVAS_PAD - node.height / 2}px`,
    width: `${node.width}px`,
    height: `${node.height}px`,
  }
}

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

/** 一键居中：整棵树等比缩放到可视区内并居中 */
function fit(): void {
  const el = viewport.value
  if (el === null) return
  const width = el.clientWidth
  const height = el.clientHeight
  if (width <= 0 || height <= 0) return
  const contentWidth = Math.max(canvasWidth.value, 1)
  const contentHeight = Math.max(canvasHeight.value, 1)
  const next = clampScale(
    Math.min((width - FIT_MARGIN * 2) / contentWidth, (height - FIT_MARGIN * 2) / contentHeight, 1),
  )
  scale.value = next
  offsetX.value = (width - contentWidth * next) / 2
  offsetY.value = (height - contentHeight * next) / 2
  fittedKey = scopeKey.value
}

/** 尚未适配过当前作用域时才自动居中（用户手动平移缩放后不打扰） */
function fitIfNeeded(): void {
  const el = viewport.value
  if (el === null || el.clientWidth <= 0 || el.clientHeight <= 0) return
  if (fittedKey === scopeKey.value) return
  fit()
}

/** 以某个可视区内的锚点做等比缩放（滚轮）或围绕中心缩放（按钮） */
function applyZoom(factor: number, anchorX: number, anchorY: number): void {
  const next = clampScale(scale.value * factor)
  if (next === scale.value) return
  const ratio = next / scale.value
  offsetX.value = anchorX - (anchorX - offsetX.value) * ratio
  offsetY.value = anchorY - (anchorY - offsetY.value) * ratio
  scale.value = next
}

function zoomBy(factor: number): void {
  const el = viewport.value
  if (el === null) return
  applyZoom(factor, el.clientWidth / 2, el.clientHeight / 2)
}

/** 滚轮缩放：锚点取指针位置，缩放时指针下的内容保持不动 */
function onWheel(event: WheelEvent): void {
  const el = viewport.value
  if (el === null) return
  event.preventDefault()
  const rect = el.getBoundingClientRect()
  applyZoom(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top)
}

let panOrigin = { pointerX: 0, pointerY: 0, offsetX: 0, offsetY: 0 }

/** 仅在节点卡片与工具栏之外的空白处启动平移，保证卡片点击不被拖拽吞掉 */
function startsPan(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true
  return target.closest('[data-tlm-gnode]') === null && target.closest('[data-tlm-gtool]') === null
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !startsPan(event.target)) return
  panning.value = true
  panOrigin = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    offsetX: offsetX.value,
    offsetY: offsetY.value,
  }
  viewport.value?.setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (!panning.value) return
  offsetX.value = panOrigin.offsetX + (event.clientX - panOrigin.pointerX)
  offsetY.value = panOrigin.offsetY + (event.clientY - panOrigin.pointerY)
}

function onPointerUp(event: PointerEvent): void {
  if (!panning.value) return
  panning.value = false
  try {
    viewport.value?.releasePointerCapture(event.pointerId)
  } catch {
    // 指针已释放：忽略
  }
}

/** 点击叶子节点 → 复用右侧 Markdown 详情抽屉 */
function onNodeClick(node: GraphLayoutNode): void {
  if (node.kind !== 'leaf' || node.node === null) return
  store.openDetail(node.node)
}

/** 卡片附加类：命中发光 / 位于命中路径 / 未命中淡化 / 实时召回微光 */
function nodeClasses(node: GraphLayoutNode): Record<string, boolean> {
  return {
    'is-hit': node.hit,
    'is-path': node.onHitPath && !node.hit,
    'is-dim': node.dim,
    'is-live': store.isActiveHit(node.id),
  }
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  const el = viewport.value
  if (el === null) return
  // wheel 必须显式非 passive：否则 preventDefault 无效，缩放时整页会跟着滚
  el.addEventListener('wheel', onWheel, { passive: false })
  if (typeof ResizeObserver !== 'undefined') {
    // 容器从 display:none 变为可见（视图模式切回图谱）时也会触发，正好用来补一次适配
    resizeObserver = new ResizeObserver(() => fitIfNeeded())
    resizeObserver.observe(el)
  }
  void nextTick(fitIfNeeded)
})

onBeforeUnmount(() => {
  viewport.value?.removeEventListener('wheel', onWheel)
  resizeObserver?.disconnect()
  resizeObserver = null
})

// 切换工程 / 切换全局偏好 → 重新适配视图
watch(scopeKey, () => {
  fittedKey = null
  void nextTick(fitIfNeeded)
})

// 从列表模式切回图谱 → 若此前因容器隐藏没能适配，这里补上
watch(
  () => props.active,
  (isActive) => {
    if (isActive === true) void nextTick(fitIfNeeded)
  },
)
</script>

<template>
  <div
    ref="viewport"
    class="tlm-graph"
    :class="{ 'is-panning': panning }"
    role="group"
    aria-label="记忆树状图谱"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div v-show="store.scopedNodes.length > 0" class="tlm-graph-stage" :style="stageStyle">
      <!-- 连线层：与节点层共用同一坐标系，translate(CANVAS_PAD) 对齐卡片偏移 -->
      <svg
        class="tlm-graph-edges"
        :width="canvasWidth"
        :height="canvasHeight"
        aria-hidden="true"
      >
        <g :transform="`translate(${CANVAS_PAD}, ${CANVAS_PAD})`">
          <path
            v-for="link in layout.links"
            :key="link.id"
            class="tlm-glink"
            :class="{ 'is-hit': link.hit, 'is-dim': link.dim }"
            :d="link.d"
          />
        </g>
      </svg>

      <!-- 节点层：所有节点都是规整卡片（内边距 + 圆角 + 微边框 + 层级阴影），
           标题 + 计数徽标；叶子可点进详情抽屉 -->
      <div class="tlm-graph-nodes">
        <template v-for="item in layout.nodes" :key="item.id">
          <button
            v-if="item.kind === 'leaf'"
            type="button"
            data-tlm-gnode="leaf"
            class="tlm-gnode tlm-gnode-leaf"
            :class="nodeClasses(item)"
            :style="nodeStyle(item)"
            :title="`阅读「${item.label}」的完整记忆`"
            @click="onNodeClick(item)"
          >
            <span class="tlm-gnode-label">{{ item.label }}</span>
            <span class="tlm-gnode-badge" title="断言强化次数">×{{ item.count }}</span>
          </button>

          <div
            v-else
            data-tlm-gnode="branch"
            class="tlm-gnode"
            :class="[item.kind === 'root' ? 'tlm-gnode-root' : 'tlm-gnode-dir', nodeClasses(item)]"
            :style="nodeStyle(item)"
            :title="`${item.label} · ${item.count} 条记忆`"
          >
            <span class="tlm-gnode-label">{{ item.label }}</span>
            <span class="tlm-gnode-badge">{{ item.count }}</span>
          </div>
        </template>
      </div>
    </div>

    <!-- 画布工具条：缩放与一键居中 -->
    <div class="tlm-graph-tools" data-tlm-gtool="1">
      <button type="button" class="tlm-gtool" title="缩小" aria-label="缩小" @click="zoomBy(1 / 1.25)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M4 8h8" />
        </svg>
      </button>
      <span class="tlm-gtool-readout">{{ Math.round(scale * 100) }}%</span>
      <button type="button" class="tlm-gtool" title="放大" aria-label="放大" @click="zoomBy(1.25)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M8 4v8M4 8h8" />
        </svg>
      </button>
      <button type="button" class="tlm-gtool tlm-gtool-wide" title="一键居中（Reset View）" @click="fit()">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2.5 6V3.5a1 1 0 0 1 1-1H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10" />
          <circle cx="8" cy="8" r="1.6" />
        </svg>
        居中
      </button>
    </div>

    <div v-if="store.scopedNodes.length === 0" class="tlm-graph-blank tlm-empty">
      当前记忆树暂无叶子沉淀
    </div>
    <div v-else class="tlm-graph-hint">拖拽平移 · 滚轮缩放</div>
  </div>
</template>
