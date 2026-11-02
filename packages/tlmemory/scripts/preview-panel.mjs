#!/usr/bin/env node
/**
 * 只读预览：用工作区里的 web/dist + 真实 DB 起一个独立看板（默认 4978），
 * 用于在宿主重启前验证分区条、徽章与筛选是否渲染正常。
 *
 *   node scripts/preview-panel.mjs --port 4978
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { MemoryDB, MemoryServer } = require('../dist/index.cjs')

const argv = process.argv.slice(2)
const idx = argv.indexOf('--port')
const port = idx >= 0 ? Number(argv[idx + 1]) : 4978
const dbPathArg = argv.indexOf('--db')
const dbPath = dbPathArg >= 0 ? argv[dbPathArg + 1] : join(homedir(), '.dsh', 'tlmemory.db')

const db = new MemoryDB(dbPath)
const server = new MemoryServer(db, port, {
  info: (...a) => console.log('[preview]', ...a),
  warn: (...a) => console.warn('[preview]', ...a),
  error: (...a) => console.error('[preview]', ...a),
}, undefined, null)

await server.start()
console.log(`preview panel: http://127.0.0.1:${port}/  (db: ${dbPath})`)

const shutdown = async () => {
  try { await server.stop?.() } catch {}
  try { db.close?.() } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
