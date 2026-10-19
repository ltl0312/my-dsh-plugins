// packages/tlsearch/src/client/entry.ts
//
// esbuild 的打包入口。只做转发：产物是 IIFE，`build-client.mjs` 会把
// `__tlsearch_client_exports` 交还给宿主 shell 的 `require` 工厂。

export { apply, inject } from './index.js'
