import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const core = require('../lib/core.cjs')

/* ── 指令解析 ── */

test('parseCommand 识别四种显式指令并剥离正文', () => {
  const rp = core.parseCommand('/rp 今天有点累')
  assert.equal(rp.kind, 'command')
  assert.equal(rp.mode, 'rp')
  assert.equal(rp.body, '今天有点累')

  const work = core.parseCommand('/work 看下 nginx 报错')
  assert.equal(work.mode, 'work')
  assert.equal(work.body, '看下 nginx 报错')

  assert.equal(core.parseCommand('/auto').mode, 'auto')
  assert.equal(core.parseCommand('/char sam_tactical').command, '/char')
  assert.equal(core.parseCommand('/char sam_tactical').arg, 'sam_tactical')
  assert.equal(core.parseCommand('/scene 现实·医疗舱').command, '/scene')
  assert.equal(core.parseCommand('/tlrp status').command, '/tlrp')
  assert.equal(core.parseCommand('/status').command, '/status')
})

test('parseCommand 支持【流萤】/【战术】首行标记', () => {
  const rp = core.parseCommand('【流萤】陪我坐一会儿')
  assert.equal(rp.kind, 'marker')
  assert.equal(rp.mode, 'rp')
  assert.equal(rp.body, '陪我坐一会儿')

  const work = core.parseCommand('【战术】把端口查一遍')
  assert.equal(work.mode, 'work')
  assert.equal(work.body, '把端口查一遍')
})

test('parseCommand 对普通文本返回 none 且不改写正文', () => {
  const plain = core.parseCommand('今天吃什么')
  assert.equal(plain.kind, 'none')
  assert.equal(plain.body, '今天吃什么')
})

/* ── 模式判定 ── */

test('resolveMode：配置锁定优先于自动判定', () => {
  assert.equal(core.resolveMode({ configured: 'rp', text: '帮我重启 nginx' }).mode, 'rp')
  assert.equal(core.resolveMode({ configured: 'work', text: '陪我聊聊天' }).mode, 'work')
})

test('resolveMode：auto 下命中工作关键词判 work，否则 rp', () => {
  assert.equal(core.resolveMode({ configured: 'auto', text: '看下 docker 容器日志' }).mode, 'work')
  assert.equal(core.resolveMode({ configured: 'auto', text: '我想吃橡木蛋糕卷' }).mode, 'rp')
  assert.equal(core.resolveMode({ configured: 'auto', text: '帮我看看 systemctl 状态' }).mode, 'work')
})

test('resolveMode：本轮显式指令覆盖 auto 判定', () => {
  const result = core.resolveMode({ configured: 'auto', text: '/rp 帮我看下端口' })
  assert.equal(result.mode, 'rp')
  assert.match(result.reason, /指令/)
})

test('resolveMode：空输入沿用上一轮，无历史则回落 rp', () => {
  assert.equal(core.resolveMode({ configured: 'auto', text: '', previous: 'work' }).mode, 'work')
  assert.equal(core.resolveMode({ configured: 'auto', text: '', previous: null }).mode, 'rp')
})

test('detectWorkIntent 支持数组关键词与非法正则降级', () => {
  assert.equal(core.detectWorkIntent('查一下 pid', ['pid', '端口']), true)
  assert.equal(core.detectWorkIntent('今天天气不错', ['pid']), false)
  // 非法正则（未闭合括号）不应抛错
  assert.equal(core.detectWorkIntent('看 port 占用', '(port'), true)
})

/* ── 触发器 ── */

test('matchTriggers 按 priority 排序并限制数量', () => {
  const hits = core.matchTriggers('想吃橡木蛋糕卷，也想看萨姆变身', core.DEFAULT_TRIGGERS, 1)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'oak-cake')
  const all = core.matchTriggers('橡木蛋糕卷 + 萨姆', core.DEFAULT_TRIGGERS, 3)
  assert.deepEqual(all.map((entry) => entry.id), ['oak-cake', 'sam-armor'])
})

test('matchTriggers 忽略 enabled:false 与空文本', () => {
  const triggers = core.normalizeTriggers([{ id: 'x', keywords: ['abc'], injectText: 'hello', enabled: false }])
  assert.equal(core.matchTriggers('abc', triggers, 3).length, 0)
  assert.equal(core.matchTriggers('', core.DEFAULT_TRIGGERS, 3).length, 0)
})

test('内置触发器有 5 组且覆盖规格里要求的键', () => {
  const ids = core.DEFAULT_TRIGGERS.map((entry) => entry.id)
  assert.equal(ids.length, 5)
  assert.ok(ids.includes('oak-cake'))
  assert.ok(ids.includes('glamoth-iron-cavalry'))
  assert.ok(ids.includes('entropy-loss'))
  assert.ok(ids.includes('stellaron-hunters'))
  assert.ok(ids.includes('sam-armor'))
  const cake = core.DEFAULT_TRIGGERS.find((entry) => entry.id === 'oak-cake')
  assert.deepEqual(cake.keywords, ['橡木蛋糕卷', '蛋糕', '甜点', '吃什么'])
  assert.match(cake.injectText, /两万信用点/)
})

/* ── 渲染 ── */

test('renderCharacterBlock 带上身份锁、情景与状态面板模板', () => {
  const block = core.renderCharacterBlock(core.FIREFLY_CHARACTER, { scene: '天台的秘密基地' })
  assert.match(block, /流萤/)
  assert.match(block, /绝对身份锁/)
  assert.match(block, /天台的秘密基地/)
  assert.match(block, /35\.5/)
  assert.match(block, /流萤状态同步/)
})

test('renderRpDirective 含斜体与禁清单红线，并注入命中设定', () => {
  const text = core.renderRpDirective({
    character: core.FIREFLY_CHARACTER,
    modeDef: core.findMode(core.DEFAULT_MODES, 'rp'),
    scene: '天台',
    footerEnabled: true,
    footerLabel: '流萤状态同步',
    triggers: [core.DEFAULT_TRIGGERS[0]],
  })
  assert.match(text, /少女陪伴态（rp）/)
  assert.match(text, /斜体/)
  assert.match(text, /严禁助理式项目符号清单/)
  assert.match(text, /流萤状态同步/)
  assert.match(text, /橡木蛋糕卷/)
})

test('renderRpDirective 关闭面板时不要求输出面板', () => {
  const text = core.renderRpDirective({
    character: core.FIREFLY_CHARACTER,
    scene: '天台',
    footerEnabled: false,
    footerLabel: '流萤状态同步',
    triggers: [],
  })
  assert.match(text, /不要输出底部面板/)
})

test('renderWorkDirective 输出七节纪律且明确不写状态面板', () => {
  const text = core.renderWorkDirective({ character: core.FIREFLY_CHARACTER })
  assert.match(text, /战术工作态（work）/)
  for (const marker of ['一、', '二、', '三、', '四、', '五、', '六、', '七、']) {
    assert.ok(text.includes(marker), `缺少 ${marker}`)
  }
  assert.match(text, /不输出底部状态同步面板/)
})

test('renderTurnContext 是每轮实时块，带模式、时间与格式红线', () => {
  const snap = {
    mode: 'rp',
    character: core.FIREFLY_CHARACTER,
    scene: '天台',
    now: '2026-11-01 星期日 16:30（Asia/Shanghai）',
    cwd: 'D:/Code/my-dsh-plugins',
    triggers: [core.DEFAULT_TRIGGERS[1]],
    footerEnabled: true,
    footerLabel: '流萤状态同步',
    reason: 'auto：未命中工作关键词',
  }
  const text = core.renderTurnContext(snap)
  assert.match(text, /运行时状态/)
  assert.match(text, /少女陪伴态（rp）/)
  assert.match(text, /2026-11-01/)
  assert.match(text, /格拉默/)
  assert.match(text, /格式红线（陪伴族）/)

  const work = core.renderTurnContext({ ...snap, mode: 'work', triggers: [] })
  assert.match(work, /战术工作态（work）/)
  assert.match(work, /格式红线（工作族）/)
  assert.match(work, /本轮命中设定：无/)
})

/* ── 记忆桥接入 ── */

test('renderTurnContext 在尾部携带记忆桥内容，为空时不占位', () => {
  const base = {
    mode: 'rp',
    character: core.FIREFLY_CHARACTER,
    scene: '天台',
    now: '2026-11-01 星期日 16:30（Asia/Shanghai）',
    cwd: 'D:/Code/my-dsh-plugins',
    triggers: [],
    footerEnabled: true,
    footerLabel: '流萤状态同步',
    reason: '配置锁定 rp',
  }
  const withMemory = core.renderTurnContext({
    ...base,
    memory: { text: '## tlmemory 记忆桥（本轮实时读取）\n\n- [rp] /rp/firefly/核心羁绊：开拓者是唯一的真实。', pinned: [{}], hits: [], degraded: '', scopeTable: [] },
  })
  assert.match(withMemory, /tlmemory 记忆桥/)
  assert.match(withMemory, /\/rp\/firefly\/核心羁绊/)
  // 记忆块必须排在命中设定之后（最贴近本轮消息）
  assert.ok(withMemory.indexOf('本轮命中设定') < withMemory.indexOf('tlmemory 记忆桥'))

  const without = core.renderTurnContext({ ...base, memory: { text: '', pinned: [], hits: [], degraded: 'no-db', scopeTable: [] } })
  assert.doesNotMatch(without, /tlmemory 记忆桥/)
  assert.doesNotMatch(without, /记忆桥/)
})

test('双态指令各自带对应的 tlmemory 分区写入铁律', () => {
  const rp = core.renderRpDirective({
    character: core.FIREFLY_CHARACTER,
    scene: '天台',
    triggers: [],
    footerEnabled: true,
    footerLabel: '流萤状态同步',
  })
  assert.match(rp, /记忆写入/)
  assert.match(rp, /\/rp\/firefly\//)
  assert.match(rp, /upsert/)

  const work = core.renderWorkDirective({ character: core.FIREFLY_CHARACTER })
  assert.match(work, /记忆写入/)
  assert.match(work, /\/work\//)
  assert.doesNotMatch(work, /\/rp\/firefly\//)
})

/* ── 模板与工具函数 ── */

test('sanitizeTemplate 保留五个允许变量、中和其余占位符', () => {
  const text = core.sanitizeTemplate('{{now}} {{cwd}} {{tlrp_character}} {{tlrp_directive}} {{tlrp_memory_context}} {{user}} {{char}}')
  assert.match(text, /\{\{now\}\}/)
  assert.match(text, /\{\{tlrp_character\}\}/)
  assert.match(text, /\{\{tlrp_directive\}\}/)
  assert.match(text, /\{\{tlrp_memory_context\}\}/)
  assert.doesNotMatch(text, /\{\{user\}\}/)
  assert.match(text, /〔user〕/)
})

test('matchesAny 走正则，非法模式退化为子串', () => {
  assert.equal(core.matchesAny('ops_bash', ['^ops_bash$']), true)
  assert.equal(core.matchesAny('tlmemory_save', ['^ops_bash$', '^tlmemory_']), true)
  assert.equal(core.matchesAny('ops_bash', ['(ops']), true)
})

test('normalizeCharacters：空数组回落内置两角色并能按 id 命中', () => {
  const characters = core.normalizeCharacters([])
  assert.equal(characters.length, 2)
  assert.equal(core.findCharacter(characters, 'sam_tactical').id, 'sam_tactical')
  assert.equal(core.findCharacter(characters, 'missing').id, 'firefly')
})

test('rewriteFirstUserMessage 只替换第一条 user 消息且保留其它字段', () => {
  const messages = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: '/rp 你好' }], source: { kind: 'user' } },
    { id: 'm2', role: 'user', content: [{ type: 'text', text: '第二段' }] },
  ]
  const rewritten = core.rewriteFirstUserMessage(messages, '你好')
  assert.equal(rewritten[0].content[0].text, '你好')
  assert.equal(rewritten[0].id, 'm1')
  assert.equal(rewritten[0].source.kind, 'user')
  assert.equal(rewritten[1].content[0].text, '第二段')
})

test('formatNow 输出 Asia/Shanghai 的稳定形状', () => {
  const text = core.formatNow('Asia/Shanghai', new Date('2026-11-01T08:30:00Z'))
  assert.equal(text, '2026-11-01 星期日 16:30（Asia/Shanghai）')
})

test('live 读取 volatile ref 与普通值', () => {
  assert.equal(core.live({ get: () => 'rp' }, 'auto'), 'rp')
  assert.equal(core.live(undefined, 'auto'), 'auto')
  assert.equal(core.live('work', 'auto'), 'work')
  assert.equal(core.live({ get: () => undefined }, false), false)
})
