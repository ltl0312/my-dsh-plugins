// packages/tlnotify/tests/mode.spec.ts
//
// 运行模式与 IM 命令解析。命令解析的边界很重要：IM 里没有「命令模式」，
// 误判的代价是把用户的话吃掉。

import { describe, expect, it } from 'vitest'
import { ModeState, describeMode, helpText, isDetailRequest, parseCommand } from '../src/mode.js'

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
  it('全局模式下所有会话都推，且默认都不详细', () => {
    const state = new ModeState({ mode: 'global' })
    expect(state.shouldPush('s1')).toBe(true)
    expect(state.shouldPush('s2')).toBe(true)
    expect(state.isDetailed('s1')).toBe(false)
  })

  it('单会话模式只推绑定的那一个，且它天然是详细的', () => {
    const state = new ModeState({ mode: 'session', targetSessionId: 's1' })
    expect(state.shouldPush('s1')).toBe(true)
    expect(state.shouldPush('s2')).toBe(false)
    expect(state.isDetailed('s1')).toBe(true)
    expect(state.isDetailed('s2')).toBe(false)
  })

  it('单会话模式未绑定时谁都不推', () => {
    const state = new ModeState({ mode: 'session' })
    expect(state.shouldPush('s1')).toBe(false)
    expect(state.targetSessionId).toBeUndefined()
  })

  it('setMode 同时更新模式与绑定目标（不传目标即清空绑定）', () => {
    const state = new ModeState({ mode: 'global' })
    state.setMode('session', 's1')
    expect(state.mode).toBe('session')
    expect(state.targetSessionId).toBe('s1')
    state.setMode('global')
    expect(state.targetSessionId).toBeUndefined()
    expect(state.shouldPush('s1')).toBe(true)
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

describe('回显文案', () => {
  it('describeMode 报出全局模式与详细名单', () => {
    const text = describeMode({ mode: 'global', detailSessions: ['session-519cc141-x'] }, () => 'proj · 519cc141')
    expect(text).toContain('全局模式')
    expect(text).toContain('proj · 519cc141')
  })

  it('describeMode 在单会话未绑定时给出操作指引', () => {
    const text = describeMode({ mode: 'session', detailSessions: [] })
    expect(text).toContain('未绑定')
    expect(text).toContain('/mode session')
  })

  it('describeMode 能回显绑定目标', () => {
    const text = describeMode({ mode: 'session', targetSessionId: 's1', detailSessions: [] }, () => 'proj · aabbccdd')
    expect(text).toContain('proj · aabbccdd')
    expect(text).not.toContain('未绑定')
  })

  it('helpText 覆盖全部命令', () => {
    const text = helpText()
    for (const token of ['/mode', '/mode global', '/mode session', 'detail', '/undetail', '/stop']) {
      expect(text).toContain(token)
    }
  })
})
