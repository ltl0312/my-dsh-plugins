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
//   - config.json 是运行时权威存储：`/mode` 之类的 IM 命令、以及插件自己的
//     设置页都写它。
//   - 推论：想让 `/mode` 命令能改运行模式，就**不要**在 GUI/补丁里显式写 `mode`。
//
//   ⚠️ 「写没写」在解析后的配置里是看不出来的——宿主先跑了一遍本插件的 `Config`
//   schema，schemastery 会把缺失字段填成默认值（见 `writtenOnly()`）。所以这里的
//   判据是「与内置默认值不同才算写过」；少了这一步，config.json 里的设置会在每次
//   启动被默认值覆盖掉。
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

/**
 * 会话模式的默认值。
 *
 * `targetSessionId` 是遗留字段（投递已经不看它了），但**必须在这里给出默认值**：
 * `writtenOnly()` 拿这份默认面判断「用户到底写没写」，漏掉一个键，宿主 schema 填出来
 * 的那个空默认值就会被当成用户意图，把 config.json 里的值盖成空。
 */
export function defaultSessionMode(): SessionModeConfig {
  return {
    targetSessionId: '',
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

/**
 * 内置默认配置。
 *
 * ⚠️ **每一个可配置的键都要在这里出现**，包括看起来「省略就等于空串」的那几个
 * （`defaultChannelId` / `dataDir` / `session.targetSessionId`）。这份对象同时是
 * `writtenOnly()` 的比较基准：漏掉一个键，宿主 schema 补出来的空默认值就会被当成
 * 「用户写过」，把 config.json 里的设置盖成空——默认通道被清掉就是这么来的。
 */
export function defaultConfig(): TlnotifyConfig {
  return {
    enabled: true,
    mode: 'global',
    defaultChannelId: '',
    channels: [],
    events: defaultEvents(),
    content: defaultContent(),
    routing: defaultRouting(),
    session: defaultSessionMode(),
    global: defaultGlobalMode(),
    logLevel: 'info',
    dataDir: '',
  }
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 结构相等（数组逐项、对象逐键）；`===` 之外只需要覆盖配置里的形状。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every((key) => key in b && sameValue(a[key], b[key]))
  }
  return false
}

/**
 * 挑出「确实写过」的那部分：只保留与内置默认值**不同**的键，整棵子树都等于默认值时
 * 整枝丢掉。
 *
 * ── 为什么必须这么判 ─────────────────────────────────────────────────────
 *
 * 宿主装载插件时会先跑一遍插件自己的 `Config` schema：cordis 的 `resolveConfig()`
 * （`cordis/lib/index.mjs:156-165`）就是一句 `config = schema(config)`，而 schemastery
 * 会把**没写的字段**逐个填成 `.default()`。所以 `apply(ctx, config)` 收到的对象里
 * `content.maxBodyChars` 永远是 1800、`routing.tableTtlDays` 永远是 7——跟用户在补丁 /
 * GUI 表单里到底写没写过毫无关系。
 *
 * 而本文件顶部的规则是「显式配置 > config.json > 内置默认值」，并且写明「只有**确实
 * 写了的字段**才算显式」。两件事在解析后的配置里是矛盾的：默认值把「没写」伪装成了
 * 「写过」。后果不只是显示不对，而是**数据被毁**——`persistEffectiveConfig()` 每次启动
 * 都把有效配置写回 config.json，于是插件设置页里刚设好的 4000，会在下次启动被 1800
 * 覆盖进文件（现场：用户报「设置正文上限后下次打开 DSH 又变回 1800」，而 config.json
 * 里确实只剩 1800）。
 *
 * 判据只能是「与默认值不同」：解析后的配置不携带 presence 元数据，这是唯一还有信息量
 * 的信号。
 *
 * ── 已知代价 ─────────────────────────────────────────────────────────────
 *
 * 用户在补丁 / GUI 表单里**显式写了一个恰好等于默认值的值**，会被当成没写。那个值想
 * 覆盖的文件值只可能来自插件自己的设置页，而「用户最后在设置页里改成的值」才是他最后
 * 表达过的意图，以文件为准反而是对的。所以这个代价可以接受，也让 `applyRuntimeOverrides()`
 * 那条为 `mode` 打的补丁不再扩大。
 */
function writtenOnly(
  source: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!(key in defaults)) {
      // 默认值里没有这个键：不是默认值能解释的东西，按「写过」处理。
      out[key] = value
      continue
    }
    const fallback = defaults[key]
    if (isPlainObject(value) && isPlainObject(fallback)) {
      const nested = writtenOnly(value, fallback)
      if (Object.keys(nested).length > 0) out[key] = nested
      continue
    }
    if (!sameValue(value, fallback)) out[key] = value
  }
  return out
}

/** 把宿主传来的配置投影成「用户确实写过的那部分」；什么都没写时返回 `undefined`。 */
function explicitOnly(
  explicit: Partial<TlnotifyConfig> | undefined,
): Partial<TlnotifyConfig> | undefined {
  if (!explicit) return undefined
  const written = writtenOnly(
    explicit as Record<string, unknown>,
    defaultConfig() as unknown as Record<string, unknown>,
  )
  return Object.keys(written).length > 0 ? (written as Partial<TlnotifyConfig>) : undefined
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
 *
 * 「显式」不是「宿主给了这个键」——宿主给出的对象被 schema 补满默认值，每个键都在
 * （见 `writtenOnly()`）。只有与内置默认值不同的叶子才算用户写过，否则 config.json
 * 说了算。少了这一步，文件里的设置会在每次启动被默认值冲掉。
 */
export function mergeConfig(
  explicit: Partial<TlnotifyConfig> | undefined,
  fromFile: Partial<TlnotifyConfig> | undefined,
): TlnotifyConfig {
  let merged = deepMerge(defaultConfig(), fromFile ?? {})
  const written = explicitOnly(explicit)
  if (written) {
    const { channels, ...rest } = written
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
 * 只在用户**确实写过**的字段上保留文件版本，避免把 GUI 的意图固化成文件之后用户
 * 再也改不动 GUI。判据与 `mergeConfig()` 同源（`explicitOnly()`）——宿主给出的
 * 默认值不算写过，否则这里会把默认值当成用户意图、把文件里的设置固化成默认值。
 * 返回实际写盘的对象。
 */
export function persistEffectiveConfig(
  dataDir: string,
  effective: TlnotifyConfig,
  explicit: Partial<TlnotifyConfig> | undefined,
): TlnotifyConfig {
  const onDisk = readConfigFile(dataDir) ?? {}
  const next: Partial<TlnotifyConfig> = { ...onDisk }
  const explicitKeys = new Set(Object.keys(explicitOnly(explicit) ?? {}))
  for (const [key, value] of Object.entries(effective)) {
    if (key === 'channels') {
      // channels 是运行时最容易改的字段（换机器人 / 加通道），始终以有效值为准。
      next.channels = effective.channels
      continue
    }
    if (!explicitKeys.has(key)) (next as Record<string, unknown>)[key] = value
  }
  // 用户写过的字段保持文件原值（可能本来就没有），由下面的 mergeConfig 决定谁生效。
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
 * 写了哪些键」——判定显式性只能靠「与默认值不同」，见 `writtenOnly()`。
 */
/**
 * 事件开关。全局默认与「每机器人覆盖」共用同一份 schema——两处形状必须一致，
 * 否则设置页把一份自定义规则存进通道、宿主读出来却是另一套字段。
 */
const EventsSchema = Schema.object({
  onTurnEnd: Schema.boolean().default(true).description('任务完成'),
  onError: Schema.boolean().default(true).description('执行错误'),
  onAborted: Schema.boolean().default(true).description('手动中止'),
  onPending: Schema.boolean().default(true).description('等待我回答 / 等待授权 / 等待计划确认'),
  onMaxTokens: Schema.boolean().default(true).description('Token 达到上限'),
  includeSubagent: Schema.boolean().default(false).description('子 Agent 事件也推送'),
})
  .default(defaultEvents())
  .description('事件开关')

/** 正文内容。全局默认与「每机器人覆盖」共用，理由同上。 */
const ContentSchema = Schema.object({
  includeMetadata: Schema.boolean().default(true).description('正文附带耗时 / token'),
  includeUserPrompt: Schema.boolean().default(false).description('正文附带上一轮用户提问'),
  maxBodyChars: Schema.number().min(200).max(20000).step(1).default(1800).description('正文上限字符数'),
})
  .default(defaultContent())
  .description('正文内容')

const ChannelSchema = Schema.object({
  id: Schema.string().default('').description('通道标识，唯一，用于 defaultChannelId 引用'),
  type: Schema.union(['qq', 'feishu'] as const).default('qq').description('通道类型'),
  enabled: Schema.boolean().default(true).description('是否启用'),
  appId: Schema.string().default('').description('QQ 机器人 AppID'),
  appSecret: Schema.string().role('secret').default('').description('QQ 机器人 AppSecret'),
  targetChatId: Schema.string().default('').description('QQ 单聊目标 openid（你自己）'),
  groupChatId: Schema.string().default('').description('QQ 群 openid（填了就投到群）'),
  markdown: Schema.boolean()
    .default(false)
    .description('QQ 用原生 Markdown 卡片发（更窄、不随窗口自适应）；关掉则发纯文本'),
  feishuAppId: Schema.string().default('').description('飞书自建应用 App ID'),
  feishuAppSecret: Schema.string().role('secret').default('').description('飞书自建应用 App Secret'),
  feishuReceiveId: Schema.string().default('').description('飞书接收方 id'),
  feishuReceiveIdType: Schema.union(['open_id', 'chat_id', 'user_id', 'union_id', 'email'] as const)
    .default('open_id')
    .description('飞书 receive_id_type'),
  mode: Schema.union(['active', 'passive'] as const).default('active').description('投递模式'),
  bindUrl: Schema.string()
    .default('')
    .description('扫码绑定用的机器人分享链接（QQ 必填；飞书可留空，由 App ID 推导）'),
  label: Schema.string().default('').description('别名，只在设置页显示；留空显示通道 id'),
  sessionScope: Schema.union(['all', 'single', 'filter'] as const)
    .default('all')
    .description('关心全部会话（all）/ 只关心绑定的那一个会话（single）/ 只关心列表里的会话（filter）'),
  sessionId: Schema.string().default('').description('单会话模式绑定的会话 id'),
  sessionFilter: Schema.array(Schema.string()).default([]).description('只推这些会话；留空 = 全部'),
  historyTurns: Schema.number()
    .min(0)
    .max(20)
    .step(1)
    .description('正文附带该会话最近 N 轮历史；不填 = 跟随全局，0 = 不带'),
  overrideEvents: Schema.boolean().default(false).description('事件开关是否覆盖全局'),
  events: EventsSchema,
  overrideContent: Schema.boolean().default(false).description('正文内容是否覆盖全局'),
  content: ContentSchema,
})

export const Config: Schema<TlnotifyConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关'),
  mode: Schema.union(['global', 'session'] as const)
    .default('global')
    .description('global=所有主会话都推；session=只推绑定的那一个会话'),
  defaultChannelId: Schema.string().default('').description('默认通道 id；留空则用第一个启用的通道'),
  channels: Schema.array(ChannelSchema).default([]).description('IM 通道列表'),
  events: EventsSchema,
  content: ContentSchema,
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

// ---------------------------------------------------------------------------
// 每机器人独立设置：生效规则
// ---------------------------------------------------------------------------

/** 一台机器人最终生效的通知规则（全局默认 + 通道覆盖）。 */
export function resolveChannelSettings(
  config: Pick<TlnotifyConfig, 'events' | 'content'>,
  channel: Pick<ChannelConfig, 'overrideEvents' | 'events' | 'overrideContent' | 'content'>,
): { events: EventsConfig; content: ContentConfig } {
  return {
    // 覆盖时以**内置默认值**为底，而不是全局值：用户在设置页把一台机器人切到
    // 「自定义」时会先拿当前生效值播种、再整体上行，所以这里不该再偷偷继承
    // 全局——否则全局一改，已经被单独设置过的机器人会跟着变，那就不叫独立了。
    events:
      channel.overrideEvents && channel.events
        ? { ...defaultEvents(), ...channel.events }
        : config.events,
    content:
      channel.overrideContent && channel.content
        ? { ...defaultContent(), ...channel.content }
        : config.content,
  }
}

/**
 * 这台机器人最终生效的会话范围。
 *
 * `sessionScope` 缺省时按 `sessionId` / `sessionFilter` 是否有值推断，保证旧
 * 配置「留空 = 全部、填了 = 白名单」继续按原意工作。
 *
 * 这是**投递的唯一依据**：全局的 `config.mode` 已经不再参与「推哪些会话」的判断
 * （见 `src/index.ts` 的 `#canPush()`），否则一台机器人选的「关心全部」会被另一个
 * 开关压掉。
 */
export function channelSessionScope(
  channel: Pick<ChannelConfig, 'sessionScope' | 'sessionId' | 'sessionFilter'>,
): 'all' | 'single' | 'filter' {
  const filter = Array.isArray(channel.sessionFilter) ? channel.sessionFilter : []
  const single = typeof channel.sessionId === 'string' ? channel.sessionId.trim() : ''
  return channel.sessionScope ?? (single ? 'single' : filter.length > 0 ? 'filter' : 'all')
}

/**
 * 这台机器人是否关心该会话。
 *
 * 三态：`'all'` 关心全部；`'single'` 只关心 `sessionId` 绑定的那一个（还没选
 * 会话时谁都不关心，宁可安静也别突然刷屏）；`'filter'` 只关心
 * `sessionFilter` 列表里的。
 */
export function channelCaresAboutSession(
  channel: Pick<ChannelConfig, 'sessionScope' | 'sessionId' | 'sessionFilter'>,
  sessionId: string,
): boolean {
  const scope = channelSessionScope(channel)
  if (scope === 'all') return true
  if (scope === 'single') {
    const single = typeof channel.sessionId === 'string' ? channel.sessionId.trim() : ''
    return single.length > 0 && single === sessionId
  }
  const filter = Array.isArray(channel.sessionFilter) ? channel.sessionFilter : []
  return filter.includes(sessionId)
}
