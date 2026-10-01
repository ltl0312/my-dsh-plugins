// packages/tlnotify/src/client/components/SecretField.tsx
//
// 密钥输入：**已保存的密钥永不回显**，这是设置页方案 §4.3 / §7 的硬约束。
//
// 于是这个组件有三种状态，而不是普通输入框的两种：
//   未设置 → 「填写」
//   已设置 → 只显示 `••••末四位` + 「改」/「清空」
//   编辑中 → 密码框 + 「保存」/「取消」
//
// 「清空」会真的提交空串；宿主侧的三态语义是「省略=保持、空串=清空、字符串=写入」，
// 所以「什么都不做」在协议层就是**不发这个字段**，不需要额外的哨兵值。

import React from 'react'
import { Btn } from './ui.js'
import type { Translator } from '../i18n.js'

export interface SecretFieldProps {
  label: string
  configured: boolean
  /** 形如 `••••abcd`；未设置时为空串。 */
  hint: string
  disabled?: boolean
  t: Translator
  /** 提交新密钥，或提交空串表示清空。 */
  onCommit: (value: string) => void
}

export function SecretField(props: SecretFieldProps): React.ReactElement {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const disabled = props.disabled === true

  const start = (): void => {
    setDraft('')
    setEditing(true)
  }

  const cancel = (): void => {
    setDraft('')
    setEditing(false)
  }

  const submit = (): void => {
    const value = draft.trim()
    if (value.length === 0) return
    props.onCommit(value)
    setEditing(false)
    setDraft('')
  }

  return (
    <div className="tln-row-body">
      <div className="tln-inline">
        <span className="tln-row-label" style={{ paddingTop: 0 }}>
          {props.label}
        </span>
        {editing ? (
          <React.Fragment>
            <input
              className="tln-input tln-grow"
              type="password"
              value={draft}
              autoFocus
              spellCheck={false}
              placeholder={props.label}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
                else if (event.key === 'Escape') cancel()
              }}
            />
            <Btn variant="primary" size="sm" disabled={disabled || draft.trim().length === 0} onClick={submit}>
              {props.t('save')}
            </Btn>
            <Btn size="sm" disabled={disabled} onClick={cancel}>
              {props.t('cancel')}
            </Btn>
          </React.Fragment>
        ) : (
          <React.Fragment>
            <span className={props.configured ? 'tln-mono tln-grow' : 'tln-hint tln-grow'}>
              {props.configured ? props.hint || '••••' : props.t('notSet')}
            </span>
            <Btn size="sm" disabled={disabled} onClick={start}>
              {props.configured ? props.t('change') : props.t('fill')}
            </Btn>
            {props.configured ? (
              <Btn size="sm" variant="danger" disabled={disabled} onClick={() => props.onCommit('')}>
                {props.t('secretClear')}
              </Btn>
            ) : null}
          </React.Fragment>
        )}
      </div>
      <div className="tln-hint">{props.t('secretHint')}</div>
    </div>
  )
}
