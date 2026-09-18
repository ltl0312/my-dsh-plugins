# `dsh plugin --profile web add dsh-plugin-tlmemory` 实现评审

- **评审对象**：`@deepseek-ai/dsh` v0.1.5-rc.1（MIT），`lib/bin.js` + `lib/plugin-Ddi42qoW.js`（131 行）
- **依赖契约**：`@deepseek-ai/dsh-app-boot`（`initProfile` / `readProfileManifest` / `writeProfileManifest` / `resolveBundleDir` / `resolveProfileDir` / `PROFILE_TEMPLATES`）
- **实测环境**：Windows 11 (10.0.26200)，Node v24.12.0，pnpm 12.4.2，profile = `~/.dsh/profiles/web`
- **验证方式**：源码静态审查 + 受控「假 pnpm」探针（独立 `DSH_HOME`，不触碰真实 profile）复现 18 组行为

---

## 一、结论摘要

| 评估维度 | 结论 | 关键依据 |
|---|---|---|
| 设计定位 | **清晰且正确**：确定性的 pnpm 转发器 + bundle 归并器 | 命令本身不做任何包解析或版本决策 |
| 功能正确性（主路径） | **正确**：init → 转发 → 按「已安装状态」归并 | 实测 R1/R2/R3 三条归并路径全部符合预期 |
| 参数转发保真度 | **基本正确但有缺口**：含空格路径被拆断；与启动器同名选项被静默吞掉并重定向 profile | 实测 T11、T17 |
| 错误处理 | **存在 1 个 P0 与 3 个 P1**：清单损坏导致崩溃并中止归并；解析/解析失败静默剔除 bundle | 实测 S3、S4，且已在真实 profile 中命中 |
| pnpm 版本兼容 | **不完整**：自身创建的 profile 是 workspace root，却不注入 `-w`，pnpm 9 下必然失败 | 代码比对 + dshmarket 兼容层旁证 |
| 性能 | **不是问题**：归并核心 40–61 ms / 57 次探测，占比可忽略 | 实测基准 |
| AGI 能力使用 | **「不使用」是对的；但缺一条给 AGI 用的结构化失败契约**，且静默降级对 agent 操作面危害最大 | 源码零模型调用 + 下游 `dshmarket` 被迫自行重建全部诊断能力 |

---

## 二、命令概述

### 2.1 调用形态

```
dsh plugin --profile <name> <pnpm 参数...>
```

三个子命令共享一个解析器（`bin.js`）。`plugin` 分支只做三件事：校验 `--profile` 非空、拒绝 `desktop`（Electron 独占）、要求至少有一个待转发的参数；随后把整条 argv 原样交给 `runPlugin`。

**职责边界**（值得肯定的设计）：启动器只解析自己拥有的旗标，其余参数「逐字」下沉。因此 `dsh plugin --profile web why --json` 中的 `why --json` 由 pnpm 解释，CLI 不建立第二套 pnpm 语法模型。

### 2.2 执行流程（四阶段）

| 阶段 | 动作 | 失败时的行为 |
|---|---|---|
| ① 预置 | `resolveProfileDir`；若 `<profile>/package.json` 不存在，用 `PROFILE_TEMPLATES[name]` 或 `DEFAULT_PROFILE_BUNDLES` 调 `initProfile`（写 package.json / cordis.patch.yml / pnpm-workspace.yaml） | 不校验 pnpm 是否存在，**先落盘**（见 P2-3） |
| ② 快照 | `readProfileManifest` 取「变更前」清单（只用于判断哪些依赖是新增的） | 抛错并中止 |
| ③ 转发 | `spawnSync("pnpm", anchor(args), { cwd: profileDir, stdio: "inherit", shell: win32 })` | ENOENT→提示 127；其他→原样抛出 |
| ④ 归并 | **仅当退出码为 0** 才执行 `reconcilePlugins` | 非 0 时只打印提示，不归并、不回滚 |

### 2.3 归并算法（本命令真正的逻辑核心）

设计要点：**「按已安装状态」重算，而不是「按依赖 diff」增量修改**。官方注释给出的理由是：这样 `update` 也能让「新版本才获得 `dsh.bundle` 声明」的包自动加入层栈。

对每个 `dependencies` 的键：
- 解析得到包目录且其 `package.json` 声明了 `dsh.bundle.patch` → 若是新 bundle，追加到 `dsh.profile.bundles` 末尾（保持依赖顺序）；
- 否则若它是本次新增的依赖 → 打印一条「未声明 dsh.bundle，仅作为普通依赖安装」的警告（面向人类的定位提示，不阻断）。

对每个已在 `bundles` 中的名字：
- 若它曾是/仍是依赖，但当前不再解析为 bundle → 从层栈移除。
- 非依赖的 bundle（即模板内置的 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`）**永不触碰**。

仅当发生实际变更时才回写清单，避免无意义的文件抖动。

**实测验证**（假 pnpm 真实改写清单与 node_modules）：

| 场景 | 期望 | 实测结果 |
|---|---|---|
| R1 `add demo-bundle`（声明 `dsh.bundle`） | 加入层栈 | `bundles` 追加 `demo-bundle` ✅ |
| R2 `add plain-lib`（无 `dsh.bundle`） | 只装依赖 + 警告 | 依赖写入，`bundles` 不变，警告如期输出 ✅ |
| R3 `remove demo-bundle` | 移出层栈 | `bundles` 恢复为 2 项 ✅ |

### 2.4 相对路径锚定

pnpm 的 `cwd` 是 profile 目录，因此裸 `.` / `../plugin` 会被静默解析到 profile 内部（`add .` 会自我链接）。命令用一条正则把**仅以 `.` 或 `..` 开头的路径型参数**重写为相对调用目录的绝对路径，`file:` / `link:` 前缀原样保留。

| 输入 | 转发给 pnpm | 判定 |
|---|---|---|
| `add .` | 调用目录绝对路径 | ✅ |
| `add ../x` | 上级目录下的 `x` | ✅ |
| `add file:.` | `file:<调用目录>` | ✅ |
| `add dsh-plugin-tlmemory` | 原样 | ✅ |
| `add file:D:/My Plugins/x` | **被拆成 `file:D:/My` 与 `Plugins/x`** | ❌ 见 P0-2 |
| `--filter=.` | 原样（未锚定） | ⚠️ 一致性缺口，见 P3-1 |

---

## 三、优点

1. **零解析策略，契约最小**。CLI 不试图理解 pnpm 语义，不自建版本解析、不加装「智能」默认值。任何 pnpm 子命令（`add` / `remove` / `why` / `update` / `install`…）天然可用，新增 pnpm 能力无需改 CLI。
2. **按安装状态归并，而非依赖 diff**。这是一个有意识的正确选择：把「是不是一个 bundle」交给包自身声明的 `dsh.bundle.patch`，而不是维护一份中心化的插件名册。副作用（`update` 后自动激活）被显式写进注释。
3. **启动路径惰性加载**。`bin.js` 以 `await import()` 按 mode 分派，`dsh plugin` 只加载 2 个模块，不构建整个应用树——对一个安装类命令而言是恰当的冷启动优化。
4. **参数顺序保真**。实测 T2–T7 表明 commander 的 `allowUnknownOption` + 变参位置参数组合**并未**打乱 pnpm 参数顺序（包括 `--filter`、`--save-dev`、前置未知选项等边界），转发面比预期可靠。
5. **相对路径自我链接防护**。`anchorPathSpec` 精确解决了「`add .` 把 profile 链接到自己」这一类真实事故，且只针对路径型参数，不误伤包名（`.hidden-pkg` 这类名字不会被改写）。
6. **退出码透传正确**。实测 T14：pnpm 返回 7 时 `dsh plugin` 也返回 7，可供脚本与 CI 依赖。
7. **归并写回具备最小性**。`changed` 标志避免每次调用都重写 `package.json`，减少与用户手工编辑、其他工具（如 dshmarket）的冲突窗口。
8. **诊断提示已内建一条**。对 git 形态的 spec 主动提示 pnpm 的构建放行机制（`allowBuilds`），命题准确——本机 `pnpm-workspace.yaml` 确实使用该键。

---

## 四、缺点（按严重度分级）

### P0-1 清单解析失败会崩溃并中止归并（错误保护范围放错位置）

`exportsPatch()` 的 `try` **只包住了 `resolveBundleDir()`**，紧接其后的 `readProfileManifest()` 不在保护范围内：

- 后果链：被依赖包的 `package.json` JSON 非法 → `readProfileManifest` 抛 `SyntaxError` → `exportsPatch` 不捕获 → 穿透 `reconcilePlugins` → 穿透 `runPlugin` → 穿透 `runCli` → 顶层无 `catch`，进程以**原始堆栈**（含内部文件路径与行号）退出。
- 关键放大效应：这一步发生在 pnpm **已经改写 profile 之后**。归并未完成，`dsh.profile.bundles` 保持陈旧，而 `dependencies` 已变——形成无回滚、无备份、无提示的**不一致状态**。
- **实测 S3**：仅将 `node_modules/demo-bundle/package.json` 截断为非法 JSON，再执行任意 `dsh plugin` 命令，即得到完整 Node 堆栈并中止归并；`bundles` 未更新。

### P0-2 Windows 下参数未转义：含空格路径被拆断，且可注入 shell 元字符

`spawnSync(..., { shell: process.platform === "win32" })` 在 Windows 上走 `cmd.exe /d /s /c`，而 Node 对 `shell: true` 的命令行构造是 **`[file, ...args].join(" ")`，不做任何转义或引用**。因此：

- **实测 T11**：`add "file:D:/My Plugins/x"` → pnpm 实际收到 `add` / `file:D:/My` / `Plugins/x` 三个参数。凡路径或 spec 含空格即静默走样（Windows 用户目录、OneDrive 同步路径、`Program Files` 下检出都很常见）。
- **实测 T12**：`add "x&ver"` → `cmd.exe` 在 `&` 处截断，**额外执行了 `ver`**。这是一条真实的命令注入面：转发面接受任意 argv，而边界由 cmd.exe 重新划定。
- 反向印证：`dshmarket` 的兼容层专门为「cmd.exe 以 OEM 代码页写错误信息，字节到达时已是替换字符」设置了 `replaceOutput` 分支。同一类 Windows 编码/转义问题在本次探针中也直接观察到（`ver` 输出中的 GBK 乱码）。

### P1-1 解析失败被当作「不是 bundle」，导致静默剔除层栈

`exportsPatch` 用裸 `catch { return false }` 处理 `resolveBundleDir` 的失败，把「存在但不是 bundle」与「根本没解析到」合并为同一返回值。归并的移除分支由此得出错误结论：

- **实测 S4**：`demo-bundle` 仍在 `dependencies` 中、但 `node_modules/demo-bundle` 目录缺失时，执行任意 `dsh plugin` 命令后，它被**从 `dsh.profile.bundles` 中静默移除**——没有任何输出。下一次启动 profile 时该插件不再加载，而用户与 agent 都拿不到任何信号。
- 该路径**此刻已在真实 profile 中命中**：`~/.dsh/profiles/web/node_modules/@furongjun1999/dsh-memory/` 只剩一个 `data` 子目录、**没有 `package.json`**，`exportsPatch` 对它返回 false。当前它尚未进入 `bundles` 因而未造成损失，但机制已被激活；一旦某个已激活 bundle 的 `node_modules` 被裁剪（store 损坏、手工清理、`file:` 依赖源目录被移动、`git` 依赖解析失败），层栈就会无提示地掉项。
- 附带的不对称：新增方向的失败**有**警告（`!beforeDeps.has(name)`），移除方向的失败**没有**警告。定向错误信息用在了危害较小的那一侧。

### P1-2 仅 bundle 型包被激活：客户端型插件在 CLI 路径下「装了但不生效」

归并只认 `dsh.bundle.patch`。对于声明 `dsh.client` 的**客户端型插件**（本命令的目标 `dsh-plugin-tlmemory` 正属此类），`dsh plugin ... add` 只完成「安装依赖」这一步，**不会**把它加入层栈，因此它不会因这条命令而挂载：

- 证据一（清单）：`dsh-plugin-tlmemory` 的 `package.json` 声明 `dsh.client`，无 `dsh.bundle`。
- 证据二（真实 profile）：它出现在 `dependencies`（`file:D:/Code/my-dsh-plugins/packages/tlmemory`），但**不在** `dsh.profile.bundles` 中。
- 证据三（实际挂载途径）：真正让它生效的是另一条链路——`~/.dsh/profiles/web/.dsh-market/hot-1.yml` 指向 `node_modules/dsh-plugin-tlmemory/dist/index.cjs`，市场日志记录 `dsh-plugin-tlmemory: live (client-only shim)`。
- 结论：`dsh plugin` 与 market 的 hot-mount 是**两条独立激活通道**，二者对「客户端型插件」的判定不一致。命令会打印一条面向人类的警告，但措辞是「作为普通依赖安装 / 将来声明了会自动激活」，并未指出「你需要 market 或手工 patch 才能真正用它」。对以插件开发为主的用户，这是最容易踩的认知陷阱。

### P1-3 与启动器同名的参数被静默吞掉，并重定向到错误的 profile

`plugin` 子命令未启用 `passThroughOptions`，且自身以 `requiredOption("--profile <name>")` 注册了同名旗标。实测 T17：

```
dsh plugin --profile web add --profile=1
  → 转发给 pnpm 的只有 ["add"]      （`--profile=1` 被 commander 吃掉）
  → 且本次操作的 profile 被改写为 "1"
```

即：待转发参数被静默丢弃，**同时**整条命令被静默改道到另一个 profile。实测确认该次调用创建并初始化了 `profiles/1`（仅含 `@deepseek-ai/dsh-base`），用户的包被装到了非目标 profile。另外 T18 表明 `--version` 可正常转发，说明风险仅限与启动器旗标同名者——但这类冲突是静默的，没有「未知旗标即转发」的兜底。

### P2-1 完全不捕获 pnpm 输出，把全部诊断责任推给下游

`stdio: "inherit"` 意味着 CLI 既不持有 pnpm 的 stdout/stderr，也无法据此分类失败；它唯一的读数是退出码和一条针对 git spec 的正则。后果是**下游被迫把这件事重做一遍**：

- `dshmarket` 的 `src/pnpm-compat.ts` 定义了一份 **20 个错误码的失败分类学**（`adding-to-root`、`ignored-builds`、`git-prepare-not-allowed`、`fetch-404`、`release-age-violation`、`windows-file-locked`、`pnpm-unusable`…）+ 双语可操作文案 + `recoverable` 标记 + 源码级 `classifyPnpmFailure(output, exitCode)`。
- 同一个模块还维护了 **pnpm 9/10/11 行为矩阵**，并为「profile 是 workspace root」注入 `-w`。
- `dsh-cli.ts` 另需自备：超时（默认 15 分钟）、进度上报、pnpm 供给、代理环境翻译（`HTTPS_PROXY` 等 → `npm_config_https_proxy` / `npm_config_proxy`）、macOS Finder 精简 PATH 修补、Android linker64 的 node 可执行文件选择。

这些都不是市场层的业务，而是「把一条不够结构化的命令行包装成可用产品」的补丁成本。它们同时说明：**CLI 当前的输出契约不足以支撑一个真实消费者**。

### P2-2 自带 workspace root，却不注入 `-w`（pnpm 9 下必然失败）

`initProfile` 会写入 `pnpm-workspace.yaml`（`packages: ["."]`），因此**凡是 CLI 自己创建的 profile 都是 workspace root**。而 pnpm 9 在 root 上执行 `add`（不带 `-w`）会以 `ERR_PNPM_ADDING_TO_ROOT` 失败，同时不带 `-w` 在非 workspace 目录又会被拒绝——这正是 `dshmarket` 必须写 `pluginArgsFor` 的原因。CLI 侧缺少这一分支，等价于：在 pnpm 9 环境下，用它自己生成的 profile 执行 `dsh plugin --profile <新名字> add <pkg>` 会稳定失败。本机 pnpm 为 12.4.2 故未暴露。

### P2-3 预置先于校验，失败会留下半成品 profile

`initProfile` 在 `spawnSync` **之前**无条件执行：即使 pnpm 不存在、或用户只是手误敲错了一个参数，也会先生成一个 profile 目录与三份配置文件。实测 T13 证实 pnpm 缺失时流程照常走完预置阶段。对未知 profile 名，模板缺失时会静默套用 `DEFAULT_PROFILE_BUNDLES`（仅 `@deepseek-ai/dsh-base`），于是 T17 的误输入直接产出一个几乎是空的 profile 目录——没有任何确认或提示。

### P2-4 缺失写回原子性与并发保护（代码推断，未复现）

- `writeProfileManifest` 是「整体覆盖 + 无临时文件 + 无备份」；写失败（只读盘、Windows 上被杀软/编辑器占用）时，pnpm 已改动的结果与未归并的清单同时存在，命令以未捕获异常结束。
- 两次调用之间无锁：`read before → spawn pnpm → read after → write` 的窗口内若并发的另一条 `dsh plugin`（或 dshmarket、或用户手工编辑）也改写清单，后写者覆盖先写者。`changed` 标志缩小但不消除该窗口。
- 注：以上两条来自代码结构推断，本次探针未构造并发/写失败场景。

### P3-1 Windows 下缺失分支实为死代码

`result.error.code === "ENOENT"` 的友好提示（「install pnpm to manage profile plugins」）与退出码 127，在 Windows 上**不可达**：`shell: true` 使 `spawnSync` 必然成功启动 `cmd.exe`，找不到 pnpm 是 cmd.exe 的失败而非 ENOENT。实测 T13：实际输出的是通用文案 `pnpm failed in profile directory …`，退出码为 1，专业提示从未出现。这条分支只在 `shell: false` 的平台上有效。

### P3-2 诊断正则是单例且不完整

git 形态判定使用 `^git+` / `^github:` / `\.git(#|$)`。它覆盖了本机 profile 里的 `github:...` 形式，但漏掉 `gitlab:`、`bitbucket:`、裸 `https://github.com/...`、`ssh://git@…` 等同样会触发 `prepare` 构建的形态。更重要的是它把**唯一的**诊断能力写死成一条正则，而 `allowBuilds` 这个键本身是 pnpm 大版本相关的（pnpm 9/10 语义不同），CLI 未读取 pnpm 版本即给出该指引。

### P3-3 性能：可优化，但不值得为性能优化

实测归并核心（57 次 `resolveBundleDir` + `readProfileManifest` 探测，覆盖真实 web profile 的 29 个依赖 + 28 个 bundle）：**40.0 / 44.3 / 61.3 ms**，约 0.7–1.1 ms/次探测。结构上它做了两遍遍历（新增循环 + 移除循环对同一批包各解析一次），且 `packageDirFromAnchor` 每次都新建 `createRequire(anchor)`——理论上可记忆化省掉近一半。

但 pnpm 本身耗时以「秒」计，20–30 ms 的节省不可感知。**结论：这不是一个性能问题**，只应作为可读性与一致性的顺手改进（按包名记忆化一次求值，两个循环共用结果）。

### P3-4 commander 层的零散取舍

- `plugin` 未设 `passThroughOptions`，导致 P1-3 的旗标吞噬；`web` / 根命令都设了。
- `anchorPathSpec` 只识别「以 `.`/`..` 开头」的形态，`--filter=.`、`--dir=./x` 这类「旗标携带路径值」的写法绕过锚定，形成一致性缺口（当前无实际危害，属语义漂移）。
- `process.exit(runPlugin(...))` 紧跟在若干 `process.stderr.write` 之后。Node 在管道场景下的 stdout/stderr 写入可能是异步的，理论上存在截断风险。本次探针中警告在管道下均完整到达，**未能复现**，故仅作低置信度提示。

---

## 五、AGI 能力使用情况评估

### 5.1 事实：这条命令中没有模型调用

`bin.js` 与 `plugin-Ddi42qoW.js` 的 import 闭包仅有 `node:fs`、`node:path`、`node:child_process` 与应用启动包。没有 LLM 客户端、没有 agent、没有推理步骤，也没有网络请求（网络只发生在被转发出去的 pnpm 内部）。全部「智能」体现为两个纯函数式判定：一条路径锚定正则、一条 git spec 正则。

### 5.2 判断一：**「不使用 AGI」是正确的**

对一个「把包写进 profile 并维护层栈」的基础设施操作，确定性就是正确性：

- 安装是有副作用、可能半成功、需要可复现与可审计的动作。让模型参与「装哪个版本 / 是否写回清单」会引入非确定性、额外延迟与不可解释的失败模式。
- 命令的成功判据可以完全由文件系统状态表达（依赖是否写入、bundle 是否在层栈中）。这类问题**不需要**推理，需要的是原子性与可观测性。
- 因此这不是「AGI 用得不够」，而是**分工正确**。若把模型塞进这条路径，反而会破坏 `dsh plugin` 作为其它工具底座的可依赖性。

### 5.3 AGI 层实际在哪里（生态分工）

| 层 | 载体 | 职责 | 与模型的关系 |
|---|---|---|---|
| 确定性底座 | `dsh plugin`（本命令） | 依赖落盘 + `dsh.profile.bundles` 归并 | 无模型 |
| 会话内动态扩展 | `@deepseek-ai/dsh-tool-cordis` | 模型自写的临时包：inspect / define / run / stop / undefine，含「失败后追加新版本再 update」的修正式工作流 | **模型直接参与**（工具集本身「把这套工作流教给模型」） |
| 市场与发现 | `dshmarket` | 目录检索、兼容性判定、一键安装、hot-mount、pnpm 兼容与错误翻译 | 目前以规则+分类学为主，非模型驱动 |
| 语义/推理 | agent 本体 | 应承担「为什么失败、下一步做什么」的解释责任 | 模型 |

这张表说明 DSH 的架构**有意**把模型能力隔离在底座之外。**分工方向正确**；问题出在接口。

### 5.4 判断二：真正被误用的，是**给 AGI 用的接口**，不是 AGI 本身

三点具体缺陷，全部落在「agent 操作这条命令时拿不到真实状态」上：

**（a）把诊断能力硬编码成单例规则，而不是可升级的通道。**
CLI 在 git spec 场景做的事，本质是「读错误 → 判断根因 → 给出可执行的下一步」——这正是模型擅长、而正则无法泛化的任务。但它用一条三条分支的正则实现了这个意图，且只覆盖一种失败。结果是：**做了一个应该由 AGI 做的判断，却做得比 AGI 差，并且挡住了 AGI 介入的通道**。要么把这条规则收窄为「原样转述 pnpm 的提示」，要么把它升级为「输出结构化失败供上层推理」。

**（b）失败以非结构化形式抛弃。**
`stdio: "inherit"` 让 CLI 放弃了对 pnpm 输出的所有权，输出直接涌向用户终端：模型看不到它（除非再包一层捕获），下游市场只能靠 `replaceOutput` 这类补丁去对付 cmd.exe 的代码页乱码。CLI 交付给上层的失败信号实际上是「一个退出码 + 一屏不可机器解析的字节」。对 AGI 驱动的编排，这是最低信息量的契约。

**（c）静默降级对 agent 是**最**危险的失败形态。**
P1-1（解析失败 → 静默剔除层栈）与 P1-2（客户端插件 → 装了但未激活）都表现为 **`exit 0` + 无错误输出**，而真实世界状态已经偏离。人类用户可以在下次启动时凭直觉发现「插件没生效」；模型则依赖工具返回值与观测结果建立世界模型——当工具以成功回应一次静默的状态丢失，模型会把错误的世界模型继续往下用（例如向用户汇报「已安装并启用」）。**在这条命令上，静默成功比显式失败对 agent 的伤害更大。** 这也是本次评审中与「AGI 使用方式」最直接相关的结论。

### 5.5 正确的 AGI 调用方式（建议形态）

原则：**CLI 保持确定性且不联网调模型；由 CLI 提供结构化事实，由 agent 层承担解释与修复。**

1. CLI **不做**模型调用，**只做** `fail loud` + 机器可读输出：
   - `dsh plugin … --json`（或 `DSH_PLUGIN_OUTPUT=json`）输出 `{ phase, exitCode, addedBundles, removedBundles, skipped: [{name, reason}], profile }`；
   - 稳定退出码分类：`0` 成功 / `2` pnpm 缺失 / `3` 清单非法 / `4` 归并不一致 / 其余透传 pnpm；
   - 每条 `stderr` 诊断行附带稳定前缀（如 `dsh: diagnose: <code>: <detail>`），使上游可用字符串匹配替代正则猜测。
2. 上游（`dshmarket` 或一个 agent 工具 / skill）读取该契约，把失败的**解释与修复建议**交给模型：例如「识别到 `git-prepare-not-allowed`，本 profile 的 `pnpm-workspace.yaml` 缺 `allowBuilds.<pkg>`，是否授权写入」——由模型给出叙述与判断，由确定性代码执行写入。
3. 所有「判断不出」的情况必须上抛，不得降级为默认值：解析不到包目录 ≠ 不是 bundle；无法读取清单 ≠ 无声明。**三态（是/否/未知）而非二态**，未知一律升级为显式错误。

---

## 六、具体优化建议

### 6.1 正确性 / 健壮性（P0–P1，建议优先）

| # | 问题 | 建议改法 | 预期收益 |
|---|---|---|---|
| 1 | P0-1 清单解析崩溃中止归并 | 把 `readProfileManifest` 一并纳入保护，或改为三态返回（`"bundle"` / `"plain"` / `"unknown"`）；解析类错误必须上抛为带前缀的干净错误，不得走 `catch → false` | 消除原始堆栈外泄与半完成状态 |
| 2 | P0-2 参数未转义 | 改用 `shell: false` 并显式解析 `pnpm.cmd` / `pnpm.exe`（`where pnpm` 或 `process.env.PATH` + PATHEXT 探测）；或改用已在 `dsh` devDependencies 中的 `execa`（自带跨平台 argv 转义）。**不要**保留「拼字符串交给 cmd.exe」的形态 | 修复含空格路径；关闭命令注入面 |
| 3 | P1-1 静默剔除 bundle | 移除分支区分「依赖已删除」（正常，静默/可选提示）与「依赖仍在但解析失败」（异常，必须 `stderr` 报错 + 非零退出，或至少明确列出被移除的名字） | 层栈不再无声掉项；agent 不再建立错误世界模型 |
| 4 | P1-3 旗标吞噬与 profile 改道 | 给 `plugin` 加 `.passThroughOptions()`；`--profile` 解析限定在首个非旗标之前；对转发的 `--profile*` 采用「出现两次即报错」而非静默覆盖 | 参数不再丢失，profile 不再被静默重定向 |
| 5 | P1-2 客户端插件装了不生效 | 归并识别第二类声明（`dsh.client`）：或给出明确文案「此为客户端型插件，需 market / patch 激活，本条命令仅完成安装」，或写一条等价 patch 使其自洽 | 消除本命令最易踩的认知陷阱 |
| 6 | P2-2 pnpm 9 上必然失败 | 在生成 `pnpm-workspace.yaml` 的前提下自动注入 `-w`（等价于 `pluginArgsFor`）；或读 `pnpm --version` 后决定 | 恢复 pnpm 9 可用性 |
| 7 | P2-3 预置先于校验 | 把「pnpm 可执行存在性」「profile 名合法性」提到 `initProfile` 之前；对未知 profile 名要求 `--yes` 或显式 `--from-default-profile` | 不再因手误留下半成品 profile |
| 8 | P2-4 写回不原子 / 无并发保护 | 临时文件 + `rename` 原子替换；写前备份 `package.json`（保留一份 `.bak`）；fail 时明确提示清单可能未归并；如可行，对 profile 加锁文件 | 消除不一致状态与丢失更新 |

### 6.2 契约 / 可观测性（配合 AGI 分工）

| # | 建议 | 说明 |
|---|---|---|
| 9 | 增加 `--json` 结果输出与稳定退出码分类 | 只加输出不改行为，向后兼容；使本命令可被 agent 与市场可靠消费（见 5.5） |
| 10 | `stderr` 诊断行加稳定前缀与错误码 | 把「正则猜根因」上移为「匹配错误码」，同时为模型提供可引用的事实 |
| 11 | 捕获 pnpm 输出（`pipe`）并同时转发 | 既保留 `stdio: inherit` 的实时体验，又持有字节以供分类；顺带按平台解码（Windows OEM 代码页）避免乱码 |
| 12 | 超时与代理显式化 | `dshmarket` 已自备 15 分钟超时与代理环境翻译；这些应下沉为 CLI 选项（`--timeout`、继承并翻译代理），减少每个消费者的重复实现 |

### 6.3 代码结构

| # | 建议 | 说明 |
|---|---|---|
| 13 | 拆分 `plugin` 模块 | 目前 init / 参数锚定 / pnpm 调用 / 归并 / 诊断挤在一个 131 行文件里；按 §2.2 四阶段拆成可独立测试的单元，`exportsPatch` 与 `reconcilePlugins` 作为纯函数（注入 `exec`）暴露 | 
| 14 | 归并改为单遍求值 + 记忆化 | 先对「依赖 ∪ 层栈」一次性求值 `Map<name, "bundle" \| "plain" \| "unknown">`，新增/移除两个分支共用；同时消除 `createRequire` 的重复构造 |
| 15 | 常量集中 | git spec 正则、警告文案、`allowBuilds` 指引等抽为具名常量并有单元测试覆盖各形态 |
| 16 | 补齐测试缺口 | 建议覆盖：非法 JSON 清单、包目录缺失、含空格 spec、`&`/`^` 元字符、`--profile` 重复、pnpm 缺失、非 0 退出、`= .` / `file:.` 锚定。这些正是本次探针命中问题的位置 |

### 6.4 关于性能的明确结论

**不需要以性能为由做任何改动。** 实测归并核心 40–61 ms（57 次探测）；即便按建议 14 减半，节省量也在 20–30 ms 量级，相对 pnpm 的秒级耗时不可感知。把它列为可优化项仅因为**顺手的清晰度收益**，不应作为独立工作项排期。

---

## 七、附：实证记录

**探针方法**：独立 `DSH_HOME` 指向工作区内临时目录 + PATH 前置受控 `pnpm.cmd`（仅打印收到的 argv，或按预设规则真实改写 profile 清单），因此所有观察都不触碰 `~/.dsh` 真实 profile。

| 编号 | 输入 / 构造 | 观察结果 | 对应结论 |
|---|---|---|---|
| T1 | `plugin --profile web add dsh-plugin-tlmemory` | 自动初始化 profile；pnpm 的 cwd = profile 目录；收到 2 个参数 | §2.2 主路径正确 |
| T2–T6 | 未知选项前/后置、`why --json`、`remove --save-dev` | 参数顺序与集合完全保真 | 优点 4 |
| T7 | `--filter=web add pkg` | 仍保序 | 优点 4（原「乱序」假设被证伪） |
| T8–T10 | `add .` / `../x` / `file:.` | 均锚定到调用目录 | §2.4 正确 |
| T11 | `add "file:D:/My Plugins/x"` | 被拆为 2 个参数 | **P0-2** |
| T12 | `add "x&ver"` | 在 `&` 处截断，`ver` 被额外执行 | **P0-2** |
| T13 | PATH 中无 pnpm | 仅输出通用「pnpm failed」；退出码 1；ENOENT/127 分支未触发 | **P3-1** |
| T14 | 假 pnpm `exit /b 7` | 透传退出码 7 | 优点 6 |
| T16 | `add github:foo/bar`（pnpm 失败） | 输出 `allowBuilds` 指引 | 优点 8 / P3-2 |
| T17 | `add --profile=1` | 转发参数被吞，profile 被改为 `1` 并新建 | **P1-3** |
| T18 | `add pkg --version` | 正常转发 | P1-3 范围界定 |
| R1 | `add demo-bundle`（声明 `dsh.bundle`） | 追加进层栈 | §2.3 正确 |
| R2 | `add plain-lib` | 仅装依赖 + 警告 | §2.3 正确 |
| R3 | `remove demo-bundle` | 从层栈移除 | §2.3 正确 |
| S3 | 令 bundle 的 `package.json` 非法 | 未捕获 `SyntaxError`、原始堆栈、归并中止 | **P0-1** |
| S4 | 依赖在、包目录缺失 | 从层栈**静默移除**，无任何输出 | **P1-1** |

**真实 profile 只读核查**（`~/.dsh/profiles/web`）：29 个依赖 / 28 个层栈项；26 个依赖声明了 `dsh.bundle`；3 个未声明（`@furongjun1999/dsh-memory` **不可解析**——其 `node_modules` 目录缺 `package.json`；`dsh-plugin-tlmemory`；`zustand`）；2 个层栈项非依赖（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`，属模板内置、归并永不触碰，行为正确）。

**基准**：归并核心 57 次探测，三次运行 40.00 / 44.30 / 61.32 ms（0.7–1.1 ms/次），预热后稳态。

**复现脚本**（工作区内，可删除）：`probe/bin/pnpm.cmd`（argv 探针）、`probe/bin2/`（固定非零退出）、`probe/bin3/`（真实改写 profile 的模拟 pnpm）、`probe/bench-reconcile.mjs`（只读基准）。

---

## 八、一句话总结

这是一条**设计定位正确、主路径可靠**的命令：它选择不做包解析、不调模型、按已安装状态归并，这些都是对的。它的代价集中在**失败面**——参数在 Windows 上被 cmd.exe 重新切分、清单解析错误直接崩溃、而「解析不到」与「不是插件」被混为一谈导致层栈无声掉项。对 AGI 编排而言，最后一点最致命：**它以 `exit 0` 回应一次真实的状态丢失**。建议的修复方向不是给这条命令加模型，而是让它**要么说清楚，要么明确失败**，把解释权交还给本应承担它的上层。
