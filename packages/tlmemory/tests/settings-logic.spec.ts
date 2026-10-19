// packages/tlmemory/tests/settings-logic.spec.ts
// 设置面板的纯逻辑回归（零 React / 零 DOM）：
// 从宿主 describe() 的 schema 投影 → 表单字段 → 保存计划 → 乐观并发写入。
//
// 这里刻意用**真实的** Config.toJSON() 当投影输入：宿主下发的就是同一个引用图
// （dsh-settings/lib/index.js:538-541 取 runtime.Config 后 form.toJSON()），
// 伪造一份手写 schema 就只能测到自己的假设。
import { beforeEach, describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import {
  SETTINGS_NS,
  SettingsPanelController,
  buildSavePlan,
  draftOf,
  fieldsFromView,
  isDirty,
  pickNamespace,
  resetField,
  resolveDictNode,
  type DescribeView,
  type NamespaceView,
  type SchemaNode,
  type SettingsTransport,
} from '../src/client/settings-logic.js'

/** 真实投影：schemastery 引用图 */
const projection = Config.toJSON() as unknown as SchemaNode & { refs?: Record<string, SchemaNode> }

function makeView(overrides: Partial<NamespaceView> = {}): NamespaceView {
  return {
    ns: SETTINGS_NS,
    revision: 3,
    schema: projection,
    value: {
      serverPort: 4890,
      maxRecallCount: 5,
      enableAutoReflection: true,
      compactionInterval: 20,
      enableAutoMerge: true,
      enableAutoEvolve: true,
      requireReview: false,
    },
    base: {},
    user: {},
    ...overrides,
  }
}

describe('pickNamespace（命名空间定位）', () => {
  it('精确命中 profile 条目 id', () => {
    const view: DescribeView = {
      writable: true,
      namespaces: [makeView({ ns: 'other-plugin', revision: 1 }), makeView()],
    }
    expect(pickNamespace(view)?.ns).toBe(SETTINGS_NS)
  })

  it('精确落空时按 tlmemory 片段唯一兜底（历史旧 id 挂载）', () => {
    const view: DescribeView = { namespaces: [makeView({ ns: 'tlmemory-runtime', revision: 7 })] }
    expect(pickNamespace(view)?.ns).toBe('tlmemory-runtime')
  })

  it('多个片段候选一律不猜（返回 undefined，面板提示未找到）', () => {
    const view: DescribeView = {
      namespaces: [makeView({ ns: 'tlmemory-runtime' }), makeView({ ns: 'tlmemory-legacy' })],
    }
    expect(pickNamespace(view)).toBeUndefined()
  })

  it('空 / 缺失 / 非数组输入都不抛错', () => {
    expect(pickNamespace(undefined)).toBeUndefined()
    expect(pickNamespace({})).toBeUndefined()
    expect(pickNamespace({ namespaces: [] })).toBeUndefined()
  })
})

describe('fieldsFromView（schema 投影 → 表单字段）', () => {
  it('八个字段按 schema 顺序投影，类型与默认值正确', () => {
    const fields = fieldsFromView(makeView())
    expect(fields.map((field) => field.key)).toEqual([
      'dbPath',
      'serverPort',
      'maxRecallCount',
      'enableAutoReflection',
      'compactionInterval',
      'enableAutoMerge',
      'enableAutoEvolve',
      'requireReview',
    ])
    const byKey = new Map(fields.map((field) => [field.key, field]))
    expect(byKey.get('serverPort')).toMatchObject({ type: 'number', value: '4890', defaultText: '4890' })
    expect(byKey.get('enableAutoReflection')).toMatchObject({ type: 'boolean', value: true, defaultText: 'true' })
    // dbPath 没有 schema 默认值：defaultText 必须缺省，否则「恢复默认」会写死绝对路径
    expect(byKey.get('dbPath')).toMatchObject({ type: 'string', value: '' })
    expect(byKey.get('dbPath')?.defaultText).toBeUndefined()
    // description 直接当提示文案，避免面板里出现两份文案
    expect(byKey.get('dbPath')?.hint).toContain('默认 ~/.dsh/tlmemory.db')
  })

  it('value 缺失时回落到 schema 默认值（首装即显示默认）', () => {
    const fields = fieldsFromView(makeView({ value: {} }))
    expect(fields.find((field) => field.key === 'maxRecallCount')?.value).toBe('5')
  })

  it('嵌套对象 / 非法节点被跳过而不是渲染错', () => {
    const schema: SchemaNode & { refs?: Record<string, SchemaNode> } = {
      uid: 9,
      refs: {
        '1': { type: 'object', dict: {} },
        '2': { type: 'string' },
        '9': { type: 'object', dict: { nested: 1, plain: 2 } },
      },
    }
    expect(fieldsFromView({ ns: 'x', revision: 1, schema }).map((field) => field.key)).toEqual(['plain'])
  })

  it('无 schema 时返回空列表（面板显示为不可配置，而不是崩）', () => {
    expect(fieldsFromView(undefined)).toEqual([])
    expect(fieldsFromView({ ns: 'x', revision: 1 })).toEqual([])
  })

  it('resolveDictNode 同时支持 uid 下标与内联节点', () => {
    expect(resolveDictNode(projection, 1)?.type).toBe('string')
    expect(resolveDictNode(undefined, { type: 'boolean' })?.type).toBe('boolean')
    expect(resolveDictNode(undefined, undefined)).toBeUndefined()
  })
})

describe('draftOf / isDirty / buildSavePlan（编辑与保存计划）', () => {
  const fields = fieldsFromView(makeView())

  it('初值不自脏，任一字段改动即脏', () => {
    const draft = draftOf(fields)
    expect(isDirty(fields, draft)).toBe(false)
    expect(isDirty(fields, { ...draft, maxRecallCount: '8' })).toBe(true)
    expect(isDirty(fields, { ...draft, enableAutoReflection: false })).toBe(true)
  })

  it('数字与布尔改动写进 patch', () => {
    const plan = buildSavePlan(fields, { ...draftOf(fields), maxRecallCount: '8', enableAutoReflection: false })
    expect(plan.invalid).toBeUndefined()
    expect(plan.unset).toEqual([])
    expect(plan.patch).toEqual({ maxRecallCount: 8, enableAutoReflection: false })
  })

  it('字符串清空走 unset（清空 dbPath = 回到默认路径）', () => {
    const withPath = fieldsFromView(makeView({ value: { dbPath: '/tmp/x.db' } }))
    const plan = buildSavePlan(withPath, { ...draftOf(withPath), dbPath: '   ' })
    expect(plan.unset).toEqual(['dbPath'])
    expect(plan.patch).toEqual({})
  })

  it('非法数字绝不写进宿主配置：返回 invalid 字段名', () => {
    const plan = buildSavePlan(fields, { ...draftOf(fields), serverPort: 'abc' })
    expect(plan.invalid).toBe('serverPort')
    expect(plan.patch).toEqual({})
  })

  it('无改动时计划为空（面板据此提示「没有需要保存的改动」）', () => {
    const plan = buildSavePlan(fields, draftOf(fields))
    expect(plan).toEqual({ patch: {}, unset: [] })
  })

  it('resetField：有默认值回到默认，无默认值清空', () => {
    const draft = { ...draftOf(fields), serverPort: '1', dbPath: '/x.db' }
    expect(resetField(fields[1], draft).serverPort).toBe('4890')
    expect(resetField(fields[0], draft).dbPath).toBe('')
  })
})

/** 远程传输替身：记录每次调用，并在内部维护 revision + 值（模拟宿主文档） */
function fakeTransport(options: {
  describe?: () => unknown
  update?: (ns: string, patch: Record<string, unknown>, revision?: number) => unknown
  mutate?: (ns: string, ops: unknown[], revision?: number) => unknown
} = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  let revision = 3
  let value: Record<string, unknown> = {
    serverPort: 4890,
    maxRecallCount: 5,
    enableAutoReflection: true,
    compactionInterval: 20,
  }
  const transport: SettingsTransport = {
    async describe() {
      calls.push({ method: 'describe', args: [] })
      if (options.describe !== undefined) return options.describe() as never
      return { ok: true, value: { writable: true, hasDocument: true, namespaces: [makeView({ revision, value: { ...value } })] } }
    },
    async update(ns, patch, expected) {
      calls.push({ method: 'update', args: [ns, patch, expected] })
      if (options.update !== undefined) return options.update(ns, patch, expected) as never
      revision += 1
      value = { ...value, ...patch }
      return { ok: true, value: makeView({ revision, value: { ...value } }) }
    },
    async mutate(ns, ops, expected) {
      calls.push({ method: 'mutate', args: [ns, ops, expected] })
      if (options.mutate !== undefined) return options.mutate(ns, ops, expected) as never
      revision += 1
      for (const op of ops as Array<{ op?: string; path?: string[] }>) {
        if (op.op === 'unset' && Array.isArray(op.path)) delete value[op.path[0]]
      }
      return { ok: true, value: makeView({ revision, value: { ...value } }) }
    },
  }
  return { transport, calls }
}

describe('SettingsPanelController（状态机 + 乐观并发）', () => {
  let controller: SettingsPanelController

  beforeEach(() => {
    controller = new SettingsPanelController(fakeTransport().transport)
  })

  it('load 后进入 ready，字段与初值就绪', async () => {
    await controller.load()
    const snapshot = controller.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.ns).toBe(SETTINGS_NS)
    expect(snapshot.revision).toBe(3)
    expect(snapshot.writable).toBe(true)
    expect(snapshot.fields).toHaveLength(8)
    expect(snapshot.dirty).toBe(false)
    expect(snapshot.busy).toBe(false)
  })

  it('命名空间缺失时进入 unavailable（提示而不是空白面板）', async () => {
    const { transport } = fakeTransport({
      describe: () => ({ ok: true, value: { writable: true, namespaces: [makeView({ ns: 'other' })] } }),
    })
    const local = new SettingsPanelController(transport)
    await local.load()
    expect(local.getSnapshot().status).toBe('unavailable')
    expect(local.getSnapshot().messageKey).toBe('unavailable')
  })

  it('describe 失败时进入 error 且可重试', async () => {
    const { transport } = fakeTransport({
      describe: () => ({ ok: false, error: { code: 'settings/rejected', message: 'boom' } }),
    })
    const local = new SettingsPanelController(transport)
    await local.load()
    expect(local.getSnapshot().status).toBe('error')
    expect(local.getSnapshot().messageKey).toBe('loadFailed')
  })

  it('保存：带当前 revision 写 patch，成功后重新 load 并提示已保存', async () => {
    const { transport, calls } = fakeTransport()
    const local = new SettingsPanelController(transport)
    await local.load()
    local.setDraft('maxRecallCount', '7')
    expect(local.getSnapshot().dirty).toBe(true)
    await local.save()

    const update = calls.find((call) => call.method === 'update')
    expect(update?.args).toEqual([SETTINGS_NS, { maxRecallCount: 7 }, 3])
    expect(calls.filter((call) => call.method === 'describe')).toHaveLength(2)
    const snapshot = local.getSnapshot()
    expect(snapshot.messageKey).toBe('saved')
    expect(snapshot.dirty).toBe(false)
    expect(snapshot.revision).toBe(4)
    expect(snapshot.fields.find((field) => field.key === 'maxRecallCount')?.value).toBe('7')
  })

  it('清空已有路径：先 mutate(unset) 再 update，且两次都带最新 revision', async () => {
    const { transport, calls } = fakeTransport({
      describe: () => ({
        ok: true,
        value: {
          writable: true,
          namespaces: [
            makeView({
              revision: 3,
              value: { dbPath: '/data/mem.db', serverPort: 4890, maxRecallCount: 5, enableAutoReflection: true, compactionInterval: 20, enableAutoMerge: true },
            }),
          ],
        },
      }),
    })
    const local = new SettingsPanelController(transport)
    await local.load()
    expect(local.getSnapshot().fields.find((field) => field.key === 'dbPath')?.value).toBe('/data/mem.db')
    local.setDraft('dbPath', '')
    local.setDraft('serverPort', '5001')
    await local.save()

    const order = calls.map((call) => call.method)
    expect(order).toEqual(['describe', 'mutate', 'update', 'describe'])
    expect(calls[1].args).toEqual([SETTINGS_NS, [{ op: 'unset', path: ['dbPath'] }], 3])
    expect(calls[2].args).toEqual([SETTINGS_NS, { serverPort: 5001 }, 4])
  })

  it('revision 冲突：提示冲突并重载最新值，不带着旧 revision 重试', async () => {
    const { transport, calls } = fakeTransport({
      update: () => ({ ok: false, error: { code: 'settings/conflict', message: 'stale' } }),
    })
    const local = new SettingsPanelController(transport)
    await local.load()
    local.setDraft('maxRecallCount', '9')
    await local.save()

    expect(calls.filter((call) => call.method === 'update')).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'describe')).toHaveLength(2)
    expect(local.getSnapshot().messageKey).toBe('conflict')
    expect(local.getSnapshot().messageKind).toBe('error')
    expect(local.getSnapshot().busy).toBe(false)
  })

  it('非法数字：不发任何写请求，提示就地修正', async () => {
    const { transport, calls } = fakeTransport()
    const local = new SettingsPanelController(transport)
    await local.load()
    local.setDraft('compactionInterval', 'x')
    await local.save()
    expect(calls.filter((call) => call.method !== 'describe')).toHaveLength(0)
    expect(local.getSnapshot().messageKey).toBe('invalidNumber')
  })

  it('无改动时保存只提示，不写宿主', async () => {
    const { transport, calls } = fakeTransport()
    const local = new SettingsPanelController(transport)
    await local.load()
    await local.save()
    expect(calls.filter((call) => call.method !== 'describe')).toHaveLength(0)
    expect(local.getSnapshot().messageKey).toBe('noChanges')
  })

  it('订阅读到每次快照替换；dispose 后不再通知也不再发请求', async () => {
    const seen: string[] = []
    const stop = controller.subscribe((snapshot) => seen.push(snapshot.status))
    await controller.load()
    expect(seen).toEqual(['loading', 'ready'])
    stop()
    controller.dispose()
    const { transport, calls } = fakeTransport()
    const local = new SettingsPanelController(transport)
    local.dispose()
    await local.load()
    expect(calls).toHaveLength(0)
  })

  it('只读部署（writable:false）时快照标记不可写', async () => {
    const { transport } = fakeTransport({
      describe: () => ({ ok: true, value: { writable: false, namespaces: [makeView()] } }),
    })
    const local = new SettingsPanelController(transport)
    await local.load()
    expect(local.getSnapshot().writable).toBe(false)
    expect(local.getSnapshot().status).toBe('ready')
  })
})

/** 防御性：传输层抛错时控制器的串行队列不能被卡死 */
describe('SettingsPanelController（异常路径）', () => {
  it('transport 抛错时 save 会 reject，但队列已复位，后续 save 仍能执行', async () => {
    let attempt = 0
    const { transport, calls } = fakeTransport({
      update: () => {
        attempt += 1
        throw new Error('network down')
      },
    })
    const local = new SettingsPanelController(transport)
    await local.load()
    local.setDraft('maxRecallCount', '6')
    await expect(local.save()).rejects.toThrow('network down')
    await expect(local.save()).rejects.toThrow('network down')
    expect(attempt).toBe(2)
    expect(calls.filter((call) => call.method === 'update')).toHaveLength(2)
  })
})

describe('模块级常量', () => {
  it('设置命名空间 = profile 插件条目 id', () => {
    expect(SETTINGS_NS).toBe('dsh-plugin-tlmemory')
  })
})
