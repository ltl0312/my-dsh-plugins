'use strict'

/**
 * tlrp 的 Cordis Config（Schemastery）。
 *
 * 这个 schema 同时就是「设置界面」：`@deepseek-ai/dsh-settings` 只把
 * `.volatile()` 字段投影成表单，也只允许写 volatile 路径，所以所有需要
 * 在设置面板里改、或者需要被 `/rp` `/work` `/char` `/scene` 指令改的字段
 * 一律标 `.volatile()`。
 *
 * `.volatile()` 之后字段的解析结果是 live ref（`{ get() }`），运行期读数
 * 必须走 `core.live()`，否则热更新看到的是启动时的旧快照。
 */

const core = require('./core.cjs')

/**
 * 构建 Config schema。
 * @param {any} z `@deepseek-ai/schemastery` 的导出（默认导出）
 * @returns {any} Schemastery schema
 */
function buildConfig(z) {
  const characterShape = z.object({
    id: z.string().default(''),
    name: z.string().default(''),
    userTitle: z.string().default(''),
    identityLock: z.string().default(''),
    corePersona: z.string().default(''),
    defaultScene: z.string().default(''),
    appearanceAndSensory: z.string().default(''),
    actionPresets: z.string().default(''),
    speechStyle: z.string().default(''),
    dialogueExamples: z.string().default(''),
    statusFooterTemplate: z.string().default(''),
  })

  const triggerShape = z.object({
    id: z.string().default(''),
    characterId: z.string().default(''),
    keywords: z.array(z.string()).default([]),
    injectText: z.string().default(''),
    priority: z.number().default(0),
    enabled: z.boolean().default(true),
  })

  const modeShape = z.object({
    id: z.string().default(''),
    name: z.string().default(''),
    commandAliases: z.array(z.string()).default([]),
    autoKeywords: z.string().default(''),
    autoPriority: z.number().default(50),
    directivePrompt: z.string().default(''),
    toolPolicy: z.union(['allow_all', 'whitelist_only', 'block_all']).default('allow_all'),
    allowedTools: z.string().default(''),
    injectCharacterPersona: z.boolean().default(true),
    enableStatusFooter: z.boolean().default(true),
    statusFooterOverride: z.string().default(''),
    bindCharacterId: z.string().default(''),
    isDefaultFallback: z.boolean().default(false),
    styleLayer: z
      .union(['inherit', 'on', 'off'])
      .default('inherit')
      .description('风格层开关（只带语言风格，不演动作）：on 强制开、off 强制关、inherit 跟随全局 styleLayerDefault。'),
  })

  return z.object({
    /* ── 设置面板字段（全部 volatile） ── */
    enabled: z
      .boolean()
      .default(true)
      .description('插件总开关。关闭后不注入任何角色、形态约束与工具拦截。')
      .volatile(),
    mode: z
      .string()
      .default('auto')
      .description('路由锁定：auto 按各形态的 autoKeywords 自动分流；填任意已注册形态 id 则锁死在该形态。聊天里用 /auto、/mode <id> 或形态别名切换。')
      .volatile(),
    modes: z
      .array(modeShape)
      .default(core.DEFAULT_MODES.map((entry) => ({ ...entry, commandAliases: [...entry.commandAliases] })))
      .description('运行形态矩阵：每个形态含 id / name / commandAliases / autoKeywords / autoPriority / directivePrompt / toolPolicy / allowedTools / injectCharacterPersona / enableStatusFooter / statusFooterOverride / bindCharacterId / isDefaultFallback。增删改后即时生效。')
      .volatile(),
    activeCharacterId: z
      .string()
      .default('firefly')
      .description('当前激活的预设角色 ID（见 characters）。聊天里用 /char <id> 切换。')
      .volatile(),
    workModeKeywords: z
      .union([z.string(), z.array(z.string())])
      .default(core.DEFAULT_WORK_KEYWORDS)
      .description('（0.2.0 兼容字段）行为族为 work 的形态若没写自己的 autoKeywords，则用这里的关键词做自动分流。新形态请直接在形态自己的 autoKeywords 里配置。')
      .volatile(),
    blockShellToolsInRp: z
      .boolean()
      .default(true)
      .description('（0.2.0 兼容字段）行为族为 rp 的形态在 whitelist_only 策略下是否物理拦截工具；0.3.0 起建议改用形态自己的 toolPolicy。')
      .volatile(),
    enableStatusFooter: z
      .boolean()
      .default(true)
      .description('状态面板总开关；与形态自己的 enableStatusFooter 取「与」。')
      .volatile(),
    customSceneOverride: z
      .string()
      .default('')
      .description('当前临时覆盖的剧情情景；留空则使用角色的 defaultScene。聊天里用 /scene <描述> 覆盖。')
      .volatile(),
    characters: z
      .array(characterShape)
      .default(core.DEFAULT_CHARACTERS.map((entry) => ({ ...entry })))
      .description('多角色预设库。每个角色含 id / name / userTitle / identityLock / defaultScene / appearanceAndSensory / actionPresets / speechStyle / statusFooterTemplate。')
      .volatile(),
    triggers: z
      .array(triggerShape)
      .default(core.DEFAULT_TRIGGERS.map((entry) => ({ ...entry, keywords: [...entry.keywords] })))
      .description('提示词触发映射表（动态世界书）：命中 keywords 即把 injectText 注入本轮上下文。')
      .volatile(),

    /* ── 风格层：只带语言风格 + 表情 + 本地表情包/图库 ── */
    styleLayerDefault: z
      .union(['on', 'off'])
      .default('off')
      .description('风格层全局默认开关：形态自己的 styleLayer 没写 on/off 时按这里走。聊天里用 /style on|off|default 临时改本会话。')
      .volatile(),
    styleEmojiHint: z
      .string()
      .default('允许适度使用 emoji：一屏最多 2 个，放在句尾，不堆在句首，也不用 emoji 替代文字。')
      .description('风格层的表情规范；留空则完全不出现 emoji。')
      .volatile(),
    stickerDir: z
      .string()
      .default('')
      .description('本地表情包库目录；留空为 ~/.dsh/stickers。子目录名即角色 id，图片文件名即贴纸标签（如 开心.png → 标签「开心」）。')
      .volatile(),
    galleryDir: z
      .string()
      .default('')
      .description('本地图库目录；留空为 ~/.dsh/gallery。图片文件名即图片标签，供「给我看图」这类请求使用。')
      .volatile(),
    maxStickersPerTurn: z
      .number()
      .default(2)
      .description('单轮最多贴几张表情包或图片（0 = 只准用文字描述，不许贴图）。')
      .volatile(),

    /* ── 以下为普通配置（通过 profile 的 cordis.patch.yml 调整） ── */
    timeZone: z.string().default('Asia/Shanghai').description('{{now}} 与状态块使用的时区。'),    statusFooterLabel: z.string().default('流萤状态同步').description('底部状态面板的标题标签。'),
    registerNowVariable: z
      .union(['auto', 'off'])
      .default('auto')
      .description('是否尝试注册 {{now}} / {{cwd}}：auto 表示已被 prompt-clock 占用时自动让位，off 表示完全不注册。'),
    enableMemoryBridge: z
      .boolean()
      .default(true)
      .description('是否每轮从 tlmemory 的 SQLite 只读读取常驻羁绊（pinned）与关键词命中；驱动缺失或库不存在时自动降级为空。'),
    memoryDbPath: z
      .string()
      .default('')
      .description('tlmemory 数据库路径；留空则依次取环境变量 TLMEMORY_DB、~/.dsh/tlmemory.db。'),
    coreSectionEnabled: z.boolean().default(true).description('是否注册 {{tlrp_character}} / {{tlrp_directive}} 所在的核心 prompt section。'),
    coreSectionOrder: z.number().default(10150).description('核心 section 的排序位置（默认在 first-party 指引之后、persona suffix 之前）。'),
    coreSectionText: z
      .string()
      .default('## tlrp 角色与形态装配\n当前时间：{{now}}\n工作目录：{{cwd}}\n\n{{tlrp_character}}\n\n{{tlrp_directive}}')
      .description('核心 section 的模板；只允许 {{now}} / {{cwd}} / {{tlrp_character}} / {{tlrp_directive}} / {{tlrp_memory_context}} 五个占位符，其余会被中和。'),
    contextOrder: z.number().default(300).description('每轮尾部实时状态块的 context 排序位置。'),
    maxTriggerInjections: z.number().default(3).description('单轮最多注入多少组触发器（上限 8）。'),
    blockedToolPatterns: z
      .array(z.string())
      .default([...core.DEFAULT_BLOCKED_TOOL_PATTERNS])
      .description('RP 态下要拦截的工具名正则（deny 语义）。'),
    allowedToolPatterns: z
      .array(z.string())
      .default([...core.DEFAULT_ALLOWED_TOOL_PATTERNS])
      .description('无论什么模式都放行的工具名正则（allow 语义，优先于 deny）。'),
    activeProfileEntryId: z
      .string()
      .default('tlrp')
      .description('settings.mutate 使用的 profile 条目 id；改 bundle 行 id 时必须同步。'),
    rpAllowedTools: z
      .string()
      .default(core.DEFAULT_RP_ALLOWED_TOOLS)
      .description('RP 态放行的工具白名单（逗号分隔的工具名或前缀，默认 tlmemory / ask_user_question / schedule）。命中即放行，优先于拦截规则。')
      .volatile(),
  })
}

module.exports = { buildConfig }
