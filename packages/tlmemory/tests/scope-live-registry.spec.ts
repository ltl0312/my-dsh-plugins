// packages/tlmemory/tests/scope-live-registry.spec.ts
// 缺陷 1 / 2 根因回归：宿主**运行期间**新建的工作区必须立刻对写路径生效。
//
// 现场证据（2026-10-07）：用户在宿主运行中新建了两个中文名工作区
// （D:\Code\DSH工作区\磁盘清理、D:\Code\DSH工作区\炎火云服务器8c8g），此后
// 这两个工作区里的会话沉淀全部落到了白名单首位那个**毫不相干**的工程
// （repo:82252c8a4eb6 / deskcraft，db.registerProject 里 root='' 的降落点签名），
// 真实工作区一条记忆都收不到 ⇒ 被「零记忆即清理」摘出看板清单。
// 根因：index.ts 在装配期把 `loadWorkspaceRegistry()` 的结果缓存进闭包，此后所有
// 写路径判定都用这份**冻结快照**，新工作区永远不在名单里。
//
// 本文件把这个契约钉死：装配之后再写 `workspace.json`（宿主真实行为），
// 新工作区的会话必须落进自己的作用域，且不得落到白名单首位那个工作区。
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, type Config } from '../src/index.js'
import { MemoryDB } from '../src/db.js'
import { loadWorkspaceRegistry, projectScopeOf, resetWorkspaceRegistryCache } from '../src/workspaces.js'
import type { Context } from 'cordis'

/** 白名单首位工作区（旧实现的「降级降落点」） */
const FIRST_ROOT = path.normalize('D:/Code/Rust/deskcraft')
const FIRST_SCOPE = projectScopeOf(FIRST_ROOT)
/** 装配之后才创建的中文名工作区 */
const CN_ROOT = path.normalize('D:/Code/DSH工作区/磁盘清理')
const CN_SCOPE = projectScopeOf(CN_ROOT)

const USER_TEXT = '请把磁盘清理脚本的 vhdx 回收顺序写成可复用步骤。'
const ASSISTANT_TEXT = '已确定：先 wsl --shutdown 再 docker system prune，最后回收 vhdx（决定，以后一律照此执行）。'

interface SessionEventListener {
  (session: unknown, event: { type: string; data: unknown }): void
}

function createFakeCtx() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let listener: SessionEventListener | null = null
  const ctx = {
    logger,
    on: (name: string, fn: SessionEventListener) => {
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
                  path_segments: ['工具链', '磁盘管理'],
                  name: 'vhdx回收顺序',
                  content: '先 wsl --shutdown 再 docker system prune，最后回收 vhdx',
                  keywords: ['vhdx', 'wsl'],
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
    emit: (session: unknown, event: { type: string; data: unknown }) => listener?.(session, event),
  }
}

/** 写一份宿主工作区登记表；roots 中的第一项即「白名单首位」降级降落点 */
function writeRegistry(home: string, workspaces: Array<{ path: string; title: string }>): void {
  const tables: Record<string, unknown> = {}
  workspaces.forEach((workspace, index) => {
    tables[`ws-${index}`] = { path: workspace.path, title: workspace.title, sessionIds: [], createdAt: '', updatedAt: '' }
  })
  fs.writeFileSync(
    path.join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: Object.keys(tables) },
      tables: { workspaces: tables },
    }),
    'utf8',
  )
}

describe('缺陷 1/2 根因：工作区白名单必须实时读取（不得在装配期冻结）', () => {
  const tempDirs: string[] = []
  const dbFiles: string[] = []
  let savedDshHome: string | undefined

  afterEach(() => {
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    resetWorkspaceRegistryCache()
    for (const file of dbFiles.splice(0)) {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(`${file}${suffix}`, { force: true })
        } catch {
          /* 临时文件清理失败不影响断言 */
        }
      }
    }
    while (tempDirs.length > 0) {
      try {
        fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
      } catch {
        /* 临时目录清理失败不影响断言 */
      }
    }
  })

  function setupDshHome(initial: Array<{ path: string; title: string }>): string {
    savedDshHome = process.env.DSH_HOME
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-live-registry-'))
    fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
    tempDirs.push(home)
    writeRegistry(home, initial)
    process.env.DSH_HOME = home
    resetWorkspaceRegistryCache()
    return home
  }

  function tempDbPath(): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-live-db-')), 'tlmemory.db')
    tempDirs.push(path.dirname(file))
    dbFiles.push(file)
    return file
  }

  it('装配后新建的中文工作区立刻生效：记忆落该工作区，绝不落白名单首位', async () => {
    // 装配时登记表里只有「白名单首位」那个工作区 —— 复刻「插件先启动、新工作区后创建」
    const home = setupDshHome([{ path: FIRST_ROOT, title: 'deskcraft' }])
    const dbPath = tempDbPath()
    const { ctx, emit } = createFakeCtx()
    const disposer = apply(ctx, { dbPath, serverPort: 0 } as Config)

    // 宿主在运行期间把新工作区（中文名）写进登记表：实时读取必须立刻看到它
    writeRegistry(home, [
      { path: FIRST_ROOT, title: 'deskcraft' },
      { path: CN_ROOT, title: '磁盘清理' },
    ])
    const registry = loadWorkspaceRegistry()
    expect(registry?.has(CN_SCOPE)).toBe(true)
    expect(registry?.has(FIRST_SCOPE)).toBe(true)

    // 会话真实形态：工作目录收在会话创建头里（session.header.cwd）
    const session = { header: { cwd: CN_ROOT } }
    emit(session, { type: 'turn/start', data: { turn: 1 } })
    emit(session, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: USER_TEXT }], source: { kind: 'user' } },
    })
    emit(session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] } },
    })
    emit(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    await new Promise((resolve) => setTimeout(resolve, 400))
    disposer()

    const db = new MemoryDB(dbPath)
    // ① 记忆归属会话自己的工作区（缺陷 1：新工作区收不到记忆）
    expect(db.getNodesByScope(CN_SCOPE).some((n) => n.is_leaf === 1 && n.name === 'vhdx回收顺序')).toBe(true)
    // ② 绝不被改道写入白名单首位那个无关工程（缺陷 2：项目记忆写进别的工程）
    expect(db.getNodesByScope(FIRST_SCOPE).some((n) => n.is_leaf === 1)).toBe(false)
    // ③ 该工作区可被记忆列表找到（登记项在位）
    expect(db.hasProject(CN_SCOPE)).toBe(true)
    expect(db.listProjects(null).some((item) => item.scope === CN_SCOPE)).toBe(true)
    db.close()
  })

  it('中文工作区的会话作用域＝登记表里的权威 scope（哈希与白名单口径一致）', () => {
    setupDshHome([
      { path: FIRST_ROOT, title: 'deskcraft' },
      { path: CN_ROOT, title: '磁盘清理' },
    ])
    const registry = loadWorkspaceRegistry()
    expect(projectScopeOf(CN_ROOT)).toBe(CN_SCOPE)
    expect(registry?.nameOf(CN_SCOPE)).toBe('磁盘清理')
    // 纯中文标题也必须能与「工程名 == 工作区标题」的同名对齐口径对上
    expect(registry?.alignTitleByName('磁盘清理')).toBe('磁盘清理')
  })
})
