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

明确不做（等待下一轮 independent review）：

- rollout / Reload extension
- 创建真实 production feedback event
- Reserve / begin-send / ACK / Recover / Retire
- 操作历史 event（含 `e600aed6ef94…` 与 final acceptance `2c6b1d23641f46c4…`）
- F1b commit / push

## 门禁

- targeted：`pnpm exec vitest run tests/f1-companion-resilience.test.ts`
- targeted：`pnpm exec vitest run tests/e1b3d3b-production-send.test.ts`
- related：`pnpm exec vitest run tests/e1b3d3b2-autonomy.test.ts tests/e1b3d3b-production-send.test.ts tests/e1b3-send-orchestration.test.ts tests/f1-companion-resilience.test.ts`
- full：`pnpm test --maxWorkers=1 --testTimeout=90000`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

结果见本轮汇报；F1b 在下一轮 review 前保持 uncommitted。
