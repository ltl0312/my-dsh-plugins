import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // 三个 IM SDK 都必须是 external，运行时从 node_modules 解析（仓库范式：见
  // tlmemory 的 tsup.config.ts，运行时依赖一律不进产物）：
  //   - @tencent-connect/qqbot-nodejs  正式 dependency，QQ 通道的正向连接
  //   - @tencent-connect/qqbot-connector 正式 dependency，扫码创建 QQ 机器人
  //   - @larksuiteoapi/node-sdk  **可选**：没有声明进 package.json，用户自己
  //     `pnpm add` 之后飞书通道才可用；动态 import() 失败会给一句中文指引。
  // cordis / schemastery 只在编译期使用（schemastery 被 tsup 内联，与 tlsearch 保持一致）。
  external: [
    '@tencent-connect/qqbot-connector',
    '@tencent-connect/qqbot-nodejs',
    '@larksuiteoapi/node-sdk',
    'cordis',
  ],
})
