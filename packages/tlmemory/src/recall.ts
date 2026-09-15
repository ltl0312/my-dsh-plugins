// packages/tlmemory/src/recall.ts
// 复合加权召回引擎与系统提示词注入格式化器。
// 打分模型：当前工程记忆叠加 ScopeBias 保证项目级契约在检索中绝对优先；
// 输出统一收敛进 <long_term_memory_context> 受控标签，并进行 XML 实体转义阻断逃逸注入。
import type { MemoryDB } from './db.js'
import type { SearchResult } from './types.js'

/** 当前工程记忆作用域偏置：体现当前代码规约的绝对优先级 */
const PROJECT_SCOPE_BIAS = 5.0

/** 第二重门禁：XML 实体转义（& < > 全覆盖），阻断针对系统提示词上下文结构的逃逸攻击 */
function escapeXmlEntities(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export class MemoryRecallEngine {
  constructor(private db: MemoryDB) {}

  /**
   * 双轨召回：项目记忆与全局记忆分别经 FTS5 检索后合流，
   * 项目命中叠加作用域偏置，按加权分数降序去重截断。
   * 用户输入为长句时，FTS5 Trigram 短语匹配要求完整连续子串、几乎必然零命中，
   * 因此先执行查询候选展开（整句 / 标点切分 token / 中英文段 / 中文滑窗子串），
   * 再跨候选聚合加权去重，保证长句输入同样能命中语义相关的记忆断言。
   */
  public recall(query: string, projectScope: string, maxCount: number = 5): SearchResult[] {
    const cleanQuery = query.trim()
    if (!cleanQuery) return []

    const candidates = this.expandQueryCandidates(cleanQuery)
    const merged = new Map<string, SearchResult>()

    for (const candidate of candidates) {
      const projectHits = this.db.search(candidate, { treeType: projectScope, limit: maxCount })
      const globalHits = this.db.search(candidate, { treeType: 'global', limit: maxCount })

      for (const hit of projectHits) {
        const uniqueKey = `${hit.tree_type}:${hit.path}${hit.name}`
        merged.set(uniqueKey, { ...hit, score: hit.score + PROJECT_SCOPE_BIAS })
      }
      for (const hit of globalHits) {
        const uniqueKey = `${hit.tree_type}:${hit.path}${hit.name}`
        // 已由项目作用域命中时保留偏置版本，否则采用全局分数
        if (!merged.has(uniqueKey)) merged.set(uniqueKey, hit)
      }
    }

    const results = Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCount)

    // 召回即强化：命中并被注入上下文的记忆叶子断言计数 +1（reinforce_count），
    // 高频被调用的记忆在长期使用中自然获得更高权重沉淀。
    this.db.reinforceByIds(results.filter((r) => r.is_leaf === 1).map((r) => r.id))

    return results
  }

  /** 查询候选展开：整句 -> 标点/空白切分 -> 中英文边界分段 -> 中文长段 Trigram 级滑窗子串 */
  private expandQueryCandidates(query: string): string[] {
    const candidates = new Set<string>([query])
    const tokens = query.split(/[\s,，。;；、:：!！?？"'()（）\[\]{}]+/).filter((t) => t.length > 0)

    for (const token of tokens) {
      candidates.add(token)
      const segments = token.match(/[a-zA-Z0-9_-]+|[\u4e00-\u9fa5]+/g) ?? [token]
      for (const seg of segments) {
        candidates.add(seg)
        if (/[\u4e00-\u9fa5]/.test(seg) && seg.length > 3) {
          // FTS5 Trigram 的检索键最小粒度为 3 字：按 3 字窗口、2 字步长滑窗
          // （4 字窗口会因偶数步长错过奇数起点的 Trigram 序列，造成长句零命中）
          for (let i = 0; i <= seg.length - 3; i += 2) {
            candidates.add(seg.slice(i, i + 3))
          }
          candidates.add(seg.slice(-3))
        }
      }
    }
    return Array.from(candidates).slice(0, 16)
  }

  /** 将召回记忆格式化为受控 XML 标签包裹的同步注入文本，空结果返回空串 */
  public formatPromptBlock(memories: SearchResult[]): string {
    if (memories.length === 0) return ''

    const lines = memories.map((m) => {
      const scopeLabel = m.tree_type === 'global' ? '全局偏好' : '当前工程'
      const cleanPath = escapeXmlEntities(`${m.path}${m.name}`)
      const cleanContent = escapeXmlEntities(m.content || '')
      return `  - [${scopeLabel}] ${cleanPath}: ${cleanContent}`
    })

    return [
      '<long_term_memory_context>',
      '以下是系统自动检索匹配的长期工程契约与避坑经验，你在本轮推理与工具调用中必须严格遵守：',
      ...lines,
      '</long_term_memory_context>',
    ].join('\n')
  }
}