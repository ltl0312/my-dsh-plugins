# my-dsh-plugins · DSH 插件合集

这是 DeepSeek Harness（DSH）的插件合集仓库，用 pnpm workspace 单仓管理。
三个插件都发布到 npm，都是 DSH 原生 **bundle** 形态（`package.json` 的 `dsh.bundle.patch`
指向包内自带的 `cordis.patch.yml`），装进 profile 即自动激活。
各自的设计取舍、完整配置与源码结构见对应包的 README。

---

## 📦 插件一览

| 插件 | 版本 | 一句话 | 详细文档 |
|---|---|---|---|
| `dsh-plugin-tlmemory` | 0.7.0 | 无感记忆沉淀与自省管理，带一级主视口记忆看板与 SQLite FTS5 全文检索 | [`packages/tlmemory/README.md`](packages/tlmemory/README.md) |
| `dsh-plugin-tlnotify` | 0.2.0 | 把 DSH 会话事件聚合到一个 IM 通道推到 QQ / 飞书，并且能直接回话 | [`packages/tlnotify/README.md`](packages/tlnotify/README.md) |
| `dsh-plugin-tlsearch` | 0.3.2 | 低 Token 消耗的联网搜索，只返回清洗过的标题 / URL / 摘要 | [`packages/tlsearch/README.md`](packages/tlsearch/README.md) |

---

## 🚀 安装

三个插件都用同一条命令安装并激活：

```powershell
dsh plugin --profile web add dsh-plugin-tlmemory
dsh plugin --profile web add dsh-plugin-tlnotify
dsh plugin --profile web add dsh-plugin-tlsearch
```

三个包都是 **bundle 形态**，只要被列进 profile 的 `dsh.profile.bundles` 就会自动激活，
**不需要**再往 profile 的 `cordis.patch.yml` 写挂载条目（补丁已随包发布）。

> **DSH 桌面应用**：profile `desktop` 由 Electron 应用独占管理，`dsh --profile desktop …`
> 与 `dsh plugin --profile desktop …` 都会被拒绝（`error: profile "desktop" is managed
> exclusively by the Electron application`）。桌面端请在应用内的插件管理界面安装 /
> 启用 —— `@deepseek-ai/dsh-plugin-manager` 只认 `dsh.bundle.patch` 这一条激活通道
> （没有它会被 `not-a-bundle` 拒绝，或被当成普通依赖而不写进 `bundles`），三个包现在都满足。

### 手工安装（等价三步）

`dsh plugin add` 自动做的就是这两件事：装依赖 → 把包归并进 `dsh.profile.bundles`（幂等）；
若依赖闭包里出现原生模块，它还会顺手在 `pnpm-workspace.yaml` 的 `allowBuilds` 里放行。
手工等价步骤如下（以 tlmemory 为例，另外两个包同理换包名）：

1. 进入 profile 目录：`cd ~/.dsh/profiles/web`
2. 装依赖：`pnpm add dsh-plugin-tlmemory`
3. 把包名加进该目录 `package.json` 的 `dsh.profile.bundles` 数组

```json
"dsh": { "profile": { "bundles": ["…", "dsh-plugin-tlmemory"] } }
```

> 只装依赖、不进 `dsh.profile.bundles` 是**不会生效**的。0.8.0 起的 tlmemory 用 Node 内置
> `node:sqlite`（需 Node >= 22.13），包内已无原生模块，安装时不会再出现
> `Ignored build scripts`；其它包若出现，按下面「手工安装」一节的说明放行 `allowBuilds`。

### 查看与摘除

```powershell
dsh plugin --profile web list
dsh plugin --profile web remove dsh-plugin-tlmemory
```

`list` 查看挂载 / 激活状态，`remove <包名>` 一键摘除补丁并卸载。

### 全局选项（任何子命令都可用）

| 选项 | 作用 |
|---|---|
| `--json` | stdout 只输出一行结果 JSON，人类日志改走 stderr；也可用 `DSH_PLUGIN_OUTPUT=json` |
| `--timeout <值>` | pnpm 超时（`1500` / `30s` / `5m`），超时以退出码 `124` 结束；也可用 `DSH_PLUGIN_TIMEOUT` |
| `--yes` | 确认「用内置默认层栈首次创建无模板的同名 profile」，没有它时未知 profile 名的首次创建会被拒绝 |
| `--no-lock` | 跳过 profile 互斥锁 |

> `--profile` 必须紧跟 `dsh plugin` 且只能出现一次；退出码、诊断前缀、原子回写等细节
> 见各包 README 的「安装」一节。

---

## 🧠 一、dsh-plugin-tlmemory —— 无感记忆与自省管理

> DeepSeek Harness (DSH) 原生无感记忆与自省管理插件。

为 DeepSeek Harness 提供会话级静默记忆提炼持久化、SQLite FTS5 全文检索，以及与 DSH 官方 Shell（如 SSH、任务看板）100% 深度融合的一级主视口记忆看板。

---

### ✨ 核心特性

- **无感静默沉淀**：基于 DSH 官方 `session/event` 契约监听 `turn/end` (completed) 事件，静默后台提炼关键工程结论、用户偏好与决策规则，不抢占推理上下文。
- **全局一级视口**：与 DSH 内置「SSH / 任务看板」同级，常驻左侧导航栏核心区，一键切换主视口并支持 `‹ 返回会话` 快捷回退。
- **多工程记忆选择（按 DSH 工作区对齐）**：顶部下拉框列出所有**有记忆数据的工程**，并把不可读的 `repo:<hash>` 反解为可读工程名，同时标注所属工作区（`工程名 [工作区名] (N条)`），切换即换树。归属判定对**存量数据友好**：同一目录的历史 hash 变体（盘符大小写、正/反斜杠写法差异）全部认账，工程名与某个合法工作区同名的存量工程也自动对齐到该工作区。
- **有记忆的工程绝不隐藏 / 绝不剔除（硬性铁律）**：工作区白名单只用来清理**没有任何节点的空壳登记**（例如以用户主目录启动而临时生成的空工程、宿主已删除的历史废弃目录）。只要某个工程在库里还存着节点，无论它的 `scope` 是否出现在 `~/.dsh/storages/workspace.json` 的名单里，都照常保留并展示 —— 白名单永远不会成为「隐藏或删除用户记忆」的理由。
- **零记忆工程自动清理 / 工程名全局唯一**：没有任何记忆文件的工程（含遗留的空目录骨架）会被自动删除，**仅豁免宿主当前正在打开的合法工作区** —— 它零记忆时也常驻下拉框（显示为 `工程名 (0)`），选中即进入「暂无记忆，点击上方「+ 新建记忆」开始沉淀」的空状态，作为「当前工程就绪、可随时沉淀」的心智锚点；同名工程（不同路径的同名仓库、目录改名遗留的旧作用域）自动追加 `scope` 短标识收敛为唯一名，手工重命名撞名时明确报错。
- **作用域读取容错**：请求一个不存在或已失效的工程时，`GET /api/nodes` 回 **HTTP 200 + 空记忆树 + 可读提示**（而不是 404），看板按空态渲染；下拉框在任何状态下都可以唤起，且选中的工程若不在当前清单里会**自动回退到第一个有记忆的工程**，不会出现「暂无工程记忆 + 下拉点不开」的死锁。
- **树状图谱视图**：与「📋 目录列表」一键互切的自顶向下多叉树，SVG 贝塞尔连线、拖拽平移与滚轮缩放、一键居中；检索时命中节点青色发光、整条父级路径连线加粗、未命中节点淡化，点击叶子直接唤起 Markdown 详情抽屉。
- **主题自适应穿透**：采用透明通道透传 DSH 官方主题底色，深色/浅色皮肤实时自适应无缝融合。
- **Markdown 详情抽屉**：记忆卡片列表仅展示关键简介，点击从右侧平滑滑出详情抽屉，支持安全沙箱渲染的完整 Markdown 阅读与一键复制。
- **SQLite FTS5 全文检索**：底层持久化采用 SQLite FTS5 分词索引，支持毫秒级全文精确检索。
- **单一宿主自洽**：通过 Cordis 补丁由 DSH Web 宿主自动托管 HTTP 服务（端口 4890），无需手动运行单独后台守护进程。

---

### 📦 安装方式

#### 方式一：一条命令安装并自动挂载（推荐）

```powershell
dsh plugin --profile web add dsh-plugin-tlmemory
```

`dsh plugin add` 会自动完成下面三件以前需要手工做的事：装依赖 → 放行原生模块
（`pnpm-workspace.yaml` 的 `allowBuilds`）→ 往 `cordis.patch.yml` 追加挂载条目（幂等）。
另外 `dsh plugin --profile web list` 可查看挂载状态，`dsh plugin --profile web remove <包名>`
可一键摘除补丁并卸载。

> `--profile` 必须紧跟 `dsh plugin`，且只能出现一次：`dsh plugin --profile web add --profile=1`
> 这类写法会**显式报错**并拒绝执行（旧版会静默丢弃参数、同时把整条命令改道到另一个 profile）。
> 命令的失败以稳定退出码分类：`0` 成功 / `1` 用法或前置条件不满足 / `2` pnpm 缺失 /
> `3` 清单非法 / `4` 归并不一致 / `124` pnpm 超时，其余透传 pnpm；每条诊断行都带
> `dsh: diagnose: <code>:` 前缀，便于脚本与 agent 直接匹配。
>
> 本层全局选项（任何子命令都可用，且不会转发给 pnpm）：
>
> | 选项 | 作用 |
> |---|---|
> | `--json` | stdout 只输出一行结果 JSON（`phase` / `exitCode` / `pnpm` / `addedBundles` / `mounts` / `allowBuilds` / `diagnostics`…），人类日志改走 stderr；也可用 `DSH_PLUGIN_OUTPUT=json` |
> | `--timeout <值>` | pnpm 超时（`1500` / `30s` / `5m`），超时以 `124` 结束；也可用 `DSH_PLUGIN_TIMEOUT` |
> | `--yes` | 确认「用内置默认层栈首次创建无模板的同名 profile」；没有它时未知 profile 名的首次创建会被拒绝（避免手误留下半成品 profile） |
> | `--no-lock` | 跳过 profile 互斥锁 |
>
> 其它内建保障：profile 自己是 workspace root 时自动给 `add`/`remove`/`update` 补 `-w`；
> 会写盘的子命令默认持有 `<profile>/.dsh-plugin.lock`；回写 `package.json` 前先存
> `.bak-dsh-plugin-manifest-<时间戳>` 并原子替换；pnpm 的输出被实时转发**同时**被捕获，
> 失败时给出分类后的诊断（`adding-to-root` / `ignored-builds` / `fetch-404` /
> `windows-file-locked` / `network` …）。

#### 方式二：手工安装（等价于方式一的三步）

进入你的 DSH profile 目录（例如 `~/.dsh/profiles/web`）：

```powershell
cd ~/.dsh/profiles/web

# 从 npm 安装
pnpm add dsh-plugin-tlmemory
```

0.8.0 起 tlmemory 的持久层是 Node 内置的 `node:sqlite`（**无需任何编译**），装完直接
把包名加进该 profile 的 `package.json` 即可。若所用版本仍提示 `Ignored build scripts`
（依赖闭包里出现原生模块），在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 里放行后重装：

```yaml
allowBuilds:
  包名: true
```

> 注意键名：pnpm 11 用的是 `allowBuilds`（映射），不是 pnpm 10 的
> `onlyBuiltDependencies`（数组）。pnpm 拦下构建时会自己往这里写一行
> `包名: set this to true or false` 占位，改成 `true` 即可。

---

### ⚙️ 配置

看板服务随宿主**零配置自启**，无需任何开关声明。要改配置就在**自己的 profile 补丁层**
`~/.dsh/profiles/web/cordis.patch.yml` 里**按 id 覆盖**（写 `- id:` 覆写行，**不要**再写
`- insert:`）：

```yaml
- id: dsh-plugin-tlmemory
  config:
    serverPort: 4890           # 看板服务端口（默认 4890）
    maxRecallCount: 5          # 单轮最多注入系统提示词的记忆条数
    enableAutoReflection: true # 会话结束异步自动反思提炼
    compactionInterval: 20     # 每累计 N 次沉淀触发一轮强化衰减 + 矛盾检测
```

> ⚠️ **从 0.6.x 升级**：0.6.x 不是 bundle，只能靠手写的 `- insert:` 挂载（当时文档给的 id 是
> `tlmemory-runtime`）。Cordis 按 **id** 去重而**不按 name**，旧条目与新 bundle 条目会同时生效
> —— 同一个包被挂载两次。升级时请先删掉那段旧的 `- insert:`，再把包名留给
> `dsh.profile.bundles` 托管。

> 端口冲突自愈：4890 被前序 tlmemory 实例占用时，新实例会经健康探测确认同名进程
> 后自动复用（多宿主并存无需手工分工）；被无关进程占用时自动顺延端口；连续顺延
> 仍失败时在控制台打印 EADDRINUSE 排查指引。
>
> 禁区端口自检：浏览器与 `fetch` 共同封禁的端口（如 3659 / 4045 / 4190 / 5060 /
> 5061 / 6000 / 6566）无法打开看板也无法被 HTTP 客户端访问，绑定后会被自检识别并
> 自动换端口重试 —— 配置 `serverPort: 0` 交由系统分配时同样保证落在可用端口上。

---

### 🚀 启动与使用

#### 1. 启动 DSH Web 宿主

在任意终端路径下直接启动：

```powershell
dsh web
```

> Node 版本：运行需 **Node >= 22.13** —— 0.8.0 起 tlmemory 用 Node 内置的 `node:sqlite`
> （v22.13.0 / v23.4.0 起不再需要 `--experimental-sqlite`），不再有原生二进制，
> 也就不会再出现 `NODE_MODULE_VERSION` 不匹配。

#### 2. 访问记忆看板

1. 打开浏览器进入 DSH 界面（通常为 http://127.0.0.1:3080）。
2. 在左侧边栏顶部（「+ 新会话」下方、「技能中心」旁）点击 **「记忆看板」**。
3. 中间主视口将平滑接管展示记忆树：顶部下拉框切换任意工程（默认选中当前所在工程），
   「全局偏好」胶囊单独查看跨工程偏好；右上角滑块在「📋 目录列表」与「🌲 树状图谱」
   之间切换，选中工程、搜索关键词与图谱的平移缩放都会原样保留。
4. 正常进行对话，每个完成的回合（Turn）将由后台自动提炼关键信息沉淀入库。

---

## 🔔 二、dsh-plugin-tlnotify —— 把会话事件推到 QQ / 飞书，并且能回话

DSH 跑在电脑上，人不在电脑前。tlnotify 把「哪个项目的哪个对话」出了什么事推到你的手机
（QQ 单聊机器人 / 飞书自建应用），并且让你**直接在那条消息下面回复**，内容会注入回正确的
会话——不用回电脑，也不用在浏览器里翻找那个标签页。

### ✨ 核心特性

- **一个通道看全部会话**：标题三段式 `DSH · <项目目录名> · <短会话id> · <事件>`，
  例 `DSH · my-dsh-plugins · 519cc141 · 权限请求`——一眼看出是哪个项目的哪个对话。
- **九类事件**：任务完成、执行错误、执行被阻塞、手动中止、Token 达到上限、异常中断、
  等待我回答、权限请求、等待计划确认。
- **能点按钮**：审批给「允许 / 拒绝」，提问给选项按钮，计划确认给「批准计划 / 不批准」，
  另外附「打开会话」「详细模式」两个操作按钮；点击即在 DSH 侧生效。
- **能定向回复**：三层路由（按钮 → 长按引用回复 → 显式短 id 前缀）保证消息回到正确的
  会话；没有引用时兜底发给**最新一条通知**的会话，并且**一定回显「已发给 X」**。
- **等待中的提问与审批可以直接回一段文字作答**：按钮不是唯一入口，回文字更可靠
  （QQ 单聊的按钮在桌面端与旧版手机上不渲染，而宿主那边只要没人结算就会一直等）。
- **零公网依赖**：两个通道都走 WebSocket 长连接，**不需要公网 IP、不需要域名、不需要内网穿透**。
- **每台机器人各自订阅**：会话范围是每台机器人自己的（全部 / 一个 / 名单里的若干个），投递逐台进行——一台设成单会话，另一台照样收全局。
- **不刷屏、重启不丢**：完成门控（等 agent 真正空闲再发）+ 按 `会话:seq` 去重（24 小时窗口）+
  正文聚合 + 长文本分片（按钮只在首片）；路由表、每台机器人的会话范围与详细模式名单都落盘，
  TTL 默认 7 天。

### 🚀 快速开始（QQ，约 10 分钟）

1. 打开 <https://q.qq.com/> 创建机器人，拿到 `AppID` 与 `AppSecret`。
2. 在「开发设置」里开启 **C2C 消息**（单聊）相关权限；用群聊还要开启群 @ 消息。
3. 用你自己的 QQ 给机器人发一条消息，插件日志里的 `sender=<你的 openid>` 就是 `targetChatId`。
4. 在 DSH 的**设置页**（设置 → 插件 → **通知助手**）里添加一个 `qq` 通道，填入 `AppID` /
   `AppSecret` / `targetChatId`；也可以直接编辑 `$DSH_HOME/tlnotify/config.json`。
5. 重启 DSH，在 QQ 里给机器人发 `/mode` 验证双向通路。

```json
{
  "enabled": true, "mode": "global", "defaultChannelId": "qq-main",
  "channels": [{ "id": "qq-main", "type": "qq", "enabled": true,
                 "appId": "102xxxxxx", "appSecret": "xxxxxxxxxxxxxxxx",
                 "targetChatId": "你的 openid" }]
}
```

> ⚠️ **唯一的硬限制**：QQ 用户可以在客户端设置里关闭「允许主动发送消息」，关闭后
> **所有主动推送都会失败**（按钮回调后的回复属于被动回复，仍可用）；插件检测到这种情况
> 会在日志里给出明确提示。

### 🔌 通道

| 通道 | `type` | 接入要点 |
|---|---|---|
| QQ 单聊机器人 | `qq` | 长连接收事件、支持按钮、支持长按引用回复，个人可自助注册；主动消息限额 **1000 条/天/用户**、**20 条/分钟**，被动回复窗口 60 分钟、最多 4 次 |
| 飞书自建应用 | `feishu` | 事件订阅方式选**长连接**（免公网的关键，不需要填回调地址）；订阅 `im.message.receive_v1` 与 `card.action.trigger`，权限 `im:message` / `im:message:send_as_bot` |

### ⚙️ 关键配置（带默认值）

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时不连任何通道 |
| `channels[].markdown` | **关** | 通道级开关；开了才用 QQ 原生 Markdown 卡片（`msg_type: 2`），关着发纯文本 |
| `channels[].sessionScope` | `all` | `all` 关心全局 / `single` 只关心 `sessionId` 那一个 / `filter` 只关心 `sessionFilter` 里列的会话；`historyTurns`（跟随全局）决定这条通知带该会话最近几轮提问：`0` = 不带、`N` = 最近 N 轮（上限 20） |
| `events.onTurnEnd` / `onError` / `onAborted` / `onPending` / `onMaxTokens` | 均 `true` | 各类事件的推送开关（`onError` 同时控制「执行被阻塞」与「异常中断」）；`events.includeSubagent` 默认 `false`，是否也推子 Agent 的事件 |
| `content.maxBodyChars` | `1800` | 正文硬上限，超出截断并标注（设置页可调，范围 200–20000）；`routing.allowPrefix` / `fallback` / `tableTtlDays` / `echoTarget` 默认 `true` / `latest` / `7` / `true`（显式短 id 前缀定向 / 无引用时发给最新一条通知的会话 / 路由表 TTL 天数 / 投递后回显「已发给 X」） |
| `session.context.previousTurns` | `3` | 单会话范围时附带前 N 轮摘要（每台机器人可用 `historyTurns` 覆盖） |

### 💬 IM 命令与文字作答

| 命令 | 作用 |
|---|---|
| `/mode` | 查看**这台机器人**当前关心哪些会话（全部 / 一个 / 名单里的 N 个）与详细模式名单 |
| `/mode global` / `/mode session <短id>` | 让**这台机器人**关心全部会话 / 只关心这个会话，之后只推这一个 |
| `detail`（也可写 `detail on`） | 把当前路由到的那个会话升级为详细模式 |
| `undetail`（也可写 `detail off` / `brief` / `精简`） | 恢复精简，整句提示复制回来也生效 |
| `stop` | 中止当前路由到的会话 |
| `<短id> 你的话` | 显式定向投递到那个会话 |
| 直接说话 | 按三层路由投递（推荐**长按引用**某条通知再回复） |

等待中的提问与审批**可以直接回一段文字作答**：

| 情况 | 你可以回 |
|---|---|
| 提问 | `1`（序号）、选项原文，或任意一句自由文本（自由文本直接当答案） |
| 提问：自定义回答 | 先回最后一行那个序号（候选数 + 1），再发一段文本——那段文本原样当答案 |
| 多选提问 | `1 3` / `1、3` / `1,3` |
| 审批 | `允许` / `同意` / `批准` / `yes` / `1`；`拒绝` / `不同意` / `deny` / `2` |
| 计划确认 | `批准` / `不批准`（**不认自由文本**——免得随手一句话就把计划批了） |

提问正文里的选项是**编号分行**的，最后一行固定是「N+1. 自定义回答（先输入序号再输入文本）」。
结算按**会话**找**最新一条**还在等待的请求；文本没对上任何等待中的请求时，它会照常作为
普通发言注入会话。

> 通道级 `markdown` 开关**默认关**是有原因的：QQ 把 `msg_type: 2` 的消息画在一张**固定宽度**
> 的卡片里（客户端写死 618px 画布），**不随窗口自适应**。2026-10-04 在同一台电脑、同一个
> 最大化窗口（2094px 宽）里实测：Markdown 卡片气泡右边界约 **600px**，而同一窗口里**普通文本**
> 气泡约 **850px**——手机上看着正好的通知，在电脑上就像「只有手机宽」，右侧空一半。
> 想要加粗标题就打开 `markdown`，想要和普通消息一样的观感就保持关闭（默认）。

完整文档见 [`packages/tlnotify/README.md`](packages/tlnotify/README.md)。

---

## 🔎 三、dsh-plugin-tlsearch —— 低 Token 消耗的联网搜索

把「一次搜索」塞进模型上下文的东西压到最少：只返回清洗过的 `{ title, url, snippet }`，
没有提供方散文、没有 Raw HTML、没有埋点参数、没有每轮重复的引用指引。后端可插拔
（Tavily / Brave / SearXNG / Google / Exa），端点可自建。

### ✨ 核心特性

- **结构化最小输出**：每条结果最多两行（`N. 标题 — URL` + 缩进摘要），零装饰词、零填充句。
- **摘要硬上限**：`maxSnippetChars`（默认 250）逐条截断并尽量落在词边界，Token 成本可预算、可封顶。
- **结果数硬上限**：`maxResults`（默认 5，上限 10）——原生 `web_search` 默认 8 条。
- **清洗是确定性的**：剥离 HTML 标签（`<strong>`、`<p>`、`<style>` 正文整块丢弃）、
  解码 HTML 实体（`&#x27;` 6 个字符 → `'` 1 个字符）、折叠换行/制表/NBSP/零宽字符。
- **URL 减负**：剔除 `utm_*` / `fbclid` / `gclid` / `srsltid` 等纯埋点参数，保留路径、
  其余查询参数与 `#hash`；解析失败的 URL **逐字节原样返回**，绝不改写。
- **先去重再截断**：按归一化后的 URL 去重，避免同一篇文章的多个镜像先占满名额再被去重。
- **超时 + 熔断**：每次请求挂 `AbortController` 超时；连续失败 3 次即熔断 60 秒，
  冷却期内**不发网络请求**直接快速失败；调用方主动中断**不计入**熔断。
- **零运行时依赖**：网络层直接用 Node 原生 `fetch` / `AbortSignal`，不引入 axios 等重库。

### 💰 为什么更省 Token（可复现的度量）

用同一批**真实脏数据**（8 条 Brave 风格原始结果：带 `<strong>` 高亮、HTML 实体、
埋点参数、均值 372 字符的长摘要）走真实管线对比：

| 指标 | 原生 `web_search` 风格 | `tlsearch` 默认 | 差异 |
|---|---|---|---|
| 结果条数 | 8 | 5 | −37% |
| 单条摘要字符（均值） | 372（未清洗、无上限） | 248（清洗 + 250 上限） | −33% |
| 单条 URL 字符（均值） | 105（含 `utm_*`/`fbclid`） | 34 | −68% |
| **总字符数** | **4346** | **1608** | **2.70×** |
| 粗估 Token（英文 ≈ 4 字符/token） | ≈ 1087 | ≈ 402 | 2.70× |

### 🔌 支持的后端

| 后端 | 密钥 | 默认端点 | 说明 |
|---|---|---|---|
| `tavily`（默认） | 必需 | `https://api.tavily.com` | 1000 credits/月，结构化 JSON、字段干净；密钥同时走 `Authorization` 头与请求体，兼容自建/中转网关 |
| `searxng` | **不需要** | 无（必须自配） | 自托管元搜索，`baseUrl` 必填，并需在实例 `settings.yml` 的 `search.formats` 中启用 `json` |
| `brave` | 必需 | `https://api.search.brave.com` | 请求侧关闭 `text_decorations` 并限定 `result_filter=web`，避免 `<strong>` 与 infobox 噪声 |
| `exa` | 必需 | `https://api.exa.ai` | 语义/神经检索，适合「找概念、找相似」；搜索与 contents 分开计费 |
| `google` | 必需（key + `cx`） | `https://www.googleapis.com` | ⚠️ 自 2026 年起不再向新客户开放，2027-01-01 停服；适配器仅为存量老 CSE 过渡保留 |

### ⚙️ 关键配置（带默认值）

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `provider` | `tavily` | 主后端：`tavily` / `searxng` / `google` / `brave` / `exa` |
| `maxResults` | `5` | 返回条数上限（钳制在 1-10） |
| `maxSnippetChars` | `250` | 单条摘要字符上限（钳制在 40-2000，控制 Token 的主旋钮） |
| `timeoutMs` | `15000` | 单次请求超时（钳制在 1000-60000） |
| `outputFormat` | `markdown` | `markdown`（最省 Token）或 `json`（结构化，便于精确解析） |
| `includeAnswer` | `false` | 是否附带后端的一句话答案（默认关以省 Token） |
| `chain[]` / `fallback` | `[]` / `none` | 后备后端链，主后端失败/熔断时按顺序降级，每级一个独立熔断器 |

### 📊 额度自查工具 `tlsearch_usage`

配置里存在 Tavily 后端时，会**额外注册**一个无入参的 `tlsearch_usage` 工具，返回一行额度信息
（如 `137/1000 credits used this cycle; 863 remaining`），让 agent 在搜索开始出现配额/限流错误时
（或准备发起大批搜索前）自己查一下余量。只在配置了 Tavily 时注册——其余后端没有机器可读的
额度接口，注册一个永远只会说「请去控制台看」的工具纯粹是每轮 Token 浪费。

完整文档见 [`packages/tlsearch/README.md`](packages/tlsearch/README.md)。

---

## 🛠️ 仓库常用命令（开发与测试）

```powershell
# 运行单元测试（全工作区）
pnpm run test

# 构建全部产物：dist/（Node 核心）+ web/client.js（客户端插件）+ web/dist/（看板前端）
pnpm run build

# 客户端 Bundle 真实冒烟走查（jsdom 加载真实产物，需先 build）
pnpm run smoke:client

# dsh CLI 增强层的单测 / 安装（可选，见 tools/dsh-plugin-cmd）
pnpm run test:cli
pnpm run install:cli
```

> 根目录 `pnpm run build` 是递归构建（workspace 含 `packages/tlmemory`、`packages/tlnotify`
> 与 `packages/tlsearch`），因此三个包的产物会被一并刷新 —— 发包前跑这一条即可。
> 单独构建某个包用 `pnpm --filter <包名> run build`。

---

## 📄 License

MIT License
