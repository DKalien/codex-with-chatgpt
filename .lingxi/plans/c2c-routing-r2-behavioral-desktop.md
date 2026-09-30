---
name: C2C Routing R2 Behavioral Desktop
overview: 以 main @ 35a4836 为基线，把 Desktop 生产信任路径从"版本/catalog/ASAR/semantic fingerprint 预登记"整体替换为"live 行为证明"：Python helper 收敛为 process identity + observe/send 两套状态语义 + behavioral send attestation（含显式 mutation boundary 与 post-start observation fence），Node 侧删除 compatibility validator 体系，CLI 收敛为薄层 behavioral diagnostics。生产代码净行数须明显下降。完成后未提交 diff 交 ChatGPT review，B 级 live smoke 在 review 通过后另行执行。已纳入用户 6 点修订。
todos:
  - id: r2-freeze
    content: R2.0 边界冻结：确认基线 35a4836、.lingxi/ 与 stash 不动
    status: completed
  - id: r2-process-identity
    content: R2.1 Python _verify_process_identity：去 version 观测，纯进程树核对
    status: completed
  - id: r2-state-split
    content: R2.2 拆分 _validate_observed_state（shape 仍严格）/ _assert_send_ready（不含 owner），切换 observe 调用点
    status: completed
  - id: r2-send-attestation
    content: R2.3 send behavioral attestation：snapshot serial fence + _find_live_turn_by_id + exact equality + 显式 mutation boundary（post-start 一律 OUTCOME_UNKNOWN/notSent=false）
    status: completed
  - id: r2-prepare
    content: R2.4 _prepare 收敛：删 candidate handshake 与 VERSION_UNSUPPORTED fallback；result 路径换 _verify_process_identity
    status: completed
  - id: r2-delete-compat-py
    content: R2.5 删除 compatibility 体系（scanner/catalog/audit + desktop_profiles.json + copy 脚本 + helper op 收敛 diagnose）
    status: completed
  - id: r2-node-slim
    content: R2.6+修订4 wire version drift 改 DESKTOP_PROTOCOL_ERROR；Node ipc.ts 瘦身 + TargetInfo 三字段退出 + abandonment/retirement 三处同删
    status: completed
  - id: r2-cli
    content: R2.7+修订5 CLI 薄层 diagnose：无 target 即报无法诊断，不做 trust 分类，不加全局扫描
    status: completed
  - id: r2-tests
    content: R2.10/11 测试重构：删 compatibility 专项测试；含两条 mutation boundary 硬验收
    status: in_progress
  - id: r2-docs
    content: R2.12 文档同步（desktop-control/protocol/development-plan/architecture/routing-architecture 补 R2 状态）
    status: pending
  - id: r2-verify
    content: A 级验收：typecheck/build/Python+Node focused tests/diff-check + 净删除指标 + grep 无残留，未提交 diff 交 review
    status: pending
---

# R2 — Desktop Behavioral Adapter（含 6 点修订）

## 边界冻结（R2.0）
- 基线 `main @ 35a4836`；只允许 `.lingxi/` 留在工作区；两条 pre-R1 stash 不碰、不 pop。
- 不接 R1 Routing 进生产发送；不改 Browser Companion / feedback / outbox / Bridge rollout / post-turn-finalizer / OAuth-Connector 的 `desktopCompatibility`。
- 全程不 commit；A 级验收 = 未提交 diff 交 review。不做 live mutation。

## Phase A — Python helper（src/desktop/helper/desktop_ipc.py）

### A1（R2.1）process identity 主线
- `_verify_runtime_identity` 改名 `_verify_process_identity`，去掉 `require_catalog` 与 version 观测，只保留：pipe server PID 身份、server 必须是当前 ChatGPT Desktop 进程、唯一 codex.exe child、PID/creation/normalized exe path、project/thread/workspace 映射（`_verify_project`）、expected fence 前后一致。
- 返回结构保留 `desktopPid/desktopExe/desktopCreation/appServerPid/appServerExe/appServerCreation`（`_verify_current_runner_ancestor` 依赖 `appServerPid`）。
- 保留现有 Windows token/integrity 与 pipe identity 检查。

### A2（R2.2）observe / send-ready 彻底分责
- `_validate_observed_state(state, target, owner)`：验证"这是正确且结构可理解的会话"——threadId/hostId/cwd/workspaceKind/resumeState/owner 存在/environments/turn 数据结构合法。**允许** idle/active/inProgress、requests 与 unconfirmed submissions 存在，但这些字段的**类型仍必须合法**（shape validation 不因只读而跳过）；turn status 非法值仍拒绝。
- `_assert_send_ready(state)`：只负责 runtime idle、requests 空、unconfirmed submissions 空、无 inProgress turn。**不含 owner 一致性**——owner 属于 `_IpcClient` session identity 而非 state 字段，由 prepare/send 前后的 owner fence（`client.discover()` 前后一致 + `request()` 的 handledByClientId 校验）单独保证。
- observe 调用点（inspect/current_identity/current_execution/result context/ownership/classification/unknown reconciliation，约 15 处）统一切到 `_validate_observed_state`；send 路径用 `_assert_send_ready`。
- 语义：忙 ≠ Desktop 不可用；`desktop status` 在 active executor 时仍可观察。

### A3（R2.3）send behavioral attestation（R2 最重要验收点）
成功条件精确定义为：

```text
fresh pre-start state
→ before turn IDs + snapshot serial
→ send-ready + process/owner fence
→ exactly one start-turn
→ ACK gives new turnId
→ post-start fresh observation (serial increased)
→ ACK turnId exists in this conversation
→ strict userMessage structure
→ exact text === submitted C2C envelope
→ final process/owner fence
→ return receipt
```

- 发送前记录 `before_turn_ids` 与 observation 高水位；post-start fence 复用 `_IpcClient.snapshot()` 现有语义（强制 following-changed → 等待 `snapshot_serial` 严格大于 before 的新 snapshot、age 有界）——**不接受 send 前缓存的 `current_state()`**。
- 新增 `_find_live_turn_by_id(...)`：安全遍历当前 canonical representation 找指定 turnId，**不要求 canonical history exhausted**；找到 0 个或 >1 个都失败。复用 `_turn_text_for_reconciliation` 的严格 userMessage 结构检查。
- **不 parse `C2C_DESKTOP_TASK` 业务字段**——exact text equality 已足够；业务 envelope 的 command/workspace digest 继续由 Node durable layer 和 reconciliation 管。
- **显式 mutation boundary**：`_Prepared.send()` 内部维护 `start_attempted` 边界。start-turn 之前仍可返回具体 preflight error / `notSent=true`；在唯一一次 `thread-follower-start-turn` 写入尝试前翻转 boundary。此后任何 `DesktopIpcError`、timeout、process drift、owner drift、state mismatch、正文 mismatch，**统一转换成 `DESKTOP_OUTCOME_UNKNOWN / notSent=false`**——不依赖各下层 helper 自己的默认 `not_sent`（防止 post-start 的 `DESKTOP_STATE_UNAVAILABLE` 被错标成"确定没发"）。绝不第二次 start-turn。

### A4（R2.4）`_prepare` 收敛
- 固定顺序：token → open pipe → process fence A → initialize → discover owner → fresh snapshot A → `_validate_observed_state` → `_assert_send_ready` → process fence B == A → freshness → Prepared。
- 删除 candidate handshake、`candidate_handshake` 分支与 `DESKTOP_VERSION_UNSUPPORTED` fallback；result/reconciliation 路径约 20 处 `_verify_runtime(...)` 全部替换为 `_verify_process_identity(...)`。
- 保留：`_turn_text_for_reconciliation`、canonical envelope reconciliation、result ownership、activity marker、terminal fence、native continuation、outcome_unknown reconciliation——这些是新的安全边界，不删。

### A5（R2.5）删除 compatibility 体系
- 删除：`PROFILE_CATALOG_PATH` 与全部 `_CATALOG_*`、`_load_catalog`、`VERIFIED_PROFILES`/`VERIFIED_RUNTIME*`/`_legacy_runtime*`/`_profile_for_pair`、`_observe_runtime_versions`/`_checked_runtime`/`_runtime_version`/`_sha256_file`/`_static_file_version`/`_static_desktop_version`、`_compatibility_for_paths`、`_asar_module_hashes`/`_asar_audit_modules`/`_AsarAuditError`/`_safe_audit*`/`_audit_result`、Protocol Fingerprint v2 scanner（`_js_*`/`_semantic_*`/`_SEMANTIC_*`/`_START_TURN_MUTATION_*`/`_MAX_PROTOCOL_*`/`_MAX_ASAR_*`）、`_compatibility_audit_for_paths`/`_compatibility_audit`/alias、`_candidate_runtime`、`_version_error`、`_runtime_process_pairs`/`_runtime_process_pair`/`_compatibility`、`_safe_compatibility`/`_diagnostic_from_observation`、`_handshake_audit`、`COMPATIBILITY_*` 常量；`ERROR_MESSAGES` 移除 `DESKTOP_VERSION_UNSUPPORTED`。
- 删除文件 `src/desktop/helper/desktop_profiles.json`；`scripts/copy-desktop-helper.mjs` 只复制 `desktop_ipc.py`。
- helper 协议 op：`compatibility`/`compatibility_audit`/`handshake_audit` 收敛为单个 `diagnose`；错误 reply 不再附 `compatibility` 字段。

### A6（修订 4）wire-version drift 改判
- `_IpcClient._handle()` 对 `thread-stream-state-changed version != 11` 的检查（现抛 `DESKTOP_VERSION_UNSUPPORTED`）改为 `DESKTOP_PROTOCOL_ERROR`——语义是"当前 live protocol 行为不符合我们理解"，不是"build 不在白名单"。
- pre-start：`DESKTOP_PROTOCOL_ERROR / notSent=true`；post-start：由 mutation boundary 收敛成 `OUTCOME_UNKNOWN / notSent=false`。

## Phase B — Node 侧

### B1（R2.6 + 修订 6）ipc.ts 瘦身与版本字段彻底退出
- 删除 `DesktopCompatibility`/`DesktopCompatibilityAudit`/candidate runtime/module 类型/`DesktopSemanticReason`/ASAR+hash validator/`validateDesktopCompatibility`/`validateDesktopCompatibilityAudit`/`desktopCompatibilityFromError`/错误 compatibility 附加/相关常量；`DESKTOP_VERSION_UNSUPPORTED` 移出 `SAFE_CODES` 与 `ERROR_MESSAGES`。
- `DesktopTargetInfo` 直接移除 `desktopVersion/appServerVersion/profile`；同步修改全部精确 key 列表 validator（6+ 处）与 `desktopIpc` 方法签名；`handshakeAudit`/`compatibility`/`compatibilityAudit` 替换为 `diagnose()`。
- `abandonment.ts`/`legacy-retirement.ts`：**类型字段、projection、equality 三处一起删**（`sameIdentity` 只比 threadId/hostId/projectId/workspaceRoot/ownerClientId 等 live 身份）；不为旧字段做 migration 体系。`ownerClientId`、thread/project/workspace/result turn 等 live 身份保留。

### B2（R2.7 + 修订 5）CLI 薄层 diagnose
- `c2c desktop compatibility` 命令名保留一版作 alias，内部只有一个薄 `diagnose(target/current-context)`。
- 没有可确定的 conversation target 时返回"无法进行 live conversation diagnosis"——**不**重新增加全局进程扫描、版本识别或静态 bundle 分析来让命令"尽量有输出"。
- 诊断结果只描述这次 live handshake 发生了什么（processStable/initialize/ownerDiscovery/followingChangedSent/stateReceived/stateChange），**不做 trusted/untrusted 分类**，不输出 profile/version/SHA/ASAR/fingerprint。
- `--audit`/`--handshake-audit` 退休（报错提示已移除）；`service.ts` durable send 语义确认不动，仅随 error 类型字段消失做最小适配。

## Phase C — 测试与文档

### C1（R2.10/11）测试重构
- 直接删除：catalog/ASAR/same-protocol candidate/semantic fingerprint/`DESKTOP_VERSION_UNSUPPORTED` 专项测试。
- Python 重点：未知日更版本不阻断 observe；active inspect 成功 + prepare `DESKTOP_BUSY`；approval pending inspect 成功 + prepare `DESKTOP_APPROVAL_PENDING`；thread/project/cwd/owner 不匹配 fail closed；PID/creation/exe prepare 前变化 → 未 start notSent=true；start-turn 恰好一次；ACK+canonical turn+exact message → receipt；ACK 后找不到 turn/正文不一致/owner 或 process drift/request 异常 → `OUTCOME_UNKNOWN/notSent=false`；pre-start 失败零 start frame；unknown reconciliation 仍按 canonical envelope。
- **两个 mutation boundary 硬验收**：
  - post-start 收到普通 `DESKTOP_STATE_UNAVAILABLE` → 对外必须 `OUTCOME_UNKNOWN/notSent=false`；
  - pre-start 同样的 `DESKTOP_STATE_UNAVAILABLE` → `notSent=true`，start-turn count=0。
- Node：desktop-ipc.test.ts（validator/key 列表/diagnose）、desktop-current.test.ts、desktop-helper-packaging.test.ts（断言 dist 无 desktop_profiles.json）、desktop-abandonment*.test.ts（identity equality）；executor-core.test.ts 已核实零 version 引用，预计零改动。
- Node 保留覆盖：journal before send、accepted 仅 behavioral-confirmed receipt、unknown 永不重发、exact command replay、active executor 时 status 仍可观察。

### C2（R2.12）文档
- `docs/desktop-control.md`、`docs/protocol.md`、`docs/development-plan.md`、`docs/architecture.md` 同步 behavioral 信任模型；`docs/routing-architecture.md` 只补一句 R2 状态。
- 明确写入：C2C 不再证明 Desktop 二进制属于预登记版本；它验证当前绑定目标、当前 live protocol 行为、mutation 单次性、mutation 后 canonical state 中的精确结果。

## 验收（A 级）
- `pnpm run typecheck`、`pnpm run build`、Python protocol/helper tests、Node Desktop focused tests、executor-core、unknown reconciliation/result tests、`git diff --check` 全绿。
- 硬指标：生产代码**明显净删除**；2200–2500（helper）/ 900–1000（ipc.ts）仅作参考，不为数字牺牲可读性。review 关注 production complexity 真实消失，以及 grep 无残留：`VERIFIED_PROFILES`、`candidateRuntime`、`semanticFingerprint`、ASAR trust、production `DESKTOP_VERSION_UNSUPPORTED`。删除量在报告中单列。
- 未提交 diff 交 ChatGPT review（先审实际删除与 behavioral send boundary，再决定 B 级 Windows smoke）；不 commit；`.lingxi/` 与两条 stash 不动。
