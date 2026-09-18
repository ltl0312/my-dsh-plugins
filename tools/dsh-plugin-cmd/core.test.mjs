// tools/dsh-plugin-cmd/core.test.mjs
// 纯逻辑层单测：node --test tools/dsh-plugin-cmd/
//
// fixture 直接照抄真实 profile（~/.dsh/profiles/web）的 cordis.patch.yml 与
// pnpm-workspace.yaml —— 注释、缩进、引号风格全部一致，避免「测试通过但真文件不认」。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUILD_APPROVAL_KEYS,
  BUILD_PLACEHOLDER,
  GIT_SPEC_PATTERN,
  LOCK_FILENAME,
  PROXY_ENV_MAP,
  appendPatchItem,
  classifyDshPackage,
  declaredDefaultConfig,
  deriveEntryId,
  detectEol,
  findForwardedProfileFlag,
  findMountedEntry,
  indentOf,
  isInstallingSubcommand,
  isMutatingSubcommand,
  listBuildPlaceholders,
  listMountedEntries,
  parseGlobalFlags,
  parsePluginSubcommand,
  parseTimeoutToken,
  patchEntries,
  planAllowBuildsEdit,
  planPatchRemoval,
  renderInsertBlock,
  renderYamlScalar,
  requiresNativeBuild,
  timestamp,
  toLines,
  topLevelItems,
  unquoteScalar,
} from './core.mjs'

/** 真实 profile 的 cordis.patch.yml（逐字节照抄，含全部注释） */
const REAL_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
#
# dsh-web-ui 全家桶已通过 bundle 机制激活:聚合包 @linxin666/dsh-web-ui-all
# 在 package.json 的 dsh.profile.bundles 中,其包内 cordis.patch.yml 的
# 16 个插件行(web-ui-*)会在启动时自动挂载,无需在此重复配置。
- id: skin
  name: dsh-skin
  disabled: true
# ============================================================
# tlmemory 长期记忆插件（阶段六：无感静默沉淀 + 原生侧边栏/主视口嵌入）
# 单一宿主自洽拓扑：本 GUI 宿主同时承担
#   - 会话事件无感静默沉淀（turn/end 异步提炼写入 ~/.dsh/tlmemory.db）；
#   - 内嵌 127.0.0.1:4890 记忆看板服务（serverEnabled: true，独占端口）；
#   - 客户端插件注册（sidebar.footer.action 左侧导航 + conversation.view 主视口）。
# 若另有常驻宿主独占 4890（旧拓扑），可置 serverEnabled: false 避免端口冲突，
# 两侧共用同一 SQLite 文件（WAL 多进程安全）。
# ============================================================
- insert:
    - id: tlmemory-runtime
      name: "dsh-plugin-tlmemory"
      config:
        serverPort: 4890
        maxRecallCount: 5
        enableAutoReflection: true
        serverEnabled: true
`

/** 真实 profile 的 pnpm-workspace.yaml（照抄） */
const REAL_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  cloudflared: true
  cpu-features: true
  node-pty: true
  ssh2: true
  voyager: true
  tree-sitter-bash: true
  sharp: ${BUILD_PLACEHOLDER}
  tesseract.js: ${BUILD_PLACEHOLDER}
  dsh-plugin-writing-guard: ${BUILD_PLACEHOLDER}
  better-sqlite3: true
minimumReleaseAgeExclude:
  - dshmarket@1.45.0
  - '@liustack/modlens@3.26.1'
`

/* --------------------------------------------------------------- 行工具 */

test('detectEol 识别 CRLF 与 LF', () => {
  assert.equal(detectEol('a\nb\n'), '\n')
  assert.equal(detectEol('a\r\nb\r\n'), '\r\n')
})

test('toLines 保留空行以便与原文行号对齐', () => {
  assert.deepEqual(toLines('a\n\nb'), ['a', '', 'b'])
})

test('indentOf 计前导空格', () => {
  assert.equal(indentOf('    - id: x'), 4)
  assert.equal(indentOf('- insert:'), 0)
  assert.equal(indentOf(''), 0)
})

test('unquoteScalar 去引号但不动裸标量', () => {
  assert.equal(unquoteScalar('"dsh-plugin-tlmemory"'), 'dsh-plugin-tlmemory')
  assert.equal(unquoteScalar("'a-b'"), 'a-b')
  assert.equal(unquoteScalar('dsh-skin'), 'dsh-skin')
  assert.equal(unquoteScalar('  "x"  '), 'x')
})

/* -------------------------------------------------- 顶层项与挂载条目定位 */

test('topLevelItems 认出两个顶层项，且把文件表头与项说明注释区分开', () => {
  const lines = toLines(REAL_PATCH)
  const items = topLevelItems(lines)
  assert.equal(items.length, 2)
  // 第一项（skin 覆盖）前是文件表头（第 1-7 行），不应随该项一起被删
  assert.equal(items[0].start, 7)
  assert.equal(items[0].headerOwned, true)
  assert.equal(items[0].ownEnd, 9)
  // 第二项（tlmemory insert）前是本项专属说明注释（第 11-19 行）
  assert.equal(items[1].start, 19)
  assert.equal(items[1].ownEnd, 26)
  assert.equal(items[1].commentStart, 10)
  assert.equal(items[1].headerOwned, false)
})

test('patchEntries 取出挂载条目的 id / name / 行范围', () => {
  const entries = patchEntries(toLines(REAL_PATCH))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'dsh-plugin-tlmemory')
  assert.equal(entries[0].id, 'tlmemory-runtime')
  assert.equal(entries[0].start, 20)
  assert.equal(entries[0].end, 26)
})

test('entryScalar 不会把 config 里的同名键误当成条目字段', () => {
  const text = ['- insert:', '    - id: a', '      name: "pkg-a"', '      config:', '        name: inner'].join('\n')
  const entries = patchEntries(toLines(text))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'pkg-a')
})

test('findMountedEntry 按 name 判等（id 是用户可任意命名的）', () => {
  assert.ok(findMountedEntry(REAL_PATCH, 'dsh-plugin-tlmemory'))
  assert.equal(findMountedEntry(REAL_PATCH, 'tlmemory-runtime'), undefined)
  assert.equal(findMountedEntry(REAL_PATCH, 'other-plugin'), undefined)
})

test('listMountedEntries 给出 id/name/行号', () => {
  assert.deepEqual(listMountedEntries(REAL_PATCH), [
    { id: 'tlmemory-runtime', name: 'dsh-plugin-tlmemory', line: 21 },
  ])
})

test('支持多个 insert 项与组内 id 插入共存', () => {
  const text = [
    '- id: skin',
    '  name: dsh-skin',
    '  disabled: true',
    '- insert:',
    '    - id: a',
    '      name: "pkg-a"',
    '- id: some-group',
    '  group: true',
    '  insert:',
    '    - id: b',
    '      name: "pkg-b"',
    '',
  ].join('\n')
  const names = listMountedEntries(text).map((entry) => entry.name)
  assert.deepEqual(names, ['pkg-a', 'pkg-b'])
})

/* -------------------------------------------------------------- 新增条目 */

test('deriveEntryId 产出稳定可用的 YAML 标量 id', () => {
  assert.equal(deriveEntryId('dsh-plugin-tlmemory'), 'dsh-plugin-tlmemory')
  assert.equal(deriveEntryId('@linxin666/dsh-ssh'), 'linxin666-dsh-ssh')
  assert.equal(deriveEntryId('@a/@b'), 'a-b')
  assert.equal(deriveEntryId('***'), 'plugin')
})

test('renderYamlScalar 字符串加引号、布尔与数字裸写', () => {
  assert.equal(renderYamlScalar('x'), '"x"')
  assert.equal(renderYamlScalar(true), 'true')
  assert.equal(renderYamlScalar(4890), '4890')
  assert.equal(renderYamlScalar('a"b'), '"a\\"b"')
})

test('renderInsertBlock 无 config 时只写 id 与 name', () => {
  assert.equal(
    renderInsertBlock({ id: 'x', name: 'pkg-x' }),
    ['- insert:', '    - id: "x"', '      name: "pkg-x"'].join('\n'),
  )
})

test('renderInsertBlock 渲染嵌套 config（标量 / 数组 / 子对象）', () => {
  const block = renderInsertBlock({
    id: 'x',
    name: 'pkg-x',
    config: { serverPort: 4890, enabled: true, tags: ['a', 'b'], nested: { deep: 'v' } },
  })
  assert.equal(
    block,
    [
      '- insert:',
      '    - id: "x"',
      '      name: "pkg-x"',
      '      config:',
      '        serverPort: 4890',
      '        enabled: true',
      '        tags:',
      '          - "a"',
      '          - "b"',
      '        nested:',
      '          deep: "v"',
    ].join('\n'),
  )
})

test('appendPatchItem 保留原有全部字节并接上新条目', () => {
  const next = appendPatchItem(REAL_PATCH, renderInsertBlock({ id: 'new-plugin', name: 'new-plugin' }))
  assert.ok(next.startsWith(REAL_PATCH.trimEnd()))
  const names = listMountedEntries(next).map((entry) => entry.name)
  assert.deepEqual(names, ['dsh-plugin-tlmemory', 'new-plugin'])
})

test('appendPatchItem 对空文件也能产出合法结构（且不以空行开头）', () => {
  const next = appendPatchItem('', renderInsertBlock({ id: 'x', name: 'pkg-x' }))
  assert.ok(next.startsWith('- insert:'), JSON.stringify(next.slice(0, 20)))
  assert.equal(listMountedEntries(next).length, 1)
})

test('listBuildPlaceholders 只列出未决的占位项', () => {
  assert.deepEqual(listBuildPlaceholders(REAL_WORKSPACE).sort(), [
    'dsh-plugin-writing-guard',
    'sharp',
    'tesseract.js',
  ])
  assert.deepEqual(listBuildPlaceholders('allowBuilds:\n  a: true\n  b: false\n'), [])
  assert.deepEqual(listBuildPlaceholders('packages:\n  - .\n'), [])
  assert.deepEqual(listBuildPlaceholders(''), [])
  assert.deepEqual(listBuildPlaceholders('allowBuilds:\n  only-placeholder: set this to true or false\n'), ['only-placeholder'])
})

test('appendPatchItem 沿用原文件的 CRLF', () => {
  const next = appendPatchItem('- id: a\r\n  name: b\r\n', renderInsertBlock({ id: 'x', name: 'pkg-x' }))
  assert.ok(next.includes('\r\n'))
  assert.ok(!/(?<!\r)\n/.test(next))
})

/* -------------------------------------------------------------- 移除手术 */

test('planPatchRemoval 连带删掉该项的专属说明注释，且不碰文件表头', () => {
  const plan = planPatchRemoval(REAL_PATCH, 'dsh-plugin-tlmemory')
  assert.equal(plan.removed, 1)
  assert.equal(listMountedEntries(plan.text).length, 0)
  // 文件表头与 skin 项必须留下
  assert.ok(plan.text.includes('# Your patch layer for this dsh profile'))
  assert.ok(plan.text.includes('- id: skin'))
  assert.ok(plan.text.includes('name: dsh-skin'))
  // 该项的说明注释应一并消失
  assert.ok(!plan.text.includes('tlmemory 长期记忆插件'))
  assert.ok(!plan.text.includes('tlmemory-runtime'))
})

test('planPatchRemoval 对未被挂载的包原样返回', () => {
  const plan = planPatchRemoval(REAL_PATCH, 'nope')
  assert.equal(plan.removed, 0)
  assert.equal(plan.text, REAL_PATCH)
})

test('planPatchRemoval 在同一项内只摘目标条目、保留兄弟条目', () => {
  const text = [
    '- insert:',
    '    - id: a',
    '      name: "pkg-a"',
    '    - id: b',
    '      name: "pkg-b"',
    '',
  ].join('\n')
  const plan = planPatchRemoval(text, 'pkg-a')
  assert.equal(plan.removed, 1)
  const names = listMountedEntries(plan.text).map((entry) => entry.name)
  assert.deepEqual(names, ['pkg-b'])
  assert.ok(plan.text.startsWith('- insert:'))
})

test('移除第一项时保留文件表头注释', () => {
  const plan = planPatchRemoval(REAL_PATCH, 'dsh-skin')
  assert.equal(plan.removed, 1)
  assert.ok(!plan.text.includes('disabled: true'))
  assert.ok(plan.text.includes('# Your patch layer for this dsh profile'))
  assert.ok(plan.text.includes('name: "dsh-plugin-tlmemory"'))
})

/* --------------------------------------------------------- allowBuilds */

test('planAllowBuildsEdit 把 pnpm 的占位值填成 true', () => {
  const plan = planAllowBuildsEdit(REAL_WORKSPACE, ['sharp', 'tesseract.js'])
  assert.deepEqual(plan.approved, ['sharp', 'tesseract.js'])
  assert.deepEqual(plan.added, [])
  assert.ok(plan.text.includes('sharp: true'))
  assert.ok(plan.text.includes('tesseract.js: true'))
  assert.ok(!plan.text.includes(BUILD_PLACEHOLDER + '\n  tesseract.js: ' + BUILD_PLACEHOLDER))
})

test('planAllowBuildsEdit 追加缺失的包名而不动既有条目', () => {
  const plan = planAllowBuildsEdit(REAL_WORKSPACE, ['better-sqlite3', 'node-gyp-build'])
  assert.deepEqual(plan.added, ['node-gyp-build'])
  assert.deepEqual(plan.approved, [])
  assert.ok(plan.text.includes('  node-gyp-build: true'))
  // 既有条目与其它段落原样保留
  assert.ok(plan.text.includes('cloudflared: true'))
  assert.ok(plan.text.includes('minimumReleaseAgeExclude:'))
  assert.ok(plan.text.includes('- dshmarket@1.45.0'))
})

test('planAllowBuildsEdit 绝不覆盖用户显式的 false', () => {
  const plan = planAllowBuildsEdit(REAL_WORKSPACE, ['sharp'])
  const withFalse = planAllowBuildsEdit(REAL_WORKSPACE.replace(`sharp: ${BUILD_PLACEHOLDER}`, 'sharp: false'), ['sharp'])
  assert.deepEqual(withFalse.approved, [])
  assert.deepEqual(withFalse.added, [])
  assert.deepEqual(withFalse.skipped, ['sharp'])
  assert.ok(withFalse.text.includes('sharp: false'))
  assert.ok(plan.text.includes('sharp: true'))
})

test('planAllowBuildsEdit 在缺少 allowBuilds 段时新建', () => {
  const plan = planAllowBuildsEdit('packages:\n  - .\n', ['better-sqlite3'])
  assert.deepEqual(plan.added, ['better-sqlite3'])
  assert.equal(plan.text, 'packages:\n  - .\n\nallowBuilds:\n  better-sqlite3: true\n')
})

test('planAllowBuildsEdit 对空文件新建段落且目标为空时不动文本', () => {
  const created = planAllowBuildsEdit('', ['x'])
  assert.equal(created.text, 'allowBuilds:\n  x: true\n')
  const untouched = planAllowBuildsEdit(REAL_WORKSPACE, [])
  assert.equal(untouched.text, REAL_WORKSPACE)
})

/* ------------------------------------------------------------- 包分类 */

test('classifyDshPackage 区分 bundle / plugin / library', () => {
  assert.equal(classifyDshPackage({ dsh: { bundle: { patch: './cordis.patch.yml' } } }).kind, 'bundle')
  assert.equal(classifyDshPackage({ dsh: { client: { platform: 'web' } } }).kind, 'plugin')
  assert.equal(classifyDshPackage({ dsh: {} }).kind, 'library')
  assert.equal(classifyDshPackage({}).kind, 'library')
  assert.equal(classifyDshPackage(undefined).kind, 'library')
})

test('declaredDefaultConfig 只在包显式声明时返回对象', () => {
  assert.deepEqual(declaredDefaultConfig({ dsh: { defaultConfig: { a: 1 } } }), { a: 1 })
  assert.deepEqual(declaredDefaultConfig({ dsh: { config: { b: 2 } } }), { b: 2 })
  assert.equal(declaredDefaultConfig({ dsh: { client: {} } }), undefined)
  assert.equal(declaredDefaultConfig({}), undefined)
})

test('requiresNativeBuild 复刻 pnpm 的判定（install 脚本或 binding.gyp）', () => {
  assert.equal(requiresNativeBuild({ scripts: { install: 'node-gyp rebuild' } }), true)
  assert.equal(requiresNativeBuild({ scripts: { postinstall: 'x' } }), true)
  assert.equal(requiresNativeBuild({ scripts: { preinstall: 'x' } }), true)
  assert.equal(requiresNativeBuild({ scripts: { test: 'x' } }, []), false)
  assert.equal(requiresNativeBuild({}, ['binding.gyp', 'index.js']), true)
  assert.equal(requiresNativeBuild({}, ['index.js']), false)
})

/* ------------------------------------------------ 全局旗标与常量（P2/P3） */

test('parseGlobalFlags 摘出本层全局旗标，其余原样留给 pnpm', () => {
  const flags = parseGlobalFlags(['add', 'pkg', '--json', '--timeout', '30s', '--yes', '--no-lock', '-D'])
  assert.equal(flags.json, true)
  assert.equal(flags.timeoutMs, 30000)
  assert.equal(flags.timeoutRaw, '30s')
  assert.equal(flags.newProfile, true)
  assert.equal(flags.lock, false)
  assert.deepEqual(flags.rest, ['add', 'pkg', '-D'], '本层旗标不得转发给 pnpm')
})

test('parseGlobalFlags 支持 --k=v 写法、非法超时值与默认值', () => {
  const equals = parseGlobalFlags(['list', '--json=false', '--timeout=1500'])
  assert.equal(equals.json, false)
  assert.equal(equals.timeoutMs, 1500)
  assert.deepEqual(equals.rest, ['list'])

  const noValue = parseGlobalFlags(['list', '--timeout'])
  assert.equal(noValue.timeoutMs, undefined)
  assert.equal(noValue.timeoutRaw, undefined, '缺值时按未给处理')

  const garbage = parseGlobalFlags(['list', '--timeout=ten'])
  assert.equal(garbage.timeoutMs, undefined)
  assert.equal(garbage.timeoutRaw, 'ten', '非法值要留证据给上层报错')

  assert.deepEqual(parseGlobalFlags(['why', 'x']), {
    json: false,
    timeoutMs: undefined,
    timeoutRaw: undefined,
    newProfile: false,
    lock: true,
    rest: ['why', 'x'],
  })
})

test('parseTimeoutToken 支持 ms / s / m 与小数', () => {
  assert.equal(parseTimeoutToken('1500'), 1500)
  assert.equal(parseTimeoutToken('30s'), 30000)
  assert.equal(parseTimeoutToken('5m'), 300000)
  assert.equal(parseTimeoutToken('0.5s'), 500)
  assert.equal(parseTimeoutToken('abc'), undefined)
  assert.equal(parseTimeoutToken(undefined), undefined)
})

test('parsePluginSubcommand 把全局旗标与子命令自身旗标分开，并保留 flags', () => {
  const add = parsePluginSubcommand(['add', 'pkg', '--id', 'x', '--json', '--dry-run', '--timeout=2s'])
  assert.equal(add.kind, 'add')
  assert.equal(add.flags.json, true)
  assert.equal(add.flags.timeoutMs, 2000)
  assert.equal(add.own.id, 'x')
  assert.equal(add.own.dryRun, true)
  assert.deepEqual(add.specs, ['pkg'], '全局旗标不该混进 add 的 spec')

  const passthrough = parsePluginSubcommand(['--json', 'why', 'pkg'])
  assert.equal(passthrough.kind, 'passthrough')
  assert.deepEqual(passthrough.args, ['why', 'pkg'], '全局旗标不该混进转发参数')
  assert.equal(passthrough.flags.json, true)

  const help = parsePluginSubcommand(['--json', '--help'])
  assert.equal(help.kind, 'help')
  assert.equal(help.flags.json, true)
  assert.equal(parsePluginSubcommand(['help']).kind, 'help')
})

test('isMutatingSubcommand / isInstallingSubcommand 的判定表（决定锁与审计）', () => {
  for (const sub of ['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'import', 'prune']) {
    assert.equal(isMutatingSubcommand([sub]), true, sub)
  }
  for (const sub of ['why', 'list', 'ls', 'outdated', 'approve-builds']) {
    assert.equal(isMutatingSubcommand([sub]), false, sub)
  }
  assert.equal(isMutatingSubcommand([]), false)
  for (const sub of ['install', 'i', 'add', 'update', 'up']) assert.equal(isInstallingSubcommand([sub]), true, sub)
  for (const sub of ['remove', 'why', 'list']) assert.equal(isInstallingSubcommand([sub]), false, sub)
})

test('findForwardedProfileFlag 抓的是「出现在子命令之后」的 --profile', () => {
  assert.equal(findForwardedProfileFlag(['add', 'pkg']), undefined)
  assert.equal(findForwardedProfileFlag(['add', 'pkg', '--profile=1']), '--profile=1')
  assert.equal(findForwardedProfileFlag(['add', '--profile', '1']), '--profile')
})

test('GIT_SPEC_PATTERN 覆盖各宿主形态（比官方三条分支更全，P3-2）', () => {
  const gitSpecs = [
    'git+https://github.com/a/b.git',
    'github:a/b',
    'gitlab:a/b',
    'bitbucket:a/b',
    'git@github.com:a/b.git',
    'ssh://git@github.com/a/b.git',
    'https://github.com/a/b.git',
    'https://github.com/a/b.git#v1',
    'https://gitlab.com/a/b',
  ]
  for (const spec of gitSpecs) assert.equal(GIT_SPEC_PATTERN.test(spec), true, spec)
  const others = ['dsh-plugin-tlmemory', '@scope/pkg', 'file:../x', 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', 'x@1.2.3']
  for (const spec of others) assert.equal(GIT_SPEC_PATTERN.test(spec), false, spec)
})

test('具名常量集中：锁文件名 / 构建放行键 / 代理键映射（建议 #15）', () => {
  assert.equal(LOCK_FILENAME, '.dsh-plugin.lock')
  assert.equal(BUILD_APPROVAL_KEYS.modern, 'allowBuilds')
  assert.equal(BUILD_APPROVAL_KEYS.legacy, 'onlyBuiltDependencies')
  const mapped = Object.fromEntries(PROXY_ENV_MAP)
  assert.equal(mapped.HTTPS_PROXY, 'npm_config_https_proxy')
  assert.equal(mapped.HTTP_PROXY, 'npm_config_proxy')
  assert.equal(mapped.NO_PROXY, 'npm_config_noproxy')
})

test('timestamp 产出备份文件名可用的稳定格式', () => {
  assert.equal(timestamp(new Date(2026, 8, 18, 11, 26, 7)), '20260918-112607')
  assert.match(timestamp(), /^\d{8}-\d{6}$/)
})
