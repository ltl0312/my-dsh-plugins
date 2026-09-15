// packages/tlmemory/tests/server-security.spec.ts
// P0 安全回归门禁（2026-09-15 代码评审 P0-1 / P0-2）：
// 1. CORS 收紧：任何响应不得携带 Access-Control-Allow-Origin:*（任意网页不得跨源读写删记忆库）；
// 2. HTTP Host 白名单：普通 HTTP 请求同样执行 DNS rebinding 防御；
// 3. WS Origin 严格解析：伪造 Origin（evil-127.0.0.1.attacker.com）不得通过子串包含绕过；
// 4. 未知 /api/* 路径不得回落 SPA index.html。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryDB } from '../src/db.js'
import { MemoryServer } from '../src/server.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForPort(server: MemoryServer, timeoutMs = 5000): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const port = server.actualPort
    if (port > 0) return port
    await delay(50)
  }
  throw new Error('server did not start listening in time')
}

describe('dsh-plugin-tlmemory 服务端安全回归（P0-1 / P0-2）', () => {
  let db: MemoryDB
  let server: MemoryServer
  let port: number

  beforeEach(async () => {
    db = new MemoryDB(':memory:')
    db.upsertLeaf('global', ['工程化'], 'pnpm放行', 'pnpm 11 需要配置原生依赖构建放行', ['pnpm'])
    server = new MemoryServer(db, 0)
    server.start()
    port = await waitForPort(server)
  })

  afterEach(() => {
    server.stop()
    db.close()
  })

  it('P0-1: API 响应不得携带任何 Access-Control-Allow-* 头（跨源读写删通道封死）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/memories`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-methods')).toBeNull()
  })

  it('P0-1: Host 头不在白名单（恶意域名 DNS rebinding）必须 403', async () => {
    // fetch（undici）按规范禁止覆写 Host 头，这里用 node:http 原生请求模拟
    // 恶意域名 A 记录指向 127.0.0.1 时浏览器发送的 Host 头形态
    const http = await import('node:http')
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/memories', method: 'GET', headers: { host: 'evil-127.0.0.1.attacker.com' } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
  })

  it('P0-1: Host 头白名单内的请求不受影响（localhost 放行）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/memories`, {
      headers: { host: 'localhost' },
    })
    expect(res.status).toBe(200)
  })

  it('P0-2: WS upgrade 携带伪造 Origin（含回环子串的恶意域名）必须被拒绝', async () => {
    const { WebSocket } = await import('ws')
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: 'http://evil-127.0.0.1.attacker.com' },
      })
      ws.on('open', () => resolve('open'))
      ws.on('error', (err: Error) => resolve(`error:${err.message}`))
      ws.on('unexpected-response', () => resolve('rejected'))
    })
    expect(outcome).not.toBe('open')
  })

  it('P0-2: WS upgrade 携带合法回环 Origin 必须正常建立', async () => {
    const { WebSocket } = await import('ws')
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      })
      ws.on('open', () => {
        ws.close()
        resolve('open')
      })
      ws.on('error', (err: Error) => resolve(`error:${err.message}`))
    })
    expect(outcome).toBe('open')
  })

  it('P0-1: 未知 /api/* 路径返回 404 而非 SPA index.html', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/nonexistent`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})
