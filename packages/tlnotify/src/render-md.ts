// packages/tlnotify/src/render-md.ts
//
// 富文本渲染的**纯函数层**：Markdown 原文 → 通道可用的两条轨（原生 MD / 高保真纯文本），
// 外加两轨各自的分片。没有网络、没有 IO、没有 cordis 依赖，可单测。
//
// ── 为什么纯文本也要讲「排版」 ──────────────────────────────────────────────
//
// `markdown.ts` 解决的是「别让用户读到源码」：`## 标题` → `【标题】`、`| a | b |` →
// `· a：b`。它的目标是把标记**去掉**，做的是降级（degrade）。
//
// 但 QQ 单聊没有 Markdown 通道（`msg_type: 2` 要 `custom_template_id`，且要过平台
// 报备），大多数时候流萤的状态面板、分节汇报、代码片段只能以纯文本落地。而纯文本
// 不等于「一坨没有层次的文字」——
//
//   - 人眼在手机上定位信息靠的是**边框、缩进、分隔线、前缀符号**这些纯字符手段；
//   - 状态面板（`> **[流萤状态同步]**`）如果被摊平成一行行普通文字，读者就分不清
//     「哪几行是一块面板」；
//   - 表格摊成 `· 键：值`（`markdown.ts` 的做法）在「两列」时够用，但三列以上就彻底
//     丢失了列语义，而列对齐是纯文本唯一还能保住的结构信息。
//
// 所以这一层不做「去掉」，做「**视觉化**」（visualize）：把 Markdown 的块级语义换成
// 纯文本里长得最像它的字符——引用块 → `┃` 竖线、标题 → `■/▍/▸` 分级前缀、表格 →
// `│` + `┈` 的等宽对齐、代码块 → `┄┄┄` 夹住的缩进区。同一条内容，观感接近渲染后的
// 效果，而不是源码。
//
// 两层的定位不要混：`toPlainText` 是「塞进按钮标签、单行原因」用的压平器；
// `toRichPlainText` 是「整段正文落地成纯文本通道」用的排版器。
//
// ── 为什么代码块必须**先切段再转换** ────────────────────────────────────────
//
// 这套规则里 `**x**` → `【x】`、`# x` → `■ x`、`` `x` `` → `「x」`、`|` → 表格列。
// 而一段代码里这些字符全是**内容**：
//
//     # 这是 shell 注释          ← 不是 h1
//     **kwargs                   ← 不是粗体
//     x = `pwd`                  ← 不是行内代码
//     a | b                      ← 不是表格列
//
// 逐行跑正则的话，代码会被改成一眼看不出原意的怪东西，用户复制出去直接不能用——
// 这比不渲染严重得多。所以顺序铁律是：**先把围栏块与行内代码整体摘成占位符，
// 再对「剩下的普通段落」做转换，最后把代码原样（代码块只加缩进）放回去**。
// 占位符用 `\u0000N\u0000`，正常正文里不可能出现这个字符，不会被误伤。
//
// 同理，`shardMarkdown` 也必须在**切段**层面工作而不是在字符层面：围栏围到一半被
// 切断，前半片是「代码区」后半片是「普通段落」，两边都会被下游按错误的语义处理。
//
// ── 与既有文件的关系 ────────────────────────────────────────────────────────
//
// `markdown.ts` 里的 `FENCE` / `INLINE_CODE` / `protect` 是**模块私有**的，`render.ts`
// 的 `sliceInto` 同样私有，而本模块的交付范围只允许新增文件、不改既有文件，所以这里
// 保留了一份最小实现。两份的判定口径必须保持一致（`^```+` 围栏、同行反引号配对、
// `\u0000` 占位符），改动任何一边都要同步另一边。

/** 三种落地方式，由通道决定用哪条轨。 */
export type MdRenderMode = 'native_md' | 'auto_fallback' | 'plain'

/**
 * `maxChars <= 0` 时的兜底预算。
 *
 * 刻意**不**复用 `render.ts` 的 `DEFAULT_SHARD_CHARS`（1200）：那个数是纯文本通道
 * 「一条消息能塞多少字」的上界；这里是富文本预算，调用方给 0 表示「你替我定」，
 * 取 1500 是个偏保守但明显比 1200 宽松的默认值。两者用途不同，合并会让人误以为
 * 改一个就同时改了两个通道。
 */
export const DEFAULT_RICH_MAX_CHARS = 1500

/** 围栏：` ``` ` 或 `~~~`，捕获缩进、围栏本身、info string（语言）。 */
const FENCE = /^(\s*)(```+|~~~+)(.*)$/
/** 围栏收尾行：只有围栏、没有 info string。 */
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/
/** 行内代码。同 `markdown.ts`：不跨行——落单的反引号不该吃掉后面几行。 */
const INLINE_CODE = /(`+)([^`\n]*?)\1/g
/** 占位符。正常正文里不会出现 `\u0000`。 */
const PLACEHOLDER = /\u0000(\d+)\u0000/g
/** 表格分隔行：只由 `-` `:` `|` 与空白组成，且至少一个 `-`。 */
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|?\s*$/
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
/** 删除线。内容必须以非空白开头结尾，否则 `~~ ~~` 这种噪声也会被当成标记。 */
const STRIKE = /~~(?=\S)([\s\S]*?\S)~~/g
/**
 * 粗体。**必须在斜体之前**判断，且用惰性匹配让 `**a *b* c**` 中的内层 `*b*` 保持原样。
 * 同理 `(?=\S)…(?<=\S)`（这里用 `\S` 收尾的写法）挡掉 `2 ** 3 ** 4` 这类算式。
 */
const BOLD = /\*\*(?=\S)([\s\S]*?\S)\*\*/g
/** 引用行前缀。`>>` 嵌套也一起吃，因为纯文本里嵌套没有可用符号。 */
const QUOTE_PREFIX = /^>\s?/
/** 标题。允许结尾的 `##` 收尾写法（`## 标题 ##`）。 */
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
/** 无序列表项。必须有空白：`*动作*` 是斜体不是列表。 */
const BULLET = /^(\s*)[-*+]\s+/

// ---------------------------------------------------------------------------
// 主入口：Markdown → 高保真纯文本
// ---------------------------------------------------------------------------

/**
 * 把 Markdown **视觉化**成纯文本。
 *
 * 处理顺序（顺序本身就是正确性的一半，别调换）：
 *   1. 围栏代码块整块摘出 → 缩进 + `┄┄┄` 包裹，内部一个字符都不改；
 *   2. 表格整块识别（表头 + 分隔行 + 数据行必须相邻）→ 按显示列宽对齐；
 *   3. 逐行处理块级标记：引用 → `┃` 区块、标题 → `■/▍/▸`、列表 → `· `；
 *   4. 行内：先摘行内代码 → 图片/链接/删除线/粗体 → 还原成 `「」`；
 *   5. 收尾：折叠连续空行、去掉首尾空行。
 */
export function toRichPlainText(markdown: string): string {
  if (!markdown) return ''
  const source = markdown.replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  const out: string[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string

    // ① 围栏代码块：整块优先，先把边界吃掉再决定怎么排。
    const fence = FENCE.exec(line)
    if (fence) {
      const ticks = fence[2] as string
      const lang = firstToken(fence[3] ?? '')
      const body: string[] = []
      i += 1
      while (i < lines.length) {
        const next = lines[i] as string
        i += 1
        if (isFenceClose(next, ticks)) break
        body.push(next)
      }
      pushBlock(out, codeBlock(lang, body))
      continue
    }

    // ② 表格：必须整块识别，逐行看是认不出来的。
    if (line.includes('|') && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line)
      i += 2 // 跳过表头与分隔行
      const rows: string[][] = []
      while (i < lines.length) {
        const row = lines[i] as string
        if (!row.includes('|') || row.trim().length === 0) break
        rows.push(splitRow(row))
        i += 1
      }
      pushBlock(out, renderTable(header, rows))
      continue
    }

    // ③ 引用块：连续 `>` 行聚成一块，首尾各留一个空行（由 pushBlock 保证）。
    if (isQuoteLine(line)) {
      const block: string[] = []
      while (i < lines.length && isQuoteLine(lines[i] as string)) {
        // 面板里的每一行仍然是 Markdown：列表项要换 `·`、粗体要换【】，所以走的还是
        // 普通行那套装饰，只是多了个 `┃` 边框。空行只留边框，不留尾随空格。
        const inner = decorateLine(stripQuote(lines[i] as string))
        block.push(inner.length > 0 ? `┃ ${inner}` : '┃')
        i += 1
      }
      pushBlock(out, block)
      continue
    }

    // ④ 标题：层级用三种前缀表达。`■`（1~2 级）与 `▍`（3 级）必须一眼能分开，
    //    否则 `##` 和 `###` 在纯文本里就退化成同一个东西了。
    const heading = HEADING.exec(line)
    if (heading) {
      const level = (heading[1] as string).length
      const text = inlineRich((heading[2] as string).replace(/[ \t]+$/, ''))
      const marks = level <= 2 ? '■' : level === 3 ? '▍' : '▸'
      pushBlock(out, [`${marks} ${text}`])
      i += 1
      continue
    }

    // ⑤ 普通行（含分隔线、列表项）。行尾空白在这里就去掉，收尾不再做全局 strip，
    //    免得把代码块内的行尾空白一起吃了。
    pushLine(out, decorateLine(line))
    i += 1
  }

  return collapseBlankLines(out)
}

/** 普通行的块级装饰：无序列表换 `·`，有序列表与分隔线原样。 */
function decorateLine(line: string): string {
  const trimmed = line.replace(/[ \t]+$/, '')
  if (trimmed.trim().length === 0) return ''
  return inlineRich(trimmed.replace(BULLET, '$1· '))
}

// ---------------------------------------------------------------------------
// 块级
// ---------------------------------------------------------------------------

/**
 * 代码块 → `┄┄┄ <lang>` / 每行缩进两格 / `┄┄┄`。
 *
 * **内容一个字符都不改**：只加左侧两个空格的缩进，缩进是排版、不是内容。
 * 空行也照样缩进成两个空格——这样它们在后面的空行折叠里不会被当成「块间空行」吃掉。
 */
function codeBlock(lang: string, body: readonly string[]): string[] {
  const block = [lang.length > 0 ? `┄┄┄ ${lang}` : '┄┄┄']
  for (const line of body) block.push(line.length > 0 ? `  ${line}` : '  ')
  block.push('┄┄┄')
  return block
}

/**
 * 表格 → `│` 竖线 + 按显示列宽右补空格的等宽文本，表头下面压一条 `┈` 横线。
 *
 * 这里和 `markdown.ts` 的 `tableLines` 是**两种取向**，不是重复实现：
 *   - `tableLines` 丢掉表头、把首列当键（`· 键：值`），因为它服务的是单行场景（按钮
 *     标签、审批原因），空间只有一个 ``·`` 的位置；
 *   - 这里保留表头并保住列，因为它服务的是整段正文，列对齐是纯文本里唯一还剩下的
 *     表格语义。表头行是不是噪音，取决于列数——两列时可以扔，三列以上扔了就没人
 *     知道第二列是什么。
 *
 * 列宽用 `displayWidth`（CJK 记两列）算，不是 `length`：中文在等宽/半等宽混排里
 * 占两格，用码点算会让中文列全部歪掉。
 */
function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const matrix: string[][] = [header.map(cellOf), ...rows.map((row) => row.map(cellOf))]
  const columns = matrix.reduce((max, row) => Math.max(max, row.length), 0)
  if (columns === 0) return []

  const widths: number[] = []
  for (let column = 0; column < columns; column += 1) {
    let width = 0
    for (const row of matrix) width = Math.max(width, displayWidth(row[column] ?? ''))
    widths.push(width)
  }

  const line = (row: readonly string[]): string => {
    const cells: string[] = []
    for (let column = 0; column < columns; column += 1) {
      const text = row[column] ?? ''
      cells.push(text + ' '.repeat(Math.max(0, (widths[column] as number) - displayWidth(text))))
    }
    return `│ ${cells.join(' │ ')} │`
  }

  const ruleWidth = widths.reduce((sum, width) => sum + width, 0) + 3 * (columns - 1) + 4
  const rule = '┈'.repeat(ruleWidth)
  const rendered: string[] = []
  matrix.forEach((row, index) => {
    if (row.every((cell) => cell.length === 0)) return
    if (index === 1) rendered.push(rule)
    rendered.push(line(row))
  })
  return rendered
}

/** 表格单元格：先做行内转换，再算宽度——占位符还原成 `「x」` 会改变显示宽度。 */
function cellOf(cell: string): string {
  return inlineRich(cell.trim()).trim()
}

function isTableSeparator(line: string | undefined): boolean {
  // 必须同时有 `-` 和 `|`：单独一行 `---` 是分隔线，不能因为上一行碰巧含 `|` 就当表头。
  if (typeof line !== 'string' || !line.includes('-') || !line.includes('|')) return false
  return TABLE_SEPARATOR.test(line)
}

/** 拆一行表格。`\|` 是单元格内的转义竖线，不能当分隔符。 */
function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split(/(?<!\\)\|/)
}

function isQuoteLine(line: string): boolean {
  return /^\s{0,3}>/.test(line)
}

function stripQuote(line: string): string {
  let text = line
  while (QUOTE_PREFIX.test(text)) text = text.replace(QUOTE_PREFIX, '')
  return text
}

// ---------------------------------------------------------------------------
// 行内
// ---------------------------------------------------------------------------

/**
 * 行内标记 → 纯文本观感。
 *
 * 先把行内代码摘成占位符，是因为下面每一条规则都会碰反引号里的内容：`` `**a**` ``
 * 应该原样保留 `**a**`，先摘后放才能做到。
 *
 * 斜体**故意不处理**：`*轻轻拨弄了一下发丝*` 是 RP 态的约定俗成动作标记，星号本身
 * 就是它的一部分，去掉反而看不懂了。粗体走 `【】`，因为 QQ 纯文本里没有第二种更
 * 接近「加粗」的观感。粗体先于斜体判断（惰性匹配），所以 `**粗**` 不会被切成两段
 * 斜体；反过来先判断斜体的话，`**a**` 会变成 `*a*`。
 */
function inlineRich(text: string): string {
  const codes: string[] = []
  let out = text.replace(INLINE_CODE, (_match, _ticks: string, code: string) => {
    codes.push(code.trim())
    return `\u0000${codes.length - 1}\u0000`
  })

  out = out
    // 图片放在链接前：`![a](b)` 的后半截也满足链接正则，先跑链接会留下一个 `!`。
    .replace(IMAGE, (_match, alt: string) => alt.trim() || '图片')
    .replace(LINK, (_match, label: string, url: string) => {
      const caption = label.trim()
      return caption.length === 0 || caption === url ? url : `${caption}（${url}）`
    })
    .replace(STRIKE, (_match, body: string) => `（删除线）${body}`)
    // 面板标题常写成 `**[流萤状态同步]**`：方括号与【】表达的是同一件事（「这是个
    // 标签」），叠在一起就成了 `【[流萤状态同步]】`，所以先剥掉外面那层方括号。
    .replace(BOLD, (_match, body: string) => `【${stripBracketLabel(body)}】`)

  return out.replace(PLACEHOLDER, (_match, index: string) => `「${codes[Number(index)] ?? ''}」`)
}

/**
 * 粗体内容被一对方括号整个包住时剥掉它，避免 `【[标题]】` 这种双层括号。
 *
 * 只剥**最外层一对**，且要求里层不再出现 `[`——否则 `**[a][b]**` 这类引用式链接的
 * 残留会被误伤。剥完仍然保留原文的空格去向由 `trim` 决定。
 */
function stripBracketLabel(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length < 2) return trimmed
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return trimmed
  const inner = trimmed.slice(1, -1)
  return inner.includes('[') ? trimmed : inner
}

// ---------------------------------------------------------------------------
// 拼装
// ---------------------------------------------------------------------------

/** 独立块（代码块 / 表格 / 引用块 / 标题）：前后各留一个空行。 */
function pushBlock(out: string[], block: readonly string[]): void {
  if (block.length === 0) return
  if (out.length > 0 && (out[out.length - 1] as string) !== '') out.push('')
  out.push(...block)
  out.push('')
}

function pushLine(out: string[], line: string): void {
  out.push(line)
}

/** 折叠连续空行、去掉首尾空行。代码块内的空行是 `'  '`，不会被这里吃掉。 */
function collapseBlankLines(lines: readonly string[]): string {
  const collapsed: string[] = []
  for (const line of lines) {
    if (line === '' && collapsed.length > 0 && (collapsed[collapsed.length - 1] as string) === '') continue
    collapsed.push(line)
  }
  while (collapsed.length > 0 && (collapsed[0] as string) === '') collapsed.shift()
  while (collapsed.length > 0 && (collapsed[collapsed.length - 1] as string) === '') collapsed.pop()
  return collapsed.join('\n')
}

// ---------------------------------------------------------------------------
// 分片
// ---------------------------------------------------------------------------

interface Block {
  kind: 'code' | 'text'
  text: string
}

/**
 * 按 `maxChars` 切分 Markdown。
 *
 * 优先级：段落边界 → 行边界 → 硬切。**围栏代码块是不可分割的原子**：它要么整块在
 * 一个分片里，要么（超过预算时）单独占一片——宁可让那一片超长，也不把代码从中间
 * 劈开。理由见文件头：劈开之后两半的「语义种类」都变了，下游无论是渲染还是执行都
 * 会读错。
 *
 * 每个分片收尾都过一遍 `balanceFences`：模型输出被截断时围栏本来就没闭合，那一段
 * 在纯文本通道里看起来就是一份没关的代码，补一个闭合围栏比留着强。
 */
export function shardMarkdown(markdown: string, maxChars: number): string[] {
  const budget = normalizeBudget(maxChars)
  const source = (markdown ?? '').replace(/\r\n?/g, '\n')
  if (source.trim().length === 0) return []

  const shards: string[] = []
  const blocks = splitBlocks(source)
  let current: string[] = []

  // 块之间用**空行**连接：切块本来就是按空行切的，用 `\n` 连回去会把段落并成一片，
  // 用户收到的就是一堵没有分节的墙。
  const joinBlocks = (blocks_: readonly string[]): string => blocks_.join('\n\n')

  const flush = (): void => {
    if (current.length === 0) return
    shards.push(balanceFences(joinBlocks(current)))
    current = []
  }

  for (const block of blocks) {
    // 长度按**连接后**的形态算（块间两个字符），不能用 `current.join('\n')` 估：
    // 三块以上会少算 (n-1) 个换行，切出来的片就会超过预算。
    if (current.length > 0 && joinBlocks(current).length + 2 + block.text.length > budget) flush()

    // 代码块整块保留：即使它已经超过预算，也不交给按行/硬切的分支。
    if (block.kind === 'code' || block.text.length <= budget) {
      current.push(block.text)
      continue
    }

    // 超长的普通块：先按行切，某一行本身超长时才硬切。
    flush()
    for (const piece of splitLongText(block.text, budget)) shards.push(balanceFences(piece))
  }
  flush()

  return shards.map((shard) => shard.trim()).filter((shard) => shard.length > 0)
}

/** 按**段落边界**分块；围栏代码块内部出现的空行不算段落边界。 */
function splitBlocks(source: string): Block[] {
  const lines = source.split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'text', text: paragraph.join('\n') })
    paragraph = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    const fence = FENCE.exec(line)
    if (fence) {
      // 围栏块必须整块取出，连同未闭合的那些行一起。
      flushParagraph()
      const ticks = fence[2] as string
      const code: string[] = [line]
      i += 1
      while (i < lines.length) {
        const next = lines[i] as string
        code.push(next)
        i += 1
        if (isFenceClose(next, ticks)) break
      }
      blocks.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    if (line.trim().length === 0) {
      flushParagraph()
      i += 1
      continue
    }
    paragraph.push(line)
    i += 1
  }
  flushParagraph()
  return blocks
}

/** 普通块的次级切分：优先整行，单行超长才硬切。 */
function splitLongText(text: string, budget: number): string[] {
  const pieces: string[] = []
  let acc: string[] = []

  for (const line of text.split('\n')) {
    if (line.length > budget) {
      if (acc.length > 0) {
        pieces.push(acc.join('\n'))
        acc = []
      }
      for (let offset = 0; offset < line.length; offset += budget) pieces.push(line.slice(offset, offset + budget))
      continue
    }
    if (acc.length > 0 && acc.join('\n').length + 1 + line.length > budget) {
      pieces.push(acc.join('\n'))
      acc = []
    }
    acc.push(line)
  }
  if (acc.length > 0) pieces.push(acc.join('\n'))
  return pieces
}

/**
 * 补闭合围栏。
 *
 * 只在**源里本来就没闭合**（模型输出被截断、或者调用方把一片内容截半）时生效。
 * 正常的代码块由它自己的收尾行关闭，这里什么都不做。
 */
function balanceFences(text: string): string {
  let open: string | null = null
  for (const line of text.split('\n')) {
    if (open === null) {
      const fence = FENCE.exec(line)
      if (fence) open = fence[2] as string
      continue
    }
    if (isFenceClose(line, open)) open = null
  }
  return open === null ? text : `${text}\n${open}`
}

function isFenceClose(line: string, open: string): boolean {
  const match = FENCE_CLOSE.exec(line)
  if (!match) return false
  const ticks = match[1] as string
  return ticks[0] === open[0] && ticks.length >= open.length
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

export interface RenderPlan {
  mode: MdRenderMode
  /** 原始 Markdown。`plain` 模式下也填——日志与调试要能看到模型到底写了什么。 */
  markdown: string
  /** 高保真纯文本备胎。`native_md` 模式为空串（通道不会回退，留空避免误用）。 */
  fallbackText: string
  shards: { markdown: string[]; text: string[] }
}

/**
 * 一次算清三种模式下的两条轨与各自的分片。
 *
 * 两轨的分片**各切各的**：同一段内容在 Markdown 里带 `## `、`**`、表格分隔行，在
 * 纯文本里带 `■ `、`【】`、`│`，长度根本不同。拿一套偏移量套另一套必然错位，这也是
 * 两条轨都保留独立分片、而不是「切一次两边共用」的原因。
 *
 * `plain` 模式下 `shards.markdown` 是空数组：那条轨不存在，给空数组比给 `[原文]`
 * 诚实——调用方 `shards.markdown.length === 0` 就能判断「这个通道没有 MD 轨」。
 */
export function planRender(markdown: string, options: { mode: MdRenderMode; maxChars: number }): RenderPlan {
  const source = markdown ?? ''
  const budget = normalizeBudget(options.maxChars)

  if (options.mode === 'native_md') {
    return {
      mode: 'native_md',
      markdown: source,
      fallbackText: '',
      shards: { markdown: shardMarkdown(source, budget), text: [] },
    }
  }

  const text = toRichPlainText(source)

  if (options.mode === 'plain') {
    return {
      mode: 'plain',
      markdown: source,
      fallbackText: text,
      shards: { markdown: [], text: shardMarkdown(text, budget) },
    }
  }

  // `auto_fallback`：两条轨都出，谁失败谁顶上。
  return {
    mode: 'auto_fallback',
    markdown: source,
    fallbackText: text,
    shards: { markdown: shardMarkdown(source, budget), text: shardMarkdown(text, budget) },
  }
}

function normalizeBudget(maxChars: number): number {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return DEFAULT_RICH_MAX_CHARS
  return Math.max(1, Math.floor(maxChars))
}

// ---------------------------------------------------------------------------
// 显示宽度
// ---------------------------------------------------------------------------

/**
 * 终端里的显示列宽：CJK / 全角 / 常见 emoji 记 2 列，其余 1 列，组合符 0 列。
 *
 * 表格对齐必须用这个而不是 `String.length`：`项目` 的 `length` 是 2 但占 4 列，
 * 用码点算宽会让所有含中文的列歪成锯齿。
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    // 变体选择符与零宽连接符不占列。
    if (code === 0xfe0f || code === 0x200d || (code >= 0x0300 && code <= 0x036f)) continue
    width += isWideCodePoint(code) ? 2 : 1
  }
  return width
}

function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // 谚文字母
    (code >= 0x2e80 && code <= 0x303e) || // CJK 部首、注音、标点（含 「」）
    (code >= 0x3041 && code <= 0x33ff) || // 假名、CJK 兼容
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 基本区
    (code >= 0xa000 && code <= 0xa4cf) || // 彝文
    (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) || // emoji
    (code >= 0x1f900 && code <= 0x1f9ff)
  )
}

function firstToken(info: string): string {
  const trimmed = info.trim()
  if (trimmed.length === 0) return ''
  return (trimmed.split(/\s+/)[0] as string).replace(/^\{.*\}$/, '')
}
