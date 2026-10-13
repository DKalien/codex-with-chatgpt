# 现役计划：单机统一 Gateway 与单插件

本文是“一个机器级 Gateway、一个 ChatGPT 插件，覆盖本机所有显式授权项目”的现役实施计划。下列各阶段完成前，计划目标都不得写成已交付。旧时间线仍保留在[开发计划](development-plan.md)；单 workspace 官方投递的当前合同见[官方路线](official-route.md)。

<a id="当前状态2026-10-08-当前-checkout"></a>

## 当前状态（2026-10-13 当前 checkout）

三合一与轻量 Companion 已部署：两个 workspace 由同一 Gateway owner 托管，运行版本均为 current。正式串行门禁 194 files / 4,087 tests 通过，后续两处小修的定向门禁 7 files / 138 tests 通过；最终 typecheck/build/diff 与 Python 协议门禁通过。Desktop 经用户本机确认恢复可用；用户刷新真实 ChatGPT 页面后复核面板“可接收结果”。精确 build、运行身份、代理观察和验收边界统一见[轻量 Companion 部署快照](companion-lightweight.md#部署与验收观察快照)。真实 Desktop task delivery、DOM Send、M4/M5 双项目 Send/observed、浏览器运行版本直接核验、旧 Connector 退役、开机自启及异常恢复仍待完成。

### 当前源码能力

- M1–M3 已有源码：`gateway register/list/revoke` 把规范 workspaceId/root 与获准 clientIds 写入机器 allowlist；`gateway serve` 使用独立 `machine-gateway` OAuth store 和单实例 owner lock。`gateway_list_workspaces` 只列出当前 client 的授权项目；workspace、Remote、Desktop、execution、feedback、Web Sink 工具显式带 workspaceId，每次调用重新解析 grant 与 canonical root。Remote 工具仍要求该 workspace 处于 official delivery mode。
- MCP Gateway 复用原工具 handler 与每项目业务状态，不增加 Gateway 任务/反馈队列。`/mcp` 与 `/oauth/token` 诊断日志只记录 method、固定 path 和 statusCode；不记录 query、body、headers。匿名访问只开放协议 discovery，工具调用仍要求 bearer OAuth 和原 scope。
- M4 已有多 workspace Companion 源码：默认 bridge-client 按 workspace 隔离凭据、偏好与页面关联，页面选择固定 workspaceId 与 canonical route，DOM mutation 按 tab 串行，操作面板请求带 workspaceId 并忽略旧项目迟到响应；namespaced alarm 仅保留在旧兼容链。测试覆盖双项目状态隔离；双项目真实 Send/observed 尚待现场验收。
- Gateway Desktop 复用本机绑定与原 sender：先 status 再 send，直接投递并保留 idle/busy 门禁；Bridge mailbox 才持久排队。Desktop read/control 与 Remote enable 独立，`codex_submit_task` 始终是后台 Remote 工具，失败不自动转投。详见 [Desktop 合同](desktop-control.md#gateway-直接投递)。
- Companion 默认使用轻量 bridge-client/content/popup，新回流目标由本机确认完整 URL，`local_user` 不替代 MCP principal。Bridge 判定连接与单次发送许可；浏览器关联真实 tab/document，执行一次已授权 DOM 操作并精确观察正文与 ATTEMPT，未知结果只观察、不重发。旧 SW `connectionReadiness` 与 proof/fence/journal 链保留兼容回归，不默认加载。机制见 [架构](architecture.md#companion-当前连接与恢复)，操作与诊断见 [排障](troubleshooting.md#日常连接与本机确认)。
- M6 已有 Windows 机器级 Gateway/Tunnel Supervisor 源码：configure/status/validate/set-key/run、稳定 launcher 后台启动、DPAPI key 保存、exact process identity、launcher startup pin、受限 OAuth metadata preflight，以及 GC 对 Gateway/Controller release 引用的保护。显式统一模式由单个 Node owner 托管已授权 workspace，只恢复原 running intent；尚无 Scheduled Task 注册或异常退出自动恢复。

### 历史验证边界（2026-10-08）

本轮唯一一次正式串行全量（2026-10-08 20:48:08–21:22:52，Asia/Shanghai）为 **180 files：177 PASS / 3 FAIL；3762 tests：3759 PASS / 3 FAIL；Duration 2078.78s，exit 1**，未出现 unhandled banner。`supervisor-store` 在未修改的源码/测试中遇原 8 秒 ACL 调用超时（8133ms）；保存的 ACL 快照合格，但变慢根因未明，未放宽门限。另两项静态测试分别因固定 1800 字符截取遗漏既有 `if (!res.ok)`、字符串判断把 `===` 当赋值而失败；仅修两行测试后一次定向 **2 files / 42 tests PASS、exit 0**，生产源码未变。未再跑正式全量，不能把原全量改写为通过。此前相关回归 **15 files / 889 tests**、typecheck/build 与本次 Python 协议 **89+20+4=113 项**通过，均不替代失败的正式全量；Vite `route-esm.js → route.js.map` 的 ENOENT 警告仍保留。证据在 ignored `.tooling/neat-closeout-20261008/`。

20:46:41 的稳定 launcher 只读样本为 `running=false`、`runtimeUpgrade.state=stopped`、`runtimeBuildId=null`、`upgradePending=false`；安装 build 为 `f6a69f50b1700fe62886d6742b33f2fe2fa460a065879aa19006ce297178cab5`，checkout build 为 `deab83645b14d099130f0bd7a381b9e085c32b332638a0eba4c4796555f2276d`，二者不同。该样本不证明后续运行状态；本轮未部署或 Reload，最新网页连接简化尚未通过用户 Reload 后的 live 验收。M4 双项目真实 Send/observed、M5 同一插件的双项目端到端验收及旧 feedback Connector 退役仍未完成。M6 的历史机器启动、正常停止/重启和 A 项目只读 smoke 证据只适用于标注时点与 build。

## 历史现场与源码验证记录（每条只代表其标注时点）

### 已验证的单 workspace 闭环（2026-10-06）

08:31–08:34 的真实网页验收已通过：OAuth；普通 Chat 的 workspace_info/list_targets；创建唯一 target；连续两轮官方投递、按需读取结果并留在同一 thread；两条 Companion 结果自动到达 observed。用户 Reload 扩展后确认当前对话 connected/armed。此验收证明一个 workspace 的官方投递与 Companion 回流，不证明多 workspace 聚合、原生 Events 唤醒或持续在线。

验收对应 workspace 2582910bf0d2，root 为 D:\python\codex-with-chatgpt，target b90a0577-2174-409f-8228-13fe8722ddef，thread 01a10e94-2366-7dc0-ae7b-0f948f24bef3。Gateway origin 为 https://c2c-official-2582910bf0d2.devworklink.com；旧反馈 origin 为 https://c2c-codex-with-chatgpt.devworklink.com。Companion route 为 https://chatgpt.com/c/6ac43e04-28c0-83ec-9651-0b32ba0617e4，Feedback epoch 14、Web Sink epoch 4。脱敏验收记录为 .tooling/official-route-deploy-20261005/gateway-companion-feedback-acceptance-20261006-verified.json（记录时间 08:34:27）。

### 实施前运行快照（2026-10-06）

09:01:03 的只读快照 .tooling/official-route-deploy-20261005/closeout-current-1791248463501.json 记录 Bridge 为 stopped，旧 durable runtime 记录仍包含 PID 19516/build c4b4c18d050137aaae1130b99257e3e13ded21eefbdf6359db2ee22798e28d97；该记录不代表进程仍运行。09:02 的 Win32_Process 只读取证中，早间记录的 Bridge 19516、Controller 24508、App Server 20172、Gateway 8572、PowerShell 24736、Cloudflare 6852、Tunnel 25488 均不在进程列表，端口 48766 无监听。原因未判定，本次未恢复。

该历史快照的已安装 build 为 c4b4c18d050137aaae1130b99257e3e13ded21eefbdf6359db2ee22798e28d97；不代表当前安装或运行版本。当时两条 Result Bus 结果为 observed、Remote queued/inflight/reconciliation 均为 0，maintenance/rollout/start locks 均为 0，471 项冻结文件 drift 为 0。2026-10-07 部署后的状态见 M6 和文末的下一会话入口。

此前源码正式串行全量为 164 files / 3435 tests PASS，typecheck、build PASS；这是实施前验收，不是当前 checkout 的 Gateway 门禁。后续 M6 限定机器启动/正常重启、双 workspace 只读连接与单项目 smoke 仅见本页历史摘要。普通 Chat 原生 Events、开机自启、异常恢复、M4 双项目真实 Send/observed、M5 端到端验收和旧插件退役仍未完成。

## 目标与不可变边界

- ChatGPT 只连接一个机器级 Gateway 插件。Gateway 提供本机项目清单和显式授权路由；它不接管每个项目的任务、结果或 Companion 状态。
- 只有显式登记且获准的 workspace 才出现在项目清单中。不得扫描任意目录、按当前目录或最近使用记录猜项目。
- 每个项目操作都要求显式 workspaceId；涉及执行目标时还要求精确 targetId，涉及结果读取时要求属于该 workspace 的 taskId。服务端核验规范 root、workspaceId、OAuth client 和现有 scope。
- 一次 OAuth 登录只认证 Gateway 调用方，不自动授权本机全部项目。每个 workspace 都需要独立的本机授权决定；撤销后请求 fail closed。
- 每个 workspace 继续使用现有 Remote Controller、task/target/result stores、Bridge、Result Bus、OAuth/Companion binding 和防重放账本。Gateway 是选择与授权路由，不建立第二份业务队列或结果权威。
- 新插件同时覆盖官方 App Server 投递和旧插件的 feedback 连接、接管、验证、状态及回流管理。Browser Companion 仍负责普通 Chat 的结果发送和观察，每个 workspace 的连接与 attempt 历史必须隔离。
- 保留认证、scope、审批、本机确认、workspace/root/client/target 精确匹配、防重放、route attestation VERIFIED 和 outcome_unknown 不重发等现有门禁。普通 Chat 原生 Events 不作为本计划的替代回流机制。
- 不引入新数据库、新队列、新依赖或跨设备体系。机器级项目登记沿用现有 state directory 和安全 JSON 工具；项目执行/反馈状态仍落在原 workspace 权威存储。

## 实施前基线与最小落点

- src/remote/server.ts 的独立 endpoint 只接收一个 workspaceRoot，构造一个 Workspace 和一个按 workspaceId 隔离的 AuthStore；其 official MCP profile 只注册 workspace 与 remote 工具。
- src/mcp/server.ts 已将 official、feedback、legacy 三类 profile 分开。Bridge 在 official mode 仍通过 feedback profile 提供反馈工具；Companion 与 Web Sink 路由仍按单 workspace 绑定。
- src/workspace/manager.ts 会 realpath workspace root 并从规范 root 派生 workspaceId，但没有机器级已授权项目 registry。src/config/endpoint.ts 是每 workspace 最近 Connector endpoint 记录，不是项目授权清单。
- 可复用 src/remote/store.ts 与 src/remote/controller.ts、src/result-bus/、src/mcp/feedback.ts、src/mcp/web-sink-tools.ts、src/bridge/companion.ts 的现有权威和协议。只为 workspaceId 路由与组合工具做必要改造；不复制业务状态机。

## 历史源码实施与验证（2026-10-06；仅对应当时 checkout）

09:15 的只读核验：旧 Bridge/Controller/App Server/Gateway/Tunnel PID 均不存在，48766 无监听；稳定 launcher 显示 Bridge stopped、Controller/App Server/Tunnel offline，Remote queued/reconciliation 为 0。installed build 仍为 c4b4c18d050137aaae1130b99257e3e13ded21eefbdf6359db2ee22798e28d97，running build 为 null。没有恢复、启动或重绑真实服务。

M1 增加机器级 `gateway/workspaces.json`，只保存规范 workspaceId/root 与 clientIds；`gateway register/list/revoke` 是本机显式授权入口，MCP 不提供登记或授权工具。每次项目调用重新读取清单并 realpath 核验；撤销对原 token 的后续调用立即生效，清单损坏拒绝且保留文件。短写锁、fsync 与原子 rename 沿用现有 JSON store 模式，遗留锁不自动回收。

M2/M3 的源码通过 `gateway serve --port <port> --public-url <HTTPS origin>` 复用原 OAuth 与 stateless MCP HTTP 入口。机器 OAuth 独立保存在 `auth/gateway.json`，token 只认证 `machine-gateway` 调用方。`gateway_list_workspaces` 要求 workspace.read 且仅列该 client 的已授权项目；其余 workspace、Git、Remote、execution、feedback、Web Sink 工具显式带 workspaceId，进入原处理函数前解析项目。Remote 还核验 deliveryMode=official。每项目业务状态、Controller、结果与审批门禁保持原权威。`gateway/server.lock` 保证认证缓存只有一个运行 owner，异常退出后的锁需人工核对，不自动抢占。

新 Gateway client 不继承旧 Connector 的 conversation fingerprint；反馈接管仍要求显式 takeover 与 fresh expectedEpoch。`feedback_companion_pair` 附加 workspaceId 供浏览器明确选择，secret 仍为一次性。路由认证消息同时携带精确 workspaceId、challengeId 与 digest，供同一插件确认对应项目。领取反馈在 reconcile/cutover 前核对 principal 与 binding/epoch；ACK 在 stale recovery 写盘前核对主体及 event/attempt，拒绝路径不推进历史。

M4 源码复用单份 Companion 状态机，为每个显式 workspace 建立 local/session/alarm 命名空间。Popup 从完整 Pair 输出登记 workspaceId 与 Bridge origin，再明确选择项目；登记不授予 Gateway 项目权限，也不调用 Pair。操作面板 URL 固定 workspaceId；页面绑定按 tab/route 选择项目，生产发送回调固定原 workspace/tab/document，同 tab 的 DOM mutation 串行。后台唤醒监听在 registry 加载前同步注册，namespaced alarm 只进入对应项目，关闭 tab 的选择清理先等待 session 加载。旧 singleton 只有完整身份与 route 可核对时复制迁移，保留旧 journal、attempt 与 archive；未知或冲突状态停止迁移。

Popup 的项目选择、列表和页面状态读取使用 revision 检查，迟到响应不能覆盖新项目或新页面；手动操作复用项目操作锁直到响应与显示更新完成，期间不能切换项目。切项目清空临时结果显示，保留持久历史；解绑后按钮保留最新 owner 状态。
当前 Popup 的空白“请选择项目”项不解除既有 tab/route 的项目映射，刷新会恢复原选择；切项目须选择明确的已登记项目。解除 tab 映射不是该空白项已实现的操作。

Grant Bridge access 单独请求权限；Pair 与 Pair+Connect 仅检查已有 permission，缺失时返回 bridge_permission_missing，不领取 owner proof 或调用 /pair。Pair secret 只保留在 popup 内存。Manifest 继续加载已构建的 classic content artifacts；ESM 模块只进入 service worker import graph。该次源码阶段没有 Reload 扩展或操作真实 ChatGPT 页面。

当次正式串行全量 `pnpm test --maxWorkers=1 --testTimeout=90000` 分两次执行。第一次于 11:29–11:59 发现 `architecture-separation.test.ts` 的静态检查只移除一次“禁止任务投递”固定提示，而 legacy 与 workspace-bound bootstrap 都含该提示：171 个文件中 170 PASS、1 FAIL，3482 项中 3481 PASS、1 FAIL。将精确提示的移除改为 `replaceAll` 后，第二次于 13:15–13:43 完整通过：171/171 files、3482/3482 tests，exit 0。调用符号、import 和 endpoint 三层架构门仍保留；source map 告警不影响测试结果。

第二次全量后的 `typecheck`、`build`、JavaScript syntax 和 `git diff --check` 均通过。run-2 使用 482 个源码/测试/配置输入，source digest 为 `24d38ebbcf301e8ae642362542246e5df37d3300a4df582cc0092e375f8b2ff5`，build ID 三重核验为 `af826f8d96120046bf6e1a8b9c029b8b7daae73bdddb7b6c741cb73e9bec4a5d`。全量无 Unhandled Error；仍记录 `dist/browser-companion/route.js.map` 缺失 source map 告警，未扩大修改打包脚本。

run-2 前后机器快照归属到测试 runner 的新进程、监听和新增临时目录均为 0。独立证据保存在 checkout 的 ignored [.tooling/unified-gateway-20261006/run-2-evidence.json](../.tooling/unified-gateway-20261006/run-2-evidence.json)，第一轮失败证据仍保留在原始 `evidence.json`。13:48 的稳定 launcher 只读刷新仍为 Bridge stopped、Controller/App Server/Tunnel offline，queued/reconciliation=0，旧 PID missing、48766 无监听；installed build 未变，running build=null。

截至该次记录，M1–M3 与 M4 的源码、定向测试和串行源码门禁已完成。M4 双项目真实 Send/observed、M5 同一插件真实双项目验收和旧插件退役尚未执行，不得从测试 fixture 推断 live 完成。

实验性并行 candidate 的 manifest 与 164 files / 3435 tests 仍保留为旧冻结基线。当前新增与改动测试会被其 inventory/hash 门拒绝；未经独立 profiling 与资源隔离审计，不刷新该清单或把新文件加入 parallel。正式验收只使用串行全量。

## 阶段与依赖顺序

顺序为 M0 → M1 → M2 → M3 → M4 → M5；M6 是独立的机器级 supervisor 实施与部署验收阶段。每阶段先做针对性回归，再运行 typecheck/build/diff 检查；整合后的正式串行全量只在源码冻结后运行一次。所有 live 检查都核对当前身份和状态，不沿用旧 PID 或把 installed build 当作 running build。

### M0：基线与合同锁定（历史阶段，已完成）

本文件记录单 workspace 现状、多项目目标、退出门槛和未完成事项。M0 不表示 Gateway 多项目代码或部署已完成。

退出条件（M0 完成时）：实现者能区分已通过的单 workspace live 闭环与当时尚未实现的多 workspace 路由；接受本文件全部安全边界。已完成。

### M1：显式项目登记与授权（源码已实现）

增加最小机器级 allowlist：显式 register/list/revoke 本机 workspace，复用 state directory、schema 校验、既有原子 JSON 写入模式与 Workspace realpath 校验。登记内容只保存规范 workspaceId/root 和必要授权主体；不递归发现目录。endpoint 记录不能代替授权。

OAuth 认证后仍按 clientId 与 workspaceId 检查本机授权；root 与 workspaceId 不匹配、项目未登记、已撤销、registry 损坏或授权主体不匹配时均拒绝。单一 token 的 scope 不能扩大项目清单。

退出条件：测试覆盖两个已授权 workspace、未登记/撤销 workspace、不同 client、root 身份错配、路径别名/符号链接边界和损坏 registry；拒绝路径没有写入任务、反馈或项目状态。

### M2：单 MCP Gateway 与多 workspace 官方工具（源码已实现；双项目现场验收待完成）

在现有 MCP 组合入口增加 Gateway profile。提供只列出当前 client 有权访问项目的只读清单；项目级 workspace/read、target、create-thread、submit、status、result 工具都显式接收 workspaceId，target/thread/task 参数按对应 workspace 解析。每次调用先核验 Gateway OAuth 身份、项目登记和 root，再进入已有每项目逻辑。

复用现有 Remote store/Controller 与 Result Bus。每个 workspace 独立实例或调用上下文，不创建共享 activeWorkspace、不将任务搬进 Gateway 私有队列。首轮覆盖新建 thread 与已登记 target；既有 thread 的挑选及 Desktop writer 移交留到延后项。

退出条件：同一插件连接和 OAuth client 可对两个本机已授权 workspace 各自创建 target、投递、查询精确 task/result；跨 workspace targetId/taskId、未授权项目及错误 root 均被拒绝；两边任务、历史和结果状态不串线。

### M3：整合旧插件的 feedback 管理（Gateway 工具源码已实现；双项目现场验收待完成）

新 Gateway 插件暴露现有 feedback 管理与 Companion/Web Sink 状态能力，至少覆盖 bootstrap/status、enable/takeover、claim/ack、stop、pair、route confirm、revoke、Web Sink list/status。项目级调用显式带 workspaceId 和原有 conversation/client 证明；逐项保留原 scope 与 fresh-state 校验。

直接复用现有 feedback、Bridge connection、delivery arbiter 和 Result Bus 状态机。Gateway 不伪造 Companion 主体、不直接写 binding、不绕开网页 route verification；旧 feedback Connector 暂时继续可用作回退，不自动双发或在 outcome_unknown 后切换插件重试。

退出条件：同一 Gateway 插件在两个 workspace 分别完成只读状态、明确接管/验证和受控回流管理；只读操作零状态写；授权不足或主体不匹配没有副作用；旧与新接口不会为同一 event/attempt 产生第二次发送。

### M4：Companion 多项目连接与回流隔离（源码已实现；双项目真实 Send/observed 待验收）

让 Companion 明确显示并操作当前已授权 workspace 的连接/route 状态。复用每项目 Bridge endpoint 与现有 connection、route attestation、Web Sink 和 Result Bus；不得把多个项目压成一个当前 binding。每项目连接、事件、reservation、attempt、ACK 与错误日志均留在本 workspace，并保留此前 attempt。

production Send 仍要求该 workspace 当前 route attestation 为 VERIFIED。尚未跨过 begin-send 的 reserved 预约可按现有 release/CAS 协议回到 queued，再为同一 workspace 的合格页面预约；保留既有发送证据。claimed/sendTarget 已冻结、发送已开始或 outcome_unknown 时都不能改投、重发。

退出条件：两个 workspace 分别完成普通 Chat 的连接、真实结果 Send 与 observed/ACK；每条结果能回到唯一原 workspace/event/attempt；一个项目断开、刷新或发生 unknown 不改动另一个项目，也不覆盖旧 attempt。

### M5：双项目验收与旧插件逐个停用门（未完成）

冻结源码后执行正式串行全量、typecheck、build 和 diff；确认 packaged artifacts、安装身份、当前运行身份和浏览器扩展版本分别可核验。随后通过同一个插件连接完成两个 workspace 的只读、官方投递、结果读取、反馈连接/验证和 Companion 回流验收。

只有新插件覆盖旧插件所需功能，两个项目均通过端到端验收、没有未解决 attempt/授权不明或结果缺口，并有可用回退路径，才逐个停用并移除旧 feedback Connector。每次只停一个并现场检查，按实际会话已有的明确用户授权执行；计划文本和历史记录本身不授予退役权限。保留旧连接的历史、凭据状态与恢复证据，不清理 workspace 状态。Bridge feedback 服务继续保留，直至另有兼容与状态迁移证据证明可以移除。

退出条件：两个项目的权限隔离和端到端记录可独立审查；新旧接口不存在双重发送；旧 Connector 每次停用后其余项目正常。任一检查不清楚即停止停用并保留旧配置。

## 延后项与风险停止条件

### M6：机器级 Gateway/Tunnel Supervisor（源码已实现；限定机器验收与 A 项目 smoke 仅为历史记录）

本节描述当前源码机制，并保留 2026-10-07 的历史验收摘要；精确机器身份和运行证据留在本机，不复制为现役配置。历史摘要不是本轮新鲜观察，也不能替代当前 checkout 的门禁或当前运行态核验。Windows Scheduled Task、开机自启和异常退出自动恢复没有实现，仍属 pending。

`gateway supervisor configure` 提供首次配置入口：保存 Gateway HTTPS origin、固定 loopback 端口、Cloudflare named tunnel 名称、Secure MCP Tunnel ID、stable launcher、两个 executable 路径和可选 proxy。配置与 `set-key`/启动共用 machine maintenance fence；存在 supervisor runtime/lock 时拒绝覆盖，损坏状态保留供核对。`status`/`validate` 只读检查配置和 runtime 文件，不证明公网可用或 OAuth 已授权。

`gateway supervisor set-key` 只接受交互式终端中的隐藏输入，用 Windows 当前用户 DPAPI 加密保存到机器状态目录的 `gateway/tunnel-runtime-key.dpapi`，配置只保存 keyFile/reference。不接受 `--key`、管道明文输入或仓库中的 key 文件；缺配置时先提示 configure。后续 `run` 只在内存解密，并只向 Secure MCP Tunnel 子进程传入临时环境变量；不向 argv、runtime JSON 或日志输出明文。PowerShell helper 使用现有环境白名单，避免继承 PowerShell 7 的 PSModulePath 导致 Windows PowerShell 的加密模块无法加载。

`gateway supervisor run` 是前台入口，直接在管理进程内启动 Gateway HTTP listener，再启动 Cloudflare origin 与 Secure MCP Tunnel 两个子进程。Secure Tunnel upstream 固定为 Gateway 公网 `/mcp`，复用精确 hostname 限制。Gateway 和所有子进程使用同一 `C2C_STATE_DIR`；Tunnel identity 是机器级，与 workspace Bridge identity 分开，停止任一项目不会隐式关闭其他项目共用的 Gateway。

本机启动终端显示短期 OAuth 配对码；Tunnel key 与 OAuth 配对码用途不同，已有效的 OAuth 授权不会因为正常重启被撤销。Gateway 使用正常 `close()` 释放 server.lock；Ctrl+C、Gateway 关闭或任一 Tunnel 退出时按本轮 PID/creationTime/executable 核验并收敛所拥有的子进程。提前退出不会漏掉，停止超时后的 unknown/仍存活进程保留 runtime/lock，绝不报告清理成功。实机首轮发现 Windows PTY 的 Ctrl+C 会令父 launcher 先退出并中断异步清理；修复仅为 Windows 增加父进程 SIGINT/SIGTERM listener 并保持 `spawnSync` 清理，非 Windows 行为不变。以真实 `CTRL_C_EVENT` 回归 `tests/windows_launcher_sigint_test.py`，另有 5 项 launcher 测试、typecheck、build、diff 检查通过；没有重跑全量。异常退出遗留锁仍需核对，不自动抢占或重试。

部署该版本后，一次配置的命令结构如下（参数来自已核验的机器 Tunnel 配置，不复制旧项目的 Tunnel 身份）：

```powershell
node "<稳定 launcher>" gateway supervisor configure --public-url "https://<Gateway origin>" --port "<已核验固定端口>" --tunnel-name "<Cloudflare named tunnel>" --tunnel-id "tunnel_<Secure MCP Tunnel ID>" --stable-launcher "<稳定 launcher>" --cloudflared "<cloudflared.exe 绝对路径>" --tunnel-client "<tunnel-client.exe 绝对路径>"
node "<稳定 launcher>" gateway supervisor set-key
node "<稳定 launcher>" gateway supervisor run
```

后续正常启动只执行 `run`，无需再次 `set-key`。需要轮换 key 时先正常停止，再执行 `set-key`。首次授权或授权失效时使用启动终端里的配对码；配对码过期可正常停止并重新运行以生成新码，保存的 Tunnel key 不变。

stable launcher 在 maintenance lock 内读取 current 并写入每次启动独立的 `gateway/supervisor.<nonce>.launch.json`，再加载 release。Supervisor 验证路径、文件身份、nonce、build 与 launcher；在同一维护门禁内持久化 runtime 后才移除本轮 pin。GC 保留 Gateway runtime、子进程与所有 launch pin 引用的 build；未知或损坏引用停止回收。未完成 handoff 的 pin 保守保留，但不会阻挡下次启动；人工核对前不自动清理。配置原子写入留下的规范临时文件不作为 release 引用，runtime 临时文件仍 fail closed。

### 历史验证摘要（2026-10-07）

当时的隔离回归覆盖机器 Supervisor 配置、DPAPI key、正常启动/停止、launcher pin 与 GC 引用。正式串行回归曾通过 173 files / 3509 tests，但之后又有 Windows Ctrl+C、Web Sink strict output projection、请求诊断与 Supervisor preflight/GC 修复；该旧全量不得作为当前 checkout 的门禁。SDK HTTP 测试夹具使用 loopback `node:http` 与流式响应规避 Fetch 禁用端口，保留真实鉴权状态、SSE 与取消行为；生产 Fetch、OAuth 和 OS 配置没有因此改变。

历史现场覆盖正常 Ctrl+C 清理、复用已保存 key 的正常重启和双 workspace 只读连接。一次 cold start 曾返回 readiness 503，正常重启后返回 200 仍带 startup probe timeout；不能宣布持续在线、异常恢复或其根因已解决。只读项目 smoke 后续完成 route attestation、同一 attempt 的 TURN_ENDED、observed 和结果回读，但仅覆盖一个明确授权项目；双项目真实 Send/observed、M5 端到端验收和旧 Connector 退役仍未完成。

精确 PID/startTime、tunnel/client、workspace/session/task/binding/attempt、installed/running build、日志和截图身份保留在本机验收记录中；本页不把它们作为可复用配置或新会话的授权来源。源码的按请求鉴权、反馈 epoch、防重放与 GC fail closed 合同仍须分别验证。

这些不是首轮 M1–M5 的阻塞任务，也不得在本轮声称已完成：

- 既有 thread 选择以及 Desktop 与独立 App Server 的 writer 移交限制。
- Controller 重启恢复、Key rotation、Gateway 开机自启与异常退出自动恢复。
- 启动 readiness 仍有异常提示：15:23 `/readyz` 为 HTTP 200，但带 2 秒 MCP startup probe timeout；此前 cold-start 503 保留为历史，原因仍未确认。
- Controller 启动 launch-pin 窗口仍未解决；legacy remote runtime 缺少 buildId 与状态不明的 remote lock/temp 持续触发保守 GC block，不清理旧状态。
- Windows Task Scheduler 注册需单独授权。
- R5j 性能优化继续 deferred。
- 普通 Chat 原生 Events 唤醒仍未通过，继续由 Companion 负责回流。

workspace/root/client/target 不一致、授权无法确认、存储损坏、进程身份不清或 route attestation 非 VERIFIED 时停止相关写操作并报告。已进入不可逆发送边界的 outcome_unknown 只能核验原 attempt，不换 ID、不自动重试。不得用旧 PID 执行强杀或用旧 durable runtime 记录宣称进程健康。

## 下一新会话入口

只在实际已授权范围内重新只读核验进程身份、端口、installed/running build、锁与 inflight；历史现场记录不代替本次检查，也不授权启动、重启、注册任务或修改绑定。先完成当前源码门禁，再按实际会话授权处理待完成的 M4/M5 验收。普通 Chat 原生 Events 与旧 Connector 退役不由一次 smoke 或旧全量推断完成。
