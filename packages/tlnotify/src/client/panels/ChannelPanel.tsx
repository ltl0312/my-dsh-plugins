// packages/tlnotify/src/client/panels/ChannelPanel.tsx
//
// 「机器人」区：左侧按类型分栏，右侧是这个类型下的机器人卡片，每张卡可以展开成
// 「接入向导」，也可以进「更多设置」子页配置它自己的通知规则 / 会话过滤 / 高级项。
//
// 这里的组件是**纯展示**的：所有状态（草稿、密钥编辑、二维码轮询、扫码创建、测试
// 结果）都在 `SettingsPage` 里，本文件只负责把值画出来并把用户动作转成回调。这样
// 「一次改动发哪一条 patch」只有一处需要理解。
//
// 结构参考 `@xmanrui/dsh-im` 的设置页（rail + 卡片 + 「更多设置」整页子页），但有两处
// 刻意的不同：
//   1. 没有独立的「添加通道向导」——rail 上选类型就是选类型，添加按钮直接造一张卡；
//   2. 密钥字段走 `SecretField`（已保存的密钥**永不回显**），所以卡片里显示的是
//      「已设置 •••• 末四位」，不是明文。

import React from 'react'
import { Btn, Check, Note, Row, Section, Seg, Select, TextArea, TextInput, NumInput, Dot } from '../components/ui.js'
import { SecretField } from '../components/SecretField.js'
import { QrCode } from '../components/QrCode.js'
import type {
  ChannelDraft,
  ChannelGlobalDefaults,
  ChannelType,
  ChannelView,
  FeishuReceiveIdType,
} from '../draft.js'
import { FEISHU_RECEIVE_ID_TYPES, draftTitle } from '../draft.js'
import type { Translator } from '../i18n.js'
import type { ProvisionSnapshot, QrPayload } from '../../protocol.js'

/** 二维码绑定的界面状态。 `phase === 'waiting'` 时页面在轮询 `bind`。 */
export interface QrState {
  channelId: string
  phase: 'loading' | 'waiting' | 'done' | 'expired' | 'failed'
  payload?: QrPayload
  message?: string
}

/** 一次「测试连接」的结果，展示在对应机器人卡片里。 */
export interface TestState {
  channelId: string
  tone: 'ok' | 'error'
  text: string
}

/** 扫码创建（`provision.*`）的界面状态。`snapshot` 缺席表示第一条请求还在路上。 */
export interface ProvisionState {
  channelId: string
  snapshot?: ProvisionSnapshot
  message?: string
}

export type SecretFieldName = 'appSecret' | 'feishuAppSecret'
export type BotTab = 'rules' | 'sessions' | 'advanced'

export interface ChannelPanelProps {
  t: Translator
  drafts: readonly ChannelDraft[]
  /** 服务端视角的通道（只用来读密钥的 configured/hint 与生效值）。 */
  views: readonly ChannelView[]
  /** 全局设置——新建机器人时用它播种「自定义」的初值。 */
  global: ChannelGlobalDefaults
  defaultChannelId: string | undefined
  busy: boolean
  /** 每次密钥保存成功后 +1，用来把 `SecretField` 重置回「未修改」外观。 */
  secretEpoch: number
  qr: QrState | undefined
  test: TestState | undefined
  provision: ProvisionState | undefined
  onChange: (next: readonly ChannelDraft[]) => void
  /** `provision=true` 表示这是一次「扫码接入」：造完卡马上开始扫码。 */
  onAdd: (type: ChannelType, provision: boolean) => void
  onSecret: (id: string, field: SecretFieldName, value: string) => void
  onDefault: (id: string | null) => void
  onTest: (id: string) => void
  onQr: (id: string) => void
  onQrClose: () => void
  onProvision: (id: string) => void
  onProvisionClose: () => void
}

const RAIL_TYPES: readonly ChannelType[] = ['qq', 'feishu']

function railLabel(t: Translator, type: ChannelType): string {
  return type === 'qq' ? t('railQq') : t('railFeishu')
}

export function ChannelPanel(props: ChannelPanelProps): React.ReactElement {
  const { t, drafts } = props
  const [rail, setRail] = React.useState<ChannelType>('qq')
  const [openBotId, setOpenBotId] = React.useState<string | null>(null)
  const [subTab, setSubTab] = React.useState<BotTab>('rules')

  const visible = drafts.filter((draft) => draft.type === rail)
  const viewOf = (id: string): ChannelView | undefined => props.views.find((item) => item.id === id)

  const update = (id: string, patch: Partial<ChannelDraft>): void => {
    props.onChange(drafts.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)))
  }

  const openBot = drafts.find((draft) => draft.id === openBotId)

  return (
    <Section title={t('channels')} hint={t('channelsHint')}>
      <div className="tln-rail" role="tablist" aria-label={t('channels')}>
        {RAIL_TYPES.map((type) => {
          const count = drafts.filter((draft) => draft.type === type).length
          return (
            <button
              key={type}
              type="button"
              role="tab"
              aria-selected={rail === type}
              className="tln-rail-tab"
              data-active={rail === type ? 'true' : 'false'}
              onClick={() => {
                setRail(type)
                setOpenBotId(null)
              }}
            >
              <span className="tln-rail-name">{railLabel(t, type)}</span>
              <span className="tln-rail-count">{t('botCount', { n: count })}</span>
            </button>
          )
        })}
      </div>

      {openBot ? (
        <BotSettingsPage
          t={t}
          draft={openBot}
          view={viewOf(openBot.id)}
          busy={props.busy}
          secretEpoch={props.secretEpoch}
          isDefault={props.defaultChannelId === openBot.id}
          tab={subTab}
          onTab={setSubTab}
          onChange={(patch) => update(openBot.id, patch)}
          onSecret={props.onSecret}
          onDefault={props.onDefault}
          onRemove={() => {
            if (typeof window !== 'undefined' && !window.confirm(t('removeConfirm'))) return
            props.onChange(drafts.filter((draft) => draft.id !== openBot.id))
            setOpenBotId(null)
          }}
          onBack={() => setOpenBotId(null)}
        />
      ) : (
        <div className="tln-bots">
          <div className="tln-panel-head">
            <div className="tln-section-title">{railLabel(t, rail)}</div>
            <span className="tln-spacer" />
            {rail === 'qq' ? (
              <Btn
                variant="primary"
                size="sm"
                disabled={props.busy}
                onClick={() => props.onAdd('qq', true)}
              >
                {t('scanAdd')}
              </Btn>
            ) : null}
            <Btn size="sm" disabled={props.busy} onClick={() => props.onAdd(rail, false)}>
              {rail === 'qq' ? t('manualAdd') : t('addFeishu')}
            </Btn>
          </div>

          {visible.length === 0 ? <Note tone="warn">{t('botEmpty')}</Note> : null}

          {visible.map((draft) => (
            <BotCard
              key={draft.id}
              t={t}
              draft={draft}
              view={viewOf(draft.id)}
              global={props.global}
              busy={props.busy}
              secretEpoch={props.secretEpoch}
              isDefault={props.defaultChannelId === draft.id}
              taken={drafts.map((item) => item.id)}
              qr={props.qr && props.qr.channelId === draft.id ? props.qr : undefined}
              test={props.test && props.test.channelId === draft.id ? props.test : undefined}
              provision={
                props.provision && props.provision.channelId === draft.id ? props.provision : undefined
              }
              onChange={(patch) => update(draft.id, patch)}
              onSecret={props.onSecret}
              onDefault={props.onDefault}
              onTest={props.onTest}
              onQr={props.onQr}
              onQrClose={props.onQrClose}
              onProvision={props.onProvision}
              onProvisionClose={props.onProvisionClose}
              onOpenSettings={(tab) => {
                setSubTab(tab)
                setOpenBotId(draft.id)
              }}
              onRemove={() => {
                if (typeof window !== 'undefined' && !window.confirm(t('removeConfirm'))) return
                props.onChange(drafts.filter((item) => item.id !== draft.id))
              }}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

// ── 卡片 ────────────────────────────────────────────────────────────────────

interface BotCardProps {
  t: Translator
  draft: ChannelDraft
  view: ChannelView | undefined
  global: ChannelGlobalDefaults
  busy: boolean
  secretEpoch: number
  isDefault: boolean
  taken: readonly string[]
  qr: QrState | undefined
  test: TestState | undefined
  provision: ProvisionState | undefined
  onChange: (patch: Partial<ChannelDraft>) => void
  onSecret: (id: string, field: SecretFieldName, value: string) => void
  onDefault: (id: string | null) => void
  onTest: (id: string) => void
  onQr: (id: string) => void
  onQrClose: () => void
  onProvision: (id: string) => void
  onProvisionClose: () => void
  onOpenSettings: (tab: BotTab) => void
  onRemove: () => void
}

function BotCard(props: BotCardProps): React.ReactElement {
  const { t, draft } = props
  const [open, setOpen] = React.useState(false)
  const [wizard, setWizard] = React.useState(false)
  const secretConfigured =
    draft.type === 'qq' ? props.view?.appSecret.configured === true : props.view?.feishuAppSecret.configured === true
  const target = draft.type === 'qq' ? draft.targetChatId : draft.feishuReceiveId
  const appId = draft.type === 'qq' ? draft.appId : draft.feishuAppId
  const tone = draft.enabled ? (secretConfigured && target.trim().length > 0 ? 'on' : 'warn') : 'off'

  return (
    <article className="tln-botCard" data-open={open ? 'true' : 'false'} data-bot-id={draft.id}>
      <div className="tln-botCard-head">
        <button type="button" className="tln-botCard-toggle" onClick={() => setOpen(!open)}>
          <Dot tone={tone} />
          <span className="tln-botCard-name">{draftTitle(draft)}</span>
          <span className="tln-mono tln-botCard-id">{draft.id}</span>
          {props.isDefault ? <span className="tln-note tln-note-ok">{t('isDefault')}</span> : null}
          <span className="tln-spacer" />
          <span className="tln-hint">
            {target.trim().length === 0 ? t('summaryNoTarget') : appId.trim() || t('summaryOff')}
          </span>
          <span className="tln-caret">{open ? '▾' : '▸'}</span>
        </button>
      </div>

      {open ? (
        <div className="tln-botCard-body">
          <Row label={t('botName')} hint={t('botNameHint')}>
            <TextInput
              value={draft.label}
              disabled={props.busy}
              placeholder={draft.id}
              onCommit={(value) => props.onChange({ label: value })}
            />
          </Row>
          <Row label={t('channelEnabled')}>
            <Check
              checked={draft.enabled}
              disabled={props.busy}
              label={draft.enabled ? t('on') : t('off')}
              onChange={(next) => props.onChange({ enabled: next })}
            />
          </Row>
          <Row label={t('channelId')} hint={t('channelIdHint')}>
            <TextInput
              value={draft.id}
              disabled={props.busy}
              onCommit={(value) => {
                const trimmed = value.trim()
                if (trimmed.length === 0 || props.taken.includes(trimmed)) return
                props.onChange({ id: trimmed })
              }}
            />
          </Row>

          <div className="tln-actions">
            <Btn size="sm" variant={wizard ? 'primary' : 'default'} disabled={props.busy} onClick={() => setWizard(!wizard)}>
              {t('wizard')}
            </Btn>
            <Btn size="sm" disabled={props.busy} onClick={() => props.onOpenSettings('rules')}>
              {t('more')}
            </Btn>
            <Btn size="sm" disabled={props.busy} onClick={() => props.onTest(draft.id)}>
              {props.busy ? t('testing') : t('test')}
            </Btn>
            <Btn size="sm" disabled={props.busy || props.isDefault} onClick={() => props.onDefault(draft.id)}>
              {t('setDefault')}
            </Btn>
            <Btn size="sm" variant="danger" disabled={props.busy} onClick={props.onRemove}>
              {t('remove')}
            </Btn>
          </div>

          {props.test ? (
            <Note tone={props.test.tone === 'ok' ? 'ok' : 'error'}>{props.test.text}</Note>
          ) : null}

          {props.provision ? (
            <ProvisionBlock
              t={t}
              draft={draft}
              state={props.provision}
              busy={props.busy}
              onRetry={() => props.onProvision(draft.id)}
              onClose={props.onProvisionClose}
            />
          ) : null}

          {props.qr ? <QrBlock t={t} qr={props.qr} onClose={props.onQrClose} /> : null}

          {wizard ? (
            <SetupWizard
              t={t}
              draft={draft}
              view={props.view}
              appId={appId}
              target={target}
              secretConfigured={secretConfigured}
              busy={props.busy}
              secretEpoch={props.secretEpoch}
              test={props.test}
              onChange={props.onChange}
              onSecret={props.onSecret}
              onTest={props.onTest}
              onQr={props.onQr}
              onProvision={props.onProvision}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

// ── 接入向导 ────────────────────────────────────────────────────────────────

interface SetupWizardProps {
  t: Translator
  draft: ChannelDraft
  view: ChannelView | undefined
  appId: string
  target: string
  secretConfigured: boolean
  busy: boolean
  secretEpoch: number
  test: TestState | undefined
  onChange: (patch: Partial<ChannelDraft>) => void
  onSecret: (id: string, field: SecretFieldName, value: string) => void
  onTest: (id: string) => void
  onQr: (id: string) => void
  onProvision: (id: string) => void
}

function SetupWizard(props: SetupWizardProps): React.ReactElement {
  const { t, draft } = props
  const done = [
    props.appId.trim().length > 0,
    props.secretConfigured,
    props.target.trim().length > 0,
    props.test?.tone === 'ok',
  ]
  const firstTodo = done.findIndex((item) => !item)
  const [openStep, setOpenStep] = React.useState(firstTodo === -1 ? 1 : firstTodo + 1)

  const toggle = (step: number): void => {
    setOpenStep(openStep === step ? 0 : step)
  }

  const stepHead = (step: number, title: string): React.ReactElement => (
    <button
      type="button"
      className="tln-step-head"
      data-open={openStep === step ? 'true' : 'false'}
      onClick={() => toggle(step)}
    >
      <span className="tln-step-index">{t('stepLabel', { n: step })}</span>
      <span className="tln-step-title">{title}</span>
      <span className={done[step - 1] ? 'tln-note tln-note-ok' : 'tln-hint'}>
        {done[step - 1] ? t('stepDone') : t('stepTodo')}
      </span>
      <span className="tln-spacer" />
      <span className="tln-caret">{openStep === step ? '▾' : '▸'}</span>
    </button>
  )

  const body = (step: number, children: React.ReactNode): React.ReactElement | null =>
    openStep === step ? (
      <div className="tln-step-body">
        {children}
        <div className="tln-actions">
          <Btn size="sm" onClick={() => setOpenStep(step === 4 ? 0 : step + 1)}>
            {t('stepSkip')}
          </Btn>
        </div>
      </div>
    ) : null

  return (
    <div className="tln-wizard">
      <div className="tln-section-head">
        <div className="tln-section-title">{t('wizard')}</div>
        <div className="tln-hint">{t('wizardHint')}</div>
      </div>

      <div className="tln-step">
        {stepHead(1, t('step1'))}
        {body(
          1,
          draft.type === 'qq' ? (
            <React.Fragment>
              <p className="tln-hint">{t('step1Qq')}</p>
              <div className="tln-actions">
                <Btn size="sm" variant="primary" disabled={props.busy} onClick={() => props.onProvision(draft.id)}>
                  {t('scanAdd')}
                </Btn>
                <a className="tln-link" href="https://q.qq.com/qqbot/openclaw" target="_blank" rel="noreferrer">
                  {t('openQqPlatform')}
                </a>
              </div>
            </React.Fragment>
          ) : (
            <React.Fragment>
              <p className="tln-hint">{t('step1Feishu')}</p>
              <div className="tln-actions">
                <a className="tln-link" href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">
                  {t('openFeishuPlatform')}
                </a>
              </div>
            </React.Fragment>
          ),
        )}
      </div>

      <div className="tln-step">
        {stepHead(2, t('step2'))}
        {body(
          2,
          <React.Fragment>
            <Row label={t('appId')} hint={t('step2Hint')}>
              <TextInput
                value={props.appId}
                disabled={props.busy}
                placeholder={draft.type === 'qq' ? '102xxxxxx' : 'cli_xxxxxxxxxxxx'}
                onCommit={(value) => props.onChange(draft.type === 'qq' ? { appId: value } : { feishuAppId: value })}
              />
            </Row>
            <div className="tln-row">
              <SecretField
                key={`${draft.id}:${draft.type}:${props.secretEpoch}`}
                label={t('appSecret')}
                configured={props.secretConfigured}
                hint={
                  draft.type === 'qq' ? props.view?.appSecret.hint ?? '' : props.view?.feishuAppSecret.hint ?? ''
                }
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
                  onChange={(value) => props.onChange({ feishuReceiveIdType: value as FeishuReceiveIdType })}
                />
              </Row>
            ) : null}
          </React.Fragment>,
        )}
      </div>

      <div className="tln-step">
        {stepHead(3, t('step3'))}
        {body(
          3,
          <React.Fragment>
            <p className="tln-hint">{draft.type === 'qq' ? t('step3Qq') : t('step3Feishu')}</p>
            <Row label={t('targetId')}>
              <div className="tln-inline">
                <TextInput
                  className="tln-grow"
                  value={props.target}
                  disabled={props.busy}
                  onCommit={(value) =>
                    props.onChange(draft.type === 'qq' ? { targetChatId: value } : { feishuReceiveId: value })
                  }
                />
                <Btn size="sm" disabled={props.busy} onClick={() => props.onQr(draft.id)}>
                  {t('qrBind')}
                </Btn>
              </div>
            </Row>
          </React.Fragment>,
        )}
      </div>

      <div className="tln-step">
        {stepHead(4, t('step4'))}
        {body(
          4,
          <div className="tln-actions">
            <Btn size="sm" disabled={props.busy} onClick={() => props.onTest(draft.id)}>
              {props.busy ? t('testing') : t('test')}
            </Btn>
            <span className="tln-hint">{t('testHint')}</span>
          </div>,
        )}
      </div>
    </div>
  )
}

// ── 更多设置子页 ────────────────────────────────────────────────────────────

interface BotSettingsPageProps {
  t: Translator
  draft: ChannelDraft
  view: ChannelView | undefined
  busy: boolean
  secretEpoch: number
  isDefault: boolean
  tab: BotTab
  onTab: (tab: BotTab) => void
  onChange: (patch: Partial<ChannelDraft>) => void
  onSecret: (id: string, field: SecretFieldName, value: string) => void
  onDefault: (id: string | null) => void
  onRemove: () => void
  onBack: () => void
}

function BotSettingsPage(props: BotSettingsPageProps): React.ReactElement {
  const { t, draft } = props
  const tabs: readonly { value: BotTab; label: string }[] = [
    { value: 'rules', label: t('tabRules') },
    { value: 'sessions', label: t('tabSessions') },
    { value: 'advanced', label: t('tabAdvanced') },
  ]

  return (
    <div className="tln-subpage">
      <div className="tln-subpage-head">
        <button type="button" className="tln-link" onClick={props.onBack}>
          {t('backToList')}
        </button>
        <span className="tln-spacer" />
        <span className="tln-botCard-name">{draftTitle(draft)}</span>
        <span className="tln-mono tln-botCard-id">{draft.id}</span>
      </div>

      <div className="tln-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={props.tab === item.value}
            className="tln-tab"
            data-active={props.tab === item.value ? 'true' : 'false'}
            onClick={() => props.onTab(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {props.tab === 'rules' ? <RulesTab {...props} /> : null}
      {props.tab === 'sessions' ? <SessionsTab {...props} /> : null}
      {props.tab === 'advanced' ? <AdvancedTab {...props} /> : null}
    </div>
  )
}

function RulesTab(props: BotSettingsPageProps): React.ReactElement {
  const { t, draft } = props
  return (
    <React.Fragment>
      <Row label={t('events')} hint={draft.overrideEvents ? t('customHint') : t('followGlobalHint')}>
        <Seg
          value={draft.overrideEvents ? 'custom' : 'global'}
          disabled={props.busy}
          ariaLabel={t('events')}
          options={[
            { value: 'global' as const, label: t('followGlobal') },
            { value: 'custom' as const, label: t('custom') },
          ]}
          onChange={(value) => props.onChange({ overrideEvents: value === 'custom' })}
        />
      </Row>

      {draft.overrideEvents ? (
        <React.Fragment>
          {(
            [
              ['onTurnEnd', t('evTurnEnd')],
              ['onError', t('evError')],
              ['onAborted', t('evAborted')],
              ['onPending', t('evPending')],
              ['onMaxTokens', t('evMaxTokens')],
              ['includeSubagent', t('evIncludeSubagent')],
            ] as const
          ).map(([key, label]) => (
            <Row key={key} label={label}>
              <Check
                checked={draft.events[key]}
                disabled={props.busy}
                label={draft.events[key] ? t('on') : t('off')}
                onChange={(next) => props.onChange({ events: { ...draft.events, [key]: next } })}
              />
            </Row>
          ))}
        </React.Fragment>
      ) : null}

      <Row label={t('content')} hint={draft.overrideContent ? t('customHint') : t('followGlobalHint')}>
        <Seg
          value={draft.overrideContent ? 'custom' : 'global'}
          disabled={props.busy}
          ariaLabel={t('content')}
          options={[
            { value: 'global' as const, label: t('followGlobal') },
            { value: 'custom' as const, label: t('custom') },
          ]}
          onChange={(value) => props.onChange({ overrideContent: value === 'custom' })}
        />
      </Row>

      {draft.overrideContent ? (
        <React.Fragment>
          <Row label={t('ctIncludeMetadata')}>
            <Check
              checked={draft.content.includeMetadata}
              disabled={props.busy}
              label={draft.content.includeMetadata ? t('on') : t('off')}
              onChange={(next) => props.onChange({ content: { ...draft.content, includeMetadata: next } })}
            />
          </Row>
          <Row label={t('ctIncludeUserPrompt')}>
            <Check
              checked={draft.content.includeUserPrompt}
              disabled={props.busy}
              label={draft.content.includeUserPrompt ? t('on') : t('off')}
              onChange={(next) => props.onChange({ content: { ...draft.content, includeUserPrompt: next } })}
            />
          </Row>
          <Row label={t('ctMaxBodyChars')} hint={t('ctMaxBodyCharsHint')}>
            <NumInput
              value={draft.content.maxBodyChars}
              min={200}
              max={20000}
              disabled={props.busy}
              onCommit={(value) => props.onChange({ content: { ...draft.content, maxBodyChars: value } })}
            />
          </Row>
        </React.Fragment>
      ) : null}
    </React.Fragment>
  )
}

function SessionsTab(props: BotSettingsPageProps): React.ReactElement {
  const { t, draft } = props
  return (
    <React.Fragment>
      <Row label={t('tabSessions')} hint={t('scopeHint')}>
        <Seg
          value={draft.sessionScope}
          disabled={props.busy}
          ariaLabel={t('tabSessions')}
          options={[
            { value: 'all' as const, label: t('scopeAll') },
            { value: 'filter' as const, label: t('scopeFilter') },
          ]}
          onChange={(value) => props.onChange({ sessionScope: value })}
        />
      </Row>
      {draft.sessionScope === 'filter' ? (
        <Row label={t('sessionFilter')} hint={t('sessionFilterHint')}>
          <TextArea
            value={draft.sessionFilter}
            disabled={props.busy}
            rows={4}
            onCommit={(value) => props.onChange({ sessionFilter: value })}
          />
        </Row>
      ) : null}
    </React.Fragment>
  )
}

function AdvancedTab(props: BotSettingsPageProps): React.ReactElement {
  const { t, draft } = props
  return (
    <React.Fragment>
      <Row label={t('pushMode')} hint={t('pushModeHint')}>
        <Seg
          value={draft.mode}
          disabled={props.busy}
          ariaLabel={t('pushMode')}
          options={[
            { value: 'active' as const, label: t('pushActive') },
            { value: 'passive' as const, label: t('pushPassive') },
          ]}
          onChange={(value) => props.onChange({ mode: value })}
        />
      </Row>
      <Row label={t('bindLink')} hint={t('bindLinkHint')}>
        <TextInput
          value={draft.bindUrl}
          disabled={props.busy}
          placeholder="https://…"
          onCommit={(value) => props.onChange({ bindUrl: value })}
        />
      </Row>
      {draft.type === 'feishu' ? (
        <Row label={t('receiveIdType')}>
          <Select
            value={draft.feishuReceiveIdType}
            disabled={props.busy}
            options={FEISHU_RECEIVE_ID_TYPES.map((item) => ({ value: item, label: item }))}
            onChange={(value) => props.onChange({ feishuReceiveIdType: value as FeishuReceiveIdType })}
          />
        </Row>
      ) : null}
      <Row label={t('groupChatId')} hint={t('groupChatIdHint')}>
        <TextInput
          value={draft.groupChatId}
          disabled={props.busy}
          onCommit={(value) => props.onChange({ groupChatId: value })}
        />
      </Row>
      <div className="tln-actions">
        <Btn size="sm" disabled={props.busy || props.isDefault} onClick={() => props.onDefault(draft.id)}>
          {t('setDefault')}
        </Btn>
        <Btn size="sm" variant="danger" disabled={props.busy} onClick={props.onRemove}>
          {t('remove')}
        </Btn>
      </div>
    </React.Fragment>
  )
}

// ── 扫码创建 / 扫码绑定 ─────────────────────────────────────────────────────

function ProvisionBlock(props: {
  t: Translator
  draft: ChannelDraft
  state: ProvisionState
  busy: boolean
  onRetry: () => void
  onClose: () => void
}): React.ReactElement {
  const { t, state } = props
  const snapshot = state.snapshot
  const phase = snapshot?.state ?? 'starting'

  const footer = (retry: boolean): React.ReactElement => (
    <div className="tln-actions">
      {retry ? (
        <Btn size="sm" variant="primary" disabled={props.busy} onClick={props.onRetry}>
          {t('provisionRetry')}
        </Btn>
      ) : null}
      <Btn size="sm" onClick={props.onClose}>
        {t('qrClose')}
      </Btn>
    </div>
  )

  if (!snapshot) {
    return (
      <div className="tln-card">
        <div className="tln-card-head">{t('provisionTitle')}</div>
        <div className="tln-hint">{state.message ?? t('provisionStarting')}</div>
        {footer(false)}
      </div>
    )
  }

  if (phase === 'done') {
    return (
      <Note tone="ok">
        {t('provisionDone')}
        {footer(false)}
      </Note>
    )
  }

  if (phase === 'failed' || phase === 'expired' || phase === 'cancelled') {
    const text =
      phase === 'failed'
        ? `${t('provisionFailed')}：${snapshot.error ?? state.message ?? ''}`
        : phase === 'expired'
          ? t('provisionExpired')
          : t('provisionCancelled')
    return (
      <Note tone={phase === 'failed' ? 'error' : 'warn'}>
        {text}
        {footer(phase !== 'cancelled')}
      </Note>
    )
  }

  const qrText = snapshot.qrText
  return (
    <div className="tln-card">
      <div className="tln-card-head">
        {t('provisionTitle')}
        <span className="tln-spacer" />
        {snapshot.expiresAt ? <Countdown t={t} until={snapshot.expiresAt} /> : null}
      </div>
      {phase === 'connecting' ? (
        <div className="tln-hint">{t('provisionConnecting')}</div>
      ) : phase === 'scanned' ? (
        <div className="tln-hint">{t('provisionScanned')}</div>
      ) : qrText ? (
        <div className="tln-qr-layout">
          <div className="tln-qr-img">
            <QrCode text={qrText} />
          </div>
          <div className="tln-qr-side">
            <p className="tln-hint">{t('provisionHint')}</p>
            <div className="tln-hint">{props.draft.type === 'qq' ? '' : t('provisionFeishu')}</div>
          </div>
        </div>
      ) : (
        <div className="tln-hint">{t('provisionStarting')}</div>
      )}
      {footer(true)}
    </div>
  )
}

function Countdown(props: { t: Translator; until: number }): React.ReactElement {
  const [left, setLeft] = React.useState(Math.max(0, props.until - Date.now()))
  React.useEffect(() => {
    const timer = window.setInterval(() => setLeft(Math.max(0, props.until - Date.now())), 1000)
    return () => window.clearInterval(timer)
  }, [props.until])
  const seconds = Math.ceil(left / 1000)
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  return <span className="tln-mono">{`${mm}:${ss}`}</span>
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
        <div className="tln-qr-layout">
          <div className="tln-qr-img">
            <QrCode text={text} />
          </div>
          <div className="tln-qr-side">
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
          </div>
        </div>
      )}
      <div className="tln-actions">
        <Btn size="sm" onClick={props.onClose}>
          {t('qrClose')}
        </Btn>
      </div>
    </div>
  )
}
