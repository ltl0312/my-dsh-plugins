# dsh-plugin-tlrp

DSH 核心角色扮演与**多形态矩阵**插件：把「当前用哪种形态说话、能动哪些工具、要不要写状态面板」从人设文本里的死规则，变成可在设置面板里自由增删改的运行时形态（Mode）。

- 包名 `dsh-plugin-tlrp`，版本 `0.4.0`，零外部重型依赖
- 双入口：ESM `index.js` + CommonJS `index.cjs`，同一份实现源（`lib/core.cjs`）
- 六块能力：设置命名空间 / 形态矩阵（自定义形态 + 动态指令）/ 动态提示变量 / 每轮尾部深度注入 / 按形态的工具拦截 / 多角色与触发映射表

## 一、它解决什么问题

`@deepseek-ai/dsh-system-prompt` 在会话建立时就把 system prompt 组装结果写进会话历史（`system/message` 节点），后续轮次只在「能力支持 in-history 更新」时追加、否则改写头部。于是：

- 静态人设里写死的「现在几点」会过期；
- 老会话里切换模式、切换角色，人设文本不会跟着变；
- 「运维纪律 vs 人设」的优先级冲突只能靠模型自觉。

tlrp 把这三件事都挪到宿主层：

| 层 | 机制 | 生效时机 |
| --- | --- | --- |
| 变量层 | `ctx.systemPrompt.variable('tlrp_character' / 'tlrp_directive' / 'now' / 'cwd', provider)` | 每次 `assemble()`，即**每一步**重新求值 |
| 上下文尾部 | `ctx.systemPrompt.context({ name: 'tlrp:turn', text: fn })` | `assemble()` + 请求前 `refreshContext()` 再求值一次，落成一条 user-role 快照，位置在本轮用户输入之后 |
| 工具层 | `ctx.tools.guard(fn)`（同步单调闸门） | 每次工具调用前 |

所以**同一个老会话里** `/rp` ↔ `/work` 切换、`/char` 换人、时间更新、关键词触发映射，都是当轮立即生效，不依赖缓存失效或会话重建。

## 二、设置命名空间 `tlrp`

插件的 Cordis Config **就是**设置面板（`@deepseek-ai/dsh-settings` 只把 `.volatile()` 字段投影成表单，也只允许写 volatile 路径）。下表字段全部 `volatile()`：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关 |
| `mode` | `auto` \| `rp` \| `work` | `auto` | 全局运行模式 |
| `activeCharacterId` | string | `firefly` | 当前激活角色 |
| `workModeKeywords` | string \| string[] | `端口\|报错\|日志\|目录\|容器\|docker\|nginx\|ssh\|systemctl\|配置\|脚本\|代码\|bug\|pid\|进程\|编译\|权限\|路由` | auto 判 work 的关键词 |
| `blockShellToolsInRp` | boolean | `true` | RP 态物理拦截运维工具 |
| `enableStatusFooter` | boolean | `true` | RP 态强制底部状态面板 |
| `customSceneOverride` | string | `""` | 临时情景覆盖 |
| `characters` | array | 内置 `firefly` + `sam_tactical` | 多角色预设库 |
| `triggers` | array | 内置 5 组流萤触发映射 | 提示词触发映射表（动态世界书） |
| `styleLayerDefault` | `on` \| `dialog` \| `off` | `off` | 全局风格层档位（形态与 `/style` 可各自覆盖）：`on` 只加语气与表情/贴纸，`dialog` 再进一步砍掉动作、环境、外貌与旁白 |
| `styleEmojiHint` | string | 适度使用 emoji 的说明 | 风格层里的表情规则；留空＝本轮不用 emoji |
| `stickerDir` | string | `""` | 表情包目录；留空落 `~/.dsh/stickers/<角色id>/` |
| `galleryDir` | string | `""` | 图库目录；留空落 `~/.dsh/gallery/` |
| `maxStickersPerTurn` | number | `2` | 每轮最多贴几张图（`0`＝本轮禁止贴图） |

非面板字段（通过 `cordis.patch.yml` 调）：`timeZone`、`statusFooterLabel`、`registerNowVariable`、`coreSectionEnabled`、`coreSectionOrder`、`coreSectionText`、`contextOrder`、`maxTriggerInjections`、`blockedToolPatterns`、`allowedToolPatterns`、`activeProfileEntryId`。

### 写入通道

设置面板 / 远端设置接口的写操作就是：

```json
{ "op": "set", "path": ["mode"], "value": "rp" }
```

`ctx.settings.mutate(ns, ops)` 的 `ns` 是**被服务的命名空间**，不是包名，也不一定是配置里的行 id：宿主 loader 会把 bundle 行包进 include，所以本 bundle 实际被服务的 ns 是 `include:tlrp`（Inspect 的 Config 目录里 `id=include:tlrp` / `patchId=tlrp`）。插件自己按「`describe()` 里长得像 tlrp 的那一行 → 配置值 → `include:<配置值>`」的顺序解析后写入，所以 `/rp` `/work` `/char` `/scene` 改的值会落到 profile patch 里，重启后仍在；解析不到时退化为**会话级内存覆盖**，不报错、不中断对话。

> 注意：本部署（0.2.1-rc.5）的 Web 客户端只为官方插件的「配套页面包」渲染独立设置页；第三方插件的表单由宿主按 schema 服出（`configForms` 通道），没有配套页面包时客户端没有自动渲染入口。tlrp 因此同时提供：`settings.mutate` 通道、`/tlrp status` 指令、以及 `--dump-config` 可见的投影配置。

## 三、聊天指令

Web / CLI 走 `ctx.commands.register()`（拦截层，不产生模型消息）；ACP 等没有指令面的通道由 `agent/pre-step` 兜底解析同一套语法。

| 指令 | 作用 |
| --- | --- |
| `/mode <形态ID> [正文]` | 锁定到任意形态（`rp` `work` `sam` `sleep`，以及你在设置面板里自建的任一 id）；带正文时剥离指令前缀 |
| `/auto` | 回到自动语义分流（按各形态 `autoKeywords` + `autoPriority` 打分，全不命中落 Auto 兜底形态） |
| `/char <id>` | 切换激活角色（`/char` 不带参数会列出可用 id） |
| `/scene <描述>` | 覆盖当前情景；留空回到角色默认情景 |
| `/tlrp status`（或 `/status`） | 打印路由锁定、本轮形态、以及**全部已注册形态**的优先级 / 工具策略 / 别名 / 触发链 |
| `/style on` \| `dialog` \| `off` \| `default` \| `status` | 当轮覆盖风格层档位：`on` 只带语气＋表情/贴纸、`dialog` 对话体（只说出口的话，不写动作/环境/外貌/旁白）、`off` 关掉、`default` 交回「形态 → 全局」判定；不带参数等同 `status` |
| 形态别名（动态注册） | 每个形态 `commandAliases` 里以 `/` 开头的别名都会被注册成真指令：默认有 `/rp` `/work` `/sam` `/sleep`，你新建 `debug` 形态并给它 `/debug`，就立刻多一条 `/debug` |

首行标记等价于指令，但**只认已注册别名**：`【流萤】`/`【陪伴】` → `rp`、`【战术】` → `work`、`【萨姆】`/`【机甲】` → `sam`、`【医疗舱】` → `sleep`；你自己给 `debug` 形态写 `【排障】`，那 `【排障】` 就同样能切形态。

旧写法（`/rp` `/work`）在默认形态表下照旧可用，因为它们就是 `rp`/`work` 形态自带的别名。

## 三点五、风格层（只带语气，不演全套）

风格层是叠加在形态之上的**表演强度旋钮**：它不换人设、不改工具策略，只决定「这一轮要不要写旁白」。

四档，取值 `inherit` / `on` / `dialog` / `off`：

| 档位 | 注入内容 |
| --- | --- |
| `inherit` | 跟随下一级（形态跟全局、全局 `inherit` 视作 `off`） |
| `on` | 补语言风格（`speechStyle` + `dialogueExamples`）＋ emoji 规则 ＋ 本地表情包/图库清单；不复述人设，也不改形态原有的动作写法 |
| `dialog` | 在 `on` 之上追加「本轮的表演强度」：只输出角色说出口的话，禁止 `*斜体动作*`、环境天气、陈设外貌、心理独白串，除非人设明确要求否则不写状态面板 |
| `off` | 完全不注入风格块 |

判定优先级：**会话 `/style` 覆盖 > 形态自带 `styleLayer` > 全局 `styleLayerDefault`**。形态自带值在设置面板的形态表单里改，全局值在「风格层（轻量注入）」分区里改，两者都不用重启。

配合本地图库：把图片丢进 `~/.dsh/stickers/<角色id>/`（或自建目录并在 `stickerDir` 指定）与 `~/.dsh/gallery/`，标签＝文件名主干，插件只扫**顶层**文件（png/jpg/jpeg/webp/gif）。模型按 `![标签](绝对路径)` 的语法贴图，路径用正斜杠；客户端会把绝对路径改写成带鉴权的 `api/file` 地址，所以本地图能直接渲染。

## 四、提示变量

| 变量 | 取值 |
| --- | --- |
| `{{tlrp_character}}` | 当前角色的完整设定块：称呼、情景、身份锁、外貌感官、动作库、语言禁用项、状态面板模板 |
| `{{tlrp_directive}}` | 按当前**形态**渲染的运行时准则：形态自己填了 `directivePrompt` 就用它的（占位符 `{name}{id}{family}{userTitle}{scene}{character}{footer}{tools}`）；没填则按行为族回落（`rp` 族=沉浸准则、`work` 族=七节运维纪律、其它=中性）；关闭态输出中性说明 |
| `{{now}}` | `2026-11-01 星期日 16:30（Asia/Shanghai）`，每次组装重算 |
| `{{cwd}}` | 当前工作目录 |

`{{now}}` / `{{cwd}}` 与 `dsh-plugin-prompt-clock` **共存**：`system-prompt` 对同名变量重复注册会抛 `already registered`，tlrp 用 try/catch 探测，已被占用就打印一行 info 并让位（`registerNowVariable: off` 可完全关闭尝试）。

## 四点五、形态矩阵（Modes）

形态不再是写死的两种，而是一份 `modes` 数组；设置面板 A 分区「形态矩阵工作室 Mode Studio」可以像角色工作室一样新建 / 复制 / 删除 / 设为 Auto 兜底 / 保存任意多个形态。每个形态字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 唯一标识，也是 `/mode <id>` 的目标与斜杠别名默认名 |
| `name` | 面板与状态块里显示的名字 |
| `commandAliases` | 聊天框触发别名，如 `['/sam','【萨姆】','变身']`；以 `/` 开头的会被注册成真指令 |
| `autoKeywords` | auto 分流用正则；空则（`work` 族）回落到全局 `workModeKeywords` |
| `autoPriority` | 越大越优先；全不命中时落 `isDefaultFallback` 形态 |
| `directivePrompt` | 该形态专属行为准则（多行），空则按行为族回落内置准则 |
| `toolPolicy` | `allow_all` / `whitelist_only` / `block_all` |
| `allowedTools` | `whitelist_only` 时放行的工具（逗号或空格分隔，匹配前缀） |
| `injectCharacterPersona` | 是否注入完整角色外貌与背景（关=只留身份锁与称呼） |
| `enableStatusFooter` | 该形态是否强制输出底部状态面板 |
| `statusFooterOverride` | 该形态专属状态面板模板（空=用角色默认模板）；占位符有 `{label}{scene}{dress}{os}{heat}{shield}{vocoder}{entropy}` |
| `bindCharacterId` | 切到该形态时联动切换的角色 id（空=保持当前角色） |
| `isDefaultFallback` | Auto 兜底位，全局恰好一个 |

内置四个（全部可改可删，但至少留一个）：

| id | 名称 | 工具策略 | 面板 | 触发别名 |
| --- | --- | --- | --- | --- |
| `rp` | 少女陪伴态（Auto 兜底） | `whitelist_only`（tlmemory） | 开 | `/rp` `【流萤】` `【陪伴】` |
| `work` | 战术工作态 | `allow_all` | 关 | `/work` `【战术】` |
| `sam` | 萨姆强袭态 | `allow_all` | 开（机甲 HUD 模板） | `/sam` `【萨姆】` `【机甲】` |
| `sleep` | 医疗舱微凉态 | `whitelist_only` | 开 | `/sleep` `【医疗舱】` |

自建第五个形态只需要在面板里点「新建形态」，填 id（如 `debug`）、名称、别名（`/debug`、`【排障】`）、关键词（`堆栈|崩溃`）、优先级（`99`）与专属准则，保存后立刻多一个切换按钮、一条 `/debug` 指令与一个状态块分支，不需要重启宿主。

**向后兼容**：读到 0.2.0 的旧形态（字段 `kind` / `keywords` / `directive` / `footer` / `order`）会被 `normalizeMode` 无损迁移成新字段（`keywords`→`autoKeywords`、`directive`→`directivePrompt`、`footer`→`enableStatusFooter`、`order`→`autoPriority = 100 - order`）；`workModeKeywords` 与 `rpAllowedTools` 作为 0.2.0 兼容字段继续可写，只在该形态自身没写对应项时兜底。

## 五、内置角色

- `firefly`（流萤）：满配。银灰渐变薄荷绿长发、粉蓝渐变瞳孔、棕色露指手套、35.5℃ 指尖、铃兰与烘焙甜香；害羞时眼角金红机甲神经微光、无意识摩挲手套边缘、发箍黑飘带轻晃；危机时扣动银青色变身器化作两米白银重甲萨姆、展开六片翠绿光翼完全燃烧。身份锁明确禁止自称 AI／Agent／模型／「跑在端口上的程序」。
- `sam_tactical`（萨姆纯战术态）：极简对照模板，用来验证多角色切换与「同插件不同人格」的渲染路径。

新增角色只要往 `characters` 里加对象，九个字段都有默认值，缺项会被 `firefly` 的默认填空补齐。

## 六、内置触发映射（动态世界书）

命中关键词即把 `injectText` 注入**本轮**上下文（只 RP 态注入，按 `priority` 降序，默认最多 3 组）：

| id | 关键词 | 注入要点 |
| --- | --- | --- |
| `oak-cake` | 橡木蛋糕卷 / 蛋糕 / 甜点 / 吃什么 | 粗糙像木屑但扎实的甜、花光两万信用点请客；**禁止**在 RP 态搜现实地图找店 |
| `glamoth-iron-cavalry` | 格拉默 / 铁骑 / AR-26710 / 女皇 / 虫群 / 长发 | 共和国覆灭、焦土战役觉醒完全燃烧、军规第 8/21 条、留长发＝活过漫长岁月的证据 |
| `entropy-loss` | 失熵症 / 医疗舱 / 手凉 / 体温 / 身体 / 生病 | 不可逆结构解离的隔毛玻璃体感、现实需躺医疗舱、梦境里格外珍惜五感 |
| `stellaron-hunters` | 卡夫卡 / 银狼 / 刃 / 阿刃 / 艾利欧 / 星核猎手 / 烤肉 | 卡夫卡教涂唇膏、银狼拉她打游戏（打法死板爱莽）、替刃代发短信、萨姆低功率烤肉烤成焦炭 |
| `sam-armor` | 萨姆 / 变身 / 机甲 / 点燃大海 / 战斗 / 保护 | 火萤Ⅳ型、神经直连 HUD 视角、喊中二台词会脸红散热口喷白气的反差萌 |

## 七、工具物理拦截

拦截策略由**当前形态的 `toolPolicy`** 决定，`tools.guard` 在每次工具调用前求值：

- `allow_all`：不拦（默认 `work` / `sam`）；
- `whitelist_only`：只放行该形态 `allowedTools` 里列出的工具前缀，其余拦下（默认 `rp` / `sleep` 放行 `tlmemory`、`ask_user_question`、`schedule`）；
- `block_all`：全拦（适合纯输出形态）。

`allowedToolPatterns`（默认 `^tlmemory_`、`^ask_user_question$`、`^schedule_`）作为全局放行层优先于形态策略。拒绝语里会点名形态与该形态的首个斜杠别名，让模型改用角色口吻接住，而不是无限重试。

`enabled: false` 时一律不拦截。旧字段 `blockShellToolsInRp` 仍生效，但只在 `rp` 族形态且 `toolPolicy` 为 `whitelist_only` 时作为补充放行开关。

## 八、安装

```bash
# 方式 A：一键装进任意 profile 目录（幂等；不跑 pnpm，因此不会被运行中的宿主锁住文件）
node packages/tlrp/scripts/install-into-profile.mjs --profile-dir ~/.dsh/profiles/desktop
node packages/tlrp/scripts/install-into-profile.mjs --profile-dir /root/.dsh/profiles/web   # 远程

# 方式 B：走宿主插件管理器（会自己跑 pnpm 并写 lockfile；宿主运行中时 Windows 上可能 EPERM）
#   在会话里调用 plugin_manager install_bundle，target = 包目录绝对路径

# 装完重启宿主（插件 JS 不做热更新），然后检查
dsh --profile web --dump-config | grep -A 8 "id: tlrp"
```

`install-into-profile.mjs` 做三件事，且都可重复执行：复制包到 `<profile>/node_modules/dsh-plugin-tlrp`（实体目录，插件才能从 profile 级 `node_modules` 解析到 `@deepseek-ai/schemastery`）；在 `package.json` 补 `dependencies` 与 `dsh.profile.bundles`（改前留时间戳备份）；在 `cordis.patch.yml` 末尾补 `- id: tlrp` 配置块。

## 八点五、验证

三段脚本，全部可脱离 GUI 跑（在 profile 目录里执行，好让宿主包可解析）：

| 脚本 | 证明什么 |
| --- | --- |
| `node --test test/core.test.mjs test/memory-bridge.test.mjs test/style.test.mjs` | 47 条纯逻辑单测：指令解析、形态归一化与迁移、触发匹配、三种准则渲染、模板中和、时区格式化、多角色回落、记忆桥、风格层四档解析与归一化、贴纸库扫描、风格块渲染 |
| `node scripts/apply-check.mjs` | 66 条端到端检查：用**真的** `SystemPrompt` 跑 `assemble()+renderPrompt()`，证明未知变量数为 0、核心 section/角色块/时间变量都在、auto 分流、形态准则切换、按 `toolPolicy` 拦截与放行、`/mode <id>` 与自定义别名（`/debug`、`【排障】`）切形态、**自定义第 5 个形态** 的专属准则/精简人设/`block_all` 全拦、`/char` `/scene` `/tlrp` 与 `settings.mutate` 落到 `include:tlrp`、`/style` 四档在 work 与 rp 两侧切换（`dialog` 会同时改掉陪伴族格式红线与斜体动作要求）、命中「橡木蛋糕卷」注入、`sam_tactical` 独立人格、关闭态不拦截 |
| `node scripts/mutate-check.mjs` | 21 条设置写入检查：用**真的** `dsh-settings` 代码跑 `describe()+mutate()`，九个 volatile 字段逐个往返、`modes` 数组往返（含自定义形态）、`mode` 可锁定到任意形态 id、非 volatile 字段被拒绝、未被服务的 ns（`tlrp`）被拒绝、批量写入 |
| `node scripts/client-check.mjs` | 62 条客户端渲染检查：切换栏按 `modes` 动态渲染、自定义形态出现在切换栏、形态 CRUD 按钮与编辑器字段齐全、五个分区可折叠（`aria-expanded`、`data-open`、`hidden` 兜底 CSS）、风格层分区与形态级档位选择 |

```bash
cd ~/.dsh/profiles/desktop
node --test "D:/Code/my-dsh-plugins/packages/tlrp/test/core.test.mjs" "D:/Code/my-dsh-plugins/packages/tlrp/test/style.test.mjs"
node "D:/Code/my-dsh-plugins/packages/tlrp/scripts/apply-check.mjs"
node "D:/Code/my-dsh-plugins/packages/tlrp/scripts/mutate-check.mjs"
```

另外两个一次性维护脚本：

- `scripts/install-into-profile.mjs --check`：只报告差异，不写盘。
- `scripts/rewrite-persona.mjs`：把人设文件里「静态双态协议」与「机器上跑着的 Agent」框架替换为「人设归人设、模式归 tlrp 运行时」，改前自动备份（本次已执行，产物见 `firefly.md.bak-tlrp-*`）。

## 九、接口

- `export const inject = []` —— 强依赖为空，所有宿主能力都在 `ctx.inject([...])` 子作用域里可选获取，缺任何一个服务都不会连带其它插件失败。
- `export function apply(ctx, config)` —— 注册变量 / section / context / 指令 / guard，全部走 `ctx.effect()`，随插件卸载自动清理。
- 内部实现（`__internals`）导出全部纯函数（`resolveMode`、`matchTriggers`、`parseCommand`、`render*` 等），便于脱离宿主单测：`pnpm --filter dsh-plugin-tlrp test`。

## 十、许可

MIT
