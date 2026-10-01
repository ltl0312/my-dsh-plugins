// packages/tlnotify/src/client/i18n.ts
//
// 设置页自己的双语词表。
//
// 不接宿主的 locale 服务：`settings.section` 的契约是「注册者负责在语言变化时带上
// 新文案重新注册」，即宿主 shell 不会替我们订阅语言状态；而本插件只需要一个导航名
// 与一张页面，为此去接一整套 locale 命名空间不划算。
//
// 做法：`label` 传 thunk（每次读取重新求值），页面内文案在渲染时按当前语言取。
// 语言判定顺序见 `detectLang()`。

export type Lang = 'zh' | 'en'

const ZH = {
  nav: '通知助手',
  title: '通知助手',
  subtitle: '把 DSH 的会话事件推到一个 IM 通道，并能从那里直接回复。',
  loading: '正在读取配置…',
  loadFailed: '读不到配置',
  saveFailed: '保存失败',
  saved: '已保存',
  save: '保存',
  cancel: '取消',
  change: '改',
  fill: '填写',
  notSet: '未设置',
  retry: '重试',
  reload: '重新读取',
  noConnection: '浏览器没有连上宿主，这一页现在只能看，不能改。',
  unsavedHint: '改动会立即写入 config.json 并生效，不需要重启。',

  enabledLabel: '启用通知',
  enabledHint: '关掉之后不再推送任何通知。设置页本身仍然可用，方便你把它打开。',

  channels: '通道',
  channelsHint: '通知通过这里配置的机器人发出去。多个通道时按「默认通道」优先。',
  addChannel: '添加通道',
  addQq: '添加 QQ 机器人',
  addFeishu: '添加飞书机器人',
  channelId: '标识',
  channelIdHint: '只用于区分通道，随便起个短名字，例如 qq-main。',
  channelType: '类型',
  channelEnabled: '启用这个通道',
  remove: '删除',
  removeConfirm: '删掉这个通道？删掉之后它就不会再收到通知了。',
  appId: 'AppID',
  appSecret: 'AppSecret',
  secretClear: '清空',
  secretHint: '出于安全，已保存的密钥不会回显；这里留空表示保持原值。',
  targetId: '目标 ID',
  targetIdHintQq: 'QQ 单聊里就是你的 openid。用「扫码绑定」可以自动填。',
  targetIdHintFeishu: '飞书的接收者 ID，单聊时通常是 openid。',
  receiveIdType: '接收者类型',
  pushMode: '发送方式',
  pushActive: '主动消息',
  pushPassive: '被动回复',
  pushModeHint: '主动消息有配额上限（QQ 1000 条/天/用户）；被动回复只在用户先说话后的一段时间内可用。',
  bindLink: '绑定链接',
  bindLinkHint: '机器人分享链接。飞书留空会用 AppID 推导；QQ 没有可推导的链接，需要手填。',
  sessionFilter: '只推这些会话',
  sessionFilterHint: '每行一个会话 id，留空表示全部会话。',
  defaultChannel: '默认通道',
  defaultChannelNone: '（不指定，按配置顺序）',
  setDefault: '设为默认',
  isDefault: '默认',

  qrBind: '扫码绑定',
  qrWorking: '正在生成…',
  qrTitle: '用手机扫这个码',
  qrWaiting: '等你给机器人发一条消息…（也可以直接发「绑定」）',
  qrDone: '绑定成功，目标 ID 已自动填入。',
  qrExpired: '二维码已过期，请重新生成。',
  qrClose: '收起',
  qrFallback: '扫不动的话，把下面这串链接复制到手机上打开：',

  test: '测试连接',
  testing: '发送中…',
  testOk: '测试消息已发出',
  testHint: '会真发一条消息。收到就说明凭据和目标 ID 都对。',

  runMode: '运行模式',
  modeGlobal: '全局',
  modeSession: '单会话',
  modeGlobalHint: '所有主会话的事件都推，正文精简，回复走三层路由。',
  modeSessionHint: '只推绑定的那一个会话，正文给全上下文，回复零歧义。',
  boundSession: '绑定会话',
  noBoundSession: '还没绑定会话。在 IM 里发「/mode session <短id>」就能绑定。',
  detailSessions: '额外升级为详细模式的会话',
  detailNone: '（无）',

  events: '推哪些事件',
  eventsHint: '关掉的事件不会产生任何通知。',
  evTurnEnd: '任务完成',
  evError: '执行错误',
  evAborted: '手动中止',
  evPending: '等待我回答 / 授权 / 计划确认',
  evMaxTokens: 'Token 达到上限',
  evIncludeSubagent: '子 Agent 也推',
  evIncludeSubagentHint: '默认静默。一个任务可能派出几十个子 Agent，全推会刷屏。',

  content: '正文内容',
  contentHint: '控制推过去的消息里放多少东西。',
  ctIncludeMetadata: '附上元信息（项目、耗时、工具次数）',
  ctIncludeUserPrompt: '附上这一轮的用户提问',
  ctMaxBodyChars: '正文上限（字符）',
  ctMaxBodyCharsHint: '超出会被分段发送，首段带按钮。允许 200 – 20000。',
  sessionContext: '单会话模式的正文细节',
  scIncludeAssistant: '包含助手全文',
  scIncludeTools: '包含工具调用列表',
  scIncludeTiming: '包含耗时',
  scPreviousTurns: '附带前几轮（0 – 20）',
  scIncludeUserPrompt: '包含用户提问',

  routing: '回复路由',
  routingHint: '决定你在 IM 里回一句话时，它被投给哪个会话。',
  rtAllowPrefix: '允许「短id 内容」前缀定向',
  rtEchoTarget: '回复时回显「已发给 X」',
  rtEchoTargetHint: '关掉之后投递成功就不再回执。建议开着：沉底的通知里很容易记错会话。',
  rtFallback: '既没有引用也没有前缀时',
  rtFallbackLatest: '发给最新一条通知的会话',
  rtFallbackIntervention: '发给最近一次需要人介入的会话',
  rtTableTtlDays: '路由表保留天数（1 – 365）',
  rtTableTtlDaysHint: '超过这个天数的旧通知被引用时，会走兜底而不是静默投错。',

  advanced: '高级',
  logLevel: '日志级别',
  dataDir: '数据目录',
  configPath: '配置文件',

  status: '状态',
  statusRunning: '运行中',
  statusDisabled: '已停用',
  statusIdle: '未启动',
  statusPushed: '已推送 {n} 条',
  statusChannels: '通道 {ok}/{total} 可用',
  statusSince: '本次启动于 {time}',

  on: '开',
  off: '关',
  yes: '是',
  no: '否',
} as const

/** 词表的键。中英两份必须一一对应：少一个键就是一处没翻译的界面。 */
export type DictKey = keyof typeof ZH
/** 一份词表。键固定、值放宽成 string —— 直接把 `typeof ZH` 当词表类型会让英文那份
 *  因为字面量类型不匹配而整片报错（`"Save"` 不是 `"保存"`）。 */
export type Dict = { [K in DictKey]: string }

const EN: Dict = {
  nav: 'Notify',
  title: 'Notification assistant',
  subtitle: 'Push DSH session events to one IM channel, and reply straight from there.',
  loading: 'Loading configuration…',
  loadFailed: 'Could not read the configuration',
  saveFailed: 'Save failed',
  saved: 'Saved',
  save: 'Save',
  cancel: 'Cancel',
  change: 'Change',
  fill: 'Set',
  notSet: 'Not set',
  retry: 'Retry',
  reload: 'Reload',
  noConnection: 'The browser is not connected to the host, so this page is read-only right now.',
  unsavedHint: 'Changes are written to config.json and take effect immediately — no restart needed.',

  enabledLabel: 'Enable notifications',
  enabledHint: 'When off, nothing is pushed. This page stays available so you can turn it back on.',

  channels: 'Channels',
  channelsHint: 'Notifications are sent through the bots configured here. The default channel wins.',
  addChannel: 'Add channel',
  addQq: 'Add QQ bot',
  addFeishu: 'Add Feishu bot',
  channelId: 'Id',
  channelIdHint: 'Only used to tell channels apart. Something short, e.g. qq-main.',
  channelType: 'Type',
  channelEnabled: 'Enable this channel',
  remove: 'Delete',
  removeConfirm: 'Delete this channel? It will stop receiving notifications.',
  appId: 'AppID',
  appSecret: 'AppSecret',
  secretClear: 'Clear',
  secretHint: 'Saved secrets are never echoed back; leaving this empty keeps the current value.',
  targetId: 'Target id',
  targetIdHintQq: 'In a QQ direct message this is your openid. "Bind by QR" can fill it in.',
  targetIdHintFeishu: 'Feishu receiver id — usually an openid for direct messages.',
  receiveIdType: 'Receiver type',
  pushMode: 'Send mode',
  pushActive: 'Proactive',
  pushPassive: 'Passive reply',
  pushModeHint: 'Proactive messages are quota-limited (QQ: 1000/day/user); passive replies work only shortly after the user speaks.',
  bindLink: 'Bind link',
  bindLinkHint: 'The bot share link. Feishu derives it from the AppID; QQ needs it typed in.',
  sessionFilter: 'Only these sessions',
  sessionFilterHint: 'One session id per line. Empty means every session.',
  defaultChannel: 'Default channel',
  defaultChannelNone: '(none — config order)',
  setDefault: 'Set default',
  isDefault: 'Default',

  qrBind: 'Bind by QR',
  qrWorking: 'Generating…',
  qrTitle: 'Scan this with your phone',
  qrWaiting: 'Waiting for you to message the bot… (a plain "bind" works too)',
  qrDone: 'Bound. The target id has been filled in.',
  qrExpired: 'The QR code expired — generate a new one.',
  qrClose: 'Collapse',
  qrFallback: "If scanning fails, copy this link onto your phone:",

  test: 'Test connection',
  testing: 'Sending…',
  testOk: 'Test message sent',
  testHint: 'This really sends a message. If it arrives, the credentials and target id are correct.',

  runMode: 'Run mode',
  modeGlobal: 'Global',
  modeSession: 'Single session',
  modeGlobalHint: 'Every main session is pushed, briefly; replies go through three-layer routing.',
  modeSessionHint: 'Only the bound session is pushed, with full context; replies are unambiguous.',
  boundSession: 'Bound session',
  noBoundSession: 'No session bound yet. Send "/mode session <short-id>" in IM to bind one.',
  detailSessions: 'Sessions upgraded to detailed',
  detailNone: '(none)',

  events: 'Which events',
  eventsHint: 'Disabled events produce no notification at all.',
  evTurnEnd: 'Turn finished',
  evError: 'Execution error',
  evAborted: 'Aborted manually',
  evPending: 'Waiting on me (question / approval / plan)',
  evMaxTokens: 'Token limit reached',
  evIncludeSubagent: 'Include sub-agents',
  evIncludeSubagentHint: 'Silent by default — one task can spawn dozens of sub-agents.',

  content: 'Message content',
  contentHint: 'How much goes into the pushed message.',
  ctIncludeMetadata: 'Include metadata (project, duration, tool count)',
  ctIncludeUserPrompt: 'Include the user prompt of this turn',
  ctMaxBodyChars: 'Body limit (characters)',
  ctMaxBodyCharsHint: 'Longer bodies are sharded; the first shard carries the buttons. 200 – 20000.',
  sessionContext: 'Single-session detail',
  scIncludeAssistant: 'Include full assistant text',
  scIncludeTools: 'Include the tool-call list',
  scIncludeTiming: 'Include timing',
  scPreviousTurns: 'Include previous turns (0 – 20)',
  scIncludeUserPrompt: 'Include the user prompt',

  routing: 'Reply routing',
  routingHint: 'Decides which session a reply in IM is delivered to.',
  rtAllowPrefix: 'Allow the "<short-id> text" prefix',
  rtEchoTarget: 'Echo "sent to X" on delivery',
  rtEchoTargetHint: 'With this off, successful delivery is silent. Keep it on: it is easy to mix up sessions.',
  rtFallback: 'When there is neither a quote nor a prefix',
  rtFallbackLatest: 'Send to the latest notified session',
  rtFallbackIntervention: 'Send to the most recent session needing a human',
  rtTableTtlDays: 'Keep the routing table for (days, 1 – 365)',
  rtTableTtlDaysHint: 'Quoting an older notification falls back instead of silently misrouting.',

  advanced: 'Advanced',
  logLevel: 'Log level',
  dataDir: 'Data directory',
  configPath: 'Config file',

  status: 'Status',
  statusRunning: 'Running',
  statusDisabled: 'Disabled',
  statusIdle: 'Not started',
  statusPushed: '{n} pushed',
  statusChannels: '{ok}/{total} channels up',
  statusSince: 'Started at {time}',

  on: 'on',
  off: 'off',
  yes: 'yes',
  no: 'no',
}

const DICTS: Record<Lang, Dict> = { zh: ZH, en: EN }

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
export function translate(lang: Lang, key: keyof Dict, vars?: Record<string, string | number>): string {
  const template: string = dictOf(lang)[key]
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : `{${name}}`,
  )
}

export type Translator = (key: keyof Dict, vars?: Record<string, string | number>) => string

export function createTranslator(lang: Lang): Translator {
  return (key, vars) => translate(lang, key, vars)
}
