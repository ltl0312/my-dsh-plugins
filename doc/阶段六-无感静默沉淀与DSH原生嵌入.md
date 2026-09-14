# 阶段六：会话无感静默沉淀 + DSH 原生侧边栏 / 主视口嵌入

本文档记录 `dsh-plugin-tlmemory` 阶段六升级的设计决策、DSH 官方契约依据、
实现要点与验证指引。对应版本 v0.2.0。

## 1. 目标

1. **会话无感记忆沉淀（无需手动提示存入）**：在会话轮次结束时静默提取本轮
   关键工程结论、用户偏好与决策规则，异步写入 SQLite (FTS5) 数据库；全程
   try-catch 容错与静默降级，严禁阻塞或打扰正常会话对话流。
2. **DSH 原生侧边栏入口 + 中心主视口（Sub-view）嵌入**：点击左侧导航栏图标后，
   DSH 客户端中心主体视口内嵌渲染看板 `http://127.0.0.1:4890`，同时严格保持
   左侧边栏、右侧工具抽屉及顶部底部外壳布局不变。

## 2. DSH 官方运行契约（唯一事实来源）

### 2.1 会话事件流 `session/event`

来源：`@deepseek-ai/dsh-session`（dsh-session 文档：持久化插件官方推荐
订阅 `session/event`，事件为追加式日志的逐条发布）。

- 事件总线信号：`'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent)`。
  根上下文监听器可观察到全部会话；监听器抛错由宿主捕获隔离，绝不阻断提交。
- 事件统一信封：`{ type, seq, time, data }`。
- 本插件消费的事件类型与载荷：

| 事件 | data 结构 | 用途 |
| --- | --- | --- |
| `turn/start` | `{ turn }` | 开启轮次素材缓冲 |
| `user/message` | `UserMessage`（`content: ContentBlock[]`，`source: MessageSource`） | 仅 `source.kind === 'user'` 视为真实人类输入，预热召回缓存 + 轮次素材 |
| `assistant/message` | `{ turn, step, message: AssistantMessage }` | 聚合本轮助手可见文本 |
| `turn/end` | `{ turn, reason: TurnEndReason }` | 仅 `reason.kind === 'completed'` 派发静默沉淀 |

- `TurnEndReason.kind`：`completed | aborted | blocked | error | max-tokens | interrupted`。
- 内容块：`{ type: 'text', text }` 为可见文本；`reasoning / image / tool-call /
  tool-result` 不进入记忆素材。

> **重要修复**：旧实现监听器签名 `(event: any)` 与实际契约 `(session, event)` 不符，
> 且读取 `event.content` / `event.last_assistant_message` 与真实信封结构不匹配，
> 导致自动沉淀实际从未生效。阶段六已按契约重写。

### 2.2 客户端插件契约（浏览器半边）

来源：`@deepseek-ai/dsh-client-modules`（宿主编排）与 `dsh-client-ui-slots`（插槽）。

- 包声明：`package.json` 增加 `dsh.client = { platform: "web", inject: [...] }`，
  并将 `exports["./client"]` 指向构建产物（宿主 `ClientModuleRegistry` 扫描
  Loader 条目，读取产物逐字节快照并编入 `window.__DSH_BOOT__` 启动图）。
- 捆绑包协议：
  ```js
  window.__ModuleLoader__.load({
    id: "<包名>",                                  // 必须等于 npm 包名
    factory: (require) => { /* CJS 风格产物 */ ; return exports }  // 导出 apply/inject
  })
  ```
- 浏览器静态模块表（仅可 require 的模块名）：`react`、`react/jsx-runtime`、
  `react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`。
- 插槽注册（`ctx.slots.inject(name, () => ctx.slots.register({...}, Component))`）：

| 插槽 | kind / scope | 语义 |
| --- | --- | --- |
| `conversation.view` | list / session | 中心主视口可切换子视图：会话头部页签（Chat / Trajectory / 记忆看板），选中后主视口整体切换，外壳不动 |
| `sidebar.footer.action` | list / root | 左侧导航栏底部加性席位：新 id 不替换任何既有入口（官方指引优先采用） |
| `shell.overlay` | list / root | 全帧悬浮层（badge/toast；点击穿透） |

> 官方指引（`cordis-plugin-development` skill）：小侧边栏动作优先用 `sidebar.footer.action`
> 等加性内层插槽；绝不直接注册 `sidebar` / `conversation` / `details` 单占席位
> （会整体替换既有区域及其子插槽）。

- 视图激活：`ctx.uiConversation.binding(sessionId).activate(viewId)`；
  当前会话：`ctx.sessions.list.getSnapshot().current`。

## 3. 实现要点

### 3.1 Node 侧（Host）

- `src/turn-tracker.ts`：纯同步轮次折叠器。来源过滤（仅 `kind === 'user'`）、
  有界缓冲（默认 8000 字符封顶）、完成态门禁（非 completed 一律丢弃素材）、
  畸形输入静默收敛。
- `src/extractor.ts`：启发式门禁（含间接提示词注入样本前缀识别）→ 活跃 LLM
  流式结构化抽取（prompt 显式覆盖「关键工程结论 / 用户偏好 / 决策规则」三类）→
  原子化净化（content ≤ 80 字、路径分段白名单、简名白名单）。纯逻辑以具名函数
  导出便于单测；整条链路 try-catch 静默降级（LLM 未就绪 / 流中断 / JSON 畸形均
  只落日志）。
- `src/index.ts`：按 `(session, event)` 契约接线；`turn/end`（completed）经
  `setImmediate` 派发后台任务，`extractAndConsolidate → notifyTreeChanged`，
  双保险 try-catch；新增 `serverEnabled` 配置支持多宿主并存。

### 3.2 客户端（Browser）

- `src/client/logic.ts`：纯逻辑（看板地址、健康探测降级、当前会话视图激活），
  Node 侧可单测。
- `src/client/index.tsx`：注册 `conversation.view`（主视口页签 + 全幅 iframe）与
  `sidebar.footer.action`（左侧导航图标；点击激活当前会话的 tlmemory 视图）。
- `scripts/build-client.mjs`：esbuild 打包 → `web/client.js`
  （`__ModuleLoader__.load` 协议，react 等静态表模块保持 external）。

## 4. 本地装配（自动更新完成）

| Profile | 变更 |
| --- | --- |
| `~/.dsh/profiles/default` | 既有 `dsh-plugin-tlmemory: file:...` 依赖 + `cordis.patch.yml` insert（旧拓扑常驻宿主，当前未运行） |
| `~/.dsh/profiles/web` | `package.json` 增加 `file:` 依赖；`cordis.patch.yml` insert（`serverEnabled: true` 单一宿主自洽拓扑）；`pnpm-workspace.yaml` 放行 `better-sqlite3: true`；`node_modules` 已离线链接并补齐原生二进制 |

> 已观测：web 宿主（GUI）重启后成功挂载 tlmemory（`~/.dsh/tlmemory.db` 被宿主独占锁定），
> 客户端插件随 `dsh.client` 声明编入浏览器启动图。

## 5. 验证运行与访问

1. **重启 GUI 宿主**（web profile：`dsh web` 或桌面端）使新插件条目进入 loader
   与客户端启动图；
2. 刷新浏览器 → 左侧导航栏底部出现「记忆看板」图标，会话头部出现「记忆看板」页签；
3. 点击图标 → 中心主视口切换为 4890 看板（左侧边栏 / 右侧抽屉 / 顶底外壳不变）；
4. 直接访问 `http://127.0.0.1:4890` 打开看板；`GET http://127.0.0.1:4890/api/nodes`
   返回记忆树 JSON；
5. 与 GUI 正常对话数轮（completed 轮次）→ 看板树自动出现静默沉淀叶子；
   GUI 宿主日志出现 `[tlmemory] 静默沉淀入库 [...]`；
6. 质量门禁：`cd packages/tlmemory && pnpm test`（42 用例全绿）、
   `pnpm build`（dist + web/client.js）、`cd web && pnpm build`（web/dist）。