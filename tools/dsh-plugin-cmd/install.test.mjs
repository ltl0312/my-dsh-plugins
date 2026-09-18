// tools/dsh-plugin-cmd/install.test.mjs
// 安装器单测：bin.js 补丁的锚定、幂等、可迁移性与语法有效性，外加一条
// 「锚点漂移」告警 —— 本机装了 dsh 时用真实的 bin.js 验证补丁仍然命中。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { pluginHelpText } from './core.mjs'
import { MODULE_MAP, patchBinJs, refreshHelpText, resolveDshDir } from './install.mjs'

/** 与官方 bin.js 同构的最小样本（关键锚点逐字取自真实文件） */
const UPSTREAM_FIXTURE = `import { Command } from "commander";
const collect = (value, previous = []) => [...previous, value];
function rejectElectronProfile(program, profile) {
	if (profile.toLowerCase() === "desktop") program.error("error: desktop is excluded");
}
function parseDshArgs(argv, version) {
	let resolved;
	const program = new Command();
	program.name("dsh").allowUnknownOption().passThroughOptions().enablePositionalOptions().argument("[args...]", "boot args").action((args, options) => {
		resolved = { mode: "profile", args };
	});
	const plugin = program.command("plugin").description("manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory");
	plugin.requiredOption("--profile <name>", "the profile whose plugins to manage (initialized on first use)").allowUnknownOption().argument("[args...]", "pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)").action((args, options) => {
		rejectParentOptions("plugin");
		if (options.profile === "") program.error("error: --profile needs a name");
		rejectElectronProfile(plugin, options.profile);
		if (args.length === 0) program.error("error: plugin needs pnpm arguments to forward (e.g. add <package>)");
		resolved = { mode: "plugin", profile: options.profile, args };
	});
	program.parse(argv, { from: "user" });
	return resolved;
}
async function runCli() {
	const invocation = parseDshArgs(process.argv.slice(2), "0.0.0");
	switch (invocation.mode) {
		case "plugin": {
			const { runPlugin } = await import("./plugin-Ddi42qoW.js");
			process.exit(runPlugin(invocation.profile, invocation.args));
			break;
		}
	}
}
if (import.meta.main) await runCli();
export { runCli };
`

const HELP = pluginHelpText('web')

/** 把文本写到临时目录并用当前 node 做语法校验（放 <dir>/package.json type:module 里） */
function syntaxOk(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-install-test-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n')
    const file = path.join(dir, 'probe.js')
    fs.writeFileSync(file, text)
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    return { ok: result.status === 0, detail: (result.stderr ?? undefined) || '' }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('patchBinJs：上游原文一次打全（profile 可选 + 透传选项 + 重复报错 + 分发替换）', () => {
  const result = patchBinJs(UPSTREAM_FIXTURE, HELP)
  assert.equal(result.ok, true, result.missing?.join(', '))
  const text = result.text
  // P1-3 的三件套
  assert.ok(text.includes('.passThroughOptions().enablePositionalOptions().argument("[args...]", "pnpm arguments'))
  assert.ok(text.includes('const collectProfile = (value, previous) =>'))
  assert.ok(text.includes(', collectProfile)'))
  assert.ok(text.includes('Array.isArray(options.profile)'))
  assert.ok(text.includes('--profile was given more than once'))
  // 关键：`--profile` 变可选后，官方那句 rejectElectronProfile 会因 undefined 抛错并被
  // 静默吞成 exit 1（`dsh plugin` / `--help` 零输出）—— 必须收进 undefined 判断
  assert.ok(text.includes('if (options.profile !== void 0) rejectElectronProfile(plugin, options.profile);'))
  assert.ok(!text.includes('\t\trejectElectronProfile(plugin, options.profile);\n'), '不得留下未加守卫的调用')
  // 既有能力不丢
  assert.ok(!text.includes('requiredOption("--profile'))
  assert.ok(text.includes('await import("./commands/plugin.js")'))
  assert.ok(text.includes('process.exit(await runPluginCommand(invocation.profile, invocation.args));'))
  assert.ok(!text.includes('pnpm arguments to forward'))
  assert.ok(text.includes('.addHelpText("after",'))
  // 语法必须仍然成立（安装器会在落盘前做同一件事）
  const check = syntaxOk(text)
  assert.ok(check.ok, check.detail)
})

test('patchBinJs 幂等：对已打补丁的文本再跑一次，结果与输入逐字节相同', () => {
  const once = patchBinJs(UPSTREAM_FIXTURE, HELP)
  assert.equal(once.ok, true)
  const twice = patchBinJs(once.text, HELP)
  assert.equal(twice.ok, true, twice.missing?.join(', '))
  assert.equal(twice.text, once.text)
})

test('patchBinJs 可从 v1 增强层升级（旧版 profile 选项 → 收集器 + 透传选项）', () => {
  const v1 = UPSTREAM_FIXTURE.replace(
    '.requiredOption("--profile <name>", "the profile whose plugins to manage (initialized on first use)")',
    '.option("--profile <name>", "the profile whose plugins to manage (default: web; initialized on first use)")',
  )
    .replace('const { runPlugin } = await import("./plugin-Ddi42qoW.js");', 'const { runPluginCommand } = await import("./commands/plugin.js");')
    .replace('process.exit(runPlugin(invocation.profile, invocation.args));', 'process.exit(await runPluginCommand(invocation.profile, invocation.args));')
  const result = patchBinJs(v1, HELP)
  assert.equal(result.ok, true, result.missing?.join(', '))
  assert.ok(result.text.includes(', collectProfile)'))
  assert.ok(result.text.includes('.passThroughOptions().enablePositionalOptions()'))
  assert.ok(syntaxOk(result.text).ok)
})

test('patchBinJs：锚点缺失时整体失败并逐条报出（宁可没装上，不能装半残）', () => {
  const broken = UPSTREAM_FIXTURE.replace(
    '.argument("[args...]", "pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)")',
    '.argument("[args...]", "some other description")',
  )
  const result = patchBinJs(broken, HELP)
  assert.equal(result.ok, false)
  assert.ok(result.missing.some((name) => name.includes('透传选项')), result.missing.join(', '))
})

test('refreshHelpText：只替换固化的帮助字符串，其余字节不动', () => {
  const installed = patchBinJs(UPSTREAM_FIXTURE, '旧的帮助正文').text
  const refreshed = refreshHelpText(installed, HELP)
  assert.equal(refreshed.ok, true, refreshed.reason)
  assert.equal(refreshed.changed, true)
  assert.ok(refreshed.text.includes(JSON.stringify(HELP)))
  assert.ok(!refreshed.text.includes('旧的帮助正文'))
  const again = refreshHelpText(refreshed.text, HELP)
  assert.equal(again.changed, false)
})

test('MODULE_MAP 覆盖落盘模块之间的全部相对 import（漏一个装完就 import 失败）', () => {
  const targets = MODULE_MAP.map(([, to]) => to)
  assert.ok(targets.includes('plugin.js'), 'command.mjs 必须落盘为 commands/plugin.js')
  // 逐份扫描落盘模块的相对 import，凡是引用同目录其它模块的都必须一起复制过去
  const sources = MODULE_MAP.map(([from]) => [from, fs.readFileSync(new URL(`./${from}`, import.meta.url), 'utf8')])
  const referenced = new Set()
  for (const [from, text] of sources) {
    for (const match of text.matchAll(/from\s+'\.\/([\w.-]+\.mjs)'/g)) {
      referenced.add(match[1])
      assert.ok(targets.includes(match[1]), `${from} 引用了 ./${match[1]}，但它不在 MODULE_MAP 里`)
    }
  }
  assert.ok(referenced.has('core.mjs') && referenced.has('forward.mjs') && referenced.has('pipeline.mjs'))
  assert.ok(referenced.has('pnpm.mjs'), 'forward.mjs 依赖 pnpm.mjs')
})

/* ------------------------------------------------- 锚点漂移告警（真实 dsh） */

/**
 * 本机真实安装的 dsh（resolveDshDir 会沿 PATH 找 dsh 垫片旁边的包目录）。
 * 找不到就跳过 —— 这条用例是「dsh 升级把锚点改掉了」的警报器，不该在无 dsh 的机器上红。
 */
const dshDir = resolveDshDir()

test('锚点漂移检查：补丁仍能命中本机真实安装的 bin.js', { skip: dshDir === undefined ? '本机未安装 @deepseek-ai/dsh' : false }, () => {
  const binFile = path.join(dshDir, 'lib', 'bin.js')
  const result = patchBinJs(fs.readFileSync(binFile, 'utf8'), HELP)
  assert.equal(result.ok, true, `锚点漂移：${result.missing?.join('、')} —— 请人工核对 ${binFile}`)
  assert.ok(syntaxOk(result.text).ok)
})
