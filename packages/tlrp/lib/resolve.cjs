'use strict'

/**
 * 在不引入任何依赖的前提下解析宿主的 `@deepseek-ai/schemastery`。
 *
 * 为什么需要它：插件可能以 `file:` / `link:`（软链）方式装进 profile，
 * 也可能被 pnpm 实体拷贝到 `<profile>/node_modules/dsh-plugin-tlrp`。前者按
 * realpath 解析，裸 import 找不到宿主依赖；后者可以。这里按「自身 → 当前
 * profile → 已知 profile → profile 级 node_modules」的顺序逐个尝试，
 * 全部失败时返回 undefined，插件退化为「无 Config schema」仍可运行。
 */

const { createRequire } = require('node:module')
const path = require('node:path')
const os = require('node:os')

const SPECIFIER = '@deepseek-ai/schemastery'

/** 可能的解析基点（package.json 或任意文件路径）。 */
function candidateBases() {
  const bases = []
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim()) bases.push(path.join(profileDir, 'package.json'))
  const home = os.homedir()
  const profile = process.env.DSH_PROFILE
  if (typeof profile === 'string' && profile.trim()) bases.push(path.join(home, '.dsh', 'profiles', profile, 'package.json'))
  for (const known of ['desktop', 'web', 'default']) {
    bases.push(path.join(home, '.dsh', 'profiles', known, 'package.json'))
  }
  bases.push(path.join(home, '.dsh', 'profiles', 'node_modules', 'noop.js'))
  return bases
}

/**
 * 尝试解析 schemastery。
 * @param {NodeRequire} [fallbackRequire] 调用方自带的 require（CJS 入口直接传 require）
 * @returns {{ z: any, attempts: string[], source: string }}
 */
function loadSchemastery(fallbackRequire) {
  const attempts = []

  const attempt = (loader, label) => {
    try {
      const mod = loader(SPECIFIER)
      const z = mod && (mod.default ?? mod)
      if (z && typeof z.object === 'function') return z
      attempts.push(`${label}: 导出里没有 object()`)
    } catch (error) {
      attempts.push(`${label}: ${(error && (error.code || error.message)) || error}`)
    }
    return undefined
  }

  if (typeof fallbackRequire === 'function') {
    const direct = attempt(fallbackRequire, 'self')
    if (direct) return { z: direct, attempts, source: 'self' }
  }

  for (const base of candidateBases()) {
    let req
    try {
      req = createRequire(base)
    } catch (error) {
      attempts.push(`${base}: ${(error && error.message) || error}`)
      continue
    }
    const found = attempt(req, base)
    if (found) return { z: found, attempts, source: base }
  }

  return { z: undefined, attempts, source: '(none)' }
}

module.exports = { loadSchemastery, candidateBases, SPECIFIER }
