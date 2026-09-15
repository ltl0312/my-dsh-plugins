// packages/tlmemory/tests/server-port-recovery.spec.ts
// 端口冲突自愈（零配置自启）固化验收标准：
// 1. 端口被无关 HTTP 进程占用 → 健康探测不命中 → 自动顺延 +1 端口绑定成功；
// 2. 端口被前序 tlmemory 实例占用 → 健康探测确认同名进程 → 本实例复用（delegated），
//    不重复绑定，前序实例继续正常服务；
// 3. /api/health 必须携带 service:'tlmemory' 身份标识（同名进程探测的依据）。
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
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

const cleanup: Array<() => void> = []

afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

describe('端口冲突自愈（零配置自启）', () => {
  it('无关进程占用端口时健康探测不命中，自动顺延 +1 绑定成功', async () => {
    // 占位者：一个在 /api/health 上返回非 tlmemory 身份的普通 HTTP 服务
    const squatter = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ hello: 'world' }))
    })
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve))
    const occupiedPort = (squatter.address() as { port: number }).port
    cleanup.push(() => squatter.close())

    const db = new MemoryDB(':memory:')
    const server = new MemoryServer(db, occupiedPort)
    cleanup.push(() => {
      server.stop()
      db.close()
    })

    const outcome = await server.start()
    const port = await waitForPort(server)

    expect(outcome).toBe('bound')
    expect(port).toBe(occupiedPort + 1)

    // 顺延后的端口真实可访问，健康响应带服务身份标识
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    const body = (await res.json()) as { ok: boolean; service: string }
    expect(body).toMatchObject({ ok: true, service: 'tlmemory' })
  })

  it('前序 tlmemory 实例占用端口时健康探测命中并复用（不重复绑定）', async () => {
    const db = new MemoryDB(':memory:')
    const first = new MemoryServer(db, 0)
    cleanup.push(() => {
      first.stop()
      db.close()
    })
    await first.start()
    const firstPort = await waitForPort(first)

    const db2 = new MemoryDB(':memory:')
    const second = new MemoryServer(db2, firstPort)
    cleanup.push(() => {
      second.stop()
      db2.close()
    })

    const outcome = await second.start()

    expect(outcome).toBe('delegated')
    expect(second.actualPort).toBe(0)

    // 前序实例仍在岗且健康
    const res = await fetch(`http://127.0.0.1:${firstPort}/api/health`)
    const body = (await res.json()) as { ok: boolean; service: string }
    expect(body).toMatchObject({ ok: true, service: 'tlmemory' })
  })
})
