// packages/tlrp/test/memory-bridge.test.mjs
//
// 记忆桥自测：不依赖宿主、不依赖 tlmemory 的代码，只用 node:test + 真实的
// ~/.dsh/tlmemory.db（可用 TLMEMORY_DB 覆盖）。库不存在时相关用例自动 skip，
// 这样 CI/新机上依然是绿的。
//
// 运行：node --test packages/tlrp/test/memory-bridge.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bridge = require('../lib/memory-bridge.cjs')

const dbPath = bridge.resolveDbPath()
const dbReady = fs.existsSync(dbPath)

test('extractTerms 只产出 ≥3 字的检索锚点', () => {
  const terms = bridge.extractTerms('你还记得橡木蛋糕卷吗？上次在筑梦边境的天台')
  assert.ok(terms.length > 0, '应当抽出至少一个词')
  for (const term of terms) assert.ok([...term].length >= 3, `词 "${term}" 少于 3 字，trigram 索引不到`)
  assert.ok(terms.some((term) => term.includes('蛋糕')), `期望命中「蛋糕」，实际：${terms.join(',')}`)
})

test('extractTerms 对短句与空输入不抛错', () => {
  assert.deepEqual(bridge.extractTerms(''), [])
  assert.deepEqual(bridge.extractTerms('嗯'), [])
})

test('库文件不存在时降级为 no-db，且不抛错', () => {
  const result = bridge.readMemoryContext({
    characterId: 'firefly',
    mode: 'rp',
    text: '橡木蛋糕卷',
    dbPath: path.join(os.tmpdir(), 'definitely-not-a-tlmemory-db.sqlite'),
  })
  assert.equal(result.text, '')
  assert.equal(result.degraded, 'no-db')
})

test('RP 态读到 pinned 常驻羁绊（真实库）', { skip: dbReady ? false : `无 ${dbPath}` }, () => {
  const result = bridge.readMemoryContext({ characterId: 'firefly', mode: 'rp', text: '' })
  assert.equal(result.degraded, '', `降级码：${result.degraded}`)
  assert.ok(result.pinned.length >= 1, '至少应读到 1 条 pinned 记忆')
  assert.ok(
    result.pinned.some((item) => item.path.startsWith('/rp/firefly/')),
    `pinned 里应含 /rp/firefly/ 前缀：${result.pinned.map((i) => i.path).join(' | ')}`,
  )
  assert.ok(result.text.includes('tlmemory 记忆桥'))
})

test('RP 态关键词静默检索命中 lore 切片（真实库）', { skip: dbReady ? false : `无 ${dbPath}` }, () => {
  const result = bridge.readMemoryContext({ characterId: 'firefly', mode: 'rp', text: '橡木蛋糕卷' })
  const all = [...result.pinned, ...result.hits]
  assert.ok(
    all.some((item) => item.path.startsWith('/lore/firefly/')),
    `应命中 lore 切片：${all.map((i) => i.path).join(' | ')}`,
  )
})

test('WORK 态不会捞到 rp / lore 分区（真实库）', { skip: dbReady ? false : `无 ${dbPath}` }, () => {
  const result = bridge.readMemoryContext({ characterId: 'firefly', mode: 'work', text: '橡木蛋糕卷 端口' })
  for (const item of [...result.pinned, ...result.hits]) {
    assert.ok(item.scope === 'work' || item.scope === 'core', `WORK 态出现了 ${item.scope} 分区：${item.path}`)
  }
})

test('角色隔离：别的角色读不到 firefly 的私有 rp 记忆（真实库）', { skip: dbReady ? false : `无 ${dbPath}` }, () => {
  const result = bridge.readMemoryContext({ characterId: 'sam_tactical', mode: 'rp', text: '橡木蛋糕卷' })
  for (const item of [...result.pinned, ...result.hits]) {
    assert.ok(item.charId === '' || item.charId === 'sam_tactical', `串戏了：${item.path} (char_id=${item.charId})`)
  }
})
