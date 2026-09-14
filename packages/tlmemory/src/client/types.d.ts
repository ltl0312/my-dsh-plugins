// packages/tlmemory/src/client/types.d.ts
// 客户端插件类型的独立最小化环境声明（仅在浏览器侧打包时被引用）：
// 1. react：构建期解析为 shell 静态模块表提供的 'react' / 'react/jsx-runtime'；
// 2. cordis Context：声明客户端 slots / sessions / uiConversation 服务的最小结构，
//    与 @deepseek-ai/dsh-client-ui-slots 及 @deepseek-ai/dsh-client-ui-conversation
//    的运行时契约对齐，避免对官方客户端包产生编译期硬依赖。

declare module 'react' {
  export type ReactNode = unknown
  export type ReactElement = unknown
  export interface CSSProperties {
    [key: string]: string | number | undefined
  }
  export function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): ReactElement
  export function useState<T>(initial: T | (() => T)): [T, (value: T) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useCallback<T extends (...args: never[]) => unknown>(
    callback: T,
    deps: readonly unknown[],
  ): T
  export const Fragment: unknown
  const React: {
    createElement: typeof createElement
    useState: typeof useState
    useEffect: typeof useEffect
    useCallback: typeof useCallback
    Fragment: typeof Fragment
  }
  export default React
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** 数据库图标（16px Outline 系列），用于侧边栏入口 */
  export const IconDatabaseOutline16: unknown
}

declare module 'cordis' {
  interface Context {
    /** 客户端插槽服务（提供 inject/register，注册即随纤程注销） */
    slots: {
      inject<T>(name: string, register: () => T): void
      register(options: unknown, component: unknown): unknown
    }
    /** 客户端会话服务（当前会话读取 + per-session binding） */
    sessions: import('./logic.js').SessionsLike
    /** 会话视图编排服务（binding().activate 激活 conversation.view） */
    uiConversation: import('./logic.js').UiConversationLike
  }
}
