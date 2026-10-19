// packages/tlsearch/src/client/host.ts
//
// 浏览器半边用到的宿主服务的**最小结构视图**。
//
// 刻意不 import 任何宿主包的类型：客户端 bundle 里不能出现 Node 内置模块，也不该
// 把 DSH 的内部包版本钉死。这里只写「我用到的那几个成员长什么样」——宿主多几个字段
// 不影响我们，少一个就编译不过，这正是想要的耦合粒度。
//
// 运行时能 require 到的裸说明符只有 `react`（`dsh.client.external` 里同名声明），
// 其余一律打进 bundle；组件一律 `React.createElement` + 内联样式/自有 CSS，不依赖
// `@deepseek-ai/dsh-client-ui-primitives`（0.2.1 里它只是壳的虚拟模块，源码不可读）。

import type { ReactNode } from 'react'

/** `ctx.slots.register` 的 list 槽选项（dsh-client-ui-slots）。 */
export interface SlotRegisterOptions {
  name: string
  /** list 槽的席位 id；同一个 id 重复注册会被宿主判重。 */
  id: string
  /** 导航里的排序位。 */
  order?: number
  /** 显示名。传 thunk 才能跟随语言变化（宿主不替我们订阅语言状态）。 */
  label?: string | (() => string)
  /** 文案命名空间：与 `ctx.locale.register(ns, …)` 的 ns 一致。 */
  locale?: string
  /** 注入面：组件拿到的额外 props。 */
  inject?: () => Record<string, unknown>
  priority?: number
}

/** 插槽组件：owner props 与 inject 面的合并。 */
export type SlotComponent = (props: Record<string, unknown>) => ReactNode

export interface SlotsService {
  inject(name: string, callback: () => unknown): unknown
  register(options: SlotRegisterOptions, component: SlotComponent): unknown
}

/**
 * `ctx.locale`：注册并绑定一个文案命名空间。
 *
 * `register` 的词典形状为 `{ zh: {...}, en: {...} }`（官方 `dsh-client-ui-settings-*`
 * 各包一致）；`bind(ns)` 返回 `(key) => string`。两者都返回 disposer / 取值函数，
 * 宿主版本差异由调用方兜住。
 */
export interface LocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown
  bind(namespace: string): unknown
}

/**
 * 一次设置写入的字段操作（`dsh-settings` 的 `applyPathOp` 契约）。
 *
 * `path` 是**完整**路径：`['provider']`、`['fallback','apiKey']`、`['chain']`。
 * 宿主的 `isVolatilePath(schema, path)` 逐段下钻，所以只要目标叶子（或它上面最近的
 * volatile 节点）带标记，这条路径就允许写；数组下标用字符串段（`['chain','0']`）。
 */
export interface ConfigOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

/** `remote.settings` 的响应信封：成功 `{ok:true,value}`，失败 `{ok:false,error}`。 */
export interface RpcResponse<T = unknown> {
  ok: boolean
  value?: T
  error?: { code?: string; message?: string }
}

/** `remote.settings` 面（`dsh-api-settings-controller` 的 RPC）。 */
export interface RemoteSettingsLike {
  describe(): Promise<RpcResponse<unknown>>
  update(ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<RpcResponse<unknown>>
  mutate(ns: string, ops: ConfigOp[], expectedRevision?: number): Promise<RpcResponse<unknown>>
}

/** `remote` 服务的最小视图。 */
export interface RemoteLike {
  settings?: RemoteSettingsLike
  /** 事件订阅；返回解绑函数（宿主不一定返回，调用方须容错）。 */
  $on?: (event: string, listener: (namespace?: unknown) => void) => unknown
}

/**
 * 客户端 apply 拿到的 ctx。
 *
 * 客户端的 ctx 不是普通对象：`dsh-cordis-client-runner` 会把它包成**白名单代理**，
 * 读一个**没写进 `inject` 的服务名会直接抛**（`service "x" is not declared by your
 * plugin`），`?.` 挡不住抛异常的 getter。所以这里显式建模三个已声明服务；不在
 * `inject` 里的（`logger`）走 `ctx.get(name)` 免声明查询，未就位时返回 `undefined`。
 */
export interface ClientContextLike {
  get: (name: string) => unknown
  /** 硬依赖（已在 `inject` 里声明）。 */
  slots?: SlotsService
  locale?: LocaleService
  remote?: RemoteLike
  /** 0.2.1 的客户端 ctx 无条件提供；不要写 `ctx.effect?.()`。 */
  effect: (callback: () => void | (() => void), label?: string) => unknown
}
