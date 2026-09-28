// packages/tlsearch/src/sanitize.ts
//
// 「降噪 + 降 Token」清洗层。所有进入模型上下文的外部文本都必须先经过这里。
//
// 为什么必须有这一层：搜索引擎返回的 title/description 常年携带
//   - HTML 高亮标签（Brave 的 description 默认带 <strong>…</strong>，甚至整段 <p>）
//   - HTML 实体（&amp; &quot; &#39; &nbsp; &#x27; —— 一个 &#x27; 就是 6 个 token 换 1 个字符）
//   - 换行/制表/零宽字符（同一段文字多出若干行，纯属浪费）
//   - 埋点参数（?utm_source=…&utm_campaign=…&fbclid=… 单条 URL 可多出上百字符）
// 这些都让「同一份信息」在上下文里膨胀数倍。清洗是确定性的、零成本的。

/**
 * 常见命名实体表。
 *
 * 只收录搜索摘要里高频出现的实体：完整 HTML5 实体表有 2000+ 项，引入它属于
 * 「为了极少数情况付出一张常驻表的代价」，与本插件目标相悖。未收录的命名实体
 * 原样保留（宁可留着 `&foo;`，也不猜错成别的字符），数字实体则走通用分支全量支持。
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  euro: '€',
  pound: '£',
  yen: '¥',
  sect: '§',
  para: '¶',
  bull: '•',
  prime: '′',
}

/** 实体匹配：命名实体或数字实体（十进制 / 十六进制） */
const ENTITY_PATTERN = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g

/**
 * 解码 HTML 实体。
 *
 * 越界码点（0、代理区、> U+10FFFF）与无法解析的数字一律**原样保留**：
 * 静默替换成 U+FFFD 会让摘要里凭空多出一个不可解释的字符。
 */
export function decodeEntities(input: string): string {
  return input.replace(ENTITY_PATTERN, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const digits = isHex ? body.slice(2) : body.slice(1)
      const code = Number.parseInt(digits, isHex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      // 代理区码点无法由 fromCodePoint 产出合法字符，直接原样保留
      if (code >= 0xd800 && code <= 0xdfff) return match
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * 剥离 HTML 标签与不可见内容。
 *
 * 先用 `<[^>]*>` 通吃所有标签（含带属性的开闭标签、自闭合标签），并单独处理
 * script/style/注释 —— 这些标签的**正文**必须整块丢弃，否则 `<style>` 里的
 * CSS 规则会变成一段毫无意义的摘要。
 */
export function stripHtml(input: string): string {
  return input
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
}

/**
 * 折叠空白：把连续空白（含 NBSP / 零宽空格 / BOM）压成单个空格并去首尾。
 *
 * \u200b（零宽空格）、\u200c-\u200d（零宽连接符）、\ufeff（BOM）在视觉上不可见，
 * 却会各自计费，且会让同一段文本在两次搜索结果里「看起来不同」而破坏去重。
 */
export function collapseWhitespace(input: string): string {
  return input.replace(/[\s\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, ' ').trim()
}

/**
 * 文本清洗主入口：剥标签 → 解实体 → 折空白。
 *
 * 顺序不可颠倒：先剥标签再解实体，`&lt;script&gt;` 这类**被转义的**标记会
 * 变成字面量 `<script>` 文本而非被二次剥离，摘要内容保持忠实。
 * 非字符串输入返回空串（引擎偶发返回 null，不应把 `null` 字符串化后写进上下文）。
 */
export function cleanText(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return ''
  return collapseWhitespace(decodeEntities(stripHtml(input)))
}

/**
 * 按字符上限截断，并尽量落在词边界上。
 *
 * 返回长度不超过 limit + 1（多出的 1 个字符是省略号）。词边界回退带 60% 下限：
 * 若最近的空格出现在前 40% 位置，说明这更像「中文/无空格长串里偶然的一个空格」，
 * 此时按原样硬截，避免为了凑词边界而丢掉大半内容。
 */
export function truncateText(input: string, limit: number): string {
  const max = Math.max(1, Math.floor(limit))
  if (input.length <= max) return input
  const head = input.slice(0, max)
  const boundary = head.search(/\s\S*$/)
  const cut = boundary > max * 0.6 ? head.slice(0, boundary) : head
  const trimmed = cut.trimEnd()
  return trimmed.length > 0 ? `${trimmed}…` : '…'
}

/** 清洗 + 截断的复合步骤：单条摘要的标准处理路径 */
export function cleanSnippet(input: unknown, limit: number): string {
  const cleaned = cleanText(input)
  return cleaned.length === 0 ? '' : truncateText(cleaned, limit)
}

/** 标题清洗：同样剥标签解实体，但**不截断**（标题本就是短文本，截断反而伤引用准确性） */
export function cleanTitle(input: unknown): string {
  return cleanText(input)
}

/**
 * 埋点参数黑名单（小写精确匹配）。
 *
 * 只收录「纯追踪、绝不参与内容寻址」的参数。刻意**不**收录 `ref` / `source` /
 * `page` / `id` 这类可能承载真实语义的参数 —— 若某个站点确实用 `?ref=` 决定
 * 展示内容，删掉它就等于把模型送到错误的页面，这是比省 token 更坏的结局。
 * `utm_*` 前缀另行匹配。
 */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'dclid',
  'msclkid',
  'yclid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'srsltid',
  'spm',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'vero_id',
  'oly_anon_id',
  'oly_enc_id',
])

/**
 * 归一化 URL：剔除纯埋点查询参数，保留路径、其余查询参数与 hash。
 *
 * 三个刻意的保守设计：
 *   1. 非 http(s) 协议、解析失败的字符串一律**原样返回**（搜到的 URL 再难看也比
 *      丢失或改写后指向别处强）；
 *   2. 只有在确实删掉了参数时才回写序列化结果 —— 否则 `https://example.com`
 *      会被 URL 规范化成 `https://example.com/`，制造无意义的外观漂移；
 *   3. 保留 hash：文档站常用 `#section` 做段落定位，删掉它就丢了精度。
 */
export function normalizeUrl(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return trimmed
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return trimmed

  let removed = false
  // 先取键快照再删除：边遍历边改 searchParams 会漏掉相邻参数
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase()
    if (TRACKING_PARAMS.has(lower) || lower.startsWith('utm_')) {
      parsed.searchParams.delete(key)
      removed = true
    }
  }
  return removed ? parsed.toString() : trimmed
}
