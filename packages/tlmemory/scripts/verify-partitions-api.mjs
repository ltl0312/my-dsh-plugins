#!/usr/bin/env node
/**
 * 分区可视化接口实测（方案 A 取证脚本）
 *
 * 直接在独立端口起一个 MemoryServer（复用真实 DB），依次打三个新/改造过的接口，
 * 打印真实响应片段，最后关闭服务。宿主进程不需要重启即可先做取证。
 *
 *   node scripts/verify-partitions-api.mjs            # 默认 4977 端口 + ~/.dsh/tlmemory.db
 *   node scripts/verify-partitions-api.mjs --port 4988 --db /path/to/tlmemory.db
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { MemoryDB, MemoryServer } = require('../dist/index.cjs')

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const PORT = Number(argOf('--port', '4977'))
const DB_PATH = argOf('--db', join(homedir(), '.dsh', 'tlmemory.db'))

const quiet = { info() {}, warn() {}, error(...a) { console.error('[server]', ...a) } }
const db = new MemoryDB(DB_PATH)
const server = new MemoryServer(db, PORT, quiet, undefined, null)

const base = `http://127.0.0.1:${PORT}`
const get = async (path) => {
  const res = await fetch(base + path)
  const text = await res.text()
  return { status: res.status, text }
}

const line = (s = '') => console.log(s)

const main = async () => {
  await server.start()
  line(`DB: ${DB_PATH}`)
  line(`PORT: ${PORT}`)
  line()

  line('=== 1) GET /api/partitions ===')
  const p = await get('/api/partitions')
  line(`HTTP ${p.status}`)
  try {
    const body = JSON.parse(p.text)
    line(JSON.stringify(body.data, null, 0))
    line(`characters: ${JSON.stringify(body.characters)}`)
  } catch {
    line(p.text.slice(0, 400))
  }
  line()

  line('=== 2) GET /api/nodes?partition=rp&char_id=firefly ===')
  const n = await get('/api/nodes?partition=rp&char_id=firefly')
  line(`HTTP ${n.status}`)
  try {
    const body = JSON.parse(n.text)
    const list = body.data ?? body
    for (const node of list) {
      line(`- [${node.scope}/${node.char_id || '-'}] ${node.path}/${node.name} pinned=${node.is_pinned} tags=${node.tags ?? ''}`)
    }
    line(`count=${list.length}`)
  } catch {
    line(n.text.slice(0, 400))
  }
  line()

  line('=== 3) GET /api/search?q=橡木蛋糕卷&partition=lore&char_id=firefly ===')
  const s1 = await get(`/api/search?q=${encodeURIComponent('橡木蛋糕卷')}&partition=lore&char_id=firefly`)
  line(`HTTP ${s1.status}`)
  try {
    const body = JSON.parse(s1.text)
    const list = body.data ?? body
    for (const hit of list) {
      line(`- score=${hit.score} ${hit.node?.path ?? hit.path}/${hit.node?.name ?? hit.name}`)
    }
    line(`count=${list.length}`)
  } catch {
    line(s1.text.slice(0, 400))
  }
  line()

  line('=== 4) GET /api/search?q=流萤&partition=rp&char_id=firefly（短词兜底）===')
  const s2 = await get(`/api/search?q=${encodeURIComponent('流萤')}&partition=rp&char_id=firefly`)
  line(`HTTP ${s2.status}`)
  try {
    const body = JSON.parse(s2.text)
    const list = body.data ?? body
    for (const hit of list) {
      line(`- score=${hit.score} ${hit.node?.path ?? hit.path}/${hit.node?.name ?? hit.name}`)
    }
    line(`count=${list.length}`)
  } catch {
    line(s2.text.slice(0, 400))
  }
}

main()
  .catch((err) => {
    console.error('FAILED:', err?.stack || err)
    process.exitCode = 1
  })
  .finally(async () => {
    await server.stop?.()
    db.close?.()
  })
