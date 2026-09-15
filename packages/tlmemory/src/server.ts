// packages/tlmemory/src/server.ts
// 轻量内嵌服务与实时通信中继层（阶段三生产版）。
// 安全基线（CVE-2026-82533 回环穿透防御）：
// 1. listen 严格显式绑定 IPv4 回环 127.0.0.1，严禁监听 0.0.0.0；
// 2. WebSocket upgrade 握手强校验 Host 与 Origin 双头，仅放行 127.0.0.1 / localhost；
// 3. 静态资源经 path.normalize 归一化并强制锚定 dist 根内，拦截目录穿越逃逸。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import type { MemoryDB } from './db.js'

/** 宿主当前所在工程的身份（由装配层注入，用于 /api/projects 标记默认选中项） */
export interface CurrentProject {
  scope: string
  name: string
  root: string
}

/** 请求体读取封顶：只用于极小的 JSON 控制报文（重命名等），超限直接截断拒绝 */
const MAX_BODY_BYTES = 8 * 1024

/** 回环绑定常量：严禁替换为 0.0.0.0 或省略（省略将默认绑定所有网卡） */
const LOOPBACK_HOST = '127.0.0.1'

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

/** Host 头白名单校验：仅接受 IPv4 回环地址与 localhost 主机名 */
function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  const hostname = hostHeader.split(':')[0].toLowerCase()
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

/**
 * Origin 头白名单校验：阻断跨站 WebSocket 劫持（CSWSH）。
 * 浏览器连接强制携带 Origin 且 JS 无法伪造，非回环 Origin 一律销毁；
 * 本地非浏览器客户端（如 ws 库）不携带 Origin，属合法本地调用，放行（Host 校验仍在）。
 */
function isAllowedOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true
  return originHeader.includes('127.0.0.1') || originHeader.includes('localhost')
}

/** 解析 web/dist 静态产物根目录（兼容 CJS __dirname 与 ESM import.meta.url 双产物） */
function resolveWebDist(): string {
  const currentDir =
    typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(currentDir, '../web/dist')
}

export class MemoryServer {
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private clients: Set<WebSocket> = new Set()
  private readonly distPath: string

  constructor(
    private db: MemoryDB,
    private port: number = 4890,
    private logger?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
    private currentProject?: CurrentProject,
  ) {
    this.distPath = resolveWebDist()
  }

  public get actualPort(): number {
    const addr = this.server?.address()
    return typeof addr === 'object' && addr !== null ? addr.port : 0
  }

  public start(): void {
    if (this.server) return

    this.server = http.createServer((req, res) => {
      void this.handleHttp(req, res)
    })

    this.wss = new WebSocketServer({ noServer: true })

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws)
      ws.on('close', () => this.clients.delete(ws))
    })

    // upgrade 握手：Host 与 Origin 双头白名单校验，任一不合法立即销毁底层 socket
    this.server.on('upgrade', (request, socket, head) => {
      if (!isAllowedHost(request.headers.host) || !isAllowedOrigin(request.headers.origin)) {
        socket.destroy()
        return
      }
      this.wss?.handleUpgrade(request, socket, head, (ws) => {
        this.wss?.emit('connection', ws, request)
      })
    })

    // 绝对绑定至本地回环地址，严禁监听 0.0.0.0
    this.server.listen(this.port, LOOPBACK_HOST, () => {
      this.logger?.info?.(`[tlmemory-server] 本地管理服务就绪: http://127.0.0.1:${this.port}`)
    })

    this.server.on('error', (err) => {
      this.logger?.error?.('[tlmemory-server] 本地网络服务异常:', (err as Error).message)
    })
  }

  public broadcastHits(treeType: string, hitNodeIds: string[]): void {
    const payload = JSON.stringify({
      type: 'MEMORY_HITS',
      treeType,
      hitNodeIds,
      timestamp: Date.now(),
    })
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      }
    }
  }

  public notifyTreeChanged(treeType: string): void {
    const payload = JSON.stringify({
      type: 'TREE_CHANGED',
      treeType,
      timestamp: Date.now(),
    })
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      }
    }
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const pathname = url.pathname

    try {
      // 工程作用域清单：驱动看板下拉框，并回报宿主当前所在工程（默认选中项）
      if (req.method === 'GET' && pathname === '/api/projects') {
        this.sendJson(res, 200, {
          data: this.db.listProjects(),
          current: this.currentProject?.scope ?? null,
          currentName: this.currentProject?.name ?? null,
        })
        return
      }

      // 手工命名工程（把历史遗留的 repo:<hash> 改成可读名字）
      if (req.method === 'PATCH' && pathname === '/api/projects') {
        const body = await this.readJsonBody(req)
        const scope = typeof body.scope === 'string' ? body.scope : ''
        const name = typeof body.name === 'string' ? body.name : ''
        if (!scope || !name.trim()) {
          this.sendJson(res, 400, { error: 'scope 与 name 均为必填' })
          return
        }
        this.sendJson(res, 200, { success: this.db.renameProject(scope, name), data: this.db.listProjects() })
        return
      }

      // 记忆树读取契约（/api/nodes 与 /api/memories 共享同一套作用域语义）：
      //   ?scope=global                    全局偏好树
      //   ?scope=project&project=<工程名>   指定工程树
      //   ?scope=project                    全部工程树（看板下拉框自行收敛）
      //   不带参数 / ?scope=all              全部树（兼容既有行为）
      // 亦兼容历史参数 ?tree= / ?treeType=（值可以是 'global' / 'project' / 原始 tree_type）
      if (req.method === 'GET' && (pathname === '/api/nodes' || pathname === '/api/memories')) {
        const scope = (url.searchParams.get('scope') ?? '').trim()
        const projectParam = (url.searchParams.get('project') ?? '').trim()
        const legacy = (url.searchParams.get('tree') ?? url.searchParams.get('treeType') ?? '').trim()

        // 显式工程名 / scope 原文：收敛到唯一工程
        if (projectParam) {
          const resolved = this.db.findProjectScope(projectParam)
          if (resolved === null) {
            this.sendJson(res, 404, { error: `未找到工程 ${projectParam}` })
            return
          }
          this.sendJson(res, 200, { data: this.db.getNodesByScope(resolved) })
          return
        }

        if (scope === 'global' || legacy === 'global') {
          this.sendJson(res, 200, { data: this.db.getNodesByScope('global') })
          return
        }

        if (scope === 'project' || legacy === 'project') {
          this.sendJson(res, 200, { data: this.db.getProjectNodes() })
          return
        }

        const explicit = scope || legacy
        if (explicit && explicit !== 'all') {
          // 允许直接传原始 tree_type（例如 repo:1a2b3c4d5e6f）
          this.sendJson(res, 200, { data: this.db.getNodesByScope(explicit) })
          return
        }

        this.sendJson(res, 200, { data: this.db.getAllNodes() })
        return
      }

      if (req.method === 'GET' && pathname === '/api/search') {
        const query = url.searchParams.get('q') || ''
        const scope = (url.searchParams.get('scope') ?? '').trim()
        const projectParam = (url.searchParams.get('project') ?? '').trim()
        const legacy = (url.searchParams.get('tree') ?? url.searchParams.get('treeType') ?? '').trim()

        let treeType: string | undefined
        if (projectParam) {
          const resolved = this.db.findProjectScope(projectParam)
          if (resolved === null) {
            this.sendJson(res, 404, { error: `未找到工程 ${projectParam}` })
            return
          }
          treeType = resolved
        } else if (scope === 'global' || legacy === 'global') {
          treeType = 'global'
        } else {
          const explicit = scope || legacy
          if (explicit && explicit !== 'all' && explicit !== 'project') treeType = explicit
        }

        const hits = this.db.search(query, { treeType })
        this.sendJson(res, 200, { data: hits })
        return
      }

      if (req.method === 'DELETE' && pathname.startsWith('/api/nodes/')) {
        const id = pathname.slice('/api/nodes/'.length)
        const removed = this.db.deleteNode(id)
        this.sendJson(res, 200, { success: removed })
        return
      }

      this.serveStatic(req, res, pathname)
    } catch (e) {
      this.sendJson(res, 500, { error: (e as Error).message })
    }
  }

  /** 读取并解析极小 JSON 请求体；超限或畸形一律收敛为空对象（由调用方按缺字段拒绝） */
  private readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let raw = ''
      let aborted = false
      req.on('data', (chunk: Buffer) => {
        if (aborted) return
        raw += chunk.toString('utf8')
        if (raw.length > MAX_BODY_BYTES) {
          aborted = true
          raw = ''
        }
      })
      req.on('end', () => {
        if (aborted || raw.trim() === '') {
          resolve({})
          return
        }
        try {
          const parsed = JSON.parse(raw)
          resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const distPath = this.distPath
    let safePath = path.normalize(path.join(distPath, pathname === '/' ? 'index.html' : pathname))

    // 目录穿越防护：normalize 归一化后必须严格锚定在 dist 根目录内（含路径分隔符，防前缀绕过）
    if (!safePath.startsWith(distPath + path.sep)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    if (!fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
      safePath = path.join(distPath, 'index.html')
    }

    if (!fs.existsSync(safePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('前端静态资源尚未构建，请进入 packages/tlmemory/web 执行 pnpm build')
      return
    }

    const ext = path.extname(safePath)
    res.writeHead(200, { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' })
    fs.createReadStream(safePath).pipe(res)
  }

  private sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }

  public stop(): void {
    for (const client of this.clients) {
      client.terminate()
    }
    this.clients.clear()
    this.wss?.close()
    this.server?.close()
    this.wss = null
    this.server = null
  }
}