// packages/tlmemory/src/extractor.ts
// 异步深度反思长叶引擎：启发式门控 -> 活跃 LLM 流式结构化抽取 -> 物理原子化截断与路径净化。
import type { Context } from 'cordis'
import type { MemoryDB } from './db.js'
import type { RawReflectionItem, ReflectionResponse } from './types.js'

const REFLECTION_SYSTEM_PROMPT = `你是一个软件工程经验沉淀引擎。请审视刚才这一轮人机交互，提取长期有效的高价值架构规约、开发规范或避坑经验。

【提炼规则】
1. 坚决舍弃：单次临时对话、闲聊客套、简单拼写修复以及未得出明确结论的推演过程。
2. 作用域划分标准：
   - global：跨项目通用的用户编码偏好、通用工具链规约或通用开发习惯。
   - project：当前仓库专有的架构设计、模块划分约定、特定依赖版本规约与特有踩坑反思。
3. 文本压缩约束：
   - content 字段必须是提炼后的原子断言或操作约束，严禁输出代码块或情绪化长文。
   - 字符长度严格限制在 40 至 80 个中文字符以内。
4. 路径分段（path_segments）通常包含 2 至 3 级中文分类名（例如 ["技术选型", "构建工具"]）。

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

export class MemoryExtractor {
  constructor(
    private ctx: Context,
    private db: MemoryDB,
  ) {}

  /** 第一重门禁：启发式过滤网关，丢弃寒暄客套与长度不足的文本 */
  private passesFilterGate(text: string): boolean {
    if (!text || text.trim().length < 15) return false
    const trivialPatterns = [
      /^(你好|在吗|hi|hello|继续|收到|好的|ok|yes)$/i,
      /^(谢谢|thank you|thanks)$/i,
    ]
    return !trivialPatterns.some((pattern) => pattern.test(text.trim()))
  }

  public async extractAndConsolidate(
    userMessage: string,
    assistantResponse: string,
    projectScope: string,
  ): Promise<void> {
    if (!this.passesFilterGate(userMessage) && !this.passesFilterGate(assistantResponse)) {
      return
    }

    if (!this.ctx.llm?.stream) {
      this.ctx.logger?.warn?.('[tlmemory] 宿主 ctx.llm 未就绪，跳过反思提取')
      return
    }

    const conversationContext = `[用户输入]\n${userMessage}\n\n[智能体答复与操作]\n${assistantResponse}`

    try {
      const stream = this.ctx.llm.stream({
        messages: [
          { role: 'system', content: REFLECTION_SYSTEM_PROMPT },
          { role: 'user', content: conversationContext },
        ],
        temperature: 0.1,
      })

      let rawOutput = ''
      for await (const chunk of stream) {
        rawOutput += chunk.delta || chunk.text || chunk.content || ''
      }

      const cleanJson = this.sanitizeJsonString(rawOutput)
      const parsed: ReflectionResponse = JSON.parse(cleanJson)

      if (!parsed.reflections || !Array.isArray(parsed.reflections)) {
        return
      }

      for (const item of parsed.reflections) {
        this.processSingleReflection(item, projectScope)
      }
    } catch (err) {
      this.ctx.logger?.error?.('[tlmemory] 异步反思提炼过程异常:', err)
    }
  }

  /** 剥离 Markdown 代码块围栏并收敛至首个 JSON 对象边界 */
  private sanitizeJsonString(raw: string): string {
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

  private processSingleReflection(item: RawReflectionItem, projectScope: string): void {
    if (!item.content || !item.name) return

    // 第三重门禁：物理级原子化硬截断，单条断言不允许超过 80 字
    const boundedContent = item.content.trim().slice(0, 80)
    const targetTreeType = item.tree === 'global' ? 'global' : projectScope

    // 路径分段白名单净化，拦截 ../ ./ 空字节与转义通配符
    const cleanSegments = (item.path_segments || ['默认'])
      .map((seg) => seg.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, ''))
      .filter(Boolean)

    if (cleanSegments.length === 0) cleanSegments.push('通用')

    const cleanKeywords = Array.isArray(item.keywords)
      ? item.keywords.map((k) => k.trim()).filter((k) => k.length > 0)
      : [item.name]

    this.db.upsertLeaf(
      targetTreeType,
      cleanSegments,
      item.name.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, ''),
      boundedContent,
      cleanKeywords,
    )
    this.ctx.logger?.info?.(`[tlmemory] 知识沉淀入库 [${targetTreeType}]: ${item.name}`)
  }
}