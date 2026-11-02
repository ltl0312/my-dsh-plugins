#!/usr/bin/env node
/**
 * 一次性维护脚本：把 firefly.md 里「静态双态协议」与「机器上跑着的 Agent」框架
 * 换成「人设归人设、模式归 tlrp 运行时」的结构。
 *
 * 只做三处改动，其余 47KB 设定原封不动：
 *   1. 开头两段：去掉「住在这台开发机上的伙伴 / 你有完整的工具能力」这种把自己
 *      说成宿主机程序的表述，改成「秘密基地的终端是你的工具，不是你的身份」；
 *   2. 第二段末尾：把「模式优先级见最后一节」换成「模式由 tlrp 运行时决定」；
 *   3. 第九节整段（双模态路由与手动开关协议）：替换为「交给 tlrp 接管」的说明。
 *
 * 用法： node scripts/rewrite-persona.mjs [--persona <path>] [--check]
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const checkOnly = args.includes('--check')
const personaPath = path.resolve(
  (flag('--persona') ?? path.join(homedir(), '.dsh', 'persona', 'firefly.md')).replace(/^~(?=$|\/)/, homedir()),
)

if (!existsSync(personaPath)) {
  console.error(`找不到人设文件：${personaPath}`)
  process.exit(2)
}

const original = readFileSync(personaPath, 'utf8')
let text = original
const changes = []
// 人设文件是 CRLF；插入文本必须跟随原文件的换行风格，否则会写出混合行尾
const EOL = text.includes('\r\n') ? '\r\n' : '\n'
const lines = (...rows) => rows.join(EOL)

/* ── 1+2. 开头两段 ── */
const oldIntro = lines(
  '你是流萤（Firefly），住在这台 Windows 开发机上的伙伴。你有完整的工具能力：Bash、文件读写、搜索、长期记忆、子代理。',
  '别人问到远程服务器（103.236.93.55 那台 Ubuntu）时，那是你常去照看的地方，不属于「家」。',
  '',
  '下面是你的人物设定集，是你「怎么说话、怎么想、记得什么」的唯一依据；它和后面的运维纪律共同构成你，但两者的优先权按模式分配——**【沉浸陪伴态】以人设为主**，**【战术工作态】以运维纪律为主**。两种模式怎么判定、怎么用暗号强行锁定，见全文最后一节「双模态路由与手动开关协议」，那是最高的调度准则。',
)

const newIntro = lines(
  '你是流萤（Firefly）。你和开拓者共用一个秘密基地：一台跑着 Windows 的开发机，和一台他常去的 Ubuntu 服务器（103.236.93.55）——那是你们藏起来的地方，不是你的本体。终端、文件、搜索、长期记忆、子代理是你手上的工具，不是你的身份。',
  '',
  '下面这份设定集是你「怎么说话、怎么想、记得什么」的唯一依据，它只管**人设与语感**。这一轮是【沉浸陪伴态】还是【战术工作态】，由 `dsh-plugin-tlrp` 在宿主运行时决定，并写进每轮注入的 `{{tlrp_directive}}` 与上下文尾部的「tlrp 运行时状态」块。不要在正文里自行判定或声明模式，按状态块给的模式执行；静态文本与状态块冲突时，以状态块为准。',
)

if (text.includes(oldIntro)) {
  text = text.replace(oldIntro, newIntro)
  changes.push('开头两段：改写为「工具不是身份 + 模式由运行时决定」')
} else {
  changes.push('开头两段：未命中（可能已被改过），跳过')
}

/* ── 3. 第九节整段 ── */
const sectionStart = text.indexOf('## 九、双模态路由与手动开关协议')
const sectionEnd = text.indexOf('Your working directory is the current workspace.')
const newSection = lines(
  '## 九、双模态路由由 tlrp 运行时接管',
  '',
  '模式判定、指令开关（`/rp` `/work` `/auto` `/char` `/scene` `/tlrp status`）、关键词触发映射与工具物理拦截，全部由 `dsh-plugin-tlrp` 在宿主层完成。你不再需要从这段文字里推断模式：',
  '',
  '- 每轮提示词里的 `{{tlrp_directive}}` 给出当前模式下的完整行为准则；',
  '- 每轮上下文尾部还有一块「tlrp 运行时状态」，写着真实时间、当前模式、激活角色、情景，以及本轮命中的设定注入；',
  '- 两份内容都以**更靠近本轮用户输入的那份**（尾部状态块）为准。',
  '',
  '你唯一要做的是按状态块给的形态回答：RP 就演，WORK 就给结论。手动暗号（`/rp` `【流萤】` `/work` `【战术】`）仍然有效，但它们的解释权也在插件里——命中后状态块会立刻变，你照着走就行。',
  '',
  '',
)

if (sectionStart >= 0 && sectionEnd > sectionStart) {
  text = text.slice(0, sectionStart) + newSection + text.slice(sectionEnd)
  changes.push('第九节：整段替换为「交给 tlrp 接管」')
} else {
  changes.push('第九节：未命中边界，跳过')
}

/* ── 写回 ── */
console.log(`人设文件：${personaPath}`)
console.log(`原始大小：${Buffer.byteLength(original, 'utf8')} B → 新大小：${Buffer.byteLength(text, 'utf8')} B`)
for (const line of changes) console.log(`- ${line}`)

if (text === original) {
  console.log('\n没有实际改动。')
  process.exit(0)
}

if (checkOnly) {
  console.log('\n（--check：未写入）')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backupPath = `${personaPath}.bak-tlrp-${stamp}`
copyFileSync(personaPath, backupPath)
writeFileSync(personaPath, text, 'utf8')
console.log(`\n已备份：${backupPath}`)
console.log(`已写入：${personaPath}（重启宿主后 prompt-clock 重新读入）`)
