# 双向消息收件箱

本轮参考主代理向执行代理派发任务的方式：提交和执行分开，执行结果与网页发送分开。复用当前领域存储、固定插件注册表和安全发送器，不引入数据库、第二套队列或新的 Desktop IPC 协议。

## 下发

`codex_desktop_send` 和 `executor_send` 在 Bridge 中验证有效授权、workspace、当前目标和正文后，将 Command 与收件箱正文一次原子保存。返回 `deliveryStatus=queued` 表示 Bridge 已接收；ChatGPT 可以结束当前轮，不等待 Codex 执行。相同 commandId、正文、主体、客户端和目标只读回放；冲突拒绝，不能用新 ID 重发同一未知任务。

后台每两秒处理候选消息。Codex busy 时保留排队；确认 idle 后仍通过原安全 sender 的 prepare 和提交点重新验证身份、授权、owner、审批与防重放，取得真实接受凭据才变为 accepted。没有验证原生 steer/插播能力，因此本轮不直接向 active turn 插入消息。队列最多 100 条，每轮最多实际处理一个可获得 authority 的候选。

锁顺序为 machine maintenance → command lifecycle → endpoint/store；安装、rollout、关闭阻止新投递。某个 Command 的坏锁、cleanup 或未知尝试只隔离该条；跳过它时不修复、删除或取得其 authority。全局存储损坏、维护锁未知仍停止相关操作。排队授权过期/撤销、目标改变时封为 blocked，不转投其他会话。Bridge 重启遗留 dispatching 封为未知，不自动重发。

取消只允许证明尚未发送的 Command；dispatching、重启中断、已有投递/结果证据不能当作未发送取消。取消会去掉排队正文，保留防重放记录。accepted 只表示接收，不表示执行完成；终态仍由原同来源可信 record 与 canonical Result Bus 核验。

Bridge 关闭会禁止新增发送并等待已准入调用。准备阶段因关闭而被拒绝、且两类投递 ledger 都无证据时，保留 queued；进入发送提交点后保留并等待原尝试，不能重新排队。已准入 IPC 的 bounded 等待可能超过 restart 的 5 秒退出核验窗口，此时安全重启会保持 pending，不会打断可能已发送的调用或启动第二实例。

## 回流

canonical Result Bus 每条记录冻结自己的结果、目标、reservation 和 attempt。浏览器恢复先只读观察原发送；找不到精确可见证据时，只在 fresh exact owner、输入框为空、无本地生产发送并发且网页组件证明零写入/零点击的条件下隔离原 attempt。

Companion 先持久保存原日志，再调用认证的 `POST /api/companion/v1/isolate-attempt`。请求与响应均精确匹配 routeCanonical/eventId/reservationId/attemptId/messageSha256。服务端仍保存 outcome_unknown 与原 attempt，加入 isolatedAt；隔离不是 ACK、执行成功或删除。只有 durable archive 和服务端精确确认均存在，才能释放本地 active journal，让后续 canonical 回流继续。

本地未知尝试归档最多 32 条、2 MiB；归档满或损坏时保留 active journal 并报告具体原因，不自动删除防重发证据来腾位置。

崩溃、响应丢失、存储失败、错误身份或旧服务端不支持时保留 active journal；重试只重验原隔离操作，不重复 DOM Send。真正晚到的精确可见证据仍可完成原 attempt 的 ACK。旧 legacy/control outbox 未迁移到这个隔离合同，继续保留原保守恢复边界。

对已经由用户明确清理的旧任务，`POST /api/companion/v1/operations/terminal-gone` 仅凭当前已验证 Web Sink 身份、精确 route 和既有 terminal witness 查询原 source 是否消失。原 source 尚在时返回 still_present；消失时返回 terminal_gone，不调用 ACK、不写结果或创建 witness。浏览器仍先保存完整原 journal，并验证零写入/零点击等安全证明后才清空 active journal。这样原任务清理不会被误记成回流成功。

## 面板与职责

面板分别显示两端可用性、连接和自动回流，再按条展示 queued/dispatching/blocked、真实投递、可信执行及回流。Codex busy 是调度状态；网页生成、草稿非空或 owner 不明时仍等待，不能覆盖用户文本。四项状态是摘要，发送边界仍实时核验。

`GET /api/companion/v1/operations/result?commandId=…&iteration=…` 只读返回已有 canonical summary/tests。需要当前 VERIFIED 的 scoped Companion 认证；结果 frozen 到其他网页时拒绝读取，未知条目不创建。正文以 textContent 呈现，不执行 HTML。这样 DOM 回流未确认时，用户仍能在符合目标权限的面板中查结果。

| 权威 | 唯一职责 |
| --- | --- |
| Routing Command/mailbox | 接收、排队正文、取消、固定任务身份 |
| Desktop/Executor dispatch ledger | 提交尝试及真实接受凭据，原 ID 防重放 |
| trusted record / canonical Result Bus | 执行终态和结果，以及逐条回流状态 |
| Companion journal/archive | 浏览器不可逆发送证据与原 attempt 防重发 |
| 运行管理与维护 | 进程、安装、rollout；不由消息状态查询触发 |

## 本轮源码验收（2026-10-05）

修订后的正式串行门禁为161 files /3403 tests PASS、exit0、unhandled0、skip/pending/todo0；465项冻结哈希稳定，进程/监听/temp新增残留0。typecheck、独立审查、canonical build、文档链接与diff检查通过。stored==computeBuildId==core-release为 `1326542c3601b2919b1872c1d80ac22aab258b05774c5ce438513b0c5aeba3a8`。首轮5项结构定位断言失败和修订证据完整保留；未修改生产行为来绕过这些测试。最新证据在 ignored `.tooling/agent-mailbox-20261005-final/`。

## 当前部署与交付边界（2026-10-05）

后端 build `1326542c3601b2919b1872c1d80ac22aab258b05774c5ce438513b0c5aeba3a8` 已安装并运行；workspace `2582910bf0d2` scoped rollout 为 current，08:32 核验 built=installed=running、`runtimeUpgrade=current`。用户已确认 Companion Reload。页面组件是否就绪、真实任务下发、可信结果回流/ACK 与面板读取仍未独立端到端观察。Desktop 本机确认已完成，Desktop 与 generic Executor availability=true（采样 activity=busy），投递权限门禁已恢复；真实消息链尚未端到端验收。Supervisor task/config/runtime 仍 absent/null，独立恢复没有验收。详情见[部署快照](development-plan.md#当前事实与开发阶段2026-10-04-2144asiashanghai)。
