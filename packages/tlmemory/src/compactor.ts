// packages/tlmemory/src/compactor.ts
// M3 异步 compaction 引擎：把「语义层校验」从写路径硬闸门中拆出来，
// 以摊薄成本的方式异步执行 —— 闸门失败永不阻塞会话流（与沉淀链路同一底线）。
//
// 两个职责：
// 1. **强化衰减**（确定性，零 LLM 成本）：长期未被召回/沉淀触碰的记忆
//    reinforce_count 减半（下限 1）。updated_at 被召回强化与沉淀写入共同刷新，
//    因此「updated_at 早于衰减窗口」即「长期未被命中」——防止历史记忆凭
//    早先积累的强化计数永久占据召回权重（脏记忆自我强化的召回侧根治）。
// 2. **矛盾检测**（语义问题，LLM 成本按批摊薄）：每累计 N 次沉淀后，把
//    本批新入库的 auto 记忆与同树内既有记忆做一次 LLM 极性对比；判定互斥的
//    旧条目降级为 pending（待确认区，自动退出召回），由用户在看板裁定。
//    候选检索复用 db.search 的确定性近邻查询，单次对比的 pair 数有硬上限。
//
// 容错基线：任何一步失败均收敛为一条日志，绝不向调用方抛错。
import type { Context } from 'cordis'
import { sanitizeJsonString } from './extractor.js'
import type { MemoryDB } from './db.js'
import type { MemoryNode } from './types.js'

/** 衰减窗口：updated_at 早于该时长的叶子记忆视为「长期未被命中」 */
export const REINFORCE_DECAY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** 单轮 compaction 参与矛盾检测的新记忆批量上限 */
export const MAX_CONFLICT_BATCH = 10

/** 单轮 compaction 送入 LLM 的 pair 数硬上限（控制 token 成本） */
export const MAX_CONFLICT_PAIRS = 12

/** 每条新记忆经确定性检索取回的冲突候选数 */
const CANDIDATES_PER_NEW_LEAF = 2

/** LLM 矛盾判定提示词：只做极性互斥判断，输出严格 JSON */
const CONFLICT_SYSTEM_PROMPT = `你是长期记忆一致性审查器。下面给出若干对新旧记忆断言，请判断每一对是否在语义上互斥（同一条目的旧结论已被新结论推翻，同时生效会造成行为矛盾）。
判断标准：
- 仅当两条断言对同一主题给出不可同时成立的操作约束或事实结论时，才算冲突；
- 互补、细化、不同主题的相似表述都不算冲突。
必须严格输出纯 JSON 对象，禁止任何 Markdown 解释文本：
{"conflicts": [{"old_id": "<旧条目id>", "new_id": "<新条目id>", "reason": "<40字以内的冲突说明>"}]}
若无任何冲突，输出 {"conflicts": []}。`

/** 一次矛盾判定的候选对 */
interface ConflictPair {
  oldNode: MemoryNode
  newNode: MemoryNode
}

export class MemoryCompactor {
  private sedimentCount = 0
  private lastCompactionAt = Date.now()

  constructor(
    private ctx: Context,
    private db: MemoryDB,
    /** 每累计多少次沉淀触发一轮 compaction（Config.compactionInterval） */
    private interval: number = 20,
  ) {}

  /**
   * 沉淀计数：每完成一次提炼调度后调用。达到阈值即复位并返回 true
   * （调用方应在提炼链尾部串行执行一轮 compaction）。
   */
  noteSedimented(): boolean {
    this.sedimentCount += 1
    if (this.sedimentCount >= Math.max(1, this.interval)) {
      this.sedimentCount = 0
      return true
    }
    return false
  }

  /**
   * 执行一轮 compaction：先跑确定性衰减（恒可执行），再尝试 LLM 矛盾检测
   * （ctx.llm 未就绪时静默跳过 —— 衰减不受影响，语义校验等下一轮）。
   * 全程静默降级，绝不抛错。
   */
  public async compact(): Promise<void> {
    const startedAt = Date.now()
    try {
      const decayed = this.db.decayStaleReinforce(REINFORCE_DECAY_WINDOW_MS)
      if (decayed > 0) {
        this.ctx.logger?.info?.(`[tlmemory] compaction 强化衰减：${decayed} 条长期未命中的记忆计数减半`)
      }
    } catch (err) {
      this.ctx.logger?.warn?.('[tlmemory] compaction 强化衰减异常（已跳过）:', (err as Error)?.message ?? err)
    }

    try {
      const conflicts = await this.detectConflicts()
      if (conflicts > 0) {
        this.ctx.logger?.info?.(`[tlmemory] compaction 矛盾检测：${conflicts} 条旧记忆因与新结论互斥降入待确认区`)
      }
    } catch (err) {
      this.ctx.logger?.warn?.('[tlmemory] compaction 矛盾检测异常（已跳过）:', (err as Error)?.message ?? err)
    }

    this.lastCompactionAt = startedAt
  }

  /**
   * 矛盾检测：取本批新入库的 auto 记忆，经确定性近邻检索组装候选对，
   * 一次 LLM 调用批量判定，互斥的旧条目降级 pending。
   * @returns 降级入待确认区的旧记忆条数
   */
  private async detectConflicts(): Promise<number> {
    if (!this.ctx.llm?.stream) return 0

    const batch = this.db.listLeavesCreatedSince(this.lastCompactionAt, MAX_CONFLICT_BATCH)
    if (batch.length === 0) return 0

    const batchIds = new Set(batch.map((node) => node.id))
    const pairs: ConflictPair[] = []
    for (const newNode of batch) {
      // 确定性候选检索：新记忆的名称前缀（3 字，同名主题的异名记忆靠它命中）
      // 与关键词在同树内找近邻旧记忆
      const probes = [newNode.name.slice(0, 3), ...(newNode.keywords ?? '').split(/\s+/)].filter(Boolean)
      for (const probe of probes) {
        for (const hit of this.db.search(probe, { treeType: newNode.tree_type, limit: CANDIDATES_PER_NEW_LEAF })) {
          if (pairs.length >= MAX_CONFLICT_PAIRS) break
          if (hit.id === newNode.id || batchIds.has(hit.id)) continue
          if (pairs.some((pair) => pair.oldNode.id === hit.id && pair.newNode.id === newNode.id)) continue
          pairs.push({ oldNode: hit, newNode })
        }
        if (pairs.length >= MAX_CONFLICT_PAIRS) break
      }
    }
    if (pairs.length === 0) return 0

    const rawOutput = await this.streamLlm(
      JSON.stringify({
        pairs: pairs.map((pair) => ({
          old_id: pair.oldNode.id,
          old_name: pair.oldNode.name,
          old_content: pair.oldNode.content ?? '',
          new_id: pair.newNode.id,
          new_name: pair.newNode.name,
          new_content: pair.newNode.content ?? '',
        })),
      }),
    )

    const parsed = this.parseConflictResponse(rawOutput, pairs)
    let demoted = 0
    for (const conflict of parsed) {
      // 只应用送入 LLM 的 id 组合：模型输出不可信，禁止其指定任意节点
      const pair = pairs.find(
        (candidate) => candidate.oldNode.id === conflict.old_id && candidate.newNode.id === conflict.new_id,
      )
      if (pair === undefined) continue
      if (this.db.setStatus(pair.oldNode.id, 'pending')) {
        demoted += 1
        this.ctx.logger?.info?.(
          `[tlmemory] 记忆互斥降级待确认 [${pair.oldNode.tree_type}]: ${pair.oldNode.path}${pair.oldNode.name} ← ${conflict.reason ?? '与新结论冲突'}（新条目: ${pair.newNode.path}${pair.newNode.name}）`,
        )
      }
    }
    return demoted
  }

  /** 流式收集 LLM 输出（与 extractor 同一套流消费约定） */
  private async streamLlm(userContent: string): Promise<string> {
    const stream = this.ctx.llm!.stream({
      messages: [
        { role: 'system', content: CONFLICT_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.1,
    })
    let rawOutput = ''
    for await (const chunk of stream) {
      rawOutput += chunk.delta || chunk.text || chunk.content || ''
    }
    return rawOutput
  }

  /** 解析 LLM 的矛盾判定输出：畸形输出一律收敛为空结果 */
  private parseConflictResponse(
    raw: string,
    pairs: ConflictPair[],
  ): Array<{ old_id: string; new_id: string; reason?: string }> {
    const validOldIds = new Set(pairs.map((pair) => pair.oldNode.id))
    const validNewIds = new Set(pairs.map((pair) => pair.newNode.id))
    try {
      const parsed: unknown = JSON.parse(sanitizeJsonString(raw))
      const conflicts = (parsed as { conflicts?: unknown })?.conflicts
      if (!Array.isArray(conflicts)) return []
      return conflicts
        .map((entry) => entry as { old_id?: unknown; new_id?: unknown; reason?: unknown })
        .filter(
          (entry) =>
            typeof entry.old_id === 'string' &&
            validOldIds.has(entry.old_id) &&
            typeof entry.new_id === 'string' &&
            validNewIds.has(entry.new_id),
        )
        .map((entry) => ({
          old_id: entry.old_id as string,
          new_id: entry.new_id as string,
          reason: typeof entry.reason === 'string' ? entry.reason : undefined,
        }))
    } catch {
      return []
    }
  }
}
