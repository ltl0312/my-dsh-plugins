// packages/tlmemory/src/client/index.tsx
// DSH 客户端插件（浏览器半边）：把 tlmemory 看板原生嵌入 DSH Web GUI。
// 官方契约（dsh-client-ui-slots）：
// 1. conversation.view（kind: list, scope: session）—— 中心主视口的可切换子视图，
//    在会话头部以页签呈现（Chat / Trajectory / 记忆看板），选中后主视口整体切换，
//    左侧边栏、右侧工具抽屉、顶底外壳布局完全保持不动；
// 2. sidebar.footer.action（kind: list, scope: root）—— 左侧导航栏底部加性席位，
//    注册新 id 不会替换任何既有入口（官方指引：小侧边栏动作优先用加性内层插槽）。
// 安全：看板仅回环地址 http://127.0.0.1:4890，若宿主管线未启动则显示离线横幅，
//      绝不影响会话主流程；插件卸载时所有注册随纤程自动逆向注销。
import type { Context } from 'cordis'
import React from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { IconDatabaseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  DASHBOARD_LABEL,
  DASHBOARD_ORIGIN,
  SIDEBAR_ACTION_ID,
  VIEW_ID,
  dashboardUrl,
  openDashboardForSession,
  probeDashboardHealth,
} from './logic.js'

export {
  DASHBOARD_LABEL,
  DASHBOARD_ORIGIN,
  SIDEBAR_ACTION_ID,
  VIEW_ID,
  dashboardUrl,
  openDashboardForSession,
  probeDashboardHealth,
} from './logic.js'

/** 客户端插件硬依赖：slots（插槽注册）、sessions（当前会话）、uiConversation（视图激活） */
export const inject = ['slots', 'sessions', 'uiConversation']

/** 会话头部页签注册（conversation.view）时注入给组件的业务面 */
interface DashboardViewInjected {
  dashboardOrigin: string
}

/** 侧边栏底部动作注册（sidebar.footer.action）时注入给组件的业务面 */
interface SidebarActionInjected {
  onOpen: () => boolean
}

/**
 * 中心主视口看板：全幅 iframe 挂载 127.0.0.1:4890 的 Vue 看板。
 * 健康状态条驱动：探测中 / 在线 / 离线三态，离线时给出重试与直开链接，
 * 不渲染任何会阻塞会话的模态。
 */
function MemoryDashboardView(props: DashboardViewInjected): ReactElement {
  const [state, setState] = React.useState<'probing' | 'online' | 'offline'>('probing')

  const check = React.useCallback(() => {
    setState('probing')
    probeDashboardHealth(props.dashboardOrigin).then((ok) => setState(ok ? 'online' : 'offline'))
  }, [props.dashboardOrigin])

  React.useEffect(() => {
    check()
    const timer = setInterval(check, 15000)
    return () => clearInterval(timer)
  }, [check])

  const statusStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    fontSize: 12,
    borderBottom: '1px solid rgba(128,128,128,0.25)',
    background: 'rgba(128,128,128,0.08)',
  }

  const statusText =
    state === 'probing'
      ? '记忆看板连接中…'
      : state === 'online'
        ? '记忆看板服务在线'
        : '记忆看板服务未启动（127.0.0.1:4890）'

  const dotColor = state === 'online' ? '#22c55e' : state === 'probing' ? '#eab308' : '#ef4444'

  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 420 } },
    React.createElement(
      'div',
      { style: statusStyle },
      React.createElement('span', { style: { color: dotColor } }, '●'),
      React.createElement('span', { style: { color: 'inherit', opacity: 0.85 } }, statusText),
      state === 'offline'
        ? React.createElement(
            'button',
            {
              onClick: check,
              style: {
                marginLeft: 8,
                padding: '2px 10px',
                fontSize: 12,
                cursor: 'pointer',
                borderRadius: 4,
                border: '1px solid rgba(128,128,128,0.4)',
                background: 'transparent',
              },
            },
            '重试',
          )
        : null,
      React.createElement(
        'a',
        {
          href: dashboardUrl(props.dashboardOrigin),
          target: '_blank',
          rel: 'noreferrer',
          style: { marginLeft: 'auto', fontSize: 12, opacity: 0.85 },
        },
        '在新窗口打开 ↗',
      ),
    ),
    React.createElement('iframe', {
      src: dashboardUrl(props.dashboardOrigin),
      title: DASHBOARD_LABEL,
      style: { flex: 1, width: '100%', border: 'none', minHeight: 0 },
    }),
  )
}

/**
 * 左侧导航栏底部入口：折叠态只显示图标，展开态显示图标 + 标签。
 * 点击即激活当前会话的记忆看板视图（中心主视口切换，外壳不动）。
 */
function MemorySidebarAction(props: { wide: boolean } & SidebarActionInjected): ReactElement {
  return React.createElement(
    'button',
    {
      onClick: () => {
        props.onOpen()
      },
      title: DASHBOARD_LABEL,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: props.wide ? '100%' : 32,
        height: 32,
        justifyContent: props.wide ? 'flex-start' : 'center',
        padding: props.wide ? '0 10px' : 0,
        cursor: 'pointer',
        background: 'transparent',
        border: 'none',
        color: 'inherit',
        opacity: 0.85,
        borderRadius: 6,
      },
    },
    React.createElement(IconDatabaseOutline16, null),
    props.wide ? React.createElement('span', { style: { fontSize: 12 } }, DASHBOARD_LABEL) : null,
  )
}

/** 客户端插件装配：注册中心主视口页签与左侧导航入口 */
export function apply(ctx: Context): void {
  const slots = ctx.slots

  // 中心主视口子视图：会话头部出现「记忆看板」页签
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: VIEW_ID,
        order: 30,
        label: () => DASHBOARD_LABEL,
        inject: () => ({ dashboardOrigin: DASHBOARD_ORIGIN } satisfies DashboardViewInjected),
      },
      MemoryDashboardView,
    ),
  )

  // 左侧导航栏底部入口：点击激活当前会话的记忆看板视图
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: SIDEBAR_ACTION_ID,
        order: 90,
        label: () => DASHBOARD_LABEL,
        inject: () =>
          ({
            onOpen: () => openDashboardForSession(ctx.sessions, ctx.uiConversation),
          }) satisfies SidebarActionInjected,
      },
      MemorySidebarAction,
    ),
  )
}