// packages/tlmemory/src/client/frame.ts
// iframe 透明透传：让宿主的主题背景从中心列一路穿透到看板内容之下。
//
// 背景链路（任一层不透明都会让看板变成「补丁」）：
//   centerCol（宿主背景，应有色）
//     └─ [data-dsh-tlmemory-view]（本插件容器：透明）
//          └─ .tlmemory-panel（本插件面板：透明）
//               └─ iframe.tlmemory-frame（本插件 iframe：透明 + color-scheme normal）
//                    └─ 看板自身 html/body/#app（在 web 侧强制 transparent）
//
// 三个属性一起设，覆盖不同内核的语义：
//   * allowtransparency="true"：HTML4 时代的遗留属性，现代内核忽略，但内嵌型宿主
//     仍可能读它（保留可用性优于省略）；
//   * background="transparent"：同为遗留属性，语义等价；
//   * style.background / backgroundColor：现代内核下真正生效的一项。
// 真正的透明由「iframe 自身透明 + 子文档 html/body 透明」共同成立才能显现。
//
// ★ 刻意**不**在 iframe 元素上设置任何非 normal 的 color-scheme（历史上的
//   applyFrameColorScheme 已删除）：实测 Chromium 会给带非 normal color-scheme
//   的 iframe 涂一层不透明白的画布（即便值为 dark 也涂白），宿主主题背景从此
//   透不上来。滚动条 / 表单控件的配色由 iframe 文档内部的 .tlm-app / .tlm-drawer
//   在元素级声明（不影响画布）；styles.ts 也在 .tlmemory-frame 上声明
//   color-scheme: normal，阻断从面板继承。

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
