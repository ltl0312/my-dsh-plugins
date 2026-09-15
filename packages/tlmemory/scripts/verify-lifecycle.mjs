#!/usr/bin/env node
// packages/tlmemory/scripts/verify-lifecycle.mjs
// 记忆生命周期端到端闭环验证（无人工干预、可重复运行）。
//
//   验证一 · 自动生成沉淀（Turn End Capture）
//     模拟 DSH 客户端 session/event 事件流水（turn/start -> user/message ->
//     assistant/message -> turn/end[completed]），驱动 TurnTracker 折叠素材，
//     经 MemoryExtractor（注入受控 Mock LLM 流）提取结构化断言并入库，
//     断言：SQLite nodes 表 + FTS5 索引均成功写入，归属工程绑定到工作区名称。
//
//   验证二 · 自行调用唤醒（Memory Recall / Context Injection）
//     模拟新一轮用户提问，触发 MemoryRecallEngine 召回链路，
//     断言：FTS5 分词检索命中此前沉淀的记忆节点；格式化 Memory Block
//     （<long_term_memory_context> 受控标签）包含沉淀内容；召回强化使
//     断言计数（reinforce_count）按机制 +1。
//
// 运行前提：先执行 `pnpm build`（本脚本消费 dist/index.js 产物）。
// 退出码：全部断言通过 0；任一失败 1（并打印失败明细）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const distEntry = path.join(packageRoot, 'dist', 'index.js')

if (!fs.existsSync(distEntry)) {
  console.error('[verify-lifecycle] 未找到 dist/index.js，请先执行 `pnpm build`。')
  process.exit(1)
}

const { MemoryDB, MemoryExtractor, MemoryRecallEngine, TurnTracker, resolveProjectIdentity } = await import(
  pathToFileURL(distEntry).href
)

// ---------------------------------------------------------------------------
// 极简断言器：逐条记录 PASS/FAIL，最终统一汇总
// ---------------------------------------------------------------------------
const results = []
let sectionTitle = ''

function section(title) {
  sectionTitle = title
  console.log(`\n=== ${title} ===`)
}

function check(name, condition, detail = '') {
  const ok = Boolean(condition)
  results.push({ section: sectionTitle, name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <-- ${detail}`}`)
  return ok
}

// ---------------------------------------------------------------------------
// 受控 Mock LLM：固定输出一份含唯一令牌的反思 JSON（替代真实宿主 ctx.llm）
// ---------------------------------------------------------------------------
const TOKEN = 'TLVERIFY-7F3A9C'
const REFLECTION_JSON = JSON.stringify({
  reflections: [
    {
      tree: 'project',
      path_segments: ['生命周期验证', '架构决策'],
      name: '验证令牌决策',
      content: `生命周期验证必须以唯一令牌${TOKEN.replace(/-/g, '')}绑定沉淀与召回两侧断言`,
      keywords: [TOKEN, '生命周期验证'],
    },
  ],
})

const logger = {
  info: (...args) => console.log('  [log]', ...args),
  warn: (...args) => console.log('  [warn]', ...args),
  error: (...args) => console.log('  [error]', ...args),
}

const mockCtx = {
  logger,
  llm: {
    async *stream() {
      yield { type: 'delta', delta: REFLECTION_JSON }
    },
  },
}

// ---------------------------------------------------------------------------
// 验证一：自动生成沉淀（Turn End Capture）
// ---------------------------------------------------------------------------
section('验证一 · 自动生成沉淀（Turn End Capture）')

// 1) 构造带 .git 标记的临时工作区，让 resolveProjectIdentity 以工作区基名命名工程
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tlmemory-lifecycle-'))
fs.mkdirSync(path.join(workspace, '.git'))
const workspaceName = path.basename(workspace)
const originalCwd = process.cwd()

let db = null
try {
  process.chdir(workspace)
  const identity = resolveProjectIdentity()
  check('工作区根目录识别（.git 回溯）', identity.root === path.normalize(workspace), `root=${identity.root}`)
  check('工程初始展示名 = 工作区基名（非裸哈希）', identity.name === workspaceName && identity.scope.startsWith('repo:'), `name=${identity.name} scope=${identity.scope}`)

  db = new MemoryDB(':memory:')
  db.registerProject(identity.scope, identity.name, identity.root)

  // 2) 模拟 DSH session/event 流水：多轮对话素材 -> turn/end(completed)
  const turnTracker = new TurnTracker()
  turnTracker.onTurnStart(1)
  turnTracker.addUserMessage(
    [
      { type: 'text', text: '我们把记忆插件的沉淀与召回闭环验证定为强制门禁：必须以唯一令牌绑定沉淀与召回两侧断言，' },
      { type: 'text', text: '并且每次召回命中都要让断言计数递增，这条决策后续所有迭代都要遵守。' },
    ],
    'user',
  )
  turnTracker.addAssistantMessage([
    { type: 'text', text: '已确认：沉淀入库走 FTS5 全文索引，召回命中即强化。生命周期验证令牌机制记录在案。' },
  ])
  const turnItem = turnTracker.endTurn(1, 'completed')
  check('turn/end(completed) 结算产出轮次素材', turnItem !== null && turnItem.userText.includes('唯一令牌'))

  // 3) 静默沉淀：Mock LLM 流式输出结构化反思 -> SQLite + FTS5 入库
  const extractor = new MemoryExtractor(mockCtx, db)
  await extractor.extractAndConsolidate(turnItem, identity.scope)

  const allNodes = db.getAllNodes(identity.scope)
  const leaves = allNodes.filter((n) => n.is_leaf === 1)
  check('提取出结构化断言并写入 nodes 表（SQLite）', leaves.length === 1 && leaves[0].name === '验证令牌决策', `leaves=${leaves.length}`)
  check('正文包含唯一令牌（原子断言内容落库）', leaves[0]?.content?.includes(TOKEN.replace(/-/g, '')) === true, `content=${leaves[0]?.content}`)
  check('归属工程绑定到当前工作区名称（tree_type=repo:<hash>）', leaves[0]?.tree_type === identity.scope, `tree_type=${leaves[0]?.tree_type}`)

  // FTS5 虚拟表命中（search 内部执行 memory_fts MATCH，能命中即索引写入成功；
  // 目录骨架的 path 分段同样会被 Trigram 命中，故断言命中集合包含该叶子即可）
  const ftsHits = db.search('生命周期验证', { treeType: identity.scope })
  check(
    'FTS5 分词索引可检索到沉淀记忆',
    ftsHits.length > 0 && ftsHits.some((h) => h.id === leaves[0].id),
    `hits=${ftsHits.length}`,
  )
  check('工程登记表名称 = 工作区基名（非裸哈希展示）', db.listProjects().some((p) => p.scope === identity.scope && p.name === workspaceName))
} finally {
  process.chdir(originalCwd)
}

// ---------------------------------------------------------------------------
// 验证二：自行调用唤醒（Memory Recall / Context Injection）
// ---------------------------------------------------------------------------
section('验证二 · 自行调用唤醒（Memory Recall / Context Injection）')

try {
  const identity = resolveProjectIdentity(workspace)
  const recall = new MemoryRecallEngine(db)

  const hitBefore = db.search(TOKEN.replace(/-/g, ''), { treeType: identity.scope })[0]
  const countBefore = hitBefore.reinforce_count

  // 模拟新一轮用户提问（针对刚才沉淀的技术决策）
  const query = `我们之前定下的生命周期验证令牌（${TOKEN}）决策规则是什么来着？`
  const hits = recall.recall(query, identity.scope, 5)

  check('FTS5 检索命中此前沉淀的记忆节点', hits.some((h) => h.id === hitBefore.id), `hits=${hits.length}`)
  const recalled = hits.find((h) => h.id === hitBefore.id)

  // Memory Block 注入断言：受控标签 + 作用域标注 + 沉淀正文
  const promptBlock = recall.formatPromptBlock(hits)
  check('Memory Block 以 <long_term_memory_context> 受控标签注入', promptBlock.startsWith('<long_term_memory_context>') && promptBlock.endsWith('</long_term_memory_context>'))
  check('Memory Block 标注「当前工程」作用域', recalled !== undefined && promptBlock.includes('[当前工程]'))
  check('Memory Block 携带沉淀正文（含唯一令牌）', promptBlock.includes(TOKEN.replace(/-/g, '')))

  // 断言计数按机制递增：召回一次 = reinforce_count + 1
  const countAfter = db.getNode(recalled.id).reinforce_count
  check('召回命中后断言计数递增（assertions + 1）', countAfter === countBefore + 1, `before=${countBefore} after=${countAfter}`)
} finally {
  db?.close()
  // 清理临时工作区
  try {
    fs.rmSync(workspace, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响验证结论 */
  }
}

// ---------------------------------------------------------------------------
// 汇总报告
// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
console.log('\n========================================')
console.log(`生命周期闭环验证报告：${results.length - failed.length}/${results.length} 项断言通过`)
for (const bySection of [...new Set(results.map((r) => r.section))]) {
  const items = results.filter((r) => r.section === bySection)
  console.log(`  ${bySection}: ${items.filter((i) => i.ok).length}/${items.length} PASS`)
}
console.log('========================================')

if (failed.length > 0) {
  console.error('\n未通过的断言：')
  for (const item of failed) console.error(`  [${item.section}] ${item.name}  <-- ${item.detail}`)
  process.exit(1)
}
console.log('全部断言通过：记忆「自动沉淀 -> FTS5 入库 -> 召回命中 -> Memory Block 注入 -> 断言强化」端到端闭环成立。')
