/**
 * InteractionBridge 的**文本作答**路径（`settleText`）。
 *
 * 为什么单独给这个文件：QQ 单聊的按钮在桌面端 / 老版本上不渲染，用户只能回文字。
 * 在那之前文本一律被当成普通发言注入会话，宿主就一直等着——用户 m04327 报的
 * 「QQ 没有弹出选项、我回复文本之后 DSH 仍然需要我选择」就是这个。
 *
 * 这里只测桥（解析与结算），不测 index.ts 的接线：宿主级的「一条事件 → 投递」测试台
 * 还不存在（见 doc/tlnotify-每机器人设置方案.md §7.1 的「仍未覆盖」）。
 */
import { describe, expect, it } from 'vitest'

import { InteractionBridge, matchAnswer, type AnswerTarget } from '../src/inject.js'
import type { RawEvent } from '../src/types.js'

interface Harness {
  bridge: InteractionBridge
  pending: RawEvent[]
  ask(request: unknown): Promise<unknown>
  approve(request: unknown): Promise<unknown>
}

/** 装一个只认 `ctx.on` 的假 ctx，把两个 waterfall 钩子记下来手工驱动。 */
function makeHarness(options: { now?: () => number } = {}): Harness {
  const pending: RawEvent[] = []
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const bridge = new InteractionBridge({
    onPending: (event) => {
      pending.push(event)
    },
    ...(options.now ? { now: options.now } : {}),
  })
  bridge.install({
    on: (name, listener) => {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  })

  // `next` 永不 resolve：宿主自己的 UI 一直不回答，只能靠 IM 这边结算。
  const never = () => new Promise<never>(() => {})
  const call = (name: string, request: unknown): Promise<unknown> => {
    const listener = listeners.get(name)
    if (!listener) throw new Error(`桥没有订阅 ${name}`)
    return Promise.resolve(listener(request, never))
  }

  return {
    bridge,
    pending,
    ask: (request) => call('user-questions/request', request),
    approve: (request) => call('approval/request', request),
  }
}

interface QuestionOptions {
  sessionId?: string
  callId?: string
  labels?: string[]
  multiSelect?: boolean
  plan?: boolean
}

function questionRequest(options: QuestionOptions = {}): unknown {
  return {
    agent: { session: { id: options.sessionId ?? 'sess-1', cwd: 'D:\\demo\\proj' } },
    questions: [
      {
        id: 'q1',
        options: (options.labels ?? ['方案甲', '方案乙', '方案丙']).map((label) => ({ label })),
        ...(options.multiSelect ? { multiSelect: true } : {}),
        ...(options.plan ? { intent: { kind: 'plan-review', approve: '批准' } } : {}),
      },
    ],
    wait: { callId: options.callId ?? 'req-1' },
  }
}

function approvalRequest(options: { sessionId?: string; callId?: string } = {}): unknown {
  return {
    agent: { session: { id: options.sessionId ?? 'sess-1', cwd: 'D:\\demo\\proj' } },
    toolName: 'shell',
    displayReason: { zh: '要执行 rm -rf' },
    callId: options.callId ?? 'appr-1',
  }
}

describe('InteractionBridge 文本作答', () => {
  it('回复序号「1」结算成第一个选项', async () => {
    const h = makeHarness()
    const answer = h.ask(questionRequest())
    expect(h.bridge.pendingCount).toBe(1)

    expect(h.bridge.settleText('sess-1', '1')).toEqual({ ok: true, echo: '已选择「方案甲」' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案甲'] }] })
    expect(h.bridge.pendingCount).toBe(0)
  })

  it('「2.」「3）」这类带标点的序号也认', async () => {
    const h = makeHarness()
    const first = h.ask(questionRequest({ callId: 'req-a' }))
    expect(h.bridge.settleText('sess-1', '2.')).toEqual({ ok: true, echo: '已选择「方案乙」' })
    await expect(first).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案乙'] }] })

    const second = h.ask(questionRequest({ callId: 'req-b' }))
    expect(h.bridge.settleText('sess-1', '3）')).toEqual({ ok: true, echo: '已选择「方案丙」' })
    await expect(second).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案丙'] }] })
  })

  it('回复选项原文（大小写不敏感）也认', async () => {
    const h = makeHarness()
    const answer = h.ask(questionRequest({ labels: ['Alpha', 'Beta'] }))
    expect(h.bridge.settleText('sess-1', 'beta')).toEqual({ ok: true, echo: '已选择「Beta」' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Beta'] }] })
  })

  it('序号越界不结算，也不吃掉这条消息', async () => {
    const h = makeHarness()
    h.ask(questionRequest())
    expect(h.bridge.settleText('sess-1', '9')).toBeUndefined()
    expect(h.bridge.settleText('sess-1', '0')).toBeUndefined()
    expect(h.bridge.pendingCount).toBe(1)
  })

  it('提问接受自由文本：不是序号也不是选项时原样当答案', async () => {
    const h = makeHarness()
    const answer = h.ask(questionRequest())
    expect(h.bridge.settleText('sess-1', '用你自己的判断')).toEqual({
      ok: true,
      echo: '已选择「用你自己的判断」',
    })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['用你自己的判断'] }] })
  })

  it('多选按空格 / 逗号 / 顿号拆成多个选项', async () => {
    const h = makeHarness()
    const answer = h.ask(questionRequest({ multiSelect: true }))
    expect(h.bridge.settleText('sess-1', '1、3')).toEqual({ ok: true, echo: '已选择「方案甲、方案丙」' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案甲', '方案丙'] }] })
  })

  it('计划只认序号和「批准 / 不批准」，随手一句话不批', async () => {
    const h = makeHarness()
    h.ask(questionRequest({ plan: true, labels: ['批准', '不批准'] }))
    expect(h.bridge.settleText('sess-1', '看着还行')).toBeUndefined()
    expect(h.bridge.pendingCount).toBe(1)

    expect(h.bridge.settleText('sess-1', '批准')).toEqual({ ok: true, echo: '已选择「批准」' })
    expect(h.bridge.pendingCount).toBe(0)
  })

  it('审批认「允许 / 拒绝」及其中英文说法', async () => {
    const h = makeHarness()
    const allowed = h.approve(approvalRequest({ callId: 'appr-a' }))
    expect(h.bridge.settleText('sess-1', '允许')).toEqual({ ok: true, echo: '已允许' })
    await expect(allowed).resolves.toBe('allowed-once')

    const rejected = h.approve(approvalRequest({ callId: 'appr-b' }))
    expect(h.bridge.settleText('sess-1', 'Deny')).toEqual({ ok: true, echo: '已拒绝' })
    await expect(rejected).resolves.toBe('rejected')
  })

  it('审批里拿不准的话不结算——宁可少答一次，也不能把用户的话吞成审批结果', async () => {
    const h = makeHarness()
    h.approve(approvalRequest())
    expect(h.bridge.settleText('sess-1', '这个命令干嘛的？')).toBeUndefined()
    expect(h.bridge.settleText('sess-1', '')).toBeUndefined()
    expect(h.bridge.pendingCount).toBe(1)
  })

  it('只结算同一个会话里的等待', async () => {
    const h = makeHarness()
    h.ask(questionRequest({ sessionId: 'sess-1', callId: 'req-1' }))
    const other = h.ask(questionRequest({ sessionId: 'sess-2', callId: 'req-2' }))

    expect(h.bridge.settleText('sess-9', '1')).toBeUndefined()
    expect(h.bridge.pendingCount).toBe(2)

    expect(h.bridge.settleText('sess-2', '1')).toEqual({ ok: true, echo: '已选择「方案甲」' })
    await expect(other).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案甲'] }] })
    expect(h.bridge.pendingCount).toBe(1)
  })

  it('同一个会话里有两条等待时，先结算最新那条', async () => {
    let tick = 1000
    const h = makeHarness({ now: () => (tick += 1) })
    const older = h.ask(questionRequest({ callId: 'req-old' }))
    const newer = h.ask(questionRequest({ callId: 'req-new' }))

    expect(h.bridge.settleText('sess-1', '2')).toEqual({ ok: true, echo: '已选择「方案乙」' })
    await expect(newer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案乙'] }] })

    // 旧的还在等：再回一次「1」才轮到它。
    expect(h.bridge.settleText('sess-1', '1')).toEqual({ ok: true, echo: '已选择「方案甲」' })
    await expect(older).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案甲'] }] })
    expect(h.bridge.pendingCount).toBe(0)
  })

  it('没有等待中的请求时返回 undefined（调用方照常注入会话）', () => {
    const h = makeHarness()
    expect(h.bridge.settleText('sess-1', '1')).toBeUndefined()
    expect(h.bridge.settleText('sess-1', '')).toBeUndefined()
  })

  it('dispose 之后不再有任何等待中的请求', () => {
    const h = makeHarness()
    void h.ask(questionRequest())
    expect(h.bridge.pendingCount).toBe(1)
    h.bridge.dispose()
    expect(h.bridge.pendingCount).toBe(0)
    expect(h.bridge.settleText('sess-1', '1')).toBeUndefined()
  })
})

/**
 * `matchAnswer`：**还没有 pending** 时判「这句话像不像作答」。
 *
 * 它是 `index.ts` 的 `#waiting`（攥住比提问先到的作答）唯一的判据，所以判读规则必须
 * 和 `settleText` 完全一致——最后一条用例就是在钉这一点。
 */
describe('matchAnswer：提问还没就绪时的判读', () => {
  const question: AnswerTarget = { kind: 'question', labels: ['方案甲', '方案乙', '方案丙'] }
  const plan: AnswerTarget = { kind: 'plan', labels: ['批准', '不批准'] }
  const approval: AnswerTarget = { kind: 'approval', labels: [] }

  it('序号与 label 原文都算作答', () => {
    expect(matchAnswer(question, '1')).toBe(true)
    expect(matchAnswer(question, '2.')).toBe(true)
    expect(matchAnswer(question, ' 3）')).toBe(true)
    expect(matchAnswer(question, '方案乙')).toBe(true)
    // label 大小写不敏感
    expect(matchAnswer({ kind: 'question', labels: ['OK'] }, 'ok')).toBe(true)
  })

  it('越界序号、空串、随便一句话都不算', () => {
    expect(matchAnswer(question, '9')).toBe(false)
    expect(matchAnswer(question, '0')).toBe(false)
    expect(matchAnswer(question, '')).toBe(false)
    expect(matchAnswer(question, '   ')).toBe(false)
    expect(matchAnswer(plan, '这个计划我觉得还行吧')).toBe(false)
  })

  it('提问认自由文本（模型能读懂），计划不认', () => {
    expect(matchAnswer(question, '我选第二个吧')).toBe(true)
    expect(matchAnswer(plan, '批准')).toBe(true)
    expect(matchAnswer(plan, '不批准')).toBe(true)
    expect(matchAnswer(plan, '就按你说的办')).toBe(false)
  })

  it('审批只认词表里的说法', () => {
    for (const word of ['允许', '同意', '通过', '批准', '好的', 'Allow', 'YES', 'ok', '1']) {
      expect(matchAnswer(approval, word)).toBe(true)
    }
    for (const word of ['拒绝', '不同意', '驳回', 'Deny', 'no', '2']) {
      expect(matchAnswer(approval, word)).toBe(true)
    }
    expect(matchAnswer(approval, '这条命令是干嘛的？')).toBe(false)
    expect(matchAnswer(approval, '')).toBe(false)
  })

  it('多选要每个 token 都命中', () => {
    const multi: AnswerTarget = { kind: 'question', labels: ['甲', '乙', '丙'], multiSelect: true }
    expect(matchAnswer(multi, '1 3')).toBe(true)
    expect(matchAnswer(multi, '1、3')).toBe(true)
    expect(matchAnswer(multi, '甲,丙')).toBe(true)
    // 有一个 token 越界就不算作答（免得把「1 9」半截当答案）
    expect(matchAnswer(multi, '1 9')).toBe(false)
    expect(matchAnswer(multi, '')).toBe(false)
  })

  it('与 settleText 的判读一致：matchAnswer 说命中，有 pending 时就必须能结算', async () => {
    const words = ['1', '2.', '方案甲', '方案乙', '9', '', '我选第一个', '这个计划还行']
    for (const word of words) {
      const h = makeHarness()
      void h.ask(questionRequest({ callId: 'req-x' }))
      const matched = matchAnswer(question, word)
      const settled = h.bridge.settleText('sess-1', word) !== undefined
      expect(settled, `「${word}」的判读两边必须一致`).toBe(matched)
      h.bridge.dispose()
    }
  })
})

/**
 * 同一个问题被两条 hook 路径各投一次。
 *
 * 现场（plugin.log 08:54:58）：一个问题在 11 毫秒里发了两条一模一样的「等待我回答」，
 * requestId 分别是 `call_00_Sp8u8…` 与合成出来的 `question-1-1791017697940`——`tool/call`
 * 那条带 callId，waterfall 那条不带，于是 `#deliveredRequests` 的按 requestId 去重拦不住。
 * 用户回一句话只会结算其中一条，另一条看上去就是「我回了但它还在等」。
 */
describe('同一个问题被重复投递', () => {
  /** waterfall 那条路：宿主既没给 `wait.callId`，`question[].intent.callId` 也是空的。 */
  function waterfallRequest(): unknown {
    return { ...(questionRequest({}) as Record<string, unknown>), wait: {} }
  }

  it('只发第一条通知，但两条路上来的 pending 都能被结算', async () => {
    const h = makeHarness()
    void h.ask(questionRequest({ callId: 'call_00_sp8u8' }))
    await Promise.resolve()
    expect(h.pending).toHaveLength(1)

    void h.ask(waterfallRequest())
    await Promise.resolve()
    // 通知不再重发……
    expect(h.pending).toHaveLength(1)
    // ……但 pending 照旧注册：哪条路上来的解答都要能算数。
    expect(h.bridge.pendingCount).toBe(2)

    const settled = h.bridge.settleText('sess-1', '方案乙')
    expect(settled?.ok).toBe(true)
    expect(h.bridge.pendingCount).toBe(1)
    h.bridge.dispose()
  })

  it('不是同一个问题（题目 id 不同）照旧两条通知', async () => {
    const h = makeHarness()
    void h.ask(questionRequest({ callId: 'call-a' }))
    await Promise.resolve()
    const second = questionRequest({ callId: 'call-b' }) as {
      questions: { id: string }[]
    }
    second.questions[0]!.id = 'q2'
    void h.ask(second)
    await Promise.resolve()
    expect(h.pending).toHaveLength(2)
    h.bridge.dispose()
  })

  it('上一个问题结算之后，同一个 id 再问一次仍然要发通知', async () => {
    const h = makeHarness()
    void h.ask(questionRequest({ callId: 'call-1' }))
    await Promise.resolve()
    expect(h.pending).toHaveLength(1)
    expect(h.bridge.settleText('sess-1', '方案甲')?.ok).toBe(true)

    void h.ask(questionRequest({ callId: 'call-2' }))
    await Promise.resolve()
    expect(h.pending).toHaveLength(2)
    h.bridge.dispose()
  })
})

/**
 * `hasLivePending` 是给日志兜底路径（`index.ts` 的 `#maybePending`）用的：两条路本该按
 * requestId 去重，但 waterfall 会自己合成 id，对不上，于是同一个提问被发两条通知。兜底路径
 * 改成先问一句「桥是不是已经在等这个会话的这类请求了」，就不再依赖 id 是否对得上。
 */
describe('hasLivePending：桥是不是已经在等这个会话', () => {
  it('没有任何等待时一律 false', () => {
    const h = makeHarness()
    expect(h.bridge.hasLivePending('sess-1', 'question')).toBe(false)
    expect(h.bridge.hasLivePending('sess-1', 'plan')).toBe(false)
    expect(h.bridge.hasLivePending('sess-1', 'approval')).toBe(false)
    h.bridge.dispose()
  })

  it('只认「同一个会话 + 同一种等待」，会话或类型对不上都不算', async () => {
    const h = makeHarness()
    void h.ask(questionRequest({ sessionId: 'sess-1', callId: 'call-1' }))
    await Promise.resolve()

    expect(h.bridge.hasLivePending('sess-1', 'question')).toBe(true)
    // 别的会话：不能替它把通知压掉。
    expect(h.bridge.hasLivePending('sess-2', 'question')).toBe(false)
    // 别的类型：提问不能当成审批。
    expect(h.bridge.hasLivePending('sess-1', 'approval')).toBe(false)
    expect(h.bridge.hasLivePending('sess-1', 'plan')).toBe(false)
    h.bridge.dispose()
  })

  it('计划与审批各自认自己的类型', async () => {
    const h = makeHarness()
    void h.ask(questionRequest({ sessionId: 'sess-1', callId: 'plan-1', plan: true }))
    void h.approve(approvalRequest({ sessionId: 'sess-2', callId: 'appr-1' }))
    await Promise.resolve()

    expect(h.bridge.hasLivePending('sess-1', 'plan')).toBe(true)
    expect(h.bridge.hasLivePending('sess-1', 'question')).toBe(false)
    expect(h.bridge.hasLivePending('sess-2', 'approval')).toBe(true)
    expect(h.bridge.hasLivePending('sess-2', 'question')).toBe(false)
    h.bridge.dispose()
  })

  it('结算之后回到 false，下一个提问不会被误压', async () => {
    const h = makeHarness()
    void h.ask(questionRequest({ sessionId: 'sess-1', callId: 'call-1' }))
    await Promise.resolve()
    expect(h.bridge.hasLivePending('sess-1', 'question')).toBe(true)

    expect(h.bridge.settleText('sess-1', '方案甲')?.ok).toBe(true)
    expect(h.bridge.hasLivePending('sess-1', 'question')).toBe(false)
    h.bridge.dispose()
  })
})
