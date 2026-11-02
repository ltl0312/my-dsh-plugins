/**
 * tlrp 客户端：TLRP 角色与双态引擎工作室（设置页独立栏目 + 插件页配置卡）。
 *
 * 运行时契约（照 §dsh 0.2.1-rc.5 客户端插件实测源码写死，不猜）：
 *   - 宿主用 window.__ModuleLoader__.load({ id, factory }) 加载本文件；
 *   - apply(ctx) 的 inject 声明 ['slots','locale']，configForms 走可选子作用域，
 *     旧宿主没有该服务时只是不出配置卡，不连累整个插件挂载；
 *   - 配置读写全部走 ctx.configForms.get(entryId)：它对每个命名空间给一个
 *     ConfigFormController，暴露 getSnapshot/subscribe/set/unset/mutate，
 *     写入最终落到 remote.settings.mutate —— 与设置界面、`settings.mutate`
 *     外部接口是同一条通道，不需要自己发明协议；
 *   - 页面把三种槽位分开：`settings.section`（设置侧边栏栏目）、
 *     `plugins.bundle.config`（键=包名）与 `plugins.row.config`
 *     （键=`<包名>#<行 id>`，即插件管理里 bundle 行的配置页）。
 *
 * 之所以要「候选命名空间」：bundle 行会被 Loader 包进 include 组，宿主实际服出的
 * 命名空间是 `include:tlrp`，裸 `tlrp` 只有在没有 include 包装时才存在。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-tlrp",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = react;

    /** 本插件拥有的字典命名空间。 */
    const NS = "settings.tlrp";

    /** 宿主实际服出的配置命名空间候选，按优先级排列。 */
    const NAMESPACE_CANDIDATES = ["include:tlrp", "tlrp"];
    /** 本插件在 bundle 清单里的包名。 */
    const BUNDLE_NAME = "dsh-plugin-tlrp";
    /** 本 bundle 在自己 patch 里声明的行 id。 */
    const ROW_ID = "tlrp";
    /** 插件页行配置的槽位键：`<包名>#<行 id>`。 */
    const ROW_CONFIG_KEY = `${BUNDLE_NAME}#${ROW_ID}`;
    /** 设置侧边栏里的栏目 id：取自己的新 id 就与官方条目并列，不覆盖任何人。 */
    const SECTION_ID = "tlrp";
    /** 栏目排序：在 plugins(15) / 记忆类(30~31) 之后，通知(60) 之前。 */
    const SECTION_ORDER = 45;

    /* ─────────────────────── 角色字段定义 ─────────────────────── */

    /**
     * 工作室表单的字段表：key 与宿主 Config 的 characterShape 一一对应。
     * `area` 表示多行、`rows` 是默认行高。
     */
    const CHAR_FIELDS = [
      { key: "id", area: false, rows: 1 },
      { key: "name", area: false, rows: 1 },
      { key: "userTitle", area: false, rows: 1 },
      { key: "defaultScene", area: true, rows: 2 },
      { key: "identityLock", area: true, rows: 5 },
      { key: "corePersona", area: true, rows: 5 },
      { key: "appearanceAndSensory", area: true, rows: 5 },
      { key: "actionPresets", area: true, rows: 5 },
      { key: "speechStyle", area: true, rows: 4 },
      { key: "dialogueExamples", area: true, rows: 7 },
      { key: "statusFooterTemplate", area: true, rows: 5 },
    ];

    /** 新建角色用的空骨架。 */
    const EMPTY_CHARACTER = {
      id: "",
      name: "",
      userTitle: "你",
      identityLock: "",
      corePersona: "",
      defaultScene: "",
      appearanceAndSensory: "",
      actionPresets: "",
      speechStyle: "",
      dialogueExamples: "",
      statusFooterTemplate: "",
    };

    /** 新建触发器用的空骨架。 */
    const EMPTY_TRIGGER = {
      id: "",
      characterId: "",
      keywords: [],
      injectText: "",
      priority: 50,
      enabled: true,
    };

    /* ─────────────────────── 形态字段定义 ─────────────────────── */

    /** 工具策略下拉项：与 core.cjs 的 TOOL_POLICIES 一一对应。 */
    const TOOL_POLICY_OPTIONS = ["allow_all", "whitelist_only", "block_all"];

    /** 新建形态用的空骨架：字段名与 lib/schema.cjs 的 modeShape 一一对应。 */
    const EMPTY_MODE = {
      id: "",
      name: "",
      commandAliases: [],
      autoKeywords: "",
      autoPriority: 50,
      directivePrompt: "",
      toolPolicy: "allow_all",
      allowedTools: "",
      injectCharacterPersona: true,
      enableStatusFooter: true,
      statusFooterOverride: "",
      bindCharacterId: "",
      isDefaultFallback: false,
    };

    /** 形态 id 的合法字符：与宿主注册斜杠指令时用的正则保持一致。 */
    const MODE_ID_RE = /^[A-Za-z0-9_-]+$/;

    /**
     * UI 兜底形态表：只在配置里还没有 `modes`（新装、或设置快照未到位）时使用。
     * 行为准则与工具策略的真源在宿主 lib/core.cjs 的 DEFAULT_MODES，这里只保证
     * 切换栏与下拉永远有东西可选，不与宿主抢定义权。
     */
    const DEFAULT_MODES = [
      {
        id: "rp",
        name: "少女陪伴态",
        commandAliases: ["/rp", "【流萤】", "【陪伴】"],
        autoKeywords: "喜欢|想你|陪我|晚安|抱抱|撒娇|难受|孤独|害怕|无聊|聊聊|好想|在吗",
        autoPriority: 10,
        directivePrompt: "",
        toolPolicy: "whitelist_only",
        allowedTools: "tlmemory, ask_user_question, schedule",
        injectCharacterPersona: true,
        enableStatusFooter: true,
        statusFooterOverride: "",
        bindCharacterId: "",
        isDefaultFallback: true,
      },
      {
        id: "work",
        name: "战术工作态",
        commandAliases: ["/work", "【战术】"],
        autoKeywords:
          "端口|报错|日志|目录|容器|docker|nginx|ssh|systemctl|配置|脚本|代码|bug|pid|进程|编译|权限|路由",
        autoPriority: 50,
        directivePrompt: "",
        toolPolicy: "allow_all",
        allowedTools: "",
        injectCharacterPersona: false,
        enableStatusFooter: false,
        statusFooterOverride: "",
        bindCharacterId: "",
        isDefaultFallback: false,
      },
      {
        id: "sam",
        name: "萨姆强袭态",
        commandAliases: ["/sam", "【萨姆】", "【机甲】"],
        autoKeywords: "萨姆|变身|机甲|点燃大海|焦土作战|虫群",
        autoPriority: 80,
        directivePrompt: "",
        toolPolicy: "allow_all",
        allowedTools: "",
        injectCharacterPersona: true,
        enableStatusFooter: true,
        statusFooterOverride: "",
        bindCharacterId: "",
        isDefaultFallback: false,
      },
      {
        id: "sleep",
        name: "医疗舱微凉态",
        commandAliases: ["/sleep", "【医疗舱】"],
        autoKeywords: "晚安|睡不着|好累|失眠|医疗舱",
        autoPriority: 60,
        directivePrompt: "",
        toolPolicy: "whitelist_only",
        allowedTools: "tlmemory, ask_user_question, schedule",
        injectCharacterPersona: true,
        enableStatusFooter: true,
        statusFooterOverride: "",
        bindCharacterId: "",
        isDefaultFallback: false,
      },
    ];

    /** 把形态的别名数组渲染成逗号分隔的编辑文本。 */
    function aliasesToText(aliases) {
      return Array.isArray(aliases) ? aliases.join(", ") : "";
    }

    /** 把编辑文本拆回别名数组（逗号、顿号与空白都算分隔符）。 */
    function textToAliases(text) {
      return String(text ?? "")
        .split(/[,，、\s]+/)
        .map((word) => word.trim())
        .filter(Boolean);
    }

    /**
     * 形态归一化：与宿主 normalizeMode 的默认值保持一致，避免表单缺键。
     * @param entry - 配置里的形态对象。
     * @param index - 用于生成兜底 id。
     * @returns 补齐全部字段的形态对象。
     */
    function normalizeModeEntry(entry, index) {
      const source = entry && typeof entry === "object" ? entry : {};
      const id = String(source.id ?? "").trim() || `mode-${index + 1}`;
      const priority = Number(source.autoPriority);
      return {
        ...EMPTY_MODE,
        ...source,
        id,
        name: String(source.name ?? "").trim() || id,
        commandAliases: Array.isArray(source.commandAliases)
          ? source.commandAliases.map((item) => String(item)).filter(Boolean)
          : textToAliases(source.commandAliases),
        autoKeywords: typeof source.autoKeywords === "string" ? source.autoKeywords : "",
        autoPriority: Number.isFinite(priority) ? priority : 50,
        directivePrompt: typeof source.directivePrompt === "string" ? source.directivePrompt : "",
        toolPolicy: TOOL_POLICY_OPTIONS.includes(source.toolPolicy) ? source.toolPolicy : "allow_all",
        allowedTools: typeof source.allowedTools === "string" ? source.allowedTools : "",
        injectCharacterPersona: source.injectCharacterPersona !== false,
        enableStatusFooter: source.enableStatusFooter !== false,
        statusFooterOverride: typeof source.statusFooterOverride === "string" ? source.statusFooterOverride : "",
        bindCharacterId: typeof source.bindCharacterId === "string" ? source.bindCharacterId : "",
        isDefaultFallback: source.isDefaultFallback === true,
      };
    }

    /** 把配置里的形态数组补齐成可渲染列表；缺失时回落 UI 兜底形态表。 */
    function normalizeModeList(raw) {
      const source = Array.isArray(raw) && raw.length > 0 ? raw : DEFAULT_MODES;
      return source.map((entry, index) => normalizeModeEntry(entry, index));
    }

    /**
     * 工具策略的可读名。
     * @param t - 字典取词函数。
     * @param policy - allow_all / whitelist_only / block_all。
     * @returns 本地化文案。
     */
    function toolPolicyLabel(t, policy) {
      if (policy === "whitelist_only") return t("policyWhitelist");
      if (policy === "block_all") return t("policyBlockAll");
      return t("policyAllowAll");
    }

    /* ────────────────────────── 文案 ────────────────────────── */

    /** 中文文案。 */
    const zh = {
      sectionLabel: "TLRP 角色与双态引擎",
      title: "TLRP 角色与双态引擎",
      description: "通用角色扮演与双态路由引擎：管理运行模式、角色设定、关键词触发映射与预设导入导出。",
      loading: "正在读取 tlrp 配置…",
      unavailable: "本部署没有服出 tlrp 的设置命名空间，工作室暂时不可用。",
      readOnly: "本部署的设置为只读，改动不会保存。",
      saving: "保存中…",
      saved: "已保存",
      saveFailed: "本部署拒绝了这次写入，已回读宿主值。",
      writeFailedHint: "写入失败：宿主可能处于只读模式，或命名空间未服出。",

      modeSection: "形态矩阵工作室 Mode Studio",
      modeSectionHint: "运行形态可以像角色一样自由增删改：每个形态有自己的行为准则、工具策略、状态面板模板与触发指令；auto 按优先级与关键词自动分流。",
      mode: "当前模式",
      modeHint: "点顶部按钮直接锁定；选「自动路由」则按关键词与优先级每轮判定。",
      modeAuto: "自动路由 (auto)",
      modeRp: "少女陪伴态",
      modeWork: "战术工作态",
      modePicker: "编辑形态",
      modePickerHint: "选择要编辑的形态；改动后点「保存形态修改」才写入配置。",
      newMode: "新建形态",
      duplicateMode: "复制当前形态",
      removeMode: "删除当前形态",
      saveMode: "保存形态修改",
      setFallback: "设为 Auto 默认兜底形态",
      cannotRemoveLastMode: "至少要保留一个形态。",
      unknownMode: "未注册形态",
      modeUnsavedHint: "形态表单已改动，点「保存形态修改」才会写入配置。",
      fallbackBadge: "Auto 兜底",
      legacySection: "0.2.0 兼容字段",
      legacyHint: "这些旧字段仍会被读取，但只在形态自己没有配置时才生效；新配置建议直接写进对应形态。",
      field_mode_id: "形态 ID",
      hint_mode_id: "唯一标识，同时是 /mode 的参数与斜杠指令名（字母、数字、- 与 _）。",
      field_mode_name: "形态显示名",
      hint_mode_name: "顶部切换栏与运行时状态块里显示的名字。",
      field_mode_commandAliases: "聊天触发指令别名",
      hint_mode_commandAliases: "逗号或空格分隔，例如 /sam, 【萨姆】, 变身；以 / 开头的别名会注册成真实指令。",
      field_mode_autoKeywords: "Auto 自动匹配正则",
      hint_mode_autoKeywords: "每行一条正则或关键词；auto 模式下按命中数与优先级决定切到哪个形态。",
      field_mode_autoPriority: "匹配优先级",
      hint_mode_autoPriority: "数字越大越优先；所有形态都未命中时回落到「Auto 兜底」形态。",
      field_mode_toolPolicy: "工具放行策略",
      hint_mode_toolPolicy: "决定该形态下运维工具能不能调：放行全部／仅白名单／禁用全部。",
      field_mode_allowedTools: "白名单（仅白名单策略生效）",
      hint_mode_allowedTools: "逗号分隔的工具名或前缀，例如 tlmemory, ask_user_question, schedule。",
      field_mode_injectCharacterPersona: "注入完整人设",
      hint_mode_injectCharacterPersona: "关闭后只注入身份锁与称呼，适合纯运维形态。",
      field_mode_enableStatusFooter: "强制底部状态面板",
      hint_mode_enableStatusFooter: "开启后每轮回复末尾必须带状态同步块。",
      field_mode_directivePrompt: "该形态专属行为准则",
      hint_mode_directivePrompt: "多行文本；可用 {name}{id}{userTitle}{scene}{character}{footer}{tools} 占位符。留空则回落到内置的陪伴／运维行为族。",
      field_mode_statusFooterOverride: "该形态专属状态栏模板覆盖",
      hint_mode_statusFooterOverride: "留空则使用角色自己的状态面板模板；可用 {label}{scene}{dress}{os}{heat}{shield}{vocoder}{entropy}。",
      field_mode_bindCharacterId: "联动角色",
      hint_mode_bindCharacterId: "切到该形态时自动切换到的角色；留空表示保持当前角色。",
      policyAllowAll: "放行全部工具",
      policyWhitelist: "仅白名单",
      policyBlockAll: "禁用全部工具",
      modeNoDirective: "（未填专属准则，回落到内置行为族）",
      modeAliasesLabel: "触发别名",
      modePriorityLabel: "优先级",
      modePolicyLabel: "工具策略",
      modeDirectiveLabel: "专属准则",
      modeBindKeep: "保持当前角色",
      newModeName: "新形态",
      modeIdInvalid: "形态 ID 只能是字母、数字、- 与 _，且不能为空。",
      modeIdTaken: "这个形态 ID 已被占用，换一个。",
      enabled: "总开关",
      enabledHint: "关闭后不注入任何角色设定与双态指令，指令本身也失效。",
      blockShell: "RP 态拦截运维工具（0.2.0）",
      blockShellHint: "旧开关：只在形态自身没写工具策略时兜底，用于兼容 0.2.0 的 blockShellToolsInRp。",
      footer: "强制底部状态面板（0.2.0）",
      footerHint: "旧开关：形态自身没配 enableStatusFooter 时才生效。",
      workKeywords: "Work 态自动触发词正则（0.2.0）",
      workKeywordsHint: "旧字段：只在形态自身没写 autoKeywords 且族为 Work 时兜底；新配置请写进形态。",
      rpAllowed: "RP 态放行的工具白名单（0.2.0）",
      rpAllowedHint: "旧字段：只在形态自身没写 allowedTools 时兜底；新配置请写进形态。",
      scene: "临时情景覆盖",
      sceneHint: "留空则使用角色自己的默认情景。",
      scenePlaceholder: "例如：现实宇宙·星舰医疗舱外",
      apply: "应用",
      clear: "清空",

      studio: "角色工作室 Character Studio",
      studioHint: "角色设定全部落在配置里，可自由编辑、复制、删除与新建；保存后立刻影响下一轮注入。",
      character: "当前角色",
      characterHint: "切换后本区表单与 {{tlrp_character}} 同步切换。",
      newCharacter: "新建空白角色",
      duplicateCharacter: "复制当前角色",
      removeCharacter: "删除当前角色",
      saveCharacter: "保存角色修改",
      cannotRemoveLast: "至少要保留一个角色。",
      unknownCharacter: "未知角色",
      unsavedHint: "表单已改动，点「保存角色修改」才会写入配置。",
      field_id: "角色 ID",
      hint_id: "配置里的唯一标识；改名会同步搬走绑定在该角色上的触发器。",
      field_name: "角色名",
      hint_name: "显示在标题与角色下拉里的名字。",
      field_userTitle: "专属称呼",
      hint_userTitle: "角色怎么称呼对方，例如「开拓者」；禁用「用户」「您」。",
      field_defaultScene: "默认情景",
      hint_defaultScene: "没有临时情景覆盖时使用。",
      field_identityLock: "绝对身份锁",
      hint_identityLock: "不可违反的底线：不得自称 AI／助手，不得自曝运维身份。",
      field_corePersona: "核心背景与性格",
      hint_corePersona: "经历、反差与最在意的东西，决定角色为什么这样说话。",
      field_appearanceAndSensory: "外貌与感官细节",
      hint_appearanceAndSensory: "发色、瞳色、气味、体温这类可直接写进描写的锚点。",
      field_actionPresets: "招牌微动作与情节预设",
      hint_actionPresets: "害羞、开心、危机时各自的固定身体反应。",
      field_speechStyle: "语言风格与禁用项",
      hint_speechStyle: "语速、常用语气词、绝对不要出现的句式。",
      field_dialogueExamples: "台词与互动范例",
      hint_dialogueExamples: "给模型做语气校准的样张，一般 4~8 条。",
      field_statusFooterTemplate: "底部状态面板模板",
      hint_statusFooterTemplate: "RP 态每轮结尾必须按此结构逐项填写。",
      newCharacterName: "新角色",
      newSceneDefault: "未指定情景",
      copySuffix: " 副本",

      triggers: "触发词映射表",
      triggersHint: "命中关键词时把注入文本并入本轮上下文；绑定角色的条目只对该角色生效。",
      addTrigger: "新增触发词映射",
      filterTriggers: "筛选",
      filterAll: "全部条目",
      filterGlobal: "仅全局",
      triggerEnabled: "启用",
      triggerNote: "名称备注",
      triggerCharacter: "绑定角色",
      triggerCharacterGlobal: "全局（所有角色）",
      triggerKeywords: "关键词（逗号或正则）",
      triggerKeywordsHint: "用逗号分隔多个关键词；写成 /正则/ 形式则按正则匹配。",
      triggerInject: "注入文本",
      triggerPriority: "优先级",
      removeTrigger: "删除此条",
      emptyTriggers: "还没有触发词映射，点上面的按钮新增一条。",
      triggersCount: "共 {count} 条（启用 {enabled} 条）",

      presets: "预设导入导出与调试探针",
      presetsHint: "整库预设走 JSON 往返；预览区展示当前模式下 {{tlrp_character}} 与 {{tlrp_directive}} 的实际内容。",
      exportJson: "导出当前角色 JSON",
      exportHint: "导出包含全部角色与触发器的 JSON，可直接保存或转给别的部署。",
      download: "下载 .json",
      importJson: "从 JSON 导入角色/触发器",
      importHint: "粘贴上面格式的 JSON：顶层可含 characters 与 triggers；同 id 覆盖，其余追加。",
      importApply: "导入",
      importFailed: "JSON 解析失败或结构不对。",
      importDone: "已导入：角色 {characters} 个、触发器 {triggers} 条。",
      preview: "预览当前合成 Prompt",
      previewHint: "左侧是 {{tlrp_character}} 的拼装结果（与宿主渲染顺序一致），右侧是 {{tlrp_directive}} 当前模式的红线条目。",
      previewCharacter: "{{tlrp_character}}",
      previewDirective: "{{tlrp_directive}}",
      previewLocalNote: "预览在浏览器侧按同一字段顺序拼装；宿主每轮还会追加实时状态块。",
      rpRules: "RP 态红线：第一人称沉浸、必带 *斜体微动作与感官描写*、禁项目符号清单、结尾必带状态面板；身份锁优先于一切运维口径。",
      workRules: "WORK 态红线：结论先行 → 证据 → 下一步；不写斜体动作、不写状态面板；危险操作先摊开再等确认。",
      offRules: "总开关已关闭：本轮不注入角色设定与双态指令。",
      currentMode: "当前生效",
      userTitle: "称呼",
      hitTriggers: "本轮命中设定",
    };

    /** 英文文案，键集与中文一致。 */
    const en = {
      sectionLabel: "TLRP character & mode engine",
      title: "TLRP character & mode engine",
      description: "A generic roleplay and dual-mode routing engine: run mode, character sheets, keyword triggers and preset import/export.",
      loading: "Reading tlrp configuration…",
      unavailable: "This deployment does not serve the tlrp settings namespace, so the studio is unavailable.",
      readOnly: "Settings are read-only on this deployment.",
      saving: "Saving…",
      saved: "Saved",
      saveFailed: "This deployment refused the write; values were re-read from the host.",
      writeFailedHint: "Write failed: the host may be read-only, or the namespace is not served.",

      modeSection: "Mode Studio",
      modeSectionHint: "Runtime modes are as editable as characters: each one carries its own directive, tool policy, status-footer template and trigger aliases; auto routes by priority and keywords.",
      mode: "Mode",
      modeHint: "Click a button to lock a mode; Auto routes every turn from keywords and priority.",
      modeAuto: "Auto route (auto)",
      modeRp: "Companion",
      modeWork: "Tactical work",
      modePicker: "Editing mode",
      modePickerHint: "Pick a mode to edit; press Save mode to write it back.",
      newMode: "New mode",
      duplicateMode: "Duplicate current",
      removeMode: "Delete current",
      saveMode: "Save mode",
      setFallback: "Make this the auto fallback",
      cannotRemoveLastMode: "At least one mode must remain.",
      unknownMode: "Unregistered mode",
      modeUnsavedHint: "This mode form has unsaved edits; press Save mode to write them.",
      fallbackBadge: "Auto fallback",
      legacySection: "0.2.0 compatibility fields",
      legacyHint: "These legacy fields are still read, but only when a mode has no value of its own; new configuration belongs in the mode.",
      field_mode_id: "Mode id",
      hint_mode_id: "Unique key, also the /mode argument and slash command (letters, digits, - and _).",
      field_mode_name: "Display name",
      hint_mode_name: "Shown in the switch bar and the runtime state block.",
      field_mode_commandAliases: "Trigger aliases",
      hint_mode_commandAliases: "Comma or space separated, e.g. /sam, 【萨姆】, 变身; aliases starting with / become real commands.",
      field_mode_autoKeywords: "Auto match regexes",
      hint_mode_autoKeywords: "One regex or keyword per line; auto picks the mode by hit count, then priority.",
      field_mode_autoPriority: "Match priority",
      hint_mode_autoPriority: "Higher wins; when nothing matches, the auto fallback mode takes over.",
      field_mode_toolPolicy: "Tool policy",
      hint_mode_toolPolicy: "Whether ops tools may run in this mode: all / allowlist only / none.",
      field_mode_allowedTools: "Allowlist (allowlist policy only)",
      hint_mode_allowedTools: "Comma-separated tool names or prefixes, e.g. tlmemory, ask_user_question, schedule.",
      field_mode_injectCharacterPersona: "Inject full persona",
      hint_mode_injectCharacterPersona: "When off, only the identity lock and address form are injected.",
      field_mode_enableStatusFooter: "Force status footer",
      hint_mode_enableStatusFooter: "When on, every reply must end with the status block.",
      field_mode_directivePrompt: "Mode directive",
      hint_mode_directivePrompt: "Multi-line; supports {name}{id}{userTitle}{scene}{character}{footer}{tools}. Empty falls back to the built-in family directive.",
      field_mode_statusFooterOverride: "Status footer template override",
      hint_mode_statusFooterOverride: "Empty uses the character template; supports {label}{scene}{dress}{os}{heat}{shield}{vocoder}{entropy}.",
      field_mode_bindCharacterId: "Bound character",
      hint_mode_bindCharacterId: "Character switched to when this mode activates; empty keeps the current one.",
      policyAllowAll: "Allow every tool",
      policyWhitelist: "Allowlist only",
      policyBlockAll: "Block every tool",
      modeNoDirective: "(no mode directive — the built-in family directive applies)",
      modeAliasesLabel: "Aliases",
      modePriorityLabel: "Priority",
      modePolicyLabel: "Tool policy",
      modeDirectiveLabel: "Directive",
      modeBindKeep: "Keep current character",
      newModeName: "New mode",
      modeIdInvalid: "A mode id may only use letters, digits, - and _ and cannot be empty.",
      modeIdTaken: "That mode id is already taken.",
      enabled: "Master switch",
      enabledHint: "When off, no character sheet or directive is injected and the commands stop working.",
      blockShell: "Block ops tools in RP",
      blockShellHint: "In companion mode, shell/terminal/file tools are blocked; only the allowlist passes.",
      footer: "Force status footer",
      footerHint: "In companion mode every reply must end with the status block.",
      workKeywords: "Work-mode trigger regexes",
      workKeywordsHint: "One regex or keyword per line; in auto mode a single hit selects WORK.",
      rpAllowed: "RP tool allowlist",
      rpAllowedHint: "Comma-separated tool names or prefixes, default tlmemory; a hit always passes.",
      scene: "Temporary scene override",
      sceneHint: "Leave empty to use the character default scene.",
      scenePlaceholder: "e.g. Real universe, outside the ship's medical bay",
      apply: "Apply",
      clear: "Clear",

      studio: "Character Studio",
      studioHint: "Every character field lives in configuration: edit, duplicate, delete or create freely; saving takes effect on the next turn.",
      character: "Active character",
      characterHint: "Switching re-binds this form and {{tlrp_character}} together.",
      newCharacter: "New blank character",
      duplicateCharacter: "Duplicate current",
      removeCharacter: "Delete current",
      saveCharacter: "Save character",
      cannotRemoveLast: "At least one character must remain.",
      unknownCharacter: "Unknown character",
      unsavedHint: "This form has unsaved edits; press Save character to write them.",
      field_id: "Character id",
      hint_id: "Unique key in configuration; renaming also re-points triggers bound to it.",
      field_name: "Name",
      hint_name: "Shown in the header and the character picker.",
      field_userTitle: "Address as",
      hint_userTitle: "How the character addresses you; avoid generic placeholders.",
      field_defaultScene: "Default scene",
      hint_defaultScene: "Used unless a temporary scene override is set.",
      field_identityLock: "Identity lock",
      hint_identityLock: "Hard floor: never claim to be an AI or a service process.",
      field_corePersona: "Background & personality",
      hint_corePersona: "History, contrast and what the character cares about.",
      field_appearanceAndSensory: "Appearance & senses",
      hint_appearanceAndSensory: "Hair, eyes, scent, temperature — anchors for description.",
      field_actionPresets: "Signature beats",
      hint_actionPresets: "Fixed body language for shy, happy and crisis moments.",
      field_speechStyle: "Voice & bans",
      hint_speechStyle: "Pace, favourite particles, sentence shapes to avoid.",
      field_dialogueExamples: "Dialogue samples",
      hint_dialogueExamples: "Calibration samples, usually four to eight.",
      field_statusFooterTemplate: "Status footer template",
      hint_statusFooterTemplate: "In RP every reply must end with this structure.",
      newCharacterName: "New character",
      newSceneDefault: "Unspecified scene",
      copySuffix: " copy",

      triggers: "Trigger map",
      triggersHint: "A keyword hit merges its text into this turn; a character-bound entry only applies to that character.",
      addTrigger: "Add trigger",
      filterTriggers: "Filter",
      filterAll: "All entries",
      filterGlobal: "Global only",
      triggerEnabled: "Enabled",
      triggerNote: "Note",
      triggerCharacter: "Bound character",
      triggerCharacterGlobal: "Global (all characters)",
      triggerKeywords: "Keywords (comma or regex)",
      triggerKeywordsHint: "Comma separates keywords; surround with slashes to match as regex.",
      triggerInject: "Injected text",
      triggerPriority: "Priority",
      removeTrigger: "Delete this entry",
      emptyTriggers: "No triggers yet — use the button above to add one.",
      triggersCount: "{count} entries ({enabled} enabled)",

      presets: "Presets & debug probe",
      presetsHint: "Presets round-trip as JSON; the preview shows the live {{tlrp_character}} and {{tlrp_directive}} content for the current mode.",
      exportJson: "Export JSON",
      exportHint: "Exports every character and trigger; save it or move it to another deployment.",
      download: "Download .json",
      importJson: "Import characters / triggers",
      importHint: "Paste JSON of the same shape: top level may carry characters and triggers; same id overwrites, the rest appends.",
      importApply: "Import",
      importFailed: "JSON parse failed or the shape is wrong.",
      importDone: "Imported {characters} character(s) and {triggers} trigger(s).",
      preview: "Preview composed prompt",
      previewHint: "Left is the assembled {{tlrp_character}} (same field order as the host); right lists the active {{tlrp_directive}} rules.",
      previewCharacter: "{{tlrp_character}}",
      previewDirective: "{{tlrp_directive}}",
      previewLocalNote: "This preview assembles fields in the browser; the host also appends the live turn-context block.",
      rpRules: "RP rules: first person, always *italic action and sensory beats*, no bullet lists, status footer at the end; the identity lock outranks ops framing.",
      workRules: "WORK rules: conclusion first, then evidence, then next step; no italic action, no status footer; risky operations are laid out and confirmed first.",
      offRules: "Master switch is off: no character sheet and no directive are injected.",
      currentMode: "Effective",
      userTitle: "Address as",
      hitTriggers: "Matched entries",
    };

    /* ────────────────────────── 样式 ────────────────────────── */

    /** 只用宿主的设计令牌，缺令牌时退回中性值。 */
    const CSS = `
.tlrp-root { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 8px; }
.tlrp-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-text-primary, #e8eaf0); margin: 0; }
.tlrp-desc { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-text-secondary, #9aa3b2); margin: 4px 0 0; }
.tlrp-section { border: 1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.09)); border-radius: 10px; padding: 14px 16px 16px; background: var(--dsw-alias-bg-raised, rgba(255,255,255,.025)); display: flex; flex-direction: column; gap: 12px; }
.tlrp-section-head { display: flex; flex-direction: column; gap: 3px; }
.tlrp-section-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-text-primary, #e8eaf0); }
.tlrp-section-hint { font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-text-secondary, #9aa3b2); }
.tlrp-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.tlrp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.tlrp-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.tlrp-field-label { font-size: 12px; color: var(--dsw-alias-text-primary, #e8eaf0); font-weight: 500; }
.tlrp-field-hint { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-text-secondary, #9aa3b2); }
.tlrp-input, .tlrp-textarea, .tlrp-select {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; line-height: 1.55;
  color: var(--dsw-alias-text-primary, #e8eaf0);
  background: var(--dsw-alias-bg-sunken, rgba(0,0,0,.22));
  border: 1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.12));
  border-radius: 7px; padding: 7px 9px; outline: none;
}
.tlrp-textarea { resize: vertical; min-height: 38px; font-family: inherit; }
.tlrp-input:focus, .tlrp-textarea:focus, .tlrp-select:focus { border-color: var(--dsw-alias-border-accent, #66e0c2); }
.tlrp-input:disabled, .tlrp-textarea:disabled, .tlrp-select:disabled { opacity: .55; }
.tlrp-btn {
  font: inherit; font-size: 12px; line-height: 1; padding: 7px 11px; border-radius: 7px; cursor: pointer;
  color: var(--dsw-alias-text-primary, #e8eaf0);
  background: var(--dsw-alias-bg-raised, rgba(255,255,255,.06));
  border: 1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14));
}
.tlrp-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-accent, #66e0c2); }
.tlrp-btn:disabled { opacity: .5; cursor: not-allowed; }
.tlrp-btn[data-active="true"] { background: var(--dsw-alias-bg-accent, rgba(102,224,194,.16)); border-color: var(--dsw-alias-border-accent, #66e0c2); }
.tlrp-btn[data-danger="true"]:hover:not(:disabled) { border-color: #e2686f; color: #e2686f; }
.tlrp-chip { font-size: 11.5px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14)); color: var(--dsw-alias-text-secondary, #9aa3b2); }
.tlrp-chip b { color: var(--dsw-alias-text-primary, #e8eaf0); font-weight: 600; }
.tlrp-switch { display: flex; gap: 8px; align-items: flex-start; }
.tlrp-switch input { margin-top: 2px; accent-color: var(--dsw-alias-border-accent, #66e0c2); }
.tlrp-card { border: 1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.1)); border-radius: 9px; padding: 12px; display: flex; flex-direction: column; gap: 10px; background: var(--dsw-alias-bg-sunken, rgba(0,0,0,.16)); }
.tlrp-card-head { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.tlrp-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
.tlrp-details { border: 1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.1)); border-radius: 9px; padding: 10px 12px; }
.tlrp-details > summary { cursor: pointer; font-size: 12.5px; font-weight: 500; }
.tlrp-preview { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 10px; }
.tlrp-note { font-size: 11px; color: var(--dsw-alias-text-secondary, #9aa3b2); }
.tlrp-warn { font-size: 11.5px; color: #e2a86b; }
`;

    /** 注入一次样式；早期文档没有 head 时静默跳过，绝不连累模块求值。 */
    function injectCss() {
      try {
        if (typeof document === "undefined") return;
        if (document.querySelector('style[data-plugin-css="dsh-plugin-tlrp"]')) return;
        const style = document.createElement("style");
        style.setAttribute("data-plugin-css", "dsh-plugin-tlrp");
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
      } catch {
        /* 无 DOM 环境下不注入样式 */
      }
    }

    /* ─────────────────────── 基础控件 ─────────────────────── */

    /** 一行标题 + 说明的分区容器。 */
    function Section(props) {
      return h(
        "section",
        { className: "tlrp-section" },
        h(
          "div",
          { className: "tlrp-section-head" },
          h("div", { className: "tlrp-section-title" }, props.title),
          props.hint ? h("div", { className: "tlrp-section-hint" }, props.hint) : null
        ),
        props.children
      );
    }

    /** 字段容器：标签 + 控件 + 提示。 */
    function Field(props) {
      return h(
        "label",
        { className: "tlrp-field" },
        h("span", { className: "tlrp-field-label" }, props.label),
        props.children,
        props.hint ? h("span", { className: "tlrp-field-hint" }, props.hint) : null
      );
    }

    /** 单行输入。 */
    function TextInput(props) {
      return h("input", {
        className: "tlrp-input",
        type: "text",
        value: props.value ?? "",
        placeholder: props.placeholder ?? "",
        disabled: props.disabled === true,
        onChange: (event) => props.onChange(event.target.value),
      });
    }

    /** 多行输入。 */
    function TextArea(props) {
      return h("textarea", {
        className: "tlrp-textarea",
        rows: props.rows ?? 3,
        value: props.value ?? "",
        placeholder: props.placeholder ?? "",
        disabled: props.disabled === true,
        spellCheck: false,
        onChange: (event) => props.onChange(event.target.value),
      });
    }

    /** 下拉选择。 */
    function Select(props) {
      return h(
        "select",
        {
          className: "tlrp-select",
          value: props.value ?? "",
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.value),
        },
        props.options.map((option) =>
          h("option", { key: option.value, value: option.value }, option.label)
        )
      );
    }

    /** 开关（原生 checkbox + 说明）。 */
    function Toggle(props) {
      return h(
        "label",
        { className: "tlrp-switch" },
        h("input", {
          type: "checkbox",
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h(
          "span",
          null,
          h("span", { className: "tlrp-field-label" }, props.label),
          props.hint ? h("span", { className: "tlrp-field-hint", style: { display: "block" } }, props.hint) : null
        )
      );
    }

    /** 按钮。 */
    function Button(props) {
      return h(
        "button",
        {
          type: "button",
          className: "tlrp-btn",
          disabled: props.disabled === true,
          "data-active": props.active === true ? "true" : "false",
          "data-danger": props.danger === true ? "true" : undefined,
          onClick: props.onClick,
        },
        props.children
      );
    }

    /* ──────────────────── 预览：与宿主同序拼装 ──────────────────── */

    /**
     * 按宿主 renderCharacterBlock 的字段顺序拼出 {{tlrp_character}} 文本。
     * 只用于调试预览；真正的注入仍由宿主渲染。
     * @param character - 角色对象。
     * @param scene - 当前情景。
     * @param footerLabel - 状态面板标题。
     * @returns 拼装后的设定块文本。
     */
    function assembleCharacterBlock(character, scene, footerLabel) {
      const char = character && typeof character === "object" ? character : EMPTY_CHARACTER;
      const lines = [
        `## 角色设定（当前激活：${char.name || char.id || ""}）`,
        `- 角色 ID：${char.id || ""}`,
        `- 称呼对方的专属称谓：${char.userTitle || "对方"}`,
        `- 当前所处情景：${scene || char.defaultScene || "未指定"}`,
        "",
        "### 绝对身份锁（不可违反）",
        char.identityLock || "",
      ];
      if (char.corePersona) lines.push("", "### 角色核心背景与性格（经历与反差）", char.corePersona);
      if (char.appearanceAndSensory) lines.push("", "### 外貌与感官细节（描写锚点）", char.appearanceAndSensory);
      if (char.actionPresets) lines.push("", "### 招牌微动作与情节预设库", char.actionPresets);
      if (char.speechStyle) lines.push("", "### 语言风格与禁用项", char.speechStyle);
      if (char.dialogueExamples) lines.push("", "### 台词与互动范例（语气锚点，不要照抄）", char.dialogueExamples);
      if (char.statusFooterTemplate) {
        lines.push("", "### 底部状态同步面板模板", "必须按下面的结构逐项填写，字段名与顺序不可改：", char.statusFooterTemplate);
      }
      return lines.join("\n");
    }

    /** 关键词与注入文本之间的人读分隔。 */
    const KEYWORD_SPLIT = /[,，、|]/;

    /** 把触发器上的关键词数组渲染成编辑用文本。 */
    function keywordsToText(keywords) {
      return Array.isArray(keywords) ? keywords.join(", ") : "";
    }

    /** 把编辑用文本拆回关键词数组。 */
    function textToKeywords(text) {
      return String(text ?? "")
        .split(KEYWORD_SPLIT)
        .map((word) => word.trim())
        .filter(Boolean);
    }

    /** 为每次新建动作生成一个稳定 id 片段。 */
    function mintId() {
      const stamp = Date.now().toString(36);
      const salt = Math.random().toString(36).slice(2, 6);
      return `${stamp}${salt}`;
    }

    /** 比较两次数组是否同构（用于决定是否把本地草稿让位给宿主快照）。 */
    function sameJson(a, b) {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch {
        return false;
      }
    }

    /** 带尾部防抖的提交器：连续编辑只写一次配置。 */
    function useCommitter(commit, delay) {
      const timer = useRef(null);
      const pending = useRef(null);
      useEffect(
        () => () => {
          if (timer.current) clearTimeout(timer.current);
        },
        []
      );
      return useCallback(
        (value) => {
          pending.current = value;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            timer.current = null;
            const next = pending.current;
            pending.current = null;
            commit(next);
          }, delay);
        },
        [commit, delay]
      );
    }

    /* ──────────────────────── 工作室主体 ──────────────────────── */

    /**
     * 四分区工作室。
     * @param props - 渲染器注入：useTlrp 快照钩子 + set/unset 写入器 + t 字典。
     */
    function TlrpStudio(props) {
      const t = props.t;
      const snapshot = (typeof props.useTlrp === "function" ? props.useTlrp((state) => state) : null) || {};
      const value = snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};
      const writable = snapshot.writable === true;
      const ready = snapshot.status === "ready";

      /** 写入一项配置；控制器自己负责与宿主对账。 */
      const write = useCallback(
        (field, next) => {
          try {
            props.set(field, next);
          } catch (error) {
            ctxLog(error);
          }
        },
        [props]
      );

      const characters = Array.isArray(value.characters) ? value.characters : [];
      const triggers = Array.isArray(value.triggers) ? value.triggers : [];
      const activeId = typeof value.activeCharacterId === "string" && value.activeCharacterId
        ? value.activeCharacterId
        : characters[0]?.id ?? "";
      const activeCharacter = useMemo(
        () => characters.find((entry) => entry?.id === activeId) ?? characters[0] ?? EMPTY_CHARACTER,
        [characters, activeId]
      );
      const modes = useMemo(() => normalizeModeList(value.modes), [value.modes]);
      const rawMode = typeof value.mode === "string" ? value.mode.trim() : "";
      const mode = rawMode && rawMode !== "auto" && modes.some((entry) => entry.id === rawMode) ? rawMode : "auto";
      const modeById = useMemo(() => new Map(modes.map((entry) => [entry.id, entry])), [modes]);
      const activeMode = modeById.get(mode) ?? null;
      const scene = typeof value.customSceneOverride === "string" ? value.customSceneOverride : "";

      /* ── 角色表单草稿：切换角色时同步，编辑中不随快照抖动 ── */
      const [draft, setDraft] = useState(() => ({ ...EMPTY_CHARACTER, ...activeCharacter }));
      const [draftFor, setDraftFor] = useState(activeId);
      const [dirty, setDirty] = useState(false);
      useEffect(() => {
        if (draftFor === activeId) return;
        setDraft({ ...EMPTY_CHARACTER, ...activeCharacter });
        setDraftFor(activeId);
        setDirty(false);
      }, [activeId, activeCharacter, draftFor]);

      const patchDraft = (key, next) => {
        setDraft((previous) => ({ ...previous, [key]: next }));
        setDirty(true);
      };

      const saveCharacter = () => {
        const nextId = String(draft.id ?? "").trim() || activeId || `character-${mintId()}`;
        const merged = { ...activeCharacter, ...draft, id: nextId };
        const list = characters.length === 0
          ? [merged]
          : characters.map((entry) => (entry?.id === activeId ? merged : entry));
        write("characters", list);
        if (nextId !== activeId) {
          write("activeCharacterId", nextId);
          if (triggers.some((entry) => entry?.characterId === activeId)) {
            write("triggers", triggers.map((entry) => (entry?.characterId === activeId ? { ...entry, characterId: nextId } : entry)));
          }
        }
        setDraft(merged);
        setDraftFor(nextId);
        setDirty(false);
      };

      const createCharacter = () => {
        const id = `character-${mintId()}`;
        const created = {
          ...EMPTY_CHARACTER,
          id,
          name: t("newCharacterName"),
          defaultScene: t("newSceneDefault"),
        };
        write("characters", [...characters, created]);
        write("activeCharacterId", id);
        setDraft(created);
        setDraftFor(id);
        setDirty(false);
      };

      const duplicateCharacter = () => {
        const id = `${activeId || "character"}-copy-${mintId()}`;
        const copy = { ...EMPTY_CHARACTER, ...activeCharacter, id, name: `${activeCharacter?.name || activeId}${t("copySuffix")}` };
        write("characters", [...characters, copy]);
        write("activeCharacterId", id);
        setDraft(copy);
        setDraftFor(id);
        setDirty(false);
      };

      const removeCharacter = () => {
        if (characters.length <= 1) {
          setNotice(t("cannotRemoveLast"));
          return;
        }
        const list = characters.filter((entry) => entry?.id !== activeId);
        const nextId = list[0]?.id ?? "";
        write("characters", list);
        write("activeCharacterId", nextId);
        setDraft({ ...EMPTY_CHARACTER, ...(list[0] ?? EMPTY_CHARACTER) });
        setDraftFor(nextId);
        setDirty(false);
      };

      /* ── 触发器：本地即时回显 + 防抖落库 ── */
      const [localTriggers, setLocalTriggers] = useState(triggers);
      const triggersDirty = useRef(false);
      useEffect(() => {
        if (!triggersDirty.current) setLocalTriggers(triggers);
      }, [triggers]);
      const commitTriggers = useCommitter(
        useCallback(
          (next) => {
            triggersDirty.current = false;
            write("triggers", next);
          },
          [write]
        ),
        600
      );
      const editTriggers = (next) => {
        triggersDirty.current = true;
        setLocalTriggers(next);
        commitTriggers(next);
      };
      const patchTrigger = (id, patch) => {
        editTriggers(localTriggers.map((entry) => (entry?.id === id ? { ...entry, ...patch } : entry)));
      };
      const addTrigger = () => {
        const created = { ...EMPTY_TRIGGER, id: `trigger-${mintId()}`, keywords: [] };
        editTriggers([...localTriggers, created]);
        setTriggerFilter("all");
      };
      const removeTrigger = (id) => {
        editTriggers(localTriggers.filter((entry) => entry?.id !== id));
      };

      /* ── 触发词筛选：'all' | 'global' | 角色 id ── */
      const [triggerFilter, setTriggerFilter] = useState("all");
      const visibleTriggers = localTriggers.filter((entry) => {
        if (triggerFilter === "all") return true;
        if (triggerFilter === "global") return !entry?.characterId;
        return entry?.characterId === triggerFilter;
      });
      const characterOptions = characters.map((entry) => ({
        value: entry?.id ?? "",
        label: `${entry?.name || entry?.id || t("unknownCharacter")}（${entry?.id ?? ""}）`,
      }));

      /* ── 形态矩阵：下拉选项与表单草稿 ── */
      const modeOptions = modes.map((entry) => ({
        value: entry.id,
        label: `${entry.name || entry.id}（${entry.id}）${entry.isDefaultFallback ? ` · ${t("fallbackBadge")}` : ""}`,
      }));
      const bindCharacterOptions = [{ value: "", label: t("modeBindKeep") }, ...characterOptions];

      const [modeEditId, setModeEditId] = useState("");
      const editingMode = modeById.get(modeEditId) ?? modes[0] ?? null;
      const [modeDraft, setModeDraft] = useState(() => normalizeModeEntry(EMPTY_MODE, 0));
      const [modeDraftFor, setModeDraftFor] = useState("");
      const [modeDirty, setModeDirty] = useState(false);
      useEffect(() => {
        const target = editingMode;
        if (!target || modeDraftFor === target.id) return;
        setModeDraft(target);
        setModeDraftFor(target.id);
        setModeDirty(false);
      }, [editingMode, modeDraftFor]);

      const patchMode = (key, next) => {
        setModeDraft((previous) => ({ ...previous, [key]: next }));
        setModeDirty(true);
      };

      /** 把改动后的形态列表写回配置，并保证恰好有一个 Auto 兜底形态。 */
      const commitModes = (list, focusId) => {
        const normalized = normalizeModeList(list);
        if (normalized.length > 0 && !normalized.some((entry) => entry.isDefaultFallback)) {
          normalized[0] = { ...normalized[0], isDefaultFallback: true };
        }
        write("modes", normalized);
        const focus = normalized.find((entry) => entry.id === focusId) ?? normalized[0] ?? null;
        setModeDraft(focus ?? normalizeModeEntry(EMPTY_MODE, 0));
        setModeDraftFor(focus?.id ?? "");
        setModeDirty(false);
        return normalized;
      };

      const saveMode = () => {
        const currentId = editingMode?.id ?? "";
        const nextId = String(modeDraft.id ?? "").trim().replace(/\s+/g, "-") || `mode-${mintId()}`;
        if (!MODE_ID_RE.test(nextId)) {
          setNotice(t("modeIdInvalid"));
          return;
        }
        if (modes.some((entry) => entry.id === nextId && entry.id !== currentId)) {
          setNotice(t("modeIdTaken"));
          return;
        }
        const merged = normalizeModeEntry({ ...(editingMode ?? {}), ...modeDraft, id: nextId }, 0);
        const list = modes.length === 0
          ? [merged]
          : modes.map((entry) => (entry.id === currentId ? merged : entry));
        const normalized = commitModes(list, nextId);
        // 形态改名后，若原本锁在它上面，跟着把锁定值搬过去
        if (mode === currentId && nextId !== currentId) write("mode", nextId);
        if (normalized.length === 0) setModeEditId("");
        else setModeEditId(nextId);
      };

      const createMode = () => {
        const id = `mode-${mintId()}`;
        const created = normalizeModeEntry(
          { ...EMPTY_MODE, id, name: t("newModeName"), commandAliases: [] },
          0
        );
        commitModes([...modes, created], id);
        setModeEditId(id);
      };

      const duplicateMode = () => {
        const source = editingMode ?? normalizeModeEntry(EMPTY_MODE, 0);
        const id = `${source.id || "mode"}-copy-${mintId()}`;
        const copy = normalizeModeEntry(
          { ...source, id, name: `${source.name || source.id}${t("copySuffix")}`, isDefaultFallback: false },
          0
        );
        commitModes([...modes, copy], id);
        setModeEditId(id);
      };

      const removeMode = () => {
        if (!editingMode) return;
        if (modes.length <= 1) {
          setNotice(t("cannotRemoveLastMode"));
          return;
        }
        const list = modes.filter((entry) => entry.id !== editingMode.id);
        const normalized = commitModes(list, list[0]?.id ?? "");
        if (mode === editingMode.id) write("mode", "auto");
        setModeEditId(normalized[0]?.id ?? "");
      };

      const setAsFallbackMode = () => {
        if (!editingMode) return;
        commitModes(
          modes.map((entry) => ({ ...entry, isDefaultFallback: entry.id === editingMode.id })),
          editingMode.id
        );
        setModeEditId(editingMode.id);
      };

      /* ── 运行模式与路由规则的本地草稿 ── */
      const keywordsText = useMemo(() => {
        const raw = value.workModeKeywords;
        if (Array.isArray(raw)) return raw.join("\n");
        return typeof raw === "string" ? raw.split(/[\n,，、|]/).map((word) => word.trim()).filter(Boolean).join("\n") : "";
      }, [value.workModeKeywords]);
      const [keywordsDraft, setKeywordsDraft] = useState(keywordsText);
      useEffect(() => setKeywordsDraft(keywordsText), [keywordsText]);
      const [sceneDraft, setSceneDraft] = useState(scene);
      useEffect(() => setSceneDraft(scene), [scene]);

      /* ── 导入导出 ── */
      const exportJson = useMemo(
        () => JSON.stringify({ characters, triggers: localTriggers }, null, 2),
        [characters, localTriggers]
      );
      const [importText, setImportText] = useState("");
      const [notice, setNotice] = useState("");

      const applyImport = () => {
        let parsed;
        try {
          parsed = JSON.parse(importText);
        } catch {
          setNotice(t("importFailed"));
          return;
        }
        const incomingCharacters = Array.isArray(parsed?.characters)
          ? parsed.characters
          : parsed && typeof parsed === "object" && typeof parsed.id === "string"
            ? [parsed]
            : [];
        const incomingTriggers = Array.isArray(parsed?.triggers) ? parsed.triggers : [];
        if (incomingCharacters.length === 0 && incomingTriggers.length === 0) {
          setNotice(t("importFailed"));
          return;
        }
        if (incomingCharacters.length > 0) {
          const merged = [...characters];
          for (const entry of incomingCharacters) {
            const normalized = { ...EMPTY_CHARACTER, ...entry, id: String(entry?.id ?? "").trim() || `character-${mintId()}` };
            const at = merged.findIndex((existing) => existing?.id === normalized.id);
            if (at >= 0) merged[at] = normalized;
            else merged.push(normalized);
          }
          write("characters", merged);
        }
        if (incomingTriggers.length > 0) {
          const merged = [...localTriggers];
          for (const entry of incomingTriggers) {
            const normalized = {
              ...EMPTY_TRIGGER,
              ...entry,
              id: String(entry?.id ?? "").trim() || `trigger-${mintId()}`,
              keywords: Array.isArray(entry?.keywords) ? entry.keywords.map((word) => String(word)) : textToKeywords(entry?.keywords),
            };
            const at = merged.findIndex((existing) => existing?.id === normalized.id);
            if (at >= 0) merged[at] = normalized;
            else merged.push(normalized);
          }
          editTriggers(merged);
        }
        setNotice(t("importDone", { characters: incomingCharacters.length, triggers: incomingTriggers.length }));
      };

      const downloadJson = () => {
        try {
          const blob = new Blob([exportJson], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = "tlrp-presets.json";
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        } catch (error) {
          ctxLog(error);
        }
      };

      /* ── 预览 ── */
      const previewCharacter = assembleCharacterBlock(activeCharacter, scene || activeCharacter?.defaultScene || "", t("userTitle"));
      const previewMode = activeMode ?? modes.find((entry) => entry.isDefaultFallback === true) ?? modes[0] ?? null;
      const directiveLines = value.enabled === false
        ? [t("offRules")]
        : previewMode === null
          ? [t("unknownMode")]
          : [
              `${t("mode")}：${previewMode.name}（${previewMode.id}）`,
              `${t("modePolicyLabel")}：${toolPolicyLabel(t, previewMode.toolPolicy)}`,
              `${t("modeAliasesLabel")}：${aliasesToText(previewMode.commandAliases) || "—"}`,
              `${t("modePriorityLabel")}：${previewMode.autoPriority}`,
              previewMode.directivePrompt ? `${t("modeDirectiveLabel")}：${previewMode.directivePrompt}` : t("modeNoDirective"),
            ];

      if (!ready) {
        return h("div", { className: "tlrp-root" }, h("p", { className: "tlrp-desc" }, snapshot.status === "loading" ? t("loading") : t("unavailable")));
      }

      const disabled = writable !== true;

      return h(
        "div",
        { className: "tlrp-root" },
        h(
          "div",
          { className: "tlrp-row" },
          h("span", { className: "tlrp-chip" }, t("mode"), " ", h("b", null, mode === "auto" ? t("modeAuto") : activeMode?.name ?? mode)),
          h("span", { className: "tlrp-chip" }, t("character"), " ", h("b", null, activeCharacter?.name || activeCharacter?.id || t("unknownCharacter"))),
          h("span", { className: "tlrp-chip" }, t("userTitle"), " ", h("b", null, activeCharacter?.userTitle || "—")),
          h("span", { className: "tlrp-chip" }, t("triggersCount", { count: localTriggers.length, enabled: localTriggers.filter((entry) => entry?.enabled !== false).length }))
        ),
        disabled ? h("p", { className: "tlrp-warn" }, t("readOnly")) : null,
        notice ? h("p", { className: "tlrp-note" }, notice) : null,

        /* ── A：形态矩阵工作室 Mode Studio ── */
        h(
          Section,
          { title: t("modeSection"), hint: t("modeSectionHint") },
          /* 顶部全局切换栏：自动路由 + 配置里的每一个形态 */
          h(
            "div",
            { className: "tlrp-row" },
            h(Button, { active: mode === "auto", disabled, onClick: () => write("mode", "auto") }, t("modeAuto")),
            modes.length === 0
              ? h("span", { className: "tlrp-note" }, t("unknownMode"))
              : modes.map((entry) =>
                  h(
                    Button,
                    {
                      key: entry.id,
                      active: mode === entry.id,
                      disabled,
                      onClick: () => write("mode", entry.id),
                    },
                    entry.isDefaultFallback ? `${entry.name} · ${t("fallbackBadge")}` : entry.name
                  )
                )
          ),
          h(
            "div",
            { className: "tlrp-row" },
            h("span", { className: "tlrp-chip" }, t("mode"), " ", h("b", null, mode === "auto" ? t("modeAuto") : activeMode?.name ?? mode)),
            h("span", { className: "tlrp-chip" }, t("modePolicyLabel"), " ", h("b", null, toolPolicyLabel(t, activeMode?.toolPolicy))),
            h("span", { className: "tlrp-chip" }, t("modePriorityLabel"), " ", h("b", null, String(activeMode?.autoPriority ?? "—"))),
            h("span", { className: "tlrp-chip" }, t("modeAliasesLabel"), " ", h("b", null, aliasesToText(activeMode?.commandAliases) || "—"))
          ),
          h(
            "div",
            { className: "tlrp-grid" },
            h(Toggle, {
              label: t("enabled"),
              hint: t("enabledHint"),
              checked: value.enabled !== false,
              disabled,
              onChange: (next) => write("enabled", next),
            })
          ),
          /* 形态 CRUD：与角色工作室同构 */
          h(
            "div",
            { className: "tlrp-row" },
            h(
              "span",
              { style: { minWidth: 220, flex: "0 1 300px" } },
              h(Select, {
                value: editingMode?.id ?? "",
                disabled,
                options: modeOptions.length > 0 ? modeOptions : [{ value: "", label: t("unknownMode") }],
                onChange: (next) => setModeEditId(next),
              })
            ),
            h(Button, { disabled, onClick: createMode }, t("newMode")),
            h(Button, { disabled, onClick: duplicateMode }, t("duplicateMode")),
            h(Button, { disabled, danger: true, onClick: removeMode }, t("removeMode")),
            h(
              Button,
              {
                disabled: disabled || editingMode?.isDefaultFallback === true,
                title: t("setFallback"),
                onClick: setAsFallbackMode,
              },
              t("setFallback")
            ),
            h(Button, { disabled: disabled || !modeDirty, onClick: saveMode }, t("saveMode"))
          ),
          modeDirty ? h("p", { className: "tlrp-note" }, t("modeUnsavedHint")) : null,
          h(
            "div",
            { className: "tlrp-grid" },
            h(
              Field,
              { label: t("field_mode_id"), hint: t("hint_mode_id") },
              h(TextInput, { value: modeDraft.id, disabled, onChange: (next) => patchMode("id", next) })
            ),
            h(
              Field,
              { label: t("field_mode_name"), hint: t("hint_mode_name") },
              h(TextInput, { value: modeDraft.name, disabled, onChange: (next) => patchMode("name", next) })
            ),
            h(
              Field,
              { label: t("field_mode_commandAliases"), hint: t("hint_mode_commandAliases") },
              h(TextInput, {
                value: aliasesToText(modeDraft.commandAliases),
                disabled,
                onChange: (next) => patchMode("commandAliases", textToAliases(next)),
              })
            ),
            h(
              Field,
              { label: t("field_mode_autoPriority"), hint: t("hint_mode_autoPriority") },
              h(TextInput, {
                value: String(modeDraft.autoPriority ?? ""),
                disabled,
                onChange: (next) => {
                  const parsed = Number(next);
                  patchMode("autoPriority", Number.isFinite(parsed) ? parsed : 0);
                },
              })
            ),
            h(
              Field,
              { label: t("field_mode_toolPolicy"), hint: t("hint_mode_toolPolicy") },
              h(Select, {
                value: modeDraft.toolPolicy,
                disabled,
                options: TOOL_POLICY_OPTIONS.map((policy) => ({ value: policy, label: toolPolicyLabel(t, policy) })),
                onChange: (next) => patchMode("toolPolicy", next),
              })
            ),
            h(
              Field,
              { label: t("field_mode_allowedTools"), hint: t("hint_mode_allowedTools") },
              h(TextInput, { value: modeDraft.allowedTools, disabled, onChange: (next) => patchMode("allowedTools", next) })
            ),
            h(
              Field,
              { label: t("field_mode_bindCharacterId"), hint: t("hint_mode_bindCharacterId") },
              h(Select, {
                value: modeDraft.bindCharacterId,
                disabled,
                options: bindCharacterOptions,
                onChange: (next) => patchMode("bindCharacterId", next),
              })
            )
          ),
          h(
            "div",
            { className: "tlrp-grid" },
            h(Toggle, {
              label: t("field_mode_injectCharacterPersona"),
              hint: t("hint_mode_injectCharacterPersona"),
              checked: modeDraft.injectCharacterPersona !== false,
              disabled,
              onChange: (next) => patchMode("injectCharacterPersona", next),
            }),
            h(Toggle, {
              label: t("field_mode_enableStatusFooter"),
              hint: t("hint_mode_enableStatusFooter"),
              checked: modeDraft.enableStatusFooter !== false,
              disabled,
              onChange: (next) => patchMode("enableStatusFooter", next),
            })
          ),
          h(
            Field,
            { label: t("field_mode_autoKeywords"), hint: t("hint_mode_autoKeywords") },
            h(TextArea, { rows: 3, value: modeDraft.autoKeywords, disabled, onChange: (next) => patchMode("autoKeywords", next) })
          ),
          h(
            Field,
            { label: t("field_mode_directivePrompt"), hint: t("hint_mode_directivePrompt") },
            h(TextArea, { rows: 10, value: modeDraft.directivePrompt, disabled, onChange: (next) => patchMode("directivePrompt", next) })
          ),
          h(
            Field,
            { label: t("field_mode_statusFooterOverride"), hint: t("hint_mode_statusFooterOverride") },
            h(TextArea, { rows: 5, value: modeDraft.statusFooterOverride, disabled, onChange: (next) => patchMode("statusFooterOverride", next) })
          ),
          h(
            "div",
            { className: "tlrp-grid" },
            h(
              Field,
              { label: t("workKeywords"), hint: t("workKeywordsHint") },
              h(TextArea, {
                rows: 4,
                value: keywordsDraft,
                disabled,
                onChange: (next) => {
                  setKeywordsDraft(next);
                  write("workModeKeywords", next.split("\n").map((line) => line.trim()).filter(Boolean));
                },
              })
            ),
            h(
              Field,
              { label: t("rpAllowed"), hint: t("rpAllowedHint") },
              h(TextInput, {
                value: typeof value.rpAllowedTools === "string" ? value.rpAllowedTools : "",
                disabled,
                onChange: (next) => write("rpAllowedTools", next),
              })
            )
          ),
          h(
            Field,
            { label: t("scene"), hint: t("sceneHint") },
            h(
              "div",
              { className: "tlrp-row" },
              h(TextInput, {
                value: sceneDraft,
                placeholder: t("scenePlaceholder"),
                disabled,
                onChange: setSceneDraft,
              }),
              h(Button, { disabled, onClick: () => write("customSceneOverride", sceneDraft) }, t("apply")),
              h(Button, { disabled, onClick: () => { setSceneDraft(""); write("customSceneOverride", ""); } }, t("clear"))
            )
          )
        ),

        /* ── B：角色工作室 ── */
        h(
          Section,
          { title: t("studio"), hint: t("studioHint") },
          h(
            "div",
            { className: "tlrp-row" },
            h(
              "span",
              { style: { minWidth: 220, flex: "0 1 300px" } },
              h(Select, {
                value: activeId,
                disabled,
                options: characterOptions.length > 0 ? characterOptions : [{ value: "", label: t("unknownCharacter") }],
                onChange: (next) => write("activeCharacterId", next),
              })
            ),
            h(Button, { disabled, onClick: createCharacter }, t("newCharacter")),
            h(Button, { disabled, onClick: duplicateCharacter }, t("duplicateCharacter")),
            h(Button, { disabled, danger: true, onClick: removeCharacter }, t("removeCharacter")),
            h(Button, { disabled, active: dirty, onClick: saveCharacter }, t("saveCharacter"))
          ),
          dirty ? h("p", { className: "tlrp-note" }, t("unsavedHint")) : null,
          h(
            "div",
            { className: "tlrp-grid" },
            CHAR_FIELDS.map((field) =>
              h(
                Field,
                { key: field.key, label: t(`field_${field.key}`), hint: t(`hint_${field.key}`) },
                field.area
                  ? h(TextArea, {
                      rows: field.rows,
                      value: draft[field.key] ?? "",
                      disabled,
                      onChange: (next) => patchDraft(field.key, next),
                    })
                  : h(TextInput, {
                      value: draft[field.key] ?? "",
                      disabled,
                      onChange: (next) => patchDraft(field.key, next),
                    })
              )
            )
          )
        ),

        /* ── C：触发词映射表 ── */
        h(
          Section,
          { title: t("triggers"), hint: t("triggersHint") },
          h(
            "div",
            { className: "tlrp-row" },
            h(Button, { disabled, onClick: addTrigger }, t("addTrigger")),
            h(
              "span",
              { style: { minWidth: 200 } },
              h(Select, {
                value: triggerFilter,
                disabled,
                options: [
                  { value: "all", label: `${t("filterAll")}（${localTriggers.length}）` },
                  { value: "global", label: t("filterGlobal") },
                  ...characterOptions.map((option) => ({ value: option.value, label: option.label })),
                ],
                onChange: setTriggerFilter,
              })
            )
          ),
          visibleTriggers.length === 0
            ? h("p", { className: "tlrp-note" }, t("emptyTriggers"))
            : visibleTriggers.map((entry) =>
                h(
                  "div",
                  { className: "tlrp-card", key: entry?.id ?? mintId() },
                  h(
                    "div",
                    { className: "tlrp-card-head" },
                    h(Toggle, {
                      label: t("triggerEnabled"),
                      checked: entry?.enabled !== false,
                      disabled,
                      onChange: (next) => patchTrigger(entry.id, { enabled: next }),
                    }),
                    h(
                      "span",
                      { style: { minWidth: 160, flex: "0 1 220px" } },
                      h(TextInput, {
                        value: entry?.characterId ?? "",
                        placeholder: t("triggerCharacterGlobal"),
                        disabled,
                        onChange: (next) => patchTrigger(entry.id, { characterId: next.trim() }),
                      })
                    ),
                    h(Button, { danger: true, disabled, onClick: () => removeTrigger(entry.id) }, t("removeTrigger"))
                  ),
                  h(
                    Field,
                    { label: t("triggerKeywords"), hint: t("triggerKeywordsHint") },
                    h(TextInput, {
                      value: keywordsToText(entry?.keywords),
                      disabled,
                      onChange: (next) => patchTrigger(entry.id, { keywords: textToKeywords(next) }),
                    })
                  ),
                  h(
                    Field,
                    { label: t("triggerInject") },
                    h(TextArea, {
                      rows: 4,
                      value: entry?.injectText ?? "",
                      disabled,
                      onChange: (next) => patchTrigger(entry.id, { injectText: next }),
                    })
                  ),
                  h(
                    "div",
                    { className: "tlrp-row" },
                    h(
                      "span",
                      { style: { width: 120 } },
                      h(Field, { label: t("triggerPriority") }, h(TextInput, {
                        value: String(entry?.priority ?? 50),
                        disabled,
                        onChange: (next) => {
                          const parsed = Number(next);
                          patchTrigger(entry.id, { priority: Number.isFinite(parsed) ? parsed : 0 });
                        },
                      }))
                    ),
                    h("span", { className: "tlrp-chip" }, entry?.id ?? "")
                  )
                )
              )
        ),

        /* ── D：预设导入导出与调试探针 ── */
        h(
          Section,
          { title: t("presets"), hint: t("presetsHint") },
          h(
            "div",
            { className: "tlrp-grid" },
            h(
              Field,
              { label: t("exportJson"), hint: t("exportHint") },
              h(TextArea, { rows: 6, value: exportJson, disabled: true, onChange: () => {} }),
              h(Button, { disabled, onClick: downloadJson }, t("download"))
            ),
            h(
              Field,
              { label: t("importJson"), hint: t("importHint") },
              h(TextArea, { rows: 6, value: importText, disabled, onChange: setImportText }),
              h(Button, { disabled, onClick: applyImport }, t("importApply"))
            )
          ),
          h(
            "details",
            { className: "tlrp-details" },
            h("summary", null, t("preview")),
            h("p", { className: "tlrp-note" }, t("previewHint")),
            h(
              "div",
              { className: "tlrp-preview" },
              h(
                "div",
                null,
                h("div", { className: "tlrp-field-label" }, t("previewCharacter")),
                h("pre", { className: "tlrp-mono tlrp-card" }, previewCharacter)
              ),
              h(
                "div",
                null,
                h("div", { className: "tlrp-field-label" }, t("previewDirective")),
                h(
                  "pre",
                  { className: "tlrp-mono tlrp-card" },
                  [`## 形态指令（当前模式：${mode === "auto" ? "auto" : mode}）`, ...directiveLines].join("\n")
                )
              )
            ),
            h("p", { className: "tlrp-note" }, t("previewLocalNote"))
          )
        )
      );
    }

    /** 兜底日志：客户端上下文可能没有 logger。 */
    function ctxLog(error) {
      try {
        console.warn("[tlrp]", error);
      } catch {
        /* 忽略 */
      }
    }

    /* ─────────────────────── 卡片与栏目 ─────────────────────── */

    /** 插件页上的配置卡：summary 只给一行说明，page 给完整工作室。 */
    function TlrpSettingsCard(props) {
      if (props.view === "summary") return props.t("description");
      return h(TlrpStudio, props);
    }

    /** 设置侧边栏栏目：标题 + 说明 + 工作室。 */
    function TlrpSettingsSection(props) {
      return h(
        "div",
        null,
        h("h2", { className: "tlrp-title" }, props.t("title")),
        h("p", { className: "tlrp-desc" }, props.t("description")),
        h(TlrpStudio, props)
      );
    }

    /* ─────────────────────── 挂载 ─────────────────────── */

    /** 本插件消费的客户端服务。configForms 另行按可选子作用域探测。 */
    const inject = ["slots", "locale"];

    /**
     * 从宿主镜像的命名空间目录里挑出本插件的配置命名空间。
     * @param forms - configForms 服务。
     * @param served - whileServed 给出的已服出集合。
     * @returns 命名空间 id。
     */
    function pickNamespace(forms, served) {
      let listed = [];
      try {
        listed = forms.describe().getSnapshot().view?.namespaces ?? [];
      } catch {
        listed = [];
      }
      const names = listed
        .map((entry) => (typeof entry?.ns === "string" ? entry.ns : typeof entry?.nsId === "string" ? entry.nsId : undefined))
        .filter((ns) => typeof ns === "string");
      return (
        names.find((ns) => ns === ROW_ID) ??
        names.find((ns) => ns === `include:${ROW_ID}`) ??
        names.find((ns) => ns === BUNDLE_NAME) ??
        NAMESPACE_CANDIDATES.find((ns) => (served?.has ? served.has(ns) : true)) ??
        NAMESPACE_CANDIDATES[0]
      );
    }

    /**
     * 挂载客户端半边：字典、三处槽位注册。页面只在宿主确实服出 tlrp 命名空间时出现。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      injectCss();
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "tlrp: settings dictionaries");
      const t = ctx.locale.bind(NS);

      /**
       * 一旦宿主服出任一候选命名空间，就注册配置卡。
       * @param forms - configForms 服务。
       * @returns 注册函数，交给 whileServed。
       */
      function registerCard(forms) {
        return (served) => {
          const namespace = pickNamespace(forms, served);
          const controller = forms.get(namespace);
          const store = {
            getSnapshot: () => controller.getSnapshot(),
            subscribe: (listener) => controller.subscribe(listener),
          };
          const face = () => ({
            hooks: { tlrp: store },
            set: (field, next) => {
              Promise.resolve(controller.set(field, next)).catch((error) => ctxLog(error));
            },
            unset: (field) => {
              Promise.resolve(controller.unset(field)).catch((error) => ctxLog(error));
            },
          });
          // 插件页分两处渲染同一张卡：bundle 页（键 = 包名）与
          // bundle 声明的行配置页（键 = <包名>#<行 id>）。
          const cells = [
            { name: "plugins.bundle.config", key: BUNDLE_NAME },
            { name: "plugins.row.config", key: ROW_CONFIG_KEY },
          ];
          const offs = [];
          for (const cell of cells) {
            try {
              const off = ctx.slots.inject(cell.name, () =>
                ctx.slots.register(
                  {
                    name: cell.name,
                    key: cell.key,
                    priority: 30,
                    locale: NS,
                    inject: face,
                  },
                  TlrpSettingsCard
                )
              );
              if (typeof off === "function") offs.push(off);
            } catch (error) {
              ctxLog(error);
            }
          }
          // 设置侧边栏的独立栏目：插件页那两处槽位只长在「插件管理」里，
          // 想让用户点一下「设置」就能看见，必须自己占一个 settings.section。
          try {
            const off = ctx.slots.inject("settings.section", () =>
              ctx.slots.register(
                {
                  name: "settings.section",
                  id: SECTION_ID,
                  order: SECTION_ORDER,
                  label: () => t("sectionLabel"),
                  locale: NS,
                  inject: face,
                },
                TlrpSettingsSection
              )
            );
            if (typeof off === "function") offs.push(off);
          } catch (error) {
            ctxLog(error);
          }
          return () => offs.forEach((off) => off());
        };
      }

      // configForms 是可选服务：旧宿主没有它就不出配置卡，插件本体照常工作。
      let disposer = () => {};
      const bind = (forms) => {
        if (forms === undefined || forms === null || typeof forms.whileServed !== "function") return;
        disposer = forms.whileServed(NAMESPACE_CANDIDATES, registerCard(forms));
      };
      // cordis 的 inject(deps, callback) 会把 callback 当作子插件体调用，
      // 收到的是**子上下文**（ctx, config），服务挂在 ctx.<name> 上，
      // 不是一张服务表 —— 所以要从 inner.configForms 取。
      if (typeof ctx.inject === "function") {
        ctx.inject(["configForms"], (inner) => {
          bind(inner?.configForms);
        });
      } else {
        bind();
      }
      ctx.effect(() => () => {
        if (typeof disposer === "function") disposer();
      }, "tlrp: settings page");
    }

    exports.NS = NS;
    exports.NAMESPACE_CANDIDATES = NAMESPACE_CANDIDATES;
    exports.apply = apply;
    exports.inject = inject;
    exports.TlrpStudio = TlrpStudio;
    exports.TlrpSettingsCard = TlrpSettingsCard;
    exports.TlrpSettingsSection = TlrpSettingsSection;
    exports.assembleCharacterBlock = assembleCharacterBlock;
    exports.EMPTY_MODE = EMPTY_MODE;
    exports.TOOL_POLICY_OPTIONS = TOOL_POLICY_OPTIONS;
    exports.normalizeModeList = normalizeModeList;
    exports.normalizeModeEntry = normalizeModeEntry;
    exports.textToAliases = textToAliases;
    exports.aliasesToText = aliasesToText;
    exports.toolPolicyLabel = toolPolicyLabel;
    exports.ROW_CONFIG_KEY = ROW_CONFIG_KEY;
    exports.SECTION_ID = SECTION_ID;
    return module.exports;
  },
});
