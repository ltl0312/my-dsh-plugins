// packages/tlnotify/tests/markdown.spec.ts
//
// 这一层存在的理由只有一个：QQ 是纯文本、飞书的 lark_md 只认内联子集，模型写的
// Markdown 在手机上全是源码。所以这里断言的都是「用户会看到什么」，不是「正则对不对」。
//
// 最后两组用例是回归护栏，别删：
//   - 顺序约束：表格必须在 `oneLine()` **之前**压平，折成一行就再也认不出表头；
//   - 非幂等：`toPlainText` 压两遍会吃掉代码里的 `#` / `-` / `**`。

import { describe, expect, it } from 'vitest'
import { toPlainText } from '../src/markdown.js'

describe('toPlainText', () => {
  it('空输入返回空串', () => {
    expect(toPlainText('')).toBe('')
  })

  it('把一次真实的入库汇报压成纯文本', () => {
    const report = [
      '## 入库结果（项目作用域 `repo:20b4f5252df2`）',
      '',
      '共 **15 条断言**，按路径分类：',
      '',
      '| 分类 | 记忆条目 |',
      '|---|---|',
      '| **架构** | 拾光技术栈与事实源 · WikiLink三级匹配 |',
      '| **部署** | 生产部署为PM2非Docker |',
      '',
      '**验证**：以「部署 踩坑 生产 PM2 watcher frontmatter」回读，命中全部关键条目（得分 3.1–7.5）✅',
    ].join('\n')

    expect(toPlainText(report)).toBe(
      [
        '【入库结果（项目作用域 repo:20b4f5252df2）】',
        '',
        '共 15 条断言，按路径分类：',
        '',
        '· 架构：拾光技术栈与事实源 · WikiLink三级匹配',
        '· 部署：生产部署为PM2非Docker',
        '',
        '验证：以「部署 踩坑 生产 PM2 watcher frontmatter」回读，命中全部关键条目（得分 3.1–7.5）✅',
      ].join('\n'),
    )
  })

  it('六种标题都变成【】', () => {
    expect(toPlainText('# 一级\n## 二级\n### 三级\n###### 六级')).toBe('【一级】\n【二级】\n【三级】\n【六级】')
    expect(toPlainText('## 带井号结尾 ##')).toBe('【带井号结尾】')
  })

  it('表格丢掉表头行，首列当键，其余列用 · 连接', () => {
    const table = ['| 项目 | 状态 | 负责人 |', '|:---|---:|:---:|', '| 上线 | 完成 | 甲 |', '| 回归 | 进行中 | 乙 |'].join(
      '\n',
    )
    expect(toPlainText(table)).toBe('· 上线：完成 · 甲\n· 回归：进行中 · 乙')
  })

  it('没有外层竖线的表格也能认出来', () => {
    expect(toPlainText(['分类 | 条目', '--- | ---', '架构 | x'].join('\n'))).toBe('· 架构：x')
  })

  it('单列表格退化成一行 · 键', () => {
    expect(toPlainText(['| 只有一列 |', '|---|', '| 甲 |', '| 乙 |'].join('\n'))).toBe('· 甲\n· 乙')
  })

  it('单元格内的转义竖线不算分隔符', () => {
    // 第二列里的 `\|` 是内容，不能被当成单元格边界切开（切错了会变成 `· a：x` + 多一列）。
    expect(toPlainText(['| 键 | 值 |', '|---|---|', '| a | x \\| y |'].join('\n'))).toBe('· a：x | y')
    // 整行只有一个单元格时，退化成 `· 内容`。
    expect(toPlainText(['| 表达式 |', '|---|', '| a \\| b |'].join('\n'))).toBe('· a | b')
  })

  it('分隔线不会因为上一行含竖线就被当成表格', () => {
    // `---` 是分隔线。如果 `isTableSeparator` 只认 `-`，这两行会被一起吞掉。
    expect(toPlainText('用 a | b 表示或\n\n---\n\n正文')).toBe('用 a | b 表示或\n\n正文')
  })

  it('围栏代码块内容原样保留，只丢掉围栏与语言标记', () => {
    const source = ['```bash', '# 安装依赖', 'pnpm add -D vitest', '```'].join('\n')
    expect(toPlainText(source)).toBe('# 安装依赖\npnpm add -D vitest')
  })

  it('代码块里的表格与强调标记不会被误伤', () => {
    const source = ['```', '| a | b |', '|---|---|', '**不是加粗**', '```'].join('\n')
    expect(toPlainText(source)).toBe('| a | b |\n|---|---|\n**不是加粗**')
  })

  it('波浪号围栏同样处理', () => {
    expect(toPlainText('~~~\ncode\n~~~')).toBe('code')
  })

  it('行内代码去掉反引号，但保留代码里的标记', () => {
    expect(toPlainText('用 `**kwargs` 传参，`a | b` 是或')).toBe('用 **kwargs 传参，a | b 是或')
  })

  it('行内代码不跨行，落单的反引号不会吃掉后面几行', () => {
    expect(toPlainText('一个 ` 落单\n第二行还有 **粗**')).toBe('一个 ` 落单\n第二行还有 粗')
  })

  it('加粗 / 斜体 / 删除线去标记留文字', () => {
    expect(toPlainText('**粗** *斜* ~~删~~ ***两者***')).toBe('粗 斜 删 两者')
  })

  it('下划线强调与嵌套强调收敛', () => {
    expect(toPlainText('__粗__ 和 **a *b* c**')).toBe('粗 和 a b c')
  })

  it('普通算式里的星号不会被当成强调', () => {
    expect(toPlainText('2 * 3 * 4 = 24')).toBe('2 * 3 * 4 = 24')
  })

  it('链接留文字带 url，图片只留 alt', () => {
    expect(toPlainText('[文档](https://x.dev/a)')).toBe('文档（https://x.dev/a）')
    expect(toPlainText('![架构图](https://x.dev/a.png)')).toBe('架构图')
    expect(toPlainText('![](https://x.dev/a.png)')).toBe('图片')
    expect(toPlainText('[https://x.dev/a](https://x.dev/a)')).toBe('https://x.dev/a')
  })

  it('无序列表统一成 ·，有序列表原样保留', () => {
    expect(toPlainText('- 甲\n* 乙\n+ 丙')).toBe('· 甲\n· 乙\n· 丙')
    expect(toPlainText('1. 甲\n2. 乙')).toBe('1. 甲\n2. 乙')
  })

  it('引用前缀与分隔线去掉', () => {
    expect(toPlainText('> 引用一行\n\n---\n\n正文')).toBe('引用一行\n\n正文')
  })

  it('HTML 标签去掉，<br> 变换行，实体解码', () => {
    expect(toPlainText('<div>甲</div><br>乙 &amp; 丙&nbsp;丁')).toBe('甲\n乙 & 丙 丁')
  })

  it('自动链接 <https://…> 不会被当成 HTML 标签吃掉', () => {
    expect(toPlainText('见 <https://x.dev/a>')).toBe('见 <https://x.dev/a>')
  })

  it('非幂等：压两遍会吃掉代码块里的标记', () => {
    const once = toPlainText('```\n# 注释\n- 参数\n```')
    expect(once).toBe('# 注释\n- 参数')
    // 第二遍把这些当成真标记了——这正是 render.ts 末尾不统一兜底的原因。
    expect(toPlainText(once)).toBe('【注释】\n· 参数')
  })
})
