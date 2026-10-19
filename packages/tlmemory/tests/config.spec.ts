// packages/tlmemory/tests/config.spec.ts
// 配置层回归护栏（1.0.0 设置页改造）：
//
// 宿主设置页只认两件事，任何一条破了，用户就会「看不到配置」或「存不进去」：
//   1) 模块导出的 `Config` 必须是带 `toJSON()` 的 schemastery Schema
//      （@deepseek-ai/dsh-settings/lib/index.js:538-541 要求 "toJSON" in schema）；
//   2) 每个字段必须 `meta.volatile === true`（同文件 :122-131 volatileForm 只收
//      volatile 叶子；:153-158 写入时逐路径复核，非 volatile 直接拒绝）。
//
// 第三条是行为契约：运行期必须读**当前** config，而不是 apply 时的快照。
import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { Config, CONFIG_DEFAULTS, defaultDbPath, liveConfig, resolveDbPath, volatile } from '../src/config.js'
import Schema from 'schemastery'

/** toJSON 引用图：{ uid, refs: { '<uid>': node } } */
interface SerializedSchema {
  uid: number
  refs: Record<string, { type?: string; meta?: Record<string, unknown>; dict?: Record<string, number> }>
}

const serialized = Config.toJSON() as unknown as SerializedSchema

/** 取根对象节点的 dict（字段名 → 子节点 uid） */
function rootDict(): Record<string, number> {
  const root = serialized.refs[String(serialized.uid)]
  const dict = root?.dict
  expect(dict, 'Config 序列化后根节点必须带 dict').toBeTruthy()
  return dict as Record<string, number>
}

describe('Config schema（宿主设置页的唯一事实来源）', () => {
  it('可序列化：toJSON() 产出可 JSON 往返的引用图', () => {
    expect(typeof (Config as { toJSON?: unknown }).toJSON).toBe('function')
    const roundTrip = JSON.parse(JSON.stringify(serialized)) as SerializedSchema
    expect(roundTrip.uid).toBe(serialized.uid)
    expect(Object.keys(roundTrip.refs).length).toBeGreaterThan(0)
  })

  it('六个字段全部标了 volatile（否则设置页不显示、保存被拒绝）', () => {
    const dict = rootDict()
    expect(Object.keys(dict).sort()).toEqual(
      ['compactionInterval', 'dbPath', 'enableAutoMerge', 'enableAutoReflection', 'maxRecallCount', 'serverPort'].sort(),
    )
    for (const [key, uid] of Object.entries(dict)) {
      const node = serialized.refs[String(uid)]
      expect(node, `字段 ${key} 必须能在 refs 里解析到节点`).toBeTruthy()
      expect(node.meta?.volatile, `字段 ${key} 必须 meta.volatile === true`).toBe(true)
    }
  })

  it('volatile() 只加标记，不改变字段类型与默认值', () => {
    const marked = volatile(Schema.number().default(3).description('d'))
    const json = marked.toJSON() as unknown as {
      uid: number
      refs: Record<string, { meta?: Record<string, unknown> }>
    }
    // 独立 schema 的 toJSON 同样是引用图：节点在 refs[uid] 上
    expect(json.refs[String(json.uid)].meta).toMatchObject({ volatile: true, default: 3, description: 'd' })
    // 原始 schema 能力不变：仍可正常校验
    expect(marked(5)).toBe(5)
  })

  it('零必填：空配置可解析并补齐默认值', () => {
    const parsed = Config({}) as Record<string, unknown>
    expect(parsed.dbPath).toBeUndefined()
    expect(parsed.serverPort).toBe(CONFIG_DEFAULTS.serverPort)
    expect(parsed.maxRecallCount).toBe(CONFIG_DEFAULTS.maxRecallCount)
    expect(parsed.enableAutoReflection).toBe(CONFIG_DEFAULTS.enableAutoReflection)
    expect(parsed.compactionInterval).toBe(CONFIG_DEFAULTS.compactionInterval)
  })

  it('dbPath 的默认值不写进 schema（否则会把 A 机器的绝对路径带到 B 机器）', () => {
    const dict = rootDict()
    const node = serialized.refs[String(dict.dbPath)]
    expect(node.meta?.default).toBeUndefined()
    expect(defaultDbPath()).toBe(path.join(os.homedir(), '.dsh', 'tlmemory.db'))
  })
})

describe('resolveDbPath（空字符串必须在边界收口）', () => {
  it('未配置 / 空白串都交还给 MemoryDB 的默认路径分支', () => {
    expect(resolveDbPath(undefined)).toBeUndefined()
    expect(resolveDbPath({})).toBeUndefined()
    // 设置页里「清空路径」是最容易点的操作：空串若透传会 openDatabase('') 抛错
    expect(resolveDbPath({ dbPath: '' })).toBeUndefined()
    expect(resolveDbPath({ dbPath: '   ' })).toBeUndefined()
  })

  it('有效路径去首尾空白后原样返回', () => {
    expect(resolveDbPath({ dbPath: '  /tmp/a.db  ' })).toBe('/tmp/a.db')
  })
})

describe('liveConfig（运行期读当前配置，不缓存快照）', () => {
  it('跟随 ctx.fiber.config 的变化', () => {
    const ctx: { fiber?: { config?: unknown } } = { fiber: { config: { maxRecallCount: 9 } } }
    const read = liveConfig(ctx, { maxRecallCount: 1 })
    expect(read().maxRecallCount).toBe(9)
    // 宿主热重载只替换 fiber.config 时，读取端必须立刻看到新值
    ctx.fiber!.config = { maxRecallCount: 2 }
    expect(read().maxRecallCount).toBe(2)
  })

  it('拿不到 fiber 时退回装配参数（单测 / 极简宿主）', () => {
    expect(liveConfig(undefined, { serverPort: 5000 })().serverPort).toBe(5000)
    expect(liveConfig({}, { serverPort: 5001 })().serverPort).toBe(5001)
    expect(liveConfig({ fiber: {} }, { serverPort: 5002 })().serverPort).toBe(5002)
  })
})
