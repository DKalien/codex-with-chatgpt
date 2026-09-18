# Phase F1b Companion Resilience Hardening

日期：2026-09-18。基线：`main@44075ea`（F1a operational readiness health 已合入）。

本阶段目标不是新功能，而是**系统证明**：Browser Companion 在 SW 重启、页面 reload、网络中断、auth stale、durable journal 恢复等真实故障下仍保持 **exactly-once / fail-closed**。

自动化入口：`tests/f1-companion-resilience.test.ts`（43 cases）。既有覆盖仍在 `tests/e1b3d3b2-autonomy.test.ts`、`tests/e1b3d3b-production-send.test.ts`、`tests/e1b3-send-orchestration.test.ts`、`tests/e1b3-send-journal.test.ts`、`tests/e1b2-transport.test.ts`；本文件矩阵优先复用，不复制大型 fixture。

## Exactly-once / fail-closed invariants

1. Autonomy 默认 **OFF**；shadow 只读；armed 仅在 exact-owner heartbeat + identity 匹配后调度。
2. **Journal-first**：任何 durable journal ≠ `NONE` 时只 recovery，不 reserve。
3. **One event per tick**：recovery/clear 后同 tick 绝不 reserve 下一条。
4. **RESERVED continuation**：同一 `eventId/reservationId` 续跑；cooldown 不阻塞 continuation；禁止二次 reserve。
5. **COMPOSER_WRITE_INTENT 之后 never rewrite**；**SEND_DISPATCH_INTENT 之后 never re-click**。
6. **OUTCOME_UNKNOWN never resend**：仅 exact server identity + exact canonical visible user turn 可 late-positive → `OBSERVED_PENDING_ACK → ACK → NONE`。
7. **OBSERVED_PENDING_ACK**：允许 retry ACK；若 authenticated `/state` 已给出 exact observed + `inFlight=null`，则 **SW-only local clear**（zero DOM / ACK / Send / CS）。这是 server fact 驱动的 durable closeout，不是新的 ACK 能力。
8. **Unknown / corrupt journal**：health 为 `blocked_gate` / `journal_state_unknown`；绝不显示 ready；production start 与 mutation 为零。
9. **Retire manual-only**；diagnostics bounded + allowlisted；health **不是**授权输入。
10. Durable cooldown（`lastProductionAttemptAt`）SW restart 后仍有效；同窗口不能消费第二个 ready event。

## Server-observed SW-only closeout（F1b review fix）

解决：**ACK 已在 server 成功，但 ACK response 或本地 journal clear 因 crash/restart 丢失**后的 restart closeout。

| 项 | 契约 |
| --- | --- |
| Eligible durable states | `OUTCOME_UNKNOWN`、`OBSERVED_PENDING_ACK`（`SERVER_OBSERVED_CLOSEOUT_STATES` / `isServerObservedCloseoutEligible`） |
| 证明来源 | authenticated `/state` body 中的 events（仅 `status === "observed"`） |
| Identity | exact `eventId` + exact `attemptId`；0 match fail closed；>1 match ambiguous fail closed |
| 附加条件 | `inFlight === null`；local journal 必须含 `eventId` + `attemptId` |
| 成功动作 | local journal → `NONE`；action=`server_observed_clear` |
| 零副作用 | write=0 / click=0 / beginSend=0 / ACK RPC=0 / CS RPC=0 / reserve=0 / release=0 |
| 非 eligible state | fail closed（`journal_not_closeout_eligible`） |
| persist failure | restore previous journal；不伪报 recovered；仍零 mutation |
| owner 依赖 | closeout decision **不需要** owner / document / content script；branch 在 `recoverProductionSendSide` 之前 |

## Resilience matrix 与自动化覆盖

| # | 场景 | 自动化覆盖 | 实现是否已满足 | 尚需 live 验收 |
| --- | --- | --- | --- | --- |
| 1 | SW restart / hydrate：policy + cooldown + journal 仍有效；RESERVED 同 reservation | F1b 1 + autonomy hydrate/cooldown 既有测试 | 是 | SW chrome.storage 真实重启 |
| 2 | SEND_INTENT crash：no inFlight → safe clear；exact claimed → adopt；reserved → retry；mismatch fail closed；无二次 reserve | F1b 2 + production-send / orchestration 既有测试 | 是 | Bridge 真实 /state + crash 后 recover |
| 3 | Post-mutation fence：WRITE/DISPATCH 重启 write=0 click=0 beginSend=0，仅 observation/ACK-safe | F1b 3 + production-send 既有 recovery | 是 | 真实 DOM observe-only |
| 4 | **OBSERVED_PENDING_ACK：retry ACK；若 authenticated /state 已给出 exact observed + inFlight=null，则 SW-only local clear，zero DOM/ACK/Send** | F1b 4 + production-send server-observed table（含 OBSERVED_PENDING_ACK） | **是（本轮修复）** | live ACK 已成功后 crash-restart closeout（禁止对历史 event 重放） |
| 5 | OUTCOME_UNKNOWN：zero resend/write/click/beginSend；mismatch block；exact server closeout / late-positive | F1b 5 + production-send late-positive A–J + server-observed | 是 | 不对历史 event 做 live 操作 |
| 6 | Tab reload / owner loss：同 tabId ≠ 同 document；waiting_owner / fail closed；需新 exact owner heartbeat；OBSERVED_PENDING_ACK server closeout 不依赖 owner | F1b 6 + F1b 4 owner-loss contract + SW `isExactOwnerHeartbeat` | 是 | 真实 ChatGPT reload + heartbeat |
| 7 | SPA route / conversation drift：binding/route/epoch 任一变化 armed 失效或 fail closed | F1b 7 + autonomy identity + route_drift 既有测试 | 是 | 跨 conversation 切换 live |
| 8 | Bridge temporary offline：journal 不丢；恢复后只做 journal 允许 continuation；OUTCOME_UNKNOWN 仍不 resend | F1b 8 + SW `!stateRes.ok return` 契约 | 是 | 断网/恢复 live |
| 9 | authStale：health `auth_stale`；禁止新 reserve/send；active journal 不被 re-pair 绕过 | F1b 9 + e1b2 re-pair gate | 是 | stale credential live re-pair |
| 10 | Durable cooldown：restart 后仍挡第二 ready；不挡 RESERVED continuation | F1b 10 + autonomy F/E | 是 | armed 多 event live |
| 11 | Corrupt / unknown durable state：fail closed；health blocked；零 mutation | F1b 11 + shape validator / health | 是 | 注入损坏 journal 的受控 live 检查（禁止自动恢复） |

## 本阶段缺口结论

- **首轮审计未发现** production send path mutation 缺口。
- **Independent review 确认一个 liveness / resilience gap**：文档与 matrix 声称 `OBSERVED_PENDING_ACK` 支持 exact server-observed closeout，但 helper/SW 仅允许 `OUTCOME_UNKNOWN`，导致 ACK 已在 server 成功、response/local clear 因 crash 丢失时本地 journal 可能不必要卡住（尤其 owner 未恢复时）。
- **本轮已修复**（最小、安全扩展）：
  - `browser-companion/production-send.js`：`SERVER_OBSERVED_CLOSEOUT_STATES` + `isServerObservedCloseoutEligible`；`findExactObservedEvent` / `evaluateServerObservedCloseout` 对两个 eligible state 放行，identity proof 不放宽。
  - `browser-companion/service-worker.js`：`handleRecover` server-observed branch 使用 `isServerObservedCloseoutEligible(journal) && closeout.ok`，仍在 `recoverProductionSendSide` 之前；rollback 语义不变。
- 其他矩阵项仍满足 exactly-once / fail-closed：
  - `recoverSendOrchestration` / `recoverProductionSend`：SEND_INTENT 三分支、post-mutation fence、late-positive exact identity。
  - `planAutonomyTick`：journal-first、cooldown 不挡 RESERVED、identity drift gate。
  - `operationalHealthSummary`：journal recovery / auth_stale / waiting_owner / unknown → blocked_gate。
  - `evaluateAutonomyGates`：`evidence.documentId !== owner.documentId` → `evidence_document_mismatch`。
  - `pairAllowedWithJournal`：active journal 仅在 `authStale` 时允许显式 re-pair；healthy journal 阻止 pair。
- SW hydrate 对未知 `journal.state` 不自动清空（保全故障证据）；health 与 production gates 共同保证 **不 ready、不 mutation**。
- 纯 planner 对 owner/evidence 一致的错误 document 不替代 SW session owner：执行前 SW 必须 `isExactOwnerHeartbeat`。

## 故障状态 ↔ operator health 表现

| 故障 / durable 状态 | health.state | health.reason（allowlisted） | 生产含义 |
| --- | --- | --- | --- |
| journal `OUTCOME_UNKNOWN` | `journal_recovery` | `recovery_required` | 绝不自动 resend；仅 exact late-positive / server closeout |
| journal `OBSERVED_PENDING_ACK` | `journal_recovery` | `recovery_required` | retry ACK；或 exact server-observed SW-only clear |
| journal RESERVED / CLAIMED / post-mutation | `journal_recovery` | `journal_active` | journal-first recovery / continuation |
| journal unknown / corrupt | `blocked_gate` | `journal_state_unknown` | fail closed；非 ready |
| transport `authStale` | `auth_stale` | `auth_stale` | 禁止新 reserve/send |
| owner/document 失效 | `waiting_owner` | `owner_unavailable` | 等 exact owner heartbeat（server closeout 仍可清 eligible journal） |
| cooldown 窗口 + journal NONE | `cooldown` | `production_cooldown` | 不发第二条 ready event |
| autonomy OFF + journal NONE | `off` | — | 默认安全 |
| 门禁失败（storage/transport/identity/heartbeat/in-flight） | `blocked_gate` | 对应 allowlisted reason | 不生产发送 |

## 本轮 F1b 交付边界

已做：

- resilience audit
- Independent review 修复：`OBSERVED_PENDING_ACK` exact server-observed SW-only closeout
- 新增/修正 `tests/f1-companion-resilience.test.ts`（true OBSERVED_PENDING_ACK coverage）
- 扩展 `tests/e1b3d3b-production-send.test.ts` server-observed table / rollback / SW contract
- 文档：`docs/phase-f1-operational-hardening.md`
- `docs/development-plan.md` 仅保留阶段摘要并指向本文档

F1b 已通过 independent review 并合入：

- commit：`90abcfe` `test(companion): harden production recovery resilience`
- `main == origin/main`
- 文档 case 数 P3 修正为 **43 cases** 后提交

F1b 合入时明确未做：

- rollout / Reload extension
- 创建真实 production feedback event
- Reserve / begin-send / ACK / Recover / Retire
- 操作历史 event（含 `e600aed6ef94…` 与 final acceptance `2c6b1d23641f46c4…`）

## F1c live resilience acceptance

日期：2026-09-18。基线：clean `main@90abcfe`。
目标：对自动化已证明的 resilience contract 做最小真实环境验收；不重做 happy-path production feedback。

### Live preconditions（只读观测）

| 项 | 结果 |
| --- | --- |
| Bridge | running（workspace `2582910bf0d2` / `codex-with-chatgpt`） |
| runtimeUpgrade | `state=current`，`upgradePending=false` |
| pairingActive | **false**（Browser Companion 当前未与 Bridge 建立 live pairing） |
| controller / remoteControl | offline / false |
| 本轮操作 | 只读 `c2c status` / machine state；**未** rollout、Reload、Reserve、begin-send、ACK、Recover、Retire |
| 历史 event | 全部保持原状态；**未** Send / Reserve / Recover / ACK / Retire |
| 新 production feedback event | **未创建** |
| Browser Companion 扩展控制面 | 本会话不可控（无法安全执行页面 Reload / SW restart 注入 / popup health 读数） |

### Case 结果

| Case | 计划目标 | 实际执行 | 最终 journal / server inFlight / server status | DOM write / click / beginSend / ACK | 结论 |
| --- | --- | --- | --- | --- | --- |
| **A** SW restart / page reload | 在 **SHADOW** 下观察：旧 document owner 失效 → health `waiting_owner` / `owner_unavailable` → **显式 bind 新 document 后，后续 heartbeat 恢复 exact-owner** | **未 live 执行** | n/a（未触碰 journal / server） | **n/a — production path 未执行** | **automation-proven / live pending**：需真实 ChatGPT 页 + extension SW 重启；`mode=off + journal=NONE + owner unavailable` 时 health 为 `off`（journal → OFF → owner 优先级），**不能**用 OFF 期待 `waiting_owner` |
| **B** Bridge temporary offline | 网络中断不导致 duplicate mutation；恢复后仅 journal-allowed continuation | **未 live 执行故障注入** | n/a | **n/a — production path 未执行** | **automation-proven / live pending**：无法在不影响真实生产发送的前提下安全注入 `/state`/`/reserve` 网络故障；若未来 live，仅允许 **新建专用 event**，且 `COMPOSER_WRITE_INTENT+` 绝不 re-write/re-click，`OUTCOME_UNKNOWN` 绝不 resend |
| **C** `OBSERVED_PENDING_ACK` server-observed closeout | 新建专用 event：server 已 `observed` + `inFlight=null`，local 仍 `OBSERVED_PENDING_ACK` → SW recover → `NONE` / `action=server_observed_clear`；期望 ACK/beginSend/DOM/CS = 0 | **未 live 执行** | n/a | **n/a — production path 未执行** | **automation-proven / live pending**：真实环境无法在**不篡改 durable journal** 的前提下构造“ACK 成功但 local clear 丢失”；按验收纪律不伪造生产状态。自动化已覆盖 eligible state table + rollback + SW branch zero-mutation contract |
| **D** page route drift / ownership invalidation | **SHADOW-only**（禁止 ARMED）：切换 conversation → route-change invalidation 清除 owner → foreign-route heartbeat 非 exact owner → 不 production tick；返回原 route 不自动继承旧 owner | **未 live 执行** | n/a | **n/a — production path 未执行** | **automation-proven / live pending**：需真实 ChatGPT conversation 切换 + extension policy 观测；本轮未 Reload / 未 Arm production。**不期待**单纯 page switch 触发 `policy_identity_mismatch` / `disarmOnIdentityChange` |

### 安全边界遵守情况

- 未操作任何历史 event（Send / Reserve / Recover / ACK / Retire / begin-send 均未发生）
- 未创建新的 production feedback event
- 未通过 Retire “清理”任何状态
- 未 rollout / Reload extension / pair 浏览器 / Arm production
- 未修改 production code（本轮仅 docs）
- 未记录 credential、secret、raw DOM、raw message

说明：上表 “n/a — production path 未执行” 表示本轮**未进入** live production path，因此**不是**对具体 live case 的 measured 调用计数。

### 尚需 operator 驱动的 live 验收（后续）

#### A / D — owner / route resilience（**不需要** production event）

适用前提：

- 先正常建立 target conversation 的 Companion pairing / ownership（若当前仍 `pairingActive=false`）
- **journal = `NONE`**，Bridge **`inFlight=none`**
- 无 pending production acceptance event 被消费
- 启用 **SHADOW**（观察 owner-loss health 必须用 SHADOW；OFF 只能作为开始/结束安全状态）
- **不进入 production path**；**不要**为 A/D 创建 feedback event

`operationalHealthSummary` 优先级：active journal → autonomy OFF → auth/owner/gates。
因此 `mode=off + journal=NONE + owner unavailable` → health=`off`；只有 **SHADOW + journal NONE + owner 失效** 才应看到 `waiting_owner` / `owner_unavailable`。

**A — Reload / document ownership resilience**

1. 健康 target route + pairing + **SHADOW** + journal `NONE`
2. Reload ChatGPT conversation page
3. 旧 document 被 ownership invalidation 清除；不应再被视为 exact owner
4. health 应显示 `waiting_owner` / `owner_unavailable`（SHADOW 下；**不是** OFF 下）
5. 新 document 的普通 heartbeat / observe **不会自动继承或恢复 owner**（content-script heartbeat 仅为 passive observation；SW heartbeat path 只计算 `isExactOwnerHeartbeat`，不自动 bind）
6. Operator 必须通过现有**显式 Bind / ownership 流程**（`c2c.bind.request → c2c.bind → bindOwner(...)`）绑定**当前新 document**
7. Bind 成功后，后续 heartbeat 才能成为 `exact-owner heartbeat`
8. 此后 health 才恢复正常 SHADOW readiness
9. 不发生 reserve / beginSend / DOM write / click / ACK
10. 验收结束恢复 **OFF**

与 D2 使用同一 ownership 事实模型：owner 失效后只能**显式 bind**重建，不存在 heartbeat 自动恢复路径。

**D1 — Page route drift（SHADOW-only）**

1. 健康 target route + **SHADOW** + journal `NONE`
2. 切到另一个 ChatGPT conversation（page route drift）
3. `ownership.invalidateOnRouteChange()`：同一 owner document 离开 bound `targetRoute` → `owner → null`
4. foreign-route heartbeat：`isExactOwnerHeartbeat(...) === false`，不 schedule autonomy tick
5. health 应表现为 owner unavailable / `waiting_owner`（SHADOW 下）
6. 不发生 reserve / beginSend / DOM write / click / ACK
7. **不要**期待单纯 conversation switch 触发 `policy_identity_mismatch` / `disarmOnIdentityChange`：那比较的是 policy vs **transport identity**（bindingId / epoch / transport route），page SPA 切换通常**不会**自动改 transport identity

**D2 — 返回原 target route**

- 返回原 bound conversation 后，**不允许**旧 owner authorization 自动继承
- 当前 owner 已在 route drift 时失效；必须按现有**显式 bind / ownership 流程**重新建立当前 document 的合法 ownership
- **同 tabId ≠ 同 document**；不得因 tabId 相同自动恢复旧 document owner
- 结束恢复 **OFF**

**D3 — Transport identity drift（单独概念，非 page drift）**

仅当 **bindingId / epoch / transport route 实际改变**时，才单独测试 `disarmOnIdentityChange`，并期待 autonomy 被强制 OFF / identity mismatch gate。
**不要**把 D1 page route drift 与 D3 transport identity drift 混成一个 case。

#### B / C — production-path resilience（需要 future controlled setup）

B/C **不是** A/D 的 SHADOW-only 验收；若未来 live，必须同时满足：

- independent review 同意
- 可控故障注入或专用 event 流水线
- **新建专用 acceptance event**（禁止历史 event；一次只允许一个）
- journal 起点与 server inFlight 明确记录
- 恢复后只执行 journal 当前允许的 continuation
- `COMPOSER_WRITE_INTENT+` 绝不 re-write / re-click
- `OUTCOME_UNKNOWN` 绝不 resend
- 不得用 Retire “清理测试”

若无法安全注入而不影响真实生产发送 / 不篡改 durable state，则保持 **automation-proven / live pending**。

出现 identity mismatch / ambiguous observation / unexpected active journal / server inFlight 与 local journal 不一致 / unexpected DOM mutation 时立即停止。

### F1c 门禁

- 本轮仅文档变更 → `git diff --check`
- 无 production code 变更 → 无需重跑 full test / typecheck / build
- live-fix 代码：本轮无；若有须先 independent review，不自动 commit
