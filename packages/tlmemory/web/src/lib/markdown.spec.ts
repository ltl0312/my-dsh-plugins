// packages/tlmemory/web/src/lib/markdown.spec.ts
// 记忆正文渲染与简介抽取的单测（纯字符串逻辑，node 环境即可）。
import { describe, it, expect } from 'vitest'
import { escapeHtml, extractSummary, renderMarkdown, sanitizeHref } from './markdown'

describe('renderMarkdown', () => {
  it('渲染标题 / 加粗 / 列表 / 行内代码等基础语法', () => {
    const output = renderMarkdown('# 标题\n\n正文 **加粗** 与 `code`\n\n- 甲\n- 乙\n')
    expect(output).toContain('<h1>标题</h1>')
    expect(output).toContain('<strong>加粗</strong>')
    expect(output).toContain('<code class="tlm-md-code">code</code>')
    expect(output).toContain('<li>甲</li>')
  })

  it('围栏代码块保留原文且语言标识经转义', () => {
    const output = renderMarkdown('```ts\nconst a = 1 < 2\n```\n')
    expect(output).toContain('<pre class="tlm-md-pre"><code class="language-ts">')
    expect(output).toContain('const a = 1 &lt; 2')
    expect(output).not.toContain('<script')
  })

  it('原始 HTML 一律转义为文本，不进入 DOM 解析路径', () => {
    const output = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>')
    // 不能存在任何未转义的标签（转义后仅剩可见文本）
    expect(output).not.toContain('<script')
    expect(output).not.toContain('<img')
    expect(output).toContain('&lt;script&gt;')
    expect(output).toContain('&lt;img src=x onerror=alert(2)&gt;')
  })

  it('危险协议的链接退化为纯文本，安全链接补 rel/target', () => {
    const output = renderMarkdown('[危险](javascript:alert(1)) 与 [安全](https://example.com/a)')
    expect(output).not.toContain('javascript:')
    expect(output).toContain('危险')
    expect(output).toContain('href="https://example.com/a"')
    expect(output).toContain('rel="noreferrer noopener"')
  })

  it('图片不产出 img 标签（不替正文发起外站请求）', () => {
    const output = renderMarkdown('![追踪像素](https://evil.example/p.png)')
    expect(output).not.toContain('<img')
    expect(output).toContain('tlm-md-imgtext')
    expect(output).toContain('追踪像素')
  })

  it('空正文产出空串（组件据此显示占位）', () => {
    expect(renderMarkdown(null)).toBe('')
    expect(renderMarkdown(undefined)).toBe('')
    expect(renderMarkdown('   \n\n  ')).toBe('')
  })
})

describe('sanitizeHref', () => {
  it('白名单协议与相对路径放行', () => {
    expect(sanitizeHref('https://example.com')).toBe('https://example.com')
    expect(sanitizeHref('http://127.0.0.1:4890/api/nodes')).toBe('http://127.0.0.1:4890/api/nodes')
    expect(sanitizeHref('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(sanitizeHref('/api/nodes')).toBe('/api/nodes')
    expect(sanitizeHref('#section')).toBe('#section')
  })

  it('危险协议与控制字符一律拒绝', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBeUndefined()
    expect(sanitizeHref('JaVaScRiPt:alert(1)')).toBeUndefined()
    expect(sanitizeHref('java\nscript:alert(1)')).toBeUndefined()
    expect(sanitizeHref('data:text/html,<script>')).toBeUndefined()
    expect(sanitizeHref('vbscript:msgbox')).toBeUndefined()
    expect(sanitizeHref('   ')).toBeUndefined()
  })
})

describe('extractSummary', () => {
  it('跳过标题取正文首段，并剥掉 Markdown 结构符号', () => {
    const summary = extractSummary('# 结论\n\n本次修复了 **背景透传** 与 `chevron` 两个问题。\n\n## 细节\n后续内容不应出现')
    expect(summary).toBe('本次修复了 背景透传 与 chevron 两个问题。')
  })

  it('整篇只有标题时退回标题文本', () => {
    expect(extractSummary('# 只有标题')).toBe('只有标题')
    expect(extractSummary('## 二级标题\n\n### 三级标题')).toBe('二级标题')
  })

  it('列表形成的首段也能压成单行', () => {
    expect(extractSummary('- 第一条\n- 第二条\n\n后面段落')).toBe('第一条 第二条')
  })

  it('正文以代码块开头时跳到其后的正文段落', () => {
    expect(extractSummary('```ts\nconst a = 1\n```\n\n真正的说明文字')).toBe('真正的说明文字')
  })

  it('超长内容按上限截断并加省略号', () => {
    const summary = extractSummary('字'.repeat(50), 10)
    expect(summary).toBe(`${'字'.repeat(10)}…`)
  })

  it('链接与图片只保留可见文本', () => {
    expect(extractSummary('参见 [文档](https://example.com)，图见 ![示意](a.png)')).toBe('参见 文档，图见 示意')
  })

  it('空白 / 空值产出空串，分割线不算正文', () => {
    expect(extractSummary(null)).toBe('')
    expect(extractSummary('   \n\n')).toBe('')
    expect(extractSummary('---\n')).toBe('')
  })
})

describe('escapeHtml', () => {
  it('转义五个危险字符', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })
})
