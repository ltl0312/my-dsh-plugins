/**
 * dsh-plugin-tlrp（ESM 入口）
 *
 * 实现源在 lib/core.cjs / lib/schema.cjs，index.cjs 与这里只做绑定，
 * 避免双入口出现两份会漂移的逻辑。
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const core = require('./lib/core.cjs')
const { buildConfig } = require('./lib/schema.cjs')
const { loadSchemastery } = require('./lib/resolve.cjs')

const plugin = core.createPlugin()

/** 解析 schemastery；失败时为 undefined（插件仍可运行，只是没有设置表单）。 */
const resolved = loadSchemastery(require)
if (!resolved.z) {
  console.warn(`[tlrp] 未能解析 @deepseek-ai/schemastery，设置表单将不可用；尝试记录：${resolved.attempts.join(' | ')}`)
}

export const Config = resolved.z ? buildConfig(resolved.z) : undefined

export const name = plugin.name

export const inject = []

export const apply = plugin.apply

export const __internals = core

export const __schemastery = { source: resolved.source, attempts: resolved.attempts }
