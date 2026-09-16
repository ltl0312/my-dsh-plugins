// packages/tlmemory/tests/server-port-recovery.spec.ts
// 端口冲突自愈（零配置自启）固化验收标准：
// 1. 端口被无关 HTTP 进程占用 → 健康探测不命中 → 自动顺延 +1 端口绑定成功；
// 2. 端口被前序 tlmemory 实例占用 → 健康探测确认同名进程 → 本实例复用（delegated），
//    不重复绑定，前序实例继续正常服务；
// 3. /api/health 必须携带 service:'tlmemory' 身份标识（同名进程探测的依据）。
//
// 2026-09-16 加固：用例 1 原先用 `squatter.listen(0)` 取临时端口，而**临时端口池与并发
// 运行的其它 vitest worker 里 MemoryServer 的 port=0 端口共用**。当被占端口的 P+1 恰好
// 落在另一 worker 的 tlmemory 实例上时，被验实例会探测到同名服务而走 delegated 分支
// （永不绑定）→ waitForPort 自旋到 5s 超时。这与自愈逻辑无关，纯属测试端口分配不确定。
// 现改为在**系统动态端口段之外**的固定候选段里取一对相邻端口（P 占用、P+1 已验证空闲），
// 并发 worker 的临时端口不可能落进该段，用例恢复确定性。
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

/**
 * 候选端口段：必须落在系统动态端口段（Windows/macOS 自 49152 起，Linux 自 32768 起）
 * **之下的固定段**，否则并发的 vitest worker 取临时端口时会与本用例的端口撞车。
 */
const FIXED_PORT_RANGE_START = 21000
const FIXED_PORT_RANGE_END = 21500

/** 尝试在指定端口监听；成功返回 true，EADDRINUSE 等失败返回 false（不抛错） */
function tryListen(server: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = (): void => {
      server.removeListener('listening', onListening)
      resolve(false)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve(true)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
  })
}

/** 在 /api/health 上返回非 tlmemory 身份的普通 HTTP 服务（占位者） */
function createSquatter(): http.Server {
  return http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ hello: 'world' }))
  })
}

/**
 * 占住一个「后继端口 P+1 已确认空闲」的固定端口 P，返回占位者本身。
 * P+1 的探测性绑定时长极短且位于动态端口段之外，被抢占的概率可忽略。
 */
async function occupyPortWithFreeSuccessor(): Promise<{ squatter: http.Server; port: number }> {
  for (let candidate = FIXED_PORT_RANGE_START; candidate < FIXED_PORT_RANGE_END; candidate++) {
    const squatter = createSquatter()
    if (!(await tryListen(squatter, candidate))) {
      await closeServer(squatter)
      continue
    }
    const probe = createSquatter()
    const successorFree = await tryListen(probe, candidate + 1)
    await closeServer(probe)
    if (successorFree) return { squatter, port: candidate }
    await closeServer(squatter)
  }
  throw new Error(
    `固定候选段 ${FIXED_PORT_RANGE_START}-${FIXED_PORT_RANGE_END} 内找不到「后继端口空闲」的相邻端口对，` +
      '请检查本机端口占用/保留段（如 Hyper-V excludedportrange）',
  )
}

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.pop()!
    await fn()
  }
})

describe('端口冲突自愈（零配置自启）', () => {
  it(
    '无关进程占用端口时健康探测不命中，自动顺延 +1 绑定成功',
    { timeout: 15000 },
    async () => {
      const { squatter, port: occupiedPort } = await occupyPortWithFreeSuccessor()
      cleanup.push(() => closeServer(squatter))

      const db = new MemoryDB(':memory:')
      const server = new MemoryServer(db, occupiedPort, undefined, undefined, null)
      cleanup.push(() => {
        server.stop()
        db.close()
      })

      const outcome = await server.start()
      // 先断言启动语义：若退化为 delegated，立即以精确断言失败，
      // 而不是先在 waitForPort 里空转到超时（错误信息更具诊断价值）
      expect(outcome).toBe('bound')
      const port = await waitForPort(server)

      expect(port).toBe(occupiedPort + 1)

      // 顺延后的端口真实可访问，健康响应带服务身份标识
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      const body = (await res.json()) as { ok: boolean; service: string }
      expect(body).toMatchObject({ ok: true, service: 'tlmemory' })
    },
  )

  it('前序 tlmemory 实例占用端口时健康探测命中并复用（不重复绑定）', async () => {
    const db = new MemoryDB(':memory:')
    const first = new MemoryServer(db, 0, undefined, undefined, null)
    cleanup.push(() => {
      first.stop()
      db.close()
    })
    await first.start()
    const firstPort = await waitForPort(first)

    const db2 = new MemoryDB(':memory:')
    const second = new MemoryServer(db2, firstPort, undefined, undefined, null)
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
