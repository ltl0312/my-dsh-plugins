// packages/tlsearch/src/types.ts
// 领域模型与 Cordis 上下文类型合并。
//
// 说明：DSH 宿主把 logger / tools 等平级服务挂载于共享 Context 之上，此处通过
// declare module 对 'cordis' 命名空间执行环境声明合并，防止编译期 TS2339。
// 该声明与 tlmemory 的同名声明互不冲突：两个包各自独立编译，运行时也不共享类型。

/** 支持的搜索引擎后端标识 */
export type ProviderId = 'tavily' | 'brave' | 'searxng' | 'google' | 'exa'

/**
 * 单个后端的**已解析连接配置**。
 *
 * 抽成独立类型是为了支持「主备双后端」：主后端与备用后端各持一份连接参数，
 * 而限额/语言/输出格式等策略参数是两者共享的（见 ResolvedConfig）。
 */
export interface BackendConfig {
  provider: ProviderId
  /** 解析后的 API Key（SearXNG 可为空） */
  apiKey: string
  /** 解析后的端点根地址（不含 /search、/customsearch/v1 等路径） */
  baseUrl: string
  /** Google CSE 的引擎 ID（cx）；其余后端恒为空串 */
  cx: string
}

/**
 * 单条搜索结果 —— 本插件对外**唯一**的结果形状。
 *
 * 刻意只保留三个字段：原生搜索工具返回的 answer / publishedAt / score / engine /
 * raw_content 等字段每轮都在消耗上下文，却不改变「模型据此引用来源」这一核心用途。
 */
export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/** 一次搜索的规范化产出 */
export interface SearchOutcome {
  hits: SearchHit[]
  /** 提供方附带的一句话答案（仅 Tavily/SearXNG 且在 includeAnswer=true 时出现） */
  answer?: string
}

/** 模型可见结果文本的呈现格式 */
export type OutputFormat = 'markdown' | 'json'

/** 备用后端的配置（全部可选；留空则回退该后端的环境变量与默认端点） */
export interface FallbackConfig {
  /** 'none'（默认）表示不启用主备切换 */
  provider?: ProviderId | 'none'
  apiKey?: string
  baseUrl?: string
  cx?: string
}

/**
 * 插件配置（与 schemastery 的 Config 一一对应，全部可选）。
 *
 * 刻意放在 types.ts 而非 index.ts：providers.ts 需要在**不反向依赖入口模块**的
 * 前提下消费它（入口 → providers 是单向依赖，避免循环导入）。
 */
export interface SearchPluginConfig {
  /** 搜索引擎后端，默认 tavily */
  provider?: ProviderId
  /** 后端 API Key（SearXNG 可不填） */
  apiKey?: string
  /** 自定义端点地址（SearXNG 必填；也可指向自建代理） */
  baseUrl?: string
  /** Google CSE 的引擎 ID（cx）；provider=google 时必填 */
  cx?: string
  /** 备用后端：主后端失败或熔断时自动改用它 */
  fallback?: FallbackConfig
  /** 单次搜索返回条数上限，默认 5，最大 10 */
  maxResults?: number
  /** 单条摘要字符上限，默认 250（防 Token 膨胀） */
  maxSnippetChars?: number
  /** 单次请求超时（毫秒），默认 15000 */
  timeoutMs?: number
  /** 检索语言（如 zh / en），留空由后端自行判定 */
  language?: string
  /** 是否附带后端给出的一句话答案，默认 false（省 Token） */
  includeAnswer?: boolean
  /** 模型可见结果的呈现格式，默认 markdown */
  outputFormat?: OutputFormat
}

/**
 * 已解析的运行期配置。
 *
 * 继承 BackendConfig：主后端的连接参数直接平铺在顶层（`rt.provider` / `rt.baseUrl` …），
 * 因此「单后端」这条最常见路径的读写方式与加入主备之前完全一致；
 * 备用后端单独收在 `fallback` 里。
 */
export interface ResolvedConfig extends BackendConfig {
  /** 主后端不可用时的备用后端；null 表示未启用（或与主后端同源） */
  fallback: BackendConfig | null
  maxResults: number
  maxSnippetChars: number
  timeoutMs: number
  language: string
  includeAnswer: boolean
  outputFormat: OutputFormat
}

// ---------------------------------------------------------------------------
// Cordis 宿主服务声明合并（只声明本插件实际消费的服务）
// ---------------------------------------------------------------------------
declare module 'cordis' {
  interface Context {
    logger?: {
      info: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
    }
    tools?: {
      /**
       * 注册工具，返回**精确注销器**（宿主内部走 Cordis effect，随上下文销毁自动回收）。
       * 定义形状由宿主 dsh-tools 决定：output 必填，parameters 为原始 JSON Schema。
       */
      register: (tool: unknown) => () => void
    }
  }
}
