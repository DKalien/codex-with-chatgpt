# 架构

ChatGPT 网页负责规划与 Review，Codex Desktop 负责执行。整条链路：

```
ChatGPT 网页 ──Secure MCP Tunnel/cloudflared──▶ Gateway /mcp ──codex_desktop_send──▶ Desktop IPC（\\.\pipe\codex-ipc）
     ▲                                                                                      │
     │ 网页伴侣写入通知并点击发送                                Codex 执行完毕运行 c2c record │
     └──── 伴侣轮询 127.0.0.1 Gateway /companion/v1 ◀──── 结果 + 通知队列 ◀───────────────────┘
```

## 进程

只有一个常驻进程：`c2c gateway run`（`c2c gateway start` 以脱离当前 Job 的方式在后台启动它）。
它监听 `127.0.0.1:<port>`，并托管两个子进程：

- `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port> run <tunnelName>`：提供公网 HTTPS origin（OAuth 元数据与 `/mcp`）。
- `tunnel-client run …`（OpenAI Secure MCP Tunnel），运行 key 由 DPAPI 解密后只经环境变量 `C2C_TUNNEL_RUNTIME_KEY` 传入。

tunnel-client 在公网 `/.well-known/oauth-protected-resource` 可达后（最多等 30s）才启动，以免它的启动探测打在尚未就绪的 cloudflared 上。子进程退出后按 2s→60s 退避重启。

## 状态目录（`getStateDir()`，测试用 `C2C_STATE_DIR` 覆盖）

| 路径 | 内容 | 兼容性 |
|---|---|---|
| `gateway/supervisor.json` | Gateway 配置 | 沿用旧格式（多余字段忽略） |
| `gateway/tunnel-runtime-key.dpapi` | DPAPI 密文 | 沿用 |
| `gateway/workspaces.json` | 已登记项目 | 沿用旧格式（`clientIds` 保留不用） |
| `gateway/runtime.json` | 运行中实例 `{pid, port, token, publicUrl, startedAt, children}`（children：各子进程 running/restarting 及最近错误） | 新 |
| `auth/gateway.json` | OAuth client/token（AuthStore identity `machine-gateway`） | 沿用，Connector 无需重建 |
| `companion.json` | 伴侣 token 与各 workspace 绑定的 ChatGPT 对话 URL | 新 |
| `workspaces/<id>/desktop.json` | Desktop 绑定与投递记录 | 新 |
| `workspaces/<id>/results/<commandId>.json` | 执行结果 | 新 |
| `workspaces/<id>/notifications.json` | 待发回网页的通知 | 新 |
| `logs/gateway.log` | Gateway 与子进程日志 | 新 |

其余旧目录不再读取，也不会被删除。

## 模块契约

公共基础：`src/errors.ts`（`C2CError(code, message)`）、`src/util/json-file.ts`（`readJson`、`writeJson`、`withLock`、`updateJson`）、`src/state.ts`（`workspaceDir(id)`）。
复用模块：`workspace/*`、`auth/*`、`pairing/manager.ts`、`mcp/http.ts`、`logger/index.ts`、`execution/sanitize.ts`、`config/paths.ts`。

### desktop/ipc.ts — Codex Desktop 命名管道客户端

帧格式：4 字节小端长度 + UTF-8 JSON。管道默认 `\\.\pipe\codex-ipc`，环境变量 `C2C_DESKTOP_PIPE` 可覆盖（测试用）。

```ts
export class DesktopIpcError extends C2CError { readonly sent: boolean }   // sent=true 表示 start-turn 字节可能已送达
export interface ThreadState { runtimeStatus: string; busy: boolean; title?: string; cwd?: string }
export class DesktopClient {
  static connect(opts?: { pipe?: string; timeoutMs?: number }): Promise<DesktopClient>; // 连接 + initialize
  discoverOwner(threadId: string): Promise<string>;
  snapshot(threadId: string): Promise<ThreadState>;
  startTurn(threadId: string, text: string): Promise<{ turnId: string }>;
  close(): void;
}
```

协议（取自已验证的旧 Python helper）：

- 请求：`{type:"request", requestId:<uuid>, sourceClientId, version, method, params, targetClientId?}`；
  `initialize`(v0, params `{clientType:"c2c"}`，result.clientId 作为后续 sourceClientId)、
  `thread-owner-discovery`(v1, params `{hostId:"local", conversationId}`，owner = response.handledByClientId；error `no-client-found` → `DESKTOP_NO_OWNER`)、
  `thread-follower-start-turn`(v2, targetClientId=owner, params `{conversationId, turnStart:{request:{threadId, input:[{type:"text", text, text_elements:[]}]}}}`，turnId = result.result.turn.id)。
- 响应：`{type:"response", requestId, resultType:"success"|…, result?, error?, handledByClientId?}`。
- 必须应答 `{type:"client-discovery-request", requestId}` → `{type:"client-discovery-response", requestId, response:{canHandle:false}}`。
- 快照：发送 broadcast `{type:"broadcast", method:"thread-stream-following-changed", version:1, sourceClientId, targetClientIds:[owner], params:{conversationId, hostId:"local", following:true}}`，
  等待 broadcast `thread-stream-state-changed`（params.conversationId 匹配，params.change.type==="snapshot"），state = params.change.conversationState。
  `busy = threadRuntimeStatus.type !== "idle" || requests 非空 || unconfirmedTurnSubmissions 非空 || 任一 turns[].status === "inProgress"`。
- 错误码：`DESKTOP_UNAVAILABLE`（管道不存在/断开）、`DESKTOP_NO_OWNER`、`DESKTOP_TIMEOUT`、`DESKTOP_PROTOCOL`、`DESKTOP_REJECTED`、`DESKTOP_OUTCOME_UNKNOWN`。超时：常规 5s，start-turn 30s。start-turn 请求写出后，任何非预期响应（非 success、method 或 handledByClientId 与请求不符）都按 `DESKTOP_OUTCOME_UNKNOWN`（`sent=true`）处理，不记为 rejected、不允许同 commandId 重发。

### desktop/store.ts、desktop/service.ts

```ts
export interface DesktopBinding { threadId: string; title?: string; boundAt: string }
export type DeliveryStatus = "sending" | "accepted" | "rejected" | "unknown";
export interface DesktopDelivery { commandId: string; status: DeliveryStatus; messageSha256: string; turnId?: string; error?: string; createdAt: string; updatedAt: string }
export interface DesktopState { binding: DesktopBinding | null; deliveries: DesktopDelivery[] } // 只保留最近 500 条
export function readDesktop(workspaceId: string): DesktopState;
export function updateDesktop<R>(workspaceId: string, fn: (state: DesktopState) => R): R;

// service.ts
export const COMMAND_ID = /^[A-Za-z0-9_-]{1,128}$/; export const MAX_MESSAGE_BYTES = 64 * 1024;
export function formatDesktopTask(input: { workspaceId: string; commandId: string; message: string }): string;
// → "[C2C_DESKTOP_TASK] workspaceId=<id> commandId=<id>\n\n<message>"
export function sendToDesktop(input: { workspaceId: string; commandId: string; message: string }, opts?: DesktopDeps): Promise<DesktopDelivery>;
export function desktopStatus(workspaceId: string, opts?: DesktopDeps): Promise<{ binding: DesktopBinding | null; available: boolean; busy?: boolean; error?: string }>;
export function bindCurrentDesktop(workspaceId: string, opts?: DesktopDeps & { env?: NodeJS.ProcessEnv }): Promise<DesktopBinding>; // threadId 来自 CODEX_THREAD_ID
export interface DesktopDeps { connect?: typeof DesktopClient.connect; busyWaitMs?: number /*60000*/; pollMs?: number /*1000*/ }
```

发送语义：

1. 校验 commandId/消息大小；未绑定 → `DESKTOP_NOT_BOUND`。
2. 同 commandId 已有记录：正文 sha256 不同 → `COMMAND_CONFLICT`；状态非 `rejected` → 直接返回原记录（幂等，不重发）；`rejected` 允许重试。
3. 连接、找 owner、轮询快照直到空闲；超过 `busyWaitMs` → 抛 `DESKTOP_BUSY`（未发送，不记录）。
4. 加锁写入 `sending` 记录（若此时已有非 rejected 记录则返回它）。
5. `startTurn`：成功 → `accepted` + turnId；`DesktopIpcError.sent=false` → `rejected`；其他 → `unknown`（不自动重发，ChatGPT 可换新 commandId）。`rejected`/`unknown` 作为记录返回而不抛错；步骤 1–3 的失败（含 `INVALID_COMMAND_ID`、`EMPTY_MESSAGE`、`MESSAGE_TOO_LARGE`）抛 `C2CError`。

### results/store.ts — 执行结果与通知队列

```ts
export type ResultStatus = "ok" | "failed" | "blocked";
export interface ResultInput { workspaceId: string; commandId: string; status: ResultStatus; summary: string; tests?: string; changedFiles?: string[]; notes?: string; output?: string }
export interface ResultRecord extends ResultInput { recordedAt: string; outputTruncated?: boolean }
export type NotificationState = "pending" | "claimed" | "delivered";
export interface Notification { id: string /*uuid*/; workspaceId: string; commandId: string; status: ResultStatus; text: string; state: NotificationState; createdAt: string; claimedAt?: string; deliveredAt?: string }
export function recordResult(input: ResultInput): { result: ResultRecord; notification: Notification };
export function readResult(workspaceId: string, commandId: string): ResultRecord | null;
export function listResults(workspaceId: string, limit?: number): ResultRecord[]; // 新→旧
export function listNotifications(workspaceId: string): Notification[];
export function claimNotification(workspaceId: string, id: string): Notification;   // pending→claimed，否则 NOTIFICATION_NOT_PENDING
export function ackNotification(workspaceId: string, id: string): Notification;     // claimed→delivered（已 delivered 幂等）
export function requeueNotification(workspaceId: string, id: string): Notification; // claimed→pending（仅人工重发）
export function renderNotification(n: Pick<Notification, "id" | "workspaceId" | "commandId" | "status">): string;
```

- summary 上限 8 KiB，output 上限 256 KiB（超出截断并置 `outputTruncated`），output 经 `sanitizeExecutionOutput` 脱敏。
- 同 commandId 再次 record：覆盖结果；若已有该 commandId 的 `pending` 通知则原地更新，否则新建通知。通知最多保留 200 条。
- 通知正文（`ATTEMPT_ID` 行供伴侣在 DOM 中精确确认送达，必须恰好一行）：

```
[C2C] Codex 已执行完毕（自动通知，不是新指令）。请调用 codex_task_result 读取结果并 Review。
WORKSPACE_ID: <id> | COMMAND_ID: <id> | STATUS: <status>
ATTEMPT_ID: <notification.id>
```

### companion/store.ts、companion/api.ts — 网页伴侣接口

`companion.json`：`{ token: string, conversations: { [workspaceId]: string /*ChatGPT 对话 URL*/ } }`。

```ts
export function companionToken(opts?: { rotate?: boolean }): string;
export function setConversation(workspaceId: string, url: string | null): void; // url 须为 https://chatgpt.com/… 且含 /c/<id>
export function getConversations(): Record<string, string>;
export function createCompanionRouter(deps: { registry: Registry }): express.Router; // 挂载于 /companion/v1
```

全部端点只接受本机直连请求（见 Gateway），并要求 `Authorization: Bearer <companion token>`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/state` | `{ workspaces: [{ workspaceId, name, conversationUrl, notifications: Notification[] /*pending+claimed*/ }] }` |
| POST | `/connect` `{workspaceId, conversationUrl}` | 绑定对话 |
| POST | `/disconnect` `{workspaceId}` | 解绑 |
| POST | `/claim` `{workspaceId, id}` | 领取一条 pending 通知 → `{ notification }` |
| POST | `/ack` `{workspaceId, id}` | 页面已确认出现该消息 |
| POST | `/requeue` `{workspaceId, id}` | 人工重发 |

错误响应：`{ error: code, message }`，状态码 400/401/404/409。

扩展（`browser-companion/`）：已连接对话页每 5 秒心跳一次。页面就绪条件只有“输入框存在、为空、没有停止按钮”；用户自己输入的内容不会被覆盖，此时等待。投递时写入→点击发送→在对话中确认 `ATTEMPT_ID` 后 ack；点击前失败则 requeue，并且仅当输入框内容与本次写入完全一致时清空。最近一次心跳结果写入 `chrome.storage.local.lastStatus`，在弹窗顶部显示。

### gateway/*

```ts
// registry.ts
export interface WorkspaceEntry { workspaceId: string; root: string; name: string }
export class Registry { constructor(stateDir?: string); list(): WorkspaceEntry[]; add(root: string): WorkspaceEntry; remove(workspaceId: string): boolean; resolve(workspaceId: string): Workspace /* UNKNOWN_WORKSPACE */ }
// config.ts
export interface GatewayConfig { publicUrl: string; port: number; tunnelName: string; tunnelId: string; cloudflaredPath: string; tunnelClientPath: string; proxy: string | null; keyFile: string }
export function readGatewayConfig(): GatewayConfig | null; export function writeGatewayConfig(config: GatewayConfig): void;
export function setTunnelKey(): void; export function readTunnelKey(keyFile: string): string; // Windows PowerShell DPAPI
// server.ts
export function startGatewayServer(opts: { port: number; publicUrl: string; runtimeToken: string; onShutdown?: () => void }): Promise<{ port: number; pairingCode(): { code: string; expiresAt: number }; close(): Promise<void> }>;
// run.ts
export function runGateway(): Promise<void>; export function startGatewayDetached(): Promise<void>; export function stopGateway(): Promise<boolean>;
export function gatewayStatus(): Promise<{ running: boolean; pid?: number; port?: number; publicUrl?: string }>;
```

请求分区：

- 本机直连 = `remoteAddress` 为回环、`Host` 为 `127.0.0.1:<port>` 或 `localhost:<port>`、且无 `x-forwarded-*`/`forwarded`/`cf-*` 头（cloudflared 也从回环连入，靠这些头区分）。
- 公网（经 cloudflared）只放行 OAuth 路由、`/.well-known/*` 与 `/mcp`；其余 404。
- `/companion/v1/*` 与 `/internal/*` 只放行本机直连；`/internal/*` 还要求 `x-c2c-runtime-token`（来自 `runtime.json`）。
  `/internal/health`、`/internal/pairing`（生成新 OAuth 配对码）、`/internal/shutdown`。

### mcp/server.ts — MCP 工具

`createMcpServer(deps: { registry: Registry; desktop?: Partial<DesktopDeps> }): McpServer`。Bearer 校验由 `/mcp` 中间件完成，工具内不再做 scope 判定。除 `gateway_list_workspaces` 外均需 `workspaceId`：

- `gateway_list_workspaces`
- `workspace_info`、`list_directory`、`read_file`、`search_workspace`、`git_status`、`git_diff`（只读，沿用旧实现语义）
- `codex_desktop_status`（`{workspaceId, commandId?}` → 绑定、可用性、该 commandId 的投递记录与结果）
- `codex_desktop_send`（`{workspaceId, commandId, message}` → `DesktopDelivery`）
- `codex_task_result`（`{workspaceId, commandId?}` → `{result: ResultRecord | null}`，缺省取最近一次，无结果时为 null）

### CLI（`c2c`，`-w` 缺省为当前目录）

```
gateway configure --public-url --port --tunnel-name --tunnel-id --cloudflared --tunnel-client [--proxy]
gateway set-key | run | start | stop | status [--json] | pair
workspace add [-w]（已登记则跳过） | list [--json] | remove <workspaceId>
desktop bind-current [-w] [--json] | status [-w] [--json] | unbind [-w]
record [-w] --command-id <id> --status ok|failed|blocked --summary <text> [--tests] [--changed-files a,b] [--notes] [--output-file <path>] [--json]
companion token [--rotate]
status [--json]
```

## 安全边界（全部保留项）

- 公网入口只有 OAuth（PKCE + 本机配对码）与带 Bearer 的 `/mcp`。
- 伴侣接口与管理接口只接受本机直连，并分别要求伴侣 token / runtime token。
- 只读工具沿用 `Workspace.resolve` 的路径越界与敏感文件拒读；执行输出脱敏。
- 同 commandId 不重发；已领取的通知不会被自动再次发送。
