import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const core = require('../lib/core.cjs')

const readFrom = (map) => (field) => (field in map ? map[field] : undefined)
const firefly = core.findCharacter(core.DEFAULT_CHARACTERS, 'firefly')

const baseConfig = (extra = {}) => ({
  enabled: true,
  mode: 'work',
  modes: [
    { id: 'work', name: '战术工作态', commandAliases: ['/work'], injectCharacterPersona: false, enableStatusFooter: false },
    { id: 'rp', name: '陪伴态', commandAliases: ['/rp'], injectCharacterPersona: true },
  ],
  characters: core.DEFAULT_CHARACTERS,
  activeCharacterId: 'firefly',
  workModeKeywords: core.DEFAULT_WORK_KEYWORDS,
  triggers: [],
  timeZone: 'Asia/Shanghai',
  statusFooterLabel: '流萤状态同步',
  maxTriggerInjections: 3,
  enableMemoryBridge: false,
  enableStatusFooter: true,
  customSceneOverride: '',
  styleLayerDefault: 'off',
  styleEmojiHint: '一屏最多 2 个 emoji。',
  stickerDir: '',
  galleryDir: '',
  maxStickersPerTurn: 2,
  ...extra,
})

/* ── 开关解析 ── */

test('resolveStyleLayer：会话覆盖 > 形态自身 > 全局默认', () => {
  assert.deepEqual(core.resolveStyleLayer({ modeLayer: 'off', globalDefault: 'on', sessionOverride: 'on' }), {
    on: true,
    source: 'session',
  })
  assert.deepEqual(core.resolveStyleLayer({ modeLayer: 'on', globalDefault: 'off' }), { on: true, source: 'mode' })
  assert.deepEqual(core.resolveStyleLayer({ modeLayer: 'inherit', globalDefault: 'on' }), { on: true, source: 'global' })
  assert.deepEqual(core.resolveStyleLayer({}), { on: false, source: 'global' })
})

test('normalizeStyleLayerFlag 兼容布尔值与大小写，未知值回落 inherit', () => {
  assert.equal(core.normalizeStyleLayerFlag(true), 'on')
  assert.equal(core.normalizeStyleLayerFlag(false), 'off')
  assert.equal(core.normalizeStyleLayerFlag('OFF'), 'off')
  assert.equal(core.normalizeStyleLayerFlag(' On '), 'on')
  assert.equal(core.normalizeStyleLayerFlag('whatever'), 'inherit')
  assert.equal(core.normalizeStyleLayerFlag(undefined), 'inherit')
})

test('normalizeMode 把 styleLayer 带进形态定义', () => {
  assert.equal(core.normalizeMode({ id: 'x', styleLayer: 'off' }).styleLayer, 'off')
  assert.equal(core.normalizeMode({ id: 'x', styleLayer: 'on' }).styleLayer, 'on')
  assert.equal(core.normalizeMode({ id: 'x' }).styleLayer, 'inherit')
  // 内置形态默认跟随全局
  for (const mode of core.normalizeModes(core.DEFAULT_MODES)) assert.equal(mode.styleLayer, 'inherit')
})

/* ── 本地图库扫描 ── */

test('scanStickerLibrary 只认图片扩展名、跳过子目录、目录缺失降级为空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlrp-stickers-'))
  try {
    writeFileSync(join(dir, '开心.png'), 'x')
    writeFileSync(join(dir, '无语.GIF'), 'x')
    writeFileSync(join(dir, '说明.txt'), 'x')
    mkdirSync(join(dir, 'nested'))
    const items = core.scanStickerLibrary(dir)
    assert.deepEqual(items.map((item) => item.tag).sort(), ['无语', '开心'].sort())
    for (const item of items) {
      assert.ok(item.path.includes('/'), `路径应统一成正斜杠：${item.path}`)
      assert.ok(!item.path.includes('\\'))
    }
    assert.deepEqual(core.scanStickerLibrary(join(dir, 'missing')), [])
    assert.deepEqual(core.scanStickerLibrary(''), [])
    assert.equal(core.scanStickerLibrary(dir, { limit: 1 }).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stickerDirOf / galleryDirOf 缺省落到 ~/.dsh 下', () => {
  const sticker = core.stickerDirOf('', 'firefly')
  const gallery = core.galleryDirOf('')
  assert.match(sticker.replace(/\\/g, '/'), /\/\.dsh\/stickers\/firefly$/)
  assert.match(gallery.replace(/\\/g, '/'), /\/\.dsh\/gallery$/)
  assert.equal(core.stickerDirOf('D:/mine', 'firefly'), 'D:/mine')
  assert.equal(core.galleryDirOf('D:/pics'), 'D:/pics')
})

/* ── 风格块渲染 ── */

test('renderStyleBlock：完整人设时只补表情与贴纸，精简时带上语言风格', () => {
  const stickers = [{ tag: '开心', path: 'C:/x/stickers/开心.png' }]
  const lean = core.renderStyleBlock(firefly, {
    fullPersona: false,
    emojiHint: '一屏最多 2 个',
    stickers,
    maxStickersPerTurn: 2,
  })
  assert.match(lean, /风格层/)
  assert.match(lean, /语言风格与禁用项/)
  assert.match(lean, /台词语气锚点/)
  assert.match(lean, /一屏最多 2 个/)
  assert.match(lean, /!\[开心\]\(C:\/x\/stickers\/开心\.png\)/)
  assert.match(lean, /不写 \*斜体动作\*/)

  const full = core.renderStyleBlock(firefly, {
    fullPersona: true,
    emojiHint: '一屏最多 2 个',
    stickers,
    maxStickersPerTurn: 2,
  })
  assert.doesNotMatch(full, /语言风格与禁用项/)
  assert.doesNotMatch(full, /台词语气锚点/)
  assert.match(full, /表情包（标签 → 可直接粘贴的行）/)

  const silent = core.renderStyleBlock(firefly, { fullPersona: false, emojiHint: '', maxStickersPerTurn: 0 })
  assert.match(silent, /本轮不使用 emoji/)
  assert.match(silent, /本轮禁止贴任何表情包或图片/)
})

test('renderStyleBlock 无图库时不编造路径', () => {
  const text = core.renderStyleBlock(firefly, { fullPersona: true, emojiHint: 'ok', stickers: [], gallery: [], maxStickersPerTurn: 2 })
  assert.doesNotMatch(text, /!\[/)
  assert.doesNotMatch(text, /本地图库/)
})

/* ── 指令接线 ── */

test('parseCommand 识别 /style 子命令', () => {
  const on = core.parseCommand('/style on')
  assert.equal(on.kind, 'command')
  assert.equal(on.command, '/style')
  assert.equal(on.arg, 'on')
  assert.equal(on.mode, '')

  const status = core.parseCommand('/style')
  assert.equal(status.command, '/style')
  assert.equal(status.arg, '')
})

/* ── 快照与注入 ── */

test('snapshot：风格层按会话 > 形态 > 全局解析，关掉时不产出 block', () => {
  const state = core.createState({ read: readFrom(baseConfig({ styleLayerDefault: 'on' })) })
  const agent = { session: { id: 's-style-global' } }
  const on = core.snapshot(state, agent)
  assert.equal(on.style.on, true)
  assert.equal(on.style.source, 'global')
  assert.match(on.style.block, /风格层/)

  state.sessionState(agent).styleLayer = 'off'
  const off = core.snapshot(state, agent)
  assert.equal(off.style.on, false)
  assert.equal(off.style.source, 'session')
  assert.equal(off.style.block, '')

  const modeState = core.createState({
    read: readFrom(
      baseConfig({
        styleLayerDefault: 'on',
        modes: [{ id: 'work', name: '战术工作态', injectCharacterPersona: false, styleLayer: 'off' }],
      }),
    ),
  })
  const modeSnap = core.snapshot(modeState, { session: { id: 's-style-mode' } })
  assert.equal(modeSnap.style.on, false)
  assert.equal(modeSnap.style.source, 'mode')
})

test('snapshot：图库目录里的图片进入风格块并计数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlrp-gallery-'))
  try {
    writeFileSync(join(dir, '天台日落.png'), 'x')
    const state = core.createState({
      read: readFrom(baseConfig({ styleLayerDefault: 'on', galleryDir: dir, maxStickersPerTurn: 1 })),
    })
    const snap = core.snapshot(state, { session: { id: 's-gallery' } })
    assert.equal(snap.style.galleryCount, 1)
    assert.match(snap.style.block, /天台日落\.png/)
    assert.match(snap.style.block, /每轮最多贴 1 张/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderModeDirective 把风格层追加在形态准则末尾，不改形态红线', () => {
  const styleBlock = core.renderStyleBlock(firefly, { fullPersona: false, emojiHint: 'ok', maxStickersPerTurn: 0 })
  const text = core.renderModeDirective({
    character: firefly,
    mode: 'work',
    modeDef: core.findMode(core.DEFAULT_MODES, 'work'),
    scene: '测试场景',
    triggers: [],
    footerEnabled: false,
    footerLabel: '测试',
    style: { on: true, source: 'global', block: styleBlock },
  })
  assert.match(text, /运维纪律在本轮优先级高于人设/)
  assert.ok(text.trimEnd().endsWith('本轮禁止贴任何表情包或图片。'))

  const withoutStyle = core.renderModeDirective({
    character: firefly,
    mode: 'work',
    modeDef: core.findMode(core.DEFAULT_MODES, 'work'),
    scene: '测试场景',
    triggers: [],
    footerEnabled: false,
    footerLabel: '测试',
  })
  assert.doesNotMatch(withoutStyle, /风格层/)
})

test('renderTurnContext 报告风格层来源与图库数量', () => {
  const text = core.renderTurnContext({
    mode: 'work',
    modeDef: core.findMode(core.DEFAULT_MODES, 'work'),
    character: firefly,
    scene: '测试场景',
    triggers: [],
    footerEnabled: false,
    footerLabel: '测试',
    reason: '测试',
    now: '2026-11-02 星期一 18:00',
    cwd: 'C:/tmp',
    memory: { text: '' },
    style: { on: true, source: 'session', block: '', stickerCount: 3, galleryCount: 1 },
  })
  assert.match(text, /风格层：开（来源：会话 \/style 覆盖）/)
  assert.match(text, /表情包 3 张、图库 1 张/)

  const offText = core.renderTurnContext({
    mode: 'work',
    modeDef: core.findMode(core.DEFAULT_MODES, 'work'),
    character: firefly,
    scene: '测试场景',
    triggers: [],
    footerEnabled: false,
    footerLabel: '测试',
    reason: '测试',
    now: '2026-11-02 星期一 18:00',
    cwd: 'C:/tmp',
    memory: { text: '' },
    style: { on: false, source: 'global', block: '', stickerCount: 0, galleryCount: 0 },
  })
  assert.match(offText, /风格层：关（来源：全局 styleLayerDefault）/)
})
