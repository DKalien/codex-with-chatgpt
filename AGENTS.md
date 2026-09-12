# 项目约定

Codex with ChatGPT 让 ChatGPT 负责规划与 Review，由 Codex 保留执行权；Bridge 提供按 workspace 隔离的 MCP 与受控 Desktop/Remote 投递。

## 开发与验证

- 技术栈：Node.js ≥ 20、TypeScript ESM、Express、MCP SDK、Vitest；Windows Desktop IPC helper 使用 Python 标准库。
- 安装依赖：`pnpm install --frozen-lockfile`；构建：`pnpm run build`；本地源码入口：`pnpm dev -- <命令>`。
- 按影响先跑定向测试。完整回归使用 `pnpm test --maxWorkers=1 --testTimeout=60000`，不要用 retry 掩盖不稳定结果。
- 生产代码变更同时检查 `pnpm run typecheck`、`pnpm run build`、`git diff --check`；helper 受影响时运行 `python tests/desktop_protocol_test.py`。
- 文档改动只需相应链接、合同和 diff 检查；已有通过的代码回归不因纯文档修改重复运行。

## 入口与目录

- `src/` 是实现，`tests/` 是回归，`skill/SKILL.md` 是用户流程权威；安全和机制分别见 `docs/security.md`、`docs/architecture.md`。
- `scripts/dev-install.ps1` 构建并安装机器 Core、Skill，随后执行 best-effort rollout。日常 CLI 使用安装返回的稳定 launcher；checkout 入口只用于明确的源码维护/验证。
- 机器 `current.json` 指向不可变 `releases/<buildId>`；源码 build 不等于安装，安装也不等于所有运行中的 Bridge 已升级。先只读核对 `status --json` 的 `runtimeUpgrade`。
- Skill 只有一个 `<C2C_LAUNCHER_PATH>` 占位符，部署后核对源码替换结果与实际安装内容一致。

## 必须保留的边界

- 增量工作保留已有 dirty/staged/untracked 改动；未经明确要求不 reset、stash、commit、push，不自动合入 upstream。
- OAuth、tunnel、session/Project、checkpoint/task、Desktop 和 records 存在机器状态目录中，各 workspace 独立；不要复制到仓库、清空或跨 workspace 复用。
- Runtime recovery 复用身份校验和认证 shutdown；不按旧 PID kill，不为开发/复核主动重启正在服务当前任务的 Bridge。
- Core rollout 只允许通过既有门禁的健康 named + idle workspace；quick/busy/unknown 保持 pending/skip。build 差异不得触发 Connector/OAuth 或会话迁移。
- 不降低 OAuth scope、Desktop 本机确认、binding/enable、owner/project/workspace、版本/hash、审批、防重放或 outcome_unknown 门禁。
- Desktop `accepted` 不是执行完成。实际 `C2C_DESKTOP_TASK` turn 按 Skill 在最终回复前写 exact commandId receipt；后续 turn 不能代记，Review 不以历史 `test_status` 代替本轮证据。
