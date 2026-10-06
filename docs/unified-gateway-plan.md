# 现役计划：单机统一 Gateway 与单插件

本文是“一个机器级 Gateway、一个 ChatGPT 插件，覆盖本机所有显式授权项目”的现役实施计划。下列各阶段完成前，计划目标都不得写成已交付。旧时间线仍保留在[开发计划](development-plan.md)；单 workspace 官方投递的当前合同见[官方路线](official-route.md)。

## 当前状态（2026-10-06，Asia/Shanghai）

### 已验证的单 workspace 闭环

08:31–08:34 的真实网页验收已通过：OAuth；普通 Chat 的 workspace_info/list_targets；创建唯一 target；连续两轮官方投递、按需读取结果并留在同一 thread；两条 Companion 结果自动到达 observed。用户 Reload 扩展后确认当前对话 connected/armed。此验收证明一个 workspace 的官方投递与 Companion 回流，不证明多 workspace 聚合、原生 Events 唤醒或持续在线。

验收对应 workspace 2582910bf0d2，root 为 D:\python\codex-with-chatgpt，target b90a0577-2174-409f-8228-13fe8722ddef，thread 01a10e94-2366-7dc0-ae7b-0f948f24bef3。Gateway origin 为 https://c2c-official-2582910bf0d2.devworklink.com；旧反馈 origin 为 https://c2c-codex-with-chatgpt.devworklink.com。Companion route 为 https://chatgpt.com/c/6ac43e04-28c0-83ec-9651-0b32ba0617e4，Feedback epoch 14、Web Sink epoch 4。脱敏验收记录为 .tooling/official-route-deploy-20261005/gateway-companion-feedback-acceptance-20261006-verified.json（记录时间 08:34:27）。

### 最新运行状态

09:01:03 的只读快照 .tooling/official-route-deploy-20261005/closeout-current-1791248463501.json 记录 Bridge 为 stopped，旧 durable runtime 记录仍包含 PID 19516/build c4b4c18d050137aaae1130b99257e3e13ded21eefbdf6359db2ee22798e28d97；该记录不代表进程仍运行。09:02 的 Win32_Process 只读取证中，早间记录的 Bridge 19516、Controller 24508、App Server 20172、Gateway 8572、PowerShell 24736、Cloudflare 6852、Tunnel 25488 均不在进程列表，端口 48766 无监听。原因未判定，本次未恢复。

当前已安装 build 仍为 c4b4c18d050137aaae1130b99257e3e13ded21eefbdf6359db2ee22798e28d97；不要据此声称它当前正在运行。最新快照记录两条 Result Bus 结果为 observed、Remote queued/inflight/reconciliation 均为 0，maintenance/rollout/start locks 均为 0。471 项冻结文件 drift 为 0。Gateway、Controller 与 App Server 的当前身份需在下一会话重新只读取证。

源码正式串行全量为 164 files / 3435 tests PASS，typecheck、build PASS，build ID 与上列安装版本一致；这是已有源码验收，不是本轮文档验证。普通 Chat 原生 Events 尚未通过；既有 thread 选择与 Desktop writer 移交限制、重启恢复、Key rotation、长期运行入口和 machine supervisor live acceptance 未完成。旧反馈插件仍保留，尚未并入单一插件或停用。

## 目标与不可变边界

- ChatGPT 只连接一个机器级 Gateway 插件。Gateway 提供本机项目清单和显式授权路由；它不接管每个项目的任务、结果或 Companion 状态。
- 只有显式登记且获准的 workspace 才出现在项目清单中。不得扫描任意目录、按当前目录或最近使用记录猜项目。
- 每个项目操作都要求显式 workspaceId；涉及执行目标时还要求精确 targetId，涉及结果读取时要求属于该 workspace 的 taskId。服务端核验规范 root、workspaceId、OAuth client 和现有 scope。
- 一次 OAuth 登录只认证 Gateway 调用方，不自动授权本机全部项目。每个 workspace 都需要独立的本机授权决定；撤销后请求 fail closed。
- 每个 workspace 继续使用现有 Remote Controller、task/target/result stores、Bridge、Result Bus、OAuth/Companion binding 和防重放账本。Gateway 是选择与授权路由，不建立第二份业务队列或结果权威。
- 新插件同时覆盖官方 App Server 投递和旧插件的 feedback 连接、接管、验证、状态及回流管理。Browser Companion 仍负责普通 Chat 的结果发送和观察，每个 workspace 的连接与 attempt 历史必须隔离。
- 保留认证、scope、审批、本机确认、workspace/root/client/target 精确匹配、防重放、route attestation VERIFIED 和 outcome_unknown 不重发等现有门禁。普通 Chat 原生 Events 不作为本计划的替代回流机制。
- 不引入新数据库、新队列、新依赖或跨设备体系。机器级项目登记沿用现有 state directory 和安全 JSON 工具；项目执行/反馈状态仍落在原 workspace 权威存储。

## 现有实现与最小落点

- src/remote/server.ts 的独立 endpoint 只接收一个 workspaceRoot，构造一个 Workspace 和一个按 workspaceId 隔离的 AuthStore；其 official MCP profile 只注册 workspace 与 remote 工具。
- src/mcp/server.ts 已将 official、feedback、legacy 三类 profile 分开。Bridge 在 official mode 仍通过 feedback profile 提供反馈工具；Companion 与 Web Sink 路由仍按单 workspace 绑定。
- src/workspace/manager.ts 会 realpath workspace root 并从规范 root 派生 workspaceId，但没有机器级已授权项目 registry。src/config/endpoint.ts 是每 workspace 最近 Connector endpoint 记录，不是项目授权清单。
- 可复用 src/remote/store.ts 与 src/remote/controller.ts、src/result-bus/、src/mcp/feedback.ts、src/mcp/web-sink-tools.ts、src/bridge/companion.ts 的现有权威和协议。只为 workspaceId 路由与组合工具做必要改造；不复制业务状态机。

## 阶段与依赖顺序

顺序为 M0 → M1 → M2 → M3 → M4 → M5。每阶段先做针对性回归，再运行 typecheck/build/diff 检查；整合后的正式串行全量只在源码冻结后运行一次。所有 live 检查都核对当前身份和状态，不沿用旧 PID 或把 installed build 当作 running build。

### M0：基线与合同锁定（文档完成）

本文件记录单 workspace 现状、多项目目标、退出门槛和未完成事项。M0 不表示 Gateway 多项目代码或部署已完成。

退出条件：实现者能区分已通过的单 workspace live 闭环与尚未实现的多 workspace 路由；接受本文件全部安全边界。已完成。

### M1：显式项目登记与授权

增加最小机器级 allowlist：显式 register/list/revoke 本机 workspace，复用 state directory、schema 校验、既有原子 JSON 写入模式与 Workspace realpath 校验。登记内容只保存规范 workspaceId/root 和必要授权主体；不递归发现目录。endpoint 记录不能代替授权。

OAuth 认证后仍按 clientId 与 workspaceId 检查本机授权；root 与 workspaceId 不匹配、项目未登记、已撤销、registry 损坏或授权主体不匹配时均拒绝。单一 token 的 scope 不能扩大项目清单。

退出条件：测试覆盖两个已授权 workspace、未登记/撤销 workspace、不同 client、root 身份错配、路径别名/符号链接边界和损坏 registry；拒绝路径没有写入任务、反馈或项目状态。

### M2：单 MCP Gateway 与多 workspace 官方工具

在现有 MCP 组合入口增加 Gateway profile。提供只列出当前 client 有权访问项目的只读清单；项目级 workspace/read、target、create-thread、submit、status、result 工具都显式接收 workspaceId，target/thread/task 参数按对应 workspace 解析。每次调用先核验 Gateway OAuth 身份、项目登记和 root，再进入已有每项目逻辑。

复用现有 Remote store/Controller 与 Result Bus。每个 workspace 独立实例或调用上下文，不创建共享 activeWorkspace、不将任务搬进 Gateway 私有队列。首轮覆盖新建 thread 与已登记 target；既有 thread 的挑选及 Desktop writer 移交留到延后项。

退出条件：同一插件连接和 OAuth client 可对两个本机已授权 workspace 各自创建 target、投递、查询精确 task/result；跨 workspace targetId/taskId、未授权项目及错误 root 均被拒绝；两边任务、历史和结果状态不串线。

### M3：整合旧插件的 feedback 管理

新 Gateway 插件暴露现有 feedback 管理与 Companion/Web Sink 状态能力，至少覆盖 bootstrap/status、enable/takeover、claim/ack、stop、pair、route confirm、revoke、Web Sink list/status。项目级调用显式带 workspaceId 和原有 conversation/client 证明；逐项保留原 scope 与 fresh-state 校验。

直接复用现有 feedback、Bridge connection、delivery arbiter 和 Result Bus 状态机。Gateway 不伪造 Companion 主体、不直接写 binding、不绕开网页 route verification；旧 feedback Connector 暂时继续可用作回退，不自动双发或在 outcome_unknown 后切换插件重试。

退出条件：同一 Gateway 插件在两个 workspace 分别完成只读状态、明确接管/验证和受控回流管理；只读操作零状态写；授权不足或主体不匹配没有副作用；旧与新接口不会为同一 event/attempt 产生第二次发送。

### M4：Companion 多项目连接与回流隔离

让 Companion 明确显示并操作当前已授权 workspace 的连接/route 状态。复用每项目 Bridge endpoint 与现有 connection、route attestation、Web Sink 和 Result Bus；不得把多个项目压成一个当前 binding。每项目连接、事件、reservation、attempt、ACK 与错误日志均留在本 workspace，并保留此前 attempt。

production Send 仍要求该 workspace 当前 route attestation 为 VERIFIED。尚未跨过 begin-send 的 reserved 预约可按现有 release/CAS 协议回到 queued，再为同一 workspace 的合格页面预约；保留既有发送证据。claimed/sendTarget 已冻结、发送已开始或 outcome_unknown 时都不能改投、重发。

退出条件：两个 workspace 分别完成普通 Chat 的连接、真实结果 Send 与 observed/ACK；每条结果能回到唯一原 workspace/event/attempt；一个项目断开、刷新或发生 unknown 不改动另一个项目，也不覆盖旧 attempt。

### M5：双项目验收与旧插件逐个停用门

冻结源码后执行正式串行全量、typecheck、build 和 diff；确认 packaged artifacts、安装身份、当前运行身份和浏览器扩展版本分别可核验。随后通过同一个插件连接完成两个 workspace 的只读、官方投递、结果读取、反馈连接/验证和 Companion 回流验收。

只有新插件覆盖旧插件所需功能，两个项目均通过端到端验收、没有未解决 attempt/授权不明或结果缺口，并有可用回退路径，才逐个停用并移除旧 feedback Connector。每次只停一个并现场检查。按本轮已有的旧插件退役授权执行，无需重复索取授权；保留旧连接的历史、凭据状态与恢复证据，不清理 workspace 状态。Bridge feedback 服务继续保留，直至另有兼容与状态迁移证据证明可以移除。

退出条件：两个项目的权限隔离和端到端记录可独立审查；新旧接口不存在双重发送；旧 Connector 每次停用后其余项目正常。任一检查不清楚即停止停用并保留旧配置。

## 延后项与风险停止条件

这些不是首轮 M1–M5 的阻塞任务，也不得在本轮声称已完成：

- 既有 thread 选择以及 Desktop 与独立 App Server 的 writer 移交限制。
- Controller/Gateway 重启恢复、Key rotation、Gateway 长期运行入口与恢复自动化。
- machine supervisor live acceptance；Windows Task Scheduler 注册需单独授权。
- R5j 性能优化继续 deferred。
- 普通 Chat 原生 Events 唤醒仍未通过，继续由 Companion 负责回流。

workspace/root/client/target 不一致、授权无法确认、存储损坏、进程身份不清或 route attestation 非 VERIFIED 时停止相关写操作并报告。已进入不可逆发送边界的 outcome_unknown 只能核验原 attempt，不换 ID、不自动重试。不得用旧 PID 执行强杀或用旧 durable runtime 记录宣称进程健康。

## 下一新会话入口

先只读刷新 Bridge、Gateway、Controller、App Server、Tunnel 的真实进程身份、端口、installed/running build、锁和 inflight。当前最后一次观察为 09:01–09:02：旧进程均 missing、48766 无监听、Bridge stopped，恢复未执行；早间 08:31–08:34 的成功闭环是历史验收。不要自动恢复、重启、使用 Key 或注册 Scheduled Task。

状态核验后从 M1 开始：只实现本机显式 workspace allowlist 和 client 授权，再进入 M2。提交时以新 commit SHA 和当时 fresh runtime observation 更新交接；本文件不把提交前 HEAD 固定成最终版本。
