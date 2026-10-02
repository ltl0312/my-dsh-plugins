// packages/tlnotify/src/client/rpc.ts
//
// 设置页 → 宿主的调用面。
//
// 走宿主原生的 `ctx.get('connection').rpc.call('/api', 'tlnotify/<method>', …)`：鉴权、
// Origin 校验、只允许 loopback 全在 Connection 里，插件不自己再实现一遍 HTTP 路由
// （实现一遍就多一处漏）。宿主侧的对应端点是 `connection.fetch.register` 注册的
// `/api/tlnotify/<method>`——见 `src/index.ts` 的 `#installRpc` 注释。
//
// 这里只做两件宿主不做的事：
//   ① 连接不可用时给出**可读**的失败，而不是让页面炸在取不到 `connection` 上；
//   ② 把宿主抛出来的异常规整成和正常失败同一形状的 `RpcResult`，让调用点只处理一种返回。

import { RPC_API_CHANNEL, rpcEndpoint, type RpcMethod, type RpcResult } from '../protocol.js'
import type { ClientContextLike, ConnectionLike, ConnectionRpcLike } from './host.js'

export interface ClientRpc {
  /** 宿主是否提供了 RPC 通道。false 时页面应进入只读态。 */
  readonly available: boolean
  call<T>(method: RpcMethod, payload?: unknown): Promise<RpcResult<T>>
}

const NO_CONNECTION: RpcResult<never> = {
  ok: false,
  error: {
    code: 'no-connection',
    message: '浏览器没有连上宿主，这一页现在只能看，不能改。',
    details: {},
  },
}

export function createClientRpc(ctx: ClientContextLike): ClientRpc {
  // **每次调用时现读**，而不是创建时抓一次：客户端的 Connection 服务可能比我们的
  // 插件晚就位（或者中途重连被换掉），创建时抓一次会让页面永远停在只读态。
  //
  // ⚠️ 必须走 `ctx.get('connection')`，**不能写 `ctx.connection`**：客户端的 ctx 是
  // 白名单代理，没在 `inject` 里声明的服务名会**直接抛**（`?.` 挡不住抛异常的
  // getter）。这一抛就变成 effect 里 `void reload()` 的未处理拒绝，页面永远停在
  // 「正在读取配置…」——正是实机踩到的那个坑。详见 `host.ts` 的 `get` 字段注释。
  // 整段再包一层 try/catch 兜底：取不到就当作没连上，页面进只读态而不是转圈。
  const read = (): ConnectionRpcLike | undefined => {
    try {
      const queried = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      const service = (queried ?? ctx.connection) as ConnectionLike | undefined
      const rpc = service?.rpc
      return typeof rpc?.call === 'function' ? rpc : undefined
    } catch {
      return undefined
    }
  }

  return {
    get available(): boolean {
      return typeof read()?.call === 'function'
    },
    async call<T>(method: RpcMethod, payload: unknown = {}): Promise<RpcResult<T>> {
      const rpc = read()
      if (!rpc || typeof rpc.call !== 'function') return NO_CONNECTION as RpcResult<T>

      let raw: unknown
      try {
        raw = await rpc.call(RPC_API_CHANNEL, rpcEndpoint(method), payload)
      } catch (error) {
        const failure = error as { code?: unknown; message?: unknown; details?: unknown }
        return {
          ok: false,
          error: {
            code: typeof failure?.code === 'string' ? failure.code : 'transport',
            message:
              typeof failure?.message === 'string' && failure.message.length > 0
                ? failure.message
                : '和宿主的连接断开了，请刷新页面重试。',
            details: isRecord(failure?.details) ? failure.details : {},
          },
        }
      }

      // 宿主侧处理器可能返回任意结构（它只承诺 `unknown`）。形状不对时宁可明确报错，
      // 也不要让 undefined 一路漂到渲染层变成一个空白页。
      if (!isRecord(raw) || typeof raw.ok !== 'boolean') {
        return {
          ok: false,
          error: { code: 'bad-response', message: '宿主返回了无法识别的响应。', details: {} },
        }
      }
      if (raw.ok === false) {
        const error = isRecord(raw.error) ? raw.error : {}
        return {
          ok: false,
          error: {
            code: typeof error.code === 'string' ? error.code : 'unknown',
            message: typeof error.message === 'string' ? error.message : '宿主没有说明失败原因。',
            details: isRecord(error.details) ? error.details : {},
          },
        }
      }
      return { ok: true, value: raw.value as T }
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
