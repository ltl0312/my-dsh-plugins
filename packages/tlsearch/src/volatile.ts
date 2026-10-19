// packages/tlsearch/src/volatile.ts
//
// 「改完立即生效」的底座：把配置字段声明为 volatile，并在校验时把它们的值包成**引用**。
//
// ── 为什么需要这一层 ────────────────────────────────────────────────────────
// 宿主（dsh 0.2.1-rc.2）的设置页只为 volatile 字段生成表单，而 volatile 的落地机制是：
//   1. 插件导出的 `Config` schema 上，字段带 `meta.volatile === true`；
//   2. `Config['~standard'].validate(raw)` 在这些**固定对象路径**上返回一个引用
//      `{ get(), [Symbol.for('cosmokit.volatile.write')](next) }`；
//   3. 宿主 Loader 发现「只有 config 变了、且差集全是 volatile」时**不重启插件**，
//      而是 resolve 出新的引用、逐个 `updateVolatile(ref, next)`，再发
//      `loader/volatile-update` 事件（cordis-plugin-loader/lib/index.js:379-422）。
//
// 也就是说：**引用在哪一层被创建，决定了热更新能不能落到插件手里**。官方实现把这件事
// 放在 `@deepseek-ai/schemastery` 的 `Schema.resolve` 里（fork 才有 `.volatile()`），
// 本仓库的公开版 schemastery 3.18.0 没有这个能力，而「零运行时依赖」是本包的硬约束
// （见 tsup.config.ts），不能为此新增 `@deepseek-ai/schemastery` + `cosmokit`。
//
// 于是这里自己实现同一套协议——关键点只有一个：写符号必须是
// `Symbol.for('cosmokit.volatile.write')`（全局注册表），这样**宿主那份 cosmokit**
// 的 `isVolatile` / `updateVolatile` / `volatileEntries` / `plainConfig` / `deepEqual`
// 都能原样识别我们创建的引用，不需要任何版本或类型上的耦合。
//
// ── 引用是快照，不是活对象 ──────────────────────────────────────────────────
// host cosmokit 的 `createVolatile` 会**深冻结**一份快照（volatile config cannot
// contain functions / cycles / class instances）。这里照做：`get()` 返回冻结快照，
// 插件侧拿到手就不可能顺手改掉配置，也就不会出现「只有本插件看到的配置和别人不一样」。

import type Schema from 'schemastery'

/**
 * cosmokit 的写符号。
 *
 * `Symbol.for` 走全局注册表，因此宿主那份 `@deepseek-ai/cosmokit` 里的
 * `Symbol.for('cosmokit.volatile.write')` 与这里是**同一个符号**——
 * 这正是跨副本互操作的全部秘密（cosmokit/lib/index.js:83）。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 一个 volatile 配置字段的引用（形状与宿主 cosmokit 的 createVolatile 一致） */
export interface VolatileRef<T> {
  /** 当前值（已深冻结的快照） */
  get(): T
}

/** 该值是否是 volatile 引用（鸭子类型，跨副本可用） */
export function isVolatileRef(value: unknown): value is VolatileRef<unknown> {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in (value as object)
}

/**
 * 深冻结快照（对齐 cosmokit 的 snapshot 语义）。
 *
 * 拒绝函数与环路：这两种值进不了引用，早失败比让宿主在 `_commitVolatile` 里
 * 悄悄失败更容易排查。JSON 形状的配置永远不会触发这两条。
 */
function snapshot<T>(value: T, ancestors = new Set<unknown>()): T {
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) throw new TypeError('volatile config cannot contain cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors))) as unknown as T
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      // 非纯对象（Date/Map/类实例）原样冻结：配置里不该出现，但不必因此抛错。
      return Object.freeze(value)
    }
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = snapshot(item, ancestors)
    }
    return Object.freeze(copy) as unknown as T
  } finally {
    ancestors.delete(value)
  }
}

/** 创建一个引用；`get()` 永远返回同一份冻结快照，直到宿主写入新值 */
export function createVolatileRef<T>(initial: T): VolatileRef<T> {
  let current = snapshot(initial)
  const ref = {
    get: (): T => current,
    [VOLATILE_WRITE]: (next: T): void => {
      current = snapshot(next)
    },
  }
  return Object.freeze(ref) as VolatileRef<T>
}

/**
 * 把一个 schema 标记为 volatile（等价于官方 fork 的 `.volatile()`）。
 *
 * 返回同一个实例：schema 是可变对象，链式写法在 `Schema.object({...})` 里最省事。
 */
export function volatile<S extends Schema>(schema: S): S {
  const meta = schema.meta as Record<string, unknown>
  // 与官方一致：重复标记是用法错误，直接报错而不是静默覆盖
  if (meta.volatile === true) throw new TypeError('volatile schema is already wrapped')
  meta.volatile = true
  return schema
}

/**
 * 沿 schema 把校验结果里的 volatile 字段替换成引用（**原地改写**）。
 *
 * 只处理两种位置：
 *   - 该 schema 节点自身 volatile → 整个值包成引用（数组类字段用它，例如 `chain`）；
 *   - 对象节点 → 递归到 **dict 里的固定键**（`fallback.apiKey` 这种）。
 *
 * 刻意不下探数组元素：`chain` 的每一项没有固定路径，宿主 `validateVolatilePlacement`
 * 也明确禁止「数组元素 + 外层 volatile」以外的组合（dsh-app-boot/lib/index.js:2611）。
 */
function wrapVolatile(schema: Schema | undefined, value: unknown): unknown {
  if (!schema) return value
  if ((schema.meta as Record<string, unknown> | undefined)?.volatile === true) return createVolatileRef(value)
  if (schema.type !== 'object' || !schema.dict) return value
  if (value === null || typeof value !== 'object') return value
  const target = value as Record<string, unknown>
  for (const key of Object.keys(schema.dict)) {
    if (!Object.hasOwn(target, key)) continue
    target[key] = wrapVolatile(schema.dict[key], target[key])
  }
  return value
}

/**
 * 让导出的 `Config` 在校验时产出引用。
 *
 * 为什么改 `~standard` 而不是直接用 `Schema.resolve`：宿主只走
 * `Config['~standard'].validate(config)`（@deepseek-ai/cordis/lib/index.js:956），
 * 那正是唯一必须拦截的入口。`~standard` 在 schemastery 里是原型上的 **getter**
 * （3.18.0 src/index.ts:214），所以这里用 `defineProperty` 在实例上遮蔽它；
 * 属性可配置，重复调用是幂等的。
 */
export function withVolatileRefs<S extends Schema>(schema: S): S {
  const own = Object.getOwnPropertyDescriptor(schema, '~standard')
  if (own?.get) return schema // 已经包过了
  const standard = schema['~standard']
  Object.defineProperty(schema, '~standard', {
    configurable: true,
    enumerable: false,
    get() {
      return {
        version: standard.version,
        vendor: standard.vendor,
        validate: (value: unknown) => {
          const result = standard.validate(value) as
            | { value?: unknown; issues?: readonly unknown[] }
            | undefined
          // 校验失败时原样返回：宿主需要看到 issues，绝不能在这里吞掉
          if (!result || result.issues !== undefined) return result
          try {
            result.value = wrapVolatile(schema, result.value)
          } catch {
            // 包引用失败（环/函数）不阻断装配：退回普通值，最坏结果是改配置要重启
          }
          return result
        },
      }
    },
  })
  return schema
}

/** 读一个字段（普通值或引用都接受）；未提供时返回 `fallback` */
export function readField<T>(value: T | VolatileRef<T> | undefined, fallback: T): T {
  const current = isVolatileRef(value) ? (value.get() as T) : (value as T | undefined)
  return current === undefined || current === null ? fallback : current
}

/**
 * 深解包：把引用摊平成普通 JSON 形状。
 *
 * 每次工具调用都对**当前** raw config 调用一次，得到本次生效的配置——
 * 这就是「不缓存快照」的实现方式（`resolveRuntime` 本身无副作用，成本可忽略）。
 */
export function unwrapVolatile<T>(value: T): T {
  if (isVolatileRef(value)) return unwrapVolatile(value.get() as T)
  if (Array.isArray(value)) return value.map((item) => unwrapVolatile(item)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return value
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = unwrapVolatile(item)
    }
    return copy as unknown as T
  }
  return value
}
