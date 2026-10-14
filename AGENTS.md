# 项目约定

Codex with ChatGPT 让 ChatGPT 负责规划与 Review，由 Codex 保留执行权；Bridge 提供按 workspace 隔离的 MCP 与受控 Desktop/Remote 投递。

## 开发与验证

- 技术栈：Node.js ≥ 20、TypeScript ESM、Express、MCP SDK、Vitest；Windows Desktop IPC helper 使用 Python 标准库。
- 安装依赖：`pnpm install --frozen-lockfile`；构建：`pnpm run build`；本地源码入口：`pnpm dev -- <命令>`。
- 按影响先跑定向测试（`pnpm test:changed` 只跑未提交改动关联的测试，`pnpm test:related -- <源文件>` 按源文件反查）。完整回归门禁使用 `pnpm test --maxWorkers=1 --testTimeout=90000`（串行是唯一正式门禁；`pnpm test:parallel` 为实验性有界并行脚本，未经独立 profiling/稳定性审计证明资源敏感文件已隔离前，不得作为 closeout 门禁），不要用 retry 掩盖不稳定结果，禁止两个全量并行。
- 生产代码变更同时检查 `pnpm run typecheck`、`pnpm run build`、`git diff --check`；Desktop/daemon Python helper 受影响时运行 `python tests/desktop_protocol_test.py` 与 `python tests/daemon_spawn_protocol_test.py`。
- 文档改动只需相应链接、合同和 diff 检查；已有通过的代码回归不因纯文档修改重复运行。

## 入口与目录

- `src/` 是实现，`tests/` 是回归，`skill/SKILL.md` 是用户流程权威；安全和机制分别见 `docs/security.md`、`docs/architecture.md`；安全门禁清单、价值评估矩阵与定期审查机制见 `docs/security-gate-audit.md`。
- `scripts/dev-install.ps1` 构建并安装机器 Core、Skill，随后执行 best-effort rollout；真实安装成功后自动通过已安装 launcher 执行 `gc --apply` 回收无引用旧 release（best effort，失败仅告警；`--protect-current` 冻结修复不回收）。日常 CLI 使用安装返回的稳定 launcher；checkout 入口只用于明确的源码维护/验证。
- 机器 `current.json` 指向不可变 `releases/<buildId>`；源码 build 不等于安装，安装也不等于所有运行中的 Bridge 已升级。先只读核对 `status --json` 的 `runtimeUpgrade`。
- Skill 只有一个 `<C2C_LAUNCHER_PATH>` 占位符，部署后核对源码替换结果与实际安装内容一致。

## 必须保留的边界

- 增量工作保留已有 dirty/staged/untracked 改动；未经明确要求不 reset、stash、commit、push，不自动合入 upstream。
- OAuth、tunnel、session/Project、checkpoint/task、Desktop 和 records 存在机器状态目录中，各 workspace 独立；不要复制到仓库、擅自清空或跨 workspace 复用。
- Runtime recovery 复用身份校验和认证 shutdown；不按旧 PID kill，不为开发/复核主动重启正在服务当前任务的 Bridge。
- Core rollout 只允许通过既有门禁的健康 named + idle workspace；quick/busy/unknown 保持 pending/skip。build 差异不得触发 Connector/OAuth 或会话迁移。统一模式按共享 owner 聚合全部活动 workspace，`-w` 不绕过兄弟 workspace；停止单个模块不退出 owner，冷启动只恢复既有 running intent。
- Bridge 负责 OAuth scope、Desktop 本机确认、binding/enable、owner/project/workspace、版本/hash、审批、防重放和 outcome_unknown 等全部安全判定；网页伴侣不承担安全门禁职责，只执行 Bridge 已授权的轻量连接、DOM 交互和结果回传。
- 用户明确要求格式化当前项目历史时，仅通过专用格式化入口永久删除任务、执行输出和回流历史；要求本机授权、精确预览确认、无活动执行或发送，并保留连接、绑定及其他 workspace。格式化不伪造送达、撤回外部消息或自动重发；异常中断保留事务标记并阻止普通写入，不能手动删标记绕过。
- Desktop `accepted` 不是执行完成。实际 `C2C_DESKTOP_TASK` turn 按 Skill 在最终回复前写 exact commandId receipt；后续 turn 不能代记，Review 不以历史 `test_status` 代替本轮证据。
- Browser Companion 保持轻量化：不实现或维护 OAuth、workspace、owner、binding、route、重放、审批和 outcome_unknown 等安全门禁；生产发送是否允许、目标是否匹配及失败恢复均由本地 Bridge 决定。
- Companion `content_scripts` 只加载构建后的 classic artifacts（包括 `*-global.js` 与 classic wrappers）；ESM `dom-adapter.js` / `turn-observer.js` 不直接作为 content script 挂载；现役后台入口为 `bridge-client.js`，旧 service-worker 与 route-attestation 编排已从源码退役。

本节为现役安全边界唯一权威；未列入本节的其余防御层允许随合同演进删改（评估快照见 [docs/security-gate-audit.md](docs/security-gate-audit.md)）。
