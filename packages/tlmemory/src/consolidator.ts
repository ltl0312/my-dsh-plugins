// packages/tlmemory/src/consolidator.ts
// 记忆归并（1.1.0）：把「同一结论被切成多条一句话」的叶子折叠成一个父节点摘要。
//
// 设计约束（来自用户决策与库内实测）：
//   1. **父子结构**：父节点承载 summary 并正常参与召回；来源叶子原文保留、status='merged'
//      退出召回，可通过 merges 审计表整次回滚 —— 归并必须可撤销，记忆不能被静默销毁；
//   2. **保守聚类**：只聚「路径逐段近义」或「名称相似且关键词重叠」的条目。实测宽口径
//      会把 /RAG/Web服务/ 与 /架构决策/项目更名/ 连成一簇（关键词并查集边），跨主题误聚
//      比漏合并更伤召回质量，因此宁可少合；
//   3. **LLM 只做归纳、不做选择**：簇由确定性规则给出，模型只负责把簇内原文写成一条
//      摘要；模型输出的 id 一律按「必须是本簇已送入的 id」校验，越界即丢弃；
//   4. **全程静默降级**：LLM 不可用 / 输出非法 → 本轮不合并、不抛错（记忆系统不允许
//      因为一次归纳失败而中断）。
import type { Context } from 'cordis'
import type { MergeCandidate, MergeRecord, MemoryDB } from './db.js'
import { sanitizeJsonString } from './extractor.js'

/**
 * 路径逐段相似阈值：段数必须相同，且每一段的字符二元组 Dice ≥ 该值。
 *
 * 0.55 而非 0.6 的实测依据：「部署运维」vs「部署与运维」的 Dice 为 4/7≈0.571 ——
 * 正是需要合并的近义路径；而「前端」vs「后端」（0）、「服务规约」vs「服务配置」（0.33）
 * 这类真正不同主题的段仍被挡在阈值外。段数必须相同这条约束提供了第二重保险。
 */
export const PATH_SEGMENT_FLOOR = 0.55
/** 名称相似下限（与关键词重叠条件配合使用） */
export const NAME_FLOOR = 0.35
/** 关键词重叠条数下限 */
export const KEYWORD_OVERLAP_MIN = 2
/** 单簇条目数上限：超过 8 条通常意味着聚类把不同主题连起来了 */
export const MAX_CLUSTER_SIZE = 8
/** 单轮最多执行的归并簇数（控制 LLM 与写库开销） */
export const MAX_CLUSTERS_PER_ROUND = 8
/** 摘要长度上限（父节点 content） */
export const MAX_SUMMARY_CHARS = 300

/** 一个待归并簇（dry-run 与执行共用同一结构） */
export interface MergeCluster {
  treeType: string
  /** 父节点路径：簇内路径分段的公共前缀 */
  path: string
  sources: Array<{ id: string; name: string; content: string }>
  /** LLM 归纳出的父节点名称（dry-run 未调 LLM 时为空） */
  name: string
  /** LLM 归纳出的摘要（dry-run 未调 LLM 时为空） */
  summary: string
  keywords: string
}

/** 一轮归并的结果 */
export interface ConsolidateReport {
  dryRun: boolean
  /** 聚类出的簇（已按条数倒序，受 limit 截断） */
  clusters: MergeCluster[]
  /** 实际落库的归并（dry-run 恒为空） */
  applied: MergeRecord[]
  /** 被跳过的簇及原因（供日志与工具返回说明） */
  skipped: Array<{ path: string; reason: string }>
  /** 摘要是否由 LLM 生成（false 表示 LLM 不可用，此时不落库） */
  summarized: boolean
}

const CONSOLIDATE_SYSTEM_PROMPT = `你是长期记忆库的归并编辑器。输入是一组「同一主题」的记忆条目，请把它们归纳成一条结构化摘要。

要求：
1. 只使用输入条目里已经存在的事实，严禁补充、推测或引入新信息；相互冲突的表述并列保留并注明分歧。
2. summary 长度 120 至 300 个中文字符；先给一句总述结论，再用中文分号「；」串联 2 至 4 个要点。
3. name 是这条摘要的标题，8 至 20 个中文字符，概括主题而非复述某一条。
4. 严禁输出代码块、Markdown 标记或解释性文字。
5. 必须严格输出纯 JSON 对象，格式：
{"summaries":[{"cluster_id":"<输入里的 cluster_id>","name":"<标题>","summary":"<摘要>"}]}
6. 对每个输入簇都必须给出一条 summaries；不得合并不同 cluster_id。`

/** 字符二元组 Dice 系数（与 extractor.nameSimilarity 同构，但不做「子串即 1」短路） */
export function diceCoefficient(a: string, b: string): number {
  const left = String(a ?? '')
  const right = String(b ?? '')
  if (!left || !right) return 0
  if (left === right) return 1
  const grams = (value: string): string[] => {
    const out: string[] = []
    for (let i = 0; i < value.length - 1; i++) out.push(value.slice(i, i + 2))
    return out
  }
  const ga = grams(left)
  const gb = grams(right)
  if (ga.length === 0 || gb.length === 0) return 0
  const counts = new Map<string, number>()
  for (const gram of ga) counts.set(gram, (counts.get(gram) ?? 0) + 1)
  let hit = 0
  for (const gram of gb) {
    const remaining = counts.get(gram) ?? 0
    if (remaining > 0) {
      hit += 1
      counts.set(gram, remaining - 1)
    }
  }
  return (2 * hit) / (ga.length + gb.length)
}

function segmentsOf(path: string): string[] {
  return String(path ?? '')
    .split('/')
    .filter(Boolean)
}

/** 两条物化路径是否近义：段数相同且逐段 Dice ≥ PATH_SEGMENT_FLOOR */
export function pathsAreSimilar(a: string, b: string): boolean {
  if (a === b) return true
  const left = segmentsOf(a)
  const right = segmentsOf(b)
  if (left.length !== right.length || left.length === 0) return false
  return left.every((segment, index) => diceCoefficient(segment, right[index]) >= PATH_SEGMENT_FLOOR)
}

/** 关键词集合（空格分隔，小写化） */
function keywordSet(keywords: string): Set<string> {
  return new Set(
    String(keywords ?? '')
      .split(/\s+/)
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean),
  )
}

/**
 * 保守聚类：并查集两条边 —— 路径逐段近义，或「名称相似 + 关键词重叠 ≥ 2」。
 * 纯函数，同一输入必得同一输出（供 dry-run 与执行共用，也便于单测）。
 */
export function clusterCandidates(
  candidates: readonly MergeCandidate[],
  limit = MAX_CLUSTERS_PER_ROUND,
): MergeCluster[] {
  const byTree = new Map<string, MergeCandidate[]>()
  for (const candidate of candidates) {
    const list = byTree.get(candidate.tree_type)
    if (list === undefined) byTree.set(candidate.tree_type, [candidate])
    else list.push(candidate)
  }

  const clusters: MergeCluster[] = []
  for (const [treeType, list] of byTree) {
    const parent = list.map((_, index) => index)
    const find = (index: number): number => {
      let cursor = index
      while (parent[cursor] !== cursor) {
        parent[cursor] = parent[parent[cursor]]
        cursor = parent[cursor]
      }
      return cursor
    }
    const union = (left: number, right: number): void => {
      const a = find(left)
      const b = find(right)
      if (a !== b) parent[b] = a
    }

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        if (pathsAreSimilar(a.path, b.path)) {
          union(i, j)
          continue
        }
        const shared = [...keywordSet(b.keywords)].filter((word) => keywordSet(a.keywords).has(word)).length
        if (shared >= KEYWORD_OVERLAP_MIN && diceCoefficient(a.name, b.name) >= NAME_FLOOR) union(i, j)
      }
    }

    const groups = new Map<number, MergeCandidate[]>()
    for (let i = 0; i < list.length; i++) {
      const root = find(i)
      const group = groups.get(root)
      if (group === undefined) groups.set(root, [list[i]])
      else group.push(list[i])
    }

    for (const members of groups.values()) {
      if (members.length < 2) continue
      const trimmed = members.slice(0, MAX_CLUSTER_SIZE)
      clusters.push({
        treeType,
        path: commonPathPrefix(trimmed.map((member) => member.path)),
        sources: trimmed.map((member) => ({ id: member.id, name: member.name, content: member.content })),
        name: '',
        summary: '',
        keywords: [...new Set(trimmed.flatMap((member) => [...keywordSet(member.keywords)]))].join(' '),
      })
    }
  }

  clusters.sort((a, b) => b.sources.length - a.sources.length || a.path.localeCompare(b.path))
  return clusters.slice(0, Math.max(1, Math.trunc(limit)))
}

/** 簇内路径的公共前缀（按段比较）；无公共段时回退为第一条的路径 */
export function commonPathPrefix(paths: readonly string[]): string {
  if (paths.length === 0) return '/未分类/'
  const split = paths.map(segmentsOf)
  const first = split[0]
  const shared: string[] = []
  for (let index = 0; index < first.length; index++) {
    const segment = first[index]
    if (split.every((segments) => segments[index] === segment)) shared.push(segment)
    else break
  }
  if (shared.length === 0) return paths[0].endsWith('/') ? paths[0] : `${paths[0]}/`
  return `/${shared.join('/')}/`
}

export interface ConsolidatorOptions {
  /** 自动归并开关（运行期读取，供设置页改值即时生效） */
  enabled?: () => boolean
  /** 单轮簇数上限 */
  limit?: number
}

export class MemoryConsolidator {
  constructor(
    private ctx: Context,
    private db: MemoryDB,
    private options: ConsolidatorOptions = {},
  ) {}

  private enabledNow(): boolean {
    const resolver = this.options.enabled
    return resolver === undefined ? true : resolver() !== false
  }

  /**
   * 执行一轮归并。
   * @param options.dryRun true 时只聚类 + 生成摘要预览，**不写库**（用户确认前的唯一形态）
   */
  public async consolidate(options: { dryRun?: boolean; limit?: number } = {}): Promise<ConsolidateReport> {
    const dryRun = options.dryRun === true
    const limit = Math.max(1, Math.trunc(options.limit ?? this.options.limit ?? MAX_CLUSTERS_PER_ROUND))
    const clusters = clusterCandidates(this.db.listMergeCandidates(), limit)
    const report: ConsolidateReport = { dryRun, clusters, applied: [], skipped: [], summarized: false }

    if (clusters.length === 0) return report
    if (!dryRun && !this.enabledNow()) {
      report.skipped.push({ path: '*', reason: '自动归并已关闭（enableAutoMerge=false）' })
      return report
    }

    const summaries = await this.summarize(clusters)
    report.summarized = summaries !== null
    if (summaries === null) {
      report.skipped.push({ path: '*', reason: 'LLM 不可用或输出非法，本轮不合并' })
      return report
    }

    for (const cluster of clusters) {
      const picked = summaries.get(clusterKey(cluster))
      if (picked === undefined) {
        report.skipped.push({ path: cluster.path, reason: '模型未给出该簇摘要' })
        continue
      }
      cluster.name = picked.name
      cluster.summary = picked.summary
    }
    if (dryRun) return report

    for (const cluster of clusters) {
      if (!cluster.summary) continue
      const record = this.db.applyMerge({
        treeType: cluster.treeType,
        path: cluster.path,
        name: cluster.name || '归并摘要',
        summary: cluster.summary,
        keywords: cluster.keywords,
        sourceIds: cluster.sources.map((source) => source.id),
        reinforceCount: cluster.sources.length,
      })
      if (record === null) {
        report.skipped.push({ path: cluster.path, reason: '落库校验未通过（条目状态已变化）' })
        continue
      }
      report.applied.push(record)
      this.ctx.logger?.info?.(
        `[tlmemory] 记忆归并 [${cluster.treeType}]: ${cluster.path}${cluster.name} ← 折叠 ${record.sourceIds.length} 条（merge #${record.mergeId}）`,
      )
    }
    return report
  }

  /** 撤销一次归并；返回 null 表示记录不存在或已撤销 */
  public revert(mergeId: number): { restored: number; removedSummary: boolean } | null {
    return this.db.revertMerge(mergeId)
  }

  /** 一次 LLM 调用归纳全部簇；不可用或输出非法时返回 null（调用方据此跳过本轮） */
  private async summarize(clusters: readonly MergeCluster[]): Promise<Map<string, { name: string; summary: string }> | null> {
    if (!this.ctx.llm?.stream) return null
    const payload = clusters.map((cluster) => ({
      cluster_id: clusterKey(cluster),
      path: cluster.path,
      items: cluster.sources.map((source) => ({ id: source.id, name: source.name, content: source.content })),
    }))

    let raw = ''
    try {
      const stream = this.ctx.llm.stream({
        messages: [
          { role: 'system', content: CONSOLIDATE_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ clusters: payload }) },
        ],
        temperature: 0.1,
      })
      for await (const chunk of stream) {
        raw += chunk.delta || chunk.text || chunk.content || ''
      }
    } catch (err) {
      this.ctx.logger?.warn?.('[tlmemory] 归并摘要生成异常（已跳过）:', (err as Error)?.message ?? err)
      return null
    }

    return parseSummaryResponse(raw, clusters)
  }
}

/** 簇的稳定标识：树 + 路径 + 成员 id 升序，保证 dry-run 与执行时同一簇得到同一 key */
export function clusterKey(cluster: MergeCluster): string {
  const ids = cluster.sources.map((source) => source.id).sort((a, b) => Number(a) - Number(b))
  return `${cluster.treeType}|${cluster.path}|${ids.join(',')}`
}

/**
 * 解析归纳输出。
 *
 * 安全边界：只接受「本簇已送入的成员集合」的摘要 —— cluster_id 必须匹配，且条目 id
 * 一个都不能越界（模型无权决定折叠谁）。畸形 JSON / 缺字段 / 摘要过短一律收敛为 null。
 */
export function parseSummaryResponse(
  raw: string,
  clusters: readonly MergeCluster[],
): Map<string, { name: string; summary: string }> | null {
  const valid = new Map<string, Set<string>>()
  for (const cluster of clusters) valid.set(clusterKey(cluster), new Set(cluster.sources.map((source) => source.id)))

  try {
    const parsed: unknown = JSON.parse(sanitizeJsonString(raw))
    const summaries = (parsed as { summaries?: unknown })?.summaries
    if (!Array.isArray(summaries)) return null
    const out = new Map<string, { name: string; summary: string }>()
    for (const entry of summaries) {
      const item = entry as { cluster_id?: unknown; name?: unknown; summary?: unknown; source_ids?: unknown }
      const key = typeof item.cluster_id === 'string' ? item.cluster_id : ''
      const allowed = valid.get(key)
      if (allowed === undefined) continue
      // 模型若回传 source_ids，必须与送入集合完全一致（顺序无关），否则视为越界丢弃
      if (Array.isArray(item.source_ids)) {
        const returned = item.source_ids.map((id) => String(id))
        if (returned.length !== allowed.size || returned.some((id) => !allowed.has(id))) continue
      }
      const summary = String(item.summary ?? '').trim().slice(0, MAX_SUMMARY_CHARS)
      if (summary.length < 20) continue
      const name = String(item.name ?? '').trim().slice(0, 40)
      out.set(key, { name, summary })
    }
    return out.size > 0 ? out : null
  } catch {
    return null
  }
}
