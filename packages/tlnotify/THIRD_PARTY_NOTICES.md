# 第三方声明（THIRD_PARTY_NOTICES）

本文件记录 `dsh-plugin-tlnotify` 的运行时依赖、构建期依赖（其代码会被打进客户端产物）、
以及在设计与实现过程中参考过的同类开源项目。**`src/` 下的代码均为本仓库原创**；第一节
「构建期内联」小节列出的依赖属于例外——它们的编译产物随 `web/client.js` 一起分发。
第二节列出的是「读过其协议实现、据此确认平台行为」的项目，按许可证要求在此致谢并声明来源。

---

## 一、运行时依赖

### `@tencent-connect/qqbot-nodejs`

- 版本：`^1.0.4`
- 许可证：MIT
- 用途：QQ 机器人官方 Node.js SDK。本插件用它建立 WebSocket 长连接、收发
  C2C / 群聊消息、发送 `keyboard` 按钮并接收按钮回调。
- 声明位置：`package.json` 的 `dependencies`（**强依赖**）。
  它是 QQ 通道唯一的网络层，体积小（唯一运行时依赖 `ws`），因此不做成可选依赖。
- 上游：<https://github.com/tencent-connect/qqbot-nodejs>

### `@larksuiteoapi/node-sdk`

- 版本：`^1.74.0`
- 许可证：MIT
- 用途：飞书（Lark）官方 Node.js SDK。本插件用它建立长连接（`WSClient`）、
  接收 `im.message.receive_v1` 与 `card.action.trigger` 事件、发送与更新交互卡片。
- 声明位置：**不在 `package.json` 里声明**，由用户在需要时自行安装：
  `pnpm add @larksuiteoapi/node-sdk`。
  原因有两条：① 该包解包后约 30 MB，只有真正要接飞书通道的用户才需要它，做成
  自动安装的依赖会让只用 QQ 的用户白白付出下载成本；② 插件在
  `FeishuChannel.start()` 里用动态 `import()` 懒加载，未安装时只让**该通道**
  启动失败并给出明确的安装指引，**不影响插件装载，也不影响 QQ 通道**。
- 上游：<https://github.com/larksuite/node-sdk>

### 构建期内联进客户端产物的依赖

设置页（`src/client/**`，构建产物 `web/client.js`）由 esbuild 打成一个自包含的
IIFE，下面两个包的**编译产物会被复制进该文件并一起分发**，因此在这里单独声明。
它们只在构建时从 `devDependencies` 取用，运行时不 `require` 它们。

#### `qrcode`

- 版本：`^1.5.4`（实际装入 `1.5.4`）
- 许可证：MIT
- 用途：扫码绑定界面里把绑定链接编码成二维码点阵。之所以不自己实现：QR 的版本选择、
  纠错分块与掩码选择出错时表现为「看起来是个正常二维码，但扫不出来」，用成熟实现更稳。
- 本插件只调用它的 `QRCode.create()` 取出模块矩阵，再自行渲染成 SVG `<path>`
  （不注入它生成的 SVG 字符串，避免多一条富文本注入通道）。渲染代码在
  `src/client/qr.ts` 与 `src/client/components/QrCode.tsx`。
- 上游：<https://github.com/soldair/node-qrcode>

#### `dijkstrajs`

- 版本：`1.0.3`
- 许可证：MIT
- 用途：`qrcode` 的依赖（掩码评估用的最短路算法）。它没有独立的 `dependencies`，
  被 esbuild 一并打进产物；`qrcode` 的另外两个依赖（`pngjs`、`yargs`）只在 Node
  端的服务端渲染路径上用到，没有进入产物（已核对 `web/client.js` 中无相关代码）。
- 上游：<https://github.com/tcort/dijkstrajs>

> `react` 与 `react-dom` 虽然也出现在客户端源码里，但它们被 esbuild 声明为
> `external`，**不进入产物**：产物里只保留一个裸 `require("react")`，由宿主 Web 应用
> 提供那一份实例。这是必须的——插件自带 React 会让 hooks 报「invalid hook call」。

---

## 二、参考过的同类项目（未复制源码）

以下是「DSH 会话通知 / IM 桥接」方向上的既有开源实现。本插件在设计阶段阅读了它们的
协议处理代码，用于确认 QQ 与飞书两端的**平台行为细节**（这些细节官方文档并未完整覆盖），
例如：

- QQ 回复消息的 `message_scene.ext` 中 `msg_idx` / `ref_msg_idx` 的编码方式，
  以及 `message_type === 103` 时改从 `msg_elements[0].msg_idx` 取引用 id；
- QQ 被动回复存在「c2c 4 片 / 群聊 5 片」的硬上限，超出后必须切换到主动目标；
- QQ `msg_seq` 必须对同一 `msg_id` 唯一，否则平台会静默丢弃后续分片；
- 飞书卡片按钮的 `value` 可以直接是 JSON 对象，而 QQ 的 `action.data` 必须是字符串。

**本插件的实现是独立编写的**：模块划分、路由表结构、门控 / 去重 / 聚合算法、
渲染格式与配置形态均按 `doc/tlnotify-设计方案.md` 自行设计，未逐行移植上述项目。

### `@xmanrui/dsh-im`

- 许可证：MIT / Apache-2.0（以其仓库声明为准）
- 上游：npm 包 `@xmanrui/dsh-im`
- 说明：包含可读的 `plugin-src/` 源码，其中 `src/channels/qq/*.mjs` 与
  `src/channels/feishu/feishu-runtime.mjs` 是上述平台行为细节的主要来源，
  另外提供了 `injected-context.mjs`（把 IM 回复注入回会话）与
  `lark-sdk-handshake-patch.mjs`（飞书长连接握手补丁）两个可借鉴的思路。

### `@michengai/dsh-im-connect`

- 说明：其依赖中包含 `@larksuiteoapi/node-sdk`，是本插件选择该 SDK 版本的参考之一。

### `dsh-ntfy-remote`

- 说明：`bridge.js` / `config.js` 的通道抽象与配置持久化方式是本插件通道层
  （`Channel` 接口 + `ChannelManager`）的模仿对象。

### `@alotop/dsh-notify-hub`

- 说明：提供了 DSH 会话事件的九类枚举，以及 `TurnAccumulator`（轮次正文累积）
  与 `CompletionGate`（等待 agent 真正空闲再通知）两个概念的成熟写法，
  本插件的 `src/aggregate.ts` 与 `src/gate.ts` 是按同样思路独立实现的。

---

## 三、宿主接口

本插件通过 `cordis`（peerDependency，`^3.0.0`）与 DSH 宿主交互，运行时**不直接
依赖**任何 `@deepseek-ai/*` 包——`src/` 下所有宿主对象都以结构化类型（`SessionLike`、
`AgentLike`、`SessionEventLike` 等）声明在 `src/events.ts` 与 `src/inject.ts` 中。
这样做是因为插件安装在用户自己的 profile 里，裸模块名解析不到宿主的 `node_modules`。

---

## 四、许可证

本插件自身以 **MIT** 许可证发布，见 `LICENSE`。上述依赖各自的许可证以其包内声明为准。
