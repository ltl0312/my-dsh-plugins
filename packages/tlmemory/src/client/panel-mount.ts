// packages/tlmemory/src/client/panel-mount.ts
// 中心列（conversation 主视口）单占接管生命周期。
//
// 中心列是单占席位（ui-conversation 持有 conversation / conversation.session
// 插槽），外部插件既不能声明插槽、也无法通过服务 API 切换可见视图，因此家族
// 插件统一在 DOM 层接管：
//   * 容器作为「中心列的尾部子节点」注入——React 从不管理它，所以不会干扰
//     shell 的 reconciliation（容器加在列末尾，会话子树整体保持挂载与状态）；
//   * 显隐只由 <html> 上的激活属性驱动（样式见 styles.ts），不涉及 React；
//   * 单占协调：本面板激活时清除既有面板（任务看板 / SSH）的 <html> 标记并按
//     它们的语义各广播一次 dsh-panel-activate，再广播自身；收到兄弟面板广播或
//     用户点击会话行时主动退场，把中心列还给会话。
// 本模块不依赖 react-dom：面板树的挂载以 mount(container) 回调注入，
// 由 index.tsx 用 createRoot 实现，从而可在 jsdom 下单测生命周期本身。

import {
  ACTIVE_ATTRIBUTE,
  CONVERSATION_COLUMN_SELECTOR,
  PANEL_ACTIVATE_EVENT,
  PANEL_NAME,
  SIDEBAR_SESSION_ROW_SELECTOR,
  SIBLING_ACTIVE_ATTRIBUTES,
  activationBroadcasts,
  markPanelActivation,
  shouldRelinquishColumn,
  type PanelState,
} from './logic.js'

/** 挂载中心面板所需的外部面 */
export interface CenterPanelOptions {
  /**
   * 把面板树挂载进注入的容器，返回卸载函数。
   * 生命周期由本模块掌管：容器被宿主替换时会先卸载再重新挂载。
   */
  mount: (container: HTMLElement) => () => void
  /** 变量与容器共享的打开状态源 */
  state: PanelState
  /** 容器 / <html> 属性与 broadcast detail 的归属标识 */
  plugin: string
  /** 容器属性名（无 data- 前缀的驼峰键，如 `dshTlmemoryView`） */
  viewDatasetKey: string
  /** 打开状态变化时（并非打开态时也需要）刷新面板树，如主题 / 语言切换 */
  refresh?: (listener: () => void) => () => void
  /** 文档对象（默认取全局 document，单测可注入） */
  doc?: Document
}

/** 找到中心列，未渲染时返回 undefined */
export function conversationColumn(doc: Document): HTMLElement | undefined {
  return doc.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/**
 * 在中心列注入面板容器并把显隐绑定到状态源。
 * @param options - 面板树挂载回调、状态源与归属标识
 * @returns 卸载面板树、移除容器并归还中心列的 Disposer
 */
export function mountCenterPanel(options: CenterPanelOptions): () => void {
  const doc = options.doc ?? document
  let unmount: (() => void) | undefined
  let container: HTMLElement | undefined

  const disposeContainer = (): void => {
    try {
      unmount?.()
    } catch {
      // 卸载异常不得阻断容器回收。
    }
    unmount = undefined
    container?.remove()
    container = undefined
  }

  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      // 中心列被宿主整体替换：丢掉过期树，重新注入。
      disposeContainer()
    }
    const column = conversationColumn(doc)
    if (column === undefined) return
    container = doc.createElement('div')
    // dataset 键（camelCase）→ 真实属性 data-dsh-tlmemory-view，与样式表选择器对应。
    container.dataset[options.viewDatasetKey] = ''
    container.setAttribute('data-dsh-plugin', options.plugin)
    column.append(container)
    try {
      unmount = options.mount(container)
    } catch {
      // 面板树挂载失败：容器留在 DOM 内（空容器在未激活时不显示），不影响外壳。
      unmount = undefined
    }
  }

  // 外壳在启动结算后才挂载中心列，用观察者等待其出现并跟踪整树重建。
  // 极早期 boot 阶段 body 可能尚未建立，退回观察 documentElement（body 也在其内）。
  const waitObserver = new MutationObserver(() => {
    ensure()
  })
  waitObserver.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true })

  const applyActive = (): void => {
    if (options.state.isOpen()) {
      // 单占席位：打开本面板必须先让兄弟面板退场，否则两套显隐规则互斥后
      // 表现为「点了没反应」。清除标记做兜底，广播则让兄弟面板的控制器
      // 状态一并收敛（它们只认自己的 sibling detail）。
      for (const attribute of SIBLING_ACTIVE_ATTRIBUTES) {
        doc.documentElement.removeAttribute(attribute)
      }
      doc.documentElement.setAttribute(ACTIVE_ATTRIBUTE, '')
      for (const detail of activationBroadcasts()) {
        const event = new CustomEvent(PANEL_ACTIVATE_EVENT, { detail })
        // 打上来源标记：代播兄弟 detail 时不能让本面板自己的监听端退场。
        markPanelActivation(event)
        doc.dispatchEvent(event)
      }
    } else {
      doc.documentElement.removeAttribute(ACTIVE_ATTRIBUTE)
    }
  }

  const onOtherActivate = (event: Event): void => {
    if (!options.state.isOpen()) return
    if (shouldRelinquishColumn(event)) options.state.setOpen(false)
  }

  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!options.state.isOpen()) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_SESSION_ROW_SELECTOR) !== null) options.state.setOpen(false)
  }

  doc.addEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate)
  doc.addEventListener('click', onClickSidebarRow, true)
  const unsubscribeState = options.state.subscribe(applyActive)
  const unsubscribeRefresh = options.refresh?.(() => {
    // 刷新语义：整棵树重挂（语言 / 主题变化时重建面板内容）。
    if (container === undefined) return
    disposeContainer()
    ensure()
  })
  applyActive()
  ensure()

  return () => {
    doc.removeEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate)
    doc.removeEventListener('click', onClickSidebarRow, true)
    waitObserver.disconnect()
    unsubscribeRefresh?.()
    unsubscribeState()
    doc.documentElement.removeAttribute(ACTIVE_ATTRIBUTE)
    disposeContainer()
  }
}

/** 面板广播 detail 的归属标识（供调用方与兄弟插件对齐） */
export const CENTER_PANEL_NAME = PANEL_NAME
