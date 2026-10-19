// packages/tlmemory/src/config.ts
// 插件配置的唯一定义处（schema + 默认值 + 运行期读取）。
//
// 为什么单独成文件：
//   1. schema 是宿主设置页的**唯一事实来源** —— 宿主 `SettingsForms.describe()`
//      取 `entry.fiber.runtime.Config`（即本模块导出的 `Config`）并据此渲染表单
//      （@deepseek-ai/dsh-settings/lib/index.js:538-541），因此 Config 必须带
//      `toJSON()`（schemastery Schema 天然满足）；
//   2. 设置页默认**不显示任何字段** —— 只有 `meta.volatile === true` 的字段才会被
//      `volatileForm()` 收进表单（同文件 :122-131），写入时 `isVolatilePath()`
//      逐路径复核（同文件 :153-158，校验点在 :507）。所以下面每个字段都套
//      `volatile()`；漏标 = 用户看不到、也存不进去；
//   3. 客户端浏览器半边无法 import 本文件（含 node:os / node:path），面板只从
//      宿主 `describe()` 的 schema 投影里拿字段，这里不导出任何浏览器可见常量。
import os from 'node:os'
import path from 'node:path'
import Schema from 'schemastery'

/**
 * 插件配置（全部可选：零必填是硬契约 —— 不写任何 config，插件必须完整可用）。
 *
 * 路径默认值刻意**不写进 schema.default**：schema 默认值会被宿主在保存表单时
 * 落成真实字符串，而 `~/.dsh/tlmemory.db` 是「当前用户主目录」的语义，
 * 写成字面量会把 A 机器的绝对路径带到 B 机器。默认值由 MemoryDB 在打开库时按
 * `os.homedir()` 现算（src/db.ts:148）。
 */
export interface Config {
  dbPath?: string
  serverPort?: number
  maxRecallCount?: number
  enableAutoReflection?: boolean
  /** M3 compaction 间隔：每累计 N 次静默沉淀触发一轮强化衰减 + 矛盾检测（默认 20） */
  compactionInterval?: number
  /**
   * 记忆归并开关（1.1.0）：开启后每轮 compaction 额外把「同主题多句话」折叠成一条摘要。
   * 归并产物是父子结构且可回滚（merges 表 + revert），因此默认开启。
   */
  enableAutoMerge?: boolean
}

/** 各数值/布尔字段的默认值（与 schema.default 保持一致，供读取端兜底） */
export const CONFIG_DEFAULTS = {
  serverPort: 4890,
  maxRecallCount: 5,
  enableAutoReflection: true,
  compactionInterval: 20,
  enableAutoMerge: true,
} as const

/** 未配置 dbPath 时 MemoryDB 实际使用的路径（仅用于日志与文档，不写入 schema 默认值） */
export function defaultDbPath(): string {
  return path.join(os.homedir(), '.dsh', 'tlmemory.db')
}

/**
 * 标记字段为 volatile：宿主设置页据此把字段渲染成「改完即生效」的表单。
 *
 * 语义依据（@deepseek-ai/dsh-settings/lib/index.js）：
 *   - :122-131 volatileForm() 沿 type==='object' 的 dict 递归收集 volatile 叶子；
 *   - :153-158 isVolatilePath() 在写入时逐路径复核，非 volatile 路径直接拒绝。
 *
 * schemastery 的 `meta` 是普通可写对象（3.18 实测：`schema.meta.volatile = true`
 * 会进入 `toJSON().refs[uid].meta.volatile`），因此不需要任何运行时依赖。
 */
export function volatile<T extends Schema>(field: T): T {
  ;(field.meta as Record<string, unknown>).volatile = true
  return field
}

/**
 * 插件配置 schema。
 *
 * 字段顺序 = 设置页渲染顺序；描述文本直接当面板提示用（客户端读 schema 投影）。
 */
export const Config: Schema<Config> = Schema.object({
  dbPath: volatile(
    Schema.string().description(
      'SQLite 数据库物理文件路径。留空使用默认 ~/.dsh/tlmemory.db；修改后插件会重新打开该库',
    ),
  ),
  serverPort: volatile(
    Schema.number().default(CONFIG_DEFAULTS.serverPort).description('记忆看板与本机 REST API 的服务端口'),
  ),
  maxRecallCount: volatile(
    Schema.number().default(CONFIG_DEFAULTS.maxRecallCount).description('每一轮最多注入系统提示词的记忆条数'),
  ),
  enableAutoReflection: volatile(
    Schema.boolean()
      .default(CONFIG_DEFAULTS.enableAutoReflection)
      .description('会话结束是否异步自动提炼沉淀（关闭后仅保留手动 save_memory）'),
  ),
  compactionInterval: volatile(
    Schema.number()
      .default(CONFIG_DEFAULTS.compactionInterval)
      .description('每累计 N 次沉淀触发一轮强化衰减与矛盾检测（0 表示不自动触发）'),
  ),
  enableAutoMerge: volatile(
    Schema.boolean()
      .default(CONFIG_DEFAULTS.enableAutoMerge)
      .description('是否把同一主题的多条短记忆自动归并成一条摘要（可回滚）'),
  ),
})

/** 读取函数：每次调用都回读宿主当前配置，绝不返回装配期的冻结快照 */
export type ConfigReader = () => Config

/**
 * 构造「运行期实时配置」读取器。
 *
 * 为什么要这样读：cordis 在配置变更时会把新 config 写回 fiber 并重启插件
 * （cordis/index.mjs:446 `plugin.apply(context, config)`、:470 `this.apply(this.context, this._config)`），
 * 所以装配期拿到的对象在下次 apply 前是旧的。把 config 闭包成常量做长期缓存
 * （本仓库 0.8.2 的白名单事故同型）会让「改完设置不生效」再现；这里优先回读
 * `ctx.fiber.config`（宿主每次 describe/重启都更新它），读不到才退回装配参数
 * —— 单测里传入的纯对象同样适用。
 */
export function liveConfig(ctx: unknown, initial: Config): ConfigReader {
  const fiber = ctx !== null && typeof ctx === 'object' ? (ctx as { fiber?: { config?: unknown } }).fiber : undefined
  return () => {
    const current = fiber?.config
    return current !== null && typeof current === 'object' ? (current as Config) : initial
  }
}

/**
 * 归一化 dbPath：空白字符串视为「未配置」，交还 MemoryDB 的默认路径分支。
 *
 * 关键防御：空字符串若直接传给 MemoryDB，`path.dirname('')` 返回 '.'，
 * 随后 openDatabase('') 抛出 —— 设置页里「清空路径」是最容易被点的操作，
 * 必须在边界上收口（src/db.ts:146-152 只对 ':memory:' 做了特判）。
 */
export function resolveDbPath(config: Config | undefined): string | undefined {
  const raw = typeof config?.dbPath === 'string' ? config.dbPath.trim() : ''
  return raw === '' ? undefined : raw
}
