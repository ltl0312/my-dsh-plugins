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

// ---------------------------------------------------------------------------
// DSH 会话事件契约（与 @deepseek-ai/dsh-session 的 SessionEvent 结构逐字段对齐）
// 说明：宿主以追加式事件日志发布 'session/event'（firehose），持久化插件官方推荐
// 订阅该事件流（dsh-session 文档：Persistence is a plugin concern — subscribe to
// `session/event`）。事件统一形状为 { type, seq, time, data }，此处仅声明本插件
// 消费的子集；结构采用最小化鸭子类型，避免对宿主包产生硬依赖。
// ---------------------------------------------------------------------------

/** DSH 内容块：模型可见消息统一由 ContentBlock[] 构成 */
export interface SessionTextBlock {
  type: 'text'
  text: string
}

/** 消息来源：仅 kind === 'user' 表示真实人类输入（其余为插件注入上下文/工具结果） */
export interface SessionMessageSource {
  kind: 'user' | 'plugin' | 'model' | 'tool' | (string & {})
}

/** 会话事件统一信封 */
export interface SessionEventEnvelope<T = unknown> {
  type: string
  seq: number
  time: number
  data: T
}

/** user/message 事件载荷（UserMessage 最小结构） */
export interface UserMessageEventData {
  content?: SessionTextBlock[]
  source?: SessionMessageSource
}

/** assistant/message 事件载荷（携带 turn/step 定位与完整助手消息） */
export interface AssistantMessageEventData {
  turn: number
  step: number
  message?: {
    content?: SessionTextBlock[]
  }
  usage?: unknown
  interrupted?: true
}

/** turn/start 事件载荷 */
export interface TurnStartEventData {
  turn: number
}

/** turn/end 事件载荷：reason.kind 决定轮次结局（仅 completed 触发沉淀） */
export interface TurnEndEventData {
  turn: number
  reason: {
    kind: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' | (string & {})
  }
}

/** 轮次跟踪器结算产出：无感静默沉淀的输入素材 */
export interface TurnTrackItem {
  turn: number
  /** 本轮真实人类输入（source.kind === 'user' 的消息文本聚合） */
  userText: string
  /** 本轮全部助手可见文本（assistant/message 的 text 块聚合） */
  assistantText: string
}

// 扩展 Cordis 上下文接口，声明宿主服务与事件总线
declare module 'cordis' {
  interface Events {
    /**
     * 宿主会话事件流（firehose）：轮次/步骤生命周期、消息与工具事件均经此发布。
     * 根上下文监听器可观察到全部会话；监听器抛错由宿主捕获隔离，绝不阻断提交。
     */
    'session/event'(session: unknown, event: SessionEventEnvelope): void
  }

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
