// 只读探针：打印 tlmemory 库的实际路径、表结构、分区统计与 FTS 定义。
// 不写库、不改配置；用于动刀前的取证。
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const candidates = [
  process.env.TLMEMORY_DB,
  path.join(os.homedir(), '.dsh', 'tlmemory.db'),
].filter(Boolean)

const found = candidates.find((p) => fs.existsSync(p))
if (!found) {
  console.log('NO_DB 尝试路径:', candidates.join(' | '))
  process.exit(0)
}
console.log('DB =', found, 'bytes =', fs.statSync(found).size)

const db = new DatabaseSync(found, { readOnly: true })
const q = (sql, ...params) => {
  try {
    return db.prepare(sql).all(...params)
  } catch (err) {
    return [{ error: String(err?.message ?? err) }]
  }
}

console.log('\n--- nodes columns ---')
console.log(q('PRAGMA table_info(nodes)').map((c) => `${c.name}:${c.type}`).join('  '))

console.log('\n--- tables ---')
console.log(q("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").map((r) => `${r.type}:${r.name}`).join('  '))

console.log('\n--- memory_fts DDL ---')
console.log(q("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'")[0]?.sql ?? '(none)')

console.log('\n--- triggers ---')
for (const r of q("SELECT name, sql FROM sqlite_master WHERE type='trigger'")) {
  console.log(`* ${r.name}`)
}

console.log('\n--- totals ---')
console.log(q('SELECT tree_type, COUNT(*) AS n, SUM(is_leaf) AS leaves FROM nodes GROUP BY tree_type ORDER BY n DESC'))

console.log('\n--- leaf sample (12) ---')
console.log(q('SELECT id, tree_type, path, name, keywords, is_pinned, status FROM nodes WHERE is_leaf=1 ORDER BY updated_at DESC LIMIT 12'))

db.close()
