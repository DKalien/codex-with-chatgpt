# 官方 MCP Events 最小实验

目标是普通 Project Chat 的“任务下发 → 完成事件唤醒 → 按需读取结果 → 继续工作”。回流成功不要求向网页输入框插入结果全文，也不依赖 Browser Companion 的 DOM Send。

本目录是独立探针，不接入生产 Bridge、真实 Codex 执行器、Result Bus 或任何现有绑定。第一步只测事件能否唤醒目标 Chat；通过后才接真实任务投递，避免先造另一套系统。

## 冻结点与分支

- 冻结分支：`codex/frozen-c2c-20261005`。
- 冻结提交：`1379fd61a5dbd3220311032682b490b2431a586d`，保存此前 56 个 dirty/untracked 项。
- 实验分支：`codex/official-mcp-events`，从上述快照出发。
- 原 `main` 保留在 `063caf07962d6dd58b952885702640aa0d6c7d52`。本轮没有 push、生产部署或切换绑定。
- 冻结时复核既有正式门禁 161 files / 3403 tests PASS；465 项 source/test/support 与原冻结哈希相同，构建为 `1326542c3601b2919b1872c1d80ac22aab258b05774c5ce438513b0c5aeba3a8`。这是旧路线的验收，不证明本实验可用。
- 原始文件 510 项字节在快照提交后保持不变；忽略的构建、依赖、测试证据未进入提交。重新建立 checkout 时需正常安装依赖与构建，不能将 Git 快照当作机器状态备份。

## 职责边界

| 环节 | 优先方案 | 当前进度 |
| --- | --- | --- |
| Chat 下发任务 | MCP 工具，由 Codex 执行；优先核验官方执行入口，避免重造 Desktop IPC | 官方 App Server 本机两轮投递及普通 Project Chat 经独立 Tunnel 的一次下发与按需读取已通过；仅为隔离实验，见[官方下发记录](../official-dispatch/README.md) |
| 任务结果 | 保存结果，提供小型只读 `read_result` 工具 | 探针只提供固定的无害结果 |
| 回流信号 | 官方 MCP Events webhook，仅携带 `result_id` | 本地探针单测 61/61 PASS；一次 Work 单结果实测收到 HTTP 200 accepted 事件并自动读取结果 |
| 唤醒与继续 | ChatGPT 订阅事件，在原 Chat 继续并读取结果 | Work 单结果闭环 PASS；普通 Project Chat 的 Events 订阅与自动唤醒仍未验收。本次普通 Chat 显式调用 `read_official_dispatch_state` 属于按需读取，不是事件唤醒 |
| 私有连接 | 优先官方 Secure MCP Tunnel | `tunnel-client` 0.0.15 已通过受限 runtime key 读取命名 tunnel metadata；只证明控制面连接 |

事件是通知，不是成功回执。HTTP 2xx、工具可调用、事件出现在 UI，或 Work chat 测试通过，均不能单独证明普通 Project Chat 已被唤醒。

## 探针范围

服务仅绑定 `127.0.0.1`，使用独立随机 Bearer token。它支持官方示例的 `server/discover`、`events/list`、`events/subscribe`、`events/unsubscribe`，加一个 `read_result` 工具；传统 `initialize` 只用于工具连接兼容。当前项目安装的 MCP SDK 1.30.0 不支持 MCP 2.0 版本协商，故实验没有修改或升级生产 SDK。

这是有意收窄的会话内探针，**不是完整 MCP 2.0 服务实现**。最新一次 Work 实测完成单次订阅、事件投递与结果读取；此前超时轮次仅为历史诊断。单次 Work 成功不证明普通 Project Chat、真实 Codex 任务下发或持久恢复可用。

回调先做 HTTPS、公网地址与挑战校验，再发送签名事件。每个进程只测试一个结果和有限订阅；密钥只在内存，重启失效，没有自动重发、跨重启恢复或持久队列。官方生产协议要求持久化订阅；本实验仅验证新建订阅到单次唤醒，不验收生产可靠性。不得接入真实结果或外部多用户流量。

## 本地运行与验证

在仓库根目录运行独立测试；它不计入生产 Vitest 全量清单：

```powershell
node --test experiments/official-events/probe.test.mjs
```

2026-10-05 本地探针单测最终 **61/61 PASS，check=0**；验证日志为 `.tooling/official-mcp-events-20261005/proxy-validation-20261005T131912218.log`。另有两项 syntax 检查、PowerShell Parser 与 diff checks 均通过。通用入口校验可选顶层 `_meta` 为 object 并剥离，再由方法层校验业务参数；认证、路由及 run ID 不使用 metadata，日志仅输出固定阶段和有界诊断。控制面与 callback 现都显式使用本机 loopback proxy；callback DNS 通过固定 DoH、验证公网地址及 CONNECT 目标 IP，再以原始 hostname 做 TLS/SNI。保持 5 秒总 deadline，不跟随 redirect、不 fallback、不 retry。

2026-10-05 12:32（Asia/Shanghai）当时最新现场日志 `.tooling/official-mcp-events-20261005/run-20261005T043222407Z-9099335b1eb04b0ca4d7a2630c72b44f/probe-live.log` 显示 `params._meta` 为 object，顶层、arguments 与 delivery 的未知字段数均为 0。`events/subscribe` 通过 parse 后以 `-32015 timeout` 失败，`events/unsubscribe` 成功；status 为 unsubscribed、无 event，callback host 为 `connectors.api.openai.com`。`read_result` 返回 pending，不能据此声称有 callback delivery 或 live 成功。

无凭据只读 HEAD 对照显示路径差异：直连 `connectors.api.openai.com` 5.017 秒超时；经 `127.0.0.1:7897` 按域名连接时 CONNECT 为 200，根路径返回 404（0.866 秒）；把本机 DNS `199.16.158.9` 固定为代理目标仍在 5.007 秒超时。经 proxy 向固定 DoH `1.1.1.1`（TLS SNI `cloudflare-dns.com`）查询得到 `104.18.38.184` / `172.64.149.72`；将可信结果之一固定为代理目标、同时保留原 hostname/TLS/SNI，根路径 HEAD 返回 404（0.697 秒）。主代理独立 `postHttps` 检查也得到 DoH GET 200、固定 IP 的 callback host 根路径 HEAD 404，耗时 1788 毫秒；未带凭据且 `callbackDelivered=false`。这些只证明特定请求路径可达，不证明 callback 成功，也不确证 DNS 投毒。

上述网络对照只说明特定请求路径可达；后续 Work run 已收到 accepted event，见下方现场记录。HEAD/DoH 检查本身不代表 callback 交付。

启动探针前，在本机临时环境中设置至少 32 字符的随机 `C2C_EVENTS_TOKEN`；不要把密钥粘贴到 Chat、提交到仓库或写进 URL。`C2C_EVENTS_PORT` 可指定独立端口（默认 43871）。

```powershell
$env:C2C_EVENTS_TOKEN = node --input-type=module -e 'import {randomBytes} from "node:crypto"; console.log(randomBytes(32).toString("hex"))'
$env:C2C_EVENTS_PORT = '43871'
node experiments/official-events/probe.mjs
```

已持有同一临时 token 的本地操作员可访问以下入口，均需 `Authorization: Bearer <token>`：

- `GET /status`：读取探针 result ID、订阅和投递观测；不返回签名密钥或回调 URL。
- `POST /mcp`：MCP JSON-RPC 入口。
- `POST /complete`：生成本次无害结果并尝试发送一次完成事件。不得将此端点用作生产完成/ACK。

停止探针即结束该次实验；到期、失败、重启后建立新的独立实验，不把旧尝试伪装为新成功。无需将本地探针设为后台常驻进程或注册 Windows Task Scheduler 时间型计划，也无需生产 rollout；ChatGPT 平台的原生事件触发测试按下方单结果指令单独处理。

## 普通 Project Chat 现场验收

1. 通过官方连接设置建立**独立测试连接**，优先 Secure MCP Tunnel；只转发探针 `/mcp`，不转发现有生产 Bridge 或操作员 `/complete`。本机探针 Bearer token 需由隧道上游 HTTP 配置注入，不能为了接入去掉认证。
2. 先确认工具发现与 `server/discover` / `events/list` 的真实请求。现有 C2C 工具可调用不代表新事件连接已就绪。
3. 在明确为普通 Chat 模式的 Project 对话中选择测试连接，并发出下方订阅指令。记录 Chat 模式和 route；在 Work 中运行的实验须单独标记。
4. 确认探针收到了客户端发出的真实 `events/subscribe`，回调挑战通过。工具名叫 subscribe、模型口头说“已订阅”或手工模拟请求均不算。
5. 等 Chat 本轮结束后，由本机操作员调用一次 `/complete`。事件只含 `result_id`；随机 proof 仅存在只读工具返回值，不提前告诉 Chat。
6. **不发送新的用户消息**，观察同一普通 Chat 是否继续并调用 `read_result`，取得正确 proof。记录 webhook 接收、工具读取、Chat 续行三个独立事实。
7. 完成后取消该测试订阅；若本次使用平台原生事件触发测试任务，也停止该任务，然后停止探针。不得将诊断日志里的任何成功位人工改写为 Chat 已唤醒。

建议给测试 Chat 的指令（替换 result ID）：

> 请仅针对这个测试 MCP 的 `probe.completed` 事件和 `result_id=<本次ID>` 建立一次原生事件订阅。允许平台为这次验证使用原生事件触发测试任务；只处理这一个结果，事件到来后调用一次 `read_result`、核对 proof、报告并停止。禁止按时间触发的计划、cron、重复运行和轮询；不要调用其他插件或下发开发任务。

本次 Work 单结果订阅、事件投递和读取已通过；普通 Project Chat 的修订指令试验未发起订阅，无法验收其原生唤醒。该观察只限本账号本次会话，不代表所有普通 Chat 永久不支持；具体证据与范围见下节。

## 本次 Chat 客户端现场观察

### 普通 Project Chat（2026-10-05 10:52:24，Asia/Shanghai）

`tunnel-client` 0.0.15 使用仅含 Tunnels Read + Use 的 runtime key，并经已有本机代理 `127.0.0.1:7897`（`--control-plane.http-proxy`）成功读取 tunnel metadata `C2C Official Events Probe`。本地 MCP 协商版本为 `2026-07-28`；ChatGPT app UI 列出 `read_result` 和 `probe.completed`。用户发出订阅指令后，Chat 回复表示当前只可用 `read_result` 工具，没有表示已建立原生事件订阅，也没有轮询、创建定时任务或发起工具调用。对应 ignored 日志为 `.tooling/official-mcp-events-20261005/run-20261005T024455546Z-60d92b636d39494eba0629619dd649c5/probe-live.log`。

### Work Chat（2026-10-05，修订指令复试；具体时间与 route 未记录）

此前 11:02 的 Work 尝试使用旧指令，未发起 `events/subscribe`；当时回复称没有可调用的原生事件订阅接口。该回复只记录为历史观察。用户之后按修订指令重试，允许这次验证使用平台原生事件触发测试任务，并只禁止时间型计划、cron、重复运行和轮询。对应 ignored 日志 `.tooling/official-mcp-events-20261005/run-20261005T024455546Z-60d92b636d39494eba0629619dd649c5/probe-live.log` 累计记录两次 `events/subscribe`，随后各有一次 `events/unsubscribe`；`tools/call` 和 `tool_read` 各两次，均为 `read_result` 返回 pending。日志没有订阅记录或事件记录，故没有证据表明订阅建立或事件唤醒成功。原始回调与可能包含敏感内容的日志行不复制到文档。

最新 live run `.tooling/official-mcp-events-20261005/run-20261005T052451046Z-de2023e809df47d9913e3096db2e8797/probe-live.log` 记录 `event_attempt` HTTP 200 accepted。操作员只调用一次本地 `/complete`，期间没有向 Work 发送新消息；同一 Work 对话自动收到 `probe.completed` 并调用一次 `read_result`。截图中的结果/proof 与 root 通过独立插件读取的结果/proof 精确匹配；proof 原串不写入文档。日志里的另一条 completed `tool_read` 是 root 独立审计读取，不算 Work 自动读取；另有一次较早的 pending 读取。事件执行后截图当时显示 task 与订阅仍启用。

之后用户用同一 Work 的正常 owner 消息停用了该测试 task；后端最终状态为 unsubscribed，平台 task 为 disabled。无法将解除状态归因到某次手动取消入口调用。用户已确认退出本地 probe；退出脚本结束了本次实验自己创建的进程。root 核实端口 `43871`、health `8075` 均无监听，精确实验路径下 `tunnel-client` 进程数为 0；没有终止或重启生产服务。

MCP Events 文档记录 Work 网页聊天、桌面端选择 Cloud 的 Work 聊天和 dots 为支持场景；本次只验证截图所示的单一 Work 对话，不能推断普通 Project Chat、dots 或其他 Work route。探针未调用模型推理 API，也未使用 Browser Companion DOM Send 或轮询。该测试 task 已停用、backend subscription 已解除；没有生产安装、重绑、真实 Codex 任务下发或支付设置变更。长期 refresh/persist/restart/key-rotation 可靠性仍未验收，不能据此将整条迁移路线 promote。

### 普通 Project Chat（2026-10-05，修订指令复试）

用户确认该会话为普通 Project Chat，修订指令允许平台原生事件触发测试任务，只禁止时间型计划、cron、轮询、重试，也没有切换到 Work。Chat 回复自述没有平台原生事件入口；这不作为底层工具清单的独立证明。ignored 日志 `.tooling/official-mcp-events-20261005/run-20261005T055230445Z-3b8e5cd69d3c41fb92a869482f2f3cd0/probe-live.log` 显示 `server/discover=1`，而 `events/subscribe`、subscription、event attempt、tool read 和 RPC fault 均为 0。服务端没有收到订阅请求，因此没有发生回调或结果读取，不能验收该会话的原生事件唤醒；这不是回调网络失败的证据，也不能外推为所有普通 Project Chat 永久不支持。

用户已确认退出本轮实验；主代理只读核实本地端口 `43871`、`11294` 均无监听，精确实验路径下 `tunnel-client` 进程数为 0。没有生产服务操作。

## 最短迁移顺序

1. 官方 App Server 本机两轮投递，以及普通 Project Chat 经独立 Tunnel 的一次官方下发与显式 `read_official_dispatch_state` 已通过；报告和边界见[官方下发记录](../official-dispatch/README.md)。本账号本次普通 Project Chat 的 Events 订阅/自动唤醒仍未通过验收。下一阶段路线待用户选择：以 Work 为规划端推进原生事件回流，或普通 Project Chat 保留受控外部回流；不自动切换或开发。持久恢复、跨重启和长期订阅 refresh 尚未验收。
2. 若用户选择 Work 路线，再增加最小任务投递入口，复用可验证的官方 Codex 执行能力；保留必要授权与工作区隔离。
3. 以真实结果替换固定探针结果，完成“下发一次 → 执行一次 → 事件唤醒 → 读取结果”的闭环，再评估重启恢复和重复事件。
4. 本账号本次普通 Project Chat 未发起订阅，不据此推断全局不支持。正式可靠性通过后，才决定退役旧回流模块；路线和额度取舍由用户决定。

## 官方依据（2026-10-05 查阅）

- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)：客户端分配 webhook、签名与验证；文档列出 ChatGPT 网页 Work chats、桌面端选择 Cloud 的 Work chats 和 dots，并说明 workspace controls for plugins and event-triggered tasks apply。
- [Scheduled Tasks](https://learn.chatgpt.com/docs/automations)：当前文档列出符合条件的 web/mobile 计划上的 Gmail、Slack、GitHub app 事件触发器及 `Allow event-triggered scheduled tasks` 权限；这不证明自定义 MCP 路由走相同触发路径。
- [连接、测试与刷新 metadata](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata)：改动 MCP schema 后重启服务，在 ChatGPT Plugins 刷新连接 metadata，确认变化并在新对话重跑受影响测试。
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)：需要账户侧 tunnel ID、运行凭据及关联的 workspace。隧道负责传输，不赋予普通 Chat 事件唤醒能力。
