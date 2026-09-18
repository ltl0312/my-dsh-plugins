# 仓库约定（my-dsh-plugins）

## 包管理器：pnpm only

本仓库**一律使用 pnpm** 管理依赖与执行脚本，**不使用 npm**。此约定对人和 Agent 同时生效，无例外。

- 安装依赖：`pnpm install`（不要 `npm install` / `npm ci`）
- 执行脚本：`pnpm run <script>` 或 `pnpm <script>`（不要 `npm run`）
- 单包操作：`pnpm --filter <pkg> <cmd>`（不要 `npm --workspace`）
- 新增依赖：`pnpm add` / `pnpm add -D` / `pnpm -r add`（不要 `npm i`）
- 临时执行包内命令：`pnpm exec <bin>`（不要 `npx`）
- workspace 结构由 `pnpm-workspace.yaml` 定义；原生模块放行由 `allowBuilds` 控制（如 `better-sqlite3`、`esbuild`、`vue-demi`）

唯一锁文件是 `pnpm-lock.yaml`。不得引入 `package-lock.json` / `yarn.lock`；若因误操作产生，删除并回到 pnpm。

机械约束（已配置，勿绕过）：

- `package.json` → `packageManager: pnpm@<version>`（corepack 可据此固定版本）
- `package.json` → `devEngines.packageManager.name = pnpm`，`onFail: error`（npm ≥ 10.9 会直接报错拒绝）
- `package.json` → `engines.node` / `engines.pnpm` 版本下限
- `.npmrc` → `engine-strict=true`
- 根目录的闸门只管根目录，因此 `packages/tlmemory/package.json` 与 `packages/tlmemory/web/package.json` 也各自带 `packageManager` + `devEngines`，在子包目录里敲 npm 同样被 `EBADDEVENGINES` 拒绝
- `.gitignore` → 兜底忽略 `package-lock.json` / `yarn.lock` / `npm-shrinkwrap.json`（裸模式递归匹配，含任意子目录）
