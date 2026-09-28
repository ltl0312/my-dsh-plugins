import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // 零运行时依赖：网络层直接用宿主 Node 的原生 fetch / AbortSignal，
  // 因此产物无需 external 任何三方模块（cordis / schemastery 仅在编译期使用）。
})
