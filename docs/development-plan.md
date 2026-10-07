# 长期开发计划

当前单机多 workspace Gateway、单插件整合的现役源码范围与未完成验收见[统一 Gateway 计划](unified-gateway-plan.md)，工具与安全合同见[官方路线](official-route.md)。本文其余部分保留各阶段历史记录；旧条目的“当前/NEXT”、PID 与部署快照只代表标注时点，不证明当前运行状态。

<a id="当前事实与开发阶段2026-10-04-2144asiashanghai"></a>

## 当前事实与开发阶段

### 2026-10-05 官方路线全面源码改造

用户已授权在 `codex/official-mcp-events` 开始改造。实现范围见[官方路线合同](official-route.md)：显式 workspace/target/thread；复用官方 App Server 客户端与持久队列；独立 MCP 入口；Bridge official 模式停用旧任务下发；官方终态进入现有 Result Bus 和 Companion 面板。本段记录源码阶段：保留原有 dirty 工作，截至源码验收未 commit/push 或部署；后续显式部署见下。

此前持久会话验证已经完成：官方创建的持久 thread 能在 Desktop 可见，用户接管后复述随机码及 active turn 插话均成功。但独立 App Server 对 Desktop 持有的 writer 再次 resume 被明确拒绝；新源码必须展示这个限制，不能把 idle 当作释放 writer。此前“尚未开始持久会话实验”是当轮历史，详细证据以[最新实验记录](../experiments/official-dispatch/README.md)为准。

**源码验收完成（2026-10-05 21:10，Asia/Shanghai）**：typecheck、定向回归、正式串行全量 **164 files /3435 tests PASS、exit0、unhandled0、skip/pending/todo0**；wall **1604.82s**、runner **1600.50s**。471 项冻结 source/test/support 哈希稳定，最终运行新增进程/监听/temp 均0。全量通过后执行一次 canonical build，stored==computeBuildId==core-release==**`c4b4c18d050137aaae1130b99257e3e13ded21eefbdf6359db2ee22798e28d97`**；官方 gateway/controller/results、Result Bus 新来源与 Companion 面板资产均已打包。证据位于 ignored `.tooling/official-route-20261005-verified/`。测试清单为 packaging1/serial6/parallel157，仅更新清单，不代表运行或验收 R5j candidate/parallel。

首个完整全量为 **163 files /3434 tests PASS，1 file /1 assertion FAIL**：旧结构测试按全文首次出现位置判断工具注册顺序，不能区分新增 official/feedback 分支。只修正该测试与清单哈希，明确验证三种 profile 各自的注册集合和顺序，保留其余边界断言；469 项其他冻结文件（包含全部生产源码）未变，再冻结执行上述正式全量。失败证据在 `.tooling/official-route-20261005-final/`，修订对比在 `revision-proof.json`，没有以 unchanged retry 掩盖失败。

更早的启动轮在发现独立 gateway 与 Bridge 共用缓存式 AuthStore 后主动中止；修复为独立 OAuth 凭据文件并补回归后才进入上述完整门禁。该中止轮的三个隔离测试目录保留作证据，删除被自动审批以 `blocked by policy` 拒绝，未绕过；最终“新增残留0”以保留它们后的基线计算。日志仍包含既有 `route-esm.js` 缺少 `route.js.map` 的调试映射诊断，未扩展修改打包机制。

源码验收时（2026-10-05 21:10，Asia/Shanghai）的下一阶段计划为经部署授权切换独立入口。本段未 install/rollout、启用 official 模式、启动真实 App Server/Tunnel、切换绑定、注册 Scheduled Task 或 commit/push；随后实际部署状态如下。普通 Chat 原生 Events、跨进程 writer 无缝移交和 machine supervisor live acceptance 仍未完成。

### 2026-10-05 官方路线部署与 OAuth 待验收

截至 21:52（Asia/Shanghai），当前 branch/HEAD 未变（`codex/official-mcp-events` / `1379fd61a5dbd3220311032682b490b2431a586d`）。471 项冻结文件保持稳定；此前正式串行全量 **164 files /3435 tests** 沿用，本次未重跑。build、installed、running ID 相同：`c4b4c18d050137aaae1130b99257e3e13ded21eefbdf6359db2ee22798e28d97`。Bridge PID `19516` 的 `startedAt=2026-10-05T13:41:24.570Z`；workspace `2582910bf0d2` local/admin/named health 全部 PASS，scoped rollout upgraded 1、pending 0、error 0。

通过稳定 launcher 启用 `deliveryMode=official` 后，controller PID `24508`、App Server PID `20172` 及 Codex `0.160.0` 运行。原 bindings、其他 workspace runtimes 和历史 tasks/threads/audit 均未改变；supervisor registration absent，config/runtime 均为 null。Bridge 原反馈 URL `https://c2c-codex-with-chatgpt.devworklink.com` 保留。

**历史快照（2026-10-05 22:27）**：新 OAuth origin `https://c2c-official-2582910bf0d2.devworklink.com` 与 Cloudflare tunnel `2186ac70-4742-42a4-90d0-745cc7568402` 已创建；22:27 gateway 已在本地端口 `48766` 运行（PID `19912`），Cloudflare PID `20304`、官方 Tunnel 客户端 PID `24788`。本机/公网 OAuth metadata 200、issuer 精确、匿名 MCP 401；官方 Tunnel readyz 200（initialize requires auth），网页 OAuth 和真实任务仍未验收。首轮部署脚本先启动 Tunnel 导致 OAuth discovery connection refused，用户 Ctrl+C 后已证明两个自有隧道退出、端口无监听；只修 ignored 启动脚本为 gateway 与公网 OAuth 就绪后再启动官方客户端，加入精确 trusted origin 与原生 startup wait，第二轮就绪。此修正没有改动被冻结的业务源码，也没有重启 Bridge/Controller。Secure MCP Tunnel 可承载 OAuth discovery，但不会自动 tunnel authorization server；因此新 origin 使用独立 OAuth store，不能套用 Bridge origin 的共享 store。[OpenAI Secure MCP Tunnel 文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)说明了此边界。

安装器 best-effort GC 已删除 `d0b085bb1b6445da312068e6014b0f026fc345fde2ae702af8675268062875d5`（72,533,432 bytes）。最终只读 GC plan 将旧 release `1326542c3601b2919b1872c1d80ac22aab258b05774c5ce438513b0c5aeba3a8` 列为候选，未删除；dangling runtime `d94af68105aa` 局部保留，引用的 build `9c33929c545edbe2242770baede0cef9f1f189712d9ce0060f307bc88ce0732a` 不存在。

后续待验收：输入 Key 后启动 OAuth gateway 与独立 Tunnel，验证真实网页工具刷新/OAuth、target 创建/选择、连续投递、结果读取及 Companion 回流。本次没有 commit/push、注册 supervisor 或 reload 浏览器扩展。

### 2026-10-06 00:58—01:45 部署与 OAuth 历史阻断快照

截至 00:58:32（Asia/Shanghai），最新实际 run `.tooling/official-route-deploy-20261005/run-20261005T162626765Z-d6f6ba64590d4a3d85a02743e81c693e/gateway-live.json` 显示独立 gateway 于 00:31:49 因用户 Ctrl+C 停止；gateway PID `12196`、Cloudflare PID `15448`、官方 Tunnel PID `9368` 均已 missing，端口 `48766` 已关闭。测试入口已停止不表示生产 Bridge 关闭：Bridge PID `19516` 仍 healthy，installed/running build 为 `c4b4c18d050137aaae1130b99257e3e13ded21eefbdf6359db2ee22798e28d97`，`runtimeUpgrade.state=current`、`upgradePending=false`；Controller PID `24508` 和 App Server PID `20172` 保持原 identity，`deliveryMode=official`，feedback/result-bus inflight 均为 0。bindings、history、其他 workspace runtimes 均 unchanged，supervisor config/runtime 为 null。471 项冻结哈希全部匹配。

**00:58 历史阻断状态**：最初 trusted-origin 不足，Harpoon target=0 并报 unsupported channel；regex 修正受 `private-host-registration-disabled` 限制。之后显式登记的 5 个精确 HTTPS 授权地址已加载（target 登记成功，另有两个 OAuth metadata endpoint 返回 200；未实际 POST 验证 register/token/revoke；`enabled=true`、`count=5`、`discovery_complete=true`），但网页仍显示“无法发现 OAuth 设置”。8 次 Harpoon 工具调用的 transport 200 只证明 HTTP transport，不证明 RPC/授权成功；AuthStore 未创建，因此 OAuth 修复与真实下发均未通过。

截至 2026-10-06 01:45:17（Asia/Shanghai），只读范围复核见 `.tooling/official-route-deploy-20261005/overnight-final-scope-20261006.json`：Bridge PID `19516`、Controller PID `24508`、App Server PID `20172` identity 保持，runtime build 仍为 `c4b4c18d050137aaae1130b99257e3e13ded21eefbdf6359db2ee22798e28d97`；bindings、history、其他 workspace runtimes 未变，feedback/Result Bus inflight 为 0，maintenance/rollout/start 无锁，official AuthStore 不存在。471 项 frozen hash 零漂移。本轮无业务源码改动或正式 full/build 重跑，未 install/restart/启动 gateway，未使用 Key。

**本机 fake control plane A/B 通过**：`.tooling/official-route-deploy-20261005/offline-oauth-harpoon-acceptance-20261006.json` 记录 cross-origin 显式配置 5 targets / OAuth auto 0，same-origin auto 8 个 OAuth targets，覆盖 PRMD、auth server、issuer、token、registration、revocation 等角色；metadata 重写符合预期，匿名及无效 bearer GET/POST 为 401，有效 bearer POST 为 200 且 Authorization 按正常机制透传，未知 label 返回工具错误且不发起 HTTP 请求，register GET 为 405（没有 DCR POST）。两组进程、监听端口和临时文件清理均通过。该 fixture 仅用 loopback HTTP、fake control plane 和 dummy credentials，不证明公网 TLS、网页 OAuth、真实授权交换，也不证明 hosted 根因已修。

**same-origin-auto 候选配置已准备，尚未启动**：`run-official-gateway.ps1` SHA-256 为 `2BA62A7AAA5BC6411070A4919BC6BA95E9C25483541C0B27D8477E97A8B34606`；`.tooling/official-route-deploy-20261005/harpoon-target-validation-20261006-same-origin-auto.json` 记录 PowerShell AST、精确 hostname regex 与 5 个拒绝反例、native client help/profile 隔离校验通过；`check-gateway.mjs --self-test` 通过 8 个 OAuth URL/角色精确检查及 6 个拒绝反例。候选将 MCP upstream 指向同一 public HTTPS origin 的 `/mcp`，使用精确 host regex，移除五个手工 target，保留 trustedOrigin、TLS 与 loopback 防护，private include、plaintext HTTP 和 request capture 均关闭。候选尚未用于真实 Tunnel/gateway 启动，没有请求真实 control plane，也未读取生产凭据。

**01:45 历史状态**：候选配置尚未实际启动，hosted 根因也未确认已修。

**01:45 历史计划（08:15 OAuth 后续已推进）**：明天用户回来后，先打开新的 App OAuth 表单并隐藏输入原 Key；主代理先检查 same-origin auto 8 个角色、公网 metadata、匿名 MCP 401 与 Tunnel readyz，再用新的 5 分钟本机码完成 OAuth，然后验收 target/tasks/result/feedback。

本轮仅修改 ignored 部署脚本并运行离线验证；没有业务源码改动、正式 full/build 重跑、install、restart 或 supervisor 变更。Bridge 原反馈绑定保持不变。

### 2026-10-06 08:15 起 OAuth、target 与官方 turn 验收

用户在新 App OAuth 页面确认“已连接并显示工具”。run `20261006T001123769Z-912dc4e0dd044f1e80b52e9b176796c3` 的 `gateway-oauth-confirmed-<run>.json`（08:15:28）记录 clientCount=1、active access/refresh 各 1、workspaceExact=true，scope 含 workspace.read、codex.read、codex.control 等；`gateway-check-<run>.json` 对 8 个 native source=oauth 角色、精确 URL 与 group 检查 PASS，TLS 与 plaintext/capture 约束检查正确。

边界仍需如实保留：Tunnel readyz 返回 HTTP 200，但正文报告 startup probe 2s timeout；随后 fresh 未授权 initialize 本机 401/40ms、公网 401/1255ms，符合未授权拒绝。截至 08:15 首次 OAuth 检查时，用户页面显示工具可见确认连接，但尚无独立证据证明网页授权业务 RPC 已执行；后续两个 turn 与网页按需读取见下文。

08:16:57 的 `gateway-oauth-scope-<run>.json` 确认 Bridge PID `19516` 仍 healthy、build `c4b4c18d050137aaae1130b99257e3e13ded21eefbdf6359db2ee22798e28d97`，bindings/history/其他 workspace 未变，feedback 与 Result Bus inflight 均为 0，deliveryMode 仍为 official。普通 Chat 的用户提供只读结果为 workspace_info 对应 `codex-with-chatgpt / 2582910bf0d2 / D:\python\codex-with-chatgpt`；`codex_list_targets` 显示 controller=running、targets=[]。该只读 smoke 通过；用户确认没有创建 target、投递任务或改文件。

08:19:12.630，requestId `official-gateway-live-20261006-01` 创建成功：targetId `b90a0577-2174-409f-8228-13fe8722ddef`、threadId `01a10e94-2366-7dc0-ae7b-0f948f24bef3`，本机 state 仅有该对象且 tasksForThread=0。task01（taskId `927502f2-3fb9-47bc-9a82-4e838282035b`，turnId `01a10e96-2cca-7382-a24c-4291d1d92c79`）于 08:21:34.580 完成，网页按需读取返回 completed，finalResponse 精确匹配 `C2C_OFFICIAL_GATEWAY_OK_7a4f2c91`，outputId `254` available=true。

随后同一 thread 的 task02 连续性测试（taskId `b3abf503-db6f-4d58-9d05-d30d8058ce21`，turnId `01a10e98-0700-79d2-bbaf-2fd83bb5c695`）于 08:23:35.501 本机完成；finalResponse 两行精确为 `C2C_OFFICIAL_GATEWAY_OK_7a4f2c91` 与 `C2C_CONTINUITY_OK_82d19f6a`，outputId `255` available=true。网页按需读取 task02 也返回 completed 且完整两行匹配；同 thread 上下文连续性通过。

截至 08:25 的历史快照：`gateway-two-turn-scope-20261006.json` 确认本轮只新增 1 thread、1 target、2 tasks；排除这些新增对象后的原 Remote 历史 SHA 与部署前匹配，旧 bindings、其他 workspace 未变，471 项冻结哈希零漂移。两条 Result Bus 记录当时均为 source=`codex_app_server`、status=`queued`，无 reservation/attempt；当时自动回流与 Companion feedback/ACK 尚待验收。普通 Chat 原生 Events 未通过。

08:31:01.919（Asia/Shanghai；状态快照 `companion-after-connect-*.json`）：用户点击 Connect 并确认当前对话已连接、自动回流开启。快照记录 Feedback binding `0f7d038a-08bb-4b1b-b899-8ddc01a0f7cd` epoch 14、Companion `d0c62b46-93c0-477d-87fe-eb943303aa0c`，Web Sink binding `4874ab53-02e4-4e5b-ae36-94dacaac2af7` epoch 4，route `https://chatgpt.com/c/6ac43e04-28c0-83ec-9651-0b32ba0617e4`。最终核验 `.tooling/official-route-deploy-20261005/gateway-companion-feedback-acceptance-20261006-verified.json` 确认 route attested 于 `2026-10-06T00:28:54.420Z`；Bus `11b81a1e…` 与 `355d0ebd…` 分别于 `00:29:01.994Z`、`00:29:31.996Z`（本地 08:29）observed，对应真实 Browser attempt `7a353a29-7155-436a-9dd8-5ffa05dc0e13`、`aee30ae6-ee3c-4c12-bca9-14ea52a131cc`，task 均 completed。既有 Connect 后的真实 Browser Send+ACK 通过，不是手工改状态；普通 Chat 原生 Events 仍未通过。核验另确认 Bridge PID `19516` healthy、installed/running build `c4b4c18d050137aaae1130b99257e3e13ded21eefbdf6359db2ee22798e28d97`，旧 Remote 历史 SHA 与部署前精确匹配，其他 Desktop/Executor binding hash、workspace runtime 与 named tunnel 未变，471 项冻结零漂移，inflight/locks 为 0、supervisor config/runtime 为 null。本轮用户输入 Key 启动独立 Gateway 与隧道；业务源码未改，Bridge/Controller/App Server 未重启，也未额外 install/full/build。

### 2026-10-05 官方消息与事件路线实验

用户授权冻结现有路线，并从包含全部56项累计改动的快照 `1379fd61` 创建 `codex/official-mcp-events`。冻结分支为 `codex/frozen-c2c-20261005`；原 `main` 提交位置及已部署服务保持不变，没有 push。目标是 MCP 下发任务、官方事件唤醒 Chat、按需读取结果，不要求把回流全文写入网页输入框。

独立 Events 探针单测 **61/61 PASS、check=0**；两项 syntax 检查、PowerShell Parser、diff checks 也通过，验收日志为 `.tooling/official-mcp-events-20261005/proxy-validation-20261005T131912218.log`。一次 Work 单结果 live 测试收到 HTTP 200 accepted event，并在同一对话自动 `read_result`；截图 proof 与主代理独立插件读取精确匹配，该独立审计读取另计。随后普通 Project Chat 按修订指令复试；日志显示 `server/discover=1`，`subscribe`、subscription、event attempt、tool read、RPC fault 均为 0。Chat 回复自述无平台原生事件入口，但这不作为底层工具清单证明；本次会话未发起订阅，不代表所有普通 Chat 永久不支持。用户已确认退出，主代理只读核实端口 `43871`、`11294` 无监听且精确实验路径下 `tunnel-client` 进程数为 0。详细观测见[实验记录](../experiments/official-events/README.md)。

本次 Work 单结果闭环仅证明一个 Work 对话可收到已接受事件并读取匹配结果；本账号本次普通 Project Chat 的 Events 修订指令试验未发起订阅，不能据此验收普通 Chat 的 Events 自动唤醒，也不能推断所有普通 Chat 永久不支持。另一次普通 Project Chat 经独立 Tunnel 的官方下发与按需读取已单次通过，见下文；Work Events 成功不替代这项普通 Chat 验收。没有生产服务改动。后续待验证范围为持久会话、连续投递及这些情形下的普通 Chat 回流；尚未启动下一轮任务。生产链路接入、持久化恢复、长期订阅 refresh、跨重启与 key rotation 均未验收。其他账户/route 的可用性及费用仍按前述边界处理。

**普通 Chat 官方下发进展（2026-10-05）**：通过既有独立 Tunnel，在普通 Project Chat 中完成一次官方 App Server 下发与显式按需读取：唯一执行调用在 45 秒界限返回 `running`，用户随后发起一次 `read_official_dispatch_state` 查询后得到 `completed`；两轮 turn 均完成且精确匹配。主代理将完整报告与本机证据逐字段比对一致，详情与 SHA-256 见[隔离投递记录](../experiments/official-dispatch/README.md)。这只证明本次单次实验的官方下发和按需读取；持久会话、连续投递及这些情形下的普通 Chat 回流仍待验证，普通 Chat 的 Events 自动唤醒与既有 Desktop thread 控制也未验收。用户已 `quit`；主代理于 `2026-10-05 16:46:30 +08:00` 只读核验端口 `43872` 和本 run health `2367` 均无监听、probe PID `24328` 不存在、指定 `tunnel-client.exe` 进程数为 0；既有 Codex 进程 PID/创建时间未变。下一步仅为上述持久会话、连续投递与普通 Chat 回流验证；本次没有发起下一轮任务。

### 2026-10-05 双向收件箱源码开发

用户授权参考主代理/子代理的消息方式改造，并授权自主推进后续开发。本轮实现 [双向消息收件箱](agent-mailbox.md)：MCP 原子入队，后台通过现有安全入口投递；busy 可排队，旧条目坏锁或未知尝试不饿死其他条目。canonical 回流未知 attempt 可以保留原证据后逐条隔离，后续回流继续；面板独立只读读取已有 canonical summary/tests。没有加入未验证的 active-turn steer、第二个执行权威或数据库。

**开发与源码门禁已完成**：定向测试、独立职责/安全审查、typecheck、`git diff --check` 和 canonical build PASS。修订后的正式串行全量 **161 files /3403 tests PASS、exit0、unhandled0、skip/pending/todo0**；wall **1389.35s**、runner **1385.90s**，465 项冻结 source/test/support 哈希稳定，新增进程/监听/temp 均0。构建 stored==computeBuildId==core-release==**`1326542c3601b2919b1872c1d80ac22aab258b05774c5ce438513b0c5aeba3a8`**，新 mailbox/shared sender/未知尝试归档均已打包。测试清单为 packaging1/serial6/parallel154、support32，仅 bookkeeping；R5j 仍 workers3、experimental/deferred，没有运行 candidate/parallel。

首轮正式全量保留为失败证据：157 files PASS、4 files/5 assertions FAIL，unhandled0、冻结稳定、残留0。原因是原结构检查仍按抽取前的 MCP dispatcher 与恢复函数边界定位；仅修正4份测试的定位，保留 no-owner/no-CS/no-Send、offline、生产 backend/pin/finalize/authority 断言，生产代码未因此修改。修订后的全量是新冻结版本的重新验证，不是 unchanged retry。关闭 prepare/commit 竞态也已修复并覆盖两类下发：确证未发送保留 queued，已提交等待原尝试，不重排。

源码验收证据保存在 ignored `.tooling/agent-mailbox-20261005/`（首轮日志与定向验证）和 `.tooling/agent-mailbox-20261005-final/`（revision-proof、frozen/full-result/full-vitest/build-identity）；后端部署与现场核验见 ignored `.tooling/agent-mailbox-deploy-20261005/` 及下方当前部署快照。

日志还保留 `route-esm.js` 引用的 `route.js.map` 缺失诊断；本轮未改相关打包脚本，该调试映射资产问题未扩大修复。正式门禁仍为 exit0/unhandled0；原始诊断可在 full.log 查阅。

**仍待完成**：用户已确认 Companion Reload；08:32 after-confirm 只读核验与465项冻结哈希复核均通过。Desktop 本机确认完成，Desktop 与 generic Executor 可用，当前采样 activity=busy；真实新任务的 busy 排队→单次发送、unknown 隔离→回流、晚到 ACK 与面板结果读取尚无独立端到端验收。Supervisor 注册及独立恢复验收仍需单独授权。

### 2026-10-05 08:32 后端部署快照

最终只读核验时间为 `2026-10-05T00:32:47.556Z`（北京时间 08:32:47.556）；安装与 scoped rollout 在 08:26 前已完成。目标 build `1326542c3601b2919b1872c1d80ac22aab258b05774c5ce438513b0c5aeba3a8` 已通过 canonical installer 的完整 artifacts/bootstrap 与 Skill 占位符精确替换核验；稳定 launcher 对 workspace `2582910bf0d2` 的 scoped rollout 返回 current=1、upgraded/stopped/pending/error 均为0。最终核验 built=installed=running，`runtimeUpgrade=current`、`upgradePending=false`；本机与认证 admin health、named public health 对应同一 immutable entry 和进程。PID `13876`，startedAt `2026-10-05T00:25:05.058Z`，creationTime `134356335037544263`。

启动前旧 PID `16348` 已正向证明 missing。首次新进程 `18856` 的调用因 `Start-Process -Wait` 让工具 wrapper 等待后台子进程而被取消并退出；该失败调用证据保留。改用仅等待 launcher 的 `WaitForExit` 后再次启动成功。部署保留原 public URL、named tunnelId、endpoint binding ID/thread/boundAt 与 binding 哈希；另一个 workspace 的 runtime 文件身份与字节未变，Feedback/Result Bus in-flight 均为0。用户已确认 Companion Reload，但页面组件当前就绪状态和真实消息是否送达未独立观察。用户完成 Desktop 本机确认后，08:32 核验 Desktop 与 generic Executor availability=true，Executor epoch=3、activity=busy；绑定目标未变，仅 Desktop runtimeFence 按确认流程从预读旧值更新为预读的新精确值。投递权限门禁已恢复，但真实新任务仍未发送验收。

08:32 复核时465项冻结哈希稳定；没有重跑 full/build。安装自带 GC 删除 `70b189e97b32c73c73ad4cccf80f97db024237f6331bcc3d964ba39decda5bb9` 和 `fb6ac93f47884ff7ea85ac5a9299913c8a6c03e05d3844f990c5c7f677b035a3`，共 `145057624` bytes。遗留 runtime `d94af68105aa` 指向缺失 build `9c33929c545edbe2242770baede0cef9f1f189712d9ce0060f307bc88ce0732a` 的 dangling reference 保持原样；部署后只读 GC plan 仅将旧 `d0b085bb1b6445da312068e6014b0f026fc345fde2ae702af8675268062875d5` 列为 72,533,432-byte delete candidate，没有再次 apply。Supervisor task absent、config/runtime null；本轮未做真实 C2C 消息端到端验收，也未 commit/push。

### 2026-10-05 00:06 历史恢复快照

核验时间：2026-10-05 00:06，Asia/Shanghai。用户已自行重启电脑，本轮继续恢复当前 workspace 的 Bridge。下面 21:44 及 command 条目保留历史，不覆盖本节。

- **源码/提交**：HEAD `063caf07962d6dd58b952885702640aa0d6c7d52` 已整合此前 249 个文件；关闭修复仍是未提交改动，没有 push。生产只改 `src/bridge/server.ts`，并补测试、清单 bookkeeping 和文档；重启后未再修改生产代码。
- **修复**：隔离真实 HTTP 测试证明未传完的 headers/body 会使旧 `server.close()` 超过退出等待窗口；已加入 1 秒排空期限和原生连接关闭，并让并发 shutdown 等待同一 Promise。正常宽限期响应、真实 daemon 退出及 runtime pin 保留都有回归。现场旧实例没有阶段日志，不能将此复现写成已证明当时唯一触发原因。
- **验证**：focused 5 files /236 tests、typecheck、canonical build PASS。唯一正式串行全量 160 files /3361 tests PASS，exit0/unhandled0，无 skip/pending；wall1554.95s、runner1550.82s；461 项冻结哈希稳定，新增进程/监听/temp 均0。重启后重新核验冻结哈希与完整安装身份，均未漂移，因此没有重复 full/build/install。实验 candidate 未运行，仍 workers3/deferred。
- **构建/安装/运行一致**：stored==computeBuildId==core-release==installed==running **`d0b085bb1b6445da312068e6014b0f026fc345fde2ae702af8675268062875d5`**。此前 canonical installer full artifact/bootstrap/helper/Browser/supervisor 与 Skill 校验均通过。新 Bridge PID **16348**，startedAt `2026-10-04T15:56:42.137Z`，creationTime `134356030009127412`；Node executable 与该 build 的 immutable release entry 精确匹配。
- **恢复完成**：重启后原 PID12676 已正向证明 missing；通过已安装稳定 launcher 执行当前 workspace `start --tunnel`，随后 scoped rollout 返回 **current1/pending0/error0**，runtimeUpgrade=current、upgradePending=false。本机 HTTP、认证 admin、named public health 均与同一 workspace/PID/startedAt/build 匹配；固定域名与 tunnelId 保留。没有第二次 termination 或再次重启新实例，maintenance/start/rollout 锁均已释放。
- **重启前故障证据**：旧 runtime `fb6ac93f…b035a3` / PID12676 已接受认证关闭且端口已关闭，但没有退出。此前仅一次精确 HANDLE TerminateProcess 被 Windows 接受，同 HANDLE10秒仍未 signaled；之后两组各三次复核均 exitCode=1、WaitForSingleObject=258，CIM仍有线程10280。具体系统 I/O/驱动原因未确定；未用退出码或端口关闭冒充 stopped，用户自行重启后才重新启动。
- **投递恢复**：整机重启曾使旧 Desktop runtimeFence 返回 `DESKTOP_PROCESS_CHANGED`。用户明确要求显示本机确认窗后，通过现役 `desktop disable` → `desktop bind-current` 并由用户亲自确认，保留原 thread/bindingId/boundAt，仅更新新进程 runtimeFence。复核 Desktop 与 Executor available=true，Executor epoch3 不变；activity=busy 对应本轮执行。Desktop/Feedback/Companion/Executor/Web Sink 绑定哈希、其他 workspace runtime 文件身份均与重启前相同，Feedback/Result Bus in-flight=0、unresolvedDelivery=false。这是可用性核验，不是新网页任务的回流或 ACK 验收。
- **Supervisor/GC**：只读 status 为 task absent、config/runtime=null，没有注册或启动 Scheduled Task。此前正常 installer GC 删除0、tombstone0、回收0 bytes；本轮仅只读 GC plan，新 build 因 current/runtime 保留，`70b189e9…a5bb9` 与 `fb6ac93f…b035a3` 成为候选，未 apply。既有 `d94af68105aa` dangling runtime reference 为一项局部问题，globalBlockerCount=0，原文件完整保留。

**下一步**：本次 Bridge 恢复与 Desktop 本机确认已完成。真实新网页任务的可信终态与网页回流验收仍独立待办，本轮没有发送测试任务或补记历史 receipt。独立 supervisor 注册及登录/重启/Codex-close 自动恢复仍需单独授权；本轮手动恢复不代表这些验收已完成。

本轮证据位于 ignored `.tooling/rollout-shutdown-fix/`：既有 `full-result.json`、`build-identity.json`、`installed-verification.json`、`recovery-terminate-result.json`、`exit-observation.json` 保留；新增 `resume-preflight.json`、`resume-start.json`、`resume-rollout.json`、`resume-health.json`、`resume-supervisor.json`、`resume-gc-plan.json`、`resume-final-readonly.json` 记录重启后结果，`resume-confirm-preflight.json`、`resume-desktop-confirm.json`、`resume-after-confirm.json` 记录用户确认及最终身份/健康核验。这些不是 trusted receipt 或网页 ACK。

## 2026-10-04 21:44 历史快照

以下保留 21:44 文档同步时的历史状态；“当前”“下一步”“未部署”“门禁失败”仅适用于当时，以前述最新核验为准。事实来自当前源码、Git、已安装稳定入口的只读 status/supervisor status，以及既有门禁产物；本次仅同步文档，不重新测试、构建、安装或 rollout。

| 事实面 | 当前核对结果 |
| --- | --- |
| Workspace / Git | `codex-with-chatgpt` / `2582910bf0d2`；`main`，HEAD `cedb95c7db4e6b7174ebf1313968d33ca5f74694`。保留大量已有 dirty/untracked 改动；暂存、冲突为空。未提交状态不是未实现的证据 |
| Checkout / 扩展构建 | `70b189e97b32c73c73ad4cccf80f97db024237f6331bcc3d964ba39decda5bb9`；stored、重新计算的 artifact hash、core-release buildId 一致。扩展加载 checkout 的 `dist/browser-companion`，用户已重载 |
| 已安装 / 运行 Core | 两者均 `fb6ac93f47884ff7ea85ac5a9299913c8a6c03e05d3844f990c5c7f677b035a3`；PID 12676，startedAt `2026-10-04T12:23:54.421Z`。稳定入口 status 返回 running=true、runtimeUpgrade=current、upgradePending=false；这里的 current 比较 installed 与 running，不代表等于 checkout |
| 服务与网页 | 本轮本地/认证 admin status 成功；named tunnel 报 running=true、固定 URL 未变，本轮未重新做公网健康验收。当前 Feedback/Companion epoch13，route `6ac252e9-86d0-83ec-b59c-3f0fc8736b79` 已 VERIFIED；Web Sink epoch3 同 route。21:39 用户确认“已连接，自动回流已开启” |
| 执行端 | Desktop 与 generic Executor 同指当前 thread `01a101c3-9904-71f1-8d9d-78550f40fa35`；Desktop enabled=true，Executor epoch3。旧 Executor 指向历史 thread 导致的 inspect_failed 已通过既有本机入口对齐，不以网页已连接替代执行端核验 |
| 历史与本轮任务 | 旧存续债务已按明确授权清理；清零是当时快照。21:44 已有本轮 `sync-current-docs-20261004-01` 的一条 accepted delivery 和 Routing command，Feedback/Bus 队列尚为空。accepted 不等于执行完成，本轮 trusted receipt 与网页收到结果还需正常终态链确认 |
| 独立 supervisor | foundation 已包含在安装 Core；只读 status 为 task absent、config/runtime=null。不是已启用的 OS 守护，也没有完成登录/重启/Codex-close 自动恢复验收 |

### 已完成与待完成

- **已完成**：B0 职责设计；B1 Windows 退出证据修正；B2 查询/连接与维护解耦；B4 canonical Result Bus 主链；B5 任务面板与受控操作源码。面板展示全部存续任务及历史异常，用户已确认列表可见；逐条写操作仍需本机精确 Companion 限时授权。
- **B3 决策已完成**：保留现有领域存储，不引入 SQLite、不提高 Node >=20 下限。数据库迁移不在当前待办中。
- **连接修复已现场核对**：接管、页面验证、凭据轮换、Web Sink 收敛分阶段；新页面 epoch13 已完成。修复了可复现的零写入拒绝响应缺身份字段及诊断丢失；旧失败原始原因无法追溯，不据恢复成功认定当时具体分支。
- **待完成**：新网页任务的可信终态 → canonical result → 网页确认全链路验收；独立 supervisor 注册及真实登录/重启/Codex-close、升级/GC pin、睡眠恢复等剩余运行场景。测试覆盖与个别现场恢复不替代这些验收。

### 测试与部署机制

唯一正式全量门禁是 `pnpm test --maxWorkers=1 --testTimeout=90000`，官方 `test` 仍为 `vitest run`。最近完整串行通过证据为安装基线 `fb6ac93…` 的 **160 files /3336 tests、exit0、unhandled0**（`.tooling/legacy-history-cleanup-dev/full-result.json`，冻结461项）；此后 Companion 改动只跑相关定向验证，不能把旧全量覆盖范围写成当前源码全量 PASS。

当前实验清单是 **160 files /3356 tests**，packaging1/serial6/parallel153、support32；workers3、experimental/deferred，不是正式门禁。最近扩展修正为 **8 files /502 tests PASS**，typecheck/build/三方 ID/diff 通过；此前连接修复的744项与后续111项是各自阶段证据，不相加为一次全量。R5j 不运行 candidate/parallel/worker 实验，不作 acceptance_ready 或 promotion 声明。

源码 build、机器 install、workspace rollout、扩展 Reload 是四个不同动作。日常运行与 record 用安装的稳定 launcher；`scripts/dev-install.ps1` 会构建/安装并 best-effort rollout，canonical 安装器的自动 GC 只按既有受审门禁执行。纯文档同步只做链接/合同/差异与范围校验，不触发这些部署动作。

### 下一阶段

1. 先核验本轮新网页任务的正常回执与回流结果，不伪造 ACK、不补记历史 receipt，也不发送无改动 closeout 来制造回执。
2. 经独立 review 和明确机器持久授权后，执行 supervisor 注册与剩余生命周期现场验收；当前文档同步不提供该授权。
3. 只有新代码变更或新的验收目标需要时再冻结并跑对应门禁；R5j 耗时优化继续置于产品/生命周期工作之后。

机制详见 [核心与插件职责边界](core-plugin-boundaries.md)、[架构](architecture.md) 和 [R5 endpoint 合同](r5-endpoint-architecture.md)。以下 command49 及更早记录为历史；后续部署、清理和连接现场证据见职责边界第12.6–15节。

## command49：repair reclaim 崩溃恢复与最终门禁（2026-10-04，source only）

修复 command48 review 确认的 P2：有效 `.repair.reclaim` 若在 takeover 中崩溃留下，原实现没有 stale-owner 消费路径。现在 sidecar 使用 strict bounded V1 schema，包含 workspace/command/repairId、exact PID/creation/executable owner、nonce、目标 repair fence 的完整文件指纹及 SHA256、createdAt。旧 ad-hoc 或零字节/损坏格式不迁移、不按年龄回收，仍永久 fail closed 待人工审查。

显式行政 confirm 最外层先取得既有 machine maintenance，随后才按 commandId 排序取得 command authority，最后进入既有 abandonment evidence/store lock；拒绝从已继承的 command/workspace cleanup authority 内反向进入。preview 只读识别有效 dead reclaim，不消费它。confirm 在 maintenance 内两次证明 owner exact missing，前后复核 sidecar 内容/身份及目标 fence，再 CAS unlink 该 stale sidecar并以 wx/fsync 创建新 claim。新 claim 在主 fence 发布前被精确消费，maintenance继续保护该窗口，避免留下指向旧 fence 的已过时 claim。发生未知、PID reuse、文件替换或 maintenance ownership 丢失即停止。

maintenance 的原有 strict 语义完全保留：acquire失败不修改 repair；不递归 reclaim maintenance，也不创建 `.reclaim.reclaim`。真实 OS crash 若还遗留 maintenance.lock，本入口继续 BUSY，必须先按该现有 authority 的单独审查流程处理，不能凭 repair owner dead 推导 maintenance 可删除。详细锁顺序及 crash 状态见 [architecture](architecture.md#repair-reclaim-的-stale-owner-恢复command49)。

定向 **18 files/430 tests PASS**（repair68项；含maintenance/rollout/GC/startup、cleanup、abandonment/CLI/interfaces），typecheck与diff-check通过。command48已修正的精确CLI inventory逐字节保留。覆盖清单仅同步158 files/3223 tests、packaging1/serial6/parallel151、support32；official test仍`vitest run`，candidate workers3/experimental/deferred，未运行R5j实验。

冻结后唯一正式 `pnpm test --maxWorkers=1 --testTimeout=90000` **158 files/3223 tests全部PASS，exit0，unhandled0，无skipped/pending/retry**。wall **1711.52s** / runner **1706.84s**；repair68/68、Desktop interfaces18/18、core-install32/32、supervisor-store23/23均通过，supervisor-store最长37.858s，无onTaskUpdate。445 source/test/support hashes前后稳定；新增test-tmp、归属/歧义进程、listener均0，全局新增5进程通过原有exact ancestry证明无关。全量后没有源码/测试改动，也没有第二次full。

full PASS后只执行一次显式canonical `pnpm run build`，stored build-id == computeBuildId == core-release.buildId == **`b6a25e1c2b7912fb32f3abfa60556ec67d19ef3d361a1213e8eb5f58fd6303f7`**；构建后445 hash仍稳定。本轮没有真实command10 preview/repair、五条历史abandonment、install/rollout/Bridge recovery、live GC、Scheduled Task、绑定变更或commit/push。原有dirty work保留。

原始证据位于ignored `.tooling/command49/`：`focused.log`、`typecheck.log`、`full.log`、`full-result.json`、`frozen.json`、`build.log`、`build-identity.json`、`scope-audit.json`。下一步由Planner独立复核stale reclaim恢复与本轮source gate；真实破坏性修复仍需新的明确用户授权，源码PASS不等于机器历史已收敛或已部署。最后仅请求exact command49正常same-origin标准record，trusted终态按原有流程核验；不补记旧receipt或手写Result Bus。

## command48：显式历史损坏锁收敛协议（2026-10-04，source only）

新增独立 `desktop abandon-corrupt-lock` preview/双 digest confirm。只接受精确选择的 historical accepted、旧 thread 连续 `DESKTOP_NO_OWNER`、当前 binding/maintenance context 精确且可用、无可信 receipt/未决结果/既有处置，以及 canonical regular、nlink=1、两次身份/hash 不变的**零字节** lifecycle lock。普通 `withCommandOperation[Async]` 仍拒绝所有损坏锁；新 repair sidecar 及未完成 repair journal 同样阻止普通写入。没有按 command10 路径或空文件 SHA 特判。

按 commandId 排序取得普通/repair authority，之后才进入原 abandonment evidence lock；不增加 workspace lock 或倒置现有顺序。repair 以 exact PID/creation/executable owner 和私有事务 capability 围栏隔离原文件，保留 quarantine 原 bytes/dev/ino，记录 `prepared → adopted_pending → completed`，在同一事务持新 lifecycle lock 完成原有整批 revalidation/write。失败保留证据及围栏；只允许 owner 被精确证明 missing、全部身份一致的显式重放。非空损坏锁、PID reuse/unknown、替换证据或 interrupted temp 均停止，不自动删除。详见 [架构中的 crash 状态表](architecture.md#历史零字节-lock-的显式行政收敛command48)。

本轮仅 source/tests/docs。**未对真实 command10 执行新 preview/confirm，未修复任何机器锁，也未执行此前五条 abandonment**；没有 Bridge 恢复/部署、Scheduled Task 或 endpoint 操作。真实修复必须先经 Planner 独立 review，再获得新的明确破坏性操作授权；此前五条 abandonment 授权不自动扩大为损坏锁 repair。R5j 继续 deferred，清单变更仅覆盖计数/hash bookkeeping。

定向验证最终覆盖15 files/412 tests，均在相应定向运行通过；新协议45项保留真实 Windows ACL、七个 crash checkpoints、双 repair 部分恢复及提交前替换证据检查。开发中发现并修正了 strict journal→intent 投影，以及重复设置目录 DACL 导致已有 journal ctime 变化的问题；只在 ACL 尚不匹配时设置，未放宽身份校验。typecheck 与 diff-check 通过。覆盖清单仅更新到158 files/3200 tests、packaging1/serial6/parallel151、support32；official test 仍 `vitest run`，candidate workers3/experimental/deferred，没有 candidate/parallel 实验。

唯一正式 `pnpm test --maxWorkers=1 --testTimeout=90000` 为 **158 files / 3200 tests：157 files、3199 tests PASS，1 file/1 test FAIL，exit1**；wall **1418.90s** / runner **1414.87s**，unhandled errors0，无 skipped/pending/retry。新 repair45/45、普通 abandonment27/27、core-install32/32均通过；supervisor-store23/23、最长32.015s，无 onTaskUpdate。445个冻结 source/test/support hash在全量前后稳定；新增 test-tmp、归属/歧义进程及 listener均0；全局新增5个进程经原有精确 ancestry 审计证明无关。

唯一失败是 `tests/desktop-interfaces.test.ts:561` 的精确 CLI 名单遗漏新增 `abandon-corrupt-lock`，属于本轮应同步却漏改的接口断言。之后只补入该名称并刷新对应 manifest hash，保持精确 equality；接口18、CLI16、manifest guards17，合计 **3 files/51 tests PASS**。生产源码自 full 起完全未变；post-full仅上述test/manifest两个冻结文件变化，原full冻结证据未覆盖。按 command48 “exactly ONE”约束没有第二次full，**正式门禁仍FAIL，未运行额外的 post-PASS canonical build，不宣称 source acceptance/deployment ready**。

证据位于 ignored `.tooling/command48/`：`focused.log`（开发中多目标ACL失败）、`repair-final.log`、`interface-correction.log`、`full.log`、`full-result.json`、`frozen.json`、`final-hashes.json`、`post-full-correction-audit.json`。本轮 exact command48 以正常 same-origin failed record 收尾；pending draft不等于trusted receipt。下一步由Planner复核实现及名单修正，另轮授权最终门禁；真实损坏锁修复仍需新的明确破坏性授权。command47 历史结果保留如下，不据源码实现宣称机器阻塞已经解除。

## command47：精确历史批次 preview 通过，confirm 被受保护锁阻塞（2026-10-04）

用户仅授权下面五条、旧 thread `01a0f4a1-9ca9-7083-b0e8-273056aeb3c6` 的批量行政 abandonment，并要求保留 command10 零字节锁。使用当前生产 stable launcher 的正常 `desktop abandon` preview/confirm；没有缩小批次、替换命令或改用底层写入。

| 精确 commandId | confirm 后状态 |
| --- | --- |
| `r5g-desktop-reconciliation-history-compat-20261001-05` | unresolved；未 abandoned |
| `r5h-ephemeral-command-lifecycle-20261002-10` | unresolved；未 abandoned |
| `r5i-plan-and-lifecycle-gap-audit-20261002-15` | unresolved；未 abandoned |
| `r5j-b1-isolation-grouped-runner-20261002-24` | unresolved；未 abandoned |
| `r5j-return-path-lock-auth-race-recovery-20261002-26` | unresolved；未 abandoned |

全部仍是 exact old-thread accepted，实时 IPC 返回 `DESKTOP_NO_OWNER`。当前 binding `3e866dc6-8c9c-41a8-9afe-861e6dacf899` / thread `01a101c3-9904-71f1-8d9d-78550f40fa35` 可用、unresolvedDelivery=false，未进入批次。生产 preview exit0，精确五条无增减，confirmationSha256=`c376466821fbdb96be1638d2ff7badba983aefaf9ba6322d8ff7b411a47821a0`。随后只提交一次 confirm，exit1，响应 `DESKTOP_ABANDONMENT_FAILED`；没有任何一条成功写入，不能表述为已行政关闭或执行成功。

**阻塞诊断**：已安装的 abandonment、cleanup fence 和 CLI 模块字节均与 reviewed checkout dist 一致。confirm 按排序嵌套获取五个 command lifecycle 锁，然后才进入 batch 写入；第二个是 `command-cleanup/2582910bf0d2/r5h-ephemeral-command-lifecycle-20261002-10.json.lock`。该锁仍为0字节（SHA256 `e3b0c442…b855`），JSON 无法解析，既有 `acquireLock/readLock` 路径抛 `COMMAND_CLEANUP_BUSY`；CLI 将此非 DesktopError 映射为上述 generic failure。这是由已安装代码路径和现场不可解析锁定位的原因，CLI 本身未返回底层 code。没有删除、抢占、修复该锁，没有拆成四条绕过。

confirm 前后完整 Desktop 文件字节/文件身份、所有 delivery 摘要、execution records/output metadata、既有 abandonment、四类 binding、无关 runtime、command10 锁及 dangling authority 均一致。五条仍不在 rollout 的 skipHistory，A 阶段未完成；**没有进入 B/C 条件恢复，也没有 kill/start/restart、install、GC apply、rollout 或 Scheduled Task 操作**。command47 未重新测 Bridge 健康，不把 command46 的超时当成本轮实时结果。08:14（Asia/Shanghai）只读 current/runtime 文件仍指向 `8e155373…e2eebce`、PID16188、creation134355028686992076；supervisor 状态目录仍不存在。

442个 reviewed source/test/support hash 稳定；checkout stored/compute/core build 仍一致为 `2714cdd9a48d21881d73800720b66403f829275a5de42006ffaf6001e7d6a0c1`，未重跑 test/typecheck/build。仅本节、architecture 与 R5 lifecycle 文档更新，保留其他 dirty work，运行 diff 检查。原始证据在 ignored `.tooling/command47/`：`preview.json`、`confirm-result.json`、`before.json`、`after-confirm.json`、`diagnostic.json`。

**NEXT**：Planner 处理“生产 confirm 必须取得 command10 锁”与“该损坏锁必须完整保留”的约束冲突；现有协议内不能完成精确五条收敛。本轮不改生产协议、不删除受保护状态、不伪造 receipt/result/output；按 exact command47 标准 same-origin blocked record 收尾。待安全方案另行审阅后再推进历史收敛、条件恢复和部署；机器持久 supervisor 注册/reboot/logon/Codex-close acceptance 仍待独立授权，R5j deferred。

## command46：部署前门禁阻塞，未安装或 rollout（2026-10-04）

Planner 已独立接受 command45 的正式157 files /3150 tests、exit0/unhandled0与 build。此次只读复核确认 workspace `2582910bf0d2`，无 staged/conflicted 文件，442个 source/test/support 冻结哈希未变；stored build-id == computeBuildId == core-release.buildId == `2714cdd9a48d21881d73800720b66403f829275a5de42006ffaf6001e7d6a0c1`。没有重复 test/typecheck/build，也没有补记 command45 缺失回执。

**部署未开始**：2026-10-04 07:56（Asia/Shanghai）机器 current 与 runtime 仍为 `8e1553735dc817e60d758d8ffb156c41a2758d70562995470f09e1803e2eebce`；PID **16188**、creation **134355028686992076**、startedAt `2026-10-03T12:07:50.008Z`，exact process identified、spawn provenance matching，entry 仍在该 immutable release。初次 preflight 的本地/admin/named 身份探测通过，但 idle 检查为 `desktop_unknown`：当前 binding 可用，旧 thread `01a0f4a1-9ca9-7083-b0e8-273056aeb3c6` 无 owner，仍有五条 unresolved 历史命令（r5g command05、r5h command10、r5i command15、r5j command24/26）。另一个退休旧 thread 的 ownerless 证据被既有规则接受，不是新增阻塞。没有执行 Retire/Abandon 或改动历史证据。

随后两次 preflight 的 loopback 请求超时；分项诊断中 `probeBridge` 约8014ms后返回 null，authenticated `/admin/info` 约8013ms后报 `Loopback HTTP response timeout`，named health 经原有三次有界探测仍为 timeout。PID/creation 仍精确存在，因此是健康/应用状态未知，不能判定 stopped，也不能强杀或绕过门禁。停止在 install/GC/rollout 之前，未触发任何生产 supervisor。

Reviewed checkout 的只读 supervisor inspection 为 **task absent、config/runtime null、bridge-supervisor 目录不存在**；`registration.registrationMode` 表示可用任务机制，不代表已注册，实际以 status=absent 为准。只读 GC plan 为 global blocker0、local issue1（原有 `runtime:d94af68105aa` dangling exact reference），唯一 delete-candidate 是历史 `8256ad7b…016765`，未执行 GC。四类 binding 哈希、无关 runtime、command10 锁与 dangling authority 的字节/文件身份已取证；本轮没有改写这些状态。证据见 ignored `.tooling/command46/` 的 `build-identity.json`、`read-only-plan.json`、`idle-diagnostic.json`、`blocked-predeploy.json` 与 preflight 日志。

**NEXT**：Planner 复核两个现场阻塞并单独确定恢复/历史收敛方案，再恢复 exact reviewed build 的安装和 scoped rollout；不放宽 owner 或健康门禁。本轮仅更新三份文档并运行 diff 检查，终态按 exact command46 正常 same-origin blocked record 收尾。真实 Scheduled Task 注册/启动/删除、reboot/logon、Codex-close 恢复验收仍未进行，R5j 继续 deferred。

## command45：supervisor 测试任务拆分与最终门禁（2026-10-04）

Planner 已通过 command44 生产实现 review。command44 全部3142断言通过但 onTaskUpdate RPC error 导致 exit1 的证据继续保留；其 supervisor-store 文件499.388s，单项61.474s、68.140s、64.166s超过60s RPC窗口，是可避免的长同步任务触发条件，不能据此断言 Vitest 存在已证实缺陷。

将 supervisor-store 的15项复合测试拆为23项独立 workspace fixture：missing/修订写入/身份不符、launch validation/持久 handoff/self-retire、两种 pin replacement、handoff 后 crash 状态/精确 stale reclaim，以及 dead/unknown/replaced operation owner 分别验证。原77条断言全部保留，现83条；真实 ACL、store、文件和进程身份路径保留，各类关键调用次数未减少。launch-only fixture 通过真实 operation lock 初始化私有 store，config 写入保留在独立配置/校验/退役 fixture 中；未提高任何 timeout，也未引入 retries/repeats。初次拆分23/23测试通过，但 replacement 单项57.27s未达到55s要求；保留 store-initial 证据，继续拆分 fixture 后重新定向验证。

最终 standalone **23/23 PASS**，wall 609.45s / runner 606.60s，最长单项 **53.29s <55s**；其余 supervisor/lifecycle、CLI、launcher、Windows Task、release-reference 及 manifest guards **6 files / 80 tests PASS**，合计 focused **7 files / 103 tests PASS**；typecheck、git diff --check 通过。

唯一正式 `pnpm test --maxWorkers=1 --testTimeout=90000` 为 **157 files / 3150 tests PASS，exit0，unhandled errors 0**；wall **1561.23s** / runner **1556.18s**，full 内 supervisor-store 最长单项 **54.26s**。无 skipped/pending/retry，442 个 source/test/support 冻结哈希稳定；command44 生产代码与未改 core-install 测试哈希保持一致；core-install 本轮32/32通过，原EPERM未复现。新增 test-tmp 目录、归属/歧义进程及 listener 均0（全局新增进程也为0）。

full PASS 后仅执行一次显式 canonical build，stored build-id == computeBuildId == core-release.buildId == `2714cdd9a48d21881d73800720b66403f829275a5de42006ffaf6001e7d6a0c1`。

本轮仅拆分测试及更新计数/hash bookkeeping 和文档，**supervisor 生产语义未变**。官方 test 仍 `vitest run`，candidate 仅同步157/3150、packaging1/serial6/parallel150、support32，workers3、experimental/deferred；未运行 candidate/parallel/worker 实验。

原始证据位于 ignored `.tooling/command45/`：`store-initial.*`、`store-standalone.*`、`focused-audit.json`、`assertion-audit.json`、`scope-audit.json`、`full.log`、`full-result.json`、`frozen.json`、`build-identity.json`。

**终态回执缺失**：标准 same-origin record 实际返回 `DESKTOP_RESULT_NOT_APPLICABLE`（desktop_discovery，exit1），未写入 record/draft/output。只读 canonical turn 核对发现原 command45 turn 已 failed；随后用户“继续”创建了新的普通 turn，binding 未变，但新 turn 不能代记旧 accepted delivery。测试进程被保留并在继续 turn 完成；上述 source gate PASS 与缺失的 receipt 分别报告。不重试绕过、不使用 `--task`、不伪造回执或手写 Result Bus；诊断见 `receipt-diagnostic.json`。后续由 Planner 只读复核实际文件/输出后决定产品下一步，不为制造旧回执发送无改动 closeout。

下一步由 Planner 独立复核测试结构与门禁证据，再另轮授权安装/真实 Scheduled Task 注册及 reboot/logon、Codex close、Core upgrade/GC 旧 release pin 与恢复边界验收。本轮没有真实 task 注册/删除、install/rollout、生产 Bridge restart/stop、live GC、endpoint switch/rebind、Retire/Abandon 或 commit/push。

## command44：supervisor 生命周期复核修复（2026-10-04，source only）

> 保留 command44 当时的实现与失败证据；生产语义仍适用，最新测试门禁与 NEXT 以 command45 为准。

当前优先级仍为 R5i 产品/lifecycle；R5j experimental/deferred，未恢复 candidate、worker 或热点优化。

- **启动 pin 交接**：stable launcher 在 maintenance 内写入 exact launch pin，再启动 immutable release，并传递关闭文件后的有界 file identity/SHA256（不含 argv/credential）。release 对照 launcher 原始 proof 固定 pin，先取得并持久化 exact runtime lease，验证 PID/creation、build、nonce、完整内容及文件身份后才消费已验证的 launch capability。运行期只需 runtime pin；正常退出释放 runtime，不再要求 launch pin 存在。交接前失败保留 launch pin，替换或损坏保持 fail closed；成功交接后的 crash/reboot 不留下永久 launch pin，旧 runtime/lock 仍仅由 exact process-missing proof 回收。
- **真实注册状态**：install 在同一 operation fence 内先写 `stopped/none`（保留 tunnel），注册并 fresh inspect exact-owned task 后才写 `running/windows-scheduled-task`。失败保持暂停；status 分别只读报告 config.registrationMode 和 task inspection。
- **卸载自退**：先持久化 stopped，只删除 exact-owned task；成功移除或确认 absent 后写 stopped/none。loop 看到非 windows-scheduled-task 即正常退出并释放 lease/runtime；不 shutdown 或 restart Bridge。remove 冲突/失败保留 stopped/windows-scheduled-task；最终写 none 失败报告错误，之后显式 uninstall 可按 absent 重新收敛，status 不修复。
- **legacy 无配置路径**：首次 install 与显式 start/stop/restart 共用既有 machine maintenance fence；start/restart 把已有 handle 传给原启动 authority，避免重入。围栏内检测没有本 workspace supervisor evidence 时直接执行旧动作，不创建 supervisor config/runtime/task，不调用 supervisor ACL/process probe/ScheduledTasks。存在配置、orphan 或损坏证据则走严格 operation fence。并发竞争返回 busy，不宣称 stop 完成，不允许首次 running 发布穿过正在执行的 stop。

Task 定义保持 exact current-user SID、AtLogOn、InteractiveToken/Limited、stable launcher、IgnoreNew、PT0S、3×PT1M。GC 同时识别启动 pin 与 runtime 引用；交接后 live old-build runtime 单独保护正在执行的 release，未知/损坏引用继续阻止回收。运行中的 supervisor 不 hot-update，需退出后下一次实际 launch/logon 使用 current release。

最终 focused **14 files / 379 tests PASS**，无 skipped；typecheck、git diff --check 与本轮19文件逐项差异检查通过。初轮新增 reboot fixture 累计真实 ACL 操作超过90s；移除无关 config transaction 和已有用例覆盖的重复 unknown-owner 尝试，保留真实 store/ACL 和精确 missing identity 断言，复测66.48s通过，未调 timeout 或 retry。

442个 source/test/support 文件冻结后，唯一正式 `pnpm test --maxWorkers=1 --testTimeout=90000` 枚举 **157 files / 3142 tests 全部 passed，但有1个 unhandled error，exit1，正式门禁 FAIL**。wall **1604.38s**、Vitest **1599.06s**。精确错误为 `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`；本地 Vitest 3.2.7 的 worker→main RPC 默认超时为60000ms，与本轮90000ms用例 timeout 不同。日志没有该错误对应的 task/file/触发时间，无法证明 supervisor 生产缺陷；长同步工作可能影响事件循环，但目前不是已确认因果。未改 Vitest/runner/timeouts、未第二次 full，未以3142项 passed 抹去 exit1。

未改的 `tests/core-install.test.ts` 本轮 **32/32 PASS，16.42s**，原 rename EPERM 未复现；其文件 SHA256 与 command44 开始时一致。所有78项 supervisor/GC 回归在正式 full 中 passed。442 hash 前后不变；新增 test-tmp 目录0、归属/歧义进程0、listener0；全局新增5个进程均由既有精确 ancestry 审计证明无关。没有事后清理以制造通过。

packaging 内两次 canonical build 通过；结束后仅只读核验 stored/computeBuildId/core-release.buildId 均为 `2714cdd9a48d21881d73800720b66403f829275a5de42006ffaf6001e7d6a0c1`。正式 full 未PASS，因此未执行额外 post-PASS build。实验覆盖守卫仅同步到157/3142、packaging1/serial6/parallel150、support32；官方 candidate 仍workers3、experimental/deferred，未跑实验、未改官方test/CI门禁。

原始/审计证据在 ignored `.tooling/command44/`：`full.log`、`full-result.json`、`full-audit.json`、`focused-audit.json`、`build-identity.json`、`frozen.json`。当前仍不能宣称 source acceptance/deployment ready；下一步由 Planner 独立复核四项修复及未归属 RPC 错误，再决定另轮验证。本轮最后只走 exact command44 标准 same-origin failed record，trusted 终态与 Browser ACK 以原有流程核验为准。

**剩余验收**：Planner 独立 review → 定位 RPC 错误并在另轮授权下通过正式门禁 → 安装/真实 Scheduled Task 注册 → reboot/logon、Codex close、Core upgrade/旧 release pin 与恢复边界验收。本轮不注册/删除真实任务，不 install/rollout/生产 restart/live GC/endpoint switch/rebind/Retire/Abandon/commit/push。

## command43：R5i-b/c 独立 Windows supervisor foundation（2026-10-03）

> 本节保留 command43 当时实现与失败证据；launch pin、注册/卸载与无配置兼容性已由 command44 修订，当前状态以上节为准。

**当前优先级已调整：暂停 R5j 测试耗时优化；R5j 继续保持 experimental，并推迟到产品/lifecycle 工作收尾之后最后处理。** command42及更早的 R5j NEXT、实验结论和历史证据仍保留，但不再代表当前下一步。

command43 在源码中建立 per-workspace Windows user-session supervisor foundation。严格 desired-state config 是自动恢复的唯一产品授权：`running` 只允许恢复已被观察证明为 `stopped` 的 Bridge；`stopped` 不自动启动或终止进程。supervisor 每周期在 workspace operation lock 下重新读取 config，并在同一操作围栏内完成 observation/recovery，避免 install、pause、stop 与恢复竞态；长生命周期另持有包含精确 PID/creation identity 的 lease。live、unknown、replaced 或损坏 owner 均视为 busy；只有精确证明 owner 已退出并复核文件身份后才可回收。

配置严格绑定 canonical `workspaceId`/`workspaceRoot`，schema 包括版本、desired state、tunnel、registration mode、递增 revision 与时间戳；读写拒绝符号链接、共享 hardlink、坏 schema 或未完成的临时文件，不保存 secret。写入通过 owner-only 权限、fsync 与原子 rename 完成。

健康状态只观察；`unknown`、probe/application timeout、maintenance/start-lock busy 不启动第二个 Bridge，也不 kill 现有进程。只有确定停止才调用现有 `ensureBridgeAndTunnel` 启动 authority，继续受 startup lease、maintenance/start lock 和 provenance 约束。`tunnel=true` 要求同 workspace 已配置且 ready 的 named tunnel，恢复后还核对原 public identity；不降级到 quick tunnel。endpoint、Desktop、Feedback、Web Sink、Executor binding 和投递记录不由 supervisor 改写。

显式 `start`/`restart` 在既有 supervisor config 时先持久化 `desiredState=running`，再调用现有启动流程；显式 `stop` 先持久化 `stopped`，再做认证 shutdown；更新失败即不执行后续动作。rollout 不改 desired state。`supervisor install` 在 operation lock 中先暂停配置、注册精确的 AtLogOn task，成功后写为 `running`；它不立即启动 task 或 Bridge，只在后续用户登录时由 Task Scheduler 启动。`pause` 只暂停恢复，`uninstall` 先暂停并只移除 exact-owned task；二者都不停止正在运行的 Bridge。

stable machine launcher 在 maintenance fence 内读取 current 并写入 workspace/build/nonce 精确的 launch pin，释放 fence 后才载入该 immutable release；supervisor 随后校验 pin 并持有 runtime pin。launcher 只有确认 child 已退出且 launch pin 身份复核通过才会删除该 pin；spawn/child 结果不确定时保留 orphan launch pin。GC 已把 launch/runtime pin 纳入 release reference graph：准确 pin（包括保守保留的 orphan launch pin）保护其 build，损坏、身份不符或无法识别的 supervisor 条目 fail closed，避免回收可能仍在执行的旧 release。当前进程不 hot-update；core upgrade 或新登录都不会替换仍存活的 supervisor，它继续执行启动时的旧 immutable release。只有旧进程退出后下一次实际 Task 启动，stable launcher 才会选择届时的 current release；`IgnoreNew` 防止旧进程存活时并行启动第二个实例。当前 slice 没有即时 supervisor restart/handoff。

当前 Windows host 的**代表性只读 capability audit**确认 ScheduledTasks module 1.0 与所需 cmdlets 可用，当前用户 SID 可读取；`AtLogOn`、该 SID 的 `InteractiveToken`/`Limited` principal、`StartWhenAvailable`、`IgnoreNew`、无执行时限及 bounded restart（3 次、每次间隔 1 分钟）可表达，内存中的 principal 归一化也已核验。此审计没有创建、注册、启动或删除真实任务。实现仅使用 exact current-user task 与 stable launcher，不存密码或 token，也不回退到 service 或 Run key；foreign/drifted task 会报告 conflict，不覆盖；卸载前重新核验 exact ownership。

**部署仍待完成**：先由 Planner 独立 review，再另行执行真实 task 注册，以及机器重启/登录、Codex 关闭后恢复、Core update/旧 release pin 和现场安全边界验证。当前没有 live task registration、Bridge install/rollout/restart 或 endpoint/binding 变更。focused GC 回归新增的 4 项及既有 85 项已通过；stop race 已修复，desired-state 读取现位于 operation lock 内。

唯一正式串行 full（`pnpm test --maxWorkers=1 --testTimeout=90000`）完成 **157 files / 3126 tests：156 files、3125 tests PASS，1 file/1 test FAIL，exit1**；wall1311.34s、Vitest1306.27s。失败为 `tests/core-install.test.ts:347` 的旧 v1 pointer fixture 在 `fs.renameSync(checkout, moved)` 返回 Windows EPERM；尚未到其后的 launcher assertion，具体占用方/系统原因未取证。未改该测试或相关生产代码，随后仅一次 standalone core-install 32/32 PASS（Vitest15.71s），此诊断不能覆盖失败 full，未第二次 full、未加 retry 或放宽 timeout。**当前门禁仍 FAIL，不能据此宣称 source acceptance/deployment ready；下一步由 Planner 独立复核失败及源码，再决定另轮最终门禁。**

此前相关 focused 共339项通过，覆盖 supervisor/store/CLI/task/launcher、runtime/daemon/startup-lease、GC/rollout 与覆盖守卫；新 supervisor/GC 62项在 full 中全部通过。开发中修复了 Windows atomic rename 的 ctime 误判和重复 ACL 校验导致的 CLI restart 25s预算超时，复测真实 restart17.03s，原 timeout不变；typecheck与最终diff-check通过。442个source/test/support hash在full及诊断后不变，157文件完整枚举，无skip/pending/retry；新增test-tmp目录、global-new/归属/歧义进程和listeners均0。full中的packaging测试通过并运行了两次 `pnpm run build`；stored/computeBuildId/core-release.buildId均为 `61480f6d81640a12f45785e041a1937f616480a7f546e64b9ee842026e8d7e31`。因为正式full未PASS，未执行额外的post-PASS build。

证据保存在ignored `.tooling/command43/`（full.log、full-audit.json、core-install-diagnostic.log、build-identity.json、frozen.json）。覆盖清单仅为新增测试同步到157/3126、packaging1/serial6/parallel150、support32；官方candidate仍workers3、experimental/deferred，acceptance_ready=false、authoritative=false，没有运行R5j candidate或worker实验。早期失败/中断的隔离fixture移至command43目录留证；未删除历史输出或事后清理full残留来制造通过。生产Bridge仍待部署，未注册/删除真实Scheduled Task、未install/rollout/生产restart/endpoint switch/rebind/Retire/Abandon/commit/push。最后使用正常same-origin command43 failed record；trusted终态和Browser ACK由原有流程确认。

## command42：update-check seed有收益，worker4仍未达门槛（2026-10-03）

> 以下 command42 的 NEXT 仅记录当时安排，现已由 command43 的产品/lifecycle 优先级覆盖。

**当前决定：worker4_not_accepted；官方candidate保持parallel workers3，acceptance_ready=false、authoritative=false。NEXT：Planner独立复核fixture与本轮证据，继续聚焦fork-scripts真实进程成本/机器竞争。** command40/41性能失败与3054历史证据边界保留。

update-check改为suite immutable seed pair与每例独立fs.cpSync，相对origin/missing upstream限定case内；全树含.git hash、无链接/nlink=1/无alternates检查与strict teardown保持。七个scenario和断言逐字节等价，真实场景Git调用172次同序；初始化49→10次。前后各一次standalone 7/7 PASS，wall41.6751→35.2293s、suite38.8274→32.1998s，分别省6.4458/6.6276s；bootstrap Trace2窗口9.0574→2.1358s。收益低于8s，未增加推测性复杂度；基于15.47%实测收益与39次bootstrap进程减少，focused通过后做唯一worker4实验。

candidate guards17/17、typecheck/diff通过。manifest仅刷新update-check hash，support32项不变；command41进程归属修复及其测试逐字节保持，production src未改。430hash冻结后唯一worker4 full 151唯一文件/3064测试全passed，无skip/pending/retry/repeat/flaky；phases32.66/61.53/399.00s，1/1、6/69、144/2994顺序无重叠。wall505.25/runner505.11s超过480s 25.25/25.11s，candidate功能安全exit0、验收wrapper exit1。update-check83.07s较command41省7.23s，但fork241.97s增19.60s；wall反增7.03s，一次观察不能证明负载因果或稳定性。

stored/compute/core-release均7550f6aa658123f608ca41dd7e9c51db1c2819c7e19c65f749a54604e6ac5734；dist及430hash不变，归属/歧义/全局新增进程、listeners、temp残留均0。CPU i3-8100为4核/4逻辑处理器。详细七用例、八热点及计数口径见[r5j profile](r5j-regression-profile.md#command42update-check-seed节省645sworker4仍超时2026-10-03)，原始证据`.tooling/command42/`。未第二次实验/三连跑/正式serial full，官方test/CI/default gate不变，无部署/GC/endpoint/rebind/Git提交操作；最后正常same-origin command42 record，trusted终态/Browser ACK由既有流程核验。

## command41：进程归属修复通过，worker4单次未达门槛（2026-10-03）

**当前决定：worker4_not_accepted；官方candidate继续workers3，acceptance_ready=false、authoritative=false。NEXT：Planner独立复核，聚焦fork-scripts/update-check热点。** command40的性能失败保留，3054历史三连跑不用于当前晋升。

runner审计从整机新增进程改为精确runner PID/Created父链归属；命中其他精确pre-run身份才排除，缺失/消失父链、重复/漂移、循环或PID复用歧义仍失败，七位创建时间保留100ns精度，无名称allowlist或命令行/env采集。对应既有测试项扩充确定性场景，focused17/17、typecheck、diff-check通过；只刷新runner/test两项manifest hash，151/3064及1/6/144分组保持。430冻结hash前后不变，production src/Browser未改。

唯一worker4实验功能与安全通过：151唯一文件/3064测试全passed，candidate exit0，无skip/pending/retry/repeat/flaky；phase顺序无重叠，覆盖1/1、6/69、144/2994。**wall498.22s、runner497.87s，仍超480s 18.22/17.87s**，实验验收wrapper exit1；packaging/serial/parallel=33.86/63.27/387.51s。相对command40 parallel462.94s减少75.43s（16.29%），但单次未控制机器负载，不能作为worker数收益或稳定性证明。fork-scripts222.37s/update-check90.29s反而增加，是下一诊断重点；完整八热点及子用例见[r5j profile](r5j-regression-profile.md#command41保守进程归属修复worker4单次超时官方仍workers32026-10-03)。CPU为i3-8100，4核/4逻辑处理器。

三方build仍`7550f6aa658123f608ca41dd7e9c51db1c2819c7e19c65f749a54604e6ac5734`，dist字节/目录不变；global-new/attributed/ambiguous/unrelated进程、listener、新test-tmp目录均0。证据在`.tooling/command41/`；没有第二次实验、三连跑、正式serial full、packaging外build或部署/清理/绑定/Git写操作。官方test/CI/default gate不变；本轮最后正常same-origin record，不预称终态trusted/Browser ACK。

## command40：当前3064候选首轮未合格，停止三连跑（2026-10-03）

**当前experimental candidate=`experimental_blocked`，acceptance_ready=false，authoritative=false；NEXT_EXPECTED_STEP：Planner独立复核失败证据，再决定后续任务。** command39的3054历史三连跑不适用于当前3064基线；本轮合格0/3，未启动run2/3，未修复/重试/重分类。

workspace2582910bf0d2及新Desktop binding `3e866dc6-8c9c-41a8-9afe-861e6dacf899`已核对；无staged/conflict，既有dirty保留。430冻结source/test/support hashes与当前正式串行3064基线完全一致，run1前后无漂移；manifest151文件、expectedTests3064、32 support hashes及packaging1/serial6/parallel144精确。唯一共享dist writer和六个serial fences未变。

run1实际151个唯一文件/3064测试全部passed，phase exit均0：packaging1/1/worker1、serial6/69/worker1、parallel144/2994/worker3；严格顺序不重叠，无skip/pending/retry/repeat/flaky。**candidate总exit1；wall571.66s、runner570.65s，分别超480s门槛91.66/90.65s；packaging/serial/parallel=32.34/62.28/462.94s。** 仅一轮，不计算三轮统计。八个指定热点及原始精度见[r5j profile](r5j-regression-profile.md#command40当前3064基线首轮未合格streak停止2026-10-03)。

三方build ID均为`7550f6aa658123f608ca41dd7e9c51db1c2819c7e19c65f749a54604e6ac5734`；dist字节/目录、430hash和support保持不变，新增test-tmp目录0、listener0。机器审计发现5个新node/cmd存活进程，触发candidate失败；只读归属显示为既有Codex app-server的CUA/MCP子树，未见测试runner/fixture引用，但保留原始exit1且耗时独立超限，不清理制造通过。

证据保留`.tooling/command40/`及其run1.json精确引用的runner目录。官方`test`仍`vitest run`，唯一正式full仍串行门禁，CI/default gate未改；当前3064正式串行PASS沿用既有证据，本轮未重跑。本轮仅结束后更新三份docs及diff-check，无源码/测试/support修改或其他部署/绑定/清理/Git操作。最后使用当前same-origin正常record；投递outcome_unknown由标准record既有严格自核验处理，不使用task fallback或人工Bus操作，不预称终态trusted/Browser ACK。

## 2026-10-03：原配对认证复核与 Bridge 恢复（普通用户请求）

实查 Bridge 原 PID16844 已不存在，local/admin 请求失败；原 Companion fbf58987-6868-40d2-8189-00fbeb4967f9 未 superseded、route attestation verified，Feedback binding/epoch 仍6135d264…/11。通过 current installed stable launcher 为2582910bf0d2执行 start --tunnel，复用原 named URL；新PID16188/creation134355028686992076/startedAt2026-10-03T12:07:50.008Z，运行8e155373…e2eebce，local/admin/named exact通过，四份Desktop/Feedback/Web Sink/Executor store启动前后逐字节不变。系统只读查询确认LastBootUpTime=2026-10-03T09:44:22.3476590Z（北京时间17:44），晚于旧Bridge启动；原进程随机器重启消失，之后未自动拉起。旧runtime没有matching graceful intent；未发现相关Application1000/1001崩溃事件。不能把该观察归因为Codex updater；机器启动后的独立恢复仍缺失，R5i supervisor/lifetime尚未完成。

已证明恢复缺口：旧版 authStale 一旦durable写入，requireProtectedTransport阻断GET /state，watchdog也被停用，失去用同一凭据复核的路径；旧版未记录触发原因，本次最初401/identity异常的来源未知。修复仅放行相同protected credential的只读/state复核，身份/route响应严格校验；exact成功持久化后才能清authStale。超时、5xx、401、身份漂移/坏响应、持久化失败均不授权Send；坏200响应不再被当成凭据已撤销的证据。请求身份与认证失败revision隔离迟到响应，bounded authStaleReason不含原响应文本。已有一分钟discovery alarm可复核旧标记，不拥有owner或Send能力，不re-pair/rebind/clear target；mutation gate、journal和route fence保留。popup允许GET /state并改为“认证待复核—保留原配对”，stale时productionEligible=false。

相关9 files/431 tests、typecheck/build/diff通过；checkout build三方ID=7550f6aa658123f608ca41dd7e9c51db1c2819c7e19c65f749a54604e6ac5734；最终正式串行full 151 files/3064 tests全PASS、exit0，Vitest1062.22s/wall1065.24s；430个冻结source/test/support hash在full前后不变，新增目录/child/listener/connection均0，build三方ID复核不变。新增10个auth恢复回归，151文件覆盖不变，candidate expectedTests更新3064并精确刷新hash；command39的3054测试三连跑仍是历史冻结基线，不代表新代码已获候选晋升资格。无Core install/rollout/GC/commit/push；用户重载扩展后用原凭据点击一次连接，实测同companionId/binding/epoch恢复connected、authStale=false、owner=true、VERIFIED、mode=armed、health=ready/journal=NONE，无重新配对；证明原凭据仍有效。command39原trusted output241随后从queued进入正常claimed，attempt885d8b4b-6e9f-4411-a568-94de07dad56f，未重录或人工Bus操作；后续只读检查原record与Bus项均已不存在，不把absence单独当作Browser observed/ACK独立证据。本轮为普通composer请求，不补记command39或伪造same-origin receipt。

本文件是本 workspace 持续维护的开发事实源，不是一次性 handoff。阶段完成、设计修正、
新风险或 `NEXT_EXPECTED_STEP` 变化时必须同步更新；历史观察与当前实现分开记录。

## command39：R5j fresh 三连跑 acceptance_ready，尚未晋升（2026-10-03）

430个command37/source-test-support冻结hash与command38部署基线一致，streak内无修改。manifest151文件恰好一次、expectedTests3054、32 support hash、packaging1/serial6/parallel144全部验证；每轮实际1/1、6/69、144/2984，阶段时间戳严格有序不重叠。三轮均151文件/3054测试全passed、exit0，无retry/repeat/flaky/skip/pending。

| fresh run | wall / runner(s) | packaging / serial / parallel(s) |
| --- | --- | --- |
| 1 | 476.71 / 475.80 | 29.51 / 57.64 / 376.66 |
| 2 | 459.78 / 458.88 | 30.71 / 56.49 / 360.63 |
| 3 | 450.11 / 449.23 | 27.66 / 54.44 / 356.18 |

三轮wall及runner均≤480s；wall min/median/max/mean=450.11/459.78/476.71/462.20s，runner=449.23/458.88/475.80/461.30s。最慢wall余量3.29s。每轮新增目录/child/listener均0，dist字节/目录及430hash不变；packaging的stored/computeBuildId/core-release均`8e1553735dc817e60d758d8ffb156c41a2758d70562995470f09e1803e2eebce`。详细六个热点文件计时见r5j-regression-profile command39，未删历史输出或清残留以制造通过。

**NEXT_EXPECTED_STEP：Planner独立promotion review。** 当前仅将experimental candidate标为`acceptance_ready`，**不是authoritative**；package.json官方test仍`vitest run`，唯一正式门禁仍串行full命令，CI/default gate未改。本轮无正式serial full、packaging外build、install/rollout/GC/endpoint/rebind/Retire/Abandon/commit/push；仅结束后docs同步/diff检查及正常same-origin record，不预称Browser observed/ACK。command38生产部署状态保持，updater resilience仍未证明。

## command38：reviewed output-lock 安装与 scoped rollout（2026-10-03）

command37 Planner review PASS，本轮430个源码/测试/support冻结hash不变，未重复full/candidate/typecheck/build。预部署stored/computeBuildId/core-release精确一致；canonical install及完整release/bootstrap/helper/daemon/Browser artifact校验PASS，安装后的三份execution短锁模块与reviewed dist逐字节一致。**built=installed=running=`8e1553735dc817e60d758d8ffb156c41a2758d70562995470f09e1803e2eebce`**。

仅workspace `2582910bf0d2`执行stable launcher rollout：upgraded1/pending0/error0。旧PID22824/creation134354762025198833已消失；新PID16844/creation134354837905238319，startedAt=`2026-10-03T06:49:51.686Z`，executable与immutable entry精确匹配。local/admin/named均exact healthy（最终named在有界3次内成功），runtimeUpgrade=current、upgradePending=false，maintenance/rollout/start锁均clear，idle gate通过。Desktop available=true/unresolvedDelivery=false；Feedback/Companion route保持VERIFIED，Desktop/Feedback/Web Sink/Executor绑定不变，其他workspace runtime文件及command10 unknown锁、dangling authority字节/文件身份不变。

安装前GC候选0；install auto-GC `partial/global0/local1`仅已知`runtime:d94af68105aa`悬空exact引用告警，deleted0/tombstoned0/skipped0/bytes0。安装期间旧runtime8256仍被保护；rollout后只读plan为2 releases、keep新8e、候选旧8256一项（72,095,173 bytes）、unknown0/global0/local1。本轮未另行apply GC，已有gc-trash身份不变。

仅更新三份部署文档，最终diff-check PASS；未改源码/测试语义、未制造生产锁竞争，未endpoint switch/rebind/Retire/Abandon/commit/push。command38最后使用新installed launcher的正常same-origin record；active draft须由turn终态finalizer核验，不预称Browser observed/ACK。

**NEXT_EXPECTED_STEP：正常回流被独立确认后，在冻结源码上开展新的R5j experimental candidate三连跑验收。** candidate仍未晋升；R5i-a已部署的事实保留，Codex updater resilience仍未证明。

## command37：execution output/records Windows acquisition 竞争修复（2026-10-03）

隔离六进程原始短锁竞争在修改前复现 EPERM 14 次（17,874 attempts），修改后复现 22 次；路径即时 present/absent 均出现，底层 holder/内核原因未定，不臆测外部软件。真实 output 前后各 480 次写入与修改后 sync/async records 480 次追加均完整、无残留锁。临时 instrumentation 已移除，结果留在 ignored `.tooling/command37/`。

新增 execution 私有分类函数，仅用于 output 与 records sync/async 的 `openSync("wx")` catch：EEXIST，以及 Windows-only EPERM/EACCES，沿用 500ms/10ms 获取等待，到期 typed BUSY；其他 errno 与非 Windows 权限错误原样失败。不删/reclaim 他人锁；action/fsync/close/unlink 不经过该分类，提交后错误不具备自动重试语义。确定性测试证明 BUSY-only 调用方面对 release/post-append 失败只提交一次。

focused 10 files/211 tests、typecheck/diff PASS；原 14 个 output-atomicity 用例扩展断言，完整 inventory 仍151/3054，manifest只刷新对应hash；command36 fork seed优化保留。最终冻结后一次正式serial full **151 files/3054 tests全PASS、exit0，Vitest948.11s/wall950.65s**，430个源码/测试/support hash在full/build前后均不变；focused/full新增目录/child/listener/connection均0。canonical build的stored/computeBuildId/core-release三方均为`8e1553735dc817e60d758d8ffb156c41a2758d70562995470f09e1803e2eebce`。未改Python helper，不重复其独立门禁。本轮未跑候选full、install/rollout/GC/endpoint/rebind/commit/push。command37最后正常same-origin record，active draft由terminal finalizer核验，不预称Browser ACK。

**NEXT_EXPECTED_STEP：Planner 独立 review command37 的获取/释放边界及正式验证，再安排新的实验候选验收。** command36 450.51s仍因1项失败不构成性能PASS；candidate未晋升，唯一正式门禁仍串行full。生产build仍command34的8256ad7b…3016765，R5i-a已部署但updater resilience未证明。

## command36：R5j-c2 fixture 优化完成，候选功能门禁 blocked（2026-10-03）

仅fork-scripts fixture和manifest hash变动：dev/upstream各一个suite seed，每例普通独立拷贝，完整性hash/canonical路径/nlink/无链接检查及strict seed teardown；生产脚本、22次PowerShell调用、13个测试体和原断言未改。standalone前后同命令13/13 PASS，wall111.18→97.37s（减少13.81s，未达20s目标）；bootstrap9.04→2.97s，PowerShell时长也有波动，不把全部收益归于seed。场景50次Git调用保留；总Git110→65，真实clone/fetch/worktree/update-ref/安装及后台子进程语义不变。focused fork13、runner/teardown17、typecheck/diff PASS。

唯一候选151文件/3054测试恰好一次，无skip/pending，**3053 PASS/1 FAIL，exit1**；packaging27.69s/serial57.59s/parallel350.99s，runner449.60s、wall450.51s。fork-scripts13/13 PASS、124.85s。429冻结hash稳定，新增目录/child/listener0，dist不变、三方build仍8256ad7b…3016765。失败为未改output-atomicity真实跨进程writer在`openSync(index.json.lock,"wx")`遇Windows EPERM；单独诊断14/14通过，不覆盖候选失败。精确底层holder/权限/删除共享窗口原因尚未证明，未放宽生产锁错误分类。

候选保持experimental/blocked，不能作为<=480s成功证据，未再跑候选或正式serial full。**NEXT_EXPECTED_STEP：Planner复核本轮fixture优化及失败证据，聚焦output lock Windows EPERM确定性诊断，恢复功能门禁后再安排新三连跑。** 详细分段/安全证据见r5j-regression-profile command36。command34 GC闭环及R5i-a部署状态不变，updater resilience仍未证明；本轮无install/rollout/GC/endpoint/rebind/commit/push，最后正常same-origin BLOCKED record，终态流水线与Browser ACK不预称成功。

## command35：R5j-e连续候选验收未达性能门槛（2026-10-03）

权威基线保持151 files/3054 tests。候选runner从旧2919下限收紧为expectedTests=3054精确相等，文件恰好一次且每个file/test必须passed；现有17个guard用例内补上下界断言，未增删测试。分组复核为packaging1/serial6/parallel144，32个support hash精确；唯一共享dist写入者保持packaging独占。增加phase开始/结束时间用于检查无重叠，没有改生产src或package.json正式test命令。

冻结后连续跑两轮：第1轮151/3054全PASS、exit0，packaging/serial/parallel=29.76/57.97/362.39s，runner462.47s/外层463.35s；第2轮同样151/3054全PASS、exit0，28.90/58.23/386.23s，runner484.90s/**外层485.86s**。第2轮超过480s硬门槛，按规则停止，**第3轮未启动**。两轮的wall min/median/max=463.35/474.61/485.86s，不能当作三连跑验收。每轮阶段无重叠、429冻结hash不变、dist字节/目录不变，新增目录/进程/listener均0；packaging三方build ID仍8256ad7b…3016765。没有事后清残留/kill未知进程。

候选维持 **experimental / performance blocked**，不标acceptance_ready。focused17、typecheck、diff-check PASS；本轮仅runner bookkeeping/guard/hash和三份文档，没有正式serial full、独立build、install/rollout/GC/endpoint/rebind/commit/push。两次packaging内的canonical build属于原测试覆盖。

**NEXT_EXPECTED_STEP：R5j-c2 fork-scripts fixture/PowerShell/Git bootstrap成本优化。** 第2轮最大文件fork-scripts155.85s，其后legacy-reconciliation72.27s、gc-apply65.12s；先分段计时并去重非被测setup，保留真实脚本/安装/Git/进程断言，不按timeout声明猜耗时。完整phase/file证据见r5j-regression-profile command35。command34 GC已review闭环，暂无GC跟进；R5i-a已部署/updater resilience未证明不变。command35最后使用正常same-origin BLOCKED record，不预称Browser observed/ACK。

## command34：reviewed GC 两阶段 live apply（2026-10-03）

本节覆盖 command33“源码待部署”的历史状态。Planner destructive semantics review PASS；429个源码/测试/support冻结hash与command33 passing full一致，stored/computeBuildId/core-release均为 `8256ad7b704e7c109973b5c1436253f05a59aa24ed157fc766fbecfad3016765`。本轮没有重跑full/candidate/typecheck/build。

安装前SOURCE只读plan精确为14 releases、keep1、候选13、unknown0、global0/local1；13项集合与command33一致，共929,156,162 bytes。冻结并复核current/runtime/pending/finalizer authority、release目录与manifest身份。唯一告警为 `runtime:d94af68105aa` 指向缺失 `9c33929c545edbe2242770baede0cef9f1f189712d9ce0060f307bc88ce0732a`，不删除、不修复authority。

| 阶段 | 精确删除范围 | deleted / tombstoned / skipped | bytesDeleted | active releases |
| --- | --- | --- | --- | --- |
| install自动GC | 安装前冻结的13个候选，集合完全一致 | 13 / 0 / 0 | 929,156,162 | 2：新current8256 + 旧runtime59e |
| rollout后显式GC一次 | 仅退役59e436b7…dc56371 | 1 / 0 / 0 | 72,081,745 | 1：仅8256 |
| 合计 | 两阶段互斥集合 | 14 / 0 / 0 | **1,001,237,907** | 1 |

两次GC均 `status=partial/ok=false/globalBlockerCount=0/localIssueCount=1`，仅上述exact dangling warning；显式CLI exit1是告警合同，installer exit0。bytes与初始logicalBytes完全一致。phase1同时保留新current和仍运行的旧59e；phase2前确认旧creation identity消失、fresh plan仅59e候选。最终current/installed/running均8256，candidate0/unknown0/global0/local1，证明局部悬空引用不再阻断独立候选。

rollout保留失败证据：首次已认证关闭旧PID23616并启动新PID22824，但cloudflared查询既有named tunnel的Cloudflare API超时，返回restart_failed/error1。只读确认新runtime健康、旧identity消失后，stable launcher `start -w <本workspace> --tunnel`复用新Bridge恢复同一配置；随后scoped rollout为 **current1/upgraded0/pending0/error0**，没有第二次重启，不将首次失败记作upgraded1。最终runtimeUpgrade=current/upgradePending=false。

新PID22824，creationTime `134354762025198833`，startedAt `2026-10-03T04:43:23.621Z`；executable/immutable entry精确匹配，provenance matching/helper-breakaway/inAnyJob=true。local Node HTTP health、authenticated admin、named public health均200且workspace/pid/start/build一致；公网仍为 `https://c2c-codex-with-chatgpt.devworklink.com`。旧PID23616/creation134354697660402460已missing，未强杀。Desktop available/unresolvedDelivery=false；四个binding store在record前与predeploy字节一致、Companion同一VERIFIED route；其他workspace runtime、command10零字节未知锁、dangling authority身份/字节不变。maintenance/rollout/start locks clear，idle PASS；core finalizer/worker/retirement目录均无entry，无新增job或retirement。

残留边界：本轮新增tombstone为0，但整个gc-trash并非空。另有 `637edb28f3b7a3c8d42a59d80ace76d4c56277f5c4599fc07b97062f2ffb1bee.bbd79e2e-c25f-4bda-bbc4-93b2259ea34c` 历史目录（birth 2026-09-16、mtime 2026-09-18），不属于本轮候选/结果，postinstall到final目录身份/时间不变，保留且不计回收bytes，未扩展历史清理范围。

本轮repo仅更新本计划、endpoint architecture、architecture三份文档；git diff --check PASS，保留既有dirty work，无staged/conflict、无commit/push、endpoint switch/rebind或Retire/Abandon。command34当前分类为applicable/origin，origin/result turn均 `01a10003-c975-76b0-a0bc-5ba84885e602`，chainLength0。标准record作为最后工具动作；trusted commit/canonical handoff由terminal finalizer核验，不预称Browser observed/ACK。**NEXT_EXPECTED_STEP：Planner复核live GC及command34正常回流 → 恢复R5j experimental candidate验证/验收。** dangling authority与历史trash继续保留；updater resilience仍未证明。

## command33：GC 按 release 限定 fail-closed 范围（2026-10-03）

本节是当前 GC 源码合同，覆盖下方 D1/D2 与旧 finalizer 节中的“任意 issue 全局阻断”和“candidate 集合变化整轮 abort”历史规则。本轮只做源码、临时 fixture 验证与真实机器只读 plan；不 install、rollout、live GC apply 或历史状态清理。

根因有两项：reference collector 将合法 RuntimeState `capabilities` 视为 strict-schema 损坏；plan 又把任何局部问题或悬空 exact 引用传播为所有候选的 `global_unknown_reference`。现在 issue 显式携带 `scope=global | build(buildId) | release(entryName)`，不解析错误文字推断安全范围。runtime/pending 按 canonical regular file、canonical 文件名、workspaceRoot/id 与 exact build 提取最小引用，额外字段不抹除 pin；不可证明的目标、文件替换/硬链接、目录链接或遍历失败仍全局阻断。current pointer 继续严格验证。

`GcPlan` 新增 `safety=clean|degraded|blocked`、`globalBlockerCount`、`localIssueCount`、`issueDetails`；仅 global issue 将所有候选变为 unknown。dangling build 只保留该 build 的告警，坏 manifest/非 canonical release 只保留对应 entry。`ok=false` 与 CLI exit1 继续表示存在告警，兼容 installer best-effort 行为，不等于没有安全候选。

apply 顺序保持 maintenance → rollout fence → start-lock → fresh plan。只处理 initial/fresh 的稳定交集；变为 referenced/unknown 的项单独 skip，新出现候选推迟下次。strict legacy retirement 保持 expired + exact active/claim/token + ESRCH + 文件身份重验；只有两次快照均已存在的 exact finalizer pin，且本轮取得原协议 retirement proof，才允许当轮释放后删除。能证明 target 但不兼容 retirement schema 的 finalizer 只 pin 对应 build，并保守跳过 retirement pass；unscoped/corrupt/orphan worker 或 retirement proof 仍全局阻断。每次 tombstone 前重读 plan 并重验 fences/path/manifest；局部错误不阻止其他项，新增 global blocker 立即停止后续删除。no-follow 删除与 tombstone 保留语义不变。

apply 返回 `status=success|partial|blocked`、scoped 诊断与 `retained` 原因；partial 保持 `ok=false`/exit1，允许已有安全删除结果同时报告告警。`bytesDeleted` 只计成功物理删除。全局阻断若在运行中出现，不回滚已完成删除，但不再删除任何后续项。

真实机器只读对账：安装版/修改前源码均为14 releases、keep1、unknown13、候选0、issue2；修改后为 `globalBlockerCount=0`、`localIssueCount=1`、keep1、unknown0、候选13、可回收 **929,156,162 bytes**。`current` 与 `runtime:2582910bf0d2` 精确保留 `59e436b7b4b16a9f21a96c745c27e9cbe5d5d269d6e77d1ae056d3f5edc56371`；`runtime:d94af68105aa` 指向缺失 `9c33929c545edbe2242770baede0cef9f1f189712d9ce0060f307bc88ce0732a`，仅保留 exact-build dangling 告警。读取前后 current/runtime/pending/finalizer authority 文件身份及字节一致，真实删除数为0。

验证：GC/reference/apply、finalizer、安装/GC 集成、rollout、manifest guard 定向8 files/293 tests PASS；最终 fence 补强后 GC apply/Bridge maintenance 2 files/58 tests PASS。首轮正式 serial full 为151 files/3054 tests，3053 PASS/1 FAIL、exit1、Vitest935.29s/墙钟937.67s；唯一失败为 `runtime-prune` 旧诊断断言仍将“缺 buildId + 额外字段”分类为 corrupt。按新 reference-extraction 合同改为 `runtime_missing_build_id`，并明确断言 global scope 和零引用；生产源码未改，相关2 files/41 tests PASS，刷新对应 manifest hash 后重新冻结。首轮429个文件hash稳定、新增目录/child/listener/关联连接均0。

最终正式 gate：151 files / 3054 tests 全部 PASS、exit0，Vitest938.81s / 墙钟941.24s。429个源码/测试/support hash 在 passing full 与最终 build 前后稳定；新增 temp-dir、child、listener、关联连接均0。typecheck、canonical build、git diff --check PASS；stored/computeBuildId/core-release 三方 ID 均为 `8256ad7b704e7c109973b5c1436253f05a59aa24ed157fc766fbecfad3016765`。HEAD仍为cedb95c，无 staged/conflict，保留既有dirty work。本轮未修改 Python helper，未另跑 Python 协议；没有执行实验 candidate full。新构建仅在 checkout，现役安装未改，真实 GC 删除/retirement 数均0。

本轮文件：`src/core/release-references.ts`、`src/core/gc-plan.ts`、`src/core/gc-apply.ts`；`tests/gc-plan.test.ts`、`tests/gc-apply.test.ts`、`tests/install-gc.test.ts`、`tests/runtime-prune.test.ts`；`scripts/test-full-candidate-manifest.json`；`docs/development-plan.md`、`docs/r5-endpoint-architecture.md`、`docs/architecture.md`。仅刷新改变的测试 hash，未更改实验 runner 分组或提升其权威级别。

**NEXT_EXPECTED_STEP：Planner independent review GC destructive semantics → 另轮部署/真实 GC 验证 → 再恢复 R5j candidate 验收。** R5i-a 已部署的观察性能力与 updater resilience 尚未证明的边界不变。command33 最后走正常 same-origin record；不预称 Browser observed/ACK。

## command32：reviewed deployment 核验（2026-10-03）

Planner已确认command31生产diff PASS。本轮fresh核验发现command32输入中的“仍运行c681”已被上一轮用户明确授权的部署取代：build/installed/running均为`59e436b7b4b16a9f21a96c745c27e9cbe5d5d269d6e77d1ae056d3f5edc56371`。429个source/test/support hash仍与command31正式full冻结快照一致；dist stored/computeBuildId/core-release一致，installed immutable release执行full artifact/bootstrap/helper/daemon/Browser资产校验通过，无staged/conflict，保留dirty work。

本轮仅调用stable launcher的当前workspace scoped rollout核验，返回**current=1/upgraded=0/pending=0/error=0**，没有重复安装、GC或重启。此前实际升级的upgraded=1证据属于上一轮，不能算成本轮再次升级。PID23616、creationTime=`134354697660402460`、startedAt=`2026-10-03T02:56:07.172Z`及executable严格复核一致；local health/authenticated admin使用已安装的新Node HTTP路径，named public health一次精确通过。runtimeUpgrade=current/upgradePending=false；maintenance/rollout/start locks clean，idle=true，Desktop available/unresolvedDelivery=false。Desktop/Feedback/Web Sink/executor binding和其他workspace runtime未变；command10零字节未知锁原样保留。上轮安装GC的13候选全部initial_plan_unsafe跳过，deleted/tombstoned/bytesDeleted=0，本轮未重复GC。

安装代码已核验canonical projection-before-legacy顺序，strict read-only cutoverReady=true、49历史suppression、unsafe legacy in-flight=0。最近同一runtime的command31已通过正常Browser回流并由用户确认exact attempt；本轮工具无外部Edge tab可见性，没有提取credential或伪造认证`/state`请求，不能声称本轮独立抓取了该响应。command32新鲜accepted delivery精确匹配same-origin turn `01a0ffb5-e8bb-7060-b5c5-271e9146a154`（chainLength0）；最后请求标准record，trusted commit/新Bus projection/Browser observed须在turn终态后由正常流水线和Planner核验，不在record后追加工具活动。

按任务要求未重跑full/candidate/typecheck/build；部署核验复用已审核151 files/3027 tests PASS冻结门禁，不把历史测试写成本轮重跑。仅更新本计划、endpoint architecture、r5j profile并执行git diff --check。**NEXT：command32正常回流核验后优先GC per-release fail-closed redesign，再恢复R5j验收。** 未commit/push/rebind/endpoint switch/Retire/Abandon，未重建或重发旧command。

## command31：生产 loopback HTTP 禁用端口修复（2026-10-03）

command30修复了直接测试HTTP客户端，但生产Bridge在默认端口冲突时会回退到`port=0`；`probeBridge/adminFetch`和doctor本机MCP探测仍使用Node Fetch，会在OS分配Fetch禁用端口时于TCP连接前误报失败。本轮新增内部`requestLoopback`，只接受结构化port/path等参数并固定连接`127.0.0.1`，使用`node:http`、`agent:false`、1MiB响应字节上限、覆盖connect/header/body的总deadline，不跟随redirect、不内部retry、不输出credential或原始网络错误。health的2s与live-PID单次8s重试、admin调用方预算、精确runtime身份判定保留；doctor本机POST `/mcp`以8s总deadline继续要求401。

公网named HTTPS、cloudflared、Browser Fetch和SDK streaming transport不迁移；测试`http-json.ts`保持独立，生产不导入测试代码。新测试以逻辑6000端口经仅TCP目的地映射连接真实port=0 server，验证生产health/admin与MCP请求不调用Fetch；覆盖状态/header/body、认证/redirect、坏JSON、超时/partial/reset、1MiB边界和socket/timer释放。provenance真实认证测试重新使用生产`adminFetch`。candidate manifest为151 files（packaging1/serial6/parallel144），仍experimental。

**验证PASS**：最终定向18 files / 386 tests，Vitest138.29s、外层140.77s；typecheck通过。最终冻结后仅执行一次正式`pnpm test --maxWorkers=1 --testTimeout=90000`：**151 files / 3027 tests全部PASS，exit0，Vitest922.72s、外层925.20s**。429个source/test/support hash在full前后及最终build后均未变；定向/full新增test-tmp目录、残留child/listener/关联连接均为0。canonical build的stored/computeBuildId/core-release三方完全一致：`59e436b7b4b16a9f21a96c745c27e9cbe5d5d269d6e77d1ae056d3f5edc56371`；git diff --check通过。Python源码未改，没有额外Python门禁或candidate full。

本轮10个交付文件：`src/bridge/loopback-http.ts`、`src/bridge/runtime.ts`、`src/cli/runtime.ts`、`tests/loopback-http.test.ts`、`tests/runtime.test.ts`、`tests/bridge-provenance.test.ts`、candidate manifest及本计划/endpoint architecture/r5j profile三份文档。command28投影代码及Browser修复保持冻结，未重建或重发command27。开始时command31当前Desktop classification为applicable/origin、chainLength0；最后走同origin标准record，不预称Browser observed。

本条覆盖此前等待额外full次数授权的状态：command31已获授权且正式门禁通过，**部署pending Planner review**。未install/rollout/GC/commit/push，保留原机器状态与dirty work。**NEXT_EXPECTED_STEP：Planner独立review生产diff → 后续部署；部署后优先GC per-release fail-closed redesign，再恢复R5j验收。**

### command31 回流故障恢复与用户授权部署（2026-10-03 10:56，Asia/Shanghai）

上述部署pending为command31开发turn结束时的状态。后续只读诊断确认原same-origin finalizer已成功提交trusted receipt/output233（ok）和canonical result `74dfb121-3360-4657-beb0-5adfdf26eb93`，无pending draft/alert，但Bus为空。运行中的旧`c681654a…fd7f3f`仍先执行legacy enrichment，遇到保留的command10零字节锁后仅走read-only cutover，因此新结果没有被投影；这次断点在server projection，不是record失败或Browser观察失败。

用户随后明确授权安装已验证构建并仅rollout `2582910bf0d2`。再次核对429个冻结hash无漂移、build三方身份一致、idle/locks/真实in-flight与binding门禁通过后，安装`59e436b7b4b16a9f21a96c745c27e9cbe5d5d269d6e77d1ae056d3f5edc56371`；scoped rollout为upgraded=1/pending=0/error=0，PID3380→23616，startedAt=`2026-10-03T02:56:07.172Z`。local/admin/named均精确匹配新runtime；Desktop/Feedback/Web Sink/executor binding与其他workspace runtime未变，command10锁原样保留。GC按原门禁跳过13个候选，deleted/tombstoned/bytesDeleted均0，未扩大GC权限。

正常Companion请求自行投影原command31，Bus `5a65ab9c85010d8e8e887fec3178e997c8a7501b068911cf4a98c6ac3f18b246`先reserved后claimed，attempt=`7b87c323-ea5d-45a5-85fa-a1fcde52ca2d`；投影时原receipt/result摘要未变。10:56:46只读检查delivery/receipt/result/Bus/draft/alert全部为空；随后用户明确确认网页已收到且ATTEMPT_ID一致，原回流与正常ACK后ephemeral cleanup完成精确对账。没有重录/重发、人工reserve/begin-send/ACK或cleanup。后续普通修复turn不补写command31回执。

**当前状态：修复构建已按用户新增授权部署，command31原回流已精确确认；NEXT优先GC per-release fail-closed redesign，再恢复R5j验收。** 未重跑未变化的formal full，未commit/push；本次部署不代表Codex updater resilience验收。

## R0→R5j recovered authoritative roadmap（截至 2026-10-03）

本路线收敛当前产品阶段；最新R5j验收以文首command35为准，部署/GC以command34为准。它优先于下方历史记录中的旧 `NEXT_EXPECTED_STEP` 和各 R3 slice
当时的 pending 状态。C/A/D/B、Phase E/F/G/H 仍是保留的历史实现记录，不再覆盖本路线的阶段顺序。

| 阶段 | 目标 | 当前状态 |
| --- | --- | --- |
| R0 | 清理实验分支，建立可信基线 | done |
| R1 | Project 是 workspace 内的容器，可关联多个带 planner/executor role 的 Route；Route identity 为 `{workspaceId, platform, conversationId}`；随机 `bindingId` / `routeId` / `resultId` 仅作引用；Command 与最小 ExecutionResult durable model | foundation done |
| R2 | 以 Desktop behavioral adapter 取代生产 build/hash/catalog gates | done |
| R3 | Browser Companion“设备授权一次 + 当前网址一键绑定”的 Web adapter 与 feedback return plane | done；真实 live E2E PASS |
| R4 | 将 Codex terminal truth（machine facts + Codex 自己的 final summary）写成 canonical ExecutionResult，经 `Command.plannerRouteId` 的 durable outbox 返回；不做第二次 AI rewrite | R4a-R4c 已完成 review；R5d3 后 production canonical authority 已迁移到 Result Bus，R4 outbox 保留为 compatibility shadow |
| R5a–R5h | endpoint 解耦、rollout 不等待 conversation idle、command 运行时状态 ephemeral | R5a-R5e 已完成验证；command12 已验证 R5f conversation-liveness 解耦的部署；command13/14 的 R5g 正向回流与 R5h terminal auto-destroy live PASS；尚未证明 Codex updater 下的进程独立性 |
| **R5i** | **Bridge process lifecycle independence / host-update resilience** | **command22 R5i-a deployed/verified：built=installed=running 465e06ca…9d83e3e；matching helper-breakaway，final/healthy inAnyJob=true。updater resilience未证明；b/c/d/e排在R5j之后** |
| **R5j** | **Full Regression Acceleration / Test Runtime Optimization** | **command31生产loopback修复，定向386与正式151 files/3027 tests PASS；build身份59e436b7…dc56371已按用户新增授权部署，原回流exact attempt已确认。GC per-release redesign优先，再恢复R5j；候选仍experimental** |

### R5j — Full Regression Acceleration / Test Runtime Optimization（command22 正式纳入）

**权威顺序：先完成当前 R5i-a 部署/observability closeout → R5j → R5i-b/c/d/e 实施及后续真实验收 → optional endpoint switching/negative live/legacy migration。** 本轮仅制定R5j，不实施测试加速，也不为证明稳定性额外跑full。后续每个开发command在最终source/test冻结后只跑一次正式full；只有失败导致修复，才需要新的最终full。

同一机器/current suite基线：command21唯一正式串行full为 **148 files / 2919 tests / exit0 / 946.92s（约15分47秒）**。当前唯一权威门禁仍为 `pnpm test --maxWorkers=1 --testTimeout=90000`；`test:parallel`继续实验性，未经独立审计和稳定性证据不得替代。

| Slice | 实施与证据要求 |
| --- | --- |
| R5j-a Profiling | 为一次权威串行full记录可重复的per-file/per-test wall-clock timing，找出最慢suite；区分CPU、spawn、文件复制/build/install fixture、无外网依赖的等待、Windows进程生命周期等待、polling/sleep。daemon/bridge parent-death的180–240s预算、fork-scripts/install-GC子进程、desktop-helper-packaging canonical build、重复CLI/Python启动只是待测候选；预算不等于实际耗时，不先认定瓶颈。 |
| R5j-b Safe parallelism | 利用现有per-file隔离C2C_STATE_DIR，将suite划分parallel-safe与must-remain-serial；审计global env、真实端口、process tree/Job、机器全局资源、共享checkout/dist mutation及外部进程交互。完成race/flake独立审计和重复完整证据前，不提升test:parallel地位。 |
| R5j-c Expensive-gate dedup | 在同一个正式验证周期中消除对同一不变量的重复canonical build/packaging/install-fixture工作；仅在身份及隔离可证明时安全复用。保留至少一次所需真实release/build identity门禁，不用mock取代release校验以换速度。 |
| R5j-d Real-time wait removal | 在不改变所测语义时，用确定性事件、process exit handle、fake timer或有界信号替代固定sleep/poll；真实OS生命周期测试继续使用真实进程，不能用假时间冒充。 |
| R5j-e Authoritative optimized gate | 产出一个有文档的唯一正式full命令；不删除测试、不减弱断言、不以changed/related代替、不跳过Windows E2E。当前平台有效测试数量和覆盖不低于基线。 |

验收首目标同机同有效full覆盖 **≤8分钟**，stretch **≤5分钟**；至少连续3次完整运行，pass/fail语义一致、无shared-state race/flake、无进程/端口/state泄漏。只有这些证据及独立review通过后，优化命令才可替换maxWorkers=1权威门禁。三连跑是R5j验收，不提前要求每次开发都重复full。

R5i-b/c/d/e继续排队；Browser refresh reconnect仍是独立R5i-e问题，不因测试加速或当前部署被合并归因。R5i-a部署若再次blocked，先保留其exact blocker，不提前推进R5j实施。

### command23：R5j-a profiling 完成，下一步为 R5j-b1

唯一正式串行 full 附加末尾 timing reporter，保持 maxWorkers=1、原 include/timeout/全部断言：**148 files / 2919 tests / exit0**。Vitest **965.64s**，外层墙钟 **970.83s**；tests/hooks853.68s、collect42.32s、prepare35.40s、setup3.44s、environment0.032s，transform4.73s不能重复加到collect。与command21同口径946.92s差+1.98%，单次不足以归因。459个冻结文件（src/tests369个）前后SHA-256一致；本轮没有源码/测试语义修改、第二次full或单独build。

完整[profiling报告与前25热点/148文件安全分类](r5j-regression-profile.md)区分实测与估算；raw只在ignored `.tooling/r5j-profile/`。前20文件累计629.77s；最大项是fork-scripts116.20s、web-control-cli57.90s、legacy-reconciliation56.10s、R5d2 lifecycle50.88s。daemon/Bridge parent-death实际6.61/5.90s，180–240s并非耗时；packaging28.41s内含两次真实build，继续保留clean identity与确定性覆盖。

分类为125个parallel_safe_candidate、6个serial_required、17个needs_refactor_before_parallel，仅为静态候选，不是并行验收。主要边界是共享dist构建/reader屏障、Job/进程树真实OS组、随机端口、独立CLI与文件持久化。无新增测试存活child或监听端口；**84个本轮测试临时目录残留**（含remote-state20、state27、prune22、gc4、auth5、daemon4及两个其他目录），因此“零state泄漏”尚未通过。未删除现场或生产历史。

**NEXT_EXPECTED_STEP = Planner independent review → R5j-b1：补齐fixture生命周期/teardown及端口所有权，建立packaging独占屏障与OS串行组，其余文件3-worker有界候选runner。** 先保持全部148文件/2919用例恰好一次、原断言及真实OS覆盖，再验证并行。当前6文件串行阶段约67.02s、其余阶段867.85s；2-worker理想下界500.95s尚未计调度，不能盲升现有parallel2。3-worker候选预计400–480s；4-worker理想含当前额外开销约320s，stretch300s仍需另省至少20s墙钟并留竞争余量，尚无实测承诺。

随后R5j-c优先减少重复CLI/Git/安装fixture准备（不将跨进程证明改成同进程、不删两次build），R5j-d替换可确定性的短poll/flush；预计额外收益见报告。R5j-e仍需连续3次同覆盖完整通过、无race/flake/进程/端口/state泄漏及独立review，才可发布唯一优化权威门禁。当前正式命令不变：`pnpm test --maxWorkers=1 --testTimeout=90000`。R5i-a deployed/verified保持，updater resilience未证明；未install/rollout/commit/push。

### command24：R5j-b1 隔离与实验分组验证

[完整残留根因、分类审计与实测](r5j-regression-profile.md)新增command24记录。修复command23全部84项残留来源，保留历史目录；测试专用严格teardown对持续Windows占用明确失败。实验入口 `pnpm test:full:candidate` 依次运行 packaging1文件独占build/hash屏障 → serial6文件（含因竞争超时移出的web-control-cli）→ parallel142文件/maxWorkers3。显式manifest与共享support hash要求新测试/改动重新审计，实际reporter保证每文件一次、无skip，build后dist不可变。

最终候选 **149 files/2931 tests/exit0，外层464.50s，runner463.53s**；新目录/child/监听端口均0，dist一致；≤480s **达成**。首轮候选web-control-cli超时后移回serial，未放宽60s断言/timeout。正式串行full **149 files/2931 tests/exit0，Vitest954.58s/墙钟956.60s**；12新增回归，生产源码未变。该full发现ensure-start-lock测试留下1个state目录；最后已补runtime teardown、55项定向及候选通过，但尚无补修后的正式full，次数上限授权待定。 候选只完成一次当前最终代码全绿，仍非权威。

**NEXT_EXPECTED_STEP = 确认是否允许追加正式full（command24次数上限）→ 最终补修冻结后的serial gate → Planner review → R5j-b2/e稳定性验收。** 唯一正式门禁保持 `pnpm test --maxWorkers=1 --testTimeout=90000`，3连跑及独立review之前不得替代。R5i-a deployed/verified及updater resilience未证明保持；未安装/rollout/生产操作/commit/push。

### command25：fixture PID identity review fix

Planner 发现 command24 `stopFixtureProcess(pid)` 按 raw PID 终止的 P2：短命进程自然退出后，PID reuse 可能使 teardown 触碰无关进程。测试/support 修复改为 `FixtureProcessIdentity={pid,creationTime,executable}`；daemon 直接使用 spawn 返回的 finalProcess，fork 创建方在持有 ChildProcess handle 时同步取得 probe 并写入 fixture marker，remote unlocker 只等待自身 exit event。

Windows 测试 helper 只打开一次带 QUERY/TERMINATE/SYNCHRONIZE 权限的非继承 HANDLE；64位签名明确，在同一句柄上检查 exact creation/executable、TerminateProcess、WaitForSingleObject，finally CloseHandle。身份漂移、活着但权限/探测未知均拒绝终止；已退出目标不再追踪 raw PID；终止后只等待原 HANDLE，绝不重开/杀替代 PID。自然退出期间 query/terminate 可返回 ACCESS_DENIED，只有同一 HANDLE 在最多10秒内 signaled 才证明已退出，持续未知仍失败；外层 helper timeout 15秒。ChildProcess 等待的 timer/listeners 在 exit/error/timeout 后全部释放。没有修改生产 src、daemon lifetime 或历史机器状态。

14项确定性 Python HANDLE 回归使用 fake kernel（含64位handle、PID reuse、creation/exe drift、EPERM/unknown、退出竞态、有限等待、close）；Vitest新增5项覆盖其接线、真实 exact fixture exit、ChildProcess timer清理，总有效用例由2931增至2936。分组维持149文件：packaging1 / serial6 / parallel142；manifest只刷新本轮审计的测试/support字节hash。新增普通child仅拥有自己的进程，不操作共享Job、固定端口或机器安装状态。

本轮唯一实验候选 **149 files / 2936 tests / exit0**，runner **480.29s**、pnpm外层 **481.31s（约8分1秒）**；新增目录/存活测试child/listener均0，dist byte/directory snapshot不变。packaging28.87s（1/1）→ serial96.36s（6/68）→ parallel343.83s（142/2867），各阶段不重叠。相较command23墙钟970.83s减少50.4%，但本次 **超过480s目标1.31秒，≤8m未达成**；不把command24的464.50s代作当前冻结代码测量，也不宣称3连跑稳定。

定向末轮daemon/runner **31 PASS**，fork **13 PASS** 与remote **20 PASS**；Python **14 PASS**；typecheck/diff PASS。早期定向暴露短命进程正在退出时的ACCESS_DENIED窗口，最终改为同一HANDLE有限等待退出证明后补测；持续权限/探测未知仍失败。packaging保留原有真实canonical build及 stored/computeBuildId/Core-release 一致校验，ID为 `29e3945669ffc64d9b0d5977c149d51145f1ed97c1f259993a4d38a7b884ffef`，未额外build。最终测试/support冻结hash保持不变，生产src/browser-companion也与本轮开始一致。raw见ignored `.tooling/r5j-b1-pid/` 和 `.tooling/r5j-candidate/1790944728714-db2b6c28-b009-4bf0-91c0-e80231b3d963/`。

**NEXT_EXPECTED_STEP = Planner复核command25 → 等待明确次数授权 → 最终冻结后的正式serial full → 通过后才进入R5j-b2/e。** command24的954.58s正式full早于最终runtime teardown补修，不能当作command25的最终门禁；本轮明确不运行正式serial full，候选仍非权威。R5i-a仍deployed/verified，updater resilience未证明。未install/rollout/生产restart/endpoint/rebind/legacy cleanup/commit/push。

### command26：return-path lock / credential race / popup timeout

command25 已有 trusted receipt（`outputId=228`、`ok`），其 canonical Bus entry `547dab80…ca33b71f` 是 queued、无 attempt；本轮不重新 record/send command25。只读取证发现 `command-cleanup/2582910bf0d2/r5h-ephemeral-command-lifecycle-20261002-10.json.lock` 为 0 字节、无法解析 PID/nonce、无对应 journal/temp，按 corrupt/unknown 保留，未删除或抢占。其他观察到的锁由当前 Bridge 持有并释放。

- Web Sink 认证后的 canonical `/state`、`/reserve` 在 delivery arbiter 内尝试现有 enrichment；仅明确的 command lifecycle `COMMAND_CLEANUP_BUSY` 可降级为严格只读 Feedback/cutover 校验。已有处置须再次验证；缺处置、身份漂移、损坏/非 regular store、cleanup transaction、任何 legacy reserved/claimed/outcome_unknown 仍阻断。纯 canonical entry 可继续；legacy/control fallback 仍要求完整 reconciliation。返回 bounded `legacyFeedbackDegraded`；不把错误捕获当成 route VERIFIED 证据。
- 已预约 Bus 的 release/begin-send/ACK 继续使用原有 exact entry/frozen-target 门禁，不依赖无关 legacy enrichment。没有新 migration authority，没有清理历史锁或 evidence。
- 每个 authenticated fetch 保存私有 request transport witness，比较 origin/workspace/companion/binding/epoch/route/credential/pairedAt。迟到旧响应返回 `stale_transport_response`，不改新 transport/journal/fence/autonomy；仍当前的 401 durable authStale 与 rebindPending 特例保留。实测回归另发现 manual reserve 使用尚未声明的 generation，已在该分支就地归一化，未改变投递授权。
- popup 的 tab/status/runtime RPC 单次 UI 等待上限 10 秒，timer 在 finally 清除；超时显示 bounded stage，后续显式 refresh 可恢复。不自动 pair/rebind/recover，不缩短 Bridge 的生产安全请求预算。
- 本轮 command26 首次投递本身仍为 outcome_unknown；通过现役严格 `desktop reconcile-unknown` 确认 exact origin 后转 accepted（turn `01a0fd0d-3019-7f83-9521-e7ce89fcf5b8`），无重发或 administrative resolution。fresh rollout gate 随后 PASS。

验证与部署：唯一获授权的正式 serial full 为 **147/149 files、2952/2954 tests，exit1，Vitest982.88s / 墙钟985.13s**；冻结424文件前后未漂移，新目录/存活测试child为0。两处失败已补修：router通过delivery adapter导出cutover错误类型、恢复原架构边界；shadow源码检查归一化CRLF后保留原只读断言。相关4 files / 143 tests PASS，typecheck与canonical build三方身份PASS，补修build `c681654acc5a52572551f92b66610689c39f667e89b888bb46eb35cb4efd7f3f`。六个改动测试文件审计后仅刷新manifest hash，packaging1/serial6/parallel142不变；未另跑候选。用户另行授权一次后，最终冻结源码的正式full为 **149 files / 2954 tests PASS、exit0、Vitest1008.61s / 墙钟1011.18s**。源码424文件无漂移，新目录/存活测试child为0；部署前canonical rebuild仍为同一c681654a…fd7f3f三方身份。没有第三次正式full或额外实验候选，command25不重录/重发。

command26 scoped部署（2026-10-03本地时间）完成：built=installed=running `c681654acc5a52572551f92b66610689c39f667e89b888bb46eb35cb4efd7f3f`；canonical full-artifact verification PASS，rollout upgraded1/pending0/error0，PID15256→3380、startedAt=`2026-10-02T16:13:34.058Z`、creationTime=`134354312128903287`。local/admin/named health均exact200，runtimeUpgrade=current/upgradePending=false，原named URL及Desktop/Feedback/Web Sink/Executor binding与其他workspace runtime保持。matching helper-breakaway/inAnyJob=true仍不证明updater resilience；旧shutdown诊断对新runtime为conflict，未附着到新进程。GC initial_plan_unsafe下12候选全保留，deleted/tombstoned/bytes为0；command10空锁未删除或抢占。

command25仍使用原trusted output228/ok：部署后先queued、后正常Bus in-flight，随后receipt/Bus消失；用户从原网页回流提供ATTEMPT_ID `380887a7-bf6e-478c-8b4a-3c33747b0ac9`，installed cleanup preview（无confirm）为not_found/artifacts=[]。没有重录/重发、人工reserve/begin/ACK或manual cleanup。Browser用户确认“已连接，自动回流已开启”；本轮未reload扩展，Browser late401/popup timeout新代码须按用户正常reload/update路径生效。

command26收尾限制：追加full授权后当前resultTurnId=`01a0fd4d-ff74-7813-ae20-1387331371af`，原delivery origin=`01a0fd0d-3019-7f83-9521-e7ce89fcf5b8`；旧/新installed helper均只读分类not_applicable，无origin/native-continuation证明。标准same-origin record尚不能声称成功，禁止--task、指定旧turn或伪造receipt；本任务开发/部署已通过，command26 canonical return闭环仍blocked。

当前 NEXT：Planner独立核对本次源码/部署及command26回执上下文限制 → R5j-b2/e。最终serial gate已通过，候选仍实验性，未完成三连跑。R5i-a deployed/verified、updater resilience 未证明的边界保留。


### command27：R5j-c1 Web Control CLI cold-start reduction

先对原套件单独测量一次：2 tests PASS，Vitest56.21s、测试体55.64s、外层58.50s。ignored preload只记录spawnSync耗时/operation/PID/status，实际26个不同Node/tsx进程（web-control24、session1、record1），累计55.60s、单次2.03–2.59s。全部raw保存在ignored `.tooling/command27/`，无正文/env/credential。这不是靠timeout声明推断热点。

测试专用 `tests/fixtures/web-control-cli.ts` 只注册生产registerWebControlCommands/registerSessionCommands/registerRecordCommand，复用Commander选项、parseAsync错误边界与真实action/store代码；不导入无关CLI注册图。生产src无修改。静态回归同时验证生产index与fixture仍从相同模块导入并调用这三个register，fixture只含三项注册。严格teardown在同步child退出后删除本套件的两个隔离目录。

所有26次调用仍各自启动真实Node/tsx进程，没有batch/in-process替代；保持初始disabled→session URL、enable→boot/receive、accepted→start/duplicate-start、真实record --task→complete/feedback、disable/close→reopen/seenCommands这五类跨进程持久化checkpoint。原有local-user/owner mismatch、超大与malformed文件读取、假source/内容不回显、重复start、feedback及禁止执行自然语言断言全部保留。

优化后standalone：3 tests PASS，Vitest16.71s、测试体15.99s、外层19.07s；仍26个不同child PID，累计15.93s、单次0.58–0.82s。墙钟减少39.42s（67.4%），同样store/actions和进程数量下的主要收益来自删掉无关cold import graph。主流程46.44→13.60s，异常输入9.20→2.37s；新增接线断言约13ms。未合并操作、放宽timeout或修改生产代码。分组/support guards17 PASS、typecheck/diff PASS。

Manifest只刷新web-control-cli.test.ts并加入新fixture support hash；149文件仍packaging1/serial6/parallel142，有效测试由2954增至2955。本轮唯一candidate全部文件/用例恰好执行一次：**148/149 files、2954/2955 tests PASS，exit1；runner470.95s、外层472.11s**。packaging33.53s（1/1）→ serial66.24s（6/69）→ parallel359.22s（142/2885）；web-control-cli在serial阶段为20.44s。新test-tmp目录、存活child、listener均0，dist byte/directory不变。419个冻结source/test/support文件前后无漂移，生产src/browser-companion未改；typecheck、定向3项、manifest guards17项与diff PASS。没有正式serial full或第二次candidate，只有packaging屏障执行现有canonical build/identity检查，build仍为`c681654acc5a52572551f92b66610689c39f667e89b888bb46eb35cb4efd7f3f`。

唯一失败为`r5-web-sink-http`的missing/wrong credential 401用例：Node Fetch在HTTP请求进入handler前返回`bad port`。只读核对本机IPv4 TCP动态范围为1024起、13977个端口，包含Node内置Undici禁止Fetch访问的端口；该fixture使用`port=0`，并不保证分配到Fetch允许的端口。精确失败端口未记录，不推测其数值；未改OS配置、生产Bridge或失败fixture，也未重试掩盖失败。≤480s虽有7.89s数值余量，但exit1不能认定首目标达成，≤450s亦未达到。

**当前NEXT_EXPECTED_STEP = Planner复核CLI优化 → 新command聚焦测试专用HTTP端口/transport fixture兼容性（保留真实HTTP/auth断言，不改生产语义或OS配置）→ 新授权范围内验证candidate。** 先消除这项稳定性阻塞，再评估耗时余量与R5j-b2/e三连跑资格；本轮不推进资格验收。R5i-a仍deployed/verified，updater resilience未证明。未install/rollout/commit/push。

**Desktop授权边界（自command27起）：需要用户专有授权时，当前Desktop command先走标准BLOCKED record并终结，再请求授权；授权后的续作由ChatGPT投递新commandId。普通composer turn绝不提升为native continuation provenance。** 不补记command26，不复用其旧origin创建receipt。



### command28：新 canonical result 的降级 projection 缺口

只读现场确认command27有trusted same-origin receipt/output229（blocked）与canonical RoutingResult，Bus为空；command10 lifecycle lock仍是原0字节、无法证明owner的文件，未删除/抢占。command26只解决了已有Bus项的降级投递：prepare先执行legacy Feedback reconcile，遇COMMAND_CLEANUP_BUSY后进入readOnly cutover，而readOnly不backfill；因此command25可回流、新产生的command27却停在Bus之前。

修复将authenticated Web Sink canonical preparation排序为：严格Feedback snapshot → 独立canonical projection → 可选legacy enrichment/cutover。projection不在legacy catch内；新增projectAvailableResultBusCommands按command分组，持原lifecycle lock后重读RoutingResult，再用原enqueue事务。只隔离同command的COMMAND_CLEANUP_BUSY/COMMAND_CLEANUP_IN_PROGRESS；cleanup journal不重建，锁不抢占。Bus/routing损坏、workspace/immutable/digest冲突及其他异常仍失败；原reconcileWorkspaceResultBus继续严格行为。被跳过command已有queued Bus也不成为本次ready/reserve候选，in-flight单飞不绕过。

仅原有legacy COMMAND_CLEANUP_BUSY允许readOnly cutover降级；已有disposition严格复核，缺处置的历史counterpart仍RESULT_BUS_CUTOVER_REQUIRED，legacy in-flight/corrupt/cleanup transaction仍阻断。canonicalProjectionDegraded只含skippedCount和最多20条commandId/code，不含path/nonce/PID/正文；不是routing/GC authority。valid cleanup journal虽可单独跳过projection，legacy enrichment原有IN_PROGRESS全局拒绝仍保留，不伪装ready。

回归先red：degraded服务运行后新RoutingResult出现，旧/state仍pendingReady=0；修复后真实HTTP/state投影新项、/reserve精确一次且replay不写，旧锁/Feedback不改。覆盖自身锁/journal、Bus/routing损坏、immutable conflict、wrong workspace/route、未决/已有cutover。测试HTTP客户端复用新增test-only http-json.ts（Node http.request，agent=false，超时销毁socket）；r5-web-sink-http与cutover HTTP fixture保持真实port=0/TCP/Authorization/JSON/status断言，避开Fetch forbidden-port限制，不改OS或生产服务。

定向覆盖8 files/163 tests PASS（相关核心2文件78项、其余5文件68项、manifest17项）；首次扩大定向有1项新journal测试预期过宽，修正为保留legacy IN_PROGRESS拒绝后通过。随后唯一正式serial full：**148/149 files、2966/2967 tests PASS，exit1；Vitest841.95s/外层843.95s**。426个冻结文件前后无漂移，build为67dac3002a55b12baa86744dea84cb8ba639137b7c04751a28e91eca4ba4fe7a；新test-tmp目录0、listener0，结束采样出现的2个短命git进程后续只读复核原creation均已消失，未kill。

full唯一失败为companion-feedback的takeover/immediate-successor用例：本轮提前的route check在无Active Sink且旧Feedback epoch过期时先返回400，遮住原应优先的401。已补修为无canonical sink时先建立legacy credential authority，再检查route，均先于projection/mutation；保留原401断言和后续rebind流程。补修后companion-feedback、cutover、R5g、Web Sink HTTP共**4 files/128 tests PASS**；typecheck/canonical build/diff PASS。最终stored=computeBuildId=Core-release为**9af70c8912732a001ef7c40688e6d3116a567267288942d4f406ad297c63ff53**；没有补修后的正式full，不把定向通过冒充最终全量门禁。

本轮一次正式full限额已用完，**deployment BLOCKED**；未运行第二次full或实验candidate、未install/rollout/GC/commit/push。manifest仍packaging1/serial6/parallel142，仅刷新3个测试及新HTTP helper审计hash。关闭前只读复核command27 receipt/output229与RoutingResult hash未变、Bus仍空，command10空锁内容/file identity未变。installed/running仍c681654acc5a52572551f92b66610689c39f667e89b888bb46eb35cb4efd7f3f，故command27自动回流仍待新代码部署，未声称observed/ACK。command28以正常same-origin BLOCKED record收尾，不用--task或新ID冒充本轮receipt。

**当前NEXT：Planner以新commandId授权补修冻结代码的一次正式serial full；通过后沿用已有install/scoped-rollout授权恢复command27正常投递，再核对command28标准回执/结果，并在存在trusted证据时验证正常投影。** 不跨普通用户授权turn追补旧origin，不重录/重发command27；现役旧server仍有projection缺口，command28 canonical handoff也可能停在Bus之前，不能预报回流成功。

**NEXT（本轮回流收敛后）：GC per-release fail-closed redesign优先，区分真正global authority blocker与仅影响单release的未知reference；再恢复R5j候选验证/剩余热点。** 本轮不扩展GC规则，candidate仍experimental、三连跑未开始。R5i-a deployed/verified和updater resilience未证明保持。普通composer turn不提升为native continuation；不补记command26，不重录/重发command27。

#
### command29：最终串行门禁失败，部署停止（2026-10-03）

在 command28 最终修复快照上只执行了一次获授权的正式 `pnpm test --maxWorkers=1 --testTimeout=90000`：**149 files / 2967 tests，148 files / 2966 tests PASS，1 FAIL，exit1；Vitest 856.96s，外层859.60s**。运行前后426个source/test/support hash完全一致；新增test-tmp目录、残留child和listener均为0，无staged/conflicted文件。本轮没有修改生产、测试或support源码，也没有第二次full或candidate。

唯一失败在 `tests/bridge-provenance.test.ts:148`：真实Bridge以`port=0`监听，未认证`fetch(/admin/info)`在Node Fetch入口抛出`TypeError: fetch failed`，cause明确为`Error: bad port`。请求尚未到达HTTP鉴权或shutdown断言；实际分配端口未记录，不猜测数值。这是另一个真实HTTP fixture使用Fetch与OS动态端口不兼容的实例，不是command28修复的auth-order再次失败。本次full中companion-feedback57、cutover61、Result Bus17、R5g5、Web Sink HTTP5均PASS。按本轮失败分支约束，仅定位，不在本轮修复后追加full。

失败后只读核对stored/computeBuildId/Core-release仍一致为`9af70c8912732a001ef7c40688e6d3116a567267288942d4f406ad297c63ff53`；这不构成正式门禁PASS。本轮未另行typecheck、部署前canonical build、protect/install/GC/rollout。installed/running仍为`c681654acc5a52572551f92b66610689c39f667e89b888bb46eb35cb4efd7f3f`，PID3380；local health/authenticated admin/named public health身份一致，rollout只读gate idle=true，Desktop available、unresolvedDelivery=false、Web Sink VERIFIED。

**command27前置事实已变化**：本轮首次只读检查时receipt、RoutingResult、Bus均已不存在；installed cleanup preview（无confirm）返回`not_found / artifacts=[]`。不能再证明它与command28关闭时的output229/result hash相同，也不能把absence当Browser observed/ACK证明。本轮未重录、重发、重建、手工reserve/begin-send/ACK或清理command27；无可供恢复的本地artifact，回流原因/attempt需独立网页证据确认。command10原零字节锁的SHA256、file identity和mtime完全未变。

command29按正常same-origin `applicable/origin` 走标准BLOCKED record，最终active-turn draft仍须由terminal finalizer验证；不预称trusted receipt或canonical handoff/Browser observed已完成。未commit/push/rebind/endpoint switch，不补记command26。

**当前NEXT_EXPECTED_STEP：以新commandId修复provenance真实HTTP fixture（复用测试用Node HTTP client，保留真实鉴权/shutdown与生命周期断言，审查相邻ephemeral-port Fetch调用），并另行取得一次最终冻结后的正式full次数授权。** 通过后才沿用install/scoped rollout授权；回流健康后优先GC per-release fail-closed redesign（保留真正global authority blockers），再恢复R5j候选验收。candidate仍experimental，R5i-a已部署的历史结论保持，updater resilience仍未证明。


### command30：临时端口 HTTP fixture 修复（仅测试，2026-10-03）

command29唯一失败是provenance用例的`fetch(/admin/info)`在真实HTTP之前被Node Fetch的forbidden-port表拒绝；生产源码与auth-order补修无漂移。本轮先给原provenance用例加入禁止Fetch的确定性guard，确认RED，再替换fixture客户端；不靠碰巧分配到禁用端口或retry证明修复。

复用`tests/http-json.ts`：新增基于Node标准库`http.request`的buffered `requestHttp`，返回标准Response以保留status/headers/text/JSON；`requestJson`仍严格解析，HTML、空body和坏JSON明确拒绝。连接`agent:false`，默认10秒**总deadline**覆盖无响应/未完成body，request close清除timer；redirect仅manual，不添加自动follow或SSE/SDK适配。本轮未改生产timeout、OS端口范围，不采用固定safe port或retry-until-safe。

修复的9个suite：bridge-provenance、auth-compatibility、build-id、runtime、desktop-interfaces、write-probe、oauth、companion-feedback、r5g-cross-plugin-e2e。保留真实Bridge `port=0`、HTTP方法/header/body、鉴权status、OAuth redirect/text、安全header、JSON和生命周期断言。provenance的三个HTTP步骤均使用测试客户端，因为生产`adminFetch`同样使用Fetch；保留未认证404空body、认证200与无token泄漏，POST保留Bearer及`X-C2C-Shutdown-Reason: rollout`、5秒deadline，并验证durable intent。build-id的admin请求同理，仍验证真实server捕获build身份。

静态审计后测试源码中剩余`fetch(`为route-attestation源码字符串断言。**有意保留**SDK StreamableHTTPClientTransport及其内部Fetch、生产probeBridge/adminFetch/CLI真实客户端行为覆盖和Fetch timeout mocks：本地SDK确有fetch注入点，但还要求streaming/SSE/取消语义，本轮buffered helper不具备该完整合同，不能机械替代。故本轮证明的是直接HTTP fixture调用修复，不宣称所有间接生产/SDK Fetch路径已消除端口风险。

新增`tests/http-json.test.ts`8项：以禁止端口6000的逻辑URL进入Node HTTP，在request单元seam仅把TCP目的地映射到真实port=0 server（不绑定固定端口），验证零Fetch调用与真实401/201、method/header/body；验证text/empty/坏JSON、manual redirect/URLSearchParams、无响应/partial响应总超时、socket和timer释放。开发中发现的空404误用JSON解析、server close callback早于socket close事件及events.once因ECONNRESET提前reject的问题已修正；最终没有未处理异常或被放宽的断言。

**最终定向13 files / 285 tests PASS，exit0，Vitest100.09s / 外层102.03s；typecheck与git diff --check PASS。** 覆盖全部变更suite及r5-web-sink-http、r5d3 cutover、candidate manifest guards。427个最终冻结source/test/support文件在定向前后无漂移，生产src/Browser/package/构建脚本与本轮起点一致。新test-tmp目录0、listener0；结束采样2个短命git进程经PID+creation只读复核均已消失，未kill。

Manifest仅刷新9个已审suite hash、http-json支持文件hash，并显式新增helper测试分类：**150 files = packaging1 / serial6 / parallel143**；候选仍experimental。本轮没有正式serial full、candidate full、canonical build、install/rollout/GC、生产runtime/绑定操作、commit/push；tests-only改动不需重建Core。现有dist身份读取仍为`9af70c8912732a001ef7c40688e6d3116a567267288942d4f406ad297c63ff53`，不把旧build身份当作本轮全量或部署证据。

**当前NEXT_EXPECTED_STEP：Planner review本轮测试修复 → 新command单独授权最终冻结后的正式serial full → PASS后沿用已有install/scoped rollout授权。** 回流部署收敛后，用户要求的GC per-release fail-closed redesign仍优先于R5j候选验收；真正global authority corruption继续全局阻断。command30最后使用正常same-origin标准record，active draft的trusted commit/canonical handoff由terminal finalizer核验，不预称Browser observed/ACK；不补记旧command，不使用--task fallback。

### 2026-10-03：command29 Browser observation / command30 queued incident

用户报告回流未到后，只读确认 command30 已有 trusted receipt/output232、canonical result 与 queued Bus entry；不是 pending record 失败。command29 的 exact attempt `95d3f052-4435-4f7c-91d1-706139e341bf` 在 07:31 开始发送，08:01 因无 observed/ACK 成为 `CLAIMED_STALE/outcome_unknown`，单飞保护阻止 command30。Companion VERIFIED、owner/route exact、armed，诊断找到唯一 marker 但全文不相等。

用户提供去正文 DOM 结构证明：单个 `.rich-text-user-turn > P` 用14个BR保存15行；链接含空的block favicon，导致P.innerText比原文多1个布局换行；body外还有占位字符与按钮，使bubble增加9字符。修复只为此明确结构增加有界正文重建：现代USER证据、唯一rich body、显式文本/inline SPAN/已知外链/BR；链接只用实际可见且与其textContent完全一致的文字，不读取href拼正文。wrapper搜索64节点、正文语法128节点；隐藏正文、未知shape/样式、正文漂移、超限与歧义均拒绝。重建后仍需全文和精确ATTEMPT逐字相等，不trim、不折叠空白、不靠marker单独ACK。

新增17个确定性回归；旧代码RED复现，修复后7 files/364 tests PASS（含classic产物、late-positive原attempt ACK且零write/click/begin-send）；typecheck、canonical build、git diff --check PASS。stored/computeBuildId/core-release三方相等：`98218285087871bedd88780fdb46781406a073310d13cc7611d398697cd12898`。Core install/rollout、正式serial full未在此诊断修复执行；此前额外full次数授权仍待取得，不把定向验证当作正式full。

**本次Browser恢复live PASS（2026-10-03 09:58，Asia/Shanghai）**：扩展加载checkout `dist/browser-companion`；用户reload、刷新原页面后，通过“绑定当前对话”恢复同route的新document本地owner（未重新配对、未改服务端binding）。Companion返回`recovery.ok=true / action=late_positive_observed_then_acked / journal=NONE`，command29沿原attempt `95d3f052-4435-4f7c-91d1-706139e341bf`完成ACK，未重发。随后正常production pipeline投递command30；用户从原网页回流提供其`ATTEMPT_ID: 12b7c2e0-f50c-42ce-a0c7-08784069be62`。09:58:21只读installed stores核对两条command的delivery/receipt/canonical result/Bus均已不存在、draft/alert均为空，与正常ACK后ephemeral cleanup一致；未人工reserve/begin-send/ACK/Retire或cleanup，未重录旧command。Bridge仍为PID3380、build `c681654a…fd7f3f`，未重启或安装新Core；command10锁保留。刷新后owner恢复仍需显式本地操作，R5i-e自动同route reconnect债务未因此宣称完成。

## R5i — Bridge process lifecycle independence / host-update resilience（command15，2026-10-02）

本节是 R5h 之后的权威下一阶段，覆盖下方历史 `NEXT_EXPECTED_STEP`。用户复现了 Codex 更新后 Bridge 断开/停止；此前本机会话只读观察到 Bridge stopped，以及 Desktop `DESKTOP_PROCESS_CHANGED`，随后用户明确要求重启 Bridge、重新绑定，才恢复可用。已核对 Codex package 从 `26.928.3736.0` 变为 `26.928.4866.0`、Desktop/app-server PID/creation/executable 均变化，workspace/thread/project 未变。这证明更新兼容与恢复验收存在缺口；**现有证据不能确定旧 Bridge 的退出发起者或 kill vector**，不把时间相关性当作 Job kill 的证明。

**R5f 完成范围更正**：rollout 与 busy/approval/self-turn 等 conversation liveness 解耦、停止生产 core post-turn-finalizer、保守 legacy retirement，以及 synthetic parent-tree death 回归仍有效；command12 active-turn rollout 部署证据保留。它们没有证明真实 Codex close/restart/updater/app-server replacement 不会终止 Bridge。R5g/R5h 正向 live PASS 不撤销，也不扩展为 updater resilience PASS。

#### 产品目标与验收边界

- Codex 正常关闭、重启、更新、app-server 替换不得终止 Bridge。进程所有权必须独立于 Codex PID/tree、console、Job Object、updater 和 app-server；若 OS/updater 仍可合法终止它，须由独立机器级 owner/supervisor 自动恢复，不能等待 Codex 再启动。
- 更新只应使 Desktop runtimeFence/availability 进入待核验状态，不应要求重启 Bridge。workspace identity、named public URL/tunnel、Feedback/Companion 与 Web Sink 权威应保留。
- 新 Desktop 出现后，在可证明同一授权目标时进行 bounded automatic re-attestation；不能证明时才要求用户重新绑定。保留 PID reuse/creation/executable、workspace/project/host/thread、owner、revision 和 outcome_unknown 安全边界，不能自动选择另一会话。
- Windows 必须覆盖真实 Codex updater/process-host 路径。验收为健康 Bridge → 实际关闭/重启/更新进程替换 → URL 持续健康，或独立 supervisor 在预先约定的恢复上限内恢复 → 新 Desktop 安全识别 → fresh command 投递及回流。记录中断窗口；synthetic taskkill 不能替代此证明。

#### command15 只读取证：已知与未知

观察窗口为 2026-10-02，status 快照 `04:25:14.772Z`（北京时间 12:25）。workspace `2582910bf0d2` 的 installed/running build 均为 `77fa4757c712042a622967f520df980b2070d0c053719562ad1b8a556e8cba90`，installed full artifact 校验通过，helper 与源码字节相同。Bridge PID `17400`、startedAt `03:59:40.024Z`，named URL `https://c2c-codex-with-chatgpt.devworklink.com` health=200；Desktop available=true、unresolvedDelivery=false。重启和绑定恢复发生在 command15 之前，本轮未进行这些操作。

| 问题 | 证据与结论 |
| --- | --- |
| 1. 当前 Bridge 的 creator / spawn mode？ | Win32_Process 显示 node PID17400 的 parent PID13856 已不存在，子进程为 cloudflared PID16684。node 来自独立 Node 安装，命令入口指向当前 immutable release。无法还原 parent 的 image/creation；**helper-breakaway / helper-wmi / direct 实际模式 unknown**，不能由 parent 已消失推断 WMI。 |
| 2. 生产是否持久化启动证明？ | `src/process/daemon.ts` 的 `ensureUnlocked()` 只取 `spawnDetachedDaemon()` 的 pid，丢弃 mode；runtime store 无 mode/creator/初始 Job proof，成功路径日志也无这些信息。helper 的 `in_job` 只查询 helper 自身，不是 daemon；TypeScript 成功分支没有要求 daemon no-Job proof。installed 实现相同，是明确 observability gap。 |
| 3. parent-death tests 证明什么？ | `tests/daemon-parent-death.test.ts` 和 `tests/bridge-parent-death.test.ts` 对 sacrificial parent 执行 `taskkill /T /F`，验证 canary 死亡、daemon/真实 Bridge 存活。强制 WMI fixture 另测 daemon 不在 Job；自然模式接受 breakaway 或 WMI，未测最终 daemon Job。缺真实 updater 的 Job 关闭/进程重归属、按进程或包枚举终止、登录会话变化等实际向量与独立退出证据；这些是待区分的假设，不是已确认根因。 |
| 4. breakaway 与 WMI 是否足以解释复现？ | helper 先尝试 `CREATE_BREAKAWAY_FROM_JOB`，仅抛 OSError 才走 WMI；没有以最终 daemon Job 证明选路。现有测试注释承认某些宿主会把 breakaway node 再纳入 Job。对**当前存活 PID17400** 的正确 HANDLE 类型 WinAPI 只读探测，OpenProcess/IsProcessInJob 均成功，`inAnyJobNow=true`。只证明当前处于某个 Job；owner、limits、kill-on-close、初始 membership、实际 mode 和旧 PID18580 的 membership 均未知。不能据此断言 Codex Job 杀死旧 Bridge，也不能称 WMI 永远无 Job。 |
| 5. WMI/relay 是否依赖 Codex 临时资源？ | `daemon_spawn.py` 的 WMI 创建独立 Python relay，relay 再创建 daemon；stdin DEVNULL、stdout/stderr 文件、close_fds，环境文件读取即删除，relay/result 文件只服务启动握手，无持续存活依赖。当前 node/helper 分别来自独立 Node 安装和 C2C release，当前 Python 解析为独立 Python 安装；历史实际 Python 未持久化。`--cwd process.cwd()` 仍继承调用目录，实际 Bridge cwd 未取证；环境允许列表和绝对命令路径也需在真实 updater 下验证，不能据代码把外部配置路径永远安全当事实。 |
| 6. release cleanup 会杀死进程吗？ | `install-core.mjs` 显式安装后才做 best-effort GC；`release-references.ts`/`gc-apply.ts` 保护 current/runtime/pending/legacy authority，并经过 maintenance/rollout/start locks 与 fresh-plan。当前 release 存在并被 current pin；只读 reference graph 为 `runtime_corrupt`（strict collector schema 与 runtime 的 capabilities 字段不兼容），保守阻断 GC，未放宽或修复。没有证据表明 C2C GC 删除了运行 release，也无 Codex updater 删除 C2C release 的证据。文件被删导致未来模块/资源访问失败与进程被终止是不同故障；遗失 runtime reference 的孤立进程仍需后续审计，不能由正常 refs 推导绝对安全。 |
| 7. 是否主动因 Desktop drift 停 Bridge？ | 审核 `daemon.ts`、CLI runtime/tunnel/doctor、core rollout、server shutdown 与 stable launcher：停止入口为显式 stop/restart、配置切换、doctor --fix 的 tunnel mismatch 修复、通过安全门禁的 rollout，以及 SIGINT/SIGTERM。Desktop process changed/runtimeFence drift 返回 unavailable/拒绝相关操作，没有直接 stop/restart hook。launcher 读取 release pointer 并执行 CLI；`dev-install.ps1` 的 best-effort rollout 是显式安装路径，不是 Codex 更新监听。 |
| 8. 有独立 supervisor 吗？ | 当前源码只有按需 ensure/restart，没有机器 supervisor。可读的 Windows Scheduled Tasks、services、startup commands 中 C2C 匹配为0，排除诊断进程后的常见进程管理器检查也为0。当前部署**没有已配置且可证明的独立机器 supervisor**；不能排除名字不透明、未暴露的外部管理器，但也不能依赖它恢复。 |
| 9. 为何仍不能定位退出原因？ | Bridge 日志在 `02:40:31.652Z` ready 到 `03:59:40.049Z` 新 ready 之间没有旧 Bridge stopped、新 fatal 或 missing-file 记录，也无成功 spawn mode/Job/exit reason。无 graceful 日志不等于强制 kill 证明。只读 Windows 事件中 Sysmon 不存在、Security 不可读取；可读 WMI/Application/AppX 窗口未找到相关进程/更新事件。缺独立观察者在更新前建立的 creator、Job、shutdown request、process-exit 与 public-health 时间线，不能事后猜退出来源。 |

Windows API 边界：breakaway 受 Job/nested Job 配置约束，进程也可后续被分配进 Job；WMI 避开调用者 Job 的继承，不等于没有 provider Job/其他约束。见 [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 与 [Win32_Process.Create 的 Job 限制](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/create-method-in-class-win32-process)。本轮 `IsProcessInJob(process, NULL, ...)` 只得到 any-Job 布尔值，不能识别其所有者或终止策略，见 [IsProcessInJob](https://learn.microsoft.com/en-us/windows/win32/api/jobapi/nf-jobapi-isprocessinjob)。

#### 独立相邻问题：Browser refresh reconnect

用户另行复现同一 ChatGPT conversation 刷新后，点击一次“连接当前对话”报错。本轮不操作浏览器，尚无该次 connect diagnostic/stage，不与 Bridge 进程退出合并归因。`browser-companion/ownership.js` 在 document replacement 后撤销旧 owner；heartbeat 不继承新 owner；`connect-flow.js` 的 explicit Connect 才能在指定 flow 状态刷新 document/generation witness。`service-worker.js` 的 connect/bind 和 `content-script.js` 的启动/pageshow heartbeat 是下一轮只读诊断入口。目标是一次显式 Connect 安全取得新 document owner，并保留/重新收敛同一 VERIFIED route 的 Web Sink，无需 re-pair 或清空 local target；不能清除 outcome_unknown/route-attest fence 来伪装成功。

#### 2026-10-02：Bridge application-timeout exact-process recovery

本次独立维护复现了另一种 wedged 状态：旧 Bridge PID `15076` / creationTime `134354084469855993` 仍存在，local `/health` 与 authenticated `/admin/info` 能建立 TCP 连接，但三轮并行请求每接口各等待 8 秒均无响应。durable runtime、matching provenance、内核 executable/creation 与完整校验的 installed immutable release/实际启动 entry 精确一致；这只证明应用层无响应，尚未定位阻塞原因，也不是 Codex updater kill 的证据。标准 restart 因 `probe_failed` 保守拒绝；用户另行明确授权这一次 persistent application timeout 恢复。

终止前再次确认 command25 trusted receipt（`outputId=228`、`ok`）、Result Bus `queued`/无 attempt、无 pending receipt finalizer，当前 active turn 仅为本次普通维护，Remote 无活动开发任务；历史 ownerless thread 已有 retirement 证据。持 machine maintenance lock 后，在同一个 Windows HANDLE 上重核 PID/creation/executable/实际 entry 与 durable 文件，完成三轮探测并再次核对活动状态，仅 `TerminateProcess` 该已验证对象；等待同一 HANDLE 发出退出信号，未使用 raw PID kill、进程名批杀或 `/T`。

由 current installed stable launcher 仅恢复 workspace `2582910bf0d2`：新 PID `15256` / creationTime `134354246084915129` / startedAt `2026-10-02T14:23:29.544Z`，build 保持 `465e06cae61fddd1f8dac7bbd0de667f2174a1d62f5d51ec3e1110b359d83e3e`；local health、authenticated admin、named public health 均精确匹配新 runtime。Desktop/Feedback/Web Sink/executor binding 与其他 workspace runtime 保持；command25 继续使用已有结果，未 record、重发或手动 reserve/ACK。

**新增 R5i-c recovery 子项（协议尚未实现）**：区分 PID missing、transport refused、TCP connected/application timeout 与身份 unknown；设计显式受控的 `exact identity + persistent application timeout` 恢复协议。必须保留 bounded 多次探测、任务终态/在途状态门禁、maintenance/start locks、终止前 fresh immutable release/entry 核验、同 HANDLE 终止与原 creation 消失证明、仅当前 workspace 的 stable launcher 恢复及三处健康身份复核。PID reuse、权限/探测 unknown、身份漂移均不得 kill；不得把普通一次 `probe_failed` 自动升级为强杀。恢复后只续投已有 canonical queued 结果，不能重发 command 或清除 unknown fence。该项与 updater lifetime、Browser refresh reconnect 独立；本次手动恢复不代表自动恢复能力或根因修复已完成。

#### R5i 实施 slices（均未在 command15 实现）

| Slice | 最小实施与验收 |
| --- | --- |
| **R5i-a observability — NEXT** | 在现有 spawn/status/log 路径持久化 bounded spawn provenance：attempt nonce、实际 mode/fallback reason、creator/helper/relay/Bridge PID+creation+image identity、launcher/release/build、helper 与 daemon 各自的初始/后续 Job 探测结果（不可读必须 unknown）。配套旧 runtime schema 的兼容读取，不因新增诊断字段破坏 GC fail-closed。下次真实更新前布置独立于 Codex 的退出/health 观察：关联显式 shutdown 发起来源、exit code/时间、可获取的 Job limits/归属与 updater 事件；无权限时明确缺口。无需新常驻调度器，不记录 raw argv/env、凭据、用户正文或 command history。 |
| R5i-b Windows lifetime hardening | 根据 a 的实际证据选择并验证外部 creator；优先验证 WMI 或等价外部路径和最终 daemon no-Job/独立归属，不能以 breakaway flag、WMI 字符串或 helper 自身不在 Job 作为成功证明。覆盖自然模式、fallback、nested Job/后续 reassignment；未知不得悄悄降级 direct 并声称独立。 |
| R5i-c independent supervisor/recovery | 判断需要 Scheduled Task、Windows Service、独立 user-session supervisor 或等价机制；不预选实现。依据最小权限、用户登录/注销、同用户凭据与 Desktop IPC、独立 Job/creator、部署/升级/卸载成本和恢复时限选择。区分用户主动 stop 与异常死亡；复用 maintenance/start locks、lease、fresh runtime identity，unknown 不双启，bounded backoff，保留同一 named URL。Bridge 自己或 Codex 的子 watchdog 不构成独立 owner。 |
| R5i-d Desktop process replacement | 在 exact workspace/project/host/thread 与新 owner 均可信时，锁内 fresh revision/前后身份复核后有限 re-attest/刷新 runtimeFence；多候选或不可证明则要求人工恢复。不得漂移 frozen command target、重发 unknown 或补造 receipt；Bridge/tunnel 不为此重启。 |
| R5i-e Browser refresh reconnect | 单独捕获 connect stage、owner/document generation、canonical route、attestation 与 Sink convergence 的 bounded 诊断，修同 route 一次 Connect 恢复；保留 pair authority、VERIFIED route 与未知发送 fence。不得靠重配对、清空本地目标或 heartbeat 隐式取得发送权。 |
| R5i-f real live acceptance | 分别验证真实 Codex close/restart/update（含 updater/process-host 替换）与 ChatGPT 页面 refresh。由独立观察者记录 Bridge PID/creation/Job、原 URL 连续 health 或 supervisor 恢复窗口，明确无人借 Codex 手动重启。验证新 Desktop、fresh send/receipt/Browser observed/R5h auto-destroy；Browser 独立用例为刷新同 route 后一次 Connect 成功。测试前明确恢复时限和通过标准，不能以 synthetic parent kill 或历史 E2E 代替。 |

command15 历史 next step 为 R5i-a 源码/测试实现；其只读审计与未部署范围保持不变。下节 command16/17 覆盖当前 next step，R5i-b/c/e 仍待证据后独立推进。

#### R5i-a command16：bounded spawn/shutdown observability（source only）

- 独立 `bridge-spawn-provenance/<workspaceId>.json`，严格 version=1；每 workspace 只保留最近一次实际 spawn 的记录，新 exact runtime 替换旧记录，不修改旧 runtime schema。包含 workspaceId/canonical root、Bridge PID/startedAt/buildId、spawnAttemptId、实际 helper-breakaway/helper-wmi/posix/direct/unknown mode、helperInJob、spawner/helper/finalProcess/healthyProcess 的 PID/image/creation/any-Job/observedAt/字段错误码，以及实际 CLI entryPath/buildId。WMI 观察 FINAL daemon，不虚构 WMI service PID、Job owner 或永久独立性。
- Windows 全部 HANDLE 显式 argtypes/restype；同一 handle 读取 creation/image/any-Job 并零等待确认未退出，creation mismatch/missing 不报告 identified。Linux 用 boot ID + start ticks 与 `/proc` image，其他不可证明的字段为 null/UNSUPPORTED。探测异常不会触发第二次 spawn；未知绝不写成 no-Job。
- `ensureBridge` 仅在新 PID 健康且 authenticated admin identity、workspace、startedAt、可用 build identity 一致后落盘。已运行 legacy Bridge 不补造 provenance。`status --json` 与 authenticated `/admin/info` 仅对 exact runtime 附加 `bridgeProvenance`；absent/conflict 不改变 readiness、rollout、GC/reference、delivery 或 endpoint authority。
- 独立 `<workspaceId>.shutdown.json` 只保留最后一条关闭意图（exact runtime + reason + observedAt）。来源为 admin_shutdown、restart、rollout、SIGINT、SIGTERM 或内部 close；restart/rollout 使用可选认证 header，保留旧 shutdown URL。先记 intent 再关闭；诊断写入失败只报 bounded warning，不改变关闭行为。没有 intent 只能表示“没有 durable graceful intent”，不能证明被强杀；intent 也不等于已经退出。
- 存储采用 owner-only temp + fsync + rename、独立短写锁、提交前 runtime/旧文件身份复核；symlink/junction、路径非 canonical、损坏、未收敛 temp/锁均拒绝诊断 mutation。不回收未知锁、不建立历史数据库、不记录 token、env/argv、正文或 commandId。
- 本轮验证：6 个 focused 文件 169 tests PASS（含新增 provenance 25）；最终 helper stdio close 调整另跑 daemon-spawn 14 PASS。Python daemon protocol/teardown 为 19/13 PASS，Desktop protocol 88 PASS；typecheck/build 命令/diff-check PASS。唯一正式串行 `pnpm test --maxWorkers=1 --testTimeout=90000`：147 files / 2832 tests PASS，exit 0，854.62s。全量前显式增量 build 为 `15fd20b037236d9781fe25476ab65100af9400e849466eea819366e71bc8da59`；但全量内 packaging clean build 暴露下述既有 P2，不能把 build 命令 exit 0 当成最终 artifact 身份通过。未 install/rollout/真实 updater 测试/rebind/endpoint switch/legacy cleanup/commit/push；保留 command15 的 activity-marker 修复，不扩张 receipt 语义。

**新发现的部署前 P2（既有 build 流程，本轮未扩改）**：`package.json` 的 build 顺序是 tsc/helper → write-build-id → Browser Companion packaging。`desktop-helper-packaging.test.ts` 清空 dist 后重建，最终保存 ID 为 `15ff18f48cfa05d570ad19d8c2e9b1b264bf724a52c5135115f7fc1daee34bbd`，而所有最终 artifact 的实际 hash 是 `15fd20b037236d9781fe25476ab65100af9400e849466eea819366e71bc8da59`。`scripts/core-release.cjs` 的安装前完整 hash 校验会安全拒绝此不一致。需在部署前把 ID 发布移至所有 artifact 完成后，并补 clean-build identity 回归；本轮保持唯一正式 full，不通过事后手改 ID 隐藏问题。

**command16 当时的 NEXT_EXPECTED_STEP：Planner independent review → 修复并验证上述 clean-build identity P2 → 部署 R5i-a 可观测性 → 在独立 health/退出观察下复现真实 Codex close/restart/update。** 当前仍未实现 supervisor、自动 Desktop re-attestation 或 Browser refresh reconnect；Job owner/limits、后续 reassignment、真正 kill source/exit code 与连续公网时间线仍需下一次外部取证，synthetic parent-tree tests 不是 updater acceptance。

#### R5i-a command17：build identity 发布边界修复（source/predeploy only）

command16 的 observability slice 已获 Planner independent code review PASS；其 clean-build identity P2 在本轮修复。唯一构建逻辑改动是 `package.json` 的完整 build 顺序：tsc → Desktop helper → daemon helper → Browser Companion packaging → write-build-id。finalizer 仍先复制 Core bootstrap、package、lock 与依赖摘要，再计算完整 dist hash 并原子发布 ID；未改变 computeBuildId、安装校验或 hash 排除项。

`build:companion` 仍是 partial build，不发布/刷新完整 Core ID。若产物变化，旧 ID 与实际 dist 不一致，安装器必须拒绝；只有完整 build 才发布可安装身份。新增回归涵盖 pipeline 顺序、finalizer 快照、旧 ID 替换、Companion 三类 artifact 篡改拒绝，以及 clean build 后同源码再次完整构建的 ID/全部产物稳定性。

独立 clean-build gate 从不存在 dist 的状态执行一次 canonical `pnpm build`；旧生成目录保留于 ignored `.tooling/command17-dist-before-clean`（递归删除被工具策略拒绝后采用可恢复移出），未触及源码或安装状态。stored ID、公开 `computeBuildId(dist)` 与 installer 的 `core-release.buildId(dist)` 都精确等于 `05b4655b53e0d231db1d8bd8aa965d6fd73eec1e71eac72366657ff744e26379`。测试用进程 preload 在 build-id 原子 rename 刚完成时读取完整 dist snapshot；该快照与 pipeline 返回后的 artifact SHA256 同为 `47994ff341674c8986da227a5be8f58cb9fde0e954b905c5f827523fd280d870`，证明发布后无产物内容变化。现役 core-release 的 build/dependency hash 与 required bootstrap snapshot 只读校验 PASS；没有调用真实机器 installCore。定向 packaging 回归另验证相同源码重跑完整 build 保持同 ID。

验证：构建/安装/fork/packaging 定向 4 files / 53 tests PASS；R5i-a provenance/spawn/parent-death/runtime/rollout 定向 6 files / 169 tests PASS；Python daemon protocol 19、teardown 13、Desktop protocol 88 PASS；typecheck、clean-build identity gate 与 diff-check PASS。最终源码/测试冻结后唯一正式串行 `pnpm test --maxWorkers=1 --testTimeout=90000` 为 **147 files / 2837 tests PASS，exit 0，874.40s**。全量中的 clean/repeated canonical build 也通过同一 stored/recomputed 身份门禁。R5i-a 诊断非权威、exact runtime 绑定、unknown Job 不冒充 false、bounded shutdown intent 与 legacy absence 兼容保持不变。

**NEXT_EXPECTED_STEP：Planner independent review command17 → install/scoped rollout R5i-a 可观测性 → 配合独立 health/exit 时间线复现真实 Codex 更新。** 本轮未 install/rollout/live update/rebind/endpoint switch/legacy cleanup/commit/push。R5i-a 仍为 local/predeploy，updater resilience 尚未证明，未扩展 R5i-b/c。

#### R5i-a command18 blockers / command19 preflight 修复（2026-10-02，source/predeploy）

command18 在 protect/build/install/GC/rollout **之前**被 preflight 正确阻断。两项源码缺口：单次 2s `/health` timeout 把存活的 exact Bridge 观察为 unknown；legacy reconciliation 要求当前 output metadata 恰好 40 条，无法接受 R5h 后续正常物理删除。command18 后来的 pending receipt 修复已恢复原 draft，经标准 trusted receipt/output222 回流，用户确认收到；它不代表部署成功，也未改写原 blocked 结果。

command19 fresh 只读证据：workspace `2582910bf0d2`、Bridge PID17400 / startedAt `2026-10-02T03:59:40.024Z` / build `77fa4757c712042a622967f520df980b2070d0c053719562ad1b8a556e8cba90` 未变，本次 fast health 40ms 成功。output index `nextId=223`、39 条 IDs179–217，三条 surviving reconciliation snapshot IDs26/27/28 的 metadata/body 均缺失。修复前 status=conflict；修复后用源码只读重验均 reconciled，Desktop history 可读。相关 Desktop、execution、index、evidence 文件哈希前后相同；没有补写 metadata/body/evidence，也没有清理旧历史。

- **Health**：正常首探测仍为 2s。只有首探测失败且 saved PID 明确 present 才进行一次 8s retry，覆盖已复现 >4s stall；之后重读 PID。缺失 PID 不重试，unknown PID 不增加重试或绕过 admin auth。快慢响应共用 workspace/PID/startedAt/build 校验，build drift/缺失 expected build 不能变 healthy；双失败仍 unknown。AbortController timer 在 response body 读取后以 finally 清除，成功、失败、abort 都有确定性测试。无 start/stop/restart 副作用。
- **严格 output snapshot**：只读返回 `nextId/items/retentionThrough?`，校验 schema、递增唯一 ID、exclusive nextId、安全路径、temp residue、writer lock，以及读取前后文件 identity/stat；读取不创建目录或锁。所有 legacy reconciliation 入口复用同一严格读取。
- **比 nextId 单独门槛更强的 retention proof**：`nextId - snapshot.id - 1 >= MAX_OUTPUT_RECORDS` 只是必要条件，短命输出逐条 cleanup 或 orphan ID skip 不能证明容量曾满。新 writer 仅在真实 retention 淘汰时，在同一次 index atomic commit 保存最高被淘汰的 unowned ID `retentionThrough`；cleanup 保留此单一水位，不创建 command tombstone/history。候选还必须所有 retained IDs 都更晚，且通过原 delivery/record/snapshot/proofSha256 exact 重验，无互斥 evidence。
- **旧 index 兼容**：没有水位时，`L=nextId-1` 是最后一次已提交 output（orphan skip 发生于它之前）。当前仍保留且 ID<L 的 newer items 当时必然与 L 共存；这些项数 + 1 达到容量才证明旧 unowned output 已被淘汰。原 full-40 window 仍通过。现场 IDs179–217 共39条，加最后已提交 ID222，证明当时至少40个 newer outputs 共存；与“数量至少39”或仅水位跨度无关。旧 index 有更多 holes 且无法证明共存时继续 fail closed，不回填水位。实际新 retention 后删除 1/7/40 条的场景通过 durable eviction 水位继续证明；精确清理旧 command 本身会先删除 reconciliation evidence，不能复用它制造 authority。

最终验证：runtime 43 tests PASS；retention/output/rollout/R5h cleanup/Desktop result/receipt 定向 8 files / 313 tests PASS，合计9 files / 356 tests。typecheck、canonical build、diff-check PASS。最终源码/测试冻结后唯一正式串行 `pnpm test --maxWorkers=1 --testTimeout=90000` 为 **147 files / 2878 tests PASS，exit 0，941.46s**。本轮未改 Python，未额外重复独立 Python helper/protocol。build stored / computeBuildId / core-release 校验均为 `de7e4c248bda7bc88f4a11c93a5f2fa30f27a3111c9ba7532c40fd17cfd55933`，full 后再次核对，不安装。已有 Companion `route.js.map` sourcemap warning 在前轮 full 也存在，未影响门禁，本轮未扩展修改。新增 fake timer 测试早期的 setTimeout spy 恢复污染了后续真实 daemon 等待，已改为推进虚拟时间验证预算、移除 timer spy；修正后的 runtime 全部43 tests 在定向与 full 均通过。仅认证关闭该失败测试在 `.tooling/test-tmp` 下遗留的隔离 Bridge，没有重启/停止生产 Bridge。command19 的终态 receipt 由同源标准 record/finalizer 收尾，本节不预先宣称 trusted commit 或 Browser observed/ACK。

**NEXT_EXPECTED_STEP：Planner independent review command19 → 重试 R5i-a install / workspace scoped rollout → 部署 observability 后再安排真实 Codex updater 取证。** R5i-a 仍 local/predeploy，updater resilience 未证明。本轮不 install/rollout/GC/live update/rebind/endpoint switch/legacy cleanup/commit/push，不变更 R5h immediate auto-destroy 或旧 administrative evidence。

### command20：安装成功，scoped rollout 保守 pending（2026-10-02）

command19 Planner review PASS。部署前对457个源码/测试及已有文件的哈希核对无漂移，HEAD仍为 `cedb95c7db4e6b7174ebf1313968d33ca5f74694`，无 staged/conflict。旧 runtime PID17400/startedAt `2026-10-02T03:59:40.024Z` 的 PID present、8s bounded health、认证 admin 与 named public health200 精确一致；SOURCE command19 `assessRolloutIdle(skipSelfTurnCheck=true, ignoreDesktopActivity=true)` PASS。旧 stable status 同轮复现 probe_failed，旧 legacy snapshot26/27/28 为 conflict；新只读实现均 reconciled。output index nextId224、39项179–217、无 retentionThrough，仍由旧格式共存证明成立；index/evidence 读取前后字节不变。

protect-current成功（不GC），本轮只执行一次 canonical `pnpm build`；stored/computeBuildId/Core release 三重 ID 精确等于 reviewed `de7e4c248bda7bc88f4a11c93a5f2fa30f27a3111c9ba7532c40fd17cfd55933`。安装成功，full release/artifact/bootstrap/helper/daemon/Companion 校验通过。best-effort GC 在 initial_plan_unsafe 阶段保守退出：10候选全部 skipped，deleted0/tombstoned0/bytesDeleted0，未到 legacy finalizer retirement。只读 plan 指出当前 runtime strict schema 不兼容，以及另一个 workspace 的 runtime 引用缺失 release；本轮不修复/删除这些未知权威。

稳定新 launcher 仅对workspace `2582910bf0d2` 执行一次 rollout，返回 **upgraded0/pending1/error0，reason=named_unhealthy**。该原因发生在 named pre-shutdown 安全门禁，旧PID/startedAt/build均未变化；没有强行restart或自动重试越过门禁。随后 installed只读复核（`08:49:31Z`）公网恢复200、idle gate PASS，仍不能反推失败时是timeout、HTTP/JSON异常还是identity不匹配：现有rollout输出只保留bounded reason，缺该次request的细分证据。

当前 **installed=de7e4c24…fd55933，running=77fa4757…e8cba90；runtimeUpgrade=stale/upgradePending=true**。Desktop binding/runtimeFence、原VERIFIED Web Sink、历史delivery/admin/abandonment/retirement/reconciliation摘要、49 suppressed queued及其他workspace runtime文件前后精确不变；genuine backlog/in-flight均0，维护/rollout/start/cleanup locks及新core finalizer均0。新CLI已能读取修正后的health/retention，旧Bridge尚未加载新实现。spawn/shutdown diagnostics均absent，authenticated旧admin不含provenance；未产生新Bridge，故不存在可报告的spawnAttemptId/mode/Job probes，也没有旧runtime的rollout shutdown intent。absent不证明强杀或无Job。安装版authority目录未导入provenance诊断。

本轮只修改两份路线文档；源码/测试未改，复用command19正式full的已审快照（147 files/2878 tests），不重复typecheck/full/Python；本轮验证为canonical build、identity/full-install校验、只读门禁与`git diff --check`。标准record使用exact command20同源origin，回执与回流状态以末尾CLI/后续terminal finalizer事实为准，不预先宣称trusted commit或Browser ACK。

**NEXT_EXPECTED_STEP：保留已安装release与rollout pending，核对named health细分故障并重新通过fresh安全门禁后，再对同workspace执行rollout、采集matching spawn provenance。R5i-a未deployment verified，updater resilience仍未证明。** 未Codex真实更新/关闭/重启验收、Browser refresh/negative、endpoint switch、rebind、manual legacy cleanup、commit/push。

### command21：named public health 有界重试与精确身份（2026-10-02）

command20安装成功但rollout在named pre-shutdown门禁保留pending，未停止旧Bridge。原`namedUrl()`只有一次8s公网请求，transport/HTTP/JSON/identity失败均折叠为named_unhealthy；事后200不能还原该次失败原因。command21修复这个已确认的liveness误拒风险，并补齐原先允许public PID/start缺失、未比对build的身份缺口，不把暂态失败直接视作健康。

- `src/core/named-health.ts`仅只读探测，`rollout.ts::namedUrl()`先独立验证named tunnel state/canonical URL及已认证local admin身份。每阶段最多3次，预算5s/5s/8s，两次固定200ms间隔：传输/退避合计18.4s；preflight/pre_shutdown/postcheck三个阶段最多55.2s，另加既有本地门禁处理。timer覆盖fetch和body读取，finally释放；HTTP错误主动abort未消费body。一次exact健康响应足够，不增加连续两次要求。
- 仅timeout/network、invalid/empty JSON、5xx、429重试。429仍用固定退避，不允许远端Retry-After延长maintenance。其他HTTP（含401/403/404）立即拒绝；service/status/workspace/PID/startedAt/build的语义不符也立即拒绝，不等错误身份变为正确。
- public必须匹配SERVICE_NAME、ok、workspace和已认证local PID/start；local有build时public必须携带精确build，不能以缺字段绕过。legacy local无build仍兼容，但PID/start不可缺。只有postcheck可把完整匹配已认证旧runtime的PID/start/build视作stale_runtime并有限重试；foreign或仅部分匹配旧身份不重试，成功仍必须exact新runtime。
- 外部UpgradeReason继续named_unhealthy。rollout结果可附`namedHealth={phase,failure,attempts,httpStatus?}`，local tunnel/URL失败attempts=0；不含响应正文、headers、异常文本或额外URL。该诊断只在本次结果，strict pending schema不变，不持久化历史，也不参与授权。未保存本次CLI结果的调用者仍只能从pending读取粗分类，不能伪称有持久化细分证据。
- 失败保持现有pending流程，不清pending、不修改runtime/tunnel/Desktop/Web Sink/Bus；pre-shutdown失败在真正stop/start之前退出。测试覆盖exact初次成功、超时/网络/HTTP/JSON预算、身份缺失/不符、严格旧身份postcheck收敛/耗尽、timer释放和失败时文件字节不变，保留原wrong URL/build与其他安全门禁。

验证：定向5 files / 242 tests PASS（named-health30、rollout108、runtime43、tunnel36、bridge-provenance25）；typecheck / canonical build / git diff --check PASS；唯一正式串行full **148 files / 2919 tests PASS，exit0，946.92s**。stored/computeBuildId/Core release ID 在full前后均为 `465e06cae61fddd1f8dac7bbd0de667f2174a1d62f5d51ec3e1110b359d83e3e`；full后源码/测试冻结哈希无漂移，生产current/runtime/pending及所核对历史状态字节不变。最终source/test冻结后只执行一次正式串行full；本轮不修改Python helper。

**NEXT_EXPECTED_STEP：Planner independent review command21 → 安装包含named health修复的新reviewed build → 仅2582910bf0d2 scoped rollout并采集matching spawn provenance。** 机器仍是installed `de7e4c24…fd55933` / running `77fa4757…e8cba90`、upgradePending；R5i-a仍installed-but-not-running，updater resilience未证明。R5i-e Browser refresh仍独立。本轮不install/rollout/restart/stop/GC/真实Codex更新/rebind/endpoint switch/manual cleanup/commit/push。standard同源command21 record/finalizer另按终态证据收尾，不预先宣称trusted commit或Browser ACK。

### command22：R5i-a deployed/verified，NEXT 转 R5j-a（2026-10-02）

command21 Planner review PASS；源码/测试对正式full冻结快照无漂移，HEAD `cedb95c7db4e6b7174ebf1313968d33ca5f74694`、无staged/conflict。预检起初两次诊断自设8s admin预算超时，中间一次只读重验取得exact health/admin；随后复用现役adminFetch默认60s与源码2s+8s health分类，完整fresh preflight PASS（health+admin合计2514ms）。没有修改生产timeout或放宽auth/identity。named probe第2次成功、HTTP200、exact旧workspace/PID/start/build；maintenance/rollout/start/cleanup locks为0，Desktop available/unresolved=false，Remote/pairing/rebind安全，原VERIFIED Sink可用，genuine backlog/in-flight=0；49 queued仍为历史suppression。

protect-current成功；一次fresh canonical build的stored/computeBuildId/Core release ID完全一致，且等于reviewed `465e06cae61fddd1f8dac7bbd0de667f2174a1d62f5d51ec3e1110b359d83e3e`。安装full release/bootstrap/helper/daemon/Companion及named-health/provenance assets校验PASS。best-effort GC因initial_plan_unsafe保留10候选：deleted0/tombstoned0/skipped10/bytesDeleted0；未进入legacy finalizer retirement，未清理unknown authority。

新stable launcher仅rollout workspace `2582910bf0d2`，返回 **upgraded1/pending0/error0**，在当前Desktop turn中直接完成。旧runtime `77fa4757c712042a622967f520df980b2070d0c053719562ad1b8a556e8cba90` / PID17400 / startedAt `2026-10-02T03:59:40.024Z` 被替换为 **PID15076 / startedAt `2026-10-02T09:54:08.149Z` / build465e06ca…9d83e3e**；built=installed=running、runtimeUpgrade=current、upgradePending=false。named URL仍为 `https://c2c-codex-with-chatgpt.devworklink.com`；installed post-read第3次有界probe成功，HTTP200、exact新runtime，旧错误pending已按成功路径清除。

#### 首次真实 matching spawn provenance

installed read/status与authenticated admin返回的record精确相同：spawnAttemptId `4b8402f5-1d87-433e-93d2-1254b975afd7`，actual mode=`helper-breakaway`，helperInJob=true；record observedAt `2026-10-02T09:54:08.573Z`。四个probe均identified，process/executable/creationTime/inAnyJob四项errors全部null。

| Probe | PID | Executable | CreationTime | inAnyJob |
| --- | --- | --- | --- | --- |
| spawner | 2568 | `D:\SOFTWARE\nodejs\node.exe` | 134354084072762003 | true |
| helper | 3492 | `E:\Dev\Python314\python.exe` | 134354084467964712 | true |
| finalProcess | 15076 | `D:\SOFTWARE\nodejs\node.exe` | 134354084469855993 | true |
| healthyProcess | 15076 | `D:\SOFTWARE\nodejs\node.exe` | 134354084469855993 | true |

launch.entryPath 为机器stateDir下 `releases/465e06cae61fddd1f8dac7bbd0de667f2174a1d62f5d51ec3e1110b359d83e3e/dist/cli/index.js`，launch.buildId与runtime一致。true仅证明观察时属于某个Job，不能推断Codex ownership/kill-on-close或更新免疫；mode来自实际spawn，不是父PID事后猜测。此证据支持R5j后继续R5i-b外部creator/final Job验证，并据约束决定R5i-c supervisor；本轮不改变spawn策略。

旧77fa runtime的server代码没有shutdown recorder，因此本次旧进程无法留下durable rollout intent；shutdown文件不存在，新runtime诊断为absent，没有补写历史或伪造新shutdown。缺记录不证明强杀。未来新runtime的intent能力已部署，但本轮不额外关闭它作验收。

#### 部署后边界与验证

Desktop binding `5f03949b-e5db-43c0-a40e-9acf4c779f56`、thread `01a0f4a1-9ca9-7083-b0e8-273056aeb3c6`、project `e6c3c73a-44fe-4254-bda9-edfc5ddb6389`及runtimeFence摘要完全不变，availability=true/unresolved=false。Web Sink `fa5af5bb-7d4d-4908-b558-43fd112b05be` epoch1、Feedback binding `6135d264-e8fd-48a9-a707-7e564e707344` epoch11及原VERIFIED route保留。其他workspace runtime文件、历史deliveries/admin/abandonment/retirement/reconciliation摘要与49 suppressed queued均前后相同，core finalizer active=0，未创建新job。

新installed stable status healthy/current，source19/21门禁和legacy26/27/28均通过；output index nextId226、39项179–217，strict retention读取前后index/evidence字节不变。GC/reference/delivery/Bus/routing/endpoint/cleanup未引入provenance/shutdown authority；namedHealth细分仅在rollout结果展示，不扩展business authority。

本轮只修改两份路线文档；build/三重ID/full installed验证/只读post gates/git diff --check PASS。源码测试无变化，未重复command21已审定向242与正式full148 files/2919；未执行R5j三连跑。标准command22同源record/finalizer在收尾处理，不预先宣称trusted commit或Browser observed/ACK。

**NEXT_EXPECTED_STEP：R5j-a profiling/optimization。R5i-a deployed/verified；updater resilience仍未证明。** R5i-b/c/d/e排在R5j之后，R5i-e Browser refresh独立保留；本轮未真实Codex update/close/restart验收（仅授权scoped rollout）、Browser refresh/negative、endpoint switch/rebind/manual legacy cleanup、commit/push。

### R5h ephemeral command lifecycle（command10，2026-10-02）

本节保留 R5h 的实现与验收历史，当前下一步以上方 R5i 为准。command09 已修复 Windows daemon 测试 teardown/exit-proof race，历史验收为 protocol 3×14/14、teardown 13/13、TS 17/17、typecheck/diff PASS，production daemon helper 未改。本轮按用户新产品要求实现正常 flow 的物理销毁；这是一项 breaking semantic change：`execution_summary`/output 不再保证 completed command 永久可查，commandId 只在仍存在的 active/incomplete flow 内去重。

- 唯一正常 terminal：accepted → trusted Desktop receipt → canonical result → Result Bus → Browser exact observed/ACK。先 durable observed，再自动 cleanup；清理失败保留 terminal，不回滚 ACK、不重发。
- 新 flow 带内部 `lifecycle=ephemeral`；旧无标记 flow 保持 legacy。现有 exact14 abandonment、49 suppressed historical Bus 和 command04/05/06/07 等证据本轮不自动迁移或删除。
- cleanup_pending 只含身份、artifact 类型/ID/digest 和 phase，不含正文/summary/output。锁顺序为 command lifecycle → 独立 `command-cleanup-workspace/<workspaceId>.lock` → 各 store lock；workspace lock 不占用任何 commandId/journal namespace，`__workspace_cleanup__` 仍是合法任务 ID。锁使用 atomic wx、PID/nonce 与精确文件身份；仅 ESRCH 可回收旧 owner，live/unknown/corrupt/replacement 保守拒绝，释放时 ownership loss 显式报错。在途 writer 冲突立即 fail closed，不排队跨越 cleanup 完成。producer/reconciler/backfill 均检查同一 fence，取得锁后重读源。
- 删除顺序为 Feedback/R4 outbox/reconciliation/cutover projections → Routing command/result → Desktop delivery、receipt draft/alert/claim 和 exact legacy evidence → output body/index、execution JSONL 与共享 Feedback cursor 的 prepared/applied 调整 → executor dispatch → Result Bus observed/attempt proof → cleanup journal。每阶段只删除 exact snapshot 子集，失败保留 fence，resume 只继续删除。
- Feedback cursor adjustment 也是临时状态：JSONL 物理删除前写 exact prefix proof，删除后 delta 仅应用一次；journal durable 到 producers_deleted 后删除 adjustment。支持无关 receipt 追加，拒绝 source replacement。command-owned output 在 cleanup 前不受 40 条 legacy retention 淘汰；满容量且没有 unowned output 可淘汰时，新写入 fail closed。
- Browser 保留 exact signed attempt witness，正常 ACK 后本地 journal 清空。丢失 ACK 响应或手动强制清理后，authenticated exact `terminal_gone` 只关闭该本地 attempt，不伪称 observed；无 witness、身份不匹配或仍有 in-flight 一律拒绝。workspace HMAC key 不保存 command/attempt history，不是 completed tombstone。
- 手动入口：`pnpm dev -- cleanup command -w <workspace> --command-id <id> --json` 为只读 preview；追加 `--confirm <confirmationSha256>` 后强制删除 exact flow，明确提示外部可能已执行/发送且本机无法恢复。支持 accepted/receipt-only/claimed/outcome_unknown，摘要漂移拒绝；没有默认 `--all`，不存在项不写 tombstone。
- workspace binding、Active Executor/Web Sink、runtime fence、route verification、OAuth/tunnel、shared store 初始化权威和其他 command 保留。完成后不创建 abandonment/retirement/admin-resolution；这些入口仅 legacy compatibility。Core release references/GC 只引用机器 lifecycle authority，未新增 command pin 或 GC 旁路。

本轮 local preflight complete / independent review pending。cleanup 定向 5 files / 44 tests，Python Desktop helper 57/57、protocol 87/87、daemon protocol 14/14 均通过；最终正式串行 `pnpm test --maxWorkers=1 --testTimeout=90000` 为 143 files / 2776 tests、exit 0（746.86s）。typecheck、build 与 diff check 通过。较早的一次 full 因独立审计确认 producer diagnostic recreation race 而主动停止；修复并补确定性回归后，以最终源码快照的上述完整 PASS 作为门禁，不计中断运行。未 install/rollout/live，不是 live proof。**NEXT_EXPECTED_STEP**：Planner independent review PASS 后，按用户预授权直接 build/install（现役 best-effort GC）+ workspace scoped rollout + fresh command 正向 live proof；无需重复询问，但仍不自动 rebind、endpoint switch、negative live exercise、commit/push。R5g live pending，R5f deployment 未验证。

command11 review-fix（2026-10-02）：workspace cleanup 不再通过合法 commandId `__workspace_cleanup__` 获取内部协调锁；使用独立 namespace，嵌套 cleanup 在改 journal/store 前拒绝。复核同时补上 legacy Feedback claim/reserve/begin-send/ACK/release/retire/stale recovery 的 command fence：先锁快照中的排序 commandIds，再锁 Feedback store 并重读来源；durable cleanup_pending 期间不得继续旧预约的发送或恢复。

command10 receipt 诊断分类为 **d（失败发生当刻的上下文证据不足）**：只读 source/installed helper 均确认 command10 accepted 仍在、runtime fence 可验证；完整 canonical island 中 origin `01a0f878…` 已 failed，之后 `01a0f9ec…` 是独立 composer/completed、单 text input、非 C2C origin，strict native edge 拒绝。当前 command11 `01a0fa30…` 两版均 applicable/origin、chainLength=0，主 runner thread/session exact。两版 history.py 确不同，但普通 composer 的拒绝语义一致；不能证明旧 helper 是此次根因，也不能把 fresh command11 快照当作 command10 record-time 证明。未补写/清理 command10。CLI 无 `--task` 时现在保留 bounded discovery code/stage/原因，不再把 NOT_APPLICABLE 抹成通用缺参提示；receipt/history/ownership 语义未放宽。

command11 最终验证：R5h cleanup 共 7 files / 65 tests；含 legacy Feedback 的联合定向 10 files / 195 tests，Desktop/receipt/record 与 R5g/R5d3/R5e/R5f 联合定向 17 files / 416 tests，新增 record discovery 4 tests 均通过（定向组有重叠，不相加）。Python helper 57/57、protocol 87/87、daemon protocol 14/14，typecheck/build/diff check PASS。最终源码冻结后仅执行一次正式串行 `pnpm test --maxWorkers=1 --testTimeout=90000`：146 files / 2801 tests、exit 0（773.37s）。未 install/rollout/live/commit/push；源码仍待 Planner independent review，R5g live pending、R5f deployment pending。该验证不代表 command10 receipt 成功，也不预先声称 command11 terminal receipt 已落盘。

### R5h command12 scoped deployment（2026-10-02）

本节覆盖上方 command10/11 的 review/deployment pending 快照。Planner 已确认 command11 `CODE_REVIEW_PASS`；其 trusted receipt `outputId=216` 已只读核实。command12 predeploy 的 408 个源码/测试哈希与 command11 正式 full 前的冻结快照精确相同，HEAD `cedb95c7db4e6b7174ebf1313968d33ca5f74694` 未变，无 staged/conflict；本轮没有生产源码修改，未重复历史 full/typecheck。

- 旧 installed release `bfc4988deb9f5187c3ade685927d8d58aed52e26b7ffc42d90235794b5cdd087` 的完整校验初次失败，仅因 command11 自编 Python 只读导入遗漏 `-B` 生成 9 个 bytecode 缓存。严格排除该 exact cache 集合后两个 hash 均精确还原原绑定；现役 maintenance lock 内 fresh 文件身份/内容重检后仅移除这些临时缓存，manifest/pointer/command 不改，原 full 验证与 `--protect-current` 通过。生产 IPC 原已使用 `-I -B -X utf8`，无需修改 helper。
- 唯一 fresh build 后 generated ID 与实际 artifact 重算均为 `77fa4757c712042a622967f520df980b2070d0c053719562ad1b8a556e8cba90`；install 成功，完整 release 身份及 helper/daemon/Companion assets 核对通过。旧 checkout 存储 ID `8b8419…` 不作为部署身份使用。
- install best-effort GC 返回 `initial_plan_unsafe`，9 项 skipped，deleted/tombstoned/bytesDeleted 均为 0；没有 legacy core finalizer retirement，不扩大清理范围。
- 通过刚安装的 stable launcher 仅 rollout workspace `2582910bf0d2`，结果 `upgraded=1`、pending/error=0。Bridge 从 PID 17708 / startedAt `2026-10-01T06:26:22.948Z` 变为 PID 18580 / `2026-10-02T02:40:31.622Z`；running/installed/built ID 相同，`runtimeUpgrade=current`、upgradePending=false。原 named URL health=200，其他 workspace runtime 文件哈希未变。
- installed helper 只读确认 command12 exact origin `01a0fa67-2062-7f13-b2d7-f83cfdbe1988` 仍 inProgress、chainLength=0；rollout 直接完成，core post-turn-finalizer active=0。**R5f conversation-liveness 解耦 deployment verified**，不以 conversation idle 作为升级条件；这不证明真实 Codex updater 下的进程独立性。
- Desktop binding `5f03949b…`、thread `01a0f4a1…` 及 runtimeFence 哈希保持原样、available=true、unresolvedDelivery=false；原 Companion/Feedback binding active，Web Sink `fa5af5bb…` epoch=1、同一 VERIFIED route available。Bus/Feedback in-flight=0，49 queued 全为历史 suppression、unsuppressed queued=0；command10 accepted/no receipt 与 existing abandonment/unknown evidence 未动，未手动清理真实 command。
- installed-surface 只读检查确认 steering/history compatibility、bounded record discovery、ephemeral schema/cleanup CLI 与独立 workspace lock。对不存在 synthetic command 的 preview 返回 not_found，137 个运行时 artifact/directory 快照前后相同，零写入、零 journal/tombstone。

**NEXT_EXPECTED_STEP**：Planner 独立核对 command12 后，通过新 runtime 投递 fresh command13，验证 R5g/R5h 单次正向回流及 observed 后 terminal auto-destroy。本轮未 fresh Desktop send、Browser reserve/begin-send/ACK、endpoint switch、rebind、negative live、commit/push；R5g/R5h fresh live proof 仍 pending，不能声称 terminal auto-destroy live PASS。command12 最终标准 record 尚须由自身 terminal fence 核验，不在本节预先声称 receipt 完成。

### R5g/R5h command13 live + command14 post-cleanup verification（2026-10-02）

本节是当前事实，覆盖上方 command10/11/12 及下方 command06/07/08 的 pending 快照。**R5h fresh live auto-destroy PASS；R5g 正向 production Executor → canonical Result Bus → 当前 VERIFIED Browser Web Sink live path PASS**。仅正向路径已验证，endpoint switching、negative live 与 live replay 演练未执行。

- command13 `r5h-fresh-live-auto-destroy-proof-20261002-13` 由新 installed runtime 识别为 exact origin `01a0fa86-325e-76a0-9b30-be5c9bc27475`，零 continuation edge。标准 record 暂存 draft 后，Planner 已观察到 trusted receipt/output218 的 C2C 回流：event `cb87518d985390e11b25bd9e43d4ebb6`、attempt `c64b2e77-5bf0-4eaf-9996-0b46ad73d7c5` 到达原 ChatGPT route。command14 用 installed 的确定性 ID 函数核对该 event 精确对应 workspace/command13/iteration1，derived Bus ID 为 `72095959bd5044e625d5debb8f45cf055364f58f4ff160772557e41bbdaa2494`；外部 C2C receipt 不属于待删除的本机运行时 history。
- command14 快照时间 `2026-10-02T03:13:11.568Z`：installed full release 校验 PASS，installed/running build 均为 `77fa4757c712042a622967f520df980b2070d0c053719562ad1b8a556e8cba90`，Bridge healthy、PID 18580；Desktop binding `5f03949b…` available，原 Web Sink `fa5af5bb…` epoch1、原 VERIFIED route available，route SHA256 `c5966a9e4453be9c686ddd66f2d432d22c6aa2531823b7aa0681d803d4f98b69`。没有 rebind 或 endpoint switch。
- Stable launcher 对 exact command13 的两次 `cleanup command ... --json`（均无 `--confirm`）分别在 reconciliation 前后返回 `not_found / artifacts=[] / confirmationSha256=null`。installed inspect 的全部 19 类 command-owned artifact 均为 0：Desktop delivery、receipt draft/alert/claim、outcome/admin/abandon/legacy evidence、execution record/output、executor dispatch、Routing command/result、R4 outbox/reconciliation、Feedback、Bus/cutover。output218 metadata 与 `bodies/218.txt` 均物理缺失；cleanup journal、journal/lock/temp residue、workspace cleanup lock、Feedback cursor adjustment 均为 0，无 completed tombstone。
- 每次 preview 分别比较 141 个路径快照（117 files、23 directories、1 absent directory），SHA256/size/mtime/dev/ino/目录条目变化均为 0。零写入结论针对 preview；普通 reconciliation 可以执行既有内部锁与投影事务，不把它描述成纯读。
- Installed trusted-result reconcile 返回 `not_applicable / routing_command_missing`；Feedback projected=0、command13 events=0；Bus projected=0/replayed=59；cutover dispositionsWritten=0/replayed=50、ready=true、unsafeLegacyInFlight=0。之后 command13 仍完全缺失，没有重新投影、发送、reserve/begin-send/ACK 或 manual cleanup。
- command10 仍为 legacy incomplete accepted/no receipt；exact14 abandonment 与49 queued `legacy_observed` suppression 的摘要前后相同，未做历史 migration。此处 abandoned 不表示成功，历史 output/authority 未被伪造。

command14 仅改本文件与 endpoint architecture 文档；未改生产/测试源码、未运行测试/typecheck/build/full，文档门禁为 `git diff --check`。本节不预先声称 command14 自身 terminal receipt/Browser observed；末尾标准 record 仍由同 origin turn 的现役 fence 核验。

**NEXT_EXPECTED_STEP**：Planner 独立核对 command14 与其标准回执，收敛本轮正向 live closeout。后续 endpoint switching/negative live 或 legacy manual migration 需独立范围与授权，不据本次 PASS 自动执行。未 install/rollout/GC/rebind/commit/push。

### R5e / R5f 当前收尾事实（2026-10-01）

- **R5e 已完成** independent review、正式串行全量回归（137 files / 2699 tests），并已完成 build、install、live rollout 与 Active Executor Binding 验证；这些是当前阶段证据，不把下方历史运行快照当作现状。
- **R5f 本轮已实现** Bridge rollout 与 conversation execution state 解耦：Desktop `busy`、`approval_pending`、active/inProgress 与当前 self-turn 不再阻断 Bridge restart/upgrade；production rollout 不再调用或创建新的 `post-turn-finalizer` job。
- rollout 仍保留 install/runtime identity、maintenance lock、rollout fence、named tunnel/public URL、pending/corrupt state、Desktop identity/runtime fence、unresolved outcome、pairing 及 Remote active/unknown 等安全门禁。
- 本轮移除 core finalizer 的 schedule/spawn/run/claim/commit mutation surface；CLI `status` 与已退休的 `run` 继续只读兼容，Desktop receipt-finalizer 保持独立。
- legacy retirement 仅由 `gc --apply` 在既有 maintenance lock、rollout fence、start-lock 与 fresh-plan 门禁内执行。只有已过期且 exact job/token claim 的 PID 明确不存在（`ESRCH`）才可退休；live、unknown、缺少 claim 或未过期继续 pin，不自动修复不明 authority。
- durable retirement ledger 先落盘，再核对 active/claim 的文件身份与内容后移除 active。claim 作为旧 worker 的 `wx` 排他 fence 永久保留，result/audit 不覆盖；active 尚在仍 pin，孤立、损坏或身份不匹配状态全局阻断 GC。只读 GC 不写 retirement。
- R5f slice 仅完成源码收敛与隔离回归，已通过 Planner independent review，未发现 P1/P2；没有执行机器状态 cleanup、install、rollout 或 deploy，部署及无法证明安全的 legacy pin 处置仍待后续验证。
- 本轮验证（2026-10-01，command `r5f-legacy-finalizer-retirement-cleanup-20261001-02`）：定向 11 files / 304 tests；正式串行 `pnpm test --maxWorkers=1 --testTimeout=90000` 为 137 files / 2721 tests、exit 0（694.85s）。typecheck、build 与 diff check 通过，代码独立审计未发现 P1/P2。全量存在非阻断的 `route.js.map` 缺失诊断，相关测试通过，未扩展该打包路径。

### R5g 当前任务与 NEXT_EXPECTED_STEP（截至 2026-10-02）

- R5g 定义为当前 production Codex Executor → canonical Result Bus → production Browser Companion Web Sink 的跨 endpoint E2E，不要求第二种 Executor；Claude E1a 保持独立支线，不进入 production registry。
- gap audit 发现并修复 claimed `/begin-send` 的 frozen route 缺口：切换到 B 后重放 A 的旧 reservation 必须在返回载荷前拒绝，报 `RESULT_BUS_FROZEN_TARGET_MISMATCH`；原 attempt/target 不变。
- 同时修复 `/reserve` 的 foreign frozen in-flight 摘要泄漏；claimed/outcome_unknown 跨 route 取预约 ID 或摘要均拒绝，保持既有 HTTP 400 错误映射与 `/state` 的 bounded blocking DTO。
- 本轮补真实 MCP/backend/receipt/projection、隔离 Companion HTTP 与 Browser production runtime 的确定性 E2E；IPC 与 DOM 使用测试 seam。**local preflight complete / live pending**，不能用测试结果声明 live completed。
- 本轮验证（command `r5g-cross-plugin-e2e-preflight-20261001-03`）：新 R5g E2E 1 file / 5 tests；R5d/R5e/R5f 定向 15 files / 555 tests；唯一一次正式串行全量 138 files / 2728 tests、exit 0（707.41s）。typecheck、build 与 diff check 通过，独立只读源码审计未发现 P1/P2。既有 `route.js.map` 缺失诊断不阻断测试。
- Planner review 随后发现 reserved 阶段的 Sink 隔离 P2；revision `r5g-review-fix-reserved-route-isolation-20261001-04` 为 `/reserve` 增加 fresh Active Sink 的 bindingId/epoch/boundAt 与 authenticated route 检查，旧 stamp 返回 HTTP 409 + `RESULT_BUS_STALE_RESERVATION`；`/state` 只呈现 bounded foreign-reserved blocker。拒绝不改写预约，same-sink replay noWrite；core begin-send stale→queued→新 stamp 的路径保持不变。跨 route、同 route successor 与等价 URL 的测试已补；R5g 5 tests、cutover 42 tests 与联合定向 16 files / 562 tests 均通过，唯一正式串行全量 138 files / 2730 tests、exit 0（712.71s）。typecheck、build、diff check 通过，独立只读源码审计未发现直接相关 P1/P2；仍是 local preflight complete / live pending。
- Live closeout attempt（2026-10-01，command `r5g-live-closeout-20261001-06`）：pre-deploy blocked，live pending。只读 rollout gate 在 `assessRolloutIdle(skipSelfTurnCheck:true, ignoreDesktopActivity:true)` 下仍为 `desktop_unknown`：当前 bound thread active 已按规则忽略；历史 blocker thread `01a0d6cd-09f3-73e3-9726-4bd65df196d3` 尚未 retired，含 14 条 `accepted` 且无收敛证据，target-scoped inspect 返回 `DESKTOP_NO_OWNER`。Strict history parsing 成功，unresolved outcome=0；command04 administrative resolution 与 command05 accepted/no receipt 保持原状。installed/runtime build 均为 `bfc4988deb9f5187c3ade685927d8d58aed52e26b7ffc42d90235794b5cdd087`；Desktop availability=true、Web Sink VERIFIED/available、Result Bus reserved/claimed/outcome_unknown=0、maintenance/rollout/start locks=0、named public health=200。未 build/test/install/GC/rollout/send/rebind；不得据此声称 R5f deployed 或 R5g completed。
- command07（2026-10-01）只读全量预检在 B 阶段停止：精确冻结的 14 项与 command06 相同，14/14 均存在 intent；`src/desktop/legacy-retirement.ts` 的既有 eligibility 只接受 `intent === undefined`，故 `LEGACY_RETIREMENT_NOT_ELIGIBLE`、eligible=0/rejected=14、retirement mutation=0。target-scoped inspect 仍为 `DESKTOP_NO_OWNER`；当前 maintenance active、runtime fence 均精确匹配，strict snapshot revision=634 未变化。未发现 execution/output/retire/reconciliation/abandon/admin 冲突；command06 trusted blocked receipt `outputId=212` 保留，command04 administrative resolution 与 command05 accepted/no receipt 未改。
- 同一 workspace `2582910bf0d2` 的 Result Bus 独立只读分类：54 项（49 queued / 5 observed）；49 个 queued 全部与唯一 canonical-like counterpart 及 `legacy_observed` ledger 条目精确对应，故生产 reserve suppression=49、genuine eligible=0，ambiguity/drift/orphan/collision=0。canonical RoutingResult=54、Bus=54、缺失 projection=0；ledger 50 行的 unique Bus entry/digest/source/eventId/disposition 均一致，orphan/duplicate/compatibility collision=0；Bus/Feedback in-flight=0。Feedback ready=0；唯一 queued 项归类为 `legacy_unbegun_bus_owned`，不成为候选。R4 compatibility shadow 54/54 pending，仅用于 audit/rollback，不是 canonical Web Sink reserve queue。Production reserve 会把已验证抑制项通过 `excludeBusEntryIds` 排除；未调用 reconcile/recover/ACK/retire 或 HTTP state，机器 JSON 的前后 size/mtime 不变。
- 以上只读预检未产生 trusted receipt 或 authority mutation；末尾标准 blocked record 按 terminal fence 处理，结果须另行复核，不构成新 helper 的 live proof。未执行 build/test/install/GC/rollout/send/rebind，不得声称 R5f deployed 或 R5g completed。
- acceptance matrix 与因果链见 [R5g acceptance matrix](r5-endpoint-architecture.md#14-r5g-acceptance-matrix部署前-preflight)。
- **NEXT_EXPECTED_STEP**：由人工选择并明确授权一种已有、适用于带 intent 投递记录的处置协议；保持现有 legacy retirement eligibility gate，不得放宽 gate 或自动 abandon。Result Bus 只读分类已完成并已记录；待该处置完成且 read-only 安全门禁通过后，再执行 R5g live closeout。
- command06 在安全门禁失败处停止；本次未 build/test/install、GC、rollout、send 或 rebind，也未声称 R5f 已部署或 R5g 已完成。
- command07 的 B 阶段只读预检在 eligibility gate 拒绝后停止；末尾标准 blocked record 按 terminal fence 处理，结果须另行复核，不构成新 helper 的 live proof。

### R5g command08 收尾快照（2026-10-02）

- 本小节是当前状态，覆盖上方截至 command07 的历史 `NEXT_EXPECTED_STEP`。
- command08 已按 canonical 排序对 exact 14 项成功执行已授权的 batch abandonment：`previewconfirmationSha256=c4d935c4dea950fe29ac6bff51f32774f74d1d1e291e811ba08daf7d78118109`、`selectionSha256=6171a34ad83858f00279602e01366968c2ba940d89acb59e83477d038021f4d5`、`batchabandonedAt=2026-10-01T16:07:48.037Z`（本地日期 2026-10-02）。原 14 条 delivery 仍为 `accepted`，history 为 `abandoned/skipHistory=14`；没有新增对应 execution/output，全部 `accepted` 状态与所有 records 哈希均未变化。command04 admin、command05 accepted/no receipt、command06 `outputId=212`、command07 `outputId=213` 均保留。
- command08 的 fresh D gate 为 PASS，按规则忽略当前 active；maintenance/rollout/start locks=0、pairing=false、core finalizer active=0。Result Bus 中 49 项 queued `legacy_observed` 全部 suppressed，genuine backlog=0、ambiguity=0、observed=6。原 Sink `fa5af5bb-7d4d-4908-b558-43fd112b05be` epoch=1，`VERIFIED/available`。该轮机器快照中的 installed/runtime build 均为 `bfc4988deb9f5187c3ade685927d8d58aed52e26b7ffc42d90235794b5cdd087`，PID=17708，named health=200。
- E 阶段安装前验证遇到门禁错误后停止；没有 build、install、GC、rollout、live send 或正式全量回归。Desktop helper 57 tests 与 `tests/desktop_protocol_test.py` 87 tests 通过；项目要求的 `tests/daemon_spawn_protocol_test.py` 为 14 tests、13 passed / 1 ERROR、exit 1。唯一错误发生于 `test_relay_mode_writes_result_and_removes_env_file` 的 `TemporaryDirectory` cleanup：unlink `daemon.log` 时收到 `WinError 32`（文件被占用）。测试 body 没有 assertion failure；真实持有句柄的进程未证实，不能据此认定 production failure，也没有重跑该门禁。
- 已完成的 focused 验证为 17 files / 469 tests、exit 0（94.57s，涵盖 Desktop/result/receipt/abandonment 与 R5g/R5d3/R5e/R5f/GC/rollout）；typecheck 通过、exit 0。以上 focused 结果不替代失败的安装前门禁，因此 R5f 部署仍未验证，R5g 仍为 live pending。
- 本节记录的是最终标准 C2C record 写入前的状态快照；最终 record 的落盘与终态须以之后实际读取结果为准。
- **当前 NEXT_EXPECTED_STEP**：聚焦诊断并修复 daemon protocol cleanup/exit-proof 门禁，再开始新的 closeout。exact 14 项 abandonment 已完成，无需再次 confirm；不得为这 14 条历史 delivery 补写 receipt。command08 自身按标准 `c2c record` 与 terminal fence 收尾。

### 当前运行时观察（只读快照：2026-09-27）

- 源码 `HEAD` 与 `origin/main` 均为 `cc0d2d4c83818c01a7e9569e3d9bbe25e2534550`；该提交包含 P0.7 v2 delivery provenance 与 v3 pending-finalizer ownership re-attestation。
- workspace `2582910bf0d2` 的 `status --json` 报告 runtime `241e5d8d…df7ee`、installed/target `769cc448…af0e3`、`runtimeUpgrade=stale`、`upgradePending=true`、reason=`desktop_unknown`。运行时不是当前目标版本。
- 同一 checkout 的 `doctor --no-fix --json` 报告 `core=install_corrupt` 且 `installedBuildId=null`；独立只读核验显示 fast pointer 检查通过，但 full artifact 校验失败。status 与 doctor 对安装完整性的投影不一致，不能把 target ID 当作已验证的完整安装。
- named HTTPS `/health` 返回 200，workspace、PID、startedAt、runtimeBuildId 与 authenticated status 一致；doctor 的 named repair 不需要修复，tunnel 检查通过，但 status 附带 DNS resolver timeout 详情。post-turn finalizer 当前 inactive；最近结果是旧目标的 `named_unhealthy`，不是当前 target 的成功升级证明。
- 因此 P0.7 live manual Stop→Continue smoke 尚未运行；本观察未执行 install、修复、restart 或 rollout。后续处置须先单独诊断 install artifact 不一致与 `desktop_unknown`，并遵守新的操作授权；本快照只作 2026-09-27 历史运行态证据，使用前重新核验。

### 历史兼容债务与阶段边界

- R3 live E2E 通过后，现有 `pairingIntent`、`epoch`、`principalFingerprint`、`routeAttestation`、
  rebind predecessor/successor 语义冻结；R4 不简化或重写这些状态。
- 现有 feedback outbox 仍按 `bindingId / epoch / principalFingerprint` 定向接收，状态沿用
  `queued → ready → reserved → claimed → observed / outcome_unknown / retired_unknown`。
  R4b 建立独立的 planner-route Result Outbox 且保持该 R3 合同不变；R4c 渐进迁移旧 delivery。
- `/state` 与 `/reserve` 当前都会调用 `reconcileFeedbackOutbox()`。R4a 保持该调用和旧路径不变；
  最终 R4 不应依靠 pull 来创建 semantic ExecutionResult 或 outbox entry。
- R4b 的 Result Outbox 只使用原 persisted `Command.plannerRouteId`；不读取 Browser、feedback、
  current binding/state、`/reserve` 或 Companion，也不改 R3 feedback schema/state lifecycle。R4c 才消费
  新 planner-route outbox，并渐进迁移旧 Browser feedback delivery。
- R4b 的 reconciliation-needed 状态存于单独 routing recovery queue；本机只读 status 可发现异步失败，
  新 canonical Desktop receipt/output 写入前先发布 recovery intent；显式 reconcile-result 按 trusted receipt
  幂等恢复，且在 execution-record 锁内清除无 receipt/result/outbox 的孤立 intent。该诊断队列不投影为 Browser/feedback event。
- 旧 Companion-derived planner routes 及 legacy `bindingId` 只保留为历史 route/reference；当前
  planner authority 来自同一 MCP request 的官方 conversation principal。不能删除、迁移或把旧记录
  提升为当前 authority。
- R5f 已解除 `rollout.ts` 对 Desktop busy、`approval_pending`、active/inProgress 与 self-turn
  post-turn-finalizer 的生产耦合；旧 finalizer durable state 仅通过严格 legacy read 与锁内
  retirement 维护，GC/reference 保护保留，不代表 R5d Result Bus 的语义发生变化。
- H0 / Claude E1a 是独立的 executor extensibility 支线，不属于 R5d/f；Claude 仍未进入 production registry。

R4a 已建立显式 `rawSummary` 的 Desktop receipt 与 read-only trusted receipt → canonical
`ResultInput` 投影接缝，并通过独立 review；它本身不自动 append result，也不改 Browser production
transport 或 R5 lifecycle。R4b 已完成并通过独立 review：本机可信 receipt 收敛接线先持久化 canonical
RoutingResult，再由 routing-owned Result Outbox 引用它，并只按原 Command 的 persisted `plannerRouteId`
建立投递目标。R4c 已接入 route-pinned Browser return consumer；routed Command 走 canonical-only，
旧 projector 仅保留给没有 Routing Command 的 genuine legacy receipt。

## Baseline（2026-09-13）

- 首轮开始 HEAD：`6c93f326eeac781af26eec1797b6c22c330ae33a`，工作区干净。
  status Review 修订开始时保留首轮 8 个文件的未提交修改，本轮不覆盖这些既有成果。
- 已实现 Machine Core immutable release、stable launcher/current pointer、按 workspace 隔离的
  rollout、exact Desktop execution receipt、历史 reconciliation/retirement/abandonment。
- 首轮开始机器部署状态为 `current`，安装与运行 build 均为
  `ae5989f7367861269b270630f19f6b71dcbf523699280beafe7d8f31a437e866`。
  首轮收尾只读 status 再次确认相同 build、`current` 且无 upgradePending；
  源码构建不等于安装，安装不等于运行 Bridge 已升级。
- 本轮仅执行 C；不安装机器 Core、不重启当前 Bridge、不实现 D/A/B、不 push。

## Machine Core 历史阶段：C→A→D1→D2→B

以下记录 2026-09-13 开始的 Machine Core 阶段顺序，作为历史实现证据保留；它不是当前 R0→R5 路线。
当时顺序为 **C → A → D1 → D2 → B**（原 C→D→A→B 已因真实终态回流缺口调整）。

| 阶段 | 目标 | 状态 | 完成证据 |
| --- | --- | --- | --- |
| C0 | 测量 launcher/readCurrent 热路径时间及 I/O | done | 下方实际 v2 基线与隔离 v3 三次测量 |
| C1/C2 | trusted manifest、fast/full 验证与兼容原子发布；launcher/status 使用 fast | done | status Review 缺口已闭合，122 项定向测试通过；独立 hygiene 后全量 772/772，见下方 |
| A | 严格终态后自动反馈 EXECUTED | done | 本文下方 A 节；status 自动 reconciliation + pending/sent + Desktop durable recovery |
| D1 | 严格引用集 + 只读 GC plan | done | `release-references` + `gc-plan`；定向 21/21；见下方 D1 节 |
| D2 | maintenance lock / apply / safe delete | done | lock + two-pass apply + tombstone；定向见 D2 节 |
| B | 已证明 self-busy 的一次性 post-turn finalizer | done | structured idle + bounded finalizer + review/closeout；见下方 B 节 |
| E | 原任务 ChatGPT 对话的后台执行反馈与独立 review | preflight blocked | 2026-09-14 首轮仅做 E0 / 接收合同核验；见 [Phase E 预检](phase-e-feedback.md)，未开发生产回流 |

A/B 共享 strict terminal receipt/reconciliation，不建设万能 scheduler；B 单独使用有限生命周期
finalizer job。C/D 共享 trusted release manifest、reference graph 和 machine maintenance lock
方向；C 已完成 manifest，reference graph/维护锁扩展在 D1/D2。

## 安全合同

### C：启动性能

fast 不能冒充 full cryptographic verification。current pointer schema、
`stateDir/releases/<runtimeBuildId>` 的路径身份、manifest 与 pointer 的绑定、build-id、关键入口
和必要 bootstrap artifact 必须 fail closed。full 保留完整 dist buildId、artifact digest、
依赖快照和 symlink 边界验证；禁止仅凭 stat/cache 命中宣称完整性通过。

旧 v2 current/release 必须可启动；更新 machine bin helper/launcher 后、切 current pointer 前
的任一失败不得破坏旧 A。旧格式允许 fallback full，新格式才走 fast。同 buildId 不同内容拒绝，
checkout 修改/移动不能改变已安装 release。

### D：引用与清理

引用来源至少覆盖 current、running runtimeBuildId、pending upgrade、rollout/install/finalizer。
未知或损坏引用 fail closed。plan/apply 分离，apply 前重读引用集并在 machine maintenance lock
下核验；不得误删当前、运行中、待切换或 finalizer 所需 release。

D1 已落地只读层：`ReleaseReferenceGraph` 收集 current / runtime / runtime-upgrade；
悬空引用、损坏状态、坏 manifest、越界链接全部 fail closed。本轮无 apply。

### A：严格终态

accepted 绝不是 complete。必须匹配 exact workspace/controlSessionId/commandId/taskId/iteration/receipt；
重复、冲突或损坏历史 fail closed。EXECUTED 自动反馈只能从严格终态产生，不使用最新 test_status
或另一任务的记录替代，不重发不确定命令。

status 轮询用 `tryResolveTerminalExecutionRecord` 分类：missing / not_terminal 为 no-op，
terminal 在 executing 上自动推进 completed + pending；corrupt/duplicate/mismatch fail closed。
terminal truth ≠ feedback delivery acknowledgement：发送失败只保留 pending，不反推任务未完成。

Desktop：首次写入仍要求 exact current result context 与 accepted turn 对齐；已有 digest 一致的
终态在 context 暂时不可用（STATE_UNAVAILABLE/IPC）时只读恢复。context 可用且指向其他 turn
仍拒绝。不降低后续 turn 代记门禁。

### B：self-busy provenance

只有证明 blocker 是发起维护的当前 turn 本身时，才能安排一次性 post-turn finalizer。
清除 `CODEX_THREAD_ID`/`CODEX_SESSION_ID` 不证明 idle。真实 Desktop、approval、remote、history、
identity 与 named tunnel gates 不降低；finalizer 到期或结果不确定时停止，不常驻重试。

## 分阶段提交建议

1. `perf(core): 记录启动热路径测量基线`：本计划和开发测量工具。
2. `perf(core): 增加兼容的 release manifest 分级验证`：schema、发布与原子兼容作为一个可运行单元。
3. `perf(core): 将 launcher 切换为快速验证`：调用点、验证与安全保证文档。

这是后续审查时的提交拆分建议；本轮保留可审查工作区 diff，未执行 commit/push。
schema、发布兼容、类型和对应回归应作为同一可运行单元，不拆出不能启动的中间提交。

## 测试矩阵

| 范围 | 必需证据 |
| --- | --- |
| C0 | wall time、多次样本、readdir/stat/lstat/realpath/readFile 次数与 bytes；无绝对时间 CI 门槛 |
| 启动热路径 | 新格式 launcher 与 status 命令内不递归扫描 release/node_modules；以 I/O 断言而非计时验证 |
| 信任绑定 | pointer/manifest/releaseRoot/build-id/入口篡改均拒绝 |
| 深层内容 | 明确 fast 的保证边界；full 发现深层 artifact 篡改 |
| 向后兼容 | 旧 v2 可启动/迁移；中间 helper 更新与 pointer 原子失败后仍运行 A |
| 独立性 | checkout 修改/移动、依赖快照、symlink 越界、同 ID 冲突 |
| 回归 | core-install/rollout/build-id 定向测试；稳定后完整 Vitest |
| 必需门禁 | typecheck、build、git diff --check；未修改 Python helper 时不新增独立 Python 门禁 |
| 交付 | 当前 commandId 的 exact execution receipt 与本轮可读 output |

## V1 Desktop 版本适配流水线（已由 R2 行为证明取代）

V1a/V1b 的 exact runtime catalog 与 candidate promotion 流水线已于 2026-09-24（R2）整体退休：
Desktop 可用性改由 live 行为证明决定，Desktop 自动升级不再需要 catalog 更新或 promotion patch。
`desktop compatibility --audit` 与 handshake audit 信任分类已删除；`c2c desktop diagnose`
（别名 `compatibility`）只做只读 live handshake 描述，不做信任分类。定向门禁相应改为
behavioral send boundary（mutation boundary 前后错误语义）、attestation 与 helper/CLI 安全投影，
完整回归继续覆盖 Desktop control/result/reconcile。

## C0 实际测量（2026-09-13）

开发工具：`scripts/measure-core-release.cjs`，仅以 Node 标准库包装同步 fs API，导出
`measureReadCurrent({ helper, stateDir, mode })`，也可运行 `--self-test`。普通启动不会加载它。
`--helper` 可指定不可变旧 helper；缺失 pointer 或验证失败以非零状态退出，不把失败计为成功启动。

正式基线使用机器 `bin/core-release.cjs` 和原 v2 state；新格式使用本轮构建的隔离安装
`.tooling/phase-c/isolated-machine`，没有切换机器 current 或启动 Bridge。新构建 ID 为
`171e916d31f75dcdb1408c9f1f3ed5eba26195f5f7fa3a49be6f86aadfc0a8a8`。

环境：Node v25.2.1 / Windows 10.0.19045 x64 / 4 CPU / 16253 MiB RAM。

| 测量 | 三次 wall time（ms） | 中位数（ms） | readdir | stat | lstat | realpath | readFile | bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 原已安装 v2 / full | 3259.80 / 3219.86 / 2965.90 | 3219.86 | 1101 | 410 | 5147 | 409 | 4742 | 70,210,932 |
| 隔离 v3 / full | 4036.27 / 3455.67 / 3409.92 | 3455.67 | 1101 | 410 | 5163 | 425 | 4756 | 70,321,230 |
| 隔离 v3 / fast | 37.83 / 26.71 / 32.01 | 32.01 | 0 | 0 | 16 | 17 | 16 | 96,711 |

上述 I/O 是每次稳定计数。旧 v2 的 release 内读取 70,210,517 bytes，其中 node_modules
为 67,889,087 bytes / 4493 次 readFile / 1062 次 readdir，证实扫描完整依赖树。
v3 fast 在 node_modules 仅检查顶层目录 lstat/realpath 各一次，无文件内容读取或目录枚举；
release 内读取 96,197 bytes。它消除启动前完整树扫描，同一 v3 比 full 少读约 99.86% 内容。

复现命令（绝对机器路径用实际安装目录替换）：

```powershell
node scripts/measure-core-release.cjs --helper "<machine-state>/bin/core-release.cjs" --state-dir "<machine-state>" --mode full --runs 3
node scripts/measure-core-release.cjs --state-dir .tooling/phase-c/isolated-machine --mode full --runs 3
node scripts/measure-core-release.cjs --state-dir .tooling/phase-c/isolated-machine --mode fast --runs 3
node .tooling/phase-c/isolated-machine/bin/c2c.js --help
```

计数是 JS fs API 调用而非内核 syscall；readBytes 是返回内容字节数，不代表物理磁盘读取。
计时包含测量器包装开销、OS 缓存和当时负载，不包含 helper 加载、Node/CLI 子进程启动或后续命令。
正式旧基线测量时构建也在运行，不能把跨安装 wall-time 比值当作稳定性能承诺。
完整原始 JSON 留在忽略目录 `.tooling/phase-c/` 并纳入本轮 execution_output 摘要；
CI 断言使用“不调用 readdir”与篡改拒绝，不使用绝对 wall-time 门槛。

## C 最终 schema、调用链与兼容性

- pointer v3 严格字段为 `version / checkoutRoot / installedAt / releaseRoot / runtimeBuildId /
  artifactSha256 / manifestSha256`。`releaseRoot` 必须精确为规范的 `stateDir/releases/<runtimeBuildId>`。
- manifest v2 严格字段为 `version / runtimeBuildId / artifactSha256 / bootstrap`；pointer 保存
  manifest 原始字节的 SHA-256。bootstrap 是固定 13 项相对路径 → SHA-256 的对象，不接受删减、
  额外项目或自行选择验证集。manifest 不进入 artifactHash，避免自引用。
- bootstrap 覆盖 `bin/c2c.js`、`package.json`、`dist/build-id.txt`、`dist/cli/index.js`、
  `scripts/` 下 core-release/core-launcher/install-core，以及 `dist/core-assets/` 中上述三个脚本、
  c2c-entry.js、package.json、dependencies-sha256.txt。pnpm-lock 快照由 full buildId/artifact 保护，
  不属于启动所需 bootstrap；深层 dist 与依赖文件也不在 fast 集内。
- fast 每次重新读/hash manifest 和 bootstrap，验证 current/manifest/入口规范普通文件及
  node_modules 顶层目录身份、build-id 内容与 runtimeBuildId 一致。没有 stat/mtime 缓存、
  没有全树枚举，也不把该结果称作 full integrity。
- `readCurrent(stateDir, mode = "full")` 是唯一格式实现；launcher 显式传 `"fast"`。
  TypeScript 的 `readCurrentInstall` / `getCurrentInstall` 只透传可选 `CoreVerification` 参数，
  默认仍为 full，不复制 release 格式。`readRuntimeUpgrade` 的验证级别是必填参数：status
  调用点明确传 fast，doctor 调用点明确传 full。链路是
  `status → readRuntimeUpgrade(fast) → getCurrentInstall(fast) → readCurrentInstall(fast) → readCurrent(fast)`。
  install/publish/protect-current/rollout 保持 full。doctor 的文本和 JSON 输出统一执行 full，
  并以 `report.core` 显示完整性结果；损坏时不显示校验通过。
  开发测量工具 `--mode full` 也提供显式只读 integrity 检查；本轮不新增生产 CLI 子命令。
- 旧 pointer v2 / manifest v1 在 fast 请求下仍 full。新安装仅在 bootstrap 快照与当前
  helper/launcher 字节一致时发布 v3；旧快照保留 v2，防止旧 helper 读取新 pointer。
  已存在 release 的 manifest 不重写，重装仍 full 核对同 ID 内容。旧 v1 freeze 保留支持。
- 新 helper/launcher 更新在先、pointer 原子切换在后；新代码兼容旧 pointer，因此中间态可启动 A，
  失败恢复旧 machine bin 与旧 pointer。回归注入 pointer rename 失败并在各次 bin 更新后真实启动 A。

## Observations、风险与未完成项

- 源码确认基线路径为 `core-launcher.cjs → readCurrent → verifyRelease → buildId(dist) + artifactHash(releaseRoot)`；
  每次旧 launcher 都遍历完整 release（含 node_modules），现已由 I/O 测量证实。
- 信任根仍是本机受信任 pointer/安装程序；本地能同时改写 pointer、manifest 和代码的攻击者不在
  digest 认证能力内。machine bin 本身也属于此信任根，只能检查规范路径，不能用未验证 helper
  自证内容安全；它必须允许与旧 release 中 helper 不同，才能安全完成分步升级。
- fast 不检测深层文件内容、额外文件或后来插入的深层 symlink；这类改动可能影响下一次 full
  检查前的运行。full 的完整 digest/buildId、依赖快照发布检查与链接边界保持，不弱化或冒充。
  验证到实际启动之间仍存在本机并发改写窗口，不宣称原子执行/防本机攻击者。
- 独立审查发现 legacy freeze 的 live bin/package 复制可能跟随外链，已改为验证实际源文件
  canonical regular 身份；machine bin 与 node_modules 顶层外链也已增加拒绝检查及回归。
  最后复核补齐 `protectCurrent` 的 v1 pointer 检查，与 `readCurrent` 共用 `readPointer`，
  通过外链访问旧 current 时在任何冻结/发布前拒绝。
- 既有原子 pointer 切换不等同于并发安装事务；本轮不把 D/B 的维护协调提前实现。
- 源码 C 完成后仍须用户按既有流程部署才改变机器启动性能；本轮隔离安装不是机器上线。
- D1 只读 reference graph / GC plan、D2 maintenance lock / apply、B post-turn finalizer 均已实现；A 自动终态回流已完成源码与测试。机器部署另按既有流程。

## 本轮验证与执行记录

### 首轮实现记录（历史）

- 首轮 core-install/rollout/build-id：99/99；增加 fast/legacy 回归后：114/114。
- 增加 bootstrap 外链检查后 core-install/core-upgrade：30/30；最终新增 node_modules 顶层检查
  随完整 Vitest 验证。真实隔离 v3 launcher `--help` 退出 0。
- 完整 Vitest：45 个文件，44 passed / 1 failed；747 项测试，746 passed / 1 failed，退出 1。
  唯一失败为 `tests/activation-skill.test.ts:72` 的 Project 路由文本断言：测试要求字面 `\n`，
  Windows checkout 的 `skill/SKILL.md` 使用 `\r\n`。已核对 Skill 与测试两份文件在换行归一化后
  均与本轮 baseline HEAD 完全一致，原文断言为 false、仅换行归一化即为 true。
  这是未修改文件的既有平台断言问题，本轮不修改 Activation 或使用 retry 掩盖失败。
- full 之后仅补 v1 pointer 的共用路径检查；最终 core-install/core-upgrade/rollout/build-id
  四文件 **122/122 通过**（包括 28 项 core-install）。无新关联疑点，不重复整套 full。
- 最终 typecheck、build 均退出 0；测量器 self-test、真实隔离 launcher `--help`、diff 检查通过。
  C 实现与相关验证完成，但不宣称全库全绿或机器已部署。
- 首轮 commandId：`core-phase-c-roadmap-20260913-001`，已在对应 active turn 内写入 exact
  execution receipt，`exitStatus=failed`、可读 outputId=53；不把 accepted 当作完成证据。

### status 热路径 Review 修订

- commandId：`phase-c-reviewfix-status-hotpath-20260913-001`。Review 确认首轮只优化 launcher，
  status 命令内部仍通过默认 full 再扫描 release；首轮仅测量 readCurrent/launcher 无法证明
  status 命令级目标完成。首轮把 status full 写成预期设计不正确，本节和上方合同已修正。
- 修订期间 C 重开为 in-progress，完成后恢复 done。仅新增显式验证级别透传和调用点选择；
  v2 fallback full、fast 损坏返回 unknown、维护 full 深层篡改检测均通过定向回归。
- 命令级测试在隔离 Bridge/state 中观测真实 status（文本/JSON）、session 和 doctor
  （文本/JSON）进程的 release readdir：status/session 必须为 0，doctor 必须大于 0。
  不以 wall time 作门槛，不部署到机器或重启本 workspace 的 Bridge。
- 定向 core-install/core-upgrade/rollout 共 **122/122 通过**（28 + 9 + 85），包含 v3 fast
  无枚举、v2 fallback full、pointer/manifest/bootstrap 损坏 unknown，以及默认 full/protect-current
  拒绝深层篡改。typecheck/build 均退出 0；源码审查确认 rollout 仍调用默认 full 的 readCurrentInstall。
- 另对新编译的 CLI（build `637d9dc009c05e0d61672835916886c1250f4808ab0f6a776e879d952ae144a5`）
  复用首轮完整 v3 隔离安装，检查真实命令内部 release I/O。只设置测试子进程的 C2C_STATE_DIR，
  不更新机器 current；测试 workspace 没有运行 Bridge，doctor 使用 --no-fix。

| 实际命令 | release readdir | release readFile | release bytes | node_modules bytes |
| --- | ---: | ---: | ---: | ---: |
| status --json | 0 | 15 | 96,197 | 0 |
| status | 0 | 15 | 96,197 | 0 |
| session --json | 0 | 0 | 0 | 0 |
| doctor --no-fix --json | 1101 | 4755 | 70,320,716 | 67,889,087 |
| doctor --no-fix | 1101 | 4755 | 70,320,716 | 67,889,087 |

此表是命令内部检查，不包含独立 launcher 的 fast 检查或 checkout 模块加载；session 的 0
不表示完整启动无 I/O。常规命令不再为展示 runtimeUpgrade 增加完整扫描。
文本 doctor 对停止 Bridge/未 allowlist 的隔离环境返回 1，但 Core 完整性检查通过；JSON
doctor 返回同一诊断信息。以上命令 I/O 计数已断言并保存在 `.tooling/phase-c-status/`，纳入新 receipt output。

- 本轮完整 Vitest 只运行一次：45 文件，44 passed / 1 failed；753 项测试，
  **752 passed / 1 failed**，退出 1，耗时 381.98 秒。唯一失败仍为未改动的
  `tests/activation-skill.test.ts:72` CRLF/LF 字面断言；本轮再次验证 Skill 与测试均与 HEAD
  换行归一化后的内容一致，未修改、重试或掩盖该问题。
- typecheck、build、git diff --check 均退出 0。实现与命令级目标已完成，但全库仍非全绿；
  新 commandId 的 receipt 保持 `exitStatus=failed`，附本轮独立可读 output。
  仅修改 docs 三份、src/core/install.ts、src/core/upgrade.ts、src/cli/index.ts 和
  tests/core-upgrade.test.ts；保留首轮其他 dirty 文件。未部署、commit/push、reset/stash 或启动 D/A/B。

### 独立 CRLF/LF 测试 hygiene 修复

- commandId：`fix-crlf-baseline-portability-20260913-001`。仅调整
  tests/activation-skill.test.ts 的输入/解析边界和本计划，不修改 Skill 业务文本或 Phase C 实现。
- 修复前重新运行该文件：18 passed / 1 failed（19 项），退出 1。实际 Skill 含 1326 个 CRLF；
  原字面 LF 断言不匹配，仅内存换行归一化后匹配，确认根因。
- 将契约分别应用于内存中的 LF、CRLF 输入，解析前统一为 LF，既有断言保持原样；
  不做磁盘换行转换，也不将断言改成宽松文本匹配。
- 状态：**done / green baseline**。定向测试首次修复后运行：LF、CRLF 各 19 项，
  共 **38/38 通过**。完整 Vitest 仅运行一次：**45 文件、772/772 全部通过**，退出 0，
  耗时 369.72 秒；无 retry，也没有通过修改 Skill 内容或弱化断言获得绿色结果。
- typecheck、build、git diff --check 均退出 0。修改前保存已跟踪文件及首轮新文件的
  SHA-256，最终核对 139 个文件，仅本测试与本计划变化；Skill 业务文本和 Phase C 源码
  字节一致。测试文件保留原有 CRLF 文件风格，LF/CRLF 输入转换只发生在内存中。
- 本次写入独立 exact execution receipt 和可读验证 output，保留前两轮失败记录的历史事实。
  未部署、dev-install、rollout、重启 Bridge、commit/push 或 reset/stash；D/A/B 未启动。

### A 自动终态回流（done）

架构决策：terminal truth 与 feedback delivery acknowledgement 解耦。

```
Execution terminal truth (JSONL ok/failed/blocked)
  → tryResolve 分类 (terminal | missing | not_terminal | throw)
  → status 自动 reconciliation (executing → completed + pending)
  → pending feedback 持久化
  → 发送 EXECUTED
       ├─ success → sent + feedbackMessageId
       └─ failure → 保持 pending，下一轮 recover/status 继续
```

实现要点：

- `tryResolveTerminalExecutionRecord`：missing/not_terminal 为 no-op；corrupt/duplicate/
  identity mismatch throw，不靠错误文案分支。`resolveTerminalExecutionRecord` 复用同一分类。
- `webControlStatus`：锁外分类，仅 terminal 需要写盘时进入 `changeControl`；
  `applyTerminalReconciliation` 是纯状态 helper，不递归 updateSession、不重新 enable。
- pending/sent：legacy 仅有 feedbackMessageId 可读；同 ID 再次确认规范化为 sent；
  不同 messageId fail closed；pending 不允许携带 feedbackMessageId。
- Desktop late-result：已有 exact terminal + digest 一致时，context 暂时不可用可只读恢复；
  首次写入与“context 可用且指向其他 turn”仍 fail closed。不删除 currentResultContext 门禁。
- Skill：status 自动发现 terminal 并返回 pendingFeedback；正常路径不要求手工 reconcile CLI。
- CLI：`web-control status` 输出 `pendingFeedback`；`recover`/`reconcile` 保留作诊断。

真实故障案例对应：

- Web Control boot messageId 拿不到 → 不阻塞 terminal；terminal 独立于 boot 确认。
- Desktop 晚于 context 窗口 → 已有终态可恢复；未写入且 context 已永久离开仍 fail closed
  （历史 unresolved，走既有 reconciliation/abandonment，不降低 turn 门禁）。
- 只有 accepted → 不 complete。
- 反馈发送失败 → 保留 pending，不重执行。

#### 2026-09-13 A 完成核对

- 代码：changed-and-verified。strict resolver、status 自动 reconciliation、pending/sent、
  Desktop durable prior recovery、Skill 自动回流说明均已落地。
- 运行态：pending。机器部署未更新本轮 dirty checkout。
- 文档：changed-and-verified。本计划与 Skill 已同步。
- 规则：verified-current。不 reset/stash/commit/push。
- 工作区：保留 Phase C、CRLF、D1 与 A 的未提交改动。

### D1 只读 reference graph + GC plan（done）

分层：`release-references`（引用发现）→ `gc-plan`（disposition）。本轮只读，无删除。

#### Reference graph

`collectReleaseReferences(stateDir)` 产出：

- `references: Map<buildId, ReleaseReference[]>`
- `referencedBuildIds`
- `issues[]` + `ok`
- kind 可扩展：本轮 `current` / `runtime` / `runtime-upgrade`；collector 列表结构上可追加
  install/rollout/finalizer，不为 B 伪造不存在状态。

收集规则：

| 源 | 校验 | 引用 |
| --- | --- | --- |
| current | 现有 `readCurrentInstall(stateDir,"fast")` 严格 identity | `current` |
| runtime/*.json | 文件名与 workspaceId 一致；strict schema；必须有 runtimeBuildId | `runtime:<ws>` |
| runtime-upgrades/*.json | 与 UpgradePending 等价 strict schema；workspace identity | `pending:<ws>` |

#### Fail-closed 规则

- runtime/pending 损坏、identity mismatch、文件名非 canonical → issue
- 引用了不存在的 release（dangling）→ issue，**不是可忽略悬空**
- current 指针无效/损坏 → issue；此时无法证明任何 release 是 current，相关 release 不得 keep
- release 根非真实目录 / symlink / 非 canonical realpath → unknown
- release.json 缺失、非严格字段、version 无效、runtimeBuildId≠目录、artifactSha256 无效、
  v2 bootstrap 键集或摘要格式错误 → unknown
- release 内链接越过 releaseRoot → unknown
- **任意 issue → 全局阻断**：所有 delete-candidate 降为 unknown，`bytesCandidateReclaimable=0`

#### Logical size

安全锚点永远是整个 releaseRoot（递归不把子目录当新根）：

- 普通文件：stat 大小
- symlink/junction：目标 realpath 必须在 releaseRoot 内；只计 link 自身 lstat 字节，
  **不跟随、不重复 target**
- 目录：同一 anchor 递归；visited realpath 防环；目录链接不跟随

#### GC plan JSON 契约

```json
{
  "ok": true,
  "stateDir": "...",
  "releases": [{ "buildId": "...", "path": "...", "disposition": "keep|delete-candidate|unknown", "reasons": ["current"], "logicalBytes": 0 }],
  "issues": ["source: message"],
  "totals": {
    "releaseCount": 0,
    "bytesKept": 0,
    "bytesCandidateReclaimable": 0,
    "issueCount": 0,
    "unknownReleaseCount": 0
  }
}
```

reasons 稳定标签：`current`、`runtime:<workspaceId>`、`pending:<workspaceId>`、
`manifest_mismatch`、`global_unknown_reference` 等。`c2c gc` 必须 `--plan` 或 `--dry-run`；
二者 disposition 等价。无 `--apply`。

CLI exit contract：`plan.ok === false` 时，**text 与 `--json` 都必须非零退出**；
JSON body 仍完整输出，不因 exit 1 丢失机器可读 plan。健康 plan 退出 0。

#### D1 验证

- 定向 `tests/gc-plan.test.ts`：**21/21 通过**（含悬空引用、坏 manifest、身份不匹配、
  symlink 越界/内部/环、只读、CLI exit contract）
- typecheck / build / git diff --check：通过

### D2 安全 GC apply + machine maintenance lock（done）

#### Maintenance lock

- 原语在 `scripts/core-release.cjs`（`tryAcquireMaintenanceLock` / `withMaintenanceLock`），
  TypeScript 经 `src/core/maintenance-lock.ts` 的 `createRequire` 复用，不复制第二套协议。
- **fresh-state bootstrap**：acquire 自己 `mkdir -p stateDir`（0700），不依赖 caller 预建目录。
- 文件：`stateDir/maintenance.lock`，`wx` + 0600。
- metadata：`version/operation/pid/startedAt/token`。
- 已有 lock → 稳定 `MAINTENANCE_BUSY`；**绝不按时间/PID 偷锁**。
- release 仅在 token 匹配时 unlink；被替换/无法证明归属 → fail closed，不 unlink。
- **unlink 实际失败** → `release()` 返回 false，不宣称 released；`withMaintenanceLock`
  抛 `MAINTENANCE_RELEASE_FAILED` 并附 `result`。destructive GC 若已发生则保留 items，
  但整体 `ok=false` + `maintenance_release_failed` issue。

#### Inherited handle 验证

`assertMaintenanceHandle(stateDir, handle)` 必须通过才能把 handle 传入 `ensureBridge`：
- `handle.path === canonical stateDir/maintenance.lock`
- lock 文件必须是 regular file（非 symlink/junction）；realpath === canonical path
- metadata 精确五字段 `version/operation/pid/startedAt/token`；`version===1`；pid 整数；
  operation 非空；startedAt 严格 ISO；token UUID
- `metadata.token === handle.token`
- mismatch / missing / replaced / extra field → `MAINTENANCE_HANDLE_INVALID` fail closed

#### Startup lease（封死 direct serve 绕过）

所有生产 bridge-start 路径在「准备启动 → runtime reference 落盘」区间必须参与同一 fence：

- `ensureBridge` parent：持有 maintenance + start.lock（nonce），经 env `C2C_STARTUP_LEASE`
  传给 spawn 的 `c2c serve` child。
- child：`consumeStartupLeaseFromEnv()` 读取后立即删除 env；`claimStartupLease` 做
  **跨进程 one-shot claim**（`startup-leases/<ws>.<leaseNonce>.claim`，`wx`）；
  已存在 claim → `STARTUP_LEASE_REPLAY` fail closed。
- parent 在 ready/failure 后 `cleanupStartupLeaseClaim`；crash 留下的 claim 人工恢复，不 steal。
- 无 lease 时 direct serve **自己** acquire maintenance + start.lock，runtime persist 后释放。
- start.lock 为 owner-safe `StartLockHandle`：strict metadata，release 仅在 workspaceId+nonce
  匹配时 unlink；失败返回 false，调用方必须暴露。

#### Maintenance release 语义

共享 `releaseMaintenanceOrThrow(handle, { result, actionError })`：
- 成功 action + release false → `MAINTENANCE_RELEASE_FAILED`，error.result 保留证据
- action 失败 + release 失败 → 保留原始 error，`cause` 挂 release failure
- token mismatch / unlink 失败 → 不 unlink 他人 lock；lock 留给人工恢复

rollout / ensureBridge / withMaintenanceLock / serve standalone 均走该 helper。

rollout / GC 共用 `rollout-fence.ts`：`tryAcquireRolloutFence` + `releaseRolloutFence`；
legacy 文件只视为 busy，不解析 steal。

#### Install / rollout / bridge-start fencing

| 操作 | fencing |
| --- | --- |
| `installCore` | 全程 maintenance（publish → bin → current switch） |
| rollout | 先 maintenance，再 `rollout.lock`；固定顺序 maintenance → rollout |
| `ensureBridge` | start.lock + maintenance（caller 未持有时自取；inherited 须 assert） |
| rollout → restartBridge | 传入已持有 maintenance handle，避免 nested deadlock |

Bridge start 关键区间持有 maintenance，因此与 apply 互斥；`*.start.lock` 不再被
reference collector 当作 corrupt runtime。

#### Apply 算法（两观察 + lock + atomic rollout fence）

```
initialPlan = planGc()          # 必须 ok
acquire maintenance
  atomically open rollout.lock (wx)  # 整个 destructive section 持有
    any start.lock? abort
    freshPlan = planGc()       # 必须 ok
    freshCandidates === initialCandidates
    per-candidate: hook → revalidate → rename tombstone → no-follow delete
  release rollout.lock            # close/unlink 失败 → ok=false + rollout_fence_release_failed
release maintenance             # 失败 → ok=false，保留 items
```

- 绝不信任旧 plan；D1 `GcPlan` 只是观察，不是删除授权。
- **GC 真正持有 `rollout.lock`**，不是只检查 existence：legacy rollout 已运行则 EEXIST abort；
  GC 持有时 legacy `openSync(wx)` 失败。
- 新 candidate / 消失 / current·runtime·pending 变化 → `stale_candidates`，不删新 candidate。

#### Tombstone / delete

- `releases/<buildId>` → atomic rename → `gc-trash/<buildId>.<nonce>`
- `gc-trash` 必须 canonical 真实目录
- `removeTreeNoFollow`：仅允许删除 `gc-trash` 锚点内；symlink unlink 自身，不跟随
- cleanup 失败 → `status=tombstoned` + 非零；`bytesDeleted` 只计真正完成删除

#### GcApplyResult 契约

```json
{
  "ok": true,
  "stateDir": "...",
  "mode": "apply",
  "items": [{ "buildId", "status": "deleted|tombstoned|skipped|error", "logicalBytes", "reason" }],
  "issues": [],
  "totals": { "candidateCount", "deletedCount", "tombstonedCount", "skippedCount", "bytesDeleted" }
}
```

#### CLI / doctor

- `c2c gc --plan | --dry-run | --apply` 互斥；各自 `--json`；plain / 组合拒绝。
- apply `ok=false` → text 与 JSON 均非零，JSON 仍完整。
- doctor 报告 `gcPlanSummary` + `maintenanceLockBusy`；**doctor --fix 绝不 apply**。
- status 热路径不扫 GC。

#### D2 验证（含 Review fix）

- `tests/maintenance-lock.test.ts`：含 fresh-stateDir install、assertMaintenanceHandle、release failure
- `tests/gc-apply.test.ts`：含 atomic rollout fence、真实 stale 断言
- `tests/bridge-maintenance-fence.test.ts`：GC-held / inherited handle / forged handle / apply∩ensureBridge
- `tests/gc-plan.test.ts`：21/21（D1 不回归）
- 完整 Vitest：见收尾

## NEXT_EXPECTED_STEP（历史记录）

历史源码阶段 C/A/D1/D2/B 已完成；其中 A 的 pending/sent 状态机制不等于无 DOM 的生产回流。
此前部署验收只对应各节记录的 build，不能代表后来所有源码均已在机器收敛。

以下为历史记录，不能覆盖后续 E1b3/E1b3d3b2 收官事实。2026-09-14 Phase E 首轮核验：干净 `main@dcf8db0` 与实时 origin/main 一致；当前源码运行产物、
installed/runtime 均为 `30cd260920fc8a2fc44ef00874c7f4a323f14108375d5ed0237807d3ece3051e`，
完整 release 校验和 128 项内存 emit 比对通过，本地及 named 公网健康。
但 `upgradePending=true / named_unhealthy` 仍保留，latest finalizer
`c5d31ea0-fcab-4058-8726-5af43b8227d8` 为 blocked，无 active job。本轮按已运行正确目标的规则
只读确认，未重新安装、rollout 或重启；**E0=blocked（遗留维护状态尚未收敛）**。

**RECEIVER_GATE=BLOCKED**：Workspace Agents 官方资料未证明进入指定已有普通 ChatGPT conversation
和最终可见消息回执；另有用户已确认的测试配置缺口（本轮尚未提供或确认测试目标/专用凭据）。
两类阻塞分开记录，补 token 不能解决路由缺口，也不据此断言整个 Phase E 不可行；真实事件/E2E 均为 0。
下一步先补齐原目标接收合同、账户与目标映射，明确遗留 pending 的限定 workspace 收敛范围；
条件成立后才做有限只读接收探针。独立 Agent 对话需用户确认需求变化。
生产 outbox、常驻 feedback pump、自动 revision 和 scheduler 不进入下一轮开发。
详细证据、能力矩阵及本轮普通 record 身份见 [Phase E 预检](phase-e-feedback.md)。

### B：strict post-turn finalizer（历史实现；R5f 后仅 legacy compatibility）

本节保留 B 阶段的 durable schema、worker、ownership 与 GC 历史证据。R5f 之后，正常 `rollout`
不会再 schedule/spawn 新 finalizer；旧 worker mutation exports 已移除，现有 active/result/claim 仅按兼容入口读取、审计和锁内 retirement 收敛，
旧 active reference 仍然保护对应 release，直到后续明确的 retire cleanup slice。

**不是 generic scheduler**，只处理已证明的 self-busy。

#### Self-busy proof

`assessRolloutIdle`（normal rollout 与 finalizer 共用）产出结构化 `RolloutBlocker[]`：
self_turn 最后评估；同 self-thread 的 desktop active 不重复记 desktop_busy。
outcome_unknown 与原逻辑一致，不再 inspect。

仅当 **blockers 严格等于一个已 Desktop 证明的 self_turn** 才允许 schedule：
- CODEX_THREAD_ID + cwd workspace 匹配
- binding.threadId === origin
- `desktopIpc.currentExecution(workspace.root)` exact thread/host/project/root → runtimeStatus active/inProgress；普通 inspect 的 DESKTOP_BUSY 本身不授予 self proof

pairing/approval/other-desktop/remote/unproven → 普通 `pending_busy`，不 schedule。

#### Finalizer state / result

- active：`stateDir/post-turn-finalizers/<ws>.json`（strict，0600，atomic）
- result：`stateDir/post-turn-finalizer-results/<ws>.json`
- worker claim：`post-turn-finalizer-workers/<ws>.claim`（wx）
- commit 顺序：exact ownership → durable result → owner-safe 删 active
- unlink 失败 → `FINALIZER_ACTIVE_RELEASE_FAILED`（附 result）；active 保留 fail closed
- active target → release reference `finalizer:<ws>`；corrupt/dangling/workspaceRoot 错配全局阻断 GC
- result alone 不产生 release reference

#### Worker

- exact `node <target-release>/dist/cli/index.js post-turn-finalizer run`
- env 仅清 `CODEX_THREAD_ID` / `CODEX_SESSION_ID` / `C2C_STARTUP_LEASE`
- origin inspect 返回 DESKTOP_BUSY 或 active/inProgress → wait；仅实际 idle → preconditions + **normal** `rollout()`；其它错误仍 fail closed
- **rollout 前再次** `assertActiveJobOwnership`（precondition await 期间可丢失）
- 非 self-busy blocker 一律 terminal，不重试
- CLI orderly exit（含 owner-lost）在 finally 幂等 `releaseClaim()`；false → exit 1
- execution projection：`post_turn_<jobId>`，无 fake commandId/controlSession

#### UX

`c2c post-turn-finalizer status -w <ws>`；rollout item 可选 `finalizer:{jobId,status}`，
counts 契约兼容。

#### B Review / closeout

- 新 scheduled job **自动** spawn detached worker；existing 不再 spawn
- schedule `assessment` 必填；无 `assessRolloutIdle(workspace, null)` 绕过
- active 创建 `wx` no-clobber；identity 比较含 origin/runtime
- rollout 拿到 maintenance 后 **reconfirm** current install（`install_changed`）
- deadline = `job.expiresAt`；origin active → `wait`（`origin_still_active`）
- expectedRuntime 核对 build/pid/startedAt；pending reason 必须仍为 `busy`
- target entry canonical + current==target；strict finalizer schema 共享
- spawn 失败 → `worker_spawn_failed` result，ownership-checked commit，无 bypass
- result corrupt → `FINALIZER_RESULT_CORRUPT`；workspaceId 不匹配同码
- `rollout({ finalizerSpawnImpl })` 测试注入；生产默认真实 spawn

#### B 初始验证（历史基线）

- `tests/post-turn-finalizer.test.ts`：25/25（含 real rollout integration、
  precondition ownership 丢失、cleanup failure、strict reference）
- rollout / gc-plan / gc-apply / install / fork 回归全绿
- 完整 Vitest：**54 files / 896 passed / 0 failed**
- typecheck / build / git diff --check：通过
- 未部署、未 commit/push/reset/stash；未对真实机器执行 apply/rollout/restart

#### B real-protocol hotfix 与真实部署验收（2026-09-14）

- 定向 post-turn-finalizer + rollout：116/116；typecheck / build / diff-check 通过。
- output59 已通过 6 文件 / 82 tests，output60 通过剩余 48 文件 / 820 tests，共同覆盖当前 54 文件 / 902 tests；并非一次完整运行。
- 真实 dev-install -Test：53 文件 / 892 tests 通过（按脚本排除 fork-scripts），exit 0。
- 安装目标：`5b7733849f334d1bc75b88d7dcd065cfc169d098b644a714b9ef4a4504cccf2c`。
- 部署 turn 中保持 pending_busy / busy；production finalizer job `4aa51c07-bcaf-47f3-bed3-37cc358e9580` 已 scheduled。
- 后续 turn 只读确认该 job terminal `ok / upgraded`，finishedAt `2026-09-14T04:42:01.564Z`；status 显示 installed/runtime 均为上述目标，state=current，upgradePending=false。
- 此证据对应上述已安装 build；后续源码审查修订不代表机器已再次部署。

#### 最终提交审查修订

- 安装拒绝 machine bin 目录外链；GC runtime/pending 引用验证 canonical regular file 与 workspaceRoot 身份。
- 修订后 core-install 29/29、gc-plan + gc-apply 50/50；typecheck / build / diff-check 通过。
- 此次源码修订验收时未重新部署；2026-09-14 Phase E 的后续机器观察见
  [Phase E 预检](phase-e-feedback.md)，不得将本条历史状态当作当前机器结论。


## Phase E UI 探针 + E1a production feedback（2026-09-15 收官，未再部署）

- synthetic probe：默认关闭 `C2C_ENABLE_FEEDBACK_PROBE`；scope `feedback.probe`；UI `ui://c2c/feedback-probe/v4.html`
- production outbox：永久 scope `codex.feedback`；`stateDir/feedback/<ws>.json`；Desktop terminal → `C2C_EXECUTED`
- 验证：**57 files / 973 passed**；typecheck / build / `git diff --check`
- **not deployed**；next transport = browser companion

过程与终态详见 [phase-e-feedback.md](phase-e-feedback.md)。

## Phase E1b0 companion 委派 + reserved 状态机（2026-09-15，代码完成未部署）

- 状态机：`ready → reserved → claimed → observed|outcome_unknown`；reserved 可 release/stale→ready；claimed 仍不可逆
- 委派：one-time pairing intent → scoped companion credential（hash 存储）；绑定 `https://chatgpt.com/c/<id>`
- re-pair：有 in-flight（reserved/claimed/outcome_unknown）时 fail closed，禁止跨 companion 继承 attempt
- 公共面：`/api/companion/v1`（pair/state/reserve/release/begin-send/ack），经 tunnel；不弱化 MCP/admin
- MCP：`feedback_companion_pair|status|revoke`
- 验证：**58 files / 992 passed**；typecheck / build / `git diff --check`
- **not deployed**；不写 MV3/DOM；runtime 仍 pre-E1a

## Phase E1b1 Edge-first passive companion（2026-09-15，代码完成 + 真机验收通过，未部署 Bridge）

- 统一 route：`src/chatgpt/route.ts`；支持 `/c/<id>`、`www.`、`/g/g-.../c/<id>`（Project/GPT）
- MV3：`browser-companion/` → `dist/browser-companion`；permissions=`storage`+`activeTab`；hosts 仅 ChatGPT
- document ownership + popup 显式 Bind；SPA 轮询；只读 DOM adapter（未知不安全）
- ownership review-fix：popup status 经 content→SW；同 tab 换 document / 缺 documentId 清 owner
- **Edge 真机被动验收通过**（真实 Project conversation bind/reload/tab-switch；无 Send）
- **不** composer 写 / native Send / reserve / begin-send / Bridge deploy
- 验证：**60 files / 1024 passed**；typecheck / build（含 companion）/ diff-check
- **Bridge runtime not deployed**（extension 本机验收 ≠ Bridge rollout）
- next：**E1b2**

## Phase E1b2 transport + reversible reservation（2026-09-15~16，**code + server deployed**；live full-path **pending**）

现役（2026-09-16）：

- SW-only Bridge HTTP + credential；`TRUSTED_CONTEXTS`；optional host permission
- Pairing：exact owner + ownerProof；secret 仅 popup 内存；paste pairing JSON；origin local / intentId session
- Journal：`NONE → RESERVE_REQUESTED → RESERVED | RESERVATION_RECOVERY`；无 SEND_INTENT
- `/api/companion/v1`：pair/state/reserve/release；`companionApiUrl` 强制前缀
- fetchCompanion 保留 `Response.ok`；DOM idle：Stop 优先 + `text-submit-btn-text` action slot（generating 实证已锁）
- **已部署** Bridge runtime `637edb28`（workspace-scoped rollout）：认证后 `/state`、`/reserve` 自主 `reconcileFeedbackOutbox`，无需 MCP 踢一下
- MCP production feedback tools：**model-visible**（`ui.model` + `openai/visibility=public`）；OAuth `codex.feedback` 未放宽
- **不** begin-send / ack / composer / native Send
- 门禁：**61 files / 1059 passed**
- **live transport 端到端**（pair→state→reserve→release 在真机 Edge 完整通过）**仍 pending**；下一阶段 E1b3 在 Send 边界前必须先完成 live 验收

## Phase E1b3d3 production Send + late-positive ACK（2026-09-17，现役）

- Browser companion：显式 one-shot production Send（idle-only preflight）；durable journal 至 `OBSERVED_PENDING_ACK` / `OUTCOME_UNKNOWN`；**零自动重发**
- Late-positive：`OUTCOME_UNKNOWN` 仅在 exact server claimed/outcome_unknown + exact DOM user turn 时 `OBSERVED_PENDING_ACK → /ack → NONE`
- Trusted MCP ACK：`claimed|outcome_unknown` + exact attempt → `observed`；`observed` same-attempt 幂等；`retired_unknown` 拒绝
- Server-observed local closeout：authenticated `/state` exact observed proof + `inFlight=null` → SW clear local journal（零 DOM/ACK）
- Popup Recover：结构化 `ok/reason/action/zeroWrite/zeroClick/journal.*` + bounded diagnostic（无 message/credential）
- **Core deployed**：workspace `codex-with-chatgpt` build `6349ad98…`；live server event `observed`
- 详细终态见 [phase-e-feedback.md](phase-e-feedback.md)

## Phase E1b3d3b2 autonomy + exact message-body observation（2026-09-18，现役 code）

- Autonomy：默认 OFF；shadow 只读；armed 心跳调度 + journal-first recovery + durable cooldown + RESERVED continuation（不二次 reserve）
- Exact body observation：parent exact 或 parent ATTEMPT + ≤64 descendant **innerText full equality**；无 fuzzy/textContent authority
- Bounded diagnostics：heartbeat / evidence / recovery / DOM representation（allowlist，无 raw text/credential）
- Live ARMED E2E 已完成：最终 acceptance event 为 `eventId=2c6b1d23641f46c484410c45f9e92d1c`、`attemptId=587c6632-7fa3-487b-a42c-25922952324b`、status=`observed`；Reload、independent review、live ACK closeout 均完成，browser journal=`NONE`、Bridge `inFlight=none`。历史 event（包括 `e600aed6ef94…`）不再执行 Send、Recover、ACK、Retire、Reserve
- 详见 [phase-e-feedback.md](phase-e-feedback.md)

## Phase F1 operational hardening（2026-09-18，已完成；当前阶段为 Phase G）

### F1a operational readiness health（已合入 `44075ea`）

- 以现役 Browser Companion 的既有 SW status payload 为唯一数据源，新增纯诊断 health summary；不新增控制面或网络 endpoint。
- health summary 只暴露 mode、identity/owner/storage/transport 门禁、journal phase、in-flight、heartbeat 分桶新鲜度、cooldown 和 allowlisted decision/recovery reason；不含 message/DOM/credential/principal/document/tab/event/attempt 标识。
- 只读 popup health block 与状态 helper 不改变 reserve、begin-send、ACK、recover、retire 或 native Send 语义；`OUTCOME_UNKNOWN` / `OBSERVED_PENDING_ACK` 始终显示 recovery-required。
- F1a 门禁：**70 files / 1519 passed / 0 failed**；typecheck / build / `git diff --check` 通过。

### F1b resilience hardening（已合入 `90abcfe`）

- Test-first resilience matrix：SW restart hydrate、SEND_INTENT crash recovery、post-mutation fence、OBSERVED_PENDING_ACK、OUTCOME_UNKNOWN、owner loss、route drift、Bridge offline、authStale、durable cooldown、corrupt journal。
- Independent review 修复并合入：`OBSERVED_PENDING_ACK` 在 authenticated `/state` exact observed + `inFlight=null` 时支持 SW-only local closeout（zero DOM/ACK/Send）；解决 ACK 已成功但 response/local clear 因 crash 丢失后的 restart closeout。自动化入口：`tests/f1-companion-resilience.test.ts`（43 cases）；矩阵与契约见 [phase-f1-operational-hardening.md](phase-f1-operational-hardening.md)。

### F1c live resilience acceptance（2026-09-18，本轮）

- Live preconditions：Bridge running、`pairingActive=false`、runtime current；本会话无 Browser Companion 扩展控制面。
- Acceptance A/B/C/D 均 **automation-proven / live pending**：未操作历史 event、未创建 production event、未 Reload/rollout；结果与 operator 后续 live 边界见 [phase-f1-operational-hardening.md](phase-f1-operational-hardening.md)。
- 本轮仅文档，无 production code 变更。

- **NEXT_EXPECTED_STEP**：
  - **A/D**（owner / route resilience，**不需要** production event）：前提是 **paired + journal `NONE` + Bridge `inFlight=none` + SHADOW-only**。
  - **A** = reload / document ownership resilience：观察 owner-loss 必须用 **SHADOW**（`mode=off + journal=NONE + owner unavailable` 时 health 为 `off`，不是 `waiting_owner`）；结束恢复 OFF。
  - **D** = page route drift / ownership invalidation（**SHADOW-only**，禁止 ARMED）：route-change invalidation 清 owner → foreign-route heartbeat 非 exact owner → 不 production tick；返回原 route 不自动继承旧 owner（同 tabId ≠ 同 document）。
  - **transport identity drift**（bindingId / epoch / transport route 变化 → `disarmOnIdentityChange`）与 **page route drift** 分开，不混测。
  - **B/C** 仍需 future controlled fault injection + dedicated new event + independent review；禁止历史 event。
  - 历史 `NEXT_EXPECTED_STEP` 仅作收尾记录。

## Phase G — Seamless Daily Workflow（2026-09-18~19，当前阶段）

F1 已完成 Browser Companion 安全底座（operational readiness + recovery resilience）。
G 阶段聚焦用户体验与跨设备日常闭环，不再扩展 recovery 状态机。

### G1a — Unified Workflow Readiness（已合入）

- 新增纯只读工作流 readiness 聚合层：`src/workflow/readiness.ts` + CLI `c2c workflow status -w <workspace> --json`（`src/cli/workflow.ts`）。
- 输出有限 enum：`overall` / `nextAction` / connection·conversation·desktop·remote 投影 / `blockers`；不输出 threadId、bindingId、credential、raw command。
- Fail-closed：`authorization=unknown` / `connectorContract!=current` → `blocked`；`desktopCompatibility=none|legacy|incomplete` → `needs_authorization`。
- Project chat 使用 thread-scoped **`projectChats[]` map**（domain-separated fingerprint → verified URL，容量 128，满则 fail closed）：同 thread 可恢复自己的 Chat；`session.url` 仅作 latest/legacy 指针，**不是** ownership 真相。
- Desktop `currentTarget`（currentIdentity）与 `bindingAvailability`（inspect structured code）分离；`desktopErrorCode` 不依赖 `error.message`；identity 变化 → `blocked`。
- CLI 失败 JSON 仅 bounded code，不透传 `error.message`。
- **ready_local / reuse** = 本机执行路径已确认：connection ready + conversation ready + exact Desktop identity + binding inspect available + no unresolved delivery。**不等于** MCP request-scoped Connector scopes/schema 已验证（`desktopCompatibility` 仅为本地 AuthStore 汇总；G1b/G2 仍必须做 `workspace_info` + request desktopCompatibility + Connector schema check）。
- `exact + busy` → `busy`；`exact + unknown/unavailable` → `blocked`（机器 JSON 与 human 同定义，不软 Ready）。
- Bridge `running=stopped` → `needs_connection/repair_connection`（不因下游 admin facts 缺失误报 corrupt）。
- `projectChats[]` durable state **strict**：`null`/malformed/duplicate/超容量 → session corrupt fail closed，不 silent-normalize。
- 测试：`tests/workflow-readiness.test.ts` + `tests/workflow-cli.test.ts` + session fingerprint regression。
- 本阶段不改 Skill Activation、MCP `workspace_info`、Connector schema、Browser Companion。
- 路线：G1a 收口 → **G1b** Skill Activation 一次 readiness 只补缺失步骤（不得因 ready_local 跳过 web verification；恢复 Project chat 必须用 thread-aware URL projection，不得复用全局 `session.url`）→ G2 readiness 投影到 `workspace_info` → G3 跨设备从零 E2E。

- **G1a 已合入** `51cbe81`。

### G1b — Skill Activation consumes workflow readiness（已合入）

- `c2c session --json` 只读 `threadConversation`：Project `chatUrl` 仅来自 `projectChats` same_thread；禁止 `session.url` fallback。
- Activation 第一事实源为 `c2c workflow status`；`overall`/`nextAction` 分流；state-changing 后 bounded reread。
- `ready_local/reuse` 与 `ready_remote/use_remote` 不调用 bind-current；仍强制 request-scoped verification。
- Connector migration / Conversation Rebind 成功后 rerun `c2c workflow status`；仅 `nextAction=bind_current` 时才 Desktop bind-current。

### G2 — readiness projection into workspace_info（已通过 independent review，本轮合入）

- `workspace_info.workflow`：request-scoped bounded projection（`schemaVersion=1`），一次调用返回 workspace identity + connection/conversation/desktop/remote + `overall/nextAction` + `requestContext`。
- **Request token isolation**：`desktopCompatibility` 与 `authorization` 只来自当前 MCP request token（`ctx.desktopCompatibility(extra.authInfo)` / `requestAuthorization`），不借用机器 AuthStore aggregate；`runtimeUpgrade` 由 Bridge hook 只读投影，不 loopback probe。
- **Request conversation 与 durable `chatKnown` 分离**：MCP `conversation.chatKnown=false`、`chatBinding="none"`；官方 `_meta["openai/session"]` 只进入 `requestContext.conversationIdentity`；resolver `requestPolicy.currentConversation` 仅决定**本轮**是否可继续，不伪装 Project membership / same_thread durable binding。
- **Remote request scope gate**：`ready_remote` 前校验当前 request 具备 `codex.read + codex.control`；缺省 → `needs_authorization` + `remote_request_scope_missing|incomplete`。
- **Full-schema fail-closed fallback**：projection 失败时返回完整 `workflowOutputSchema` shape（`blocked/stop_unknown` + `workflow_projection_failed`），workspace identity 始终可作恢复入口；output schema 字段全部 bounded enum（共享 `readiness.ts` 常量 + `WORKFLOW_BLOCKER_CODES`）。
- **Connector contract 仍为 v1**（未 bump）；`workspace_info` 保持 readOnly；不自动执行 `nextAction`。
- 共享层：`src/workflow/facts.ts` + `src/workflow/request.ts`；CLI 仍走 `codex_thread` collector，不传 requestPolicy（G1a parity）。
- 测试：`tests/workflow-request.test.ts`、`tests/workflow-mcp-projection.test.ts`（HTTP Cases A/B/C + projection failure）、readiness/cli/mcp-integration 更新。

- **G2 已通过 independent review**（full suite 1628 passed）。

### G3 — route-principal attestation（2026-09-19，live E2E **PASS**）

G3 修复 Browser Companion 误绑错误 ChatGPT conversation 后 production Send 投错 chat 的问题。
`paired ≠ origin conversation attested`：pair 只注册 credential+route，**reserve/begin-send 要求 route 已验证**。

**现役实现（code committed `84e67e4`…`b961438`；workspace `2582910bf0d2` install `f728012c…`）**

- **Server contract**：pair 铸 pending challenge（`challengeId` + `challengeDigest`，绑定 workspace/binding/epoch/companion/route）；MCP `feedback_companion_route_confirm`（scope `codex.feedback`，principal 仅来自 `openai/session`）。wrong principal **不消费** challenge。
- **Browser gates**：route `PENDING` 时 Arm / Reserve / production begin-send 均拒绝；authenticated `/state` 为 **唯一** `VERIFIED` 权威；DOM 观察不得写 VERIFIED。
- **Attestation one-shot Send**：popup 不传 message；SW owns `[C2C_ROUTE_ATTEST]` body；dedicated CS runner；observer 仅 `collectBoundedDescendants`（≤64 BFS）+ `innerText` canonical equality + exact `challengeId` marker；**无 ATTEMPT_ID 语义**、无 production journal。
- **Durable fence**（`chrome.storage.local`）：`NONE → PAIRING_TRANSITION → ROUTE_ATTEST_DISPATCH → OBSERVED_PENDING_CONFIRM → VERIFIED | OUTCOME_UNKNOWN`；session latch 不够；corrupt fence fail closed；**任何 non-NONE fence（含不同 identity）一律 block**；transport clear 不清 fence；仅 re-pair（新 companionId+challengeId）写 matching `NONE`。
- **Pair barrier-first**：调 `/pair` 前 durable 写 `PAIRING_TRANSITION`；`prev*` 在改全局前捕获；`TRANSPORT+LOCAL+FENCE` 尽量同一次 `storage.local.set`；4xx 可恢复 prev fence，网络/5xx 保持 barrier；pair **非** success 若 durable commit 失败。
- **Post-write ready gate**（`b961438`）：write/verify 后按 send-probe 契约 poll——仅 `kind=send` + `enabled` + form `data-testid=send-button` 才 dispatch；`idle` 不是 click target；成功判定为 `click.ok`（生产返回 `clicked:1`）。
- **Classic packaging**：content_scripts **禁止** ESM `dom-adapter.js` / `turn-observer.js` / `route-attestation*.js`；CS 使用 `dom-adapter-global.js` / `turn-observer-global.js` / `route-attestation-global.js` / `route-attestation-run-global.js`；SW ESM import graph 保留原文件名；`send-probe-run` / `send-click-adapter` classic 为 IIFE + namespaced `__c2c*` 绑定；build fail-fast（manifest 禁 ESM、provider 先于 consumer、`new Function` parse、真实 `import()` dist ESM link 测试）。
- **Popup Grant Bridge access**（`9dc88d7`）：`chrome.permissions.request` 在 click handler **同步**调用（gesture-first）；Pair 仅 `permissions.contains`，缺权限 `bridge_permission_missing`。
- **门禁**：最近 full vitest **80 files / 1775 passed**；typecheck / build / `git diff --check`。Extension 需 Edge **Reload** `dist/browser-companion` 才加载新 CS/popup。

**边界（未改 / 不得弱化）**

- production journal / late-positive ACK / autonomy / pair credential / OAuth scope 门禁不变；无自动重发。
- Fence 实际字段：`companionId + challengeId + routeCanonical + …`（**无** bindingId/epoch）；server challenge digest 已绑 binding/epoch。
- HTTP authenticated `/state` 可含 attestation message（SW 恢复用）；popup SW payload 仅 `routeAttestationPending`。

- **G3 live acceptance：PASS（2026-09-19）**。跨设备 Desktop smoke 与 route-principal attestation 闭环已完成；后续实现不得把旧的 `live E2E pending` 当作当前状态。
- **NEXT_EXPECTED_STEP**：**G4c independent review；通过后再安排 deploy/live acceptance**。
  - Normal same-browser 顺序：点一次 **Connect this Chat**；首次使用时在同一点击中请求 host permission（浏览器可能弹授权框）→ 当前 Chat 通过 `feedback_companion_route_confirm` 完成 principal proof。**Grant Bridge access** 保留为连接设置中的 fallback；Browser 不再需要第二次 Bind/Rebind/Verify/Complete 点击。
  - 路径：`workspace_info` → bounded workflow readiness → 安全 Desktop/Remote → Codex 执行 → Companion 反馈回 **已验证** conversation → independent review → DONE。
  - 不要求用户手工搬 workspaceId / threadId / bindingId；不得自动降低授权、审批、`outcome_unknown` 或 Project ownership 门禁。
  - **前置约束**：`requestContext.conversationIdentity=available` ≠ Project membership ≠ durable same-thread Chat binding；live 闭环必须依赖 **route attestation VERIFIED**，不得把 `currentConversation` 当永久绑定。
  - 历史 Connector `test_status` 不得替代本次 live acceptance；后续仍以现役 runtime/status 为准。

### G4a + G4b — bounded bootstrap / same-browser rebind（2026-09-20，landed at `22fb917`）

- MCP `feedback_bootstrap_status` 只根据当前 request 的 `openai/session` principal 投影有限状态：`DISABLED`、`OWNED_VERIFIED`、`OWNED_NEEDS_BROWSER_REBIND`、`FOREIGN_SAFE_TO_TAKEOVER`、`BLOCKED_INFLIGHT`。仅 foreign-safe 返回 takeover 所需 `expectedEpoch + widgetId`；不返回 principal、credential、secret 或 hash。
- `reserved / claimed / outcome_unknown` 一律 `BLOCKED_INFLIGHT`；takeover 的 `expectedEpoch` CAS 与原有 in-flight fence 不变。
- takeover 后 predecessor credential 对 `/state`、`/reserve`、`/begin-send`、`/ack`、retire 等 production API 继续无效；它只可访问 `/rebind/init` 与 `/rebind/complete`。
- `/rebind/init` 仅接受同 workspace 的 immediate predecessor、exact successor epoch、无 in-flight 状态；创建持久化、TTL、one-shot challenge，不授予 production authority。
- current Chat 仍通过现役 `feedback_companion_route_confirm` 完成 request-scoped principal attestation；wrong principal 不消费 challenge。确认后 `/rebind/complete` 才旋转 fresh credential；Browser 再以 authenticated `/state` 取得唯一 `VERIFIED` 权威。
- Browser SW 复用既有 route-attestation runner、session latch 与 durable fence；init 前 barrier-first，网络/5xx/storage ambiguity 进入 fail-closed fence，不自动重发。autonomy 默认 OFF，identity 变化强制 disarm。
- cold `feedback_companion_pair` fallback 保留；未增加 manifest permission、自动 Arm、Connect & Arm 或第二套 DOM runner。

### G4c — Connect this Chat（2026-09-20，implementation ready for review）

- Popup 的主操作只向当前 tab content script 发送固定 `c2c.connect.request`；content script 再把当前 bounded observation 转给 SW。tab/document/route 权威始终来自真实 `MessageSender` 与 canonical route parser，不接受 popup 提供 identity。
- 同浏览器 immediate-successor rebind 复用 G4b `/rebind/init` 和 G3 one-shot route-attestation runner/fence。新增只读、bounded `/rebind/status`；只有 exact predecessor credential + active binding/epoch/route/challenge 才可读取 `PENDING | CONFIRMED | EXPIRED`。
- Browser durable connect fence 为 `NONE -> ATTEST_REQUESTED -> COMPLETE_REQUESTED -> DONE`，任何网络、5xx、malformed/mismatched 2xx 或 durable commit ambiguity 收敛到 `OUTCOME_UNKNOWN`，不自动重发 attestation 或 `/rebind/complete`。
- Connect 入口先 durable persist autonomy `OFF`；OFF 写入失败时保持内存 OFF 并返回 `autonomy_persist_failed`，不报告 CONNECTED、不启动 route Send 或 complete。已证明无 mutation 的 complete `COMPANION_REPAIR_BLOCKED` / `COMPANION_REBIND_NOT_CONFIRMED` 只回滚到 `ATTEST_REQUESTED`，等待后续 heartbeat 重新读取 status；其余错误仍进入 `OUTCOME_UNKNOWN`。
- current Chat 的 request-scoped MCP principal confirmation 仍是必需步骤；wrong principal 不消费 challenge。确认后 exact owner heartbeat 最多发起一次 `/rebind/complete`，fresh credential 安装后 authenticated `/state` 仍是 `VERIFIED` 唯一权威。
- Pair/Rebind/Complete/Clear 共用 SW transport mutation gate，防止异步 Bridge 返回覆盖更新后的 transport。Browser restart 只允许 exact owner 对 durable `DONE + OBSERVED_PENDING_CONFIRM` 做只读 `/state` 收敛，不重复 complete 或 DOM Send。
- 无 eligible predecessor 时返回 bounded `cold_pair_required`，继续使用现有手工 cold-pair fallback。Bridge permission 缺失时明确返回 `bridge_permission_missing`；Connect 不请求 permission、不 Arm、不触发 production feedback 操作。

### P0.6 — Desktop native continuation receipt ownership（已实现并完成独立 Review）

- forensic 已确认本机平台存在 `capacity_retry_automatic` 与 `resume_interrupted_task` 两类
  zero-canonical-user-input 的 continuation 行为信号；这只是当前观测到的 allowlist，不宣称是上游稳定 enum。
- P0.6 保持 immutable origin `delivery.turnId`，每次首次写 receipt 重新读取 canonical、完整、
  newest-boundary exhausted 的历史，并以严格 UUID、同 workspace/thread/project、精确 C2C envelope
  bytes/SHA、同一 canonical island 内的紧邻 successor 和 bounded chain 证明当前 result tip 的归属；
  写入前第二次 attestation 比较完整的逐边签名链，以捕获前序边漂移；
  每跳按其精确 trigger 校验 predecessor：capacity retry 允许 `failed`/`interrupted`，手动 resume 只允许
  `interrupted`；新信号或变化的信号仍 fail closed，需重新观测并审查后才能扩展 allowlist。
  island 边界与无法证明为字典且无用户输入的 successor item 均 fail closed。
- 任意普通 `failed`、同线程/时间相邻、summary/hash、未知 trigger、插入新的 C2C/user turn、
  malformed/duplicate/incomplete history 均不可续接；只有明确 allowlisted 的 native continuation relation
  才能把 predecessor 视为可继续状态。重启不保存或猜测 continuation tip，而是重新 attestation。
- `outcome_unknown` 仍只恢复原始 envelope 的 accepted origin；P0.5 的 receipt-backed busy-tail settle
  仍只服务新 send，两者不改变彼此的 fail-closed 语义。P0.6 不新增 MCP 工具、不公开链内部、
  不重发 Desktop task、不产生第二条 receipt。

### P0.7 — v2 Desktop delivery provenance 与严格 re-materialization alias（源码已提交；live smoke 待运行时升级后验证）

- 新 send 使用精确 v2 `C2C_DESKTOP_TASK` envelope；C2C 自行生成 UUID `deliveryId`，在
  `outcome_unknown` durable commit 中持久化后才发送，wire 与状态共用同一值。状态 version 1 继续读取，
  旧 v1 delivery 不回填 ID，command replay 不重新生成或发送。
- `deliveryId` 是 provenance identity，不是授权凭证，也不公开到 MCP delivery projection。unknown
  reconciliation 与本机 delivery identity 比较纳入该字段；仅当字段存在时加入既有证据摘要，因此历史 v1
  confirmation/proof 的 canonical bytes 不变。
- 唯一 turn alias 是 `edit_user_message_v2_delivery`：v2 envelope 在 exhausted canonical history 中唯一，
  replacement turn exact-match deliveryId 和原始 envelope bytes/hash，trigger=`edit_user_message`、
  status=`interrupted`，并立即接续一个通过 P0.6 `resume_interrupted_task` 规则的 successor。
  originTurnId 保留为实际 replacement turn；durable accepted turnId 不变。v1 精确 turn 规则及普通新 user
  turn、复制 envelope、重复候选、未知 trigger 和所有历史/身份 fail-closed 门禁不变。
- `current_result_classification` 与 ownership IPC 通过严格 alias enum 明示该关系；receipt 写前复核比较
  deliveryId、alias 和完整逐边签名链。未知版本、额外字段、坏 UUID、错 ID 或关系漂移均拒绝。
- 为覆盖 `inProgress → pending draft → detached finalizer` 时间窗，新 pending draft 升为 v3 并固化首次
  ownership snapshot；`safe_terminal` 后由 exact-target 只读 IPC 重验整条 ownership，再于 output/receipt 写入前
  确认 durable accepted turnId/deliveryId 未变。既有 v1/v2 drafts 保持原读取与收敛语义，不回填证据。

### P0.6a — outcome_unknown 行政 resolution（已实现并完成独立 Review）

- 增加显式 `desktop resolve-unknown --command-id` 两阶段入口：preview 只读，confirm 只写独立
  resolution 证据；不修改原始 delivery，不补 turnId，不写 execution receipt/output，也不把结果
  解释为成功。
- resolution 证据绑定精确 workspace、commandId、delivery 摘要与 confirmationSha256，并与
  trusted receipt、reconciliation、retirement、abandonment 及重复 resolution 做冲突检查；Desktop
  IPC/canonical history 不可用时仍可安全执行，损坏或漂移一律 fail-closed。
- 原始 `outcome_unknown` 保持不变；history 用 `resolved_unknown`、status 用
  `administratively_resolved`，workflow/rollout 仅对有严格匹配证据的 unknown 解除阻塞，其他
  unknown 继续阻断。原有 reconcile、self-reconcile、P0.5/P0.6 和 commandId 防重放语义不变。

### 未来方向（非当前实施）：ChatGPT 侧本机管理能力面

- 仅在出现具体恢复需求时，评估向 ChatGPT 暴露一组小型、allowlist 化、按能力划分的 MCP 管理动作，
  例如对现有 `resolve-unknown` 两阶段语义提供受限 wrapper；不得提供任意 shell/命令执行工具。
- 每个动作仍须有严格参数 schema、workspace binding、OAuth scope 与当前 conversation principal 校验，
  保留 preview/confirm 或等价的有界授权、幂等与审计证据，并对损坏、漂移和歧义 fail closed。
- `resolve-unknown` wrapper 必须原样保留语义告知：行政 resolution 仅停止等待/解除阻塞，
  不代表已投递、已接受、已完成或成功。其他候选能力只在出现明确 workflow 需求后逐项评估；
  当前不实现、不改变 R4/R5 范围，也不建设任意 shell/命令执行或 generic exec 工具；R5b
  已有的 `executor_send` 仍只按 active executor binding 提供受限投递。

## H0 — Executor Core foundation（2026-09-23，本轮）

- 新增 `src/executor/` 的有限 contract、固定 registry 和 `CodexDesktopAdapter`。Bridge 的 Desktop 控制服务通过 adapter 处理现有会话绑定、当前身份/本机确认、target inspect、prepare/send connection 及 post-result settle 的 active inspection；IPC/helper、状态存储、授权、审批、replay、`outcome_unknown` 和 trusted receipt 语义不迁移、不弱化。
- 当前唯一生产 executor 是 `codex-desktop`。Claude Code 作为计划中的第一个额外 adapter，H0 只提供扩展接缝；Mimo Desktop 需先有稳定本机机器接口，GUI-only 自动化是较低信任路径，不自动继承 trusted receipt。
- capability descriptor 仅是规划/UI 事实，unknown executor ID fail closed；无插件自动发现、PATH/网络探测、动态加载、自动选择或负载均衡。
- ChatGPT planner/reviewer → C2C executor-agnostic control plane → local adapters → workspace 的分层已写入架构文档。Browser Companion/feedback transport 保持 executor-independent；H0 不新增 generic MCP executor 工具或第二个 executor。
- 回归新增 `tests/executor-core.test.ts`，覆盖 registry、bounded capabilities、adapter 委托、注入式 Desktop service 绑定/status/send 以及 capability 不得绕过启用门禁；既有 Desktop IPC/control/result/finalizer 测试继续作为语义门禁。

### H0 边界与下一步

H0 不抽象 Codex-specific result classification、terminal fence、receipt finalizer、unknown reconciliation 或 Browser Companion 协议；后续 adapter 必须先定义独立的证据合同，才能获得可信回执语义。下一步若实现 Claude Code，先补本地身份/审批/终态证据合同，再扩展 registry 和定向测试，不改变现有 `codex_desktop_send` / `codex_desktop_status`。

## Executor E1a — Claude runner contract（2026-09-23，本轮）

- command83 的只读本机审计确认 Claude Code `2.1.220` 与非交互/会话/JSON 输出帮助线索；
  C2C command binding、审批观察、取消协议和 trusted terminal receipt 仍未由真实任务证明。
  MiMo Desktop 没有稳定 coding-task API 证据，继续保持低信任候选。
- 本轮新增 `src/executor/claude/` 的协议 scaffolding：显式 executable identity、commandId 与 UUID
  sessionId 的本地 correlation metadata/可选 `command_id` mismatch guard、workspaceRoot/cwd 的
  词法 containment、固定 JSON argv、safe permission allowlist、bounded child-process seam、结构化
  parser 和 fail-closed terminal classification（包括 JSON `is_error=true` 即使进程退出码为零）。
  词法 containment 不替代 Bridge canonical workspace security boundary；测试只使用 fake runner，未启动真实 Claude。
- Claude candidate descriptor 明确 `productionEnabled=false`，生产 `executorRegistry` 仍只有
  `codex-desktop`；不新增 generic MCP executor 工具、不改 Desktop schema/工具、不实现 MiMo。
  candidate capability 不授予权限，`trustedTerminalReceipt` 仍不可用。
- 下一 gate：受控只读真实 Claude smoke，验证实际 JSON/session/exit 行为；之后另行完成审批可见性、
  C2C-owned child cancellation（不等同 Claude-native interrupt）、descendant/orphan 行为和可信
  receipt evidence 合同，再讨论生产注册。

## H1 — Browser Companion toolbar indicator 与 sleep/wake recovery（2026-09-22，现役源码）

- 工具栏 `C/C!/C×` 仅为诊断显示，error > warning > normal；不授予权限、不改变 autonomy 或发送权。Service Worker 在 tick、production send 与恢复路径清除 in-flight 标记后刷新，保证临时 `C!` 能收敛回真实健康状态。
- MV3 `alarms` watchdog 只做低频 `/state` discovery/reconcile；机器睡眠或后台冻结期间不承诺执行，恢复后的生产动作仍须由真实 owner 文档 heartbeat 经过既有 route、DOM、journal、cooldown 与 exact-owner 门禁触发。
- 用户已在扩展 Reload 后实测 stale-warning 修复；源码提交 `ab79b6a` 已推送，测试/构建门禁通过。此前安装目标 `15c76d1…` 曾因 rollout pending 与 named identity mismatch 未收敛；最新稳定 launcher 已确认 runtime/installed build 一致、`runtimeUpgrade=current`，不把历史 pending 误记为当前阻塞。
- 现役细节与运行时排障见 [phase-e-feedback.md](phase-e-feedback.md) 的 toolbar/sleep-wake 小节及 [troubleshooting.md](troubleshooting.md) 的 `named_unhealthy` 说明。

## R3a — derived current planner route（2026-09-24，历史初版，已由 R3l 收敛）

- 当时新增 `src/routing/current-planner-route.ts`：current planner route 只从现有 VERIFIED Companion
  candidate 派生；只读解析精确匹配已注册 planner route，显式 ensure 复用 `registerRoute()` 并保持
  exact replay 无 revision/file rewrite。未验证时即使有历史 route 也返回 none；身份、损坏 state、
  role 或 locator 冲突 fail closed。ensure 注册后会 recheck authority；期间目标变化则抛
  `ROUTE_AUTHORITY_CHANGED`，可能留下的旧 route 仅是 catalog/history，不作为 current 返回。
- 未在 routing schema/store 增加 active/default/current route pointer；helper 不写 feedback state。
- 本 slice 不接入 Desktop send、feedback send、route-confirm MCP 或 Browser Companion；其 route 返回值是
  时点快照而非 lease，调用方须在副作用边界重新解析，不得跨 await / 进程边界沿用。Browser Companion
  重连体验在独立 R3f slice 完成，未改变此 route authority。

## R3b — derived current executor route（2026-09-24，routing foundation 完成）

- 新增 `src/routing/current-executor-route.ts`：current executor route 从现有 Desktop binding target
  派生，显式 ensure 注册后 recheck；binding 中途变化时报 `ROUTE_AUTHORITY_CHANGED`，旧 route 仅保留
  为 catalog/history。exact replay 不 bump revision、不重写 route 文件。
- route identity 不包含 enabled、availability 或 busy；helper 不写 Desktop state，不等于发送授权/可用性。
- 不接 Desktop send、feedback、Browser Companion 或 MCP，不增加 current/default pointer、锁或状态机。

## R3c — current Command adapter（2026-09-24，routing foundation 完成）

- 新增 `src/routing/current-command.ts`：显式 ensure 当前 planner/executor routes，计算 payload 的 UTF-8
  byte length 与 SHA-256，再复用 `createCommand()` 创建 pending Command；current authority 缺失时不猜历史 route。
- 同 commandId 的 replay/conflict 仍由现有 store 处理；创建前会同步 re-resolve route，但该结果不是
  transport lease，未来发送边界仍须重新解析。
- 仅写 routing store；不接 Desktop send、feedback、Browser Companion 或 MCP，也不新增管理层/锁/pointer。

## R3d — current Command Desktop delivery adapter（2026-09-24，slice 完成）

- 新增 `src/routing/current-command-transport.ts`：重解析当前 planner/executor authority 后复用
  `sendDesktop()` 作为唯一实际 Desktop sender，并把相同 commandId 的 accepted/rejected/outcome_unknown
  同步写回 routing Command。
- `transitionCommandDelivery()` 只允许 pending → 首个终态；精确终态 replay 不改文件，不同终态冲突拒绝。
  若 Desktop 已持久化而 routing sync 失败，错误直接返回；后续同 commandId replay 校验原 Command 的
  intent/payload 后只读核对 Desktop durable ledger，匹配时只收敛 routing、不进行第二次 IPC send，且不
  因 current binding 已切换而阻断。ledger 不存在时仍须重验当前 authority 才可发送。
- 未接 MCP/现有生产调用方、feedback 或 ExecutionResult；未增加队列/锁/确认流程，Desktop 原有门禁不变。

## R3e — 现有 Desktop send 的 routing 生产接线（2026-09-24，slice 完成）

- `codex_desktop_send` 继续使用原工具名、`sendInput` schema、OAuth scope、`userConfirmed` 与 Desktop public
  delivery 输出；handler 改走 `deliverCurrentCommand()`，`sendDesktop()` 仍是唯一真实 sender。
- 必填 `bindingId` 显式核验：新/pending 无 Desktop durable record 时必须等于当前 binding；durable replay 必须等于
  原 delivery bindingId。匹配 replay 返回原 public delivery，不再 IPC send；错 binding 沿用
  `DESKTOP_BINDING_MISMATCH` / `DESKTOP_COMMAND_CONFLICT` 拒绝。
- 初版新 Command 要求当前 Companion planner route VERIFIED；此 planner authority 已于 2026-09-25 由 R3l
  改为同一 MCP request 的官方 conversation principal。`RoutingError` 保留明确 code/message；workspace mismatch
  与 Desktop/OAuth 错误映射保持明确，不改变 `codex_desktop_status`。
- 未新增 MCP tool、确认、队列或状态机；不接 feedback / ExecutionResult。Browser Companion 重连 UX
  由独立 R3f slice 提供，不改变本 slice 的 routing/send 边界。

## R3f — Browser Companion 一键重连自动恢复（2026-09-24，首轮实现）

- 用户成功开启自动回流后，显式点击“连接当前对话”可在新绑定完成且 authenticated route attestation 为
  `VERIFIED` 后，基于新 binding / epoch / route 写入 fresh ARMED policy；旧会话的 ARMED authority 不迁移。
- `rearmOnConnect` 仅是偏好，不是发送 authority；身份变化、连接过程和验证降级先关闭 autonomy。
  手动暂停、显式 unbind、清除 transport 会清除此偏好；重连后的真实发送门禁不变。
- 自动恢复持久化失败时 route connection 仍可保持 VERIFIED，但 autonomy 保持 OFF；不重复 attestation。
- R3a–R3e 提供 derived routing 与现有 Desktop send 接线；R3f 提供已配对页面的 Companion reconnect UX。
  后续新 Chat live smoke 暴露 takeover bootstrap 缺口，因此 R3 总阶段尚未完成；不包含 feedback / ExecutionResult 或 R4。

## R3 live smoke gap / R3g（代码完成，live smoke pending；2026-09-25）

- 新 Chat 的当前 owner 绑定不等于 Companion server binding successor；首次 `/rebind/init` 返回
  `COMPANION_REBIND_NOT_SUCCESSOR` 时，Browser Companion 需通过同一 Chat 的固定控制消息等待现有
  `feedback_status` / `feedback_takeover` 完成 takeover，再继续原 rebind 与 VERIFIED route attestation。
- R3g 将 bootstrap dispatch/wait 纳入既有 durable connect-flow，固定消息经 exact user-turn observation
  后才等待；dispatch 歧义与浏览器重启均 fail closed、不自动重发。代码及自动化回归完成；真实新 Chat
  单击 live smoke 尚待用户重载扩展后验证，因此 R3 暂不宣称整体完成。

## R3h — bootstrap sender 与 popup route 对齐（代码完成，live smoke pending；2026-09-25）

- 新 Chat live smoke 暴露 MV3 bootstrap sender URL 过严，以及 popup 仅凭旧 transport 的 VERIFIED 状态显示当前 Chat 已连接/可 Arm；现已改为 same-extension internal sender 检查，并要求当前页面 route 与 verified transport route 等价。
- 代码 review 与自动化回归完成；本次构建部署后，真实新 Chat 单击 live smoke 仍待用户 reload 扩展验证。R3 整体仍未验收完成。
- R3h closeout 全套回归暴露并已修复 Desktop stale-snapshot 并发分类问题；live smoke 仍 pending。

## R3i — owner-local read-only shadow 诊断（代码/测试完成；live diagnosis 与独立 review pending；2026-09-25）

- 新 Chat route 与旧 Companion transport 不同时，高级 Shadow Inspect 仅按当前 exact owner document 读取 bounded DOM capability evidence；不改变 bootstrap、Send 或 route authority。此前 live smoke 的 `generation_unknown` 尚未查明/修复；R3i 只解除只读诊断被 `owner_route_mismatch` 阻断的问题，不放宽 generation 门槛。

## R3j — 网页绑定身份收敛（代码/测试完成，待独立 review；2026-09-25）

- Popup 仍只发零参数固定命令；绑定身份仅为 `tabId/documentId/canonicalRoute`，三者由真实 MessageSender 及 `sender.url` 派生。`generation` 单独作为 freshness，`targetRoute` 与 `lastSeen` 内部派生。

## R3k — Browser feedback return plane 边界（代码完成；可实施部分独立 review 通过；2026-09-25）

- `companionApiUrl()` 仅允许当前 Browser Companion feedback endpoints；`/rebind/status` 只接受 canonical ChatGPT route 与 UUID `challengeId` 两个固定 query。未改变 Companion server contract。
- 加入 Browser runtime 与 Desktop MCP/routing 的双向 source architecture gate；popup 将生产回写明确命名为 FEEDBACK DELIVERY，并说明只写回当前 Chat、不向 Codex 下发任务。
- R3k 独立 review 指出当时的新 Command planner 仍依赖持久 VERIFIED Companion route；该缺口由 R3l 处理。

## R3l — request-scoped task planner authority（代码完成；cross-principal replay review-fix 待独立 review；2026-09-25）

- `codex_desktop_send` 从同一 MCP request 的官方 conversation principal 派生 planner route；缺少官方身份即明确拒绝，不从 Browser/feedback、历史 route、工具参数或 `sessionId` 回退。
- Executor route 改为 Desktop-only 投影，仍严格要求当前 Desktop binding；Browser Companion / feedback state 不再参与新 Command 创建或首次发送前 current-authority 检查。
- 旧 Companion-derived planner routes 保留为 routing history；不删除、不迁移、不覆盖。Browser/feedback 仍只负责 feedback return plane。
- command34 review-fix 在读取任何旧终态或 Desktop durable delivery 前，校验既有 Command 的 planner route 属于当前 request principal；跨 principal replay 以 `COMMAND_CONFLICT` 拒绝，不写状态、不发送。
- 验证通过：command34 focused routing/MCP/架构 4 files / 84 tests，full suite 99 files / 2134 tests，typecheck、build、`git diff --check` 均通过；R3i/j/k 浏览器与 feedback focused 14 files / 560 tests 通过。
- 当前变更仍在未提交工作树，未 push/install；command34 未取得可信 Desktop execution receipt，独立 review 与部署后新 Chat live smoke 均 pending。2026-09-25 只读 `c2c status` 显示 Bridge runtime 与 installed build 一致、`runtimeUpgrade=current`；Desktop availability 返回 `DESKTOP_PROTOCOL_ERROR`，`unresolvedDelivery=false`。R3 整体不视为验收完成。

## R3 aggregate live E2E closeout（截至 2026-09-26）

R3 已通过真实 live E2E，阶段状态为 **done**。R3a–R3l 条目保留各 slice 当时的实现与审查证据；
其中“live smoke pending”“R3 整体不视为验收完成”等均为历史快照，已由本节及顶部 R0→R5
roadmap supersede，不再表示当前阻塞。该日的下一阶段为 R4；当前进度以本文顶部为准，R3 当时的 pairing、feedback 与 route 兼容债务见上节。

### 2026-10-04 连接恢复过程记录（历史，当前状态见本文顶部）

2026-10-04 21:19 面板 Codex inspect_failed 已通过 canonical executor bind-current 修复：generic Executor 从旧历史 thread 对齐到当前已确认 Desktop thread，available=true；网页绑定/回流/runtime 未变，源码未改。现场证据见职责边界第14节末及 .tooling/executor-panel-alignment/。


2026-10-04 21:34：新网页连接仍停在本地 OUTCOME_UNKNOWN，服务端 epoch12 未接管。修复已复现的 bootstrap 零写入拒绝响应缺身份字段及错误码被只读刷新覆盖；旧未知状态保持，不根据新实现倒推旧发送结果。8 files/502 tests、typecheck/build/三方 ID/diff PASS；checkout build 70b189e97b32c73c73ad4cccf80f97db024237f6331bcc3d964ba39decda5bb9，仅扩展变化、未部署后台。现场恢复待重载及核验，详情见 core-plugin-boundaries.md 第15节；不把上一页面已连接当作新页面验收。

21:39 同轮现场收尾：新页面已验证，Feedback/Companion epoch13 与 Web Sink epoch3 已指向新 route；用户确认已连接且自动回流开启。旧本地 fence 由用户通过既有恢复按钮清除，未手写状态，Bridge 未重启；上一段“待核验”阶段现已完成，原始失败原因仍不可追溯。
