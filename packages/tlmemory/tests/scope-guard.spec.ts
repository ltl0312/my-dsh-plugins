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

const USER_TEXT = '请记住：对外 HTTP API 路由统一 kebab-case 命名。'
const ASSISTANT_TEXT = '已记住：对外 HTTP API 路由统一 kebab-case 命名（决定，以后一律遵守）。'

interface EventListener {
  (session: unknown, event: { type: string; data: unknown }): void
}

function createFakeCtx() {
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
})
