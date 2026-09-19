# Phase E：部署基线与 ChatGPT 接收端预检

核验日期：2026-09-14。任务来源是用户手动交给本机主代理的任务包。
本轮是预检，不是 Phase E 自动回流功能完成。

| 身份 | 本轮值 |
| --- | --- |
| workspace | `codex-with-chatgpt` / `2582910bf0d2` |
| workspaceRoot | `D:\python\codex-with-chatgpt` |
| commandId | `phase-e-e0-receiver-preflight-manual-20260914-002` |
| taskId / iteration | `manual_phase_e_preflight_20260914_002` / `1` |
| 来源 | `manual user task; no accepted Desktop delivery` |

## 结论与原需求

- **E0 = blocked**：源码、安装、运行产物已核实对齐；当前公网健康，但旧
  `upgradePending=true / named_unhealthy` 尚保留，维护状态未完全收敛。没有 active finalizer。
  此处 blocked 指遗留维护状态，不表示运行 build 落后或当前公网不可达。
- **RECEIVER_GATE = BLOCKED**：首先，官方资料未证明指定已有普通 ChatGPT conversation
  路由及最终可见消息回执；其次，用户已明确本轮尚未提供或确认测试目标与专用凭据。
  接口合同缺口与测试配置缺口分别阻塞；补一个 token 不能解决路由问题。真实接收 E2E 未执行。
- 下一轮不能开始生产 outbox、feedback pump 或自动 revision 开发。先补齐接收合同和资格证据。

目标继续保持：本机主动出站、可在 NAT 后；ChatGPT 与 Codex 可跨设备及网络；
不依赖 DOM、常驻页面或同一个 Desktop turn；反馈进入原任务绑定的确切 ChatGPT 对话，
接收后在原任务范围内独立 review。独立 Agent 对话是需求变化，未经用户确认不能替代原目标。

## E0：源码、安装、运行与遗留状态

本轮修改文档前已保存只读基线。源码为干净的 `main`，HEAD、本地 `origin/main`、
实时 `git ls-remote origin refs/heads/main` 均为
`dcf8db073dd01407c91a1cc0c0c23b2d2fd90136`。没有 reset、stash、checkout、commit 或 push。

| 项目 | 本轮观察 |
| --- | --- |
| checkout `dist/build-id.txt` 及实际 dist 摘要 | `30cd260920fc8a2fc44ef00874c7f4a323f14108375d5ed0237807d3ece3051e` |
| installedBuildId / runtimeBuildId | 均为上述 `30cd2609…` |
| current metadata | version 3；installedAt=`2026-09-14T06:16:20.076Z` |
| runtimeUpgrade | `state=current`；`upgradePending=true`；`reason=named_unhealthy`；target 为上述 build |
| Bridge | `c2c-bridge` / `0.1.1`；workspace 身份匹配；PID `20196`；startedAt=`2026-09-14T06:17:31.153Z` |
| pending 文件 | `runtime-upgrades/2582910bf0d2.json`；updatedAt=`2026-09-14T06:17:36.201Z` |
| active finalizer | 无；没有等待当前 turn 结束的 job |
| latest finalizer | `c5d31ea0-fcab-4058-8726-5af43b8227d8`；`blocked / named_unhealthy` |
| named tunnel | `cloudflare-named`；当前 running；下述公网检查通过 |
| 权限状态 | Desktop enabled；Remote Control=false；writeProbeEnabled=false；本轮均未改变 |

2026-09-14 07:24:48–49 UTC（北京时间 15:24:48–49）的独立只读检查：
本地 `/health` 和既有 named 公网 `/health` 均为 HTTP 200，返回相同 workspaceId、PID、
startedAt；未认证的本地 `/mcp` 为 HTTP 401。使用 8 秒上限与禁止重定向的请求，
没有发送认证凭据。status 中的旧 QUIC warning 不能替代本次健康观察，也不能证明一直稳定。
这只证明本机发起的当前公网可达性，未证明另一设备/网络的可达性或后台接收成功。
中断恢复后于 08:35:10 UTC（北京时间 16:35:10）再次检查公网，仍为 HTTP 200，身份及进程未变。

### 对齐证据，不按 buildId 猜源码提交

使用已有 TypeScript 编译器按当前 tsconfig 在内存中 emit，128 个 JS/source-map 产物与
checkout dist 逐项一致，diagnostics=0，没有覆盖 dist。Python helper、core 脚本、入口、
package/lock 快照逐项一致，依赖摘要一致。checkout dist 重算摘要与 installed dist 重算摘要
相同；既有 `readCurrent(stateDir, "full")` 完整 release 校验通过；实际安装脚本/入口与源码
相同；Skill 经唯一 launcher 占位符替换后相同。

因此可以证明当前干净源码的运行产物与机器相同。current/release manifest 没有 Git commit 字段，
不能把 installedAt 或 buildId 当作 Git provenance（源码来源）证明，也不能由此推断旧 build 的提交。

### 两次历史线索及保留事实

- 旧 build `5b7733849f334d1bc75b88d7dcd065cfc169d098b644a714b9ef4a4504cccf2c`
  的 release manifest 仍存在。现有普通 execution record
  `post_turn_4aa51c07-bcaf-47f3-bed3-37cc358e9580` 记录 `ok / upgraded`，
  timestamp=`2026-09-14T04:42:01.564Z`。这是历史成功证据，不是当前运行版本。
- `post_turn_c5d31ea0-fcab-4058-8726-5af43b8227d8` 的真实记录为
  `blocked`、`finalizer blocked: named_unhealthy`、目标 `30cd2609…`，
  timestamp=`2026-09-14T06:17:36.209Z`。对应 latest result 保留 scheduledAt
  `06:16:39.300Z`、startedAt `06:16:40.515Z`、finishedAt `06:17:36.209Z`（均 UTC）。
- 当前安装指针和运行进程已经是该目标；pending 与 terminal blocked result 仍存在，active job 已无。
  `src/core/upgrade.ts` 分别计算 build 是否相同与 pending 是否存在，因此
  `current + upgradePending=true` 可以同时出现，status 不会自动清除 pending。
- `src/core/rollout.ts` 在重启后仍做 named 检查，失败可以留下已运行新 build 的 pending；
  但仅凭上述结果与时间不能断言该次失败发生在 precheck 还是 postcheck，也不能证明是谁启动了
  当前进程。本轮不补写“历史升级成功”，不修改 blocked 记录，不重复处理已 abandonment 的历史记录。

### 维护决策

用户规定已安装且运行正确目标时只读确认，所以本轮没有重复部署、rollout、doctor 修复、
重启、清 pending 或安排 finalizer。保留 `named_unhealthy` 作为待复核维护项，E0 不标为通过。

已阅读 `scripts/dev-install.ps1`：参数只有 Test/InstallRoot，末尾默认执行不带 workspace
限制的 `rollout --json --result-file ...`。它不能满足本轮“不得升级其他 workspace”的安装范围，
如以后确需安装，必须先解决这个既有入口限制，本轮不重写安装系统。
独立 CLI rollout 支持 `-w`；其 current 分支在认证身份后清 pending，不重启。
后续若明确允许收敛遗留标记，只能使用该限定 workspace 的正常路径并前后只读核验；
不能直接删除状态文件、清环境变量冒充 idle 或手工造 finalizer job。

## 当前代码链路与 destination 缺口

1. **Web Control**：`src/session/state.ts` 保存 workspace/controlSessionId/codexSessionId、
   conversationUrl、用户消息授权与 command receipts。`src/session/web-control.ts` 及
   `src/cli/web-control.ts` 通过唯一的 command/task/iteration/controlSessionId execution record
   校验 `ok|failed|blocked` 终态，推进 completed + pending feedback；反馈消息 ID 另行标记 sent。
   终态不等于反馈送达；当前仍需 Agent 观察网页消息并调用反馈确认入口。
2. **Desktop**：`src/desktop/store.ts` 保存 workspace/root、bindingId、thread/host/project、
   revision、clientId、commandId、正文 hash、accepted turnId；`service.ts` 投递前检查本机绑定、
   enable、owner/version/idle/approval/replay。`result.ts` 核验 exact accepted thread/turn，
   形成带 digest 的 execution receipt 与输出；accepted 本身不表示执行完成。
3. **MCP 拉取**：`src/bridge/server.ts`、`src/mcp/http.ts`、`src/mcp/desktop.ts` 提供受控入口；
   `src/auth/store.ts`、`src/auth/oauth.ts` 绑定 client/token/scope/workspace；named tunnel 提供
   ChatGPT 调用本机工具的入口。`src/remote/controller.ts` 处理本机远程队列执行及结果，
   没有向指定 ChatGPT 对话主动反馈的发送器。
4. **普通记录**：`src/cli/index.ts` 的 record 入口使用 `src/execution/records.ts` 与
   `src/execution/output.ts`，可保存 commandId/taskId/iteration、changedFiles/tests/status 和
   outputId。它不能冒充 Desktop receipt，也不能省略 Web Control 身份去通过 strict terminal 校验。
   普通 append 不自动去重，所以本轮在开始、恢复与记录前按 commandId 或 taskId/iteration 查重。
   MCP execution_summary 提供最近记录，消费者仍须选出精确身份；test_status 只代表最新记录。

| 已存在 | 仍缺少或未获证明 |
| --- | --- |
| workspaceId/root、taskId/iteration、commandId | 原任务到获授权 ChatGPT 接收端的可验证映射 |
| Web Control conversationUrl/controlSessionId/message IDs | 无 DOM 的普通 conversation 接口、持久消息读取与最终 delivery acknowledgement |
| Desktop threadId/projectId/bindingId/turnId/正文及 receipt digest | ChatGPT account/workspace/receiver principal、API trigger ID、接收 conversation ID |
| SavedSession.url/projectUrl/connectorName | 不能证明旧 URL 就是本轮任务的确切目的地；没有本轮 API conversation_key 绑定 |
| OAuth clientId/scopes、execution/outputId | 发送凭据引用、event idempotency/recovery 合同、receiver run/message IDs、terminal digest 的接收端校验 |

当前本 workspace 保存了 Project、chat URL 和指定 Connector 名称，并存在 enabled 的 Web Control
状态；本轮只读取字段存在性，不调用 web-control status/receive、不开启监听、不借用其 session。
Desktop 的当前绑定属于本任务所在会话，但它不是 ChatGPT destination。两者均不能填补上述缺口。

## 官方接收接口核验

下列资料于 **2026-09-14** 通过官方网页实际打开核验；不是从先前聊天推断。

| 官方依据 | 核实的合同 |
| --- | --- |
| [Workspace Agents 总览](https://developers.openai.com/workspace-agents) | 提供已发布 workspace agent 的外部触发入口 |
| [Trigger runs](https://developers.openai.com/workspace-agents/trigger-runs) | `POST /v1/workspace_agents/{id}/trigger`；目标 `agtch_…`；`input` + 可选 `conversation_key` 延续 Agent 对话；外部系统可在 UI 外触发 |
| 同上 | 202 表示事件持久入队，返回 conversation_url；beta `workspace_agent_runs=v1` 另给 `agent_trigger_run_id=apirun_…`；GET `/runs/{run_id}` 查询 queued/in_progress/suspended/completed/failed；目前不能经 API 读取 Agent 回答 |
| 同上 | 同一 API trigger、同一 Idempotency-Key 重试同一事件返回原 accepted outcome，不新增入队；未说明 TTL、同 key 不同 payload 及跨身份去重边界 |
| [Authentication](https://developers.openai.com/workspace-agents/authentication) | 管理员启用 Workspace agents 和个人 access token 创建；ChatGPT Admin > Access tokens 创建专用 Workspace Agents scope token；不证明当前账户已获准 |

### 能力矩阵：合同、实测和未知分开

| 要求 | 本轮实际证据 | 结论 / 最小缺口 |
| --- | --- | --- |
| A 账户与身份 | 用户已明确本轮尚未提供或确认可用的测试目标及专用凭据 | **测试配置缺口，真实探针 BLOCKED**；账户资格本身仍未验证，不能断言无资格；未查其他应用 token/cookie、不复用 C2C OAuth，Bridge tokenCount 不证明资格 |
| B 原普通对话精确路由 | 官方请求无指定已有普通 ChatGPT conversation ID/URL 字段；没有本任务映射 | **文档未证明，BLOCKED**；conversation_key 不能当普通 chat ID；另建 Agent 对话需用户接受需求变化 |
| C 后台运行 | 外部触发合同存在；未发事件、未关闭目标页测试 | **未测试**；Web/mobile 可见性、另一网络/NAT、页面关闭后运行均无实测证据 |
| C 工具 | 没有已确认发布目标；本机 Connector 名称存在 | **未测试/文档未证明** 后台接收方实际拥有该 Connector 并调用 workspace_info；旧 OAuth 授权不可替代测试 |
| D 请求接收/持久入队 | 官方 202 合同；本轮无 response/run/message ID | **未测试**，不能将 HTTP 受理当 sent |
| D 运行完成/用户消息持久可见 | 官方区分 run 终态；没有消息读取证据 | **BLOCKED**；completed 不证明已进入原普通对话或可见消息已持久出现 |
| D 幂等与恢复 | 官方同事件重试合同；本轮没有故障/恢复实测 | **未测试**；保存原 key/payload/target，不换 key 盲重发；TTL/冲突行为不假定 |
| E 独立 review | 没有接收事件、工具调用或读取本轮产物的证据 | **未测试**；必须准确关联本轮身份、terminal digest，重新读取 execution/output/git/code |

### 不确定结果及授权处理

后续最小预检应分别记录 accepted、durably queued、run terminal、用户可见消息证据。
runId 永远不是 messageId；只有 conversation_url 时不确认 sent。请求接受后响应丢失，
保留 unknown；仅在官方保证适用且原 payload/target/key 不变时进行一次同事件恢复，
不得换 key 扩散请求。同 key 不同 payload 本地拒绝；未公布保留期限不能写无限去重保证。
遇 suspended 或真实审批时按所见状态停住，不能自动批准。

EXECUTED 仅是执行结果，不是新用户授权。未来 review 需要确认 destination 及读取主体，
用原 workspace/command/task/iteration 和 terminal digest 查唯一 execution record，
读取该 outputId、当时及当前 Git/code，区分源码漂移与本轮产物；restricted 就明确记录。
自动 revision 的授权模型留待单独设计，不修改 userConfirmed、Desktop 本机确认或任何 scope。

## 本轮真实探针与建议架构

接收端新事件 **0**，同事件恢复 **0**。没有 runId/messageId，没有向页面输入预检文本，
没有 codex_desktop_send、开发任务或自动 revision。账户资格未知，目标及权限未确认，
不满足真实探针前提；不以本机 mock 填补实测证据。因此没有新增探针代码、测试框架或依赖。

建议本轮停在合同预检。将来只有原目标路由、专用凭据、后台只读 Connector、最终回执与恢复
证据齐备后，才设计最小的“严格终态 → 出站投递 → 确切接收端 → 独立 review”路径。
Web Control、Desktop 和 manual record 使用各自原有终态证明，不能为了统一回流而放宽任一校验。
不提前实现 outbox、常驻 pump、scheduler 或 revision。此结论不是整个 Phase E 不可行的证明；
它表示当前候选与当前访问条件尚未满足原需求，不能以配置缺失替代能力判断。

下一轮最小任务：

1. 复核 E0 遗留 pending 的处理范围；如获准，限定本 workspace 走 normal rollout 的 current
   路径收敛标记，保留历史 finalizer 结果，再只读验收。
2. 明确原普通对话是否有正式可写且可查询消息的接收路径；若仅有独立 Agent 对话，先取得
   用户对该需求变化的决定。缺此证明时继续 BLOCKED，不先建设队列。
3. 提供获准发布目标、所属 workspace 的非敏感身份，以及本机安全配置引用，秘密不进入聊天。
   条件成立后才做最多两个新事件和一次受保证的同事件恢复；标记为 PRECHECK，不能伪称 EXECUTED。
4. 真实验证关页、Web/mobile/另一设备网络、只读 workspace_info、最终持久消息及独立 review。

## 验证、证据与普通执行记录

- 本轮仅改本文件与 `docs/development-plan.md`；代码测试 0、接收探针事件 0、安装 0。
  执行 `git diff --check`；不把历史 902/892 等测试数写成本轮通过数。
- tracked diff 检查 exit 0；新文档补充空白/冲突标记与本地链接检查通过。对新文件使用
  no-index 得到 exit 1（文件与 NUL 有差异，仅换行提示），初始包装误按必须为 0 报错；
  已用直接文档检查确认没有空白错误，没有通过重复重跑测试掩盖失败。
- 只读产物验证：full release 通过、128 个内存编译产物一致、0 diagnostics、资源和依赖一致、
  已安装 Skill 一致；本地/公网 health=200、未认证 MCP=401。没有运行写 dist 的 build。
- 一次补充资产核查误按 release 根目录读取 lockfile，ENOENT/exit 1；阅读 publisher 后确认
  正确位置是 `dist/core-assets/pnpm-lock.yaml`，定向重查通过。这是本轮检查路径错误，非产品故障。
- 直接下载官方 `.md` 副本返回 403；保留响应作失败证据。上述官方结论取自浏览工具实际打开的
  HTML 页面，不把下载失败当成账户无资格或 API 不可用。

原始只读基线与过程材料位于已忽略且本轮唯一的
`.tooling/phase-e-20260914-6f391850845d46aebd9b15120ec51987/`，未覆盖旧证据：
`baseline-status.json`、`baseline-finalizer.json`、`baseline-head.txt`、`baseline-git-status.txt`、
`origin-main.txt`、`artifact-verification.json`、`installed-outer-assets.json`、
`identity-history.json`、`historical-success.json`、`health-observations.json`、`official-sources.json`。
中断恢复后补充 `final-status.json`、`final-finalizer.json`；安装/运行 build、Bridge PID/startedAt、
pending 和 latest finalizer 结论未变。
`final-health.json`、`diff-check.json`、`document-validation.json` 保存收尾检查。
status 的 tokenCount 从 10 变为 11，本轮未调用配对/授权或改 scope；变化来源未核验，
不读取凭据追查，也不将该计数当作 Workspace Agents 的资格证据。
本地路径用于复核，不绕过 MCP 对 ignored 文件或输出的安全规则。

开始时严格检查完整 execution JSONL，本 commandId 和 taskId/iteration 均无记录；当前 Desktop
deliveries 中也没有本 commandId。收尾使用既有普通 `c2c record`，exitStatus=`blocked`，
notes 包含 `manual user task; no accepted Desktop delivery`；不填 controlSessionId、turnId，
不生成 Desktop receipt。ChatGPT 应以本文件开头的 commandId/taskId/iteration 查询唯一
execution_summary，再读取记录实际返回的 outputId；OUTPUT_AVAILABLE 以实际安全发布结果为准。


---

# Phase E 第二轮：官方组件反馈探针原型（代码，未部署）

日期：2026-09-14。来源：用户手动委派（非 Desktop accepted delivery）。
保留首轮 E0/RECEIVER_GATE 预检为历史结论；本轮需求变更后实现**默认关闭**的隔离原型。

## 需求变更（相对首轮）

- 继续使用当前普通 ChatGPT / Project 对话；页面与组件可保持运行。
- 不要求页面关闭或组件卸载后自动唤醒；一 workspace 同时只有一个有效接收对话。
- 新 Chat 明确接管后，后续反馈跟随新 Chat；跨设备/网络；不依赖本机浏览器或 localhost。
- 不使用 DOM 抓取或私有网页 API；不重复执行 Codex 任务，不盲目重发。
- 本轮不再以缺少 Workspace Agent 目标/token 为实现阻塞。

## 官方资料核验

2026-09-14 再次尝试打开
`developers.openai.com/plugins/build/chatgpt-ui` 与
`/plugins/reference`，HTTP **403**，本环境无法直接读取页面正文。
实现依据：

- 仓库锁定的 `@modelcontextprotocol/sdk@1.30.0`（`registerResource` / `registerTool`）；
- 既有 write-probe 的 enable/scope/`_meta` 模式；
- MCP Apps 常见 `ui://` resource + 宿主 toolkit `callTool` 约定。

因此 UI 资源 URI 使用 `ui://c2c/feedback-probe.html`；若真实宿主要求不同
URI/mime 或 `ui/*` 方法名，需在真实验收阶段按宿主能力检测调整，**不在本轮猜接口**。

## 实现范围

| 文件 | 职责 |
| --- | --- |
| `src/feedback/probe-store.ts` | 持久 binding/event、短锁、takeover/claim/send/confirm |
| `src/feedback/probe-ui.ts` | 内嵌 HTML 组件 + 可测轮询逻辑 |
| `src/mcp/feedback-probe.ts` | 默认门禁下注册 UI resource 与 8 个探针工具 |
| `src/mcp/server.ts` | `resources` capability；开关开启时注册探针 |
| `src/auth/store.ts` | 开启时暴露窄 scope `feedback.probe` |

默认关闭：`C2C_ENABLE_FEEDBACK_PROBE` 非 `1` 时不注册工具/resource，scope 不出现。

状态文件：`stateDir/feedback-probe/state.json`（0600，rename 原子写）。
**不写入 MCP handler 内存/widgetState/localStorage 作为唯一真相。**

## 安全合同（本轮）

- 元数据 sessionKey 仅用于关联；不接受模型随意填写的 conversationId 作为已验证目标。
- 接管：atomic epoch 比较；旧 epoch 不能领取；ready 可交接；sending/unknown 列入 blockedEvents，不假装安全。
- claim 前持久领取；sent 必须有 messageId；无 messageId 只能 outcome_unknown。
- 换接口超时不得“兜底”发送；unknown 保留，不自动重发。
- 不调用 codex_desktop_send；不消费历史 EXECUTED；不伪造 Desktop receipt。
- UI 不暴露 bearer/admin/隧道凭据；不访问 localhost。

## 离线测试

`tests/feedback-probe.test.ts`：默认关闭/scope、UI 资产、enable/epoch/takeover、
claim 冲突、无 messageId、重启后 sending、model confirm、workspace 错配、
轮询有界/停止/冲突、MCP 注册、HTML 转义。

## 未做 / 未宣称

- 未部署、未 dev-install、未重启真实 Bridge。
- 未通过真实 ChatGPT 宿主 E2E；`LIVE_CHATGPT_TEST = not_run`。
- `PRODUCTION_FEEDBACK = not_enabled`。
- 未实现生产 outbox、自动 revision、E0 pending 清理。

## 最小真实验收步骤（下一轮）

1. 在测试环境设 `C2C_ENABLE_FEEDBACK_PROBE=1`，重新安装/重启 Bridge。
2. 授权包含 `feedback.probe` 的 token。
3. 在当前普通/Project Chat 加载 connector，确认卡片出现。
4. 一次“启用 + 开始轮询”后创建 probe 事件，观察是否自动回传。
5. 新 Chat 明确接管；确认旧 epoch 不能领取。
6. 刷新/重复挂载/短暂断网：不产生盲目重发。
7. 另一设备/网络记录是否可用；Web/mobile 分别记录。
8. 若宿主要求每次点击才能发送，如实记为“仅点击可用”。


---

# Phase E UI probe review fix

日期：2026-09-14。不部署；保留 dirty worktree。

## 修复摘要

1. **Trusted principal**：`resolveTrustedPrincipal` 仅从 `authInfo.clientId` + `sessionId` + `_meta` 建 fingerprint；
   tool args 不再接收 sessionKey/conversationId。status 只返回 fingerprint，不返回原始 session。
2. **destination 绑定**：claim/report_send/confirm/stop 均校验 caller fingerprint；
   event 记录目标 `principalFingerprint`。takeover 后旧 sent/unknown 事件仍归原主体，新主体不能 confirm。
3. **无伪 messageId**：去掉 `host-ack`；无真实 id 一律 `outcome_unknown`。
4. **固定模板 payload**：服务端 `buildProbePayload`；follow-up 含 probeId/digest/attempt/epoch/fingerprint。
5. **sending crash recovery**：enable/takeover/stop 将遗留 sending 收敛为 `outcome_unknown`，不可再 claim。
6. **单实现轮询**：HTML 通过 `pollForProbeEvent.toString()` 嵌入同一函数；启用一次自动轮询。
7. **workspace 隔离**：`feedback-probe/<workspaceId>.json`。
8. **UI 绑定**：新增 `probe_open_card` 返回 `ui/resourceUri` 元数据。
   官方文档仍 403；**LIVE_HOST_CONTRACT=blocked**，禁止部署依赖未验证 contract。

## 测试

`tests/feedback-probe.test.ts`：13 项（principal 冒充、takeover confirm 边界、
messageId、模板、crash recovery、workspace 隔离、HTML 单实现、open_card 元数据、scope 拒绝）。


---

# Phase E UI probe 再收紧

日期：2026-09-14。

- enable/takeover **锁死**：`requireConversationPrincipal`，缺对话级身份（conversation/session/thread）拒绝。
- principal fingerprint 不变；status 不返回原始 session。
- **poll 等待未知未来 ready 事件**（不依赖预先 create 的 probeId）。
- 新增本地 **`probe_emit_event`**；组件启用后可独立 emit，再由轮询领取。
- **统一 unwrap**：`unwrapToolResult`（structuredContent 优先），UI 与 store 语义一致。
- HTML 仍内嵌同一 `pollForProbeEvent.toString()`。
---

# Phase E probe enable/takeover 与本机 emit 锁死

日期：2026-09-14。不部署；保留 dirty worktree。

## 语义

| 场景 | 行为 |
| --- | --- |
| 无 active binding | `probe_enable` 创建 |
| 有 active binding，caller 是 owner | 幂等返回原 binding：**不增 epoch、不改 sending、不换 bindingId/widgetId** |
| 有 active binding，caller 不同 | **`PROBE_TAKEOVER_REQUIRED`**；B 只能 `probe_takeover(expectedEpoch)` |
| 新卡片加载 | 先 `probe_status`，读 `epoch` 与 `ownsBinding`，再决定 enable/复用/接管/轮询 |

## 本机 emit

- CLI：`c2c feedback-probe emit -w <workspace> [--label …]`
- 不接受自由正文；事件 `principalFingerprint` 固定为当前 active binding
- 不需要 Chat principal；真实验收要求 **Chat 完全不碰 emit 按钮**
- MCP 已删除 `probe_emit_event`；UI 已删除 emit 按钮

## Principal fingerprint

- 稳定字段：`clientId` + 已选择的 `conversationKey`
- 不纳入 `_meta` 其它键、traceId、无关标量
- 对话级身份缺失时 enable/takeover 仍 fail closed

## Follow-up 与 polling

- claim 返回 `payloadDigest`；HTML 用嵌入的同一 `buildFollowUpPrompt()` 发送
- 实际发送文本含：probeId + payloadDigest + attemptId + epoch + principalFingerprint
- 默认 attempts ≈ `lifetime/interval`（15min / 3s = 300），deadline 仍是主边界；测试可注入很小次数

## 测试（20 项）

覆盖：B enable → TAKEOVER_REQUIRED；A 重复 enable 不换 epoch；本机 emit 不经 Chat principal；
无关 metadata 不改变 fingerprint；HTML 含 digest 且无 emit 工具；默认 polling 能等到约 57s 后才出现的事件。

---

# Phase E MCP Apps 宿主契约收紧

日期：2026-09-14。不部署。

- **descriptor**：`probe_open_card` `_meta = { ui: { resourceUri }, "openai/outputTemplate": resourceUri }`
- **MIME**：resource 与 result 均为 `text/html;profile=mcp-app`
- **UI bridge**：`window.openai.callTool(name, args)` / `window.openai.sendFollowUpMessage({ prompt })`；不再使用 `window.openai.toolkit`
- **principal**：conversationKey **只**取官方 `_meta["openai/session"]`（字符串或 `{id}`）；conversationId/threadId/sessionId 等未确认键 fail closed
- **follow-up**：明确要求 `probe_model_confirm(probeId, payloadDigest, attemptId)`；无持久 messageId → `outcome_unknown`，靠 `model_observed` 对账，不伪造 `sent`

测试同步：`openai/session`、descriptor `ui.resourceUri`/`openai/outputTemplate`、MCP Apps MIME、HTML 无 `window.openai.toolkit`。

---

# Phase E host-contract 校准（REVISION）

日期：2026-09-14。只做宿主合同，不扩展架构、不部署。

## 已对齐

1. **descriptor `_meta`**：`ui.resourceUri` + `openai/outputTemplate`（挂在 tool descriptor，不只在 result）
2. **MIME**：`text/html;profile=mcp-app`
3. **UI bridge**：`window.openai.callTool(name, args)` / `sendFollowUpMessage({ prompt })`；无 toolkit
4. **principal**：conversationKey **仅** `_meta["openai/session"]`；fingerprint=`hash(clientId+openai/session)`；缺 session → `PROBE_CHAT_IDENTITY_UNAVAILABLE`（enable/takeover/claim/report/confirm/stop）；status 不回显原始 session
5. **follow-up**：要求 `probe_model_confirm(probeId, payloadDigest, attemptId)`；confirm 必带 attemptId 并精确匹配事件 principal；无 messageId → outcome_unknown → model_observed，不伪造 sent

## 状态

- `LIVE_HOST_CONTRACT = blocked`
- `LIVE_CHATGPT_TEST = not_run`
- `PRODUCTION_FEEDBACK = not_enabled`

---

# Phase E pre-deploy hardening

日期：2026-09-15。只做收口，不扩架构、不部署。

1. **tool metadata**：统一 `securitySchemes`；open_card/model_confirm = `ui.visibility=["model"]`；
   status/enable/takeover/claim/report/stop = `ui.visibility=["app"]` + `openai/widgetAccessible=true`。
2. **send/confirm race**：`sending|sent|outcome_unknown → model_observed`；
   report 在 model_observed 后 unknown 幂等 no-op，sent+messageId 只补 messageId，不降级。
3. **UI isError 归一化**：`normalizeToolResult` 抛带 code 的错误。
4. **openai/session 严格化**：仅字符串；object/missing fail closed。
5. **owner enable**：同 binding 不换 epoch；仅收敛 stale sending。
6. **版本化 URI**：`ui://c2c/feedback-probe/v1.html`；`LIVE_HOST_CONTRACT=documented_unverified`。
7. **离线测试**：metadata/visibility/race/stale/isError/script compile/resource callback。

---

# Phase E live-host follow-up fix（v2 / ui/message）

日期：2026-09-15。真实 E2E 已证明 card/callTool/claim；sendFollowUpMessage 无持久 messageId。

- URI：`ui://c2c/feedback-probe/v2.html`（不覆盖 v1 cache key）
- `McpAppsBridge`：parent-only JSON-RPC 2.0；`ui/initialize` → `ui/notifications/initialized`
- 仅 `hostCapabilities.message.types` 含 text 才 `bridge=standard`
- follow-up **只**走 `ui/message`；发出后不 fallback alias
- isError / timeout / 无 messageId → `outcome_unknown`；有可验证 messageId 才 `sent`
- callTool 仍用 `window.openai.callTool`（已验证）
- 卡片显示 `bridge` / `host.message`

未部署、未 commit/push。

---

# Phase E v2 protocol correction

日期：2026-09-15。不部署。

- `UI_PROTOCOL_VERSION = 2026-01-26`
- initialize 只认 `hostCapabilities.message.text !== undefined`；**不再**读 `result.message.types`
- 标准 mock：`hostCapabilities.message.text = {}`；反例：legacy `message.types` / 缺 `text` → unavailable
- `ui/message` 标准结果只看 `isError`：不从 `messageId`/`id` 推导 `sent`
- 成功 resolve（`{}` / `{isError:false}`）→ `attempted`，UI 一律 `outcome_unknown`
- 无 fallback / 无 resend

---

# Phase E v3 rendered-runtime fix

日期：2026-09-15。不部署。

- URI：`ui://c2c/feedback-probe/v3.html`（不覆盖 v2）
- 根因：`McpAppsBridge.toString()` 含 `UI_*` free variable，HTML 未嵌入 → 卡在 initializing
- 修复：render 时用 `JSON.stringify(TS 导出常量)` 生成浏览器侧 `var UI_*`
- rendered-runtime 测试真正执行 HTML script（fake window/document/timer）：
  - timeout → `bridge=unavailable`，不发 `ui/message`，无 ReferenceError
  - 标准 init → `initialized` 通知 + `standard` + `host.message=yes`
- 启动链 `ensureBridge().then().catch(...)`：异常时强制 unavailable

---

# Phase E v4 init diagnostics

日期：2026-09-15。不部署。

- URI：`ui://c2c/feedback-probe/v4.html`
- `BridgeState` 拆分：`standard` / `initialized_no_message` / `unavailable`
- 合法 init + 无 `message.text` ≠ 初始化失败；仍发 `initialized` 通知
- 窄诊断：`initOutcome`（pending/ok/timeout/rpc_error/post_error/invalid_result）、`negotiatedProtocol`、rpc code/message（≤120）、messageText/serverTools/serverResources
- 卡片：`bridge` / `init.outcome` / `protocol` / `host.message` / `host.serverTools`
- 不暴露 hostContext/session/token/完整 caps

---

# Phase E1a production feedback outbox（代码，未部署）

- `src/mcp/conversation-principal.ts`：probe 复用同一 principal/fingerprint
- scope **`codex.feedback`**（永久，与 `feedback.probe` 分离）
- `src/feedback/store.ts`：`stateDir/feedback/<ws>.json`；binding/epoch/events
- `src/feedback/projector.ts`：baseline cursor；仅 accepted trusted Desktop receipt → `C2C_EXECUTED`
- deterministic `eventId`；重复 reconcile 不重复投影
- enable/takeover/claim/ack/stop；claimed 阻止 takeover；stale claimed → outcome_unknown
- MCP：`feedback_status/enable/takeover/claim_next/ack_observed/stop`（无 emit/UI）
- probe 默认关闭行为保持

门禁：production 13 + probe 43 + CLI；MCP/auth/desktop/remote 列表已更新；全量 **57 / 966 passed**。

---

# Phase E1a review-fix

1. MCP：`resolveConversationPrincipal` → `requireConversationPrincipal` **先于** reconcile/mutation
2. binding API 未初始化 → `FEEDBACK_STATE_UNINITIALIZED`；baseline 仅 `ensureFeedbackState`
3. reconcile 每次 `recoverStaleFeedback`（status 即可收敛 stale claimed）
4. `writeState`：open/write/fsync/close/rename + 清理 tmp + 0600
5. desktop-like（receipt/task/delivery）任一命中必须完整 trusted receipt，否则 fail closed
6. ack 先校验 target/attempt，再 observed 幂等
7. `feedback_status`：`readOnlyHint=false`
8. 全量 **57 / 973 passed**

---

# Phase E / E1a 收官状态（knowledge closeout）

日期：2026-09-15。本节为现役终态；上方各段为历史过程记录。

| 项 | 状态 |
| --- | --- |
| Phase E synthetic probe | 代码完成；默认关闭（`C2C_ENABLE_FEEDBACK_PROBE`）；v4 URI |
| Phase E1a production outbox | **complete**（含 review-fix） |
| 验证 | **57 files / 973 passed / 0 failed**；typecheck / build / `git diff --check` 通过 |
| static review | passed（identity 先序、UNINITIALIZED、stale reconcile、fsync write、desktop-like fail closed、ack 顺序） |
| deploy | **not deployed**（本轮不 rollout/restart） |
| live ChatGPT production feedback | **not enabled**；未 emit |
| next transport | **browser companion**（E1b+，本文件不做） |

权威入口：
- synthetic probe：`src/feedback/probe-store.ts` / `probe-ui.ts` / `src/mcp/feedback-probe.ts`
- production：`src/feedback/store.ts` / `projector.ts` / `src/mcp/feedback.ts` / `src/mcp/conversation-principal.ts`
- tests：`tests/feedback-probe.test.ts` / `feedback-probe-cli.test.ts` / `production-feedback.test.ts`


---

# Phase E1b0 browser companion 委派与 delivery 合同（代码，未部署）

日期：2026-09-15。**不写 extension / DOM**；不 deploy / rollout / restart。

## 状态机

```
queued → ready → reserved → claimed → observed
                      ↓          ↓
                   ready     outcome_unknown
              (release/stale)   (stale claimed)
```

- `reserved`：可逆预占；`FEEDBACK_RESERVATION_STALE_MS=2min`；stale → ready
- `reserved → claimed`（`beginSend`）：不可逆 send-intent；持久化 `attemptId`
- `claimed` 仍不可自动回 ready；stale claimed → `outcome_unknown`
- `reserved` / `claimed` / `outcome_unknown` 均阻止 takeover
- MCP `claimNext` 跳过 reserved

## 委派信任链

```
trusted principal → active bindingId+epoch
  → one-time pairing intent (hashed secret, 10min)
  → companion credential (hashed, scoped)
  → https://chatgpt.com/c/<uuid>
```

- companion **不得**接收 `openai/session`、principal fingerprint、admin token、OAuth/MCP/Desktop scope
- credential/secret 只存 SHA-256；明文仅 pair/exchange 响应一次
- re-pair = transport takeover：存在 `reserved/claimed/outcome_unknown` 时 **fail closed**（`COMPANION_REPAIR_BLOCKED`）；reserved 须先 release 或等 stale→ready；成功 re-pair 时旧 credential 立即失效
- epoch 变更立即失效旧 companion
- route 仅 `https://chatgpt.com/c/<uuid>`（delivery locator，非 identity）

## 公共 HTTP（`/api/companion/v1`）

| Method | Path | Auth |
| --- | --- | --- |
| POST | `/pair` | pairing intent |
| GET | `/state` | companion Bearer |
| POST | `/reserve` | companion |
| POST | `/release` | companion |
| POST | `/begin-send` | companion |
| POST | `/ack` | companion |

挂载于 Bridge，**不**使用 adminGuard / bearerAuth / MCP。经 named tunnel 暴露；production 不依赖同机 localhost。E1b0 仅 REST。

## MCP 新增

- `feedback_companion_pair` — trusted 创建 pairing intent（secret 一次）
- `feedback_companion_status` — 元数据，无 secret
- `feedback_companion_revoke` — 撤销 companion/intent

## 代码入口

- `src/feedback/store.ts` — reserved 状态机 + companion/intent 字段
- `src/feedback/companion.ts` — route/credential/pair/exchange/verify
- `src/bridge/companion.ts` + `src/bridge/server.ts` — public transport
- `src/mcp/feedback.ts` — pair/status/revoke tools
- `tests/companion-feedback.test.ts` — 安全/状态机/HTTP

**not deployed**；runtime 仍为 pre-E1a。

权威入口补充：
- companion：`src/feedback/companion.ts` / `src/bridge/companion.ts`
- companion tests：`tests/companion-feedback.test.ts`

---

# Phase E1b1 Edge-first passive Browser Companion（代码，未部署；未执行 native Send）

日期：2026-09-15。E1b0 complete；runtime 仍 **not deployed**。

## 范围（本阶段）

- 统一 ChatGPT conversation route 解析：`src/chatgpt/route.ts`（browser-safe，无 Node import）
- 支持：`/c/<id>`、`www.chatgpt.com`、`/g/g-.../c/<id>`（Project/GPT shaped）
- canonical host=`chatgpt.com`；companion **拒绝** query/hash；web-control **剥离** query/hash（不弱化）
- MV3 extension：`browser-companion/` → 打包 `dist/browser-companion/`
- permissions：`storage` + `activeTab`；hosts 仅 chatgpt.com / www.chatgpt.com
- **无** `<all_urls>` / debugger / nativeMessaging / webRequest / remote JS
- document ownership：tabId + documentId + canonicalRoute；popup 显式 Bind
- SPA route 轮询 + popstate/hashchange；无 MAIN-world history hook
- 只读 DOM adapter：composer empty/dirty/absent/unknown；generation idle/generating/unknown
- **未知一律不安全**；不写 composer；**不点 Send**；无 companion credential 下放 content script

## 明确未实现

reserve polling / begin-send / SEND_INTENT / composer write / native Send / native user-turn ACK / WSS / production deploy

## 存储

- `chrome.storage.local`：schemaVersion、targetRoute、paired 标记
- `chrome.storage.session`：tab/document registry、owner document、liveness

## Edge 验证

产物目录：`dist/browser-companion`（`pnpm run build:companion`）。

**真机验收（2026-09-15）：已通过。** 本机 Microsoft Edge 加载 unpacked 后，对真实已登录 ChatGPT Project conversation 被动观察：

- popup 显示真实 Project conversation canonical route（`/g/g-.../c/<uuid>`，与 parser 的 gpt-conversation 支持一致）
- Bind 后 popup 显示 **是 owner**
- 切走 conversation / reload：owner 失效，不静默继承
- 同 route 另一 tab 不成为 owner
- 全程 **未写 composer、未点 Send**

E1b1 = Edge-first **passive ownership layer** 验收完成。仍未实现 reserve / begin-send / SEND_INTENT / native Send / ACK / Bridge production deploy。

## 门禁

定向 route/companion/web-control + 全量 **60 files / 1024 passed**；typecheck / build（含 companion 打包）/ diff-check 通过。

Ownership review-fix：popup `isOwner` 经 content script → SW（真实 MessageSender）；同 tab 出现不同 documentId 或缺 documentId 时 fail-closed 清 owner；移除死 `c2c.unobserve` 路径。

---

# Phase E1b2 transport + reversible reservation（**code review passed；Bridge 已部署；live transport pending**）

日期：2026-09-15~16。基于 E1b1 `main@66e0e49`。

## 现役状态（2026-09-16）

| 项 | 状态 |
| --- | --- |
| code review | passed |
| Bridge deploy | **runtime `637edb28` current**（workspace-scoped） |
| MCP companion tools 可见性 | **model-visible**（`5b5032f`） |
| companion API | `/api/companion/v1`；`ok` 字段保留；autonomous reconcile on `/state`+`/reserve` |
| extension 包 | `dist/browser-companion` 已含 paste-JSON / idle evidence / base path |
| live transport 端到端 | **pending** |
| native Send | **从未发生** |

## 范围

- SW-only Bridge HTTP + credential；content/popup 不持 secret
- `chrome.storage.local.setAccessLevel(TRUSTED_CONTEXTS)` before storing credential
- Bridge origin parser（HTTPS 生产 / loopback HTTP 开发）
- Pairing（exact owner + 权限 + POST /pair）
- GET /state + identity 校验 + `inFlight` recovery 投影
- 5s heartbeat 证据；reserve 门禁；durable journal
- POST /reserve + /release
- **不** /begin-send、/ack、composer 写、native Send

## Journal

`NONE` | `RESERVE_REQUESTED` | `RESERVED` | `RESERVATION_RECOVERY`

## 门禁（最新）

**61 files / 1059 passed**；typecheck / build（含 companion）/ diff-check。

## E1b2 review-fix（2026-09-15）

- `storageProtected`：TRUSTED_CONTEXTS 失败则不加载/不写 credential，pair/fetch/reserve fail closed
- pair：popup→content mint one-use ownerProof→SW 验 proof 后 /pair（secret 不经 content）
- reserve：popup→content→SW `c2c.reserve.page`，identity 只来自 MessageSender
- active journal（REQUESTED/RESERVED/RECOVERY）拒绝 `transport.clear` 与 pair
- 401/identity mismatch 先 `persistTransport` authStale=true
- 门禁：**61 files / 1036 passed**

## E1b2 atomic route refresh closeout（2026-09-15）

- owner-proof / reserve 请求携带当前 href+safety；SW 先 `refreshPageObservation` 再 exact-owner 判定
- 同 document SPA 已切 route 时立即拒绝（不等 800ms poll）
- popup pair 使用 try/finally 清空 secret
- fresh full gates：**61 files / 1044 passed**；typecheck / build companion / diff-check

## E1b2 运行时收尾 hotfix（2026-09-15~16，均已 commit）

- `5b5032f`：production feedback MCP **model-visible**（部署后 ChatGPT 可刷新看到 companion tools）
- `cecc710`：popup paste pairing JSON；origin local 持久；intentId session-only
- `39d3075`：`companionApiUrl` 固定 `/api/companion/v1`
- `a96a210`：`fetchCompanion` 保留 `Response.ok`（修 `http_200` 误判）
- `1413969`：generating 实证——同 class 变 `data-testid=stop-button` → generating；idle 须 `text-submit-btn-text`
- `a5f337e`：认证后 `/state`+`/reserve` **autonomous reconcile**；已 rollout 至 `637edb28`

---

# Phase E1b3d3 production Send + late-positive closeout

日期：2026-09-17。**现役终态**。本节覆盖代码与已部署 Core；上方各段为历史过程记录。E1b0 状态机图中 `outcome_unknown` 的“死端”只描述当时；现役允许 **exact late-positive** 闭环。

## 状态机（现役）

```
ready → reserved → claimed → observed
                 ↓    ↓
              release  outcome_unknown
                       ↓ exact DOM turn late-positive
                 OBSERVED_PENDING_ACK → /ack → NONE
                       ↓
                 trusted ACK / server observed closeout → NONE
                       ↓
                 manual retired_unknown（永不重发 / 永不 ACK）
```

- `OUTCOME_UNKNOWN` **不是**永久粘死：仅在 **同一 authenticated identity** 下闭环。
- 允许：Companion `/ack` 与 trusted MCP `feedback_ack_observed` 在 **exact attempt** 上 `claimed|outcome_unknown → observed`。
- 允许：本地 journal `OUTCOME_UNKNOWN` + server `inFlight=null` + exact `observed` proof → SW durable clear（`server_observed_clear`），零 DOM。
- 允许：本地 late-positive DOM 观察（exact canonical user turn）→ `OBSERVED_PENDING_ACK` → 复用既有 ACK。
- 禁止：`retired_unknown` 再 ACK / resurrect；identity 或 attempt 不一致仍 fail closed。

## 代码入口（现役）

| 层 | 文件 |
| --- | --- |
| journal / late-positive transition | `browser-companion/reservation-journal.js`（`markLateObservedPendingAck`） |
| pure send / observed proof | `browser-companion/production-send.js` |
| orchestration recovery | `browser-companion/send-orchestrator.js` |
| production DI runtime | `browser-companion/production-send-runtime.js` |
| SW recover / state / retire | `browser-companion/service-worker.js` |
| popup structured recover | `browser-companion/popup/popup.js` |
| server ACK + retire | `src/feedback/store.ts` / `src/feedback/companion.ts` |
| trusted MCP ACK description | `src/mcp/feedback.ts`（`feedback_ack_observed`） |
| **route attestation（G3，2026-09-19）** | server `src/feedback/companion.ts` + MCP `feedback_companion_route_confirm`；browser `browser-companion/route-attestation.js` / `route-attestation-run.js`；**production reserve/begin-send 要求 route VERIFIED**；详见 [development-plan.md G3](development-plan.md) |

## 部署 / live（2026-09-17）

| 项 | 状态 |
| --- | --- |
| Core trusted late-positive ACK | **deployed** 至 `codex-with-chatgpt`：`runtimeBuildId=installedBuildId=6349ad9887d2…`，`upgradePending=false` |
| MCP `feedback_ack_observed` 描述 | **live**：`exact claimed/outcome_unknown → observed；observed same-attempt idempotent` |
| Browser extension | `dist/browser-companion` 已含 latest recover/diagnostics/server-observed；Reload **已完成** |
| live event `e600aed6ef94…` | 历史 server **`observed`**；不再执行 Send、Recover、ACK、Retire、Reserve |
| 安全边界 | credential 仍 SW-only；zero-Send 运行时（除用户显式 send-click-adapter）；journal NONE 不自动重发 |

门禁：typecheck / build / `pnpm test --maxWorkers=1 --testTimeout=90000` / `git diff --check` 通过。

**注（2026-09-19）**：上表部署 build `6349ad98…` 为 E1b3d3 时代证据。之后 G3 route-attestation / classic packaging 已合入并安装至 workspace `2582910bf0d2` 的更新 Core；**不得**把上表当作当前机器 runtime 结论。现役 G3 事实以 [development-plan.md](development-plan.md) 与 `status --json` 为准。

---

# Phase E1b3d3b2 autonomous trigger + exact message-body observation

日期：2026-09-18。**现役终态**（extension Reload、independent review、live ACK closeout 均已完成）。

## Autonomy（默认 OFF）

| 项 | 语义 |
| --- | --- |
| policy | `c2c_companion_autonomy_v1`：`off` \| `shadow` \| `armed`；identity 变更强制 disarm |
| trigger | 仅 exact owner-document `c2c.heartbeat`；memory tick gate |
| SHADOW | 只读：ready>0 时记 `would_reserve_and_send`，零 reserve/send |
| ARMED | journal-first；同 tick recover 清空后不再 reserve；一 tick 一条；durable 30s cooldown；`RESERVED` continuation 复用 `canStartProductionSend` + `handleProductionSend`（reserve=0） |
| popup | Enable Shadow / Arm Production（需 confirm checkbox）/ Disable；ARMED 时禁用 manual Reserve/Production Send；Retire 仍 manual-only |
| 诊断 | bounded：heartbeat safety、evaluated evidence、recovery result + observation diagnostic（无 raw text/credential） |

## Exact message-body observation

- `findCanonicalUserTurn`：parent exact fast path 保留；否则 parent visible text 必须含 exact ATTEMPT，再在 ≤64 descendant 中用 **innerText full equality + exact ATTEMPT** 作为唯一成功 authority。
- 不放宽 canonical equality；无 substring/trim/textContent authority。
- Ambiguity 按 **user turn** 计，不按 descendant 数。
- Representation diagnostic（bounded numbers/booleans）解释 UI chrome vs nested exact body。

## 代码入口（现役）

| 层 | 文件 |
| --- | --- |
| autonomy policy / plan tick / recovery sanitizers | `browser-companion/autonomy.js` |
| SW heartbeat tick / recover closeout / autonomy RPC | `browser-companion/service-worker.js` |
| exact body observation + bounded descendant BFS | `browser-companion/turn-observer.js` |
| tests | `tests/e1b3d3b2-autonomy.test.ts` / `tests/e1b3d3b-production-send.test.ts` / `tests/e1b3-dom-capability.test.ts` |

门禁：typecheck / build / `pnpm test --maxWorkers=1 --testTimeout=90000`（1518 passed）/ `git diff --check` 通过。

## Phase F1a operational readiness（2026-09-18）

E1b3d3b2 的最终 live acceptance 已收口：最终 acceptance event 为 `eventId=2c6b1d23641f46c484410c45f9e92d1c`、`attemptId=587c6632-7fa3-487b-a42c-25922952324b`、status=`observed`；extension Reload 已完成，ChatGPT independent review 已完成，live ACK closeout 已完成，browser journal 为 `NONE`，Bridge `inFlight` 为 `none`。历史 event（包括 `e600aed6ef94…`）不再执行 Send、Recover、ACK、Retire、Reserve。

F1a 只增加现有 SW status payload 的纯、只读 operational health summary 及 popup 展示，不新增 endpoint，不改变 reserve/begin-send/ACK/recover/retire 语义。摘要限于 mode、identity/owner/storage/transport 门禁、journal phase、in-flight、heartbeat 新鲜度分桶、cooldown 与 allowlisted reason；不暴露 message/DOM/credential/principal/document/tab/event/attempt 标识。`OUTCOME_UNKNOWN` 与 `OBSERVED_PENDING_ACK` 始终标记 recovery-required。

门禁：**70 files / 1519 passed / 0 failed**；typecheck / build / `git diff --check` 通过。下一阶段为 F1 operational readiness review，不扩展生产发送协议。

---

# Phase G3 route-principal attestation（2026-09-19，现役 code + Bridge install）

权威事实源：[development-plan.md — G3](development-plan.md)。

- `paired ≠ attested`：production companion reserve/begin-send 要求 authenticated `/state` `routeVerification=VERIFIED`。
- MCP：`feedback_companion_route_confirm`；wrong principal 不消费 challenge。
- Browser：durable fence + `PAIRING_TRANSITION`；post-write ready gate 仅 form `send-button`；classic CS `*-global.js` 打包。
- **live G3 cross-device E2E 未执行**；见 development-plan `NEXT_EXPECTED_STEP`。
- 历史 phase 文中的 “not deployed / Reload 已完成” 只描述当时轮次，不能当作当前机器 runtime 结论；以 `status --json` 为准。
