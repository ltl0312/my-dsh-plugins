// packages/tlmemory/src/client/settings.tsx
// DSH 设置页里的「记忆」分区（settings.section 槽位）。
//
// 为什么单独一个分区而不是复用 plugins.item 卡片：本插件的配置项都属于
// 「运行期行为」（库路径、召回条数、自动提炼间隔），改完立即生效，与
// 「插件列表」的启用/停用语义无关，放在设置页一级导航里更符合用户心智。
//
// 宿主契约（只用到这三个服务，均来自 shell 提供的客户端上下文）：
//   - ctx.slots：inject(name, cb) / register(spec, Component)
//     （settings.section 的声明与消费见 @deepseek-ai/dsh-client-ui-settings-general/
//      lib/client.js:1258-1261 与 :337；注册形态同 dsh-client-ui-settings-account/
//      lib/client.js:4773-4795）
//   - ctx.locale：bind(ns) / register(ns, { zh, en })
//   - ctx.remote.settings：describe() / update(ns, patch, revision) / mutate(...)
//     （dsh-api-settings-controller/lib/index.js:393-476；冲突为 settings/conflict）
//
// 状态机、保存计划与乐观并发全部落在 settings-logic.ts（纯函数 + 控制器），
// 本文件只负责把快照渲染成表单。样式一律内联，不依赖宿主的 CSS 变量与
// 组件库：外部插件不该假设自己的样式作用域。

import React from 'react'
import type { Context } from 'cordis'
import {
  SettingsPanelController,
  type FieldSpec,
  type PanelSnapshot,
  type SettingsTransport,
} from './settings-logic.js'

/** 词典命名空间（与插槽注册里的 locale 字段一致） */
export const SETTINGS_LOCALE_NS = 'settings.tlmemory'
/** 插槽条目 id：设置页左栏的定位锚点 */
export const SETTINGS_SECTION_ID = 'tlmemory'
/** 导航顺序：排在「通用(0)」之后、「模型」「账户」之前，与插件家族相邻 */
export const SETTINGS_SECTION_ORDER = 30

/** 字段标题：以现有 Config 的键为准，未列出的键回退成原始键名 */
const FIELD_LABEL_KEYS: Record<string, string> = {
  dbPath: 'field.dbPath',
  serverPort: 'field.serverPort',
  maxRecallCount: 'field.maxRecallCount',
  enableAutoReflection: 'field.enableAutoReflection',
  compactionInterval: 'field.compactionInterval',
  enableAutoMerge: 'field.enableAutoMerge',
}

/** 字段补充提示（schema 的 description 之外，面板额外要交代的操作语义） */
const FIELD_HINT_KEYS: Record<string, string> = {
  dbPath: 'hint.dbPath',
  serverPort: 'hint.serverPort',
  maxRecallCount: 'hint.maxRecallCount',
  enableAutoReflection: 'hint.enableAutoReflection',
  compactionInterval: 'hint.compactionInterval',
  enableAutoMerge: 'hint.enableAutoMerge',
}

const zh: Record<string, string> = {
  nav: '记忆',
  title: 'TLMemory 长期记忆',
  description: '配置记忆库位置与召回行为。保存后立即生效，无需重启。',
  'field.dbPath': '数据库路径',
  'field.serverPort': '看板服务端口',
  'field.maxRecallCount': '单轮召回条数',
  'field.enableAutoReflection': '自动提炼记忆',
  'field.compactionInterval': '自动提炼间隔（轮）',
  'field.enableAutoMerge': '自动归并相近记忆',
  'field.enableAutoEvolve': '自动整理记忆树',
  'field.requireReview': '保留人工审核',
  'hint.dbPath': '留空则使用默认路径 ~/.dsh/tlmemory.db；首次启动自动建库建表。',
  'hint.serverPort': '记忆看板服务监听的本地端口（仅回环地址）。',
  'hint.maxRecallCount': '每轮对话最多注入几条相关记忆。',
  'hint.enableAutoReflection': '开启后，对话结束会后台提炼可复用的事实与偏好。',
  'hint.compactionInterval': '每累计多少轮对话触发一次后台提炼。',
  'hint.enableAutoMerge': '把同一主题的多条短记忆折叠成一条摘要，原句保留在库里可回滚。',
  'hint.enableAutoEvolve': '每轮自动合并近义目录（如「部署运维」与「运维部署」），让树越用越整齐；只改结构，不改内容。',
  'hint.requireReview': '默认关闭：记忆直接入库、旧结论被新结论取代时自动退出召回，全程无需确认。',
  defaultText: '默认值',
  emptyText: '未设置',
  reset: '恢复默认',
  save: '保存',
  saving: '保存中…',
  discard: '放弃改动',
  saved: '已保存，新配置立即生效。',
  noChanges: '没有需要保存的改动。',
  invalidNumber: '请填写数字，或点「恢复默认」。',
  conflict: '配置刚被其它窗口改动，已重新载入最新值，请确认后再保存。',
  saveFailed: '宿主没有接受这次修改，已重新载入最新值。',
  loadFailed: '读取配置失败，请稍后重试。',
  unavailable: '未在当前 profile 中找到本插件的配置命名空间，暂时无法在此配置。',
  readOnly: '当前部署的设置为只读。',
  retry: '重新读取',
  loading: '正在读取配置…',
  namespace: '命名空间',
  revision: '版本',
}

const en: Record<string, string> = {
  nav: 'Memory',
  title: 'TLMemory long-term memory',
  description: 'Configure where memories live and how they are recalled. Changes apply immediately.',
  'field.dbPath': 'Database path',
  'field.serverPort': 'Dashboard port',
  'field.maxRecallCount': 'Recall limit per turn',
  'field.enableAutoReflection': 'Auto-distill memories',
  'field.compactionInterval': 'Auto-distill interval (turns)',
  'field.enableAutoMerge': 'Auto-merge similar memories',
  'field.enableAutoEvolve': 'Auto-organise the memory tree',
  'field.requireReview': 'Keep human review',
  'hint.dbPath': 'Leave blank to use ~/.dsh/tlmemory.db; the database and tables are created on first start.',
  'hint.serverPort': 'Loopback port serving the memory dashboard.',
  'hint.maxRecallCount': 'How many related memories may be injected into one turn.',
  'hint.enableAutoReflection': 'When enabled, reusable facts and preferences are distilled after a turn.',
  'hint.compactionInterval': 'Turns accumulated before a background distillation runs.',
  'hint.enableAutoMerge': 'Fold same-topic short memories into one summary; originals stay recoverable.',
  'hint.enableAutoEvolve': 'Merges near-synonym directories each round so the tree stays tidy; structure only, content untouched.',
  'hint.requireReview': 'Off by default: memories enter recall immediately and superseded ones drop out automatically.',
  defaultText: 'Default',
  emptyText: 'Not set',
  reset: 'Reset to default',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saved: 'Saved; the new configuration is active now.',
  noChanges: 'Nothing to save.',
  invalidNumber: 'Enter a number, or reset the field to its default.',
  conflict: 'Another window changed the configuration; the latest values were reloaded.',
  saveFailed: 'The host rejected the change; the latest values were reloaded.',
  loadFailed: 'Could not read the configuration. Please retry.',
  unavailable: 'This plugin has no configuration namespace in the current profile.',
  readOnly: 'This deployment stores settings read-only.',
  retry: 'Reload',
  loading: 'Reading configuration…',
  namespace: 'Namespace',
  revision: 'Revision',
}

// ── 内联样式（外部插件不共享宿主样式作用域） ────────────────────────────────

const S = {
  root: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 0 8px' },
  head: { display: 'flex', flexDirection: 'column', gap: '6px' },
  title: { margin: 0, fontSize: '16px', fontWeight: 600 },
  description: { margin: 0, fontSize: '13px', lineHeight: 1.6, opacity: 0.72 },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  labelRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  label: { fontSize: '13px', fontWeight: 500 },
  hint: { fontSize: '12px', lineHeight: 1.55, opacity: 0.66 },
  defaultTag: { fontSize: '11px', opacity: 0.55 },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    fontSize: '13px',
    borderRadius: '8px',
    border: '1px solid rgba(128,128,128,0.38)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
  },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  linkButton: {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    opacity: 0.62,
    fontSize: '12px',
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'underline',
  },
  footer: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
  message: { fontSize: '12px', lineHeight: 1.5 },
  primaryButton: {
    padding: '7px 16px',
    fontSize: '13px',
    borderRadius: '8px',
    border: '1px solid rgba(128,128,128,0.4)',
    background: 'rgba(128,128,128,0.16)',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
  },
  meta: { fontSize: '11px', opacity: 0.45, fontFamily: 'ui-monospace, Menlo, Consolas, monospace' },
} as const

function disabledStyle(disabled: boolean): Record<string, string | number> {
  return disabled ? { ...S.linkButton, opacity: 0.3, cursor: 'default' } : { ...S.linkButton }
}

// ── 组件 ────────────────────────────────────────────────────────────────────

/** 插槽注入面：控制器 + 取词函数 */
export interface SettingsSectionProps {
  controller: SettingsPanelController
  t: (key: string) => string
}

/**
 * 渲染设置页的「记忆」分区。
 *
 * 快照订阅走控制器（不引入额外状态库）：subscriber 会在 load / 编辑 / 保存
 * 的每个阶段收到整体替换后的新快照，React 只负责重绘。
 */
export function TlmemorySettingsSection(props: SettingsSectionProps): unknown {
  const { controller, t } = props
  const [snapshot, setSnapshot] = React.useState<PanelSnapshot>(() => controller.getSnapshot())

  React.useEffect(() => controller.subscribe((next) => setSnapshot(next)), [controller])

  const readOnly = !snapshot.writable || snapshot.status !== 'ready'
  const busy = snapshot.busy
  const canSave = snapshot.dirty && !readOnly && !busy

  const header = React.createElement(
    'div',
    { style: { ...S.head } },
    React.createElement('h3', { style: { ...S.title } }, t('title')),
    React.createElement('p', { style: { ...S.description } }, t('description')),
  )

  if (snapshot.status === 'loading' && snapshot.fields.length === 0) {
    return React.createElement(
      'div',
      { style: { ...S.root }, 'data-tlmemory-settings': 'loading' },
      header,
      React.createElement('p', { style: { ...S.hint } }, t('loading')),
    )
  }

  if (snapshot.status === 'unavailable' || snapshot.status === 'error') {
    return React.createElement(
      'div',
      { style: { ...S.root }, 'data-tlmemory-settings': snapshot.status },
      header,
      React.createElement(
        'p',
        { style: { ...S.hint } },
        t(snapshot.messageKey ?? (snapshot.status === 'error' ? 'loadFailed' : 'unavailable')),
      ),
      React.createElement(
        'div',
        { style: { ...S.footer } },
        React.createElement('button', { type: 'button', style: { ...S.primaryButton }, onClick: () => void controller.load() }, t('retry')),
      ),
    )
  }

  const rows = snapshot.fields.map((field) => renderField(field, snapshot, controller, t, readOnly || busy))

  const message =
    snapshot.messageKey === null
      ? null
      : React.createElement(
          'span',
          {
            style: {
              ...S.message,
              color: snapshot.messageKind === 'error' ? '#e5686d' : 'inherit',
              opacity: snapshot.messageKind === 'error' ? 1 : 0.66,
            },
            role: 'status',
            'aria-live': 'polite',
          },
          t(snapshot.messageKey),
        )

  const meta =
    snapshot.ns === undefined
      ? null
      : React.createElement(
          'span',
          { style: { ...S.meta } },
          `${t('namespace')}: ${snapshot.ns}`,
          snapshot.revision === undefined ? '' : ` · ${t('revision')}: ${String(snapshot.revision)}`,
        )

  return React.createElement(
    'div',
    { style: { ...S.root }, 'data-tlmemory-settings': 'ready' },
    header,
    ...rows,
    React.createElement(
      'div',
      { style: { ...S.footer } },
      React.createElement(
        'button',
        {
          type: 'button',
          style: canSave ? { ...S.primaryButton } : { ...S.primaryButton, opacity: 0.45, cursor: 'default' },
          disabled: !canSave,
          onClick: () => {
            void controller.save()
          },
        },
        busy ? t('saving') : t('save'),
      ),
      snapshot.dirty && !busy
        ? React.createElement(
            'button',
            { type: 'button', style: disabledStyle(readOnly), disabled: readOnly, onClick: () => void controller.load() },
            t('discard'),
          )
        : null,
      message,
    ),
    readOnly ? React.createElement('p', { style: { ...S.hint } }, t('readOnly')) : null,
    meta,
  )
}

/** 单行字段：string / number 用输入框，boolean 用复选框 */
function renderField(
  field: FieldSpec,
  snapshot: PanelSnapshot,
  controller: SettingsPanelController,
  t: (key: string) => string,
  disabled: boolean,
): unknown {
  const labelKey = FIELD_LABEL_KEYS[field.key]
  const hintKey = FIELD_HINT_KEYS[field.key]
  const label = t(labelKey ?? field.key)
  const hint = hintKey === undefined ? field.hint : t(hintKey)
  const draftValue = snapshot.draft[field.key] ?? field.value
  const defaultText = field.defaultText === undefined ? t('emptyText') : `${t('defaultText')}: ${field.defaultText}`

  const labelRow = React.createElement(
    'div',
    { style: { ...S.labelRow } },
    React.createElement('span', { style: { ...S.label } }, label),
    React.createElement('span', { style: { ...S.defaultTag } }, defaultText),
    React.createElement(
      'button',
      {
        type: 'button',
        style: disabledStyle(disabled),
        disabled,
        title: t('reset'),
        onClick: () => {
          controller.resetFieldToDefault(field.key)
        },
      },
      t('reset'),
    ),
  )

  const control =
    field.type === 'boolean'
      ? React.createElement(
          'label',
          { style: { ...S.checkboxRow } },
          React.createElement('input', {
            type: 'checkbox',
            checked: draftValue === true,
            disabled,
            onChange: (event: { target?: { checked?: boolean } }) => {
              controller.setDraft(field.key, event.target?.checked === true)
            },
          }),
          React.createElement('span', { style: { ...S.hint } }, hint ?? ''),
        )
      : React.createElement('input', {
          type: field.type === 'number' ? 'number' : 'text',
          style: { ...S.input, opacity: disabled ? 0.6 : 1 },
          value: typeof draftValue === 'string' ? draftValue : String(draftValue),
          placeholder: field.type === 'number' ? (field.defaultText ?? '') : '',
          disabled,
          spellcheck: false,
          onChange: (event: { target?: { value?: string } }) => {
            controller.setDraft(field.key, event.target?.value ?? '')
          },
        })

  return React.createElement(
    'div',
    { style: { ...S.field }, 'data-tlmemory-field': field.key },
    labelRow,
    control,
    field.type === 'boolean' ? null : React.createElement('span', { style: { ...S.hint } }, hint ?? ''),
  )
}

// ── 注册 ────────────────────────────────────────────────────────────────────

/**
 * 在设置页注册「记忆」分区。
 *
 * 与服务端看板的 DOM 挂载完全独立：即使 DOM 挂载被幂等短路（重复 apply /
 * HMR 重注入），设置分区仍会随纤程重新注册。
 *
 * @param ctx - 客户端根上下文
 * @returns 手动注销的 Disposer（正常路径由 ctx.effect 自动回收）
 */
export function registerSettingsSection(ctx: Context): () => void {
  const disposers: Array<() => void> = []

  const remoteSettings = ctx.remote?.settings
  if (remoteSettings === undefined || typeof remoteSettings.describe !== 'function') {
    // 宿主未提供设置传输（极简 shell / 只读嵌入）：不注册空面板，也不影响看板。
    console.warn('[tlmemory] 宿主未提供 remote.settings，跳过设置面板注册')
    return () => {}
  }

  const t = ctx.locale.bind(SETTINGS_LOCALE_NS)
  disposers.push(ctx.locale.register(SETTINGS_LOCALE_NS, { zh, en }))

  const controller = new SettingsPanelController(remoteSettings as SettingsTransport)
  disposers.push(() => controller.dispose())

  // 首屏读取一次，并在宿主设置文档变更（含其它窗口的写入、profile 补丁热重载）
  // 时重新读取，保证面板显示的永远是当前值。
  void controller.load()
  disposers.push(
    ctx.remote.$on('settings/document-updated', () => {
      void controller.load()
    }),
  )

  disposers.push(
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: SETTINGS_SECTION_ID,
          order: SETTINGS_SECTION_ORDER,
          label: () => t('nav'),
          locale: SETTINGS_LOCALE_NS,
          inject: () => ({ controller, t }),
        },
        TlmemorySettingsSection,
      ),
    ),
  )

  const dispose = (): void => {
    for (const entry of disposers.splice(0)) {
      try {
        entry()
      } catch (error) {
        console.warn('[tlmemory] 设置面板回收失败：', error)
      }
    }
  }
  ctx.effect(() => dispose, 'tlmemory: settings section')
  return dispose
}
