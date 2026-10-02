// packages/tlnotify/tests/mode.spec.ts
//
// 每台机器人各自的会话范围 + IM 命令解析。命令解析的边界很重要：IM 里没有
// 「命令模式」，误判的代价是把用户的话吃掉。
//
// 「投递按不按会话过滤」已经不在这个模块了：全局模式开关被删掉，改由每台机器人
// 自己的 `sessionScope` 决定（见 tests/channel-settings.spec.ts 与 index.ts 的
// `#canPush()`）。这里只留 detail 名单与遗留字段的兼容读写。

import { describe, expect, it } from 'vitest'
import { ModeState, describeChannelScope, helpText, isDetailRequest, parseCommand } from '../src/mode.js'

describe('parseCommand', () => {
  it('`/mode`、`mode`、`模式` 都显示当前模式', () => {
    expect(parseCommand('/mode')).toEqual({ kind: 'show' })
    expect(parseCommand('mode')).toEqual({ kind: 'show' })
    expect(parseCommand('模式')).toEqual({ kind: 'show' })
    expect(parseCommand('  /mode?  ')).toEqual({ kind: 'show' })
  })

  it('`/mode global` 与几个别名都切全局', () => {
    for (const text of ['/mode global', 'mode all', '/mode 全局']) {
      expect(parseCommand(text)).toEqual({ kind: 'set-global' })
    }
  })

  it('`/mode session <短id>` 带短 id；不带时返回不带 shortId 的命令', () => {
    expect(parseCommand('/mode session 519cc141')).toEqual({ kind: 'set-session', shortId: '519cc141' })
    expect(parseCommand('/mode single 519cc141')).toEqual({ kind: 'set-session', shortId: '519cc141' })
    expect(parseCommand('/mode session')).toEqual({ kind: 'set-session' })
    expect(parseCommand('/mode 单会话')).toEqual({ kind: 'set-session' })
  })

  it('`/mode <短id>` 是常见笔误，按绑定解释', () => {
    expect(parseCommand('/mode 519cc141')).toEqual({ kind: 'set-session', shortId: '519cc141' })
    expect(parseCommand('/mode session-519cc141')).toEqual({ kind: 'set-session', shortId: 'session-519cc141' })
  })

  it('`/mode` 后面跟不认识的词时给帮助而不是乱猜', () => {
    expect(parseCommand('/mode 随便什么')).toEqual({ kind: 'help' })
  })

  it('detail / undetail 及其别名', () => {
    expect(parseCommand('detail')).toEqual({ kind: 'detail', on: true })
    expect(parseCommand('/详细')).toEqual({ kind: 'detail', on: true })
    expect(parseCommand('undetail')).toEqual({ kind: 'detail', on: false })
    expect(parseCommand('/brief')).toEqual({ kind: 'detail', on: false })
    expect(parseCommand('精简')).toEqual({ kind: 'detail', on: false })
  })

  it('stop 与中文别名', () => {
    expect(parseCommand('/stop')).toEqual({ kind: 'stop' })
    expect(parseCommand('中止')).toEqual({ kind: 'stop' })
    expect(parseCommand('停止')).toEqual({ kind: 'stop' })
  })

  it('help 与 `?`', () => {
    expect(parseCommand('/help')).toEqual({ kind: 'help' })
    expect(parseCommand('?')).toEqual({ kind: 'help' })
    expect(parseCommand('帮助')).toEqual({ kind: 'help' })
  })

  it('普通正文绝不当作命令（只认整条消息就是命令的情况）', () => {
    expect(parseCommand('顺便说下 detail')).toBeUndefined()
    expect(parseCommand('这个方案 help 一下')).toBeUndefined()
    expect(parseCommand('请 stop 那个任务')).toBeUndefined()
    expect(parseCommand('继续')).toBeUndefined()
    expect(parseCommand('')).toBeUndefined()
    expect(parseCommand('   ')).toBeUndefined()
  })

  it('isDetailRequest 只对「升级」为真', () => {
    expect(isDetailRequest('detail')).toBe(true)
    expect(isDetailRequest('/详细')).toBe(true)
    expect(isDetailRequest('undetail')).toBe(false)
    expect(isDetailRequest('继续')).toBe(false)
  })
})

describe('ModeState', () => {
  it('isDetailed 只看 detail 集合，不再跟遗留的全局模式挂钩', () => {
    // 老配置里可能是 mode='session' + targetSessionId：投递已经不看它了，
    // 「单会话带上下文」改由收件那台机器人自己的 sessionScope 决定。
    const legacy = new ModeState({ mode: 'session', targetSessionId: 's1' })
    expect(legacy.isDetailed('s1')).toBe(false)
    legacy.setDetailed('s1', true)
    expect(legacy.isDetailed('s1')).toBe(true)
  })

  it('遗留的 mode / targetSessionId 照样读得到、写得回（只为兼容老配置）', () => {
    const state = new ModeState({ mode: 'global' })
    expect(state.mode).toBe('global')
    expect(state.targetSessionId).toBeUndefined()
    state.setMode('session', 's1')
    expect(state.mode).toBe('session')
    expect(state.targetSessionId).toBe('s1')
    state.setMode('global')
    expect(state.targetSessionId).toBeUndefined()
  })

  it('detail 集合可增可删，重复设置返回 false', () => {
    const state = new ModeState({ mode: 'global' })
    expect(state.setDetailed('s1', true)).toBe(true)
    expect(state.setDetailed('s1', true)).toBe(false)
    expect(state.isDetailed('s1')).toBe(true)
    expect(state.setDetailed('s1', false)).toBe(true)
    expect(state.isDetailed('s1')).toBe(false)
    expect(state.setDetailed('s1', false)).toBe(false)
  })

  it('构造时可恢复 detail 名单，snapshot 能完整往返', () => {
    const state = new ModeState({ mode: 'session', targetSessionId: 's1', detailSessions: ['s2', 's3'] })
    expect(state.detailSessions).toEqual(['s2', 's3'])
    const snapshot = state.snapshot()
    expect(snapshot).toEqual({ mode: 'session', targetSessionId: 's1', detailSessions: ['s2', 's3'] })
    expect(new ModeState(snapshot).snapshot()).toEqual(snapshot)
  })

  it('snapshot 在未绑定时不带 targetSessionId 字段', () => {
    expect(new ModeState({ mode: 'global' }).snapshot()).toEqual({ mode: 'global', detailSessions: [] })
  })
})

describe('describeChannelScope（只讲发命令的那台机器人）', () => {
  it('关心全部：一句话说清，并列出全部命令', () => {
    const text = describeChannelScope('all')
    expect(text).toContain('关心全部会话')
    for (const token of ['/mode global', '/mode session', 'detail', '/undetail', '/stop']) {
      expect(text).toContain(token)
    }
  })

  it('只关心一个且已绑定：回显绑定的会话', () => {
    const text = describeChannelScope('single', { sessionId: 's1', labelOf: () => 'proj · aabbccdd' })
    expect(text).toContain('proj · aabbccdd')
  })

  it('只关心一个但还没选：给操作指引，并说明谁都推不到', () => {
    const text = describeChannelScope('single')
    expect(text).toContain('还没选')
    expect(text).toContain('/mode session')
  })

  it('只关心名单：报出勾了几个；名单为空时明说等于不推', () => {
    expect(describeChannelScope('filter', { filterCount: 3 })).toContain('3 个会话')
    expect(describeChannelScope('filter', { filterCount: 0 })).toContain('空的')
  })

  it('helpText 覆盖全部命令，并写明只影响发命令的那台机器人', () => {
    const text = helpText()
    for (const token of ['/mode', '/mode global', '/mode session', 'detail', '/undetail', '/stop']) {
      expect(text).toContain(token)
    }
    expect(text).toContain('发命令的这台机器人')
  })
})
