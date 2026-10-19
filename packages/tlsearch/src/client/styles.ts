// packages/tlsearch/src/client/styles.ts
//
// 客户端半边的全部样式：注入一张以 `tls-` 类名为前缀的样式表。
//
// 浏览器半边由 esbuild 直接打包，没有 CSS 处理链路，所以样式只能以字符串注入。
// 选择器一律带 `tls-` 前缀，不向宿主其它区域泄漏；色值走 DSH 设计令牌并带中性回落
// 色，随 light / dark / skin 自动跟随。
//
// 注意：本常量是 JS 模板字面量，CSS 里**不得出现反引号或 `${**（会截断字面量）。

export const STYLE_ID = 'dsh-tlsearch-client-styles'

export const CLIENT_CSS = `
.tls-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 2px 32px;
  font-family: var(--dsw-font-family, inherit);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font-size: 13px;
  line-height: 1.6;
}

.tls-head { display: flex; flex-direction: column; gap: 4px; }
.tls-title { font-size: 16px; font-weight: 600; }
.tls-subtitle { color: var(--dsw-alias-label-secondary, #666); }
.tls-hint { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 1.55; }

.tls-banner {
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24));
  border-radius: 8px;
  font-size: 12px;
}
.tls-banner-warn { color: #9a6a00; border-color: rgba(154,106,0,.4); }
.tls-banner-error { color: #c0392b; border-color: rgba(192,57,43,.4); }

.tls-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
  border-radius: 12px;
  background: var(--dsw-alias-bg-base, transparent);
}
.tls-section-head { display: flex; flex-direction: column; gap: 2px; }
.tls-section-title { font-weight: 600; font-size: 13px; }

.tls-row {
  display: grid;
  grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
  gap: 8px 14px;
  align-items: start;
}
.tls-row-label { padding-top: 6px; color: var(--dsw-alias-label-secondary, #666); }
.tls-row-body { display: flex; flex-direction: column; gap: 5px; min-width: 0; }

.tls-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

.tls-input,
.tls-select,
.tls-textarea {
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
.tls-input:focus,
.tls-select:focus,
.tls-textarea:focus { border-color: var(--dsw-alias-state-business-primary, #2f7d32); }
.tls-input:disabled,
.tls-select:disabled,
.tls-textarea:disabled { opacity: .55; }
.tls-input-num { max-width: 130px; }
.tls-input-secret { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.tls-textarea { resize: vertical; min-height: 76px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.tls-textarea-bad { border-color: rgba(192,57,43,.6); }

.tls-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 12px;
  font: inherit;
  color: inherit;
  background: var(--dsw-alias-bg-base, transparent);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32));
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
}
.tls-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
.tls-btn:disabled { opacity: .5; cursor: default; }
.tls-btn-sm { padding: 2px 8px; font-size: 12px; }

.tls-check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.tls-check input { margin: 0; flex: none; }
.tls-check-disabled { opacity: .55; cursor: default; }

.tls-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
  border-radius: 999px;
}
.tls-chip-ok { color: #1f7a34; border-color: rgba(31,122,52,.4); }
.tls-chip-bad { color: #c0392b; border-color: rgba(192,57,43,.4); }

.tls-flash { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
.tls-flash-ok { color: #1f7a34; }
.tls-flash-bad { color: #c0392b; }

.tls-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.tls-spacer { flex: 1 1 auto; }
.tls-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
`

let installed = 0

/** 注入样式表；重复调用只注入一次。 */
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
