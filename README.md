# Codex with ChatGPT

> ChatGPT thinks. Codex works. · 简体中文见 [README.zh-CN.md](README.zh-CN.md)

Use the ChatGPT web app as the planning and review brain for your Codex Desktop sessions, while Codex keeps full ownership of execution. ChatGPT reads your project through an OAuth-protected, read-only MCP connection, sends a confirmed plan to a bound Codex Desktop thread, and receives Codex's result back in the conversation.

```
ChatGPT web ──Secure MCP Tunnel/cloudflared──▶ Gateway /mcp ──codex_desktop_send──▶ Desktop IPC (\.\pipe\codex-ipc)
     ▲                                                                                      │
     │ companion writes the notice and clicks send                  Codex finishes, runs c2c record
     └──── companion polls 127.0.0.1 Gateway /companion/v1 ◀──── result + notification queue ◀──┘
```

Windows only (DPAPI key storage, Desktop named pipe). Requires Node.js >= 20, pnpm, `cloudflared`, and an OpenAI Secure MCP Tunnel client.

## Install

```powershell
git clone <this repo>; cd codex-with-chatgpt
pwsh scripts/dev-install.ps1      # add -Test to run the tests first
```

This builds, installs to `%LOCALAPPDATA%\codex-with-chatgpt\app`, writes the stable launcher `bin\c2c.mjs`, and installs the Codex Skill. Below, `c2c` means `node "%LOCALAPPDATA%\codex-with-chatgpt\bin\c2c.mjs"`.

## Setup (once)

1. `c2c gateway configure --public-url <https://…> --port <port> --tunnel-name <name> --tunnel-id <id> --cloudflared <path> --tunnel-client <path>`, then `c2c gateway set-key` and `c2c gateway start`.
2. In ChatGPT, create a connector pointing at `<publicUrl>/mcp` with OAuth. When asked for a pairing code, run `c2c gateway pair`.
3. `c2c workspace add -w <project>` (optional: binding in step 5 registers the project automatically and skips already registered ones).
4. Load the browser companion (`%LOCALAPPDATA%\codex-with-chatgpt\app\dist\browser-companion`) as an unpacked extension, paste the token from `c2c companion token`, and connect it to the ChatGPT conversation for the project.
5. In the Codex Desktop session, say "bind this session to ChatGPT" (the Skill runs `c2c workspace add` and then `c2c desktop bind-current -w <project> --json`). For a new project, put its `workspaceId` in the ChatGPT project instructions and connect the companion in that conversation.

## Daily use

Ask ChatGPT to plan. It reads the project with the read-only tools, you confirm the plan, ChatGPT calls `codex_desktop_send` with a new `commandId`. Codex executes and runs `c2c record` before its final reply; the companion posts the notice back to ChatGPT, which reads the result with `codex_task_result` and reviews. Revisions are sent with a new `commandId`.

`c2c status` and `c2c gateway status` show the current state.

## Development

`pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm test` (full gate, about a minute), `pnpm run typecheck`.

## Docs

- [Architecture and module contracts](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Codex Skill](skill/SKILL.md)

## License

MIT, see [LICENSE](LICENSE).
