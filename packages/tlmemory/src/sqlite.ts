// packages/tlmemory/src/sqlite.ts
// 持久层驱动边界：**唯一**一处知道底层 SQLite 引擎的文件。
//
// 为什么不用 better-sqlite3（2026-10-05 桌面端事故定因）：
// 桌面端（Electron carrier）是用 Electron 自带的 Node 跑宿主的
// （process.execPath + ELECTRON_RUN_AS_NODE=1 ⇒ Node v24.18.1，
// NODE_MODULE_VERSION 149），而 pnpm 是在系统 Node（v24.12.0，ABI 137）下
// 编译/预取 better-sqlite3 的 —— 于是宿主挂载本插件时 dlopen 直接失败：
//
//   was compiled against a different Node.js version using NODE_MODULE_VERSION 137.
//   This version of Node.js requires NODE_MODULE_VERSION 149.
//
// 插件激活失败 ⇒ MemoryServer 不启动 ⇒ 看板显示「服务未启动」。
// 这是「原生 ABI 绑定依赖 + 宿主运行时不同」的结构性问题，重建二进制只是本机补丁
// （下一次 pnpm install 又会用系统 Node 重新生成 137），所以这里换掉驱动本身：
// 改用 Node 内置的 node:sqlite（DatabaseSync）—— 零原生依赖、跨 Node/Electron 稳定。
//
// 版本要求：node:sqlite 自 v22.13.0 / v23.4.0 起不再需要 --experimental-sqlite，
// 自 v24.2.0 起不再 experimental（见 package.json 的 engines.node）。
//
// 本文件暴露的接口刻意与原先用到的 better-sqlite3 子集逐一对齐
// （prepare/exec/pragma/transaction/close/open），使 db.ts 的改动收敛为三行。
import { DatabaseSync, type StatementSync } from 'node:sqlite'

/** SQLite 可绑定的标量（与 node:sqlite 的 SupportedValueType 对齐） */
type Bindable = null | number | bigint | string | Uint8Array

/** 单条语句的写结果；与 better-sqlite3 的 RunResult 对齐（都收敛为 number） */
export interface SqlRunResult {
  changes: number
  lastInsertRowid: number
}

/** 预处理语句：只保留 db.ts 实际用到的三个读取/写入入口 */
export interface SqlStatement {
  run(...params: unknown[]): SqlRunResult
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Array<Record<string, unknown>>
}

/** 数据库连接：与 better-sqlite3 的 Database 在使用面上等价的子集 */
export interface SqlDatabase {
  prepare(sql: string): SqlStatement
  exec(sql: string): void
  /**
   * better-sqlite3 的 `pragma()` 一肩挑两职：带 `=` 的是写入
   * （`pragma('journal_mode = WAL')`），不带的是读取（`pragma('table_info(nodes)')`）。
   * 读取分支返回行数组，与 better-sqlite3 一致。
   */
  pragma(source: string): unknown
  /**
   * 事务包裹：返回一个可调用函数，与原 `db.transaction(fn)()` 用法一致。
   * 嵌套调用用 SAVEPOINT 降级（与 better-sqlite3 语义一致），
   * 这样「内部辅助方法误套事务」不会变成 "cannot start a transaction within a transaction"。
   */
  transaction<T>(fn: () => T): () => T
  close(): void
  readonly open: boolean
}

/**
 * `all()`/`get()` 返回的行在 node:sqlite 里是 `[Object: null prototype]`，
 * better-sqlite3 返回普通对象。这里统一归一化，避免下游断言/原型方法出现静默偏差。
 */
function plainRow(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row }
}

function adaptStatement(statement: StatementSync): SqlStatement {
  return {
    run(...params: unknown[]): SqlRunResult {
      const result = statement.run(...(params as Bindable[]))
      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      }
    },
    get(...params: unknown[]): Record<string, unknown> | undefined {
      const row = statement.get(...(params as Bindable[]))
      return row === undefined ? undefined : plainRow(row as Record<string, unknown>)
    },
    all(...params: unknown[]): Array<Record<string, unknown>> {
      return (statement.all(...(params as Bindable[])) as Array<Record<string, unknown>>).map(plainRow)
    },
  }
}

/** 打开（不存在则创建）一个 SQLite 库，接口与 better-sqlite3 使用面等价 */
export function openDatabase(file: string): SqlDatabase {
  const raw = new DatabaseSync(file)
  // 事务嵌套深度：0 表示当前没有本驱动开启的事务
  let depth = 0

  return {
    prepare(sql: string): SqlStatement {
      return adaptStatement(raw.prepare(sql))
    },
    exec(sql: string): void {
      raw.exec(sql)
    },
    pragma(source: string): unknown {
      if (source.includes('=')) {
        raw.exec(`PRAGMA ${source}`)
        return undefined
      }
      return raw.prepare(`PRAGMA ${source}`).all().map((row) => plainRow(row as Record<string, unknown>))
    },
    transaction<T>(fn: () => T): () => T {
      return (): T => {
        const nested = depth > 0
        const savepoint = nested ? `tlmemory_sp_${depth}` : ''
        depth += 1
        raw.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN')
        try {
          const result = fn()
          depth -= 1
          raw.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
          return result
        } catch (err) {
          depth -= 1
          try {
            raw.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK')
          } catch {
            // 回滚本身失败（例如连接已关闭）不能覆盖原始错误
          }
          throw err
        }
      }
    },
    close(): void {
      raw.close()
    },
    get open(): boolean {
      return raw.isOpen
    },
  }
}
