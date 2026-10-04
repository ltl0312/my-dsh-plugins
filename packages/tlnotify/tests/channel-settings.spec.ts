// packages/tlnotify/tests/channel-settings.spec.ts
//
// 「每台机器人各自一套设置」落地后的宿主侧逻辑：会话范围、事件开关、正文细节
// 的合并与脱敏，以及通道投递（每台机器人各收一份）。
//
// 这一层的失败模式和 rpc.spec.ts 描述的一样安静——都不会抛错，只会让用户觉得
// 「设置没生效」：
//   * 合并的底用错（该回落到**内置默认**却回落到全局值）→ 全局一改，通道跟着跑偏；
//   * 显式 'all' 被 sessionFilter 列表压过 → 用户勾了「所有会话」却收不到；
//   * 脱敏把密钥带出去 → 没人会发现；
//   * sendEach 的「没人关心」与 send() 的「没有通道接」混为一谈 → 日志刷满。
// 所以下面重点钉「合并的底是谁」和「谁压过谁」。
//
// 另外几处**源码实际行为与设计描述不一致**的地方，都就地用注释标了出来，并按
// 源码断言（不是为了证明实现对，而是先把现状钉住，免得改坏时没人知道）。

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  channelCaresAboutSession,
  defaultConfig,
  defaultContent,
  defaultEvents,
  resolveChannelSettings,
} from '../src/config.js'
import { applyPatch, redactChannel } from '../src/rpc.js'
import { ChannelManager } from '../src/channels/index.js'
import { QqChannel } from '../src/channels/qq.js'
import type { RpcFailure, RpcResult } from '../src/protocol.js'
import type {
  ChannelConfig,
  ChannelLogger,
  ContentConfig,
  EventsConfig,
  Notification,
  TlnotifyConfig,
} from '../src/types.js'

function channel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return { id: 'qq-main', type: 'qq', enabled: true, sessionFilter: [], ...overrides }
}

function configWith(...channels: ChannelConfig[]): TlnotifyConfig {
  return { ...defaultConfig(), channels }
}

/** 取出成功结果，失败时把 details 打出来（否则断言失败只看到 undefined）。 */
function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(`期望成功，实际：${JSON.stringify(result.error)}`)
  return result.value
}

/** 取出失败原因，成功时抛错。 */
function unwrapError<T>(result: RpcResult<T>): RpcFailure {
  if (result.ok) throw new Error(`期望失败，实际成功：${JSON.stringify(result.value)}`)
  return result.error
}

/** 打一个通道补丁，返回补丁后配置里的那台机器人。 */
function patchChannel(base: TlnotifyConfig, patch: Record<string, unknown>): ChannelConfig {
  const next = unwrap(applyPatch(base, { channels: [patch] })).next
  const first = next.channels[0]
  if (!first) throw new Error('补丁后通道表变空了')
  return first
}

/**
 * 造一个「只有部分键」的 events / content。
 *
 * 这是真实场景：配置文件是用户手改过的、或者老版本宿主写下的，只有零星几个键。
 * 用 `Partial<X> as X` 而不是 `as any`：类型系统本来就说不出「一个少了必填键的
 * 对象」，这里是想在**运行期**喂给被测函数。
 */
function partialEvents(overrides: Partial<EventsConfig>): EventsConfig {
  return overrides as EventsConfig
}

function partialContent(overrides: Partial<ContentConfig>): ContentConfig {
  return overrides as ContentConfig
}

// ---------------------------------------------------------------------------
// A. resolveChannelSettings
// ---------------------------------------------------------------------------

describe('resolveChannelSettings', () => {
  const globalWith = (): Pick<TlnotifyConfig, 'events' | 'content'> => ({
    events: { ...defaultEvents(), onTurnEnd: false },
    content: { ...defaultContent(), includeMetadata: false, maxBodyChars: 500 },
  })

  it('没开自定义 → 原样返回全局那一份（同一引用，改全局后跟着变）', () => {
    const global = globalWith()
    const target = channel()
    const first = resolveChannelSettings(global, target)

    // 「原样」= 不是拷贝、也不是快照：设置页改全局，这台机器人立刻跟着变。
    expect(first.events).toBe(global.events)
    expect(first.content).toBe(global.content)

    global.events.onError = false
    global.content.maxBodyChars = 600
    const second = resolveChannelSettings(global, target)
    expect(second.events.onError).toBe(false)
    expect(second.content.maxBodyChars).toBe(600)
  })

  it('开了自定义但只给部分键 → 未提到的键回落到**内置默认**，而不是全局值', () => {
    const global = globalWith()
    const target = channel({
      overrideEvents: true,
      events: partialEvents({ onError: false }),
      overrideContent: true,
      content: partialContent({ includeUserPrompt: true }),
    })
    const { events, content } = resolveChannelSettings(global, target)

    expect(events.onError).toBe(false)
    // 全局把 onTurnEnd 关成了 false，但内置默认是 true → 回落到内置默认
    expect(events.onTurnEnd).toBe(true)
    expect(events.includeSubagent).toBe(false)

    expect(content.includeUserPrompt).toBe(true)
    // 全局 maxBodyChars=500 / includeMetadata=false，内置默认是 1800 / true
    expect(content.maxBodyChars).toBe(1800)
    expect(content.includeMetadata).toBe(true)
  })

  it('开了自定义但 events / content 本身是 undefined → 回落到全局值，不崩', () => {
    const global = globalWith()
    const target = channel({ overrideEvents: true, overrideContent: true })
    const { events, content } = resolveChannelSettings(global, target)

    // 开关开着但覆盖对象没给：只能按「没覆盖」处理，否则会拿到 undefined 崩在调用处
    expect(events).toBe(global.events)
    expect(content).toBe(global.content)
  })
})

// ---------------------------------------------------------------------------
// B. channelCaresAboutSession
// ---------------------------------------------------------------------------

describe('channelCaresAboutSession', () => {
  it("显式 'all' 压过非空的 sessionFilter", () => {
    const target = channel({ sessionScope: 'all', sessionFilter: ['s1'] })
    expect(channelCaresAboutSession(target, 's1')).toBe(true)
    expect(channelCaresAboutSession(target, 's2')).toBe(true)
  })

  it('sessionScope 缺省 + 列表为空 / 未给 → 关心所有会话', () => {
    expect(channelCaresAboutSession(channel({ sessionFilter: [] }), 'anything')).toBe(true)
    expect(channelCaresAboutSession(channel({ sessionFilter: undefined }), 'anything')).toBe(true)
    expect(channelCaresAboutSession(channel({ sessionScope: undefined }), 'anything')).toBe(true)
  })

  it('sessionScope 缺省 + 非空列表 → 只有列表内的会话关心', () => {
    const target = channel({ sessionFilter: ['s1'] })
    expect(channelCaresAboutSession(target, 's1')).toBe(true)
    expect(channelCaresAboutSession(target, 's2')).toBe(false)
  })

  it("显式 'filter' 压过空列表 → 谁都不关心（不是「空列表=全关心」）", () => {
    const target = channel({ sessionScope: 'filter', sessionFilter: [] })
    expect(channelCaresAboutSession(target, 's1')).toBe(false)
    expect(channelCaresAboutSession(target, '')).toBe(false)
  })

  it("'single'：只认绑定的那个会话，别的会话与空 id 都不关心", () => {
    const target = channel({ sessionScope: 'single', sessionId: 'session-a' })
    expect(channelCaresAboutSession(target, 'session-a')).toBe(true)
    expect(channelCaresAboutSession(target, 'session-b')).toBe(false)
    expect(channelCaresAboutSession(target, '')).toBe(false)
  })

  it("'single' 但还没选会话（空 id）→ 谁都不推：宁可安静，也不要突然把全部会话刷过去", () => {
    const target = channel({ sessionScope: 'single', sessionId: '' })
    expect(channelCaresAboutSession(target, 'session-a')).toBe(false)
    expect(channelCaresAboutSession(target, '')).toBe(false)
  })

  it("'single' 压过非空的 sessionFilter（用户选了「只推一个」，列表不该再起作用）", () => {
    const target = channel({ sessionScope: 'single', sessionId: 'session-a', sessionFilter: ['session-b'] })
    expect(channelCaresAboutSession(target, 'session-a')).toBe(true)
    expect(channelCaresAboutSession(target, 'session-b')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// C. applyPatch 的每机器人字段
// ---------------------------------------------------------------------------

describe('applyPatch 的每机器人字段', () => {
  it('只发 overrideEvents + 部分 events：未提到的键保留原覆盖值', () => {
    const base = configWith(channel({ overrideEvents: true, events: { ...defaultEvents(), onTurnEnd: false } }))
    const next = patchChannel(base, { id: 'qq-main', overrideEvents: true, events: { onError: false } })

    expect(next.overrideEvents).toBe(true)
    expect(next.events?.onError).toBe(false)
    expect(next.events?.onTurnEnd).toBe(false) // 原覆盖值保留
    expect(next.events?.onPending).toBe(true)
  })

  it('只发 events（不带 overrideEvents）→ 视为开启自定义', () => {
    const next = patchChannel(configWith(channel()), { id: 'qq-main', events: { onError: false } })
    expect(next.overrideEvents).toBe(true)
    expect(next.events?.onError).toBe(false)
  })

  it('events: null / content: null → 复位开关并删掉覆盖对象', () => {
    const base = configWith(
      channel({
        overrideEvents: true,
        events: { ...defaultEvents(), onError: false },
        overrideContent: true,
        content: { ...defaultContent(), maxBodyChars: 200 },
      }),
    )

    const clearedEvents = patchChannel(base, { id: 'qq-main', events: null })
    expect(clearedEvents.overrideEvents).toBe(false)
    expect('events' in clearedEvents).toBe(false)

    const clearedContent = patchChannel(base, { id: 'qq-main', content: null })
    expect(clearedContent.overrideContent).toBe(false)
    expect('content' in clearedContent).toBe(false)
  })

  it('只发 overrideEvents:false（不发 events）→ 覆盖对象留着，但不再生效', () => {
    const overrides = { ...defaultEvents(), onTurnEnd: false }
    const base = configWith(channel({ overrideEvents: true, events: overrides }))
    const next = patchChannel(base, { id: 'qq-main', overrideEvents: false })

    // 源码：只有 `patch.events !== undefined` 才会动 `next.events`，所以覆盖对象
    // 原样留在配置里（不是被删掉）。这是刻意的：用户关掉开关只是「暂时不生效」，
    // 再打开时那套自定义值还在，不用重新填一遍。
    expect(next.overrideEvents).toBe(false)
    expect(next.events).toEqual(overrides)

    // 「留着但不再生效」= 生效值回到全局那一份
    const effective = resolveChannelSettings(base, next)
    expect(effective.events).toBe(base.events)
    expect(effective.events.onTurnEnd).toBe(true)
  })

  describe('label', () => {
    it('写字符串（先 trim）', () => {
      const next = patchChannel(configWith(channel()), { id: 'qq-main', label: ' 主号 ' })
      expect(next.label).toBe('主号')
    })

    it('空串 / 纯空白 / null → 清空', () => {
      for (const clearing of ['', '   ', null]) {
        const next = patchChannel(configWith(channel({ label: '旧名' })), { id: 'qq-main', label: clearing })
        expect(next.label, JSON.stringify(clearing)).toBeUndefined()
      }
    })

    it('清空时源码是「赋 undefined」而不是「删键」——与其他文本字段的语义不一致', () => {
      const next = patchChannel(configWith(channel({ label: '旧名' })), { id: 'qq-main', label: '' })
      // 源码 `next.label = read.value`，没走 `assign()`（其他文本字段走 assign，
      // value 为 undefined 时会 delete 键）。所以键其实还在，只是值为 undefined。
      // 对 JSON 序列化 / 设置页展示没有影响（undefined 会被丢掉），但两套语义并存
      // 本身就是个坑，这里钉住。
      expect('label' in next).toBe(true)
      expect(next.label).toBeUndefined()
    })

    it('非字符串 → invalid-patch', () => {
      const result = applyPatch(configWith(channel()), { channels: [{ id: 'qq-main', label: 123 }] })
      const error = unwrapError(result)
      expect(error.code).toBe('invalid-patch')
      expect(error.details.path).toBe('channels[0].label')
    })

    it('超长 label 目前**没有任何上限**（与设计描述不符，按源码断言）', () => {
      // 设计描述是「并发超长要有 invalid-patch 失败」，但 `readTextPatch()` 只查
      // 「是不是字符串 / 是不是空」，不查长度，`ChannelSchema` 也没给 label 设
      // max。所以超长 label 会被原样写进配置。
      // 断言的是现状而不是期望：真要加上限，应该先知道现在没有。
      const long = 'x'.repeat(5000)
      const next = patchChannel(configWith(channel()), { id: 'qq-main', label: long })
      expect(next.label).toBe(long)
    })
  })

  it("sessionScope 只认 'all' / 'single' / 'filter'，别的值 → invalid-patch", () => {
    const result = applyPatch(configWith(channel()), { channels: [{ id: 'qq-main', sessionScope: 'none' }] })
    const error = unwrapError(result)
    expect(error.code).toBe('invalid-patch')
    expect(error.details.path).toBe('channels[0].sessionScope')

    const ok = patchChannel(configWith(channel()), { id: 'qq-main', sessionScope: 'filter', sessionFilter: ['s1'] })
    expect(ok.sessionScope).toBe('filter')

    const single = patchChannel(configWith(channel()), { id: 'qq-main', sessionScope: 'single', sessionId: 'session-a' })
    expect(single.sessionScope).toBe('single')
    expect(single.sessionId).toBe('session-a')
  })

  it('sessionId：空串即清空绑定（不是「留下上一次选的那个」）', () => {
    const bound = patchChannel(configWith(channel()), { id: 'qq-main', sessionScope: 'single', sessionId: 'session-a' })
    expect(bound.sessionId).toBe('session-a')

    const cleared = patchChannel(configWith(bound), { id: 'qq-main', sessionId: '' })
    expect(cleared.sessionId).toBeUndefined()
  })

  describe('通道级 historyTurns（三态）', () => {
    it('null → 删掉覆盖，回到跟随全局', () => {
      const base = configWith(channel({ historyTurns: 5 }))
      expect(patchChannel(base, { id: 'qq-main', historyTurns: null }).historyTurns).toBeUndefined()
    })

    it('0 是合法值，且与「没设过」不是一回事（0 = 这台不带历史）', () => {
      expect(patchChannel(configWith(channel()), { id: 'qq-main', historyTurns: 0 }).historyTurns).toBe(0)
    })

    it('-1 / 21 / 小数 / 字符串 / NaN → 全拒', () => {
      const base = configWith(channel())
      const bad = [-1, 21, 1.5, '3', Number.NaN, true]
      for (const value of bad) {
        const result = applyPatch(base, { channels: [{ id: 'qq-main', historyTurns: value }] })
        expect(unwrapError(result).code, JSON.stringify(value)).toBe('invalid-patch')
      }
    })

    it('关掉正文自定义（overrideContent=false）不会顺手把 historyTurns 清掉', () => {
      const base = configWith(channel({ overrideContent: true, historyTurns: 4 }))
      const next = patchChannel(base, { id: 'qq-main', overrideContent: false })
      expect(next.historyTurns).toBe(4)
    })
  })

  it('events / content 里出现未知键（含跨对象的键）→ invalid-patch', () => {
    // 事件对象里没有 onNope
    expect(applyPatch(configWith(channel()), { channels: [{ id: 'qq-main', events: { onNope: true } }] }).ok).toBe(false)

    // maxBodyChars 属于 content，放到 events 里必须被拒（跨对象键不能靠「反正没人看」蒙混）
    const crossed = applyPatch(configWith(channel()), { channels: [{ id: 'qq-main', events: { maxBodyChars: 200 } }] })
    const crossedError = unwrapError(crossed)
    expect(crossedError.code).toBe('invalid-patch')
    expect(crossedError.details.path).toBe('channels[0].events.maxBodyChars')

    // content 里没有 onError
    expect(applyPatch(configWith(channel()), { channels: [{ id: 'qq-main', content: { onError: true } }] }).ok).toBe(false)
  })

  describe('通道级 content.maxBodyChars 边界', () => {
    it('199 / 20001 / NaN / 字符串 / 无穷 → 全拒', () => {
      const base = configWith(channel())
      const bad = [199, 20001, Number.NaN, '1800', Number.POSITIVE_INFINITY, null]
      for (const value of bad) {
        const result = applyPatch(base, { channels: [{ id: 'qq-main', content: { maxBodyChars: value } }] })
        expect(unwrapError(result).code, JSON.stringify(value)).toBe('invalid-patch')
      }
    })

    it('200 / 1800 / 20000 → 写入且一定是整数', () => {
      const base = configWith(channel())
      for (const value of [200, 1800, 20000]) {
        const next = patchChannel(base, { id: 'qq-main', content: { maxBodyChars: value } })
        expect(next.content?.maxBodyChars).toBe(value)
        expect(Number.isInteger(next.content?.maxBodyChars)).toBe(true)
      }
    })

    it('小数被四舍五入接受（与全局 content.maxBodyChars 的 requireInt 不对称）', () => {
      // 通道级走 `readContentPatch()`：只判 number + 区间，然后 `Math.round()`；
      // 全局那份走 `requireInt()`，小数直接拒。同一个字段名两套规则，钉住。
      const next = patchChannel(configWith(channel()), { id: 'qq-main', content: { maxBodyChars: 1500.5 } })
      expect(next.content?.maxBodyChars).toBe(1501)

      expect(applyPatch(configWith(channel()), { content: { maxBodyChars: 1500.5 } }).ok).toBe(false)
    })
  })

  it('未知顶层键仍然被拒（回归）', () => {
    const result = applyPatch(configWith(channel()), { nope: 1 })
    const error = unwrapError(result)
    expect(error.code).toBe('invalid-patch')
    expect(String(error.details.path)).toContain('nope')
  })
})

// ---------------------------------------------------------------------------
// D. redactChannel
// ---------------------------------------------------------------------------

describe('redactChannel', () => {
  const global = {
    events: { ...defaultEvents(), onTurnEnd: false },
    content: { ...defaultContent(), includeMetadata: false, maxBodyChars: 500 },
  }

  it('没开自定义 → 开关为 false，events / content 回的是全局生效值（拷贝）', () => {
    const red = redactChannel(channel(), global)
    expect(red.overrideEvents).toBe(false)
    expect(red.overrideContent).toBe(false)
    expect(red.events).toEqual(global.events)
    expect(red.content).toEqual(global.content)
    // 拷贝：脱敏结果会被序列化回浏览器，不能把宿主内部那份对象直接交出去
    expect(red.events).not.toBe(global.events)
    expect(red.content).not.toBe(global.content)
    expect(red.label).toBe('')
    expect(red.sessionScope).toBe('all')
  })

  it('开了自定义 → events / content 回的是合并后的**生效值**', () => {
    const target = channel({
      overrideEvents: true,
      events: partialEvents({ onError: false }),
      overrideContent: true,
      content: partialContent({ maxBodyChars: 300 }),
    })
    const red = redactChannel(target, global)

    expect(red.overrideEvents).toBe(true)
    expect(red.events.onError).toBe(false)
    expect(red.events.onTurnEnd).toBe(true) // 内置默认，不是全局的 false
    expect(red.overrideContent).toBe(true)
    expect(red.content.maxBodyChars).toBe(300)
    expect(red.content.includeMetadata).toBe(true) // 内置默认，不是全局的 false
  })

  it('sessionScope 缺省时按 sessionFilter 反推（与 channelCaresAboutSession 同一套规则）', () => {
    expect(redactChannel(channel({ sessionFilter: ['s1'] }), global).sessionScope).toBe('filter')
    expect(redactChannel(channel({ sessionFilter: [] }), global).sessionScope).toBe('all')
    // 显式值两边的「压过」方向也要一致
    expect(redactChannel(channel({ sessionScope: 'all', sessionFilter: ['s1'] }), global).sessionScope).toBe('all')
    expect(redactChannel(channel({ sessionScope: 'filter', sessionFilter: [] }), global).sessionScope).toBe('filter')
  })

  it("'single' 的绑定 id 与 historyTurns 一并回给设置页；没设过 historyTurns 时不带这个键", () => {
    const red = redactChannel(channel({ sessionScope: 'single', sessionId: 'session-a', historyTurns: 0 }), global)
    expect(red.sessionScope).toBe('single')
    expect(red.sessionId).toBe('session-a')
    expect(red.historyTurns).toBe(0)

    const follow = redactChannel(channel({ sessionScope: 'single', sessionId: 'session-a' }), global)
    expect(follow.sessionId).toBe('session-a')
    // 缺省＝跟随全局：必须**不带键**。带了 `0` 的话设置页会把「跟随全局」显示成「0 轮」，
    // 用户以为自己没动过，实际已经把这台机器人改成不带历史了。
    expect('historyTurns' in follow).toBe(false)

    // 没绑会话时回空串（而不是 undefined），设置页的受控输入框才能直接吃这个值。
    expect(redactChannel(channel(), global).sessionId).toBe('')
  })

  it('密钥永不出现在脱敏结果里（回归）', () => {
    const target = channel({
      appId: '1234567890',
      appSecret: 'qq-secret-plain',
      feishuAppId: 'cli_abcdefg',
      feishuAppSecret: 'fs-secret-plain',
    })
    const red = redactChannel(target, global)
    const json = JSON.stringify(red)

    expect(json).not.toContain('qq-secret-plain')
    expect(json).not.toContain('fs-secret-plain')
    // 只露末四位，够用户认出自己配的是哪个，又不够拼回原值
    expect(red.appSecret).toEqual({ configured: true, hint: '••••lain' })
    expect(red.feishuAppSecret).toEqual({ configured: true, hint: '••••lain' })
  })

  it('没配密钥时报「未配置」而不是空串', () => {
    const red = redactChannel(channel(), global)
    expect(red.appSecret).toEqual({ configured: false, hint: '' })
    expect(red.feishuAppSecret).toEqual({ configured: false, hint: '' })
  })
})

// ---------------------------------------------------------------------------
// E. ChannelManager：投递顺序、逐台发送、单台失败不牵连
// ---------------------------------------------------------------------------
//
// 《每机器人设置方案》之后，投递走 `sendEach()`：**谁勾了谁收到**，两台都勾同一
// 会话就各收一条（不短路）。`send()` 保留旧的故障转移语义，只有老路径在用。

interface LogLine {
  level: 'info' | 'warn' | 'error'
  message: string
}

/** 极小的假 log：只把行记下来。故意不实现 `child`，通道会自动回落到父 log。 */
function fakeLog(): { log: ChannelLogger; lines: LogLine[] } {
  const lines: LogLine[] = []
  const recorder = (level: LogLine['level']) => (message: string) => {
    lines.push({ level, message })
  }
  return { log: { info: recorder('info'), warn: recorder('warn'), error: recorder('error') }, lines }
}

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    title: 'DSH · tlnotify · a1b2c3 · 任务完成',
    body: '改完了 3 个文件。',
    actions: [],
    level: 'info',
    sessionId: 'session-1',
    tag: 'session-1:completed:1',
    kind: 'completed',
    ...overrides,
  }
}

const DROPPED = '没有可用的通道，通知被丢弃'

describe('ChannelManager 的逐台投递', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * 造一个管理器。真正的 `start()` 会去连平台 SDK，所以这里把 `start` 打桩成
   * 「立刻就绪」；`send` 按各用例需要打桩——被测的是管理器的编排，不是通道本身。
   */
  function makeManager(): { manager: ChannelManager; lines: LogLine[] } {
    const { log, lines } = fakeLog()
    const manager = new ChannelManager({ log, onInbound: () => {}, onAction: () => {} })
    return { manager, lines }
  }

  function stubStart(): void {
    vi.spyOn(QqChannel.prototype, 'start').mockResolvedValue(undefined)
  }

  it('两台机器人都不关心这个会话：sendEach 静默返回空数组，只有 send() 才 warn', async () => {
    stubStart()
    const send = vi.spyOn(QqChannel.prototype, 'send').mockResolvedValue({ messageId: 'm-1' })
    const { manager, lines } = makeManager()
    const uninterested = (id: string): ChannelConfig =>
      channel({ id, sessionScope: 'filter', sessionFilter: ['other-session'] })
    await manager.start([uninterested('a'), uninterested('b')])

    // sendEach：调用方（宿主）自己已经判断过「没人关心」，空手而归是正常路径
    const sent = await manager.sendEach(() => undefined)
    expect(sent).toEqual([])
    expect(send).not.toHaveBeenCalled()
    expect(lines.filter((line) => line.message.includes(DROPPED))).toEqual([])

    // send()：两台都被会话过滤筛掉了，这条必须报（否则用户以为「已经发出去了」）
    const fallback = await manager.send(notification({ sessionId: 'not-followed' }))
    expect(fallback).toBeUndefined()
    expect(send).not.toHaveBeenCalled()
    expect(lines.filter((line) => line.level === 'warn' && line.message.includes(DROPPED))).toHaveLength(1)
  })

  it('两台机器人都关心：各发一份（不短路），顺序按默认通道优先', async () => {
    stubStart()
    const send = vi.spyOn(QqChannel.prototype, 'send').mockResolvedValue({ messageId: 'm-a' })
    const { manager } = makeManager()
    // 配置顺序是 a, b；默认通道指到 b → 发送顺序应该是 b, a
    await manager.start([channel({ id: 'a' }), channel({ id: 'b' })], 'b')

    const asked: string[] = []
    const results = await manager.sendEach((channelId) => {
      asked.push(channelId)
      return notification()
    })

    expect(asked).toEqual(['b', 'a'])
    expect(results.map((result) => result.channelId)).toEqual(['b', 'a'])
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('不关心的那台被跳过，关心的那台照发', async () => {
    stubStart()
    const send = vi.spyOn(QqChannel.prototype, 'send').mockResolvedValue({ messageId: 'm-a' })
    const { manager } = makeManager()
    await manager.start([channel({ id: 'a' }), channel({ id: 'b' })], 'b')

    const asked: string[] = []
    const results = await manager.sendEach((channelId) => {
      asked.push(channelId)
      return channelId === 'b' ? undefined : notification()
    })

    expect(asked).toEqual(['b', 'a'])
    expect(results.map((result) => result.channelId)).toEqual(['a'])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('一台发不出去不影响另一台：各自记 status，错误只报自己的', async () => {
    stubStart()
    const send = vi.spyOn(QqChannel.prototype, 'send').mockImplementation(function (this: QqChannel) {
      return this.id === 'b' ? Promise.reject(new Error('平台拒收')) : Promise.resolve({ messageId: 'ok-a' })
    })
    const { manager, lines } = makeManager()
    await manager.start([channel({ id: 'a' }), channel({ id: 'b' })], 'b')

    const results = await manager.sendEach(() => notification())

    expect(send).toHaveBeenCalledTimes(2) // b 失败也照样轮到 a
    expect(results.map((result) => result.channelId)).toEqual(['a'])
    expect(results[0]?.messageId).toBe('ok-a')

    const byId = new Map(manager.statuses.map((status) => [status.id, status]))
    expect(byId.get('b')?.failed).toBe(1)
    expect(byId.get('b')?.sent).toBe(0)
    expect(byId.get('b')?.lastError).toBe('平台拒收')
    expect(byId.get('a')?.sent).toBe(1)
    expect(byId.get('a')?.failed).toBe(0)
    expect(byId.get('a')?.connected).toBe(true)
    expect(byId.get('a')?.lastError).toBeUndefined()
    expect(lines.some((line) => line.level === 'error' && line.message.includes('通道「b」发送失败'))).toBe(true)
  })

  it('candidates() 默认通道优先，且不含被禁用的通道', async () => {
    stubStart()
    const { manager } = makeManager()
    await manager.start(
      [channel({ id: 'a' }), channel({ id: 'off', enabled: false }), channel({ id: 'b' })],
      'b',
    )

    // 被禁用的通道压根没进通道表（只有一条 enabled:false 的 status）
    expect(manager.candidates().map((config) => config.id)).toEqual(['b', 'a'])
    expect(manager.statuses.map((status) => status.id)).toEqual(['a', 'off', 'b'])
    expect(manager.statuses.find((status) => status.id === 'off')?.connected).toBe(false)
  })

  it('start() 抛错的通道仍留在 candidates() 里（与「只含已启动的通道」的注释不符）', async () => {
    // 源码在 `await channel.start()` **之前**就把通道塞进了通道表，失败时只写
    // lastError、不删条目 → 「已启动的通道」这个说法对启动失败的通道不成立：
    // 它照样会被 send()/sendEach() 试到（然后每发一条报一次错）。
    // 钉住现状，顺便说明真要去掉它得在 catch 里 `#channels.delete(config.id)`。
    vi.spyOn(QqChannel.prototype, 'start').mockRejectedValue(new Error('缺少 appId / appSecret'))
    const { manager } = makeManager()
    await manager.start([channel({ id: 'a' })])

    expect(manager.statuses[0]?.connected).toBe(false)
    expect(manager.statuses[0]?.lastError).toContain('缺少 appId')
    expect(manager.candidates().map((config) => config.id)).toEqual(['a'])
  })

  it('stop() 之后通道与状态一起清空，candidates() 为空', async () => {
    stubStart()
    const stop = vi.spyOn(QqChannel.prototype, 'stop').mockResolvedValue(undefined)
    const { manager } = makeManager()
    await manager.start([channel({ id: 'a' })])
    expect(manager.candidates()).toHaveLength(1)

    await manager.stop()
    expect(manager.candidates()).toEqual([])
    expect(manager.statuses).toEqual([])
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

/**
 * QQ 原生 Markdown 开关（`channels[].markdown`）。
 *
 * 缺省是**纯文本**：`msg_type: 2` 的卡片宽度由 QQ 客户端写死（桌面端实测约
 * 600px，普通文本气泡约 850px），在电脑上看着像「只有手机宽」。这条链路要保证
 * 「没配 = false」「配了就原样回显」「不碰它就别动它」三件事。
 */
describe('QQ 原生 Markdown 开关', () => {
  it('没配 markdown 时，脱敏视图回 false（界面默认关）', () => {
    const base = configWith(channel())
    expect(redactChannel(base.channels[0] as ChannelConfig, base).markdown).toBe(false)
  })

  it('补丁能打开，并原样回显', () => {
    const base = configWith(channel())
    const patched = patchChannel(base, { id: 'qq-main', markdown: true })
    expect(patched.markdown).toBe(true)
    const view = redactChannel(patched, { ...base, channels: [patched] })
    expect(view.markdown).toBe(true)
  })

  it('补丁里没带这个字段时保持原值（别的字段照样改）', () => {
    const base = configWith(channel({ markdown: true }))
    const patched = patchChannel(base, { id: 'qq-main', label: '主机器人' })
    expect(patched.markdown).toBe(true)
    expect(patched.label).toBe('主机器人')
  })

  it('非布尔值被拒', () => {
    const base = configWith(channel())
    const result = applyPatch(base, { channels: [{ id: 'qq-main', markdown: 'yes' }] })
    expect(result.ok).toBe(false)
  })
})
