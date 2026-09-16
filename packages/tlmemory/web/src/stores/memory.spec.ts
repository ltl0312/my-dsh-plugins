// packages/tlmemory/web/src/stores/memory.spec.ts
// 工程下拉框「自愈」契约固化（v0.6.5 修复「下拉框死锁」的回归守门）：
// 1. 选中的 scope 不在服务端清单里（被清理 / hash 口径变化 / 首次加载竞态）时，
//    必须**自动回退到清单里第一个有记忆的工程**，而不是死守一个已不存在的 scope
//    ——死守会让顶栏停在「暂无工程记忆」，且下拉没有任何可选项，形成死锁；
// 2. /api/nodes 对失效作用域回 200 + 空数组（不再 404）时，store 必须把它收敛成空树，
//    绝不能把 `undefined` 写进 nodes 让下方整块渲染报错；
// 3. 服务端同时给出 `data` 与 `nodes` 两个字段时，任一存在即可用（容错契约）。
//
// 注意：本文件刻意放在 web/src 下 —— 'vue' / 'pinia' 只装在 web/node_modules，
// 放在 tests/ 下会解析不到依赖。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMemoryStore, type ProjectDto } from './memory'

function project(scope: string, name: string, leafCount: number, workspaceName: string | null = null): ProjectDto {
  return { scope, name, root: null, workspaceName, nodeCount: leafCount, leafCount, updatedAt: 0 }
}

/** 按 URL 分派响应的 fetch 桩：返回体直接取自给定映射 */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const key = Object.keys(routes).find((pattern) => url.includes(pattern))
    const hit = key ? routes[key] : undefined
    const status = hit?.status ?? (hit ? 200 : 404)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => hit?.body ?? {},
    } as unknown as Response
  }) as unknown as typeof fetch
}

describe('tlmemory 看板工程选择器自愈', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('选中 scope 不在清单里时，自动回退到清单里第一个有记忆的工程', async () => {
    const store = useMemoryStore()
    // 模拟上一轮事故：选中的是靠 hash 漂移产生、已被清理的旧 scope
    store.currentProjectScope = 'repo:1c5b8d3f3502'

    stubFetch({
      '/api/projects': {
        body: {
          data: [project('repo:cccccccccccc', 'deskcraft', 0), project('repo:cccccccccccc2', 'TLToolBox', 7)],
          current: null,
          currentName: null,
        },
      },
      '/api/nodes': { body: { data: [] } },
    })

    await store.fetchProjects()

    // 回退目标是「有记忆」的那个，而不是清单首项的零记忆工程
    expect(store.currentProjectScope).toBe('repo:cccccccccccc2')
    expect(store.currentProject?.name).toBe('TLToolBox')
  })

  it('宿主上报的当前工程在清单里时优先保留它，不做多余回退', async () => {
    const store = useMemoryStore()
    stubFetch({
      '/api/projects': {
        body: {
          data: [project('repo:aaaaaaaaaaaa', 'my-dsh-plugins', 3), project('repo:bbbbbbbbbbbb', 'TLToolBox', 9)],
          current: 'repo:aaaaaaaaaaaa',
          currentName: 'my-dsh-plugins',
        },
      },
      '/api/nodes': { body: { data: [] } },
    })

    await store.fetchProjects()

    expect(store.currentProjectScope).toBe('repo:aaaaaaaaaaaa')
  })

  it('bootstrap：清单与节点都到位后，选中项一定落在清单内（下拉框绝不无选项）', async () => {
    const store = useMemoryStore()
    stubFetch({
      '/api/projects': {
        body: { data: [project('repo:bbbbbbbbbbbb', 'TLToolBox', 2)], current: '', currentName: '' },
      },
      '/api/nodes': { body: { data: [] } },
    })

    await store.bootstrap()

    expect(store.projectOptions).toHaveLength(1)
    expect(store.currentProjectScope).toBe('repo:bbbbbbbbbbbb')
  })

  it('/api/projects 为空时仍从节点反推工程清单（有节点必有可选项）', async () => {
    const store = useMemoryStore()
    stubFetch({
      '/api/projects': { body: { data: [], current: null, currentName: null } },
      '/api/nodes': {
        body: {
          data: [
            { id: '1', tree_type: 'repo:deadbeefcafe', parent_id: null, path: '/架构/', name: '架构', is_leaf: 0, content: null, keywords: null, reinforce_count: 0, is_pinned: 0 },
            { id: '2', tree_type: 'repo:deadbeefcafe', parent_id: '1', path: '/架构/P0/', name: 'P0', is_leaf: 1, content: 'x', keywords: null, reinforce_count: 0, is_pinned: 0 },
          ],
        },
      },
    })

    await store.bootstrap()

    expect(store.projectOptions.map((item) => item.scope)).toEqual(['repo:deadbeefcafe'])
    expect(store.currentProjectScope).toBe('repo:deadbeefcafe')
    expect(store.currentProject?.leafCount).toBe(1)
  })

  it('fetchNodes：失效作用域回 200 空树时收敛为空数组，而不是写入 undefined', async () => {
    const store = useMemoryStore()
    store.currentProjectScope = 'repo:deadbeefcafe'
    stubFetch({
      '/api/nodes': {
        body: { data: [], nodes: [], message: '未找到工程「repo:deadbeefcafe」，已返回空记忆树', resolved: false },
      },
    })

    await store.fetchNodes()
    expect(store.nodes).toEqual([])
    expect(store.scopedNodes).toEqual([])
  })

  it('fetchNodes：非 2xx 也不崩，收敛为空数组', async () => {
    const store = useMemoryStore()
    store.currentProjectScope = 'repo:deadbeefcafe'
    stubFetch({ '/api/nodes': { status: 500, body: { error: 'boom' } } })

    await store.fetchNodes()
    expect(store.nodes).toEqual([])
  })

  it('fetchNodes：只有 nodes 字段（无 data）时照样取到数据', async () => {
    const store = useMemoryStore()
    store.currentProjectScope = 'repo:deadbeefcafe'
    stubFetch({
      '/api/nodes': {
        body: {
          nodes: [
            { id: '9', tree_type: 'repo:deadbeefcafe', parent_id: null, path: '/规范/', name: '规范', is_leaf: 1, content: 'x', keywords: null, reinforce_count: 0, is_pinned: 0 },
          ],
        },
      },
    })

    await store.fetchNodes()
    expect(store.nodes).toHaveLength(1)
    expect(store.currentProjectScope).toBe('repo:deadbeefcafe')
  })

  it('selectProject 切换后 currentProject 指向新工程（顶栏高亮与勾选有据可依）', async () => {
    const store = useMemoryStore()
    stubFetch({
      '/api/projects': {
        body: {
          data: [project('repo:aaaaaaaaaaaa', 'my-dsh-plugins', 1), project('repo:bbbbbbbbbbbb', 'TLToolBox', 5)],
          current: 'repo:aaaaaaaaaaaa',
          currentName: 'my-dsh-plugins',
        },
      },
      '/api/nodes': { body: { data: [] } },
      '/api/search': { body: { data: [] } },
    })
    await store.fetchProjects()

    await store.selectProject('repo:bbbbbbbbbbbb')

    expect(store.currentTree).toBe('project')
    expect(store.currentProject?.name).toBe('TLToolBox')
    // 作用域查询串精确指向新工程，不与上一棵树串味
    expect(store.scopeQuery).toBe('scope=project&project=repo%3Abbbbbbbbbbbb')
  })
})
