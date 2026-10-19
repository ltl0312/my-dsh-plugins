// packages/tlsearch/src/client/index.tsx
//
// 浏览器半边的入口：把设置页挂到 `settings.section` 插槽上。
//
// 为什么用官方插槽而不是 DOM 级接管：设置页的一等公民插槽就是 `settings.section`
// （官方 `dsh-client-ui-settings-*` 各包都这么注册），走它就不必猜宿主外壳的 DOM 结构，
// 也不会在外壳改版时静默失效。
//
// 客户端 ctx 是**白名单服务代理**：`ctx.xxx` 只对 `inject` 里声明过的名字可读，读未声明的
// 会直接抛（`?.` 挡不住 throw）。所以这里声明 `['slots', 'locale', 'remote']` —— 三个都是
// 本面板的真依赖（挂载点 / 文案 / 配置读写），缺一个这页就没有意义。
// 不在 inject 里的服务（`logger`）一律走 `ctx.get(name)` 现取。
//
// 客户端 `apply` 抛错会拖垮整个 web boot，所以每一步都自己兜住，失败只留一条警告。

import React from 'react'
import { SettingsPage } from './SettingsPage.js'
import { DICTIONARIES, SETTINGS_LOCALE_NS, createTranslator, detectLang, translate } from './i18n.js'
import type { Lang } from './i18n.js'
import type { ClientContextLike, SlotComponent } from './host.js'
import type { ConfigStore } from './store.js'
import { createConfigStore } from './store.js'
import { ensureClientStyles, removeClientStyles } from './styles.js'

/**
 * 注入的宿主服务（硬依赖）：插槽、文案、配置传输。
 *
 * `remote.settings` 必须单独列出：客户端 ctx 是服务代理，未声明的属性一读就抛
 * `cannot get property "remote.settings" without inject`（0.2.1-rc.2 实测），
 * 而设置页读写全靠这个命名空间，`?.` 兜不住。
 */
export const inject: string[] = ['slots', 'locale', 'remote', 'remote.settings']

/** 插槽条目 id：设置页左栏的定位锚点，也是本插件在 profile 里的条目名。 */
export const SETTINGS_SECTION_ID = 'tlsearch'
/** 导航顺序：紧跟 tlmemory(30)，在模型 / 账户等宿主内建分区之前。 */
export const SETTINGS_SECTION_ORDER = 31

/** 打招呼专用：`logger` 不在 inject 里，用 `ctx.get` 现取。 */
function warn(ctx: ClientContextLike, message: string, error?: unknown): void {
  try {
    const logger = ctx.get('logger') as { warn?: (message: string, error?: unknown) => void } | undefined
    logger?.warn?.(message, error)
  } catch {
    /* 连 logger 都取不到也不能再抛：这里只是打招呼。 */
  }
}

/** 跟随宿主语言。`<html lang>` / `class` 变了就重渲染。 */
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

/** 插槽注入面：只给 store，文案由组件自己按当前语言取。 */
interface SectionProps {
  store: ConfigStore
}

/** `settings.section` 的组件：把 store 渲染成表单。 */
function TlsearchSection(props: SectionProps): React.ReactElement {
  const lang = useLang()
  const t = React.useMemo(() => createTranslator(lang), [lang])
  return <SettingsPage store={props.store} t={t} />
}
TlsearchSection.displayName = 'TlsearchSettingsSection'

export function apply(ctx: ClientContextLike): void {
  if (typeof document === 'undefined') return

  const disposers: Array<() => void> = []
  const dispose = (): void => {
    for (const entry of disposers.splice(0)) {
      try {
        entry()
      } catch (error) {
        warn(ctx, 'tlsearch: 设置面板回收失败。', error)
      }
    }
  }
  // 0.2.1 的客户端 ctx 无条件提供 effect，不写 `ctx.effect?.()` 这种双路回退。
  ctx.effect(() => dispose, 'tlsearch: settings section')

  const slots = ctx.slots
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    warn(ctx, 'tlsearch: 宿主没有 slots 服务，设置页无法挂载。')
    return
  }

  try {
    ensureClientStyles()
    disposers.push(removeClientStyles)
  } catch (error) {
    warn(ctx, 'tlsearch: 注入样式失败，页面会失去外观但仍可用。', error)
  }

  // 文案：两份词表注册进宿主 locale（导航名与宿主侧取词都从这里来）。
  // 页面正文另用本地 translator —— 它的 `{name}` 占位符替换是自己实现的，不赌宿主
  // `locale.bind()` 的入参签名；两份词表内容同源（i18n.ts）。
  let boundT: ((key: string) => string) | undefined
  try {
    const locale = ctx.locale
    if (locale && typeof locale.register === 'function') {
      const registered = locale.register(SETTINGS_LOCALE_NS, DICTIONARIES)
      if (typeof registered === 'function') disposers.push(registered as () => void)
    }
    if (locale && typeof locale.bind === 'function') {
      const bound = locale.bind(SETTINGS_LOCALE_NS)
      if (typeof bound === 'function') boundT = bound as (key: string) => string
    }
  } catch (error) {
    warn(ctx, 'tlsearch: 注册文案命名空间失败，导航名退回内置词表。', error)
  }

  // 配置读写：store 由这里持有（插槽组件重挂不丢状态、不重复订阅），回收交给 effect。
  const store = createConfigStore(ctx.remote)
  disposers.push(() => store.dispose())

  try {
    slots.inject('settings.section', () =>
      slots.register(
        {
          name: 'settings.section',
          id: SETTINGS_SECTION_ID,
          order: SETTINGS_SECTION_ORDER,
          // `label` 传 thunk：语言变化时宿主重新取词，导航名跟着变。
          label: () => (boundT ? boundT('nav') : translate(detectLang(), 'nav')),
          locale: SETTINGS_LOCALE_NS,
          inject: () => ({ store }),
        },
        // 插槽组件拿到的 props = owner props + `inject()` 的返回值。宿主侧只做对象合并，
        // 类型上收窄成 `SlotComponent` 才符合 register 的签名。
        TlsearchSection as unknown as SlotComponent,
      ),
    )
  } catch (error) {
    warn(ctx, 'tlsearch: 注册设置页失败。', error)
  }
}
