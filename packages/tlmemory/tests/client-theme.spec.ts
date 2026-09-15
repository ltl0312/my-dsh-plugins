// @vitest-environment jsdom
// packages/tlmemory/tests/client-theme.spec.ts
// 主题桥宿主半边的单测：配色读数优先级、变更订阅（含去抖与退订）、
// 主题消息协议，以及 iframe 透明属性 / color-scheme 的落位。
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DASHBOARD_ORIGIN,
  READY_MESSAGE_TYPE,
  THEME_CHANGE_MESSAGE_TYPE,
  THEME_MESSAGE_TYPE,
  isDashboardOrigin,
  legacyThemeMessage,
  parseDashboardMessage,
  themeMessage,
} from '../src/client/logic.js'
import { detectThemeMode, watchThemeMode } from '../src/client/theme.js'
import { applyFrameTransparency } from '../src/client/frame.js'

/** 让 MutationObserver 的微任务回调结算 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  document.documentElement.removeAttribute('data-ds-dark-theme')
  document.documentElement.removeAttribute('data-ds-light-theme')
  document.documentElement.removeAttribute('data-theme')
  document.body.removeAttribute('data-ds-dark-theme')
  document.body.removeAttribute('data-ds-light-theme')
  document.body.removeAttribute('data-theme')
  // class 形态标记的用例各自清理，这里整体兜底归零
  document.body.className = ''
  document.documentElement.className = ''
  // 内联 color-scheme 同样归零，避免用例间串扰
  document.documentElement.style.colorScheme = ''
  document.body.style.colorScheme = ''
})

describe('主题协议常量', () => {
  it('themeMessage 产出规范协议推送体 { type: dsh-theme-change, theme }', () => {
    expect(THEME_CHANGE_MESSAGE_TYPE).toBe('dsh-theme-change')
    expect(themeMessage('dark')).toEqual({ type: THEME_CHANGE_MESSAGE_TYPE, theme: 'dark' })
    expect(themeMessage('light').theme).toBe('light')
  })

  it('legacyThemeMessage 产出旧协议推送体 { type: dsh-tlmemory:theme, mode }（兼容周期）', () => {
    expect(legacyThemeMessage('dark')).toEqual({ type: THEME_MESSAGE_TYPE, mode: 'dark' })
    expect(legacyThemeMessage('light').mode).toBe('light')
  })

  it('parseDashboardMessage 只认就绪握手，陌生消息一律忽略', () => {
    expect(parseDashboardMessage({ type: READY_MESSAGE_TYPE })).toEqual({ type: READY_MESSAGE_TYPE })
    expect(parseDashboardMessage({ type: 'something-else' })).toBeUndefined()
    expect(parseDashboardMessage('dsh-tlmemory:ready')).toBeUndefined()
    expect(parseDashboardMessage(null)).toBeUndefined()
    expect(parseDashboardMessage(undefined)).toBeUndefined()
  })

  it('isDashboardOrigin 精确比对看板源', () => {
    expect(isDashboardOrigin(DASHBOARD_ORIGIN)).toBe(true)
    // event.origin 由浏览器按 scheme://host:port 序列化，永不带尾斜杠；
    // 带斜杠说明来源异常，按不匹配处理（宁严不松）。
    expect(isDashboardOrigin(`${DASHBOARD_ORIGIN}/`)).toBe(false)
    expect(isDashboardOrigin('http://127.0.0.1:4891')).toBe(false)
    expect(isDashboardOrigin('https://evil.example')).toBe(false)
    expect(isDashboardOrigin('')).toBe(false)
  })
})

describe('宿主配色读数', () => {
  it('宿主未声明主题时回落浅色（jsdom 无系统深色偏好）', () => {
    expect(detectThemeMode(document)).toBe('light')
  })

  it('body 上的权威深色标记优先', () => {
    document.body.setAttribute('data-ds-dark-theme', '')
    expect(detectThemeMode(document)).toBe('dark')
  })

  it('html 上的显式浅色标记生效', () => {
    document.documentElement.setAttribute('data-ds-light-theme', '')
    expect(detectThemeMode(document)).toBe('light')
  })

  it('取值型属性支持 light / dark 文本值', () => {
    document.body.setAttribute('data-theme', 'dark')
    expect(detectThemeMode(document)).toBe('dark')
    document.body.setAttribute('data-theme', 'light')
    expect(detectThemeMode(document)).toBe('light')
    // 非法取值不参与判定
    document.body.setAttribute('data-theme', 'solarized')
    expect(detectThemeMode(document)).toBe('light')
  })

  it('body 与 html 同时有标记时以 body 为准', () => {
    document.documentElement.setAttribute('data-ds-light-theme', '')
    document.body.setAttribute('data-ds-dark-theme', '')
    expect(detectThemeMode(document)).toBe('dark')
  })

  it('class 形态的主题标记（body.dark / body.light）参与判定', () => {
    document.body.classList.add('dark')
    expect(detectThemeMode(document)).toBe('dark')
    document.body.classList.remove('dark')
    document.body.classList.add('light')
    expect(detectThemeMode(document)).toBe('light')
    document.body.classList.remove('light')
    expect(detectThemeMode(document)).toBe('light')
  })

  it('html 上的 class 令牌同样生效，且 data 标记优先于 class', () => {
    document.documentElement.classList.add('dark')
    expect(detectThemeMode(document)).toBe('dark')
    // data 显式标记优先于 class 令牌
    document.body.setAttribute('data-theme', 'light')
    expect(detectThemeMode(document)).toBe('light')
    document.body.removeAttribute('data-theme')
    document.documentElement.classList.remove('dark')
  })

  it('class 子串相似名（dark-mode 等）不得误判为主题标记', () => {
    document.body.className = 'dark-mode themed-dark'
    expect(detectThemeMode(document)).toBe('light')
  })

  it('★ 宿主 boot 脚本语义：浅色 = 无 data 标记 + 内联 color-scheme: light', () => {
    // 复刻 dsh-client-ui-theme 的 boot 脚本在浅色态留下的 DOM：
    // documentElement.style.colorScheme = 'light'，body 无任何主题标记。
    // 旧行为会漏读这层而回落 matchMedia（OS 偏好），OS 深色时就把浅色宿主推成深色。
    document.documentElement.style.colorScheme = 'light'
    expect(detectThemeMode(document)).toBe('light')

    // 深色态：boot 脚本同时写属性与内联值，两者一致判深色
    document.documentElement.style.colorScheme = 'dark'
    document.body.setAttribute('data-ds-dark-theme', '')
    expect(detectThemeMode(document)).toBe('dark')

    // 内联 color-scheme 的优先级高于 class 令牌（boot 脚本比皮肤类更权威）
    document.body.removeAttribute('data-ds-dark-theme')
    document.documentElement.style.colorScheme = 'light'
    document.body.classList.add('dark')
    expect(detectThemeMode(document)).toBe('light')
  })

  it('body 上的内联 color-scheme 先于 html 读数', () => {
    document.body.style.colorScheme = 'dark'
    document.documentElement.style.colorScheme = 'light'
    expect(detectThemeMode(document)).toBe('dark')
  })

  it('内联 color-scheme 变化（style 属性）触发订阅回调', async () => {
    const listener = vi.fn()
    const dispose = watchThemeMode(document, listener)
    document.documentElement.style.colorScheme = 'dark'
    await flush()
    expect(listener).toHaveBeenCalledWith('dark')
    dispose()
  })
})

describe('宿主配色订阅', () => {
  it('主题标记变化时回调新值，且仅在实际变化时触发', async () => {
    const listener = vi.fn()
    const dispose = watchThemeMode(document, listener)

    document.body.setAttribute('data-ds-dark-theme', '')
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith('dark')

    // 同一模式的其它属性抖动（class 变化）不应重复通知
    document.body.className = 'hHd-Xa_body'
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)

    // 切回浅色：需要摘掉深色标记并落一个显式浅色标记
    document.body.removeAttribute('data-ds-dark-theme')
    document.documentElement.setAttribute('data-ds-light-theme', '')
    await flush()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith('light')

    dispose()
  })

  it('退订后不再回调', async () => {
    const listener = vi.fn()
    watchThemeMode(document, listener)()

    document.body.setAttribute('data-ds-dark-theme', '')
    await flush()
    expect(listener).not.toHaveBeenCalled()
  })

  it('订阅者抛错不影响观察链', async () => {
    const listener = vi.fn(() => {
      throw new Error('订阅者异常')
    })
    const dispose = watchThemeMode(document, listener)

    document.body.setAttribute('data-ds-dark-theme', '')
    await flush()
    dispose()

    // 第二次变更仍能照常派发
    const second = vi.fn()
    const disposeSecond = watchThemeMode(document, second)
    document.body.removeAttribute('data-ds-dark-theme')
    document.documentElement.setAttribute('data-ds-light-theme', '')
    await flush()
    expect(second).toHaveBeenCalledWith('light')
    disposeSecond()
  })
})

describe('iframe 透明透传', () => {
  /** 构造一张游离的 iframe */
  const makeFrame = (): HTMLIFrameElement => document.createElement('iframe')

  it('同时落位遗留属性与现代内联样式', () => {
    const frame = makeFrame()
    applyFrameTransparency(frame)

    expect(frame.getAttribute('allowtransparency')).toBe('true')
    expect(frame.getAttribute('background')).toBe('transparent')
    expect(frame.style.background).toBe('transparent')
    expect(frame.style.backgroundColor).toBe('transparent')
  })

  it('重复应用幂等，不叠加脏值', () => {
    const frame = makeFrame()
    applyFrameTransparency(frame)
    applyFrameTransparency(frame)
    expect(frame.getAttribute('background')).toBe('transparent')
    expect(frame.style.backgroundColor).toBe('transparent')
  })

  it('★ iframe 元素不得携带非 normal 的 color-scheme（否则 Chromium 涂白画布）', () => {
    const frame = makeFrame()
    applyFrameTransparency(frame)
    // applyFrameTransparency 只管透明属性，绝不能碰 color-scheme
    expect(frame.style.colorScheme).toBe('')
  })
})
