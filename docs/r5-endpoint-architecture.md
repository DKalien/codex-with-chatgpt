# R5 Endpoint Architecture

状态：**R5d1 foundation 已完成（shadow/backfill only）**（含 R5a contracts + R5b Active Executor Binding + R5c Active Web Sink Binding）。
R5d2 delivery lifecycle、R5d3 cutover 尚未开始。R4 persistence/wire 仍不迁移。

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

投递 lifecycle 冻结（R5d2 begin-send 目标契约，本阶段不实现迁移 API）：

```text
queued/reserved                          sendTarget === null
claimed/observed/outcome_unknown/retired_unknown
                                         sendTarget 必须保留 WebSinkSendTargetSnapshot
```

即 queued/reserved 均未冻结目的地；begin-send（reserved → claimed）是冻结边界，冻结后 target 不可消失或改指。
R5d2 才实现 Web Sink delivery lifecycle，R5d3 才评估 cutover 与旧 outbox drain。

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
