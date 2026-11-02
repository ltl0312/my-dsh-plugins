/**
 * tlrp：设置写入通道往返验证（跑真实 dsh-settings 代码，不是复刻）。
 *
 * 证明三件事：
 *   1. 插件的 Config 被 dsh-settings 投影成一份**非空**表单（describe() 有 tlrp 行 + schema 引用表非空）；
 *   2. 九个 volatile 字段逐个 `mutate('tlrp', [{op:'set', path:[field], value}])` 往返成功并回读一致；
 *   3. 非 volatile 字段（timeZone）被宿主拒绝 —— 「只写 volatile」是宿主强制的边界。
 *
 * 运行前提：`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`、`dsh-plugin-tlrp` 可解析。
 *
 *   cd ~/.dsh/profiles/desktop
 *   node D:/Code/my-dsh-plugins/packages/tlrp/scripts/mutate-check.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(process.env.TLRP_PROFILE_BASE || `${process.cwd()}/package.json`)

const { default: SettingsForms } = require('@deepseek-ai/dsh-settings')
const plugin = require('dsh-plugin-tlrp')

if (!plugin.Config) {
  console.error('FAIL: dsh-plugin-tlrp 没有导出 Config（schemastery 未能解析）')
  process.exit(2)
}

const schema = plugin.Config
const parsed = schema({ mode: 'auto' })

/** 极简 configEditor 替身：只实现 dsh-settings 真正调用到的成员。 */
const store = { raw: {} }
// 真实宿主里 bundle 行被 include 包裹，被服务的命名空间是 include:tlrp
const NS = 'include:tlrp'
const entry = {
  id: NS,
  options: { id: NS, config: store.raw },
  fiber: {
    uid: 'uid-tlrp-integration',
    state: 2,
    runtime: { Config: schema },
    config: parsed,
    ctx: {},
  },
}

const noop = () => {}
const fakeCtx = {
  reflect: { provide: noop },
  effect: (fn) => {
    const dispose = typeof fn === 'function' ? fn() : undefined
    return typeof dispose === 'function' ? dispose : noop
  },
  on: () => noop,
  emit: noop,
  root: { loader: { await: () => new Promise(() => {}) } },
  logger: { error: console.error, warn: console.warn, info() {}, debug() {} },
  fiber: {},
}

const configEditor = {
  documentPath: '(integration)',
  entries: () => [entry],
  configuration: () => [{ entry, inherited: {}, override: store.raw }],
  async edit(_entry, change) {
    store.raw = await change(store.raw, {})
    return store.raw
  },
}

const forms = new SettingsForms({ ...fakeCtx, configEditor })

const failures = []
const check = (label, ok, detail) => {
  if (ok) console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`)
  else {
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

/* 1. 表单投影非空 */
const rows = forms.describe()
const row = rows.find((candidate) => candidate.ns === NS)
check('describe() 返回 tlrp 表单', row !== undefined, row === undefined ? `没有命名空间 ${NS}` : `ns=${row.ns} applies=${row.applies} autoGenerate=${row.autoGenerate}`)
const refCount = row?.schema && typeof row.schema === 'object' ? Object.keys(row.schema.refs ?? {}).length : 0
check('表单 schema 引用表非空', refCount > 0, `refs=${refCount}`)

/* 2. 九个 volatile 字段逐个往返 */
const cases = [
  ['enabled', false],
  ['mode', 'rp'],
  ['activeCharacterId', 'sam_tactical'],
  ['workModeKeywords', '端口|报错'],
  ['blockShellToolsInRp', false],
  ['enableStatusFooter', false],
  ['customSceneOverride', '现实宇宙·星舰医疗舱外'],
  ['characters', [{ id: 'firefly', name: '流萤（Firefly）' }]],
  ['triggers', [{ id: 'oak-cake', keywords: ['橡木蛋糕卷'], injectText: '橡木蛋糕卷', priority: 100, enabled: true }]],
]

for (const [field, value] of cases) {
  try {
    await forms.mutate(NS, [{ op: 'set', path: [field], value }])
    const round = forms.describe().find((candidate) => candidate.ns === NS)
    const readBack = round?.user?.[field]
    const ok = JSON.stringify(readBack) === JSON.stringify(value)
    check(`mutate 往返 ${field}`, ok, `写=${JSON.stringify(value).slice(0, 60)} 读=${JSON.stringify(readBack).slice(0, 60)}`)
  } catch (error) {
    check(`mutate 往返 ${field}`, false, error && error.message)
  }
}

/* 3. 配置里写的 tlrp 不是被服务的 ns（宿主会包成 include:tlrp） */
let wrongNsRejected = false
try {
  await forms.mutate('tlrp', [{ op: 'set', path: ['mode'], value: 'work' }])
} catch {
  wrongNsRejected = true
}
check('未被服务的 ns（tlrp）被拒绝', wrongNsRejected, '所以插件必须解析出 include:tlrp 再写')

/* 4. 非 volatile 路径必须被宿主拒绝 */
let rejected = false
let message = ''
try {
  await forms.mutate(NS, [{ op: 'set', path: ['timeZone'], value: 'UTC' }])
} catch (error) {
  rejected = true
  message = error && error.message
}
check('非 volatile 字段被拒绝', rejected, message || '意外成功')

/* 4. 批量写入（模拟一次 /char + /scene 连按） */
try {
  await forms.mutate(NS, [
    { op: 'set', path: ['activeCharacterId'], value: 'firefly' },
    { op: 'set', path: ['customSceneOverride'], value: '匹诺康尼·筑梦边境天台' },
  ])
  const round = forms.describe().find((candidate) => candidate.ns === NS)
  check(
    '批量写入角色与情景',
    round?.user?.activeCharacterId === 'firefly' && round?.user?.customSceneOverride === '匹诺康尼·筑梦边境天台',
    JSON.stringify(round?.user ?? {}).slice(0, 160),
  )
} catch (error) {
  check('批量写入角色与情景', false, error && error.message)
}

/* 5. v0.2.0 工作室：完整角色对象与新触发器往返 */
const fullCharacter = {
  id: 'tester',
  name: '测试角色',
  userTitle: '站长',
  defaultScene: '测试场景',
  identityLock: '不许自称 AI 或跑在端口上的程序',
  corePersona: '第一行背景\n第二行性格',
  appearanceAndSensory: '银灰色长发，指尖微凉',
  actionPresets: '害羞时摩挲手套边缘',
  speechStyle: '短句，带呼吸感',
  dialogueExamples: '「来了。」',
  statusFooterTemplate: '> **{label}**\n> - 情景：{scene}',
}
const fullTrigger = {
  id: 'trigger-test',
  characterId: 'tester',
  keywords: ['测试词', '橡木'],
  injectText: '注入文本',
  priority: 42,
  enabled: true,
}

try {
  await forms.mutate(NS, [
    { op: 'set', path: ['characters'], value: [fullCharacter] },
    { op: 'set', path: ['triggers'], value: [fullTrigger] },
  ])
  const round = forms.describe().find((candidate) => candidate.ns === NS)
  const storedCharacter = round?.user?.characters?.[0]
  const storedTrigger = round?.user?.triggers?.[0]
  check(
    'mutate 往返完整角色（11 字段）',
    JSON.stringify(storedCharacter) === JSON.stringify(fullCharacter),
    JSON.stringify(storedCharacter ?? null).slice(0, 120),
  )
  check(
    'mutate 往返带 characterId 的触发器',
    JSON.stringify(storedTrigger) === JSON.stringify(fullTrigger),
    JSON.stringify(storedTrigger ?? null).slice(0, 120),
  )
} catch (error) {
  check('mutate 往返完整角色（11 字段）', false, error && error.message)
}

/* 6. 写一个字段不许冲掉其它字段 */
try {
  await forms.mutate(NS, [{ op: 'set', path: ['mode'], value: 'work' }])
  const round = forms.describe().find((candidate) => candidate.ns === NS)
  const keptCharacter = round?.user?.characters?.[0]?.id === 'tester'
  const keptTrigger = round?.user?.triggers?.[0]?.id === 'trigger-test'
  const keptMode = round?.user?.mode === 'work'
  check(
    '写 mode 不冲掉 characters / triggers',
    keptCharacter && keptTrigger && keptMode,
    `characters=${keptCharacter} triggers=${keptTrigger} mode=${keptMode}`,
  )
} catch (error) {
  check('写 mode 不冲掉 characters / triggers', false, error && error.message)
}

/* 7. v0.3.0：modes 数组往返（含自定义第 5 个形态）+ 任意形态 id 锁定 */
const fullMode = {
  id: 'debug',
  name: '排障态',
  commandAliases: ['/debug', '【排障】'],
  autoKeywords: '堆栈|崩溃|内存泄漏',
  autoPriority: 99,
  directivePrompt: '只输出根因与最小修复步骤。',
  toolPolicy: 'block_all',
  allowedTools: '',
  injectCharacterPersona: false,
  enableStatusFooter: false,
  statusFooterOverride: '',
  bindCharacterId: '',
  isDefaultFallback: false,
}
const fallbackMode = {
  id: 'rp',
  name: '少女陪伴态',
  commandAliases: ['/rp', '【流萤】'],
  autoKeywords: '喜欢|想你|陪我',
  autoPriority: 10,
  directivePrompt: '',
  toolPolicy: 'whitelist_only',
  allowedTools: 'tlmemory, ask_user_question, schedule',
  injectCharacterPersona: true,
  enableStatusFooter: true,
  statusFooterOverride: '',
  bindCharacterId: 'firefly',
  isDefaultFallback: true,
}

try {
  await forms.mutate(NS, [{ op: 'set', path: ['modes'], value: [fallbackMode, fullMode] }])
  const round = forms.describe().find((candidate) => candidate.ns === NS)
  const storedModes = round?.user?.modes
  check(
    'mutate 往返 modes 数组（含自定义第 5 类形态）',
    JSON.stringify(storedModes) === JSON.stringify([fallbackMode, fullMode]),
    JSON.stringify(storedModes ?? null).slice(0, 160),
  )
  check(
    'modes 往返保留 toolPolicy / 别名 / 兜底位',
    storedModes?.[1]?.toolPolicy === 'block_all' &&
      storedModes?.[1]?.commandAliases?.includes('【排障】') &&
      storedModes?.[0]?.isDefaultFallback === true &&
      storedModes?.[0]?.bindCharacterId === 'firefly',
    JSON.stringify(storedModes?.[1] ?? null).slice(0, 120),
  )
} catch (error) {
  check('mutate 往返 modes 数组（含自定义第 5 类形态）', false, error && error.message)
}

try {
  await forms.mutate(NS, [{ op: 'set', path: ['mode'], value: 'debug' }])
  const round = forms.describe().find((candidate) => candidate.ns === NS)
  check('mode 可锁定到自定义形态 id', round?.user?.mode === 'debug', String(round?.user?.mode))
  check(
    '写 mode 不冲掉 modes 数组',
    Array.isArray(round?.user?.modes) && round.user.modes.length === 2 && round.user.modes[1]?.id === 'debug',
    `modes=${Array.isArray(round?.user?.modes) ? round.user.modes.length : 'null'}`,
  )
} catch (error) {
  check('mode 可锁定到自定义形态 id', false, error && error.message)
}

console.log('')
console.log('最终 raw 配置：')
console.log(JSON.stringify(store.raw).slice(0, 400))
console.log('')
if (failures.length > 0) {
  console.error(`RESULT: FAIL (${failures.length}) → ${failures.join(', ')}`)
  process.exit(1)
}
console.log('RESULT: ALL PASS')
