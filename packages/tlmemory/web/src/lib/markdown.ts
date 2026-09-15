// packages/tlmemory/web/src/lib/markdown.ts
// 记忆正文的 Markdown 渲染与「简介」抽取。
//
// 为什么不用 marked 的默认渲染：记忆正文是本地沉淀的自由文本，可能夹带 HTML 片段
// 或 `javascript:` 链接。看板虽然只跑在回环地址，但它持有 /api/nodes 的删除权限，
// 一次注入就能删库，所以这里把 marked 的三个出口全部收口：
//   * html    —— 原样转义为文本（不执行、不解析）；
//   * link    —— 协议白名单，仅放行 http / https / mailto / tel 与相对路径；
//   * image   —— 不产出 <img>，避免看板替正文向任意外站发请求（隐私 + 追踪）。
// 代码块与行内代码自行渲染，语言标识也经过转义，不依赖库内实现细节。

import { Marked } from 'marked'

/** HTML 文本转义（正文与属性值共用） */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 链接协议白名单：相对路径 / 锚点（不含 scheme）也放行 */
const SAFE_LINK_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:', 'tel:']

/**
 * 校验链接目标；危险协议返回 undefined（调用方退化为纯文本）。
 * @param href - 原始链接
 */
export function sanitizeHref(href: string): string | undefined {
  const trimmed = href.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  if (trimmed === '') return undefined
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)
  if (scheme === null) return trimmed
  return SAFE_LINK_PROTOCOLS.includes(`${scheme[1]!.toLowerCase()}:`) ? trimmed : undefined
}

const html = escapeHtml

/** 收口后的 Markdown 解析器（GFM：表格 / 任务列表 / 删除线；换行按字面处理） */
const markdown = new Marked({ gfm: true, breaks: true })

markdown.use({
  renderer: {
    html(token) {
      // 原始 HTML 一律当正文显示，不进入 DOM 解析路径。
      return html(token.text)
    },
    code(token) {
      const language = (token.lang ?? '').trim().split(/\s+/)[0] ?? ''
      const languageClass = language === '' ? '' : ` class="language-${html(language)}"`
      return `<pre class="tlm-md-pre"><code${languageClass}>${html(token.text)}</code></pre>\n`
    },
    codespan(token) {
      return `<code class="tlm-md-code">${html(token.text)}</code>`
    },
    link(token) {
      const rendered = this.parser.parseInline(token.tokens)
      const href = sanitizeHref(token.href)
      if (href === undefined) return rendered
      const title = token.title === null || token.title === undefined ? '' : ` title="${html(token.title)}"`
      return `<a class="tlm-md-link" href="${html(href)}"${title} target="_blank" rel="noreferrer noopener">${rendered}</a>`
    },
    image(token) {
      // 只保留替代文本，不发起网络请求。
      return `<span class="tlm-md-imgtext">${html(token.text || token.href)}</span>`
    },
  },
})

/**
 * 把 Markdown 渲染为可直接 v-html 的安全 HTML 片段。
 * @param source - 记忆正文（可为空）
 */
export function renderMarkdown(source: string | null | undefined): string {
  if (source === null || source === undefined) return ''
  const text = String(source)
  if (text.trim() === '') return ''
  return markdown.parse(text, { async: false })
}

/** 行首的 Markdown 结构前缀（引用 / 列表 / 任务框） */
const LINE_PREFIX = /^\s{0,3}(?:>\s?|[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/

/** ATX 标题（`#` ~ `######`） */
const HEADING = /^\s{0,3}#{1,6}\s+/

/** 分割线（`---` / `***` / `___`）：属于版式而非正文，简介里跳过 */
const THEMATIC_BREAK = /^(?:[-*_]\s*){3,}$/

/**
 * 抽取列表项简介：取正文第一个正文段落，剥掉 Markdown 结构符号后压成单行。
 *
 * 两条刻意的取舍：
 *   1. **标题不进简介**：记忆文档普遍以 `# 标题` 开头，而标题与节点名高度重合，
 *      拿它当简介等于把列表项变成「名字 + 名字」。因此优先取标题之后的第一个
 *      正文段落，只有整篇除标题外再无内容时才退回标题文本。
 *   2. **不截原始文本**：先剥标记再压行，否则 `## ` `- ` 这类符号会直接漏进简介。
 * @param source - 记忆正文
 * @param maxLength - 简介最大字符数（超出以省略号收尾）
 */
export function extractSummary(source: string | null | undefined, maxLength = 160): string {
  if (source === null || source === undefined) return ''
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n')

  let inCodeBlock = false
  let headingFallback = ''
  const body: string[] = []
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inCodeBlock = !inCodeBlock
      // 代码块本身不进简介；它前面的段落到此为止。
      if (body.length > 0) break
      continue
    }
    if (inCodeBlock) continue
    if (line === '') {
      // 段落边界：已经收到正文即可收工，否则继续跳过前导空行。
      if (body.length > 0) break
      continue
    }
    if (THEMATIC_BREAK.test(line)) continue
    if (HEADING.test(line)) {
      if (headingFallback === '') headingFallback = line.replace(HEADING, '')
      continue
    }
    body.push(line.replace(LINE_PREFIX, ''))
  }

  const flattened = flattenInline((body.length > 0 ? body : [headingFallback]).join(' '))
  if (flattened === '') return ''
  return flattened.length <= maxLength ? flattened : `${flattened.slice(0, maxLength).trimEnd()}…`
}

/** 去掉行内 Markdown 记号（链接 / 图片 / 强调 / 行内代码），折叠空白 */
function flattenInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
