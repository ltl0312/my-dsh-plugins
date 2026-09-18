# dsh-plugin-tlmemory

> DeepSeek Harness (DSH) 原生无感记忆与自省管理插件。

为 DeepSeek Harness 提供会话级静默记忆提炼持久化、SQLite FTS5 全文检索，以及与 DSH 官方 Shell（如 SSH、任务看板）100% 深度融合的一级主视口记忆看板。

---

## ✨ 核心特性

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

## 📦 安装方式

### 方式一：一条命令安装并自动挂载（推荐）

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

### 方式二：手工安装（等价于方式一的三步）

进入你的 DSH profile 目录（例如 `~/.dsh/profiles/web`）：

```powershell
cd ~/.dsh/profiles/web

# 从 npm 安装
pnpm add dsh-plugin-tlmemory
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
>
> 禁区端口自检：浏览器与 `fetch` 共同封禁的端口（如 3659 / 4045 / 4190 / 5060 /
> 5061 / 6000 / 6566）无法打开看板也无法被 HTTP 客户端访问，绑定后会被自检识别并
> 自动换端口重试 —— 配置 `serverPort: 0` 交由系统分配时同样保证落在可用端口上。

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
