/**
 * 设置页 RPC 的宿主侧实现：脱敏、白名单校验、补丁应用、失败翻译。
 *
 * 这里**不做 IO**——不读写文件、不发消息、不碰通道。`index.ts` 拿到这里的
 * 结果后再决定落盘与重连。这样切分的好处是这一整套规则可以在 vitest 里直接
 * 单测，不需要起一个假的 DSH。
 *
 * 契约（方法名、字段、信封）在 `./protocol.ts`。
 */

import type {
  ChannelConfig,
  ChannelType,
  TlnotifyConfig,
} from './types.js'
import type {
  ChannelPatch,
  RedactedChannel,
  RpcFailure,
  RpcResult,
  SecretState,
  StatePayload,
  TestFailureHint,
  TlnotifyPatch,
} from './protocol.js'

// ---------------------------------------------------------------------------
// 信封
// ---------------------------------------------------------------------------

/** 构造成功结果。 */
export function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

/** 构造失败结果；`details` 用于把「哪一项、期望什么」带回设置页。 */
export function fail(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): RpcResult<never> {
  const error: RpcFailure = { code, message, details }
  return { ok: false, error }
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

/** 密钥只报「配没配」+ 末四位。 */
export function secretState(secret: string | undefined): SecretState {
  const value = typeof secret === 'string' ? secret.trim() : ''
  if (!value) return { configured: false, hint: '' }
  const tail = value.length <= 4 ? value : value.slice(-4)
  return { configured: true, hint: `••••${tail}` }
}

/**
 * 日志与错误信息里的兜底脱敏。
 *
 * 上游 SDK 的报错经常把请求体原样带出来（App Secret 就在里面），所以凡是
 * 要写进日志或回给前端的错误文本，都先过一遍这里。
 */
export function redactText(text: string): string {
  return text
    // 常见密钥形态：32 位以上无空格串紧跟在 secret/token/key/app_secret 之后
    .replace(/((?:app[_-]?secret|secret|access[_-]?token|token|api[_-]?key)\s*[:=]\s*)([A-Za-z0-9_\-./+]{8,})/gi, '$1[redacted]')
    // 形如 {"appSecret":"xxxx"} 的 JSON 片段
    .replace(/("(?:appSecret|feishuAppSecret|app_secret|secret)"\s*:\s*")([^"]*)(")/gi, '$1[redacted]$3')
}

/** 单条通道 → 脱敏通道。 */
export function redactChannel(config: ChannelConfig): RedactedChannel {
  return {
    id: config.id,
    type: config.type,
    enabled: config.enabled,
    sessionFilter: Array.isArray(config.sessionFilter) ? [...config.sessionFilter] : [],
    ...(config.appId ? { appId: config.appId } : {}),
    ...(config.targetChatId ? { targetChatId: config.targetChatId } : {}),
    ...(config.groupChatId ? { groupChatId: config.groupChatId } : {}),
    ...(config.feishuAppId ? { feishuAppId: config.feishuAppId } : {}),
    ...(config.feishuReceiveId ? { feishuReceiveId: config.feishuReceiveId } : {}),
    feishuReceiveIdType: config.feishuReceiveIdType ?? 'open_id',
    mode: config.mode ?? 'active',
    ...(config.bindUrl ? { bindUrl: config.bindUrl } : {}),
    appSecret: secretState(config.appSecret),
    feishuAppSecret: secretState(config.feishuAppSecret),
  }
}

/** 整份配置 → 脱敏配置（`dataDir` 是真值，不是密钥）。 */
export function redactConfig(config: TlnotifyConfig, dataDir: string): StatePayload['config'] {
  return {
    enabled: config.enabled,
    mode: config.mode,
    ...(config.defaultChannelId ? { defaultChannelId: config.defaultChannelId } : {}),
    logLevel: config.logLevel,
    dataDir,
    channels: config.channels.map(redactChannel),
    events: { ...config.events },
    content: { ...config.content },
    routing: { ...config.routing },
    session: {
      ...(config.session.targetSessionId ? { targetSessionId: config.session.targetSessionId } : {}),
      context: { ...config.session.context },
    },
    global: { ...config.global },
  }
}

// ---------------------------------------------------------------------------
// 校验小工具
// ---------------------------------------------------------------------------

const CHANNEL_TYPES: readonly ChannelType[] = Object.freeze(['qq', 'feishu'] as const)
const RECEIVE_ID_TYPES = ['open_id', 'chat_id', 'user_id', 'union_id', 'email'] as const
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
const RUN_MODES = ['global', 'session'] as const
const FALLBACKS = ['latest', 'intervention', 'none'] as const
const VERBOSITIES = ['brief', 'normal'] as const
const CHANNEL_MODES = ['active', 'passive'] as const

class Rejection extends Error {
  readonly path: string
  readonly expected: string
  constructor(path: string, expected: string) {
    super(`${path} 期望 ${expected}`)
    this.name = 'Rejection'
    this.path = path
    this.expected = expected
  }
}

function reject(path: string, expected: string): never {
  throw new Rejection(path, expected)
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') reject(path, '布尔值')
  return value
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    reject(path, allowed.join(' | '))
  }
  return value as T
}

function requireInt(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    reject(path, `${min}..${max} 的整数`)
  }
  if (value < min || value > max) reject(path, `${min}..${max}`)
  return value
}

/**
 * 文本字段的三态：`undefined` 保持原值，`null` / 空串清空，其余写入。
 *
 * 返回 `undefined` 表示「该清空或没写」，调用方据此决定是否动这个键。
 */
function readTextPatch(
  value: string | null | undefined,
  path: string,
): { touched: boolean; value: string | undefined } {
  if (value === undefined) return { touched: false, value: undefined }
  if (value === null) return { touched: true, value: undefined }
  if (typeof value !== 'string') reject(path, '字符串或 null')
  const trimmed = value.trim()
  return { touched: true, value: trimmed === '' ? undefined : trimmed }
}

/** 写进对象：值为 undefined 时删键，而不是留一个 `key: undefined`。 */
function assign<K extends string, V>(
  target: Partial<Record<K, V>>,
  key: K,
  value: V | undefined,
): void {
  if (value === undefined) delete target[key]
  else target[key] = value
}

// ---------------------------------------------------------------------------
// patch 应用
// ---------------------------------------------------------------------------

/** 补丁白名单的顶层字段。 */
export const PATCH_TOP_KEYS: readonly string[] = Object.freeze([
  'enabled',
  'mode',
  'defaultChannelId',
  'logLevel',
  'channels',
  'events',
  'content',
  'routing',
  'session',
  'global',
] as const)

export interface PatchOutcome {
  next: TlnotifyConfig
  /** 实际变化的顶层字段名。 */
  changed: string[]
  /** 是否需要重启才生效；当前恒为 false。 */
  restartRequired: boolean
  /** 通道相关字段是否有变化（变了要重连通道）。 */
  channelsChanged: boolean
}

/**
 * 校验一个「部分对象」只含白名单内的键。
 *
 * 之所以要显式拒绝未知键而不是忽略，是因为设置页与宿主是两个独立演进的半边：
 * 如果新前端给旧宿主发了一个宿主不认识的字段而宿主默默丢掉，用户会看到
 * 「保存成功」但配置没变——这是最难排查的一类 bug。
 */
function assertKnownKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) reject(`${prefix}${key}`, `以下之一：${allowed.join(', ')}`)
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reject(path, '对象')
  }
  return value as Record<string, unknown>
}

function applyEvents(current: TlnotifyConfig, raw: unknown): TlnotifyConfig['events'] {
  const patch = asRecord(raw, 'events')
  assertKnownKeys(
    patch,
    ['onTurnEnd', 'onError', 'onAborted', 'onPending', 'onMaxTokens', 'includeSubagent'],
    'events.',
  )
  const next = { ...current.events }
  for (const key of Object.keys(patch) as (keyof TlnotifyConfig['events'])[]) {
    next[key] = requireBoolean(patch[key], `events.${key}`)
  }
  return next
}

function applyContent(current: TlnotifyConfig, raw: unknown): TlnotifyConfig['content'] {
  const patch = asRecord(raw, 'content')
  assertKnownKeys(patch, ['includeMetadata', 'includeUserPrompt', 'maxBodyChars'], 'content.')
  const next = { ...current.content }
  if (patch.includeMetadata !== undefined) {
    next.includeMetadata = requireBoolean(patch.includeMetadata, 'content.includeMetadata')
  }
  if (patch.includeUserPrompt !== undefined) {
    next.includeUserPrompt = requireBoolean(patch.includeUserPrompt, 'content.includeUserPrompt')
  }
  if (patch.maxBodyChars !== undefined) {
    next.maxBodyChars = requireInt(patch.maxBodyChars, 'content.maxBodyChars', 200, 20000)
  }
  return next
}

function applyRouting(current: TlnotifyConfig, raw: unknown): TlnotifyConfig['routing'] {
  const patch = asRecord(raw, 'routing')
  assertKnownKeys(patch, ['allowPrefix', 'fallback', 'tableTtlDays', 'echoTarget'], 'routing.')
  const next = { ...current.routing }
  if (patch.allowPrefix !== undefined) {
    next.allowPrefix = requireBoolean(patch.allowPrefix, 'routing.allowPrefix')
  }
  if (patch.fallback !== undefined) {
    next.fallback = requireEnum(patch.fallback, FALLBACKS, 'routing.fallback')
  }
  if (patch.tableTtlDays !== undefined) {
    next.tableTtlDays = requireInt(patch.tableTtlDays, 'routing.tableTtlDays', 1, 365)
  }
  if (patch.echoTarget !== undefined) {
    next.echoTarget = requireBoolean(patch.echoTarget, 'routing.echoTarget')
  }
  return next
}

function applyGlobal(current: TlnotifyConfig, raw: unknown): TlnotifyConfig['global'] {
  const patch = asRecord(raw, 'global')
  assertKnownKeys(
    patch,
    ['verbosity', 'includeSessionLabel', 'includeSummaryLine', 'includeSubagent'],
    'global.',
  )
  const next = { ...current.global }
  if (patch.verbosity !== undefined) {
    next.verbosity = requireEnum(patch.verbosity, VERBOSITIES, 'global.verbosity')
  }
  for (const key of ['includeSessionLabel', 'includeSummaryLine', 'includeSubagent'] as const) {
    if (patch[key] !== undefined) next[key] = requireBoolean(patch[key], `global.${key}`)
  }
  return next
}

function applySession(current: TlnotifyConfig, raw: unknown): TlnotifyConfig['session'] {
  const patch = asRecord(raw, 'session')
  assertKnownKeys(patch, ['targetSessionId', 'context'], 'session.')
  const next: TlnotifyConfig['session'] = {
    ...current.session,
    context: { ...current.session.context },
  }
  if (patch.targetSessionId !== undefined) {
    const read = readTextPatch(
      patch.targetSessionId as string | null | undefined,
      'session.targetSessionId',
    )
    assign(next, 'targetSessionId', read.value)
  }
  if (patch.context !== undefined) {
    const context = asRecord(patch.context, 'session.context')
    assertKnownKeys(
      context,
      ['includeAssistant', 'includeTools', 'includeTiming', 'previousTurns', 'includeUserPrompt'],
      'session.context.',
    )
    for (const key of ['includeAssistant', 'includeTools', 'includeTiming', 'includeUserPrompt'] as const) {
      if (context[key] !== undefined) {
        next.context[key] = requireBoolean(context[key], `session.context.${key}`)
      }
    }
    if (context.previousTurns !== undefined) {
      next.context.previousTurns = requireInt(
        context.previousTurns,
        'session.context.previousTurns',
        0,
        20,
      )
    }
  }
  return next
}

const CHANNEL_PATCH_KEYS: readonly string[] = Object.freeze([
  'id',
  'type',
  'enabled',
  'sessionFilter',
  'appId',
  'appSecret',
  'targetChatId',
  'groupChatId',
  'feishuAppId',
  'feishuAppSecret',
  'feishuReceiveId',
  'feishuReceiveIdType',
  'mode',
  'bindUrl',
] as const)

/** 补丁 → 完整通道配置；`base` 是该通道的现有配置（新通道则是 undefined）。 */
function applyChannelPatch(base: ChannelConfig | undefined, raw: unknown, index: number): ChannelConfig {
  const prefix = `channels[${index}].`
  const patch = asRecord(raw, `channels[${index}]`)
  assertKnownKeys(patch, CHANNEL_PATCH_KEYS, prefix)

  const id = patch.id
  if (typeof id !== 'string' || id.trim() === '') reject(`${prefix}id`, '非空字符串')
  const channelId = id.trim()

  const next: ChannelConfig = base
    ? { ...base }
    : { id: channelId, type: 'qq', enabled: true }

  if (patch.type !== undefined) next.type = requireEnum(patch.type, CHANNEL_TYPES, `${prefix}type`)
  if (patch.enabled !== undefined) {
    next.enabled = requireBoolean(patch.enabled, `${prefix}enabled`)
  }
  if (patch.sessionFilter !== undefined) {
    const raw2 = patch.sessionFilter
    if (!Array.isArray(raw2)) reject(`${prefix}sessionFilter`, '字符串数组')
    next.sessionFilter = raw2.map((item, i) => {
      if (typeof item !== 'string') reject(`${prefix}sessionFilter[${i}]`, '字符串')
      return item
    })
  }

  const textFields = [
    'appId',
    'appSecret',
    'targetChatId',
    'groupChatId',
    'feishuAppId',
    'feishuAppSecret',
    'feishuReceiveId',
    'bindUrl',
  ] as const
  for (const field of textFields) {
    const value = patch[field]
    if (value === undefined) continue
    const read = readTextPatch(value as string | null | undefined, `${prefix}${field}`)
    assign(next, field, read.value)
  }

  if (patch.feishuReceiveIdType !== undefined) {
    next.feishuReceiveIdType = requireEnum(
      patch.feishuReceiveIdType,
      RECEIVE_ID_TYPES,
      `${prefix}feishuReceiveIdType`,
    )
  }
  if (patch.mode !== undefined) {
    next.mode = requireEnum(patch.mode, CHANNEL_MODES, `${prefix}mode`)
  }

  // 注意：这里**不**校验「类型与凭据是否配套」。用户从 QQ 切到飞书时必然会经过
  // 一个「类型已经是飞书、飞书凭据还没填」的中间状态，此时拒绝保存只会让人以为
  // 是插件坏了。真正的一致性由「测试连接」按钮负责告诉用户。
  return next
}

function applyChannels(current: TlnotifyConfig, raw: unknown): ChannelConfig[] {
  if (!Array.isArray(raw)) reject('channels', '数组')
  const seen = new Set<string>()
  const next = raw.map((item, index) => {
    const { id } = (item ?? {}) as { id?: unknown }
    const base = typeof id === 'string' ? current.channels.find((c) => c.id === id) : undefined
    const channel = applyChannelPatch(base, item, index)
    if (seen.has(channel.id)) reject(`channels[${index}].id`, `不重复的通道 id（${channel.id} 重复）`)
    seen.add(channel.id)
    return channel
  })
  return next
}

/**
 * 把补丁应用到一个完整配置上。
 *
 * 纯函数：不写盘、不重连。调用方（`index.ts`）拿到 `next` 后再落盘并决定是否
 * 重连通道。
 */
export function applyPatch(
  current: TlnotifyConfig,
  rawPatch: unknown,
): RpcResult<PatchOutcome> {
  if (typeof rawPatch !== 'object' || rawPatch === null || Array.isArray(rawPatch)) {
    return fail('invalid-patch', '补丁必须是一个对象', { path: 'patch', expected: 'object' })
  }
  const patch = rawPatch as TlnotifyPatch & Record<string, unknown>

  try {
    assertKnownKeys(patch as Record<string, unknown>, PATCH_TOP_KEYS, '')

    const next: TlnotifyConfig = {
      ...current,
      events: { ...current.events },
      content: { ...current.content },
      routing: { ...current.routing },
      session: { ...current.session, context: { ...current.session.context } },
      global: { ...current.global },
      channels: [...current.channels],
    }
    const changed: string[] = []

    if (patch.enabled !== undefined) {
      next.enabled = requireBoolean(patch.enabled, 'enabled')
      changed.push('enabled')
    }
    if (patch.mode !== undefined) {
      next.mode = requireEnum(patch.mode, RUN_MODES, 'mode')
      changed.push('mode')
    }
    if (patch.logLevel !== undefined) {
      next.logLevel = requireEnum(patch.logLevel, LOG_LEVELS, 'logLevel')
      changed.push('logLevel')
    }
    if (patch.defaultChannelId !== undefined) {
      const read = readTextPatch(patch.defaultChannelId, 'defaultChannelId')
      assign(next, 'defaultChannelId', read.value)
      changed.push('defaultChannelId')
    }
    if (patch.events !== undefined) {
      next.events = applyEvents(current, patch.events)
      changed.push('events')
    }
    if (patch.content !== undefined) {
      next.content = applyContent(current, patch.content)
      changed.push('content')
    }
    if (patch.routing !== undefined) {
      next.routing = applyRouting(current, patch.routing)
      changed.push('routing')
    }
    if (patch.session !== undefined) {
      next.session = applySession(current, patch.session)
      changed.push('session')
    }
    if (patch.global !== undefined) {
      next.global = applyGlobal(current, patch.global)
      changed.push('global')
    }
    const channelsChanged = patch.channels !== undefined
    if (channelsChanged) {
      next.channels = applyChannels(current, patch.channels)
      changed.push('channels')
    }

    // 默认通道不能指向一个不存在的通道，否则推送会静默落到第一个可用通道，
    // 而用户在设置页看到的是一个已经不存在的 id。
    if (next.defaultChannelId && !next.channels.some((c) => c.id === next.defaultChannelId)) {
      return fail('invalid-patch', `默认通道 ${next.defaultChannelId} 不在通道列表里`, {
        path: 'defaultChannelId',
        expected: next.channels.map((c) => c.id).join(' | ') || '（还没有通道）',
      })
    }

    return ok({ next, changed, restartRequired: false, channelsChanged })
  } catch (error) {
    if (error instanceof Rejection) {
      return fail('invalid-patch', error.message, { path: error.path, expected: error.expected })
    }
    return fail('invalid-patch', redactText(String(error)), {})
  }
}

// ---------------------------------------------------------------------------
// 测试连接：把平台原始报错翻成能照做的建议
// ---------------------------------------------------------------------------

/**
 * 上游报错 → 可执行建议。
 *
 * 方案 §5.3 的两个例子是硬要求：
 * 飞书 `19024` → 自定义关键词未命中；QQ 主动消息被拒 → 去 QQ 里打开
 * 「允许主动发送」。
 */
export function explainTestFailure(raw: string): TestFailureHint {
  const text = redactText(raw)
  const advice = ((): string => {
    if (/19024|custom.?keyword|关键词/i.test(text)) {
      return '飞书拒绝了这条消息：机器人开了「自定义关键词」校验，而测试消息里没有命中的词。请到飞书开放平台把这个机器人的关键词校验关掉，或在测试消息里带上已配置的关键词。'
    }
    if (/19001|19002|19003|app[_-]?id|app[_-]?secret|invalid.?credential|unauthorized|401/i.test(text)) {
      return '凭据没通过平台校验。请核对 AppID / AppSecret 是否复制完整、是否属于当前这个应用，并确认应用已经发布或至少处于可用状态。'
    }
    if (/allow.?proactive|proactive|主动消息|主动发送|robot.*(?:disabled|closed)|11244|22009/i.test(text)) {
      return '消息被平台拒收。如果是 QQ：请在 QQ 客户端里打开该机器人的聊天，进入设置打开「允许主动发送」——这个开关在用户侧，机器人无法自己打开。'
    }
    if (/receive[_-]?id|open[_-]?id|user not found|230002|230006|invalid.?target|目标/i.test(text)) {
      return '目标 id 不对或这个接收方对当前应用不可见。建议直接点「扫码绑定」，让机器人从你发来的那条消息里自己读出目标 id，避免手抄错误。'
    }
    if (/timeout|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|network|socket hang up/i.test(text)) {
      return '网络没连上平台。请检查本机网络与代理设置；如果用了代理，确认开放平台域名走了直连。'
    }
    if (/websocket|1006|close|断线|reconnect/i.test(text)) {
      return '长连接断了。插件会自动指数退避重连；如果一直连不上，通常是凭据失效或平台侧把该应用的长连接禁用了。'
    }
    return '平台返回了未归类错误。先确认这条通道的凭据与目标 id 都填了，再看下面的原始报错。'
  })()

  return { raw: text, advice }
}

// ---------------------------------------------------------------------------
// 扫码绑定：链接推导
// ---------------------------------------------------------------------------

/** 飞书机器人 applink：手机扫码直接打开与机器人的单聊。 */
export function feishuBotApplink(appId: string): string {
  return `https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(appId)}`
}

export interface DerivedBindLink {
  qrText?: string
  derived: boolean
  missing?: string
}

/**
 * 算出要编码进二维码的内容。
 *
 * - 用户手填的 `bindUrl` 优先——那是他从平台后台复制来的官方分享链接，一定对；
 * - 飞书可以用 App ID 推导出 applink，所以没填 `bindUrl` 也能扫；
 * - QQ 没有可推导的公开链接（区分单聊的 openid 每机器人独立，平台不提供
 *   由 AppID 拼出的加好友链接），因此只能让用户填，或走「给机器人发条消息」
 *   的无扫码路径。
 *
 * 这里**不编造链接**：推导不出来就返回 `missing`，让前端显示说明而不是画一个
 * 扫了没用的二维码。
 */
export function deriveBindLink(config: ChannelConfig): DerivedBindLink {
  const manual = typeof config.bindUrl === 'string' ? config.bindUrl.trim() : ''
  if (manual) return { qrText: manual, derived: false }

  if (config.type === 'feishu') {
    const appId = typeof config.feishuAppId === 'string' ? config.feishuAppId.trim() : ''
    if (appId) return { qrText: feishuBotApplink(appId), derived: true }
    return {
      derived: false,
      missing: '还没有填飞书 App ID，推导不出机器人链接。请先填 App ID，或把飞书后台的机器人分享链接粘到「绑定链接」里。',
    }
  }

  return {
    derived: false,
    missing:
      'QQ 不提供可以由 AppID 推导的加机器人链接，所以这里没有可直接扫的二维码。请到 QQ 开放平台复制机器人的分享链接填进「绑定链接」，或者直接在 QQ 里给机器人发一条「绑定」——插件会从那条消息里读出你的 openid 并自动填好。',
  }
}

/** 生成一个足够随机、便于日志排查的绑定令牌。 */
export function createBindToken(random: () => number = Math.random): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let token = ''
  for (let i = 0; i < 20; i += 1) {
    token += alphabet[Math.floor(random() * alphabet.length) % alphabet.length]
  }
  return token
}
