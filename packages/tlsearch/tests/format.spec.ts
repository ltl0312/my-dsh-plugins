// packages/tlsearch/tests/format.spec.ts
//
// 返回契约与呈现层回归。
//
// 契约部分对应一次真实事故（tlmemory 的 content.some is not a function）：
// 宿主要求 output.render 恒返回 ContentBlock[]，一旦返回裸字符串，
// 工具调用链会在宿主的 `.some(...)` 处崩溃且无法恢复。因此这里对
// 「任何畸形输入都必须收敛为合法非空块数组」做穷举式断言。

import { describe, expect, it } from 'vitest'
import {
  TOOL_RESULT_SCHEMA,
  estimateChars,
  pickProjectionCandidate,
  renderJson,
  renderMarkdown,
  renderOutcome,
  toContentBlocks,
  toToolResult,
} from '../src/format.js'
import type { SearchOutcome } from '../src/types.js'

const outcome: SearchOutcome = {
  hits: [
    { title: 'DeepSeek Harness', url: 'https://ds.example/docs', snippet: 'A compact agent harness.' },
    { title: 'No snippet here', url: 'https://ds.example/empty', snippet: '' },
  ],
}

/** 宿主 render 之后会执行的形状检查：必须是元素为 {type:'text',text} 的非空数组 */
function expectValidBlocks(blocks: unknown): void {
  expect(Array.isArray(blocks)).toBe(true)
  const list = blocks as Array<{ type: string; text: string }>
  expect(list.length).toBeGreaterThan(0)
  for (const block of list) {
    expect(block.type).toBe('text')
    expect(typeof block.text).toBe('string')
  }
}

describe('toToolResult 信封契约', () => {
  it('字符串产出规范信封', () => {
    expect(toToolResult('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] })
  })

  it('非字符串被 JSON 序列化，绝不返回裸对象', () => {
    expect(toToolResult({ a: 1 })).toEqual({ content: [{ type: 'text', text: '{"a":1}' }] })
    expect(toToolResult(null)).toEqual({ content: [{ type: 'text', text: '' }] })
  })

  it('循环引用退化为 String() 而非抛错', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const envelope = toToolResult(cyclic)
    expect(envelope.content[0]!.text).toBe('[object Object]')
  })

  it('信封满足 output.schema 的形状要求', () => {
    const schema = TOOL_RESULT_SCHEMA as {
      required: string[]
      properties: { content: { type: string; items: { required: string[] } } }
    }
    expect(schema.required).toContain('content')
    expect(schema.properties.content.type).toBe('array')
    expect(schema.properties.content.items.required).toEqual(['type', 'text'])
    const envelope = toToolResult('x')
    expect(Array.isArray(envelope.content)).toBe(true)
  })
})

describe('toContentBlocks 最终护栏', () => {
  it('信封 → 块数组', () => {
    expectValidBlocks(toContentBlocks(toToolResult('hi')))
    expect(toContentBlocks(toToolResult('hi'))).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('裸字符串不再原样返回（这正是事故形态）', () => {
    const blocks = toContentBlocks('just a string')
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks).toEqual([{ type: 'text', text: 'just a string' }])
  })

  it('畸形输入一律收敛为合法非空块数组', () => {
    for (const input of [null, undefined, 42, true, {}, [], { content: 'nope' }, { content: [] }]) {
      expectValidBlocks(toContentBlocks(input))
    }
  })

  it('过滤掉非文本块', () => {
    const blocks = toContentBlocks({
      content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'x' }, 'nope'],
    })
    expect(blocks).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('兼容旧实现的 { message } / { text } 形态', () => {
    expect(toContentBlocks({ message: 'm' })).toEqual([{ type: 'text', text: 'm' }])
    expect(toContentBlocks({ text: 't' })).toEqual([{ type: 'text', text: 't' }])
  })
})

describe('pickProjectionCandidate', () => {
  it('双参契约取第二个参数，单位契约取第一个', () => {
    expect(pickProjectionCandidate('args', 'value')).toBe('value')
    expect(pickProjectionCandidate('value', undefined)).toBe('value')
  })
})

describe('renderMarkdown', () => {
  it('每条结果最多两行，摘要为空时整行省略', () => {
    expect(renderMarkdown(outcome, 'dsh')).toBe(
      '1. DeepSeek Harness — https://ds.example/docs\n' +
        '   A compact agent harness.\n' +
        '2. No snippet here — https://ds.example/empty',
    )
  })

  it('零命中给确定性提示并回显查询串', () => {
    expect(renderMarkdown({ hits: [] }, 'nothing here')).toBe('No results for "nothing here".')
  })

  it('零命中时回显被截断的超长查询串', () => {
    const text = renderMarkdown({ hits: [] }, 'q'.repeat(500))
    expect(text.length).toBeLessThan(200)
    expect(text.startsWith('No results for "')).toBe(true)
  })

  it('answer 存在时置于列表之前', () => {
    const text = renderMarkdown({ hits: outcome.hits, answer: '42' }, 'q')
    expect(text.startsWith('Answer: 42\n\n1. ')).toBe(true)
  })

  it('不含链接语法与引号包裹（相比原生 web_search 省下的固定开销）', () => {
    const text = renderMarkdown(outcome, 'q')
    expect(text).not.toContain('](')
    expect(text).not.toContain('"https')
  })
})

describe('renderJson', () => {
  it('恒为 [{ title, url, snippet }] 裸数组', () => {
    expect(JSON.parse(renderJson(outcome))).toEqual(outcome.hits)
    expect(JSON.parse(renderJson({ hits: [] }))).toEqual([])
  })
})

describe('renderOutcome', () => {
  it('markdown 模式恒为单个文本块', () => {
    const blocks = renderOutcome(outcome, 'markdown', 'q')
    expect(blocks).toHaveLength(1)
    expectValidBlocks(blocks)
  })

  it('json 模式无 answer 时单块且为裸数组', () => {
    const blocks = renderOutcome(outcome, 'json', 'q')
    expect(blocks).toHaveLength(1)
    expect(JSON.parse(blocks[0]!.text)).toEqual(outcome.hits)
  })

  it('json 模式有 answer 时答案单独成块，结果块形状不漂移', () => {
    const blocks = renderOutcome({ hits: outcome.hits, answer: '42' }, 'json', 'q')
    expect(blocks).toHaveLength(2)
    expect(JSON.parse(blocks[0]!.text)).toEqual({ answer: '42' })
    expect(JSON.parse(blocks[1]!.text)).toEqual(outcome.hits)
  })
})

describe('estimateChars', () => {
  it('累加标题 + URL + 摘要字符数', () => {
    expect(estimateChars([{ title: 'ab', url: 'cd', snippet: 'efg' }])).toBe(7)
    expect(estimateChars([])).toBe(0)
  })
})
