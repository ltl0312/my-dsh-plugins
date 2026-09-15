// packages/tlmemory/src/query-expand.ts
// 查询候选展开（共享模块）：
// FTS5 Trigram 短语匹配要求完整连续子串，自然语言长句几乎必然零命中；
// 本模块把原始查询展开为「整句 / 标点切分 token / 中英文边界分段 /
// 中文滑窗 Trigram 子串」候选集，供召回引擎（recall.ts）与
// tlmemory_query 工具（tools.ts）共用同一套展开语义，避免逻辑漂移。

/**
 * 查询候选展开：整句 -> 标点/空白切分 -> 中英文边界分段 -> 中文长段 Trigram 级滑窗子串。
 * @param query - 原始查询文本
 * @param maxCandidates - 候选集截断上限（Set 按插入序保留：整句优先，token 次之）
 */
export function expandQueryCandidates(query: string, maxCandidates = 16): string[] {
  const clean = String(query ?? '').trim()
  if (!clean) return []

  const candidates = new Set<string>([clean])
  const tokens = clean.split(/[\s,，。;；、:：!！?？"'()（）\[\]{}]+/).filter((t) => t.length > 0)

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
  return Array.from(candidates).slice(0, maxCandidates)
}
