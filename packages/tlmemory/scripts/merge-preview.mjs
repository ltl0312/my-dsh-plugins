#!/usr/bin/env node
// packages/tlmemory/scripts/merge-preview.mjs
// 记忆归并 dry-run：只读打开 tlmemory 库，用**与运行时同一套**聚类规则
// （dist/index.js 导出的 clusterCandidates）算出「会合并成什么」，不调 LLM、不写库。
//
// 用途：历史回填前的唯一前置步骤 —— 用户先看这份清单确认口径，再在会话里让模型
// 调 tlmemory_consolidate(dry_run=false) 执行（或直接跑本脚本 --apply 之外的路径）。
//
// 用法：
//   node packages/tlmemory/scripts/merge-preview.mjs                # 打印前 8 簇摘要
//   node packages/tlmemory/scripts/merge-preview.mjs --all          # 打印全部簇
//   node packages/tlmemory/scripts/merge-preview.mjs --json         # 输出 JSON（供管道处理）
//   TL_MEMORY_DB=/path/to.db node ...                              # 指定库文件
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DB_PATH = process.env.TL_MEMORY_DB ?? path.join(os.homedir(), '.dsh', 'tlmemory.db')
const args = new Set(process.argv.slice(2))
const showAll = args.has('--all')
const asJson = args.has('--json')

// 复用产物里的聚类实现：预览与执行必须同源，否则「看到的」和「合掉的」会不一致
const { clusterCandidates } = await import(new URL('../dist/index.js', import.meta.url).href)

const db = new DatabaseSync(DB_PATH, { readOnly: true })
// 库可能是被旧版插件建的（还没有归并列）——本脚本只读，不建表、不迁移：
// 缺列时按「尚无归并记录」处理，真正建列由插件下次打开库时自动完成。
const columns = new Set(db.prepare('PRAGMA table_info(nodes)').all().map((row) => String(row.name)))
const where = [
  "is_leaf = 1",
  "status = 'confirmed'",
  "content IS NOT NULL",
  "content <> ''",
  columns.has('merged_into') ? 'merged_into IS NULL' : null,
  columns.has('is_pinned') ? 'is_pinned = 0' : null,
]
  .filter(Boolean)
  .join(' AND ')
if (!columns.has('merged_into')) {
  console.log('[提示] 该库尚无 merged_into/merged_from 列：预览按「全部未归并」计算，插件下次打开库会自动迁移。\n')
}
const rows = db
  .prepare(
    `SELECT id, tree_type, path, name, content, keywords FROM nodes
     WHERE ${where}
     ORDER BY tree_type ASC, path ASC, name ASC`,
  )
  .all()
const totalLeaves = db
  .prepare("SELECT COUNT(*) AS n FROM nodes WHERE is_leaf = 1 AND status = 'confirmed'")
  .get().n
db.close()

const candidates = rows.map((row) => ({
  id: String(row.id),
  tree_type: String(row.tree_type),
  path: String(row.path),
  name: String(row.name),
  content: String(row.content),
  keywords: row.keywords == null ? '' : String(row.keywords),
}))

// limit 传足够大，先看全量再按展示需要截断
const clusters = clusterCandidates(candidates, 1000)
const covered = clusters.reduce((sum, cluster) => sum + cluster.sources.length, 0)

if (asJson) {
  console.log(JSON.stringify({ db: DB_PATH, totalLeaves, candidates: candidates.length, clusters }, null, 2))
  process.exit(0)
}

console.log(`库文件: ${DB_PATH}`)
console.log(`已确认叶子 ${totalLeaves} 条，可参与归并 ${candidates.length} 条`)
console.log(`可合并簇 ${clusters.length} 个，覆盖 ${covered} 条（${((covered / Math.max(1, candidates.length)) * 100).toFixed(1)}%）`)
console.log(`规则: 路径逐段 Dice ≥ 0.55（段数相同）或 名称 Dice ≥ 0.35 且关键词重叠 ≥ 2；簇内 2–8 条\n`)

const shown = showAll ? clusters : clusters.slice(0, 8)
for (const [index, cluster] of shown.entries()) {
  console.log(`## 簇 ${index + 1} · ${cluster.treeType} · ${cluster.sources.length} 条 · ${cluster.path}`)
  for (const source of cluster.sources) console.log(`   - ${source.name} :: ${source.content}`)
  console.log()
}
if (!showAll && clusters.length > shown.length) {
  console.log(`（其余 ${clusters.length - shown.length} 簇用 --all 查看；--json 输出完整结构）`)
}
