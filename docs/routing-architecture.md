# Routing Architecture（R1 — Project Route Foundation）

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
- R1 不设计 active/default route：Command 总是显式引用两条 route，基础模型已闭合；
  "哪个 planner route 是当前默认回流目标"留待 R3 一键绑定时定义，不提前造第二套
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
- 不生成 routeId、不写 routing store、不写任何旧 state；真正注册成 Route 是以后
  显式 migration/rebind 的事。

## R1 边界（明确不做）

- 无 transport：不实现 command 真实投递/执行通道，不接 executor adapter 调用。
- 无生产调用方：现有 Desktop send、feedback、Companion、rollout 零行为变化。
- 不修改 Desktop IPC trust、Companion transport、rollout、OAuth 门禁。
- 不做 active/default route（R3）、rawSummary/machineEvidence（R4）、一键绑定（R3）。
