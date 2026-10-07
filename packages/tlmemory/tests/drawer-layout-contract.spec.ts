// packages/tlmemory/tests/drawer-layout-contract.spec.ts
// 缺陷 3（打开记忆详情时整页横向位移约半屏）的**布局不变量**，源码与构建产物双向钉死：
//
//   1. 详情抽屉是视口级浮层：Teleport 到 body + position: fixed + 贴右（right: 0）。
//      只要它是 body 的直接子节点，「祖先 transform / will-change 造成的 fixed
//      定位基准漂移」这一整类缺陷就不可能发生（Teleport 把这条约束固化下来）。
//   2. 文档本身**不可能**出现横向可滚动区域（html / body overflow-x: hidden）。
//      在应用自身不对容器施加 transform 的前提下，「整个界面横向位移」只可能来自
//      文档级横向滚动（scrollLeft > 0）；这条规则把它确定性封死 —— 横向滚动需求
//      一律落在内部滚动容器（.tlm-main-inner / .tlm-drawer-body / .tlm-md-pre）。
//   3. 源码与 web/dist 已构建产物必须同时满足：构建产物陈旧（改完源码没重新构建）
//      同样会被这条用例抓住。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceCssPath = path.join(packageDir, 'web/src/style.css')
const drawerVuePath = path.join(packageDir, 'web/src/components/MemoryDetailDrawer.vue')
const assetsDir = path.join(packageDir, 'web/dist/assets')

/** 取一条简单规则（无嵌套花括号）的声明体；找不到返回空串 */
function declarationsOf(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  return match?.[1] ?? ''
}

function builtCss(): { file: string; css: string } | null {
  if (!fs.existsSync(assetsDir)) return null
  const file = fs
    .readdirSync(assetsDir)
    .filter((name) => name.endsWith('.css'))
    .sort()
    .at(-1)
  if (file === undefined) return null
  return { file, css: fs.readFileSync(path.join(assetsDir, file), 'utf8') }
}

describe('缺陷 3 布局不变量：详情抽屉是视口级浮层，文档不得横向滚动', () => {
  const sourceCss = fs.readFileSync(sourceCssPath, 'utf8')

  it('抽屉源码：Teleport 到 body + 固定贴右浮层', () => {
    const vue = fs.readFileSync(drawerVuePath, 'utf8')
    expect(vue).toContain('<Teleport to="body">')
    expect(vue).toContain('class="tlm-drawer"')
    expect(vue).toContain('role="dialog"')

    const drawer = declarationsOf(sourceCss, '.tlm-drawer')
    expect(drawer).not.toBe('')
    expect(drawer).toContain('position: fixed')
    expect(drawer).toMatch(/right:\s*0/)
    // 抽屉宽度仍是「内容自适应」而不是被固定成视口宽：贴右定位才有意义
    expect(drawer).toContain('var(--tlm-drawer-width)')
  })

  it('源码：html / body 都不允许横向滚动（横向位移只能来自文档级滚动）', () => {
    expect(declarationsOf(sourceCss, 'html')).toContain('overflow-x: hidden')
    expect(declarationsOf(sourceCss, 'body')).toContain('overflow-x: hidden')
  })

  it('构建产物：同一组不变量必须已经落到 web/dist（防止「改了源码没重新构建」）', () => {
    const built = builtCss()
    if (built === null) {
      console.warn('[drawer-layout-contract] 未找到 web/dist 构建产物，请先执行 `pnpm --dir web run build`')
      return
    }
    const drawer = declarationsOf(built.css, '.tlm-drawer')
    expect(drawer, `${built.file} 应包含 .tlm-drawer 规则`).not.toBe('')
    expect(drawer).toContain('position:fixed')
    expect(drawer).toMatch(/right:\s*0/)
    // html 与 body 两条规则各一次（minifier 会分别保留）
    expect((built.css.match(/overflow-x:\s*hidden/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
