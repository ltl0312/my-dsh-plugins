# my-dsh-plugins

DeepSeek Harness（DSH）第三方插件单仓库（pnpm workspace）。

## 插件清单

| 包 | 说明 |
| --- | --- |
| [`packages/tlmemory`](packages/tlmemory) | `dsh-plugin-tlmemory` 跨会话、跨项目树状长期记忆插件（SQLite FTS5 Trigram + 无感静默沉淀 + DSH 原生侧边栏/主视口嵌入） |

## dsh-plugin-tlmemory

### 核心能力（v0.2.0）

1. **会话无感静默沉淀**：依据 DSH 官方 `session/event` 契约
   （`(session, event)` 双参、事件统一 `{ type, seq, time, data }` 信封），
   在 `turn/end`（`reason.kind === 'completed'`）时非阻塞派发后台提炼任务：
   复用宿主活跃 LLM 流式抽取「关键工程结论 / 用户偏好 / 决策规则」，
   原子化断言（≤80 字）写入 SQLite FTS5 Trigram 索引。全程 try-catch
   静默降级，不阻塞、不打扰会话对话流；`setImmediate` 后台执行，主响应零损耗。
2. **DSH 原生客户端嵌入**：`web/client.js` 为 DSH 客户端插件（浏览器半边），
   注册两个原生插槽——
   - `sidebar.footer.action`：左侧导航栏底部「记忆看板」图标入口；
   - `conversation.view`：中心主视口「记忆看板」页签（全幅 iframe 嵌入
     `http://127.0.0.1:4890` 看板，左侧边栏 / 右侧工具抽屉 / 顶底外壳布局不动）。
3. **双轨召回注入**：`user/message`（`source.kind === 'user'`）同步预热
   `systemPrompt.section` 内存缓存，项目记忆叠加作用域偏置，XML 实体转义防逃逸。

### 工程结构

```text
packages/tlmemory
├── src/
│   ├── index.ts            # 插件装配中心（session/event 契约接线 + 注销收敛）
│   ├── types.ts            # 领域模型 + cordis Context/Events 类型合并
│   ├── db.ts               # SQLite 物化路径 + FTS5 Trigram（WAL）
│   ├── recall.ts           # 复合加权召回 + 系统提示词格式化（XML 转义）
│   ├── extractor.ts        # 异步反思提炼（启发式门禁 + LLM 结构化抽取 + 原子化截断）
│   ├── turn-tracker.ts     # 轮次生命周期折叠（来源过滤 + 有界缓冲 + 完成态门禁）
│   ├── server.ts           # 内嵌 127.0.0.1 HTTP/WS 管理服务（回环绑定 + Host/Origin 校验）
│   ├── tools.ts            # tlmemory_save / tlmemory_query 主动存取工具
│   └── client/             # DSH 客户端插件源码（logic.ts 纯逻辑 + index.tsx 插槽注册）
├── web/                    # Vue 3 看板前端（vite 构建 → web/dist，随包静态服务）
│   └── client.js           # 客户端插件捆绑包（构建产物，提交入库）
├── scripts/build-client.mjs# 客户端捆绑包构建脚本（esbuild → __ModuleLoader__.load 协议）
└── tests/                  # vitest 单测（42 用例）
```

### 构建与测试

```bash
# 根工作区（全部子包）
pnpm install --offline          # 离线安装（store 内已有全部依赖）
pnpm -r run build               # 后端 tsup + 客户端捆绑 + 前端 vite
pnpm run test                   # 全工作区单测（42 passed）

# 仅 tlmemory
cd packages/tlmemory
pnpm build        # tsup(dist) + build:client(web/client.js)
pnpm test         # vitest run
cd web && pnpm build   # 前端 web/dist
```

### DSH 装配（本地 Profile）

插件通过 cordis patch 零侵入挂载（无需改动 DSH 官方代码）：

- **default 宿主**（常驻内存服务宿主，提供 4890 看板）：见
  `cordis.patch.example.yml`，`serverEnabled` 缺省为 `true`；
- **web 宿主**（GUI 宿主，承担会话沉淀 + 客户端插件注册）：`serverEnabled: false`
  避免与 4890 常驻服务重复绑定端口，两侧共用 `~/.dsh/tlmemory.db`（SQLite WAL
  支持多进程读写）。客户端插件由 DSH `ClientModuleRegistry` 依据包内
  `dsh.client` 声明 + `exports["./client"]` 自动编入浏览器启动图（boot graph）。

### 验证运行与访问

1. 重启 GUI 宿主（`dsh web` / 桌面端）使新插件挂载生效；
2. 刷新浏览器：左侧导航栏底部出现「记忆看板」图标，会话头部页签出现「记忆看板」；
3. 点击入口 → 中心主视口切换为 `http://127.0.0.1:4890` 记忆看板（外壳布局不变）；
4. 直接访问 `http://127.0.0.1:4890` 亦可打开看板；`GET /api/nodes` 返回记忆树；
5. 正常对话数轮后（completed 轮次），看板树自动出现静默沉淀的新记忆叶子；
   日志出现 `[tlmemory] 静默沉淀入库 [...]` 即代表链路打通。
