// packages/tlmemory/src/tools.ts
// 主动记忆工具箱：向 ctx.tools 注册 tlmemory_save / tlmemory_query，
// 提供入参白名单校验，并返回副作用注销闭包（Disposer）以支持热重载回滚。
import type { Context } from 'cordis'
import type { MemoryDB } from './db.js'
import type { SaveMemoryArgs, QueryMemoryArgs } from './types.js'

/** 路径分段白名单正则，拦截 ../ ./ 空字节与转义通配符 */
const SEGMENT_SANITIZER = /[^a-zA-Z0-9_\u4e00-\u9fa5]/g

function assertSaveArgs(args: unknown): asserts args is SaveMemoryArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('[tlmemory] tlmemory_save 入参必须为对象')
  }
  const candidate = args as Record<string, unknown>
  if (candidate.tree_scope !== 'global' && candidate.tree_scope !== 'project') {
    throw new Error('[tlmemory] tlmemory_save 入参校验失败: tree_scope 必须为 global 或 project')
  }
  if (!Array.isArray(candidate.path_segments) || candidate.path_segments.some((s) => typeof s !== 'string')) {
    throw new Error('[tlmemory] tlmemory_save 入参校验失败: path_segments 必须为字符串数组')
  }
  if (typeof candidate.rule_name !== 'string' || candidate.rule_name.trim().length === 0) {
    throw new Error('[tlmemory] tlmemory_save 入参校验失败: rule_name 必须为非空字符串')
  }
  if (typeof candidate.content !== 'string' || candidate.content.trim().length === 0) {
    throw new Error('[tlmemory] tlmemory_save 入参校验失败: content 必须为非空原子断言文本')
  }
  if (!Array.isArray(candidate.keywords) || candidate.keywords.some((k) => typeof k !== 'string')) {
    throw new Error('[tlmemory] tlmemory_save 入参校验失败: keywords 必须为字符串数组')
  }
}

function assertQueryArgs(args: unknown): asserts args is QueryMemoryArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('[tlmemory] tlmemory_query 入参必须为对象')
  }
  const candidate = args as Record<string, unknown>
  if (typeof candidate.query !== 'string' || candidate.query.trim().length === 0) {
    throw new Error('[tlmemory] tlmemory_query 入参校验失败: query 必须为非空检索文本')
  }
  if (
    candidate.scope !== undefined &&
    candidate.scope !== 'all' &&
    candidate.scope !== 'global' &&
    candidate.scope !== 'project'
  ) {
    throw new Error('[tlmemory] tlmemory_query 入参校验失败: scope 必须为 all / global / project')
  }
  if (candidate.limit !== undefined && (typeof candidate.limit !== 'number' || candidate.limit < 1)) {
    throw new Error('[tlmemory] tlmemory_query 入参校验失败: limit 必须为正整数')
  }
}

export function registerMemoryTools(
  ctx: Context,
  db: MemoryDB,
  resolveCurrentScope: () => string,
): () => void {
  if (!ctx.tools?.register) {
    ctx.logger?.warn?.('[tlmemory] ctx.tools 未就绪，跳过工具注册')
    return () => {}
  }

  const unregisterSave = ctx.tools.register({
    name: 'tlmemory_save',
    description: '显式将重要用户规范、技术架构约束或踩坑避坑断言持久化至长期记忆树中',
    parameters: {
      tree_scope: {
        type: 'string',
        enum: ['global', 'project'],
        description: '作用域：global 属于跨工程全局偏好，project 属于当前仓库专属规约',
        required: true,
      },
      path_segments: {
        type: 'array',
        items: { type: 'string' },
        description: '树形分类路径段，例如 ["工程化", "包管理"]',
        required: true,
      },
      rule_name: {
        type: 'string',
        description: '规则简述标题，例如 "pnpm依赖构建放行"',
        required: true,
      },
      content: {
        type: 'string',
        description: '原子断言文本，严格限制在40至80字符以内，禁止包含多余代码块',
        required: true,
      },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: '检索关键词列表',
        required: true,
      },
    },
    async execute(args: unknown) {
      assertSaveArgs(args)
      const targetTree = args.tree_scope === 'global' ? 'global' : resolveCurrentScope()
      const sanitizedSegments = args.path_segments
        .map((s) => s.replace(SEGMENT_SANITIZER, ''))
        .filter(Boolean)
      const sanitizedName = args.rule_name.replace(SEGMENT_SANITIZER, '')
      const boundedContent = args.content.trim().slice(0, 80)

      if (sanitizedSegments.length === 0) {
        throw new Error('[tlmemory] tlmemory_save 入参净化失败: path_segments 净化后为空')
      }
      if (!sanitizedName) {
        throw new Error('[tlmemory] tlmemory_save 入参净化失败: rule_name 净化后为空')
      }

      const node = db.upsertLeaf(
        targetTree,
        sanitizedSegments,
        sanitizedName,
        boundedContent,
        args.keywords || [sanitizedName],
      )

      return {
        status: 'success',
        message: `记忆已成功入库 [${node.tree_type}]: ${node.path}${node.name}`,
        node_id: node.id,
      }
    },
  })

  const unregisterQuery = ctx.tools.register({
    name: 'tlmemory_query',
    description: '通过 FTS5 Trigram 全文索引检索与当前任务紧密相关的长期记忆断言',
    parameters: {
      query: {
        type: 'string',
        description: '查询文本或技术关键字',
        required: true,
      },
      scope: {
        type: 'string',
        enum: ['all', 'global', 'project'],
        description: '查询范围，默认 all 覆盖全局与当前工程',
      },
      limit: {
        type: 'number',
        description: '最大检索结果数，默认 5',
      },
    },
    async execute(args: unknown) {
      assertQueryArgs(args)
      const currentScope = resolveCurrentScope()
      let treeType: string | undefined
      if (args.scope === 'global') treeType = 'global'
      if (args.scope === 'project') treeType = currentScope

      const results = db.search(args.query, {
        treeType,
        limit: args.limit ?? 5,
      })

      return {
        status: 'success',
        hits_count: results.length,
        memories: results.map((r) => ({
          tree: r.tree_type === 'global' ? '全局偏好' : '当前工程',
          path: `${r.path}${r.name}`,
          content: r.content,
          score: r.score,
        })),
      }
    },
  })

  return () => {
    unregisterSave()
    unregisterQuery()
  }
}