// packages/tlnotify/src/markdown.ts
//
// 把模型产出的 Markdown 压成 IM 看得懂的纯文本。
//
// ── 为什么必须有这一层 ──────────────────────────────────────────────────────
//
// 通知正文里最常出现的就是**助手回复原文**，而助手回复几乎必然是 Markdown
// （`## 标题`、`| 表格 |`、`**加粗**`、代码围栏）。但两个通道都不渲染它：
//
//   - QQ：只发 `msg_type: 0`（纯文本，见 `channels/qq.ts`）。QQ 的 Markdown
//     消息要 `custom_template_id`，单聊里根本用不了。
//   - 飞书：无按钮时 `msg_type: 'text'`；有按钮时走卡片，但卡片的 `lark_md`
//     只认加粗 / 斜体 / 删除线 / 链接这一小撮**内联**语法，`## 标题` 与
//     `| 表格 |` 一样是原样输出。
//
// 不压的结果就是用户在手机上读到「| 分类 | 记忆条目 |」这种源码。
//
// ── 一条容易被忽略的顺序约束 ────────────────────────────────────────────────
//
// 表格识别依赖**相邻两行**（表头 + 分隔行），一旦被折平就再也认不出来。精简模式
// 现在不折行了（见 `render.ts` 的 `structuredText`），但按钮标签、`· ` 列表项、审批
// 原因这些位置仍然会 `oneLine()`，所以助手正文必须在折行**之前**先过这里——
// `render.ts` 的 `primaryText` 是那个 choke point，别把它挪到后面去。
//
// ── 规则：只降级，不丢信息 ──────────────────────────────────────────────────
//
//   标题   `## X`              → `【X】`
//   表格   `| a | b |`         → `· a：b`（表头行丢弃，首列当键）
//   围栏   ```code```          → 内容原样保留，丢掉围栏与语言标记
//   行内   `` `code` `` `**粗**` `*斜*` `~~删~~` → 去掉标记留文字
//   链接   `[文字](url)`       → `文字（url）`
//   列表   `- x`               → `· x`（有序列表原样保留）
//   引用 / 分隔线 / HTML 标签  → 去掉标记
//
// ── 它不是幂等的，别压两遍 ──────────────────────────────────────────────────
//
// 代码块和行内代码是**原样还原**的，所以第一遍的输出里会重新出现 `# 注释`、
// `- 参数`、`**a**` 这类字符——只不过它们此时是代码内容，不是标记。再压一遍，
// 第二遍就认不出这个区别了，会照着标记把它们吃掉。因此每个自由文本入口各压一次
// （见 `render.ts` 里各调用点的注释），不要在正文末尾统一兜底。

const FENCE = /^\s*(```+|~~~+)/
/** 行内代码。刻意不跨行：正文里一个落单的反引号不该把后面几行全吃掉。 */
const INLINE_CODE = /(`+)([^`\n]*?)\1/g
/** 表格分隔行：只由 `-` `:` `|` 和空白组成，且至少一个 `-`。 */
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|?\s*$/
const PLACEHOLDER = /\u0000(\d+)\u0000/g
/** 常见 HTML 实体。模型偶尔会转义，留着 `&nbsp;` 比吃掉它更难看。 */
const HTML_ENTITY: Readonly<Record<string, string>> = Object.freeze({
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
})

export function toPlainText(markdown: string): string {
  if (!markdown) return ''
  const source = markdown.replace(/\r\n?/g, '\n')

  // 1) 先把代码摘出来：围栏块整块摘，行内代码逐段摘。代码里的 `#`、`|`、`*` 是
  //    代码而不是标记，所以用占位符顶替，等所有规则跑完再原样放回去。
  const codes: string[] = []
  const lines: string[] = []
  let inFence = false
  for (const line of source.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    lines.push(inFence ? protect(codes, line) : line)
  }
  const kept = lines.map((line) =>
    line.replace(INLINE_CODE, (_match, _ticks: string, code: string) => protect(codes, code.trim())),
  )

  // 2) 表格必须整块识别（表头 + 分隔行 + 数据行），逐行看是认不出来的。
  const blocks: string[] = []
  for (let i = 0; i < kept.length; i += 1) {
    const line = kept[i] as string
    if (line.includes('|') && isTableSeparator(kept[i + 1])) {
      i += 2 // 跳过表头与分隔行
      const rows: string[][] = []
      while (i < kept.length && (kept[i] as string).includes('|') && (kept[i] as string).trim().length > 0) {
        rows.push(splitRow(kept[i] as string))
        i += 1
      }
      i -= 1
      blocks.push(...tableLines(rows))
      continue
    }
    blocks.push(line)
  }

  // 3) 行级标记 → 4) 行内标记 → 5) 收尾。
  //    行内规则在**还原代码之前**跑：那时代码还是占位符，里面的 `**` 不会被误伤。
  const flattened = inline(blocks.map(flattenLine).join('\n'))
  const cleaned = flattened
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned.replace(PLACEHOLDER, (_match, index: string) => codes[Number(index)] ?? '')
}

// ---------------------------------------------------------------------------
// 行级
// ---------------------------------------------------------------------------

function flattenLine(line: string): string {
  // 引用前缀：留着 `>` 在手机上没有意义，正文本身要保留。
  const text = line.replace(/^\s{0,3}>\s?/, '')

  const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text)
  if (heading) return `【${heading[2]}】`

  // 分隔线（`---` / `***` / `___`）没有任何信息量，整行丢掉。
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(text)) return ''

  // 无序列表统一成 `· `，和正文里其它小圆点保持一致；有序列表原样留着，
  // 因为「1. 2. 3.」本身就是有用信息（提问选项就靠它）。
  return text.replace(/^(\s*)[-*+]\s+/, '$1· ')
}

function isTableSeparator(line: string | undefined): boolean {
  // 必须同时有 `-` 和 `|`：`---` 单独一行是分隔线，不能因为上一行碰巧含 `|`
  // 就把它当成表格分隔行——那样两行都会被吞掉。
  if (typeof line !== 'string' || !line.includes('-') || !line.includes('|')) return false
  return TABLE_SEPARATOR.test(line)
}

/** 拆一行表格。`\|` 是单元格内的转义竖线，不能当分隔符。 */
function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim())
}

/**
 * 表格 → `· 首列：其余列`。
 *
 * 表头行直接丢弃：通知里能放下的表格几乎都是「键 | 值」两列，表头只是把这件事
 * 说了一遍；留着反而在正文里多出一行噪音。列宽对齐也不做——IM 的字体不是等宽，
 * 对齐在手机上必然错位。
 */
function tableLines(rows: readonly (readonly string[])[]): string[] {
  const lines: string[] = []
  for (const row of rows) {
    const cells = row.map((cell) => cell.trim())
    if (cells.every((cell) => cell.length === 0)) continue
    const key = cells[0] ?? ''
    const values = cells.slice(1).filter((cell) => cell.length > 0)
    if (values.length === 0) {
      if (key.length > 0) lines.push(`· ${key}`)
    } else if (key.length === 0) {
      lines.push(`· ${values.join(' · ')}`)
    } else {
      lines.push(`· ${key}：${values.join(' · ')}`)
    }
  }
  return lines
}

// ---------------------------------------------------------------------------
// 行内
// ---------------------------------------------------------------------------

function inline(text: string): string {
  let out = text
    // HTML：`<br>` 是换行，其余标签（`<div>`、`<span>`、`<details>`…）只去标记。
    // 这个标签正则要求标签名后紧跟空白或 `>`，所以 `<https://x>` 这种自动链接
    // 不会被当成标签吃掉。
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\/?>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (match) => HTML_ENTITY[match] ?? match)

  // 行内代码不在这里处理——它已经在 `toPlainText` 第 1 步被换成占位符了，
  // 所以下面这些规则碰不到代码内容。别把反引号剥离挪回来：那样代码里的 `**`
  // 会被当成强调标记吃掉。

  // 图片只留 alt（通知里放不了图）；链接留「文字（url）」，url 本身有用。
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt: string) => alt.trim() || '图片')
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) => {
    const text_ = label.trim()
    return text_.length === 0 || text_ === url ? url : `${text_}（${url}）`
  })

  // 强调标记：内容必须以非空白开头结尾，否则 `2 * 3 * 4` 这种普通算式会被吃掉。
  // 循环几轮是为了让 `**a *b* c**` 这种嵌套也能收敛。
  for (let pass = 0; pass < 3; pass += 1) {
    const before = out
    out = out
      .replace(/\*\*\*(\S(?:[^*]*?\S)?)\*\*\*/g, '$1')
      .replace(/\*\*(\S(?:[^*]*?\S)?)\*\*/g, '$1')
      .replace(/__(\S(?:[^_]*?\S)?)__/g, '$1')
      .replace(/~~(\S(?:[^~]*?\S)?)~~/g, '$1')
      .replace(/(^|[^*])\*(\S(?:[^*\n]*?\S)?)\*(?!\*)/g, '$1$2')
    if (out === before) break
  }
  return out
}

function protect(codes: string[], text: string): string {
  codes.push(text)
  return `\u0000${codes.length - 1}\u0000`
}
