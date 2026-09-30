---
name: C2C Routing R1 Foundation
overview: 按批准的修订版执行：R0 分两步归档旧实验（tracked 整体 stash、provenance 未跟踪文件单独 stash、.lingxi/ 不碰），恢复 bc65014 无 tracked dirty 基线。R1 只做 src/routing 的 schema/store/legacy projection + 架构文档 + 测试：platform 端点语义枚举、locator 判别且不参与 identity、route 注册幂等、command 只描述投递且创建入口封死 pending、result 带 iteration 幂等、store 以 workspace identity 对象核对、legacy 只产出候选。不接任何生产调用方；完成后不 commit，未提交 diff 交 ChatGPT 独立 review。
todos:
  - id: archive-experiment
    content: R0：tracked 改动整体 stash；两个 provenance 未跟踪文件单独 stash；.lingxi/ 不碰；核对 HEAD=bc65014 且无 tracked dirty
    status: completed
  - id: routing-schema
    content: 新建 src/routing/schema.ts：platform 端点枚举 + discriminated locator + 平台专项 conversationId 校验 + command(创建封死 pending)/result(iteration 幂等) schema + 角色校验
    status: completed
  - id: routing-store
    content: 新建 src/routing/store.ts：durable store + route 幂等注册 + command 严格幂等 + appendResult 幂等(RESULT_CONFLICT) + Pick<Workspace,'id'|'root'> 每次核对
    status: completed
  - id: legacy-adapter
    content: 新建 src/routing/legacy-adapter.ts：只读 legacy projection，产出 LegacyRouteCandidate，verified 才投影 planner candidate，不写任何 state
    status: completed
  - id: routing-docs
    content: 新建 docs/routing-architecture.md：术语、threat model（安全边界句 + 引用标识句）、数据流、R1 边界
    status: completed
  - id: routing-tests
    content: 新增 tests/routing-*.test.ts：20 项（基础八 + 修订八 + 约束验收四）
    status: completed
  - id: verify-review
    content: typecheck/build/定向测试/diff-check；不 commit，未提交 diff 交 ChatGPT 独立 review
    status: completed
  - id: fix-routing-tests
    content: 修复 tests/routing.test.ts 结构损坏（重写 durable store describe 区块，测试改走公开 API）
    status: completed
  - id: verify-final
    content: 重跑 routing tests + typecheck + git diff --check
    status: completed
  - id: report-review
    content: 报告未提交 diff 就绪，等待 ChatGPT 批准 R1 commit
    status: completed
---

# C2C Routing R1 — Project Route Foundation（最终版）

## 已核对的现状事实

- 基线：main @ `bc65014`（IPC v2 诊断指纹）。ChatGPT 侧 Connector 现场核对失败，以本会话早前只读核对的基线与工作区漂移记录为准：17 个 tracked 修改 + `.lingxi/` + 2 个 provenance 未跟踪文件；执行时开工前再只读核对一次，不依赖历史计数。
- `.lingxi/` 不在已确认的实验集合内，R0 不碰、不入任何 stash、不入 R1 产物。

## R0 — 安全归档旧实验（两步，不吞 .lingxi/）

1. tracked 整体留档：`git stash push -m "pre-R1 archive: tracked attestation/provenance experiment"`（不带 -u，只收 tracked 修改）。
2. provenance 未跟踪文件单独留档：`git stash push -u -m "pre-R1 archive: provenance untracked files" -- src/desktop/helper/desktop_provenance.py tests/desktop_provenance_test.py`（pathspec 限定）。
3. 验收：`HEAD=bc65014`、无 tracked dirty、两个 provenance 文件已归档；不强求 `git status` 完全空白（允许 `.lingxi/` 残留）。
4. R1 全程不 pop、不 reset、不触碰 stash 条目。

## R1 范围

只做 `src/routing/schema.ts` + `src/routing/store.ts` + `src/routing/legacy-adapter.ts` + `docs/routing-architecture.md` + routing tests。**不接任何生产调用方**。

## src/routing/schema.ts — Route 身份模型

- 核心身份：`workspace + platform + conversationId`。
- `platform` 为端点/执行平台枚举（非 OS、非产品类别）：初始 `chatgpt_web`、`codex_desktop`；未来 `codex_cloud`、`claude_code`、`mimo_desktop`。strict 拒绝未知值。
- Route 为 discriminated locator 结构：

  ```text
  Route
    routeId
    role            // planner | executor，注册后不可变
    platform
    conversationId
    locator         // 按 platform 判别，不参与 identity
    createdAt
    updatedAt
  ```

  - `chatgpt_web`: `locator = { gptId? }`；`codex_desktop`: `locator = { hostId: "local", executorProjectId }`。
  - locator 不参与 identity；唯一键只有 `(platform, conversationId)`；不设公共 `projectId` 字段。
- `conversationId` 平台专项校验：`chatgpt_web` 用现有 legacy 字符集 `[A-Za-z0-9_-]{1,128}`；`codex_desktop` 用 UUID；未来平台各自新增 validator。

### Route 注册幂等

同 `(platform, conversationId)` 再次注册：role、locator 完全一致 → 返回既有 route；role 不同 → `ROUTE_ROLE_CONFLICT`；locator 不允许静默漂移 → `ROUTE_LOCATOR_CONFLICT`。

## src/routing/schema.ts — Command 与 ExecutionResult

### Command 只描述投递

- `deliveryStatus`: `pending | accepted | rejected | outcome_unknown`；`completed/failed/blocked` 属于 ExecutionResult。**发送结果不明 ≠ 执行失败**。
- Command 不放 `projectId`；最小字段：`commandId`、`plannerRouteId`、`executorRouteId`、`intent`、`payloadBytes`、`payloadSha256`、`deliveryStatus`、`createdAt`、`updatedAt`。R1 不保存正文。

### commandId 幂等（对齐 Desktop replay 严格性）

- 同 commandId + 完全相同 routes / intent / digest / bytes → 返回旧记录；任一字段不同 → `COMMAND_CONFLICT`。

### 创建入口封死（新增约束 1）

- `createCommand()` **不接受调用方指定初始 deliveryStatus**；创建 API 统一产生 `pending`。`accepted/rejected/outcome_unknown` 只能由未来 transport 阶段的明确状态转换 API 写入。R1 不接 transport，但先把入口封死，杜绝直接创建"accepted command"。

### ExecutionResult 独立建模 + 幂等（新增约束 2）

- 字段：`resultId`、`commandId`、`executorRouteId`、`iteration`、`status: ok | failed | blocked`、`createdAt`、`updatedAt`。
- 允许一个 command 多个 iteration result；`(commandId, iteration)` 唯一。
- `appendResult()` 幂等语义：
  - 同 commandId + iteration + executorRouteId + status 完全一致 → 返回既有 result；
  - 同 `(commandId, iteration)` 但内容不同 → `RESULT_CONFLICT`；
  - 不因每次生成新 `resultId` 让同一 execution receipt 重放成两条结果。
- `resultId` 保留为引用 ID，**不承担幂等身份**。
- `rawSummary + machineEvidence` 留 R4 扩展。

## src/routing/store.ts — durable store

- 对齐 desktop store 范式：`wx` 文件锁 + `ROUTING_STORE_BUSY`、tmp+rename+fsync、revision 单调、`.initialized` 标记、损坏抛 `ROUTING_STATE_CORRUPT`（保留文件、不重置、人工核对）。
- 存储：per-workspace 单文件 `getStateDir()/routing/<workspaceId>.json`。
- **workspace identity 对象（新增约束 3）**：store API 接收 `Pick<Workspace, "id" | "root">`，不收两个彼此独立的裸字符串；每次 read/update 都用它核对 state 的 `workspaceId/workspaceRoot`，任一不匹配 fail closed。持久化格式不变。
- `workspaceRoot` 要求绝对路径。
- stateSchema 结构约束：routeId/commandId/resultId 各自唯一；`(platform, conversationId)` 唯一；`command.plannerRouteId` → role === planner；`command.executorRouteId` → role === executor；`result.executorRouteId` 与 `command.executorRouteId` 完全一致；所有引用必须解析到本 state 内 route。
- **R1 不设计 active route**：无 `active/superseded/defaultRouteId`；"当前默认回流目标"留 R3。

## src/routing/legacy-adapter.ts — legacy projection

- 只读读取现有 desktop-control / feedback state，返回 `LegacyRouteCandidate`；**不生成 routeId、不写 routing store、不写任何旧 state**。注册成 Route 是以后显式 migration/rebind 的事。
- Desktop binding → executor candidate：`platform=codex_desktop`、`conversationId=threadId`、`locator.hostId`、`locator.executorProjectId`、`legacyReferenceId=bindingId`（bindingId 仅为引用 ID，不承担真实身份）。
- 旧 feedback：仅当 Companion **route attestation 已 VERIFIED** 时，才从 `routeCanonical` 提取 `chatgpt_web` planner candidate；无 verified route → `planner candidate = none`。绝不因文件里有个 URL 就升级成可信 planner route。
- 多次调用结果确定（无随机 identity）；不参与生产发送/回流、不改 Desktop IPC trust、不改 Companion transport、不碰 rollout。

## docs/routing-architecture.md

- 术语：route / Project / Command / ExecutionResult / locator / legacyReferenceId。
- Threat model 开篇边界句：

  > C2C 不试图防御具有当前用户本机执行权限的恶意进程。C2C 的安全边界是防止跨 workspace / platform / conversation 的错误路由、command 重放、重复 mutation、错误 result 归属以及损坏状态被静默接受。

- 引用标识句（新增）：

  > `routeId`、`bindingId`、`resultId` 都是内部引用标识；能够决定跨进程路由归属的是 workspace-scoped semantic identity，而不是这些随机 UUID。

- 未来数据流：`Planner route → Project → Command → Executor route → ExecutionResult → Planner route`。
- R1 边界声明：无 transport、无生产调用方、无 Desktop IPC 改动、无 rollout、生产行为零变化。

## 测试（tests/routing-*.test.ts，C2C_STATE_DIR 隔离）

基础八项：

1. route identity 唯一性（同 identity 二次注册走幂等路径，返回同一 route）；
2. 同 conversationId 不同 platform 不冲突；
3. 同 Project 多 route（多个 executor route 挂同一 locator.executorProjectId）；
4. 跨 workspace 不串线（状态互不可见、引用不可解析）；
5. commandId 幂等：完全相同字段重放返回旧记录；
6. result 必须引用真实 command 且 executorRouteId 一致；
7. 损坏状态 fail closed：篡改 JSON → `ROUTING_STATE_CORRUPT`，不自动重置；
8. legacy projection 只读：旧 store 文件内容与 mtime 不变。

修订新增八项：

9. exact route 重复注册幂等（role+locator 全同返回既有）；
10. 相同 identity 不同 role → `ROUTE_ROLE_CONFLICT`；
11. locator 漂移 → `ROUTE_LOCATOR_CONFLICT`；
12. commandId 相同但 payload/routes 不同 → `COMMAND_CONFLICT`；
13. planner/executor route 角色放反 → schema 拒绝；
14. unverified legacy Companion 不生成 planner candidate；
15. verified route 才投影 planner candidate；
16. legacy adapter 多次调用不产生随机 identity、不写任何旧/新 state。

最终新增四项（约束验收）：

17. command 创建无法伪造非 pending 初始状态（API 无该入口，schema 层同样拒绝）；
18. result exact replay 幂等（同 commandId+iteration+executorRouteId+status 返回既有）；
19. 同 `(commandId, iteration)` 不同 status/executor → `RESULT_CONFLICT`；
20. workspace id/root 任一不匹配 → fail closed。

## 验证与交付（完成标准）

- `pnpm run typecheck`、`pnpm run build`、routing tests（20 项）、desktop/feedback 定向回归、`git diff --check`。
- 完成状态：`bc65014 + 新增 routing foundation`；原 Desktop send、feedback、Companion、rollout 全部零行为变化。做到即停，不进入 R2。
- **不 commit**：把未提交 diff 交回 ChatGPT 独立 review，review 通过后另行提交。
- 执行方式：不由 Connector 自动送 Desktop（当前通道 `DESKTOP_VERSION_UNSUPPORTED`）；在 IDE/Codex 侧执行。

## 非目标

- 不实现 command 真实投递/执行通道，不接 executor adapter 调用，不接任何生产调用方。
- 不修改 Desktop IPC trust、Companion transport、rollout、OAuth 门禁；不改变现有生产发送与回流行为。
- 不做 active/default route（R3）、rawSummary/machineEvidence（R4）、一键绑定（R3）。
- 实验代码不入库；`.lingxi/` 不碰。

## 风险

- R0 两步 stash 未来恢复时需按序 pop 两个条目；R1 只新增文件，冲突面极小。
- platform 枚举扩展需同步新增 conversationId validator 与 locator 分支；strict 模式下旧状态不受影响。
- legacy projection 对 VERIFIED 的判定依赖现有 feedback attestation 状态读取；旧 state 结构变化时 candidate 产出为 none（fail closed），不猜测。
