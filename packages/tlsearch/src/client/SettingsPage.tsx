// packages/tlsearch/src/client/SettingsPage.tsx
//
// 设置页本体：把 `Config` 的每一项暴露成可编辑控件，改完立刻写回并生效。
//
// 交互约定（都是刻意的）：
// - 文本/数字输入框**非受控**，失焦或回车时提交。受控输入在写回往返期间会被宿主回传
//   的值顶回去，光标会跳；非受控 + 「revision 变了就换 key 重挂」既稳又能跟随外部改动。
// - 下拉/开关/复选框立即提交。
// - 每次只提交**改动过的路径**（`mutate` 的路径语义）：脱敏字段没被碰过就不会上线，
//   已保存的密钥不会被空串覆盖。
// - 服务端的钳制与校验是唯一权威，这里只做提示。写失败就地显示，不吞。

import React from 'react'
import type { ConfigOp } from './host.js'
import type { Translator } from './i18n.js'
import type { ConfigStore, SecretSlot, StoreSnapshot } from './store.js'
import { setOp } from './store.js'
import {
  LIMITS,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  asNumberInRange,
  formatChain,
  hasUsableBackend,
  parseChain,
  verdicts,
} from './model.js'
import type { FormValues } from './model.js'

type Flash = { kind: 'ok' | 'bad'; text: string } | undefined

interface PageProps {
  /** 由 `apply()` 建好并持有的 store：插槽组件重挂不会丢状态，也不会重复订阅。 */
  store: ConfigStore
  t: Translator
}

function Row(props: { label: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="tls-row">
      <div className="tls-row-label">{props.label}</div>
      <div className="tls-row-body">
        {props.children}
        {props.hint ? <div className="tls-hint">{props.hint}</div> : null}
      </div>
    </div>
  )
}

function Section(props: {
  title: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="tls-section">
      <div className="tls-section-head">
        <div className="tls-section-title">{props.title}</div>
        {props.hint ? <div className="tls-hint">{props.hint}</div> : null}
      </div>
      {props.children}
    </section>
  )
}

/**
 * 非受控文本框：失焦 / 回车提交。
 *
 * `fieldKey` 由 revision 参与构成——宿主回传新 revision（自己写的、或别处改的）时
 * 输入框重新挂载，文本随之刷新；没变的时候不会重挂，光标不跳。
 */
function TextField(props: {
  value: string
  fieldKey: string
  disabled: boolean
  placeholder?: string
  secret?: boolean
  onCommit: (value: string) => void
}): React.ReactElement {
  return (
    <input
      key={props.fieldKey}
      className={`tls-input${props.secret ? ' tls-input-secret' : ''}`}
      type="text"
      defaultValue={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      spellCheck={false}
      autoComplete="off"
      onBlur={(event) => {
        const next = event.currentTarget.value
        if (next === props.value) return
        props.onCommit(next)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        event.currentTarget.blur()
      }}
    />
  )
}

function NumberField(props: {
  value: number
  fieldKey: string
  disabled: boolean
  min: number
  max: number
  onCommit: (value: number) => void
  onReject: () => void
}): React.ReactElement {
  return (
    <input
      key={props.fieldKey}
      className="tls-input tls-input-num"
      type="number"
      min={props.min}
      max={props.max}
      step={1}
      defaultValue={String(props.value)}
      disabled={props.disabled}
      onBlur={(event) => {
        const raw = event.currentTarget.value.trim()
        if (raw === '' || !Number.isFinite(Number(raw))) {
          props.onReject()
          return
        }
        const next = asNumberInRange(raw, props.value, props.min, props.max)
        if (next === props.value) {
          props.onReject()
          return
        }
        props.onCommit(next)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        event.currentTarget.blur()
      }}
    />
  )
}

function SelectField(props: {
  value: string
  disabled: boolean
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}): React.ReactElement {
  return (
    <select
      className="tls-select"
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.currentTarget.value)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

function providerOptions(t: Translator, withNone: boolean): Array<{ value: string; label: string }> {
  const list = PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDER_LABELS[id] }))
  return withNone ? [{ value: 'none', label: t('providerNone') }, ...list] : list
}

function secretAt(secrets: SecretSlot[], path: string[]): boolean {
  const key = path.join('.')
  return secrets.some((slot) => slot.set && slot.path.join('.') === key)
}

/** 后端链编辑框：本地文本状态，失焦时解析并提交。 */
function ChainEditor(props: {
  values: FormValues
  disabled: boolean
  t: Translator
  revisionKey: string
  onCommit: (items: Array<Record<string, unknown>>) => void
}): React.ReactElement {
  const [text, setText] = React.useState<string>(() => formatChain(props.values.chain))
  const [error, setError] = React.useState<string | undefined>(undefined)
  const committed = React.useRef<string>(text)

  // 外部（宿主回传）改了链就同步一次；用户正在编辑时不打断——`revisionKey` 只在
  // 提交成功后才会变，而那时 committed 已经等于新文本。
  React.useEffect(() => {
    if (committed.current === text) return
    setText(formatChain(props.values.chain))
    committed.current = formatChain(props.values.chain)
    setError(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.revisionKey])

  const submit = (): void => {
    if (text === committed.current) return
    const parsed = parseChain(text)
    if (!parsed.ok) {
      setError(
        parsed.index >= 0
          ? `${props.t('chainInvalid')} #${parsed.index + 1} — ${parsed.error}`
          : `${props.t('chainInvalid')} — ${parsed.error}`,
      )
      return
    }
    setError(undefined)
    committed.current = text
    props.onCommit(parsed.items)
  }

  return (
    <div className="tls-row-body">
      <textarea
        className={`tls-textarea${error ? ' tls-textarea-bad' : ''}`}
        value={text}
        disabled={props.disabled}
        spellCheck={false}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={submit}
      />
      {error ? (
        <div className="tls-flash tls-flash-bad">{error}</div>
      ) : props.values.chain.length === 0 ? (
        <div className="tls-hint">{props.t('chainEmpty')}</div>
      ) : null}
    </div>
  )
}

export function SettingsPage(props: PageProps): React.ReactElement {
  const { t, store } = props

  const snapshot = React.useSyncExternalStore<StoreSnapshot>(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
  )

  const [flash, setFlash] = React.useState<Flash>(undefined)
  const [busy, setBusy] = React.useState(0)
  const [nonce, setNonce] = React.useState(0)

  const flashTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showFlash = React.useCallback((next: Flash) => {
    setFlash(next)
    if (flashTimer.current !== undefined) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(undefined), 4000)
  }, [])
  React.useEffect(
    () => () => {
      if (flashTimer.current !== undefined) clearTimeout(flashTimer.current)
    },
    [],
  )

  const commit = React.useCallback(
    (ops: ConfigOp[]) => {
      setBusy((count) => count + 1)
      void store
        .mutate(ops)
        .then((result) => {
          if (result.ok) {
            showFlash({ kind: 'ok', text: t('saved') })
            return
          }
          if (result.conflict) {
            showFlash({ kind: 'bad', text: t('conflict') })
            setNonce((value) => value + 1)
            return
          }
          showFlash({ kind: 'bad', text: `${t('saveFailed')}: ${result.error ?? ''}` })
          setNonce((value) => value + 1)
        })
        .finally(() => setBusy((count) => Math.max(0, count - 1)))
    },
    [store, showFlash, t],
  )

  const revisionKey = `${snapshot.revision ?? 'x'}:${nonce}`
  const values = snapshot.values
  const ready = snapshot.status === 'ready'
  const disabled = !ready || !snapshot.writable || busy > 0
  const readOnly = ready && !snapshot.writable

  const verdictList = verdicts(values)
  const usable = hasUsableBackend(verdictList)

  const head = (
    <header className="tls-head">
      <div className="tls-title">{t('title')}</div>
      <div className="tls-subtitle">{t('subtitle')}</div>
      <div className="tls-hint">{t('hintEveryChangeLive')}</div>
    </header>
  )

  const statusBar = (
    <div className="tls-actions">
      {busy > 0 ? <span className="tls-flash">{t('saving')}</span> : null}
      {flash ? (
        <span className={`tls-flash ${flash.kind === 'ok' ? 'tls-flash-ok' : 'tls-flash-bad'}`}>{flash.text}</span>
      ) : null}
      <span className="tls-spacer" />
      <button
        type="button"
        className="tls-btn tls-btn-sm"
        disabled={snapshot.status === 'loading'}
        onClick={() => {
          void store.reload()
        }}
      >
        {t('reload')}
      </button>
    </div>
  )

  if (!ready) {
    const message =
      snapshot.status === 'loading'
        ? t('loading')
        : snapshot.status === 'error'
          ? `${t('saveFailed')}: ${snapshot.error ?? ''}`
          : t('unavailable')
    return (
      <div className="tls-page">
        {head}
        {snapshot.status === 'unavailable' ? <div className="tls-hint">{t('unavailableHint')}</div> : null}
        {snapshot.status === 'error' && !snapshot.error ? <div className="tls-hint">{t('noBridge')}</div> : null}
        <div className={`tls-banner ${snapshot.status === 'error' ? 'tls-banner-error' : 'tls-banner-warn'}`}>{message}</div>
        {statusBar}
      </div>
    )
  }

  const apiKeySaved = secretAt(snapshot.secrets, ['apiKey'])
  const fallbackKeySaved = secretAt(snapshot.secrets, ['fallback', 'apiKey'])

  return (
    <div className="tls-page">
      {head}

      {readOnly ? <div className="tls-banner tls-banner-warn">{t('readOnly')}</div> : null}
      {snapshot.applies !== undefined && snapshot.applies !== 'live' ? (
        <div className="tls-banner tls-banner-warn">{`applies: ${snapshot.applies}`}</div>
      ) : null}

      <Section title={t('sectionPrimary')} hint={t('sectionPrimaryHint')}>
        <Row label={t('provider')}>
          <SelectField
            value={values.provider}
            disabled={disabled}
            options={providerOptions(t, false)}
            onChange={(next) => commit([setOp(['provider'], next)])}
          />
        </Row>
        <Row label={t('apiKey')} hint={t('apiKeyHint')}>
          <div className="tls-inline">
            <TextField
              value={values.apiKey}
              fieldKey={`${revisionKey}:apiKey`}
              disabled={disabled}
              secret
              placeholder={apiKeySaved ? t('apiKeySaved') : undefined}
              onCommit={(next) => commit([setOp(['apiKey'], next)])}
            />
            {apiKeySaved ? (
              <button
                type="button"
                className="tls-btn tls-btn-sm"
                disabled={disabled}
                onClick={() => commit([setOp(['apiKey'], '')])}
              >
                {t('off')}
              </button>
            ) : null}
          </div>
        </Row>
        <Row label={t('baseUrl')} hint={t('baseUrlHint')}>
          <TextField
            value={values.baseUrl}
            fieldKey={`${revisionKey}:baseUrl`}
            disabled={disabled}
            onCommit={(next) => commit([setOp(['baseUrl'], next)])}
          />
        </Row>
        <Row label={t('cx')} hint={t('cxHint')}>
          <TextField
            value={values.cx}
            fieldKey={`${revisionKey}:cx`}
            disabled={disabled}
            onCommit={(next) => commit([setOp(['cx'], next)])}
          />
        </Row>
      </Section>

      <Section title={t('sectionFallback')} hint={t('sectionFallbackHint')}>
        <Row label={t('provider')}>
          <SelectField
            value={values.fallback.provider}
            disabled={disabled}
            options={providerOptions(t, true)}
            onChange={(next) => commit([setOp(['fallback', 'provider'], next)])}
          />
        </Row>
        <Row label={t('apiKey')} hint={t('apiKeyHint')}>
          <div className="tls-inline">
            <TextField
              value={values.fallback.apiKey}
              fieldKey={`${revisionKey}:fallback.apiKey`}
              disabled={disabled}
              secret
              placeholder={fallbackKeySaved ? t('apiKeySaved') : undefined}
              onCommit={(next) => commit([setOp(['fallback', 'apiKey'], next)])}
            />
            {fallbackKeySaved ? (
              <button
                type="button"
                className="tls-btn tls-btn-sm"
                disabled={disabled}
                onClick={() => commit([setOp(['fallback', 'apiKey'], '')])}
              >
                {t('off')}
              </button>
            ) : null}
          </div>
        </Row>
        <Row label={t('baseUrl')} hint={t('baseUrlHint')}>
          <TextField
            value={values.fallback.baseUrl}
            fieldKey={`${revisionKey}:fallback.baseUrl`}
            disabled={disabled}
            onCommit={(next) => commit([setOp(['fallback', 'baseUrl'], next)])}
          />
        </Row>
        <Row label={t('cx')} hint={t('cxHint')}>
          <TextField
            value={values.fallback.cx}
            fieldKey={`${revisionKey}:fallback.cx`}
            disabled={disabled}
            onCommit={(next) => commit([setOp(['fallback', 'cx'], next)])}
          />
        </Row>
      </Section>

      <Section title={t('sectionChain')} hint={t('sectionChainHint')}>
        <ChainEditor
          values={values}
          disabled={disabled}
          t={t}
          revisionKey={revisionKey}
          onCommit={(items) => commit([setOp(['chain'], items)])}
        />
      </Section>

      <Section title={t('sectionOutput')} hint={t('sectionOutputHint')}>
        <Row label={t('maxResults')} hint={t('maxResultsHint')}>
          <NumberField
            value={values.maxResults}
            fieldKey={`${revisionKey}:maxResults`}
            disabled={disabled}
            min={LIMITS.minResults}
            max={LIMITS.maxResults}
            onCommit={(next) => commit([setOp(['maxResults'], next)])}
            onReject={() => setNonce((value) => value + 1)}
          />
        </Row>
        <Row label={t('maxSnippetChars')} hint={t('maxSnippetCharsHint')}>
          <NumberField
            value={values.maxSnippetChars}
            fieldKey={`${revisionKey}:maxSnippetChars`}
            disabled={disabled}
            min={LIMITS.minSnippetChars}
            max={LIMITS.maxSnippetChars}
            onCommit={(next) => commit([setOp(['maxSnippetChars'], next)])}
            onReject={() => setNonce((value) => value + 1)}
          />
        </Row>
        <Row label={t('outputFormat')} hint={t('outputFormatHint')}>
          <SelectField
            value={values.outputFormat}
            disabled={disabled}
            options={[
              { value: 'markdown', label: t('fmtMarkdown') },
              { value: 'json', label: t('fmtJson') },
            ]}
            onChange={(next) => commit([setOp(['outputFormat'], next)])}
          />
        </Row>
        <Row label={t('includeAnswer')} hint={t('includeAnswerHint')}>
          <label className={`tls-check${disabled ? ' tls-check-disabled' : ''}`}>
            <input
              type="checkbox"
              checked={values.includeAnswer}
              disabled={disabled}
              onChange={(event) => commit([setOp(['includeAnswer'], event.currentTarget.checked)])}
            />
            <span>{values.includeAnswer ? t('on') : t('off')}</span>
          </label>
        </Row>
      </Section>

      <Section title={t('sectionAdvanced')} hint={t('sectionAdvancedHint')}>
        <Row label={t('timeoutMs')} hint={t('timeoutMsHint')}>
          <NumberField
            value={values.timeoutMs}
            fieldKey={`${revisionKey}:timeoutMs`}
            disabled={disabled}
            min={LIMITS.minTimeoutMs}
            max={LIMITS.maxTimeoutMs}
            onCommit={(next) => commit([setOp(['timeoutMs'], next)])}
            onReject={() => setNonce((value) => value + 1)}
          />
        </Row>
        <Row label={t('language')} hint={t('languageHint')}>
          <TextField
            value={values.language}
            fieldKey={`${revisionKey}:language`}
            disabled={disabled}
            onCommit={(next) => commit([setOp(['language'], next)])}
          />
        </Row>
      </Section>

      <Section title={t('chainStatus')} hint={t('noKeyMode')}>
        <div className="tls-inline">
          {verdictList.length === 0 ? <span className="tls-hint">{t('chainStatusNone')}</span> : null}
          {verdictList.map((verdict) => {
            const ok = verdict.missing === null
            const missing =
              verdict.missing === 'apiKey'
                ? t('keyMissing')
                : verdict.missing === 'baseUrl'
                  ? t('baseUrlMissing')
                  : verdict.missing === 'cx'
                    ? t('cxMissing')
                    : ''
            return (
              <span
                key={`${verdict.label}:${verdict.provider}`}
                className={`tls-chip ${ok ? 'tls-chip-ok' : 'tls-chip-bad'}`}
              >
                <span>{verdict.label}</span>
                <span>{ok ? t('usable') : `${t('notUsable')} — ${missing}`}</span>
              </span>
            )
          })}
          {!usable && verdictList.length > 0 ? <span className="tls-hint">{t('chainStatusNone')}</span> : null}
        </div>
      </Section>

      {statusBar}
    </div>
  )
}
