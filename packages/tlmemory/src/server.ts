// packages/tlmemory/src/server.ts
// 轻量内嵌服务与实时通信中继层（阶段三生产版）。
// 安全基线（CVE-2026-82533 回环穿透防御）：
// 1. listen 严格显式绑定 IPv4 回环 127.0.0.1，严禁监听 0.0.0.0；
// 2. WebSocket upgrade 握手强校验 Host 与 Origin 双头，仅放行 127.0.0.1 / localhost；
// 3. 静态资源经 path.normalize 归一化并强制锚定 dist 根内，拦截目录穿越逃逸；
// 4. CORS 白名单回复（非通配符）：仅当请求头携带的 Origin 通过回环白名单校验时，
//    才回写 Access-Control-Allow-Origin=<该具体 Origin>。宿主页面（如
//    http://127.0.0.1:3080）与看板服务端（http://127.0.0.1:4890）天然不同源，
//    缺失 ACAO 会让浏览器的跨源探针 fetch 被 CORS policy 直接拦截，宿主据此误判
//    服务离线并弹出遮罩 —— 白名单回复既修复该误判，又不向公网/未授权域名开口子。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import type { MemoryDB } from './db.js'
import type { ProjectSummary } from './types.js'
import { loadWorkspaceRegistry, type WorkspaceRegistry } from './workspaces.js'

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

/** 预检放行的方法集合：与下方全部 API 路由实际使用的方法保持一致 */
const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'

/**
 * 预检放行的请求头集合：看板的写操作统一以 application/json 提交（POST/PUT/PATCH/DELETE），
 * 该 Content-Type 属非简单类型，浏览器必然先发 OPTIONS 预检，故必须显式放行 Content-Type。
 */
const CORS_ALLOW_HEADERS = 'Content-Type'

/**
 * 解析可回写 CORS 头的合法 Origin。
 * 返回 null 表示「不回写任何 CORS 头」：包括无 Origin（同源请求/本地非浏览器客户端）
 * 与白名单外的 Origin（恶意网页、公网域名）两类。
 * 注意：**绝不使用通配符 `*`** —— 回写的必须是命中的具体 Origin，
 * 且不带 Access-Control-Allow-Credentials（本服务全程无 Cookie 鉴权依赖）。
 */
function resolveCorsOrigin(originHeader: string | undefined): string | null {
  if (!originHeader) return null
  return isAllowedOrigin(originHeader) ? originHeader : null
}

/**
 * 为通过白名单校验的跨源请求回写 CORS 响应头（在 writeHead 之前调用即可，
 * Node 会把 setHeader 写入的头与后续 writeHead 的显式头合并保留）。
 * `Vary: Origin` 保证中间缓存（含浏览器 HTTP 缓存）不会把带 ACAO 的响应
 * 错配给另一个 Origin。
 */
function applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): string | null {
  const origin = resolveCorsOrigin(req.headers.origin)
  if (origin === null) return null
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS)
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS)
  res.setHeader('Vary', 'Origin')
  return origin
}

/** 解析 web/dist 静态产物根目录（兼容 CJS __dirname 与 ESM import.meta.url 双产物） */
function resolveWebDist(): string {
  const currentDir =
    typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(currentDir, '../web/dist')
}

/**
 * 服务启动结果：
 * - bound     成功绑定端口；
 * - delegated 端口已被前序 tlmemory 实例监听，健康探测确认同名进程后本实例复用之；
 * - failed    连续端口重试后仍无法绑定（已打印 EADDRINUSE 排查指引）。
 */
export type ServerStartOutcome = 'bound' | 'delegated' | 'failed'

/** 端口冲突自愈：从配置端口起最多向后顺延尝试的端口数（4890 → 4899） */
const MAX_PORT_ATTEMPTS = 10

/**
 * Fetch 规范（browsers / undici 同源实现）明令封禁的端口表。
 *
 * 为什么必须自检：serverPort 为 0 或某个「看起来空闲」的端口时，OS 完全可能把禁区端口
 * 派给我们 —— 本机临时端口段是**连续递增**分配的，实测会依次经过 3659 / 4045 / 4190 /
 * 5060 / 5061 / 6000 / 6566 等禁区。绑定成功后症状是「服务在岗但谁都用不了」：
 * 浏览器打不开看板（ERR_UNSAFE_PORT），undici 的 fetch 直接抛 `Error: bad port`，
 * 表现为宿主看板空白 + 依赖 HTTP 的自动化链路随机失败。
 */
const FETCH_FORBIDDEN_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87,
  95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139,
  143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659,
  4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

/** 端口是否落在浏览器 / fetch 共同封禁的禁区（导出供单测与排查复用） */
export function isFetchForbiddenPort(port: number): boolean {
  return FETCH_FORBIDDEN_PORTS.has(port)
}

export class MemoryServer {
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private clients: Set<WebSocket> = new Set()
  private readonly distPath: string

  constructor(
    private db: MemoryDB,
    private port: number = 4890,
    private logger?: {
      info: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
    },
    private currentProject?: CurrentProject,
    /**
     * 宿主合法工作区白名单的来源（默认读 DSH 的 `$DSH_HOME/storages/workspace.json`）。
     *
     * 传入 null 表示**关闭白名单过滤**：工程清单只按「零记忆」清理，不按工作区归属。
     * 该形态仅供不依赖 DSH 宿主环境的嵌入式用例（单测直接构造本服务，用合成 scope
     * 验证登记/命名契约）使用；插件装配（src/index.ts）永远传入真实读取器，
     * 因此线上所有清单读取都经过工作区白名单校验。
     */
    private workspaceRegistryProvider: (() => WorkspaceRegistry | null) | null = loadWorkspaceRegistry,
  ) {
    this.distPath = resolveWebDist()
  }

  /**
   * 取宿主合法工作区白名单；读取器抛错或不可用一律视为「无从判定」（返回 null），
   * 调用方据此关闭过滤 —— 绝不因读取失败把用户的工程当孤儿清空。
   */
  private workspaceRegistry(): WorkspaceRegistry | null {
    try {
      return this.workspaceRegistryProvider?.() ?? null
    } catch (err) {
      this.logger?.warn?.('[tlmemory-server] 读取宿主工作区登记表失败，本轮跳过白名单过滤:', err)
      return null
    }
  }

  /**
   * 工程清单（已按宿主工作区白名单附带 workspaceName）。
   * 所有返回清单的端点统一走这里，避免某一条响应缺字段。
   */
  private projectList(registry: WorkspaceRegistry | null = this.workspaceRegistry()): ProjectSummary[] {
    return this.db.listProjects(registry?.scopes ?? null)
  }

  public get actualPort(): number {
    const addr = this.server?.address()
    return typeof addr === 'object' && addr !== null ? addr.port : 0
  }

  /**
   * 零配置自启（异步）：按配置端口尝试绑定；若 EADDRINUSE 则先做健康探测 ——
   * 确认是前序 tlmemory 实例（同名进程）时直接复用、不再重复绑定（多宿主并存
   * 场景自动收敛，无需任何手工开关）；确认是无关进程时自动顺延 +1 端口重试；
   * 连续重试仍失败则打印明确的 EADDRINUSE 解决指引。
   */
  public async start(): Promise<ServerStartOutcome> {
    if (this.server) return 'bound'

    let port = this.port
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const result = await this.listenOnce(port)

      if (result === 'bound') return 'bound'

      if (result === 'eaddrinuse') {
        // 自愈第一优先：健康探测确认是否为前序 tlmemory 实例 —— 是则直接复用，
        // 本实例不重复绑定（沉淀与召回职责照常，看板由在岗实例提供）
        if (await this.probeTlmemoryPeer(port)) {
          this.logger?.info?.(
            `[tlmemory-server] 端口 ${port} 已由前序 tlmemory 实例提供服务，本实例自动复用该实例（不重复绑定）`,
          )
          return 'delegated'
        }
        this.logger?.warn?.(
          `[tlmemory-server] 端口 ${port} 被其他进程占用，自动改用 ${port + 1} 重试...`,
        )
        port += 1
        continue
      }

      if (result === 'unsafe-port') {
        // 命中浏览器/fetch 封禁端口：port=0 时保持 0 让 OS 重新派发（临时端口段连续
        // 递增，下一轮必然越过错峰分布的禁区）；显式配置的端口则向后顺延一格。
        if (this.port !== 0) port += 1
        continue
      }

      // 非 EADDRINUSE 的监听异常已在 listenOnce 内记日志，不再重试
      break
    }

    this.logger?.error?.(
      `[tlmemory-server] EADDRINUSE：从端口 ${this.port} 起连续 ${MAX_PORT_ATTEMPTS} 个端口均无法绑定。\n` +
        `  解决指引：\n` +
        `    Windows:     netstat -ano | findstr :${this.port}  找到占用 PID 后 taskkill /PID <pid> /F\n` +
        `    macOS/Linux: lsof -i :${this.port}\n` +
        `    或在 cordis.patch.yml 的 tlmemory config 中将 serverPort 改为其他空闲端口。`,
    )
    return 'failed'
  }

  /**
   * 单次尝试：在指定端口上完成整套运行时装配（HTTP + WS upgrade + 安全校验）。
   * 绑定成功后还会自检实际端口是否落在浏览器/fetch 封禁的禁区
   * （port 传 0 时 OS 可能派发禁区端口），命中则立即释放并回报 'unsafe-port'。
   */
  private listenOnce(port: number): Promise<'bound' | 'eaddrinuse' | 'unsafe-port' | 'error'> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        void this.handleHttp(req, res)
      })

      const wss = new WebSocketServer({ noServer: true })

      wss.on('connection', (ws: WebSocket) => {
        this.clients.add(ws)
        ws.on('close', () => this.clients.delete(ws))
      })

      // upgrade 握手：Host 与 Origin 双头白名单校验，任一不合法立即销毁底层 socket
      server.on('upgrade', (request, socket, head) => {
        if (!isAllowedHost(request.headers.host) || !isAllowedOrigin(request.headers.origin)) {
          socket.destroy()
          return
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request)
        })
      })

      let settled = false
      const settle = (value: 'bound' | 'eaddrinuse' | 'unsafe-port' | 'error'): void => {
        if (settled) return
        settled = true
        resolve(value)
      }

      server.once('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EADDRINUSE') {
          server.close(() => {})
          settle('eaddrinuse')
          return
        }
        this.logger?.error?.('[tlmemory-server] 本地网络服务异常:', (err as Error).message)
        settle('error')
      })

      // 绝对绑定至本地回环地址，严禁监听 0.0.0.0
      server.listen(port, LOOPBACK_HOST, () => {
        const address = server.address()
        const assigned = typeof address === 'object' && address !== null ? address.port : port
        // 禁区端口自检：这类端口浏览器打不开看板、undici fetch 直接 bad port，
        // 属于「看似在岗实则不可用」，必须释放换端口（见 FETCH_FORBIDDEN_PORTS 注释）
        if (isFetchForbiddenPort(assigned)) {
          this.logger?.warn?.(
            `[tlmemory-server] 端口 ${assigned} 属于浏览器与 fetch 共同封禁的禁区，自动改用其他端口重试...`,
          )
          server.close(() => {})
          settle('unsafe-port')
          return
        }
        this.server = server
        this.wss = wss
        // 注意：port 为 0 时必须打印**实际**分配端口，否则日志里的 :0 无法用于访问
        this.logger?.info?.(`[tlmemory-server] 本地管理服务就绪: http://127.0.0.1:${assigned}`)
        settle('bound')
      })
    })
  }

  /**
   * 端口被占时的同名进程探测：向 127.0.0.1:<port>/api/health 发一次短超时 GET。
   * 响应携带 service:'tlmemory'（新版本）或 ok:true（兼容旧版本健康响应）即认定
   * 是前序 tlmemory 实例在岗；探测超时/失败/非本服务响应一律返回 false。
   */
  private probeTlmemoryPeer(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get({ host: LOOPBACK_HOST, port, path: '/api/health', timeout: 800 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          resolve(false)
          return
        }
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          raw += chunk
          if (raw.length > 4096) req.destroy()
        })
        res.on('end', () => {
          try {
            const body = JSON.parse(raw) as { ok?: unknown; service?: unknown }
            resolve(body.service === 'tlmemory' || body.ok === true)
          } catch {
            resolve(false)
          }
        })
      })
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.on('error', () => resolve(false))
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
    // P0-1 安全基线（保留）：CORS 绝不是无差别敞开 —— 仅对通过回环白名单校验的 Origin
    // 回写 ACAO 具体值，绝不使用通配符 `*`。白名单外网页发起的 fetch/DELETE 预检
    // 因拿不到 ACAO 头而必然失败，任意公网页面读写删记忆库的通道依旧封死。
    //
    // 白名单内跨源则是**必须**放行的合法场景：宿主页面（127.0.0.1:3080，另一端口
    // 即另一 Origin）的在线探针会 fetch http://127.0.0.1:4890/api/health，
    // 缺失 ACAO 时浏览器以 CORS policy 阻断响应，宿主将服务误判为离线并弹遮罩。

    // DNS rebinding 防御：普通 HTTP 请求与 WS upgrade 一致执行 Host 头白名单校验。
    // 恶意域名的 A 记录指向 127.0.0.1 时，浏览器发送的 Host 头是恶意域名本身，
    // 在此被直接拒绝。
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return
    }

    // 白名单命中的 Origin 回写 CORS 头（含后续 403/404/413 等业务响应一并携带，
    // 避免宿主探针把「服务在岗但端点报错」误读成 CORS 拦截）
    applyCorsHeaders(req, res)

    // CORS 预检（OPTIONS）：白名单内的 Origin 直接 204 结束，不进入任何业务路由；
    // 白名单外或畸形 Origin 明确回 403，不给「先探测再说」留余地。
    if (req.method === 'OPTIONS') {
      const origin = req.headers.origin
      if (origin !== undefined && resolveCorsOrigin(origin) === null) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Forbidden')
        return
      }
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const pathname = url.pathname

    try {
      // P2-1 轻量健康探针：客户端每 15s 轮询一次只为判断在线与否，
      // 绝不应拉全量节点表（几千节点 = 全表 dump + JSON 序列化的纯浪费）。
      // service 字段同时服务于端口冲突自愈：新实例 EADDRINUSE 时据此
      // 确认占用者是否为前序 tlmemory 同名进程。
      if (req.method === 'GET' && pathname === '/api/health') {
        this.sendJson(res, 200, { ok: true, service: 'tlmemory' })
        return
      }

      // 工程作用域清单：驱动看板下拉框，并回报宿主当前所在工程（默认选中项）。
      // 读取前先做一次自愈维护（幂等）：清掉「没有任何记忆文件」的历史遗留工程、
      // 清掉**不属于宿主合法工作区**的孤儿工程（以用户主目录启动而临时产生的工程、
      // 宿主已删除的历史目录）、消除同名工程；**豁免宿主当前正在打开的合法工作区**
      // （方案 B）—— 它零记忆时也保留，作为「当前工程就绪、可随时新建沉淀」的锚点。
      if (req.method === 'GET' && pathname === '/api/projects') {
        const registry = this.workspaceRegistry()
        const current = this.currentProject
        // 白名单校验（方案 B 锚点约束）：当前工程**只有本身属于宿主合法工作区**时
        // 才配得上「零记忆也保留」的豁免；非合法工作区即使被当作当前工程传入，
        // 也绝不呈现为锚点 —— 否则看板又会冒出一个本不该存在的工程。
        const currentAllowed =
          current !== undefined && (registry === null || registry.has(current.scope))
        const maintenance = this.db.maintainProjects({
          keepScope: currentAllowed ? current.scope : null,
          isScopeAllowed: registry === null ? null : (scope: string) => registry.has(scope),
        })
        if (maintenance.purgedScopes.length > 0) {
          this.logger?.info?.(
            `[tlmemory-server] 自动清理 ${maintenance.purgedScopes.length} 个工程（零记忆或不属于宿主合法工作区）: ${maintenance.purgedScopes.join(', ')}`,
          )
        }
        for (const change of maintenance.renamed) {
          this.logger?.warn?.(
            `[tlmemory-server] 工程重名自愈: ${change.scope} 「${change.from}」→「${change.to}」`,
          )
        }
        // 展示保证（方案 B）：当前活跃的合法工作区必须常驻清单（记忆数标记为 0），
        // 看板才能显示 `xxx (0)`、允许选中并切入空树后新建，形成「当前工程就绪」的锚点。
        // 正常路径它的登记项已被 keepScope 豁免保留；这里用幂等登记再兜一层 ——
        // 多宿主并存时另一宿主的维护周期不知道我们的活跃 scope，仍可能清掉它，
        // 而「scope 有记忆却没有登记项」的历史形态也会让工程名退化成裸哈希。
        if (currentAllowed && !this.db.hasProject(current.scope)) {
          this.db.registerProject(current.scope, current.name, current.root)
        }
        // 清单再按白名单过滤一层（纵深防御）：即便本轮维护因故没落库清理，
        // 也绝不把非合法工作区暴露给下拉框。
        const list =
          registry === null
            ? this.projectList(registry)
            : this.projectList(registry).filter((item) => registry.has(item.scope))
        this.sendJson(res, 200, {
          data: list,
          current: currentAllowed ? current.scope : null,
          currentName: currentAllowed ? current.name : null,
        })
        return
      }
      // 手工命名工程（把历史遗留的 repo:<hash> 改成可读名字）。
      // 唯一性闸门：目标名字被其它工程占用时返回 409 并指明占用者，
      // 不让看板出现两个同名工程（同名工程在界面上无法区分，按名解析也会歧义）。
      if (req.method === 'PATCH' && pathname === '/api/projects') {
        const body = await this.readBodyOr413(req, res)
        if (body === null) return
        const scope = typeof body.scope === 'string' ? body.scope : ''
        const name = typeof body.name === 'string' ? body.name : ''
        if (!scope || !name.trim()) {
          this.sendJson(res, 400, { error: 'scope 与 name 均为必填' })
          return
        }
        const owner = this.db.findProjectNameOwner(name.trim(), scope)
        if (owner !== null) {
          this.sendJson(res, 409, { error: this.nameConflictMessage(name.trim()) })
          return
        }
        if (!this.db.renameProject(scope, name)) {
          this.sendJson(res, 409, { error: '工程重命名失败：名称不可用' })
          return
        }
        this.sendJson(res, 200, { success: true, data: this.projectList() })
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
          const resolved = this.resolveProjectScopeParam(projectParam)
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
          const resolved = this.resolveProjectScopeParam(projectParam)
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
        // 与 PATCH /api/projects 同一道唯一性闸门（两个端点必须给出完全一致的语义）
        const owner = this.db.findProjectNameOwner(newName, resolved)
        if (owner !== null) {
          this.sendJson(res, 409, { error: this.nameConflictMessage(newName) })
          return
        }
        const success = this.db.renameProject(resolved, newName)
        if (!success) {
          this.sendJson(res, 409, { error: '工程重命名失败：名称不可用' })
          return
        }
        this.notifyTreeChanged(resolved)
        this.sendJson(res, 200, { success, data: this.projectList() })
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
          // 当前工程零记忆时不占登记表，这里必须能解析回它的 scope（否则第一条记忆建不出来）
          treeType = this.resolveProjectScopeParam(project) ?? project
          // 写入即登记：零记忆工程已被维护清理，一旦有记忆落库就必须重建登记项，
          // 否则看板只会拿到裸 scope 哈希当工程名。当前工程用可读名兜底。
          const isCurrent = treeType === this.currentProject?.scope
          this.db.registerProject(
            treeType,
            isCurrent ? (this.currentProject?.name ?? treeType) : treeType,
            isCurrent ? (this.currentProject?.root ?? null) : null,
          )
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
   * 工程重名冲突的可读提示（两个重命名端点共用）。
   *
   * 为什么只提「另一个工程」而不回显对方名字：唯一性是**按名字查得**的
   * （findProjectNameOwner 用 lower(name) 匹配），所以冲突对方的名字必然与所求
   * 名字相同 —— 回显只会变成「已被工程「X」占用」而 X 就是用户刚输入的那个名字，
   * 徒增困惑。这里改为点明冲突性质与下一步动作。
   */
  private nameConflictMessage(name: string): string {
    return `工程名「${name}」已被另一个工程占用（同名工程在界面上无法区分），请换一个名字`
  }

  /**
   * 解析 ?project= / ?scope= 里的工程标识为确定 scope。
   *
   * 先走登记表 / 节点的常规解析（findProjectScope）；解析不出来时，若它正是
   * **宿主当前工程的 scope 或名字**，则视为合法并指向当前工程。
   *
   * 为什么还要这层兜底：当前工程的登记项平时由 keepScope 豁免保留，但多宿主并存时
   * 另一宿主的维护周期可能清掉它（对方不知道我们的活跃 scope）。此时看板在自己工程上
   * 取树仍必须拿到**空树而不是 404**，否则「新建第一条记忆」的入口就断了。
   *
   * 注意顺序：常规解析优先，所以当前工程的名字若被另一个**有记忆**的工程占用，
   * 仍然解析到那个工程（不劫持），只有真的无从解析时才兜底到当前工程。
   */
  private resolveProjectScopeParam(key: string): string | null {
    const resolved = this.db.findProjectScope(key)
    if (resolved !== null) return resolved
    if (this.currentProject) {
      if (key === this.currentProject.scope || key === this.currentProject.name) {
        return this.currentProject.scope
      }
    }
    return null
  }

  /**
   * readJsonBody 的统一入口：超限时回 413 并**保持连接语义**（不做任何强断），
   * 返回 null 表示调用方必须立即终止处理。
   *
   * 413 投递可靠性加固（2026-09-16，实测数据见 tests/p2-fixes.spec.ts）：
   * 曾经的实现是 `res.end(..., () => req.destroy())`，意图「超限客户端不值得继续占用」，
   * 但这会让**响应字节与对端仍在途的请求体赛跑**：TCP 语义下 destroy() 在接收缓冲仍有
   * 未读数据时发出的是 RST 而非 FIN，RST 会让对端内核直接丢弃接收缓冲 —— 客户端因此
   * 拿到 ECONNRESET 而不是 413。压测实测（40×300KB / 20×8MB / 并发 24×600KB）：
   *   旧实现 300KB 失败 8/40，8MB 失败 20/20，并发 600KB 失败 24/24；
   *   仅去掉 req.destroy() 后 300KB 与 600KB 全通，但 8MB 仍失败 15/20
   *   —— 因为 `Connection: close` 会让 Node 在响应 finish 时立即 `destroySoon()`，
   *   与客户端在途请求体同样产生 RST；
   *   本实现（不强断、不声明 Connection: close）三个场景全部 0 失败。
   * 代价与兜底：超限请求体的剩余字节会被继续消费并丢弃（readJsonBody 在超限后即停止
   * 累积，内存占用仍严格封顶在 MAX_BODY_BYTES），连接资源由 Node 的 requestTimeout /
   * keepAliveTimeout 兜底回收，不再由本方法手工强断。
   */
  private async readBodyOr413(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | null> {
    const { body, tooLarge } = await this.readJsonBody(req)
    if (!tooLarge) return body
    // 显式保证剩余请求体继续被消费丢弃：既不阻塞对端写入，也避免连接停在半途
    req.resume()
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: `请求体超过 ${MAX_BODY_BYTES} 字节上限` }))
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