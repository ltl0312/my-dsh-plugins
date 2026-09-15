// packages/tlmemory/src/client/frame.ts
// iframe 透明透传：让宿主的主题背景从中心列一路穿透到看板内容之下。
//
// 背景链路（任一层不透明都会让看板变成「补丁」）：
//   centerCol（宿主背景，应有色）
//     └─ [data-dsh-tlmemory-view]（本插件容器：透明）
//          └─ .tlmemory-panel（本插件面板：透明）
//               └─ iframe.tlmemory-frame（本插件 iframe：透明）
//                    └─ 看板自身 html/body/#app（在 web 侧强制 transparent）
//
// 三个属性一起设，覆盖不同内核的语义：
//   * allowtransparency="true"：HTML4 时代的遗留属性，现代内核忽略，但内嵌型宿主
//     仍可能读它（保留可用性优于省略）；
//   * background="transparent"：同为遗留属性，语义等价；
//   * style.background / backgroundColor：现代内核下真正生效的一项。
// 真正的透明由「iframe 自身透明 + 子文档 html/body 透明」共同成立才能显现。

/** iframe 与承载层的透明底色 */
export const TRANSPARENT_BACKGROUND = 'transparent'

/**
 * 把 iframe 自身铺成透明（浏览器默认给 iframe 一层白底，会盖住宿主背景）。
 * @param frame - 看板 iframe 元素
 */
export function applyFrameTransparency(frame: HTMLIFrameElement): void {
  frame.setAttribute('allowtransparency', 'true')
  frame.setAttribute('background', TRANSPARENT_BACKGROUND)
  frame.style.background = TRANSPARENT_BACKGROUND
  frame.style.backgroundColor = TRANSPARENT_BACKGROUND
}

/**
 * 把主题模式同步到 iframe 及其承载层的 color-scheme。
 *
 * 仅影响滚动条、表单控件等「内核绘制」的外观（CSS 配色由 iframe 内的
 * data-theme 令牌层负责），因此不需要跨文档通信，父侧设置即可。
 * @param frame - 看板 iframe 元素
 * @param mode - 当前配色模式
 */
export function applyFrameColorScheme(frame: HTMLIFrameElement, mode: 'light' | 'dark'): void {
  frame.style.colorScheme = mode
}
