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

/** 请求体读取封顶：新建 / 编辑记忆的 Markdown 正文可达数十 KB，其余控制报文极小 */
const MAX_BODY_BYTES = 256 * 1024

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
 * 安全基线（P0-2）：必须用 URL 解析后取 hostname 做严格相等比较，
 * 严禁子串包含判断 —— `http://evil-127.0.0.1.attacker.com` 这类伪造 Origin
 * 能绕过 includes 校验，但对 hostname 严格匹配无效。
 */
function isAllowedOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true
  try {
    const hostname = new URL(originHeader).hostname.toLowerCase()
    return hostname === '127.0.0.1' || hostname === 'localhost'
  } catch {
    // 畸形 Origin（非合法 URL）一律拒绝
    return false
  }
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
    // P0-1 安全基线：不再返回任何 Access-Control-Allow-* 头。
    // 看板与 API 同源（127.0.0.1:4890），同源请求天然不需要 CORS；
    // 任何跨源网页发起的 fetch/DELETE 预检因无 ACAO 头而必然失败，
    // 简单请求（GET）的响应也无法被跨源页面读取 —— 任意网页读写删记忆库的通道就此封死。

    // DNS rebinding 防御：普通 HTTP 请求与 WS upgrade 一致执行 Host 头白名单校验。
    // 恶意域名的 A 记录指向 127.0.0.1 时，浏览器发送的 Host 头是恶意域名本身，
    // 在此被直接拒绝。
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const pathname = url.pathname

    try {
      // P2-1 轻量健康探针：客户端每 15s 轮询一次只为判断在线与否，
      // 绝不应拉全量节点表（几千节点 = 全表 dump + JSON 序列化的纯浪费）
      if (req.method === 'GET' && pathname === '/api/health') {
        this.sendJson(res, 200, { ok: true })
        return
      }

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
        const body = await this.readBodyOr413(req, res)
        if (body === null) return
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

      // 工程重命名（projectKey + newName 形态；与 PATCH /api/projects 等价兼容，
      // 看板工程下拉框的「重命名」入口走此端点）
      if (req.method === 'POST' && pathname === '/api/projects/rename') {
        const body = await this.readBodyOr413(req, res)
        if (body === null) return
        const key =
          typeof body.projectKey === 'string' && body.projectKey.trim()
            ? body.projectKey.trim()
            : typeof body.scope === 'string'
              ? body.scope.trim()
              : ''
        const newName =
          typeof body.newName === 'string' && body.newName.trim()
            ? body.newName.trim()
            : typeof body.name === 'string'
              ? body.name.trim()
              : ''
        if (!key || !newName) {
          this.sendJson(res, 400, { error: 'projectKey 与 newName 均为必填' })
          return
        }
        const resolved = this.db.findProjectScope(key) ?? key
        const success = this.db.renameProject(resolved, newName)
        if (success) this.notifyTreeChanged(resolved)
        this.sendJson(res, 200, { success, data: this.db.listProjects() })
        return
      }

      // 手工新增记忆节点（看板「+ 新建记忆」表单提交）：
      // scope=global 落全局偏好树；scope=project 时按 project（scope 原文或可读名）收敛，
      // 全新工程标识自动登记，保证下拉框即刻可见。成功返回 201 与完整节点。
      if (req.method === 'POST' && pathname === '/api/nodes') {
        const body = await this.readBodyOr413(req, res)
        if (body === null) return
        const scope = typeof body.scope === 'string' ? body.scope.trim() : ''
        const project = typeof body.project === 'string' ? body.project.trim() : ''
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        const content = typeof body.content === 'string' ? body.content : ''
        const pathInput = typeof body.path === 'string' ? body.path : '/'
        const keywords = Array.isArray(body.keywords) ? body.keywords.map(String) : []

        if (!title || !content.trim()) {
          this.sendJson(res, 400, { error: 'title 与 content 均为必填' })
          return
        }

        let treeType: string
        if (scope === 'global') {
          treeType = 'global'
        } else {
          if (!project) {
            this.sendJson(res, 400, { error: 'scope 为 project 时归属工程（project）不能为空' })
            return
          }
          const resolved = this.db.findProjectScope(project)
          if (resolved !== null) {
            treeType = resolved
          } else {
            treeType = project
            this.db.registerProject(treeType, project, null)
          }
        }

        try {
          const created = this.db.createLeaf(treeType, pathInput, title, content, keywords)
          this.notifyTreeChanged(created.tree_type)
          this.sendJson(res, 201, { data: created })
        } catch (e) {
          this.sendJson(res, 400, { error: (e as Error).message })
        }
        return
      }

      // 在线编辑记忆节点（看板详情抽屉「保存」提交）：title / content / path 任意组合，
      // FTS5 由 trg_nodes_au 触发器自动同步；唯一冲突转译为 409。
      if (req.method === 'PUT' && pathname.startsWith('/api/nodes/')) {
        const id = pathname.slice('/api/nodes/'.length)
        const body = await this.readBodyOr413(req, res)
        if (body === null) return
        const patch: { title?: string; content?: string; path?: string } = {}
        if (typeof body.title === 'string') patch.title = body.title
        if (typeof body.content === 'string') patch.content = body.content
        if (typeof body.path === 'string') patch.path = body.path
        if (Object.keys(patch).length === 0) {
          this.sendJson(res, 400, { error: 'title / content / path 至少提供一项' })
          return
        }
        try {
          const updated = this.db.updateNode(id, patch)
          if (updated === null) {
            this.sendJson(res, 404, { error: `记忆节点 ${id} 不存在` })
            return
          }
          this.notifyTreeChanged(updated.tree_type)
          this.sendJson(res, 200, { data: updated })
        } catch (e) {
          this.sendJson(res, 409, { error: (e as Error).message })
        }
        return
      }

      // M1 待确认区审核（看板「确认 / 拒绝」入口）：把沉淀条目在
      // confirmed / pending 之间切换。确认后重新参与召回；拒绝语义由前端转译为删除。
      if (req.method === 'PATCH' && pathname.startsWith('/api/nodes/') && pathname.endsWith('/status')) {
        const id = pathname.slice('/api/nodes/'.length, -'/status'.length)
        const body = await this.readBodyOr413(req, res)
        if (body === null) return
        const status = typeof body.status === 'string' ? body.status.trim() : ''
        if (status !== 'confirmed' && status !== 'pending') {
          this.sendJson(res, 400, { error: "status 仅接受 'confirmed' / 'pending'" })
          return
        }
        const ok = this.db.setStatus(id, status)
        if (!ok) {
          this.sendJson(res, 404, { error: `记忆节点 ${id} 不存在或状态值非法` })
          return
        }
        const node = this.db.getNode(id)
        if (node) this.notifyTreeChanged(node.tree_type)
        this.sendJson(res, 200, { success: true, data: node })
        return
      }

      if (req.method === 'DELETE' && pathname.startsWith('/api/nodes/')) {
        const id = pathname.slice('/api/nodes/'.length)
        const removed = this.db.deleteNode(id)
        this.sendJson(res, 200, { success: removed })
        return
      }

      // API 命名空间隔离：全部 API 路由均未命中时，未知 /api/* 请求不得回落到
      // SPA index.html（返回 200 + HTML 会让前端与调试时的错误语义混乱），统一 404。
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        this.sendJson(res, 404, { error: `未知 API 端点: ${req.method ?? 'GET'} ${pathname}` })
        return
      }

      this.serveStatic(req, res, pathname)
    } catch (e) {
      this.sendJson(res, 500, { error: (e as Error).message })
    }
  }

  /**
   * P2-9：读取 JSON 请求体并按**字节**计数（此前按 UTF-16 code unit 计数，
   * 中文正文下与真实字节上限差 3 倍）。tooLarge=true 表示超过上限，
   * 由调用方回 413 并销毁连接 —— 超限请求不得伪装成「缺字段 400」。
   */
  private readJsonBody(req: http.IncomingMessage): Promise<{ body: Record<string, unknown>; tooLarge: boolean }> {
    return new Promise((resolve) => {
      let raw = ''
      let bytes = 0
      let tooLarge = false
      let settled = false
      const settle = (large: boolean, body: Record<string, unknown> = {}): void => {
        if (settled) return
        settled = true
        resolve({ body, tooLarge: large })
      }
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return
        bytes += chunk.length
        raw += chunk.toString('utf8')
        if (bytes > MAX_BODY_BYTES) {
          tooLarge = true
          raw = ''
          settle(true)
        }
      })
      req.on('end', () => {
        if (tooLarge || raw.trim() === '') {
          settle(tooLarge)
          return
        }
        try {
          const parsed = JSON.parse(raw)
          settle(false, parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})
        } catch {
          settle(false)
        }
      })
      req.on('error', () => settle(false))
    })
  }

  /**
   * readJsonBody 的统一入口：超限时直接回 413 并销毁连接（响应写完后才销毁，
   * 保证客户端能读到状态码），返回 null 表示调用方必须立即终止处理。
   */
  private async readBodyOr413(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | null> {
    const { body, tooLarge } = await this.readJsonBody(req)
    if (!tooLarge) return body
    res.setHeader('Connection', 'close')
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: `请求体超过 ${MAX_BODY_BYTES} 字节上限` }), () => {
      // 响应落盘后再关闭连接：超限客户端不值得继续占用
      req.destroy()
    })
    return null
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