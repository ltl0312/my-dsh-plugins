// packages/tlmemory/tests/sqlite-driver.spec.ts
// 回归护栏（2026-10-05 桌面端事故）：
// 桌面端（Electron carrier）用 Electron 自带的 Node 跑宿主（Node v24.18.1 / ABI 149），
// 而 pnpm 是在系统 Node（ABI 137）下编译/预取原生模块的 —— better-sqlite3 因此在
// 宿主里 dlopen 失败（NODE_MODULE_VERSION 137 vs 149），插件激活不了、MemoryServer
// 起不来、看板显示「服务未启动」。本用例把两条契约钉死：
//   1) 依赖清单里不得再出现按 NODE_MODULE_VERSION 编译的 SQLite 驱动；
//   2) 宿主运行时必须真的具备本插件依赖的 SQLite 能力（FTS5 trigram / bm25 / pragma
//      读写两态 / 事务含嵌套 SAVEPOINT）。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/sqlite.js'

const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')

/** 按 NODE_MODULE_VERSION 编译、不能跨 Node/Electron 运行时的原生 SQLite 驱动 */
const ABI_BOUND_SQLITE_DRIVERS = ['better-sqlite3', 'sqlite3']

describe('SQLite 驱动契约（桌面端 ABI 事故回归护栏）', () => {
  it('依赖清单里不得出现 ABI 绑定的原生 SQLite 驱动', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ])
    for (const driver of ABI_BOUND_SQLITE_DRIVERS) {
      expect(declared.has(driver), `${driver} 是 ABI 绑定驱动，会在 Electron 宿主里加载失败`).toBe(false)
    }
    // 引擎必须是 Node 内置的 node:sqlite（v22.13+ 不再需要 --experimental-sqlite）
    expect(fs.existsSync(path.join(path.dirname(packageJsonPath), 'src', 'sqlite.ts'))).toBe(true)
  })

  it('宿主运行时的 node:sqlite 可开可关（open 状态可观测）', () => {
    const db = openDatabase(':memory:')
    expect(db.open).toBe(true)
    db.close()
    expect(db.open).toBe(false)
  })

  it('FTS5 trigram 分词与 bm25 排序在宿主运行时可用', () => {
    const db = openDatabase(':memory:')
    db.exec("CREATE VIRTUAL TABLE fts USING fts5(name, content, tokenize = 'trigram')")
    db.prepare('INSERT INTO fts (name, content) VALUES (?, ?)').run(
      'pnpm构建拦截',
      '原生C++模块需 approve-builds 放行',
    )

    // 与 MemoryDB.search() 同款：把查询包成短语，既规避 FTS5 语法注入又兼容中英混排
    const phrase = (query: string) => `"${query.replace(/"/g, '""')}"`

    const zh = db.prepare('SELECT name, bm25(fts) AS b FROM fts WHERE fts MATCH ? ORDER BY bm25(fts)').all(phrase('原生C++'))
    expect(zh).toHaveLength(1)
    expect(zh[0].name).toBe('pnpm构建拦截')
    expect(Number(zh[0].b)).toBeLessThanOrEqual(0)

    const en = db.prepare('SELECT name FROM fts WHERE fts MATCH ?').all(phrase('approve-builds'))
    expect(en).toHaveLength(1)
    db.close()
  })

  it('pragma 的写入/读取两态与原有语义一致', () => {
    const db = openDatabase(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)')
    expect(db.pragma('journal_mode = WAL')).toBeUndefined()
    expect(db.pragma('busy_timeout = 5000')).toBeUndefined()
    const info = db.pragma('table_info(t)') as Array<{ name: string }>
    expect(info.map((column) => column.name)).toEqual(['id', 'name', 'note'])
    db.close()
  })

  it('事务：提交 / 回滚 / 嵌套 SAVEPOINT，且行对象是普通对象', () => {
    const db = openDatabase(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    const insert = db.prepare('INSERT INTO t (name) VALUES (?)')
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }

    expect(db.transaction(() => insert.run('a'))()).toBeDefined()
    expect(db.transaction(() => {
      insert.run('outer')
      return db.transaction(() => {
        insert.run('inner')
        return 'nested'
      })()
    })()).toBe('nested')
    expect(count().n).toBe(3)

    const row = db.prepare('SELECT name FROM t WHERE name = ?').get('a')
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype)

    const boom = db.transaction(() => {
      insert.run('rolled-back')
      throw new Error('rollback me')
    })
    expect(() => boom()).toThrow('rollback me')
    expect(count().n).toBe(3)
    expect(db.prepare('SELECT name FROM t WHERE name = ?').get('rolled-back')).toBeUndefined()
    db.close()
  })
})
