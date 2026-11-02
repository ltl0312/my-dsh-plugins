'use strict'

/**
 * dsh-plugin-tlrp（CommonJS 入口）
 *
 * 与 index.js 等价：同一个实现源 `lib/core.cjs` + `lib/schema.cjs`。
 * 宿主用 `import()` 加载时走 index.js，用 `require()` 加载时走这里。
 */

const core = require('./lib/core.cjs')
const { buildConfig } = require('./lib/schema.cjs')
const { loadSchemastery } = require('./lib/resolve.cjs')

const plugin = core.createPlugin()

/** 解析 schemastery；失败时为 undefined（插件仍可运行，只是没有设置表单）。 */
const resolved = loadSchemastery(require)
if (!resolved.z) {
  console.warn(`[tlrp] 未能解析 @deepseek-ai/schemastery，设置表单将不可用；尝试记录：${resolved.attempts.join(' | ')}`)
}

const Config = resolved.z ? buildConfig(resolved.z) : undefined

const name = plugin.name
const inject = []

const apply = plugin.apply

module.exports = {
  name,
  inject,
  apply,
  Config,
  // 供测试与诊断使用
  __internals: core,
  __schemastery: { source: resolved.source, attempts: resolved.attempts },
}
