# dsh-plugin-tlnotify

> 把 **所有** DeepSeek Harness 会话的事件聚合到一个 IM 通道，并且能**回话**。

DSH 跑在电脑上，人不在电脑前。`tlnotify` 把「哪个项目的哪个对话」出了什么事推到你的
手机（QQ 单聊机器人 / 飞书自建应用），并且让你**直接在那条消息下面回复**，内容会注入
回正确的会话——不用回电脑，也不用在浏览器里翻找那个标签页。

---

## ✨ 核心特性

- **一个通道看全部会话**。标题三段式：`DSH · <项目目录名> · <短会话id> · <事件>`，
  例 `DSH · my-dsh-plugins · 519cc141 · 权限请求`——一眼看出是哪个项目的哪个对话。
- **九类事件**：任务完成、执行错误、执行被阻塞、手动中止、Token 达到上限、异常中断、
  等待我回答、权限请求、等待计划确认。
- **能点按钮**。审批给「允许 / 拒绝」，提问给选项按钮，计划确认给「批准 / 继续规划」，
  另外附「中止」「详细」「定位」等操作按钮。点击即在 DSH 侧生效。
- **能定向回复**。三层路由（按钮 → 长按引用回复 → 显式短 id 前缀）保证消息回到正确的会话；
  没有引用时兜底发给**最新一条通知**的会话，并且**一定回显「已发给 X」**。
- **零公网依赖**。两个通道都走 WebSocket 长连接，**不需要公网 IP、不需要域名、不需要内网穿透**。
- **两种运行模式**。全局模式（所有主会话，一行精简提示）与单会话模式（只盯一个会话，
  带完整上下文与前 N 轮摘要）。
- **不刷屏**。完成门控（等 agent 真正空闲再发）、按 `会话:seq` 去重（24 小时窗口）、
  正文聚合、长文本自动分片（按钮只在首片）。
- **重启不丢**。路由表、运行模式、详细模式名单都落盘，TTL 默认 7 天。

---

## 📦 安装

本包是 **bundle 形态**（`package.json` 的 `dsh.bundle.patch` 指向包内自带的
`cordis.patch.yml`）。因此只要被列进 profile 的 `dsh.profile.bundles` 就会自动激活，
**不需要**再往 profile 的 `cordis.patch.yml` 写挂载条目。

### 方式一：一条命令安装并激活（推荐）

```powershell
dsh plugin --profile web add dsh-plugin-tlnotify
```

`dsh plugin add` 会自动装依赖并把该包归并进 `dsh.profile.bundles`（幂等）。
`dsh plugin --profile web list` 可核对激活状态。

### 方式二：手工安装（等价）

```powershell
cd ~/.dsh/profiles/web
pnpm add dsh-plugin-tlnotify
```

然后把它加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组：

```json
"dsh": { "profile": { "bundles": ["…", "dsh-plugin-tlnotify"] } }
```

> **调试本地源码**时依赖写成
> `"dsh-plugin-tlnotify": "file:D:/Code/my-dsh-plugins/packages/tlnotify"`，
> 并且同样必须出现在 `dsh.profile.bundles` 里才会生效——只装依赖不激活是**不会生效**的。
>
> 要接飞书通道，还需要在 profile 里自己装上飞书官方 SDK：
> `pnpm add @larksuiteoapi/node-sdk`。只接 QQ 则不需要。
>
> 它**故意不在本插件的 `package.json` 里声明**：该包解包后约 30 MB，做成自动安装的
> 依赖会让只用 QQ 的用户白白付出下载成本。插件在飞书通道启动时才动态 `import()` 它，
> 没装的话**只有飞书通道**启动失败并打印上面这条安装指引，QQ 通道与插件装载都不受影响。

---

## 🚀 快速开始（QQ，约 10 分钟）

QQ 单聊机器人是**首选通道**：长连接收事件、支持按钮、支持长按引用回复，
而且**个人可以自助注册**，不需要企业资质。

1. **注册机器人**：打开 <https://q.qq.com/> → 创建机器人 → 拿到 `AppID` 与 `AppSecret`。
2. **打开消息权限**：在「开发设置」里开启 **C2C 消息**（单聊）相关权限；
   如果用群聊，还要开启群 @ 消息。
3. **拿到你自己的 openid**：机器人上线后，用你自己的 QQ 给机器人发一条消息，
   插件日志里会出现一条 `收到入站消息 … sender=<你的 openid>`。
   把它填进配置的 `targetChatId`。
4. **配置通道**：GUI 的 **设置 → 插件 → tlnotify**，或直接改
   `$DSH_HOME/tlnotify/config.json`：

   ```json
   {
     "enabled": true,
     "mode": "global",
     "channels": [
       {
         "id": "qq-main",
         "type": "qq",
         "enabled": true,
         "appId": "102xxxxxx",
         "appSecret": "xxxxxxxxxxxxxxxx",
         "targetChatId": "你的 openid"
       }
     ],
     "defaultChannelId": "qq-main"
   }
   ```

5. **重启 DSH**，然后在 QQ 里给机器人发 `/mode` 验证双向通路。

> ⚠️ **唯一的硬限制**：QQ 用户可以在客户端设置里关闭「允许主动发送消息」。
> 关闭后**所有主动推送都会失败**（按钮回调后的回复属于被动回复，仍可用）。
> 插件检测到这种情况会在日志里给出明确提示。

---

## 🔌 通道

### QQ 单聊机器人（`type: "qq"`）

| 配置项 | 必填 | 说明 |
|---|---|---|
| `appId` | ✅ | 机器人 AppID |
| `appSecret` | ✅ | 机器人 AppSecret（`.role('secret')`，只存在本机配置里） |
| `targetChatId` | ✅ | 目标用户的 `openid`。**每个机器人看到的 openid 不同**，换机器人要重新获取 |
| `targetKind` | | `user`（默认，单聊）或 `group`（群聊） |
| `sessionFilter` | | 会话白名单：填了就只推这些会话；留空推全部 |

- 主动消息限额：**1000 条/天/用户**、**20 条/分钟**。被动回复窗口 60 分钟、最多 4 次。
- 按钮通过 `keyboard` 实现；`action.data` 是字符串，所以结构化 `value` 用 `JSON.stringify` 承载。
- **引用回复靠 `msg_idx` 而不是 `message_id`**：QQ 的入站事件里没有 `message_reference` 字段，
  被引用消息由 `message_scene.ext` 的 `ref_msg_idx`（或 `message_type===103` 时的
  `msg_elements[0].msg_idx`）还原。因此插件同时维护 `byRefIdx` 与 `byContent`（正文哈希）
  两张反查表——只靠 `message_id` 是接不上引用回复的。

### 飞书自建应用（`type: "feishu"`）

| 配置项 | 必填 | 说明 |
|---|---|---|
| `appId` | ✅ | 自建应用 App ID |
| `appSecret` | ✅ | 自建应用 App Secret |
| `targetChatId` | ✅ | 接收消息的 `open_id` / `chat_id` / `union_id` |
| `feishuReceiveIdType` | | `open_id`（默认）/ `chat_id` / `union_id` / `email` |
| `sessionFilter` | | 同上 |

1. 在 <https://open.feishu.cn/> 创建**企业自建应用**，开启**机器人**能力。
2. **事件订阅方式选「长连接」**——这是免公网的关键，不需要填任何回调地址。
3. 订阅事件：`im.message.receive_v1`（收消息）、`card.action.trigger`（卡片按钮）。
4. 权限：`im:message`、`im:message:send_as_bot`。
5. 把应用发布到自己的企业/团队，然后把机器人拉进一个会话或直接单聊它。

- 飞书按钮的 `value` **可以是任意 JSON 对象**，不需要字符串化。
- 引用回复用 `parent_id ?? root_id` 反查。
- `update(messageId, patch)` 在飞书上是**真正可用**的（`im.message.patch`），
  所以点完按钮后消息会被原地改写成「已结算」状态；QQ 上不支持编辑，
  插件会改为**发送一条回执**。

---

## ⚙️ 配置

配置有两条路径：宿主 GUI 的 **设置 → 插件 → tlnotify**，或 profile 的
`~/.dsh/profiles/web/cordis.patch.yml` 里**按 id 覆盖**
（注意是覆盖，不是再插一条 `- insert:`——挂载已由 bundle 完成，重复插入会挂载两次）：

```yaml
- id: dsh-plugin-tlnotify
  config:
    enabled: true
    mode: global              # global | session
    channels: []
```

**权威性规则**：显式配置 > `$DSH_HOME/tlnotify/config.json` > 内置默认值。
唯一的例外是 `mode` 与 `session.targetSessionId`——这两个字段是**运行时权威**，
`/mode` 命令写入的值会盖过 GUI / 补丁，否则用户改完模式一重启就丢。

### 顶层

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 时不连任何通道 |
| `mode` | `global` | `global` 全局模式 / `session` 单会话模式 |
| `channels[]` | `[]` | 通道列表，见上 |
| `defaultChannelId` | `''` | 默认通道；留空用第一个启用的通道 |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |
| `dataDir` | `$DSH_HOME/tlnotify` | 配置 / 状态 / 日志的落盘目录 |

### `events` —— 哪些事件要推

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `onTurnEnd` | `true` | 任务完成 |
| `onError` | `true` | 执行错误；**同时控制「执行被阻塞」与「异常中断」** |
| `onAborted` | `true` | 手动中止 |
| `onPending` | `true` | 等待我回答 / 权限请求 / 等待计划确认 |
| `onMaxTokens` | `true` | Token 达到上限 |
| `includeSubagent` | `false` | 是否也推子 Agent 的事件。默认 `false`——子 Agent 一多会刷屏 |

### `content` —— 正文放什么

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `includeMetadata` | `true` | 是否带耗时 / 工具数 / token 等元信息 |
| `includeUserPrompt` | `true` | 是否回显触发这一轮的提问 |
| `maxBodyChars` | `1500` | 正文硬上限，超出截断并标注 |

### `routing` —— 回复怎么找到会话

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `allowPrefix` | `true` | 是否允许 `519cc141 继续` 这种显式前缀定向 |
| `fallback` | `latest` | 没有引用时发给谁：`latest`（最新一条通知的会话）或 `intervention`（最近一次需要人介入的会话） |
| `tableTtlDays` | `7` | 路由表条目存活天数 |
| `echoTarget` | `true` | 投递后是否回显「已发给 X」。**强烈建议保持开启**，否则投错会话你无从察觉 |

### `session` / `global` —— 两种模式的形态

单会话模式（`mode: "session"`）只推 `targetSessionId` 那一个会话，并且带完整上下文：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `targetSessionId` | `''` | 绑定的会话 id（可用 `/mode session <短id>` 设置） |
| `context.includeAssistant` | `true` | 是否包含助手回复正文 |
| `context.includeTools` | `true` | 是否列出工具调用 |
| `context.includeTiming` | `true` | 是否带耗时 |
| `context.previousTurns` | `3` | 附带前 N 轮的摘要 |
| `context.includeUserPrompt` | `true` | 是否回显提问 |

全局模式（`mode: "global"`）推所有主会话，但保持精简：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `verbosity` | `brief` | `brief` 固定精简；`normal` 让所有会话都按详细正文渲染（不推荐，会刷屏） |
| `includeSessionLabel` | `true` | 标题里带「项目 · 短id」 |
| `includeSummaryLine` | `true` | 是否附一行结果摘要 |
| `includeSubagent` | `false` | 同 `events.includeSubagent` |

---

## 💬 IM 命令

在通道里直接给机器人发这些话：

| 命令 | 作用 |
|---|---|
| `/mode` | 查看当前模式、绑定会话与详细模式名单 |
| `/mode global` | 切到全局模式 |
| `/mode session <短id>` | 切到单会话模式并绑定该会话 |
| `/help` | 帮助 |
| `detail` | 把**当前路由到的那个会话**升级为详细模式（全局模式下临时看细节） |
| `undetail`（也可写 `brief` / `精简`） | 恢复精简 |
| `stop` | 中止当前路由到的会话 |
| `<短id> 你的话` | 显式定向投递到那个会话 |
| 直接说话 | 按三层路由投递（推荐**长按引用**某条通知再回复） |

---

## 🧭 回复路由（三层，顺序不可颠倒）

1. **按钮**。按钮的 `value` 自带 `sessionId`，零歧义。审批 / 提问 / 计划按钮同时完成
   「结算」与「路由」两件事。
2. **长按引用回复**。用 `byMessage` / `byRefIdx` / `byThread` / `byContent` 四张表反查
   被引用消息属于哪个会话。QQ 靠 `ref_msg_idx`，飞书靠 `parent_id ?? root_id`。
3. **显式前缀**。`519cc141 继续` —— 短 id 是会话 id 去掉 `session-` 前缀后的前 8 位。

**兜底**：都没有时，默认发给**最新一条通知**的会话（`fallback: "intervention"` 则发给
「最近一次需要人介入」的会话）；该会话已经不存在就再退一层；都没有就回
「没有可投递的会话」。**任何一次投递都会回显「已发给 X」**，包括兜底路径
（会额外标注「没有引用，按最新通知投递」）。

路由表有 TTL（默认 7 天），并且**落盘到 `state.json`**——重启后引用一条三天前的通知仍然有效。

---

## 🗂️ 文件与状态

全部落在 `$DSH_HOME/tlnotify/`：

| 文件 | 内容 |
|---|---|
| `config.json` | 有效配置。GUI / 补丁里没写的字段会从这里读；`/mode` 也写这里 |
| `state.json` | 路由表（`byMessage` / `byThread` / `byRefIdx` / `byContent` / `latest` / `lastIntervention`）、详细模式名单、入站去重表 |
| `plugin.log` | 插件日志，1 MiB 轮转保留一份 `.1` |

写入是**原子**的（先写 `.tmp` 再 `rename`），落盘是**防抖**的（1.5 秒），
且所有文件操作失败都**不会抛异常**——通知插件绝不能因为磁盘问题把宿主拖下水。

---

## 🧱 源码结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：`Config`、`apply`、把下面所有模块接线起来 |
| `src/types.ts` | 全部领域类型；**不 import 任何 `@deepseek-ai/*` 运行时模块** |
| `src/config.ts` | 配置解析 / 合并 / 落盘，以及 GUI 用的 schemastery `Config` |
| `src/events.ts` | 会话事件归一化：9 类事件、项目名、短 id、子 Agent 判定 |
| `src/aggregate.ts` | `TurnAccumulator`：累积助手正文与工具调用，产出 `TurnSnapshot` |
| `src/gate.ts` | `CompletionGate`：等 agent 真正空闲再发，防抖 + 重试上限 |
| `src/dedupe.ts` | 按 `会话:seq` 去重（24 小时窗口 / 2000 条上限） |
| `src/render.ts` | 标题三段式、正文渲染、按钮生成、长文本分片 |
| `src/route.ts` | `RouteTable`：三层路由 + TTL + 序列化 |
| `src/mode.ts` | `ModeState`：全局 / 单会话 / 详细名单，以及命令解析 |
| `src/inject.ts` | `SessionInjector`（回注消息、中止会话）与 `InteractionBridge`（审批 / 提问 waterfall） |
| `src/log.ts` | 带轮转的文件日志，失败静默 |
| `src/channels/index.ts` | `ChannelManager`：启动 / 停止 / 发送 / 故障转移 / 分片 |
| `src/channels/qq.ts` | QQ 单聊机器人通道 |
| `src/channels/feishu.ts` | 飞书自建应用通道 |

### 三个值得记录的宿主事实

1. **`apply` 的返回值会被丢弃**。Cordis 3.0.0 的 `MainScope.apply` 是
   `this.ensure(async () => plugin.apply(...))`，返回值直接丢掉。所以真正的卸载路径
   是绑在 ctx 上的副作用（`ctx.on('dispose', …)`），同时仍然返回幂等 `dispose`
   供测试和会消费返回值的宿主使用。
2. **审批没有「按 id 答复」的 API**。唯一的公开途径是
   `'approval/request'` waterfall：返回 `'allowed-once'` 放行、`'rejected'` 拒绝，
   或调 `next()` 委托给别人。提问同理走 `'user-questions/request'` waterfall。
   `InteractionBridge` 把这两个 waterfall 桥接成「发一条 IM 消息，等按钮回来」。
3. **不要在 agent 级监听器里 `await agent.whenIdle()`**——宿主的类型注释明确警告会死锁。
   完成门控只在 `session/event`（非 agent 事件）里查 `agent.status`。

---

## 🛠️ 开发

本仓库统一使用 **pnpm**（见根目录 `AGENTS.md`）：

```powershell
# 类型检查（tsc --noEmit，零错误）
pnpm --filter dsh-plugin-tlnotify run typecheck

# 构建产物：dist/index.js (ESM) + dist/index.cjs (CJS) + dist/index.d.ts
pnpm --filter dsh-plugin-tlnotify run build

# 单元测试（零网络：全部使用假宿主对象）
pnpm --filter dsh-plugin-tlnotify run test

# 全工作区递归构建
pnpm run build
```

---

## 📄 License

MIT License。本项目是 DeepSeek Harness 的第三方插件，与 DeepSeek 官方无隶属关系。

第三方依赖与参考项目的声明见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
