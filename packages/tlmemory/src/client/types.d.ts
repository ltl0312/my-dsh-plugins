// packages/tlmemory/src/client/types.d.ts
// 客户端插件类型的独立最小化环境声明（仅在浏览器侧打包 / 类型检查时被引用）：
// 1. react / react-dom/client：构建期解析为 shell 静态模块表提供的同名模块
//    （宿主内置包与家族插件同样以 require("react-dom/client") 取 createRoot）；
// 2. cordis Context：只声明本插件真正使用的宿主 API（ctx.effect）。
//    新增用到的宿主 API 必须在此同步补声明，否则客户端 tsc 会报错。
//
// 本插件不再使用任何客户端服务（slots / sessions / uiConversation），
// 因此这里也不再为它们保留声明 —— 谁引入谁补声明。

declare module 'react' {
  export type ReactNode = unknown
  export type ReactElement = unknown
  export interface CSSProperties {
    [key: string]: string | number | undefined
  }
  export interface RefObject<T> {
    current: T
  }
  /** setState 的两种形态：直接值或基于前值的更新函数 */
  export type SetState<T> = (value: T | ((previous: T) => T)) => void
  export function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): ReactElement
  export function useState<T>(initial: T | (() => T)): [T, SetState<T>]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useCallback<T extends (...args: never[]) => unknown>(
    callback: T,
    deps: readonly unknown[],
  ): T
  export function useRef<T>(initial: T): RefObject<T>
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export const Fragment: unknown
  const React: {
    createElement: typeof createElement
    useState: typeof useState
    useEffect: typeof useEffect
    useCallback: typeof useCallback
    useRef: typeof useRef
    useMemo: typeof useMemo
    Fragment: typeof Fragment
  }
  export default React
}

declare module 'react-dom/client' {
  /** React 根句柄（仅用到 render / unmount） */
  export interface Root {
    render(children: unknown): void
    unmount(): void
  }
  /** 在宿主容器上创建 React 根（中心主视口面板用它独立挂载） */
  export function createRoot(container: Element | DocumentFragment): Root
}

declare module 'cordis' {
  interface Context {
    /**
     * 注册随纤程自动回收的生命周期副作用（客户端插件的标准注销通道）。
     * @param callback - 副作用体；其返回值作为 Disposer
     * @param label - 便于排障的副作用名
     * @returns 手动执行注销的 Disposer
     */
    effect(callback: () => void | (() => void), label?: string): () => void
  }
}
