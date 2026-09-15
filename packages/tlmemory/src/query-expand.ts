// packages/tlmemory/src/query-expand.ts
// 查询候选展开（共享模块）：
// FTS5 Trigram 短语匹配要求完整连续子串，自然语言长句几乎必然零命中；
// 本模块把原始查询展开为「整句 / 标点切分 token / 中英文边界分段 /
// 中文滑窗 Trigram 子串」候选集，供召回引擎（recall.ts）与
// tlmemory_query 工具（tools.ts）共用同一套展开语义，避免逻辑漂移。

/**
 * 查询候选展开（P2-3 配额分配版）：
 *   保底层 = 整句 + 每个 token + token 的中英文分段（按输入顺序优先保留）；
 *   限额层 = 中文长段的 Trigram 滑窗子串，占用剩余名额，且按段轮转分配。
 * 此前的扁平 Set + slice(0, N) 按插入序截断会把名额全部让给排在前面的
 * 滑窗子串 —— 长中文输入（滑窗子串是候选大头）时句子末段的概念词被截掉，
 * 恰是「最后提到的那个坑」这类高价值召回目标。
 * @param query - 原始查询文本
 * @param maxCandidates - 候选集截断上限
 */
export function expandQueryCandidates(query: string, maxCandidates = 16): string[] {
  const clean = String(query ?? '').trim()
  if (!clean) return []

  const tokens = clean.split(/[\s,，。;；、:：!！?？"'()（）\[\]{}]+/).filter((t) => t.length > 0)

  // 候选集：整句必在首位；每个 token 与其中英文分段至少保底 1 个名额
  const kept: string[] = [clean]
  const pushKept = (value: string): void => {
    if (!kept.includes(value)) kept.push(value)
  }

  // 滑窗子串按中文长段分桶收集，随后轮转取样，保证每段至少分到一个名额
  const windowBuckets: string[][] = []

  for (const token of tokens) {
    pushKept(token)
    const segments = token.match(/[a-zA-Z0-9_-]+|[\u4e00-\u9fa5]+/g) ?? [token]
    for (const seg of segments) {
      pushKept(seg)
      if (/[\u4e00-\u9fa5]/.test(seg) && seg.length > 3) {
        // FTS5 Trigram 的检索键最小粒度为 3 字：按 3 字窗口、2 字步长滑窗
        // （4 字窗口会因偶数步长错过奇数起点的 Trigram 序列，造成长句零命中）
        const bucket: string[] = []
        for (let i = 0; i <= seg.length - 3; i += 2) {
          const gram = seg.slice(i, i + 3)
          if (!bucket.includes(gram)) bucket.push(gram)
        }
        const tail = seg.slice(-3)
        if (!bucket.includes(tail)) bucket.push(tail)
        if (bucket.length > 0) windowBuckets.push(bucket)
      }
    }
  }

  // 滑窗名额轮转分配：每轮各段取一个，直到用尽剩余名额（尾段概念词不再被截掉）
  let bucketIndex = 0
  while (kept.length < maxCandidates && windowBuckets.length > 0) {
    const index = bucketIndex % windowBuckets.length
    const bucket = windowBuckets[index]!
    const gram = bucket.shift()
    if (gram === undefined) {
      windowBuckets.splice(index, 1)
      continue
    }
    pushKept(gram)
    bucketIndex += 1
  }

  return kept.slice(0, maxCandidates)
}
