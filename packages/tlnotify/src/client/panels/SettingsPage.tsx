// packages/tlnotify/src/client/panels/SettingsPage.tsx
//
// 设置页本体：状态栏 + 通用 + 通道 + 事件 + 正文 + 路由 + 高级。
//
// 状态全部集中在这里，是因为「一次改动发哪一条 patch」必须只有一个地方定义：
//   · 顶层开关 / 模式 / 日志级别 / 默认通道      → 单键 patch
//   · 通道相关（含密钥、增删、默认通道指向）    → `channels` 整表替换
//   · 事件 / 正文 / 路由 / 单会话细项            → 该子对象的部分字段
//
// 每次 patch 成功后都用服务端返回的 `config` 回填，而不是假设自己写对了；写盘失败
// 会被宿主拒绝并原样回传，界面立刻能看到。

import React from 'react'
import { Btn, Check, Dot, Note, NumInput, Row, Section, Seg, Select } from '../components/ui.js'
import { ChannelPanel } from './ChannelPanel.js'
import type { QrState, SecretFieldName, TestState } from './ChannelPanel.js'
import { createDraft, toChannelPatches, toDrafts } from '../draft.js'
import type { ChannelDraft, ChannelType, ChannelView, ConfigView } from '../draft.js'
import type { ClientContextLike } from '../host.js'
import type { Translator } from '../i18n.js'
import { createClientRpc } from '../rpc.js'
import type {
  BindPayload,
  PatchPayload,
  QrPayload,
  StatePayload,
  TestPayload,
  TlnotifyPatch,
} from '../../protocol.js'

export interface SettingsPageProps {
  ctx: ClientContextLike
  t: Translator
}

/** 只在通道 id 集合没变时保留本地草稿，否则从服务端重建。 */
function sameChannelIds(drafts: readonly ChannelDraft[], views: readonly ChannelView[]): boolean {
  if (drafts.length !== views.length) return false
  for (let index = 0; index < drafts.length; index += 1) {
    if (drafts[index].id !== views[index].id) return false
  }
  return true
}

function formatTime(stamp: number): string {
  try {
    return new Date(stamp).toLocaleTimeString()
  } catch {
    return String(stamp)
  }
}

export function SettingsPage(props: SettingsPageProps): React.ReactElement {
  const { t } = props
  const rpc = React.useMemo(() => createClientRpc(props.ctx), [props.ctx])

  const [state, setState] = React.useState<StatePayload | undefined>(undefined)
  const [drafts, setDrafts] = React.useState<ChannelDraft[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [flash, setFlash] = React.useState<string | undefined>(undefined)
  const [qr, setQr] = React.useState<QrState | undefined>(undefined)
  const [test, setTest] = React.useState<TestState | undefined>(undefined)
  const [secretEpoch, setSecretEpoch] = React.useState(0)

  const applyState = React.useCallback((next: StatePayload): void => {
    setState(next)
    setDrafts((previous) => (sameChannelIds(previous, next.config.channels) ? previous : toDrafts(next.config)))
  }, [])

  const reload = React.useCallback(async (): Promise<void> => {
    const result = await rpc.call<StatePayload>('state')
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setError(undefined)
    applyState(result.value)
  }, [rpc, applyState])

  React.useEffect(() => {
    void reload()
  }, [reload])

  React.useEffect(() => {
    if (!flash) return
    const timer = window.setTimeout(() => setFlash(undefined), 2200)
    return () => window.clearTimeout(timer)
  }, [flash])

  /**
   * 发一条 patch。
   *
   * `bumpSecret` 只在**改了密钥**时为真：密钥保存成功后要把 `SecretField` 重置回
   * 「不修改」外观，但普通字段改动不该顺手把它们全部重挂载一遍。
   */
  const patch = React.useCallback(
    async (next: TlnotifyPatch, bumpSecret = false): Promise<boolean> => {
      setBusy(true)
      setError(undefined)
      try {
        const result = await rpc.call<PatchPayload>('patch', { patch: next })
        if (!result.ok) {
          setError(result.error.message)
          return false
        }
        setState((previous) => (previous ? { ...previous, config: result.value.config } : previous))
        setFlash(t('saved'))
        if (bumpSecret) setSecretEpoch((value) => value + 1)
        // 状态栏里的 running/connected 会随配置变化，单独补一次轻量刷新。
        const fresh = await rpc.call<StatePayload>('state')
        if (fresh.ok) setState((previous) => (previous ? { ...previous, status: fresh.value.status } : previous))
        return true
      } finally {
        setBusy(false)
      }
    },
    [rpc, t],
  )

  // ── 通道整表提交 ─────────────────────────────────────────────────────────
  const commitChannels = React.useCallback(
    (next: readonly ChannelDraft[], bumpSecret = false): void => {
      setDrafts(next.slice())
      void patch({ channels: toChannelPatches(next) }, bumpSecret)
    },
    [patch],
  )

  const addChannel = React.useCallback(
    (type: ChannelType): void => {
      const next = [...drafts, createDraft(type, drafts.map((draft) => draft.id))]
      commitChannels(next)
    },
    [drafts, commitChannels],
  )

  const saveSecret = React.useCallback(
    (id: string, field: SecretFieldName, value: string): void => {
      const next = drafts.map((draft) => {
        const base = toChannelPatches([draft])[0]
        if (draft.id !== id) return base
        // 显式两条分支，不用计算属性名：`[field]` 会让 TS 退化成 string 索引。
        return field === 'appSecret' ? { ...base, appSecret: value } : { ...base, feishuAppSecret: value }
      })
      void patch({ channels: next }, true)
    },
    [drafts, patch],
  )

  // ── 测试连接 ─────────────────────────────────────────────────────────────
  const runTest = React.useCallback(
    async (channelId: string): Promise<void> => {
      setBusy(true)
      setTest(undefined)
      try {
        const result = await rpc.call<TestPayload>('test', { channelId })
        if (!result.ok) {
          setTest({ channelId, tone: 'error', text: result.error.message })
          return
        }
        setTest({ channelId, tone: 'ok', text: `${t('testOk')} — ${result.value.summary}` })
      } finally {
        setBusy(false)
      }
    },
    [rpc, t],
  )

  // ── 扫码绑定 ─────────────────────────────────────────────────────────────
  const openQr = React.useCallback(
    async (channelId: string): Promise<void> => {
      setQr({ channelId, phase: 'loading' })
      const result = await rpc.call<QrPayload>('qr', { channelId })
      if (!result.ok) {
        setQr({ channelId, phase: 'failed', message: result.error.message })
        return
      }
      setQr({ channelId, phase: 'waiting', payload: result.value })
    },
    [rpc],
  )

  const qrChannelId = qr?.channelId
  const qrToken = qr?.payload?.token
  const qrPhase = qr?.phase

  React.useEffect(() => {
    if (qrPhase !== 'waiting' || !qrChannelId || !qrToken) return undefined
    let cancelled = false

    const tick = async (): Promise<void> => {
      const result = await rpc.call<BindPayload>('bind', { channelId: qrChannelId, token: qrToken })
      if (cancelled) return
      if (!result.ok) {
        setQr({ channelId: qrChannelId, phase: 'failed', message: result.error.message })
        return
      }
      if (result.value.expired) {
        setQr({ channelId: qrChannelId, phase: 'expired' })
        return
      }
      if (result.value.bound) {
        setQr({ channelId: qrChannelId, phase: 'done' })
        await reload()
      }
      // `bound:false, expired:false` 是「还没看到你的消息」，正常轮询结果，继续等。
    }

    const timer = window.setInterval(() => {
      void tick()
    }, 2000)
    void tick()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [qrPhase, qrChannelId, qrToken, rpc, reload])

  if (!state) {
    return (
      <div className="tln-page">
        <div className="tln-head">
          <div className="tln-title">{t('title')}</div>
          <div className="tln-subtitle">{t('subtitle')}</div>
        </div>
        {error ? (
          <Note tone="error">
            {t('loadFailed')}：{error}
            <div className="tln-actions">
              <Btn size="sm" onClick={() => void reload()}>
                {t('retry')}
              </Btn>
            </div>
          </Note>
        ) : (
          <div className="tln-busy">{t('loading')}</div>
        )}
      </div>
    )
  }

  const config: ConfigView = state.config
  const status = state.status
  const disabled = busy || !rpc.available
  const upChannels = status.channels.filter((channel) => channel.connected).length
  const anyUp = upChannels > 0

  const statusText = !status.running
    ? status.enabled
      ? t('statusIdle')
      : t('statusDisabled')
    : t('statusRunning')

  return (
    <div className="tln-page">
      <div className="tln-head">
        <div className="tln-title">{t('title')}</div>
        <div className="tln-subtitle">{t('subtitle')}</div>
        <div className="tln-statusbar">
          <span className="tln-status-item">
            <Dot tone={status.running ? (anyUp ? 'on' : 'warn') : 'off'} />
            {statusText}
          </span>
          <span className="tln-status-item">{t('statusPushed', { n: status.pushed })}</span>
          <span className="tln-status-item">
            {t('statusChannels', { ok: upChannels, total: config.channels.length })}
          </span>
          <span className="tln-status-item">{t('statusSince', { time: formatTime(status.startedAt) })}</span>
          <span className="tln-spacer" />
          {flash ? <span className="tln-status-item tln-note-ok">{flash}</span> : null}
          <Btn size="sm" disabled={busy} onClick={() => void reload()}>
            {t('reload')}
          </Btn>
        </div>
      </div>

      {!rpc.available ? <Note tone="warn">{t('noConnection')}</Note> : null}
      {error ? <Note tone="error">{error}</Note> : null}

      <Section title={t('status')} hint={t('unsavedHint')}>
        <Row label={t('enabledLabel')} hint={t('enabledHint')}>
          <Check
            checked={config.enabled}
            disabled={disabled}
            label={config.enabled ? t('on') : t('off')}
            onChange={(value) => void patch({ enabled: value })}
          />
        </Row>
        <Row label={t('defaultChannel')} hint={t('defaultChannelNone')}>
          <Select
            value={config.defaultChannelId ?? ''}
            disabled={disabled}
            options={[
              { value: '', label: t('defaultChannelNone') },
              ...config.channels.map((channel) => ({ value: channel.id, label: channel.id })),
            ]}
            onChange={(value) => void patch({ defaultChannelId: value.length === 0 ? null : value })}
          />
        </Row>
      </Section>

      <Section title={t('runMode')} hint={config.mode === 'global' ? t('modeGlobalHint') : t('modeSessionHint')}>
        <Row label={t('runMode')}>
          <Seg
            value={config.mode}
            disabled={disabled}
            ariaLabel={t('runMode')}
            options={[
              { value: 'global' as const, label: t('modeGlobal') },
              { value: 'session' as const, label: t('modeSession') },
            ]}
            onChange={(value) => void patch({ mode: value })}
          />
        </Row>
        <Row label={t('boundSession')} hint={config.mode === 'session' ? undefined : t('modeGlobalHint')}>
          {config.session.targetSessionId ? (
            <span className="tln-mono">{config.session.targetSessionId}</span>
          ) : (
            <span className="tln-hint">{t('noBoundSession')}</span>
          )}
        </Row>
        <Row label={t('detailSessions')}>
          <span className="tln-mono">
            {status.detailSessions.length === 0 ? t('detailNone') : status.detailSessions.join(', ')}
          </span>
        </Row>
      </Section>

      <ChannelPanel
        t={t}
        drafts={drafts}
        views={config.channels}
        defaultChannelId={config.defaultChannelId}
        busy={busy}
        secretEpoch={secretEpoch}
        qr={qr}
        test={test}
        onChange={(next) => commitChannels(next)}
        onAdd={addChannel}
        onSecret={saveSecret}
        onDefault={(id) => void patch({ defaultChannelId: id })}
        onTest={(id) => void runTest(id)}
        onQr={(id) => void openQr(id)}
        onQrClose={() => setQr(undefined)}
      />

      <Section title={t('events')} hint={t('eventsHint')}>
        <Row label={t('evTurnEnd')}>
          <Check
            checked={config.events.onTurnEnd}
            disabled={disabled}
            label={config.events.onTurnEnd ? t('on') : t('off')}
            onChange={(value) => void patch({ events: { ...config.events, onTurnEnd: value } })}
          />
        </Row>
        <Row label={t('evError')}>
          <Check
            checked={config.events.onError}
            disabled={disabled}
            label={config.events.onError ? t('on') : t('off')}
            onChange={(value) => void patch({ events: { ...config.events, onError: value } })}
          />
        </Row>
        <Row label={t('evAborted')}>
          <Check
            checked={config.events.onAborted}
            disabled={disabled}
            label={config.events.onAborted ? t('on') : t('off')}
            onChange={(value) => void patch({ events: { ...config.events, onAborted: value } })}
          />
        </Row>
        <Row label={t('evPending')}>
          <Check
            checked={config.events.onPending}
            disabled={disabled}
            label={config.events.onPending ? t('on') : t('off')}
            onChange={(value) => void patch({ events: { ...config.events, onPending: value } })}
          />
        </Row>
        <Row label={t('evMaxTokens')}>
          <Check
            checked={config.events.onMaxTokens}
            disabled={disabled}
            label={config.events.onMaxTokens ? t('on') : t('off')}
            onChange={(value) => void patch({ events: { ...config.events, onMaxTokens: value } })}
          />
        </Row>
        <Row label={t('evIncludeSubagent')} hint={t('evIncludeSubagentHint')}>
          <Check
            checked={config.events.includeSubagent}
            disabled={disabled}
            label={config.events.includeSubagent ? t('on') : t('off')}
            onChange={(value) => void patch({ events: { ...config.events, includeSubagent: value } })}
          />
        </Row>
      </Section>

      <Section title={t('content')} hint={t('contentHint')}>
        <Row label={t('ctIncludeMetadata')}>
          <Check
            checked={config.content.includeMetadata}
            disabled={disabled}
            label={config.content.includeMetadata ? t('on') : t('off')}
            onChange={(value) => void patch({ content: { ...config.content, includeMetadata: value } })}
          />
        </Row>
        <Row label={t('ctIncludeUserPrompt')}>
          <Check
            checked={config.content.includeUserPrompt}
            disabled={disabled}
            label={config.content.includeUserPrompt ? t('on') : t('off')}
            onChange={(value) => void patch({ content: { ...config.content, includeUserPrompt: value } })}
          />
        </Row>
        <Row label={t('ctMaxBodyChars')} hint={t('ctMaxBodyCharsHint')}>
          <NumInput
            value={config.content.maxBodyChars}
            min={200}
            max={20000}
            disabled={disabled}
            onCommit={(value) => void patch({ content: { ...config.content, maxBodyChars: value } })}
          />
        </Row>

        <div className="tln-section-head">
          <div className="tln-section-title">{t('sessionContext')}</div>
        </div>
        <Row label={t('scIncludeAssistant')}>
          <Check
            checked={config.session.context.includeAssistant}
            disabled={disabled}
            label={config.session.context.includeAssistant ? t('on') : t('off')}
            onChange={(value) =>
              void patch({ session: { ...config.session, context: { ...config.session.context, includeAssistant: value } } })
            }
          />
        </Row>
        <Row label={t('scIncludeTools')}>
          <Check
            checked={config.session.context.includeTools}
            disabled={disabled}
            label={config.session.context.includeTools ? t('on') : t('off')}
            onChange={(value) =>
              void patch({ session: { ...config.session, context: { ...config.session.context, includeTools: value } } })
            }
          />
        </Row>
        <Row label={t('scIncludeTiming')}>
          <Check
            checked={config.session.context.includeTiming}
            disabled={disabled}
            label={config.session.context.includeTiming ? t('on') : t('off')}
            onChange={(value) =>
              void patch({ session: { ...config.session, context: { ...config.session.context, includeTiming: value } } })
            }
          />
        </Row>
        <Row label={t('scIncludeUserPrompt')}>
          <Check
            checked={config.session.context.includeUserPrompt}
            disabled={disabled}
            label={config.session.context.includeUserPrompt ? t('on') : t('off')}
            onChange={(value) =>
              void patch({
                session: { ...config.session, context: { ...config.session.context, includeUserPrompt: value } },
              })
            }
          />
        </Row>
        <Row label={t('scPreviousTurns')}>
          <NumInput
            value={config.session.context.previousTurns}
            min={0}
            max={20}
            disabled={disabled}
            onCommit={(value) =>
              void patch({ session: { ...config.session, context: { ...config.session.context, previousTurns: value } } })
            }
          />
        </Row>
      </Section>

      <Section title={t('routing')} hint={t('routingHint')}>
        <Row label={t('rtAllowPrefix')}>
          <Check
            checked={config.routing.allowPrefix}
            disabled={disabled}
            label={config.routing.allowPrefix ? t('on') : t('off')}
            onChange={(value) => void patch({ routing: { ...config.routing, allowPrefix: value } })}
          />
        </Row>
        <Row label={t('rtEchoTarget')} hint={t('rtEchoTargetHint')}>
          <Check
            checked={config.routing.echoTarget}
            disabled={disabled}
            label={config.routing.echoTarget ? t('on') : t('off')}
            onChange={(value) => void patch({ routing: { ...config.routing, echoTarget: value } })}
          />
        </Row>
        <Row label={t('rtFallback')}>
          <Select
            value={config.routing.fallback}
            disabled={disabled}
            options={[
              { value: 'latest', label: t('rtFallbackLatest') },
              { value: 'intervention', label: t('rtFallbackIntervention') },
            ]}
            onChange={(value) => void patch({ routing: { ...config.routing, fallback: value as 'latest' | 'intervention' } })}
          />
        </Row>
        <Row label={t('rtTableTtlDays')} hint={t('rtTableTtlDaysHint')}>
          <NumInput
            value={config.routing.tableTtlDays}
            min={1}
            max={365}
            disabled={disabled}
            onCommit={(value) => void patch({ routing: { ...config.routing, tableTtlDays: value } })}
          />
        </Row>
      </Section>

      <Section title={t('advanced')}>
        <Row label={t('logLevel')}>
          <Select
            value={config.logLevel}
            disabled={disabled}
            options={[
              { value: 'debug', label: 'debug' },
              { value: 'info', label: 'info' },
              { value: 'warn', label: 'warn' },
              { value: 'error', label: 'error' },
            ]}
            onChange={(value) => void patch({ logLevel: value as ConfigView['logLevel'] })}
          />
        </Row>
        <Row label={t('dataDir')}>
          <span className="tln-mono" style={{ wordBreak: 'break-all' }}>
            {config.dataDir}
          </span>
        </Row>
        <Row label={t('configPath')}>
          <span className="tln-mono" style={{ wordBreak: 'break-all' }}>
            {status.configPath}
          </span>
        </Row>
        <Row label={t('status')}>
          <span className="tln-mono" style={{ wordBreak: 'break-all' }}>
            {status.statePath}
          </span>
        </Row>
      </Section>

      {config.channels.length === 0 ? <Note tone="warn">{t('channelsHint')}</Note> : null}
    </div>
  )
}
