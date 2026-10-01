// packages/tlnotify/tests/rpc.spec.ts
//
// 设置页与宿主之间那条 RPC 的纯逻辑：脱敏、补丁校验、报错翻译、绑定链接推导。
//
// 这一层值得测的原因是它的失败模式特别安静：
//   * 脱敏漏一个分支 → 密钥被写进日志/回给浏览器，没人会发现；
//   * 补丁校验少一道 → 设置页显示「已保存」，配置其实没变或变成了半截；
//   * 报错翻译认错关键词 → 用户照着错的建议去改平台设置，越改越乱。
// 所以下面基本都在钉「不该通过的必须不通过」。

import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/config.js'
import {
  PATCH_TOP_KEYS,
  applyPatch,
  createBindToken,
  deriveBindLink,
  explainTestFailure,
  feishuBotApplink,
  ok,
  redactChannel,
  redactConfig,
  redactText,
  secretState,
} from '../src/rpc.js'
import type { ChannelConfig, TlnotifyConfig } from '../src/types.js'

function channel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return { id: 'qq-main', type: 'qq', enabled: true, sessionFilter: [], ...overrides }
}

function configWith(...channels: ChannelConfig[]): TlnotifyConfig {
  return { ...defaultConfig(), channels }
}

/** 取出成功结果，失败时把 details 打出来（否则断言失败只看到 undefined）。 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`期望成功，实际：${JSON.stringify(result.error)}`)
  return result.value
}

describe('信封', () => {
  it('ok() 包一层 value', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 })
  })
})

describe('secretState', () => {
  it('空值一律报「未配置」，hint 也是空串', () => {
    expect(secretState(undefined)).toEqual({ configured: false, hint: '' })
    expect(secretState('')).toEqual({ configured: false, hint: '' })
    expect(secretState('   ')).toEqual({ configured: false, hint: '' })
  })

  it('只露末四位，且先 trim', () => {
    expect(secretState('topsecretvalue')).toEqual({ configured: true, hint: '••••alue' })
    expect(secretState('  abcd1234  ')).toEqual({ configured: true, hint: '••••1234' })
  })

  it('短到不足四位就整串露出（否则提示会变成一串点，用户认不出自己配的是哪个）', () => {
    expect(secretState('1234')).toEqual({ configured: true, hint: '••••1234' })
    expect(secretState('ab')).toEqual({ configured: true, hint: '••••ab' })
  })
})

describe('redactText', () => {
  it('抹掉 `secret: xxx` 形态的明文', () => {
    const out = redactText('request failed: app_secret: abcdefghijklmnop qq')
    expect(out).not.toContain('abcdefghijklmnop')
    expect(out).toContain('[redacted]')
  })

  it('抹掉 JSON 片段里的密钥', () => {
    const out = redactText('{"appId":"102000","appSecret":"supersecretvalue"}')
    expect(out).not.toContain('supersecretvalue')
    expect(out).toBe('{"appId":"102000","appSecret":"[redacted]"}')
  })

  it('普通文本原样返回', () => {
    const text = '目标 id 不对：open_id 无效'
    expect(redactText(text)).toBe(text)
  })
})

describe('redactChannel / redactConfig', () => {
  it('永不带出密钥明文，只给 configured + hint', () => {
    const red = redactChannel(channel({ appId: '102000', appSecret: 'topsecretvalue' }))
    expect(red.appSecret).toEqual({ configured: true, hint: '••••alue' })
    expect(JSON.stringify(red)).not.toContain('topsecretvalue')
  })

  it('空字段不出现（少一堆 `targetChatId: ""` 才不会让前端把空串当已配置）', () => {
    const red = redactChannel(channel())
    expect('targetChatId' in red).toBe(false)
    expect('appId' in red).toBe(false)
    expect('bindUrl' in red).toBe(false)
    expect(red.appSecret).toEqual({ configured: false, hint: '' })
  })

  it('把缺省值补齐成协议里声明的必填字段', () => {
    const red = redactChannel(channel())
    expect(red.feishuReceiveIdType).toBe('open_id')
    expect(red.mode).toBe('active')
  })

  it('redactConfig 里 dataDir 是真值，不是密钥', () => {
    const red = redactConfig(configWith(channel({ appSecret: 'topsecretvalue' })), 'C:/tmp/tlnotify')
    expect(red.dataDir).toBe('C:/tmp/tlnotify')
    expect(red.channels).toHaveLength(1)
    expect(JSON.stringify(red)).not.toContain('topsecretvalue')
  })
})

describe('applyPatch 的拒绝路径', () => {
  const base = configWith(channel())

  it('补丁不是对象就拒绝', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      const res = applyPatch(base, bad)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error.details.path).toBe('patch')
    }
  })

  it('未知顶层键直接拒绝，不静默忽略', () => {
    const res = applyPatch(base, { nope: 1 })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('invalid-patch')
      expect(res.error.details.path).toBe('nope')
    }
  })

  it('未知子键同样拒绝', () => {
    expect(applyPatch(base, { events: { onNope: true } }).ok).toBe(false)
    expect(applyPatch(base, { content: { maxChars: 10 } }).ok).toBe(false)
    expect(applyPatch(base, { session: { context: { turns: 3 } } }).ok).toBe(false)
    expect(applyPatch(base, { channels: [{ id: 'x', nope: 1 }] }).ok).toBe(false)
  })

  it('类型不对就拒绝', () => {
    expect(applyPatch(base, { enabled: 'yes' }).ok).toBe(false)
    expect(applyPatch(base, { mode: 'all' }).ok).toBe(false)
    expect(applyPatch(base, { logLevel: 'trace' }).ok).toBe(false)
    expect(applyPatch(base, { events: { onError: 1 } }).ok).toBe(false)
    expect(applyPatch(base, { content: { maxBodyChars: '1800' } }).ok).toBe(false)
  })

  it('数值区间按方案卡死', () => {
    const cases: [unknown, boolean][] = [
      [{ content: { maxBodyChars: 199 } }, false],
      [{ content: { maxBodyChars: 200 } }, true],
      [{ content: { maxBodyChars: 20000 } }, true],
      [{ content: { maxBodyChars: 20001 } }, false],
      [{ content: { maxBodyChars: 1500.5 } }, false],
      [{ routing: { tableTtlDays: 0 } }, false],
      [{ routing: { tableTtlDays: 1 } }, true],
      [{ routing: { tableTtlDays: 365 } }, true],
      [{ routing: { tableTtlDays: 366 } }, false],
      [{ session: { context: { previousTurns: 0 } } }, true],
      [{ session: { context: { previousTurns: 20 } } }, true],
      [{ session: { context: { previousTurns: 21 } } }, false],
    ]
    for (const [patch, expected] of cases) {
      expect(applyPatch(base, patch).ok, JSON.stringify(patch)).toBe(expected)
    }
  })

  it('默认通道必须真实存在', () => {
    const res = applyPatch(base, { defaultChannelId: 'ghost' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.details.path).toBe('defaultChannelId')
    expect(applyPatch(base, { defaultChannelId: 'qq-main' }).ok).toBe(true)
  })
})

describe('applyPatch 的成功路径', () => {
  it('changed 只列出真正动过的顶层字段', () => {
    const base = configWith(channel())
    const out = unwrap(applyPatch(base, { enabled: false, events: { onError: false } }))
    expect(out.changed).toEqual(['enabled', 'events'])
    expect(out.channelsChanged).toBe(false)
    expect(out.restartRequired).toBe(false)
  })

  it('没有实际改动时 changed 为空', () => {
    const out = unwrap(applyPatch(configWith(channel()), {}))
    expect(out.changed).toEqual([])
  })

  it('子对象是浅合并，没提到的兄弟键不会被抹掉', () => {
    const base = configWith(channel())
    const out = unwrap(applyPatch(base, { content: { includeMetadata: false } }))
    expect(out.next.content.includeMetadata).toBe(false)
    expect(out.next.content.maxBodyChars).toBe(base.content.maxBodyChars)
  })

  it('补丁不会改动传进来的那份配置（纯函数）', () => {
    const base = configWith(channel())
    const before = JSON.stringify(base)
    unwrap(applyPatch(base, { channels: [{ id: 'qq-main', enabled: false }] }))
    expect(JSON.stringify(base)).toBe(before)
  })

  it('defaultChannelId 清空走 null', () => {
    const base = { ...configWith(channel()), defaultChannelId: 'qq-main' }
    const out = unwrap(applyPatch(base, { defaultChannelId: null }))
    expect('defaultChannelId' in out.next).toBe(false)
  })
})

describe('applyPatch 的通道表', () => {
  const base = configWith(
    channel({ appId: '102000', targetChatId: 'OPENID', appSecret: 'topsecretvalue' }),
  )

  it('整表替换，但按 id 保留未提及的字段', () => {
    const out = unwrap(applyPatch(base, { channels: [{ id: 'qq-main', enabled: false }] }))
    expect(out.channelsChanged).toBe(true)
    const [next] = out.next.channels
    expect(next.enabled).toBe(false)
    expect(next.appId).toBe('102000')
    expect(next.targetChatId).toBe('OPENID')
    expect(next.appSecret).toBe('topsecretvalue')
  })

  it('密钥三态：省略=保持、空串/null=清空、字符串=写入', () => {
    const omitted = unwrap(applyPatch(base, { channels: [{ id: 'qq-main' }] }))
    expect(omitted.next.channels[0].appSecret).toBe('topsecretvalue')

    for (const clearing of ['', '   ', null]) {
      const out = unwrap(applyPatch(base, { channels: [{ id: 'qq-main', appSecret: clearing }] }))
      expect('appSecret' in out.next.channels[0], JSON.stringify(clearing)).toBe(false)
    }

    const written = unwrap(applyPatch(base, { channels: [{ id: 'qq-main', appSecret: ' brandnew ' }] }))
    expect(written.next.channels[0].appSecret).toBe('brandnew')
  })

  it('新通道有可用的默认值，且 id 不能为空', () => {
    const out = unwrap(applyPatch(base, { channels: [{ id: 'fresh' }] }))
    const fresh = out.next.channels.find((c) => c.id === 'fresh')
    expect(fresh).toMatchObject({ id: 'fresh', type: 'qq', enabled: true })
    expect(applyPatch(base, { channels: [{ id: '   ' }] }).ok).toBe(false)
  })

  it('id 重复要拒绝（否则默认通道指向谁就不确定了）', () => {
    const res = applyPatch(base, { channels: [{ id: 'dup' }, { id: 'dup' }] })
    expect(res.ok).toBe(false)
  })

  it('删掉通道时，指向它的默认通道会被一起拦下', () => {
    const withDefault = { ...base, defaultChannelId: 'qq-main' }
    expect(applyPatch(withDefault, { channels: [{ id: 'other' }] }).ok).toBe(false)
  })

  it('整表替换不会保留已经被删掉的通道', () => {
    const out = unwrap(applyPatch(base, { channels: [{ id: 'fresh' }] }))
    expect(out.next.channels.map((c) => c.id)).toEqual(['fresh'])
  })

  it('顶层白名单与协议一致', () => {
    expect([...PATCH_TOP_KEYS]).toEqual([
      'enabled',
      'mode',
      'defaultChannelId',
      'logLevel',
      'channels',
      'events',
      'content',
      'routing',
      'session',
      'global',
    ])
  })
})

describe('explainTestFailure', () => {
  it('飞书 19024 / 关键词 → 自定义关键词建议', () => {
    for (const raw of ['{"code":19024,"msg":"custom keyword not found"}', '关键词未命中']) {
      expect(explainTestFailure(raw).advice).toContain('自定义关键词')
    }
  })

  it('QQ 主动消息被拒 → 明确指回 QQ 客户端里的用户侧开关', () => {
    const hint = explainTestFailure('{"code":11244,"message":"allow proactive message is off"}')
    expect(hint.advice).toContain('允许主动发送')
    expect(hint.advice).toContain('用户侧')
  })

  it('凭据问题 → 去核对 AppID/AppSecret', () => {
    expect(explainTestFailure('{"code":19001,"msg":"invalid app_id"}').advice).toContain('AppID')
  })

  it('目标 id 问题 → 建议扫码绑定而不是手抄', () => {
    expect(explainTestFailure('receive_id invalid: user not found').advice).toContain('扫码绑定')
  })

  it('网络与长连接各有专门文案', () => {
    expect(explainTestFailure('connect ETIMEDOUT 1.2.3.4:443').advice).toContain('网络')
    expect(explainTestFailure('websocket closed with 1006').advice).toContain('长连接')
  })

  it('不认识的报错给兜底文案，而不是瞎猜', () => {
    const hint = explainTestFailure('something entirely unexpected')
    expect(hint.advice).toContain('未归类')
    expect(hint.raw).toBe('something entirely unexpected')
  })

  it('回给前端的 raw 也要先脱敏', () => {
    const hint = explainTestFailure('{"appSecret":"supersecretvalue"}')
    expect(hint.raw).not.toContain('supersecretvalue')
  })
})

describe('deriveBindLink', () => {
  it('手填的绑定链接优先，且标记为非推导', () => {
    const link = deriveBindLink(channel({ type: 'feishu', feishuAppId: 'cli_x', bindUrl: ' https://example.com/bot ' }))
    expect(link).toEqual({ qrText: 'https://example.com/bot', derived: false })
  })

  it('飞书有 AppID 就能推导出 applink', () => {
    const link = deriveBindLink(channel({ type: 'feishu', feishuAppId: 'cli_abc' }))
    expect(link.derived).toBe(true)
    expect(link.qrText).toBe(feishuBotApplink('cli_abc'))
    expect(link.qrText).toContain('applink.feishu.cn')
  })

  it('飞书没填 AppID → 给说明，不画二维码', () => {
    const link = deriveBindLink(channel({ type: 'feishu' }))
    expect(link.qrText).toBeUndefined()
    expect(link.derived).toBe(false)
    expect(link.missing).toContain('App ID')
  })

  it('QQ 永远推导不出来 → 给说明而不是编一个链接', () => {
    const link = deriveBindLink(channel({ type: 'qq', appId: '102000' }))
    expect(link.qrText).toBeUndefined()
    expect(link.missing).toContain('绑定')
  })
})

describe('createBindToken', () => {
  it('20 位小写字母数字', () => {
    expect(createBindToken()).toMatch(/^[a-z0-9]{20}$/)
  })

  it('注入随机源后结果可复现', () => {
    expect(createBindToken(() => 0)).toBe('a'.repeat(20))
    expect(createBindToken(() => 0.999999)).toBe('9'.repeat(20))
  })
})
