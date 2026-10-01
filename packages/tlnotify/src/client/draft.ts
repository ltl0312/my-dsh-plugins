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

import type { ChannelPatch, StatePayload } from '../protocol.js'

export type ConfigView = StatePayload['config']
export type ChannelView = ConfigView['channels'][number]

export type ChannelType = 'qq' | 'feishu'
export type FeishuReceiveIdType = 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email'

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
  appId: string
  targetChatId: string
  groupChatId: string
  feishuAppId: string
  feishuReceiveId: string
  feishuReceiveIdType: FeishuReceiveIdType
  mode: 'active' | 'passive'
  /** 文本域里一行一个；空行忽略。 */
  sessionFilter: string
  bindUrl: string
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
    appId: channel.appId ?? '',
    targetChatId: channel.targetChatId ?? '',
    groupChatId: channel.groupChatId ?? '',
    feishuAppId: channel.feishuAppId ?? '',
    feishuReceiveId: channel.feishuReceiveId ?? '',
    feishuReceiveIdType: channel.feishuReceiveIdType,
    mode: channel.mode,
    sessionFilter: formatSessionFilter(channel.sessionFilter),
    bindUrl: channel.bindUrl ?? '',
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
 */
export function toPatch(draft: ChannelDraft): ChannelPatch {
  return {
    id: draft.id,
    type: draft.type,
    enabled: draft.enabled,
    appId: draft.appId.trim(),
    targetChatId: draft.targetChatId.trim(),
    groupChatId: draft.groupChatId.trim(),
    feishuAppId: draft.feishuAppId.trim(),
    feishuReceiveId: draft.feishuReceiveId.trim(),
    feishuReceiveIdType: draft.feishuReceiveIdType,
    mode: draft.mode,
    sessionFilter: parseSessionFilter(draft.sessionFilter),
    bindUrl: draft.bindUrl.trim(),
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

export function createDraft(type: ChannelType, taken: readonly string[]): ChannelDraft {
  return {
    id: nextId(type, taken),
    type,
    // **默认不启用**：新通道还没有凭据，直接启用会让宿主立刻去建连并失败，
    // 在状态栏上留下一串「通道不可用」。等用户填完再自己打开。
    enabled: false,
    appId: '',
    targetChatId: '',
    groupChatId: '',
    feishuAppId: '',
    feishuReceiveId: '',
    feishuReceiveIdType: 'open_id',
    mode: 'active',
    sessionFilter: '',
    bindUrl: '',
  }
}

/** 界面上的通道显示名：手填的 id 就是它在日志与配置里的键，直接给用户看。 */
export function draftTitle(draft: ChannelDraft): string {
  return draft.id
}
