// packages/tlmemory/src/types.ts
// 领域模型与 Cordis 上下文类型合并
// 说明：DSH 宿主将 logger / tools / systemPrompt / llm 等平级服务挂载于共享 Context 之上，
// 此处通过 declare module 对 'cordis' 命名空间执行环境声明合并，防止编译期出现 TS2339 错误。

export type MemoryScope = 'global' | 'project'
export type MemoryCategory = 'preference' | 'architecture' | 'lesson'

export interface MemoryNode {
  id: string
  tree_type: string           // 'global' 或 'repo:<hash>'
  parent_id: string | null
  path: string                // 物化全路径，例如 '/architecture/storage/'
  name: string                // 节点名称，例如 'sqlite配置'
  is_leaf: number             // 0: 分类目录, 1: 记忆叶子
  content: string | null      // 原子断言规则（严格限制在80字以内）
  keywords: string | null     // 关键词，空格分隔
  reinforce_count: number     // 强化权重计数
  is_pinned: number           // 是否强制置顶 (0/1)
  created_at: number
  updated_at: number
}

export interface SearchOptions {
  treeType?: string
  pathPrefix?: string
  limit?: number
}

export interface SearchResult extends MemoryNode {
  score: number
  bm25_rank: number
}

export interface RawReflectionItem {
  tree: 'global' | 'project'
  path_segments: string[]
  name: string
  content: string
  keywords: string[]
}

export interface ReflectionResponse {
  reflections: RawReflectionItem[]
}

/** tlmemory_save 工具入参 */
export interface SaveMemoryArgs {
  tree_scope: 'global' | 'project'
  path_segments: string[]
  rule_name: string
  content: string
  keywords: string[]
}

/** tlmemory_query 工具入参 */
export interface QueryMemoryArgs {
  query: string
  scope?: 'all' | 'global' | 'project'
  limit?: number
}

// 扩展 Cordis 上下文接口，声明宿主服务
declare module 'cordis' {
  interface Context {
    logger?: {
      info: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
    }
    tools?: {
      register: (tool: unknown) => () => void
    }
    systemPrompt?: {
      section: (section: {
        name: string
        order: number
        text: string | ((context: unknown) => string)
        complete?: boolean
      }) => () => void
      variable: (name: string, provider: (context: unknown) => string | undefined) => () => void
    }
    llm?: {
      stream: (options: {
        messages: Array<{ role: string; content: string }>
        temperature?: number
        signal?: AbortSignal
      }) => AsyncIterable<{ type: string; delta?: string; text?: string; content?: string }>
    }
  }
}
