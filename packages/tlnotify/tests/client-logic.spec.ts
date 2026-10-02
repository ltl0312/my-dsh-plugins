// packages/tlnotify/tests/client-logic.spec.ts
//
// 客户端半边里不依赖 DOM 的那部分纯逻辑：草稿模型与双语词表。
//
// jsdom 冒烟（`pnpm smoke:client`）覆盖了「真的能加载、能渲染、点了真发请求」，
// 但它是端到端的一次性脚本，断言不细。这里钉住两条最容易悄悄坏掉的不变量：
//   1. `toPatch` 永不产出密钥键 —— 一旦带上，用户每次保存设置都会被清掉一个密钥；
//   2. 中英两份词表的键必须完全一致 —— 少一个键就是一处空白界面，而且只在
//      切到那种语言时才看得见。

import { describe, expect, it } from 'vitest'
import {
  FEISHU_RECEIVE_ID_TYPES,
  createDraft,
  draftTitle,
  formatSessionFilter,
  parseSessionFilter,
  toChannelPatches,
  toDraft,
  toDrafts,
  toPatch,
} from '../src/client/draft.js'
import type { ChannelView } from '../src/client/draft.js'
import { createTranslator, detectLang, dictOf, translate } from '../src/client/i18n.js'

const FULL_VIEW: ChannelView = {
  id: 'qq-main',
  type: 'qq',
  enabled: true,
  sessionFilter: ['abcdef12', '34567890'],
  appId: '102000000',
  targetChatId: 'OPENID_XYZ',
  groupChatId: 'GROUP_1',
  feishuAppId: 'cli_abc',
  feishuReceiveId: 'ou_abc',
  feishuReceiveIdType: 'chat_id',
  mode: 'passive',
  bindUrl: 'https://example.com/bot',
  appSecret: { configured: true, hint: '••••abcd' },
  feishuAppSecret: { configured: false, hint: '' },
  label: '主机器人',
  sessionScope: 'filter',
  overrideEvents: false,
  events: {
    onTurnEnd: true,
    onError: true,
    onAborted: true,
    onPending: true,
    onMaxTokens: true,
    includeSubagent: false,
  },
  overrideContent: false,
  content: { includeMetadata: true, includeUserPrompt: true, maxBodyChars: 1800 },
}

/**
 * `createDraft` 的第三个参数：全局生效的 events / content。
 *
 * 新机器人的默认姿态是**跟随全局**（`overrideEvents:false`），所以创建时必须把全局那
 * 一份拷进草稿里 —— 否则用户在向导里点开「自定义」会看到一个空表单。
 */
const GLOBAL = {
  events: {
    onTurnEnd: true,
    onError: true,
    onAborted: true,
    onPending: true,
    onMaxTokens: true,
    includeSubagent: false,
  },
  content: { includeMetadata: true, includeUserPrompt: false, maxBodyChars: 1800 },
}

describe('toDraft', () => {
  it('可选项缺席时给空串，而不是 undefined（否则输入框会变成非受控组件）', () => {
    const draft = toDraft({
      id: 'bare',
      type: 'feishu',
      enabled: false,
      sessionFilter: [],
      feishuReceiveIdType: 'open_id',
      mode: 'active',
      appSecret: { configured: false, hint: '' },
      feishuAppSecret: { configured: false, hint: '' },
    })
    for (const key of ['appId', 'targetChatId', 'groupChatId', 'feishuAppId', 'feishuReceiveId', 'bindUrl'] as const) {
      expect(draft[key], key).toBe('')
    }
    expect(draft.sessionFilter).toBe('')
  })

  it('会话过滤从数组摊成一行一个', () => {
    expect(toDraft(FULL_VIEW).sessionFilter).toBe('abcdef12\n34567890')
  })

  it('toDrafts 保持配置里的顺序', () => {
    const config = { channels: [FULL_VIEW, { ...FULL_VIEW, id: 'second' }] }
    expect(toDrafts(config as never).map((d) => d.id)).toEqual(['qq-main', 'second'])
  })
})

describe('toPatch', () => {
  // 这是整个客户端最要紧的一条不变量。
  it('永不产出密钥键（协议里的「省略」才算保持原值）', () => {
    const patch = toPatch(toDraft(FULL_VIEW)) as Record<string, unknown>
    expect('appSecret' in patch).toBe(false)
    expect('feishuAppSecret' in patch).toBe(false)
    expect(JSON.stringify(patch)).not.toContain('Secret')
  })

  it('文本字段 trim 后原样带出', () => {
    const draft = { ...toDraft(FULL_VIEW), id: '  qq-main  ', targetChatId: '  OPENID_XYZ  ' }
    const patch = toPatch(draft)
    // id 不 trim：它是配置里的键，界面那边负责拒绝非法 id；这里保持一致即可。
    expect(patch.targetChatId).toBe('OPENID_XYZ')
  })

  it('往返一圈不丢字段', () => {
    const patch = toPatch(toDraft(FULL_VIEW))
    expect(patch).toMatchObject({
      id: 'qq-main',
      type: 'qq',
      enabled: true,
      appId: '102000000',
      targetChatId: 'OPENID_XYZ',
      groupChatId: 'GROUP_1',
      feishuAppId: 'cli_abc',
      feishuReceiveId: 'ou_abc',
      feishuReceiveIdType: 'chat_id',
      mode: 'passive',
      sessionFilter: ['abcdef12', '34567890'],
      bindUrl: 'https://example.com/bot',
    })
  })

  it('用户在界面上删掉目标 id → 发出空串，宿主按「清空」处理', () => {
    const patch = toPatch({ ...toDraft(FULL_VIEW), targetChatId: '   ' })
    expect(patch.targetChatId).toBe('')
  })

  it('toChannelPatches 与草稿等长同序', () => {
    const patches = toChannelPatches([toDraft(FULL_VIEW), createDraft('feishu', ['qq-main'], GLOBAL)])
    expect(patches.map((p) => p.id)).toEqual(['qq-main', 'feishu-1'])
  })
})

describe('parseSessionFilter', () => {
  it('换行、英文逗号、中文逗号都算分隔符', () => {
    expect(parseSessionFilter('a\nb,c，d')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('去空白、丢空行', () => {
    expect(parseSessionFilter('  a  \n\n , ,\n b ')).toEqual(['a', 'b'])
    expect(parseSessionFilter('')).toEqual([])
  })

  it('format / parse 往返稳定', () => {
    const list = ['abcdef12', '34567890']
    expect(parseSessionFilter(formatSessionFilter(list))).toEqual(list)
    expect(formatSessionFilter([])).toBe('')
    expect(formatSessionFilter(undefined)).toBe('')
  })
})

describe('createDraft', () => {
  it('默认不启用：新通道还没凭据，立刻建连只会在状态栏留一串失败', () => {
    expect(createDraft('qq', [], GLOBAL).enabled).toBe(false)
    expect(createDraft('feishu', [], GLOBAL).enabled).toBe(false)
  })

  it('id 按类型连续编号，并跳过已占用的', () => {
    expect(createDraft('qq', [], GLOBAL).id).toBe('qq-1')
    expect(createDraft('qq', ['qq-1'], GLOBAL).id).toBe('qq-2')
    expect(createDraft('qq', ['qq-1', 'qq-2', 'feishu-1'], GLOBAL).id).toBe('qq-3')
    expect(createDraft('feishu', ['qq-1'], GLOBAL).id).toBe('feishu-1')
  })

  it('新草稿的默认值是可提交的（能被宿主校验通过）', () => {
    const draft = createDraft('feishu', [], GLOBAL)
    expect(FEISHU_RECEIVE_ID_TYPES).toContain(draft.feishuReceiveIdType)
    expect(draft.mode).toBe('active')
    expect(toPatch(draft).sessionFilter).toEqual([])
  })

  it('新机器人默认「关心全局」：sessionScope=all，且通知规则跟随全局（不发覆盖对象）', () => {
    const patch = toPatch(createDraft('qq', [], GLOBAL))
    expect(patch.sessionScope).toBe('all')
    // 跟随全局 = 草稿里有副本、但 patch 里明确发 null（协议里 null 才是「回到全局」）。
    expect(patch.overrideEvents).toBe(false)
    expect(patch.events).toBeNull()
    expect(patch.overrideContent).toBe(false)
    expect(patch.content).toBeNull()
  })
})

describe('draftTitle', () => {
  it('没起名字时就是配置里的键本身', () => {
    expect(draftTitle(createDraft('qq', [], GLOBAL))).toBe('qq-1')
  })

  it('起了名字就用名字（名字只影响显示，配置里的键仍是 id）', () => {
    expect(draftTitle({ ...createDraft('qq', [], GLOBAL), label: '  客服机器人  ' })).toBe('客服机器人')
  })
})

describe('i18n', () => {
  it('中英两份词表的键完全一致', () => {
    const zh = Object.keys(dictOf('zh')).sort()
    const en = Object.keys(dictOf('en')).sort()
    expect(en).toEqual(zh)
  })

  it('没有空文案', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const [key, value] of Object.entries(dictOf(lang))) {
        expect(value.trim(), `${lang}.${key}`).not.toBe('')
      }
    }
  })

  it('占位符会被替换；缺参数时保留原样，方便一眼看出漏传', () => {
    expect(translate('zh', 'statusPushed', { n: 3 })).toBe('已推送 3 条')
    expect(translate('zh', 'statusPushed')).toContain('{n}')
    expect(translate('en', 'statusPushed', { n: 3 })).toBe('3 pushed')
  })

  it('createTranslator 绑定语言', () => {
    expect(createTranslator('en')('save')).toBe('Save')
    expect(createTranslator('zh')('save')).toBe('保存')
  })

  it('没有 DOM 时 detectLang 回退到中文，而不是抛错', () => {
    expect(typeof document).toBe('undefined')
    expect(detectLang()).toBe('zh')
  })

  it('未知语言回退到中文词表', () => {
    expect(dictOf('fr' as never)).toEqual(dictOf('zh'))
  })
})
