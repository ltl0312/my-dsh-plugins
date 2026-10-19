// packages/tlsearch/src/client/store.ts
//
// 设置页的读写层：把宿主 `remote.settings` 的 RPC 包装成一个可订阅的小 store。
//
// 为什么走 `remote.settings` 而不是 `configForms`：
// - `configForms`（`dsh-client-ui-settings` 的共享表单）在 `decode` 时**丢掉了
//   `secrets`**——快照只有 `{status,value,base,user,revision,writable}`。本插件的
//   `apiKey` 是 `role('secret')`，宿主会把值从 `value` 里删掉、只在 `secrets` 里留
//   一个 `set` 标记；没有这份信息就无法区分「没配」和「配了但不回显」，页面会误导。
// - `remote.settings` 的 `mutate(ns, ops, rev)` 按**路径**写，天然适合脱敏字段：
//   没被用户改过的路径根本不上线，所以已保存的密钥不会被空串覆盖。
//
// 信封形状（`dsh-api-settings-controller/lib/index.js:271-292` 的 `namespaceView`）：
//   describe() → { ok, value: { writable, hasDocument, namespaces: [view…] } }
//   mutate()   → { ok, value: view }        // 失败 { ok:false, error:{ message } }
// 注意 `describe()` 返回的是**包装对象**而不是数组，`namespaces` 才是数组；这里两种
// 形状都接受，宿主换了包装也不至于整页空白。

import type { ConfigOp, RemoteLike } from './host.js'
import { CLIENT_NAMESPACE, DEFAULTS, normalizeValues } from './model.js'
import type { FormValues } from './model.js'

/** 命名空间兜底匹配片段：历史版本可能以别的条目 id 挂载本插件。 */
const NAMESPACE_HINT = 'tlsearch'

/** 一个被脱敏的字段位置，`set` 表示宿主侧确实存了值。 */
export interface SecretSlot {
  path: string[]
  set: boolean
}

export interface StoreSnapshot {
  status: 'loading' | 'ready' | 'unavailable' | 'error'
  values: FormValues
  revision?: number
  writable: boolean
  /** `applies` 原样保留：不是 `live` 时页面要提示「需要重启」。 */
  applies?: string
  secrets: SecretSlot[]
  error?: string
}

export interface MutateResult {
  ok: boolean
  error?: string
  /** 宿主判定为写冲突（`SETTINGS_CONFLICT`）：页面应提示「已重新读取」。 */
  conflict?: boolean
}

export interface ConfigStore {
  getSnapshot(): StoreSnapshot
  subscribe(listener: () => void): () => void
  /** 只提交**改动过**的路径；未提交的字段（尤其是脱敏密钥）保持原值。 */
  mutate(ops: ConfigOp[]): Promise<MutateResult>
  reload(): Promise<void>
  dispose(): void
}

const INITIAL: StoreSnapshot = {
  status: 'loading',
  values: DEFAULTS,
  writable: false,
  secrets: [],
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** `describe()` 的 `namespaces`（兼容「直接给数组」的旧形状）。 */
function namespaceList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.map(asRecord)
  const inner = asRecord(value).namespaces
  return Array.isArray(inner) ? inner.map(asRecord) : []
}

function secretSlots(value: unknown): SecretSlot[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const record = asRecord(entry)
    const path = Array.isArray(record.path) ? record.path.map((segment) => String(segment)) : []
    return path.length === 0 ? [] : [{ path, set: record.set === true }]
  })
}

function envelopeError(response: unknown): string | undefined {
  const error = asRecord(response).error
  if (typeof error === 'string') return error
  const message = asRecord(error).message
  return typeof message === 'string' ? message : undefined
}

/** 宿主的冲突错误文案（`SettingsConflictError`: `… changed since it was read …`）。 */
function isConflict(message: string | undefined): boolean {
  if (!message) return false
  return message.includes('changed since it was read') || message.includes('SETTINGS_CONFLICT')
}

/** 描述符 → 快照。`value` 已由宿主脱敏（secret 字段不在里面）。 */
function fromDescriptor(view: Record<string, unknown>, writable: boolean): StoreSnapshot {
  const revision = typeof view.revision === 'number' ? view.revision : undefined
  return {
    status: 'ready',
    values: normalizeValues(view.value),
    ...(revision === undefined ? {} : { revision }),
    writable,
    ...(typeof view.applies === 'string' ? { applies: view.applies } : {}),
    secrets: secretSlots(view.secrets),
  }
}

/**
 * 从 `namespaces` 里选出本插件的描述符。
 *
 * 优先精确匹配 profile 条目 id（`dsh-plugin-tlsearch`）；精确匹配落空时，退回到
 * 「id 里带 tlsearch 的唯一候选」——本仓库历史事故里插件曾以旧 id 挂载，写死包名会让
 * 面板整页消失。多个候选一律视为不可判定：宁可提示「未找到」，也不猜错命名空间写坏
 * 别人的配置。
 */
function pickView(namespaces: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const exact = namespaces.find((entry) => entry.ns === CLIENT_NAMESPACE)
  if (exact !== undefined) return exact
  const candidates = namespaces.filter(
    (entry) => typeof entry.ns === 'string' && entry.ns.toLowerCase().includes(NAMESPACE_HINT),
  )
  return candidates.length === 1 ? candidates[0] : undefined
}

/**
 * 构造设置 store。
 *
 * @param remote - 客户端的 `remote` 服务（`apply()` 直接传 `ctx.remote`）。
 *   这里**不**自己取 `ctx.get('remote')`：客户端的 ctx 是白名单服务代理，`remote` 已在
 *   `export const inject` 里声明，直接读才是唯一正确路径。
 */
export function createConfigStore(remote: RemoteLike | undefined): ConfigStore {
  let snapshot = INITIAL
  let disposed = false
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        /* 订阅者自己的异常不能打断别人 */
      }
    }
  }

  const commit = (next: StoreSnapshot): void => {
    if (disposed) return
    snapshot = next
    emit()
  }

  const settings = (): RemoteLike['settings'] | undefined => {
    const services = remote?.settings
    return services && typeof services.describe === 'function' ? services : undefined
  }

  /** 命中的命名空间 id：写回时必须用它（精确匹配落空时可能是旧 id）。 */
  let pickedNs: string | undefined

  const load = async (): Promise<void> => {
    const api = settings()
    if (!api) {
      commit({ ...INITIAL, status: 'unavailable', writable: false })
      return
    }
    try {
      const response = (await api.describe()) as { ok?: boolean; value?: unknown } | undefined
      if (!response || response.ok === false) {
        commit({ ...INITIAL, status: 'error', error: envelopeError(response) ?? 'settings/describe failed' })
        return
      }
      const holder = asRecord(response.value)
      const writable = holder.writable === true
      const view = pickView(namespaceList(response.value))
      if (!view) {
        pickedNs = undefined
        commit({ ...INITIAL, status: 'unavailable', writable })
        return
      }
      pickedNs = typeof view.ns === 'string' ? view.ns : CLIENT_NAMESPACE
      commit(fromDescriptor(view, writable))
    } catch (error) {
      commit({
        ...INITIAL,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 首次读取 + 跟随宿主的推送失效。`$on` 的返回值是解绑函数，官方 provider 也这么用。
  void load()
  let off: (() => void) | undefined
  const subscribed = remote?.$on?.('settings/document-updated', (namespace?: unknown) => {
    // 事件带命名空间；只关心自己的那一份（有的宿主版本不带参数，那就一律重读）。
    if (namespace === undefined || namespace === CLIENT_NAMESPACE || namespace === pickedNs) void load()
  })
  if (typeof subscribed === 'function') off = subscribed as () => void

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(ops) {
      if (ops.length === 0) return { ok: true }
      const api = settings()
      if (!api || typeof api.mutate !== 'function') return { ok: false, error: 'no settings bridge' }
      try {
        const response = (await api.mutate(pickedNs ?? CLIENT_NAMESPACE, ops, snapshot.revision)) as
          | { ok?: boolean; value?: unknown }
          | undefined
        if (!response || response.ok === false) {
          const message = envelopeError(response) ?? 'settings/mutate failed'
          const conflict = isConflict(message)
          if (conflict) {
            await load()
            return { ok: false, error: message, conflict: true }
          }
          return { ok: false, error: message }
        }
        const view = asRecord(response.value)
        if (view.ns === CLIENT_NAMESPACE || view.revision !== undefined) {
          commit(fromDescriptor(view, snapshot.writable))
        } else {
          await load()
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    reload: load,
    dispose() {
      disposed = true
      listeners.clear()
      try {
        off?.()
      } catch {
        /* 解绑失败无所谓 */
      }
    },
  }
}

/** 便捷构造：`set` 一条路径。 */
export function setOp(path: string[], value: unknown): ConfigOp {
  return { op: 'set', path, value }
}

/** 便捷构造：`unset` 一条路径（回到 schema 默认值）。 */
export function unsetOp(path: string[]): ConfigOp {
  return { op: 'unset', path }
}
