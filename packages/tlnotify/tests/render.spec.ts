// packages/tlnotify/tests/render.spec.ts
//
// 渲染决定了「手机上第一眼看到什么」。标题是固定的三段式，任何模式都不变；
// 正文才随模式变。按钮的数量与顺序也有硬上限。

import { describe, expect, it } from 'vitest'
import { DEFAULT_SHARD_CHARS, MAX_ACTION_BUTTONS, renderNotification, renderTitle, shardNotification } from '../src/render.js'
import type { GlobalModeConfig, RawEvent, SessionModeConfig, TurnSnapshot } from '../src/types.js'

const S = 'session-519cc141-4fdd-4ba7-82d1-441b071ab878'

const sessionConfig: SessionModeConfig = {
  context: {
    includeAssistant: true,
    includeTools: true,
    includeTiming: true,
    previousTurns: 3,
    includeUserPrompt: true,
  },
}

const globalConfig: GlobalModeConfig = {
  verbosity: 'brief',
  includeSessionLabel: true,
  includeSummaryLine: true,
  includeSubagent: false,
}

const content = { includeMetadata: true, includeUserPrompt: true, maxBodyChars: 1500 }

function options(overrides: Partial<Parameters<typeof renderNotification>[2]> = {}) {
  return {
    mode: 'global' as const,
    content,
    session: sessionConfig,
    global: globalConfig,
    ...overrides,
  }
}

function event(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    kind: 'completed',
    sessionId: S,
    seq: 7,
    time: 1_700_000_000_000,
    detail: { project: 'DSH' },
    ...overrides,
  }
}

function snapshot(overrides: Partial<TurnSnapshot> = {}): TurnSnapshot {
  return {
    turn: 3,
    startedAt: 1000,
    endedAt: 6000,
    durationMs: 5000,
    assistantText: '改完了 3 个文件。',
    tools: [],
    errors: [],
    ...overrides,
  }
}

describe('renderTitle', () => {
  it('固定三段式：DSH · 项目 · 短id · 事件', () => {
    expect(renderTitle('DSH', '519cc141', 'approval')).toBe('DSH · DSH · 519cc141 · 权限请求')
    expect(renderTitle('my-dsh-plugins', 'aabbccdd', 'completed')).toBe('DSH · my-dsh-plugins · aabbccdd · 任务完成')
  })

  it('九类事件都有中文标签', () => {
    const labels = (['completed', 'error', 'blocked', 'aborted', 'max-tokens', 'interrupted', 'question', 'approval', 'plan'] as const)
      .map((kind) => renderTitle('p', 'sid', kind))
    for (const title of labels) {
      expect(title.startsWith('DSH · p · sid · ')).toBe(true)
      expect(title.endsWith('· ')).toBe(false)
    }
  })

  it('通知标题与模式无关，永远三段式', () => {
    const brief = renderNotification(event(), snapshot(), options())
    const detailed = renderNotification(event(), snapshot(), options({ mode: 'session' }))
    expect(brief.title).toBe('DSH · DSH · 519cc141 · 任务完成')
    expect(detailed.title).toBe(brief.title)
  })

  it('会话 id 去掉 session- 前缀并取前 8 位', () => {
    expect(renderNotification(event(), undefined, options()).title).toContain('· 519cc141 ·')
  })
})

describe('全局精简正文', () => {
  it('完成事件压成一行，带耗时与结果', () => {
    const notification = renderNotification(event(), snapshot(), options())
    expect(notification.body).toBe('耗时 5.0s — 改完了 3 个文件。')
    expect(notification.kind).toBe('completed')
    expect(notification.level).toBe('info')
  })

  it('多行助手正文被折叠成一行', () => {
    const notification = renderNotification(event(), snapshot({ assistantText: '第一行\n\n第二行  第三行' }), options())
    expect(notification.body).toBe('耗时 5.0s — 第一行 第二行 第三行')
  })

  it('没有快照时退回「已完成」而不是空正文', () => {
    expect(renderNotification(event(), undefined, options()).body).toBe('已完成')
  })

  it('出错事件优先展示错误文本', () => {
    const notification = renderNotification(
      event({ kind: 'error', detail: { project: 'DSH', text: '连接超时' } }),
      snapshot(),
      options(),
    )
    expect(notification.body).toBe('耗时 5.0s — 连接超时')
    expect(notification.level).toBe('error')
  })

  it('出错但没给错误文本时退到失败的工具', () => {
    const notification = renderNotification(
      event({ kind: 'error', detail: { project: 'DSH' } }),
      snapshot({
        assistantText: '',
        tools: [{ name: 'bash', callId: 'c1', arguments: '', ok: false, error: 'exit 1' }],
      }),
      options(),
    )
    expect(notification.body).toContain('bash: exit 1')
  })

  it('中止事件即使没有正文也给一句说明', () => {
    const notification = renderNotification(event({ kind: 'aborted' }), undefined, options())
    expect(notification.body).toBe('已被中止')
  })

  it('max-tokens 事件给出可执行的下一步', () => {
    const notification = renderNotification(event({ kind: 'max-tokens' }), undefined, options())
    expect(notification.body).toContain('继续')
  })

  it('计划事件提示等待确认', () => {
    const notification = renderNotification(event({ kind: 'plan' }), undefined, options())
    expect(notification.body).toContain('等待你确认这份计划')
    expect(notification.body).toContain('回复「批准」或「不批准」即可。')
  })

  it('includeMetadata 关掉后不显示耗时', () => {
    const notification = renderNotification(
      event(),
      snapshot(),
      options({ content: { ...content, includeMetadata: false } }),
    )
    expect(notification.body).toBe('改完了 3 个文件。')
  })

  it('正文超过 maxBodyChars 时截断并加省略号', () => {
    const notification = renderNotification(
      event(),
      snapshot({ assistantText: 'x'.repeat(500) }),
      options({ content: { ...content, maxBodyChars: 100 } }),
    )
    expect(notification.body).toHaveLength(100)
    expect(notification.body.endsWith('…')).toBe(true)
  })
})

describe('提问与审批正文', () => {
  it('精简模式下列出选项标签', () => {
    const notification = renderNotification(
      event({
        kind: 'question',
        detail: {
          project: 'DSH',
          text: '要选哪个方案？',
          requestId: 'call-1',
          options: [{ label: '方案甲' }, { label: '方案乙' }],
        },
      }),
      undefined,
      options(),
    )
    expect(notification.body).toContain('要选哪个方案？')
    expect(notification.body).toContain('可选：方案甲 / 方案乙')
    // 按钮在 QQ 桌面端 / 老版本上不渲染，正文里这句提示才是可用的作答入口。
    expect(notification.body).toContain('回复序号或选项文字即可作答。')
  })

  it('多选时加标注，并说明多个答案怎么隔开', () => {
    const notification = renderNotification(
      event({ kind: 'question', detail: { project: 'DSH', text: '选几个', multiSelect: true } }),
      undefined,
      options(),
    )
    expect(notification.body).toContain('（可多选）')
    expect(notification.body).toContain('多个用空格隔开')
  })

  it('详细模式下选项带编号与描述', () => {
    const notification = renderNotification(
      event({
        kind: 'question',
        detail: {
          project: 'DSH',
          text: '要选哪个？',
          requestId: 'call-1',
          options: [{ label: '甲', description: '最快' }, { label: '乙' }],
        },
      }),
      undefined,
      options({ mode: 'session' }),
    )
    expect(notification.body).toContain('1. 甲 —— 最快')
    expect(notification.body).toContain('2. 乙')
  })

  it('审批正文点名工具与原因', () => {
    const notification = renderNotification(
      event({ kind: 'approval', detail: { project: 'DSH', requestId: 'req-1', toolName: 'Bash', text: '要执行 rm' } }),
      undefined,
      options(),
    )
    expect(notification.body).toContain('工具 `Bash`')
    expect(notification.body).toContain('原因：要执行 rm')
    expect(notification.body).toContain('回复「允许」或「拒绝」即可。')
  })

  it('没有工具名时退到「一个工具」', () => {
    const notification = renderNotification(
      event({ kind: 'approval', detail: { project: 'DSH', requestId: 'req-1' } }),
      undefined,
      options(),
    )
    expect(notification.body).toContain('一个工具')
  })

  it('计划正文在详细模式下展开并截断', () => {
    const notification = renderNotification(
      event({ kind: 'plan', detail: { project: 'DSH', requestId: 'req-1', plan: 'y'.repeat(3000) } }),
      undefined,
      options({ mode: 'session', content: { ...content, maxBodyChars: 500 } }),
    )
    expect(notification.body).toContain('等待你确认这份计划：')
    expect(notification.body).toContain('回复「批准」或「不批准」即可。')
    expect(notification.body.length).toBeLessThanOrEqual(500)
  })
})

describe('按钮', () => {
  it('审批给「允许 / 拒绝」，外加打开会话与详细模式', () => {
    const notification = renderNotification(
      event({ kind: 'approval', detail: { project: 'DSH', requestId: 'req-1', toolName: 'Bash' } }),
      undefined,
      options(),
    )
    expect(notification.actions.map((a) => a.label)).toEqual(['允许', '拒绝', '打开会话', '详细模式'])
    expect(notification.actions[0]!.value).toMatchObject({
      v: 1,
      kind: 'approval',
      sessionId: S,
      requestId: 'req-1',
      choice: 'allow',
    })
    expect(notification.actions[1]!.value.choice).toBe('reject')
    expect(notification.actions[1]!.tone).toBe('danger')
  })

  it('审批没有 requestId 时不给审批按钮（点了也结算不了）', () => {
    const notification = renderNotification(
      event({ kind: 'approval', detail: { project: 'DSH', toolName: 'Bash' } }),
      undefined,
      options(),
    )
    expect(notification.actions.map((a) => a.label)).toEqual(['打开会话', '详细模式'])
  })

  it('提问为每个选项生成一个按钮，带下标', () => {
    const notification = renderNotification(
      event({
        kind: 'question',
        detail: { project: 'DSH', requestId: 'call-1', options: [{ label: '甲' }, { label: '乙' }] },
      }),
      undefined,
      options(),
    )
    expect(notification.actions.slice(0, 2).map((a) => a.label)).toEqual(['甲', '乙'])
    expect(notification.actions[0]!.value).toMatchObject({ kind: 'question', requestId: 'call-1', choice: '甲', optionIndex: 0 })
    expect(notification.actions[1]!.value.optionIndex).toBe(1)
  })

  it('选项超过 6 个时只保留 6 个按钮，且不再追加其它按钮', () => {
    const options_ = Array.from({ length: 8 }, (_, i) => ({ label: `选项${i + 1}` }))
    const notification = renderNotification(
      event({ kind: 'question', detail: { project: 'DSH', requestId: 'call-1', options: options_ } }),
      undefined,
      options(),
    )
    expect(notification.actions).toHaveLength(MAX_ACTION_BUTTONS)
    expect(notification.actions.map((a) => a.label)).not.toContain('打开会话')
  })

  it('计划确认给「批准计划 / 不批准」', () => {
    const notification = renderNotification(
      event({ kind: 'plan', detail: { project: 'DSH', requestId: 'req-9' } }),
      undefined,
      options(),
    )
    expect(notification.actions.slice(0, 2).map((a) => a.label)).toEqual(['批准计划', '不批准'])
    expect(notification.actions[0]!.value.choice).toBe('approve')
    expect(notification.actions[1]!.value.choice).toBe('reject')
  })

  it('普通事件只给「打开会话」与「详细模式」', () => {
    const notification = renderNotification(event(), snapshot(), options())
    expect(notification.actions.map((a) => a.label)).toEqual(['打开会话', '详细模式'])
    expect(notification.actions[0]!.value.kind).toBe('goto')
    expect(notification.actions[1]!.value.kind).toBe('detail')
  })

  it('单会话模式下不再给「详细模式」按钮（本来就详细）', () => {
    const notification = renderNotification(event(), snapshot(), options({ mode: 'session' }))
    expect(notification.actions.map((a) => a.label)).toEqual(['打开会话'])
  })

  it('已经升级过详情的会话不再给「详细模式」按钮', () => {
    const notification = renderNotification(event(), snapshot(), options({ detailed: true }))
    expect(notification.actions.map((a) => a.label)).toEqual(['打开会话'])
  })

  it('每个按钮的 value 都能直接喂给 RouteTable.fromAction', () => {
    const notification = renderNotification(
      event({ kind: 'approval', detail: { project: 'DSH', requestId: 'req-1', toolName: 'Bash' } }),
      undefined,
      options(),
    )
    for (const item of notification.actions) {
      expect(item.value.v).toBe(1)
      expect(item.value.sessionId).toBe(S)
    }
  })
})

describe('单会话详细正文', () => {
  it('展开正文、工具摘要、耗时与「你刚才问」', () => {
    const notification = renderNotification(
      event(),
      snapshot({
        assistantText: '第一段\n第二段',
        userPrompt: '帮我改一下',
        tools: [
          { name: 'read', callId: 'c1', arguments: '', ok: true },
          { name: 'read', callId: 'c2', arguments: '', ok: true },
        ],
      }),
      options({ mode: 'session' }),
    )
    expect(notification.body).toContain('第一段\n第二段')
    expect(notification.body).toContain('工具：read ×2')
    expect(notification.body).toContain('耗时 5.0s')
    expect(notification.body).toContain('你刚才问：帮我改一下')
  })

  it('附上最近 N 轮的用户提问', () => {
    const previous: TurnSnapshot[] = [
      snapshot({ turn: 1, userPrompt: '第一轮的提问' }),
      snapshot({ turn: 2, userPrompt: '第二轮的提问' }),
    ]
    const notification = renderNotification(event(), snapshot(), options({ mode: 'session', previousTurns: previous }))
    expect(notification.body).toContain('最近 2 轮：')
    expect(notification.body).toContain('· 第一轮的提问')
    expect(notification.body).toContain('· 第二轮的提问')
  })

  it('前一轮没有提问时标注「(无提问)」', () => {
    const notification = renderNotification(
      event(),
      snapshot(),
      options({ mode: 'session', previousTurns: [snapshot({ turn: 1 })] }),
    )
    expect(notification.body).toContain('(无提问)')
  })

  it('includeTools 关掉后不显示工具摘要', () => {
    const notification = renderNotification(
      event(),
      snapshot({ tools: [{ name: 'read', callId: 'c1', arguments: '', ok: true }] }),
      options({
        mode: 'session',
        session: { context: { ...sessionConfig.context, includeTools: false } },
      }),
    )
    expect(notification.body).not.toContain('工具：')
  })

  it('详细模式下列出失败的工具', () => {
    const notification = renderNotification(
      event({ kind: 'error', detail: { project: 'DSH' } }),
      snapshot({ tools: [{ name: 'bash', callId: 'c1', arguments: '', ok: false, error: 'exit 1' }] }),
      options({ mode: 'session' }),
    )
    expect(notification.body).toContain('失败的工具：')
    expect(notification.body).toContain('· bash: exit 1')
  })
})

describe('tag 与去重键', () => {
  it('tag 是 `<会话id>:<事件>:<seq>`，同一条事件稳定可复现', () => {
    const first = renderNotification(event(), snapshot(), options())
    const second = renderNotification(event(), snapshot(), options())
    expect(first.tag).toBe(`${S}:completed:7`)
    expect(second.tag).toBe(first.tag)
  })
})

describe('shardNotification', () => {
  it('正文不超限时原样返回', () => {
    const notification = renderNotification(event(), snapshot(), options())
    const shards = shardNotification(notification)
    expect(shards).toHaveLength(1)
    expect(shards[0]).toBe(notification)
  })

  it('刚好等于上限也不分片', () => {
    const notification = { ...renderNotification(event(), snapshot(), options()), body: 'x'.repeat(1200) }
    expect(shardNotification(notification, 1200)).toHaveLength(1)
  })

  it('超限时按上限切分，且只切正文不切标题', () => {
    const notification = { ...renderNotification(event(), snapshot(), options()), body: 'x'.repeat(1000) }
    const shards = shardNotification(notification, 200)
    expect(shards).toHaveLength(5)
    for (const shard of shards) {
      expect(shard.title).toBe(notification.title)
      expect(shard.body).toContain('x'.repeat(50))
    }
  })

  it('按钮只在第一片，后续片不带按钮', () => {
    const notification = renderNotification(
      event({ kind: 'approval', detail: { project: 'DSH', requestId: 'req-1', toolName: 'Bash' } }),
      undefined,
      options(),
    )
    const long = { ...notification, body: 'x'.repeat(1000) }
    const shards = shardNotification(long, 200)
    expect(shards.length).toBeGreaterThan(1)
    expect(shards[0]!.actions.length).toBe(notification.actions.length)
    for (const shard of shards.slice(1)) expect(shard.actions).toHaveLength(0)
  })

  it('每片都标注 (i/N)，后续片的 tag 带后缀以免被当成重复消息', () => {
    const notification = { ...renderNotification(event(), snapshot(), options()), body: 'x'.repeat(1000) }
    const shards = shardNotification(notification, 200)
    const total = shards.length
    shards.forEach((shard, index) => {
      expect(shard.body).toContain(`(${index + 1}/${total})`)
    })
    expect(shards[0]!.tag).toBe(notification.tag)
    expect(shards[1]!.tag).toBe(`${notification.tag}#2`)
  })

  it('优先在换行处断开', () => {
    const notification = {
      ...renderNotification(event(), snapshot(), options()),
      body: `${'a'.repeat(150)}\n${'b'.repeat(150)}`,
    }
    const shards = shardNotification(notification, 200)
    expect(shards).toHaveLength(2)
    expect(shards[0]!.body.startsWith('a'.repeat(150))).toBe(true)
    expect(shards[1]!.body.startsWith('b')).toBe(true)
  })

  it('分片数有硬上限，剩下的内容折叠成一句说明', () => {
    const notification = { ...renderNotification(event(), snapshot(), options()), body: 'x'.repeat(5000) }
    const shards = shardNotification(notification, 200)
    expect(shards.length).toBeGreaterThan(12)
    expect(shards[shards.length - 1]!.body).toContain('后续内容已省略')
  })

  it('limit 有下限，避免被配置成 1 个字符而炸出上万条消息', () => {
    const notification = { ...renderNotification(event(), snapshot(), options()), body: 'x'.repeat(1000) }
    const shards = shardNotification(notification, 1)
    expect(shards.length).toBeLessThan(20)
  })

  it('默认上限是 1200', () => {
    expect(DEFAULT_SHARD_CHARS).toBe(1200)
  })
})
