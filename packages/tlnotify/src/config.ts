// packages/tlnotify/src/config.ts
//
// 配置的解析、合并与落盘。
//
// ── 权威性规则（重要，README 里也要写清楚）──────────────────────────────────
//
//   显式配置  >  $DSH_HOME/tlnotify/config.json  >  内置默认值
//
//   - 「显式配置」= 宿主传进来的 cordis config（profile 补丁里的裸 row / GUI 表单）。
//     只有**确实写了的字段**才算显式；没写的字段不会覆盖文件。
//   - config.json 是运行时权威存储：`/mode` 之类的 IM 命令、以及将来可能的
//     自建设置页都写它。
//   - 推论：想让 `/mode` 命令能改运行模式，就**不要**在 GUI/补丁里显式写 `mode`。
//
// 这样两种用法都自洽：纯 GUI 用户（从不碰文件）改表单即生效；命令行用户
// （从不碰 GUI）改文件即生效；两者都用的用户按上面的优先级推理即可。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from 'schemastery'
import type {
  ChannelConfig,
  ContentConfig,
  EventsConfig,
  GlobalModeConfig,
  RoutingConfig,
  SessionModeConfig,
  TlnotifyConfig,
} from './types.js'

export const CONFIG_FILENAME = 'config.json'
export const STATE_FILENAME = 'state.json'

/** `$DSH_HOME`（宿主约定的家目录），回退到 `~/.dsh`。 */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** 配置/状态/日志目录：`$DSH_HOME/tlnotify`（可用 dataDir 覆盖）。 */
export function resolveDataDir(config?: Pick<TlnotifyConfig, 'dataDir'>): string {
  const custom = config?.dataDir?.trim()
  return custom && custom.length > 0 ? custom : join(resolveDshHome(), 'tlnotify')
}

export function defaultEvents(): EventsConfig {
  return {
    onTurnEnd: true,
    onError: true,
    onAborted: true,
    onPending: true,
    onMaxTokens: true,
    includeSubagent: false,
  }
}

export function defaultContent(): ContentConfig {
  return {
    includeMetadata: true,
    includeUserPrompt: false,
    maxBodyChars: 1800,
  }
}

export function defaultRouting(): RoutingConfig {
  return {
    allowPrefix: true,
    fallback: 'latest',
    tableTtlDays: 7,
    echoTarget: true,
  }
}

export function defaultSessionMode(): SessionModeConfig {
  return {
    context: {
      includeAssistant: true,
      includeTools: true,
      includeTiming: true,
      previousTurns: 3,
      includeUserPrompt: true,
    },
  }
}

export function defaultGlobalMode(): GlobalModeConfig {
  return {
    verbosity: 'brief',
    includeSessionLabel: true,
    includeSummaryLine: true,
    includeSubagent: false,
  }
}

export function defaultConfig(): TlnotifyConfig {
  return {
    enabled: true,
    mode: 'global',
    channels: [],
    events: defaultEvents(),
    content: defaultContent(),
    routing: defaultRouting(),
    session: defaultSessionMode(),
    global: defaultGlobalMode(),
    logLevel: 'info',
  }
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 逐层合并，只覆盖 source 里**确实存在**的键；数组整体替换。 */
function deepMerge<T>(base: T, source: unknown): T {
  if (source === undefined) return base
  if (Array.isArray(source)) return source as unknown as T
  if (!isPlainObject(source)) return source as unknown as T
  if (!isPlainObject(base)) return source as unknown as T
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    out[key] = deepMerge((base as Record<string, unknown>)[key], value)
  }
  return out as T
}

/**
 * 合并三层：默认值 ← 文件 ← 显式配置。
 *
 * `channels` 特殊处理：任何一侧给出了**非空数组**就整体替换，避免出现
 * 「默认空数组 + 文件里的通道」被逐项合并成半截配置的情况。
 */
export function mergeConfig(
  explicit: Partial<TlnotifyConfig> | undefined,
  fromFile: Partial<TlnotifyConfig> | undefined,
): TlnotifyConfig {
  let merged = deepMerge(defaultConfig(), fromFile ?? {})
  if (explicit && Object.keys(explicit).length > 0) {
    const { channels, ...rest } = explicit
    merged = deepMerge(merged, rest)
    if (Array.isArray(channels) && channels.length > 0) {
      merged.channels = channels as ChannelConfig[]
    }
  }
  // 兜底：任何来源都可能给出空数组，最终统一成数组。
  if (!Array.isArray(merged.channels)) merged.channels = []
  return merged
}

/** 给一个配置对象补齐所有必填字段（用于从文件读到半截 JSON 的情况）。 */
export function normalizeConfig(input: unknown): TlnotifyConfig {
  return mergeConfig(isPlainObject(input) ? (input as Partial<TlnotifyConfig>) : undefined, undefined)
}

// ---------------------------------------------------------------------------
// 文件读写
// ---------------------------------------------------------------------------

export function configPath(dataDir: string): string {
  return join(dataDir, CONFIG_FILENAME)
}

export function statePath(dataDir: string): string {
  return join(dataDir, STATE_FILENAME)
}

export function ensureDir(dataDir: string): void {
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch {
    /* 目录建不出来时后续写入会自己报错并降级 */
  }
}

/** 读 JSON；不存在/损坏/非对象都返回 undefined，绝不抛。 */
export function readJsonFile<T = unknown>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return undefined
    const raw = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return parsed as T
  } catch {
    return undefined
  }
}

/** 原子写：先写 `.tmp` 再 rename，避免半截 JSON 被下次启动读到。 */
export function writeJsonFile(path: string, value: unknown): boolean {
  const tmp = `${path}.tmp`
  try {
    mkdirSync(join(path, '..'), { recursive: true })
  } catch {
    /* 忽略 */
  }
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

export function readConfigFile(dataDir: string): Partial<TlnotifyConfig> | undefined {
  const raw = readJsonFile<unknown>(configPath(dataDir))
  return isPlainObject(raw) ? (raw as Partial<TlnotifyConfig>) : undefined
}

export function saveConfigFile(dataDir: string, config: TlnotifyConfig): boolean {
  return writeJsonFile(configPath(dataDir), config)
}

/**
 * 把「有效配置」回写到 config.json。
 *
 * 只在显式配置**没有**提供的字段上写文件版本，避免把 GUI 的意图固化成文件
 * 之后用户再也改不动 GUI。返回实际写盘的对象。
 */
export function persistEffectiveConfig(
  dataDir: string,
  effective: TlnotifyConfig,
  explicit: Partial<TlnotifyConfig> | undefined,
): TlnotifyConfig {
  const onDisk = readConfigFile(dataDir) ?? {}
  const next: Partial<TlnotifyConfig> = { ...onDisk }
  const explicitKeys = new Set(Object.keys(explicit ?? {}))
  for (const [key, value] of Object.entries(effective)) {
    if (key === 'channels') {
      // channels 是运行时最容易改的字段（换机器人 / 加通道），始终以有效值为准。
      next.channels = effective.channels
      continue
    }
    if (!explicitKeys.has(key)) (next as Record<string, unknown>)[key] = value
  }
  // 显式配置里的字段保持文件原值（可能本来就没有）。
  for (const key of explicitKeys) {
    if (key === 'channels') continue
    if (onDisk[key as keyof TlnotifyConfig] !== undefined) {
      ;(next as Record<string, unknown>)[key] = onDisk[key as keyof TlnotifyConfig]
    }
  }
  const written = mergeConfig(explicit, next)
  saveConfigFile(dataDir, written)
  return written
}

// ---------------------------------------------------------------------------
// 宿主 GUI 用的 schemastery schema
// ---------------------------------------------------------------------------

/**
 * 宿主 GUI（Settings > Plugins > Plugin configuration）会自动按这个 schema
 * 生成表单；namespace 的 key 就是 profile 补丁里的 entry id（`dsh-plugin-tlnotify`）。
 *
 * 注意：schema 只负责**校验与呈现**，字段是否算「显式」由 apply 时收到的对象
 * 决定。schemastery 会为缺失字段填上 default，所以插件内部拿不到「用户到底
 * 写了哪些键」——因此 index.ts 里另外读了一次原始 profile 补丁值来判定显式性
 * 见 `extractExplicitKeys`。
 */
const ChannelSchema = Schema.object({
  id: Schema.string().default('').description('通道标识，唯一，用于 defaultChannelId 引用'),
  type: Schema.union(['qq', 'feishu'] as const).default('qq').description('通道类型'),
  enabled: Schema.boolean().default(true).description('是否启用'),
  appId: Schema.string().default('').description('QQ 机器人 AppID'),
  appSecret: Schema.string().role('secret').default('').description('QQ 机器人 AppSecret'),
  targetChatId: Schema.string().default('').description('QQ 单聊目标 openid（你自己）'),
  groupChatId: Schema.string().default('').description('QQ 群 openid（填了就投到群）'),
  feishuAppId: Schema.string().default('').description('飞书自建应用 App ID'),
  feishuAppSecret: Schema.string().role('secret').default('').description('飞书自建应用 App Secret'),
  feishuReceiveId: Schema.string().default('').description('飞书接收方 id'),
  feishuReceiveIdType: Schema.union(['open_id', 'chat_id', 'user_id', 'union_id', 'email'] as const)
    .default('open_id')
    .description('飞书 receive_id_type'),
  mode: Schema.union(['active', 'passive'] as const).default('active').description('投递模式'),
  sessionFilter: Schema.array(Schema.string()).default([]).description('只推这些会话；留空 = 全部'),
})

export const Config: Schema<TlnotifyConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关'),
  mode: Schema.union(['global', 'session'] as const)
    .default('global')
    .description('global=所有主会话都推；session=只推绑定的那一个会话'),
  defaultChannelId: Schema.string().default('').description('默认通道 id；留空则用第一个启用的通道'),
  channels: Schema.array(ChannelSchema).default([]).description('IM 通道列表'),
  events: Schema.object({
    onTurnEnd: Schema.boolean().default(true).description('任务完成'),
    onError: Schema.boolean().default(true).description('执行错误'),
    onAborted: Schema.boolean().default(true).description('手动中止'),
    onPending: Schema.boolean().default(true).description('等待我回答 / 等待授权 / 等待计划确认'),
    onMaxTokens: Schema.boolean().default(true).description('Token 达到上限'),
    includeSubagent: Schema.boolean().default(false).description('子 Agent 事件也推送'),
  })
    .default(defaultEvents())
    .description('事件开关'),
  content: Schema.object({
    includeMetadata: Schema.boolean().default(true).description('正文附带耗时 / token'),
    includeUserPrompt: Schema.boolean().default(false).description('正文附带上一轮用户提问'),
    maxBodyChars: Schema.number().min(200).max(20000).step(1).default(1800).description('正文上限字符数'),
  })
    .default(defaultContent())
    .description('正文内容'),
  routing: Schema.object({
    allowPrefix: Schema.boolean().default(true).description('允许「<短id> 继续」显式前缀定向'),
    fallback: Schema.union(['latest', 'intervention', 'none'] as const)
      .default('latest')
      .description('无引用时的兜底目标'),
    tableTtlDays: Schema.number().min(1).max(90).step(1).default(7).description('路由表 TTL（天）'),
    echoTarget: Schema.boolean().default(true).description('回显「已发给 X」'),
  })
    .default(defaultRouting())
    .description('回复路由'),
  session: Schema.object({
    targetSessionId: Schema.string().default('').description('单会话模式绑定的会话 id'),
    context: Schema.object({
      includeAssistant: Schema.boolean().default(true).description('正文带助手回复摘要'),
      includeTools: Schema.boolean().default(true).description('正文带工具调用列表'),
      includeTiming: Schema.boolean().default(true).description('正文带耗时'),
      previousTurns: Schema.number().min(0).max(20).step(1).default(3).description('附带最近 N 轮'),
      includeUserPrompt: Schema.boolean().default(true).description('附带用户提问'),
    })
      .default(defaultSessionMode().context)
      .description('单会话模式上下文'),
  })
    .default({ targetSessionId: '', context: defaultSessionMode().context })
    .description('单会话模式'),
  global: Schema.object({
    verbosity: Schema.union(['brief', 'normal'] as const).default('brief').description('精简 / 常规'),
    includeSessionLabel: Schema.boolean().default(true).description('标题带项目与会话短 id'),
    includeSummaryLine: Schema.boolean().default(true).description('正文带一行摘要'),
    includeSubagent: Schema.boolean().default(false).description('子 Agent 也推（与 events 取或）'),
  })
    .default(defaultGlobalMode())
    .description('全局模式'),
  logLevel: Schema.union(['debug', 'info', 'warn', 'error'] as const).default('info').description('日志级别'),
  dataDir: Schema.string().default('').description('数据目录；留空 = $DSH_HOME/tlnotify'),
})
