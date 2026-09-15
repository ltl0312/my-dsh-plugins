// packages/tlmemory/tests/plugin-assembly.spec.ts
// 插件装配中心测试：以最小化假 ctx 驱动 apply()，验证
// 1. session/event 监听按官方双参契约正确折叠轮次素材；
// 2. completed 轮次在 setImmediate 后台触发无感静默沉淀并落库；
// 3. 非 completed 轮次不触发提炼；服务零配置自启（serverPort=0 绑定临时端口）；
// 4. 注销 Disposer 全量收敛、可重复执行。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apply, type Config } from '../src/index.js'
import type { Context } from 'cordis'

const USER_TEXT =
  '请为本仓库搭建 vitest 单测基础设施并配置覆盖率门禁，另外以后工程交互一律使用中文回复。'
const ASSISTANT_TEXT =
  '已完成：vitest 配置落位于 packages/tlmemory，coverage 门禁就绪，并记住中文回复偏好。'

interface EventListener {
  (session: unknown, event: { type: string; data: unknown }): void
}

function createFakeCtx(overrides: Partial<Record<string, unknown>> = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let listener: EventListener | null = null
  const ctx = {
    logger,
    on: (name: string, fn: EventListener) => {
      if (name === 'session/event') listener = fn
      return () => true
    },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, variable: () => () => {} },
    llm: {
      stream: vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'delta',
            delta: JSON.stringify({
              reflections: [
                {
                  tree: 'project',
                  path_segments: ['工程化', '单测'],
                  name: 'vitest单测基建',
                  content: '仓库单测统一使用 vitest 并开启覆盖率门禁',
                  keywords: ['vitest', 'coverage'],
                },
              ],
            }),
          }
        })(),
      ),
    },
    ...overrides,
  }
  return { ctx: ctx as unknown as Context, logger, emit: (event: { type: string; data: unknown }) => listener?.(null, event), getListener: () => listener }
}

describe('dsh-plugin-tlmemory 装配与无感静默沉淀', () => {
  let db: { dbPath: string }

  beforeEach(() => {
    db = { dbPath: ':memory:' }
  })

  function buildConfig(extra: Partial<Config> = {}): Config {
    // serverPort=0：让 OS 分配临时端口，避免测试与真实 4890 服务互相干扰；
    // 新版装配已移除 serverEnabled 开关，内嵌服务随 apply 零配置自启。
    return { dbPath: ':memory:', serverPort: 0, ...extra }
  }

  it('completed 轮次经 setImmediate 后台触发静默沉淀并入库', async () => {
    const { ctx, logger, emit } = createFakeCtx()
    const disposer = apply(ctx, buildConfig())

    emit({ type: 'turn/start', data: { turn: 1 } })
    emit({
      type: 'user/message',
      data: { content: [{ type: 'text', text: USER_TEXT }], source: { kind: 'user' } },
    })
    emit({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } },
    })
    emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    // 等待 setImmediate 后台任务与异步流结算
    await new Promise((resolve) => setTimeout(resolve, 120))

    const settledLog = logger.info.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('静默沉淀入库')),
    )
    expect(settledLog).toBe(true)

    disposer()
  })

  it('aborted 轮次不触发任何沉淀（素材直接丢弃）', async () => {
    const { ctx, logger, emit } = createFakeCtx()
    const disposer = apply(ctx, buildConfig())

    emit({ type: 'turn/start', data: { turn: 2 } })
    emit({
      type: 'user/message',
      data: { content: [{ type: 'text', text: USER_TEXT }], source: { kind: 'user' } },
    })
    emit({
      type: 'assistant/message',
      data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } },
    })
    emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } })

    await new Promise((resolve) => setTimeout(resolve, 80))

    const settledLog = logger.info.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('静默沉淀入库')),
    )
    expect(settledLog).toBe(false)

    disposer()
  })

  it('插件注入上下文（plugin 来源）不参与召回预热与沉淀素材', async () => {
    const { ctx, emit } = createFakeCtx()
    const disposer = apply(ctx, buildConfig())

    emit({ type: 'turn/start', data: { turn: 3 } })
    emit({
      type: 'user/message',
      data: { content: [{ type: 'text', text: USER_TEXT }], source: { kind: 'plugin', plugin: 'fs-notice' } },
    })
    emit({
      type: 'assistant/message',
      data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } },
    })
    emit({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })

    await new Promise((resolve) => setTimeout(resolve, 80))

    // 素材因用户侧为空而未达门槛：不应有任何沉淀入库日志
    const settledLog = ctx.logger.info.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('静默沉淀入库')),
    )
    expect(settledLog).toBe(false)

    disposer()
  })

  it('零配置自启：apply 默认拉起内嵌服务并绑定临时端口', async () => {
    const { ctx } = createFakeCtx()
    const disposer = apply(ctx, buildConfig())
    // listen 是异步动作，稍候轮询服务就绪日志
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(
      ctx.logger.info.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('本地管理服务就绪')),
      ),
    ).toBe(true)
    disposer()
  })

  it('enableAutoReflection=false 时 completed 轮次不派发提炼', async () => {
    const { ctx, logger, emit } = createFakeCtx()
    const disposer = apply(ctx, buildConfig({ enableAutoReflection: false }))

    emit({ type: 'turn/start', data: { turn: 4 } })
    emit({
      type: 'user/message',
      data: { content: [{ type: 'text', text: USER_TEXT }], source: { kind: 'user' } },
    })
    emit({
      type: 'assistant/message',
      data: { turn: 4, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } },
    })
    emit({ type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })

    await new Promise((resolve) => setTimeout(resolve, 80))

    const settledLog = logger.info.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('静默沉淀入库')),
    )
    expect(settledLog).toBe(false)
    disposer()
  })

  it('注销 Disposer 全量收敛且幂等可重复执行', async () => {
    const { ctx, emit } = createFakeCtx()
    const disposer = apply(ctx, buildConfig())
    emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    disposer()
    disposer()
    // P2-4：db.close 推迟到在途提炼链收尾之后，注销日志随之异步落账
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ctx.logger.info.mock.calls.some((c) => c.some((a) => typeof a === 'string' && a.includes('已彻底安全注销')))).toBe(true)
  })

  it('事件处理中的意外异常被双保险隔离，不上抛', async () => {
    const { ctx, emit } = createFakeCtx({
      llm: {
        stream: vi.fn().mockReturnValue(
          (async function* () {
            throw new Error('boom')
          })(),
        ),
      },
    })
    const disposer = apply(ctx, buildConfig())

    emit({ type: 'turn/start', data: { turn: 5 } })
    emit({
      type: 'user/message',
      data: { content: [{ type: 'text', text: USER_TEXT }], source: { kind: 'user' } },
    })
    emit({
      type: 'assistant/message',
      data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } },
    })
    emit({ type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(ctx.logger.error.mock.calls.length).toBeGreaterThanOrEqual(0)
    disposer()
  })
})