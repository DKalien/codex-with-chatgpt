---
name: codex-with-chatgpt
description: >
  Use ChatGPT (web) as the planning and review brain for Codex coding sessions,
  while Codex keeps full execution ownership. Use when the user says
  "启用 ChatGPT 工作流" / "为当前项目启用 ChatGPT 工作流" / "Set up Codex with ChatGPT" /
  "用 ChatGPT 规划" / "把这个会话绑定给 ChatGPT", when they ask to connect ChatGPT to the
  current workspace, or when a turn starts with the internal
  "[C2C_DESKTOP_TASK] workspaceId=... commandId=..." envelope, which requires
  recording an execution result before the final reply.
---

# Codex with ChatGPT

ChatGPT thinks. Codex works.

你（Codex）负责执行：改代码、跑命令、git、测试、恢复。ChatGPT 负责规划与 Review，
通过本机 Gateway 的 MCP 只读访问当前项目，并把确认后的计划投递到本会话。

命令入口（下文简写 `c2c`，所有命令都是 `node "<C2C_LAUNCHER_PATH>" <参数>`）。
`-w` 缺省为当前目录，建议显式传项目根目录。
`c2c` 会写本机状态目录（`%LOCALAPPDATA%\codex-with-chatgpt`）并访问 Desktop 命名管道；沙箱内因权限失败时，直接申请在沙箱外运行同一条命令，不要改用其他方式绕过。

## 收到 [C2C_DESKTOP_TASK]（核心规则）

当某个 turn 的消息以如下首行开头：

```
[C2C_DESKTOP_TASK] workspaceId=<id> commandId=<id>
```

1. 正文是 ChatGPT 规划、用户已确认的计划，按它执行（读代码、改文件、跑测试）。遇到计划无法执行或有风险时，不要擅自扩大范围，用 `blocked` 如实记录。
2. 最终回复之前，必须运行一次（commandId 必须与首行一致，不能代记其他 turn）：

```
c2c record -w <workspace> --command-id <commandId> --status ok|failed|blocked --summary "<你自己的最终总结>" --tests "<测试结果摘要，或 not run>" --changed-files "a.ts,b.ts" [--output-file <日志文件>] --json
```

- `ok` 已完成；`failed` 执行了但失败；`blocked` 无法继续（缺信息、需要人工决定）。
- `--summary` 写你真实做了什么、结果如何，不要复述计划；`--tests` 写本轮实际运行的命令和结果，没跑就写 `not run`。
- 长输出（测试/构建日志）先存成文件，用 `--output-file` 传入；Gateway 会截断并脱敏。
- record 会生成通知，由网页伴侣发回 ChatGPT 对话；ChatGPT 随后用 `codex_task_result` 读取结果并 Review。
3. record 成功后停止一切工具调用，直接给出最终回复。不要再改文件，也不要为通知再做任何事。
4. record 失败（退出码非 0）时，在最终回复里如实说明失败原因，不要假装已记录。

没有这个首行的普通 turn 不需要 record。

## 一次性设置

按顺序做，已完成的步骤跳过。`c2c status` 可查看整体状态。

1. 配置 Gateway（公网 URL 与 tunnel 来自用户的 Cloudflare / OpenAI Secure MCP Tunnel 设置）：
   - `c2c gateway configure --public-url <https://...> --port <port> --tunnel-name <name> --tunnel-id <id> --cloudflared <path> --tunnel-client <path> [--proxy <url>]`
   - `c2c gateway set-key`（按提示输入 tunnel 运行 key，DPAPI 加密保存）
   - `c2c gateway start`，再 `c2c gateway status` 确认 running。
2. 在 ChatGPT 创建 Connector，MCP 地址为 `<publicUrl>/mcp`，认证选 OAuth。授权页要求配对码时运行 `c2c gateway pair` 取一次性配对码（短时有效），由用户在授权页输入。
3. 登记项目：`c2c workspace add -w <workspace>`，`c2c workspace list` 确认 workspaceId。
4. 安装网页伴侣：Chrome/Edge 打开扩展页，开启开发者模式，加载 `%LOCALAPPDATA%\codex-with-chatgpt\app\dist\browser-companion`（源码目录为 `dist/browser-companion`）；`c2c companion token` 取 token 填入伴侣弹窗，并在对应 ChatGPT 对话页点击连接（把该对话绑定到项目）。token 泄露时用 `c2c companion token --rotate` 轮换。
5. 绑定会话（见下）。

## 绑定会话

用户说“把这个会话绑定给 ChatGPT”时，在当前 Codex Desktop 会话里依次运行：

```
c2c workspace add -w <workspace>
c2c desktop bind-current -w <workspace> --json
```

第一条确保项目已登记：未登记时新登记，已登记时输出“已登记过…跳过”，不会重复。
第二条读取 `CODEX_THREAD_ID` 作为绑定目标。成功后告诉用户：workspaceId、线程标题，以及项目是新登记还是已登记过；新登记时提醒用户在 ChatGPT 项目说明里写入这个 workspaceId，并在对应对话里用网页伴侣点“连接当前对话”。其他命令：`c2c desktop status -w <workspace> --json`（绑定、Desktop 是否可用、是否忙碌）、`c2c desktop unbind -w <workspace>`。

## 告诉 ChatGPT 什么

用户让你说明用法时，转述这几点：

- 先 `gateway_list_workspaces` 拿 workspaceId，用只读工具（`read_file`、`search_workspace`、`git_diff` 等）了解项目，再制定计划。
- 用户确认计划后调用 `codex_desktop_send`，必须提供新的 `commandId`（字母数字、`_`、`-`，≤128 字符）；同一个 commandId 不会重发。
- 用 `codex_desktop_status` 查看投递状态，用 `codex_task_result` 读取执行结果（不传 commandId 返回最近一次）。
- Review 后需要修改，就发新的 commandId 的修订消息；不要复用旧 commandId。
- `accepted` 只代表 Desktop 接收了消息，不代表执行完成；以 `codex_task_result` 的结果为准。
- 投递状态为 `unknown` 时先让用户在 Desktop 里确认是否已收到，再决定是否换新 commandId 重发。

## 排查

- `c2c status --json`：整体状态；`c2c gateway status --json`：Gateway 是否运行、端口、publicUrl。
- Gateway 没运行：`c2c gateway start`；日志在状态目录的 `logs/gateway.log`。
- 升级新构建后需要 `c2c gateway stop` 再 `c2c gateway start`，但**正在服务当前任务时先询问用户**，不要自行重启。
- Desktop 忙或不可用、投递结果未知、伴侣不发送等见仓库 `docs/troubleshooting.md`。
- 状态目录是本机私有数据（OAuth、token、结果），不要复制进仓库，也不要手动改动。
