# 官方 App Server 本机隔离投递验证

2026-10-05，使用当前 Codex CLI 0.160.0 仅运行一次：

```powershell
node --import tsx experiments/official-dispatch/probe.mjs --live
```

本机 `app-server --stdio` 投递完成。新建 ephemeral thread 使用 `approvalPolicy=never`、`readOnly` sandbox 和 `networkAccess=false`；ChatGPT 账户类型为 `chatgpt`，`requiresOpenaiAuth=true`。两轮都收到 `completed`，返回值均与 scratch fixture 精确匹配；第二轮没有工具调用。`thread/read` 被拒绝，RPC code 为 `-32600`，证据记录为 `request_rejected`；没有据 ephemeral 属性推断拒绝原因，也没有因此重试。官方文档将 `thread/read` 描述为读取已存储线程，ephemeral 线程不落盘的 schema 说明仅用于理解能力边界，不代表本次 RPC 拒绝原因：[App Server 文档](https://learn.chatgpt.com/docs/app-server)。

未传入 `model` 或 `modelProvider` 覆盖。`model/list` 标记的 default ID 是 `gpt-6.1-sol`，而 `thread/start` 返回的 `effectiveModel` 是 `gpt-6-astra`（provider `openai`）；这是本次观测到的差异，没有改写配置或切换模型。

探针记录的 App Server child PID 为 `23716`；客户端 close 已完成，child 收到 `SIGTERM` 并触发 exit/close，post 快照中该 PID 已不存在。scratch 清理成功。忽略目录 `.tooling/official-dispatch-20261005/` 保存了完整脱敏投递结果 `run-d49c5e77-75c1-4e1e-b5ec-fc4590205df8.json`，以及前后白名单进程快照 `process-before-070e101056294a4d8a333c0c850f7dd9.json`、`process-after-070e101056294a4d8a333c0c850f7dd9.json`。进程条目只含 PID、PPID、creation 和 executable，快照另附采集时间。

本机两轮投递与同 thread continuation 已通过；下方另记录了一次普通 Project Chat 经既有独立 Tunnel 的官方下发与按需读取。本页还记录了持久 Desktop session 的可见、接管和 Desktop 自有 active turn 插话验证；独立 App Server active turn 的 Desktop 插话及普通 Chat 的 Events 自动唤醒仍未验证。

## 持久 Desktop session 可见性、接管与 active owner 边界

2026-10-05，主代理通过官方 `read_thread`、近期 `list_threads` 和原生 Desktop 导航核验 thread `01a10b83-770a-7cb0-b5fd-b7b923a03704`：列表中 projectId 为 `e6c3c73a-44fe-4254-bda9-edfc5ddb6389`、标题为 `官方投递桌面接管测试 f64027a7`、状态为 `notLoaded`，导航返回 `navigated=true`。Desktop 随后完成接管 turn `01a10b86-4b50-7f31-9daa-415021bd5994`，回复原 marker 与“桌面接管成功”，没有工具调用。持久 thread 的列表、读取、导航和人工接管均已通过。

active turn 插话有两次不同结果。第一轮 root 发起的等待 turn `01a10b8b-3c76-7531-8c99-cf6a2e8cd859` 持续 50 秒未收到用户输入，结果 `C2C_NO_STEER_RECEIVED`，不计为通过。之后用户在 Desktop 自己重发等待后，于同一 turn `01a10b8d-f86a-7983-9f61-8771d5b88acf` 中插话；item 顺序为 user wait → commentary → 50 秒 sleep → user 插话 → final `C2C_DESKTOP_STEER_OK`，耗时 14,260 ms。它证明 Desktop 可插入 Desktop 自己持有的 active turn，不证明 Desktop 能插入由独立 App Server 持有的 active turn。

为核验后一边界，主代理只运行了一次独立 active-owner 探针 `.tooling/official-dispatch-20261005/active-owner-3947661a-9d17-4403-8fd5-d780e565db4b.json`。它在 `turn/start` 前以 RPC `-32600` 失败，`threadId` 和 `turnId` 均为空；自有 child PID `4140` 的 exit/close 均已观察到，artifact SHA-256 为 `8b4e96802e8b752e7bcc26f1c419fadb1e6ea392fb1833ccddcc0d24f0efd122`。因此没有创建该探针 turn。

随后未启动 turn 的诊断 `.tooling/official-dispatch-20261005/active-owner-resume-diagnostic-20261005.json` 仅调用 initialize、`account/read`、`thread/read` 和 `thread/resume`，没有调用 `turn/start`；initialize、ChatGPT account 与 `thread/read` 均成功，thread source 为 `vscode`、状态为 `notLoaded`。`thread/resume` 对精确测试 thread 以 RPC `-32600` 拒绝，message 为 `thread 01a10b83-770a-7cb0-b5fd-b7b923a03704 already has an active writer`。诊断 artifact SHA-256 为 `7ac78f30ba4c9728ab63ee7074c46ae63764c9eab8eff1d5be131a58d2dfbb09`。这说明在本次 Desktop writer 活跃时，另一个 App Server 进程不能直接 resume 该 thread；不据此推断其他状态下都不能 resume，也没有验证跨进程 busy 插话。

原 reporter artifact `desktop-session-run-f64027a7-b4e3-49d6-b535-8db989385d68.json` 的 `closeObserved=false` 与退出码 1 保持原样，SHA-256 仍为 `1859d8c4956a6c6a1967de07bc59dccc359df0551c1f2edd4f9e8d7fa5aad70e`。诊断 child PID `24832` 的 `closeObserved=false` 也保留为未观察；主代理事后只读 CIM 确认 PID `4140`、`24832` 及其直接子进程均不存在，既有 `codex.exe` PID `1816`、`18172`、`17884` 的 PID/creation/executable 未变。进程退出观察不替代原 reporter 的 close 事件证据。

## 普通 Chat + 独立 Tunnel 网页验证

2026-10-05，在普通 Project Chat 经既有独立 Tunnel 完成一次真实下发。`read_official_dispatch_state` 对本次 ID `d979ab2f-29c9-486a-a92c-e33a5fb1a585` 首先返回 `not_started`；唯一一次 `run_official_dispatch_probe` 在 45 秒界限返回 `running`。用户随后显式发起一次 `read_official_dispatch_state`，得到 `completed`。完整报告与本机证据逐字段匹配。

本机证据为 `.tooling/official-dispatch-20261005/run-c1f021e3-d730-4a58-91bc-7fce6217337b.json`，SHA-256 `74335f5ae54c9502bb11ce22814bb4fe990984fa5e76526207c65e4bb37644bc`。线程 `01a10b2f-ef25-7350-a8e6-5a004500c9e5` 的两轮 turn `01a10b2f-f095-7c13-ad35-1e222d255f20` 与 `01a10b30-a018-7dc1-b6de-b4e49eda20f3` 均为 `completed` 且精确匹配；第二轮 `noToolActions=true`。`thread/read` 返回 RPC `-32600`，拒绝原因仍为未知，没有按 ephemeral 属性推断原因。App Server child 已关闭且 scratch 已清理；前后白名单快照中的三个既有 `codex.exe` PID/creation 未变。用户已 `quit`；主代理于 `2026-10-05 16:46:30 +08:00` 只读核验端口 `43872` 和本 run health `2367` 的监听数均为 0，probe PID `24328` 不存在，精确路径 `D:\python\codex-with-chatgpt\.tooling\official-mcp-events-20261005\client\tunnel-client.exe` 的进程数为 0。三个既有 Codex 进程 PID/创建时间仍相同：`1816` / `01:00:32.923974`、`18172` / `01:01:02.48519`、`17884` / `09:00:42.903078`（+08:00）。

Chat 工具调用结果由用户提供并与上述本机报告互证；没有独立 ChatGPT 平台日志。本次证明这个普通 Project Chat 的一次官方下发和显式按需读取。本机持久 Desktop session 的可见、接管和 Desktop 自有 turn 插话已另行通过；普通 Chat 经 Tunnel 的持久会话、连续投递及相应回流仍待验证，也未验证 Events 自动唤醒或 Desktop 插入独立 App Server 的 active turn。MCP SDK classic `initialize` / `tools/list` / `tools/call` 与无状态 Streamable HTTP 的 in-process fake 检查通过；本次 Tunnel 也实际完成了该工具调用，但不构成旧 schema 缓存、重启或其他 route 的兼容性证明。

若继续新的网页实验，可在原 PowerShell 窗口运行忽略目录 launcher，并在隐藏输入提示中输入现有 runtime API key：

```powershell
.\.tooling\official-mcp-events-20261005\run-local-experiment.ps1 -Probe official-dispatch
```

本机如需经过已验证的 loopback proxy，可选用：

```powershell
.\.tooling\official-mcp-events-20261005\run-local-experiment.ps1 -Probe official-dispatch -ControlPlaneProxy http://127.0.0.1:7897
```

launcher 默认仍使用既有 events 实验路径；`-Probe official-dispatch` 选择独立端口 `127.0.0.1:43872` 和 `/mcp` endpoint。runtime key 与随机 Bearer 只暂存在该 PowerShell 进程环境；probe 的 App Server 子进程会过滤这些变量。网页可看到 `read_official_dispatch_state()` 和 `run_official_dispatch_probe(experiment_id)` 两个工具。执行工具只接受 launcher 打印的当前随机 UUID，schema 使用稳定 UUID 字符串，不把本次 ID 固化为动态 enum/const；与当前 ID 不匹配的调用（包括旧进程缓存的 ID）会在 dispatch 前拒绝。执行工具执行固定两轮 scratch-fixture 任务，最长等待 45 秒后返回 `running`；本进程内同 ID 的重复调用返回同一状态，不会提交第二个 turn。状态保存在 probe 进程内；终态时会额外向 ignored `.tooling/official-dispatch-20261005/` 写入脱敏摘要证据。只有终态才返回 turn IDs、精确匹配布尔值和清理摘要，不返回 fixture 内容。

启动后 launcher 会打印当前随机 ID。普通 Chat 先调用 `read_official_dispatch_state()` 取得本次 ID，再用以下唯一参数调用执行工具：

```json
run_official_dispatch_probe({"experiment_id":"<launcher 打印的 Experiment ID>"})
```

本进程内重复调用同一 ID 会返回同一状态；旧进程缓存的 ID 与当前 ID 不匹配时会被拒绝，不会触发新 turn。

输入 `quit` 时 launcher 会向本机 endpoint 发带随机 Bearer 的 shutdown 请求，等待 owned App Server child 的 close 证据；若不能确认清理，它会报告 pending，不会杀掉 probe 或进程树。dispatch 分支不保存原始 probe/Tunnel 日志，key 不写入文件或聊天。可选择传 `-ControlPlaneProxy http://127.0.0.1:<port>` 指定已存在的 loopback proxy。

Fake 协议检查命令：

```powershell
node --import tsx experiments/official-dispatch/mcp-probe.mjs --self-test
```

本次普通 Project Chat + 独立 Tunnel 的单次 E2E 已通过。本机持久 Desktop 会话接管与 Desktop 自有 active turn 插话也已通过；普通 Chat + Tunnel 的持久会话、连续投递与回流，以及 Desktop 插入独立 App Server 的 active turn，仍待验证。单次 Work Events 成功不替代普通 Project Chat 验证。本轮进程退出已核验；没有因本记录启动新 turn。
