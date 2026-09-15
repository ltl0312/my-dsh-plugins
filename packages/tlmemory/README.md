# dsh-plugin-tlmemory

> DeepSeek Harness (DSH) 原生无感记忆与自省管理插件。

为 DeepSeek Harness 提供会话级静默记忆提炼持久化、SQLite FTS5 全文检索，以及与 DSH 官方 Shell（如 SSH、任务看板）100% 深度融合的一级主视口记忆看板。

---

## ✨ 核心特性

- **无感静默沉淀**：基于 DSH 官方 `session/event` 契约监听 `turn/end` (completed) 事件，静默后台提炼关键工程结论、用户偏好与决策规则，不抢占推理上下文。
- **全局一级视口**：与 DSH 内置「SSH / 任务看板」同级，常驻左侧导航栏核心区，一键切换主视口并支持 `‹ 返回会话` 快捷回退。
- **主题自适应穿透**：采用透明通道透传 DSH 官方主题底色，深色/浅色皮肤实时自适应无缝融合。
- **Markdown 详情抽屉**：记忆卡片列表仅展示关键简介，点击从右侧平滑滑出详情抽屉，支持安全沙箱渲染的完整 Markdown 阅读与一键复制。
- **SQLite FTS5 全文检索**：底层持久化采用 SQLite FTS5 分词索引，支持毫秒级全文精确检索。
- **单一宿主自洽**：通过 Cordis 补丁由 DSH Web 宿主自动托管 HTTP 服务（端口 4890），无需手动运行单独后台守护进程。

---

## 📦 安装方式

### 方式一：在 DSH Profile 中作为依赖安装（推荐）

进入你的 DSH profile 目录（例如 `~/.dsh/profiles/web`）：

```powershell
cd ~/.dsh/profiles/web

# 从 npm 安装
pnpm add dsh-plugin-tlmemory

# 或从本地源码目录软链接
pnpm add "file:D:/Code/my-dsh-plugins/packages/tlmemory"
```

### 方式二：放行原生模块（针对 SQLite 原生驱动）

若使用原生驱动，在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 中放行 `better-sqlite3`：

```yaml
packages:
  - '.'
onlyBuiltDependencies:
  - better-sqlite3
```

---

## ⚙️ 配置与挂载

编辑 Profile 目录下的补丁文件 `~/.dsh/profiles/web/cordis.patch.yml`，挂载插件并开启自服务：

```yaml
- insert:
    - id: tlmemory-runtime
      name: "dsh-plugin-tlmemory"
      config:
        serverEnabled: true        # 随 DSH 宿主一并启动 127.0.0.1:4890 看板服务
        serverPort: 4890
        maxRecallCount: 5          # 单轮最多注入系统提示词的记忆条数
        enableAutoReflection: true # 会话结束异步自动反思提炼
```

---

## 🚀 启动与使用

### 1. 启动 DSH Web 宿主

在任意终端路径下直接启动（Node >= 22，推荐 Node 24）：

```powershell
dsh web
```

### 2. 访问记忆看板

1. 打开浏览器进入 DSH 界面（通常为 http://127.0.0.1:3080）。
2. 在左侧边栏顶部（「+ 新会话」下方、「技能中心」旁）点击 **「记忆看板」**。
3. 中间主视口将平滑接管展示当前工程与全局偏好树，支持搜索、目录折叠与 Markdown 阅读。
4. 正常进行对话，每个完成的回合（Turn）将由后台自动提炼关键信息沉淀入库。

---

## 🛠️ 项目常用命令（开发与测试）

```powershell
# 运行单元测试
pnpm run test

# 构建 Node 核心与前端客户端产物
pnpm run build

# 客户端 Bundle 真实冒烟走查
pnpm run smoke:client
```

---

## 📄 License

MIT License
