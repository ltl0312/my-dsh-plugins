// packages/tlmemory/tests/scope-guard.spec.ts
// v0.6.6 作用域防漂移端到端守门（ZhuanZ 幽灵工程根治）：
// 1. 装配期热归并：白名单外孤儿 scope 的存量记忆被整体迁入合法工作区，
//    原 scope 连根消失（节点 + 登记项），目标工作区登记名可读；
// 2. 会话级作用域防线：会话工作区在白名单内 → 记忆写入该工作区 scope；
//    会话工作区是名单外目录（如用户主目录 C:\Users\ZhuanZ）→ 严禁以此建工程，
//    自动降级写入白名单首位合法工作区；
// 3. 白名单不可读（DSH_HOME 无登记表）时关闭防线，维持旧行为 —— 绝不凭空搬家。
// 注意：apply 装配会真实读 DSH_HOME 下的 workspace.json，本文件全程把该环境变量
// 指向临时 fixture，dbPath 指向临时 SQLite 文件，不触碰真实 ~/.dsh。
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, type Config } from '../src/index.js'
import { MemoryDB } from '../src/db.js'
import { projectScopeOf, resetWorkspaceRegistryCache } from '../src/workspaces.js'
import type { Context } from 'cordis'

const PLUGINS_ROOT = path.normalize('D:/Code/my-dsh-plugins')
const PLUGINS_SCOPE = projectScopeOf(PLUGINS_ROOT)
const ORPHAN_ROOT = path.normalize('C:/Users/ZhuanZ')
const ORPHAN_SCOPE = projectScopeOf(ORPHAN_ROOT)
const TOOLBOX_ROOT = path.normalize('D:/Code/Rust/TLToolBox')
const TOOLBOX_SCOPE = projectScopeOf(TOOLBOX_ROOT)

const USER_TEXT = '请记住：对外 HTTP API 路由统一 kebab-case 命名。'
const ASSISTANT_TEXT = '已记住：对外 HTTP API 路由统一 kebab-case 命名（决定，以后一律遵守）。'

interface EventListener {
  (session: unknown, event: { type: string; data: unknown }): void
}

function createFakeCtx() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let listener: EventListener | null = null
  const tools: Array<{ name: string; execute: (args: unknown, exec?: unknown) => Promise<unknown> }> = []
  const ctx = {
    logger,
    on: (name: string, fn: EventListener) => {
      if (name === 'session/event') listener = fn
      return () => true
    },
    tools: {
      register: (definition: { name: string; execute: (args: unknown, exec?: unknown) => Promise<unknown> }) => {
        tools.push(definition)
        return () => {}
      },
    },
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
                  path_segments: ['工程化', 'API规范'],
                  name: 'kebab-case命名',
                  content: '对外 HTTP API 路由统一 kebab-case 命名',
                  keywords: ['api', 'kebab-case'],
                },
              ],
            }),
          }
        })(),
      ),
    },
  }
  return {
    ctx: ctx as unknown as Context,
    logger,
    tools,
    /** 与真实宿主一致：session/event 监听器第一参携带会话对象 */
    emit: (session: unknown, event: { type: string; data: unknown }) => listener?.(session, event),
  }
}

/** 在临时目录写一份只含 my-dsh-plugins 工作区的宿主登记表 */
function writeFixtureDshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-scope-guard-'))
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['ws-1'] },
      tables: {
        workspaces: {
          'ws-1': { path: PLUGINS_ROOT, title: 'my-dsh-plugins', sessionIds: [], createdAt: '', updatedAt: '' },
        },
      },
    }),
    'utf8',
  )
  return home
}

describe('tlmemory 作用域防漂移（装配端到端）', () => {
  const tempDirs: string[] = []
  const dbFiles: string[] = []
  let savedDshHome: string | undefined
  let savedWorkspaceDir: string | undefined

  afterEach(() => {
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    if (savedWorkspaceDir === undefined) delete process.env.DSH_WORKSPACE_DIR
    else process.env.DSH_WORKSPACE_DIR = savedWorkspaceDir
    resetWorkspaceRegistryCache()
    for (const file of dbFiles.splice(0)) {
      try {
        fs.rmSync(file, { force: true })
        fs.rmSync(`${file}-wal`, { force: true })
        fs.rmSync(`${file}-shm`, { force: true })
      } catch {
        // 临时文件清理失败不影响断言
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // 临时目录清理失败不影响断言
      }
    }
  })

  function setupDshHome(): void {
    savedDshHome = process.env.DSH_HOME
    savedWorkspaceDir = process.env.DSH_WORKSPACE_DIR
    const home = writeFixtureDshHome()
    tempDirs.push(home)
    process.env.DSH_HOME = home
    delete process.env.DSH_WORKSPACE_DIR
    resetWorkspaceRegistryCache()
  }

  function tempDbPath(): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-scope-db-')), 'tlmemory.db')
    tempDirs.push(path.dirname(file))
    dbFiles.push(file)
    return file
  }

  it('装配期把孤儿 scope 的存量记忆归并进白名单工作区，原 scope 连根消失', () => {
    setupDshHome()
    const dbPath = tempDbPath()
    // 预置存量脏数据：宿主曾以用户主目录启动，误建 ZhuanZ 工程并误存记忆
    const seeded = new MemoryDB(dbPath)
    seeded.registerProject(ORPHAN_SCOPE, 'ZhuanZ', ORPHAN_ROOT)
    seeded.upsertLeaf(ORPHAN_SCOPE, ['安全红线', '前端XSS'], '富文本禁v-html', '前端渲染富文本严禁使用 v-html', ['xss'])
    seeded.registerProject(PLUGINS_SCOPE, 'my-dsh-plugins', PLUGINS_ROOT)
    seeded.close()

    const { ctx, logger } = createFakeCtx()
    const config: Config = { dbPath, serverPort: 0, enableAutoReflection: false }
    const disposer = apply(ctx, config)
    disposer()

    // 归并落库核验（重开同一文件）
    const db = new MemoryDB(dbPath)
    expect(db.countNodes(ORPHAN_SCOPE)).toBe(0)
    expect(db.hasProject(ORPHAN_SCOPE)).toBe(false)
    expect(
      db.getNodesByScope(PLUGINS_SCOPE).some((n) => n.is_leaf === 1 && n.name === '富文本禁v-html'),
    ).toBe(true)
    db.close()
    // 归并有日志佐证
    expect(
      logger.warn.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('孤儿工程记忆已归并')),
      ),
    ).toBe(true)
  })

  it('会话工作区在白名单内：沉淀落库该工作区 scope', async () => {
    setupDshHome()
    const dbPath = tempDbPath()
    const { ctx, logger, emit } = createFakeCtx()
    const disposer = apply(ctx, { dbPath, serverPort: 0 })

    emit({ workspaceDir: PLUGINS_ROOT }, { type: 'turn/start', data: { turn: 1 } })
    emit(
      { workspaceDir: PLUGINS_ROOT },
      { type: 'user/message', data: { content: [{ type: 'text', text: USER_TEXT }], source: { kind: 'user' } } },
    )
    emit(
      { workspaceDir: PLUGINS_ROOT },
      {
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } },
      },
    )
    emit({ workspaceDir: PLUGINS_ROOT }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    await new Promise((resolve) => setTimeout(resolve, 150))
    disposer()

    const db = new MemoryDB(dbPath)
    expect(
      db.getNodesByScope(PLUGINS_SCOPE).some((n) => n.is_leaf === 1 && n.name === 'kebab-case命名'),
    ).toBe(true)
    expect(db.countNodes(ORPHAN_SCOPE)).toBe(0)
    db.close()
    expect(
      logger.info.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('静默沉淀入库')),
      ),
    ).toBe(true)
  })

  it('会话工作区是名单外目录：严禁建幽灵工程，记忆降级写入白名单首位合法工作区', async () => {
    setupDshHome()
    const dbPath = tempDbPath()
    const { ctx, logger, emit } = createFakeCtx()
    const disposer = apply(ctx, { dbPath, serverPort: 0 })

    // 会话游离在用户主目录（ZhuanZ 场景）：workspaceDir 指向名单外目录
    emit({ workspaceDir: ORPHAN_ROOT }, { type: 'turn/start', data: { turn: 2 } })
    emit(
      { workspaceDir: ORPHAN_ROOT },
      { type: 'user/message', data: { content: [{ type: 'text', text: USER_TEXT }], source: { kind: 'user' } } },
    )
    emit(
      { workspaceDir: ORPHAN_ROOT },
      {
        type: 'assistant/message',
        data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } },
      },
    )
    emit({ workspaceDir: ORPHAN_ROOT }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })

    await new Promise((resolve) => setTimeout(resolve, 150))
    disposer()

    const db = new MemoryDB(dbPath)
    // 记忆写入白名单工作区，孤儿 scope 全程零节点
    expect(
      db.getNodesByScope(PLUGINS_SCOPE).some((n) => n.is_leaf === 1 && n.name === 'kebab-case命名'),
    ).toBe(true)
    expect(db.countNodes(ORPHAN_SCOPE)).toBe(0)
    expect(db.hasProject(ORPHAN_SCOPE)).toBe(false)
    db.close()
    // 防线有降级日志佐证
    expect(
      logger.warn.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('已降级写入合法工作区')),
      ),
    ).toBe(true)
  })

  // ── v0.6.9 会话作用域错账修复（2026-09-18 取证）───────────────────────────
  // 真实宿主的 SessionService 顶层没有 workspaceDir/workspace/cwd/root 任何一键，
  // 会话工作目录收在创建头里（session.header.cwd）。旧实现四键全落空 ⇒ 回退进程身份
  // （宿主 cwd，实测为用户主目录）⇒ 召回只查「主目录 scope + global」永远 0 命中，
  // 且当主目录恰在白名单内时防漂移闸门不触发，错账完全静默。
  // 宿主权威佐证：dsh-workspace 把会话挂到工作区时强制 header.cwd realpath ===
  // workspace.record.path，即 header.cwd 就是工作区根。

  it('真实宿主形态：会话只带 header.cwd（无顶层键）⇒ 沉淀落库该工作区 scope', async () => {
    setupDshHome()
    const dbPath = tempDbPath()
    const { ctx, emit } = createFakeCtx()
    const disposer = apply(ctx, { dbPath, serverPort: 0 })

    const session = { header: { cwd: PLUGINS_ROOT } }
    emit(session, { type: 'turn/start', data: { turn: 3 } })
    emit(
      session,
      { type: 'user/message', data: { content: [{ type: 'text', text: USER_TEXT }], source: { kind: 'user' } } },
    )
    emit(
      session,
      {
        type: 'assistant/message',
        data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } },
      },
    )
    emit(session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })

    await new Promise((resolve) => setTimeout(resolve, 150))
    disposer()

    const db = new MemoryDB(dbPath)
    expect(
      db.getNodesByScope(PLUGINS_SCOPE).some((n) => n.is_leaf === 1 && n.name === 'kebab-case命名'),
    ).toBe(true)
    // 绝不落到主目录伪工程
    expect(db.countNodes(ORPHAN_SCOPE)).toBe(0)
    db.close()
  })

  it('D2：会话携带 requestHeader ⇒ 提炼调用按宿主 llm.stream 契约携带 route/sessionId/purpose', async () => {
    setupDshHome()
    const dbPath = tempDbPath()
    const { ctx, emit } = createFakeCtx()
    const disposer = apply(ctx, { dbPath, serverPort: 0 })

    // 真实宿主形态：SessionService 暴露 id 与 requestHeader()（缓存折叠，含 config.route）。
    // 全部事件复用同一对象 —— 与真实宿主一致（WeakMap 缓存必然命中）。
    const session = {
      id: 'sess-d2',
      header: { cwd: PLUGINS_ROOT },
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'chat-model' } }),
    }
    emit(session, { type: 'turn/start', data: { turn: 7 } })
    emit(
      session,
      { type: 'user/message', data: { content: [{ type: 'text', text: USER_TEXT }], source: { kind: 'user' } } },
    )
    emit(
      session,
      {
        type: 'assistant/message',
        data: { turn: 7, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } },
      },
    )
    emit(session, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })

    await new Promise((resolve) => setTimeout(resolve, 150))
    disposer()

    // llm.stream 必须按宿主契约被调用（route 是必需项，缺了就是空流）
    expect(ctx.llm.stream).toHaveBeenCalledTimes(1)
    const opts = ctx.llm.stream.mock.calls[0][0] as Record<string, unknown>
    expect(opts.provider).toBe('deepseek')
    expect(opts.model).toBe('chat-model')
    expect(opts.sessionId).toBe('sess-d2')
    expect(opts.purpose).toBe('tlmemory-reflection')
    expect(typeof opts.system).toBe('string')
    expect((opts.system as string).length).toBeGreaterThan(0)
    const messages = opts.messages as Array<Record<string, unknown>>
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].source).toEqual({ kind: 'plugin', plugin: 'dsh-plugin-tlmemory' })

    // 且提炼照常落库（route 路径下全链路仍通）
    const db = new MemoryDB(dbPath)
    expect(
      db.getNodesByScope(PLUGINS_SCOPE).some((n) => n.is_leaf === 1 && n.name === 'kebab-case命名'),
    ).toBe(true)
    db.close()
  })

  it('D2 降级：会话无 requestHeader ⇒ 提炼仍按旧契约调用（非 DSH 宿主兼容）', async () => {
    setupDshHome()
    const dbPath = tempDbPath()
    const { ctx, emit } = createFakeCtx()
    const disposer = apply(ctx, { dbPath, serverPort: 0 })

    const session = { workspaceDir: PLUGINS_ROOT }
    emit(session, { type: 'turn/start', data: { turn: 8 } })
    emit(
      session,
      { type: 'user/message', data: { content: [{ type: 'text', text: USER_TEXT }], source: { kind: 'user' } } },
    )
    emit(
      session,
      {
        type: 'assistant/message',
        data: { turn: 8, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } },
      },
    )
    emit(session, { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })

    await new Promise((resolve) => setTimeout(resolve, 150))
    disposer()

    // 旧契约形态：裸 messages + temperature，不带 route
    expect(ctx.llm.stream).toHaveBeenCalledTimes(1)
    const opts = ctx.llm.stream.mock.calls[0][0] as Record<string, unknown>
    expect(opts.provider).toBeUndefined()
    expect(opts.model).toBeUndefined()
    expect(opts.temperature).toBe(0.1)
    const messages = opts.messages as Array<Record<string, unknown>>
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
  })

  it('header.cwd 指向名单外目录：防漂移闸门对新来源同样生效', async () => {
    setupDshHome()
    const dbPath = tempDbPath()
    const { ctx, emit } = createFakeCtx()
    const disposer = apply(ctx, { dbPath, serverPort: 0 })

    const session = { header: { cwd: ORPHAN_ROOT } }
    emit(session, { type: 'turn/start', data: { turn: 4 } })
    emit(
      session,
      { type: 'user/message', data: { content: [{ type: 'text', text: USER_TEXT }], source: { kind: 'user' } } },
    )
    emit(
      session,
      {
        type: 'assistant/message',
        data: { turn: 4, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } },
      },
    )
    emit(session, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })

    await new Promise((resolve) => setTimeout(resolve, 150))
    disposer()

    const db = new MemoryDB(dbPath)
    expect(
      db.getNodesByScope(PLUGINS_SCOPE).some((n) => n.is_leaf === 1 && n.name === 'kebab-case命名'),
    ).toBe(true)
    expect(db.countNodes(ORPHAN_SCOPE)).toBe(0)
    db.close()
  })

  it('会话无任何线索（连 header 都没有）⇒ 回退进程身份，且进程身份非仓库根时有告警', async () => {
    setupDshHome()
    const dbPath = tempDbPath()
    // 把进程 cwd 挪到一个无 .git 的目录，复现「宿主以用户主目录启动」的现场
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-nogit-'))
    tempDirs.push(noGit)
    const savedCwd = process.cwd()
    process.chdir(noGit)
    try {
      const { ctx, logger, emit } = createFakeCtx()
      const disposer = apply(ctx, { dbPath, serverPort: 0 })

      const session = {}
      emit(session, { type: 'turn/start', data: { turn: 5 } })
      emit(
        session,
        { type: 'user/message', data: { content: [{ type: 'text', text: USER_TEXT }], source: { kind: 'user' } } },
      )
      emit(
        session,
        {
          type: 'assistant/message',
          data: { turn: 5, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } },
        },
      )
      emit(session, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })

      await new Promise((resolve) => setTimeout(resolve, 150))
      disposer()

      // 回退进程身份（非仓库、名单外）→ 防漂移降级到白名单首位合法工作区
      const db = new MemoryDB(dbPath)
      expect(
        db.getNodesByScope(PLUGINS_SCOPE).some((n) => n.is_leaf === 1 && n.name === 'kebab-case命名'),
      ).toBe(true)
      db.close()
      // R-S2 可观测性：进程级身份不是仓库根 ⇒ 装配期即告警
      expect(
        logger.warn.mock.calls.some((call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes('不是仓库根')),
        ),
      ).toBe(true)
      // 降级路径日志同样在场
      expect(
        logger.warn.mock.calls.some((call) =>
          call.some((arg) => typeof arg === 'string' && arg.includes('已降级写入合法工作区')),
        ),
      ).toBe(true)
    } finally {
      process.chdir(savedCwd)
    }
  })

  // ── v0.6.9 工具路径作用域（exec.agent.session）────────────────────────────
  // 真实宿主把会话挂在 exec.agent.session 下（dsh-tools:1265 有
  // exec.agent?.session.append(...) 的直接用法）。旧实现只探 exec.session /
  // exec.context.session，全落空 ⇒ tlmemory_save 回退进程身份，记忆写进宿主 cwd
  // 的伪工程（2026-09-18 实证：pnpm 约定落在了 repo:7af7de66d3a0/ZhuanZ）。
  // 判据要有区分度：fixture 放两个工作区，进程身份（cwd 派生）与工具会话身份分属两树。
  it('工具路径：exec 把会话挂在 agent.session 下 ⇒ tlmemory_save 落库正确 scope', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-scope-tools-'))
    tempDirs.push(home)
    fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'storages', 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['ws-1', 'ws-2'] },
        tables: {
          workspaces: {
            'ws-1': { path: PLUGINS_ROOT, title: 'my-dsh-plugins', sessionIds: [], createdAt: '', updatedAt: '' },
            'ws-2': { path: TOOLBOX_ROOT, title: 'TLToolBox', sessionIds: [], createdAt: '', updatedAt: '' },
          },
        },
      }),
      'utf8',
    )
    savedDshHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    delete process.env.DSH_WORKSPACE_DIR
    resetWorkspaceRegistryCache()

    const dbPath = tempDbPath()
    const { ctx, tools } = createFakeCtx()
    const disposer = apply(ctx, { dbPath, serverPort: 0 })

    const save = tools.find((t) => t.name === 'tlmemory_save')
    expect(save, 'tlmemory_save 必须已注册').toBeTruthy()
    await save!.execute(
      {
        tree_scope: 'project',
        path_segments: ['工程化', '包管理'],
        rule_name: 'pnpm唯一包管理器',
        content: '本仓库一律用pnpm管依赖与跑脚本，禁用npm',
        keywords: ['pnpm'],
      },
      // 真实宿主形态：会话在 exec.agent.session 下，且属于 TLToolBox 工作区
      { agent: { session: { header: { cwd: TOOLBOX_ROOT } } } },
    )
    disposer()

    const db = new MemoryDB(dbPath)
    // 记忆必须落进 exec 会话所属的工作区
    expect(
      db.getNodesByScope(TOOLBOX_SCOPE).some((n) => n.is_leaf === 1 && n.name === 'pnpm唯一包管理器'),
    ).toBe(true)
    // 进程身份（cwd 派生的 my-dsh-plugins）不该收到这条
    expect(
      db.getNodesByScope(PLUGINS_SCOPE).some((n) => n.is_leaf === 1 && n.name === 'pnpm唯一包管理器'),
    ).toBe(false)
    db.close()
  })
})
