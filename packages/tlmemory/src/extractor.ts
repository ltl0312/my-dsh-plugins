// packages/tlmemory/src/extractor.ts
// 异步深度反思长叶引擎（无感静默沉淀的提取侧）：
// 启发式门控 -> 活跃 LLM 流式结构化抽取 -> 物理原子化截断与路径净化。
// 容错基线：整条链路处于异步后台微任务内，任何一步失败均被 try-catch 收敛为
// 一条 warn/error 日志，绝不向上抛错、绝不阻塞或打断宿主会话对话流。
import type { Context } from 'cordis'
import type { MemoryDB } from './db.js'
import type { RawReflectionItem, ReflectionResponse, TurnTrackItem } from './types.js'

const REFLECTION_SYSTEM_PROMPT = `你是一个软件工程经验沉淀引擎。请审视刚才这一轮人机交互，提取长期有效的高价值信息并固化为原子断言规则。

【可提取的三类信息】
1. 关键工程结论：本轮达成的架构决策、技术选型、模块划分约定、特定依赖版本规约与踩坑反思。
2. 用户偏好：用户明确表达或反复体现的编码风格偏好、工作流习惯、工具链倾向（如"我习惯用pnpm"、"错误信息用中文回复"）。
3. 决策规则：本轮确立的"遇到X时应该/不应该Y"式的可复用操作准则。

【提炼规则】
1. 坚决舍弃：单次临时对话、闲聊客套、简单拼写修复以及未得出明确结论的推演过程。
2. 作用域划分标准：
   - global：跨项目通用的用户编码偏好、通用工具链规约或通用开发习惯。
   - project：当前仓库专有的架构设计、模块划分约定、特定依赖版本规约与特有踩坑反思。
3. 文本压缩约束：
   - content 字段必须是提炼后的原子断言或操作约束，严禁输出代码块或情绪化长文。
   - 字符长度严格限制在 40 至 80 个中文字符以内。
4. 路径分段（path_segments）通常包含 2 至 3 级中文分类名（例如 ["技术选型", "构建工具"] 或 ["用户偏好", "编码风格"]）。

【输出格式】
必须严格输出纯 JSON 对象，严禁包裹任何代码块外的 Markdown 解释性文本：
{
  "reflections": [
    {
      "tree": "global" | "project",
      "path_segments": ["分类一级", "分类二级"],
      "name": "规则简名",
      "content": "40到80字高度精炼的核心断言规则",
      "keywords": ["关键词1", "关键词2"]
    }
  ]
}
若本轮交互无长期价值，请直接输出 {"reflections": []}。`

/** 路径分段白名单：仅字母、数字、下划线、中文与连字符，拦截路径穿越与通配符注入 */
const SEGMENT_SANITIZER = /[^a-zA-Z0-9_\u4e00-\u9fa5\-]/g

/** 第一重门禁：启发式过滤网关，丢弃寒暄客套与长度不足的文本 */
export function passesFilterGate(text: string): boolean {
  if (!text || text.trim().length < 15) return false
  const trivialPatterns = [
    /^(你好|在吗|hi|hello|继续|收到|好的|ok|yes)$/i,
    /^(谢谢|thank you|thanks)$/i,
  ]
  if (trivialPatterns.some((pattern) => pattern.test(text.trim()))) return false
  // 间接提示词注入样本：前缀匹配（允许带后缀的变形），命中即丢弃
  const injectionPatterns = [
    /^(ignore previous instructions|system override|disregard above|ignore all previous)/i,
    /(忽略(此前|之前|上面|以上)?(指令|指示|规则|所有)?|无视上述(指令|规则))/,
  ]
  return !injectionPatterns.some((pattern) => pattern.test(text.trim()))
}

/** 剥离 Markdown 代码块围栏并收敛至首个 JSON 对象边界 */
export function sanitizeJsonString(raw: string): string {
  let sanitized = raw.trim()
  if (sanitized.startsWith('```json')) {
    sanitized = sanitized.slice(7)
  } else if (sanitized.startsWith('```')) {
    sanitized = sanitized.slice(3)
  }
  if (sanitized.endsWith('```')) {
    sanitized = sanitized.slice(0, -3)
  }
  sanitized = sanitized.trim()

  // 兜底收敛：仅保留首个 '{' 至末尾 '}' 之间的片段
  const start = sanitized.indexOf('{')
  const end = sanitized.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    sanitized = sanitized.slice(start, end + 1)
  }
  return sanitized.trim()
}

/** 物理级原子化截断：单条断言不允许超过 80 字 */
export function boundContent(content: string, maxChars = 80): string {
  return String(content ?? '').trim().slice(0, maxChars)
}

/** 路径分段白名单净化：拦截 ../ ./ 空字节与转义通配符，空结果回退为 ['通用'] */
export function sanitizePathSegments(segments: unknown, fallback = '通用'): string[] {
  const clean = (Array.isArray(segments) ? segments : [])
    .map((seg) => String(seg ?? '').replace(SEGMENT_SANITIZER, '').trim())
    .filter(Boolean)
  return clean.length > 0 ? clean : [fallback]
}

/** 规则简名净化：与路径分段同一白名单，空结果回退为 '未命名规则' */
export function sanitizeName(name: unknown, fallback = '未命名规则'): string {
  const clean = String(name ?? '').replace(SEGMENT_SANITIZER, '').trim()
  return clean || fallback
}

export class MemoryExtractor {
  constructor(
    private ctx: Context,
    private db: MemoryDB,
  ) {}

  /**
   * 无感静默沉淀入口：由轮次结束后台任务调用。
   * 全程 try-catch：LLM 未就绪 / 流中断 / JSON 畸形 / 单条失败均静默降级，
   * 保证任何异常都到不了事件循环，也不影响宿主后续会话。
   */
  public async extractAndConsolidate(
    turnItem: TurnTrackItem,
    projectScope: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const { userText, assistantText } = turnItem
    if (!this.passesEitherGate(userText, assistantText)) return

    if (!this.ctx.llm?.stream) {
      this.ctx.logger?.warn?.('[tlmemory] 宿主 ctx.llm 未就绪，跳过本轮静默沉淀（零影响降级）')
      return
    }

    const conversationContext = `[用户输入]\n${userText}\n\n[智能体答复与操作]\n${assistantText}`

    try {
      const stream = this.ctx.llm.stream({
        messages: [
          { role: 'system', content: REFLECTION_SYSTEM_PROMPT },
          { role: 'user', content: conversationContext },
        ],
        temperature: 0.1,
        ...(options.signal ? { signal: options.signal } : {}),
      })

      let rawOutput = ''
      for await (const chunk of stream) {
        rawOutput += chunk.delta || chunk.text || chunk.content || ''
      }

      const cleanJson = sanitizeJsonString(rawOutput)
      const parsed: ReflectionResponse = JSON.parse(cleanJson)

      if (!parsed.reflections || !Array.isArray(parsed.reflections)) {
        this.ctx.logger?.info?.('[tlmemory] 本轮提炼结果为空，无新记忆沉淀')
        return
      }

      for (const item of parsed.reflections) {
        this.processSingleReflection(item, projectScope)
      }
    } catch (err) {
      // 静默降级：仅记录日志，绝不向调用方抛错
      this.ctx.logger?.warn?.('[tlmemory] 异步反思提炼过程异常，已静默跳过:', (err as Error)?.message ?? err)
    }
  }

  private passesEitherGate(userText: string, assistantText: string): boolean {
    return passesFilterGate(userText) || passesFilterGate(assistantText)
  }

  private processSingleReflection(item: RawReflectionItem, projectScope: string): void {
    if (!item.content || !item.name) return

    // 第三重门禁：物理级原子化硬截断，单条断言不允许超过 80 字
    const boundedContent = boundContent(item.content)
    if (boundedContent.length < 4) return
    const targetTreeType = item.tree === 'global' ? 'global' : projectScope

    const cleanSegments = sanitizePathSegments(item.path_segments)
    const cleanName = sanitizeName(item.name)

    const cleanKeywords = Array.isArray(item.keywords)
      ? item.keywords.map((k) => String(k).trim()).filter((k) => k.length > 0)
      : [cleanName]

    this.db.upsertLeaf(targetTreeType, cleanSegments, cleanName, boundedContent, cleanKeywords)
    this.ctx.logger?.info?.(`[tlmemory] 静默沉淀入库 [${targetTreeType}]: ${cleanName}`)
  }
}
