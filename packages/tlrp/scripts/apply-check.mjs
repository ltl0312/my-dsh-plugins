/**
 * tlrp：apply() 端到端集成检查（真 SystemPrompt + 真 Config + 真插件代码）。
 *
 * 覆盖：
 *   1. 装配：变量 / 核心 section / 尾部 context / 工具 guard / 6 条指令 / pre-step 监听器；
 *   2. 组装：`SystemPrompt.assemble()` + `renderPrompt()` 不抛错（unknown prompt variable = 0），
 *      渲染文本里确实有 tlrp section、角色块、模式准则、当前时间；
 *   3. 双态：auto 闲聊→RP、工程词→WORK，`{{tlrp_directive}}` 随之切换；
 *   4. 拦截：RP 态拒绝 ops_bash、放行 tlmemory_save；WORK 态不拦；关闭态不拦；
 *   5. 指令：/rp 剥离前缀并改写消息、/char 与 /scene 写入 mutate、/tlrp status 汇报；
 *   6. 触发：命中「橡木蛋糕卷」后 context 与 directive 里都出现注入设定；
 *   7. 多角色：`activeCharacterId: sam_tactical` 的独立装配渲染出萨姆人格。
 *
 * 运行：
 *   cd ~/.dsh/profiles/desktop
 *   node D:/Code/my-dsh-plugins/packages/tlrp/scripts/apply-check.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(process.env.TLRP_PROFILE_BASE || `${process.cwd()}/package.json`)

const { SystemPrompt, renderPrompt, renderContextSections } = require('@deepseek-ai/dsh-system-prompt')
const plugin = require('dsh-plugin-tlrp')

const failures = []
const check = (label, ok, detail) => {
  if (ok) console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`)
  else {
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}
const noop = () => {}

if (typeof plugin.apply !== 'function' || !plugin.Config) {
  console.error('FAIL: dsh-plugin-tlrp 需要同时导出 apply 与 Config')
  process.exit(2)
}

/**
 * 搭一个最小宿主：只实现插件与 systemPrompt 真正调用到的成员。
 * 关键点是 effect() 必须把 ScopedLayers 传进来的 generator 驱动到第一次 yield，
 * 否则注册根本不会发生（真实 Cordis 就是这么做的）。
 */
function createHarness(configOverrides = {}, options = {}) {
  const services = {}
  const handlers = new Map()
  const mutations = []
  const followed = []

  const ctx = {
    logger: () => ({ info: noop, warn: console.warn, error: console.error, debug: noop }),
    reflect: { provide: noop },
    emit: noop,
    on(event, listener) {
      handlers.set(event, listener)
      return noop
    },
    effect(fn) {
      const result = typeof fn === 'function' ? fn() : undefined
      if (result && typeof result.next === 'function') {
        result.next()
        return () => {
          try {
            result.return?.()
          } catch {
            /* 忽略 */
          }
        }
      }
      return typeof result === 'function' ? result : noop
    },
    inject(deps, callback) {
      if (deps.every((dep) => services[dep] !== undefined)) callback(ctx)
    },
    async waterfall(_carrier, _event, _payload, _context, fallback) {
      return fallback()
    },
    get systemPrompt() {
      return services.systemPrompt
    },
    get tools() {
      return services.tools
    },
    get commands() {
      return services.commands
    },
    get agents() {
      return services.agents
    },
    get settings() {
      return services.settings
    },
    get sessionProjections() {
      return services.sessionProjections
    },
  }

  services.systemPrompt = new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: true })
  services.tools = {
    guards: [],
    guard(fn) {
      this.guards.push(fn)
      return noop
    },
  }
  services.commands = {
    defs: [],
    register(definition) {
      this.defs.push(definition)
      return noop
    },
  }
  services.agents = {}
  services.sessionProjections = { stateOf: () => undefined }
  /**
   * 真实宿主里 bundle 行会被包进 include，设置命名空间因此是 `include:tlrp`
   * 而不是配置里写的 `tlrp`。这里按这个现实建模：只认 include:tlrp，写 tlrp
   * 直接报「没有这个可配置条目」——用来验证插件的命名空间解析。
   */
  services.settings = {
    describe() {
      return [
        {
          ns: 'include:tlrp',
          value: { mode: 'auto', activeCharacterId: 'firefly', customSceneOverride: '', characters: [], triggers: [] },
        },
        { ns: 'include:tool-bash', value: { publishBashTool: true } },
      ]
    },
    async mutate(ns, ops, expectedRevision) {
      if (ns !== 'include:tlrp') throw new Error(`No configurable plugin entry "${ns}"`)
      mutations.push({ ns, ops, expectedRevision })
      return undefined
    },
  }

  const agent = {
    session: { seq: 0, eventAt: () => undefined },
    followup(input) {
      followed.push(input)
    },
  }

  // 模拟 prompt-clock 先注册 now/cwd 的部署：tlrp 必须让位而不是抛 duplicate
  if (options.preRegistered) {
    for (const [name, value] of Object.entries(options.preRegistered)) {
      services.systemPrompt.variable(name, () => value)
    }
  }

  plugin.apply(ctx, plugin.Config(configOverrides))
  const userMessage = (text) => ({
    id: `m-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })

  async function run(text) {
    const preStep = handlers.get('agent/pre-step')
    const decision = await preStep({ agent, turn: 1, step: 1, signal: { aborted: false } }, async () => ({
      kind: 'enter',
      messages: [userMessage(text)],
    }))
    const assembly = await services.systemPrompt.assemble({ agent })
    return {
      decision,
      prompt: renderPrompt(assembly),
      contexts: renderContextSections(assembly)
        .map((entry) => entry.text)
        .join('\n'),
    }
  }

  return {
    ctx,
    services,
    handlers,
    mutations,
    followed,
    agent,
    run,
    guard: (name) => services.tools.guards[0]({ name, agent }),
  }
}

/* ── 1. 装配注册 ── */
const h = createHarness({ mode: 'auto' })
check('注册了 pre-step 监听器', typeof h.handlers.get('agent/pre-step') === 'function')
check('注册了内置指令 + 形态别名', ['auto','mode','char','scene','title','trigger','tlrp'].every((name) => h.services.commands.defs.some((d) => d.name === name)), h.services.commands.defs.map((d) => `/${d.name}`).join(' '))
check(
  'v0.2.0 新命令 /title 与 /trigger 在位',
  ['title', 'trigger'].every((name) => h.services.commands.defs.some((definition) => definition.name === name)),
  h.services.commands.defs.map((d) => `/${d.name}`).join(' '),
)
check('注册了工具 guard', h.services.tools.guards.length === 1)

/* ── 2. 组装 + 渲染 ── */
const plain = await h.run('今天有点想你了')
check('renderPrompt 不抛错（unknown prompt variable = 0）', plain.prompt.length > 0, `${plain.prompt.length} 字符`)
check('核心 section 已装配', plain.prompt.includes('tlrp 角色与形态装配'))
check('角色块已装配', plain.prompt.includes('流萤（Firefly）') && plain.prompt.includes('绝对身份锁'))
check('时间变量已解析', /20\d\d-\d\d-\d\d .+（Asia\/Shanghai）/.test(plain.prompt), plain.prompt.match(/当前时间：[^\n]+/)?.[0])
check('auto 闲聊判 RP', plain.prompt.includes('本轮运行模式：少女陪伴态（rp）'))
check('RP 准则含斜体与禁清单红线', plain.prompt.includes('斜体') && plain.prompt.includes('严禁助理式项目符号清单'))
check('尾部 context 已生成', plain.contexts.includes('tlrp 运行时状态') && plain.contexts.includes('运行模式：少女陪伴态（rp）'))

const work = await h.run('看下 nginx 报错和端口占用')
check('auto 工程词判 WORK', work.prompt.includes('本轮运行模式：战术工作态（work）'), work.prompt.match(/本轮运行模式：[^\n]+/)?.[0])
check('WORK 准则含七节纪律', work.prompt.includes('七、说完就停'))
check('WORK 尾部 context 声明不写面板', work.contexts.includes('状态面板：本轮关闭'))

/* ── 3. 工具拦截 ── */
check('WORK 态放行 ops_bash', h.guard('ops_bash') === undefined)
await h.run('/rp 我们聊会儿天')
const denial = h.guard('ops_bash')
check('RP 态拦截 ops_bash', typeof denial === 'string' && denial.includes('不在工具白名单内'), typeof denial === 'string' ? denial.split('\n')[0] : String(denial))
check('RP 态放行 tlmemory_save', h.guard('tlmemory_save') === undefined, '记忆类工具白名单')
check('RP 态放行 ask_user_question', h.guard('ask_user_question') === undefined)

/* ── 4. 指令 ── */
const rpRun = await h.run('/rp 陪我坐一会儿')
check('/rp 剥离指令前缀', rpRun.decision?.messages?.[0]?.content?.[0]?.text === '陪我坐一会儿', JSON.stringify(rpRun.decision?.messages?.[0]?.content?.[0]?.text))
check(
  '/rp 写入 settings.mutate（解析到被服务的 include:tlrp）',
  h.mutations.some((entry) => entry.ns === 'include:tlrp' && entry.ops?.some((op) => op.path?.[0] === 'mode' && op.value === 'rp')),
  JSON.stringify(h.mutations.at(-1)),
)

await h.run('/char sam_tactical')
check(
  '/char 写入 activeCharacterId',
  h.mutations.some((entry) => entry.ops?.some((op) => op.path?.[0] === 'activeCharacterId' && op.value === 'sam_tactical')),
  JSON.stringify(h.mutations.at(-1)),
)

const sceneRun = await h.run('/scene 现实宇宙·星舰医疗舱外')
check('/scene 覆盖情景', sceneRun.prompt.includes('星舰医疗舱外') && sceneRun.contexts.includes('星舰医疗舱外'))
check(
  '/scene 写入 customSceneOverride',
  h.mutations.some((entry) => entry.ops?.some((op) => op.path?.[0] === 'customSceneOverride' && op.value === '现实宇宙·星舰医疗舱外')),
)

const titleHandler = h.services.commands.defs.find((definition) => definition.name === 'title')?.handler
const titled = await titleHandler({ agent: h.agent, rawInput: '站长' })
check(
  '/title 写入 characters[].userTitle',
  titled?.kind === 'success' &&
    h.mutations.some((entry) => entry.ops?.some((op) => op.path?.[0] === 'characters' && op.value?.[0]?.userTitle === '站长')),
  titled?.text?.split('\n')[0],
)

const triggerHandler = h.services.commands.defs.find((definition) => definition.name === 'trigger')?.handler
const added = await triggerHandler({ agent: h.agent, rawInput: 'add 烤焦的肉,烤肉=那天大家都吃了焦炭味的肉干' })
check(
  '/trigger add 写入 triggers',
  added?.kind === 'success' &&
    h.mutations.some((entry) =>
      entry.ops?.some((op) => op.path?.[0] === 'triggers' && op.value?.some?.((item) => item.keywords?.includes('烤肉'))),
    ),
  added?.text?.split('\n')[0],
)

const statusHandler = h.services.commands.defs.find((definition) => definition.name === 'tlrp')?.handler
const status = await statusHandler({ agent: h.agent, rawInput: 'status' })
check('/tlrp status 返回汇总', status?.kind === 'success' && status.text.includes('已注册形态'), status?.text?.split('\n')[1])

/* ── 5. 触发映射 ── */
const triggered = await h.run('好想吃橡木蛋糕卷啊')
check('命中橡木蛋糕卷触发器', triggered.contexts.includes('两万信用点'), triggered.contexts.match(/\[oak-cake\][^\n]{0,40}/)?.[0])
check('注入内容进入 {{tlrp_directive}}', triggered.prompt.includes('橡木蛋糕卷') && triggered.prompt.includes('两万信用点'))

/* ── 6. 多角色切换 ── */
const sam = createHarness({ activeCharacterId: 'sam_tactical' })
const samRun = await sam.run('报一下状态')
check('sam_tactical 渲染独立人格', samRun.prompt.includes('萨姆（SAM · 纯战术态）'), samRun.prompt.match(/角色设定（当前激活：[^\n]+/)?.[0])
check('sam_tactical 的语言风格生效', samRun.prompt.includes('极度简练'))
check('sam_tactical 无状态面板模板', !samRun.prompt.includes('底部状态同步面板模板'))

/* ── 7. 与 prompt-clock 共存：now/cwd 已被占用时 tlrp 让位 ── */
const coexisting = createHarness({ mode: 'auto' }, { preRegistered: { now: 'SENTINEL-NOW', cwd: 'SENTINEL-CWD' } })
const coexistRun = await coexisting.run('今天有点想你了')
check('now/cwd 已被占用时 apply 不崩溃', coexistRun.prompt.length > 0, `${coexistRun.prompt.length} 字符`)
check('让位后沿用既有 provider', coexistRun.prompt.includes('SENTINEL-NOW') && coexistRun.prompt.includes('SENTINEL-CWD'))
check('让位后 tlrp 自身的变量仍工作', coexistRun.prompt.includes('流萤（Firefly）') && coexistRun.prompt.includes('少女陪伴态（rp）'))

/* ── 8. 关闭态 ── */
const off = createHarness({ enabled: false })
const offRun = await off.run('看下 docker 日志')
check('关闭态准则中性', offRun.prompt.includes('tlrp：未启用'))
check('关闭态不拦截工具', off.guard('ops_bash') === undefined)
check('关闭态 context 声明忽略', offRun.contexts.includes('插件已关闭'))

/* ── 9. v0.3.0：自定义第 5 个形态 + 动态指令切换 ── */
const debugMode = {
  id: 'debug',
  name: '排障态',
  commandAliases: ['/debug', '【排障】'],
  autoKeywords: '堆栈|崩溃|内存泄漏',
  autoPriority: 99,
  directivePrompt: '## 本轮运行模式：排障态（debug）\n- 只输出根因与最小修复步骤，不写抒情段落。',
  toolPolicy: 'block_all',
  allowedTools: '',
  injectCharacterPersona: false,
  enableStatusFooter: false,
  statusFooterOverride: '',
  bindCharacterId: '',
}
const fiveModes = [...plugin.__internals.DEFAULT_MODES, debugMode]

const custom = createHarness({ mode: 'auto', modes: fiveModes })
check(
  '自定义第 5 个形态注册了斜杠指令',
  custom.services.commands.defs.some((definition) => definition.name === 'debug'),
  custom.services.commands.defs.map((d) => `/${d.name}`).join(' '),
)

const debugRun = await custom.run('帮忙看下这个崩溃堆栈和内存泄漏')
check('自定义形态被 auto 关键词命中', debugRun.prompt.includes('排障态'), debugRun.prompt.match(/本轮运行模式：[^\n]+/)?.[0])
check('自定义形态专属准则生效', debugRun.prompt.includes('只输出根因与最小修复步骤'))
check('自定义形态精简注入人设', !debugRun.prompt.includes('外貌与感官细节'))
check('自定义形态不输出状态面板', debugRun.contexts.includes('状态面板：本轮关闭'), (debugRun.contexts.match(/- 状态面板：.*/) ?? [])[0])
const debugDenial = custom.guard('ops_bash')
check('自定义形态 toolPolicy=block_all 拦截工具', typeof debugDenial === 'string', String(debugDenial).split('\n')[0])

const switcher = createHarness({ mode: 'auto', modes: fiveModes })
const byModeCommand = await switcher.run('/mode sam 开始吧')
check(
  '/mode <id> 写入 mode',
  switcher.mutations.some((entry) => entry.ops?.some((op) => op.path?.[0] === 'mode' && op.value === 'sam')),
  JSON.stringify(switcher.mutations.at(-1)),
)
check('/mode <id> 剥离正文', byModeCommand.decision?.messages?.[0]?.content?.[0]?.text === '开始吧', JSON.stringify(byModeCommand.decision?.messages?.[0]?.content?.[0]?.text))

const byAlias = await switcher.run('【排障】先别抒情')
check(
  '自定义括号别名切形态',
  switcher.mutations.some((entry) => entry.ops?.some((op) => op.path?.[0] === 'mode' && op.value === 'debug')),
  JSON.stringify(switcher.mutations.at(-1)),
)
check('自定义括号别名剥离标记', byAlias.decision?.messages?.[0]?.content?.[0]?.text === '先别抒情', JSON.stringify(byAlias.decision?.messages?.[0]?.content?.[0]?.text))

const slashAlias = await switcher.run('/debug 只给结论')
check(
  '自定义斜杠别名切形态',
  switcher.mutations.some((entry) => entry.ops?.some((op) => op.path?.[0] === 'mode' && op.value === 'debug')),
  JSON.stringify(switcher.mutations.at(-1)),
)

console.log('')
if (failures.length > 0) {
  console.error(`RESULT: FAIL (${failures.length}) → ${failures.join(', ')}`)
  process.exit(1)
}
console.log('RESULT: ALL PASS')
