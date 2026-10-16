# 项目约定

Codex with ChatGPT：ChatGPT 网页负责规划与 Review，Codex Desktop 负责执行。一个常驻 Gateway 进程提供 OAuth 保护的 MCP、受控 Desktop 投递和网页伴侣接口。设计以 [docs/architecture.md](docs/architecture.md) 为准。

## 技术栈与命令

- Node.js ≥ 20、TypeScript ESM（import 带 `.js` 后缀）、Express 5、MCP SDK、zod、Vitest；Windows 专用（DPAPI、Desktop 命名管道）。
- `pnpm install --frozen-lockfile` 安装；`pnpm run build` 构建（tsc + 网页伴侣打包到 `dist/`）；`pnpm dev -- <命令>` 从源码运行 CLI。
- `pnpm test` 即完整门禁（约 1 分钟）；`pnpm run typecheck`；提交前 `git diff --check`。
- `scripts/dev-install.ps1` 构建并安装到状态目录的 `app/`，写入稳定 launcher `bin/c2c.mjs` 并安装 Skill；`-Test` 先跑测试。

## 目录

- `src/` 实现，`tests/` 回归（每个测试文件有独立 `C2C_STATE_DIR` 沙箱），`browser-companion/` 网页伴侣（MV3，保持轻量），`skill/SKILL.md` Codex 用户流程，`docs/` 设计与排查。

## 必须保留的边界

- 公网入口只有 OAuth（PKCE + 本机配对码）与带 Bearer 的 `/mcp`；伴侣与管理接口只接受本机直连并分别校验伴侣 token / runtime token。
- 只读工具沿用 `Workspace.resolve` 的越界与敏感文件拒读；执行输出必须脱敏。
- 同 commandId 不重发，投递结果未知时只能由 ChatGPT 换新 commandId；Desktop `accepted` 不是执行完成，结果以 `c2c record` 写入的 receipt 为准。
- 已领取的通知不自动再次发送；网页伴侣不承担安全判定。

## 工作方式

- 保留已有 dirty/staged/untracked 改动；未经明确要求不 reset、stash、commit、push。
- 状态目录（`%LOCALAPPDATA%\codex-with-chatgpt`，测试用 `C2C_STATE_DIR`）是本机私有数据，各 workspace 独立，不要复制进仓库或擅自清空。
- 不要重启正在服务当前任务的 Gateway，需要时先询问用户。
- 保持最小实现：不加推测性选项和抽象，不新增依赖；用户可见信息使用简体中文。
