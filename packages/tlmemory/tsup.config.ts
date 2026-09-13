import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // 原生 C++ 模块严禁打入产物，必须在运行时从 node_modules 解析
  external: ['better-sqlite3'],
})
