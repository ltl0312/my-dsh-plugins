// tools/dsh-plugin-cmd/core.mjs
// `dsh plugin` 增强的纯逻辑层 —— 零第三方依赖、零 IO、零副作用。
//
// 为什么全部用「文本结构扫描」而不是 YAML 解析/重序列化：
//   profile 的 cordis.patch.yml 里承载着用户手写的大量注释（拓扑说明、端口冲突提示…），
//   任何 load→dump 往返都会把它们抹掉。因此本模块只做两件事：
//     1. 以 YAML 的**块结构**（列 0 的 `-` 起一个顶层项、缩进决定从属）判断某个插件
//        是否已被挂载、以及某个条目到底占了哪几行；
//     2. 只对「新增」追加文本、对「移除」做行级手术，其余字节原样保留。
//   解析器（js-yaml）只用于**开机前的自查**，不参与写入。
//
// 本文件被仓库单测（node --test）与全局安装里的编排层同时引用，因此不得 import 任何
// 包，也不得依赖 Node 之外的环境。

/** profile 目录下的用户补丁层文件名（与 dsh-app-boot 的 PROFILE_PATCH_FILENAME 一致） */
export const PATCH_FILENAME = 'cordis.patch.yml'

/** pnpm 11 的「允许执行构建脚本」配置文件名 */
export const WORKSPACE_FILENAME = 'pnpm-workspace.yaml'

/** 回写被改动的文件前生成的备份后缀（中间再插时间戳） */
export const BACKUP_INFIX = 'bak-dsh-plugin'

/** profile 级互斥锁文件名（P2-4：取不到锁就明确失败，绝不并发覆盖） */
export const LOCK_FILENAME = '.dsh-plugin.lock'

/** 锁被视为陈旧（可接管）的毫秒数 */
export const LOCK_STALE_MS = 10 * 60 * 1000

/** profile 清单文件在回写前的备份后缀（P2-4） */
export const MANIFEST_BACKUP_SUFFIX = `${BACKUP_INFIX}-manifest`

/**
 * 需要 `prepare` 构建的 git 形态 spec。
 * 官方只有三条分支（`^git+` / `^github:` / `\\.git(#|$)`），漏掉 gitlab/bitbucket/裸
 * https 与 ssh 形态；这些同样会触发 pnpm 的构建放行（P3-2）。
 */
export const GIT_SPEC_PATTERN = /^(?:git\+|github:|gitlab:|bitbucket:|git@)|\.git(?:#|$)|(?:^|\/\/)(?:www\.)?(?:github|gitlab|bitbucket)\.com\//i

/**
 * pnpm 记录「允许执行构建脚本」的配置键，按 pnpm 大版本区分（P3-2）：
 *   - pnpm 10：`onlyBuiltDependencies`（数组）
 *   - pnpm 11+：`allowBuilds`（映射，本增强层写的就是它）
 */
export const BUILD_APPROVAL_KEYS = Object.freeze({
  modern: 'allowBuilds',
  legacy: 'onlyBuiltDependencies',
})

/** 代理环境变量 → pnpm（npm 配置）认的键名（#12：把翻译下沉，消费者不必各自实现） */
export const PROXY_ENV_MAP = Object.freeze([
  ['HTTPS_PROXY', 'npm_config_https_proxy'],
  ['https_proxy', 'npm_config_https_proxy'],
  ['HTTP_PROXY', 'npm_config_proxy'],
  ['http_proxy', 'npm_config_proxy'],
  ['NO_PROXY', 'npm_config_noproxy'],
  ['no_proxy', 'npm_config_noproxy'],
])

/**
 * pnpm 写入 pnpm-workspace.yaml 的「待人工确认」占位值。
 * pnpm 检测到需要构建脚本的依赖时会自动补一条 `包名: set this to true or false`，
 * 等用户改成布尔值；这正是我们要自动填掉的东西。
 */
export const BUILD_PLACEHOLDER = 'set this to true or false'

/* ------------------------------------------------------------------ 行工具 */

/** 探测换行风格（只认 CRLF / LF；混用时以出现次数多者为准） */
export function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? '\r\n' : '\n'
}

/**
 * 当前时间戳（用于备份文件名与锁记录），形如 20260915-133600。
 * 放在 core 里是因为 pipeline（备份）与 forward（清单备份、锁）都要用。
 */
export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** 拆行（丢换行符），保留空行以便行号与原文一一对应 */
export function toLines(text) {
  return text.split(/\r\n|\n/)
}

/** 按原换行风格拼回文本 */
export function fromLines(lines, eol = '\n') {
  return lines.join(eol)
}

/** 一行有多少个前导空格（制表符按 1 列计，够用且不猜测展开宽度） */
export function indentOf(line) {
  const match = /^[ \t]*/.exec(line)
  return match === null ? 0 : match[0].length
}

/** 该行是否构成一个 YAML 列表项（按给定缩进） */
function isListItem(line, indent) {
  if (indentOf(line) !== indent) return false
  return /^[ \t]*-(\s|$)/.test(line)
}

/** 该行是否为整行注释 */
function isComment(line) {
  return /^\s*#/.test(line)
}

/** 该行是否为空白行 */
function isBlank(line) {
  return line.trim() === ''
}

/* ---------------------------------------------------- 顶层 patch 项的定位 */

/**
 * 扫描顶层 patch 项（列 0 的 `-`）。
 *
 * 每项返回三段：
 *   - `commentStart`：紧邻其前的连续注释段起点（若该注释段一路顶到文件开头则不含，
 *     那是文件级表头而不是这一项的说明）；
 *   - `start` / `ownEnd`：该项自身的 YAML 内容范围（不含紧后的注释——那些属于下一项）。
 * @param lines - 已拆分的行
 */
export function topLevelItems(lines) {
  const starts = []
  for (let i = 0; i < lines.length; i += 1) {
    if (isListItem(lines[i], 0)) starts.push(i)
  }
  return starts.map((start, index) => {
    const limit = index + 1 < starts.length ? starts[index + 1] : lines.length
    let ownEnd = start
    for (let i = start; i < limit; i += 1) {
      if (!isBlank(lines[i]) && !isComment(lines[i])) ownEnd = i
    }
    // 紧邻其前的连续注释段
    let commentStart = start
    while (commentStart - 1 >= 0 && isComment(lines[commentStart - 1])) commentStart -= 1
    // 注释段若顶到文件开头，视为文件表头：不随本项目条目一同移除
    const inheritsHeader = commentStart === 0
    return { commentStart, headerOwned: inheritsHeader, start, ownEnd }
  })
}

/* ----------------------------------------- 挂载条目（insert 列表）的定位 */

/** 单个挂载条目在文本里的位置与身份 */
/**
 * @typedef {object} PatchEntry
 * @property {number} start - 条目首行（`- ` 那一行）
 * @property {number} end - 条目末行（含）
 * @property {number} blockStart - 所属 `- insert:` 顶层项的起始行
 * @property {number} blockOwnEnd - 所属顶层项的末行
 * @property {string} name - 条目声明的插件包名（未声明为空串）
 * @property {string} id - 条目 id（未声明为空串）
 */

/** 去掉 YAML 标量两端的引号 */
export function unquoteScalar(raw) {
  const value = String(raw).trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** 在条目范围内按「条目属性缩进」取标量字段，避免误取 config 里的同名键 */
function entryScalar(lines, entry, key) {
  const dashIndent = indentOf(lines[entry.start])
  // 条目 `- ` 之后的关键字逻辑缩进是 dashIndent + 2（YAML 常见的 4/6 空格风格）
  const propertyIndent = dashIndent + 2
  for (let i = entry.start; i <= entry.end; i += 1) {
    const line = lines[i]
    if (isBlank(line) || isComment(line)) continue
    // 首行是 `- key: value` 形态：剥掉 `- ` 后按逻辑缩进比较
    const body = i === entry.start ? line.replace(/^[ \t]*-(\s+|$)/, '') : line
    const bodyIndent = i === entry.start ? propertyIndent : indentOf(line)
    if (bodyIndent !== propertyIndent) continue
    const match = new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(body.trim())
    if (match === null) continue
    const raw = match[1].trim()
    // 块标量（`|` / `>`）不是普通标量字段
    if (raw === '' || raw === '|' || raw === '>') continue
    return unquoteScalar(raw)
  }
  return ''
}

/**
 * 找出所有「挂载条目」：`- insert:` 下的直接子项。
 * 同时支持带 id 的组内插入（`- id: xxx` + `insert:`）——两者的条目层形状一致。
 *
 * 条目缩进是**探测**出来的而不是假设的：YAML 的块序列允许 `insert:` 之后
 * 缩进 2 或 4（dsh 官方模板用 4），写死 +2 会一个条目都找不到。
 * @param lines - 已拆分的行
 * @returns 条目列表
 */
export function patchEntries(lines) {
  const entries = []
  for (const block of topLevelItems(lines)) {
    // 该顶层项内出现的 insert 标记行
    const insertMarkers = []
    for (let i = block.start; i <= block.ownEnd; i += 1) {
      const line = lines[i]
      if (isBlank(line) || isComment(line)) continue
      const isOwnFieldLine = i === block.start
      const body = isOwnFieldLine ? line.replace(/^[ \t]*-(\s+|$)/, '') : line
      const bodyIndent = isOwnFieldLine ? indentOf(line) : indentOf(line)
      if (!/^insert\s*:/.test(body.trim())) continue
      if (/\S/.test(body.trim().replace(/^insert\s*:\s*/, ''))) {
        // 行内数组形态（`insert: [...]`）：不做行级手术，也不去猜
        continue
      }
      insertMarkers.push({ line: i, indent: bodyIndent })
    }

    for (const marker of insertMarkers) {
      // 探测条目缩进：marker 之后第一个更深缩进的列表项
      let firstEntry = -1
      for (let i = marker.line + 1; i <= block.ownEnd; i += 1) {
        const line = lines[i]
        if (isBlank(line) || isComment(line)) continue
        if (indentOf(line) <= marker.indent) break
        if (/^[ \t]*-(\s|$)/.test(line)) firstEntry = i
        break
      }
      if (firstEntry === -1) continue
      const entryIndent = indentOf(lines[firstEntry])

      for (let i = firstEntry; i <= block.ownEnd; i += 1) {
        const line = lines[i]
        if (isBlank(line) || isComment(line)) continue
        const indent = indentOf(line)
        if (indent < entryIndent) break
        if (indent > entryIndent) continue
        if (!/^[ \t]*-(\s|$)/.test(line)) continue
        // 条目范围：到下一个同级或更浅缩进的非空行为止
        let end = i
        for (let j = i + 1; j <= block.ownEnd; j += 1) {
          const next = lines[j]
          if (isBlank(next) || isComment(next)) continue
          if (indentOf(next) <= entryIndent) break
          end = j
        }
        const entry = {
          start: i,
          end,
          blockStart: block.start,
          blockOwnEnd: block.ownEnd,
          id: '',
          name: '',
        }
        entry.name = entryScalar(lines, entry, 'name')
        entry.id = entryScalar(lines, entry, 'id')
        entries.push(entry)
        i = end
      }
    }
  }
  return entries
}

/**
 * 该插件是否已被挂载（按 `name` 判等，而不是按 id —— id 是用户可任意命名的）。
 * @param text - cordis.patch.yml 原文
 * @param packageName - 插件包名
 * @returns 命中的条目（未命中返回 undefined）
 */
export function findMountedEntry(text, packageName) {
  const lines = toLines(text)
  return patchEntries(lines).find((entry) => entry.name === packageName)
}

/** 列出所有已挂载的条目（供 `list` 使用） */
export function listMountedEntries(text) {
  return patchEntries(toLines(text)).map((entry) => ({
    id: entry.id,
    name: entry.name,
    line: entry.start + 1,
  }))
}

/* -------------------------------------------------------- 新条目的文本构造 */

/** 渲染一个 YAML 标量（够用即可：字符串一律双引号，避免歧义） */
export function renderYamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (value === null || value === undefined) return 'null'
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 递归渲染 config 的 YAML 片段（仅支持纯对象 / 数组 / 标量，与插件 config 的实际形状一致）。
 * @param lines - 输出缓冲（原地追加）
 * @param value - 待渲染的值
 * @param indent - 当前缩进
 */
function renderYamlValue(lines, value, indent) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines[lines.length - 1] += ' []'
      return
    }
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        lines.push(`${pad}-`)
        renderYamlValue(lines, item, indent + 2)
      } else {
        lines.push(`${pad}- ${renderYamlScalar(item)}`)
      }
    }
    return
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) {
      lines[lines.length - 1] += ' {}'
      return
    }
    for (const key of keys) {
      const child = value[key]
      if (child !== null && typeof child === 'object') {
        lines.push(`${pad}${key}:`)
        renderYamlValue(lines, child, indent + 2)
      } else {
        lines.push(`${pad}${key}: ${renderYamlScalar(child)}`)
      }
    }
    return
  }
  lines[lines.length - 1] += ` ${renderYamlScalar(value)}`
}

/**
 * 由包名派生一个稳定、可读、可作为 YAML 标量安全使用的条目 id。
 * 规则：去掉 scope 的 `@`、把 `/` 换成 `-`、剔除不安全字符、折叠连续连字符。
 * @param packageName - npm 包名
 */
export function deriveEntryId(packageName) {
  const id = String(packageName)
    .replace(/^@/, '')
    .replace(/[\\/]/g, '-')
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return id === '' ? 'plugin' : id
}

/**
 * 渲染一个可追加到 cordis.patch.yml 末尾的 `- insert:` 顶层项。
 * 缩进风格与 dsh 官方 profile 模板一致（顶层 `- `、条目 4 空格、字段缩进 +2）。
 * @param entry - `{ id, name, config? }`
 * @returns YAML 文本（不含结尾换行）
 */
export function renderInsertBlock(entry) {
  const lines = ['- insert:', `    - id: ${renderYamlScalar(entry.id)}`, `      name: ${renderYamlScalar(entry.name)}`]
  if (entry.config !== undefined && entry.config !== null && Object.keys(entry.config).length > 0) {
    lines.push('      config:')
    renderYamlValue(lines, entry.config, 8)
  }
  return lines.join('\n')
}

/**
 * 把新条目追加到补丁文件末尾（保留原有全部字节，只补必要空行）。
 * 追加而非重写，是因为文件里承载着用户手写的注释与拓扑说明。
 * @param text - 原文（可为空串，表示文件尚不存在）
 * @param block - {@link renderInsertBlock} 的结果
 * @returns 新文本
 */
export function appendPatchItem(text, block) {
  const eol = detectEol(text)
  const body = toLines(block)
  const trimmed = text.replace(/(\r\n|\n)+$/, '')
  // 空文件不要先垫一个空行（否则首行就是空白，看着像坏文件）
  const lines = trimmed === '' ? [] : toLines(trimmed)
  const next = lines.length === 0 ? body : [...lines, '', ...body]
  return `${fromLines(next, eol)}${eol}`
}

/* -------------------------------------------------------- 移除的行级手术 */

/**
 * 读取某个**顶层项**自身字段（`- key: value` / 紧随其后的同缩进字段）。
 * 顶层项的字段缩进是探测出来的：首行 `- ` 之后的关键字逻辑缩进为 2。
 * @param lines - 已拆分的行
 * @param item - {@link topLevelItems} 的产物
 * @param key - 字段名
 */
function topLevelItemScalar(lines, item, key) {
  const propertyIndent = indentOf(lines[item.start]) + 2
  for (let i = item.start; i <= item.ownEnd; i += 1) {
    const line = lines[i]
    if (isBlank(line) || isComment(line)) continue
    const isFirst = i === item.start
    const body = isFirst ? line.replace(/^[ \t]*-(\s+|$)/, '') : line
    const bodyIndent = isFirst ? propertyIndent : indentOf(line)
    if (bodyIndent !== propertyIndent) continue
    const match = new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(body.trim())
    if (match === null) continue
    const raw = match[1].trim()
    if (raw === '' || raw === '|' || raw === '>') continue
    return unquoteScalar(raw)
  }
  return ''
}

/**
 * 规划一次「移除挂载条目」的行级手术。
 *
 * 覆盖两种形态，都只删属于自己的行、其余字节原样保留：
 *   1. `- insert:` 里的挂载条目 `name: <包名>`（`add` 写下的就是这种）；
 *   2. 顶层覆盖项自身声明了 `name: <包名>`（如用户手写的 `disabled: true`）。
 * 若同一顶层项里还有别的条目，只摘掉目标条目、保留该项；该项专属于该插件时
 * 连它的说明注释一起删（但绝不删文件表头注释）。
 * @param text - 原文
 * @param packageName - 插件包名
 * @returns `{ text, removed, lines }`；`removed === 0` 表示未命中，`text` 原样返回
 */
export function planPatchRemoval(text, packageName) {
  const eol = detectEol(text)
  const lines = toLines(text)
  const items = topLevelItems(lines)
  const entries = patchEntries(lines)
  const drop = new Set()
  const removedSpans = []

  const dropWholeItem = (item, fallbackStart, fallbackEnd) => {
    const from = item !== undefined && !item.headerOwned ? item.commentStart : fallbackStart
    const to = item?.ownEnd ?? fallbackEnd
    for (let i = from; i <= to; i += 1) drop.add(i)
    removedSpans.push({ from: from + 1, to: to + 1 })
  }

  for (const entry of entries) {
    if (entry.name !== packageName) continue
    const siblings = entries.filter((other) => other.blockStart === entry.blockStart && other.start !== entry.start)
    if (siblings.length === 0) {
      dropWholeItem(
        items.find((item) => item.start === entry.blockStart),
        entry.blockStart,
        entry.end,
      )
    } else {
      for (let i = entry.start; i <= entry.end; i += 1) drop.add(i)
      removedSpans.push({ from: entry.start + 1, to: entry.end + 1 })
    }
  }

  // 顶层覆盖项（自身 name 命中、且不含 insert 挂载条目）
  const insertOnlyNames = new Set(entries.map((entry) => entry.blockStart))
  for (const item of items) {
    if (insertOnlyNames.has(item.start)) continue
    if (topLevelItemScalar(lines, item, 'name') !== packageName) continue
    dropWholeItem(item, item.start, item.ownEnd)
  }

  if (removedSpans.length === 0) return { text, removed: 0, lines: 0, spans: [] }

  const kept = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!drop.has(i)) kept.push(lines[i])
  }
  // 折叠因删除产生的连续空行（最多留一行）
  const collapsed = []
  for (const line of kept) {
    if (isBlank(line) && collapsed.length > 0 && isBlank(collapsed[collapsed.length - 1])) continue
    collapsed.push(line)
  }
  const result = `${fromLines(collapsed, eol).replace(/(\r\n|\n)+$/, '')}${eol}`
  return { text: result, removed: removedSpans.length, lines: drop.size, spans: removedSpans }
}

/* ------------------------------------------------- allowBuilds 的合并编辑 */

/** 解析 pnpm-workspace.yaml 中某个列 0 段落的孩子行范围 */
function sectionRange(lines, key) {
  const start = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line))
  if (start === -1) return undefined
  let end = start
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isBlank(lines[i])) continue
    if (indentOf(lines[i]) === 0 && !isComment(lines[i])) break
    end = i
  }
  return { start, end, inline: /:\s*\S/.test(lines[start]) }
}

/**
 * 规划 pnpm-workspace.yaml 的 allowBuilds 编辑（pnpm 11 的键名与形状）。
 *
 * 语义要点：
 *   - pnpm 11 的键是 `allowBuilds`（映射），不是 `onlyBuiltDependencies`（数组，pnpm 10 的旧名）；
 *   - pnpm 检测到需要构建脚本的依赖时会自己补一条占位值
 *     `包名: set this to true or false`，这里把占位值填成 `true`；
 *   - 用户显式写的 `false` 是明确拒绝，绝不覆盖；已有的 `true` 保持不变。
 * @param text - pnpm-workspace.yaml 原文（可为空串，表示新建）
 * @param packageNames - 需要放行的包名集合
 * @returns `{ text, added, approved, skipped }`
 */
export function planAllowBuildsEdit(text, packageNames) {
  const targets = [...new Set(packageNames.filter((name) => typeof name === 'string' && name !== ''))]
  const eol = detectEol(text)
  if (targets.length === 0) return { text, added: [], approved: [], skipped: [] }

  const lines = text === '' ? [] : toLines(text.replace(/(\r\n|\n)+$/, ''))
  const section = sectionRange(lines, 'allowBuilds')
  const added = []
  const approved = []
  const skipped = []

  if (section === undefined) {
    if (lines.length > 0 && !isBlank(lines[lines.length - 1])) lines.push('')
    lines.push('allowBuilds:')
    for (const name of targets) {
      lines.push(`  ${name}: true`)
      added.push(name)
    }
    return { text: `${fromLines(lines, eol)}${eol}`, added, approved, skipped }
  }

  const childPattern = /^(\s+)([^:\s#][^:]*?)\s*:\s*(.*?)\s*$/
  const present = new Set()
  for (let i = section.start + 1; i <= section.end; i += 1) {
    const match = childPattern.exec(lines[i])
    if (match === null) continue
    const key = unquoteScalar(match[2])
    present.add(key)
    if (!targets.includes(key)) continue
    const value = match[3]
    if (value === 'true' || value === 'false') {
      if (value === 'false') skipped.push(key)
      continue
    }
    lines[i] = `${match[1]}${match[2]}: true`
    approved.push(key)
  }

  const missing = targets.filter((name) => !present.has(name))
  if (missing.length > 0) {
    const insertAt = section.end + 1
    const child = `${' '.repeat(Math.max(2, indentOf(lines[section.end + 1] ?? '  x')))}`
    const newLines = missing.map((name) => `${child}${name}: true`)
    lines.splice(insertAt, 0, ...newLines)
    added.push(...missing)
  }

  return { text: `${fromLines(lines, eol)}${eol}`, added, approved, skipped }
}

/**
 * 列出 allowBuilds 段里**尚未决定**的条目（值不是布尔，即 pnpm 写的占位值）。
 *
 * 这是 pnpm 自己的「等你批准」记录，比任何启发式探测都准。有了它，`add` 就能
 * 精确识别「本次安装新产生的待批项」并自动批准，而不去动历史遗留的占位项。
 * @param text - pnpm-workspace.yaml 原文
 * @returns 占位条目名列表
 */
export function listBuildPlaceholders(text) {
  if (text === '') return []
  const lines = toLines(text)
  const section = sectionRange(lines, 'allowBuilds')
  if (section === undefined) return []
  const childPattern = /^(\s+)([^:\s#][^:]*?)\s*:\s*(.*?)\s*$/
  const names = []
  for (let i = section.start + 1; i <= section.end; i += 1) {
    const match = childPattern.exec(lines[i])
    if (match === null) continue
    const value = match[3]
    if (value === 'true' || value === 'false') continue
    names.push(unquoteScalar(match[2]))
  }
  return names
}

/* ------------------------------------------------------- 插件清单的分类 */

/**
 * 判断一个已安装依赖属于哪一类，决定它需不需要写进 cordis.patch.yml。
 *
 *   - `bundle`：声明了 `dsh.bundle.patch` —— 由 profile 的 bundles 层栈托管，
 *     `dsh plugin` 的既有 reconcile 会自动处理，**不要**再插补丁（会重复挂载）；
 *   - `plugin`：声明了 `dsh` 元数据（如 `dsh.client`）但不是 bundle —— 这正是
 *     需要手工写 cordis.patch.yml 的那一类，本命令自动代劳；
 *   - `library`：无任何 dsh 元数据 —— 普通库，挂上去会让 profile 启动失败，
 *     因此只提示、不自动挂载。
 * @param manifest - 目标包的 package.json 内容
 */
export function classifyDshPackage(manifest) {
  const dsh = manifest?.dsh
  if (dsh !== null && typeof dsh === 'object') {
    const patch = dsh.bundle?.patch
    if (typeof patch === 'string' && patch !== '') {
      return { kind: 'bundle', reason: 'package.json 声明了 dsh.bundle.patch（由 profile bundles 层栈托管）' }
    }
    const keys = Object.keys(dsh)
    if (keys.length > 0) {
      return { kind: 'plugin', reason: `package.json 声明了 dsh 元数据（${keys.join(', ')}）` }
    }
  }
  return { kind: 'library', reason: 'package.json 未声明任何 dsh 元数据' }
}

/**
 * 从已安装包的 package.json 里提炼该插件声明的默认 config（可选能力）。
 * 目前生态里没有统一的「默认配置」声明位置，因此只在包显式给出
 * `dsh.config` / `dsh.defaultConfig` 时采用，否则返回 undefined（交给插件自身的
 * schemastery 默认值），避免猜测。
 * @param manifest - 目标包的 package.json 内容
 */
export function declaredDefaultConfig(manifest) {
  const dsh = manifest?.dsh
  if (dsh === null || typeof dsh !== 'object') return undefined
  for (const key of ['defaultConfig', 'config']) {
    const value = dsh[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
  }
  return undefined
}

/* --------------------------------------------------- 原生构建模块的判定 */

/* --------------------------------------------------- 原生构建模块的判定 */

/**
 * 复刻 pnpm 自身的「该包是否需要执行构建脚本」判定
 * （pnpm dist 内 `pkgRequiresBuild` 的实现）：
 *   有 preinstall / install / postinstall 之一，或包内含 `binding.gyp` / `.hooks/`。
 * 用途：pnpm 的 pendingBuilds 记录缺失时的兜底探测。
 * @param manifest - 包的 package.json
 * @param fileNames - 包根目录下的文件名列表（可选）
 */
export function requiresNativeBuild(manifest, fileNames = []) {
  const scripts = manifest?.scripts
  if (scripts !== null && typeof scripts === 'object') {
    if (scripts.preinstall || scripts.install || scripts.postinstall) return true
  }
  return fileNames.some((name) => name === 'binding.gyp' || /^\.hooks[/\\]/.test(name))
}

/* --------------------------------------------------- 子命令解析与帮助 */

/** 只由本增强层接管的子命令（其余一律原样转发给 pnpm，保持既有行为不变） */
const ADD_ALIASES = new Set(['add'])
const REMOVE_ALIASES = new Set(['remove', 'rm', 'uninstall'])
const LIST_ALIASES = new Set(['list', 'ls'])

/**
 * 会改变「已安装依赖集合」的子命令。
 * 这些走 passthrough 的用法在转发之后必须做一次激活审计（P1-2）：
 * `dsh plugin install` 只装依赖，不会写 cordis.patch.yml，客户端型插件装完并不生效。
 */
const INSTALLING_ALIASES = new Set(['install', 'i', 'add', 'update', 'up'])

/**
 * 在**待转发**的参数里找 `--profile`（P1-3）。
 *
 * 启动器的 `--profile` 只能出现在子命令之前；一旦出现在待转发参数里（例如
 * `dsh plugin --profile web add --profile=1`），它就是一条会丢失的参数或者一次静默的
 * profile 改道 —— 两种都不可接受，必须显式报错而不是吞掉或覆盖。
 * @param args - 待转发的参数
 * @returns 命中的那个 token；没有则 undefined
 */
export function findForwardedProfileFlag(args) {
  const argv = Array.isArray(args) ? args.map(String) : []
  return argv.find((token) => token === '--profile' || token.startsWith('--profile='))
}

/**
 * 该次转发是否会改动已安装依赖（决定要不要做激活审计）
 * @param args - 待转发的参数
 */
export function isInstallingSubcommand(args) {
  const argv = Array.isArray(args) ? args : []
  return typeof argv[0] === 'string' && INSTALLING_ALIASES.has(argv[0])
}

/** 会写盘（需要拿 profile 锁）的子命令；查询类不加锁，避免只读操作被互相阻塞 */
const MUTATING_ALIASES = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'import', 'prune'])

/**
 * 该次转发是否会改动 profile（决定要不要拿锁、要不要备份清单）
 * @param args - 待转发的参数
 */
export function isMutatingSubcommand(args) {
  const argv = Array.isArray(args) ? args : []
  return typeof argv[0] === 'string' && MUTATING_ALIASES.has(argv[0])
}

/**
 * 解析形如 `1500` / `30s` / `5m` 的超时值。
 * @param raw - 原始 token
 * @returns 毫秒数；无法解析返回 undefined（由调用方决定是否作为用法错误）
 */
export function parseTimeoutToken(raw) {
  if (raw === undefined || raw === null) return undefined
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(raw).trim())
  if (match === null) return undefined
  const value = Number(match[1])
  const unit = match[2] ?? 'ms'
  const scaled = unit === 'm' ? value * 60_000 : unit === 's' ? value * 1_000 : value
  return Math.max(0, Math.round(scaled))
}

/**
 * 摘出属于**本增强层**的全局旗标（对 add / remove / list / passthrough 一律生效，
 * 且不转发给 pnpm）。
 *
 * 为什么需要一层独立的全局旗标：`--json` / `--timeout` / `--yes` / `--no-lock`
 * 描述的是「这条命令怎么跑」，而不是「pnpm 怎么跑」。之前它们只能靠每个子命令各自
 * 解析，既容易漏，也会随子命令集合增长而漂移。
 * @param args - `dsh plugin` 之后的 argv
 * @returns `{ json, timeoutMs, timeoutRaw, newProfile, lock, rest }`
 */
export function parseGlobalFlags(args) {
  const argv = Array.isArray(args) ? args.map(String) : []
  const flags = { json: process.env.DSH_PLUGIN_OUTPUT === 'json', timeoutMs: undefined, timeoutRaw: undefined, newProfile: false, lock: true, rest: [] }
  const envTimeout = parseTimeoutToken(process.env.DSH_PLUGIN_TIMEOUT)
  if (envTimeout !== undefined) flags.timeoutMs = envTimeout
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--json') {
      flags.json = true
      continue
    }
    if (token.startsWith('--json=')) {
      flags.json = token.slice('--json='.length) !== 'false'
      continue
    }
    if (token === '--timeout') {
      flags.timeoutRaw = argv[i + 1]
      flags.timeoutMs = parseTimeoutToken(argv[i + 1])
      i += 1
      continue
    }
    if (token.startsWith('--timeout=')) {
      flags.timeoutRaw = token.slice('--timeout='.length)
      flags.timeoutMs = parseTimeoutToken(flags.timeoutRaw)
      continue
    }
    if (token === '--yes' || token === '--new-profile') {
      flags.newProfile = true
      continue
    }
    if (token === '--no-lock') {
      flags.lock = false
      continue
    }
    flags.rest.push(token)
  }
  return flags
}

/**
 * 解析 `dsh plugin` 之后的参数。
 *
 * 设计原则：**只吃掉属于自己的参数，其余原样交给 pnpm**。因此 `why`、`update`、
 * `outdated`、`install` 等既有用法零影响；`add` 里混入的 pnpm 旗标（`-D`、`--save-exact`…）
 * 也会原样透传。本层全局旗标由 {@link parseGlobalFlags} 先摘掉。
 *
 * 已知权衡：`--dry-run` 被本层接管（不再是 pnpm 的 dry-run），因为「先看要写什么
 * 再决定要不要动 profile」是这里最重要的安全阀。
 * @param args - `dsh plugin` 之后的 argv
 * @returns 判别联合：`help` / `add` / `remove` / `list` / `passthrough`（附 `flags`）
 */
export function parsePluginSubcommand(args) {
  const raw = Array.isArray(args) ? args.map(String) : []
  const flags = parseGlobalFlags(raw)
  const argv = flags.rest

  // 先摘全局旗标再判断帮助：`dsh plugin --json --help` 也该走帮助
  if (argv.length === 0) return { kind: 'help', reason: raw.length === 0 ? 'empty' : 'asked', flags }
  if (argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') return { kind: 'help', reason: 'asked', flags }

  const sub = argv[0]
  const rest = argv.slice(1)

  if (ADD_ALIASES.has(sub)) {
    const own = { id: undefined, config: undefined, configRaw: undefined, mount: true, dryRun: false }
    const specs = []
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i]
      if (token === '--id') {
        own.id = rest[i + 1]
        i += 1
        continue
      }
      if (token.startsWith('--id=')) {
        own.id = token.slice('--id='.length)
        continue
      }
      if (token === '--config') {
        own.configRaw = rest[i + 1]
        i += 1
        continue
      }
      if (token.startsWith('--config=')) {
        own.configRaw = token.slice('--config='.length)
        continue
      }
      if (token === '--no-mount') {
        own.mount = false
        continue
      }
      if (token === '--dry-run') {
        own.dryRun = true
        continue
      }
      specs.push(token)
    }
    return { kind: 'add', specs, own, flags }
  }

  if (REMOVE_ALIASES.has(sub)) {
    const own = { dryRun: false }
    const specs = []
    for (const token of rest) {
      if (token === '--dry-run') {
        own.dryRun = true
        continue
      }
      specs.push(token)
    }
    return { kind: 'remove', specs, own, flags }
  }

  if (LIST_ALIASES.has(sub)) return { kind: 'list', extra: rest, flags }

  return { kind: 'passthrough', args: argv, flags }
}

/**
 * `dsh plugin --help` 的正文。
 * @param profile - 当前（或默认）profile 名，用于示例；可省略
 */
export function pluginHelpText(profile = 'web') {
  return `用法：
  dsh plugin --profile <名称> add <包名|路径> [选项]   安装并自动挂载插件
  dsh plugin --profile <名称> remove <包名>            摘除补丁并卸载依赖
  dsh plugin --profile <名称> list                     列出插件挂载状态
  dsh plugin --profile <名称> <其它 pnpm 参数…>        原样转发给 pnpm（why / update / …）

add 的三步自动化（这三步以前需要手工做）：
  1. 依赖安装：在 profile 目录执行 pnpm add（首次使用时自动初始化 profile）
  2. 原生模块放行：把依赖树里需要构建脚本的包（如 better-sqlite3）写进
     pnpm-workspace.yaml 的 allowBuilds: <包名>: true —— pnpm 11 的正确键名与形状
  3. 补丁挂载：该包声明了 dsh 元数据（如 dsh.client）且不是 bundle 时，
     自动往 cordis.patch.yml 追加合法的 - insert: 条目（幂等，已挂载则跳过）

add 选项：
  --id <名称>      挂载条目的 id（默认由包名派生，如 @scope/pkg → scope-pkg）
  --config <JSON>  挂载 config（默认不写，交给插件自身的 schema 默认值）
  --no-mount       只安装依赖，不改 cordis.patch.yml
  --dry-run        只预览将写入的内容：不执行 pnpm、不落盘

remove 选项：
  --dry-run        只预览将删除的行范围

全局选项（任何子命令都可用，不会转发给 pnpm）：
  --json           只把结果以单行 JSON 输出到 stdout（人类可读日志改走 stderr）
                   也可用 DSH_PLUGIN_OUTPUT=json 常开
  --timeout <值>   pnpm 超时，支持 1500 / 30s / 5m；超时以退出码 124 结束
                   也可用 DSH_PLUGIN_TIMEOUT 设置默认值（不设则不限时）
  --yes            确认「用内置默认层栈首次创建无模板的同名 profile」
                   （又名 --new-profile；没有它时，未知 profile 名的首次创建会被拒绝）
  --no-lock        跳过 profile 互斥锁（默认会用 .dsh-plugin.lock 串行化写操作）

示例：
  dsh plugin --profile ${profile} add dsh-plugin-tlmemory
  dsh plugin --profile ${profile} add file:D:/Code/my-dsh-plugins/packages/tlmemory
  dsh plugin --profile ${profile} add dsh-plugin-tlmemory --dry-run
  dsh plugin --profile ${profile} list --json
  dsh plugin --profile ${profile} remove dsh-plugin-tlmemory

说明：
  * 未指定 --profile 时默认使用 web（会先提示一行再执行）；
  * 写文件前一律生成 <文件名>.bak-dsh-plugin-<时间戳> 备份，写入后立即复读校验；
  * 回写 package.json 前会另存一份 .bak-dsh-plugin-manifest-<时间戳>，并原子替换；
  * 会写盘的子命令（add / remove / install / update…）默认持有 profile 锁，
    拿不到锁就明确失败，绝不并发覆盖；
  * pnpm 的输出会被实时转发**同时**被捕获：失败时给出带稳定前缀的分类诊断
    （dsh: diagnose: <错误码>: …），退出码 0/2/3/4/124 为稳定契约，其余透传 pnpm；
  * 不改动 profile 里 cordis.patch.yml 的既有内容与注释，只做追加 / 精确摘除；
  * bundle 形态（声明 dsh.bundle.patch）的插件由 dsh.profile.bundles 层栈托管，
    本命令不会重复挂载。
`
}

