# dsh-plugin-tlmemory

> DeepSeek Harness (DSH) 原生无感记忆与自省管理插件。

为 DeepSeek Harness 提供会话级静默记忆提炼持久化、SQLite FTS5 全文检索，以及与 DSH 官方 Shell（如 SSH、任务看板）100% 深度融合的一级主视口记忆看板。

---

## ✨ 核心特性

- **无感静默沉淀**：基于 DSH 官方 `session/event` 契约监听 `turn/end` (completed) 事件，静默后台提炼关键工程结论、用户偏好与决策规则，不抢占推理上下文。
- **全局一级视口**：与 DSH 内置「SSH / 任务看板」同级，常驻左侧导航栏核心区，一键切换主视口并支持 `‹ 返回会话` 快捷回退。
- **多工程记忆选择**：顶部下拉框自动列出库中所有存在记忆记录的工程（`GET /api/projects` 把不可读的 `repo:<hash>` 反解为可读工程名），切换即换树；全局偏好独立胶囊，与工程记忆明确区隔。
- **树状图谱视图**：与「📋 目录列表」一键互切的自顶向下多叉树，SVG 贝塞尔连线、拖拽平移与滚轮缩放、一键居中；检索时命中节点青色发光、整条父级路径连线加粗、未命中节点淡化，点击叶子直接唤起 Markdown 详情抽屉。
- **主题自适应穿透**：采用透明通道透传 DSH 官方主题底色，深色/浅色皮肤实时自适应无缝融合。
- **Markdown 详情抽屉**：记忆卡片列表仅展示关键简介，点击从右侧平滑滑出详情抽屉，支持安全沙箱渲染的完整 Markdown 阅读与一键复制。
- **SQLite FTS5 全文检索**：底层持久化采用 SQLite FTS5 分词索引，支持毫秒级全文精确检索。
- **单一宿主自洽**：通过 Cordis 补丁由 DSH Web 宿主自动托管 HTTP 服务（端口 4890），无需手动运行单独后台守护进程。

---

## 📦 安装方式

### 方式一：一条命令安装并自动挂载（推荐）

```powershell
dsh plugin --profile web add dsh-plugin-tlmemory

# 本地源码目录
dsh plugin --profile web add "file:D:/Code/my-dsh-plugins/packages/tlmemory"
```

`dsh plugin add` 会自动完成下面三件以前需要手工做的事：装依赖 → 放行原生模块
（`pnpm-workspace.yaml` 的 `allowBuilds`）→ 往 `cordis.patch.yml` 追加挂载条目（幂等）。
另外 `dsh plugin --profile web list` 可查看挂载状态，`dsh plugin --profile web remove <包名>`
可一键摘除补丁并卸载。

### 方式二：手工安装（等价于方式一的三步）

进入你的 DSH profile 目录（例如 `~/.dsh/profiles/web`）：

```powershell
cd ~/.dsh/profiles/web

# 从 npm 安装
pnpm add dsh-plugin-tlmemory

# 或从本地源码目录软链接
pnpm add "file:D:/Code/my-dsh-plugins/packages/tlmemory"
```

若安装过程中 pnpm 提示 `Ignored build scripts`（例如 `better-sqlite3`），
在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 中放行该原生模块后重新安装：

```yaml
allowBuilds:
  better-sqlite3: true
```

> 注意键名：pnpm 11 用的是 `allowBuilds`（映射），不是 pnpm 10 的
> `onlyBuiltDependencies`（数组）。pnpm 拦下构建时会自己往这里写一行
> `better-sqlite3: set this to true or false` 占位，改成 `true` 即可。

---

## ⚙️ 配置与挂载

编辑 Profile 目录下的补丁文件 `~/.dsh/profiles/web/cordis.patch.yml`，挂载插件即可
（看板服务随宿主**零配置自启**，无需任何开关声明）：

```yaml
- insert:
    - id: tlmemory-runtime
      name: "dsh-plugin-tlmemory"
      config:
        serverPort: 4890           # 看板服务端口（默认 4890）
        maxRecallCount: 5          # 单轮最多注入系统提示词的记忆条数
        enableAutoReflection: true # 会话结束异步自动反思提炼
        compactionInterval: 20     # 每累计 N 次沉淀触发一轮强化衰减 + 矛盾检测
```

> 端口冲突自愈：4890 被前序 tlmemory 实例占用时，新实例会经健康探测确认同名进程
> 后自动复用（多宿主并存无需手工分工）；被无关进程占用时自动顺延端口；连续顺延
> 仍失败时在控制台打印 EADDRINUSE 排查指引。

---

## 🚀 启动与使用

### 1. 启动 DSH Web 宿主

在任意终端路径下直接启动：

```powershell
dsh web
```

> Node 版本：运行需 Node >= 22；由于 `better-sqlite3` 是原生模块，**建议统一用 Node 24**
> （原生二进制的 ABI 必须与运行它的 Node 匹配，混用会报 `NODE_MODULE_VERSION` 不匹配）。

### 2. 访问记忆看板

1. 打开浏览器进入 DSH 界面（通常为 http://127.0.0.1:3080）。
2. 在左侧边栏顶部（「+ 新会话」下方、「技能中心」旁）点击 **「记忆看板」**。
3. 中间主视口将平滑接管展示记忆树：顶部下拉框切换任意工程（默认选中当前所在工程），
   「全局偏好」胶囊单独查看跨工程偏好；右上角滑块在「📋 目录列表」与「🌲 树状图谱」
   之间切换，选中工程、搜索关键词与图谱的平移缩放都会原样保留。
4. 正常进行对话，每个完成的回合（Turn）将由后台自动提炼关键信息沉淀入库。

---

## 🛠️ 项目常用命令（开发与测试）

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

> 根目录 `pnpm run build` 是递归构建（workspace 同时包含 `packages/tlmemory` 与
> `packages/tlmemory/web`），因此 `dist/`、`web/client.js`、`web/dist/` 会被一并刷新 ——
> 发包前跑这一条即可。单独构建看板前端用 `pnpm --dir packages/tlmemory/web run build`。

---

## 📄 License

MIT License
