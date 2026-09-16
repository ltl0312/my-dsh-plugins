// packages/tlmemory/tests/server-security.spec.ts
// P0 安全回归门禁（2026-09-15 代码评审 P0-1 / P0-2）：
// 1. CORS 白名单：仅回环白名单 Origin 回写具体 ACAO 值，绝不出现通配符 `*`；
//    无 Origin 与白名单外 Origin 一律不回写 —— 任意公网网页不得跨源读写删记忆库；
// 2. HTTP Host 白名单：普通 HTTP 请求同样执行 DNS rebinding 防御；
// 3. WS Origin 严格解析：伪造 Origin（evil-127.0.0.1.attacker.com）不得通过子串包含绕过；
// 4. 未知 /api/* 路径不得回落 SPA index.html。
//
// CORS 白名单层（2026-09-16）补充动机：宿主页面在 http://127.0.0.1:3080，与看板服务端
// 4890 端口天然不同源，缺失 ACAO 会让宿主在线探针的 fetch 被浏览器 CORS policy 拦截，
// 进而把「服务在岗」误判为离线并弹遮罩。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { IncomingHttpHeaders } from 'node:http'
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

interface RawProbe {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/**
 * 原生 http 探针：undici（fetch）的 forbidden header 列表会吞掉 Origin / Host，
 * 而 CORS 断言恰恰依赖这两个头，故一律走 node:http 直发。
 */
async function rawProbe(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string> },
): Promise<RawProbe> {
  const http = await import('node:http')
  return new Promise<RawProbe>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/api/memories',
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** ACAO 取值规范化：响应头可能是 string | string[] | undefined */
function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null
  return Array.isArray(value) ? value.join(', ') : value
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

  it('P0-1: 无 Origin 的请求不回写任何 Access-Control-Allow-* 头（同源与本地客户端无需 CORS）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/memories`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-methods')).toBeNull()
  })

  it('CORS 白名单: 宿主 Origin http://127.0.0.1:3080 的 GET 回写该具体 Origin（非通配符）', async () => {
    const res = await rawProbe(port, {
      path: '/api/health',
      headers: { origin: 'http://127.0.0.1:3080' },
    })
    expect(res.status).toBe(200)
    expect(headerValue(res.headers['access-control-allow-origin'])).toBe('http://127.0.0.1:3080')
    expect(headerValue(res.headers['access-control-allow-origin'])).not.toBe('*')
    expect(headerValue(res.headers['access-control-allow-methods'])).toBe(
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    )
    expect(headerValue(res.headers['access-control-allow-headers'])).toBe('Content-Type')
    expect(headerValue(res.headers.vary)).toContain('Origin')
  })

  it('CORS 白名单: localhost 变体与任意本地开发端口同样回写具体 Origin', async () => {
    for (const origin of ['http://localhost:3080', 'http://127.0.0.1:5173', 'http://localhost:4890']) {
      const res = await rawProbe(port, { path: '/api/memories', headers: { origin } })
      expect(res.status).toBe(200)
      expect(headerValue(res.headers['access-control-allow-origin'])).toBe(origin)
      expect(headerValue(res.headers['access-control-allow-origin'])).not.toBe('*')
    }
  })

  it('CORS 预检: 白名单 Origin 的 OPTIONS 返回 204 且不进入业务路由', async () => {
    const res = await rawProbe(port, {
      method: 'OPTIONS',
      path: '/api/nodes',
      headers: {
        origin: 'http://127.0.0.1:3080',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(res.status).toBe(204)
    expect(res.body).toBe('')
    expect(headerValue(res.headers['access-control-allow-origin'])).toBe('http://127.0.0.1:3080')
    expect(headerValue(res.headers['access-control-allow-methods'])).toContain('POST')
    expect(headerValue(res.headers['access-control-allow-headers'])).toBe('Content-Type')
  })

  it('CORS 白名单外 Origin: GET 不回写 ACAO（跨源读写删通道依旧封死）', async () => {
    for (const origin of [
      'http://evil-127.0.0.1.attacker.com',
      'https://example.com',
      'http://192.168.1.10:3080',
      'null',
      'not-a-url',
    ]) {
      const res = await rawProbe(port, { path: '/api/memories', headers: { origin } })
      expect(res.status).toBe(200)
      expect(headerValue(res.headers['access-control-allow-origin'])).toBeNull()
      expect(headerValue(res.headers['access-control-allow-methods'])).toBeNull()
    }
  })

  it('CORS 白名单外 Origin: OPTIONS 预检必须 403 且不带 CORS 头', async () => {
    const res = await rawProbe(port, {
      method: 'OPTIONS',
      path: '/api/nodes',
      headers: { origin: 'https://evil-127-0-0-1.attacker.com' },
    })
    expect(res.status).toBe(403)
    expect(headerValue(res.headers['access-control-allow-origin'])).toBeNull()
  })

  it('Host 校验优先于 CORS: 恶意 Host 携带回环 Origin 仍 403 且不泄露 CORS 头', async () => {
    const res = await rawProbe(port, {
      path: '/api/health',
      headers: { host: 'evil-127.0.0.1.attacker.com', origin: 'http://127.0.0.1:3080' },
    })
    expect(res.status).toBe(403)
    expect(headerValue(res.headers['access-control-allow-origin'])).toBeNull()
  })

  it('CORS 头覆盖业务错误响应: 白名单 Origin 命中 404 时仍携带 ACAO', async () => {
    const res = await rawProbe(port, {
      path: '/api/nonexistent',
      headers: { origin: 'http://127.0.0.1:3080' },
    })
    expect(res.status).toBe(404)
    expect(headerValue(res.headers['access-control-allow-origin'])).toBe('http://127.0.0.1:3080')
  })

  it('P0-1: Host 头不在白名单（恶意域名 DNS rebinding）必须 403', async () => {
    // fetch（undici）按规范禁止覆写 Host 头，这里用 node:http 原生请求模拟
    // 恶意域名 A 记录指向 127.0.0.1 时浏览器发送的 Host 头形态
    const res = await rawProbe(port, {
      path: '/api/memories',
      headers: { host: 'evil-127.0.0.1.attacker.com' },
    })
    expect(res.status).toBe(403)
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
