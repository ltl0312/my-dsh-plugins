// packages/tlmemory/src/client/entry.ts
// 客户端捆绑包入口：仅透出插件 apply/inject。
// 构建脚本（scripts/build-client.mjs）将其打成 IIFE 后，包裹进
// `window.__ModuleLoader__.load({ id, factory })` 注册协议，
// 产物落盘为 web/client.js，供 DSH 宿主 ClientModuleRegistry 静态服务。
export { apply, inject } from './index.js'
