# R5 Endpoint Architecture

状态：**R5a foundation contracts**（不切生产行为）。

本文冻结 R5 目标架构概念、依赖边界与 migration 顺序。R4 persistence/wire 本轮不迁移。

---

## 1. 目标拓扑

```text
Web Planner  →  Bridge  →  Executor Binding
                     ↓
              Result Bus（future）
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

继续沿用 R4 canonical ExecutionResult wire/persistence（本轮不改）。
R5d 起，result 投递目标从「plannerRoute-pinned」迁移到 Workspace Result Bus。

### 2.5 Workspace Result Bus（future / R5d）

- queued result 跟随 **当前** Web Sink
- send attempt 一旦 `begin-send`，target URL/epoch 固定
- `outcome_unknown` **禁止**自动改发新 URL

本轮只建立合同，不实现 Bus，不切换 R4 Result Outbox。

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

本轮 **不修改** Browser Companion 实现与 live 行为。

未来拆分：

| 层 | 职责 |
|----|------|
| Browser Companion Core | exact URL binding、binding epoch、durable journal、reserve、begin-send、observation、ack、single-flight |
| Surface Plugin | DOM 差异（ChatGPTSurfacePlugin / ClaudeSurfacePlugin / …） |

Generic contract 中 **禁止**：DOM selector、principalFingerprint、feedback credential、planner route。

---

## 6. R4 保持原样（本轮）

以下 **不修改**：

- `src/routing/schema.ts`：`routingPlatformSchema`、`RoutingRole`、`Command.plannerRouteId`、`Command.executorRouteId`
- trusted receipt → canonical ExecutionResult → plannerRoute Result Outbox → feedback path
- feedback persisted schema
- ExecutionResult wire/persistence
- Browser Companion live 行为
- 现有 MCP tool schema
- routing/feedback persisted schema version

R5a 只是建立下一阶段可迁入的新 core contracts。

---

## 7. Migration 顺序

| 阶段 | 内容 |
|------|------|
| **R5a** | endpoint contracts（本轮） |
| **R5b** | generic executor binding + generic MCP executor tools |
| **R5c** | Browser Web Sink URL binding |
| **R5d** | workspace result bus，解除 plannerRoute-pinned result delivery |
| **R5e** | dynamic executor / web sink switching |
| **R5f** | Bridge lifecycle independence + retire core post-turn-finalizer |
| **R5g** | cross-plugin live E2E |

---

## 8. 当前生产能力边界

- ChatGPT Web 仍是**唯一 production Web Surface**。架构允许未来 surface plugin，本阶段不实现其他 AI 网页。
- Codex Desktop 仍是**唯一 production Executor plugin**。
- Claude Code **不在**本轮进入 production registry。
- R4 persistence/wire **本轮不迁移**。
- 本阶段 **不切生产行为**：routing/feedback/outbox 流程保持不变。

---

## 9. 测试与门禁

- `tests/r5-endpoint-core.test.ts`：schema/registry/projection/capability
- `tests/r5-endpoint-architecture.test.ts`：依赖围栏与禁止字段
- 既有 `tests/routing*.ts`、`tests/execution-result-*.ts`、`tests/architecture-separation.test.ts`、`tests/r45f-architecture.test.ts` 必须继续通过
