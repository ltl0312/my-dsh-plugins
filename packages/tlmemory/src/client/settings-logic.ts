// packages/tlmemory/src/client/settings-logic.ts
// 设置面板的纯逻辑层（零 React、零 DOM、零网络）：schema 投影 → 表单字段 → 保存计划，
// 以及一个可订阅的控制器。宿主侧契约见 @deepseek-ai/dsh-settings/lib/index.js：
//   - describe() 返回 { writable, hasDocument, namespaces[] }，每个 namespace 形如
//     { ns, revision, schema, value, base, user }（dsh-api-settings-controller/lib/index.js:393-400
//     与 :275-289 的 namespaceView）；
//   - 写入按 revision 做乐观并发，冲突抛 SETTINGS_CONFLICT，远程层映射为
//     settings/conflict（dsh-settings/lib/index.js:163-175、:511）；
//   - schema 是 schemastery `toJSON()` 的引用图 { uid, refs: { '1': {...} } }，
//     对象节点的 dict 值是 refs 的下标（见 tests 里对真实 toJSON 形状的断言）。

/** 本插件在宿主 profile 里的条目 id，同时也是设置命名空间 */
export const SETTINGS_NS = 'dsh-plugin-tlmemory'
/** 命名空间兜底匹配片段：历史版本曾用 tlmemory-runtime 之类的 id 挂载 */
export const SETTINGS_NS_HINT = 'tlmemory'

/** 远程调用结果信封（dsh-client-ui-settings/lib/client.js:1447-1451 的读取形态） */
export type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message: string } }

/** schemastery 序列化图里的单节点 */
export interface SchemaNode {
  uid?: number
  type?: string
  meta?: Record<string, unknown>
  dict?: Record<string, number | SchemaNode>
  inner?: number | SchemaNode
}

/** 设置命名空间视图（远程投影，密钥字段已被宿主脱敏） */
export interface NamespaceView {
  ns: string
  revision: number
  schema?: SchemaNode & { refs?: Record<string, SchemaNode> }
  value?: Record<string, unknown>
  base?: Record<string, unknown>
  user?: Record<string, unknown>
}

/** describe() 的返回体 */
export interface DescribeView {
  writable?: boolean
  hasDocument?: boolean
  namespaces?: NamespaceView[]
}

export type FieldType = 'string' | 'number' | 'boolean'

/** 面板里的一行可编辑字段 */
export interface FieldSpec {
  key: string
  type: FieldType
  /** 规范化后的当前值（number 统一转成字符串交给 input，保留 '' 表示「未设置」） */
  value: string | boolean
  /** schema 声明的默认值（用于「恢复默认值」与提示文案） */
  defaultText?: string
  /** schema meta.description，直接作为提示文案 */
  hint?: string
}

export type FieldDraft = Record<string, string | boolean>

export type PanelStatus = 'loading' | 'ready' | 'unavailable' | 'error'

/** 面板快照（不可变，每次变更整体替换后通知订阅者） */
export interface PanelSnapshot {
  status: PanelStatus
  /** 命中的命名空间 id（写入时要回写同一个 id） */
  ns?: string
  revision?: number
  writable: boolean
  fields: FieldSpec[]
  draft: FieldDraft
  dirty: boolean
  busy: boolean
  /** 提示文案的字典键（由组件翻译），null 表示无提示 */
  messageKey: string | null
  messageKind: 'info' | 'error'
}

/** 保存计划：update(patch) 与 mutate(unset) 两组路径（互斥键） */
export interface SavePlan {
  patch: Record<string, unknown>
  unset: string[]
  /** 具体哪个字段的值无法解析成数字 */
  invalid?: string
}

/** 远程传输层：只依赖 remote.settings 的三个方法，便于单测替身 */
export interface SettingsTransport {
  describe(): Promise<RemoteResult<DescribeView> | DescribeView>
  update(
    ns: string,
    patch: Record<string, unknown>,
    revision?: number,
  ): Promise<RemoteResult<NamespaceView> | NamespaceView | void>
  mutate(
    ns: string,
    ops: unknown[],
    revision?: number,
  ): Promise<RemoteResult<NamespaceView> | NamespaceView | void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 拆出 { ok, value } 信封；宿主老版本直接返回值时按成功处理 */
function unwrap<T>(response: RemoteResult<T> | T | void): { ok: true; value: T | undefined } | { ok: false; message: string; code?: string } {
  if (isRecord(response) && 'ok' in response) {
    if ((response as { ok: unknown }).ok === true) {
      return { ok: true, value: (response as { value?: T }).value }
    }
    const error = (response as { error?: unknown }).error
    const message = isRecord(error) && typeof error.message === 'string' ? error.message : ''
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
    return { ok: false, message: message === '' ? 'settings request rejected' : message, code }
  }
  return { ok: true, value: response as T | undefined }
}

/**
 * 从 describe() 结果里选出本插件的命名空间。
 *
 * 优先精确匹配 profile 条目 id（`dsh-plugin-tlmemory`）；命中不了再退回
 * 「id 里带 tlmemory」的唯一候选 —— 本仓库历史事故中插件曾被以
 * `tlmemory-runtime` 之类的旧 id 挂载，此时精确匹配必然落空，而按包名写死
 * 又会让面板彻底消失。多个候选一律视为不可判定（返回 undefined），
 * 宁可提示「未找到」也不猜错命名空间写坏别人的配置。
 */
export function pickNamespace(view: DescribeView | undefined, preferred = SETTINGS_NS): NamespaceView | undefined {
  const namespaces = isRecord(view) && Array.isArray(view.namespaces) ? view.namespaces : []
  const exact = namespaces.find((ns) => ns?.ns === preferred)
  if (exact !== undefined) return exact
  const candidates = namespaces.filter(
    (ns) => typeof ns?.ns === 'string' && ns.ns.toLowerCase().includes(SETTINGS_NS_HINT),
  )
  return candidates.length === 1 ? candidates[0] : undefined
}

/** 解析 schema 引用图里的根节点 */
function rootNode(schema: NamespaceView['schema']): SchemaNode | undefined {
  if (!isRecord(schema)) return undefined
  const refs = isRecord(schema.refs) ? schema.refs : undefined
  const uid = typeof schema.uid === 'number' ? schema.uid : undefined
  if (refs !== undefined && uid !== undefined) {
    const root = refs[String(uid)]
    if (isRecord(root)) return root
  }
  // 已经内联的对象节点（无 refs/uid）也支持
  return typeof schema.type === 'string' ? (schema as SchemaNode) : undefined
}

/** 取 dict 某个键对应的节点（值可能是 uid 下标，也可能内联） */
export function resolveDictNode(
  schema: NamespaceView['schema'],
  entry: number | SchemaNode | undefined,
): SchemaNode | undefined {
  if (isRecord(entry) && typeof entry.type === 'string') return entry
  if (typeof entry !== 'number') return undefined
  const refs = isRecord(schema) && isRecord(schema.refs) ? schema.refs : undefined
  const node = refs?.[String(entry)]
  return isRecord(node) ? node : undefined
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 把 schema 声明值与运行时值统一成表单可编辑值 */
function normalize(type: FieldType, raw: unknown): string | boolean {
  if (type === 'boolean') return raw === true
  if (raw === undefined || raw === null) return ''
  if (type === 'number') return typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : String(raw)
  return String(raw)
}

/**
 * 把命名空间视图投影成表单字段列表。
 *
 * 只收 string / number / boolean 三种标量；嵌套对象与 dict 跳过（本插件 schema
 * 全平铺，出现嵌套说明是别人的命名空间或未来扩展，直接不渲染比渲染错好）。
 */
export function fieldsFromView(view: NamespaceView | undefined): FieldSpec[] {
  const root = rootNode(view?.schema)
  const dict = isRecord(root) && isRecord(root.dict) ? root.dict : undefined
  if (dict === undefined) return []
  const values = isRecord(view) && isRecord(view.value) ? view.value : {}
  const fields: FieldSpec[] = []
  for (const [key, entry] of Object.entries(dict)) {
    const node = resolveDictNode(view?.schema, entry as number | SchemaNode | undefined)
    const type = node?.type
    if (type !== 'string' && type !== 'number' && type !== 'boolean') continue
    const meta = isRecord(node) && isRecord(node.meta) ? node.meta : {}
    const declared = meta.default
    const raw = values[key] !== undefined ? values[key] : declared
    const defaultText =
      declared === undefined || declared === null ? undefined : normalize(type, declared) === '' ? undefined : String(normalize(type, declared))
    fields.push({
      key,
      type,
      value: normalize(type, raw),
      defaultText,
      hint: textOf(meta.description),
    })
  }
  return fields
}

/** 字段初值（未改动即为初值） */
export function draftOf(fields: FieldSpec[]): FieldDraft {
  const draft: FieldDraft = {}
  for (const field of fields) draft[field.key] = field.value
  return draft
}

/** 是否与快照初值一致 */
export function isDirty(fields: FieldSpec[], draft: FieldDraft): boolean {
  for (const field of fields) {
    if ((draft[field.key] ?? field.value) !== field.value) return true
  }
  return false
}

/**
 * 生成保存计划。
 *
 * 三种字段的语义：
 *   - string：去首尾空白后为空 → 走 mutate 的 unset（恢复 schema 默认/继承）；
 *     非空 → update 写入（dbPath 依赖这条「清空即默认」）。
 *   - number：解析失败直接返回 invalid，绝不把 NaN 写进宿主配置。
 *   - boolean：直接写 true/false。
 */
export function buildSavePlan(fields: FieldSpec[], draft: FieldDraft): SavePlan {
  const patch: Record<string, unknown> = {}
  const unset: string[] = []
  for (const field of fields) {
    const next = draft[field.key] ?? field.value
    if (next === field.value) continue
    if (field.type === 'boolean') {
      patch[field.key] = next === true
      continue
    }
    const text = String(next).trim()
    if (field.type === 'string') {
      if (text === '') unset.push(field.key)
      else patch[field.key] = text
      continue
    }
    const parsed = Number(text)
    if (text === '' || !Number.isFinite(parsed)) return { patch: {}, unset: [], invalid: field.key }
    patch[field.key] = parsed
  }
  return { patch, unset }
}

/** 重置一个字段到 schema 默认值（无默认值时清空输入） */
export function resetField(field: FieldSpec, draft: FieldDraft): FieldDraft {
  const next: FieldDraft = { ...draft }
  if (field.defaultText !== undefined) next[field.key] = field.type === 'boolean' ? field.defaultText === 'true' : field.defaultText
  else next[field.key] = field.type === 'boolean' ? false : ''
  return next
}

/**
 * 设置面板控制器：状态机 + 乐观并发写入 + 冲突恢复。
 *
 * 与宿主 `ConfigForm.mutate()`（dsh-client-ui-settings/lib/client.js:1165-1188）同构：
 * 写入失败一律先重新 load() 再交还控制权，绝不带着陈旧 revision 重试。
 */
export class SettingsPanelController {
  private readonly transport: SettingsTransport
  private readonly listeners = new Set<(snapshot: PanelSnapshot) => void>()
  private snapshot: PanelSnapshot = {
    status: 'loading',
    writable: false,
    fields: [],
    draft: {},
    dirty: false,
    busy: false,
    messageKey: null,
    messageKind: 'info',
  }
  private disposed = false
  /** 写入串行化：并发点击保存不会互相踩 revision */
  private tail: Promise<void> = Promise.resolve()

  constructor(transport: SettingsTransport) {
    this.transport = transport
  }

  getSnapshot(): PanelSnapshot {
    return this.snapshot
  }

  subscribe(listener: (snapshot: PanelSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  private emit(patch: Partial<PanelSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener(this.snapshot)
  }

  /** 重新从宿主读取 schema 与当前值 */
  async load(): Promise<void> {
    if (this.disposed) return
    this.emit({ status: 'loading', busy: true })
    const outcome = unwrap<DescribeView>(await this.transport.describe())
    if (this.disposed) return
    if (!outcome.ok) {
      this.emit({ status: 'error', busy: false, messageKey: 'loadFailed', messageKind: 'error' })
      return
    }
    const view = pickNamespace(outcome.value)
    if (view === undefined) {
      this.emit({
        status: 'unavailable',
        busy: false,
        ns: undefined,
        fields: [],
        draft: {},
        dirty: false,
        messageKey: 'unavailable',
        messageKind: 'error',
      })
      return
    }
    const fields = fieldsFromView(view)
    this.emit({
      status: 'ready',
      busy: false,
      ns: view.ns,
      revision: typeof view.revision === 'number' ? view.revision : undefined,
      writable: outcome.value?.writable !== false,
      fields,
      draft: draftOf(fields),
      dirty: false,
      messageKey: null,
      messageKind: 'info',
    })
  }

  setDraft(key: string, value: string | boolean): void {
    if (this.disposed) return
    const draft: FieldDraft = { ...this.snapshot.draft, [key]: value }
    this.emit({ draft, dirty: isDirty(this.snapshot.fields, draft) })
  }

  resetFieldToDefault(key: string): void {
    if (this.disposed) return
    const field = this.snapshot.fields.find((candidate) => candidate.key === key)
    if (field === undefined) return
    const draft = resetField(field, this.snapshot.draft)
    this.emit({ draft, dirty: isDirty(this.snapshot.fields, draft) })
  }

  /** 保存：先 unset（清空字段）再 update（值字段），每一步都带当前 revision */
  save(): Promise<void> {
    const run = this.tail.then(async () => {
      if (this.disposed) return
      const { ns, fields, draft, revision } = this.snapshot
      if (ns === undefined) return
      const plan = buildSavePlan(fields, draft)
      if (plan.invalid !== undefined) {
        this.emit({ messageKey: 'invalidNumber', messageKind: 'error' })
        return
      }
      if (plan.unset.length === 0 && Object.keys(plan.patch).length === 0) {
        this.emit({ messageKey: 'noChanges', messageKind: 'info' })
        return
      }
      this.emit({ busy: true, messageKey: 'saving', messageKind: 'info' })
      let expected = revision
      if (plan.unset.length > 0) {
        const ops = plan.unset.map((key) => ({ op: 'unset', path: [key] }))
        const written = unwrap<NamespaceView>(await this.transport.mutate(ns, ops, expected))
        if (!written.ok) {
          await this.fail(written.message, written.code)
          return
        }
        expected = written.value?.revision ?? expected
      }
      if (Object.keys(plan.patch).length > 0) {
        const written = unwrap<NamespaceView>(await this.transport.update(ns, plan.patch, expected))
        if (!written.ok) {
          await this.fail(written.message, written.code)
          return
        }
      }
      await this.load()
      if (this.disposed) return
      this.emit({ messageKey: 'saved', messageKind: 'info' })
    })
    this.tail = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /** 写入失败的统一收尾：重读宿主状态，冲突给出可操作提示 */
  private async fail(message: string, code?: string): Promise<void> {
    await this.load()
    if (this.disposed) return
    this.emit({
      messageKey: code === 'settings/conflict' ? 'conflict' : 'saveFailed',
      messageKind: 'error',
      busy: false,
    })
    if (code !== 'settings/conflict') {
      // 具体原因写进控制台，面板只给一句可读提示（避免把宿主内部错误糊到界面上）
      console.warn('[tlmemory] 保存设置失败：', message)
    }
  }
}
