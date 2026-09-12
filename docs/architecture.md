# Architecture

```
             ┌───────────────────────────┐
             │    ChatGPT Web / Sol      │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │
             │  MCP (RO + gated)   │
             │  OAuth AS + PRM     │
             │  Pairing Manager    │
             │  Tunnel Manager     │
             │  Admin API (local)  │
             └──────────┬──────────┘
                        │  read-only
                        ▼
             ┌─────────────────────┐
             │   Local Workspace   │
             └──────────▲──────────┘
                        │ edit / shell / git / test
             ┌──────────┴──────────┐
             │  Codex Harness      │
             └─────────────────────┘
```

## Principles

- **ChatGPT thinks. Codex works.** The bridge never re-implements a coding harness.
- **Computer Use = control plane**: tiny `[C2C]` state messages (< 1 KB).
- **MCP = data plane**: ChatGPT pulls files/diffs/search results itself.
- **Read-only by default**: the 9 base tools remain read-only. Desktop Control is a separately
  authorized plain-text delivery path to one existing Desktop thread; it is not a workspace
  write, shell or arbitrary RPC tool.
- **Workspace is the security boundary**: one bridge = one workspace = one token audience.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | McpServer with 9 read-only tools, always-discoverable but separately guarded Desktop schemas, and optional Remote actions; stateless Streamable HTTP transport (fresh server per request, JSON responses) |
| `desktop/` | Local Desktop binding, version-gated IPC delivery, replay-safe state and delivery status |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment (realpath of deepest existing ancestor), sensitive-file policy, `.c2cignore`, paginated read/list, ripgrep search with Node fallback, git status/diff with pagination |
| `tunnel/` | `TunnelProvider` interface + Cloudflare Quick and workspace-configured Named Tunnel implementations; business logic is vendor-agnostic |
| `execution/` | JSONL execution records plus optional sanitized command output (`execution_output`) |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `core/` | Verified machine install metadata, guarded rollout and per-workspace pending upgrades |
| `cli/` | `c2c` commands; `--json` everywhere for the Skill |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger |

## Request lifecycles

**MCP call**: ChatGPT → tunnel (https) → bridge `/mcp` → bearer middleware
(401/403) → stateless StreamableHTTP transport → tool handler → workspace layer
(path containment → ignore rules → pagination) → JSON result.

**Desktop delivery**: ChatGPT → tunnel (https) → bridge `/mcp` → bearer middleware
and `codex.desktop.control` check → local enable/binding/workspace check → fresh
Desktop process/endpoint/owner/version check → controlled local IPC → bounded
acceptance receipt. The bridge records the delivery before the send attempt and
returns `accepted` only with the real Desktop thread/turn IDs; it never waits for
task completion or exposes raw IPC through the tunnel.

**Desktop execution evidence**: the internal task envelope routes the accepted Desktop turn to
the Skill's local receipt flow. Before its final reply, that same verified active turn records
the exact command ID and this turn's test/output evidence. Review resolves that record and its
output ID, never a historical latest test result. See [automatic receipts](desktop-control.md#自动验收记录).

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens.

**Ports**: prefer 48765, bind 127.0.0.1 only. On conflict, `/health` identifies
the workspace, PID and Bridge start time. Matching runtime identities are reused;
provably stale records allow a new instance on an available port. Uncertain
identities block recovery and shutdown. Legacy health without process identity
requires matching authenticated `/admin/info` before reusing a live instance.
Configuration follows automatically via
the current workspace's runtime file; other workspace processes are untouched.

**Machine Core**: a dependency-free Node launcher in the machine state directory reads strictly
validated v2 `current.json` and executes its immutable `releases/<buildId>` with the same Node and arguments.
The checkoutRoot field is source provenance only. Each release contains copied runtime files and dependencies;
dependency links are confined to the release, and its manifest/content digest and dist build ID are verified before execution.
Rebuilding or moving the checkout cannot alter the installed release. Installation stages and validates a new release,
then atomically switches the pointer; an existing release is never overwritten. Legacy v1 pointers are frozen to the same
installed build before install/build can mutate the checkout; failure stops the installer and preserves the old pointer.
The deterministic SHA-256 `dist/build-id.txt` hashes runtime artifacts including the Desktop helper and Core installer assets, excluding itself.
The build captures entrypoint/package/installer snapshots and a dependency-content digest. Installation copies these snapshots
and verifies dependency contents before and after copying; post-build edits cannot be published under the earlier build ID.
Each Bridge captures its own `runtimeBuildId` at startup; updating the pointer cannot make an old
process report the new build. Health/admin/runtime expose the ID without changing MCP schemas.

Local `rollout` shares the authenticated shutdown/wait/start-tunnel path with CLI restart. It checks
runtime and authenticated admin identity twice and only restarts healthy named tunnels with the
same workspace hostname/URL, no pairing, no Desktop activity/approval/unresolved outcome, and no
Remote queued/active/uncertain execution. Quick, busy and unknown instances are skipped; stopped
workspaces are never started. Minimal per-workspace pending metadata contains no credentials or
message content. `status/doctor` reads it through `runtimeUpgrade`. Successful rollout rechecks the
build, identity and fixed URL; it never changes Connector/OAuth/session/Project/checkpoint/binding.
Phase 1 has no resident Supervisor or polling loop. Workspace state remains strictly isolated.
Only the process holding the machine rollout lock can update pending state. Concurrent losers report
`rollout_busy` without changing runtime, pending or workspace files.

**Tunnel**: default is a Cloudflare Quick Tunnel (`cloudflared tunnel --url …`).
The URL changes per start, so `c2c doctor` can restart it and tell the Skill to
Delete + recreate that workspace's ChatGPT connector. A workspace may instead
choose a named hostname once (`c2c tunnel choose --mode named`). The Skill asks
before the first public URL exists; `cloudflared tunnel login` is the only extra
user step. Tunnel name, hostname and preference live under the OS state dir
(`tunnels/<workspaceId>.json`), never in the project. Named starts use
`cloudflared tunnel --url … run <name>` so the public URL stays stable. If named
provisioning fails, ordinary setup can fall back to Quick Tunnel. Legacy
Connector migration uses `--require-named`: it preserves the existing state on
failure and stops without rebuilding the Connector or reporting Ready. Its
final named URL must be healthy before Connector authorization. If a named tunnel later
drops, doctor asks for a Cloudflare re-login (`namedRepair`) instead of
rotating the ChatGPT connector.
