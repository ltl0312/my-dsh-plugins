// packages/tlsearch/tests/sanitize.spec.ts
//
// 清洗层回归：这些函数决定了「同一份信息」在本插件里占多少 Token，
// 且它们是完全确定性的纯函数，因此必须逐条钉死行为边界
// （尤其是「不该动的内容绝不动」这类保守性约束）。

import { describe, expect, it } from 'vitest'
import {
  cleanSnippet,
  cleanText,
  cleanTitle,
  collapseWhitespace,
  decodeEntities,
  normalizeUrl,
  stripHtml,
  truncateText,
} from '../src/sanitize.js'

describe('decodeEntities', () => {
  it('解码命名实体（大小写不敏感）', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe('a & b <c> "d" \'e\'')
    expect(decodeEntities('&AMP; &Nbsp;')).toBe('&  ')
  })

  it('解码十进制与十六进制数字实体', () => {
    expect(decodeEntities('&#65;&#x42;&#x1F600;')).toBe('AB😀')
  })

  it('越界码点、代理区码点与未知命名实体一律原样保留', () => {
    // ﴿静默替换成 U+FFFD 会让摘要里凭空多出一个不可解释的字符﴿
    expect(decodeEntities('&#0;')).toBe('&#0;')
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;')
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;')
    expect(decodeEntities('&unknownentity;')).toBe('&unknownentity;')
    // 没有分号的裸 & 不是实体，必须留在原地
    expect(decodeEntities('AT&T 与 R&D')).toBe('AT&T 与 R&D')
  })
})

describe('stripHtml', () => {
  it('剥离普通标签', () => {
    expect(cleanText('<p>hi <strong>there</strong></p>')).toBe('hi there')
  })

  it('整块丢弃 script/style/注释的正文', () => {
    expect(stripHtml('<style>p{color:red}</style>text')).toBe(' text')
    expect(stripHtml('<script>evil()</script>ok')).toBe(' ok')
    expect(stripHtml('a<!-- hidden -->b')).toBe('a b')
  })

  it('先剥标签再解实体：被转义的标记只变成字面量文本，不被二次剥离', () => {
    expect(cleanText('&lt;b&gt;not bold&lt;/b&gt;')).toBe('<b>not bold</b>')
  })
})

describe('collapseWhitespace', () => {
  it('折叠连续空白并去首尾', () => {
    expect(collapseWhitespace('  a \n\n\t b  ')).toBe('a b')
  })

  it('不可见字符一并折叠（它们各自计费却不显示）', () => {
    expect(collapseWhitespace('a\u00a0b\u200bc')).toBe('a b c')
  })
})

describe('cleanText', () => {
  it('非字符串输入返回空串', () => {
    expect(cleanText(null)).toBe('')
    expect(cleanText(undefined)).toBe('')
    expect(cleanText(42)).toBe('')
    expect(cleanText({})).toBe('')
  })

  it('复合清洗：标签 + 实体 + 空白', () => {
    expect(cleanText('<p>Hello&nbsp;<strong>World</strong></p>\n')).toBe('Hello World')
  })
})

describe('truncateText', () => {
  it('未超限时原样返回', () => {
    expect(truncateText('hello world', 100)).toBe('hello world')
    expect(truncateText('hello', 5)).toBe('hello')
  })

  it('超限时回退到词边界并追加省略号', () => {
    expect(truncateText('hello world', 8)).toBe('hello…')
  })

  it('无词边界（中文/长串）时按上限硬截', () => {
    expect(truncateText('abcdefghij', 5)).toBe('abcde…')
    // 「这是一段没有空格的中文摘要文本」取前 6 个字符 → 这是一段没有
    expect(truncateText('这是一段没有空格的中文摘要文本', 6)).toBe('这是一段没有…')
  })

  it('输出长度不超过 limit + 1（省略号本身）', () => {
    for (const limit of [1, 3, 10, 40]) {
      expect(truncateText('x'.repeat(500), limit).length).toBeLessThanOrEqual(limit + 1)
    }
  })

  it('limit 非正数时按 1 处理，绝不返回空串', () => {
    expect(truncateText('abc', 0)).toBe('a…')
    expect(truncateText('', 0)).toBe('')
  })
})

describe('cleanSnippet / cleanTitle', () => {
  it('cleanSnippet = 清洗 + 截断', () => {
    expect(cleanSnippet('<b>hi</b>   there', 250)).toBe('hi there')
    expect(cleanSnippet('<b>hi</b> there', 3)).toBe('hi…')
    expect(cleanSnippet(null, 250)).toBe('')
  })

  it('cleanTitle 只清洗不截断（标题短，截断反而伤引用准确性）', () => {
    const long = 'T'.repeat(400)
    expect(cleanTitle(`<em>${long}</em>`)).toBe(long)
  })
})

describe('normalizeUrl', () => {
  it('剔除纯埋点参数', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x&utm_medium=y&id=1')).toBe(
      'https://example.com/a?id=1',
    )
    expect(normalizeUrl('https://example.com/a?fbclid=z&gclid=w')).toBe('https://example.com/a')
  })

  it('保留可能承载语义的参数与 hash', () => {
    expect(normalizeUrl('https://example.com/a?ref=docs&page=2')).toBe(
      'https://example.com/a?ref=docs&page=2',
    )
    expect(normalizeUrl('https://docs.example.com/guide#install')).toBe(
      'https://docs.example.com/guide#install',
    )
  })

  it('无参数可删时逐字节原样返回（不做无意义的 URL 规范化）', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
    expect(normalizeUrl('  https://example.com/a  ')).toBe('https://example.com/a')
  })

  it('非 http(s) 与非法输入原样返回，非字符串返回空串', () => {
    expect(normalizeUrl('ftp://example.com/x')).toBe('ftp://example.com/x')
    expect(normalizeUrl('not a url')).toBe('not a url')
    expect(normalizeUrl('')).toBe('')
    expect(normalizeUrl(null)).toBe('')
    expect(normalizeUrl(123)).toBe('')
  })
})
