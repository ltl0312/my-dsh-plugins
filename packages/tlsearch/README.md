# dsh-plugin-tlsearch

> 面向 DeepSeek Harness 的**低 Token 消耗**联网搜索插件。

把「一次搜索」塞进模型上下文的东西压到最少：只返回清洗过的 `{ title, url, snippet }`，
没有提供方散文、没有 Raw HTML、没有埋点参数、没有每轮重复的引用指引。
后端可插拔（Tavily / Brave / SearXNG），端点可自建（SearXNG、new-api 等中转网关）。

---

## ✨ 核心特性

- **结构化最小输出**：每条结果最多两行（`N. 标题 — URL` + 缩进摘要），零装饰词、零填充句。
- **摘要硬上限**：`maxSnippetChars`（默认 250）逐条截断并尽量落在词边界，Token 成本可预算、可封顶。
- **结果数硬上限**：`maxResults`（默认 5，上限 10）——原生 `web_search` 默认 8 条。
- **清洗是确定性的**：剥离 HTML 标签（`<strong>`、`<p>`、`<style>` 正文整块丢弃）、
  解码 HTML 实体（`&#x27;` 6 个字符 → `'` 1 个字符）、折叠换行/制表/NBSP/零宽字符。
- **URL 减负**：剔除 `utm_*` / `fbclid` / `gclid` / `srsltid` 等纯埋点参数，
  保留路径、其余查询参数与 `#hash`；解析失败的 URL **逐字节原样返回**，绝不改写。
- **先去重再截断**：按归一化后的 URL 去重，避免同一篇文章的多个镜像先占满名额再被去重。
- **超时 + 熔断**：每次请求挂 `AbortController` 超时；连续失败 3 次即熔断 60 秒，
  冷却期内**不发网络请求**直接快速失败。调用方主动中断**不计入**熔断。
- **零运行时依赖**：网络层直接用 Node 原生 `fetch` / `AbortSignal`，不引入 axios 等重库。
- **错误可据以行动**：缺凭据、端点错、非 JSON、限流、超时各有分类错误码与修复指引。

---

## 💰 为什么更省 Token（可复现的度量）

用同一批**真实脏数据**（8 条 Brave 风格原始结果：带 `<strong>` 高亮、HTML 实体、
埋点参数、均值 372 字符的长摘要）走真实管线对比：

| 指标 | 原生 `web_search` 风格 | `tlsearch` 默认 | 差异 |
|---|---|---|---|
| 结果条数 | 8 | 5 | −37% |
| 单条摘要字符（均值） | 372（未清洗、无上限） | 248（清洗 + 250 上限） | −33% |
| 单条 URL 字符（均值） | 105（含 `utm_*`/`fbclid`） | 34 | −68% |
| **总字符数** | **4346** | **1608** | **2.70×** |
| 粗估 Token（英文 ≈ 4 字符/token） | ≈ 1087 | ≈ 402 | 2.70× |

节省来自六个确定性机制，其中贡献最大的是**摘要上限**、**结果数上限**与**实体/标签清洗**：

1. 摘要按 `maxSnippetChars` 硬截断（原生工具没有这个旋钮）；
2. 结果数默认 5 条（原生默认 8 条）；
3. 剥离 HTML 标签并解码实体（`&#x27;` → `'` 即 6 字符省到 1 字符）；
4. 剔除 URL 埋点参数；
5. 不返回 `age` / `score` / `engine` / `raw_content` / 图片等元数据；
6. 「引用来源」的整句指引放在**工具描述**里只付一次，而不是每次调用都重复一遍。

> 复现方式：`packages/tlsearch` 构建后，用 `normalizeHits` + `renderOutcome` 处理同一批载荷即可
> 得到上表数字（本插件导出这两个函数，便于自行核对与调参）。

---

## 🔌 支持的后端

| 后端 | 密钥 | 默认端点 | 说明 |
|---|---|---|---|
| `tavily`（默认） | 必需 | `https://api.tavily.com` | 结构化 JSON、字段干净、有免费额度；密钥同时走 `Authorization` 头与请求体，兼容自建/中转网关 |
| `brave` | 必需 | `https://api.search.brave.com` | 请求时关闭 `text_decorations`（源头不产生 `<strong>`）并限定 `result_filter=web` |
| `searxng` | **不需要** | 无（必须自配） | 自托管元搜索；`baseUrl` 必填，并需在实例 `settings.yml` 的 `search.formats` 中启用 `json` |

---

## 📦 安装

### 方式一：一条命令安装并自动挂载（推荐）

```powershell
dsh plugin --profile web add dsh-plugin-tlsearch
```

`dsh plugin add` 会自动装依赖、放行原生模块并往 `cordis.patch.yml` 追加挂载条目（幂等）。

### 方式二：手工安装

```powershell
cd ~/.dsh/profiles/web
pnpm add dsh-plugin-tlsearch
```

---

## ⚙️ 配置

编辑 Profile 目录下的 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: tlsearch-runtime
      name: "dsh-plugin-tlsearch"
      config:
        provider: tavily              # tavily | brave | searxng
        apiKey: "tvly-xxxxxxxxxxxx"   # SearXNG 可留空
        # baseUrl: "https://searx.example.com"   # SearXNG 必填；也可指向自建代理
        maxResults: 5                 # 1-10，默认 5
        maxSnippetChars: 250          # 单条摘要字符上限，默认 250（控制 Token 的主旋钮）
        timeoutMs: 15000              # 单次请求超时（毫秒），默认 15000
        outputFormat: markdown        # markdown（最省）| json
        language: ""                  # 如 zh / en；留空由后端判定
        includeAnswer: false          # 是否附带后端的一句话答案（默认 false 以省 Token）
```

### 配置项

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `provider` | `tavily` | 搜索引擎后端 |
| `apiKey` | `''` | 后端密钥；留空时回退环境变量 |
| `baseUrl` | 后端默认端点 | 自定义端点根地址；SearXNG 必填 |
| `maxResults` | `5` | 返回条数上限（钳制在 1-10） |
| `maxSnippetChars` | `250` | 单条摘要字符上限（钳制在 40-2000） |
| `timeoutMs` | `15000` | 单次请求超时（钳制在 1000-60000） |
| `language` | `''` | 检索语言（Tavily 不发送该字段） |
| `includeAnswer` | `false` | 是否附带一句话答案（Tavily `answer` / SearXNG `answers`） |
| `outputFormat` | `markdown` | `markdown`（最省 Token）或 `json`（结构化，便于精确解析） |

> 越界值一律**钳制**而非报错；`null` / 空串等「未提供」形态退回默认值而不是被压成下限。
> 配置不完整**不会**导致插件装载失败——工具照常注册，调用时返回分类错误，
> 便于模型把「去哪儿补配置」原样转述给你。

### 环境变量回退

配置留空时按顺序回退（通用变量优先于后端专用变量）：

| 用途 | 变量 |
|---|---|
| 通用密钥 | `TLSEARCH_API_KEY` |
| 通用端点 | `TLSEARCH_BASE_URL` |
| Tavily | `TAVILY_API_KEY`、`TAVILY_BASE_URL` |
| Brave | `BRAVE_SEARCH_API_KEY`、`BRAVE_API_KEY`、`BRAVE_BASE_URL` |
| SearXNG | `SEARXNG_BASE_URL` |

### 与原生 `web_search` 的关系

两者可以并存（模型按需选用）。若要**替代**原生搜索，在 `dsh-tool-web` 的配置里关掉它的搜索工具：

```yaml
- id: tool-web
  config:
    search: false   # 保留 web_fetch，仅关闭原生 web_search
```

---

## 🧾 输出格式

模型看到的只有结果本身，没有任何前言后语。

**`outputFormat: markdown`（默认，最省）**

```
1. DeepSeek Harness 文档 — https://example.com/docs
   紧凑的 agent 运行时，支持工具注册与会话事件流。
2. 插件开发指南 — https://example.com/plugins
```

摘要为空时**整行省略**，不会渲染出只有空白的缩进行。零命中时返回
`No results for "查询串".`（回显查询串且截断到 120 字符）。

**`outputFormat: json`**

```json
[{"title":"DeepSeek Harness 文档","url":"https://example.com/docs","snippet":"紧凑的 agent 运行时…"}]
```

恒为 `[{ title, url, snippet }]` 裸数组；开启 `includeAnswer` 时答案单独成块
（`{"answer":"…"}`），**结果块的形状不会漂移**，解析方无需分情况处理。

---

## 🛡️ 超时、熔断与错误分类

- **超时**：每次请求挂 `AbortController`，`timeoutMs` 到点即中止；
  同时向宿主声明 `timeoutMs + 5s` 的工具超时——先由本插件给出分类错误，宿主再兜底硬停。
- **熔断**：连续失败 3 次即熔断，冷却 60 秒。冷却期内**不发网络请求**，
  直接返回 `circuit-open` 并提示「不要立即重试」。冷却期满放行一次试探，
  试探失败立即重新熔断（而不是退回闭合并重新数满阈值）。
- **不计入熔断**：调用方主动中断（`aborted`）属于用户/宿主行为，不算后端故障。
- **体积上限**：响应超过 2,000,000 字符直接拒绝，避免异常端点拖垮内存与 JSON 解析。

| 错误码 | 含义 | 处置 |
|---|---|---|
| `config` | 配置不合法（缺 `baseUrl`、查询为空） | 按错误信息补齐配置 |
| `credential` | 缺密钥或密钥被拒（HTTP 401/403） | 检查 `apiKey` 或环境变量 |
| `timeout` | 后端未在 `timeoutMs` 内响应 | 调大超时或换后端；会计入熔断 |
| `aborted` | 调用方主动中断 | 无需处理；不计入熔断 |
| `http` | 其他 HTTP 错误（含 429 限流） | 看错误信息中的响应摘要 |
| `network` | 传输层失败（DNS/连接/TLS） | 检查网络与端点可达性 |
| `response` | 响应不是合法 JSON 或超体积 | SearXNG 需启用 `json` 格式 |
| `circuit-open` | 熔断中 | 等待冷却，或换后端 |

---

## 🔧 后端配置要点

**SearXNG（最常见的坑）**：默认只对浏览器提供 HTML，必须在其 `settings.yml` 中启用 JSON：

```yaml
search:
  formats:
    - html
    - json
```

未启用时本插件会返回明确提示（而不是把 HTML 页面当成结果解析）。

**自建 / 中转网关**：`baseUrl` 支持带路径前缀，例如 `https://proxy.example/tavily`；
Tavily 的密钥同时以请求头与请求体两种形式携带，因此 `new-api` 这类只读请求体的网关也能直接用。

**Brave**：需要有效的订阅令牌（`X-Subscription-Token`）；本插件已在请求侧关闭文本装饰
并限定 `result_filter=web`，避免 `<strong>` 标记与 infobox/FAQ 噪声进入上下文。

---

## 🛠️ 开发

本仓库统一使用 **pnpm**（见根目录 `AGENTS.md`）：

```powershell
# 类型检查（tsc --noEmit，零错误）
pnpm --filter dsh-plugin-tlsearch run typecheck

# 构建产物：dist/index.js (ESM) + dist/index.cjs (CJS) + dist/index.d.ts
pnpm --filter dsh-plugin-tlsearch run build

# 单元测试（112 个用例，零网络：全部使用假 fetch 与假 Cordis 上下文）
pnpm --filter dsh-plugin-tlsearch run test

# 全工作区递归构建
pnpm run build
```

### 源码结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：`Config` schema、`apply` 装配、生命周期与可逆注销 |
| `src/tool.ts` | 模型可见工具：定义、参数校验、熔断判定、在途请求登记、错误分类 |
| `src/providers.ts` | 三个后端适配器 + 配置解析 + 归一化管线（清洗/去重/截断） |
| `src/http.ts` | 超时、体积上限、熔断状态机、错误分类 |
| `src/sanitize.ts` | HTML/实体/空白清洗、词边界截断、URL 埋点参数剔除 |
| `src/format.ts` | 工具返回契约收敛层 + 紧凑渲染（markdown/json） |
| `src/types.ts` | 领域模型与 Cordis 上下文类型合并 |

### 两个值得记录的宿主事实

1. **工具返回必须是 `{ content: [{ type: 'text', text }] }`**。
   宿主的工具流水线会按 `output.schema` 校验返回值，再以 `(args, value)` **双参**调用
   `output.render`，随后对结果执行 `.some(...)`。若 `render` 返回裸字符串，
   宿主会抛 `content.some is not a function` 且工具链不可恢复。
   本插件对畸形输入做兜底归一，任何情况下都返回合法非空块数组。
2. **Cordis 3.0.0 会丢弃 `apply` 的返回值**（`ensure(async () => plugin.apply(...))`）。
   因此真正的卸载路径绑定在 `ctx` 上：工具注销器由 `ctx.tools.register` 返回（本身即 effect），
   在途请求中止与熔断复位挂在 `ctx.on('dispose', …)`。同时返回幂等的 `dispose` 函数，
   对会消费返回值的宿主与单元测试同样可用。

---

## 🤝 贡献

欢迎 Issue 与 PR：<https://github.com/ltl0312/my-dsh-plugins>

- 新增搜索后端：在 `src/providers.ts` 实现 `ProviderAdapter`（`build` + `parse`）并注册进
  `PROVIDERS`；清洗、去重、截断、熔断、限流由共享管线负责，无需重复实现。
- 提交前请确保 `typecheck` / `build` / `test` 三项全绿。
- 本仓库**一律使用 pnpm**（`package.json` 的 `packageManager` + `devEngines` 与
  `.npmrc` 的 `engine-strict=true` 会拒绝 npm）。

---

## 📄 License

MIT License

本项目是 DeepSeek Harness 的第三方插件，与 DeepSeek 官方无隶属关系。
