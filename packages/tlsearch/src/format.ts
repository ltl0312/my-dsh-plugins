// packages/tlsearch/src/format.ts
//
// 工具返回契约收敛层 + 结果呈现层。
//
// 契约部分与 tlmemory 的同名实现同源，原因是一次真实事故：
// DSH 宿主的工具流水线按固定次序消费工具——
//   1. snapshotToolValue(name, candidate)        快照 execute 返回值；
//   2. validateJsonSchemaValue(output.schema)    按 output.schema 校验；
//   3. tool.output.render(exec.arguments, value) **双参**调用，产出 content；
//   4. 宿主随后对 content 执行 `.some(block => …)`。
// 若 render 返回裸字符串（例如 JSON.stringify 的结果），第 4 步会抛
// `TypeError: content.some is not a function`，工具链整体崩溃且不可恢复。
// 因此本文件的契约三层钉死：
//   A. execute 恒返回 `{ content: [{ type: 'text', text }] }`；
//   B. 该信封恒满足 output.schema；
//   C. render 恒返回合法文本块数组，对畸形输入与旧宿主单位调用形态都做兜底。

import type { OutputFormat, SearchHit, SearchOutcome } from './types.js'

/** MCP 规范文本内容块（与 dsh-llm 的 TextBlock 逐字段一致） */
export interface ToolTextBlock {
  type: 'text'
  text: string
}

/** MCP/DSH 规范工具返回信封：content 恒为数组 */
export interface ToolResultEnvelope {
  content: ToolTextBlock[]
}

/** 单个文本块字符上限。正常配置下结果总量远低于此，仅作为异常端点的最后防线。 */
const MAX_TOOL_TEXT_CHARS = 60_000

/** 零命中提示里回显查询串的字符上限 */
const QUERY_ECHO_CHARS = 120

/** 截断超长文本，保证 text 恒为可安全落盘的字符串 */
function clampText(text: string): string {
  return text.length > MAX_TOOL_TEXT_CHARS
    ? `${text.slice(0, MAX_TOOL_TEXT_CHARS)}\n…（内容过长，已截断）`
    : text
}

/** JSON 序列化兜底：循环引用 / BigInt / undefined 一律退化为 String()，绝不抛错 */
function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/** 文本块判型守卫：宿主侧只认 { type: 'text', text: string } */
function isTextBlock(value: unknown): value is ToolTextBlock {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'text' &&
    typeof (value as { text?: unknown }).text === 'string'
  )
}

/** 把任意 execute 产出规范化为主机契约信封（全插件唯一的成功返回出口） */
export function toToolResult(result: unknown): ToolResultEnvelope {
  return {
    content: [
      {
        type: 'text',
        text: typeof result === 'string' ? result : safeStringify(result),
      },
    ],
  }
}

/** 从候选值中提取文本块（信封 / 块数组 / 裸字符串 / 带 message 的对象），无果返回空数组 */
function extractTextBlocks(candidate: unknown): ToolTextBlock[] {
  if (typeof candidate === 'string') return [{ type: 'text', text: clampText(candidate) }]
  if (Array.isArray(candidate)) {
    return candidate.filter(isTextBlock).map((block) => ({
      type: 'text' as const,
      text: clampText(block.text),
    }))
  }
  if (typeof candidate === 'object' && candidate !== null) {
    const record = candidate as Record<string, unknown>
    if (Array.isArray(record.content)) return extractTextBlocks(record.content)
    if (typeof record.message === 'string') return [{ type: 'text', text: clampText(record.message) }]
    if (typeof record.text === 'string') return [{ type: 'text', text: clampText(record.text) }]
  }
  return []
}

/**
 * 最终护栏：把任何候选值收敛为合法 ContentBlock[]。
 * 无论输入是信封、块数组、裸字符串、裸对象、null 还是畸形结构，返回值恒为非空数组。
 */
export function toContentBlocks(candidate: unknown): ToolTextBlock[] {
  const blocks = extractTextBlocks(candidate)
  if (blocks.length > 0) return blocks
  return [{ type: 'text', text: clampText(safeStringify(candidate)) }]
}

/** 兼容宿主 render 的双参契约 (args, value) 与历史单位调用 (value) */
export function pickProjectionCandidate(args: unknown, value: unknown): unknown {
  return value === undefined ? args : value
}

/** output.schema：宿主在 render 之前用它校验 execute 的返回值 */
export const TOOL_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    content: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '内容块类型，恒为 text' },
          text: { type: 'string', description: '供模型读取的文本内容' },
        },
        required: ['type', 'text'],
      },
      description: 'MCP 规范内容块数组，至少含一个 text 块',
    },
  },
  required: ['content'],
}

/**
 * 渲染紧凑 Markdown：每条结果最多两行，零填充词、零装饰。
 *
 *   Answer: <可选的一句话答案>
 *
 *   1. 标题 — https://url
      摘要片段
 *
 * 相比原生 web_search 的 `- [标题](url)` + 缩进摘要 + 固定引用指引，
 * 这里省掉了三处纯开销：链接语法的 `[]()` 括号、每条结果的引号包裹、
 * 以及每次调用都重复一遍的整句引用说明（该说明已移入工具描述，只付一次）。
 * 摘要为空时**整行省略**，不会渲染出只有缩进空白的行。
 */
export function renderMarkdown(outcome: SearchOutcome, query: string): string {
  const lines: string[] = []
  if (typeof outcome.answer === 'string' && outcome.answer.length > 0) {
    lines.push(`Answer: ${outcome.answer}`)
    lines.push('')
  }
  if (outcome.hits.length === 0) {
    lines.push(`No results for ${JSON.stringify(query.slice(0, QUERY_ECHO_CHARS))}.`)
    return lines.join('\n')
  }
  outcome.hits.forEach((hit, index) => {
    lines.push(`${index + 1}. ${hit.title} — ${hit.url}`)
    if (hit.snippet.length > 0) lines.push(`   ${hit.snippet}`)
  })
  return lines.join('\n')
}

/** 渲染紧凑 JSON：恒为 `[{ title, url, snippet }]` 的裸数组（答案存在时单独一块） */
export function renderJson(outcome: SearchOutcome): string {
  return JSON.stringify(outcome.hits)
}

/**
 * 结果 → 文本块数组。
 *
 * JSON 模式下答案单独成块（`{"answer":"…"}`），结果块恒为裸数组——
 * 这样「结果形状」不会因为是否附带答案而漂移，解析方无需分情况处理。
 */
export function renderOutcome(outcome: SearchOutcome, format: OutputFormat, query: string): ToolTextBlock[] {
  if (format === 'json') {
    const blocks: ToolTextBlock[] = []
    if (typeof outcome.answer === 'string' && outcome.answer.length > 0) {
      blocks.push({ type: 'text', text: JSON.stringify({ answer: outcome.answer }) })
    }
    blocks.push({ type: 'text', text: renderJson(outcome) })
    return blocks
  }
  return [{ type: 'text', text: renderMarkdown(outcome, query) }]
}

/** 估算一次结果集的上下文成本（字符数），用于日志与 README 的量化对比 */
export function estimateChars(hits: readonly SearchHit[]): number {
  return hits.reduce((total, hit) => total + hit.title.length + hit.url.length + hit.snippet.length, 0)
}
