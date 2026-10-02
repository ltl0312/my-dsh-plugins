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
 * 只注入 `slots`——它是**硬依赖**（没有它这一页根本挂不上）。`connection` **不注入**：
 * 它是**软依赖**（拿不到就退化成只读态，而不是整页消失），而客户端的 ctx 是白名单
 * 代理，`inject` 里每个名字都会变成一道**激活门**（provider 卸载时整包被 park）。
 * 官方指引同此：「Prefer ctx.get(name) with an undefined check; use inject only for
 * hard dependencies.」（`dsh-cordis-client-runner/lib/client.js:6144`）。所以设置页
 * 每次调用时用 `ctx.get('connection')` 现取。
 */
export const inject: string[] = ['slots']

/**
 * 打招呼专用。
 *
 * 客户端的 ctx 是白名单代理，`ctx.logger` **不在**白名单里（读它同样会抛）。日志是
 * 失败路径上的最后一环，绝不能再制造第二个异常，所以取不到就安静算了。
 */
function warn(ctx: ClientContextLike, message: string, error?: unknown): void {
  try {
    const queried = typeof ctx.get === 'function' ? ctx.get('logger') : undefined
    const logger = (queried ?? ctx.logger) as { warn?: (message: string, error?: unknown) => void } | undefined
    logger?.warn?.(message, error)
  } catch {
    /* 客户端的 ctx 可能连 logger 都不给：这里只是打招呼，绝不能因此再抛。 */
  }
}

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
    warn(ctx, 'tlnotify: 宿主没有 slots 服务，设置页无法挂载。')
    return
  }

  try {
    ensureClientStyles()
  } catch (error) {
    warn(ctx, 'tlnotify: 注入样式失败，页面会失去外观但仍可用。', error)
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
    warn(ctx, 'tlnotify: 注册设置页失败。', error)
  }

  ctx.effect?.(() => () => removeClientStyles(), 'tlnotify: client mounts')
}
