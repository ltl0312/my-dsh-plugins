// packages/tlnotify/src/client/draft.ts
//
// 通道的「可编辑草稿」模型。
//
// 为什么不直接把 `RedactedChannel` 塞进输入框：
//   1. 协议里 `appId`/`targetChatId`/... 都是可选的，输入框需要 `''` 而不是
//      `undefined`，否则 React 会把它变成非受控组件；
//   2. `sessionFilter` 在协议里是 `string[]`，在界面上是一行一个的文本域；
//   3. 密钥在协议里**永远不回显**（只有 `{configured, hint}`），所以草稿里根本
//      不该有密钥字段——密钥的编辑由 `SecretField` 自己持有草稿并在确认时直接
//      发一次 patch。这样才能保证「没动过的密钥不会因为保存而被抹掉」。
//
// 于是：`ChannelDraft` 只管非密钥字段；`toPatch` 产出的 `ChannelPatch` **不带
// 任何密钥键**（协议三态里的「省略」= 保持原值）。
//
// 每机器人独立设置（`label` / `sessionScope` / `events` / `content`）也走同一套
// 三态：协议里 `events: null` 的意思是「丢掉这份覆盖，回到跟随全局」，所以在草稿
// 里用 `overrideEvents: boolean` 表达这个选择，`toPatch` 再把布尔翻成 `null` 或
// 一份完整对象。这样界面上「跟随全局 / 自定义」就是一个开关，而不是「有没有发过
// 这个字段」这种看不见的状态。

import type { ChannelPatch, StatePayload } from '../protocol.js'
import type { ContentConfig, EventsConfig } from '../types.js'

export type ConfigView = StatePayload['config']
export type ChannelView = ConfigView['channels'][number]

/** 新建机器人时用来播种「自定义」初值的那份全局设置。 */
export type ChannelGlobalDefaults = Pick<ConfigView, 'events' | 'content'>

export type ChannelType = 'qq' | 'feishu'
export type FeishuReceiveIdType = 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email'
/** 每台机器人关心哪些会话：全局（所有）/ 只这一个 / 列表中这几个。 */
export type SessionScope = 'all' | 'single' | 'filter'

export const FEISHU_RECEIVE_ID_TYPES: readonly FeishuReceiveIdType[] = [
  'open_id',
  'chat_id',
  'user_id',
  'union_id',
  'email',
]

export interface ChannelDraft {
  id: string
  type: ChannelType
  enabled: boolean
  /** 展示名。空串时界面上回落到 `id`。 */
  label: string
  appId: string
  targetChatId: string
  groupChatId: string
  feishuAppId: string
  feishuReceiveId: string
  feishuReceiveIdType: FeishuReceiveIdType
  mode: 'active' | 'passive'
  /** 会话过滤：`all` = 关心全局（所有会话），`single` = 只看绑定的那一个，`filter` = 只看下面的列表。 */
  sessionScope: SessionScope
  /** `sessionScope === 'single'` 时绑定的会话 id（完整 id，不是短 id）。 */
  sessionId: string
  /** 文本域里一行一个；空行忽略。 */
  sessionFilter: string
  /**
   * 推送正文带几轮历史：`null` = 跟随全局，`0` = 不带历史。
   *
   * 用 `null` 而不是 `undefined` 是因为它要能被 React state 直接持有；协议那边
   * `null` 同样是「回到跟随全局」。
   */
  historyTurns: number | null
  bindUrl: string
  /** QQ 用原生 Markdown 卡片发（默认 false = 纯文本：卡片宽度由 QQ 客户端写死，比普通气泡窄）。 */
  markdown: boolean
  /** 通知规则是否覆盖全局。false 时 `events` 只是「翻开关时的初值」，不生效。 */
  overrideEvents: boolean
  events: EventsConfig
  /** 正文内容是否覆盖全局。 */
  overrideContent: boolean
  content: ContentConfig
}

export function formatSessionFilter(list: readonly string[] | undefined): string {
  if (!list || list.length === 0) return ''
  return list.join('\n')
}

export function parseSessionFilter(text: string): string[] {
  return text
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export function toDraft(channel: ChannelView): ChannelDraft {
  return {
    id: channel.id,
    type: channel.type,
    enabled: channel.enabled,
    label: channel.label ?? '',
    appId: channel.appId ?? '',
    targetChatId: channel.targetChatId ?? '',
    groupChatId: channel.groupChatId ?? '',
    feishuAppId: channel.feishuAppId ?? '',
    feishuReceiveId: channel.feishuReceiveId ?? '',
    feishuReceiveIdType: channel.feishuReceiveIdType,
    mode: channel.mode,
    sessionScope: channel.sessionScope,
    sessionId: channel.sessionId ?? '',
    sessionFilter: formatSessionFilter(channel.sessionFilter),
    historyTurns: typeof channel.historyTurns === 'number' ? channel.historyTurns : null,
    bindUrl: channel.bindUrl ?? '',
    markdown: channel.markdown === true,
    overrideEvents: channel.overrideEvents,
    // 即使没开覆盖也照抄生效值：用户点开「自定义」的那一刻，看到的应该是
    // **当前正在生效的那份**，而不是内置默认——否则一开开关行为就变了。
    events: { ...channel.events },
    overrideContent: channel.overrideContent,
    content: { ...channel.content },
  }
}

export function toDrafts(config: ConfigView): ChannelDraft[] {
  return config.channels.map(toDraft)
}

/**
 * 草稿 → patch。
 *
 * 有意**不写** `appSecret` / `feishuAppSecret`：省略即保持原值。
 *
 * 文本字段一律发出去（清空时是空串）。协议里「空串」和「null」都算清空，用空串
 * 可以让 patch 的形状保持稳定、少一个分支；代价是每次保存都会把空的文本字段再
 * 写一遍，而这恰好是我们要的——用户在界面上删掉目标 id 时，配置里应该真的变空，
 * 而不是留下上一次的旧值。
 *
 * `events` / `content` 相反：跟随全局时发 `null`（把可能存在的旧覆盖丢掉）。草稿
 * 是「配置在这个界面上的唯一真相」，保存一次就应该让配置完全等于界面上看到的样子。
 */
export function toPatch(draft: ChannelDraft): ChannelPatch {
  return {
    id: draft.id,
    type: draft.type,
    enabled: draft.enabled,
    label: draft.label.trim(),
    appId: draft.appId.trim(),
    targetChatId: draft.targetChatId.trim(),
    groupChatId: draft.groupChatId.trim(),
    feishuAppId: draft.feishuAppId.trim(),
    feishuReceiveId: draft.feishuReceiveId.trim(),
    feishuReceiveIdType: draft.feishuReceiveIdType,
    mode: draft.mode,
    sessionScope: draft.sessionScope,
    sessionId: draft.sessionId.trim(),
    sessionFilter: parseSessionFilter(draft.sessionFilter),
    // 三态原样送出：`null`＝回到跟随全局，`0`＝这台机器人不带历史。
    historyTurns: draft.historyTurns,
    bindUrl: draft.bindUrl.trim(),
    markdown: draft.markdown,
    overrideEvents: draft.overrideEvents,
    events: draft.overrideEvents ? { ...draft.events } : null,
    overrideContent: draft.overrideContent,
    content: draft.overrideContent ? { ...draft.content } : null,
  }
}

/** 整表替换用的 patch 数组；顺序与草稿顺序一致。 */
export function toChannelPatches(drafts: readonly ChannelDraft[]): ChannelPatch[] {
  return drafts.map(toPatch)
}

function nextId(type: ChannelType, taken: readonly string[]): string {
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${type}-${index}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${type}-${Date.now()}`
}

export function createDraft(
  type: ChannelType,
  taken: readonly string[],
  global: ChannelGlobalDefaults,
): ChannelDraft {
  return {
    id: nextId(type, taken),
    type,
    // **默认不启用**：新通道还没有凭据，直接启用会让宿主立刻去建连并失败，
    // 在状态栏上留下一串「通道不可用」。等用户填完再自己打开。
    enabled: false,
    label: '',
    appId: '',
    targetChatId: '',
    groupChatId: '',
    feishuAppId: '',
    feishuReceiveId: '',
    feishuReceiveIdType: 'open_id',
    mode: 'active',
    // 新机器人默认**关心全局**（所有会话），这样「加一个机器人」不会是个哑巴；
    // 只想收特定会话的人可以到「更多设置 → 会话过滤」里改成列表。
    sessionScope: 'all',
    sessionId: '',
    sessionFilter: '',
    // 新机器人跟随全局的历史轮数：不替用户做「带不带历史」这个决定。
    historyTurns: null,
    bindUrl: '',
    markdown: false,
    overrideEvents: false,
    events: { ...global.events },
    overrideContent: false,
    content: { ...global.content },
  }
}

/** 界面上的通道显示名：起了名字就用名字，没起就用 id。 */
export function draftTitle(draft: ChannelDraft): string {
  return draft.label.trim() || draft.id
}

/**
 * 接入向导的完成度（4 步）。
 *
 * 只依赖能看得见的东西，不存「用户点过第几步」：
 * 第 1 步要拿到 AppID（扫码创建或手填），第 2 步要密钥已保存（协议只回
 * `configured`），第 3 步要有目标 id，第 4 步由测试结果单独驱动。
 */
export function draftProgress(draft: ChannelDraft, view: ChannelView | undefined): boolean[] {
  const appId = draft.type === 'qq' ? draft.appId : draft.feishuAppId
  const target = draft.type === 'qq' ? draft.targetChatId : draft.feishuReceiveId
  const secret = draft.type === 'qq' ? view?.appSecret.configured : view?.feishuAppSecret.configured
  return [appId.trim().length > 0, secret === true, target.trim().length > 0, false]
}
