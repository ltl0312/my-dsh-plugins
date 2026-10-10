/**
 * 三层合并的**显式性判据**：宿主传进来的配置里，只有与内置默认值不同的叶子才算
 * 「用户写过」。
 *
 * 这一组锁的是一次线上事故（用户 m04327）：在插件设置页把「正文上限（字符）」设成
 * 4000，下次打开 DSH 又变回 1800，而且 `config.json` 里也真的只剩 1800——不是显示
 * 问题，是**设置被写盘覆盖掉了**。
 *
 * 根因在平台层，不在插件自己的逻辑里：宿主装载插件前会跑一遍本插件的 `Config`
 * schema，cordis 的 `resolveConfig()`（`cordis/lib/index.mjs:156-165`）就一句
 * `config = schema(config)`，schemastery 把**没写的字段**逐个填成默认值。于是
 * `apply()` 拿到的对象里 `content.maxBodyChars` 恒为 1800，插件原来那句
 * `if (explicit && Object.keys(explicit).length > 0)` 就把这份「全是默认值」的对象
 * 当成了用户意图 → 文件里的 4000 在 `mergeConfig()` 里输给 1800，紧接着
 * `persistEffectiveConfig()` 又把 1800 写回文件，数据就此丢失。
 *
 * 所以这里的第一个用例**特意用真的 `Config` schema** 造出宿主会传的那个对象：往
 * schema 里塞 `{}` 与宿主装载时的行为等价。任何「靠 key 存在与否判断显式性」的写法
 * 都会在这个用例上失败。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Config,
  defaultConfig,
  mergeConfig,
  normalizeConfig,
  persistEffectiveConfig,
  readConfigFile,
} from '../src/config.js'
import type { ChannelConfig, TlnotifyConfig } from '../src/types.js'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tlnotify-config-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 宿主实际传给 `apply()` 的东西：schema 已经把缺失字段填成默认值。 */
function hostConfig(patch: Record<string, unknown> = {}): TlnotifyConfig {
  return Config(patch as Partial<TlnotifyConfig>) as TlnotifyConfig
}

function channel(id: string): ChannelConfig {
  return { id, type: 'qq', enabled: true }
}

describe('宿主补满默认值的配置', () => {
  it('schemastery 会把没写的字段填满（这就是判据必须看值的原因）', () => {
    const fromHost = hostConfig()
    // 用户一个字段都没写，宿主给的对象却「每个键都在」。
    expect(Object.keys(fromHost).length).toBeGreaterThan(0)
    expect(fromHost.content.maxBodyChars).toBe(1800)
    expect(fromHost.enabled).toBe(true)
    expect(fromHost.logLevel).toBe('info')
  })

  it('文件里的值不被默认值冲掉（现场：设置页设了 4000，重启后变回 1800）', () => {
    const merged = mergeConfig(hostConfig(), { content: { maxBodyChars: 4000 } })
    expect(merged.content.maxBodyChars).toBe(4000)
    // 文件没提到的字段照旧走内置默认值。
    expect(merged.content.includeMetadata).toBe(true)
  })

  it('默认值不冲掉文件里的**部分**字段：同层的其他键仍然来自文件', () => {
    const merged = mergeConfig(hostConfig(), {
      content: { includeMetadata: false, maxBodyChars: 4000 },
    })
    expect(merged.content).toEqual({
      includeMetadata: false,
      includeUserPrompt: false,
      maxBodyChars: 4000,
    })
  })

  it('用户确实写过的值（与默认值不同）仍然盖过文件', () => {
    const merged = mergeConfig(hostConfig({ content: { maxBodyChars: 9000 } }), {
      content: { maxBodyChars: 4000 },
    })
    expect(merged.content.maxBodyChars).toBe(9000)
  })

  it('用户写了「恰好等于默认值」时按没写处理（解析后的配置里无法分辨）', () => {
    // 这是这套判据的已知代价，写进用例是为了让它**可见**、而不是被当成 bug 反复改。
    const merged = mergeConfig(hostConfig({ content: { maxBodyChars: 1800 } }), {
      content: { maxBodyChars: 4000 },
    })
    expect(merged.content.maxBodyChars).toBe(4000)
  })

  it('通道表：默认空数组不冲掉文件里的通道，非空数组整体替换', () => {
    const file = { channels: [channel('from-file')] }
    expect(mergeConfig(hostConfig(), file).channels.map((item) => item.id)).toEqual(['from-file'])
    // 非空即整体替换（逐项合并会长出「半截配置」）；通道内部被 schema 补出来的默认值
    // 一并在内，所以只比 id。
    expect(
      mergeConfig(hostConfig({ channels: [channel('from-patch')] }), file).channels.map((item) => item.id),
    ).toEqual(['from-patch'])
  })

  it('默认值里没有的键按「写过」处理，原样带过来', () => {
    const merged = mergeConfig(hostConfig({ futureKnob: 42 } as unknown as Partial<TlnotifyConfig>), {})
    expect((merged as unknown as Record<string, unknown>).futureKnob).toBe(42)
  })

  it('「省略即空串」的字段也不会被空默认值冲掉（默认通道 / dataDir / 遗留 targetSessionId）', () => {
    const merged = mergeConfig(hostConfig(), {
      defaultChannelId: 'qq-1',
      dataDir: 'D:/tlnotify-data',
      session: { context: defaultConfig().session.context, targetSessionId: 'session-abc' },
    })
    expect(merged.defaultChannelId).toBe('qq-1')
    expect(merged.dataDir).toBe('D:/tlnotify-data')
    expect(merged.session.targetSessionId).toBe('session-abc')
  })

  it('内置默认面必须覆盖宿主 schema 会补出来的每一个键', () => {
    // 这是 `writtenOnly()` 成立的前提。将来给 Config schema 加了字段却忘了在
    // `defaultConfig()` 里给默认值，这条用例会当场失败——否则那个字段会被静默地
    // 「永远是显式」，重启即回默认值。
    const defaults = defaultConfig() as unknown as Record<string, unknown>
    const fromHost = hostConfig() as unknown as Record<string, unknown>
    for (const key of Object.keys(fromHost)) expect(Object.keys(defaults)).toContain(key)
    for (const key of Object.keys(fromHost.session as Record<string, unknown>)) {
      expect(Object.keys(defaults.session as Record<string, unknown>)).toContain(key)
    }
    for (const key of Object.keys(fromHost.content as Record<string, unknown>)) {
      expect(Object.keys(defaults.content as Record<string, unknown>)).toContain(key)
    }
    for (const key of Object.keys(fromHost.events as Record<string, unknown>)) {
      expect(Object.keys(defaults.events as Record<string, unknown>)).toContain(key)
    }
    for (const key of Object.keys(fromHost.routing as Record<string, unknown>)) {
      expect(Object.keys(defaults.routing as Record<string, unknown>)).toContain(key)
    }
    for (const key of Object.keys(fromHost.global as Record<string, unknown>)) {
      expect(Object.keys(defaults.global as Record<string, unknown>)).toContain(key)
    }
  })

  it('文件整体缺失时仍然是完整配置', () => {
    expect(mergeConfig(hostConfig(), undefined)).toEqual(defaultConfig())
    expect(mergeConfig(undefined, undefined)).toEqual(defaultConfig())
  })

  it('normalizeConfig 也一样：传进去的默认值不改变结果', () => {
    expect(normalizeConfig(hostConfig())).toEqual(defaultConfig())
    expect(normalizeConfig({ content: { maxBodyChars: 4000 } }).content.maxBodyChars).toBe(4000)
  })
})

describe('启动时回写 config.json', () => {
  it('不把文件里的设置改写成默认值（这就是「重启就丢」的那一步）', () => {
    const dataDir = tempDir()
    const effective = mergeConfig(hostConfig(), { content: { maxBodyChars: 4000 } })

    const written = persistEffectiveConfig(dataDir, effective, hostConfig())

    expect(written.content.maxBodyChars).toBe(4000)
    expect(readConfigFile(dataDir)?.content?.maxBodyChars).toBe(4000)
    expect(readFileSync(join(dataDir, 'config.json'), 'utf8')).toContain('"maxBodyChars": 4000')
  })

  it('用户写过的字段照旧以用户为准，并落到文件里', () => {
    const dataDir = tempDir()
    const host = hostConfig({ content: { maxBodyChars: 9000 } })
    const effective = mergeConfig(host, { content: { maxBodyChars: 4000 } })

    const written = persistEffectiveConfig(dataDir, effective, host)

    expect(written.content.maxBodyChars).toBe(9000)
    expect(readConfigFile(dataDir)?.content?.maxBodyChars).toBe(9000)
  })

  it('文件不存在时把整个有效配置写成快照', () => {
    const dataDir = tempDir()
    const effective = mergeConfig(hostConfig({ channels: [channel('qq-1')] }), undefined)

    const written = persistEffectiveConfig(dataDir, effective, hostConfig({ channels: [channel('qq-1')] }))

    expect(written.channels.map((item) => item.id)).toEqual(['qq-1'])
    expect(readConfigFile(dataDir)?.channels?.map((item) => item.id)).toEqual(['qq-1'])
  })

  it('反复启动是幂等的：第二次回写不会改变文件内容', () => {
    const dataDir = tempDir()
    const host = hostConfig()
    const first = persistEffectiveConfig(dataDir, mergeConfig(host, { content: { maxBodyChars: 4000 } }), host)
    const second = persistEffectiveConfig(dataDir, mergeConfig(host, readConfigFile(dataDir)), host)
    expect(second).toEqual(first)
    expect(readConfigFile(dataDir)?.content?.maxBodyChars).toBe(4000)
  })
})
