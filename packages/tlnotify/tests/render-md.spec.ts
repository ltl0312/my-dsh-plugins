// packages/tlnotify/tests/render-md.spec.ts
//
// 断言的都是「用户在 QQ 纯文本里**看到**什么」，不是「正则写没写对」。
//
// 两组护栏别删：
//   - 代码块先切段：`**` / `#` / 反引号在代码里是内容，被转换了就等于把用户要复制的
//     代码改坏了；
//   - 代码块不可分割：分片把围栏从中间劈开，两半的语义种类都会变。

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RICH_MAX_CHARS,
  displayWidth,
  planRender,
  shardMarkdown,
  toRichPlainText,
} from '../src/render-md.js'

/** 数一个分片里的围栏行，奇偶性用来判断有没有留下未闭合的代码块。 */
function fenceCount(text: string): number {
  return text.split('\n').filter((line) => /^\s*(`{3,}|~{3,})/.test(line)).length
}

describe('toRichPlainText：引用块', () => {
  it('状态面板变成竖线区块，块前后各留一个空行', () => {
    const panel = [
      '前文',
      '',
      '> **[流萤状态同步]**',
      '> - **当前所处**：天台',
      '> - 内心OS：风很凉',
      '',
      '后文',
    ].join('\n')

    const out = toRichPlainText(panel)

    expect(out).toBe(
      [
        '前文',
        '',
        '┃ 【流萤状态同步】',
        '┃ · 【当前所处】：天台',
        '┃ · 内心OS：风很凉',
        '',
        '后文',
      ].join('\n'),
    )
  })

  it('嵌套引用也只吃前缀，正文完整保留', () => {
    expect(toRichPlainText('>> 引用里的引用')).toBe('┃ 引用里的引用')
  })
})

describe('toRichPlainText：标题', () => {
  it('按层级给出 ■ / ▍ / ▸，且 ## 与 ### 一眼可分', () => {
    const out = toRichPlainText('# 一级\n## 二级\n### 三级\n#### 四级')

    expect(out).toBe('■ 一级\n\n■ 二级\n\n▍ 三级\n\n▸ 四级')
    expect(out.includes('■ 二级')).toBe(true)
    expect(out.includes('▍ 三级')).toBe(true)
    expect(out.includes('■ 三级')).toBe(false)
  })

  it('结尾带井号的标题也能剥干净', () => {
    expect(toRichPlainText('## 带井号结尾 ##')).toBe('■ 带井号结尾')
  })
})

describe('toRichPlainText：代码块必须是内容不是标记', () => {
  const code = ['# 汇报', '', '```python', '**不是粗体**', '# 不是标题', 'x = `pwd`', '```'].join('\n')

  it('代码里的 ** 与 # 原样保留，语言被标注，内容缩进两格', () => {
    const out = toRichPlainText(code)

    expect(out).toBe(['■ 汇报', '', '┄┄┄ python', '  **不是粗体**', '  # 不是标题', '  x = `pwd`', '┄┄┄'].join('\n'))
    expect(out.includes('【不是粗体】')).toBe(false)
  })

  it('代码块里的表格竖线不会被当成表格', () => {
    const out = toRichPlainText(['```sql', 'select a | b from t', '```'].join('\n'))
    expect(out).toContain('  select a | b from t')
  })
})

describe('toRichPlainText：行内标记', () => {
  it('行内代码变「」，且里面的 ** 不转换', () => {
    expect(toRichPlainText('执行 `pnpm **test**` 看看')).toBe('执行 「pnpm **test**」 看看')
  })

  it('粗体变【】，斜体动作的星号原样保留', () => {
    expect(toRichPlainText('**已完成** 和 *轻轻拨弄了一下发丝*')).toBe('【已完成】 和 *轻轻拨弄了一下发丝*')
    expect(toRichPlainText('*微微偏头，看向天台的边缘*')).toBe('*微微偏头，看向天台的边缘*')
  })

  it('粗体不会被误判成两个斜体', () => {
    const out = toRichPlainText('**重点**')
    expect(out).toBe('【重点】')
    expect(out.includes('*')).toBe(false)
  })

  it('链接、删除线、列表', () => {
    expect(toRichPlainText('[文档](https://x.test/a) 见 ~~旧版~~')).toBe(
      '文档（https://x.test/a） 见 （删除线）旧版',
    )
    expect(toRichPlainText('- 甲\n- 乙\n* 丙\n1. 丁')).toBe('· 甲\n· 乙\n· 丙\n1. 丁')
  })
})

describe('toRichPlainText：表格对齐', () => {
  it('保留表头、按显示列宽补空格、分隔行变 ┈ 横线', () => {
    const table = ['| 项目 | 状态 |', '|---|---|', '| 上线 | 完成 |', '| 回归修复 | 进行中 |'].join('\n')
    const lines = toRichPlainText(table).split('\n')

    expect(lines[0]).toBe('│ 项目     │ 状态   │')
    expect(lines[2]).toBe('│ 上线     │ 完成   │')
    expect(lines[3]).toBe('│ 回归修复 │ 进行中 │')
    expect(lines[1]?.startsWith('┈┈')).toBe(true)
    // 每行的显示宽度必须一致，否则手机上就是锯齿。
    const widths = lines.filter((line) => line.startsWith('│')).map(displayWidth)
    expect(new Set(widths).size).toBe(1)
  })

  it('三列表格每一列都对齐', () => {
    const table = ['| a | 名称 | c |', '|:-|:-:|-:|', '| 1 | 长名字 | 3 |', '| 22 | x | 444 |'].join('\n')
    const rows = toRichPlainText(table)
      .split('\n')
      .filter((line) => line.startsWith('│'))

    expect(rows).toHaveLength(3)
    expect(new Set(rows.map(displayWidth)).size).toBe(1)
    expect(rows[0]).toContain('名称')
  })
})

describe('toRichPlainText：空白规整', () => {
  it('连续空行压成一个，行尾空白去掉', () => {
    expect(toRichPlainText('正文   \n\n\n\n下一段  ')).toBe('正文\n\n下一段')
  })

  it('空输入返回空串', () => {
    expect(toRichPlainText('')).toBe('')
  })
})

describe('shardMarkdown', () => {
  it('在段落边界分片，每片不超预算且内容不丢', () => {
    const paragraphs = Array.from({ length: 6 }, (_unused, index) => `第${index}段${'文字'.repeat(25)}`)
    const source = paragraphs.join('\n\n')

    const shards = shardMarkdown(source, 120)

    expect(shards.length).toBeGreaterThan(1)
    for (const shard of shards) expect(shard.length).toBeLessThanOrEqual(120)
    for (const paragraph of paragraphs) {
      expect(shards.some((shard) => shard.includes(paragraph))).toBe(true)
    }
  })

  it('围栏代码块永远不跨分片', () => {
    const body = Array.from({ length: 40 }, (_unused, index) => `const v${index} = ${index}`)
    const code = ['```ts', ...body, '```'].join('\n')
    const source = `开头一段${'字'.repeat(40)}\n\n${code}\n\n结尾一段${'字'.repeat(40)}`

    const shards = shardMarkdown(source, 120)

    expect(shards.length).toBeGreaterThan(1)
    const holder = shards.find((shard) => shard.includes('```ts'))
    expect(holder).toBeDefined()
    // 同一个分片里既有开栏也有闭栏，且最后一行代码在里面。
    expect(fenceCount(holder as string) % 2).toBe(0)
    expect(holder as string).toContain('const v39 = 39')
    expect((holder as string).includes('```')).toBe(true)
  })

  it('超长代码块整块独立成片，并且补上闭合围栏', () => {
    const body = Array.from({ length: 30 }, (_unused, index) => `line ${index}`)
    const source = ['```ts', ...body].join('\n')

    const shards = shardMarkdown(source, 80)

    expect(shards).toHaveLength(1)
    expect(fenceCount(shards[0] as string)).toBe(2)
    expect((shards[0] as string).endsWith('```')).toBe(true)
  })

  it('单行超长时硬切，且不留下空片', () => {
    const shards = shardMarkdown('字'.repeat(300), 100)
    expect(shards).toHaveLength(3)
    for (const shard of shards) expect(shard.length).toBeLessThanOrEqual(100)
  })

  it('预算非法时按 1500 兜底', () => {
    const source = Array.from({ length: 40 }, () => '内容'.repeat(30)).join('\n\n')
    const fallback = shardMarkdown(source, 0)
    expect(fallback.length).toBe(shardMarkdown(source, DEFAULT_RICH_MAX_CHARS).length)
    expect(fallback.length).toBeGreaterThan(1)
    expect(shardMarkdown(source, -5)).toEqual(fallback)
  })

  it('空内容返回空数组', () => {
    expect(shardMarkdown('', 100)).toEqual([])
    expect(shardMarkdown('   \n\n  ', 100)).toEqual([])
  })
})

describe('planRender', () => {
  const source = ['## 标题', '', '**重点**'].join('\n')
  const rich = '■ 标题\n\n【重点】'

  it('native_md：原样给 Markdown，不产纯文本备胎', () => {
    const plan = planRender(source, { mode: 'native_md', maxChars: 1500 })

    expect(plan.mode).toBe('native_md')
    expect(plan.markdown).toBe(source)
    expect(plan.fallbackText).toBe('')
    expect(plan.shards.markdown).toEqual([source])
    expect(plan.shards.text).toEqual([])
  })

  it('plain：markdown 留档但 md 轨分片为空，text 轨是排版后的正文', () => {
    const plan = planRender(source, { mode: 'plain', maxChars: 1500 })

    expect(plan.markdown).toBe(source)
    expect(plan.fallbackText).toBe(rich)
    expect(plan.shards.markdown).toEqual([])
    expect(plan.shards.text).toEqual([rich])
  })

  it('auto_fallback：两条轨都产出', () => {
    const plan = planRender(source, { mode: 'auto_fallback', maxChars: 1500 })

    expect(plan.fallbackText).toBe(rich)
    expect(plan.shards.markdown).toEqual([source])
    expect(plan.shards.text).toEqual([rich])
  })

  it('两条轨各切各的：Markdown 更长的段落片数可能不同', () => {
    const table = ['| a | b |', '|---|---|', ...Array.from({ length: 8 }, (_unused, index) => `| ${index} | 值 |`)]
    const plan = planRender(table.join('\n'), { mode: 'auto_fallback', maxChars: 60 })

    expect(plan.shards.markdown.length).toBeGreaterThan(1)
    expect(plan.shards.text.length).toBeGreaterThan(1)
    // 纯文本版带 │ 与补位空格，本来就比 Markdown 版长。
    expect(plan.fallbackText.length).not.toBe(plan.markdown.length)
  })

  it('maxChars <= 0 时两种轨都按 1500 兜底', () => {
    const long = Array.from({ length: 40 }, () => '内容'.repeat(30)).join('\n\n')
    const zero = planRender(long, { mode: 'auto_fallback', maxChars: 0 })
    const explicit = planRender(long, { mode: 'auto_fallback', maxChars: DEFAULT_RICH_MAX_CHARS })

    expect(zero.shards.markdown.length).toBe(explicit.shards.markdown.length)
    expect(zero.shards.text.length).toBe(explicit.shards.text.length)
    expect(zero.shards.markdown.length).toBeGreaterThan(1)
  })
})
