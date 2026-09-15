# 阶段六：会话无感静默沉淀 + DSH 原生侧边栏 / 主视口嵌入

本文档记录 `dsh-plugin-tlmemory` 阶段六升级的设计决策、DSH 官方契约依据、
实现要点与验证指引。阶段六自 v0.2.0 起引入，后续版本持续演进
（§7 记录 v0.2.2 / v0.2.3 的增量）；**涉及具体版本号、用例数、产物字节数的表述以
源码与根目录 `README.md` 为准**。

## 1. 目标

1. **会话无感记忆沉淀（无需手动提示存入）**：在会话轮次结束时静默提取本轮
   关键工程结论、用户偏好与决策规则，异步写入 SQLite (FTS5) 数据库；全程
   try-catch 容错与静默降级，严禁阻塞或打扰正常会话对话流。
2. **全局一级主视图（中心列接管）**：左侧边栏顶部与「任务看板 / SSH / 技能中心」
   并列常驻一个「记忆看板」入口；点击后中心主视口整幅内嵌渲染看板
   `http://127.0.0.1:4890`，顶部带标准「‹ 返回会话」回退头，左右外壳与会话子树
   保持挂载；**不弹窗、不打开外部窗口**（见 §6 架构变更）。

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

- 视图激活（**已废弃**，见 §6）：`ctx.uiConversation.binding(sessionId).activate(viewId)`
  **不会切换可见页签**（只把 target 登记进 target-neutral assembly 的 active set），
  而 `conversation.view` 的可见切换由会话 store 的 `view` 字段决定，外部插件写不进去。
  因此本插件已彻底放弃「会话内子页签」形态，改为与家族插件同规格的中心列 DOM 接管。

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

全局一级主视图形态（`conversation.view` / `sidebar.footer.action` 均已移除）：

- `src/client/logic.ts`：纯逻辑（看板地址、健康探测降级、面板状态机、
  中心列单占协议常量与广播序列），Node 侧可单测。
- `src/client/sidebar-entry.ts`：侧栏顶部入口行的 DOM 注入与自愈
  （插到 New Session 行之后的家族块末尾，与任务看板 / SSH / 技能中心并列）。
- `src/client/panel-mount.ts`：中心列单占接管（容器注入 / `<html>` 激活属性 /
  兄弟面板让步与广播 / 会话行点击收拢 / 整树重建重挂 / 卸载还原）。
  不依赖 react-dom —— 面板树以 `mount(container)` 回调注入。
- `src/client/styles.ts`：注入一张属性 / 类名前缀化的样式表（接管规则 + 入口行 +
  面板内部），色值走 `--dsw-alias-*` 令牌。
- `src/client/index.tsx`：`apply` 装配（DOM 幂等 + `ctx.effect` 回收）+
  `MemoryDashboardPanel`（标准回退头 + 健康状态点 + 全幅 iframe + 视口内遮罩）。
- `scripts/build-client.mjs`：esbuild 打包 → `web/client.js`
  （`__ModuleLoader__.load` 协议；`react` / `react/jsx-runtime` /
  `react-dom/client` 为 shell 静态模块表名，保持 external）。
- 测试：`tests/client-logic.spec.ts`（纯逻辑）+ `tests/client-dom.spec.ts`
  （jsdom 下的真实 DOM 注入 / 单占协调 / 卸载还原）。

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
2. 刷新浏览器 → 左侧边栏顶部出现「记忆看板」入口，与任务看板 / SSH / 技能中心并列；
3. 点击入口 → 中心主视口整幅切换为 4890 看板，顶部为「‹ 返回会话 | 记忆看板」，
   左侧边栏 / 右侧抽屉 / 顶底外壳均不变，无任何外部窗口；
4. 直接访问 `http://127.0.0.1:4890` 打开看板；`GET http://127.0.0.1:4890/api/nodes`
   返回记忆树 JSON；
5. 与 GUI 正常对话数轮（completed 轮次）→ 看板树自动出现静默沉淀叶子；
   GUI 宿主日志出现 `[tlmemory] 静默沉淀入库 [...]`；
6. 质量门禁：`cd packages/tlmemory && pnpm test`（当前 104 用例全绿）、
   `pnpm build`（dist + web/client.js）、`cd web && pnpm build`（web/dist）、
   `pnpm run smoke:client`（jsdom 加载真实产物走查装配）；根目录另有
   `pnpm run test:cli` / `pnpm run install:cli` 对应 dsh CLI 增强层（见 §7）。

## 6. 客户端注册架构改造：改为全局一级主视图（2026-09-15）

### 6.1 为什么推翻旧形态

旧实现注册 `conversation.view`（会话内子页签）+ `sidebar.footer.action`（左下角底栏），
两个位置都不对，且存在两个硬缺陷：

1. **位置错**：入口在左下角底部、视图在会话头部页签里，不是「与任务看板 / SSH /
   技能中心并列的全局一级主视图」；
2. **切换不可靠**：`conversation.view` 的可见视图由会话 store（`dsh.conversation`）
   的 `view` 字段决定，该字段只由 shell 自己的页签按钮或 slot 注入给「已激活视图」
   的 `openView(view, focus)` 写入；外部插件两者都拿不到，
   `uiConversation.binding(id).activate(target)` 只登记装配层 target、不切页签。
   旧实现因此在找不到页签时退化到 `window.open` 开外部窗口 —— 与目标形态相悖。

### 6.2 家族实现逆向（唯一可靠依据）

宿主内置包里**没有**可用的全局导航 / 主视口插槽：sidebar shell 只声明
`sidebar.brand.mark` / `brand.name` / `workspaces` / `settings` / `footer.action`，
中心列（`conversation`）是 `ui-conversation` 持有的单占席位，且外部插件不能声明插槽。
宿主内既有的三个同级入口（`@linxin666/dsh-client-ui-task-board`、
`@linxin666/dsh-ssh`、`@linxin666/dsh-client-ui-skill-explorer`）统一采用
**DOM 级接管**，本插件改为与它们完全同规格：

| 环节 | 家族做法（本插件照搬） |
| --- | --- |
| 侧栏入口 | 纯 DOM 注入到 shell 的 New Session 行之后、工作区之前；MutationObserver 自愈；家族块相对定位保证与兄弟入口的次序稳定 |
| 中心视图 | 容器作为中心列（`[data-pane="conversation"], [class*="centerCol"]`）的尾部子节点注入；`position:absolute; inset:0; z-index:60`；显隐由 `<html>` 激活属性驱动；激活期间隐藏会话内容（子树保持挂载） |
| 单占协调 | `<html>` 上的 `data-dsh-*-active` 互斥 + `dsh-panel-activate` CustomEvent 广播；点会话行即收拢 |
| 回退头 | `‹ 返回会话` ghost 按钮，带家族共享钩子 `data-dsh-center-view-back` |
| 面板树 | 独立 React 根（`react-dom/client` 的 `createRoot`），容器留在 DOM 内、未激活时仅隐藏 |

### 6.3 本插件新增的单占细节

- **代播兄弟 detail**：任务看板只对 `ssh` 退场、SSH 只对 `taskboard` 退场，两者都不认识
  `tlmemory`。因此本面板激活时按「`taskboard` → `ssh` → `tlmemory`」顺序广播，
  兄弟面板的控制器状态才能真正收敛（否则它们的侧栏入口仍高亮，再点会「没反应」）。
- **来源标记**：代播的兄弟 detail 会同时被本插件自己的监听端收到，若不加标记就会
  「打开即关闭」。广播事件上打 `__dshPanelActivateOrigin = 'tlmemory'`，
  `shouldRelinquishColumn(event)` 对自播事件一律返回 false（回归用例已覆盖）。
- **样式注入**：本插件走 esbuild 直接打包，没有 CSS Module 处理链路，
  因此注入一张属性 / 类名前缀化的普通样式表（`styles.ts`），
  接管显隐规则留在表内随插件一起加载。

### 6.4 文件与产物

| 文件 | 变化 |
| --- | --- |
| `src/client/logic.ts` | 重写：去掉插槽 / 会话相关逻辑，新增面板状态机、单占协议常量与广播判定 |
| `src/client/sidebar-entry.ts` | 新增：侧栏入口行注入 + 自愈 + 高亮 + 幂等 |
| `src/client/panel-mount.ts` | 新增：中心列接管生命周期（不依赖 react-dom） |
| `src/client/styles.ts` | 新增：注入样式表（属性作用域，不泄漏） |
| `src/client/index.tsx` | 重写：`apply` 装配 + `MemoryDashboardPanel`（回退头 / 状态点 / 全幅 iframe / 视口内遮罩）；`inject = []` |
| `src/client/types.d.ts` | 补 `react-dom/client`（createRoot）与 setState 更新函数形态；移除已不用的 slots / sessions / uiConversation 声明 |
| `scripts/build-client.mjs` | external 增加 `react-dom/client` |
| `package.json` | `dsh.client.inject` 从错误的服务名改为 `[]` |
| `tests/client-logic.spec.ts` | 重写为纯逻辑用例（地址 / 探测 / 状态机 / 单占协议） |
| `tests/client-dom.spec.ts` | 新增 jsdom 用例（入口注入排序与自愈、接管属性与广播、卸载还原） |

产物：`web/client.js` 42394 bytes（含 `require("react")` / `require("react-dom/client")`），
已同步至 `~/.dsh/profiles/web/node_modules/dsh-plugin-tlmemory/`。

## 7. v0.2.2 / v0.2.3 增量（在阶段六形态之上）

§6 完成「中心列整幅接管」后，又按用户反馈做了两轮改造，细节见根 `README.md` 的
核心特性与 `tools/dsh-plugin-cmd/`、`src/client/theme.ts` 等源码：

### 7.1 与宿主主题实时自适应（透明透传）

- 新增 `src/client/theme.ts`：宿主配色读数与订阅（优先级
  `body/html[data-ds-dark-theme]` → `[data-ds-light-theme]` → `data-theme`/`data-dsw-theme`
  文本值 → `matchMedia` 回落）；订阅用 MutationObserver 精确盯 `documentElement` 与
  `body` 的属性（**不用 subtree**，否则 hover 类名抖动都会触发读数）。
- 新增 `src/client/frame.ts`：`allowtransparency` / `background` 遗留属性 + 内联样式，
  经 ref 落到真实 iframe 元素，规避 React 各版本对遗留属性白名单的差异。
- 主题经 `postMessage` 双向握手同步（iframe 加载完成 + 子文档发 `ready` 各推一次），
  解决「iframe src 先加载、面板后挂载」导致首帧丢推的问题。
- 面板容器不再自带 `--dsw-alias-bg-base` 不透明底，改为 `transparent`：宿主主题背景
  穿透到看板之下。**看板侧 `:root` 上绝不能写 `color-scheme`** —— 根元素背景透明时
  画布会被所用色彩方案的基础色填满，透明透传直接失效（`backgroundColor` 仍是
  `rgba(0,0,0,0)`，只看计算样式查不出来）；该声明改放在 `.tlm-app` / `.tlm-drawer` 上。

### 7.2 看板前端（Vue）交互改造

- 折叠箭头由 `▼`/`▶` 文本字符改为统一的 14×14 SVG chevron + CSS 旋转过渡
  （展开 90° 朝下 / 收起 0° 朝右），消除字形差异导致的尺寸与基准线跳动。
- 记忆列表项只渲染简介（`line-clamp: 2`）与元数据（置顶 / `×N`），点击从右侧滑出
  Markdown 详情抽屉：新增 `web/src/components/MemoryDetailDrawer.vue`、
  `web/src/lib/markdown.ts`（`marked` 收口：转义原始 HTML、链接协议白名单、
  不产出 `<img>`），配色统一走 `web/src/style.css` 的 `--tlm-*` 令牌层。
- 面板顶部标题栏右侧留 48px 宿主安全区（`.tlmemory-header { padding-right: 48px }`），
  状态胶囊与标题同基准线左对齐 —— 避免盖住宿主右上角的抽屉折叠按钮。

### 7.3 dsh CLI 增强层（可选，不影响插件本体）

`tools/dsh-plugin-cmd/` 给官方 `dsh plugin` 补上「装完自动放行原生构建 + 自动写
`cordis.patch.yml` 挂载」，即：

```powershell
dsh plugin --profile web add dsh-plugin-tlmemory
dsh plugin --profile web list
dsh plugin --profile web remove dsh-plugin-tlmemory
```

安装/刷新用 `pnpm run install:cli`（**每次升级 `@deepseek-ai/dsh` 都会覆盖 bin.js，
需重跑一次**），回滚 `install.mjs --uninstall`。单测 `pnpm run test:cli`。

