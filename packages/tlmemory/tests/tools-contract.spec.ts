// packages/tlmemory/tests/tools-contract.spec.ts
// 工具返回契约回归测试（content.some is not a function 崩溃守门人）。
//
// 事故背景：DSH 宿主的工具流水线（@deepseek-ai/dsh-tools 的 createSuccessResult）
// 按以下顺序消费工具：
//   1. snapshotToolValue(tool.name, candidate)   —— 快照 execute 的返回值；
//   2. validateJsonSchemaValue(tool.output.schema, value) —— 按 output.schema 校验；
//   3. tool.output.render(exec.arguments, value) —— **双参**调用，产出 content；
//   4. 之后宿主对 content 调用 .some(...)（见 dsh-tools 内 result.content.some(block => ...)）。
// 因此 output.render 的签名是 (args, value) 且**必须**返回 ContentBlock[]；
// 旧实现写成 (result) => result?.message ?? JSON.stringify(result)，第一个形参实际接到的是
// exec.arguments，于是恒走 JSON.stringify 分支返回**裸字符串**，宿主把它当 content 数组用，
// 在 .some(...) 处抛 TypeError: content.some is not a function，会话随即不可恢复。
//
// 本文件同时钉死三层契约：
//   A. execute 返回值恒为 MCP 信封 { content: [{ type: 'text', text }] }；
//   B. execute 返回值必过 output.schema；
//   C. output.render(args, value) 恒返回合法文本块数组（含旧宿主单位调用的兼容路径）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryDB } from '../src/db.js'
import { registerMemoryTools } from '../src/tools.js'
import type { Context } from 'cordis'

/** 捕获注册的伪宿主工具定义（字段名与 @deepseek-ai/dsh-tools 的 ToolDefinition 对齐） */
interface CapturedTool {
  name: string
  parameters: unknown
  output: {
    schema: Record<string, unknown>
    render: (...args: unknown[]) => unknown
  }
  execute: (args: unknown, exec?: unknown) => Promise<unknown>
}

function createToolHost() {
  const tools: CapturedTool[] = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: {
      register: (definition: unknown) => {
        tools.push(definition as CapturedTool)
        return () => {}
      },
    },
  }
  return { ctx: ctx as unknown as Context, tools, get: (name: string) => tools.find((t) => t.name === name)! }
}

/**
 * 宿主 output.schema 校验的最小复刻（object / array / string / number / boolean /
 * 必填 / items 子集），足以覆盖本插件声明的 schema，避免为单测引入 ajv 依赖。
 */
function validateSchema(schema: any, value: unknown, pointer = 'value'): string[] {
  const violations: string[] = []
  if (schema?.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [`${pointer} must be object`]
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value as object, key)) violations.push(`${pointer}.${key} is required`)
    }
    for (const [key, child] of Object.entries<any>(schema.properties ?? {})) {
      if (Object.hasOwn(value as object, key)) {
        violations.push(...validateSchema(child, (value as any)[key], `${pointer}.${key}`))
      }
    }
  } else if (schema?.type === 'array') {
    if (!Array.isArray(value)) return [`${pointer} must be array`]
    value.forEach((item, index) => violations.push(...validateSchema(schema.items, item, `${pointer}[${index}]`)))
  } else if (schema?.type === 'string') {
    if (typeof value !== 'string') violations.push(`${pointer} must be string`)
  } else if (schema?.type === 'number') {
    if (typeof value !== 'number') violations.push(`${pointer} must be number`)
  } else if (schema?.type === 'boolean') {
    if (typeof value !== 'boolean') violations.push(`${pointer} must be boolean`)
  }
  return violations
}

/** 宿主 createSuccessResult 的消费链：schema 校验 → render(args, value) → content.some(...) */
function runHostPipeline(tool: CapturedTool, args: unknown, value: unknown): unknown[] {
  const violations = validateSchema(tool.output.schema, value)
  expect(violations, `工具 ${tool.name} 的返回值不符合 output.schema`).toEqual([])
  const content = tool.output.render(args, value)
  expect(Array.isArray(content), `工具 ${tool.name} 的 output.render 必须返回数组`).toBe(true)
  const blocks = content as Array<{ type?: unknown; text?: unknown }>
  // 宿主首个消费动作就是 content.some(...)：旧实现在此抛 content.some is not a function
  expect(() => blocks.some((block) => block.type === 'image')).not.toThrow()
  for (const block of blocks) {
    expect(block.type, `工具 ${tool.name} 的 render 产出块必须为 text`).toBe('text')
    expect(typeof block.text, `工具 ${tool.name} 的 render 产出 text 必须为字符串`).toBe('string')
  }
  return blocks
}

const SAVE_ARGS = {
  tree_scope: 'project' as const,
  path_segments: ['工程化', '包管理'],
  rule_name: 'pnpm依赖构建放行',
  content: 'pnpm 11 原生构建放行键统一写 allowBuilds 映射',
  keywords: ['pnpm', 'allowBuilds'],
}

describe('tlmemory 工具返回契约（MCP/DSH 规范）', () => {
  let db: MemoryDB
  let host: ReturnType<typeof createToolHost>
  let dispose: () => void

  beforeEach(() => {
    db = new MemoryDB(':memory:')
    host = createToolHost()
    dispose = registerMemoryTools(host.ctx, db, () => 'repo:testscope')
  })

  afterEach(() => {
    dispose()
    db.close()
  })

  it('注册了 tlmemory_save / tlmemory_query / tlmemory_delete 三个工具', () => {
    expect(host.tools.map((t) => t.name).sort()).toEqual([
      'tlmemory_delete',
      'tlmemory_query',
      'tlmemory_save',
    ])
  })

  it('tlmemory_save 的 execute 返回规范信封且通过 output.schema', async () => {
    const tool = host.get('tlmemory_save')
    const result: any = await tool.execute(SAVE_ARGS)

    expect(Array.isArray(result.content)).toBe(true)
    expect(result.content.length).toBeGreaterThan(0)
    for (const block of result.content) {
      expect(block.type).toBe('text')
      expect(typeof block.text).toBe('string')
    }
    expect(result.content[0].text).toContain('记忆已成功入库')

    runHostPipeline(tool, SAVE_ARGS, result)
  })

  it('tlmemory_query 的 execute 返回规范信封且通过 output.schema', async () => {
    const save = host.get('tlmemory_save')
    await save.execute(SAVE_ARGS)

    const tool = host.get('tlmemory_query')
    const result: any = await tool.execute({ query: 'pnpm 依赖构建放行' })

    expect(Array.isArray(result.content)).toBe(true)
    for (const block of result.content) {
      expect(block.type).toBe('text')
      expect(typeof block.text).toBe('string')
    }
    expect(result.content[0].text).toContain('pnpm')

    runHostPipeline(tool, { query: 'pnpm 依赖构建放行' }, result)
  })

  it('tlmemory_query 空结果仍返回合法信封（不得返回裸字符串或空数组）', async () => {
    const tool = host.get('tlmemory_query')
    const result: any = await tool.execute({ query: '绝不存在的检索词zzz' })

    runHostPipeline(tool, { query: '绝不存在的检索词zzz' }, result)
    expect(result.content[0].text.length).toBeGreaterThan(0)
  })

  it('output.render 兼容旧宿主单位调用（render(value)）且恒不返回裸字符串', () => {
    for (const tool of host.tools) {
      const rendered = tool.output.render({ content: [{ type: 'text', text: 'legacy' }] })
      expect(Array.isArray(rendered)).toBe(true)
      expect((rendered as any[])[0]).toEqual({ type: 'text', text: 'legacy' })
    }
  })

  it('output.render 对畸形输入（字符串 / 裸对象 / null）仍收敛为文本块数组', () => {
    const tool = host.get('tlmemory_save')
    const cases: unknown[] = [
      'plain string',
      { status: 'success', message: '裸对象消息' },
      null,
      undefined,
      { content: 'not-an-array' },
      42,
    ]
    for (const candidate of cases) {
      const rendered = tool.output.render(SAVE_ARGS, candidate)
      expect(Array.isArray(rendered)).toBe(true)
      const blocks = rendered as Array<{ type: string; text: string }>
      expect(blocks.length).toBeGreaterThan(0)
      expect(blocks[0]!.type).toBe('text')
      expect(typeof blocks[0]!.text).toBe('string')
      expect(() => blocks.some((b) => b.type === 'image')).not.toThrow()
    }
  })
})

describe('tlmemory 工具作用域动态感知（v0.6.6 防漂移）', () => {
  let db: MemoryDB
  let host: ReturnType<typeof createToolHost>
  let dispose: () => void
  /** resolver 收到的 session 线索（按调用次序） */
  const seenSessions: unknown[] = []

  beforeEach(() => {
    db = new MemoryDB(':memory:')
    host = createToolHost()
    seenSessions.length = 0
    dispose = registerMemoryTools(host.ctx, db, (session) => {
      seenSessions.push(session)
      // 会话携带孤儿工作区线索时返回降级后的合法 scope（由装配层保证）
      const dir = (session as { workspaceDir?: string } | undefined)?.workspaceDir
      return dir === 'C:/Users/ZhuanZ' ? 'repo:safefallback' : 'repo:session-resolved'
    })
  })

  afterEach(() => {
    dispose()
    db.close()
  })

  it('execute 第二参（exec 上下文）携带 session 时按会话解析作用域', async () => {
    const tool = host.get('tlmemory_save')
    await tool.execute(SAVE_ARGS, { session: { workspaceDir: 'D:/Code/my-dsh-plugins' } })

    expect(seenSessions).toEqual([{ workspaceDir: 'D:/Code/my-dsh-plugins' }])
    // 落库 scope 是会话解析结果，而非进程级固定值
    expect(db.getNodesByScope('repo:session-resolved').filter((n) => n.is_leaf === 1)).toHaveLength(1)
  })

  it('嵌套形态 exec.context.session 同样被识别', async () => {
    const tool = host.get('tlmemory_save')
    await tool.execute(SAVE_ARGS, { context: { session: { workspaceDir: 'C:/Users/ZhuanZ' } } })

    expect(seenSessions).toEqual([{ workspaceDir: 'C:/Users/ZhuanZ' }])
    expect(db.getNodesByScope('repo:safefallback').filter((n) => n.is_leaf === 1)).toHaveLength(1)
  })

  it('不传 exec（历史宿主单参调用）时 session 为 undefined，resolver 仍被调用', async () => {
    const tool = host.get('tlmemory_save')
    await tool.execute(SAVE_ARGS)

    expect(seenSessions).toEqual([undefined])
    expect(db.getNodesByScope('repo:session-resolved').filter((n) => n.is_leaf === 1)).toHaveLength(1)
  })

  it('tlmemory_query 的 project 范围检索同样按会话解析作用域', async () => {
    const save = host.get('tlmemory_save')
    await save.execute(SAVE_ARGS, { session: { workspaceDir: 'D:/Code/my-dsh-plugins' } })

    const query = host.get('tlmemory_query')
    seenSessions.length = 0
    const result: any = await query.execute({ query: 'pnpm 依赖构建放行', scope: 'project' }, { session: null })

    // session: null 经 extractExecSession 探测后回退为 undefined（鸭子类型守卫）
    expect(seenSessions).toEqual([undefined])
    expect(result.content[0].text).toContain('pnpm')
  })
})

describe('tlmemory_delete 受控删除（v0.6.11）', () => {
  let db: MemoryDB
  let host: ReturnType<typeof createToolHost>
  let dispose: () => void

  /** 造一条记忆（默认落当前工程作用域） */
  const seed = async (treeScope: 'project' | 'global' = 'project') => {
    const save = host.get('tlmemory_save')
    const result: any = await save.execute({ ...SAVE_ARGS, tree_scope: treeScope })
    return result
  }

  beforeEach(() => {
    db = new MemoryDB(':memory:')
    host = createToolHost()
    dispose = registerMemoryTools(host.ctx, db, () => 'repo:testscope')
  })

  afterEach(() => {
    dispose()
    db.close()
  })

  it('confirm 非布尔 true 时一律拒绝（字符串 "true" 也不行）', async () => {
    await seed()
    const tool = host.get('tlmemory_delete')
    const leaf = db.getAllNodes().find((n) => n.is_leaf === 1)!

    const missing: any = await tool.execute({ id: leaf.id })
    expect(missing.content[0].text).toContain('confirm')
    expect(db.getNode(leaf.id)).not.toBeNull()

    await tool.execute({ id: leaf.id, confirm: 'true' })
    expect(db.getNode(leaf.id)).not.toBeNull()
  })

  it('confirm: true 时按 id 删除叶子记忆，返回规范信封', async () => {
    await seed()
    const tool = host.get('tlmemory_delete')
    const leaf = db.getAllNodes().find((n) => n.is_leaf === 1)!
    const args = { id: leaf.id, confirm: true }

    const result: any = await tool.execute(args)

    expect(db.getNode(leaf.id)).toBeNull()
    expect(result.content[0].text).toContain('已删除记忆')
    runHostPipeline(tool, args, result)
  })

  it('拒绝删除分类目录（is_leaf=0 会级联清空整棵子树）', async () => {
    await seed()
    const tool = host.get('tlmemory_delete')
    const dir = db.getAllNodes().find((n) => n.is_leaf === 0)!
    const result: any = await tool.execute({ id: dir.id, confirm: true })

    expect(db.getNode(dir.id)).not.toBeNull()
    expect(result.content[0].text).toContain('分类目录')
  })

  it('跨作用域守卫：默认拒绝 global 记忆，显式 allow_cross_scope 才放行', async () => {
    await seed('global')
    const tool = host.get('tlmemory_delete')
    const globalLeaf = db.getAllNodes('global').find((n) => n.is_leaf === 1)!

    const refused: any = await tool.execute({ id: globalLeaf.id, confirm: true })
    expect(db.getNode(globalLeaf.id)).not.toBeNull()
    expect(refused.content[0].text).toContain('allow_cross_scope')

    const allowed: any = await tool.execute({ id: globalLeaf.id, confirm: true, allow_cross_scope: true })
    expect(db.getNode(globalLeaf.id)).toBeNull()
    expect(allowed.content[0].text).toContain('已删除记忆')
  })

  it('无 id 时按 rule_name 在作用域内定位删除', async () => {
    await seed()
    const tool = host.get('tlmemory_delete')

    const result: any = await tool.execute({ rule_name: SAVE_ARGS.rule_name, confirm: true })

    expect(result.content[0].text).toContain('已删除记忆')
    expect(db.getAllNodes().filter((n) => n.is_leaf === 1)).toHaveLength(0)
  })

  it('同名命中多条时拒绝猜测，返回候选 id 要求改用 id 重试', async () => {
    db.upsertLeaf('repo:testscope', ['一类'], '同名规则', '断言一', ['k'], { source: 'manual' })
    db.upsertLeaf('repo:testscope', ['二类'], '同名规则', '断言二', ['k'], { source: 'manual' })
    const tool = host.get('tlmemory_delete')

    const result: any = await tool.execute({ rule_name: '同名规则', confirm: true })

    expect(result.content[0].text).toContain('无法确定唯一目标')
    expect(result.content[0].text).toContain('id=')
    expect(db.getAllNodes('repo:testscope').filter((n) => n.name === '同名规则')).toHaveLength(2)
  })

  it('目标不存在时返回说明性文本而非抛错', async () => {
    const tool = host.get('tlmemory_delete')

    const byId: any = await tool.execute({ id: '不存在的id', confirm: true })
    expect(byId.content[0].text).toContain('未找到')

    const byName: any = await tool.execute({ rule_name: '从未记录过的规则', confirm: true })
    expect(byName.content[0].text).toContain('未在当前范围找到')

    const neither: any = await tool.execute({ confirm: true })
    expect(neither.content[0].text).toContain('必须提供 id 或 rule_name')
  })

  it('tlmemory_query 结果附带节点 id，供删除工具精确定位', async () => {
    await seed()
    const query = host.get('tlmemory_query')

    const result: any = await query.execute({ query: 'pnpm 依赖构建放行' })

    expect(result.content[0].text).toContain('id: ')
  })
})
