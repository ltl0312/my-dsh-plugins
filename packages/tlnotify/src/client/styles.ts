// packages/tlnotify/src/client/styles.ts
//
// 客户端半边的全部样式：注入一张以 `tln-` 类名为前缀的样式表。
//
// 为什么不走 CSS Module：浏览器半边由 esbuild 直接打包，没有 CSS 处理链路。
// 选择器一律带 `tln-` 前缀，不向宿主其它区域泄漏。
//
// 色值全部走 DSH 设计令牌（`--dsw-alias-*`）并带中性回落色，随 light / dark / skin
// 自动跟随。字号与圆角用相对值，尽量不写死像素里的「主题感」。
//
// 注意：本常量是 JS 模板字面量，CSS 里**不得出现反引号或 ${**（会截断字面量）。

export const STYLE_ID = 'dsh-tlnotify-client-styles'

export const CLIENT_CSS = `
.tln-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 4px 2px 32px;
  font-family: var(--dsw-font-family, inherit);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font-size: 13px;
  line-height: 1.6;
}

.tln-head { display: flex; flex-direction: column; gap: 4px; }
.tln-title { font-size: 16px; font-weight: 600; }
.tln-subtitle { color: var(--dsw-alias-label-secondary, #666); }
.tln-hint { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 1.55; }

.tln-statusbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
  border-radius: 10px;
  background: var(--dsw-alias-bg-base, transparent);
}
.tln-status-item { display: inline-flex; align-items: center; gap: 6px; }
.tln-status-item + .tln-status-item::before {
  content: '';
  width: 1px;
  height: 12px;
  margin-right: 8px;
  background: var(--dsw-alias-border-l3, rgba(127,127,127,.28));
}

.tln-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary, #999); }
.tln-dot-on { background: var(--dsw-alias-state-business-primary, #2f7d32); }
.tln-dot-warn { background: #d08700; }
.tln-dot-off { background: var(--dsw-alias-label-tertiary, #999); }

.tln-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
  border-radius: 12px;
  background: var(--dsw-alias-bg-base, transparent);
}
.tln-section-head { display: flex; flex-direction: column; gap: 2px; }
.tln-section-title { font-weight: 600; font-size: 13px; }

.tln-row {
  display: grid;
  grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
  gap: 10px 14px;
  align-items: start;
}
.tln-row-label { padding-top: 6px; color: var(--dsw-alias-label-secondary, #666); }
.tln-row-body { display: flex; flex-direction: column; gap: 5px; min-width: 0; }

.tln-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.tln-grow { flex: 1 1 180px; min-width: 0; }

.tln-input,
.tln-select,
.tln-textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 6px 9px;
  font: inherit;
  color: inherit;
  background: var(--dsw-alias-bg-base, transparent);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32));
  border-radius: 8px;
  outline: none;
}
.tln-input:focus,
.tln-select:focus,
.tln-textarea:focus { border-color: var(--dsw-alias-state-business-primary, #2f7d32); }
.tln-input:disabled,
.tln-select:disabled,
.tln-textarea:disabled { opacity: .55; }
.tln-textarea { resize: vertical; min-height: 56px; font-family: inherit; }
.tln-input-num { max-width: 120px; }

.tln-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  font: inherit;
  color: inherit;
  background: var(--dsw-alias-bg-base, transparent);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32));
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
}
.tln-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
.tln-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.16)); }
.tln-btn:disabled { opacity: .5; cursor: default; }
.tln-btn-primary {
  color: #fff;
  background: var(--dsw-alias-state-business-primary, #2f7d32);
  border-color: transparent;
}
.tln-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
.tln-btn-danger { color: #c0392b; border-color: rgba(192,57,43,.45); }
.tln-btn-sm { padding: 3px 9px; font-size: 12px; }

.tln-check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.tln-check input { margin: 0; flex: none; }
.tln-check-disabled { opacity: .55; cursor: default; }

.tln-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32)); border-radius: 8px; overflow: hidden; }
.tln-seg > button {
  padding: 5px 14px;
  font: inherit;
  color: inherit;
  background: transparent;
  border: none;
  border-right: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
  cursor: pointer;
}
.tln-seg > button:last-child { border-right: none; }
.tln-seg > button[aria-pressed='true'] {
  color: #fff;
  background: var(--dsw-alias-state-business-primary, #2f7d32);
}

.tln-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
  border-radius: 10px;
}
.tln-card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.tln-card-head .tln-grow { flex: 1 1 auto; }

.tln-note {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.tln-note-ok { color: #1f7a34; border-color: rgba(31,122,52,.4); }
.tln-note-warn { color: #9a6a00; border-color: rgba(154,106,0,.4); }
.tln-note-error { color: #c0392b; border-color: rgba(192,57,43,.4); }

.tln-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
  color: var(--dsw-alias-label-secondary, #666);
}

.tln-qr { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.tln-qr-canvas {
  padding: 10px;
  background: #fff;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
  border-radius: 10px;
  line-height: 0;
}
.tln-qr svg { display: block; width: 208px; height: 208px; }

.tln-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.tln-spacer { flex: 1 1 auto; }

.tln-busy { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; }

.tln-kv { display: grid; grid-template-columns: minmax(80px, 140px) minmax(0, 1fr); gap: 4px 12px; font-size: 12px; }
.tln-kv dt { color: var(--dsw-alias-label-secondary, #666); }
.tln-kv dd { margin: 0; word-break: break-all; }

.tln-fatal { display: flex; flex-direction: column; gap: 10px; padding: 16px 0; }
`

let installed = 0

/** 注入样式表；重复调用只注入一次。返回是否需要由调用方在卸载时移除。 */
export function ensureClientStyles(): boolean {
  if (typeof document === 'undefined') return false
  installed += 1
  if (document.getElementById(STYLE_ID)) return false
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CLIENT_CSS
  document.head.appendChild(style)
  return true
}

/** 卸载样式表。引用计数归零才真的移除，避免多个挂载点互相拆台。 */
export function removeClientStyles(): void {
  if (typeof document === 'undefined') return
  installed = Math.max(0, installed - 1)
  if (installed > 0) return
  document.getElementById(STYLE_ID)?.remove()
}
