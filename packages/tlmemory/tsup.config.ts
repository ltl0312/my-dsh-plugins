import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // 运行时下限是 Node 22.13（node:sqlite），target 与之一致
  target: 'node22',
  // tsup 默认会剥掉 `node:` 前缀（removeNodeProtocol 默认 true）：
  // 实测 `node:sqlite` 被改写成裸 `sqlite`，而裸 `sqlite` 不是内置模块 ——
  // 产物一加载就 `ERR_MODULE_NOT_FOUND: Cannot find package 'sqlite'`，
  // 源码级测试全绿也照样漏过去（见 tests/dist-artifact.spec.ts 的护栏）。
  removeNodeProtocol: false,
  // WebSocket 库禁止打入产物，必须在运行时从 node_modules 解析；
  // SQLite 走 Node 内置的 node:sqlite（见 src/sqlite.ts），无第三方原生依赖。
  external: ['ws'],
})
