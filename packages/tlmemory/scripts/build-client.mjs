// scripts/build-client.mjs
// 构建 DSH 客户端插件捆绑包：src/client/* → web/client.js。
// 产物遵循 DSH 客户端模块加载协议：
//   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => exports })
// 其中 react / react/jsx-runtime / @deepseek-ai/dsh-client-ui-primitives 为
// shell 静态模块表名称，必须保持 external（工厂内以 require() 解析）。
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const pkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
const PACKAGE_NAME = pkgJson.name
const OUT_FILE = join(pkgRoot, 'web', 'client.js')

// esbuild 解析：优先走 node_modules 链，失败时回退 pnpm store 目录
function resolveEsbuildPath() {
  try {
    return createRequire(import.meta.url).resolve('esbuild')
  } catch {
    const store = join(pkgRoot, '..', '..', 'node_modules', '.pnpm')
    if (!existsSync(store)) throw new Error('esbuild 不可用：pnpm store 缺失')
    const candidates = []
    for (const dir of readdirSync(store)) {
      if (dir.startsWith('esbuild@')) candidates.push(join(store, dir, 'node_modules', 'esbuild'))
    }
    for (const candidate of candidates) {
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
    throw new Error('esbuild 不可用：请先在 packages/tlmemory 执行 pnpm install')
  }
}

const esbuildPath = resolveEsbuildPath()
// 按包绝对路径加载 esbuild（绕过 pnpm 严格链接）；Windows 绝对路径需转 file:// URL
const esbuildModule = await import(pathToFileURL(esbuildPath).href)
const esbuildBuild = esbuildModule.default?.build ?? esbuildModule.build
if (typeof esbuildBuild !== 'function') throw new Error('esbuild 加载失败: ' + esbuildPath)

const result = await esbuildBuild({
  entryPoints: [join(pkgRoot, 'src', 'client', 'entry.ts')],
  bundle: true,
  format: 'iife',
  globalName: '__tlmemory_client_exports',
  platform: 'browser',
  target: 'es2020',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  write: false,
})

const iifeCode = result.outputFiles[0].text

// 组装 DSH 客户端加载协议：factory 接收 shell 注入的 require，
// IIFE 内部的 require("react") 等调用在运行时解析到该参数。
const bundle = `// GENERATED FILE — DO NOT EDIT BY HAND.
// Source: packages/tlmemory/src/client/*  |  Build: pnpm build:client
// DSH client-module boot registration protocol (see dsh-client-modules).
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_NAME)},
  factory: (require) => {
${iifeCode
    .split('\n')
    .map((line) => '    ' + line)
    .join('\n')}
    return __tlmemory_client_exports;
  }
});
`

writeFileSync(OUT_FILE, bundle, 'utf8')
console.log(`[build-client] 已生成 ${OUT_FILE} (${Buffer.byteLength(bundle)} bytes)`)
