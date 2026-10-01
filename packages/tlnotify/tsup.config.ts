import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // 两个 IM SDK 都必须是 external：
  //   - @tencent-connect/qqbot-nodejs 是正式 dependency（打包会把它整棵协议实现塞进产物）
  //   - @larksuiteoapi/node-sdk 是 optionalDependency，运行时才动态 import() 懒加载
  // cordis / schemastery 只在编译期使用（schemastery 被 tsup 内联，与 tlsearch 保持一致）。
  external: ['@tencent-connect/qqbot-nodejs', '@larksuiteoapi/node-sdk', 'cordis'],
})
