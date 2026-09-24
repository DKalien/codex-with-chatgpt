# Routing Architecture（R1 foundation + R3 derived routes）

Routing 是 C2C 的新语义身份层：以 workspace-scoped semantic identity 描述
"哪个对话在哪个平台上扮演什么角色"，并把 Command / ExecutionResult 建模为
可持久化、可重放、可审计的记录。R1 只建立模型与 durable store，不接任何
生产调用方。

## 术语

| 术语 | 含义 |
| --- | --- |
| Route | 一个跨平台会话身份。核心身份是 `workspace + platform + conversationId`；`role`（planner / executor）是注册后不可变的属性。 |
| platform | 端点/执行平台，不是 OS，也不是模糊产品类别。R1 初始值：`chatgpt_web`、`codex_desktop`；未来按需扩展 `codex_cloud`、`claude_code`、`mimo_desktop`。 |
| conversationId | 平台专项校验的会话标识。`chatgpt_web` 沿用现有 ChatGPT legacy 字符集 `[A-Za-z0-9_-]{1,128}`（保持平台原样字符串语义，不强行 lowercase）；`codex_desktop` 用 UUID，注册时 canonical 化为 lowercase，大小写变体不形成两个 identity。未来平台各自新增 validator，不允许把整段 URL 塞进 conversationId。 |
| locator | 平台定位信息，按 platform 判别（discriminated union），**不参与 route identity**。`chatgpt_web`: `{ gptId? }`；`codex_desktop`: `{ hostId: "local", executorProjectId }`。 |
| Project | 一个 workspace 内的业务项目容器。一个 Project 可挂多个 route（例如多个 executor route 挂同一 `locator.executorProjectId`）。 |
| Command | 一次投递描述。`deliveryStatus` 只有 `pending / accepted / rejected / outcome_unknown`；**发送结果不明 ≠ 执行失败**。 |
| ExecutionResult | 一次执行结果。`status` 为 `ok / failed / blocked`；允许一个 command 多个 iteration result，`(commandId, iteration)` 唯一。 |
| legacyReferenceId | legacy projection 产出的引用 ID（desktop `bindingId`、companion `bindingId`）。**仅为引用 ID，不承担真实身份。** |

> `routeId`、`bindingId`、`resultId` 都是内部引用标识；能够决定跨进程路由归属的是
> workspace-scoped semantic identity，而不是这些随机 UUID。

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
- Routing store 不保存 active/default route 指针。当前 planner route 从现有 VERIFIED Browser
  Companion authority 派生；当前 executor route 从现有 Desktop binding target 派生，避免第二个
  binding 状态机。

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
`LegacyRouteCandidate`：

- Desktop binding → executor candidate（`platform=codex_desktop`、
  `conversationId=threadId`、`locator.hostId/executorProjectId`、
  `legacyReferenceId=bindingId`）。
- 旧 feedback → planner candidate，仅当 Companion route attestation 已 VERIFIED；
  否则 `planner candidate = none`。
- projection 本身不生成 routeId、不写 routing store 或任何旧 state；R3a 的独立显式 ensure
  才会按当前 VERIFIED candidate 注册 Route，不代表旧 state migration 或 rebind。

## R3a 当前 planner route（基础层，未接生产调用方）

- `src/routing/current-planner-route.ts` 复用 `projectLegacyRoutes()` 的 Companion attestation
  authority；没有 VERIFIED 候选时 current planner route 为 `none`，即使 store 中留有历史 planner
  route 也不会因“最新”而自动成为 current。
- 只读解析仅按候选的精确 `(platform=chatgpt_web, conversationId)` 查找已注册 route；role 必须为
  `planner`，locator 必须与候选完全一致，否则使用 `ROUTE_ROLE_CONFLICT` 或
  `ROUTE_LOCATOR_CONFLICT` fail closed。身份与 routing-state 损坏仍沿用现有 workspace/store 错误。
- 显式 `ensureCurrentPlannerRoute()` 先调用现有 `registerRoute()`，再重新读取并核对 VERIFIED
  Companion authority；若当前候选已不再解析到刚注册的 route，则抛 `ROUTE_AUTHORITY_CHANGED`，
  旧 route 可留在 catalog/history，但调用方不得当作 current 使用。exact replay 仍不 bump revision、
  不重写 routing state。该 helper 不写 feedback/Companion state。
- 当前 route 是每次从已验证 Companion authority 推导的结果，不是新的持久指针；旧 routing route
  仍作为 catalog/history 保存。此 R3a 仅为 routing foundation，不接 Desktop send、feedback send、
  route-confirm MCP 或 Browser Companion，也不代表一键绑定/重连 UX 已完成。
- ensure 返回值只是最终 recheck 时点的快照，不是 lease；后续 R3b 必须在实际副作用边界重新解析，
  不能跨 `await` 或进程边界把返回 route 当作持续有效的 authority。

## R3b 当前 executor route（基础层，未接生产调用方）

- `src/routing/current-executor-route.ts` 复用 `projectLegacyRoutes()` 的 Desktop binding candidate；
  route identity 表达当前绑定的 thread/project target，不包含 enabled、availability 或 busy 状态。
- 只读解析精确匹配已注册的 `codex_desktop` executor route；显式 ensure 复用 `registerRoute()`，
  exact replay 不改 revision/文件，并在注册后重读 binding。若 binding 在 ensure 期间变化则抛
  `ROUTE_AUTHORITY_CHANGED`；旧 route 可留作 catalog/history，但不作为 current 返回。
- helper 只读 Desktop state，不代表 Desktop 可发送或已空闲；返回值是时点快照而非 lease。此 slice
  不接 Desktop send、feedback、Companion 或 MCP，也不新增持久 current/default pointer。

## R3c 当前 Command adapter（基础层，未接 transport）

- `src/routing/current-command.ts` 显式 ensure 当前 planner 与 executor route；缺少任一当前 authority
  时抛 `ROUTING_ROUTE_NOT_FOUND`，不从历史 route 推断。它以原始 payload 的 UTF-8 byte length 和
  SHA-256 调用现有 `createCommand()`，由 routing store 负责 pending 状态与 commandId 幂等/冲突语义。
- 创建前同步 re-resolve 两条 route 以减少明显 stale；这仍只是时点检查，不是 transport lease。任何
  未来发送边界必须重新解析当前 authority。该 adapter 只写 routing store，不调用 send、不写 Desktop/
  feedback/Companion，也不接 MCP。

## R3d Command → Desktop delivery adapter

- `src/routing/current-command-transport.ts` 复用 `createCurrentCommand()`；投递前同步重新解析
  当前 VERIFIED planner 与 Desktop binding executor，并把与 digest/bytes 完全相同的原始 payload
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
- 新 Command 还要求当前 Companion planner route 已 VERIFIED；缺少 authority 时 routing 错误原样返回，发送不进入 IPC。
- 仅 `codex_desktop_send` 接入；不接 feedback / ExecutionResult。Browser Companion 重连 UX 由独立 R3f
  提供，不改变本 slice 的 routing/send 边界。

## R2 状态（2026-09-24）

R2（Desktop Behavioral Adapter）已把 Desktop 生产信任路径切换为 live 行为证明：
Desktop 是否可用由当前进程/owner/project/workspace 核验与发送后 canonical turn 证明决定，
版本/app-server hash/ASAR/catalog/semantic fingerprint 预登记体系整体删除。
R3e 将现有 `codex_desktop_send` 接到 R3d adapter；底层仍复用原 Desktop behavioral send 路径，
不改变 `sendDesktop()` 的信任边界。

## R1/R3 边界（明确不做）

- R3e 仅把现有 `codex_desktop_send` 接入 R3d adapter；`codex_desktop_status`、feedback、Companion、rollout
  wiring 不变，不新增 MCP tool。
- 不做 feedback/ExecutionResult 回流或 executor 执行通道。
- 不修改 Desktop IPC trust、Companion transport、rollout、OAuth 门禁。
- 不做 rawSummary/machineEvidence（R4）。R3a/R3b 派生 routes，R3c 创建 Command，R3d 提供 Desktop
  delivery adapter，R3e 接通现有 send tool；R3f 的一键重连 UX 位于 Browser Companion，不创建第二套路由
  authority 或持久 current/default route pointer。
