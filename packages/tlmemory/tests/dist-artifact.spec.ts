// packages/tlmemory/tests/dist-artifact.spec.ts
// 产物级护栏（2026-10-05）：
// 源码级测试跑的是 src/**，**不会**经过打包器，因此看不见打包器对模块说明符的改写。
// 实测 tsup 默认 `removeNodeProtocol: true` 会把 `node:sqlite` 剥成裸 `sqlite`，
// 而裸 `sqlite` 不是 Node 内置模块（只有带前缀的 `node:sqlite` 才是）——
// 产物一加载就 `ERR_MODULE_NOT_FOUND: Cannot find package 'sqlite'`，
// 300 条源码测试全绿也照样漏过。本用例直接拿 dist 说话：
//   1) 两个入口的文本里必须是带前缀的 `node:sqlite`；
//   2) 两个入口都必须真的能被加载，并且驱动能跑通一次写入 + FTS5 检索。
import { beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(packageDir, 'dist')
const esmFile = path.join(distDir, 'index.js')
const cjsFile = path.join(distDir, 'index.cjs')

/** dist 由 `pnpm run build` 生成；未构建时跳过（CI 的发布路径一定会先构建） */
const built = fs.existsSync(esmFile) && fs.existsSync(cjsFile)
const maybeDescribe = built ? describe : describe.skip

interface ProbedMemoryDb {
  upsertLeaf(treeType: string, pathSegments: string[], name: string, content: string, keywords: string[]): unknown
  search(query: string): Array<{ bm25_rank: number }>
  close(): void
}

function probeDriver(label: string, mod: Record<string, unknown>): void {
  const MemoryDB = mod.MemoryDB as (new (p?: string) => ProbedMemoryDb) | undefined
  expect(typeof MemoryDB, `${label} 必须导出 MemoryDB`).toBe('function')
  const db = new (MemoryDB as new (p?: string) => ProbedMemoryDb)(':memory:')
  try {
    db.upsertLeaf('repo:probe', ['探针'], '驱动可用', 'node:sqlite 在产物里可用', ['sqlite'])
    const hits = db.search('node:sqlite')
    expect(hits.length, `${label} 的 FTS5 检索应当命中刚写入的节点`).toBe(1)
    expect(hits[0].bm25_rank).toBe(1)
  } finally {
    db.close()
  }
}

maybeDescribe('产物契约（打包器改写 node: 前缀的回归护栏）', () => {
  beforeAll(() => {
    if (!built) {
      // 显式提示，避免「静默跳过」被误读成「已验证」
      console.warn('[dist-artifact] 未找到 dist 产物，请先 `pnpm run build` 后再跑本用例')
    }
  })

  it('ESM / CJS 入口都必须保留带前缀的 node:sqlite 说明符', () => {
    for (const file of [esmFile, cjsFile]) {
      const source = fs.readFileSync(file, 'utf8')
      expect(source, `${path.basename(file)} 应当保留 node:sqlite`).toContain('node:sqlite')
      // 裸 `sqlite` 不是内置模块：出现即说明前缀被剥掉，产物必然加载失败
      expect(source, `${path.basename(file)} 不应出现被剥掉前缀的裸 sqlite`).not.toMatch(
        /(from|require\()\s*["']sqlite["']/,
      )
    }
  })

  it('ESM 产物可加载且驱动可用', async () => {
    const mod = (await import(pathToFileURL(esmFile).href)) as Record<string, unknown>
    probeDriver('ESM 产物', mod)
  })

  it('CJS 产物可加载且驱动可用', () => {
    const require_ = createRequire(path.join(packageDir, 'package.json'))
    probeDriver('CJS 产物', require_(cjsFile) as Record<string, unknown>)
  })
})
