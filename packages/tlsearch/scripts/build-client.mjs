// scripts/build-client.mjs
//
// 把 `src/client/*` 打成一个 DSH 客户端模块，落到 `web/client.js`。
//
// 产物必须遵守客户端的模块加载协议（见 @deepseek-ai/dsh-client-modules）：
//
//   window.__ModuleLoader__.load({
//     id: '<包名>',
//     factory: (require) => ({ apply, inject }),
//   })
//
// `id` **必须等于包名**，否则宿主无法把 `dsh.client` 声明的依赖图对上号，加载时会报
//   bundle <url> loaded without registering "<id>" via __ModuleLoader__.load
//
// `factory` 的 `require` 参数由 shell 注入，所以 `react` 保持 external：客户端 bundle
// 里 React 只有一份，必须是 shell 的那份（否则 hooks 会炸在「invalid hook call」上，
// 而且报错完全指不到这里）。`dsh.client.external` 里也声明了同名 external。
//
// 本脚本跑完会顺手做两件事（省得等到宿主里才发现）：
//  1. 断言产物里出现 `__ModuleLoader__.load` 且 id 就是包名；
//  2. 断言产物里没有 `require("node:…")` 之类的 Node 内置引用。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const pkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
const PACKAGE_NAME = pkgJson.name
const OUT_FILE = join(pkgRoot, 'web', 'client.js')
const GLOBAL_NAME = '__tlsearch_client_exports'

/** esbuild 解析：优先走 node_modules 链，失败时回退 pnpm store 目录。 */
function resolveEsbuildPath() {
  try {
    return createRequire(import.meta.url).resolve('esbuild')
  } catch {
    const store = join(pkgRoot, '..', '..', 'node_modules', '.pnpm')
    if (!existsSync(store)) throw new Error('esbuild 不可用：pnpm store 缺失')
    for (const dir of readdirSync(store)) {
      if (!dir.startsWith('esbuild@')) continue
      const candidate = join(store, dir, 'node_modules', 'esbuild')
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
    throw new Error('esbuild 不可用：请先在仓库根执行 pnpm install')
  }
}

const esbuildPath = resolveEsbuildPath()
// 按绝对路径加载 esbuild（绕过 pnpm 的严格链接）；Windows 绝对路径要转 file:// URL。
const esbuildModule = await import(pathToFileURL(esbuildPath).href)
const esbuildBuild = esbuildModule.default?.build ?? esbuildModule.build
if (typeof esbuildBuild !== 'function') throw new Error('esbuild 加载失败: ' + esbuildPath)

const result = await esbuildBuild({
  entryPoints: [join(pkgRoot, 'src', 'client', 'entry.ts')],
  bundle: true,
  format: 'iife',
  globalName: GLOBAL_NAME,
  platform: 'browser',
  target: 'es2020',
  // 经典 JSX 变换（`React.createElement`），与 tsconfig.client.json 的 `"jsx": "react"`
  // 对齐：这样产物里唯一的裸 require 就是 `react`。
  jsx: 'transform',
  external: ['react'],
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  write: false,
})

const iifeCode = result.outputFiles[0].text

const bundle = `// GENERATED FILE — DO NOT EDIT BY HAND.
// Source: packages/tlsearch/src/client/*  |  Build: pnpm build:client
// DSH client-module boot registration protocol (see dsh-client-modules).
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_NAME)},
  factory: (require) => {
${iifeCode
  .split('\n')
  .map((line) => '    ' + line)
  .join('\n')}
    return ${GLOBAL_NAME};
  }
});
`

// ── 产物自检：宁可在这里失败，也不要等宿主在浏览器里报一句天书 ──────────────
const problems = []
if (!bundle.includes('window.__ModuleLoader__.load(')) problems.push('缺少 window.__ModuleLoader__.load 调用')
if (!bundle.includes(`id: "${PACKAGE_NAME}"`)) problems.push(`注册 id 不是包名 ${PACKAGE_NAME}`)
if (!bundle.includes(`return ${GLOBAL_NAME};`)) problems.push(`工厂没有返回 ${GLOBAL_NAME}`)
for (const builtin of ['node:fs', 'node:path', 'node:module', 'node:process']) {
  if (bundle.includes(`require("${builtin}")`) || bundle.includes(`require('${builtin}')`)) {
    problems.push(`产物里出现了 Node 内置模块 ${builtin}`)
  }
}
if (problems.length > 0) {
  throw new Error('[build-client] 产物不符合客户端模块协议:\n  - ' + problems.join('\n  - '))
}

mkdirSync(dirname(OUT_FILE), { recursive: true })
writeFileSync(OUT_FILE, bundle, 'utf8')
console.log(
  `[build-client] 已生成 ${OUT_FILE} (${Buffer.byteLength(bundle)} bytes, id=${PACKAGE_NAME})`,
)
