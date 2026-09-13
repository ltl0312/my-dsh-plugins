// packages/tlmemory/tests/server.spec.ts
// 嵌入式 HTTP 服务契约（固化验收标准）：
// 1. GET /api/memories?tree=global 必须返回 200 与有效 JSON（记忆树节点列表）；
// 2. GET /api/search?q=pnpm 必须通过 FTS5 全文索引命中已入库记忆。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryDB } from '../src/db.js'
import { MemoryServer } from '../src/server.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询等待服务完成监听并返回实际端口（port=0 时为系统临时端口） */
async function waitForPort(server: MemoryServer, timeoutMs = 5000): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const port = server.actualPort
    if (port > 0) return port
    await delay(50)
  }
  throw new Error('server did not start listening in time')
}

describe('dsh-plugin-tlmemory 嵌入式 HTTP 服务', () => {
  let db: MemoryDB
  let server: MemoryServer
  let port: number

  beforeEach(async () => {
    db = new MemoryDB(':memory:')
    db.upsertLeaf(
      'global',
      ['工程化', '构建'],
      'pnpm放行',
      'pnpm 11 需要配置 native 依赖构建放行',
      ['pnpm', 'native', '构建放行'],
    )
    db.upsertLeaf('repo:abc', ['踩坑'], '本地样例', 'repo 作用域样例内容', ['local'])
    server = new MemoryServer(db, 0)
    server.start()
    port = await waitForPort(server)
  })

  afterEach(() => {
    server.stop()
    db.close()
  })

  it('GET /api/memories?tree=global 返回 200 与有效 JSON 且仅含全局树', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/memories?tree=global`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')

    const body = await res.json()
    expect(body).toHaveProperty('data')
    expect(Array.isArray(body.data)).toBe(true)

    const names = body.data.map((n: { name: string }) => n.name)
    expect(names).toContain('pnpm放行')
    expect(names).not.toContain('本地样例')
  })

  it('GET /api/search?q=pnpm 通过 FTS5 命中已入库记忆', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/search?q=${encodeURIComponent('pnpm')}`,
    )
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.data[0].name).toBe('pnpm放行')
    expect(body.data[0].score).toBeGreaterThan(0)
  })
})