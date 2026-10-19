// packages/tlmemory/src/client/types.d.ts
// 客户端插件类型的独立最小化环境声明（仅在浏览器侧打包 / 类型检查时被引用）：
// 1. react / react-dom/client：构建期解析为 shell 静态模块表提供的同名模块
//    （宿主内置包与家族插件同样以 require("react-dom/client") 取 createRoot）；
// 2. cordis Context：只声明本插件真正使用的宿主 API（ctx.effect / ctx.slots /
//    ctx.locale / ctx.remote）。新增用到的宿主 API 必须在此同步补声明，否则
//    客户端 tsc 会报错。
//
// 槽位与设置传输的结构取自宿主实现（dsh-client-ui-slots 的 slots 服务、
// dsh-client-locale 的 locale 服务、settings.section 的注册形态见
// @deepseek-ai/dsh-client-ui-settings-account/lib/client.js:4773-4795、
// @deepseek-ai/dsh-client-ui-settings-general/lib/client.js:1258-1261 与
// @deepseek-ai/dsh-client-ui-settings/lib/client.js:1447-1489）。

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
  /** 一次插槽注册的声明（字段与宿主 slots.register 的 spec 对齐） */
  interface SlotRegistration {
    /** 目标插槽名，如 'settings.section' */
    name: string
    /** 插槽内唯一 id */
    id?: string
    /** 同级排序权重，越小越靠前 */
    order?: number
    /** 导航/标题文案（惰性求值，随语言切换重算） */
    label?: () => string
    /** 该条目使用的词典命名空间 */
    locale?: string
    /** 传给组件的注入面 */
    inject?: () => Record<string, unknown>
    /** 子插槽声明（本插件未使用，保留以对齐宿主契约） */
    children?: Record<string, { kind: 'list' | 'single'; scope?: string }>
  }

  /** 宿主插槽服务（ctx.slots） */
  interface SlotsService {
    /**
     * 仅当目标插槽存在时执行注册，并把注销交给纤程。
     * @param name - 插槽名
     * @param callback - 插槽就绪后的注册体，返回其 Disposer
     * @returns 手动注销的 Disposer
     */
    inject(name: string, callback: () => () => void): () => void
    /**
     * 在插槽里登记一个条目。
     * @param spec - 条目声明
     * @param component - 渲染该条目的组件
     * @returns 注销该条目的 Disposer
     */
    register(spec: SlotRegistration, component: unknown): () => void
  }

  /** 宿主词典服务（ctx.locale） */
  interface LocaleService {
    /** 绑定命名空间，返回该命名空间下的取词函数 */
    bind(namespace: string): (key: string) => string
    /**
     * 注册词典（键为语言标识）。
     * @returns 注销该词典的 Disposer
     */
    register(namespace: string, bundles: Record<string, Record<string, string>>): () => void
  }

  /** 宿主设置传输（ctx.remote.settings，见 dsh-api-settings-controller） */
  interface RemoteSettingsService {
    describe(): Promise<unknown>
    update(namespace: string, patch: Record<string, unknown>, revision?: number): Promise<unknown>
    mutate(namespace: string, operations: unknown[], revision?: number): Promise<unknown>
  }

  /** 宿主远程服务（ctx.remote） */
  interface RemoteService {
    settings: RemoteSettingsService
    /** 订阅远程事件；设置文档变更事件为 'settings/document-updated' */
    $on(event: string, callback: (...args: unknown[]) => void): () => void
  }

  interface Context {
    /**
     * 注册随纤程自动回收的生命周期副作用（客户端插件的标准注销通道）。
     * @param callback - 副作用体；其返回值作为 Disposer
     * @param label - 便于排障的副作用名
     * @returns 手动执行注销的 Disposer
     */
    effect(callback: () => void | (() => void), label?: string): () => void
    /** 插槽服务（由 shell 提供） */
    slots: SlotsService
    /** 词典服务（由 shell 提供） */
    locale: LocaleService
    /** 远程服务（由 shell 提供） */
    remote: RemoteService
  }
}
