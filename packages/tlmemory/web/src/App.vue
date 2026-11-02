<!-- packages/tlmemory/web/src/App.vue
     记忆看板主视图。所有配色走 style.css 的 --tlm-* 令牌层（由 <html data-theme>
     驱动，主题经 postMessage 从宿主同步而来），组件内不写死任何颜色，
     因此宿主切浅色 / 深色时整块看板同步响应。

     顶部工具栏三组控件，职责严格分开：
       1. 工程下拉选择框（ProjectPicker）—— 常显当前工程名 + 记忆数，下拉可切换；
       2. [全局偏好] 独立胶囊 —— 与工程记忆明确区隔，再点一次回到工程记忆；
       3. 视图模式滑块 —— 📋 目录列表 / 🌲 树状图谱，半透明滑块随选中项平移，
          两视图用 v-show 切换，因而选中工程、搜索关键词、图谱的平移缩放状态都原样保留。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useMemoryStore } from './stores/memory'
import MemoryTree from './components/MemoryTree.vue'
import MemoryGraphTree from './components/MemoryGraphTree.vue'
import MemoryDetailDrawer from './components/MemoryDetailDrawer.vue'
import MemoryCreateModal from './components/MemoryCreateModal.vue'
import ProjectPicker from './components/ProjectPicker.vue'
import {
  currentThemeMode,
  getThemePreference,
  setThemePreference,
  setupThemeBridge,
  type ThemePreference,
} from './theme'

const store = useMemoryStore()

/** 主题桥的卸载函数（组件销毁时摘掉 postMessage 监听） */
let disposeThemeBridge: (() => void) | undefined

/** 「+ 新建记忆」表单弹窗的显隐 */
const showCreate = ref(false)

/** 是否处于全文检索态：列表模式下用它决定展示检索结果还是完整目录 */
const searching = computed(() => store.isSearching)

/** 主题偏好（顶栏主题按钮的状态与图标） */
const themePref = ref<ThemePreference>(getThemePreference())

const THEME_LABEL: Record<ThemePreference, string> = {
  auto: '跟随宿主',
  light: '强制浅色',
  dark: '强制深色',
}

const themeButtonTitle = computed(() => {
  const next = themePref.value === 'auto' ? '浅色' : themePref.value === 'light' ? '深色' : '跟随宿主'
  const effective = currentThemeMode()
  return `主题：${THEME_LABEL[themePref.value]}（当前 ${effective === 'dark' ? '深色' : '浅色'}）· 点击切换为${next}`
})

/** 循环切换：跟随宿主 → 浅色 → 深色 → 跟随宿主 */
function cycleTheme(): void {
  const next: ThemePreference =
    themePref.value === 'auto' ? 'light' : themePref.value === 'light' ? 'dark' : 'auto'
  setThemePreference(next)
  themePref.value = next
}

/** 分区中文名（与 tlrp / tlmemory 分区语义一一对应） */
const PARTITION_TITLES: Record<string, string> = {
  core: '核心画像',
  work: '工程运维',
  rp: '角色扮演',
  lore: '世界观设定',
}

/**
 * 分区胶囊：只列出**真的有记忆**的分区（零条分区不占位），条数按叶子计。
 * 分区与工程正交 —— rp/lore 的角色记忆挂在 global 树下，按工程维度看不见，
 * 这一条筛选条才是它们在界面上的入口。
 */
const partitionChips = computed(() => {
  const totals = new Map<string, number>()
  for (const row of store.partitionStats) {
    if (!row.scope) continue
    totals.set(row.scope, (totals.get(row.scope) ?? 0) + Number(row.leaves ?? 0))
  }
  return ['core', 'work', 'rp', 'lore']
    .filter((scope) => (totals.get(scope) ?? 0) > 0)
    .map((scope) => ({ scope, title: PARTITION_TITLES[scope] ?? scope, leaves: totals.get(scope) ?? 0 }))
})

/** 角色胶囊：rp/lore 分区里出现过的角色（其它分区没有角色归属） */
const charChips = computed(() => {
  const totals = new Map<string, number>()
  for (const row of store.partitionStats) {
    if (!row.charId) continue
    if (row.scope !== 'rp' && row.scope !== 'lore') continue
    totals.set(row.charId, (totals.get(row.charId) ?? 0) + Number(row.leaves ?? 0))
  }
  return [...totals.entries()].map(([charId, leaves]) => ({ charId, leaves }))
})

/** 角色分区的默认角色：点「角色扮演 / 世界观设定」时自动带上第一个角色 */
const defaultCharId = computed<string>(() => charChips.value[0]?.charId ?? '')

/** 点分区胶囊：已激活则退出分区模式；rp/lore 自动带默认角色 */
function choosePartition(scope: string): void {
  const needsChar = scope === 'rp' || scope === 'lore'
  void store.setPartition(scope, needsChar ? store.activeCharId || defaultCharId.value : '')
}

/** 点角色胶囊：在当前分区内切换角色（未选分区时落到 rp） */
function chooseChar(charId: string): void {
  const scope = store.activePartition === 'rp' || store.activePartition === 'lore' ? store.activePartition : 'rp'
  void store.setPartition(scope, charId)
}

/** 全局偏好胶囊：先退出分区模式，再切树 */
function chooseGlobal(): void {
  if (store.activePartition) void store.setPartition('')
  void store.toggleGlobal()
}

onMounted(() => {
  // 先接主题再取数据：避免首屏用错配色。
  disposeThemeBridge = setupThemeBridge()
  void store.bootstrap()
  store.setupWebSocket()
})

onBeforeUnmount(() => {
  disposeThemeBridge?.()
  // P2-11：卸载时取消挂起的 WS 重连定时器并关闭连接，不留空转轮询
  store.disposeWebSocket()
})
</script>

<template>
  <div class="tlm-app">
    <header class="tlm-header">
      <span class="tlm-brand">
        TL·MEMORY
        <!-- 只统计真正的记忆条目（叶子）；目录骨架不是记忆，不该混进「N 条」 -->
        <span class="tlm-brand-count">{{ store.memoryNodes.length }} 条</span>
        <span v-if="store.partitionLabel" class="tlm-partition-badge">{{ store.partitionLabel }}</span>
      </span>
      <span class="tlm-spacer" />

      <!-- 工程选择器：自定义下拉，常显「工程名 (记忆数)」；
           选项来自 GET /api/projects（服务端已反解工程名），失败时由节点反推兜底 -->
      <ProjectPicker />

      <!-- 全局偏好：独立胶囊，与工程记忆明确区分 -->
      <button
        type="button"
        class="tlm-pill"
        :aria-pressed="store.currentTree === 'global' && !store.activePartition"
        title="查看跨工程通用的全局偏好"
        @click="chooseGlobal"
      >
        全局偏好
      </button>

      <!-- 视图模式滑块：半透明自适应滑块随选中项平移（与 DSH 原生分段控件同观感） -->
      <div class="tlm-segment" role="group" aria-label="视图模式" :data-active="store.viewMode">
        <span class="tlm-segment-thumb" aria-hidden="true" />
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

      <!-- 新建记忆：弹出轻量级表单（归属工程 / 路径目录 / 标题 / Markdown 正文） -->
      <button type="button" class="tlm-create-btn" title="手工新增一条记忆" @click="showCreate = true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
          <path d="M8 3.2v9.6M3.2 8h9.6" />
        </svg>
        新建记忆
      </button>

      <!-- 主题按钮：跟随宿主（自动）→ 浅色 → 深色 循环；localStorage 持久化。
           深浅切换的显式入口 —— 宿主页面半边异常（旧脚本推错主题）时的手动兜底。 -->
      <button
        type="button"
        class="tlm-theme-btn"
        :title="themeButtonTitle"
        :aria-label="themeButtonTitle"
        @click="cycleTheme"
      >
        <!-- 跟随宿主：半填充对比圆 -->
        <svg
          v-if="themePref === 'auto'"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="5.4" />
          <path d="M7 1.6v10.8" stroke-linecap="round" />
          <path d="M7 1.6a5.4 5.4 0 0 1 0 10.8Z" fill="currentColor" stroke="none" />
        </svg>
        <!-- 强制浅色：太阳 -->
        <svg
          v-else-if="themePref === 'light'"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="2.8" />
          <path d="M7 1v1.6M7 11.4V13M1 7h1.6M11.4 7H13M2.76 2.76l1.13 1.13M10.11 10.11l1.13 1.13M11.24 2.76l-1.13 1.13M3.89 10.11l-1.13 1.13" />
        </svg>
        <!-- 强制深色：月牙 -->
        <svg v-else viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">
          <path d="M12.2 8.6A5.6 5.6 0 1 1 5.4 1.8a4.6 4.6 0 0 0 6.8 6.8Z" />
        </svg>
      </button>
    </header>

    <!-- 物理分区筛选条（v2）：core / work / rp / lore，右侧挂角色胶囊。
         分区维度与工程维度正交 —— 角色扮演记忆挂在 global 树下，工程下拉框里
         只能看到「一整棵 global」，这里是它唯一的入口。 -->
    <div v-if="partitionChips.length > 0" class="tlm-partitions">
      <span class="tlm-partitions-label">分区</span>
      <button
        v-for="chip in partitionChips"
        :key="chip.scope"
        type="button"
        class="tlm-partition-chip"
        :class="{ 'is-active': store.activePartition === chip.scope }"
        :aria-pressed="store.activePartition === chip.scope"
        :title="`只看 ${chip.title} 分区（${chip.leaves} 条）`"
        @click="choosePartition(chip.scope)"
      >
        {{ chip.title }}
        <span class="tlm-partition-count">{{ chip.leaves }}</span>
      </button>
      <span v-if="charChips.length > 0" class="tlm-partitions-sep" aria-hidden="true" />
      <button
        v-for="char in charChips"
        :key="char.charId"
        type="button"
        class="tlm-partition-chip tlm-partition-char"
        :class="{ 'is-active': store.isActiveChar(char.charId) }"
        :aria-pressed="store.isActiveChar(char.charId)"
        :title="`切换到角色「${char.charId}」的分区记忆（${char.leaves} 条）`"
        @click="chooseChar(char.charId)"
      >
        {{ char.charId }}
      </button>
      <button
        v-if="store.activePartition"
        type="button"
        class="tlm-partition-clear"
        title="退出分区筛选，回到工程/全局维度"
        @click="store.setPartition('')"
      >
        退出分区
      </button>
    </div>

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

    <!-- P2-7 操作错误提示条：删除/检索等 4xx/5xx 不再完全静默 -->
    <div v-if="store.actionError" class="tlm-errorbar" role="alert">
      <span>{{ store.actionError }}</span>
      <button type="button" class="tlm-errorbar-close" aria-label="关闭错误提示" @click="store.actionError = ''">
        ×
      </button>
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
      <span>已载入节点 {{ store.scopedNodes.length }}（其中记忆 {{ store.memoryNodes.length }} 条）</span>
      <span class="tlm-conn" :class="{ 'is-online': store.wsConnected }">
        <span class="tlm-conn-dot" aria-hidden="true" />
        {{ store.wsConnected ? '实时链路正常' : '实时链路断开' }}
      </span>
    </footer>

    <!-- 详情抽屉：完整渲染所选记忆的 Markdown 全文 -->
    <MemoryDetailDrawer :node="store.selectedNode" @close="store.closeDetail()" />

    <!-- 新建记忆弹窗：提交 POST /api/nodes，成功后自动定位新节点 -->
    <MemoryCreateModal :open="showCreate" @close="showCreate = false" />
  </div>
</template>
