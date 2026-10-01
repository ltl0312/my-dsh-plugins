// packages/tlnotify/src/client/entry.ts
//
// 客户端 bundle 的入口。构建产物落在 `web/client.js`（见 scripts/build-client.mjs）。
//
// 这里只做转出：esbuild 用 `format: 'iife'` + `globalName: '__tlnotify_client_exports'`
// 把本模块的导出挂到那个全局名上，构建脚本再手工包一层
// `window.__ModuleLoader__.load({ id: 'dsh-plugin-tlnotify', factory })`。

export { apply, inject } from './index.js'
