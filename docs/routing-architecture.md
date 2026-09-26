# Routing Architecture（R1 foundation + R3 live-complete；R4a/R4b reviewed）

Routing 是 C2C 的新语义身份层：以 `{workspaceId, platform, conversationId}` 标识
workspace 内特定平台上的对话。Route 另有注册后不可变的 planner / executor role；
Command / ExecutionResult 是可持久化、可重放、可审计的记录。R1 只建立模型与 durable
store，不接任何生产调用方。

## R0→R5 当前路线

权威阶段定义与完整历史见[长期开发计划](development-plan.md)。当前状态：R0 基线、R1 Routing
foundation、R2 Desktop behavioral adapter、R3 Browser Companion Web adapter / feedback return plane
均已完成，R3 真实 live E2E 已通过；R4a canonical result envelope 与 R4b receipt → canonical RoutingResult → routing-owned Result Outbox 均已完成且独立 review PASS；R4c 下一步消费新 outbox 并渐进迁移旧 Browser feedback delivery；R5 尚未开始。

| 阶段 | Routing 相关目标 | 状态 |
| --- | --- | --- |
| R0 | 清理实验分支并建立可信基线 | done |
| R1 | Project 容器、核心身份为 `{workspaceId, platform, conversationId}` 的 Route、Command、最小 ExecutionResult durable model | foundation done |
| R2 | Desktop 生产信任基于 live behavioral proof | done |
| R3 | Web adapter、当前网址绑定与 feedback return plane | live E2E PASS |
| R4 | canonical ExecutionResult + `Command.plannerRouteId` durable outbox；机器事实与 Codex 自己的 final summary 一并回流，不做第二次 AI rewrite | R4a/R4b done / independent review PASS；R4c next：消费 planner-route outbox 并渐进迁移旧 Browser feedback delivery |
| R5 | Bridge lifecycle 与会话执行状态解耦 | planned; 不属于 H0 / Claude E1a |

## 术语

| 术语 | 含义 |
| --- | --- |
| Route | 标识 workspace 内特定平台上的一个对话，核心 semantic identity 是 `{workspaceId, platform, conversationId}`；`role`（planner / executor）是注册后不可变的属性，不属于核心 identity。 |
| platform | 端点/执行平台，不是 OS，也不是模糊产品类别。R1 初始值：`chatgpt_web`、`codex_desktop`；未来按需扩展 `codex_cloud`、`claude_code`、`mimo_desktop`。 |
| conversationId | 平台专项校验的会话标识。`chatgpt_web` 沿用现有 ChatGPT legacy 字符集 `[A-Za-z0-9_-]{1,128}`（保持平台原样字符串语义，不强行 lowercase）；`codex_desktop` 用 UUID，注册时 canonical 化为 lowercase，大小写变体不形成两个 identity。未来平台各自新增 validator，不允许把整段 URL 塞进 conversationId。 |
| locator | 平台定位信息，按 platform 判别（discriminated union），**不参与 route identity**。`chatgpt_web`: `{ gptId? }`；`codex_desktop`: `{ hostId: "local", executorProjectId }`。 |
| Project | 一个 workspace 内的项目容器，可关联多个带 planner / executor role 的 Route。 |
| Command | 一次投递描述。`deliveryStatus` 只有 `pending / accepted / rejected / outcome_unknown`；**发送结果不明 ≠ 执行失败**。 |
| ExecutionResult | 一次执行结果。`status` 为 `ok / failed / blocked`；允许一个 command 多个 iteration result，`(commandId, iteration)` 唯一。 |
| legacyReferenceId | legacy projection 产出的引用 ID（desktop `bindingId`、companion `bindingId`）。**仅为引用 ID，不承担真实身份。** |

> `routeId`、`bindingId`、`resultId` 都是随机引用标识；能够决定跨进程路由归属的是
> `{workspaceId, platform, conversationId}` 核心 semantic identity，而不是这些 ID。

## Threat model

**C2C 不试图防御具有当前用户本机执行权限的恶意进程。C2C 的安全边界是防止跨
workspace / platform / conversation 的错误路由、command 重放、重复 mutation、
错误 result 归属以及损坏状态被静默接受。**

由此推导的模型约束：

- **跨 workspace 不串线**：状态按 workspace 独立存储（`<stateDir>/routing/<workspaceId>.json`）；
  store API 与 legacy projection 公共入口接收 workspace identity 对象（`Pick<Workspace, "id" | "root">`），
  先用 `new Workspace(root)` 走生产同款 realpath + sha256 派生，要求 `resolved.id === identity.id`
  且 `resolved.root === identity.root`（伪造 id/root 组合 → `ROUTING_WORKSPACE_IDENTITY_MISMATCH`，
  不读任何 state）；每次读取/写入再核对 state 的 `workspaceId/workspaceRoot`，任一不匹配 fail closed。
  所有 routeId 引用必须解析到本 state 内的 route，结构性禁止跨 workspace 引用。
- **route identity 唯一**：workspace 内 `(platform, conversationId)` 唯一；同 conversationId
  不同 platform 不冲突。role 注册后不可变，同一会话不得兼任 planner 与 executor。
- **locator 不参与 identity**：locator 漂移不允许静默接受（`ROUTE_LOCATOR_CONFLICT`），
  防止定位字段在重放中被偷换。
- **command 重放与伪造**：commandId 严格幂等——同 commandId + 完全相同
  routes/intent/payload 指纹才返回旧记录，任一字段不同即 `COMMAND_CONFLICT`；
  创建入口封死初始 `deliveryStatus`（一律 `pending`），`accepted/rejected/outcome_unknown`
  只能由未来 transport 阶段的明确状态转换 API 写入。
- **exact replay 不修改状态**：route / command / result 的 exact replay 返回原记录，
  不 bump revision、不更新 `updatedAt`、不重写主 state 文件；幂等是可观测性质，
  不是仅返回值相同。
- **错误 result 归属**：result 必须引用本 state 内真实 command；幂等身份是
  `(commandId, iteration)`——已存在时字段全同 → exact replay，executor/status 任一不同 →
  `RESULT_CONFLICT`；首次写入时 executor 与 command 不符 → `ROUTING_RESULT_ROUTE_MISMATCH`。
  重复 receipt 冲突与首次错误引用是两类清楚错误。
- **损坏状态 fail closed**：状态损坏、未初始化历史缺失或 identity 不匹配时抛
  `ROUTING_STATE_CORRUPT`，保留文件、不重置、人工核对；绝不静默重建 ID 历史。
- **legacy 侧信道**：legacy projection 只读，不写任何旧/新 state；旧 Companion 只有
  route attestation 已 VERIFIED 才投影 planner candidate，绝不因文件里有个 URL 就把它
  升级成可信 planner route。

## 数据流（未来形态）

```text
Planner route → Project → Command → Executor route → ExecutionResult → Planner route
```

- Planner route 上的规划会话产生 Command，Command 显式引用 `plannerRouteId` 与
  `executorRouteId`（schema 强制 planner→planner、executor→executor，角色放反即拒绝）。
- Executor route 执行后产出 ExecutionResult，结果沿 Command 引用回流到 Planner route。
- Routing store 不保存 active/default route 指针。当前 planner route 从同一 MCP request 的官方
  conversation principal 派生；当前 executor route 从现有 Desktop binding target 派生，避免第二个
  binding 状态机。R3 Browser Companion 是 Web binding 与 feedback return plane，不是当前 task planner authority。

## Durable store

- 存储：per-workspace 单文件 `<stateDir>/routing/<workspaceId>.json`；workspace 是安全边界。
- 范式对齐 desktop store：`wx` 文件锁（`ROUTING_STORE_BUSY`）、tmp+rename+fsync 原子写、
  `.initialized` 标记、损坏 fail closed（`ROUTING_STATE_CORRUPT`）。
- 与 desktop store 的差异：Routing 是全新 store，无历史兼容包袱——`revision` 必填
  （transient 空状态显式 `revision: 0`，首次 durable write 后为 1；persisted revision 缺失
  即 `ROUTING_STATE_CORRUPT`，不允许回退到 0 重新计数）；exact replay 不重写主 state 文件。
- 永久 ID 历史不淘汰；容量到限人工迁移。
- Route 注册幂等：同 identity 再注册，role+locator 全同返回既有；role 不同
  `ROUTE_ROLE_CONFLICT`；locator 漂移 `ROUTE_LOCATOR_CONFLICT`。

## Legacy projection（不是 migration）

`src/routing/legacy-adapter.ts` 只读读取现有 desktop-control / feedback state，产出
`LegacyRouteCandidate` 供兼容投影：

- Desktop binding → executor candidate（`platform=codex_desktop`、
  `conversationId=threadId`、`locator.hostId/executorProjectId`、
  `legacyReferenceId=bindingId`）。
- 旧 feedback → 历史 planner candidate，仅当 Companion route attestation 已 VERIFIED；
  否则 `planner candidate = none`。R3l 后该 candidate 不代表当前生产 planner authority。
- projection 本身不生成 routeId、不写 routing store 或任何旧 state；R3a 的独立显式 ensure
  才会按当前 VERIFIED candidate 注册 Route，不代表旧 state migration 或 rebind。

## R3a planner route（初版语义，已由 R3l 收敛）

- 初版曾从 VERIFIED Companion candidate 派生；该 planner authority 已由 R3l 替换，不再是当前生产语义。
- 现行 `current-planner-route.ts` 以同一次 MCP request 的可信 conversation principal fingerprint 为身份；
  只读解析及显式 ensure 均精确匹配该 request route，且注册后 re-resolve。旧 Companion-derived route
  仅保留为 routing catalog/history，不会被新请求自动采用。
- current route 每次从 request-scoped fingerprint 派生，不是新的持久指针；旧 routing route 仍作为
  catalog/history 保存。生产 send 接线及 Browser reconnect UX 分别见 R3e 与 R3f–R3l。
- ensure 返回值只是最终 recheck 时点的快照，不是 lease；后续 R3b 必须在实际副作用边界重新解析，
  不能跨 `await` 或进程边界把返回 route 当作持续有效的 authority。

## R3b 当前 executor route（derived foundation）

- `src/routing/current-executor-route.ts` 复用 Desktop-only `desktop-adapter.ts` 的 binding candidate；
  route identity 表达当前绑定的 thread/project target，不包含 enabled、availability 或 busy 状态。
- 只读解析精确匹配已注册的 `codex_desktop` executor route；显式 ensure 复用 `registerRoute()`，
  exact replay 不改 revision/文件，并在注册后重读 binding。若 binding 在 ensure 期间变化则抛
  `ROUTE_AUTHORITY_CHANGED`；旧 route 可留作 catalog/history，但不作为 current 返回。
- helper 只读 Desktop state，不代表 Desktop 可发送或已空闲；返回值是时点快照而非 lease，不新增持久
  current/default pointer。

## R3c 当前 Command adapter（Command catalog foundation）

- `src/routing/current-command.ts` 显式 ensure 当前 request-principal planner 与 Desktop executor route；缺少任一当前 authority
  时抛 `ROUTING_ROUTE_NOT_FOUND`，不从历史 route 推断。它以原始 payload 的 UTF-8 byte length 和
  SHA-256 调用现有 `createCommand()`，由 routing store 负责 pending 状态与 commandId 幂等/冲突语义。
- 创建前同步 re-resolve 两条 route 以减少明显 stale；这仍只是时点检查，不是 transport lease。该 adapter
  只写 routing store，不调用 send、不写 Desktop/feedback/Companion。

## R3d Command → Desktop delivery adapter

- `src/routing/current-command-transport.ts` 复用 `createCurrentCommand()`；首次投递前同步重新解析
  当前 MCP request planner 与 Desktop binding executor，并把与 digest/bytes 完全相同的原始 payload
  交给唯一 transport `sendDesktop()`。Desktop 仍独立执行现有授权、binding、busy、replay、owner/process
  与 outcome_unknown 门禁；此检查只是时点快照，不是 lease。
- 新增 `transitionCommandDelivery()`，仅允许既有 pending Command 转为 `accepted / rejected /
  outcome_unknown`；相同终态 replay 不写文件，不同终态抛 `ROUTING_COMMAND_DELIVERY_CONFLICT`。
- routing 同步失败直接暴露；pending Command 的同 commandId replay 先校验 intent/payload，再只读核对
  Desktop durable ledger。记录与原 executor route 一致时只 transition routing、不 IPC send，也不要求
  当前 binding 未变化；ledger 无记录时才要求当前 planner/executor authority 一致并调用 sender。
  不新增重发/补偿队列。
- 已是 routing 终态的 exact replay 直接返回既有 Command，不要求 current route 未变化，也不再次调用
  Desktop。R3d 本身不处理 feedback / ExecutionResult。

## R3e 生产 MCP send 接线

- 现有 `codex_desktop_send` handler 调用 `deliverCurrentCommand()`；工具名、`sendInput` schema、OAuth
  scope、`userConfirmed:true` 和 Desktop public delivery 输出保持不变。`sendDesktop()` 仍是唯一真实 sender。
- 显式传入的 `bindingId` 不会被 routing 自动替换：新 Command 及无 durable record 的 pending Command
  必须匹配当前 binding；已有 Desktop delivery 的 replay 必须匹配原 delivery 的 `bindingId`，并返回原 public
  delivery。不同 binding 沿用 `DESKTOP_BINDING_MISMATCH` / `DESKTOP_COMMAND_CONFLICT` 拒绝，不二次发送。
- 新 Command 要求同一 MCP request 有官方 conversation principal；planner route 只由其 fingerprint 派生，
  不读取 Companion/feedback authority。缺少 principal 时以明确 routing error 拒绝，发送不进入 IPC。
- 仅 `codex_desktop_send` 接入；不接 feedback / ExecutionResult。Browser Companion 重连 UX 由独立 R3f
  提供，不改变本 slice 的 routing/send 边界。

## R2 状态（2026-09-24）

R2（Desktop Behavioral Adapter）已把 Desktop 生产信任路径切换为 live 行为证明：
Desktop 是否可用由当前进程/owner/project/workspace 核验与发送后 canonical turn 证明决定，
版本/app-server hash/ASAR/catalog/semantic fingerprint 预登记体系整体删除。
R3e 将现有 `codex_desktop_send` 接到 R3d adapter；底层仍复用原 Desktop behavioral send 路径，
不改变 `sendDesktop()` 的信任边界。

## R1/R3 边界与当前迁移约束

- 以下边界描述的是 R3e send 接线切片，不代表 R3 aggregate 的当前完成状态：该 slice 仅把现有
  `codex_desktop_send` 接入 R3d adapter；`codex_desktop_status`、feedback、Companion、rollout wiring
  不变，不新增 MCP tool。
- R3e slice 不实现 feedback/ExecutionResult 回流或 executor 执行通道；feedback return plane 后由 R3 后续切片完成，
  canonical ExecutionResult delivery 留给 R4。
- R3e slice 不修改 Desktop IPC trust、Companion transport、rollout、OAuth 门禁。
- R3 当时不做 rawSummary/machineEvidence 与 ExecutionResult/outbox delivery（R4）。R3a/R3b 派生 routes，
  R3c 创建 Command，R3d 提供 Desktop delivery adapter，R3e 接通现有 send tool；新 Chat
  reconnect/bootstrap UX 位于 Browser Companion，不创建第二套路由 authority 或持久 current/default route pointer。
  上述 slice 已由真实 live E2E 收官；各 slice 内更早的 pending 记录以 `development-plan.md` 的 R3 aggregate
  closeout 为准。

## R4 ExecutionResult outbox（R4a、R4b 完成；R4c 下一步）

- R1 的 `RoutingState.results[]` / `appendResult()` 原先只保存最小结果身份与状态。
  R4a 扩充为 bounded `rawSummary` + versioned `machineEvidence`：来源是显式 Codex final summary
  与本机 trusted Desktop receipt，包含 receipt 摘要、Command/task/iteration/status、accepted thread/turn/binding、
  changed files、tests summary 及可选 output metadata，不保存 output body。
  `(commandId, iteration)` exact replay 比较摘要及全部证据，漂移则 `RESULT_CONFLICT`。
- R4a 的 `execution-result-projector` 只读校验 Routing Command、executor route、唯一 accepted Desktop delivery、
  唯一 trusted receipt 与 output metadata 后产生 `ResultInput` 候选；它不调用 `appendResult()`，
  不创建 outbox entry，不触碰 Browser/feedback 或 Desktop send。旧 generic/历史 receipt 读取兼容，
  但缺显式 summary/provenance 的记录不能成为新 canonical machine evidence。
- R4a 与 R4b 均已完成并通过独立 review；trusted Desktop receipt → canonical RoutingResult → routing-owned durable Result Outbox 已接入本机生产收敛边界。R4c 的 outbox consumer 与 Browser delivery 迁移尚未接通。
- R4 将 canonical ExecutionResult 绑定原 Command，经其 `plannerRouteId` durable outbox 返回；复用 Codex
  自己的 final summary，不再让第二个 AI 重写结果。R4b 已接通 receipt-to-outbox 的生产生成路径；R4c
  尚未接通从新 outbox 到 Browser feedback consumer 的生产交付。
- R3 pairing / feedback 身份字段及状态机已由真实 live E2E 验收，应保持兼容。当前 feedback outbox 以
  `bindingId / epoch / principalFingerprint` 为接收者，状态为
  `queued → ready → reserved → claimed → observed / outcome_unknown / retired_unknown`；R4b 不修改此 schema
  或 lifecycle，R4c 再渐进迁移旧 Browser feedback delivery。
- `/state` 与 `/reserve` 当前调用 `reconcileFeedbackOutbox()`；R4a 保持现有调用。canonical Result 与新
  Result Outbox entry 不依赖 pull 才创建，也不调用这条 feedback reconciliation 路径。

### R4b routing-owned Result Outbox（已完成；不含 R4c consumer）

R4b 把 R4a projector 验证出的 `ResultInput` 先交给 Routing store，持久化 canonical RoutingResult；只有拿到
持久化结果后，才原子写入独立的 per-workspace Result Outbox：
`<stateDir>/routing/<workspaceId>.result-outbox.json`。Outbox 只存引用与摘要，不复制 result 内容：

```text
{
  version: 1,
  workspaceId,
  workspaceRoot,
  revision,
  entries: [{
    version: 1, outboxEntryId, workspaceId, plannerRouteId, commandId,
    resultId, executorRouteId, iteration, status, resultSha256,
    createdAt, deliveryStatus: "pending"
  }]
}
```

- `version` 必须精确为当前 schema 版本；未知版本、额外字段或缺字段均 fail closed。`workspaceId` 与 canonical
  `workspaceRoot` 必须和打开的 workspace identity 完全匹配；persisted `revision` 必须是正的安全整数，首次写入为 1，
  且每次真实 mutation 单调递增。outbox 主文件不存在时按空 outbox（瞬态 `revision: 0`）处理；已存在文件损坏、
  identity 不匹配或 revision 无效时保留原文件并 fail closed，不重置历史。
- 每条 entry 严格限定为上列字段；`outboxEntryId` 是对
  `[workspaceId, commandId, iteration]` 的确定性 SHA-256，entry digest 是规范 canonical RoutingResult 的 SHA-256。
  entry 必须解析到同一 workspace 中的
  canonical RoutingResult、其原 persisted Command 及该 Command 的 planner Route。`plannerRouteId` 只能复制自该
  persisted Command，不能从 current route、binding 或 Companion 重新推导。digest 绑定 entry 引用及 canonical
  Result 的完整 summary、machine evidence 与身份；重复语义键或摘要不匹配按损坏/冲突拒绝。
- entry 数量不超过 Routing `results` 的既有上限 10,000，字段长度与 UUID / digest 使用现有 schema 的严格约束；
  Outbox metadata 不包含 `rawSummary`、machine evidence、feedback 或任何 Browser / Companion 字段。
- Result Outbox 由 Routing 自己持有，使用独立单文件；在工作区锁内写临时文件、fsync 后原子 rename 发布。精确重放
  不增加 revision、不重写文件。不能把尚未提交的 Result 和 Outbox entry 合并成一次写入：Outbox entry 必须引用已持久化
  canonical Result。
- 若 Result 已提交但 Outbox 写入失败，不消费或清理原 trusted receipt；保留 canonical Result，并返回有界的
  `reconciliation-needed` 结果，并将 reason code 写入使用独立文件与写锁的 routing recovery queue：
  `<stateDir>/routing/<workspaceId>.result-reconciliation.json`。因此 Outbox 锁竞争不会阻止记录恢复项，队列有严格
  workspace identity、revision 与 10,000 项上限。`desktop result-reconciliation-status` 可只读发现待办；
  `desktop reconcile-result --command-id` 幂等重试并在收敛后清除对应恢复项。
  对应的 recovery intent 会在新的 canonical receipt/output 首次提交前先写入该独立队列；无法持久化 intent 时，
  不先写 output/receipt。`c2c record`、`desktop record-result` 与 detached safe-terminal receipt finalizer
  共用此提交前钩子，并在 receipt 成功后调用同一 reconciler。若此前置 intent 后未产生 receipt，reconciler
  会在 execution-record 锁内确认无 receipt、canonical Result 或 Outbox entry 后清除孤立 intent；后续 writer
  会在自己的 receipt 提交前重新发布。恢复命令只需历史 trusted receipt，不要求当前 Desktop binding。
  `appendResultWithReplay()` exact replay 取得原 result 后补齐缺少的 Outbox entry；原子 rename 前崩溃留下的 temp 不会被当作主状态，
  重试仍可收敛；原子发布后的 caller retry 返回原 entry，不重复生成 Result 或投递目标。
- 本切片不依赖 Browser、feedback state、current binding/state、`/state`、`/reserve` 或 Companion，也不修改 R3
  feedback schema、状态迁移或 transport。R4c 才消费新 planner-route Result Outbox，并渐进迁移旧 Browser feedback
  delivery；R4c 未在本切片实现。

## R5 Bridge lifecycle decoupling（规划中）

`rollout.ts` 的 `assessRolloutIdle()` 当前会因 Desktop busy、`approval_pending` 等阻断 rollout，并可能通过
self-turn `post-turn-finalizer` 延后执行。R5 的目标是让 Bridge lifecycle 完全脱离 conversation execution state；
该耦合是待处理债务。H0 / Claude E1a 属于独立 executor extensibility 支线，不是 R5。

## R3k Task delivery 与 Feedback return plane

- 运行时职责分离：任务投递入口是 `codex_desktop_send → deliverCurrentCommand() → sendDesktop()`；Browser Companion
  只负责当前 Chat owner/connect、feedback pair/takeover/rebind/route attestation，以及 RESERVED feedback
  的 reserve/release/回写与 ack。Browser 所称的 feedback delivery 是把 feedback 写回 ChatGPT，不是向 Codex
  下发开发任务。
- Browser Companion 的 Bridge URL builder 仅允许现有 `/api/companion/v1` feedback endpoints；`/rebind/status`
  只允许 canonical ChatGPT conversation route 与 UUID challengeId 两个固定 query 参数。源码架构测试同时禁止
  Browser task-delivery imports/calls，并禁止 Desktop MCP/transport 反向依赖 Browser runtime。
- 边界限定：Desktop task delivery 不检查 Browser 扩展是否在线或其实时健康；R3e 曾从持久
  feedback/Companion state 派生 planner authority，该限制已由 R3l 移除。

## R3l Task delivery planner authority

- Planner 仅从本次 MCP request 的官方 conversation principal 派生；缺少官方 `_meta["openai/session"]`
  时以 `ROUTING_PLANNER_IDENTITY_UNAVAILABLE` fail closed，不从参数、sessionId、Browser state 或历史 route 回退。
- 新 Command 只保存引用 request-scoped planner route；原始 MCP session 不持久化、不返回。Executor 只从
  当前 Desktop binding 投影，`current-executor-route.ts` 经 Desktop-only adapter 读取，不依赖 feedback/store。
- 既有 commandId replay 在 terminal fast path 或 Desktop durable delivery 同步前，也会核对原 planner route 属于本次
  request principal；主体不匹配时以 `COMMAND_CONFLICT` 拒绝，不写 routing 状态、不发送。
- Browser Companion / feedback 是 return plane；离线、无 binding 或 feedback state 缺失/损坏不阻断新 task
  delivery。旧 Companion-derived planner routes 保留作历史记录，不删除、不迁移、不覆盖。
