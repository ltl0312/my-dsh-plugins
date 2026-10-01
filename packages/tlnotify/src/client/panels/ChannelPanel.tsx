// packages/tlnotify/src/client/panels/ChannelPanel.tsx
//
// 「通道」区：增删通道、填凭据、测连接、扫码绑定。
//
// 这里的组件是**纯展示**的：所有状态（草稿、密钥编辑、二维码轮询、测试结果）都在
// `SettingsPage` 里，本文件只负责把值画出来并把用户动作转成回调。这样「一次改动
// 发哪一条 patch」只有一处需要理解。

import React from 'react'
import { Btn, Check, Note, Row, Section, Seg, Select, TextArea, TextInput } from '../components/ui.js'
import { SecretField } from '../components/SecretField.js'
import { QrCode } from '../components/QrCode.js'
import type { ChannelDraft, ChannelView, ChannelType, FeishuReceiveIdType } from '../draft.js'
import { FEISHU_RECEIVE_ID_TYPES } from '../draft.js'
import type { Translator } from '../i18n.js'
import type { QrPayload } from '../../protocol.js'

/** 二维码绑定的界面状态。 `phase === 'waiting'` 时页面在轮询 `bind`。 */
export interface QrState {
  channelId: string
  phase: 'loading' | 'waiting' | 'done' | 'expired' | 'failed'
  payload?: QrPayload
  message?: string
}

/** 一次「测试连接」的结果，展示在对应通道卡片里。 */
export interface TestState {
  channelId: string
  tone: 'ok' | 'error'
  text: string
}

export type SecretFieldName = 'appSecret' | 'feishuAppSecret'

export interface ChannelPanelProps {
  t: Translator
  drafts: readonly ChannelDraft[]
  /** 服务端视角的通道（只用来读 `appSecret` / `feishuAppSecret` 的 configured/hint）。 */
  views: readonly ChannelView[]
  defaultChannelId: string | undefined
  busy: boolean
  /** 每次密钥保存成功后 +1，用来把 `SecretField` 重置回「未修改」外观。 */
  secretEpoch: number
  qr: QrState | undefined
  test: TestState | undefined
  onChange: (next: readonly ChannelDraft[]) => void
  onAdd: (type: ChannelType) => void
  onSecret: (id: string, field: SecretFieldName, value: string) => void
  onDefault: (id: string | null) => void
  onTest: (id: string) => void
  onQr: (id: string) => void
  onQrClose: () => void
}

function replaceAt(drafts: readonly ChannelDraft[], index: number, patch: Partial<ChannelDraft>): ChannelDraft[] {
  return drafts.map((draft, cursor) => (cursor === index ? { ...draft, ...patch } : draft))
}

export function ChannelPanel(props: ChannelPanelProps): React.ReactElement {
  const { t, drafts } = props
  const taken = drafts.map((draft) => draft.id)

  return (
    <Section title={t('channels')} hint={t('channelsHint')}>
      {drafts.length === 0 ? <Note tone="warn">{t('channelsHint')}</Note> : null}

      {drafts.map((draft, index) => {
        const view = props.views.find((item) => item.id === draft.id)
        const isDefault = props.defaultChannelId === draft.id
        const channelTest = props.test && props.test.channelId === draft.id ? props.test : undefined
        const channelQr = props.qr && props.qr.channelId === draft.id ? props.qr : undefined

        return (
          <div className="tln-card" key={`${draft.id}:${index}`}>
            <div className="tln-card-head">
              <span className="tln-mono">{draft.id}</span>
              <span className="tln-spacer" />
              {isDefault ? <span className="tln-note tln-note-ok">{t('isDefault')}</span> : null}
              <Btn
                size="sm"
                disabled={props.busy || isDefault}
                onClick={() => props.onDefault(draft.id)}
              >
                {t('setDefault')}
              </Btn>
              <Btn
                size="sm"
                variant="danger"
                disabled={props.busy}
                onClick={() => {
                  if (typeof window !== 'undefined' && !window.confirm(t('removeConfirm'))) return
                  const next = drafts.filter((_item, cursor) => cursor !== index)
                  props.onChange(next)
                }}
              >
                {t('remove')}
              </Btn>
            </div>

            <Row label={t('channelId')} hint={t('channelIdHint')}>
              <TextInput
                value={draft.id}
                disabled={props.busy}
                onCommit={(value) => {
                  const trimmed = value.trim()
                  if (trimmed.length === 0 || taken.includes(trimmed)) return
                  props.onChange(replaceAt(drafts, index, { id: trimmed }))
                }}
              />
            </Row>

            <Row label={t('channelType')}>
              <Seg
                value={draft.type}
                disabled={props.busy}
                ariaLabel={t('channelType')}
                options={[
                  { value: 'qq' as ChannelType, label: 'QQ' },
                  { value: 'feishu' as ChannelType, label: '飞书' },
                ]}
                onChange={(value) =>
                  // 切换类型时不动 `feishuReceiveIdType`：它只对飞书有意义，保留原值
                  // 让用户在两种类型间来回切时不会丢掉已选的接收者类型。
                  props.onChange(replaceAt(drafts, index, { type: value }))
                }
              />
            </Row>

            <Row label={t('channelEnabled')}>
              <Check
                checked={draft.enabled}
                disabled={props.busy}
                label={draft.enabled ? t('on') : t('off')}
                onChange={(next) => props.onChange(replaceAt(drafts, index, { enabled: next }))}
              />
            </Row>

            {draft.type === 'qq' ? (
              <Row label={t('appId')}>
                <TextInput
                  value={draft.appId}
                  disabled={props.busy}
                  placeholder="102xxxxxx"
                  onCommit={(value) => props.onChange(replaceAt(drafts, index, { appId: value }))}
                />
              </Row>
            ) : (
              <Row label={t('appId')}>
                <TextInput
                  value={draft.feishuAppId}
                  disabled={props.busy}
                  placeholder="cli_xxxxxxxxxxxx"
                  onCommit={(value) => props.onChange(replaceAt(drafts, index, { feishuAppId: value }))}
                />
              </Row>
            )}

            <div className="tln-row">
              <SecretField
                key={`${draft.id}:${draft.type}:${props.secretEpoch}`}
                label={t('appSecret')}
                configured={
                  draft.type === 'qq'
                    ? view?.appSecret.configured === true
                    : view?.feishuAppSecret.configured === true
                }
                hint={draft.type === 'qq' ? view?.appSecret.hint ?? '' : view?.feishuAppSecret.hint ?? ''}
                disabled={props.busy}
                t={t}
                onCommit={(value) =>
                  props.onSecret(draft.id, draft.type === 'qq' ? 'appSecret' : 'feishuAppSecret', value)
                }
              />
            </div>

            {draft.type === 'feishu' ? (
              <Row label={t('receiveIdType')}>
                <Select
                  value={draft.feishuReceiveIdType}
                  disabled={props.busy}
                  options={FEISHU_RECEIVE_ID_TYPES.map((item) => ({ value: item, label: item }))}
                  onChange={(value) =>
                    props.onChange(
                      replaceAt(drafts, index, { feishuReceiveIdType: value as FeishuReceiveIdType }),
                    )
                  }
                />
              </Row>
            ) : null}

            <Row
              label={t('targetId')}
              hint={draft.type === 'qq' ? t('targetIdHintQq') : t('targetIdHintFeishu')}
            >
              <div className="tln-inline">
                {draft.type === 'qq' ? (
                  <TextInput
                    className="tln-grow"
                    value={draft.targetChatId}
                    disabled={props.busy}
                    onCommit={(value) => props.onChange(replaceAt(drafts, index, { targetChatId: value }))}
                  />
                ) : (
                  <TextInput
                    className="tln-grow"
                    value={draft.feishuReceiveId}
                    disabled={props.busy}
                    onCommit={(value) => props.onChange(replaceAt(drafts, index, { feishuReceiveId: value }))}
                  />
                )}
                <Btn size="sm" disabled={props.busy} onClick={() => props.onQr(draft.id)}>
                  {t('qrBind')}
                </Btn>
              </div>
            </Row>

            <Row label={t('pushMode')} hint={t('pushModeHint')}>
              <Seg
                value={draft.mode}
                disabled={props.busy}
                ariaLabel={t('pushMode')}
                options={[
                  { value: 'active' as const, label: t('pushActive') },
                  { value: 'passive' as const, label: t('pushPassive') },
                ]}
                onChange={(value) => props.onChange(replaceAt(drafts, index, { mode: value }))}
              />
            </Row>

            <Row label={t('bindLink')} hint={t('bindLinkHint')}>
              <TextInput
                value={draft.bindUrl}
                disabled={props.busy}
                placeholder="https://…"
                onCommit={(value) => props.onChange(replaceAt(drafts, index, { bindUrl: value }))}
              />
            </Row>

            <Row label={t('sessionFilter')} hint={t('sessionFilterHint')}>
              <TextArea
                value={draft.sessionFilter}
                disabled={props.busy}
                rows={2}
                onCommit={(value) => props.onChange(replaceAt(drafts, index, { sessionFilter: value }))}
              />
            </Row>

            {channelQr ? <QrBlock t={t} qr={channelQr} onClose={props.onQrClose} /> : null}

            <div className="tln-actions">
              <Btn size="sm" disabled={props.busy} onClick={() => props.onTest(draft.id)}>
                {props.busy ? t('testing') : t('test')}
              </Btn>
              <span className="tln-hint">{t('testHint')}</span>
            </div>

            {channelTest ? (
              <Note tone={channelTest.tone === 'ok' ? 'ok' : 'error'}>{channelTest.text}</Note>
            ) : null}
          </div>
        )
      })}

      <div className="tln-actions">
        <Btn size="sm" disabled={props.busy} onClick={() => props.onAdd('qq')}>
          {t('addQq')}
        </Btn>
        <Btn size="sm" disabled={props.busy} onClick={() => props.onAdd('feishu')}>
          {t('addFeishu')}
        </Btn>
      </div>
    </Section>
  )
}

function QrBlock(props: { t: Translator; qr: QrState; onClose: () => void }): React.ReactElement {
  const { t, qr } = props

  if (qr.phase === 'failed') {
    return (
      <Note tone="error">
        {qr.message ?? t('loadFailed')}
        <div className="tln-actions">
          <Btn size="sm" onClick={props.onClose}>
            {t('qrClose')}
          </Btn>
        </div>
      </Note>
    )
  }

  if (qr.phase === 'expired') {
    return (
      <Note tone="warn">
        {t('qrExpired')}
        <div className="tln-actions">
          <Btn size="sm" onClick={props.onClose}>
            {t('qrClose')}
          </Btn>
        </div>
      </Note>
    )
  }

  if (qr.phase === 'done') {
    return (
      <Note tone="ok">
        {t('qrDone')}
        <div className="tln-actions">
          <Btn size="sm" onClick={props.onClose}>
            {t('qrClose')}
          </Btn>
        </div>
      </Note>
    )
  }

  const text = qr.payload?.qrText

  return (
    <div className="tln-card">
      <div className="tln-card-head">{t('qrTitle')}</div>
      {qr.phase === 'loading' || !text ? (
        <div className="tln-hint">{t('qrWorking')}</div>
      ) : (
        <React.Fragment>
          <QrCode text={text} />
          <div className="tln-hint">{t('qrWaiting')}</div>
          {qr.payload && qr.payload.derived === false ? (
            <div>
              <div className="tln-hint">{t('qrFallback')}</div>
              <div className="tln-mono" style={{ wordBreak: 'break-all' }}>
                {text}
              </div>
            </div>
          ) : null}
          <div className="tln-kv">
            <span className="tln-hint">{t('qrBind')}</span>
            <span className="tln-mono">{qr.payload?.token}</span>
          </div>
        </React.Fragment>
      )}
      <div className="tln-actions">
        <Btn size="sm" onClick={props.onClose}>
          {t('qrClose')}
        </Btn>
      </div>
    </div>
  )
}
