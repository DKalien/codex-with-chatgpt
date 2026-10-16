# Codex with ChatGPT

> ChatGPT 负责思考，Codex 负责干活。 · English: [README.md](README.md)

把 ChatGPT 网页版变成 Codex Desktop 会话的“规划与 Review 大脑”，执行权完全留在 Codex 手里。ChatGPT 通过 OAuth 保护的只读 MCP 连接读取项目，把确认后的计划投递到已绑定的 Codex Desktop 会话，并在对话里收到 Codex 的执行结果。

```
ChatGPT 网页 ──Secure MCP Tunnel/cloudflared──▶ Gateway /mcp ──codex_desktop_send──▶ Desktop IPC（\.\pipe\codex-ipc）
     ▲                                                                                      │
     │ 网页伴侣写入通知并点击发送                                Codex 执行完毕运行 c2c record │
     └──── 伴侣轮询 127.0.0.1 Gateway /companion/v1 ◀──── 结果 + 通知队列 ◀───────────────────┘
```

仅支持 Windows（DPAPI 密钥存储、Desktop 命名管道）。需要 Node.js >= 20、pnpm、`cloudflared` 和 OpenAI Secure MCP Tunnel 客户端。

## 安装

```powershell
git clone <本仓库>; cd codex-with-chatgpt
pwsh scripts/dev-install.ps1      # 加 -Test 先跑测试
```

脚本会构建、安装到 `%LOCALAPPDATA%\codex-with-chatgpt\app`、写入稳定 launcher `bin\c2c.mjs` 并安装 Codex Skill。下文 `c2c` 指 `node "%LOCALAPPDATA%\codex-with-chatgpt\bin\c2c.mjs"`。

## 首次设置

1. `c2c gateway configure --public-url <https://…> --port <port> --tunnel-name <name> --tunnel-id <id> --cloudflared <路径> --tunnel-client <路径>`，然后 `c2c gateway set-key`、`c2c gateway start`。
2. 在 ChatGPT 创建 Connector，地址 `<publicUrl>/mcp`，认证选 OAuth；授权页要求配对码时运行 `c2c gateway pair`。
3. `c2c workspace add -w <项目目录>`（可省略：第 5 步绑定时会自动登记，已登记则跳过）。
4. 以“加载已解压的扩展程序”方式加载网页伴侣（`%LOCALAPPDATA%\codex-with-chatgpt\app\dist\browser-companion`），填入 `c2c companion token` 输出的 token，并在该项目对应的 ChatGPT 对话页点击连接。
5. 在 Codex Desktop 会话里说“把这个会话绑定给 ChatGPT”（Skill 会先执行 `c2c workspace add`，再执行 `c2c desktop bind-current -w <项目> --json`）。新项目需把 `workspaceId` 写进 ChatGPT 项目说明，并在该对话里用伴侣点击连接。

## 日常使用

让 ChatGPT 做规划：它用只读工具了解项目，你确认计划后，ChatGPT 用新的 `commandId` 调用 `codex_desktop_send`。Codex 执行并在最终回复前运行 `c2c record`；伴侣把通知发回 ChatGPT，ChatGPT 用 `codex_task_result` 读取结果并 Review。需要修改时用新的 `commandId` 发修订。

`c2c status`、`c2c gateway status` 查看当前状态。

## 开发

`pnpm install --frozen-lockfile`、`pnpm run build`、`pnpm test`（完整门禁，约 1 分钟）、`pnpm run typecheck`。

## 文档

- [架构与模块契约](docs/architecture.md)
- [常见问题排查](docs/troubleshooting.md)
- [Codex Skill](skill/SKILL.md)

## 许可证

MIT，见 [LICENSE](LICENSE)。
