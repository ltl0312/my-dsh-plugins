// packages/tlnotify/src/client/host.ts
//
// 浏览器半边用到的宿主服务的**最小结构视图**。
//
// 刻意不 import 任何宿主包的类型：客户端 bundle 里不能出现 Node 内置模块，也不该
// 把 DSH 的内部包版本钉死。这里只声明「我用到的那几个成员长什么样」——宿主升级多
// 几个字段不影响我们，少一个就编译不过，这正是想要的耦合粒度。
//
// 运行时能 require 到的裸说明符只有 `react`（dsh-im 与 tlmemory 两个参考实现都只
// require `react` / `react-dom*`，本插件只用 `react`）。其余一律打进来。

import type { ReactNode } from 'react'

/** `ctx.slots.register` 的 list 槽选项（dsh-client-ui-slots）。 */
export interface SlotRegisterOptions {
  name: string
  /** list 槽的席位 id；同一个 id + 同优先级重复注册会抛错。 */
  id: string
  /** 导航里的排序位。 */
  order?: number
  /** 显示名。传 thunk 才能跟随语言变化（shell 不会替我们订阅语言状态）。 */
  label?: string | (() => string)
  priority?: number
  children?: Record<string, { kind: string; scope?: string }>
}

/** 插槽组件：owner props（`settings.section` 给 `{ close }`）与 inject 面的合并。 */
export type SlotComponent = (props: Record<string, unknown>) => ReactNode

export interface SlotsService {
  inject(name: string, callback: () => unknown): unknown
  register(options: SlotRegisterOptions, component: SlotComponent): unknown
}

/** 客户端 `ctx.connection.rpc` 的最小面（dsh-client-connection）。 */
export interface ConnectionRpcLike {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
}

export interface ConnectionLike {
  isLoopback?: boolean
  rpc?: ConnectionRpcLike
}

/** 客户端 apply 拿到的 ctx。用可选字段是为了能在半装好的宿主上优雅降级。 */
export interface ClientContextLike {
  slots?: SlotsService
  connection?: ConnectionLike
  effect?: (callback: () => void | (() => void), label?: string) => unknown
  logger?: { warn?: (message: string, error?: unknown) => void }
}
