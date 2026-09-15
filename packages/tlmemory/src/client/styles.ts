// packages/tlmemory/src/client/styles.ts
// 客户端插件的全部样式：注入一张以本插件自有 data 属性 / 类名为前缀的样式表。
//
// 为什么不走 CSS Module：本插件的浏览器半边由 esbuild 直接打包（无 CSS 处理
// 链路），家族插件用到的 `\0dsh-css` 哈希类名机制是宿主给官方包准备的内部通道。
// 因此这里与 dsh-context 的做法一致：注入一张普通样式表，选择器一律带
// `tlmemory-` 类名前缀或 `data-dsh-tlmemory-*` 属性前缀，不向宿主其它区域泄漏。
//
// 色值全部走 dsh 设计令牌（--dsw-alias-*）并带中性回落色，随 light / dark / skin
// 自动跟随；中心列接管的显隐规则必须留在本表内（它随插件样式一起注入）。
//
// 透明透传：容器 / 面板 / iframe / 承载区一律不铺底色（background: transparent），
// 亦不设 border-radius 之类的「卡片感」外观 —— 宿主的主题背景直接穿透到看板之下，
// 看板的配色由 iframe 内部的主题令牌层（web/src/style.css）按 light / dark 自行负责。
// 唯一的例外是加载 / 离线遮罩：它是替代内容的占位，必须自带不透明底才能读清。

import {
  ACTIVE_ATTRIBUTE,
  ENTRY_ATTRIBUTE,
  STYLE_ID,
  VIEW_ATTRIBUTE,
} from './logic.js'

const ENTRY_ICON_ATTRIBUTE = 'data-dsh-tlmemory-icon'
const ENTRY_LABEL_ATTRIBUTE = 'data-dsh-tlmemory-label'

/** 注入样式表的内容 */
// 注意：本常量是 JS 模板字面量，CSS 注释与取值里**不得出现反引号或 ${**
// （会截断字面量并触发 TS1005）—— 描述 CSS 关键字时用单引号包起来。
export const CLIENT_CSS = `
/* --- 中心列接管（全局规则，按属性作用域限定） ------------------------------- */

[data-pane='conversation'],
[class*='centerCol'] {
  position: relative;
}

/* 面板容器作为中心列的尾部子节点；未激活时完全不参与布局。 */
[${VIEW_ATTRIBUTE}] {
  position: absolute;
  inset: 0;
  display: none;
  /* 高于会话输入卡（0.1.2 shell 中 z-index: 7），让面板与其弹层完整覆盖。 */
  z-index: 60;
  overflow: hidden;
  /* 透明底：本容器不像会话内容那样自带底色，宿主的主题背景由此穿透到看板之下，
     看板不再是一块与宿主主题脱节的补丁。会话内容不透出由下方那条
     'display: none !important' 规则保证，不依赖底色遮挡。 */
  background: transparent;
}

/* 中心列单占：仅当兄弟面板（任务看板 / SSH）都未激活时才显示本面板，
   三者的激活标记同时存在时不会互相抢显示。 */
html[${ACTIVE_ATTRIBUTE}]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [${VIEW_ATTRIBUTE}] {
  display: block;
}

/* 本面板激活期间隐藏会话内容（子树保持挂载与状态，只是不参与显示）。 */
html[${ACTIVE_ATTRIBUTE}]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-pane='conversation'] > :not([${VIEW_ATTRIBUTE}]),
html[${ACTIVE_ATTRIBUTE}]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [class*='centerCol'] > :not([${VIEW_ATTRIBUTE}]) {
  display: none !important;
}

/* --- 侧栏入口行（与任务看板 / SSH / 技能中心并列常驻） ---------------------- */

[${ENTRY_ATTRIBUTE}] {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease;
}

[${ENTRY_ATTRIBUTE}]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary, inherit);
}

[${ENTRY_ATTRIBUTE}][data-active] {
  background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-primary, inherit);
  font-weight: 600;
}

[${ENTRY_ATTRIBUTE}]:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #3b82f6);
  outline-offset: 2px;
}

/* 图标盒固定 24×24、SVG 18×18：与 shell 侧栏导航图标的几何一致，
   换图标或 SVG 固有尺寸变化都不会让基线偏移。 */
[${ENTRY_ATTRIBUTE}] [${ENTRY_ICON_ATTRIBUTE}] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
}

[${ENTRY_ATTRIBUTE}] [${ENTRY_ICON_ATTRIBUTE}] > svg {
  display: block;
  width: 18px;
  height: 18px;
}

[${ENTRY_ATTRIBUTE}] [${ENTRY_LABEL_ATTRIBUTE}] {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 折叠轨（56px rail）：只显图标、圆形居中，与 shell 的 rail 按钮一致。 */
[data-dsh-frame][data-sidebar-collapsed] [${ENTRY_ATTRIBUTE}],
[data-sidebar-collapsed] [${ENTRY_ATTRIBUTE}] {
  justify-content: center;
  padding: 0;
  width: 36px;
  min-height: 36px;
  margin: 0 auto 12px;
  border-radius: 50%;
}

[data-dsh-frame][data-sidebar-collapsed] [${ENTRY_ATTRIBUTE}] [${ENTRY_LABEL_ATTRIBUTE}],
[data-sidebar-collapsed] [${ENTRY_ATTRIBUTE}] [${ENTRY_LABEL_ATTRIBUTE}] {
  display: none;
}

/* --- 面板内部（透明透传 + 标准回退头 + 全幅 iframe） ---------------------- */

/* 面板外框透明：背景交由宿主中心列提供，配色由看板内部的主题令牌层负责
   （看板是跨源 iframe，无法继承宿主的 CSS 变量，靠 postMessage 同步 light/dark）。 */
.tlmemory-panel {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 14px 16px 16px;
  gap: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: var(--dsw-font-family, inherit);
  color-scheme: light dark;
}

.tlmemory-panel[data-theme='light'] {
  color-scheme: light;
}

.tlmemory-panel[data-theme='dark'] {
  color-scheme: dark;
}

/* 标题栏：左侧「回退 + 标题组」，右侧整段留空。
   padding-right 是**宿主安全区** —— 中心列整幅接管时，面板右上角与宿主右上角的
   抽屉折叠按钮重叠，任何贴右的控件都会盖住宿主自己的图标。这里保留 48px
   （叠加 .tlmemory-panel 的 16px 右内边距，实际离视口右缘 64px），
   所有控件一律左对齐排布，绝不使用 margin-left:auto / 贴右定位。 */
.tlmemory-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  padding-right: 48px;
}

/* 标题组：标题 + 状态胶囊 + （离线时）重试按钮，同一基准线左对齐。
   间隙用 gap 统一给 8px（等价于状态胶囊的 margin-left: 8px 且不会与重试按钮重复叠加）。 */
.tlmemory-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.tlmemory-title {
  margin: 0;
  flex: 0 1 auto;
  min-width: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--dsw-alias-label-primary, inherit);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tlmemory-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 5px 12px;
  font-family: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, inherit);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease;
}

.tlmemory-back:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.tlmemory-back:focus-visible,
.tlmemory-retry:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #3b82f6);
  outline-offset: 2px;
}

/* 状态指示器：紧凑次级胶囊，紧跟标题之后（左对齐），不再贴右端。
   半透明底 + 令牌色，随 light / dark / skin 自动跟随；不写死纯色。 */
.tlmemory-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  max-width: 100%;
  box-sizing: border-box;
  padding: 2px 8px;
  border-radius: 9999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
  color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9));
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}

/* 文案过长（窄面板）时只截断文字，胶囊本身不撑破标题组 */
.tlmemory-status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tlmemory-dot {
  flex: none;
  font-size: 10px;
  line-height: 1;
}

.tlmemory-retry {
  flex: none;
  padding: 3px 10px;
  font-family: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, inherit);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  border-radius: 6px;
  cursor: pointer;
}

.tlmemory-retry:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

/* iframe 承载区：父级已有确定高度（容器 absolute inset:0），
   因此 flex:1 + min-height:0 即可自适应，不需要任何 vh 估算。 */
.tlmemory-body {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: transparent;
}

/* iframe 自身透明：浏览器默认给 iframe 一层不透明白底，会盖住宿主背景；
   allowtransparency / background 属性与 inline style 由 frame.ts 在挂载时补齐
   （内联样式优先级高于本表，故这里只需兜住默认值）。 */
.tlmemory-frame {
  display: block;
  width: 100%;
  height: 100%;
  flex: 1;
  min-height: 0;
  border: none;
  background: transparent !important;
  color-scheme: light dark;
}

.tlmemory-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 13px;
}

.tlmemory-overlay-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 420px;
}

.tlmemory-overlay-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
}

.tlmemory-overlay-hint {
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary, inherit);
}

.tlmemory-spinner {
  width: 18px;
  height: 18px;
  flex: none;
  border: 2px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.45));
  border-top-color: var(--dsw-alias-state-business-primary, #3b82f6);
  border-radius: 50%;
  animation: tlmemory-spin 800ms linear infinite;
}

@keyframes tlmemory-spin {
  to { transform: rotate(360deg); }
}

/* 触屏尺寸：入口与回退按钮抬到 44px 可点区。 */
@media (max-width: 768px) {
  [${ENTRY_ATTRIBUTE}] {
    min-height: 44px;
  }

  .tlmemory-back,
  .tlmemory-retry {
    min-height: 32px;
  }
}

@media (prefers-reduced-motion: reduce) {
  [${ENTRY_ATTRIBUTE}],
  .tlmemory-back {
    transition: none;
  }

  .tlmemory-spinner {
    animation: none;
  }
}
`

/** 注入样式表的幂等键，供查询与移除复用 */
export const STYLE_SELECTOR = `style[data-plugin-css="${STYLE_ID}"]`

/**
 * 注入（或复用）客户端样式表。
 * @param doc - 目标文档
 * @returns 本次调用是否创建了 style 节点（调用方据此决定卸载时是否移除）
 */
export function ensureClientStyles(doc: Document = document): boolean {
  if (doc.querySelector(STYLE_SELECTOR) !== null) return false
  const tag = doc.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-tlmemory'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CLIENT_CSS
  doc.head.appendChild(tag)
  return true
}

/**
 * 移除本插件注入的样式表（仅当本插件是创建者时）。
 * @param doc - 目标文档
 */
export function removeClientStyles(doc: Document = document): void {
  doc.querySelector(STYLE_SELECTOR)?.remove()
}
