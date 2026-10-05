# R5 Endpoint Architecture

## 消息与 endpoint 的职责更新（2026-10-05，源码与后端部署）

[双向消息收件箱](agent-mailbox.md) 将“Bridge 已接收 queued”“Executor 已接受 accepted”“可信执行终态”“网页 observed/ACK”四件事分开。MCP 接收不等待 Executor 空闲；后台发送仍实时验证原 frozen target 和权限。未知任务不能换 ID 重发，但独立新任务可继续排队。Command 的 corrupt lifecycle authority 保留，worker 只跳过这条，不抢锁。

canonical Result Bus 的 isolatedAt 保留原 outcome_unknown/target/reservation/attempt，单条不再占用全局回流槽；不生成成功或 ACK。旧 legacy/control 未获得此合同。当前 VERIFIED Companion 可在权限允许的 frozen route 查询 canonical summary/tests；旧目标结果不因当前面板连接而自动转投或泄漏。

关闭排队 worker 与已有 Bridge shutdown 共享退出流程；maintenance → command → endpoint/store 的锁顺序保留 rollout/安装隔离。修订后的正式串行门禁161 files /3403 tests PASS，465项冻结哈希稳定、残留0，typecheck/build/diff通过；构建三方身份为 `1326542c3601b2919b1872c1d80ac22aab258b05774c5ce438513b0c5aeba3a8`。canonical install 与 Skill 精确替换已核验，workspace `2582910bf0d2` 已 scoped rollout；08:32 复核 build/install/runtime 一致、runtimeUpgrade=current。Companion Reload 已由用户确认。页面组件与真实下发/回流端到端尚未独立观察；Desktop 本机确认已完成，Desktop 与 generic Executor availability=true（采样 activity=busy），投递权限门禁已恢复；真实消息链尚未端到端验收。最终只读核验见[部署快照](development-plan.md#当前事实与开发阶段2026-10-04-2144asiashanghai)。

## 2026-10-04 历史 endpoint 合同与实施状态

最新源码与运行部署快照见[开发计划当前事实](development-plan.md#当前事实与开发阶段2026-10-04-2144asiashanghai)；下文状态表及后续 command/R5 切片保留当时证据。

| 现役边界 | 当前实现与核验要求 |
| --- | --- |
| Core owns bindingId/epoch | CLI/MCP/popup 调核心用例；固定插件 registry 不提供动态加载，平台 adapter 不自行推进全局绑定 |
| Executor 与 Web Sink 独立 | Desktop 绑定与 generic Executor active binding 都需核验；网页连接正常不证明执行端可用。命令目标在 dispatch 冻结，回流目标在相应发送边界冻结 |
| 查询与维护分离 | feedback/companion 状态和面板只读；连接经 delivery arbiter fresh 核验，后台有界维护处理 cleanup/stale/projection，不由 status 扫描全部历史锁 |
| canonical Result Bus | 新 canonical result 只有一条发送权威；旧 outbox/projection 仅在未迁移范围兼容，不为新结果另建发送事件 |
| Companion 平台证据 | 保留 owner document、route attestation、发送 journal 与不可逆边界；接管成功、页面已验证、完整连接、自动回流开关分别显示 |
| 项目任务面板 | 覆盖当前 workspace 全部存续历史和异常，不因换 binding 隐藏。取消/重排/清理各自按核心状态和本机限时授权执行；不提供任意重发或终止执行 |
| 生命周期 | 复用稳定 launcher、maintenance/start/startup-lease。supervisor 只能在 desired=running 且正向证明 stopped 时调用现有启动权威；unknown 不启动或强杀 |

当前网页连接现场已验证为 epoch13，Web Sink 同 route；这是连接事实，真实任务终态回流仍须按 command/attempt 证据确认。历史清零是受授权的一次处置；新任务仍会正常产生记录。Supervisor 已有安装代码，实际任务/配置/runtime 仍未创建，真实独立恢复验收继续待授权。

Bridge 的认证 shutdown 只表示已接收关闭请求。HTTP server 先停止接受新连接，允许在途请求在 1 秒内完成，再关闭剩余连接，避免未传完的请求无限阻塞退出；并发 shutdown 共享完成 Promise。runtime/release pin 仍保留到外部精确退出证明，rollout 的 5 秒退出门禁不放宽。关闭开始、排空期限到达和关闭完成有有界日志。

详细当前合同见 [职责边界第12节](core-plugin-boundaries.md#12-b2b5-剩余源码交付2026-10-04)，历史 repair/abandon 仍使用专用严格协议，不因新面板或连接恢复而放宽。

## 2026-10-04 command49：有效 repair reclaim 恢复，corrupt 仍拒绝

历史损坏锁行政入口新增 strict reclaim sidecar：exact workspace/command/repairId、PID/creation/executable、nonce、target fence完整指纹/hash、createdAt。preview严格只读；只有有效且exact owner missing的claim才可能恢复。confirm以既有machine maintenance为最外层，继而sorted command authorities → evidence/store；双重missing proof与fresh sidecar/target身份复核后才CAS消费stale claim。自己的claim在主fence替换前消费且maintenance仍在，避免发布后留下过时target；原quarantine、same-transaction capability与abandonment batch语义不变。

live/unknown/reused/replaced/corrupt claim仍BUSY；普通writer看到任何repair sidecar始终BUSY。没有递归reclaim maintenance：若真实OS crash遗留maintenance.lock，继续按原机制停止，不能借此自动删除。锁顺序、并发及crash协议见 [architecture](architecture.md#repair-reclaim-的-stale-owner-恢复command49)。command48精确CLI名单修正保留，本轮没有任何真实历史repair/abandon、部署/Bridge recovery、live GC、Scheduled Task或绑定操作。最终门禁见development-plan command49；真实破坏性修复仍须独立审查和新的明确授权，R5j继续deferred。

最终focused18 files/430 tests、typecheck/diff PASS。唯一正式serial full **158 files/3223 tests全PASS、exit0/unhandled0**，wall1711.52s/runner1706.84s；445冻结hash稳定，归属/歧义进程、listener、temp新增均0。full后仅一次canonical build，stored==computeBuildId==core-release.buildId==**`b6a25e1c2b7912fb32f3abfa60556ec67d19ef3d361a1213e8eb5f58fd6303f7`**。没有full后源码/测试修改、第二次full或R5j实验；下一步Planner独立review，真实破坏性修复仍待单独授权。当前源码通过不表示生产锁已修、历史已收敛或release已部署。

## 2026-10-04 command48：损坏锁行政收敛源码，机器历史仍未处置

新增仅服务 historical ownerless Desktop abandonment 的独立 repair preview/双摘要 confirm。正常 lifecycle 锁语义不放宽；零字节 canonical/nlink=1 文件才可能符合 V1，两次文件身份/hash、旧 thread `DESKTOP_NO_OWNER` 和当前 binding/maintenance context 均须稳定。已有 receipt/result/行政证据、cleanup temp/journal、live/unknown/reused process 或任意身份漂移拒绝。

独立 exact-process repair fence 先阻挡所有普通 writer，再把原损坏锁 rename 到 owner-only quarantine，保留原 inode/bytes，持新正常 lifecycle lock 并通过私有 capability 在同一排序事务提交一个原生 abandonment batch。`prepared/adopted_pending/completed` journal 及隔离证据不自动删除或恢复；中断后仅 exact owner missing + 全部证据一致才能显式重放，既有 batch 不重复。详细 lock order、CLI 和 crash 表见 [architecture](architecture.md#历史零字节-lock-的显式行政收敛command48)。abandonment 仍仅为行政停止等待，不是 trusted receipt 或执行成功。

command48 **没有对真实 command10 执行 preview/confirm/rename/delete，没有执行历史五条 abandonment**，也无 Bridge recovery/install/rollout、task 注册/删除/启动、绑定变更或手工 Result Bus 操作。机器部署阻塞尚未解除；下一步先 Planner 独立审查，再取得新的明确破坏性 repair 授权。Supervisor 现有已审语义与 live acceptance 边界保持，R5j deferred。最终正式串行与 build 证据见 development-plan command48；不将 fixture 通过等同于 live convergence。

本轮唯一正式full：158 files/3200 tests，3199通过、1失败，exit1/unhandled0，wall1418.90s/runner1414.87s；445 hash稳定，归属/歧义进程、listener、temp新增均0。失败是CLI命令名单未同步，已仅修正该测试并刷新manifest，定向3 files/51 tests通过；repair45/45及supervisor-store23/23在full通过。全量失败保留，未第二次full，未追加要求full PASS的canonical build。生产源码在full后未变；清单158/3200及1/6/151仅bookkeeping，R5j未执行或提升。Planner仍需审查并安排下一轮最终门禁。

## 2026-10-04 command47：历史收敛被保留锁阻塞，恢复/部署未开始

精确五条（r5g05、r5h10、r5i15、r5j24/26，完整 ID 见 development-plan command47）均为指定旧 thread 的 historical accepted，实时 owner 为 `DESKTOP_NO_OWNER`；当前 binding/thread 可用且不在批次。通过 stable launcher 的生产 `desktop abandon` preview 得到 exact 五条 confirmation，随后一次 confirm 返回 exit1/`DESKTOP_ABANDONMENT_FAILED`。没有 partial success，五条仍 unresolved、skipHistory=false；abandonment 只代表行政停止等待，当前连该状态也未达成。

代码/文件只读诊断定位到 command10 原有零字节 lifecycle lock：生产 confirm 先按排序获取所有命令锁，无法解析的 owner 按 `COMMAND_CLEANUP_BUSY` fail closed，CLI 映射为 generic failure。该锁、dangling runtime authority、原 delivery 全文件字节/身份、records/output metadata、既有 abandonment 及所有绑定均保持原样；没有偷锁、修复、拆批或直接写状态。A 阶段未完成，B/C 的条件恢复未执行，本轮没有重新测 Bridge 健康，也没有安装、rollout、GC apply、Scheduled Task 操作或 supervisor process/pin。

08:14（Asia/Shanghai）current/runtime 文件仍指向旧 `8e155373…e2eebce`、PID16188/creation134355028686992076；checkout `2714cdd9…6a0c1` 的三重 build identity 和442冻结 hash稳定。下一步先独立审查受保护损坏锁与生产 abandonment 协议的收敛方案，再恢复部署；真实 supervisor 注册和 reboot/logon/Codex-close acceptance 继续等待独立授权。command47 仅 docs-only closeout 与正常 same-origin blocked record；不补记或重建旧五条的执行结果，R5j继续 deferred。

## 2026-10-04 command46：部署前阻塞，supervisor 尚未安装/注册

Planner 接受的 command45 source gate 保持有效：442文件冻结稳定，checkout stored/compute/core build 均为 `2714cdd9a48d21881d73800720b66403f829275a5de42006ffaf6001e7d6a0c1`，本轮未重跑 test/typecheck/build。07:56（Asia/Shanghai）机器 current/runtime 仍为 `8e1553735dc817e60d758d8ffb156c41a2758d70562995470f09e1803e2eebce`，PID16188、creation134355028686992076、startedAt `2026-10-03T12:07:50.008Z`，process identified、immutable entry/provenance matching。

当前 Desktop binding 可用且没有 unresolved delivery，但 rollout 对历史的严格评估是 `desktop_unknown`：旧 thread `01a0f4a1-9ca9-7083-b0e8-273056aeb3c6` 无 owner，五条 unresolved 历史记录未被收敛。后续 loopback health 返回 null，authenticated admin 8s响应超时，named health 原有三次探测全部 timeout。Bridge 精确进程仍存在，不能当作 stopped。已停止在 install/auto-GC/scoped rollout 前；没有恢复、强杀、Retire/Abandon、endpoint switch/rebind 或 Result Bus 手工操作。

Reviewed checkout 的只读 supervisor 检查：task **absent**，config/runtime **null**，`bridge-supervisor` 目录不存在；检查没有创建 config/runtime/launch pin/task。GC plan global blocker0，只有原有 dangling reference local issue1；未删除候选或历史状态。四类绑定、无关 runtime、command10 锁与 dangling authority 已作只读取证。机器持久注册和 reboot/logon、Codex-close acceptance 仍待独立授权，先由 Planner 审查当前两个现场阻塞。command45 回执不补记；本轮仅请求 exact command46 正常 same-origin blocked record。详情见 development-plan command46 和 ignored `.tooling/command46/`。

## 2026-10-04 command45：测试任务拆分与正式门禁

本轮仅拆分测试及更新计数/hash bookkeeping 和文档，**supervisor 生产语义未变**。官方 test 仍 `vitest run`，candidate 仅同步157/3150、packaging1/serial6/parallel150、support32，workers3、experimental/deferred；未运行 candidate/parallel/worker 实验。 command44 的 launch-pin → runtime-pin handoff、truthful registration、uninstall self-retire、legacy maintenance fence 及 live old-release GC 保护全部保持原样。supervisor-store 从15项拆为23项独立 fixture，原断言与真实 Windows ACL/身份操作保留；未调整 timeout/retry。最终 standalone **23/23 PASS**，wall 609.45s / runner 606.60s，最长单项 **53.29s <55s**；其余 supervisor/lifecycle、CLI、launcher、Windows Task、release-reference 及 manifest guards **6 files / 80 tests PASS**，合计 focused **7 files / 103 tests PASS**；typecheck、git diff --check 通过。

唯一正式 `pnpm test --maxWorkers=1 --testTimeout=90000` 为 **157 files / 3150 tests PASS，exit0，unhandled errors 0**；wall **1561.23s** / runner **1556.18s**，full 内 supervisor-store 最长单项 **54.26s**。无 skipped/pending/retry，442 个 source/test/support 冻结哈希稳定；command44 生产代码与未改 core-install 测试哈希保持一致；core-install 本轮32/32通过，原EPERM未复现。新增 test-tmp 目录、归属/歧义进程及 listener 均0（全局新增进程也为0）。 full PASS 后仅执行一次显式 canonical build，stored build-id == computeBuildId == core-release.buildId == `2714cdd9a48d21881d73800720b66403f829275a5de42006ffaf6001e7d6a0c1`。

下一步由 Planner 独立复核测试结构与门禁证据，再另轮授权安装/真实 Scheduled Task 注册及 reboot/logon、Codex close、Core upgrade/GC 旧 release pin 与恢复边界验收。本轮没有真实 task 注册/删除、install/rollout、生产 Bridge restart/stop、live GC、endpoint switch/rebind、Retire/Abandon 或 commit/push。详细时序和初轮57.27s未达标证据见 development-plan command45 与 `.tooling/command45/`。

标准 same-origin record 返回 `DESKTOP_RESULT_NOT_APPLICABLE`，没有生成回执：原 command45 turn 已 failed，用户“继续”处于新的普通 turn，不能代记旧 delivery。source gate PASS 保留，receipt 缺失另行报告；binding 未变，无 `--task` 回退或手工 Result Bus 操作。Planner 应只读复核实际证据，不能据此声称已完成可信终态回执闭环。

## 2026-10-04 command44：supervisor 启动交接与显式生命周期

> 本节保留当时实现及失败证据；最新门禁与下一步以 command45 为准。

当前 source 修复四项 lifecycle P2：launch pin 只保护启动窗口，exact runtime fsync/atomic publication 及 ownership 验证完成后，通过已验证的 pin capability 严格删除原 filename/nonce/content/file identity；launcher 不再按 child exit 删除 pin。交接前失败与替换证据保留；交接后运行期仅 runtime pin 保护旧 release，crash/reboot 后只有 exact missing process proof 可以回收旧 lease/runtime。

install 在 operation fence 内按 `stopped/none → register + fresh exact-owned inspection → running/windows-scheduled-task` 提交；失败不启动 Bridge。uninstall 按 `stopped → exact task removal/confirmed absence → stopped/none` 提交，loop 遇到 none 自退并释放 runtime。移除失败/冲突保留 stopped/windows-scheduled-task，最终 config 写失败仍报告失败，可由后续显式 uninstall 收敛；status 始终只读分别呈现 config 与 task 实际 inspection。pause 仍保留注册并 idle。所有这些操作不停止或重启 Bridge，不改变四类 endpoint bindings。

无 supervisor evidence 的旧 start/stop/restart 只复用 existing machine maintenance fence 来与首次 install 排序，不进入 supervisor ACL/process probe/ScheduledTasks 或创建 supervisor state。start/restart 传递 inherited maintenance handle，原 ensure/startup lease/start.lock 仍是唯一启动 authority。配置/损坏/orphan 状态继续严格拒绝；竞争 busy 时动作没有完成，不能宣称 stop 成功。rollout 不修改 desired state。

Scheduled Task SID、AtLogOn、InteractiveToken/Limited、stable launcher 与 settings 保持不变；GC 继续保护 live exact old-release runtime，unknown/corrupt pin fail closed。R5j 保持 experimental/deferred，无 candidate/worker 实验。当前仅 source/tests/docs；正式冻结 full 及 build 证据见 development-plan command44 与 `.tooling/command44/`。真实 task 注册、reboot/logon、Codex close、升级后恢复仍待 Planner review 后另轮授权验收，本轮无生产部署或持久机器任务变更。

最终 focused14 files/379 tests、typecheck/diff PASS。442 hash冻结后的唯一正式 full 为 **157 files/3142 tests passed，但1个 unhandled `Timeout calling "onTaskUpdate"` RPC error，exit1，门禁 FAIL**；wall1604.38s/runner1599.06s。日志不含该错误的具体task/file，不能断言与supervisor相关，未调整runner/timeout或追加full。未改core-install32/32通过，原EPERM未复现；所有78项supervisor/GC回归通过。冻结hash稳定，新增目录/归属及歧义进程/listener均0，全局新增5进程被精确祖先链证明无关。packaging内两次build通过，三方ID只读复核为 `2714cdd9a48d21881d73800720b66403f829275a5de42006ffaf6001e7d6a0c1`；未执行额外post-PASS build。当前等待Planner复核与后续门禁，不能据断言passed宣称完整验收通过。

## 2026-10-03 command43：R5i-b/c supervisor foundation 当前状态

> command43 的历史状态保留；当前 launch-pin/registration/uninstall/legacy 合同由 command44 覆盖。

当前优先级已从 R5j 性能优化切回产品/lifecycle 工作：R5j 继续 experimental，worker4 未获接受，官方候选仍 workers3；command42 及更早记录完整保留，但它们的 NEXT 已被覆盖。R5j 优化推迟到当前产品/lifecycle 与 supervisor live acceptance 完成之后最后处理。

command43 已实现每-workspace strict desired-state config、短 operation lock 与长 exact supervisor lease。每个 observation/recovery 周期在 operation lock 内重新读取状态；显式 start/restart 先写 `running`、stop 先写 `stopped`，写失败即停止后续动作；rollout 不切换 desired state。`stopped` 不恢复；`unknown`、应用超时/探测不确定及 maintenance/start-lock busy 不 spawn、不 kill，只按有界 backoff 重查。仅已证明 Bridge stopped 才调用现有 safe start authority；tunnel 配置为 true 时只接受同 workspace 已有且 ready 的 named tunnel，并验证 public identity。Supervisor 不改变 Desktop/Feedback/Web Sink/Executor binding 或 endpoint target。

`supervisor install` 注册精确的 current-user AtLogOn task 并提交 `desiredState=running`，不会立即启动 task 或 Bridge；首次自动启动等下一次用户登录。`pause` 与 `uninstall` 都先置为 stopped，uninstall 只删除 exact-owned task；二者不停止当前 Bridge。只读 Windows audit 代表性地确认 ScheduledTasks module 1.0/cmdlets、当前 SID，以及 SID principal + `AtLogOn`/`InteractiveToken`/`Limited` 与 `StartWhenAvailable`/`IgnoreNew`/`PT0S`/3×`PT1M` settings 可表达；本轮没有真实 task 注册。

Scheduled Task 固定调用 stable machine launcher，不引用 checkout/release-specific entry。launcher 在 maintenance fence 内先写 exact launch pin，再加载 current immutable release；只有确认 child exit 且 pin identity 仍精确时才删除 launch pin，结果不确定则保留 orphan pin。运行中的 supervisor 随后持 exact runtime pin。GC graph 收集两种 pin：精确 build（包括 orphan launch pin）被保留，损坏/身份不符/未知 supervisor 引用 fail closed。升级或新登录不热切换仍存活的 supervisor；旧进程继续执行其 pinned release，直到退出后下一次实际 Task launch 才由 stable launcher 选取届时 current。`IgnoreNew` 防止重叠 supervisor；当前 slice 不含即时 restart/handoff。

**下一步**：Planner 独立 review 后，另行进行真实 Scheduled Task 注册和现场 reboot/login、Codex 关闭、Core update/GC 与安全边界验证。上述均尚未执行，本轮也没有 install/rollout/restart、task 注册或 endpoint/binding 变更。GC 新增的 4 个测试及既有 85 个回归测试已通过，stop race 已修复。

唯一正式串行 full（`pnpm test --maxWorkers=1 --testTimeout=90000`）完成 **157 files / 3126 tests：156 files、3125 tests PASS，1 file/1 test FAIL，exit1**；wall1311.34s、Vitest1306.27s。失败为 `tests/core-install.test.ts:347` 的旧 v1 pointer fixture 在 `fs.renameSync(checkout, moved)` 返回 Windows EPERM；尚未到其后的 launcher assertion，具体占用方/系统原因未取证。未改该测试或相关生产代码，随后仅一次 standalone core-install 32/32 PASS（Vitest15.71s），此诊断不能覆盖失败 full，未第二次 full、未加 retry 或放宽 timeout。**当前门禁仍 FAIL，不能据此宣称 source acceptance/deployment ready；下一步由 Planner 独立复核失败及源码，再决定另轮最终门禁。**

此前相关 focused 共339项通过，覆盖 supervisor/store/CLI/task/launcher、runtime/daemon/startup-lease、GC/rollout 与覆盖守卫；新 supervisor/GC 62项在 full 中全部通过。开发中修复了 Windows atomic rename 的 ctime 误判和重复 ACL 校验导致的 CLI restart 25s预算超时，复测真实 restart17.03s，原 timeout不变；typecheck与最终diff-check通过。442个source/test/support hash在full及诊断后不变，157文件完整枚举，无skip/pending/retry；新增test-tmp目录、global-new/归属/歧义进程和listeners均0。full中的packaging测试通过并运行了两次 `pnpm run build`；stored/computeBuildId/core-release.buildId均为 `61480f6d81640a12f45785e041a1937f616480a7f546e64b9ee842026e8d7e31`。因为正式full未PASS，未执行额外的post-PASS build。

证据保存在ignored `.tooling/command43/`（full.log、full-audit.json、core-install-diagnostic.log、build-identity.json、frozen.json）。覆盖清单仅为新增测试同步到157/3126、packaging1/serial6/parallel150、support32；官方candidate仍workers3、experimental/deferred，acceptance_ready=false、authoritative=false，没有运行R5j candidate或worker实验。早期失败/中断的隔离fixture移至command43目录留证；未删除历史输出或事后清理full残留来制造通过。生产Bridge仍待部署，未注册/删除真实Scheduled Task、未install/rollout/生产restart/endpoint switch/rebind/Retire/Abandon/commit/push。最后使用正常same-origin command43 failed record；trusted终态和Browser ACK由原有流程确认。

## 2026-10-03 command42：R5j update-check fixture优化与worker4复测

本轮只改update-check测试fixture、该manifest hash和三份docs；生产endpoint、Browser及src/cli/update-check.ts均未改。command41保守进程归属实现与测试逐字节保持。suite seed使用普通独立Git对象文件与相对origin/upstream，每例复制整对并验证路径、完整hash和无共享链接，strict teardown；七个场景及172次真实Git操作同序。初始化49→10次，前后standalone均7/7 PASS，wall41.6751→35.2293s、省6.4458s（15.47%），未达8s故不追加优化复杂性。candidate guards17/17、typecheck/diff PASS，151/3064与1/6/144分组、32 support hashes不变。

唯一worker4实验功能/安全PASS：151/3064全passed、无skip/pending/retry/repeat/flaky，phase32.66/61.53/399.00s顺序无重叠；430hash、dist及三方build7550f6aa658123f608ca41dd7e9c51db1c2819c7e19c65f749a54604e6ac5734稳定，归属/歧义/全局新增进程、listener和temp残留均0。但wall505.25/runner505.11s超480s，candidate exit0、验收wrapper exit1。**worker4_not_accepted；官方experimental candidate仍workers3，acceptance_ready=false、authoritative=false。** update-check83.07s比command41省7.23s，fork241.97s增19.60s，整轮慢7.03s；不将一次负载变化当作优化因果或稳定性证明。

NEXT：Planner独立复核后继续fork-scripts/进程竞争诊断；七用例、八热点与原始路径见[r5j profile](r5j-regression-profile.md#command42update-check-seed节省645sworker4仍超时2026-10-03)。本轮未第二次full/三连跑/authoritative serial full，官方test/CI/default gate不变，无install/rollout/GC/endpoint switch/rebind/Retire/Abandon/commit/push。精确command42仅正常same-origin标准record返回，不使用task fallback/manual Result Bus，不预称trusted终态或Browser ACK。

## 2026-10-03 command41：R5j归属审计修复与worker4单次实验

本轮只改candidate runner/test/support hashes和三份docs，production endpoint及Browser行为不变。进程审计先锁定当前runner的精确PID/Created，再用父链确认归属或其他pre-run身份；断链、消失父进程、PID复用/时间顺序/元数据歧义均fail closed，无名称allowlist。监听端口只随归属/歧义进程失败，保留全局新增等诊断计数；不采集命令行/env。focused17/17、typecheck/diff通过，当前覆盖仍151/3064、分组1/6/144。

唯一worker4实验151/3064全passed、candidate exit0，顺序与无retry/repeat/skip/pending/flaky核验通过；430hash及dist不变，global-new/attributed/ambiguous/unrelated进程、listener、新test-tmp目录均0，三方build仍`7550f6aa658123f608ca41dd7e9c51db1c2819c7e19c65f749a54604e6ac5734`。wall498.22/runner497.87s仍超480s，实验验收wrapper exit1，**worker4_not_accepted，官方candidate保持workers3，acceptance_ready=false、authoritative=false**。parallel387.51s比command40减少75.43s，但单次不能区分worker变化和机器负载或证明稳定性；command40性能失败不被归属修复抹去。

NEXT：Planner独立复核归属边界及fork-scripts/update-check热点；八项热点、CPU及原始证据见[r5j profile](r5j-regression-profile.md#command41保守进程归属修复worker4单次超时官方仍workers32026-10-03)。本轮未重复实验/正式full、改变官方test/CI/default gate、安装/rollout/GC/endpoint switch/rebind/Retire/Abandon/commit/push。当前command41按正常same-origin标准record返回，不使用task fallback或人工Result Bus操作。

## 2026-10-03 command40：当前3064候选验收停止

当前候选状态为**experimental_blocked、acceptance_ready=false、authoritative=false**。430个source/test/support冻结hash与当前正式串行151/3064基线一致，manifest151文件、32 support hashes、packaging1/serial6/parallel144核验通过；唯一共享dist writer和六个串行fences未变。command39的3054三连跑仅属历史，不能替当前基线晋升。

只完成run1：151个唯一文件/3064测试全passed，无skip/pending/retry/repeat/flaky，三阶段1/1、6/69、144/2994按序不重叠；phase exit0，但candidate机器审计发现5个新增存活node/cmd，故总exit1。只读归属为既有Codex app-server的CUA/MCP子树，未见测试runner/fixture引用；保留原始审计失败。wall571.66s、runner570.65s均超过480s，packaging/serial/parallel为32.34/62.28/462.94s；严格STOP，run2/3未启动，无修复、重试或事后清残留。

barrier及结束复核的stored/computeBuildId/core-release均`7550f6aa658123f608ca41dd7e9c51db1c2819c7e19c65f749a54604e6ac5734`；dist字节/目录和430冻结hash不变，新增test-tmp目录0、listener0。当前thread/binding核验精确，本轮无endpoint switch/rebind/Retire/Abandon或运行时部署；普通same-origin标准record负责本轮返回，不手工操作Result Bus。详细热点与证据目录见[r5j profile](r5j-regression-profile.md#command40当前3064基线首轮未合格streak停止2026-10-03)。正式串行门禁、package.json官方test、CI/default gate保持原状。NEXT：Planner独立复核本次失败，当前不具备promotion资格。

## 2026-10-03：原配对认证复核与 Bridge 恢复（普通用户请求）

实查 Bridge 原 PID16844 已不存在，local/admin 请求失败；原 Companion fbf58987-6868-40d2-8189-00fbeb4967f9 未 superseded、route attestation verified，Feedback binding/epoch 仍6135d264…/11。通过 current installed stable launcher 为2582910bf0d2执行 start --tunnel，复用原 named URL；新PID16188/creation134355028686992076/startedAt2026-10-03T12:07:50.008Z，运行8e155373…e2eebce，local/admin/named exact通过，四份Desktop/Feedback/Web Sink/Executor store启动前后逐字节不变。系统只读查询确认LastBootUpTime=2026-10-03T09:44:22.3476590Z（北京时间17:44），晚于旧Bridge启动；原进程随机器重启消失，之后未自动拉起。旧runtime没有matching graceful intent；未发现相关Application1000/1001崩溃事件。不能把该观察归因为Codex updater；机器启动后的独立恢复仍缺失，R5i supervisor/lifetime尚未完成。

已证明恢复缺口：旧版 authStale 一旦durable写入，requireProtectedTransport阻断GET /state，watchdog也被停用，失去用同一凭据复核的路径；旧版未记录触发原因，本次最初401/identity异常的来源未知。修复仅放行相同protected credential的只读/state复核，身份/route响应严格校验；exact成功持久化后才能清authStale。超时、5xx、401、身份漂移/坏响应、持久化失败均不授权Send；坏200响应不再被当成凭据已撤销的证据。请求身份与认证失败revision隔离迟到响应，bounded authStaleReason不含原响应文本。已有一分钟discovery alarm可复核旧标记，不拥有owner或Send能力，不re-pair/rebind/clear target；mutation gate、journal和route fence保留。popup允许GET /state并改为“认证待复核—保留原配对”，stale时productionEligible=false。

相关9 files/431 tests、typecheck/build/diff通过；checkout build三方ID=7550f6aa658123f608ca41dd7e9c51db1c2819c7e19c65f749a54604e6ac5734；最终正式串行full 151 files/3064 tests全PASS、exit0，Vitest1062.22s/wall1065.24s；430个冻结source/test/support hash在full前后不变，新增目录/child/listener/connection均0，build三方ID复核不变。新增10个auth恢复回归，151文件覆盖不变，candidate expectedTests更新3064并精确刷新hash；command39的3054测试三连跑仍是历史冻结基线，不代表新代码已获候选晋升资格。无Core install/rollout/GC/commit/push；用户重载扩展后用原凭据点击一次连接，实测同companionId/binding/epoch恢复connected、authStale=false、owner=true、VERIFIED、mode=armed、health=ready/journal=NONE，无重新配对；证明原凭据仍有效。command39原trusted output241随后从queued进入正常claimed，attempt885d8b4b-6e9f-4411-a568-94de07dad56f，未重录或人工Bus操作；后续只读检查原record与Bus项均已不存在，不把absence单独当作Browser observed/ACK独立证据。本轮为普通composer请求，不补记command39或伪造same-origin receipt。

2026-10-03 command39：R5j fresh三连跑在同一430 hash冻结集合上全部合格，candidate=`acceptance_ready`、authoritative=false。每轮151/3054全passed、exit0、retry/repeat/flaky/skip/pending均无；packaging1/serial6/parallel144按时间戳有序且不重叠，32 support hash精确。wall=476.71/459.78/450.11s，runner=475.80/458.88/449.23s；phase分别29.51/57.64/376.66、30.71/56.49/360.63、27.66/54.44/356.18s。wall min/median/max/mean450.11/459.78/476.71/462.20s，runner449.23/458.88/475.80/461.30s；最慢wall余量3.29s。每轮新增目录/child/listener0、dist字节/目录不变、430hash稳定，barrier三方build ID均`8e1553735dc817e60d758d8ffb156c41a2758d70562995470f09e1803e2eebce`。六个热点实测与原始报告位置见r5j-regression-profile command39。NEXT为Planner独立promotion review；官方test仍vitest run，正式门禁仍串行full，未改CI/default gate或生产语义。本轮仅候选三次及结束后docs/diff/正常same-origin record，无正式full、packaging外build、install/rollout/GC/endpoint/rebind/Retire/Abandon/commit/push，不预称Browser ACK；updater resilience仍未证明。

2026-10-03 command38：command37 reviewed build已安装并仅rollout workspace2582910bf0d2，built/installed/running精确为`8e1553735dc817e60d758d8ffb156c41a2758d70562995470f09e1803e2eebce`；upgraded1/pending0/error0，runtimeUpgrade=current/upgradePending=false。新PID16844、creation134354837905238319、startedAt2026-10-03T06:49:51.686Z，immutable entry/provenance matching，旧PID22824原身份已消失；local/admin/named exact健康（最终named3次内成功）。Desktop available、unresolvedDelivery=false，Feedback/Companion route VERIFIED；所有四类binding、其他workspace runtime、command10未知锁与dangling authority保留。install完整artifact及installed短锁模块逐字节校验PASS，430冻结hash不变；未重复full/candidate/typecheck/build。auto-GC deleted0/tombstoned0/bytes0，partial仅known dangling exact引用（global0/local1）；rollout后旧8256成为唯一候选，未追加GC apply。生产只增加reviewed acquisition分类，无锁抢占或synthetic contention；endpoint/receipt权限边界不变。仅文档同步与diff-check，最后正常same-origin record，不预称Browser ACK。NEXT为正常回流确认后的新R5j候选三连跑，candidate仍experimental/updater resilience未证明；无rebind/Retire/Abandon/commit/push。

2026-10-03 command37：execution output/records 私有 acquisition 分类统一，EEXIST 与 Windows-only EPERM/EACCES 仅在 `openSync("wx")` 失败后沿用500ms/10ms等待，到期typed BUSY；非Windows权限错误及其他errno原样失败。不reclaim任何锁，不改变action/fsync/close/unlink错误、receipt身份、记录顺序或endpoint权威。隔离原始短锁竞争前后实际复现EPERM14/22次；真实output前后各480写、records混合480追加完整无锁残留。确定性注入证明sync/async预算及提交后错误不成为BUSY、调用方不重复写入。focused10/211与typecheck/diff PASS；最终一次正式serial full151/3054全PASS、exit0，Vitest948.11s/wall950.65s，430hash在full/build前后不变，focused/full新增目录/child/listener/connection均0。canonical build三方精确ID为`8e1553735dc817e60d758d8ffb156c41a2758d70562995470f09e1803e2eebce`。151/3054及candidate分组、command36 fork seed优化保持；本轮不跑候选、不部署/GC/rebind/commit/push，最后same-origin record的trusted/canonical handoff由terminal finalizer核验，不预称Browser ACK。NEXT为Planner review后另行候选验收，candidate继续experimental，生产8256及updater resilience未证明不变。完整证据见r5j-regression-profile command37。

2026-10-03 command36：R5j-c2只优化fork-scripts fixture bootstrap，dev/upstream suite seed以普通独立文件复制，每例/seed hash、canonical路径、无链接/nlink检查与strict teardown；13个原测试体/断言、22次生产PowerShell调用和50次场景Git调用未变。standalone13/13 PASS，wall111.18→97.37s，bootstrap9.04→2.97s；focused guards17/typecheck/diff PASS。唯一候选151/3054中3053 PASS/1 FAIL，exit1，wall450.51s/runner449.60s，phases27.69/57.59/350.99s；fork13/13 PASS124.85s。429冻结hash、dist与三方build8256ad7b…3016765稳定，新增目录/child/listener0。失败是未改output-atomicity四writer的Windows `index.json.lock` open EPERM；单独诊断14/14 PASS不覆盖失败，精确系统原因尚未知，未改生产锁语义。candidate继续experimental/blocked，未启动第二轮/三连跑或正式full；NEXT为Planner review后聚焦output lock EPERM，再恢复候选验收。本轮未部署/GC/rebind/commit/push，endpoint及生产权威边界不变。

2026-10-03 command35 R5j-e验收：候选覆盖合同收紧为151文件恰好一次/3054测试精确相等，全部state必须passed；packaging1/serial6/parallel144保持。两轮功能均151/3054 PASS、exit0，外层463.35s/485.86s（runner462.47s/484.90s）；第2轮超480s，依规则不启动第3轮。429冻结hash稳定，每轮dist不变、目录/child/listener残留0，packaging三方ID均8256ad7b…3016765。focused17/typecheck/diff PASS，无production/package.test行为变化、无新正式serial full或部署。候选仍experimental/performance blocked，不能标acceptance_ready或替代正式serial gate；NEXT聚焦fork-scripts实测155.85s的fixture/PowerShell/Git启动成本，保留真实跨进程及OS覆盖。具体统计见r5j-regression-profile command35。command34 GC已review闭环、暂无GC跟进；updater resilience仍未证明。

2026-10-03 command34当前部署/GC状态：built=installed=current=running=`8256ad7b704e7c109973b5c1436253f05a59aa24ed157fc766fbecfad3016765`。自动GC仅删除预冻结13项/929,156,162 bytes；旧runtime exact identity消失且fresh plan仅剩59e后，显式GC一次仅删除59e/72,081,745 bytes；合计14项/**1,001,237,907 bytes**。active releases从14（安装时15）变2再变1，最终candidate0/unknown0/global0/local1。partial/ok=false仅保留runtime:d94af68105aa→missing9c33929c…ce0732a的exact dangling告警，authority不动。

首次rollout完成进程替换后，cloudflared查询既有tunnel的API超时，报告restart_failed；stable start --tunnel复用新Bridge恢复同URL后，scoped rollout收敛current1/pending0/error0，无二次重启。PID23616→22824，creation134354762025198833/start2026-10-03T04:43:23.621Z，旧identity missing；local/admin/named均精确200，upgradePending=false。四个binding store、其他workspace runtime、command10未知锁与dangling authority未改，core finalizer/worker/retirement均0。本轮新增tombstone0；9月历史gc-trash `637edb28…bee.bbd79e2e…34c` 保留，不宣称整个trash为空。429冻结hash、三方build和full artifact核验通过，未重跑已审full/candidate/build。完整过程见development-plan command34；下方command33为源码实现时的历史记录。NEXT为Planner复核live GC及标准回流后恢复R5j，updater resilience仍未证明。

2026-10-03 command33：GC per-release fail-closed 源码已实现，部署仍待 Planner review。本节覆盖旧 GC 全局传播规则，不改变 endpoint/delivery/command cleanup 权威。issue 使用显式 global/build/release scope；current 或无法确定目标的 runtime/finalizer、目录遍历/ownership 不确定仍全局阻断；exact runtime/pending（含 capabilities/未来额外字段）保留目标 pin，dangling exact 引用只告警，坏 release 只隔离本项。plan 暴露 safety/globalBlockerCount/localIssueCount/issueDetails；apply 允许 initial/fresh 稳定候选交集部分推进，每项 tombstone 前重验引用、maintenance/rollout/start fences 与路径。全局问题停止后续删除，局部问题不污染独立候选；strict retirement/death proof 与 no-follow 保持。partial 仍 ok=false/CLI exit1，installer best-effort 安装语义不变。

真实机器只读前后：14 releases 从 keep1/unknown13/candidate0 变为 keep1/unknown0/candidate13，global0/local1，可回收929,156,162 bytes；current 与本 workspace runtime 保留59e436b7…dc56371，另一 workspace 的9c33929c…ce0732a缺失只保留 exact dangling 告警。authority 文件身份/字节读取前后不变；未 live apply/install/rollout。最终验证与 build 见 development-plan command33；NEXT 为 Planner 审查 destructive semantics 后的部署/真实清理验证，再恢复 R5j，updater resilience 仍未证明。

command33最终验证：正式serial full为151 files/3054 tests PASS、exit0，Vitest938.81s/墙钟941.24s；429冻结hash稳定，新增目录/child/listener/关联连接0，typecheck/build/diff PASS。新checkout build三方ID为`8256ad7b704e7c109973b5c1436253f05a59aa24ed157fc766fbecfad3016765`，未安装。首轮full唯一旧runtime-prune诊断断言失败（3053/3054通过），更新为显式global missing-build阻断后相关41项通过，再完成上述最终full；失败记录保留。正常同源command33 record留到本轮最后，不预称Browser observed。

2026-10-03 command32部署核验（历史）：Planner已review command31 PASS；目标`59e436b7b4b16a9f21a96c745c27e9cbe5d5d269d6e77d1ae056d3f5edc56371`在上一轮用户授权恢复时已安装运行，本轮full artifact/hash/进程身份与local/admin/named均重新验证通过。stable scoped rollout返回current=1/upgraded=0/pending=0/error=0，PID23616未重复重启；429冻结hash不变，runtimeUpgrade=current，binding和其他workspace runtime保留。command10未知锁未动，read-only cutover ready、49suppression且legacy in-flight=0。近期command31 exact回流证明同版本路径可用；本轮无外部Edge tab可见性，未独立抓取当前认证`/state`。新command32在same-origin最后record，终态receipt/新结果投影/网页observed留给正常流水线与Planner后验。没有重跑full/candidate/build、重复install/GC或人工Bus操作；上轮GC为13项保守跳过、零删除。

状态：**R5d1/R5d2/R5d3 已完成；R5e dynamic endpoint switching 已通过 independent review、137 files / 2699 tests 全量回归及 live rollout/binding 验证；R5f lifecycle independence 与保守 legacy retirement 已通过 Planner independent review，部署待验证；R5g local preflight complete / live pending，command08 已完成 exact 14 batch abandonment，但 E 阶段安装前验证 blocked**（含 R5a contracts + R5b Active Executor Binding + R5c Active Web Sink Binding）。
R4 persistence/wire 不迁移、不删除；R4 Result Outbox 保留为兼容 shadow（可写/可读，用于回滚与审计），
但不再是 production canonical delivery 权威。

本文冻结 R5 目标架构概念、依赖边界与 migration 顺序。

2026-10-03 command31：本机控制HTTP与公网客户端边界明确分离。Bridge端口冲突后可由OS分配任意合法端口，故health/admin/doctor本机MCP使用固定`127.0.0.1`的Node HTTP bounded client，避免Fetch forbidden-port表产生TCP之前的false negative；不迁移named HTTPS、Browser或MCP SDK streaming客户端。总deadline覆盖connect/header/body，响应上限1MiB、无pool/redirect/retry；health 2s+live PID单次8s及authenticated exact runtime规则不变。admin保留错误message/非JSON fallback与调用方timeout；doctor本机POST以8s总deadline继续要求401。

command31验证：定向18 files/386 tests PASS；唯一正式serial full为151 files/3027 tests PASS、exit0，Vitest922.72s/墙钟925.20s；429个冻结文件无漂移，新增目录/child/listener/关联连接均0；typecheck/build/diff PASS。stored/computeBuildId/core-release build ID均为`59e436b7b4b16a9f21a96c745c27e9cbe5d5d269d6e77d1ae056d3f5edc56371`。部署pending Planner review，未install/rollout/GC；command28 canonical projection-before-legacy与Browser观察修复未改，旧command27不重建/重发。command31仅在最后请求同origin标准receipt，不预称Browser observed；后续部署后GC per-release redesign仍优先于R5j验收。

2026-10-03 10:56后续恢复更新（覆盖上段历史部署pending）：原command31已存在trusted output233/ok与canonical result，但旧c681运行时的legacy-first降级路径仍阻止新Bus投影。用户另行明确授权后，已将三方校验一致的`59e436b7…dc56371`安装并仅rollout当前workspace；PID23616，local/admin/named精确通过，四类endpoint binding及其他workspace runtime未变。保留command10未知锁，GC跳过13项且零删除。正常Browser请求投影出唯一Bus entry并生成attempt `7b87c323-ea5d-45a5-85fa-a1fcde52ca2d`，随后本地command artifacts消失；用户进一步确认网页已收到且ATTEMPT_ID一致，原回流与正常ACK后自动清理完成精确对账。没有重录、重发、人工Bus操作或放宽same-origin语义。NEXT优先GC per-release redesign，再恢复R5j验收；updater resilience未证明。

2026-10-03 Browser observation兼容修复（live恢复PASS）：command29已有精确attempt的USER消息，但ChatGPT rich paragraph的链接favicon产生额外布局换行，外层按钮/占位文字又污染父innerText，故未ACK并阻塞queued command30（trusted output232）。仅对已证明的现代USER单rich paragraph增加有界文本+BR重建；链接可见label必须完整，隐藏正文/未知shape/文本漂移继续拒绝；仍要求全文与ATTEMPT精确相等。late-positive只沿原attempt ACK，零重发/重定向。7 files/364 tests、typecheck/build/diff通过；checkout build三方身份为`98218285087871bedd88780fdb46781406a073310d13cc7611d398697cd12898`。

用户reload扩展、刷新原页面并显式恢复同route本地document owner后，Companion对原command29 attempt `95d3f052-4435-4f7c-91d1-706139e341bf`报告`late_positive_observed_then_acked`成功；command30随后正常回流，用户提供网页attempt `12b7c2e0-f50c-42ce-a0c7-08784069be62`。2026-10-03 09:58:21（Asia/Shanghai）installed只读检查两条command的delivery/receipt/result/Bus已自动清理。未人工ACK/cleanup、未重录/重发、未改服务端binding；Core仍PID3380/build `c681654a…fd7f3f`。本轮没有Core部署或正式full，额外full次数授权仍待取得；R5i-e刷新后自动恢复owner仍未完成。

---

## 1. 目标拓扑

```text
Web Planner  →  Bridge  →  Executor Binding
                     ↓
              canonical Result Bus（R5d3 production authority）
                     ↓
Web Sink     ←  Bridge  ←  canonical Execution Result
```

三者彼此独立：

| 角色 | 职责 | 非职责 |
|------|------|--------|
| **Request Client** | 请求来源（当前为 ChatGPT MCP request） | 不是永久 result destination；不在 Endpoint Core 中拥有 planner routing authority |
| **Executor Endpoint** | 执行本地编程任务 | 不负责把结果送回某个固定会话 |
| **Web Sink Endpoint** | 接收 canonical result | 不假设一定是某个 AI 站点 |

长期语义：

- `Web Planner → Bridge → 当前 Executor Binding`
- `Executor Result → Bridge Result Bus → 当前 Web Sink Binding`

**不是**：原 ChatGPT conversation → 固定 Codex thread → 回原 ChatGPT conversation。

Bridge 是唯一中枢：`Plugin ↔ Bridge ↔ Plugin`。禁止 Plugin 直接互连。

---

## 2. 冻结概念

### 2.1 Request Client

只是请求来源。当前实现可以是 ChatGPT MCP request。
新 Endpoint Core **不**给它 planner routing authority，也不把它当作永久 sink。

### 2.2 Executor Binding

Generic identity：

```text
ExecutorBindingCandidate {          // plugin 发现
  pluginId
  workspaceId
  workspaceRoot                     // absolute
  instanceId                        // opaque
  sessionId                         // opaque，不必 UUID
  locator                           // bounded string map
}

ExecutorBindingStamp {              // Bridge 所有
  bindingId
  epoch
  boundAt
}

ExecutorBinding = createExecutorBinding(candidate, stamp)
```

约束：

- **Bridge 拥有** `bindingId` / `epoch` / `boundAt`
- plugin 只 `discoverCurrent()` session candidate，**不得铸造** binding 元数据
- generic core 不出现线程/回合/主机/项目或具体产品字段名
- locator：key 数有限、safe ID key、value 有长度上限
- fail closed（strict schema）

### 2.3 Executor Delivery Snapshot

```text
ExecutorDeliveryTargetSnapshot {
  version: 1
  bindingId / pluginId / workspaceId / workspaceRoot
  instanceId / sessionId / locator / epoch
  frozenAt
}
```

**一旦 command 准备/开始投递，实际 executor identity 冻结。**
后续即使用户切换执行工具，旧 command **绝不能**被重发给新 executor。
比较必须覆盖全部 identity 字段（含 `workspaceRoot` 与 locator 结构相等）。

### 2.4 Canonical Execution Result

继续沿用 R4 canonical ExecutionResult wire/persistence（截至 R5c 不改）。
R5d 起，result 投递目标从「plannerRoute-pinned」迁移到 Workspace Result Bus。

### 2.5 Workspace Result Bus（R5d1 shadow / R5d2 delivery）

- queued result 跟随 **当前** Web Sink
- send attempt 一旦 `begin-send`，target URL/epoch 固定
- `outcome_unknown` **禁止**自动改发新 URL

R5d1 已建立 Bridge-owned、planner-independent Result Bus 持久化与 canonical-result shadow/backfill，
并接入生产 seam：`reconcileTrustedDesktopExecutionResult` 在 R4 canonical result/outbox 落定后，
以 persisted canonical RoutingResult 为源幂等补建 Bus entry（单锁批量）。
- Bus shadow 失败（如临时状态损坏）只在上报 `resultBus` 结果，不抑制、不回滚已成立的 R4 result/outbox；
- 精确重放只比对不可变 canonical identity（busEntryId/resultId/digest/result bytes），
  不重置 `deliveryStatus`/`sendTarget` 等未来投递状态；crash gap 由下一次对账修复，无需重新执行；
- legacy RoutingResult 永不晋升为 Bus entry。

持久化身份自校验（读取即 fail closed，`RESULT_BUS_STATE_CORRUPT`）：

```text
busEntryId   = sha256(JSON.stringify([workspaceId, commandId, iteration]))
resultSha256 = canonicalRoutingResultDigest(result)   // 与 R4 outbox 共享同一实现
```

投递 lifecycle 冻结（R5d2 已实现 lifecycle core；无 HTTP/MCP 端点，未接 Companion）：

```text
queued/reserved                          sendTarget === null
claimed/observed/outcome_unknown/retired_unknown
                                         sendTarget 必须保留 WebSinkSendTargetSnapshot
```

即 queued/reserved 均未冻结目的地；begin-send（reserved → claimed）是冻结边界，冻结后 target 不可消失或改指。

R5d2 lifecycle core 状态机（全部经由 result-bus store-owned 事务原语写盘；单锁、revision +1 恰好一次、noWrite 字节等价、fsync + atomic rename）：

```text
queued -> reserved                    reserve-next：按 createdAt 升序 + busEntryId 决胜，
                                      盖章当前 Active Web Sink binding stamp（bindingId/epoch/boundAt），
                                      不冻结 sendTarget、不铸造 attempt
reserved -> claimed                   begin-send = target freeze：以当时 Active Web Sink 冻结精确
                                      WebSinkSendTargetSnapshot + 铸造 attemptId
claimed -> observed                   ACK（精确 attemptId）；observed + 精确 attemptId 重放 noWrite
claimed -> outcome_unknown            保留 reservation/attempt/冻结 target + outcomeUnknownAt/reasonCode
outcome_unknown -> observed           late-positive ACK（清除 outcome 时间戳）
outcome_unknown -> retired_unknown    手动 retire（终态）
```

单飞（single-flight）：reserved / claimed / outcome_unknown 任一存在时不得预约新 entry；
observed / retired_unknown 是终态，不再阻塞后续 entry。

Web Sink 切换语义：

- reserved 期间切换 → begin-send 检测 binding stamp 不匹配：不冻结旧 target、不铸造 attempt，
  entry 安全回 queued 并返回 bounded stale_reservation；后续 reserve 指向新 binding；
- claimed 之后切换 → 已冻结 target 不变；ack / outcome_unknown / retire / shadow reconcile 均不改写 target。

bounded 恢复（显式常量 + 可注入 nowMs；不导入既有反馈恢复代码）：

- stale reserved → queued（begin-send 意图未持久化，安全侧）；
- stale claimed → outcome_unknown（保留 attemptId 与冻结 target，绝不回 queued）。

`outcome_unknown` **永不**自动回 queued、**永不**采纳当前 Active Web Sink（A→B 切换后仍 pin A）。

R5d3 已进行 Companion endpoint cutover（见 2.5.1）；旧 outbox 物理删除留待 live E2E 证明后的清理阶段。

### 2.5.1 R5d3 production canonical cutover

Canonical routed result 投递路径自 R5d3 起为：

```text
Canonical RoutingResult → Workspace Result Bus → 当前 Active Web Sink → Browser Companion → 当前绑定 URL
```

投递目标只来自 `readActiveWebSinkBinding(workspaceId)`；plannerRouteId /
plannerPrincipalFingerprint 不再参与目标选择。历史 canonical legacy 事件仅按
commandId/iteration/resultSha256 精确分类，不读取其 planner 身份值。

历史重复防回放（migration disposition ledger，`<state>/result-bus-cutover/<workspaceId>.json`）：

- 分类器识别**两类**历史 counterpart：R4c canonical-pinned 事件与 **pre-R4c exact legacy**
  事件（无 planner/canonical 元数据，但 eventId 由 workspaceId/commandId/taskId/iteration/
  desktopReceiptSha256 派生且 immutable facts 精确匹配，含 R4c 同语义 truncate/normalize）；
  两者共存（歧义）→ fail closed；
- 历史 observed → `legacy_observed`；retired_unknown → `legacy_retired`：对应 Bus entry 永久抑制；
- 历史 ready/queued → `legacy_unbegun_bus_owned`：旧事件永久不可经 legacy 路径预约
  （reserve/claim 排除集），Bus entry 不抑制、由 Bus exactly once 投递；
- 历史 reserved/claimed/outcome_unknown → cutover 不 ready：既有 legacy in-flight 优先经旧
  lifecycle 精确收敛，其 Bus counterpart 不独立发送；收敛到 observed/retired 后写入
  disposition 并永久抑制；
- resultSha256 漂移 / 重复事件 / 歧义 → fail closed；绝不从时间戳推断已投递；
- ledger 自校验：每行必须恰一 Bus entry 匹配、resultSha256 一致、legacyEventId/disposition
  与历史 source 一致；orphan/future 行 fail closed；抑制集取自校验后的 reconciliation 结果。

认证与全局仲裁（R5d3 review-fix）：

- Bus canonical 路径认证**只需** R5c Web Sink Companion 边界
  （`verifyCompanionCredentialForWebSink`），不要求 active Feedback receiver
  binding/principal；Feedback receiver 为 null/principal 漂移不阻断 Bus 投递；
  legacy/control 路径 lazy 使用 `verifyCompanionCredential`；
- 全局单飞在**写 durable state 之前**由 per-workspace delivery arbiter
  （`src/bridge/delivery-arbiter.ts`）串行化：Browser Bus reserve、Browser legacy reserve、
  MCP `feedback_claim_next` 全部参与；第二获取被拒且状态零改动；
- cutover ownership 先于**所有** legacy 获取路径建立：即使无 Active Sink / Web Sink 暂不可用，
  arbiter 内也先 reconcile cutover 并以 validated `ownedLegacyEventIds` 排除集传入
  legacy reserve/claim；canonical counterpart 绝不因 Sink 缺失而重获 legacy 可预约性；
- legacy canonical ACK/retire 终态化与 disposition 写入、新 Bus reservation 同锁串行，
  关闭 terminalization TOCTOU 窗口；
- route/frozen 边界：reserve 请求 route === 当前 Active Sink；reserved begin-send 请求 route ===
  reservation 目标（stamp 匹配时即当前 Sink；已切换则交由 core stale-requeue）；claimed begin-send
  重放、ack/retire
  请求 route 必须等于**冻结** `sendTarget.canonicalUrl`；retire 另要求精确 reservationId；
  Sink 切到 C 绝不 reinterpret 冻结于 B 的 attempt；
- in-flight 保密性：foreign（reservedBy 非本 companion）legacy in-flight 与冻结到其他 route
  的 Bus attempt 只暴露 bounded blocking 元数据（`blockedByLegacyInFlight` /
  `pinnedToOtherRoute`），不泄露 eventId/attemptId/reservationId/message/messageSha256。

R5d3 final review-fix（两处契约收紧）：

- canonical counterpart 分类只考虑 **canonical-like 候选**（R4c pinned canonical 事件与
  pre-R4c exact `C2C_EXECUTED` desktop 事件）；同 command 的 `FINAL_RECEIPT_REQUIRED`
  control 事件与其他非 canonical/control 事件可与同一 canonical execution 合法共存，
  不参与 ambiguity/drift 判定，由 legacy/control 路径按自身生命周期继续投递；
  `validateLedgerRows` 同口径——control 事件不使有效 canonical ledger 行歧义或无效；
  多个 canonical-like counterpart、pinned `resultSha256` 漂移、pre-R4c immutable 元数据
  漂移仍一律 fail closed（exact pre-R4c 匹配不弱化）；
- `/reserve` **auth-first**：无效/缺失 credential 一律 401，绝不触发 Feedback projector、
  Result Bus shadow、cutover ledger 或 Bus lifecycle 的任何 reconcile/写入。认证边界
  先于一切生产 reconcile 建立（Web Sink Companion auth 可用即用之；否则要求有效 legacy
  Feedback Companion auth 作 fallback-only 操作）；已认证后由 adapter 拥有完整 reconcile
  序列（projector reconcile → arbiter 内 cutover ownership → reserve/fallback），
  路由层不再 pre-auth reconcile；Web Sink credential 不要求 Active Sink 存在即可通过认证；
- **auth-purity（零 stale recovery before auth）**：credential 真实性先对 raw 只读状态
  校验（`verifyCompanionCredentialReadOnly`：workspace 精确、companion 存在、未 superseded、
  hash 精确，零写入/零 recovery），通过后才允许 `recoverStaleFeedback`（此时 recovery 是
  authenticated lifecycle 维护）。`resolveDeliverySource` 严格只读（`readFeedbackState`），
  不做 stale transition。release/begin-send/ack/retire 序列为：只读 credential pre-auth →
  只读 source resolution → source-specific 授权/route 检查 → authenticated lifecycle
  recovery/mutation。无效/缺失/malformed/superseded credential 对 Feedback state、stale
  lifecycle、Result Bus、cutover ledger、projection cursor 零持久化 mutation；有效
  credential 仍在认证边界内执行既有 bounded stale recovery。superseded credential 的
  endpoint 错误码统一为 pre-auth 的 `COMPANION_UNAUTHORIZED`（401 语义不变）。

投递接线（`src/bridge/result-bus-delivery.ts`，唯一 adapter 入口）：

- Bus 投递授权走 R5c Web Sink Companion 边界（`verifyCompanionCredentialForWebSink`）；
  reserve 时请求 route 必须与当前 Active Web Sink canonicalUrl 精确一致；
- Browser HTTP wire 兼容：eventId 为确定性 32-hex 兼容投递 ID
  `sha256("result-bus-companion:" + busEntryId).slice(0, 32)`，
  不写入 Bus 持久化身份；eventId 解析到 Bus/legacy 必须恰好一个来源，冲突 fail closed；
- `/state` 是跨 Bus / legacy 非 canonical / pre-cutover legacy canonical 的单一 coherent
  单飞视图；任两源同时存在 durable in-flight 即 migration conflict fail closed；
  源优先级：1. 既有精确 in-flight → 2. queued canonical Result Bus → 3. legacy 非 canonical/control；
  `events` 包含已 observed 且冻结 URL 与 credential verified route 精确一致的 Bus 最小证明
  （eventId/status/attemptId），供 ACK 响应丢失后的 journal 收敛；不暴露其他 route 或正文；
- `/reserve` `/release` `/begin-send` `/ack` `/retire-unknown` 按 eventId 解析来源后
  分别走 R5d2 Bus lifecycle 或旧 legacy lifecycle；旧 legacy unsafe in-flight 永不 retarget；
- canonical message 由 server 中性 formatter 生成（与 legacy 事件字节语义一致），
  EVENT_ID 使用兼容投递 ID；browser 不得自行拼装。

Feedback projector 不再把 fresh routed canonical results 投影为 production canonical
投递事件（`FINAL_RECEIPT_REQUIRED` 控制事件与 legacy 非 routed 投递不变）；
R4 outbox 的兼容投影保留在显式 compat 模块，仅用于审计/回滚/测试。

### 2.6 Web Sink Binding

```text
WebSinkBindingCandidate {           // plugin 发现
  pluginId / surfaceId
  workspaceId
  canonicalUrl                      // bounded HTTPS
}

WebSinkBinding = createWebSinkBinding(candidate, stamp)  // Bridge 所有 bindingId/epoch/boundAt
```

约束：

- 无 plannerRouteId、无 conversation principal、无 executor identity
- 不假设 chatgpt.com
- `WebSinkSendTargetSnapshot` 在 begin-send 后冻结 **workspaceId + URL/epoch**
- `assertSendTargetImmutable()` 比较 `bindingId / pluginId / surfaceId / workspaceId / canonicalUrl / epoch`

### 2.7 Delivery Acceptance

```text
ExecutorDeliveryAcceptance =
  | { status: "accepted"; deliveryId: opaque bounded ID }
  | { status: "rejected"; reasonCode: bounded code; reason?: bounded text }
```

- 保留 opaque delivery/execution 关联，不暴露产品字段名
- Codex adapter：校验返回 session identity 与 frozen target 一致，否则 fail closed（不返回 accepted）
- `connection.close()` 在 accepted/rejected 路径都执行

### 2.8 Plugin Registry

- fixed explicit registration
- pluginId 运行时按 Endpoint safe ID 校验
- duplicate / unknown plugin fail closed
- descriptor.pluginId 必须与注册 ID 一致
- 无 PATH/网络/动态 import/文件系统插件发现

---

## 3. 模块布局（R5a）

```text
src/endpoints/
  schema.ts              // generic identity + binding + snapshot schema
  executor-contract.ts   // ExecutorPlugin contract
  web-sink-contract.ts   // WebSinkPlugin contract
  registry.ts            // implementation-neutral registry
  index.ts               // 公共出口
```

依赖规则：

```text
src/endpoints/*  ──X──>  desktop | feedback | browser-companion | mcp | cli | remote
src/executor/*   ────>   src/endpoints/*   （允许）
src/endpoints/*  ──X──>  src/executor/*    （禁止反向）
```

Codex-specific 字段（thread/host/project/turn、Desktop IPC、ownership proof）**只**留在：

- `src/executor/index.ts`（projection + CodexDesktopExecutorPlugin）
- `src/desktop/**`（persisted Desktop domain）

---

## 4. Codex Desktop 作为第一个 production Executor Plugin

```text
current Desktop binding/target
        │
        ▼  projectCodexDesktopTargetToExecutorBindingCandidate()
ExecutorBindingCandidate {
  pluginId    = "codex-desktop"
  sessionId   = threadId
  instanceId  = local host identity
  locator     = { executorProjectId: ... }
}
        │
        ▼  createExecutorBinding(candidate, {bindingId, epoch, boundAt})  // Bridge
ExecutorBinding
```

- plugin **不**生成 bindingId/epoch/boundAt
- 不修改 desktop persisted state
- 既有 `ExecutorAdapter` / `codexDesktopAdapter` / `executorRegistry` API **保留**
- production 默认仍只有 Codex Desktop adapter
- **Claude Code 不进入 production registry**（`src/executor/claude` 仅 candidate/contract）

Capabilities（generic）：

| capability | Codex Desktop | 说明 |
|------------|---------------|------|
| bindExistingSession | true | |
| createSession | false | |
| delivery | true | |
| activeExecutionInspection | true | |
| approvalVisibility | true | |
| trustedTerminalReceipt | true | **capability，不是默认能力** |
| cancellationInterrupt | false | |
| resume | false | |

`trustedTerminalReceipt === false` 的插件不得产出 trusted evidence。

---

## 5. Web Sink / Browser Companion 边界

R5c 已在 Browser Companion 增加 **显式 Connect 绑定路径**与只读 status 同步：

- `POST /api/companion/v1/web-sink/bind-current`（credential 认证，显式 Connect）
- `GET /api/companion/v1/web-sink/status`（只读，Bridge 权威）
- allowlist：`browser-companion/bridge-origin.js`
- 导航切换 **不**自动改 sink；周期 `GET /state` 仍只读

分层：

| 层 | 职责 |
|----|------|
| Browser Companion Core | exact URL binding、binding epoch、durable journal、reserve、begin-send、observation、ack、single-flight |
| Surface Plugin | DOM 差异（ChatGPTSurfacePlugin / ClaudeSurfacePlugin / …） |

Generic contract 中 **禁止**：DOM selector、principalFingerprint、feedback credential、planner route。

---

## 6. R4 保持原样（截至 R5c）

以下 **不修改**：

- `src/routing/schema.ts`：`routingPlatformSchema`、`RoutingRole`、`Command.plannerRouteId`、`Command.executorRouteId`
- trusted receipt → canonical ExecutionResult → plannerRoute Result Outbox → feedback path
- feedback persisted schema
- ExecutionResult wire/persistence
- Browser Companion live 行为
- 既有 MCP tool schema 保持兼容；R5 新增的 executor/web-sink tools 另按各自 scope 与 binding 合同约束
- routing/feedback persisted schema version

R5a–R5c 建立并接线新 core contracts；R4 Result Outbox 目的地未改。

---

## 7. Migration 顺序

| 阶段 | 内容 |
|------|------|
| **R5a** | endpoint contracts（已完成） |
| **R5b** | Bridge-owned Active Executor Binding + generic MCP executor tools（已完成） |
| **R5c** | Browser Web Sink URL binding（已完成） |
| **R5d** | workspace result bus，解除 plannerRoute-pinned result delivery（已完成） |
| **R5e** | dynamic executor / web sink switching（independent review、full regression、live rollout/binding 已验证） |
| **R5f** | rollout 与 conversation liveness 解耦 + 保守 legacy retirement（review PASS，command12 部署验证）；synthetic parent-tree tests 不证明真实 Codex updater 下的进程独立性，不明 legacy pin 继续保守保留 |
| **R5g** | production Executor → canonical Result Bus → production Web Sink；command13/14 正向 live PASS，switching/negative live 未执行 |
| **R5h** | ephemeral command lifecycle；command13/14 exact observed 后物理 auto-destroy live PASS，legacy history 未迁移 |
| **R5i — NEXT** | Bridge process lifecycle independence / host-update resilience；command16 observability 已获 code review PASS，command17 修复 clean-build identity P2，待独立 review 后部署及真实更新取证；优先于 optional live exercises/legacy migration |

---

## 8. R5b 实际状态（已完成）

- **Active Executor Binding** 是 Bridge-owned durable state（`src/executor-control/`）
- 绑定必须经**本地显式** `c2c executor bind-current --plugin codex-desktop`
- **MCP 不能 bind executor**（无 `executor_bind` 工具）
- generic MCP `executor_send` 只选择当前 active binding，并 freeze delivery snapshot
- **Codex production backend** 委托现有 `deliverCurrentCommand()` durable R4 transport
- `executor_send` **不**调用 `ExecutorPlugin.deliver()`（contract seam 与 production transport 分离）
- generic binding 与 legacy Desktop bindingId **是两个概念**，只做 session/instance/project/workspace exact attestation
- R5b **仍**把 result 钉在 plannerRoute（R5d 才解除）
- ChatGPT request source 在最终架构中不选择 result sink
- production registry **只有** `codex-desktop`；其他候选工具不进入 production registry
- OAuth：新增 `codex.executor.read` / `codex.executor.control`；保留旧 desktop scopes

Persisted state：

```text
<state>/executor-control/<workspaceId>.json
{
  version: 1
  workspaceId
  workspaceRoot
  revision            // monotonic
  activeBinding: ExecutorBinding | null
}
```

Store 只保存 generic binding，不保存 threadId/turnId/hostId/projectId/plannerRouteId。

---

## 9. R5c 实际状态（已完成）

**Production path（已接线）：**

```text
Browser current URL
  → verified Companion route
  → POST /api/companion/v1/web-sink/bind-current  (credential auth)
  → Bridge-owned Active Web Sink Binding
```

- Web Sink identity 是 **URL-based**，不是 planner-principal-based
- production surface registry 仅 `browser-companion` / `chatgpt-web`
- Companion 认证边界：active companion + credential hash + verified exact route + workspace
- **不**要求 planner principal / Feedback receiver 相等（R4 feedback 仍用更严格 `verifyCompanionCredential`）
- ChatGPT URL parser 只在 `chatgpt-surface.ts`
- **legacy Feedback Companion transport 保持完整**
- R4 Result Outbox **仍**钉在 plannerRoute，直到 R5d
- URL 切换不影响 Executor binding；Executor 切换不影响 Web Sink binding
- MCP 只读：`web_sink_list` / `web_sink_status`（`codex.websink.read`）
- **无** MCP `web_sink_bind` / `web_sink_switch`
- Browser「连接当前对话」在 route VERIFIED 后显式 bind；导航切换不自动改 sink
- 页面刷新后再次显式 Connect 可更新同目标 DONE flow 的 owner witness，再持久绑定；
  status/heartbeat 不更新 witness、不补建 sink。仅 legacy 配对或 VERIFIED 不代表 Web Sink 可用；
  popup 成功提示也须通过刷新后的 `r5cConnected`、当前 owner 与 route 校验。
- `webSinkStatus` availability 依据 companion/verified route 事实
- Browser 通过 `GET /web-sink/status` 恢复 Bridge 权威投影；status 失败 fail closed
- `r5cConnected` = route VERIFIED + connect-flow identity/transport exact match + active Web Sink projection synced/available
  且与当前 route 相等 + durable DONE 匹配当前 transport

Persisted state：

```text
<state>/web-sink-control/<workspaceId>.json
{
  version: 1
  workspaceId
  revision
  activeBinding: WebSinkBinding | null   // generic URL identity only
}
```

---

## 10. 当前生产能力边界

- ChatGPT Web 仍是**唯一 production Web Surface**。架构允许未来 surface plugin，本阶段不实现其他 AI 网页。
- Codex Desktop 仍是**唯一 production Executor plugin**。
- Claude Code **不在** production registry。
- R5d3 后，fresh canonical result 的 production delivery 权威是 Workspace Result Bus → Active Web Sink。
- R4 plannerRoute-pinned outbox 继续保存为 compatibility shadow；历史 unsafe in-flight 与 cutover disposition 保持保护，不能抢回 fresh canonical authority。

---

## 11. 测试与门禁

- `tests/r5-endpoint-core.test.ts` / `tests/r5-endpoint-architecture.test.ts`
- `tests/r5-executor-*.test.ts` / `tests/r5b-architecture.test.ts`
- `tests/r5-web-sink-*.test.ts` / `tests/r5c-architecture.test.ts`
- `tests/r5e-executor-dispatch.test.ts` / `tests/r5e-web-sink-switch.test.ts` / `tests/r5e-independence.test.ts` / `tests/r5e-architecture.test.ts`
- 既有 `tests/routing*.ts`、`tests/execution-result-*.ts`、`tests/architecture-separation.test.ts`、`tests/r45f-architecture.test.ts` 必须继续通过

---

## 12. R5e 实际状态（dynamic endpoint switching，已完成验证）

阶段证据基线：R5d1、R5d2、R5d3 complete。R5e 已实现 dynamic Executor / Web Sink
switching，并已完成 independent review、137 files / 2699 tests 正式串行全量回归、build/install、
live rollout 与 Active Executor Binding 验证。本节记录当前已验证语义，不把旧的未部署快照当作现状。

### 12.1 Endpoint switch serialization（跨进程锁）

`src/endpoint-switch/lock.ts` 提供两个独立域的 fail-closed 进程间锁：

- `executor` 域：序列化 Active Executor Binding 切换（`bindCurrentExecutor`）与
  dispatch target pin（`beginExecutorDispatch`）；
- `web-sink` 域：序列化 Active Web Sink Binding 切换（`bindCurrentWebSink`）与
  Result Bus `reserve-next` / `begin-send`。

锁文件 `<state>/endpoint-switch/<workspaceId>.<domain>.lock`：`wx` 原子创建 + fsync；
已存在 → `ENDPOINT_SWITCH_LOCK_BUSY`（fail closed，绝不等待或抢占）。锁内容只有
pid/domain/nonce/createdAt（nonce 是每次 acquire 随机生成的 ownership token），
无 credential/消息/planner 身份。release 先读回当前锁路径，仅当其仍携带本 handle
的 nonce 才删除；missing / unreadable / nonce-mismatch / unlink-failed（nonce
匹配但最终删除失败）一律以 bounded ownership-lost 结果上报，绝不删除替代锁、
绝不抛错。`withEndpointSwitchLock` 传播该结果：fn 成功但归属丢失 → 抛
`ENDPOINT_SWITCH_LOCK_OWNERSHIP_LOST`（成功的 authority mutation 不静默伪装为
成功）；fn 抛错 → 原始错误仍是主错误，归属证据有界附加（不替换主错误）。
锁顺序统一为 endpoint-switch lock → 各 store 自身 lock，禁止反序。

### 12.2 Executor 切换语义（durable dispatch target pin + process owner）

新增 Executor Dispatch Ledger（`<state>/executor-dispatch/<workspaceId>.json`）：

```text
entry {
  version: 1
  commandId / intent
  payloadBytes / payloadSha256 / requestAuthoritySha256   // identity 摘要，无明文
  target: ExecutorDeliveryTargetSnapshot                  // 冻结 target
  deliveryStatus: started | accepted | rejected | outcome_unknown
  ownerId?                                                // 进程级 dispatch owner token
  createdAt / updatedAt / startedAt
  deliveryId? / errorCode? / terminalAt? / outcomeReasonCode?
}
```

**new command**（ledger 无 entry）→ 路径严格为：

```text
executor switch lock
  -> 读 current Active Executor（caller bindingId 不等于当前 Active binding
     → EXECUTOR_BINDING_STALE fail closed）
  -> durable started target pin + ownerId
  -> release switch lock
  -> backend send 在锁外进行
```

**existing command**（同 commandId 已有 entry）→ 严格无锁读 ledger 后只走
dispatch-store 事务：**不读 current Active Executor、不取 endpoint-switch
lock**。identity（intent/payloadBytes/payloadSha256/requestAuthoritySha256）
任一漂移 → `EXECUTOR_DISPATCH_IDENTITY_MISMATCH` fail closed；caller bindingId
不等于 entry 冻结 target 的 bindingId → `EXECUTOR_COMMAND_PINNED`。按 entry
状态收敛：

- **started + 同进程 owner**（entry ownerId 匹配当前进程 dispatch owner）→
  `EXECUTOR_DISPATCH_IN_FLIGHT`：无 mutation、无 backend retry（同一活进程
  的重复请求保护）；
- **started + 异 owner**（不同进程 / 崩溃残留；含 legacy 无 ownerId 的 started
  entry）→ durable `outcome_unknown`（`interrupted_after_target_pin`）：
  无 backend retry、不 retarget（safety > availability，绝不二次 send）；
- **terminal replay**（accepted/rejected/outcome_unknown）→ 幂等 noWrite，返回
  durable result：无 backend call，且**无 current binding 要求**（不比较当前
  Active binding：A pinned 后切换 B，X 仍投 A，绝不跟随 B）。

stale executor switch lock 只能阻塞 **new work / switch**（target pin、binding
切换、web-sink 序列化），不能阻塞已 pinned 工作的 recovery/replay——existing
command 的免锁路径保证 crash 后无需持锁即可收敛。

- backend result 必须与冻结 target 精确一致（commandId/pluginId/bindingId/sessionId），
  漂移 → `EXECUTOR_DISPATCH_RESULT_MISMATCH` + durable `outcome_unknown`；backend 抛错
  → durable `outcome_unknown`（不掩盖原始错误）；
- `ProductionSendRequest` 删除 `activeBinding` 字段：backend 只认冻结 target snapshot；
  legacy Desktop exact attestation（`assertGenericMatchesLegacyDesktop`）保留——
  Executor 切到 B 后，target A 的 send 仍 fail safely（MUST NOT send to B）；
- 不新增 MCP `executor_bind` / `executor_switch` 工具；binding 仍只能本地显式
  bind-current；MCP `executor_send` 的 pin/replay 全部收敛到 dispatch service；
  **ownerId 不是公开身份**：它只是进程内 crash-recovery 区分 token，不进公开
  DTO、不暴露给 planner/远端。

### 12.3 Web Sink 切换语义（serialization only，R5d2 生命周期不变）

`bindCurrentWebSink` 与 Result Bus `reserve-next` / `begin-send` 全程持有 `web-sink`
域 switch lock；生命周期语义与 R5d2 完全一致：

- queued → reserve 时 sink：reservation 盖章当时 Active Web Sink stamp（不冻结 target）；
- reserved 期间切换 → begin-send `stale_reservation` 安全回 queued（无 attemptId、
  不冻结 target）；后续 reserve 指向新 sink；
- claimed 之后切换 → 冻结 `sendTarget` 永久不变；outcome_unknown / observed /
  retired_unknown 亦然；永不自动 retarget、永不自动 retry `outcome_unknown`。

recoverStale / ack / mark-outcome_unknown / retire **不加** switch lock
（单 store 事务已足够；避免不必要的锁扩散）。

### 12.4 双域独立性

Executor 切换不改 Web Sink control 状态，也不改 dispatch ledger 已冻结 entry；
Web Sink 切换不改 executor binding 与 dispatch ledger。unstarted 的 queued result
跟随当前 sink；delivery-started 的 result / command 永久冻结其 target。

### 12.5 测试

- `tests/endpoint-switch-lock.test.ts`：nonce ownership（替代锁不误删）/ 归属丢失
  bounded 上报 / `withEndpointSwitchLock` 传播（success→OWNERSHIP_LOST、throwing→
  原错误为主+证据、normal 不变），两域（executor/web-sink）覆盖
- `tests/r5e-executor-dispatch.test.ts`：pin / replay / owner 分支（IN_FLIGHT /
  异 owner outcome_unknown）/ switch / crash recovery / identity 漂移 / result
  mismatch / stale lock 下免锁 replay / 确定性 lock interleave（无 sleep）
- `tests/r5e-web-sink-switch.test.ts`：stale requeue 周期 / 冻结 target 不变 /
  web-sink lock interleave
- `tests/r5e-independence.test.ts`：双域切换互不越界
- `tests/r5e-architecture.test.ts`：模块边界与 token fence

---

## 13. R5f 实际状态（rollout 与 conversation liveness 解耦，已实现）

生产 rollout 已解除 conversation liveness 依赖：Desktop `busy`、`approval_pending`、
active/inProgress 与当前 self-turn 不再阻断 Bridge restart/upgrade，也不再调用
`schedulePostTurnFinalizer()` 或创建新的 finalizer worker。`assessRolloutIdle()` 仍执行
安全检查，但以 lifecycle-independent 模式忽略上述活动状态。

该独立性只指 conversation liveness；command12 已验证当前 active turn 中直接 rollout、零 core post-turn-finalizer。既有 synthetic parent-tree death 回归没有覆盖真实 Codex updater/process-host。command15 的更新后断开复现要求新增 R5i（见 §16），不得把本节的完成状态解释为“Codex update 不能终止 Bridge”。

下列门禁保持 fail closed：install/runtime identity、maintenance lock、rollout fence、workspace
与 runtime fence、named tunnel/public URL 健康、pending/corrupt state、Desktop unknown 或
unresolved outcome、pairing，以及 Remote active/unknown。R5f 不改变 R5d/R5e Result Bus、
Executor dispatch 或 Web Sink switching 语义。

core finalizer 已移除 schedule/spawn/run/claim/commit 等 worker mutation surface；CLI `status`
与已退休的 `run` 保持只读兼容。Desktop receipt-finalizer 是独立机制，本轮不改变其行为。

历史 finalizer 只在 `gc --apply` 的 maintenance → rollout fence → start-lock → fresh-plan
临界区退休。条件为 active 已过期、claim 严格匹配 job/token、PID 探测明确返回 `ESRCH`；
live、EPERM/unknown、缺少 claim、未过期均继续 pin。旧 release 的 worker 在最后 ownership
check 后不再检查 active，因此不能用 tombstone 替代死亡证明，也不能退休 live claim。

retirement ledger（`post-turn-finalizer-retirements/<workspaceId>.json`）保存 exact active/claim
快照、文件身份及内容摘要。先 `fsync` ledger，再重复校验 active/claim 后移除 active。
claim 永久保留，阻止缓存旧 job 的 worker 再以 `wx` 获取 ownership；result/audit 不覆盖。
ledger 已写但 active 仍在时继续 pin，匹配的重试可完成退休；无 active 的退休证据必须仍匹配
claim。损坏、symlink、替换、身份不一致或孤立 claim 全局阻断 GC，不能把未知 authority
当作无引用 release。只读 `plan`/`dry-run` 不写状态。退休后重新构建引用图，新增候选只能来自
本轮证明已退休的 target；每个 release tombstone 前再查引用与 artifact，保留 TOCTOU 门禁。

R5f 已通过 Planner independent review，未发现 P1/P2；本轮不执行机器状态 cleanup、install、
rollout 或 deploy。部署，以及缺少死亡证明的 legacy pin 仍需后续处置，不能
声称所有历史状态已清空。

本轮验证（2026-10-01）：finalizer/GC/rollout、Desktop receipt-finalizer 与 R5e 定向回归为
11 files / 304 tests；正式串行全量为 137 files / 2721 tests、exit 0（694.85s）。typecheck、
build、diff check 通过；独立代码审计未发现 P1/P2。全量的 `route.js.map` 缺失诊断不阻断测试。

## 14. R5g acceptance matrix（部署前 preflight）

R5g 的 cross-plugin 指当前 production `codex-desktop` Executor endpoint 与
`browser-companion / chatgpt-web` Web Sink endpoint，经 Bridge-owned canonical Result Bus
完整协作。两者的 bindingId、epoch 与切换锁分别属于各自域；epoch 数值偶然相同不表示共享
authority。Claude E1a / MiMo 不进入本轮 production registry，也不是本阶段的 live 阻塞条件。

本地因果链使用真实 MCP `executor_send` handler、Codex production backend、durable dispatch、
Desktop/routing ledger、`recordDesktopResult`、canonical projection 与 Result Bus；Companion
走隔离 HTTP pair、durable route confirmation、bind-current、reserve、begin-send、ACK，Browser
使用真实 `runProductionSend` / `recoverProductionSend`。仅 Desktop IPC 证据与 Browser DOM
操作使用确定性测试 seam。该证据是 local preflight，不证明真实 Desktop/网页已发送。

```text
Local confirmed Active Executor Binding
  → executor_send → durable frozen dispatch target → Codex backend accepted delivery
  → exact trusted terminal receipt → canonical ExecutionResult → workspace Result Bus
  → verified Active Web Sink → reserve → begin-send freezes exact sendTarget
  → Companion source resolution → Browser production runtime → exact ACK → observed
```

| 验收项 | Local preflight 的必要证据 | Live proof 的必要证据 |
| --- | --- | --- |
| 完整因果链 | accepted delivery、trusted receipt digest、唯一 canonical result/Bus item、真实 HTTP 与 Browser runtime observed 串联 | 同一次真实 commandId、delivery/turn、receipt、result/bus digest、attemptId 与目标网页用户消息逐段对账 |
| Executor/Sink independence | 独立 binding identity；切 Executor 不改 Sink；旧 dispatch/Command executor target 不漂移 | 两域显式绑定与状态核对；先只读记录 exact workspace/endpoint，切换场景另行授权 |
| begin-send 前切 Sink | queued 可随新 Sink；stale reservation 安全回 queued，不产生 attempt | 明确授权 A→B 切换与重预约，核对结果只进入 B |
| begin-send 后切 Sink | claimed/outcome_unknown 保留原 sendTarget；新 route 不得重放 begin-send、ACK 或读取旧 payload | 冻结 attempt 仍属于 A；B 零投递，未知结果不自动重试 |
| 幂等与 canonical authority | duplicate command 不再 backend send；receipt/result 重放不新增 semantic result；duplicate ACK bytes/revision 不变；R4 shadow 不抢回 authority | 确认仅一次真实执行、一次 semantic result 与一次网页发送；重放核验另行授权 |
| fail closed | target/dispatch identity 漂移、source migration conflict、未 VERIFIED/unavailable Sink 拒绝，不伪装 observed | 通过可安全、明确授权的负向步骤核验拒绝，不破坏历史 authority；无法安全演练时保留 local evidence 限界 |
| unknown recovery | Browser recovery 仅观察/ACK，零 composer write、零点击、零 retarget | 真实未知结果先人工核对；只有 exact positive observation 才 ACK，禁止自动重发 |

截至 2026-10-02，command13 正向 production live 回流与 command14 installed post-cleanup verification 已 PASS，证据见下方 R5h live closeout。该结论仅覆盖同一现役 Executor/Sink 的正向链路；endpoint switching、negative live、live replay 演练仍未执行，本地矩阵证据不冒充这些 live proof。

R5g gap audit 确认旧 `/begin-send` 的 claimed 重放未验证 frozen route：A claimed 后换到
verified B，可以用旧 reservation 取得 A 的消息。新增共享 adapter fence 后，跨 route 重放在
lifecycle mutation 与 payload 返回前报 `RESULT_BUS_FROZEN_TARGET_MISMATCH`，原 attempt/target
及持久化 bytes 保持不变；同 route 的精确 claimed 重放仍沿用既有 noWrite 语义。

相邻 `/reserve` 的 in-flight 返回也补 frozen-route fence：claimed/outcome_unknown 已冻结到
其他 route 时，拒绝返回 reservationId、command/task、文件/测试摘要及 outputId。错误沿用
既有 `RESULT_BUS_FROZEN_TARGET_MISMATCH` 的 HTTP 400 映射；`/state` 仍仅返回 bounded
`pinnedToOtherRoute`。

Planner review 随后发现 reserved 尚无 sendTarget 的隔离缺口，由 revision
`r5g-review-fix-reserved-route-isolation-20261001-04` 修复：`/reserve` 对 reserved 额外要求
reservation 的 bindingId/epoch/boundAt 精确匹配 fresh Active Sink，且 authenticated route
与当前 Sink route 等价；旧 stamp 返回 HTTP 409 + `RESULT_BUS_STALE_RESERVATION`，不返回
旧 eventId/reservationId 或摘要，也不因该拒绝改写预约。`/state` 对 foreign reserved 只返回
`{status:"reserved", pinnedToOtherRoute:true}`；同 Sink 精确 reserve replay 与恢复信息保留。
core begin-send 的 stale reservation 规则不变：旧预约安全回 queued，不铸造 attempt/sendTarget，
随后可重新取得新 Sink stamp 的预约。同 route successor 也须通过 stamp 检查，等价 URL 不
制造新的 authority。该 revision 已通过下列本轮源码审查与隔离回归。

command04 源码验收时的历史状态：**local preflight complete / live pending**。确定性 E2E 位于
`tests/r5g-cross-plugin-e2e.test.ts`；本次 reserved-isolation revision 的 R5g E2E 5 tests、
R5d3 cutover 42 tests 均通过，R5g/R5d/R5e/R5f 联合定向为 16 files / 562 tests。
本次 revision 唯一一次正式串行全量为 138 files / 2730 tests、exit 0（712.71s）；
typecheck、build 与 diff check 通过，独立只读源码审计未发现直接相关 P1/P2。
既有 `route.js.map` 缺失诊断不阻断测试。未实际 install/rollout/live send 前不得标记 R5g completed。

2026-10-01 command `r5g-live-closeout-20261001-06` 的 pre-deploy read-only gate **blocked**，live pending。
`assessRolloutIdle(skipSelfTurnCheck:true, ignoreDesktopActivity:true)` 仍为 `desktop_unknown`：当前
bound thread active 已正确忽略；历史 blocker thread `01a0d6cd-09f3-73e3-9726-4bd65df196d3` 尚未
retired，含 14 条 `accepted` 且无收敛证据，target-scoped inspect 返回 `DESKTOP_NO_OWNER`。
Strict history parsing 成功，unresolved outcome=0；
command04 administrative resolution 与 command05 accepted/no receipt 均保持原状。

当时 installed/runtime build 均为
`bfc4988deb9f5187c3ade685927d8d58aed52e26b7ffc42d90235794b5cdd087`；Desktop availability=true、
Web Sink VERIFIED/available、Result Bus reserved/claimed/outcome_unknown=0、maintenance/rollout/start
locks=0、named public health=200。未 build/test/install/GC/rollout/send/rebind；不得声称 R5f deployed
或 R5g completed。

**NEXT_EXPECTED_STEP**：人工审查该历史 thread 的 ownerless `accepted` 证据，并在另行授权下处理；不得
自动 retire、改写记录或补 receipt。read-only 安全门禁通过后再执行 R5g live closeout。

2026-10-01 command07 的只读全量预检在 B 阶段停止。被冻结的 exact 14 项与 command06 相同，14/14 均含
intent；`src/desktop/legacy-retirement.ts` 的现有 eligibility 仅允许 `intent === undefined`，因此返回
`LEGACY_RETIREMENT_NOT_ELIGIBLE`、eligible=0/rejected=14，retirement mutation=0。target-scoped inspect
仍为 `DESKTOP_NO_OWNER`；maintenance active 与 runtime fence 精确匹配，strict snapshot revision=634 未变化。
未发现 execution/output/retire/reconciliation/abandon/admin 冲突。command06 trusted blocked receipt
`outputId=212` 保留；command04 administrative resolution 与 command05 accepted/no receipt 保持原样。
同一 workspace `2582910bf0d2` 的 Result Bus 独立只读分类结果：Bus 54 项（49 queued / 5 observed）；49 个 queued
全部与唯一 canonical-like counterpart 及 `legacy_observed` ledger 条目精确对应，因此生产 reserve suppression=49、
genuine eligible=0，ambiguity/drift/orphan/collision=0。canonical RoutingResult=54、Bus=54、缺失 projection=0；
ledger 50 行的 unique Bus entry/digest/source/eventId/disposition 均一致，orphan/duplicate/compatibility collision=0；
Bus/Feedback in-flight=0。Feedback ready=0；唯一 queued 项归类为
`legacy_unbegun_bus_owned`，不成为候选。R4 compatibility shadow 54/54 pending，仅供 audit/rollback，不是 canonical
Web Sink reserve queue；production reserve 通过 `excludeBusEntryIds` 排除已验证抑制项。未调用 reconcile/recover/ACK/
retire 或 HTTP state，机器 JSON 前后 size/mtime 不变。以上只读预检未产生 trusted receipt 或 authority mutation；
末尾标准 blocked record 按 terminal fence 处理，结果须另行复核，不构成新 helper 的 live proof。

**NEXT_EXPECTED_STEP**：人工选择并明确授权一种已有、适用于带 intent 投递记录的处置协议；不得放宽
legacy retirement eligibility gate，也不得自动 abandon。Result Bus 只读分类已完成；待处置与 read-only 安全门禁
通过后，再执行 R5g live closeout。command07 的 B 阶段只读预检在 eligibility gate 拒绝后停止；末尾标准
blocked record 按 terminal fence 处理，结果须另行复核，不构成新 helper 的 live proof。未 build/test/install/GC/rollout/send/rebind。不得声称
R5f deployed 或 R5g completed。

### 2026-10-02 command08 最新 closeout 状态

command08 已按 canonical 排序对 exact 14 项成功执行已授权的 batch abandonment：
`previewconfirmationSha256=c4d935c4dea950fe29ac6bff51f32774f74d1d1e291e811ba08daf7d78118109`，
`selectionSha256=6171a34ad83858f00279602e01366968c2ba940d89acb59e83477d038021f4d5`，
`batchabandonedAt=2026-10-01T16:07:48.037Z`（本地日期 2026-10-02）。原 14 条 delivery 均仍为
`accepted`，history 为 `abandoned/skipHistory=14`；没有新增对应 execution/output，全部 `accepted`
状态与所有 records 哈希未变。command04 admin、command05 accepted/no receipt、command06
`outputId=212` 与 command07 `outputId=213` 均保留。

command08 fresh D gate 为 PASS，当前 active 按规则忽略；locks=0、pairing=false、core finalizer
active=0。49 个 queued `legacy_observed` 全部 suppressed，genuine backlog=0、ambiguity=0、
observed=6。原 Sink `fa5af5bb-7d4d-4908-b558-43fd112b05be` epoch=1，`VERIFIED/available`；
本轮快照中的 installed/runtime build 均为
`bfc4988deb9f5187c3ade685927d8d58aed52e26b7ffc42d90235794b5cdd087`，PID=17708，named health=200。

E 阶段安装前 Python 门禁有 1 个 ERROR 后，停止 build/install/GC/rollout/live/full regression。Desktop
helper 为 57 tests、`tests/desktop_protocol_test.py` 为 87 tests，均通过；必需的
`tests/daemon_spawn_protocol_test.py` 为 14 tests、13 passed / 1 ERROR、exit 1。错误在
`test_relay_mode_writes_result_and_removes_env_file` 的 `TemporaryDirectory` 清理时发生：unlink
`daemon.log` 收到 `WinError 32`（文件被占用）。测试 body 没有 assertion failure，真实句柄持有者未证实，
不能据此判断 production failure；该门禁未重跑。另有 focused 验证 17 files / 469 tests、exit 0
（94.57s，Desktop/result/receipt/abandonment 与 R5g/R5d3/R5e/R5f/GC/rollout），typecheck exit 0；
这些结果不消除安装前门禁失败。

本状态基于最终标准 C2C record 写入前的快照；最终 record 是否落盘及其终态须以后续实际读取结果为准。
**当前 NEXT_EXPECTED_STEP**：聚焦诊断/修复 daemon protocol cleanup/exit-proof 门禁后，再启动新的
closeout。exact 14 项 abandonment 已完成，无需再次 confirm，不得为其补 receipt；command08 自身按
标准 `c2c record` 与 terminal fence 收尾。R5g 仍为 live pending，R5f 部署未验证；
不得据此标记 R5g PASS 或 deployment verified。

## 15. R5h ephemeral command lifecycle

2026-10-02 command10 改变正常 command 的产品合同；本节优先于旧 completed-history 永久保留模型。command11 已获 Planner `CODE_REVIEW_PASS`，command12 已将 exact reviewed source scoped install/rollout 到 workspace `2582910bf0d2`；R5f conversation-liveness 解耦 deployment verified，command13 正向回流与 command14 installed post-cleanup verification 已证明 R5h fresh live auto-destroy PASS、R5g 正向 production live path PASS。endpoint switching/negative live 未执行，legacy history 未迁移。当前 NEXT_EXPECTED_STEP 见 §17.8 的command30测试fixture修复与待授权最终门禁，之后GC per-release redesign优先于R5j候选验收；command26正式门禁及部署已完成，但R5j-b2/e稳定性验收尚未开始。下方 command10–14 的旧 next-step/deployment pending 仅作历史快照。

正常完整链路仍是 independent production Executor → trusted receipt → canonical ExecutionResult → Result Bus → independent VERIFIED Web Sink → exact observed/ACK。变化在 terminal 之后：新 `ephemeral` flow 立即销毁 command-scoped runtime persistence，只有 incomplete/异常 flow 暂留。没有 completed tombstone、TTL、永久 commandId replay registry，完成后允许新的 commandId 生命周期；日常新任务仍使用新 ID。

### Command-scoped ownership map

下表相对路径均位于所选机器 `stateDir`，删除通过所属 store 的 exact transaction，不直接拼 JSON。共享文件只移除目标 entry，workspace 权威和 peer command 不变。

| Authority / projection | 位置与 exact ownership | Cleanup |
| --- | --- | --- |
| Desktop delivery | `desktop-control/<workspace>.json`，commandId/deliveryId/turn/binding/hash | 删除 exact delivery；binding/runtimeFence/init 保留 |
| Executor dispatch | `executor-dispatch/<workspace>.json`，commandId + dispatchGenerationId + frozen target | 删除 exact entry；late generation commit 拒绝 |
| Execution receipt / output | `executions/<workspace>.jsonl`；`execution-outputs/<workspace>/index.json`、`bodies/<outputId>.txt`，commandId+iteration=1 或 receipt-linked exact output | 物理删除正文、metadata、record；路径/symlink/size/identity 验证；空 JSONL unlink |
| Desktop receipt-finalizer | `desktop-receipt-finalization/{drafts,alerts,claims}/<workspace>-<command>.*` | exact generation draft/alert/claim 删除；旧 worker 下一 tick 重读，不能复活 |
| Routing Command/Result | `routing/<workspace>.json`，commandId / resultId / digest | projections 先删，再删 producer；routes 保留 |
| R4 compatibility / issue queue | `routing/<workspace>.result-outbox.json`、`.result-reconciliation.json`；`feedback/<workspace>.json` 的 executed / final-receipt-required exact event | 删除 exact shadow/control/issue；receiver、companion、route 权威保留 |
| R5 canonical Bus / cutover | `result-bus/<workspace>.json`、`result-bus-cutover/<workspace>.json`，derived command+iteration Bus identity / result digest | cutover exact entry 先删；observed Bus attempt proof 最后删，不触碰其他 migration suppression |
| Legacy evidence | `desktop-{outcome-resolution,abandonment,legacy-reconciliation,legacy-retirement}/<workspace>.json` 的 exact command | 仅该 flow 且在 exact manual confirmation scope 时删除；batch prunes 单项并重算剩余 selection identity |
| Browser local attempt | Companion durable single-flight journal，exact event/attempt/route/signed witness | 正常 ACK 清空；fresh authenticated terminal-gone 只清 exact local attempt，不 Send、不伪造 observed |
| Cleanup recovery | `command-cleanup/<workspace>/<command>.json`；Feedback transient cursor adjustment | 仅 active journal/marker，全部删除成功后物理删除，无 permanent history |

`command-cleanup-keys/<workspace>.json` 是 workspace witness 验证 key，无 commandId/event/attempt history。Core `release-references` 不以这些 command stores 为 release authority；core legacy finalizer 的 release pin/retirement ledger 不属于此清理协议，既有 GC/maintenance fences 保持。

### Terminal ordering and crash invariants

1. ACK 先 durable observed，然后写 snapshot_pending journal/full exact artifact snapshot；任何 cleanup error 返回 observed + cleanup_pending，不回滚或再次 Browser Send。
2. 锁顺序为 per-command lifecycle → 独立 workspace cleanup → individual store。workspace lock 为 `command-cleanup-workspace/<workspaceId>.lock`，不使用 magic commandId 或 per-command journal 路径；合法任务 `__workspace_cleanup__` 与内部协调不别名。两类锁共用 atomic wx + strict PID/nonce owner，ESRCH-only 回收必须 fresh 文件身份/内容精确相同；live/unknown/corrupt/replacement 不抢占，释放时再次核对 inode/dev/content，ownership loss 显式失败。lifecycle command lock 覆盖 backend await/receipt commit/Bus mutation，所有 producer/reconciler/backfill 在同一 fence 下且锁后重读源。Busy 立即拒绝旧 writer，不排队越过 completed cleanup；新请求必须 fresh read。
3. 短 workspace cleanup 串行后删 Feedback/R4/cutover projections，再删 Routing、Desktop/finalizer/evidence、output/receipt、dispatch。Execution JSONL 删除前 prepared cursor prefix proof durable，删除后 delta/applied 一次；peer append 可兼容，replacement fail closed。
4. journal durable producers_deleted 后移除 cursor adjustment，再删 Bus proof，验证所有目标 artifacts 为空，最后 unlink cleanup journal及严格匹配的 journal atomic-write leftovers。任何中途 crash resume 只继续删除，绝不重发/重新投影；corrupt/ambiguous/path escape/live owner fail closed。Shared store 未收敛的 atomic-write residue 不推断、不删除：cleanup 继续 pending，需独立核对；不得忽略残留后伪称 cleaned。
5. ACK 初始 journal rename 失败时 observed 保留；既有 runtime readers重新尝试新 ephemeral observed flow，旧无标记 history 不迁移。Receipt/canonical/Bus source被物理移除后无法 backfill。
6. duplicate ACK 在 Bus 已消失时必须有签名的 exact workspace/event/attempt/VERIFIED canonical route/companion witness；仅返回 `terminal_gone`，不是 observed。Browser OBSERVED_PENDING_ACK 可仅关闭本地状态；manual force cleanup 后 CLAIMED/unknown 等本地 fence 也可由相同 authenticated terminal-gone proof 清空，零 DOM/Send。任意不存在 identity 或 forged witness 不成功。
7. Legacy Feedback compatibility 发送同样受 cleanup fence：claim/reserve/begin-send/ACK/release/retire 与 stale recovery 均先对快照 commandIds 按稳定顺序取得 lifecycle locks，再取 Feedback store lock、重读并拒绝新增 command source。已 reserved 的旧 event 在 fenced journal 下也不得升级 claimed；cleanup 自身仍通过 maintenance authority 使用原始 store lock 完成 exact 删除。

### Manual force cleanup and migration

`pnpm dev -- cleanup command -w <workspace> --command-id <id> --json` 是只读 preview，返回 bounded artifact types/IDs/digests、notice 与 confirmationSha256；`--confirm <exact digest>` 先 fence 再复用同一 coordinator，支持 incomplete accepted、receipt-only、claimed、outcome_unknown。它明确表示本地放弃，外部可能已执行/发送，本机再也无法恢复该事实；不补 receipt，不伪造成功，不自动重发。digest drift/identity conflict 拒绝；没有 `--all`，不存在项不创建 tombstone。正在执行的 writer 持锁时本次 confirm fail closed，等待该调用结束后重新 preview。

旧 abandonment/retirement/admin-resolution/reconciliation 保留 strict read/legacy compatibility，新正常 flow 不生成它们。现有 exact14 abandonment 和49 suppressed历史 Bus不在自动 migration 范围；只允许未来另行 exact manual cleanup。Completed runtime diagnostics/output 可消失是新合同，不承诺永久可查。

本地验证：cleanup 定向 5 files / 44 tests；Python Desktop helper 57/57、protocol 87/87、daemon protocol 14/14；最终正式 serial full 143 files / 2776 tests、exit 0（746.86s）；typecheck/build/diff check PASS。R5d/R5e/R5f/R5g 与 Browser production delivery 回归均包含于最终 full。中途独立审计发现的 producer diagnostic recreation race 已修复并补测；主动停止的早期 full 不作为验收结果。

command11 read-only receipt diagnostic 为 d（缺 command10 record-time 上下文）：accepted origin failed 后存在独立 composer/completed、单 text input、non-C2C turn，source 与 installed 对它的 strict native edge 都拒绝；当前 command11 两版均 applicable/origin、零 continuation edge。history.py source/installed 有 steering/native-chain 兼容差异，不能仅凭 build 不同归因。未修改 command10 delivery/receipt；CLI 只增加 NOT_APPLICABLE 的 bounded 原因可见性，不选择其他 accepted，也不允许后续普通 turn 补原 receipt。部署与 fresh-command live proof 仍 pending。

command11 review-fix 验证：R5h cleanup 7 files / 65 tests，含 legacy Feedback 的定向 10 files / 195 tests，Desktop/receipt/record 与 R5g/R5d3/R5e/R5f 定向 17 files / 416 tests（分组有重叠）；record discovery 新增 4 tests 通过。Python helper 57/57、protocol 87/87、daemon protocol 14/14；typecheck/build/diff check PASS。最终源码冻结后唯一正式 serial full 为 146 files / 2801 tests、exit 0（773.37s）。未 install/rollout/live/commit/push，Planner independent review 与部署验证仍 pending；不据此声称 command10 receipt 成功或 command11 terminal receipt 已完成。

### command12 deployment evidence

- Predeploy source/test 冻结快照 408 文件精确匹配 command11 正式 full；无 staged/conflict，HEAD 未变。本轮只做部署与 bounded docs，没有修改生产源码，未重复 full/typecheck。
- 原 installed `bfc4988deb9f5187c3ade685927d8d58aed52e26b7ffc42d90235794b5cdd087` 已严格保护。初次 full artifact 失败的唯一差异为 command11 诊断导入未加 `-B` 所生成的 9 个 `.pyc`；现役 maintenance lock 内 exact cache 身份/内容重检后恢复，未改 manifest/pointer/history。生产 helper 本来已用 `-B`。
- Fresh build stored/recomputed、installed 与 running 均为 `77fa4757c712042a622967f520df980b2070d0c053719562ad1b8a556e8cba90`；完整 release 与 helper/daemon/Companion artifacts 通过。install GC 保守 `initial_plan_unsafe`：9 skipped、0 deleted/tombstoned/bytes，未发生 legacy finalizer retirement。
- Stable launcher 仅 scoped rollout 当前 workspace，`upgraded=1`、pending/error=0；Bridge PID 17708→18580，startedAt=`2026-10-02T02:40:31.622Z`，runtimeUpgrade=current、upgradePending=false，原 named URL health=200。command12 installed classification 仍 exact origin/inProgress、零 continuation edge，core finalizer active=0；其他 workspace runtime 哈希未变。R5f rollout 与 conversation liveness 解耦已 live deployment verified；尚未验证真实 Codex updater 下的进程独立性。
- Desktop binding/runtimeFence、原 VERIFIED Web Sink `fa5af5bb…` epoch=1 与 Companion/Feedback identity 都不变且 available；unresolvedDelivery=false、Bus/Feedback in-flight=0、49 historical suppressed queued 未动、unsuppressed queued=0、cleanup journal/workspace lock=0。command10 未清理/补 receipt，历史 abandonment/unknown evidence 保留。
- Installed steering/history、record diagnostic、ephemeral schema/cleanup CLI、独立 workspace lock 已核对；不存在 synthetic command preview=not_found，137 个 artifact/directory 快照零变化、零 tombstone。没有真实 Browser/新 Desktop send，这不是 terminal auto-destroy live proof。

**NEXT_EXPECTED_STEP**：Planner 独立核对 command12 后，从新 runtime 投递 fresh command13，执行 R5g/R5h positive live proof。R5g/R5h live 仍 pending；禁止以安装验收冒充 observed→auto-destroy PASS。endpoint switching/negative live exercises 未执行，command12 未 rebind/commit/push；最终标准 record 的 pending/terminal 状态由自身 fence 决定。

### command13/14 positive live and physical absence evidence

此处覆盖 command12 当时的 live pending；快照时间 `2026-10-02T03:13:11.568Z`。installed full release 校验通过，installed/running build 为 `77fa4757c712042a622967f520df980b2070d0c053719562ad1b8a556e8cba90`，Bridge healthy、PID18580、startedAt `2026-10-02T02:40:31.622Z`。Desktop binding `5f03949b…`/thread `01a0f4a1…` available，原 Web Sink `fa5af5bb…` epoch1 与原 VERIFIED route available；route SHA256 `c5966a9e4453be9c686ddd66f2d432d22c6aa2531823b7aa0681d803d4f98b69`。

command13 `r5h-fresh-live-auto-destroy-proof-20261002-13` 在新 helper 下 self-attested exact origin `01a0fa86-325e-76a0-9b30-be5c9bc27475`、chainLength0，标准 record 在 inProgress 时仅 pending。Planner 后续 observed C2C return 证明 trusted receipt/output218 → event `cb87518d985390e11b25bd9e43d4ebb6` → attempt `c64b2e77-5bf0-4eaf-9996-0b46ad73d7c5` 到达当前 ChatGPT route。command14 用 installed `resultBusEntryId` 与 `resultBusCompanionDeliveryId` 精确重算同一 workspace/command/iteration 对应的 Bus ID `72095959bd5044e625d5debb8f45cf055364f58f4ff160772557e41bbdaa2494` 与 event，零猜测、零重新建 history。外部 Connector C2C receipt 刻意处于本机 cleanup 生命周期之外。

Stable CLI 对 exact command13 的两次只读 preview（无 confirm）在 reconciliation 前后均为 `not_found / artifacts=[] / confirmationSha256=null`；installed `inspectCommandCleanupArtifacts` 汇总下列 19 kinds，计数全部为 **0**：

| Artifact kinds | 各 kind count |
| --- | --- |
| `desktop_delivery_ephemeral`, `desktop_delivery_legacy` | 0, 0 |
| `receipt_draft`, `receipt_alert`, `receipt_claim` | 0, 0, 0 |
| `outcome_resolution`, `abandonment`, `legacy_reconciliation`, `legacy_retirement` | 0, 0, 0, 0 |
| `execution_record`, `execution_output`, `executor_dispatch` | 0, 0, 0 |
| `routing_command`, `routing_result`, `result_outbox`, `result_reconciliation` | 0, 0, 0, 0 |
| `feedback_event`, `result_bus`, `result_bus_cutover` | 0, 0, 0 |

output218 index metadata 与 `bodies/218.txt` 物理缺失；exact cleanup journal、journal/lock/tmp residue、workspace cleanup lock 与 Feedback cursor adjustment 均为0。每次 preview 各自对 141 个路径快照（117 files、23 directories、1 absent directory）比较 SHA256、size、mtime、dev/ino 和目录 entries，变化0。只证明 preview 零写入；下述普通 reconciliation 允许既有内部事务，不能声称整个 reconciliation 纯读。

Installed 正常 trusted-result reconcile 返回 `not_applicable / routing_command_missing`；Feedback projected0/target events0；Bus projected0/replayed59；cutover dispositionsWritten0/replayed50、ready=true、unsafeLegacyInFlight0。再次 preview/inspect 仍完全缺失，未复活 command13、未 Send/reserve/begin-send/ACK/manual cleanup。command10 legacy accepted/no receipt、exact14 abandonment artifacts 与49 `legacy_observed` suppressed queued 的摘要均前后相同；未迁移旧 history。

**R5h fresh live auto-destroy PASS；R5g 正向 production Executor → canonical Result Bus → 当前 VERIFIED Browser Web Sink live path PASS。** endpoint switching、negative live 与 live replay 未演练，不能扩展为整个 live acceptance matrix 全覆盖。command14 仅文档同步，未运行 tests/typecheck/build/full，验证门禁为 `git diff --check`；未 install/rollout/GC/rebind/commit/push。command14 自身标准 receipt 尚须由同 origin terminal fence 核验，不预先声称 observed 或 auto-cleaned。

**NEXT_EXPECTED_STEP**：Planner 独立核对 command14 与其标准回执，完成本次正向 live closeout；其他 live 场景与 legacy manual migration 保持独立范围，不自动执行。

## 16. R5i：Bridge 进程独立性与 host-update resilience（command15 audit；command16 observability）

本节保留R5i历史演进；command22已验证R5i-a部署，当前权威NEXT为第17.3节 **command25 PID identity修复复核与最终formal次数授权，之后R5j-b2/e稳定性验收**，之后再实施R5i-b/c/d/e与真实updater验收；optional endpoint switching/negative live和legacy migration仍在后。完整取证、九项审计回答及 a–f slices 见 [长期开发计划的 R5i 部分](development-plan.md)。R5g/R5h 正向 live PASS 保持有效。

进程所有权与 endpoint availability 是两个边界：Codex close/restart/update/app-server replacement 不得终止 Bridge；若 OS/updater 仍可终止，须由独立机器 owner 自动恢复，不依赖 Codex 再启动。Desktop replacement 仅触发 exact target 的 bounded re-attestation/runtimeFence 更新；未知或多候选继续 fail closed，不能切换 frozen command target、重发 outcome_unknown 或伪造 receipt。workspace、named URL/tunnel、Feedback/Companion 与 Active Web Sink 权威应保持，不能通过重启 Bridge/full rebind 代替安全恢复。

command15 只读快照（2026-10-02）：installed/running build 仍为 `77fa4757c712042a622967f520df980b2070d0c053719562ad1b8a556e8cba90`，Bridge PID17400 healthy、公网 health200、Desktop available。当前 parent PID13856 已消失，生产没有保存实际 spawn mode/creator/初始 Job proof；当前 Bridge 的 `IsProcessInJob(..., NULL, ...)` 成功返回 true，但 Job 所有者/limits/初始归属/旧 PID18580 退出原因均未知。未发现已配置的独立机器 supervisor。日志和可读 Windows 事件不足以还原旧进程被谁终止，因此记录为 **updater resilience 未证明**，不宣称已定位 Job kill 根因。

现有 Windows helper 优先 breakaway、失败后才 WMI；helper 自身不在 Job 不能代替 daemon 证明。强制 WMI fixture 的 no-Job 断言与 sacrificial parent `taskkill /T /F` 仅证明各自场景。真实 updater 的 Job close/reassignment 或其他终止向量需要独立观察，不以 WMI 创建成功推导永久无 Job，参见 [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 和 [WMI Create 限制](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/create-method-in-class-win32-process)。

R5i-a 复用现有 spawn/status/log 保存 bounded mode、进程 creation/executable identity、launcher/release 与 daemon Job 证据，unknown 明示；下一次真实更新前建立独立退出/health 时间线。R5i-b 验证外部 creator 与最终进程归属；R5i-c 根据权限、用户会话/凭据、Job 独立性、运维及恢复时限选择 Scheduled Task/Service/等价 supervisor，尊重用户主动 stop 与现有 maintenance/start/fresh identity 门禁。不得新建 command history 或把退出诊断误作发送授权。

R5i-d 恢复 Desktop authority；**R5i-e 单独处理 Browser refresh reconnect**：同一 ChatGPT conversation 刷新后，一次显式“连接当前对话”应重取当前 document owner、收敛同一 VERIFIED Web Sink，无需重新配对/清空目标。当前 refresh 报错尚无 exact stage 证据，不与 Bridge 退出混为一因，不能清除 unknown/attestation fence 绕过。R5i-f 分别执行真实 Codex close/restart/update 与网页 refresh 验收，证明 URL 连续健康或独立恢复、新 Desktop 识别及 fresh command 回流；保留独立 health/退出时间线与预定恢复上限。

2026-10-02 独立维护补充 R5i-c 的 **persistent application timeout** 恢复缺口：PID `15076` 的 durable/kernel/immutable entry 身份完全匹配，health/admin 三轮均 TCP connected 但各 8 秒响应超时。标准 restart 保守拒绝 `probe_failed`；用户仅授权本次维护，按 maintenance lock + 同 HANDLE fresh identity/entry 核验与终止、原 creation 退出证明后，由 stable launcher 恢复本 workspace 为 PID `15256`、startedAt `2026-10-02T14:23:29.544Z`，build 仍 `465e06ca…9d83e3e`，local/admin/named identity 均通过。command25 已有 trusted output228/queued canonical result，未重新 record/send；绑定和其他 workspace runtime 保留。后续协议需区分明确死亡、拒连接、应用层持续超时和 unknown，保留任务/在途门禁、PID reuse/权限 ambiguity fail-closed 与 workspace scope；不能因一次慢请求而强杀，也不能恢复时重发 command、切换 Sink 或清 unknown。详见 [R5i recovery 维护证据与待实现协议](development-plan.md#2026-10-02bridge-application-timeout-exact-process-recovery)。本次未改生产恢复代码，wedged 根因、自动恢复及 updater resilience 均未证明已解决。

command15 仅文档与只读审计，验证 `git diff --check`；未改生产/测试源码，未 tests/build/install/rollout/restart/stop/rebind/cleanup/commit/push。该历史范围保持不变。

### 16.1 command16：独立诊断记录，不是运行权威

R5i-a 源码已实现，验证汇总见 [长期计划 command16](development-plan.md)。`bridge-spawn-provenance/<workspaceId>.json`（version=1）只保存最近一次实际 spawn，绑定 canonical workspace、PID、startedAt、runtimeBuildId 与 spawnAttemptId；记录实际 mode、helper Job 观察、spawner/helper/最终 daemon/健康后 daemon 的 image/creation/any-Job/字段错误码和观察时间，以及 CLI entryPath/buildId。最终 PID 来自 relay 返回值，不把 relay/helper 的 Job 当成 daemon 的 Job；WMI creator service PID 与 Job owner 均不推断。

`ensureBridge` 在 authenticated healthy exact runtime 确认后原子写入；旧 Bridge 缺记录为 absent，不补造 mode。`status --json` 和 authenticated `/admin/info` 的 `bridgeProvenance` 只返回 matching record 或 bounded absent/conflict。WinAPI 使用完整 HANDLE、同 handle creation/image/Job/零等待存活观察；null 明确表示 unknown/unsupported。诊断永远不参与 readiness、GC/reference、rollout 安全、command cleanup 或发送授权。

同目录 `<workspaceId>.shutdown.json` 只保存最后一次 exact runtime 的关闭意图：admin_shutdown/restart/rollout/SIGINT/SIGTERM/close + observedAt。来源只通过认证后的固定 enum 接受，旧 admin shutdown URL 保持兼容。意图在 shutdown 前写入，错误不改变 shutdown 行为；缺记录不能推出强杀，有 intent 不能推出成功退出。两个文件都无 command history、argv/env、token、消息正文；写锁/安全路径/strict parse/旧身份复核/temp+fsync+rename 拒绝 ambiguous mutation，未知 state 保留。

验证：focused 6 files / 169 tests PASS；Python daemon protocol/teardown 19/13、Desktop protocol 88 PASS；typecheck/build 命令/diff-check PASS；唯一正式串行 full 147 files / 2832 tests PASS（exit 0，854.62s）。全量前增量 build `15fd20b037236d9781fe25476ab65100af9400e849466eea819366e71bc8da59` 未部署。全量内 clean-build 暴露既有 P2：build-id 在 Browser Companion packaging 前发布，最终保存 ID `15ff18f48cfa05d570ad19d8c2e9b1b264bf724a52c5135115f7fc1daee34bbd` 与最终 artifact hash `15fd20b037236d9781fe25476ab65100af9400e849466eea819366e71bc8da59` 不同；安装完整校验会拒绝。详见长期计划 command16 部署前 P2，未通过事后重写 ID 掩盖。

command16 当时状态为 source implementation / independent review and deployment pending；其后 Planner 对 observability slice code review PASS，只阻断于上述 build identity P2。b/c/d/e/f 未完成，真实 kill source、Job limits/owner、后续 re-assignment 与 OS exit code 仍可能未知。

### 16.2 command17：完整 build 的最终发布边界

canonical `pnpm build` 已改为先完成 Browser Companion packaging，最后执行 write-build-id；finalizer 内 bootstrap/package/lock/依赖摘要复制仍先于 hash。未改变完整 dist hash 或安装器校验，也未排除 Companion。partial `build:companion` 不发布 Core ID；若修改 artifact，安装器重算必须拒绝旧 ID，不能以 partial build 冒充 release。

clean-build stored/recomputed/installer ID 都为 `05b4655b53e0d231db1d8bd8aa965d6fd73eec1e71eac72366657ff744e26379`。ID 原子发布瞬间与 pipeline 结束后的完整 dist snapshot 精确相同；Core assets 与依赖 hash 的只读安装身份校验 PASS。同源码重复 canonical build 稳定，发布后篡改 Companion 的 service-worker/popup/manifest 均被真实安装验证函数拒绝（隔离 fixture，不是机器安装）。唯一正式串行 full 为 147 files / 2837 tests PASS、exit 0（874.40s）；focused/Python/typecheck/build/diff 明细见 [长期计划 command17](development-plan.md)。

当前 **R5i-a local/predeploy，build identity P2 已修复；真实 updater resilience 未证明**。NEXT 为 Planner independent review command17，再 install/scoped rollout 观测实现，之后进行独立 health/退出取证下的真实更新复现。本轮不部署，不选择 supervisor、不修改 spawn 策略；R5g/R5h 历史 live PASS 的范围不扩张。

### 16.3 command18/19：preflight observation 与 ephemeral retention 兼容

command18 尚未执行 protect/build/install/rollout：存活 Bridge 的单次2s health timeout，以及 R5h cleanup 后 legacy metadata 从40降至39，分别阻断了观察与历史证据重验。command19 只修源码/测试/文档，机器仍为 build `77fa4757c712042a622967f520df980b2070d0c053719562ad1b8a556e8cba90`。后续旧 record 恢复回流不代表部署完成。

health 首探测2s；仅 fast failure + PID definitely present 才做一次8s retry，并重读 PID、复用同一 workspace/PID/start/build 校验。PID missing/unknown 不获得宽松健康结论，admin auth failure 仍拒绝；timer 覆盖 body read 并在 finally 释放。这个 bounded read-only observation 不重启进程，不证明 updater resilience。

output index 严格只读快照保留 allocation horizon `nextId`，新增可选 `retentionThrough` 仅随真正 eviction 的 atomic index commit 前进，cleanup 保留它；它是共享 store 的单一淘汰水位，不是 completed command tombstone。nextId 距离达到40只是必要条件（短命输出和 orphan skip 可造成假象）；missing metadata 复用仍要求 exact delivery/record/durable snapshot hash、无冲突、所有 retained IDs 更新，并且有实际 eviction 水位或旧格式的共存证明。

旧格式用最后已提交 `L=nextId-1`：当前保留且 ID<L 的 newer items 在 L 提交时仍存在，数量+1达到40才证明容量淘汰。当前39项179–217与最后分配222构成该证明，旧 snapshot26/27/28 只读重验恢复 reconciled，原始状态字节未变。更多旧 holes 没有水位且无法证明时继续 conflict；不迁移、不补 output、不写证据。新水位支持真实 retention 后任意数量的合法 cleanup holes；old command 自身被清理时其 reconciliation evidence 也被删除。strict snapshot 对损坏、非单调 ID、水位矛盾、symlink、temp residue、并发 writer 与读取时文件替换一律拒绝。

command19 最终定向356 tests、唯一正式串行 full **147 files / 2878 tests**、typecheck/build/diff PASS；stored/recomputed/Core release build ID 为 `de7e4c248bda7bc88f4a11c93a5f2fa30f27a3111c9ba7532c40fd17cfd55933`。细节见 [command19 长期计划](development-plan.md)。R5i-a 仍 predeploy；NEXT 为 Planner independent review → 重试 install/scoped rollout，真实 updater resilience 仍待独立 live acceptance。R5g/R5h 既有正向 live PASS 不扩大为 lifecycle independence PASS。

### 16.4 command20：reviewed release 已安装，运行时升级仍 pending

command19独立review通过后，本轮SOURCE修复版两层preflight PASS：旧Bridge PID17400/start/build、认证admin与公网200精确匹配；旧stable仍复现probe_failed和三个legacy conflict，新实现按strict retention proof恢复reconciled，index/evidence零写入。一次canonical build三重ID与reviewed值一致，安装full artifact校验成功：`de7e4c248bda7bc88f4a11c93a5f2fa30f27a3111c9ba7532c40fd17cfd55933`。GC因initial_plan_unsafe保留10候选，删除/retirement均0。

仅workspace2582910bf0d2的stable rollout返回upgraded0/pending1/error0、named_unhealthy，旧runtime未关闭。事后公网200不能替代失败当时的门禁；没有足够细分证据将本次失败归因于已修复的local health问题，未强制重启/重试。running仍为 `77fa4757c712042a622967f520df980b2070d0c053719562ad1b8a556e8cba90`、PID17400、startedAt `2026-10-02T03:59:40.024Z`，upgradePending=true。Desktop/runtimeFence、VERIFIED Web Sink、历史证据和其他workspace runtime均保持。

新installed CLI显示spawn/shutdown均absent，旧authenticated admin不暴露provenance。未产生新runtime，故实际mode、spawnAttemptId、final/healthy Job观察仍unknown；没有发生rollout shutdown，不能声称已验证shutdown intent。安装版非authority导入边界仍通过只读核对，但**R5i-a deployed/verified未达成**。NEXT为核对named health并通过fresh门禁后重新scoped rollout，再根据真实provenance选择R5i-b/c；R5i-e Browser reconnect仍独立，updater resilience未证明。完整部署/GC/验证证据见长期计划command20。本轮仅文档变更，未重复源码回归；standard command20 terminal return另行核验，不提前宣称Browser observed。

### 16.5 command21：named health 的 transport liveness 与语义身份分开

保留command20“安装成功、named_unhealthy阻断rollout”的事实；不能由后来200推断失败当时的具体异常。新只读probe把每阶段预算限制为5s/5s/8s、两次200ms退避，最多18.4s（三个rollout阶段合计最多55.2s探测预算）。只重试timeout/network、无效或空JSON、5xx/429；其他4xx及service/status/workspace/PID/start/build语义不符立即拒绝。timer覆盖body读取并finally清理，不暴露原始响应或异常。

named tunnel state/canonical URL仍先单独校验。public必须exact匹配local authenticated identity，现代local build必须在public显式一致；legacy无build仅豁免build字段，PID/start仍必须exact。preflight/pre_shutdown禁止身份漂移；postcheck只允许完整匹配已认证旧runtime的响应在预算内重试，任意foreign/部分旧身份立即拒绝，最终只有exact新runtime可升级成功。

rollout结果新增可选非权威`namedHealth`诊断（phase/failure/attempts/httpStatus），外部reason仍named_unhealthy；不改strict pending schema，不新增历史store。失败只能沿既有pending写入，不能提前shutdown或变更endpoint/业务状态。具体回归和验证见长期计划command21；定向5 files / 242 tests PASS（named-health30、rollout108、runtime43、tunnel36、bridge-provenance25）；typecheck / canonical build / git diff --check PASS；唯一正式串行full **148 files / 2919 tests PASS，exit0，946.92s**。stored/computeBuildId/Core release ID 在full前后均为 `465e06cae61fddd1f8dac7bbd0de667f2174a1d62f5d51ec3e1110b359d83e3e`；full后源码/测试冻结哈希无漂移，生产current/runtime/pending及所核对历史状态字节不变。

R5i-a保持installed-but-not-running：installed de7e4c24…fd55933、running77fa4757…e8cba90；本轮不部署。NEXT为Planner review→安装包含本修复的exact reviewed build→scoped rollout/真实provenance采集，updater resilience及独立Browser refresh仍待后续验收。

### 16.6 command22：R5i-a 部署及首次真实 provenance

command21 reviewed源码/测试哈希不变；fresh preflight建立exact旧runtime PID/local health/authenticated admin/named public身份。初次自设8s诊断预算曾超时，改用现役adminFetch默认60s后完整fresh gate通过，未改生产门禁。named preflight第2次成功；protect、一次canonical build和安装full artifact校验PASS。built/installed/running最终均为 `465e06cae61fddd1f8dac7bbd0de667f2174a1d62f5d51ec3e1110b359d83e3e`。

仅2582910bf0d2 scoped rollout返回upgraded1/pending0/error0。runtime由PID17400/build77fa4757…e8cba90更替为 **PID15076、startedAt2026-10-02T09:54:08.149Z**；status healthy/current、upgradePending=false。原named URL保留，post-read第3次bounded public probe取得HTTP200与exact新runtime。Desktop binding/runtimeFence、原VERIFIED Sink、历史证据及其他workspace runtime前后不变；legacy snapshot26/27/28通过，output index/evidence读取零写入，in-flight/genuine backlog0，新core finalizer0。GC只按best-effort运行，initial_plan_unsafe下10候选全保留，删除/tombstone/retirement/bytes均0。

installed status与authenticated admin的spawn provenance均matching且record相同：attempt `4b8402f5-1d87-433e-93d2-1254b975afd7`，actual mode **helper-breakaway**，helperInJob=true。spawner2568/helper3492/final15076/healthy15076均identified；final与healthy creationTime同为134354084469855993、executable为 `D:\SOFTWARE\nodejs\node.exe`、inAnyJob均true、所有字段errors为null。launch指向该immutable release的dist/cli/index.js，build精确一致。完整四probe及creation/executable明细见长期计划command22。

**inAnyJob=true只证明观察时Job membership，不能认定Job owner/kill-on-close或updater kill来源。** 旧77fa server没有shutdown recorder，故旧runtime没有durable rollout intent；当前shutdown文件/diagnostic为absent，未补历史。新runtime的intent能力已部署，本轮没有额外shutdown演练。诊断不进入GC/reference/delivery/Bus/routing/endpoint/cleanup authority，namedHealth仍只是bounded rollout结果细分。

**R5i-a deployed/verified，updater resilience仍未证明。NEXT=R5j-a profiling/optimization**；R5i-b外部creator/Job hardening、R5i-c supervisor设计及d/e排在R5j之后。本轮仅两份docs变化，build/identity/install/postgate/diff PASS；源码未变，不重复command21正式full。command22同源record终态回流另行核验，不预称Browser observed。未真实Codex updater/Browser refresh/negative/endpoint switch/rebind/manual cleanup/commit/push。

## 17. R5j：正式全量回归加速（command22 roadmap）

权威优先级为完成R5i-a部署/observability closeout → **R5j** → R5i-b/c/d/e实施；optional endpoint switching/negative live/legacy migration仍在后。R5i-e Browser refresh保持独立问题。command22仅规划；command24实验分组实测见17.2，正式门禁仍未替换。

基线是command21同机正式串行full：148 files/2919 tests、exit0、946.92s（约15m47s）。现役唯一正式命令仍为 `pnpm test --maxWorkers=1 --testTimeout=90000`；test:parallel是实验性。

R5j-a为一次权威serial full采集可重复per-file/per-test wall-clock，区分CPU/spawn/复制/build/install fixture、无网络等待、Windows进程生命周期和sleep/poll。parent-death的180–240s预算、fork-scripts/install-GC、packaging canonical build及重复CLI/Python bootstrap是待测假设，不能把timeout预算当耗时。R5j-b审计per-file C2C_STATE_DIR隔离及env/端口/Job/进程树/机器全局资源/共享checkout-dist/外部进程，划分并行安全与必须串行。R5j-c去重同周期重复build/packaging/install证明，保留真实release identity门禁，不以mock换速度。R5j-d用事件、exit handles、fake timers或有界信号替代可替代的固定等待，真实OS语义仍真实测试。R5j-e发布一个唯一、可审计的优化full命令，覆盖及测试数量不降低，不删测试/减断言/跳Windows E2E/用changed或related替代。

同机同有效full覆盖首目标≤8分钟，stretch≤5分钟；至少连续3次完整通过、pass/fail语义相同，无共享状态race/flake及进程/端口/state泄漏，并经独立review后，才替换maxWorkers=1权威地位。普通开发command仍只在最终source/test冻结后跑一次正式full，失败修复才重跑；不在R5j之前为稳定性重复full。具体slice计划见长期开发计划R5j。

### 17.1 command23：实测 profiling 与并行隔离边界

R5j-a已完成唯一正式serial full：**148 files / 2919 tests PASS，exit0；Vitest965.64s，外层墙钟970.83s**。Vitest3.2.7末尾reporter读取公开module/test diagnostic，原始文件只保存在ignored `.tooling/r5j-profile/`。源码/测试语义未改，459个冻结文件前后一致（src/tests369个）；报告写于测试结束之后。未另跑build/full/install/rollout。

前20文件占629.77s，最大热点为fork-scripts116.20s、web-control-cli57.90s、legacy-reconciliation56.10s、R5d2 lifecycle50.88s，主要是CLI/Git冷启动、真实多store文件事务和cleanup；transform仅4.73s。真实daemon/Bridge parent-death只用6.61/5.90s，不以180–240s预算充当可节省耗时。完整[热点、用例、148文件分类和估算](r5j-regression-profile.md)是本轮可复核的依据。

125文件为parallel_safe_candidate、6文件serial_required、17文件needs_refactor_before_parallel；分类不授权直接启用test:parallel。共享checkout dist的packaging必须先独占完成，再放行Companion/Bridge provenance reader；不能利用缺artifact的exists-guard悄悄少测。真实Job/parent-tree/runtime/binary探测暂保留OS串行组，其他文件保持独立worker/state/env、真实CLI进程和事务边界。没有生产架构、provenance authority或lifecycle语义修改。

进程/监听端口差集未见测试残留，但新增84个测试临时目录未被teardown移除，故R5j-e无泄漏条件未达成；未自动清理现场或legacy machine state。**当前NEXT=Planner review → R5j-b1：fixture teardown/端口生命周期修复 + 构建屏障与OS串行组 + 其余文件3-worker候选runner。** 理想分组模型2/3/4-worker分别500.95/356.31/283.99s，还需约35.95s现有额外开销及资源竞争余量。3-worker预估400–480s可作为首目标；stretch300s尚需额外优化和实测，不能宣称已达成。之后R5j-c减少fixture/bootstrap重复，R5j-d去除可替代短等待，R5j-e在3连跑及独立review通过后才替换正式命令。

R5i-a仍为command22 deployed/verified，running build465e06ca…9d83e3e、helper-breakaway且final/healthy Job=true；这不是updater resilience证明。R5i-b/c/d/e继续排在R5j之后，Browser refresh独立问题保留。

### 17.2 command24：R5j-b1 隔离与实验分组验证

[完整残留根因、分类审计与实测](r5j-regression-profile.md)新增command24记录。修复command23全部84项残留来源，保留历史目录；测试专用严格teardown对持续Windows占用明确失败。实验入口 `pnpm test:full:candidate` 依次运行 packaging1文件独占build/hash屏障 → serial6文件（含因竞争超时移出的web-control-cli）→ parallel142文件/maxWorkers3。显式manifest与共享support hash要求新测试/改动重新审计，实际reporter保证每文件一次、无skip，build后dist不可变。

最终候选 **149 files/2931 tests/exit0，外层464.50s，runner463.53s**；新目录/child/监听端口均0，dist一致；≤480s **达成**。首轮候选web-control-cli超时后移回serial，未放宽60s断言/timeout。正式串行full **149 files/2931 tests/exit0，Vitest954.58s/墙钟956.60s**；12新增回归，生产源码未变。该full发现ensure-start-lock测试留下1个state目录；最后已补runtime teardown、55项定向及候选通过，但尚无补修后的正式full，次数上限授权待定。 候选只完成一次当前最终代码全绿，仍非权威。

**NEXT_EXPECTED_STEP = 确认是否允许追加正式full（command24次数上限）→ 最终补修冻结后的serial gate → Planner review → R5j-b2/e稳定性验收。** 唯一正式门禁保持 `pnpm test --maxWorkers=1 --testTimeout=90000`，3连跑及独立review之前不得替代。R5i-a deployed/verified及updater resilience未证明保持；未安装/rollout/生产操作/commit/push。

### 17.3 command25：fixture PID identity review fix

Planner 发现 command24 `stopFixtureProcess(pid)` 按 raw PID 终止的 P2：短命进程自然退出后，PID reuse 可能使 teardown 触碰无关进程。测试/support 修复改为 `FixtureProcessIdentity={pid,creationTime,executable}`；daemon 直接使用 spawn 返回的 finalProcess，fork 创建方在持有 ChildProcess handle 时同步取得 probe 并写入 fixture marker，remote unlocker 只等待自身 exit event。

Windows 测试 helper 只打开一次带 QUERY/TERMINATE/SYNCHRONIZE 权限的非继承 HANDLE；64位签名明确，在同一句柄上检查 exact creation/executable、TerminateProcess、WaitForSingleObject，finally CloseHandle。身份漂移、活着但权限/探测未知均拒绝终止；已退出目标不再追踪 raw PID；终止后只等待原 HANDLE，绝不重开/杀替代 PID。自然退出期间 query/terminate 可返回 ACCESS_DENIED，只有同一 HANDLE 在最多10秒内 signaled 才证明已退出，持续未知仍失败；外层 helper timeout 15秒。ChildProcess 等待的 timer/listeners 在 exit/error/timeout 后全部释放。没有修改生产 src、daemon lifetime 或历史机器状态。

14项确定性 Python HANDLE 回归使用 fake kernel（含64位handle、PID reuse、creation/exe drift、EPERM/unknown、退出竞态、有限等待、close）；Vitest新增5项覆盖其接线、真实 exact fixture exit、ChildProcess timer清理，总有效用例由2931增至2936。分组维持149文件：packaging1 / serial6 / parallel142；manifest只刷新本轮审计的测试/support字节hash。新增普通child仅拥有自己的进程，不操作共享Job、固定端口或机器安装状态。

本轮唯一实验候选 **149 files / 2936 tests / exit0**，runner **480.29s**、pnpm外层 **481.31s（约8分1秒）**；新增目录/存活测试child/listener均0，dist byte/directory snapshot不变。packaging28.87s（1/1）→ serial96.36s（6/68）→ parallel343.83s（142/2867），各阶段不重叠。相较command23墙钟970.83s减少50.4%，但本次 **超过480s目标1.31秒，≤8m未达成**；不把command24的464.50s代作当前冻结代码测量，也不宣称3连跑稳定。

定向末轮daemon/runner **31 PASS**，fork **13 PASS** 与remote **20 PASS**；Python **14 PASS**；typecheck/diff PASS。早期定向暴露短命进程正在退出时的ACCESS_DENIED窗口，最终改为同一HANDLE有限等待退出证明后补测；持续权限/探测未知仍失败。packaging保留原有真实canonical build及 stored/computeBuildId/Core-release 一致校验，ID为 `29e3945669ffc64d9b0d5977c149d51145f1ed97c1f259993a4d38a7b884ffef`，未额外build。最终测试/support冻结hash保持不变，生产src/browser-companion也与本轮开始一致。raw见ignored `.tooling/r5j-b1-pid/` 和 `.tooling/r5j-candidate/1790944728714-db2b6c28-b009-4bf0-91c0-e80231b3d963/`。

**NEXT_EXPECTED_STEP = Planner复核command25 → 等待明确次数授权 → 最终冻结后的正式serial full → 通过后才进入R5j-b2/e。** command24的954.58s正式full早于最终runtime teardown补修，不能当作command25的最终门禁；本轮明确不运行正式serial full，候选仍非权威。R5i-a仍deployed/verified，updater resilience未证明。未install/rollout/生产restart/endpoint/rebind/legacy cleanup/commit/push。

### 17.4 command26：canonical return 可用性与 Browser request identity

现役 return incident 的持久阻塞是 command10 的空 lifecycle lock；owner 无法证明，仍保留。command25 已有 trusted output228/ok，Bus queued/no attempt，不重新 record/send。旧 `/state` 和 reserve 在 canonical delivery 前全量获取 legacy/control command locks，令一个无关历史锁阻断当前已验证 route 收敛。

新边界复用 delivery arbiter、Web Sink auth 和严格 cutover validator：仅 command lifecycle busy 允许省略 legacy enrichment，以 regular/严格 Feedback snapshot 排除跨源 in-flight，并只复用已验证处置。需要新处置、conflict、corrupt/cleanup transaction 仍 fail closed；不把 legacy/control ready 暗中放入可投递队列。`legacyFeedbackDegraded={code,stage,commandId}` 只作诊断，不含 nonce/path/credential，不授予 route、sink 或 delivery authority；productionEligible 仍需当前 exact Active Sink。已预约 Bus 的 release/begin/ACK 原有身份门禁保持。

Browser authenticated request 使用私有 transport snapshot witness；迟到旧 credential 401 不得污染新 transport，状态/预约/ACK 回归覆盖真实 Pair replacement。当前 credential 的 durable authStale/rebindPending 合同保留。popup 单次 status/RPC UI 等待 10 秒，finally 释放 timer，超时显示 bounded stage，不自动恢复/重发。manual reserve 的 generation 声明前访问也由同一回归明确复现并就地修正。

command26 首次正式serial full为147/149 files、2952/2954 tests、exit1、墙钟985.13s；两个失败是router越过adapter导入错误类型和CRLF静态取样。已恢复架构入口并保持原断言，补修后143项定向、typecheck、build三方身份PASS（`c681654a…fd7f3f`）。用户随后追加一次授权，最终正式full为149 files / 2954 tests PASS、exit0、墙钟1011.18s；424文件冻结未漂移，新目录/存活测试child为0，canonical rebuild仍三方匹配c681654a…fd7f3f。部署事实随后单独核对，不以定向PASS替代门禁。Browser 修复需用户正常 reload/update 才生效，本轮不自动 reload/rebind。R5j 候选仍 experimental；当前 NEXT 以 development-plan 的 command26 收尾为准，覆盖第17.3节旧次数授权等待。

command26 scoped部署（2026-10-03本地时间）完成：built=installed=running `c681654acc5a52572551f92b66610689c39f667e89b888bb46eb35cb4efd7f3f`；canonical full-artifact verification PASS，rollout upgraded1/pending0/error0，PID15256→3380、startedAt=`2026-10-02T16:13:34.058Z`、creationTime=`134354312128903287`。local/admin/named health均exact200，runtimeUpgrade=current/upgradePending=false，原named URL及Desktop/Feedback/Web Sink/Executor binding与其他workspace runtime保持。matching helper-breakaway/inAnyJob=true仍不证明updater resilience；旧shutdown诊断对新runtime为conflict，未附着到新进程。GC initial_plan_unsafe下12候选全保留，deleted/tombstoned/bytes为0；command10空锁未删除或抢占。

command25仍使用原trusted output228/ok：部署后先queued、后正常Bus in-flight，随后receipt/Bus消失；用户从原网页回流提供ATTEMPT_ID `380887a7-bf6e-478c-8b4a-3c33747b0ac9`，installed cleanup preview（无confirm）为not_found/artifacts=[]。没有重录/重发、人工reserve/begin/ACK或manual cleanup。Browser用户确认“已连接，自动回流已开启”；本轮未reload扩展，Browser late401/popup timeout新代码须按用户正常reload/update路径生效。

command26收尾限制：追加full授权后当前resultTurnId=`01a0fd4d-ff74-7813-ae20-1387331371af`，原delivery origin=`01a0fd0d-3019-7f83-9521-e7ce89fcf5b8`；旧/新installed helper均只读分类not_applicable，无origin/native-continuation证明。标准same-origin record尚不能声称成功，禁止--task、指定旧turn或伪造receipt；本任务开发/部署已通过，command26 canonical return闭环仍blocked。

### 17.5 command27：test-only CLI bootstrap optimization

R5j-c1只改变测试启动图：最小fixture调用同一生产web-control/session/record注册函数，26次真实Node/tsx调用和所有跨进程store assertions保留，生产src/receipt/authority不变。standalone外层58.50→19.07s（2→3 tests，新增生产接线guard），过程与checkpoint详见[r5j-regression-profile](r5j-regression-profile.md)。149文件分区不变（packaging1/serial6/parallel142）；唯一candidate执行2955项，2954 PASS/1 FAIL、exit1、外层472.11s，不能认定≤8m验收达成。三阶段33.53/66.24/359.22s；新目录/child/listener均0、dist不变、419文件冻结无漂移。定向3项、分组17项、typecheck/diff PASS；没有正式serial或第二次candidate，没有额外build/install/rollout/commit/push。

失败为`r5-web-sink-http`的401用例在Fetch入口返回`bad port`：真实`port=0`监听可能被本机动态端口范围1024..15000分配到Node Fetch禁止端口，尚未进入HTTP鉴权。只读检查本机端口配置和当前Node内置Undici证明此兼容缺口，实际失败端口未记录；未改生产/OS或重试掩盖失败。**NEXT_EXPECTED_STEP：新command修复测试专用HTTP端口/transport fixture兼容性，保持真实HTTP/auth断言，随后重新按授权验证candidate。** 暂不进入三连跑资格验收；候选仍experimental。R5i-a保持deployed/verified，updater resilience未证明。

授权规则：中途需要用户专有授权，先终结当前command并标准record BLOCKED，再询问；授权后Planner投递新commandId续作。普通composer输入不能冒充native continuation，不追补command26 receipt。


### 17.6 command28：新 canonical result 的降级 projection 缺口

只读现场确认command27有trusted same-origin receipt/output229（blocked）与canonical RoutingResult，Bus为空；command10 lifecycle lock仍是原0字节、无法证明owner的文件，未删除/抢占。command26只解决了已有Bus项的降级投递：prepare先执行legacy Feedback reconcile，遇COMMAND_CLEANUP_BUSY后进入readOnly cutover，而readOnly不backfill；因此command25可回流、新产生的command27却停在Bus之前。

修复将authenticated Web Sink canonical preparation排序为：严格Feedback snapshot → 独立canonical projection → 可选legacy enrichment/cutover。projection不在legacy catch内；新增projectAvailableResultBusCommands按command分组，持原lifecycle lock后重读RoutingResult，再用原enqueue事务。只隔离同command的COMMAND_CLEANUP_BUSY/COMMAND_CLEANUP_IN_PROGRESS；cleanup journal不重建，锁不抢占。Bus/routing损坏、workspace/immutable/digest冲突及其他异常仍失败；原reconcileWorkspaceResultBus继续严格行为。被跳过command已有queued Bus也不成为本次ready/reserve候选，in-flight单飞不绕过。

仅原有legacy COMMAND_CLEANUP_BUSY允许readOnly cutover降级；已有disposition严格复核，缺处置的历史counterpart仍RESULT_BUS_CUTOVER_REQUIRED，legacy in-flight/corrupt/cleanup transaction仍阻断。canonicalProjectionDegraded只含skippedCount和最多20条commandId/code，不含path/nonce/PID/正文；不是routing/GC authority。valid cleanup journal虽可单独跳过projection，legacy enrichment原有IN_PROGRESS全局拒绝仍保留，不伪装ready。

回归先red：degraded服务运行后新RoutingResult出现，旧/state仍pendingReady=0；修复后真实HTTP/state投影新项、/reserve精确一次且replay不写，旧锁/Feedback不改。覆盖自身锁/journal、Bus/routing损坏、immutable conflict、wrong workspace/route、未决/已有cutover。测试HTTP客户端复用新增test-only http-json.ts（Node http.request，agent=false，超时销毁socket）；r5-web-sink-http与cutover HTTP fixture保持真实port=0/TCP/Authorization/JSON/status断言，避开Fetch forbidden-port限制，不改OS或生产服务。

定向覆盖8 files/163 tests PASS（相关核心2文件78项、其余5文件68项、manifest17项）；首次扩大定向有1项新journal测试预期过宽，修正为保留legacy IN_PROGRESS拒绝后通过。随后唯一正式serial full：**148/149 files、2966/2967 tests PASS，exit1；Vitest841.95s/外层843.95s**。426个冻结文件前后无漂移，build为67dac3002a55b12baa86744dea84cb8ba639137b7c04751a28e91eca4ba4fe7a；新test-tmp目录0、listener0，结束采样出现的2个短命git进程后续只读复核原creation均已消失，未kill。

full唯一失败为companion-feedback的takeover/immediate-successor用例：本轮提前的route check在无Active Sink且旧Feedback epoch过期时先返回400，遮住原应优先的401。已补修为无canonical sink时先建立legacy credential authority，再检查route，均先于projection/mutation；保留原401断言和后续rebind流程。补修后companion-feedback、cutover、R5g、Web Sink HTTP共**4 files/128 tests PASS**；typecheck/canonical build/diff PASS。最终stored=computeBuildId=Core-release为**9af70c8912732a001ef7c40688e6d3116a567267288942d4f406ad297c63ff53**；没有补修后的正式full，不把定向通过冒充最终全量门禁。

本轮一次正式full限额已用完，**deployment BLOCKED**；未运行第二次full或实验candidate、未install/rollout/GC/commit/push。manifest仍packaging1/serial6/parallel142，仅刷新3个测试及新HTTP helper审计hash。关闭前只读复核command27 receipt/output229与RoutingResult hash未变、Bus仍空，command10空锁内容/file identity未变。installed/running仍c681654acc5a52572551f92b66610689c39f667e89b888bb46eb35cb4efd7f3f，故command27自动回流仍待新代码部署，未声称observed/ACK。command28以正常same-origin BLOCKED record收尾，不用--task或新ID冒充本轮receipt。

**当前NEXT：Planner以新commandId授权补修冻结代码的一次正式serial full；通过后沿用已有install/scoped-rollout授权恢复command27正常投递，再核对command28标准回执/结果，并在存在trusted证据时验证正常投影。** 不跨普通用户授权turn追补旧origin，不重录/重发command27；现役旧server仍有projection缺口，command28 canonical handoff也可能停在Bus之前，不能预报回流成功。

**NEXT（本轮回流收敛后）：GC per-release fail-closed redesign优先，区分真正global authority blocker与仅影响单release的未知reference；再恢复R5j候选验证/剩余热点。** 本轮不扩展GC规则，candidate仍experimental、三连跑未开始。R5i-a deployed/verified和updater resilience未证明保持。普通composer turn不提升为native continuation；不补记command26，不重录/重发command27。


### 17.7 command29：最终串行门禁失败，部署停止（2026-10-03）

在 command28 最终修复快照上只执行了一次获授权的正式 `pnpm test --maxWorkers=1 --testTimeout=90000`：**149 files / 2967 tests，148 files / 2966 tests PASS，1 FAIL，exit1；Vitest 856.96s，外层859.60s**。运行前后426个source/test/support hash完全一致；新增test-tmp目录、残留child和listener均为0，无staged/conflicted文件。本轮没有修改生产、测试或support源码，也没有第二次full或candidate。

唯一失败在 `tests/bridge-provenance.test.ts:148`：真实Bridge以`port=0`监听，未认证`fetch(/admin/info)`在Node Fetch入口抛出`TypeError: fetch failed`，cause明确为`Error: bad port`。请求尚未到达HTTP鉴权或shutdown断言；实际分配端口未记录，不猜测数值。这是另一个真实HTTP fixture使用Fetch与OS动态端口不兼容的实例，不是command28修复的auth-order再次失败。本次full中companion-feedback57、cutover61、Result Bus17、R5g5、Web Sink HTTP5均PASS。按本轮失败分支约束，仅定位，不在本轮修复后追加full。

失败后只读核对stored/computeBuildId/Core-release仍一致为`9af70c8912732a001ef7c40688e6d3116a567267288942d4f406ad297c63ff53`；这不构成正式门禁PASS。本轮未另行typecheck、部署前canonical build、protect/install/GC/rollout。installed/running仍为`c681654acc5a52572551f92b66610689c39f667e89b888bb46eb35cb4efd7f3f`，PID3380；local health/authenticated admin/named public health身份一致，rollout只读gate idle=true，Desktop available、unresolvedDelivery=false、Web Sink VERIFIED。

**command27前置事实已变化**：本轮首次只读检查时receipt、RoutingResult、Bus均已不存在；installed cleanup preview（无confirm）返回`not_found / artifacts=[]`。不能再证明它与command28关闭时的output229/result hash相同，也不能把absence当Browser observed/ACK证明。本轮未重录、重发、重建、手工reserve/begin-send/ACK或清理command27；无可供恢复的本地artifact，回流原因/attempt需独立网页证据确认。command10原零字节锁的SHA256、file identity和mtime完全未变。

command29按正常same-origin `applicable/origin` 走标准BLOCKED record，最终active-turn draft仍须由terminal finalizer验证；不预称trusted receipt或canonical handoff/Browser observed已完成。未commit/push/rebind/endpoint switch，不补记command26。

**当前NEXT_EXPECTED_STEP：以新commandId修复provenance真实HTTP fixture（复用测试用Node HTTP client，保留真实鉴权/shutdown与生命周期断言，审查相邻ephemeral-port Fetch调用），并另行取得一次最终冻结后的正式full次数授权。** 通过后才沿用install/scoped rollout授权；回流健康后优先GC per-release fail-closed redesign（保留真正global authority blockers），再恢复R5j候选验收。candidate仍experimental，R5i-a已部署的历史结论保持，updater resilience仍未证明。


### 17.8 command30：临时端口 HTTP fixture 修复（仅测试，2026-10-03）

command29唯一失败是provenance用例的`fetch(/admin/info)`在真实HTTP之前被Node Fetch的forbidden-port表拒绝；生产源码与auth-order补修无漂移。本轮先给原provenance用例加入禁止Fetch的确定性guard，确认RED，再替换fixture客户端；不靠碰巧分配到禁用端口或retry证明修复。

复用`tests/http-json.ts`：新增基于Node标准库`http.request`的buffered `requestHttp`，返回标准Response以保留status/headers/text/JSON；`requestJson`仍严格解析，HTML、空body和坏JSON明确拒绝。连接`agent:false`，默认10秒**总deadline**覆盖无响应/未完成body，request close清除timer；redirect仅manual，不添加自动follow或SSE/SDK适配。本轮未改生产timeout、OS端口范围，不采用固定safe port或retry-until-safe。

修复的9个suite：bridge-provenance、auth-compatibility、build-id、runtime、desktop-interfaces、write-probe、oauth、companion-feedback、r5g-cross-plugin-e2e。保留真实Bridge `port=0`、HTTP方法/header/body、鉴权status、OAuth redirect/text、安全header、JSON和生命周期断言。provenance的三个HTTP步骤均使用测试客户端，因为生产`adminFetch`同样使用Fetch；保留未认证404空body、认证200与无token泄漏，POST保留Bearer及`X-C2C-Shutdown-Reason: rollout`、5秒deadline，并验证durable intent。build-id的admin请求同理，仍验证真实server捕获build身份。

静态审计后测试源码中剩余`fetch(`为route-attestation源码字符串断言。**有意保留**SDK StreamableHTTPClientTransport及其内部Fetch、生产probeBridge/adminFetch/CLI真实客户端行为覆盖和Fetch timeout mocks：本地SDK确有fetch注入点，但还要求streaming/SSE/取消语义，本轮buffered helper不具备该完整合同，不能机械替代。故本轮证明的是直接HTTP fixture调用修复，不宣称所有间接生产/SDK Fetch路径已消除端口风险。

新增`tests/http-json.test.ts`8项：以禁止端口6000的逻辑URL进入Node HTTP，在request单元seam仅把TCP目的地映射到真实port=0 server（不绑定固定端口），验证零Fetch调用与真实401/201、method/header/body；验证text/empty/坏JSON、manual redirect/URLSearchParams、无响应/partial响应总超时、socket和timer释放。开发中发现的空404误用JSON解析、server close callback早于socket close事件及events.once因ECONNRESET提前reject的问题已修正；最终没有未处理异常或被放宽的断言。

**最终定向13 files / 285 tests PASS，exit0，Vitest100.09s / 外层102.03s；typecheck与git diff --check PASS。** 覆盖全部变更suite及r5-web-sink-http、r5d3 cutover、candidate manifest guards。427个最终冻结source/test/support文件在定向前后无漂移，生产src/Browser/package/构建脚本与本轮起点一致。新test-tmp目录0、listener0；结束采样2个短命git进程经PID+creation只读复核均已消失，未kill。

Manifest仅刷新9个已审suite hash、http-json支持文件hash，并显式新增helper测试分类：**150 files = packaging1 / serial6 / parallel143**；候选仍experimental。本轮没有正式serial full、candidate full、canonical build、install/rollout/GC、生产runtime/绑定操作、commit/push；tests-only改动不需重建Core。现有dist身份读取仍为`9af70c8912732a001ef7c40688e6d3116a567267288942d4f406ad297c63ff53`，不把旧build身份当作本轮全量或部署证据。

**当前NEXT_EXPECTED_STEP：Planner review本轮测试修复 → 新command单独授权最终冻结后的正式serial full → PASS后沿用已有install/scoped rollout授权。** 回流部署收敛后，用户要求的GC per-release fail-closed redesign仍优先于R5j候选验收；真正global authority corruption继续全局阻断。command30最后使用正常same-origin标准record，active draft的trusted commit/canonical handoff由terminal finalizer核验，不预称Browser observed/ACK；不补记旧command，不使用--task fallback。
