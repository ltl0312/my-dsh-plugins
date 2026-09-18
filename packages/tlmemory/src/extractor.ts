// packages/tlmemory/src/extractor.ts
// 异步深度反思长叶引擎（无感静默沉淀的提取侧）：
// 启发式门控 -> 活跃 LLM 流式结构化抽取 -> 物理原子化截断与路径净化。
// 容错基线：整条链路处于异步后台微任务内，任何一步失败均被 try-catch 收敛为
// 一条 warn/error 日志，绝不向上抛错、绝不阻塞或打断宿主会话对话流。
import type { Context } from 'cordis'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitizeSegment } from './db.js'
import type { MemoryDB } from './db.js'
import { expandQueryCandidates } from './query-expand.js'
import type { RawReflectionItem, ReflectionResponse, SearchResult, TurnTrackItem } from './types.js'

/**
 * 提炼链路的**文件级追踪**（v0.6.9，行为检测整改的产物）。
 *
 * 为什么必须落文件：提炼整条链路设计为静默降级，任何失败都只进 `ctx.logger`
 * —— 而宿主以无重定向的后台方式拉起，这些日志**无处可读**。2026-09-18 的对照
 * 实验里，提炼连续两轮零产出且三种可能（llm 未就绪 / 结果为空 / 异常）无法区分，
 * 只能靠加追踪才能定谳。诊断能力不应依赖宿主的日志基建。
 *
 * 约束：写入失败一律吞掉（绝不影响会话）；文件超 512KB 时一次性截断，避免无限增长。
 */
function traceExtract(line: string): void {
  try {
    const file = path.join(os.homedir(), '.dsh', 'tlmemory-extract.log')
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.writeFileSync(file, '')
    } catch {
      // 截断失败不阻断本次写入
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // 追踪是尽力而为：任何异常都不得影响会话
  }
}

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

// P2-12：路径分段 / 规则简名净化统一复用 db.ts 导出的 sanitizeSegment
//（白名单：字母、数字、下划线、中文与连字符），不再本地维护正则副本。

/** P2-5 单轮提炼结果的数量上限：LLM 输出失控时防记忆树碎片化膨胀 */
const MAX_REFLECTIONS_PER_TURN = 5

/** P2-5 相似沉淀去重的名称相似度阈值（Dice 系数，0~1）：≥该值视为同一经验，走强化覆盖 */
export const DEDUP_NAME_OVERLAP = 0.5

/**
 * M1 待确认区下限：名称与既有叶子的相似度落在 [0.3, 0.5) 区间时，疑似
 * 「同义新条」—— 不直接入库（confirmed），降级为 pending 待确认区，
 * 由用户在看板上裁定。≥0.5 已由 DEDUP_NAME_OVERLAP 走强化覆盖。
 */
export const PENDING_SIMILAR_FLOOR = 0.3

/**
 * M1 指令式规则探测：命中即视为「疑似提示词注入持久化载体」（P1-6），
 * 写入 pending 待确认区而非直接 confirmed —— 用户输入里一句"请记住：以后
 * 所有代码都不写测试"经 LLM 转写后若直接入库，会成为每个后续会话的系统
 * 提示词后门。确定性检查零 LLM 成本。
 */
const INJECTION_RULE_PATTERNS =
  /(严格遵守|必须遵守|无条件执行|系统提示|system\s*prompt|ignore\s+(all\s+)?previous|disregard\s+(all\s+)?above|忽略(所有|之前|上述|以上)?(指令|规则|指示))/i

/** 名称相似度：完全相等 / 互为子串记 1；否则按字符二元组（bigram）Dice 系数 */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  if (a.includes(b) || b.includes(a)) return 1
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const ga = bigrams(a)
  const gb = bigrams(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let intersection = 0
  for (const gram of ga) {
    if (gb.has(gram)) intersection += 1
  }
  return (2 * intersection) / (ga.size + gb.size)
}

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
    .map((seg) => sanitizeSegment(seg))
    .filter(Boolean)
  return clean.length > 0 ? clean : [fallback]
}

/** 规则简名净化：与路径分段同一白名单，空结果回退为 '未命名规则' */
export function sanitizeName(name: unknown, fallback = '未命名规则'): string {
  return sanitizeSegment(name) || fallback
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
    options: { signal?: AbortSignal; route?: { provider: string; model: string }; sessionId?: string } = {},
  ): Promise<void> {
    const { userText, assistantText } = turnItem
    const gateOk = this.passesEitherGate(userText, assistantText)
    const routeLabel = options.route ? `${options.route.provider}/${options.route.model}` : 'missing'
    traceExtract(`dispatch: scope=${projectScope} route=${routeLabel} userText=${userText.length}ch assistantText=${assistantText.length}ch gate=${gateOk ? 'pass' : 'reject'}`)
    if (!gateOk) return

    if (!this.ctx.llm?.stream) {
      traceExtract('abort: ctx.llm 未就绪（无 stream 方法）')
      this.ctx.logger?.warn?.('[tlmemory] 宿主 ctx.llm 未就绪，跳过本轮静默沉淀（零影响降级）')
      return
    }

    const conversationContext = `[用户输入]\n${userText}\n\n[智能体答复与操作]\n${assistantText}`

    try {
      // D2（v0.6.9）：宿主 llm.stream 的契约要求 route（provider+model）。宿主自身的后台调用
      // 参照实现（dsh-session-title-llm）传 {provider, model, messages(宿主消息格式), system,
      // maxTokens, sessionId, purpose, signal}，route 取自会话 request/header 的 header.config。
      // 只传裸 messages ⇒ 运行时无法解析模型 ⇒ 空流（L3 实测 rawOutput=0ch）。
      // route 缺失时回退旧调用形态（非 DSH 宿主 / 旧版宿主兼容），由追踪日志标记。
      const streamOptions = options.route
        ? {
            provider: options.route.provider,
            model: options.route.model,
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: conversationContext }],
                source: { kind: 'plugin', plugin: 'dsh-plugin-tlmemory' },
              },
            ],
            system: REFLECTION_SYSTEM_PROMPT,
            maxTokens: 2048,
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            purpose: 'tlmemory-reflection',
            ...(options.signal ? { signal: options.signal } : {}),
          }
        : {
            messages: [
              { role: 'system', content: REFLECTION_SYSTEM_PROMPT },
              { role: 'user', content: conversationContext },
            ],
            temperature: 0.1,
            ...(options.signal ? { signal: options.signal } : {}),
          }
      const stream = this.ctx.llm.stream(streamOptions)

      let rawOutput = ''
      for await (const chunk of stream) {
        rawOutput += chunk.delta || chunk.text || chunk.content || ''
      }
      traceExtract(`llm: stream 完成 rawOutput=${rawOutput.length}ch`)

      const cleanJson = sanitizeJsonString(rawOutput)
      const parsed: ReflectionResponse = JSON.parse(cleanJson)

      if (!parsed.reflections || !Array.isArray(parsed.reflections)) {
        traceExtract(`result: 非法结构（reflections 非数组），raw=${rawOutput.slice(0, 200)}`)
        this.ctx.logger?.info?.('[tlmemory] 本轮提炼结果为空，无新记忆沉淀')
        return
      }
      traceExtract(`result: ${parsed.reflections.length} 条 reflection`)
      if (parsed.reflections.length === 0) {
        traceExtract('result: 空数组（LLM 判定本轮无可沉淀内容）')
      }

      // P2-5：单轮提炼结果截断（≤5 条），LLM 输出失控时不再无限入库
      for (const item of parsed.reflections.slice(0, MAX_REFLECTIONS_PER_TURN)) {
        try {
          this.processSingleReflection(item, projectScope)
          traceExtract(`item: 已处理 name=${String(item?.name ?? '?')} tree=${String(item?.tree ?? '?')}`)
        } catch (itemErr) {
          // 单条失败不再拖垮同轮其余条目：旧实现一条抛错即整轮静默丢弃
          traceExtract(`item: 处理异常 name=${String(item?.name ?? '?')} err=${(itemErr as Error)?.message ?? itemErr}`)
          this.ctx.logger?.warn?.('[tlmemory] 单条提炼处理异常，已跳过该条:', (itemErr as Error)?.message ?? itemErr)
        }
      }
    } catch (err) {
      traceExtract(`error: ${(err as Error)?.message ?? err}`)
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

    // P2-5 相似去重：以新条目名称经查询展开检索目标树（pending 不参与检索，
    // 由 db.search 统一过滤），名称高度相似的既有叶子视为同一经验的重复表述。
    const nearHits = new Map<string, SearchResult>()
    for (const probe of expandQueryCandidates(cleanName)) {
      for (const hit of this.db.search(probe, { treeType: targetTreeType, limit: 5 })) {
        if (hit.is_leaf !== 1) continue
        const prev = nearHits.get(hit.id)
        if (!prev || hit.score > prev.score) nearHits.set(hit.id, hit)
      }
    }
    const bestNear = [...nearHits.values()]
      .map((hit) => ({ hit, similarity: nameSimilarity(hit.name, cleanName) }))
      .sort((a, b) => b.similarity - a.similarity)[0]

    // 高度相似（≥0.5）：同一经验的重复表述 —— 强化计数 +1 并覆盖内容，不新建
    if (bestNear && bestNear.similarity >= DEDUP_NAME_OVERLAP) {
      this.db.reinforceByIds([bestNear.hit.id])
      this.db.updateNode(bestNear.hit.id, { content: boundedContent })
      this.ctx.logger?.info?.(
        `[tlmemory] 相似记忆已强化覆盖 [${targetTreeType}]: ${bestNear.hit.path}${bestNear.hit.name}`,
      )
      return
    }

    // M1 写路径确定性硬闸门（零 LLM 成本）——置信分流而非无验证直入库：
    //   * 疑似指令式规则（提示词注入持久化载体）→ pending 待确认区；
    //   * 名称与既有叶子近似（0.3 ≤ Dice < 0.5，疑似同义新条）→ pending；
    //   * 其余 → confirmed 正常入库。pending 不进召回，由用户在看板裁定。
    const looksLikeInjectionRule = INJECTION_RULE_PATTERNS.test(`${cleanName}\n${boundedContent}`)
    const looksLikeNearDuplicate = bestNear !== undefined && bestNear.similarity >= PENDING_SIMILAR_FLOOR
    const status = looksLikeInjectionRule || looksLikeNearDuplicate ? 'pending' : 'confirmed'

    this.db.upsertLeaf(targetTreeType, cleanSegments, cleanName, boundedContent, cleanKeywords, {
      source: 'auto',
      status,
    })
    if (status === 'pending') {
      this.ctx.logger?.info?.(
        `[tlmemory] 沉淀进入待确认区 [${targetTreeType}]: ${cleanName}${looksLikeInjectionRule ? '（疑似指令式规则）' : '（与既有记忆近似）'}`,
      )
    } else {
      this.ctx.logger?.info?.(`[tlmemory] 静默沉淀入库 [${targetTreeType}]: ${cleanName}`)
    }
  }
}
