// packages/tlsearch/src/client/i18n.ts
//
// 设置页的双语词表 + 语言判定。
//
// 词表同时喂给宿主 locale 服务（`ctx.locale.register('settings.tlsearch', {zh, en})`），
// 所以导航名与页面文案只有这一份事实来源；页面正文另外保留本地的 `createTranslator`
// 只因为它的 `{name}` 占位符替换是自己实现的（不赌宿主 bind 的入参签名）。
//
// `label` 依赖宿主 locale：`settings.section` 的契约是「注册者自己在语言变化时给出新文案」
// （官方各 `dsh-client-ui-settings-*` 包都传 `locale:` + `label: () => t('nav')`）。

/** 设置页在宿主 locale 服务里注册的命名空间（与插槽注册里的 `locale` 字段一致）。 */
export const SETTINGS_LOCALE_NS = 'settings.tlsearch'

export type Lang = 'zh' | 'en'

const ZH = {
  nav: '联网搜索',
  title: '联网搜索（tlsearch）',
  subtitle: '给 Agent 一个 search 工具，按后端链依次尝试；第一个成功的就返回。',
  hintEveryChangeLive: '这一页的每一项都会立即写回配置并生效，不需要重启。',

  loading: '正在读取配置…',
  unavailable: '宿主没有提供这张配置表单',
  unavailableHint:
    '通常是插件的配置里还没有任何一项需要重新加载的字段，或者宿主版本不支持按字段写入。可以先用配置文件填好再回来。',
  noBridge: '浏览器没有连上宿主的设置服务，这一页现在只能看，不能改。',
  readOnly: '当前配置是只读的（宿主侧 profile 不可写），改动不会保存。',
  saveFailed: '保存失败',
  conflict: '配置在别处被改过，已重新读取，请再改一次。',
  saved: '已保存',
  saving: '保存中…',
  reload: '重新读取',

  sectionPrimary: '主后端',
  sectionPrimaryHint: '最常用的那一个。留空 apiKey 就会退到环境变量，再退到备用后端与后端链。',
  sectionFallback: '备用后端（简写）',
  sectionFallbackHint: '只填一个后端时用它；比在后端链里写一项更省事。',
  sectionChain: '后端链',
  sectionChainHint: '按顺序尝试，前一个失败（超时 / 限流 / 不可用）才走下一个。每一项形如 {"provider":"brave","apiKey":"..."}。',
  sectionOutput: '搜索结果',
  sectionOutputHint: '控制返回给 Agent 的内容量与格式。',
  sectionAdvanced: '高级',
  sectionAdvancedHint: '一般不用改。',

  provider: '后端',
  providerNone: '（不用）',
  apiKey: 'API Key',
  apiKeyHint: '留空表示不在这里配置：会去读环境变量，再不行就算不可用。密钥不回显，留空即保持原值。',
  apiKeySaved: '已保存（不回显）',
  baseUrl: 'Base URL',
  baseUrlHint: '留空用该后端的默认地址；自建 SearXNG 必填。',
  cx: 'CX / 搜索引擎 ID',
  cxHint: '只有 Google 需要。',

  maxResults: '结果条数上限',
  maxResultsHint: '1 – 10，默认 5。',
  maxSnippetChars: '摘要截断长度',
  maxSnippetCharsHint: '40 – 2000，默认 250。太长会挤占上下文。',
  timeoutMs: '超时（毫秒）',
  timeoutMsHint: '1000 – 60000，默认 15000。超时会被记为一次失败并切到下一个后端。',
  language: '结果语言',
  languageHint: '传给后端的语言偏好，例如 zh / en。留空由后端决定。',
  includeAnswer: '请求附带答案摘要',
  includeAnswerHint: '只有部分后端支持；不影响搜索结果本身。',
  outputFormat: '输出格式',
  outputFormatHint: 'Agent 看到的结果长什么样。',
  fmtMarkdown: 'Markdown',
  fmtJson: 'JSON',

  chainEmpty: '（空：只用主后端与备用后端）',
  chainInvalid: '这一段不是合法的后端对象',
  chainAdd: '加一项',
  chainRemove: '删除',

  usable: '可用',
  notUsable: '不可用',
  keyMissing: '缺少 API Key',
  baseUrlMissing: '缺少 Base URL',
  cxMissing: '缺少 CX',
  chainStatus: '当前可用后端',
  chainStatusNone: '一个都没有：这么调用会直接报错，并告诉你缺什么。',
  noKeyMode: '没有配置任何密钥时插件照常装配，工具会返回一句「怎么配」的说明，不会让宿主起不来。',

  on: '开',
  off: '关',
} as const

/** 词表的键。中英两份必须一一对应：少一个键就是一处没翻译的界面。 */
export type DictKey = keyof typeof ZH
/** 一份词表。键固定、值放宽成 string（直接把 `typeof ZH` 当词表类型会让英文那份
 *  因为字面量类型不匹配而整片报错）。 */
export type Dict = { [K in DictKey]: string }

const EN: Dict = {
  nav: 'Web search',
  title: 'Web search (tlsearch)',
  subtitle: 'Gives the agent a search tool that walks the backend chain and returns the first success.',
  hintEveryChangeLive: 'Every field on this page is written back and applied immediately — no restart.',

  loading: 'Loading configuration…',
  unavailable: 'The host does not expose a configuration form here',
  unavailableHint:
    'Usually this means no field of this plugin is marked as live-editable, or the host version cannot write per field. You can still fill in the configuration file and come back.',
  noBridge: 'The browser is not connected to the host settings service, so this page is read-only.',
  readOnly: 'This configuration is read-only (the host profile is not writable); changes will not be saved.',
  saveFailed: 'Save failed',
  conflict: 'The configuration changed elsewhere and was reloaded — please make the change again.',
  saved: 'Saved',
  saving: 'Saving…',
  reload: 'Reload',

  sectionPrimary: 'Primary backend',
  sectionPrimaryHint: 'The usual one. Leave the API key empty to fall back to the environment variable, then to the fallback backend and the chain.',
  sectionFallback: 'Fallback backend (shorthand)',
  sectionFallbackHint: 'Used when you only want one backup backend; simpler than an entry in the chain.',
  sectionChain: 'Backend chain',
  sectionChainHint:
    'Tried in order; the next one runs only when the previous fails (timeout / rate limit / unavailable). Each entry looks like {"provider":"brave","apiKey":"..."}.',
  sectionOutput: 'Search results',
  sectionOutputHint: 'How much is returned to the agent, and in which shape.',
  sectionAdvanced: 'Advanced',
  sectionAdvancedHint: 'Rarely needs changing.',

  provider: 'Backend',
  providerNone: '(none)',
  apiKey: 'API key',
  apiKeyHint:
    'Empty means "not configured here": the environment variable is read instead, and the backend counts as unusable if that is empty too. Saved secrets are never echoed; leave it empty to keep the current value.',
  apiKeySaved: '(saved — not shown)',
  baseUrl: 'Base URL',
  baseUrlHint: 'Empty uses the default address of that backend; required for a self-hosted SearXNG.',
  cx: 'CX / search engine id',
  cxHint: 'Google only.',

  maxResults: 'Result limit',
  maxResultsHint: '1 – 10, default 5.',
  maxSnippetChars: 'Snippet length',
  maxSnippetCharsHint: '40 – 2000, default 250. Longer snippets crowd out the context.',
  timeoutMs: 'Timeout (ms)',
  timeoutMsHint: '1000 – 60000, default 15000. A timeout counts as a failure and moves to the next backend.',
  language: 'Result language',
  languageHint: 'Language preference passed to the backend, e.g. zh / en. Empty lets the backend decide.',
  includeAnswer: 'Ask for an answer summary',
  includeAnswerHint: 'Only some backends support it; search results themselves are unaffected.',
  outputFormat: 'Output format',
  outputFormatHint: 'What the agent sees.',
  fmtMarkdown: 'Markdown',
  fmtJson: 'JSON',

  chainEmpty: '(empty: primary and fallback backends only)',
  chainInvalid: 'This entry is not a valid backend object',
  chainAdd: 'Add entry',
  chainRemove: 'Remove',

  usable: 'usable',
  notUsable: 'unusable',
  keyMissing: 'API key missing',
  baseUrlMissing: 'base URL missing',
  cxMissing: 'CX missing',
  chainStatus: 'Usable backends',
  chainStatusNone: 'None: a call will fail with a message naming the missing piece.',
  noKeyMode:
    'With no key configured the plugin still mounts; the tool answers with a short "how to configure" note instead of breaking the host.',

  on: 'on',
  off: 'off',
}

const DICTS: Record<Lang, Dict> = { zh: ZH, en: EN }

/** 交给 `ctx.locale.register()` 的两份词表。 */
export const DICTIONARIES: Record<Lang, Dict> = DICTS

/** 猜当前语言。取不到就当中文——本插件的目标用户是中文环境。 */
export function detectLang(): Lang {
  try {
    const root = typeof document === 'undefined' ? undefined : document.documentElement
    const declared = root?.getAttribute('lang') ?? root?.lang
    if (declared) return /^en\b/i.test(declared) ? 'en' : 'zh'
    const nav = typeof navigator === 'undefined' ? undefined : navigator.language
    if (nav) return /^en\b/i.test(nav) ? 'en' : 'zh'
  } catch {
    /* 读不到就回退 */
  }
  return 'zh'
}

export function dictOf(lang: Lang): Dict {
  return DICTS[lang] ?? ZH
}

/** 取一条文案；`vars` 会替换文案里的 `{name}` 占位符。 */
export function translate(lang: Lang, key: DictKey, vars?: Record<string, string | number>): string {
  const template: string = dictOf(lang)[key]
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : `{${name}}`,
  )
}

export type Translator = (key: DictKey, vars?: Record<string, string | number>) => string

export function createTranslator(lang: Lang): Translator {
  return (key, vars) => translate(lang, key, vars)
}
