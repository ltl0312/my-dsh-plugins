// packages/tlrp/lib/memory-bridge.cjs
//
// tlrp ← → tlmemory 的记忆桥。
//
// 为什么是「只读直连 SQLite」而不是调用 tlmemory 的 ctx 服务：
//   1. tlrp 必须零依赖、CJS、单文件可挂载：它要在新老 DSH 上都能装，不能因为
//      tlmemory 没装/版本不匹配就整个插件起不来；
//   2. 只读语义足够 —— tlrp 只负责「把该在场的信息搬到台面上」，写入永远由模型
//      通过 tlmemory_save 发起（谁拥有数据谁负责写，避免两个插件同时写同一行）；
//   3. 驱动走 Node 内置 node:sqlite（与仓库约定一致，绝不引入 better-sqlite3 这类
//      按 NODE_MODULE_VERSION 编译的驱动）。宿主 Node 过旧时 require 会抛错，
//      这里全部吞掉并降级为「无记忆上下文」，绝不让记忆桥拖垮对话。
//
// 降级矩阵（任一不满足都只是少一段注入，不报错、不阻塞）：
//   no-driver  宿主 Node 没有 node:sqlite
//   no-db      库文件不存在（tlmemory 从未运行过）
//   no-schema  tlmemory 还是 v1（没有 scope / char_id / tags 列）
//   no-fts     memory_fts 不可用，退化为 LIKE 检索

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const EXCLUDED_STATUS = "n.status NOT IN ('pending', 'merged', 'superseded')"

let driver
let driverProbed = false

// 一轮里 snapshot() 会被变量 / context / guard 多次调用，每次开库太浪费。
// 用「参数 + 文本」做键、3 秒 TTL 的短缓存：同一轮命中缓存，跨轮自然失效。
const CACHE_TTL_MS = 3000
let cacheKey = ''
let cacheAt = 0
let cacheValue = null

/** 惰性探测 node:sqlite（Electron 宿主上可能不存在，绝不能放在模块顶部 require）。 */
function loadDriver() {
  if (driverProbed) return driver
  driverProbed = true
  try {
    // eslint-disable-next-line node/no-unsupported-features/node-builtins
    driver = require('node:sqlite')
  } catch {
    driver = null
  }
  return driver
}

function resolveDbPath(explicit) {
  const value = String(explicit || process.env.TLMEMORY_DB || '').trim()
  if (value) return value
  return path.join(os.homedir(), '.dsh', 'tlmemory.db')
}

/** 打开只读库；失败返回 null（调用方按降级处理）。 */
function openReadOnly(dbPath) {
  const mod = loadDriver()
  if (!mod || typeof mod.DatabaseSync !== 'function') return { handle: null, reason: 'no-driver' }
  if (!fs.existsSync(dbPath)) return { handle: null, reason: 'no-db' }
  try {
    const handle = new mod.DatabaseSync(dbPath, { readOnly: true })
    return { handle, reason: '' }
  } catch {
    // 只读打开失败（例如文件被独占）时再试一次常规打开：宁可短暂持写锁也不要整段失效
    try {
      return { handle: new mod.DatabaseSync(dbPath), reason: '' }
    } catch {
      return { handle: null, reason: 'no-db' }
    }
  }
}

/** 列探测：v1 库没有 scope/char_id/tags，必须降级而不是抛错。 */
function hasPartitionSchema(handle) {
  try {
    const rows = handle.prepare('PRAGMA table_info(nodes)').all()
    const names = new Set(rows.map((row) => String(row.name || '')))
    return names.has('scope') && names.has('char_id') && names.has('tags')
  } catch {
    return false
  }
}

function hasFts(handle) {
  try {
    handle.prepare('SELECT rowid FROM memory_fts LIMIT 1').all()
    return true
  } catch {
    return false
  }
}

/** 从用户本轮发言里抽 3~4 字的检索锚点（与 tlmemory 的 trigram 拆分同一口径）。 */
function extractTerms(text, limit = 4) {
  const out = []
  const seen = new Set()
  const push = (term) => {
    const clean = String(term || '').trim()
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    out.push(clean)
  }
  for (const seg of String(text || '').split(/[^\p{L}\p{N}_]+/u)) {
    if (!seg) continue
    const chars = Array.from(seg)
    if (chars.length < 3) continue // trigram 对 <3 字符不可见，短词交给模型自己表述
    if (chars.length <= 6) {
      push(seg)
    } else {
      for (let i = 0; i + 4 <= chars.length && out.length < limit; i += 3) {
        push(chars.slice(i, i + 4).join(''))
      }
    }
    if (out.length >= limit) break
  }
  return out.slice(0, limit)
}

function rowToItem(row) {
  const dirPath = String(row.path || '/')
  const name = String(row.name || '')
  return {
    scope: String(row.scope || ''),
    charId: String(row.char_id || ''),
    path: `${dirPath}${name}`,
    content: String(row.content || '').slice(0, 240),
  }
}

function renderItem(item) {
  return `- [${item.scope || '?'}] ${item.path}：${item.content}`
}

/**
 * 取本轮记忆上下文。
 *
 * @param {object} input
 * @param {string} input.characterId 当前激活角色
 * @param {'rp'|'work'|'off'} input.mode 本轮模式
 * @param {string} [input.text] 用户本轮发言（用于关键词静默检索）
 * @param {string} [input.dbPath] 覆盖库路径（测试/多 profile 用）
 * @param {number} [input.pinnedLimit]
 * @param {number} [input.hitLimit]
 * @returns {{text:string, pinned:Array, hits:Array, degraded:string, scopeTable:string[]}}
 */
function readMemoryContext(input = {}) {
  const mode = input.mode === 'work' ? 'work' : 'rp'
  const charId = String(input.characterId || '').trim()
  const partitions = mode === 'rp' ? ['rp', 'lore', 'core'] : ['work', 'core']
  const dbPath = resolveDbPath(input.dbPath)
  const empty = { text: '', pinned: [], hits: [], degraded: '', scopeTable: partitions }

  const key = `${mode}|${charId}|${dbPath}|${String(input.text || '')}`
  const at = Date.now()
  if (cacheValue && cacheKey === key && at - cacheAt < CACHE_TTL_MS) return cacheValue
  const remember = (value) => {
    cacheKey = key
    cacheAt = Date.now()
    cacheValue = value
    return value
  }

  const { handle, reason } = openReadOnly(dbPath)
  if (!handle) return remember({ ...empty, degraded: reason })

  try {
    if (!hasPartitionSchema(handle)) return remember({ ...empty, degraded: 'no-schema' })

    const partitionSql = `n.scope IN (${partitions.map(() => '?').join(', ')})`
    // 角色隔离但保留共享层：char_id='' 的行（core 画像、历史迁移记忆）对所有角色可见
    const charSql = charId ? "(n.char_id = ? OR n.char_id = '')" : '1 = 1'
    const baseParams = charId ? [...partitions, charId] : [...partitions]

    const pinnedLimit = Number.isFinite(input.pinnedLimit) ? input.pinnedLimit : 3
    const pinnedRows = handle
      .prepare(
        `SELECT n.scope, n.char_id, n.path, n.name, n.content
           FROM nodes n
          WHERE n.is_pinned = 1 AND n.is_leaf = 1 AND ${partitionSql} AND ${charSql} AND ${EXCLUDED_STATUS}
          ORDER BY n.updated_at DESC
          LIMIT ${pinnedLimit}`,
      )
      .all(...baseParams)

    const pinned = pinnedRows.map(rowToItem)

    const terms = extractTerms(input.text)
    let hits = []
    if (terms.length > 0) {
      const hitLimit = Number.isFinite(input.hitLimit) ? input.hitLimit : 3
      const pinnedPaths = new Set(pinned.map((item) => item.path))
      if (hasFts(handle)) {
        const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
        const rows = handle
          .prepare(
            `SELECT n.scope, n.char_id, n.path, n.name, n.content
               FROM memory_fts
               JOIN nodes n ON n.id = memory_fts.rowid
              WHERE memory_fts MATCH ? AND ${partitionSql} AND ${charSql} AND ${EXCLUDED_STATUS}
              ORDER BY n.is_pinned DESC, bm25(memory_fts, 0.2, 2.0, 1.5, 1.0, 1.5, 3.0)
              LIMIT ${hitLimit + pinned.length}`,
          )
          .all(match, ...baseParams)
        hits = rows.map(rowToItem).filter((item) => !pinnedPaths.has(item.path)).slice(0, hitLimit)
      } else {
        const like = terms.map(() => 'n.content LIKE ?').join(' OR ')
        const rows = handle
          .prepare(
            `SELECT n.scope, n.char_id, n.path, n.name, n.content
               FROM nodes n
              WHERE (${like}) AND n.is_leaf = 1 AND ${partitionSql} AND ${charSql} AND ${EXCLUDED_STATUS}
              ORDER BY n.is_pinned DESC, n.updated_at DESC
              LIMIT ${hitLimit + pinned.length}`,
          )
          .all(...terms.map((term) => `%${term}%`), ...baseParams)
        hits = rows.map(rowToItem).filter((item) => !pinnedPaths.has(item.path)).slice(0, hitLimit)
      }
    }

    const text = renderMemoryBlock({ pinned, hits, mode, charId })
    return remember({ text, pinned, hits, degraded: '', scopeTable: partitions })
  } catch (error) {
    return remember({ ...empty, degraded: `error:${String(error && error.message ? error.message : error).slice(0, 120)}` })
  } finally {
    try {
      handle.close()
    } catch {
      /* 关闭失败不影响本轮结果 */
    }
  }
}

/** 渲染成可直接塞进提示词的一段文本（空记忆时返回空串，不占上下文）。 */
function renderMemoryBlock({ pinned, hits, mode, charId }) {
  if (pinned.length === 0 && hits.length === 0) return ''
  const lines = ['## tlmemory 记忆桥（本轮实时读取）']
  if (pinned.length > 0) {
    lines.push('', '### 常驻记忆（pinned，每轮必带，不需要检索就能看到）')
    for (const item of pinned) lines.push(renderItem(item))
  }
  if (hits.length > 0) {
    lines.push('', '### 本轮命中的相关记忆（关键词静默检索）')
    for (const item of hits) lines.push(renderItem(item))
  }
  lines.push(
    '',
    '使用规则：以上是**已经落库的事实**，可以自然引用、不要当成待验证的猜测；与库中记录冲突的临时说法以库为准。',
  )
  if (mode === 'rp') {
    lines.push(
      `- 本轮新出现的重要互动、约定、情绪变化：用 tlmemory_save 写入 /rp/${charId || '<char>'}/... 分区（tags 给 3~5 个 ≥3 字词）。`,
    )
  } else {
    lines.push('- 本轮产生的技术结论：用 tlmemory_save 写入 /work/... 分区；同一主题复用同一 path 让 upsert 自动收敛。')
  }
  return lines.join('\n')
}

module.exports = {
  readMemoryContext,
  renderMemoryBlock,
  extractTerms,
  resolveDbPath,
  loadDriver,
}
