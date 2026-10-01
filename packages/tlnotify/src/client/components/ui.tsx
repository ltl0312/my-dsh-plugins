// packages/tlnotify/src/client/components/ui.tsx
//
// 设置页的裸件：只用原生元素 + `tln-` 类名。
//
// 为什么不用宿主打包好的 `@deepseek-ai/dsh-client-ui-primitives`：那个包没有
// `./client` 导出，也没有 `dsh.client` 字段——本机两个可用的参考实现（dsh-im 与
// tlmemory）在客户端里都**只** require `react` / `react-dom*`，从没真的 require 过
// primitives。为一个「未必解析得开」的说明符去赌整个页面能不能加载，不值得。
//
// 用经典 JSX 变换（tsconfig.client.json 里 `"jsx": "react"`）：产物里唯一的裸
// require 就是 `react`，与两个参考实现完全一致。

import React from 'react'

export interface SectionProps {
  title?: string
  hint?: React.ReactNode
  children?: React.ReactNode
}

export function Section(props: SectionProps): React.ReactElement {
  return (
    <div className="tln-section">
      {props.title ? (
        <div className="tln-section-head">
          <div className="tln-section-title">{props.title}</div>
          {props.hint ? <div className="tln-hint">{props.hint}</div> : null}
        </div>
      ) : null}
      {props.children}
    </div>
  )
}

export interface RowProps {
  label?: React.ReactNode
  hint?: React.ReactNode
  children?: React.ReactNode
}

export function Row(props: RowProps): React.ReactElement {
  return (
    <div className="tln-row">
      <div className="tln-row-label">{props.label}</div>
      <div className="tln-row-body">
        {props.children}
        {props.hint ? <div className="tln-hint">{props.hint}</div> : null}
      </div>
    </div>
  )
}

export interface BtnProps {
  children?: React.ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger'
  size?: 'md' | 'sm'
  disabled?: boolean
  title?: string
}

export function Btn(props: BtnProps): React.ReactElement {
  const className = [
    'tln-btn',
    props.variant === 'primary' ? 'tln-btn-primary' : '',
    props.variant === 'danger' ? 'tln-btn-danger' : '',
    props.size === 'sm' ? 'tln-btn-sm' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button
      type="button"
      className={className}
      onClick={props.onClick}
      disabled={props.disabled === true}
      title={props.title}
    >
      {props.children}
    </button>
  )
}

export interface CheckProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: React.ReactNode
  disabled?: boolean
  title?: string
}

export function Check(props: CheckProps): React.ReactElement {
  const disabled = props.disabled === true
  return (
    <label className={disabled ? 'tln-check tln-check-disabled' : 'tln-check'} title={props.title}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  )
}

export interface SegOption<T extends string> {
  value: T
  label: string
  title?: string
}

export interface SegProps<T extends string> {
  value: T
  options: readonly SegOption<T>[]
  onChange: (next: T) => void
  disabled?: boolean
  ariaLabel?: string
}

export function Seg<T extends string>(props: SegProps<T>): React.ReactElement {
  return (
    <div className="tln-seg" role="group" aria-label={props.ariaLabel}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === props.value}
          title={option.title}
          disabled={props.disabled === true}
          onClick={() => {
            if (option.value !== props.value) props.onChange(option.value)
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export interface TextInputProps {
  value: string
  onCommit: (next: string) => void
  placeholder?: string
  disabled?: boolean
  type?: 'text' | 'password'
  className?: string
  title?: string
}

/**
 * 文本输入：内部持有草稿，**失焦或回车**才提交。
 *
 * 逐键提交会在每个字符上写一次 config.json 并重启通道，键盘敲一半时还可能把
 * 半截 AppID 当成有效值发出去。失焦提交是这里唯一合理的粒度。
 */
export function TextInput(props: TextInputProps): React.ReactElement {
  const [draft, setDraft] = React.useState(props.value)
  const [focused, setFocused] = React.useState(false)

  // 外部值变了（例如重新读取配置）且用户没在编辑时就跟随。
  React.useEffect(() => {
    if (!focused) setDraft(props.value)
  }, [props.value, focused])

  const commit = (): void => {
    if (draft !== props.value) props.onCommit(draft)
  }

  return (
    <input
      className={props.className ? `tln-input ${props.className}` : 'tln-input'}
      type={props.type ?? 'text'}
      value={draft}
      placeholder={props.placeholder}
      disabled={props.disabled === true}
      title={props.title}
      spellCheck={false}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        commit()
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          setDraft(props.value)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

export interface TextAreaProps {
  value: string
  onCommit: (next: string) => void
  placeholder?: string
  disabled?: boolean
  rows?: number
}

export function TextArea(props: TextAreaProps): React.ReactElement {
  const [draft, setDraft] = React.useState(props.value)
  const [focused, setFocused] = React.useState(false)

  React.useEffect(() => {
    if (!focused) setDraft(props.value)
  }, [props.value, focused])

  return (
    <textarea
      className="tln-textarea"
      value={draft}
      rows={props.rows ?? 3}
      placeholder={props.placeholder}
      disabled={props.disabled === true}
      spellCheck={false}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        if (draft !== props.value) props.onCommit(draft)
      }}
      onChange={(event) => setDraft(event.target.value)}
    />
  )
}

export interface NumInputProps {
  value: number
  onCommit: (next: number) => void
  min?: number
  max?: number
  disabled?: boolean
  title?: string
}

export function NumInput(props: NumInputProps): React.ReactElement {
  const [draft, setDraft] = React.useState(String(props.value))
  const [focused, setFocused] = React.useState(false)

  React.useEffect(() => {
    if (!focused) setDraft(String(props.value))
  }, [props.value, focused])

  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10)
    if (!Number.isFinite(parsed)) {
      setDraft(String(props.value))
      return
    }
    const clamped = Math.min(props.max ?? Number.MAX_SAFE_INTEGER, Math.max(props.min ?? 0, parsed))
    setDraft(String(clamped))
    if (clamped !== props.value) props.onCommit(clamped)
  }

  return (
    <input
      className="tln-input tln-input-num"
      type="number"
      value={draft}
      min={props.min}
      max={props.max}
      disabled={props.disabled === true}
      title={props.title}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        commit()
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps {
  value: string
  options: readonly SelectOption[]
  onChange: (next: string) => void
  disabled?: boolean
}

export function Select(props: SelectProps): React.ReactElement {
  return (
    <select
      className="tln-select"
      value={props.value}
      disabled={props.disabled === true}
      onChange={(event) => props.onChange(event.target.value)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export interface NoteProps {
  tone?: 'info' | 'ok' | 'warn' | 'error'
  children?: React.ReactNode
}

export function Note(props: NoteProps): React.ReactElement {
  const tone = props.tone ?? 'info'
  const className =
    tone === 'info' ? 'tln-note' : `tln-note tln-note-${tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'error'}`
  return <div className={className}>{props.children}</div>
}

export function Dot(props: { tone: 'on' | 'warn' | 'off' }): React.ReactElement {
  return <span className={`tln-dot tln-dot-${props.tone}`} />
}
