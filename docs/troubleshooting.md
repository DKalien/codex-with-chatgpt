# Troubleshooting

Use the installed stable launcher for the `c2c` commands below and specify `-w <workspace>`.
For read-only inspection, start with `c2c status --json` or `c2c doctor --no-fix --json`.
When connection repair is intended:

```
c2c doctor
```

It checks Node, workspace, bridge, MCP, OAuth and tunnel — and repairs what it
can (restarts the bridge, restarts the tunnel) without asking.

### Core installed, but a workspace still reports an older build

Building the checkout only produces artifacts. `scripts/dev-install.ps1` installs an immutable
release, switches the machine pointer, installs the Skill, and attempts safe rollout. Rebuilding
or moving the checkout afterward does not alter that installed release.
Read `runtimeUpgrade` in `status/doctor --json`: `installedBuildId` is the selected release;
`runtimeBuildId` belongs to the running process and may be absent on legacy builds.

`busy`, approval, unresolved outcome, unknown identity, pairing or Remote activity keep the
workspace pending. `quick` is skipped because a restart would change its URL; stopped workspaces
are not started. Once a named workspace is provably healthy and idle, a local
`c2c rollout -w <workspace> --json` can retry. Phase 1 has no background Supervisor.
A concurrent `rollout_busy` response performs no state writes; it does not create a new pending record.
Do not rebuild a compatible Connector or reauthorize OAuth merely because the Core build differs.
Do not interrupt an active Review Bridge to clear pending status.

## Common situations

### "Bridge 未运行"
`c2c start` (or let doctor do it). Bridge logs:
`c2c logs`, or verbose: `c2c logs --verbose`.

If doctor says the bridge state is **uncertain** (无法确认), do not start a
second bridge and do not Delete the ChatGPT connector. Wait and run doctor
again. The local process may still be running.

### Everything was quit and ChatGPT can no longer connect
Closing a terminal does not necessarily stop the detached Bridge. Check the actual runtime first.
If a quick tunnel did stop, the next repairing `c2c doctor` may create a new address and set
`chatgptRepair.needed`. The Skill should tell the
user that the old address expired, then **Delete** THIS workspace's
connector (`chatgptRepair.connectorName`) and create it again with the new
address (never click Reconnect — the old URL is dead). Other workspaces keep
their own connectors so two projects can stay connected at once.

Fixed ChatGPT pages for first-time setup and later repair (do not hunt the UI):

- Developer mode: https://chatgpt.com/#settings/Security
- Plugins hub (manage existing connectors): https://chatgpt.com/plugins
- Add a connector:
  https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

### Tunnel URL unreachable / ChatGPT says the connector is broken
Same as above: `c2c doctor`, then Delete + recreate THIS workspace's
connector if `chatgptRepair.needed`. Fresh pairing code: `c2c pair`.
If this workspace uses a stable hostname, doctor sets `namedRepair` instead —
re-login to Cloudflare (`c2c tunnel login`) and doctor again. Do not Delete
the connector; the address did not change.

### Connector was rebuilt, but the old chat says "tool has been disabled"

Do not rebuild the Connector again. After local authorization and the current contract are verified,
Activation uses Conversation Rebind: create a chat inside the saved Project, send boot and any necessary
HANDOFF, and verify `workspace_info` plus current Desktop schemas through the exact connector name.
Only a verified replacement chat updates `session.url`; Project, instructions, checkpoint and task remain.
Legacy long-chat uses the existing switch-chat/HANDOFF flow. Failure stops without claiming Ready.
See [migration and rebind](desktop-control.md).

### I have a Cloudflare domain and want a stable hostname
During first-time setup (or the next coding session, once), say you have a
Cloudflare account and give the domain. Codex opens a browser for Cloudflare
login, then keeps `c2c-<project>.your-domain.com`. To stay on the temporary
address, say you do not have a domain. Switching later: tell Codex you want
the stable hostname; it runs `c2c tunnel choose --mode named --zone <domain>`.

### "配对码无效/过期"
Pairing codes are one-time and expire after ~5 minutes:

```
c2c pair
```

generates a fresh one (older codes become invalid immediately).

### ChatGPT gets 401 on every tool call
The access token expired and refresh failed (e.g. after `c2c unpair` or a
long offline period). Delete THIS workspace's connector if the address also
changed; otherwise run Authorize again in ChatGPT and enter a fresh pairing
code. Never use Reconnect when the public address has been replaced.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.
If cloudflared is installed in a custom location that is not on `PATH`, set
`C2C_CLOUDFLARED_PATH` to the executable's absolute path before running `c2c`.

### Every new Codex chat “repairs” the connection / cannot write logs
The C2C state directory lives outside the project (macOS:
`~/Library/Application Support/codex-with-chatgpt`; Windows:
`%LOCALAPPDATA%\codex-with-chatgpt`). Codex's default sandbox cannot write
there, so each new chat looks like a health-check failure.

`c2c setup`, `c2c doctor` and `c2c sandbox-allow` add that directory to
`[sandbox_workspace_write].writable_roots` in `~/.codex/config.toml`
(`%USERPROFILE%\.codex\config.toml` on Windows). After that, later chats
do not need elevation.

### Port already in use
An existing healthy Bridge is reused only when its workspace and runtime identity
match. If an old runtime points at a port now used by another workspace, recovery
is allowed only when the saved PID is gone, or the same PID has a provably newer
`startedAt`. Legacy health responses without identity fields require a dead saved
PID for stale recovery. A live legacy Bridge can instead be verified only when
health names this workspace and authenticated `/admin/info`, using its saved
admin token, exactly matches the saved service, workspace ID, PID and start time.
Missing fields, failed authentication or identity mismatches remain `unknown`.
Restart requires successful authenticated shutdown and waits for the old runtime
to exit before starting the replacement; it does not claim success by reusing it.
Recovery starts this workspace on an available port and replaces only its runtime
metadata, preserving authorization, tunnel, session, Project and task state.
Stopping uses verified identity and authenticated shutdown; it never kills an
unverified saved PID or shuts down the other workspace.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env`, keys, credentials and anything matched by
`.c2cignore` are never readable through ChatGPT. `.env.example` is allowed.

### I cannot see Projects in the ChatGPT sidebar
Hover **Chats** /「聊天」, click the … that appears, and choose
**Organize by project** /「按项目整理」. Then create a project named after
this workspace, with **project-only memory**. Tell Codex「好了」when the
collection page is open (`https://chatgpt.com/g/g-p-…/project`).

### This workspace opened the wrong ChatGPT Project
Do not pick another project by name automatically. Open the collection that
matches this workspace and tell Codex「已找到」, or say you want the old
long-chat instead. Each workspace has its own Project and its own connector.

### Completely stuck

Inspect `c2c status --json` and `c2c doctor --no-fix --json` first. When repair is intended,
`c2c doctor` can restore eligible local components; `c2c setup` ensures Bridge/tunnel availability
and generates a fresh pairing code, reusing saved state. Neither is a request to erase
authorization, Connector, session or Project. Unknown identity and active-task upgrade gates
still apply; do not use stop/setup as an automatic reset of a live Review workspace.
