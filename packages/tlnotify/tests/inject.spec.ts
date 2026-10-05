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
import type { ActionValue, RawEvent } from '../src/types.js'

interface Harness {
  bridge: InteractionBridge
  pending: RawEvent[]
  ask(request: unknown): Promise<unknown>
  approve(request: unknown): Promise<unknown>
}

/** 装一个只认 `ctx.on` 的假 ctx，把两个 waterfall 钩子记下来手工驱动。 */
function makeHarness(options: { now?: () => number; host?: () => Promise<unknown> } = {}): Harness {
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

  // `next` 默认永不 resolve：宿主自己的 UI 一直不回答，只能靠 IM 这边结算。
  const never = () => new Promise<never>(() => {})
  const host = options.host ?? never
  const call = (name: string, request: unknown): Promise<unknown> => {
    const listener = listeners.get(name)
    if (!listener) throw new Error(`桥没有订阅 ${name}`)
    return Promise.resolve(listener(request, host))
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
    // 自由文本走宿主的 `custom` 字段（GUI 的输入框回传的就是它），不塞进 `selected`——
    // 塞进去模型会以为用户点了一个名字很奇怪的选项。
    await expect(answer).resolves.toEqual({
      answers: [{ id: 'q1', selected: [], custom: '用你自己的判断' }],
    })
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

  it('「自定义回答」那个序号也算「像作答」（否则那句「4」会被当普通发言注进会话）', () => {
    expect(matchAnswer(question, '4')).toBe(true)
    expect(matchAnswer({ kind: 'question', labels: ['甲', '乙'] }, '3')).toBe(true)
    // 多选和 plan 没有这个入口：越界就是越界。
    expect(matchAnswer({ kind: 'question', labels: ['甲', '乙', '丙'], multiSelect: true }, '4')).toBe(false)
    expect(matchAnswer(plan, '4')).toBe(false)
  })

  it('与 settleText 的判读一致：matchAnswer 说命中，有 pending 时就必须能结算', async () => {
    const words = ['1', '2.', '4', '方案甲', '方案乙', '9', '', '我选第一个', '这个计划还行']
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
 * 「N+1. 自定义回答」那条两段式的路（用户 m00524）。
 *
 * 它不是宿主给的选项，所以正文里那一行的序号一定落在候选之外——不特殊处理的话
 * `readOneOption` 会判它越界，然后掉进自由文本兜底，直接把数字「4」当成用户想要的
 * 答案。所以：先回序号 = 进入等待状态（不结算），下一句话原样当答案。
 */
describe('自定义回答（先回序号，再发文本）', () => {
  it('回「4」只进入等待状态，下一句话才是答案', async () => {
    const h = makeHarness()
    const answer = h.ask(questionRequest())
    expect(h.bridge.settleText('sess-1', '4')).toEqual({
      ok: false,
      armed: true,
      reason: '好，把你要自定义的答案发过来（下一条消息就是答案）。',
    })
    expect(h.bridge.pendingCount).toBe(1)

    // 答案原样收下——哪怕它长得像序号（这正是两段式的意义：不再解析）。
    expect(h.bridge.settleText('sess-1', '2')).toEqual({ ok: true, echo: '已按自定义答案「2」作答' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: '2' }] })
    expect(h.bridge.pendingCount).toBe(0)
  })

  it('序号跟着候选数走：两个候选时「3」才是自定义', async () => {
    const h = makeHarness()
    void h.ask(questionRequest({ labels: ['甲', '乙'] }))
    expect(h.bridge.settleText('sess-1', '2')?.echo).toBe('已选择「乙」')

    const other = makeHarness()
    void other.ask(questionRequest({ labels: ['甲', '乙'] }))
    expect(other.bridge.settleText('sess-1', '3')).toMatchObject({ ok: false, armed: true })
    expect(other.bridge.pendingCount).toBe(1)
  })

  it('多选与 plan 都没有这个入口：越界序号既不结算也不进入等待', async () => {
    const multi = makeHarness()
    void multi.ask(questionRequest({ labels: ['甲', '乙'], multiSelect: true }))
    expect(multi.bridge.settleText('sess-1', '3')).toBeUndefined()
    expect(multi.bridge.pendingCount).toBe(1)

    const plan = makeHarness()
    void plan.ask(questionRequest({ plan: true }))
    expect(plan.bridge.settleText('sess-1', '4')).toBeUndefined()
    expect(plan.bridge.pendingCount).toBe(1)
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
 * 按钮那条路：通知里的 `requestId` 由**投递这条通知的生产者路径**决定，而注册 pending 的是
 * waterfall 桥。两条路的 id 可能不是一套——宿主不给 callId 时桥自己合成
 * `question-<n>-<时间戳>`，而日志兜底那条带的是真实 `call_00_…`，现场 05:20:40 那条通知
 * 就是这么发出去的：点按钮回「这个请求已经结束或过期了」。所以结算必须能靠「会话 + 题目 id」
 * 或「同种类唯一一条等待」把 pending 找回来（见 `InteractionBridge#resolvePending`）。
 */
describe('按钮带的 id 和注册的 id 不是一套时', () => {
  const questionButton = (requestId: string, choice: string, questionId?: string): ActionValue => ({
    v: 1,
    kind: 'question',
    sessionId: 'sess-1',
    requestId,
    choice,
    ...(questionId === undefined ? {} : { questionId }),
  })

  it('按「会话 + 题目 id」找回来结算（日志兜底先投递的现场）', async () => {
    const h = makeHarness()
    const answer = h.ask(questionRequest({ callId: 'question-1-1791091239330' }))
    expect(h.bridge.pendingCount).toBe(1)

    expect(h.bridge.settle(questionButton('call_00_hqeXp7iU4Ko93c9gj2vr4685', '方案乙', 'q1'))).toEqual({
      ok: true,
      echo: '已选择「方案乙」',
    })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案乙'] }] })
    expect(h.bridge.pendingCount).toBe(0)
  })

  it('没有题目 id 时退化成「这个会话里唯一一条同种类等待」', async () => {
    const h = makeHarness()
    const answer = h.ask(questionRequest({ callId: 'question-1-1791091239330' }))
    expect(h.bridge.settle(questionButton('call_00_other', '方案甲'))).toEqual({ ok: true, echo: '已选择「方案甲」' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案甲'] }] })
  })

  it('审批也一样：没有题目 id，只能靠唯一性', async () => {
    const h = makeHarness()
    const answer = h.approve(approvalRequest({ callId: 'approval-1-1791091239330' }))
    expect(
      h.bridge.settle({ v: 1, kind: 'approval', sessionId: 'sess-1', requestId: 'call_00_appr', choice: 'allow' }),
    ).toEqual({ ok: true, echo: '已允许' })
    await expect(answer).resolves.toBe('allowed-once')
    expect(h.bridge.pendingCount).toBe(0)
  })

  it('同种类有两条等待时拒绝：不能拿旧按钮去结算新请求', async () => {
    const h = makeHarness()
    void h.ask(questionRequest({ callId: 'question-1-1' }))
    void h.ask(questionRequest({ callId: 'question-2-2' }))
    expect(h.bridge.pendingCount).toBe(2)

    expect(h.bridge.settle(questionButton('call_00_stale', '方案甲'))).toEqual({
      ok: false,
      reason: '这个请求已经结束或过期了',
    })
    expect(h.bridge.pendingCount).toBe(2)
    h.bridge.dispose()
  })

  it('id 对得上时照旧精确匹配', async () => {
    const h = makeHarness()
    const answer = h.ask(questionRequest({ callId: 'req-1' }))
    expect(h.bridge.settle(questionButton('req-1', '方案丙'))).toEqual({ ok: true, echo: '已选择「方案丙」' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案丙'] }] })
  })

  it('两条都不是：照旧说「已经结束或过期了」', () => {
    const h = makeHarness()
    expect(h.bridge.settle(questionButton('call_00_none', '方案甲'))).toEqual({
      ok: false,
      reason: '这个请求已经结束或过期了',
    })
  })

  it('一个 id 都没有的按钮照旧拒绝（载荷坏了）', () => {
    const h = makeHarness()
    expect(h.bridge.settle({ v: 1, kind: 'question', sessionId: 'sess-1' })).toEqual({
      ok: false,
      reason: '这个按钮没有携带请求 id',
    })
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

/** 等赛跑 + finally 都跑完。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 网页上那张卡片为什么必须靠这个 signal 才会消失：宿主的提问 / 授权是当「转发 Remote event」
 * 送到浏览器的，宿主侧 `request.signal` 会被单独抽出来当那条 pending event 的取消信号
 * （`dsh-api-gateway` 的 `projectRemoteEventRequest`），只有它 abort 时浏览器才会收到
 * `cancel` 帧、把卡片释放掉（`dsh-client-ui-user-questions` 的 `reconcile()` 要求
 * `hasWaterfall()` 为假；`dsh-client-ui-approval` 的 `PendingApproval` 只认这个 abort）。
 *
 * 而它就是工具调用自己的 signal——**别人抢答之后永远不会 abort**。于是 QQ 里回一句话把提问
 * 答掉了，网页上的卡片却留在原地，连会话结束都不消失（用户报的「请求回答之后，dsh 界面的
 * 提问框依然在」）。
 *
 * 所以桥在 `proceed()` 之前把 signal 换成自己可控制的复合信号，这次交互一结束就 abort 它。
 */
describe('接管宿主的取消信号：交互结束后卡片才会消失', () => {
  it('QQ 文本结算之后交给宿主的 signal 会 abort，宿主自己的信号不动', async () => {
    const h = makeHarness()
    const host = new AbortController()
    const request = questionRequest({ callId: 'call-1' }) as { signal?: AbortSignal }
    request.signal = host.signal

    void h.ask(request)
    await flush()
    // 换成了复合信号：网关那边会校验 instanceof AbortSignal，所以必须是真信号。
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(request.signal).not.toBe(host.signal)
    expect(request.signal?.aborted).toBe(false)

    expect(h.bridge.settleText('sess-1', '方案甲')?.ok).toBe(true)
    await flush()
    expect(request.signal?.aborted).toBe(true)
    // 不能把宿主自己的信号也 abort 掉：下游还有别人在用它。
    expect(host.signal.aborted).toBe(false)
    h.bridge.dispose()
  })

  it('宿主没给 signal 时也要补一个，否则网关根本拿不到取消信号', async () => {
    const h = makeHarness()
    const request = questionRequest({ callId: 'call-1' }) as { signal?: AbortSignal }
    expect(request.signal).toBeUndefined()

    void h.ask(request)
    await flush()
    expect(request.signal).toBeInstanceOf(AbortSignal)

    expect(h.bridge.settleText('sess-1', '方案乙')?.ok).toBe(true)
    await flush()
    expect(request.signal?.aborted).toBe(true)
    h.bridge.dispose()
  })

  it('宿主自己取消时，复合信号跟着 abort 并带上同一个 reason', async () => {
    const h = makeHarness()
    const host = new AbortController()
    const request = questionRequest({ callId: 'call-1' }) as { signal?: AbortSignal }
    request.signal = host.signal
    void h.ask(request)
    await flush()

    const reason = new Error('宿主取消了这次提问')
    host.abort(reason)
    expect(request.signal?.aborted).toBe(true)
    expect(request.signal?.reason).toBe(reason)
    h.bridge.dispose()
  })

  it('进来时宿主信号已经 abort 的话，补上的信号也立刻是 abort 的', async () => {
    const h = makeHarness()
    const host = new AbortController()
    host.abort(new Error('早就取消了'))
    const request = questionRequest({ callId: 'call-1' }) as { signal?: AbortSignal }
    request.signal = host.signal

    void h.ask(request)
    await flush()
    expect(request.signal?.aborted).toBe(true)
    h.bridge.dispose()
  })

  it('网页先答也要收掉，不然卡片永远挂着', async () => {
    const h = makeHarness({ host: () => Promise.resolve({ answers: [{ id: 'q1', selected: ['方案甲'] }] }) })
    const host = new AbortController()
    const request = questionRequest({ callId: 'call-1' }) as { signal?: AbortSignal }
    request.signal = host.signal

    await h.ask(request)
    await flush()
    expect(request.signal?.aborted).toBe(true)
    h.bridge.dispose()
  })

  it('审批路径同样接管', async () => {
    const h = makeHarness()
    const host = new AbortController()
    const request = approvalRequest({ callId: 'appr-1' }) as { signal?: AbortSignal }
    request.signal = host.signal

    void h.approve(request)
    await flush()
    expect(request.signal?.aborted).toBe(false)

    expect(h.bridge.settleText('sess-1', '允许')?.ok).toBe(true)
    await flush()
    expect(request.signal?.aborted).toBe(true)
    expect(host.signal.aborted).toBe(false)
    h.bridge.dispose()
  })

  it('请求对象被冻住时退化成老行为，不抛异常', async () => {
    const h = makeHarness()
    const request = Object.freeze(questionRequest({ callId: 'call-1' })) as { signal?: AbortSignal }

    void h.ask(request)
    await flush()
    expect(request.signal).toBeUndefined()

    expect(h.bridge.settleText('sess-1', '方案甲')?.ok).toBe(true)
    await flush()
    h.bridge.dispose()
  })
})

/**
 * 同一条等待会从两条路进来：`session/event` 的 `tool/call`（`index.ts#maybePending`，带真实
 * callId）和 `user-questions/request` waterfall（本桥）。两条路算出来的 requestId 可能对不上，
 * 而且谁先谁后不定（现场 08:54:58 / 15:05:20 是 waterfall 先，15:41:38 是兜底先），于是同一个
 * 提问被两条路各发一条「等待我回答」。这里测的是两条路共用的那道闸：`会话 + 题目 id`。
 */
describe('同一条等待只发一次通知：两条生产者路径共用一道闸', () => {
  it('桥发出去的等待事件带着题目 id，兜底那条路也拿得到同一个身份', async () => {
    const h = makeHarness()
    void h.ask(questionRequest())
    await flush()
    expect(h.pending).toHaveLength(1)
    expect(h.pending[0]?.detail.questionId).toBe('q1')
    h.bridge.dispose()
  })

  it('先到的那条记账，后到的那条被拦下来', async () => {
    const h = makeHarness()
    expect(h.bridge.announceQuestion('sess-1', 'q1')).toBe(true)
    expect(h.bridge.announceQuestion('sess-1', 'q1')).toBe(false)
    h.bridge.dispose()
  })

  it('不同题目、不同会话各算一条', async () => {
    const h = makeHarness()
    expect(h.bridge.announceQuestion('sess-1', 'q1')).toBe(true)
    expect(h.bridge.announceQuestion('sess-1', 'q2')).toBe(true)
    expect(h.bridge.announceQuestion('sess-2', 'q1')).toBe(true)
    h.bridge.dispose()
  })

  it('拿不到题目 id 时不认重，退化成老行为（宁可多发也不吞）', async () => {
    const h = makeHarness()
    expect(h.bridge.announceQuestion('sess-1', undefined)).toBe(true)
    expect(h.bridge.announceQuestion('sess-1', undefined)).toBe(true)
    h.bridge.dispose()
  })

  it('提问被结算之后这笔账就抹掉：同一个题目 id 以后还能再问一次', async () => {
    const h = makeHarness()
    const answer = h.ask(questionRequest())
    await flush()
    // 通知那道闸（index.ts#deliver）在这里记一笔。
    expect(h.bridge.announceQuestion('sess-1', 'q1')).toBe(true)
    expect(h.bridge.announceQuestion('sess-1', 'q1')).toBe(false)

    expect(h.bridge.settleText('sess-1', '方案甲')?.ok).toBe(true)
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案甲'] }] })

    // 提问结束了，账也抹掉：同一个题目 id 以后还能再问一次。
    expect(h.bridge.announceQuestion('sess-1', 'q1')).toBe(true)
    h.bridge.dispose()
  })

  it('兜底先记账、waterfall 后到：pending 照旧注册，文字作答仍然能结算', async () => {
    const h = makeHarness()
    // 兜底那条路先认领了这条通知（通知本身由 index.ts 的闸决定发不发）。
    expect(h.bridge.announceQuestion('sess-1', 'q1')).toBe(true)

    const answer = h.ask(questionRequest())
    await flush()
    // 桥照样注册 pending：QQ 里回文字必须还能答掉它。
    expect(h.bridge.pendingCount).toBe(1)
    expect(h.bridge.settleText('sess-1', '方案乙')).toEqual({ ok: true, echo: '已选择「方案乙」' })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['方案乙'] }] })
    h.bridge.dispose()
  })

  it('时间窗过期的账不再拦人', async () => {
    let now = 1_000
    const h = makeHarness({ now: () => now })
    expect(h.bridge.announceQuestion('sess-1', 'q1')).toBe(true)
    expect(h.bridge.announceQuestion('sess-1', 'q1')).toBe(false)

    now += 2 * 60 * 1000 + 1
    expect(h.bridge.announceQuestion('sess-1', 'q1')).toBe(true)
    h.bridge.dispose()
  })

  it('dispose 之后账本清空，不会把下一轮的通知吞掉', async () => {
    const h = makeHarness()
    expect(h.bridge.announceQuestion('sess-1', 'q1')).toBe(true)
    h.bridge.dispose()
    expect(h.bridge.announceQuestion('sess-1', 'q1')).toBe(true)
  })
})

/**
 * 一次请求带多个问题（`questions: [q1, q2, q3]`）。
 *
 * 现场 `session-5bc7441e`：模型一次问了 engine / domain / surface 三个，插件只渲染了第一个，
 * 用户在 QQ 上只能看到第 1 问，宿主只拿到一个答案，模型只好反复重问——任务就卡在那儿。
 */
describe('InteractionBridge 一次请求带多个问题', () => {
  const batch = (options: { callId?: string } = {}): unknown => ({
    agent: { session: { id: 'sess-1', cwd: 'D:\\demo\\proj' } },
    questions: [
      { id: 'engine', question: '谁判定领域？', options: [{ label: '大模型' }, { label: '人工' }] },
      { id: 'domain', question: '领域怎么落盘？', options: [{ label: '移目录' }, { label: '存字段' }] },
      { id: 'surface', question: '入口放哪？', options: [{ label: '/admin' }, { label: '导入后自动' }] },
    ],
    wait: { callId: options.callId ?? 'call_batch' },
  })

  const click = (questionId: string, requestId: string, choice: string): ActionValue => ({
    v: 1,
    kind: 'question',
    sessionId: 'sess-1',
    requestId,
    questionId,
    choice,
  })

  /** 三条通知要走完 `#handleQuestion` 里那几次 await，用一次宏任务把它们排干净。 */
  const drain = flush

  it('每问各发一条通知，id / seq 逐条区分，并标出「第几问 / 共几问」', async () => {
    const h = makeHarness()
    void h.ask(batch())
    await drain()
    expect(h.pending.map((event) => event.detail.questionId)).toEqual(['engine', 'domain', 'surface'])
    expect(h.pending.map((event) => event.detail.requestId)).toEqual(['call_batch', 'call_batch#1', 'call_batch#2'])
    expect(h.pending.map((event) => event.detail.questionIndex)).toEqual([0, 1, 2])
    expect(h.pending.map((event) => event.detail.questionTotal)).toEqual([3, 3, 3])
    // seq 必须互不相同：index.ts 的 Dedupe 按 (sessionId, seq) 认重，共用 seq 会让第 2、3 条
    // 通知被当成重复事件丢掉。
    expect(new Set(h.pending.map((event) => event.seq)).size).toBe(3)
    expect(h.bridge.pendingCount).toBe(3)
    h.bridge.dispose()
  })

  it('答完一问不结账，全部答完才把三条答案一起交给宿主', async () => {
    let tick = 0
    const h = makeHarness({ now: () => (tick += 1) })
    const answer = h.ask(batch())
    await drain()
    expect(h.bridge.settleText('sess-1', '1')).toEqual({ ok: true, echo: '已选择「大模型」' })
    expect(h.bridge.settleText('sess-1', '1')).toEqual({ ok: true, echo: '已选择「移目录」' })

    let settled = false
    void answer.then(() => {
      settled = true
    })
    await drain()
    expect(settled).toBe(false)

    expect(h.bridge.settleText('sess-1', '2')).toEqual({ ok: true, echo: '已选择「导入后自动」' })
    await expect(answer).resolves.toEqual({
      answers: [
        { id: 'engine', selected: ['大模型'] },
        { id: 'domain', selected: ['移目录'] },
        { id: 'surface', selected: ['导入后自动'] },
      ],
    })
    h.bridge.dispose()
  })

  it('文本正好等于某一问的标签时，落到那一问（不必按顺序）', async () => {
    let tick = 0
    const h = makeHarness({ now: () => (tick += 1) })
    void h.ask(batch())
    await drain()
    expect(h.bridge.settleText('sess-1', '存字段')).toEqual({ ok: true, echo: '已选择「存字段」' })
    // 第二问结算掉之后，剩下的按「最早一条」继续走。
    expect(h.bridge.settleText('sess-1', '1')).toEqual({ ok: true, echo: '已选择「大模型」' })
    h.bridge.dispose()
  })

  it('按钮带的 id 与题目不符时，以题目 id 为准', async () => {
    let tick = 0
    const h = makeHarness({ now: () => (tick += 1) })
    const answer = h.ask(batch())
    await drain()
    expect(h.bridge.settle(click('surface', 'call_batch', '导入后自动'))).toEqual({
      ok: true,
      echo: '已选择「导入后自动」',
    })
    expect(h.bridge.settle(click('engine', 'call_batch#0', '人工'))).toEqual({ ok: true, echo: '已选择「人工」' })
    expect(h.bridge.settle(click('domain', 'call_batch#1', '移目录'))).toEqual({ ok: true, echo: '已选择「移目录」' })
    await expect(answer).resolves.toMatchObject({ answers: [{ id: 'engine' }, { id: 'domain' }, { id: 'surface' }] })
    h.bridge.dispose()
  })

  it('整组结算干净：三问都答过之后不再命中，也不留残项', async () => {
    let tick = 0
    const h = makeHarness({ now: () => (tick += 1) })
    void h.ask(batch({ callId: 'call_clean' }))
    await drain()
    expect(h.bridge.settleText('sess-1', '1')?.ok).toBe(true)
    expect(h.bridge.settleText('sess-1', '1')?.ok).toBe(true)
    expect(h.bridge.settleText('sess-1', '2')?.ok).toBe(true)
    expect(h.bridge.settleText('sess-1', '1')).toBeUndefined()
    expect(h.bridge.pendingCount).toBe(0)
    h.bridge.dispose()
  })
})
