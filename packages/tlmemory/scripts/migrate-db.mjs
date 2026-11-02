#!/usr/bin/env node
/**
 * 只跑迁移、不跑插件：把 v1 库升级到 v2（scope / char_id / tags + 6 列 FTS）。
 *
 * 为什么要单独一个脚本：插件里的迁移只在 apply() 时执行，而那需要整个宿主跑起来。
 * 上线前想先确认「库能干净升级、旧数据一条不丢」，就必须能在裸 node 下跑一次。
 *
 * 用法：
 *   node scripts/migrate-db.mjs                       # 默认 ~/.dsh/tlmemory.db
 *   node scripts/migrate-db.mjs --db /root/.dsh/tlmemory.db
 *   TLMEMORY_MODULE=/root/.dsh/profiles/web/node_modules/dsh-plugin-tlmemory/dist/index.cjs \
 *     node scripts/migrate-db.mjs --db /root/.dsh/tlmemory.db
 *
 * 幂等：迁移块内部以「scope 列是否已回填」为判据，可反复运行。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const readFlag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const modulePath = process.env.TLMEMORY_MODULE
  ? path.resolve(process.env.TLMEMORY_MODULE)
  : path.resolve(import.meta.dirname, '..', 'dist', 'index.cjs')
const dbPath = readFlag('--db') ?? path.join(os.homedir(), '.dsh', 'tlmemory.db')

if (!existsSync(modulePath)) {
  console.error(`找不到 tlmemory 构建产物：${modulePath}（先跑 pnpm exec tsup）`)
  process.exit(2)
}
if (!existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`)
  process.exit(2)
}

const require = createRequire(import.meta.url)
const { MemoryDB } = require(modulePath)

console.log(`模块：${modulePath}`)
console.log(`数据库：${dbPath}`)

const db = new MemoryDB(dbPath)

const stats = db.partitionStats()
console.log('\n分区统计（scope / char_id / 总节点 / 叶子 / 置顶）：')
for (const row of stats) {
  console.log(`  ${String(row.scope || '(空)').padEnd(6)} ${String(row.char_id || '').padEnd(12)} ${String(row.total).padStart(6)} ${String(row.leaves).padStart(6)} ${String(row.pinned).padStart(4)}`)
}

const pinned = db.listPinned(['rp'], 'firefly', 5)
console.log(`\nfirefly 的置顶 rp 记忆：${pinned.length === 0 ? '(无)' : ''}`)
for (const node of pinned) console.log(`  - ${node.path}${node.name}：${String(node.content).slice(0, 60)}`)

const hit = db.search('橡木蛋糕卷', { partitions: ['rp', 'lore'], charId: 'firefly', limit: 3 })
console.log(`\n检索「橡木蛋糕卷」于 rp+lore：${hit.length} 命中`)
for (const node of hit) console.log(`  - [${node.scope}] ${node.path}${node.name}（score ${node.score?.toFixed?.(2) ?? node.score}）`)

process.exit(0)
