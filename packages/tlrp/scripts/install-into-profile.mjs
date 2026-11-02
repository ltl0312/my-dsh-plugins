#!/usr/bin/env node
/**
 * 把一个 profile 目录装成「tlrp 可用」状态（幂等）。
 *
 * 做三件事（都带幂等判断，可反复运行）：
 *   1. 把包文件复制到 <profile>/node_modules/dsh-plugin-tlrp（实体目录，
 *      这样插件才能从 profile 级 node_modules 解析到 @deepseek-ai/schemastery）；
 *   2. 在 <profile>/package.json 里补 dependencies 条目与 dsh.profile.bundles 条目；
 *   3. 在 <profile>/cordis.patch.yml 末尾补 `- id: tlrp` 配置块。
 *
 * 为什么不用 `dsh plugin add` / pnpm：profile 目录里跑 pnpm 会被正在运行的宿主
 * 锁住文件（Windows 上表现为 ERR_PNPM_EPERM importPackage），而 tlrp 没有任何
 * 运行期依赖需要 pnpm 解析 —— 它只用宿主已有的 @deepseek-ai/schemastery。
 * 需要 lockfile 一致时，停掉宿主后再跑一次 `pnpm install` 即可。
 *
 * 用法：
 *   node scripts/install-into-profile.mjs --profile-dir ~/.dsh/profiles/desktop
 *   node scripts/install-into-profile.mjs --profile-dir /root/.dsh/profiles/web
 *   node scripts/install-into-profile.mjs --profile-dir ... --check   # 只报告，不写
 */

import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))

const PACKAGE_NAME = manifest.name
const ENTRY_ID = 'tlrp'
// package.json 是 bundle 解析的锚点，无论 files 列表怎么写都必须复制
const FILES = ['package.json', ...(manifest.files ?? [
  'package.json',
  'index.js',
  'index.cjs',
  'lib/core.cjs',
  'lib/schema.cjs',
  'lib/resolve.cjs',
  'lib/memory-bridge.cjs',
  'cordis.patch.yml',
  'locale/*.json',
  'icon.svg',
  'README.md',
])]

const args = process.argv.slice(2)
const readFlag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const checkOnly = args.includes('--check')
const profileDirArg = readFlag('--profile-dir') ?? readFlag('-p')

if (!profileDirArg) {
  console.error('用法：node scripts/install-into-profile.mjs --profile-dir <profile 目录> [--check]')
  process.exit(2)
}

const profileDir = path.resolve(profileDirArg.replace(/^~(?=$|\/)/, homedir()))
if (!existsSync(path.join(profileDir, 'package.json'))) {
  console.error(`不是 profile 目录（缺少 package.json）：${profileDir}`)
  process.exit(2)
}

const report = []
const note = (line) => {
  report.push(line)
  console.log(line)
}

/* ── 1. 复制包文件 ── */
const targetDir = path.join(profileDir, 'node_modules', PACKAGE_NAME)
if (!checkOnly) {
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  const missing = []
  for (const entry of FILES) {
    if (entry.includes('*')) {
      const dir = path.dirname(entry)
      const base = path.join(packageRoot, dir)
      if (!existsSync(base)) continue
      for (const name of require('node:fs').readdirSync(base)) {
        const rel = path.join(dir, name)
        const to = path.join(targetDir, rel)
        mkdirSync(path.dirname(to), { recursive: true })
        cpSync(path.join(packageRoot, rel), to)
      }
      continue
    }
    const from = path.join(packageRoot, entry)
    if (!existsSync(from)) {
      missing.push(entry)
      continue
    }
    const to = path.join(targetDir, entry)
    mkdirSync(path.dirname(to), { recursive: true })
    cpSync(from, to)
  }
  note(`[1/3] 已复制包文件 → ${targetDir}${missing.length ? `（缺失：${missing.join(', ')}）` : ''}`)
} else {
  note(`[1/3] 跳过复制（--check）：目标 ${targetDir}${existsSync(targetDir) ? ' 已存在' : ' 不存在'}`)
}

/* ── 2. package.json：dependencies + dsh.profile.bundles ── */
const profileJsonPath = path.join(profileDir, 'package.json')
const profileJsonText = readFileSync(profileJsonPath, 'utf8')
const profileJson = JSON.parse(profileJsonText)
const indentMatch = /^([ \t]+)"/m.exec(profileJsonText)
const indent = indentMatch ? indentMatch[1] : '  '
const dependencySpec = `file:${packageRoot.replace(/\\/g, '/')}`
profileJson.dependencies ??= {}
profileJson.dsh ??= {}
profileJson.dsh.profile ??= {}
profileJson.dsh.profile.bundles ??= []

const depChanged = profileJson.dependencies[PACKAGE_NAME] !== dependencySpec
const bundleChanged = !profileJson.dsh.profile.bundles.includes(PACKAGE_NAME)
profileJson.dependencies[PACKAGE_NAME] = dependencySpec
if (bundleChanged) profileJson.dsh.profile.bundles.push(PACKAGE_NAME)

if (!checkOnly && (depChanged || bundleChanged)) {
  // 改前留一份带时间戳的备份（profile 可能被 plugin manager 同时管理）
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  writeFileSync(`${profileJsonPath}.bak-tlrp-${stamp}`, profileJsonText, 'utf8')
  writeFileSync(profileJsonPath, `${JSON.stringify(profileJson, null, indent)}\n`, 'utf8')
}
note(
  `[2/3] package.json ${depChanged || bundleChanged ? '已更新' : '无需改动'}：dependencies["${PACKAGE_NAME}"]="${dependencySpec}"，bundles ${bundleChanged ? '已追加' : '已包含'}`,
)

/* ── 3. cordis.patch.yml：追加 - id: tlrp ── */
const patchPath = path.join(profileDir, 'cordis.patch.yml')
let patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
const alreadyPatched = new RegExp(`^- id:\\s*${ENTRY_ID}\\s*$`, 'm').test(patchText)

const block = [
  '',
  `# ── ${ENTRY_ID}：双态路由与角色扮演核心（install-into-profile.mjs 写入） ──`,
  '# 行 id 必须是 tlrp：它同时是设置命名空间（settings.mutate("tlrp", ops)）与',
  '# 插件配置 activeProfileEntryId 的默认值。',
  `- id: ${ENTRY_ID}`,
  '  config:',
  '    mode: auto',
  '    activeCharacterId: firefly',
  '    enableStatusFooter: true',
  '    blockShellToolsInRp: true',
  '    timeZone: Asia/Shanghai',
  '    coreSectionOrder: 10150',
  '    contextOrder: 300',
  '',
].join('\n')

if (!checkOnly && !alreadyPatched) {
  if (patchText.length > 0 && !patchText.endsWith('\n')) patchText += '\n'
  writeFileSync(patchPath, patchText + block, 'utf8')
}
note(`[3/3] cordis.patch.yml ${alreadyPatched ? '已包含 tlrp 行（未改动）' : checkOnly ? '需要追加 tlrp 行' : '已追加 tlrp 行'}`)

console.log('')
console.log(`profile：${profileDir}`)
console.log(`条目 id：${ENTRY_ID}（设置命名空间同名）`)
console.log('下一步：重启该 profile 的宿主进程（插件 JS 不做热更新），然后：')
console.log(`  dsh --profile <name> --dump-config | grep -A 3 "${ENTRY_ID}"`)
