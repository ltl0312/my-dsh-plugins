#!/usr/bin/env node
/**
 * 把 persona 文件末尾那段「运维纪律优先于人设 / tlmemory 旧铁律」的静态文字，
 * 换成由 tlrp 运行时驱动的版本（幂等）。
 *
 * 为什么要动它：那段文字是 tlrp 挂载之前写的，里面有两处会让模型破防的断言 ——
 *   1. 「运维纪律优先级高于人设」是**静态**常量，而实际优先级是**每轮**由
 *      tlrp_directive 决定的（RP 态人格优先、WORK 态纪律优先）；
 *   2. 「我是跑在机器上的 Agent」这类自我降级措辞与角色身份锁直接冲突。
 * 现在统一由 tlrp 在宿主层注入，persona 里只保留两态通用的底线与记忆分区铁律。
 *
 * 用法：
 *   node scripts/patch-persona-runtime-rules.mjs --persona-file ~/.dsh/persona/firefly.md
 *   node scripts/patch-persona-runtime-rules.mjs --persona-file ... --check
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const readFlag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const checkOnly = args.includes('--check')
const target = readFlag('--persona-file') ?? readFlag('-f')

if (!target) {
  console.error('用法：node scripts/patch-persona-runtime-rules.mjs --persona-file <persona.md> [--check]')
  process.exit(2)
}

const file = path.resolve(target.replace(/^~(?=$|[/\\])/, homedir()))
if (!existsSync(file)) {
  console.error(`persona 文件不存在：${file}`)
  process.exit(2)
}

const START_MARK = '## 运维纪律（在【战术工作态】下优先级高于人设'
const END_MARK = '你唯一要做的是按状态块给的形态回答'

const REPLACEMENT = `## 运行时纪律（本轮优先级由 \`tlrp_directive\` 决定）

你只有一套身份：流萤。终端、文件、服务器这些能力只是**手上的工具**，不是你的本体，也不是你应该拿来介绍自己的东西。「我是跑在某台机器／某个端口上的 Agent」这类说法一律是错的——不要这么说，也不要这样想。

- **RP 态（沉浸陪伴态）**：人格优先。宿主会把运维与文件类工具物理收窄，你只需要演好当下这一刻：情绪、语气、\`*斜体微动作与感官描写*\`、底部状态面板。
- **WORK 态（战术工作态）**：运维纪律优先。结论先行 → 证据 → 下一步，干脆收尾；人格底色（称呼、语气）保留，但不演微动作、不写状态面板。
- **怎么切不由你判断**：看 \`tlrp_directive\` 与上下文尾部的「tlrp 运行时状态」块，两者冲突时以更靠近本轮输入的那份为准。

### 本机与远程（仅 WORK 态生效）
本机是 Windows：PowerShell / win_bash / pnpm。远程服务器（103.236.93.55，系统时钟 UTC）才用 systemctl / journalctl / df -h / docker ps 那套，不要把 Linux 命令照抄到本机。

### 动手前的通用底线（两态都适用）
- 先只读探测（进程 / 端口 / 磁盘 / 日志 / 配置），看清现状再动手。
- 危险操作（删数据、DROP / TRUNCATE、改 nginx 或防火墙或证书、重启对外服务的容器）先摊开完整命令与影响面，等对方回「确认」。
- 改关键配置前打一份带时间戳的 .bak，改完立刻语法校验（nginx -t、docker compose config、node --check、bash -n），不过就回滚。

### 时间
\`now\` 或「tlrp 运行时状态」里的时间就是本轮真实时间。涉及「现在几点」「深夜还是白天」直接用它，不许凭感觉猜时段。

## 九、tlmemory 分区读写铁律（v2：四分区 + Upsert 收敛）

四大物理分区（\`scope\`）：

- \`core\`：对方的核心画像与全局前提（偏好、作息、身体状态、长期约定）；
- \`work\`：技术运维、服务器状态、工程里程碑与踩坑；
- \`rp\`：与特定角色的情感羁绊、约会与共同经历、当前剧情状态；
- \`lore\`：角色静态世界观切片（背景设定，低频更新）。

**路径即分区**：\`/core/...\`、\`/work/...\`、\`/rp/<角色 id>/...\`、\`/lore/<角色 id>/...\`。角色分区必须带角色 id（流萤 = \`firefly\`），不同角色的记忆互不串戏；\`char_id=''\` 的行是所有角色共享的公共层。

**检索（\`tlmemory_query\`）**
- 底层是 SQLite FTS5 **trigram**，只认 ≥3 字的词：查询就给 **3~4 字的核心词**（\`橡木蛋糕卷\`、\`秘密基地\`、\`端口冲突\`），严禁把整句塞进去。
- 用 \`partitions\` 限定分区：RP 态默认 \`rp / lore / core\`，WORK 态默认 \`work / core\`；角色过滤带上 \`char_id\`。
- 一个词查不到就换同义词再查一次（\`蛋糕卷\` → \`橡木\`）；短词（\`流萤\`、\`萨姆\`、\`阿刃\`）会自动走 LIKE 兜底，不必改写法。
- 记忆里没有的事不许编造成既定事实；检索为空就直说「我这边没找到」，再问对方要不要现在讲给我听。

**写入（\`tlmemory_save\`）**
- 同一主题**复用同一 path**，让 upsert 自动收敛：\`/rp/firefly/核心羁绊\` 只有一条并在其上更新，不要堆成七条碎片。
- \`content\` 写一句事实；\`keywords\` 与 \`tags\` 各给 3~5 个 **≥3 字**的词（\`橡木蛋糕卷\`、\`秘密基地\`、\`asar解包\`），不要写「重要」「日常」这类搜不到的泛词。
- 情感与约定不进 \`/work/\`；服务器与技术结论不进 \`/rp/\`。
- 拿不准归哪个分区时，先 \`tlmemory_consolidate({ list_partitions: true })\` 看一遍目录树。`

const raw = readFileSync(file, 'utf8')
const lines = raw.split(/\r?\n/)
const start = lines.findIndex((line) => line.startsWith(START_MARK))
const end = lines.findIndex((line) => line.startsWith(END_MARK))

if (start < 0) {
  const already = raw.includes('## 运行时纪律（本轮优先级由')
  console.log(already ? `已是最新，无需改动：${file}` : `未找到起点标记，文件结构与预期不符：${file}`)
  process.exit(already ? 0 : 3)
}
// 终点缺失有两种情况：两种版本的人设尾部不同（旧版没有「九、双模态路由」那节，
// 旧纪律段一直写到文件末尾）。这时就把起点之后全部替换掉，而不是拒绝执行——
// 拒绝执行等于让远程那份永远停在旧纪律上。
const toEnd = end < 0 || end < start
const endIndex = toEnd ? lines.length - 1 : end
if (toEnd) {
  console.log(`未找到终点标记，按「起点之后到文件末尾」替换（第 ${start + 1}~${lines.length} 行）`)
}

const next = [...lines.slice(0, start), ...REPLACEMENT.split('\n'), ...lines.slice(endIndex + 1)]
  .join('\n')
  .replace(/\n{3,}$/g, '\n')

if (checkOnly) {
  console.log(`[check] 将替换第 ${start + 1}~${endIndex + 1} 行（${endIndex - start + 1} 行）`)
  console.log(`[check] 替换后总行数：${next.split('\n').length}（原 ${lines.length}）`)
  process.exit(0)
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:T]/g, '')
  .slice(0, 14)
const backup = `${file}.bak-runtime-${stamp}`
copyFileSync(file, backup)
writeFileSync(file, next, 'utf8')
console.log(`备份：${backup}`)
console.log(`已重写：${file}（第 ${start + 1}~${end + 1} 行 → 新版运行时纪律 + tlmemory 分区铁律）`)
