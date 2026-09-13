// packages/tlmemory/src/server.ts
// 阶段二桩实现：先满足宿主装配联动的生命周期接口（start / stop / broadcastHits / notifyTreeChanged）。
// 完整的嵌入式 REST 与 WebSocket 实时中继服务在阶段三落地，
// 届时将严格绑定 127.0.0.1 回环地址并执行 Origin / Host 白名单校验（CVE-2026-82533 回环穿透防御）。
import type { MemoryDB } from './db.js'

export class MemoryServer {
  constructor(
    private db: MemoryDB,
    private port: number = 4890,
    private logger?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
  ) {}

  public start(): void {
    this.logger?.info?.(`[tlmemory-server] 桩模式启动（阶段三将落地 http://127.0.0.1:${this.port} 回环服务）`)
  }

  public stop(): void {
    this.logger?.info?.('[tlmemory-server] 桩模式停止，无网络句柄残留')
  }

  public broadcastHits(treeType: string, hitNodeIds: string[]): void {
    // 阶段三：经 WebSocket 向侧边栏广播 MEMORY_HITS 微光感知事件
    this.logger?.info?.(`[tlmemory-server] 命中感知广播 (${treeType}): ${hitNodeIds.length} 条`)
  }

  public notifyTreeChanged(treeType: string): void {
    // 阶段三：经 WebSocket 向侧边栏广播 TREE_CHANGED 树变更通知
    this.logger?.info?.(`[tlmemory-server] 树变更通知 (${treeType})`)
  }
}