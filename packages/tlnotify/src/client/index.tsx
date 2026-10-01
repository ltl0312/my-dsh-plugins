// packages/tlnotify/src/client/index.tsx
//
// 浏览器半边的入口：把设置页挂到 `settings.section` 插槽上。
//
// 为什么用官方插槽而不是 tlmemory 那套「DOM 级接管」：设置页的一等公民插槽就是
// `settings.section`（官方 `dsh-client-ui-settings-plugins` 等五个包都这么注册），
// 走它就不必去猜宿主外壳的 DOM 结构，也不会在外壳改版时静默失效。
//
// 客户端 `apply` 抛错会拖垮整个 web boot，所以这里每一步都自己兜住，失败只留一条
// 警告日志。

import React from 'react'
import { SettingsPage } from './panels/SettingsPage.js'
import { createTranslator, detectLang, translate } from './i18n.js'
import type { Lang } from './i18n.js'
import type { ClientContextLike } from './host.js'
import { ensureClientStyles, removeClientStyles } from './styles.js'

/**
 * 注入的宿主服务名。
 *
 * 只注入 `slots`。`connection` **不注入**：拿不准它在客户端 cordis 里注册的短名，
 * 而注入一个不存在的服务会让插件永远不激活（比降级严重得多）。设置页在每次调用
 * 时才读 `ctx.connection.rpc`，服务晚就位也能自己好起来。
 */
export const inject: string[] = ['slots']

/** 跟随宿主语言。`<html lang>`/`class` 变了就重渲染。 */
function useLang(): Lang {
  const [lang, setLang] = React.useState<Lang>(() => detectLang())

  React.useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined
    const observer = new MutationObserver(() => setLang(detectLang()))
    try {
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang', 'class'] })
    } catch {
      return undefined
    }
    return () => observer.disconnect()
  }, [])

  return lang
}

export function apply(ctx: ClientContextLike): void {
  if (typeof document === 'undefined') return

  const slots = ctx.slots
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    ctx.logger?.warn?.('tlnotify: 宿主没有 slots 服务，设置页无法挂载。')
    return
  }

  try {
    ensureClientStyles()
  } catch (error) {
    ctx.logger?.warn?.('tlnotify: 注入样式失败，页面会失去外观但仍可用。', error)
  }

  const Section = (): React.ReactElement => {
    const lang = useLang()
    const t = React.useMemo(() => createTranslator(lang), [lang])
    return <SettingsPage ctx={ctx} t={t} />
  }
  Section.displayName = 'TlnotifySettingsSection'

  try {
    // `label` 传 thunk：`settings.section` 的契约是注册者自己负责在语言变化时给出
    // 新文案（shell 不订阅 locale），thunk 每次读取都重新求值正好满足。
    slots.inject('settings.section', () =>
      slots.register(
        {
          name: 'settings.section',
          id: 'tlnotify',
          order: 60,
          label: () => translate(detectLang(), 'nav'),
        },
        Section,
      ),
    )
  } catch (error) {
    ctx.logger?.warn?.('tlnotify: 注册设置页失败。', error)
  }

  ctx.effect?.(() => () => removeClientStyles(), 'tlnotify: client mounts')
}
