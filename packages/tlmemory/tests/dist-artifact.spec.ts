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

  // 1.0.0 起设置页是配置的唯一入口，产物里少了这两样，用户面板直接空白：
  //   1) Config 必须仍有 toJSON（dsh-settings/lib/index.js:538-541 会检查）；
  //   2) 每个字段必须带 meta.volatile = true（同文件 :122-131 只收 volatile 叶子，
  //      :153-158 写入时逐路径复核）。打包器如果把 meta 合并丢了，源码测试看不出来。
  it('产物导出的 Config 可 toJSON，且六个字段都带 volatile 标记', async () => {
    const mod = (await import(pathToFileURL(esmFile).href)) as Record<string, unknown>
    const Config = mod.Config as { toJSON?: () => unknown } | undefined
    expect(typeof Config?.toJSON, 'ESM 产物必须导出带 toJSON 的 Config').toBe('function')
    const json = Config!.toJSON!() as {
      uid: number
      refs: Record<string, { meta?: Record<string, unknown>; dict?: Record<string, number> }>
    }
    const root = json.refs[String(json.uid)]
    const dict = root?.dict ?? {}
    expect(Object.keys(dict).sort()).toEqual(
      ['compactionInterval', 'dbPath', 'enableAutoMerge', 'enableAutoReflection', 'maxRecallCount', 'serverPort'].sort(),
    )
    for (const [key, uid] of Object.entries(dict)) {
      expect(json.refs[String(uid)]?.meta?.volatile, `产物里的字段 ${key} 必须 volatile`).toBe(true)
    }
    // 能被 JSON 往返（宿主会把它塞进 describe 响应）
    expect(() => JSON.stringify(json)).not.toThrow()
  })
})

// 客户端产物契约（packages/tlmemory/scripts/build-client.mjs 的产物）：
//   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => {...} })
// id 必须等于 package.json 的 name —— 宿主按条目 id 加载客户端模块，写成旧名字
// （历史事故里的 tlmemory-runtime）就会「插件在、客户端不在」。
const clientFile = path.join(packageDir, 'web', 'client.js')
const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
  name: string
  version: string
  dsh?: { client?: { platform?: string; inject?: string[] } }
}

const clientBuilt = fs.existsSync(clientFile)
const maybeClientDescribe = clientBuilt ? describe : describe.skip

maybeClientDescribe('客户端产物契约', () => {
  const source = clientBuilt ? fs.readFileSync(clientFile, 'utf8') : ''

  it('走 __ModuleLoader__.load 且 id 等于包名', () => {
    expect(source).toContain('__ModuleLoader__')
    expect(source).toMatch(/__ModuleLoader__\s*\.\s*load\s*\(/)
    expect(source).toContain(JSON.stringify(pkg.name))
    // 历史旧 id 不得再出现（0.6.x 的双挂载事故）
    expect(source).not.toContain('tlmemory-runtime')
  })

  it('factory 形态正确：可 require 宿主共享模块', () => {
    expect(source).toMatch(/factory\s*:\s*\(\s*require\s*\)\s*=>/)
  })

  it('清单声明的客户端注入与模块导出一致（含设置面板所需服务）', () => {
    expect(pkg.dsh?.client?.platform).toBe('web')
    // remote.settings 是设置页写配置的通道；reason：0.2.1 客户端 ctx 是白名单代理，
    // 少声明一项就取不到（取不到即抛，面板会空转），所以这里必须逐项锁死。
    expect(pkg.dsh?.client?.inject).toEqual(['slots', 'locale', 'remote', 'remote.settings'])
  })

  it('设置页分区已打进产物（settings.section + locale 命名空间）', () => {
    // 压缩后字符串仍以字面量存在：插槽名与词典命名空间是宿主的契约字符串
    expect(source).toContain('settings.section')
    expect(source).toContain('settings.tlmemory')
    expect(source).toContain('dsh-plugin-tlmemory')
  })

  it('发布白名单包含客户端产物与挂载补丁（缺失即装不上/加载不到）', () => {
    const files = (JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { files?: string[] })
      .files
    expect(files).toContain('web/client.js')
    expect(files).toContain('cordis.patch.yml')
    expect(files).toContain('dist')
  })
})
