# R5 Endpoint Architecture

状态：**R5d1/R5d2 已完成；R5d3 production canonical cutover 已实现（待 independent review / live deployment 证明）**（含 R5a contracts + R5b Active Executor Binding + R5c Active Web Sink Binding）。
R5e/R5f 尚未开始。R4 persistence/wire 不迁移、不删除；R4 Result Outbox 保留为兼容 shadow（可写/可读，用于回滚与审计），
但不再是 production canonical delivery 权威。

本文冻结 R5 目标架构概念、依赖边界与 migration 顺序。

---

## 1. 目标拓扑

```text
Web Planner  →  Bridge  →  Executor Binding
                     ↓
              Result Bus（R5d1 shadow）
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
- route/frozen 边界：reserve 请求 route === 当前 Active Sink；begin-send 请求 route ===
  reservation 目标（stamp 匹配时即当前 Sink；已切换则交由 core stale-requeue）；ack/retire
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
| **R5d** | workspace result bus，解除 plannerRoute-pinned result delivery |
| **R5e** | dynamic executor / web sink switching |
| **R5f** | Bridge lifecycle independence + retire core post-turn-finalizer |
| **R5g** | cross-plugin live E2E |

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
- R4 persistence/wire **尚未迁移**（R5d 起才动 Result Bus）。
- R5c 后 routing/feedback/outbox 仍走 plannerRoute-pinned R4 路径。

---

## 11. 测试与门禁

- `tests/r5-endpoint-core.test.ts` / `tests/r5-endpoint-architecture.test.ts`
- `tests/r5-executor-*.test.ts` / `tests/r5b-architecture.test.ts`
- `tests/r5-web-sink-*.test.ts` / `tests/r5c-architecture.test.ts`
- 既有 `tests/routing*.ts`、`tests/execution-result-*.ts`、`tests/architecture-separation.test.ts`、`tests/r45f-architecture.test.ts` 必须继续通过
