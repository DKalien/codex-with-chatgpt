# 安全门禁审查报告（Security Gate Audit）

> 生成日期：2026-10-09。执行：Codex（受用户委托）。基线 HEAD `98292c2`（分支 `codex/official-mcp-events`，审查开始时 working tree clean）。
> 结论速览：项目安全控制呈 defense-in-depth 形态；冗余的主体是**同一检查的多份重复实现**（可安全收敛）与**看似重复、实为真实信任边界**的多层校验（不可删）。8 项冻结门禁 0 项可删语义；实施 4 批收敛（B1/B2/B4/B6），2 批（B3/B5）经逐点核实判定不满足删层判据而保留。

## 2026-10-12 默认 Companion 合同更新

本报告后续的 B/C 批次、冻结项与测试计数是原日期评估快照，不代表当前扩展仍默认加载旧实现。现役边界继续以 [AGENTS.md](../AGENTS.md) 为权威；默认链见[轻量 Companion](companion-lightweight.md)。

| 控制 | 当前责任与变化 | 证据入口 |
|---|---|---|
| 默认加载 | `bridge-client.js` + `content-lite.js` + `popup/lightweight.html`；旧 phase/owner-proof/route-attest/fence/journal 实现保留兼容，不默认加载 | `browser-companion/manifest.json` |
| 安全判定 | OAuth scope、本机确认、binding/enable、owner/project/workspace、版本/hash、审批、防重放和 outcome_unknown 全部由 Bridge 判定 | `src/bridge/companion.ts`、`src/bridge/result-bus-delivery.ts` |
| 配对权限 | 独立 Grant 请求精确 origin；Pair 只 contains，密钥只在 popup 内存；JSON 自动登记并选择项目 | `browser-companion/popup/lightweight.js` |
| 回流连接 | 配对后按需本机确认，状态推进 commit/bind；无需 route 验证消息；local_user 不授予 MCP principal | `browser-companion/bridge-client.js`、`src/bridge/companion-local-route.ts` |
| 单次发送 | `/begin-send once:true` 只对首次 durable claim 授权 DOM 执行；重启或响应不明只观察原 attempt，精确 observed 后 ACK | `src/result-bus/delivery-lifecycle.ts`、`browser-companion/content-lite.js` |

本节是源码合同更新，不补记新的全量回归、部署或真实网页验收。

## 1. 范围与方法

- 范围：`src/`（含 Desktop Python helper）、`browser-companion/`、`scripts/`、`docs/`、`tests/` 全部安全控制（身份验证、授权、加密/哈希、访问限制、审计/防重放、状态机门禁、进程/环境隔离等）。
- 方法：三路并行代码盘点（认证授权链 / 防重放与审计完整性 / 文档-架构-测试门禁）→ grep 计数与抽样读码复核 → 逐点"删层判据"核实（两检查点之间无 await、无状态变更、无锁释放、无跨进程窗口，且同信任边界内已有等价拦截）。
- 口径：行数以 `git diff --stat` 为准；重复实现以 grep 计数为准；时长以 vitest 输出 duration 为准。
- 限制：不含渗透测试/运行时动态审计；全量回归基线采用既有回归记录（127 files / 2598 tests / 683–819s，2026-09-30/10-01 记录）。

## 2. 基线数据（B0，2026-10-09）

| 指标 | 基线值 | 采集方式 |
|---|---|---|
| `requireScope` 定义 | 3 份（tool-shared/feedback/feedback-probe）+ 5 处内联 `scopes.includes` 判定 + 3 份 `requireAuth` 内联 | `rg "function requireScope\|scopes\.includes" src` |
| `authorizeNow` 定义 | 3 份（desktop/executor-tools/web-sink-tools） | `rg "function authorizeNow" src` |
| 常量时间比较实现 | 4 份（auth safeEqual ×1、feedback hashEqual ×1、web-sink hashEqual ×1、pairing 内联 ×1） | 人工核读 |
| `HEX64` 正则定义 | **11 份**（初测 13 为组合 grep 高估，精确复核 11） | `rg "HEX64 = /" src` |
| 64KiB 上限 TS 内重复 | 5 处（desktop/store、executor-control/schema、desktop×3 异写法 64\*1024/65_536/65536） | `rg "64 \* 1024\|65536\|65_536" src` |
| 单飞集合常量 | 2 份（feedback/delivery-lifecycle 与 bridge/delivery-arbiter 各定义同集合） | 人工核读 |
| "冻结 sendTarget" 比对模板 | 4 处（result-bus-delivery.ts reserve/begin-send/ack/retire，其中 3 处带 FIX B 注释） | 人工核读 |
| durable store 事务模板 | 6 份（executor-control/dispatch-store/web-sink/routing/result-bus/desktop） | 人工核读 |
| nonce ownership 锁 | 5 份（endpoint-switch/command-cleanup/dispatch-store/rollout-fence/startup-lease） | 人工核读 |
| 全量回归历史基线 | 127 files / 2598 tests / 683–819s | 既有回归记录 |
| 批前 git 状态 | clean（HEAD `98292c2`） | `git status --porcelain` |

## 3. 门禁清单（按层分类）

> 快照声明：本表为 2026-10-09 一次性评估记录快照，仅供审查追溯；现役安全边界以 [AGENTS.md「必须保留的边界」](../AGENTS.md) 为唯一权威，本表不作为独立约束源。

| 门禁ID | 名称 | 冻结状态 | 位置（代表） | 层 |
|---|---|---|---|---|
| G-OA1 | OAuth PKCE S256 + 授权码一次性 + TTL | 冻结 | `src/auth/oauth.ts` | MCP 接入 |
| G-OA2 | Bearer 每请求校验 + 跨 workspace 403 | — | `src/auth/middleware.ts` | MCP 接入 |
| G-OA3 | Token 只存 sha256 / TTL 1h/30d / refresh 轮换 / revoke | 冻结 | `src/auth/store.ts` | MCP 接入 |
| G-OA4 | 配对码一次性 + 5 次尝试 + IP 限速 + 5min TTL | 冻结 | `src/pairing/manager.ts` | MCP 接入 |
| G-SC1 | 逐工具 OAuth scope 门禁（8 处实现→收敛） | 冻结 | `src/mcp/tool-shared.ts` 等 | MCP 工具 |
| G-SC2 | live OAuth 重验证（desktopAuthorize/executorAuthorize） | 冻结 | `src/bridge/server.ts` | 投递提交 |
| G-SC3 | 排队延迟授权复核（verifyAccessTokenHash 出队时） | — | `src/routing/mailbox.ts` | 投递提交 |
| G-DC1 | Desktop 本机确认框（bindCurrentDesktop） | 冻结 | `src/desktop/service.ts` | Desktop |
| G-DC2 | Desktop enable 需 bindingId + `--accept-desktop-permissions` | 冻结 | `src/cli/desktop.ts` | Desktop |
| G-DC3 | 行政处置 `--confirm` 摘要 | 冻结 | `src/desktop/outcome-resolution.ts` | Desktop |
| G-BE1 | binding/enable 精确匹配（authorized） | 冻结 | `src/desktop/service.ts` | Desktop |
| G-BE2 | Active Executor Binding（bindingId+epoch 防 ABA） | 冻结 | `src/executor-control/service.ts` | Executor |
| G-BE3 | Executor Dispatch durable target pin + identity replay | 冻结 | `src/executor-control/dispatch-service.ts` | Executor |
| G-OP1 | owner/project/workspace 归属（identity.py 提权/完整性/进程树） | 冻结 | `src/desktop/helper/c2c_desktop_ipc/identity.py` | Desktop IPC |
| G-OP2 | 跨语言 wire 双侧校验（TS ipc-validation ↔ Python） | — | `src/desktop/ipc-validation.ts` 等 | Desktop IPC |
| G-VH1 | 版本/hash（launch pin、runtimeBuildId、payloadSha256、messageSha256） | 冻结 | `src/supervisor/store.ts` 等 | 完整性 |
| G-VH2 | HEX64/摘要形状校验（11 份→1） | 冻结 | `src/core/hex.ts` | 完整性 |
| G-PR1 | commandId 防重放（replay 五元组指纹） | 冻结 | `src/desktop/service.ts` | 防重放 |
| G-PR2 | Web Control seenCommands 防重放（10000 上限、不重置） | 冻结 | `src/session/web-control.ts` | 防重放 |
| G-PR3 | startup lease one-shot claim | — | `src/core/startup-lease.ts` | 防重放 |
| G-OU1 | outcome_unknown 不重发 + assertNoUncertainDelivery | 冻结 | `src/desktop/service.ts` | 未知结果 |
| G-OU2 | reconcile-unknown 5 重精确匹配 / 0-1-N 候选语义 | 冻结 | `src/desktop/unknown-reconciliation.ts` | 未知结果 |
| G-OU3 | dispatch split-brain 保守收敛（绝不二次 send） | 冻结 | `src/executor-control/dispatch-service.ts` | 未知结果 |
| G-RT1 | Route attestation VERIFIED（production reserve/begin-send 门禁） | 冻结 | `src/feedback/companion-route.ts` | Companion |
| G-RT2 | route durable fence（仅 re-pair 重置） | 冻结 | `browser-companion/route-attestation.js` | Companion |
| G-RT3 | pairing ≠ Send authority；local_user 不提供 Feedback principal | 冻结 | `src/feedback/companion-delivery.ts` | Companion |
| G-SF1 | 单飞 in-flight ≤1（schema/事务/arbiter/adapter） | 冻结 | `src/bridge/delivery-arbiter.ts` | 状态机 |
| G-SF2 | begin-send 唯一冻结点 + frozen attempt 不迁移 | 冻结 | `src/result-bus/delivery-lifecycle.ts` | 状态机 |
| G-SF3 | noWrite byte-equality + replay 幂等合同 | 冻结 | 各 durable store | 状态机 |
| G-AC1 | adminGuard（loopback + admin token + 拒代理头） | — | `src/bridge/server.ts` | 运维面 |
| G-AC2 | 认证 shutdown + runtime 身份校验（不按旧 PID kill） | 冻结 | `src/process/daemon.ts`、`src/bridge/runtime.ts` | 运维面 |
| G-AC3 | daemon 环境投影 allowlist + 交接文件 0600 | 冻结 | `src/process/daemon-spawn.ts` | 进程隔离 |
| G-AC4 | Windows Job membership fail-closed | 冻结 | `src/process/daemon-spawn.ts` | 进程隔离 |
| G-SD1 | 日志/输出脱敏（redact、私钥块 HARD_REJECT、64KiB 截断） | — | `src/logger/index.ts`、`src/execution/sanitize.ts` | 数据保护 |
| G-SD2 | 敏感文件 deny-by-default（.env/keys/SSH…） | — | `src/workspace/ignore.ts` | 数据保护 |
| G-SD3 | stateCorrupt fail-closed（损坏保留文件、不重置 ID） | 冻结 | 各 store | 完整性 |
| G-SD4 | 审批不自动批准（工具描述合同 + 无绕过面） | 冻结 | `src/mcp/*`、`skill/SKILL.md` | 授权 |

## 4. 价值评估矩阵

评分：安全价值 / 去重收益 / 改动风险 / 测试成本，1–5（越高越强/越大）。

| 门禁ID | 控制目标 | 实现份数 | 冗余类型 | 安全价值 | 去重收益 | 改动风险 | 处置 | 理由 |
|---|---|---|---|---|---|---|---|---|
| G-SC1 | scope 最小授权 | 8 | 重复实现 | 5 | 4 | 2 | **收敛（B1）** | 判定谓词+challenge 文本收敛共享；错误类/文案逐点保留 |
| G-SC2 | TOCTOU 撤权防护 | 2 | 同窗少量重复 | 5 | 1 | 5 | 保留 | pin 前+send-time 双点各有语义；序列被工程约定冻结 |
| G-SC3 | 排队期间撤权防护 | 1 | 无 | 5 | 0 | 5 | 保留 | 唯一拦截点 |
| G-VH2 | 摘要形状 | 11 | 重复实现 | 3 | 5 | 1 | **收敛（B2）** | 零依赖共享常量 `src/core/hex.ts` |
| G-SD1 同类 | 常量时间比较 | 4 | 重复实现 | 4 | 4 | 1 | **收敛（B2）** | canonical=safeEqual；hashEqual 保留导出名 |
| 正文上限 | 64KiB 正文上限 | 5 | 重复实现（同值异写法） | 3 | 3 | 1 | **收敛（B2）** | 单一来源 EXECUTOR_MESSAGE_MAX_BYTES；Python/wire 独立保留 |
| G-SF1 | 单飞 ≤1 | 2 常量+4 检查层 | 常量重复/层间重叠 | 5 | 2 | 3 | **常量收敛（B2）**；层保留 | 常量 2→1；4 检查层经核实分属不同边界（schema 防篡改/事务内/跨 store/adapter） |
| G-SF2 同类 | 冻结 route 比对 | 4 | 模板复制 | 5 | 3 | 2 | **收敛（B4）** | 同文件提取 assertFrozenSendTarget；错误码/文案逐字保留 |
| G-BE3 同类 | dispatch 形状校验 | 2 | 手工 regex 与共享重复 | 2 | 2 | 1 | **收敛（B4）** | assertHex64 改用共享 HEX64；dispatch 七条硬约束不动 |
| G-PR1 同类 | replay 指纹比对 | 5 调用点 | 调用点分散 | 5 | 0 | 5 | 保留 | 每个调用点之间存在 await/IPC/锁边界（见 §6 B3 核实） |
| G-OU1/G-OU2 | 未知结果保守性 | 多层 | 层间重叠 | 5 | 0 | 5 | 保留 | split-brain 最后防线 |
| G-RT1/G-RT2/G-RT3 | route 劫持防护 | 多层 | 层间重叠 | 5 | 0 | 5 | 保留（B5 仅记录） | 跨信任域（网页/SW/CS/服务端）各有边界 |
| G-DC1/G-DC2/G-DC3 | 用户意志证明 | 3 | 无 | 5 | 0 | 5 | 保留 | 授权链唯一"用户意志"证据 |
| G-OP1/G-OP2 | 越权/提权防护 | 跨语言 | 双侧校验 | 5 | 0 | 5 | 保留 | 不可信 wire 边界必须双侧 |
| G-AC2/G-AC3/G-AC4 | 进程生命周期/环境隔离 | 多层 | 无实质重复 | 5 | 0 | 5 | 保留 | 每项对应真实 Windows 攻击面 |
| G-OA1–G-OA4 | 接入安全 | — | 无 | 5 | 0 | 5 | 保留 | PKCE/一次性/限速为标准必需 |
| G-SD3 | 损坏 fail-closed | 6+ store | 模板复制 | 4 | 3 | 4 | 仅记录（B5 类） | 合并为共享原语收益存在但改动面大（见 §7 未来候选） |

**总结论**：可"删语义"的门禁为 **0**；可收敛的是重复实现（B1/B2/B4）；层间重叠的检查经逐点核实均为真实信任边界（§6）。

## 5. 移除/收敛方案与实施结果

### 5.1 C 阶段（§7 未来候选二次瘦身，2026-10-09 追加）

| 批次 | 内容 | 结果 | 语义变化 |
|---|---|---|---|
| C1 | #19 durable store 事务模板 ×6 → 共享原语 `src/core/durable-store.ts`（wx 锁 + fsyncSync + initialized marker + tmp wx 0600 + 原子 rename + 失败清 tmp + 锁清理纪律的唯一实现点）；6 店（executor-control/dispatch/web-sink/routing/result-bus/desktop）改为注入差异回调（错误工厂、parse、身份校验、revision 公式、noWrite 策略、序列化、路径硬化钩子）；5 个 store wx 锁实例经 `simpleWxLock` 收敛（#20 有价值部分） | 完成；17 files 合并验证全绿（r5e dispatch 33、r5d2 29、desktop-control 53、routing 23+35 等） | 无（错误码/文案/顺序逐字保留；3 处有界微差异见下） |
| C2 | #20 nonce ownership 锁 ×5 → 共享 | **部分收敛 + 证据否决统一**：endpoint-switch 被 `r5e-architecture` import fence 钉死为自包含；command-cleanup（ESRCH reclaim+dev/ino+ALS）、dispatch（generation 仲裁）、rollout-fence（token+dev/ino 裸 Error）、startup-lease（lease 链 one-shot）是 4 种结构不同的协议而非参数差异，强行统一必然语义漂移。其"wx 锁 payload+fsync+清理"重复已由 C1 的 `simpleWxLock` 吸收（5 实例） | — |
| C3 | #21 行政证据 store ×4 → 共享 `src/core/evidence-store.ts`（readState 六段判定 + writeState 原子替换模板唯一实现点） | 完成；4 店净删 235 行模板（abandonment −63/retirement −70/reconciliation −48/outcome-resolution −54），7 files 249/249 全绿 | 无（parse 内外/utf8/错误映射差异参数化保留） |
| C4 | #7 companion-route 双查提取、#22 expectation 同构合并 | 完成（7 files 289/289 全绿） | 无 |
| C4 | #12 Result Bus 单飞事务内层裁剪 | **证据否决**：`FEEDBACK_INFLIGHT_FENCE` 被 13 处测试钉死（含 `body.error` wire 契约），事务内层删除即改错误契约 | — |
| C4 | #14 companion-rebind 12 项 `||` 链"三证删一" | **证据否决**：该链是跨 4 份记录（binding/intent/predecessor/eligibility）的**必守一致性断言合取**，每条是不同配对关系，非同一事实副本；删除任一条即削弱篡改检测 | — |

C1 微差异（均在可达状态等价或 fail-safe 方向）：① dispatch `beforeRename` 中路径断言与锁归属重验顺序互换（并发双违例时错误码优先级不同，提交点语义更强）；② dispatch 读阶段 dirname 断言移入 `afterRead`（纳秒级窗口，外层断言已先行拦截）；③ result-bus 锁清理改为 close 吞错 + unlink 必定尝试（原为合并 try；新语义更少残留 `.lock`）。

| 批次 | 内容 | 结果 | 语义变化 | 回滚方式 |
|---|---|---|---|---|
| B0 | 基线采集 + 本报告骨架 | 完成 | 无 | 删除新建文件 |
| B1 | 授权谓词收敛：`scopeSatisfied`/`authExpired`/`wwwAuthenticateChallenge`（三档逐字变体）收进 `tool-shared.ts`；3 份 `requireScope` 定义→1 共享+2 薄委托；3 份 `authorizeNow`→共享判定+各留一行抛错；5 处内联 scope 判定改谓词 | 完成（8 文件） | 无（错误码/文案/_meta 逐字不变；修复一次 `_meta` 包装回归后复测全绿） | git checkout 单文件清单 |
| B2 | 常量时间比较 4→1（canonical `auth/store.safeEqual`；`hashEqual` 保留导出名；pairing 摘要比较转 hex safeEqual）；HEX64 11→1（新 `src/core/hex.ts`，零依赖，result-bus fence 兼容）；64KiB 5 处→单一来源 `EXECUTOR_MESSAGE_MAX_BYTES`（Python/wire 异语义保留）；单飞常量 2→1 | 完成（18 文件） | 无 | git checkout 单文件清单 |
| B3 | 同同步窗口重复检查裁剪（5 项候选） | **逐点核实后全部保留**（见 §6） | — | — |
| B4 | 冻结 route 比对模板 4→1（同文件 `assertFrozenSendTarget`）；dispatch `assertHex64` 改共享 HEX64 | 完成（2 文件） | 无 | git checkout 单文件清单 |
| B5 | Companion 双查提取 / rebind 三证删一 / Result Bus 单飞事务内层 | **仅记录**（§7） | — | — |
| B6 | 文档收敛 + 本报告 | 完成 | 无 | git checkout |
| B7 | closeout：数据汇总 + typecheck/build/diff-check + 单次全量 | 见 §8 | — | — |

### 回滚机制（通用）

1. 每批开工前 `git status --porcelain` + `git diff -- <本批文件>`；非空则存批前快照 patch 到仓库外 scratch（如 `../c2c-audit-rollbacks/`，不进仓库）。
2. 回滚路径 A（批前 clean）：`git checkout -- <本批文件清单>`（绝不动清单外文件）；路径 B（批前 dirty）：`git apply -R batchN.patch`；untracked 新文件（`src/core/hex.ts`、`docs/security-gate-audit.md`）直接删除。
3. 禁止 `git reset` / `git stash` / 全仓 checkout / clean / commit。多批共享文件按批序反向回滚（后批先回）。

## 6. 移除前后风险对比（含 B3 核实证据）

### 6.1 B3 五项"删层候选"核实结论（全部不满足删层判据，保留）

| # | 候选 | 核实发现的真实边界 | 结论 |
|---|---|---|---|
| #11 | result-finalization.ts `:161` 与 `:143` 复核 | `assertFinalizationDeliveryStable` 重读磁盘投递状态；`:162` 紧随的 `appendTrustedReceiptLocked` 是 commit 点，`:161` 是其前置漂移防线（跨进程可写 desktop state，执行记录锁不覆盖 desktop 写者）；中间还有外部回调 `beforeReceiptCommit` | 保留（提交点前漂移防线） |
| #13 | desktop/service.ts `replay()` 多次调用 | 5 个调用点分别位于：锁外预检（避免 replay 触发 IPC prepare）、提交锁内（`prepareWithPostResultSettle` await 之后）、commit 失败 catch 回读、accepted/rejected 落盘（`connection.send` await 之后）——每两点之间都有真实 await/IPC 边界 | 保留 |
| #15 | `:217`/`:230` 重复 enabled/binding 检查 | `:226` 注释即合同："提交点前在短锁内重新读取授权和绑定，防止旧快照越过撤权"；`:230` 位于 IPC prepare await 之后的提交锁内，是 TOCTOU 边界本体 | 保留 |
| #16 | desktopCompatibility 二次 verifyAccessToken | 函数接收**原始 token 字符串**（输入边界校验）；且 bearerAuth 中间件与工具处理之间存在 MCP 调度异步边界；内层 `expiresAt <= Date.now()` 在精确过期时刻比 verify 更严格（删=微幅放宽） | 保留 |
| #18 | executor_send 6 次 token 校验 | 工程约定冻结序列（require scope → authorizeNow → executorAuthorize → derive request authority → beginExecutorDispatch）；pre-pin 校验必须先于 planner 主体派生；send.ts:19 的 `authorize()` 为 mailbox 出队路径共用入口；send-time 回调位于 backend 提交点（await 之后） | 保留 |

### 6.2 攻击路径风险对比（收敛前后）

| 攻击路径 | 收敛前拦截层 | 收敛后拦截层 | 层差 | 残余风险 |
|---|---|---|---|---|
| 过期 token 提交 | bearerAuth + requireAuth + authorizeNow + live executorAuthorize（pin 前）+ send-time 回调 + 提交点锁内 | 同左（全部保留；仅判定谓词/文本收敛为共享实现） | 0 | 无变化 |
| 排队期间撤权后出队 | mailbox `verifyAccessTokenHash` + binding 复核 | 同左 | 0 | 无变化 |
| 旧快照越过撤权 | 提交点锁内 `authorized()` 重验 + authorize() | 同左 | 0 | 无变化 |
| route 劫持后 Send | route VERIFIED 门禁 + durable fence + browser 状态机 + 服务端 4 处冻结比对 | 同左（冻结比对模板收敛，检查点 4 个不变） | 0 | 无变化 |
| split-brain 二次 send | dispatch owner + outcome_unknown fail-closed | 同左 | 0 | 无变化 |
| commandId 重放 | replay 五元组 + schema 唯一性 + mailbox 指纹 + dispatch identity | 同左 | 0 | 无变化 |
| 摘要形状伪造 | 11 处 HEX64 独立定义（漂移风险） | 1 处共享定义（一致性↑） | 0（一致性改善） | 无变化 |
| 常量时间比较实现漂移 | 4 份实现（长度语义细节各异） | 1 份 canonical | 0（一致性改善） | 无变化 |

**结论**：所有收敛均为"实现合一"，拦截点数量、拦截时机、错误契约逐字不变；安全风险不升不降，维护一致性提升。

## 7. 未来候选与 C 阶段处置对照

| 候选 | 内容 | 处置 |
|---|---|---|
| #19 | durable store 事务模板 ×6 → 共享原语 | **已完成**（C1，§5.1） |
| #20 | nonce ownership 锁 ×5 → 共享原语 | **部分完成 + 统一否决**（C2：store wx 锁 5 实例已收敛；4 种 ownership 锁是结构不同协议，且 endpoint-switch 被 import fence 钉死自包含） |
| #21 | 行政证据 store 模板 ×4 → 共享 | **已完成**（C3，净删 235 行模板） |
| #22 | TS 内同构 expectation 合并 | **已完成**（C4） |
| #7 | challengeDigest 双查提取 | **已完成**（C4） |
| #12 | Result Bus 单飞事务内层裁剪 | **证据否决**（FEEDBACK_INFLIGHT_FENCE 为对外 wire 合同——`src/bridge/companion.ts` 将 `error.code` 映射到 `body.error` 供 Companion 消费；13 处测试钉死的是合同而非"实现形状"，不可作为冗余放松） |
| #14 | companion-rebind 三证删一 | **证据否决**（16 项 `||` 链是跨记录一致性断言合取，非副本校验） |
| #17 | browser 侧 `liveFenceOk` 同步段重复 re-fence 裁剪 | **代码级证据否决**（2026-10-09 复核 `browser-companion/production-send-runtime.js:215-340`）：无纯同步段重复——`writeCanonicalMessage`/`dispatchNativeSend` 的入口 fence 与 `mutationGuard` 之间跨 DOM mutation 点（React composer 操作与事件循环让出，页面脚本可导航/换 generation）；`beginSend` re-fence 与上游 fence 之间隔 `waitForSendReady` 真实轮询 await，且 fence 是 `/begin-send` RPC await 前最后一条同步语句。删任一处即开 generation drift 发送窗口 |
| #10 | `isTrustedDesktopReceipt` 手工 8 项与 zod schema 收敛 | **已完成**（2026-10-09）：新增参数化 `trustedDesktopReceiptSchema(commandId)`（src/execution/records.ts），8 谓词逐条 zod 表达、hex 复用 `core/hex.ts`；gate schema `.passthrough()` 与旧手工谓词严格同判（不重复存储层 strict 校验）；函数 boolean 合同不变、13 调用点零改动；9 例翻转/边界等价性测试 + 受影响 7 套件 293 测试全绿 |
| #4 | `userConfirmed: z.literal(true)` 常量共享 | 不实施：仅 3 行字面量，共享属过度抽象 |
| B6-docs | `docs/security.md` "MCP 不是 shell/文件 RPC" 主题表述 | 不实施：经核实为 Gateway/Remote/Desktop/Web 四个信任边界各自的局部合同（非同一语句重复），合并会削弱各节边界语义 |
| 退役类 | `result-bus-delivery.ts` legacy/Bus cutover 历史分类、receipt-finalizer draft v1/v2/v3 兼容 | 保留为未来候选：迁移期代码，待过渡完成后整体退役而非逐条删检查；退役前置门禁见 [runtime-simplification.md](runtime-simplification.md)「legacy 退役前置门禁」 |
| Python 双侧 wire 校验（#22 跨语言部分） | TS/Python 双侧校验 | 不实施：跨信任边界必须双侧 |

**文本 fence 分类核实（2026-10-09，建议 2 落地记录）**：对 `r5b/r5c/r5d1/r5e-architecture` 等文本 fence 逐条核读，断言归两类——(a) 架构边界禁词护栏（`plannerRouteId`/`principalFingerprint`/`feedback`/`readActiveWebSinkBinding` 等，防跨层耦合与信息泄漏）、(b) 安全不变量/安全入口合同（`fsyncSync`/`noWrite`/`openSync wx 0600`/`\.initialized`/`verifyCompanionCredentialForWebSink`/`isWebSinkRouteVerified`/条目上限/状态机字面量）。无"纯实现细节"可放松项：文本 fence 是静态源码扫描机制，字面断言即其工作机制，无法在不改变 fence 物种（静态架构检查→动态测试）的前提下"放松为行为断言"。**结论：0 项可安全放松**，放松即降低架构安全。测试断言三分法原则（wire 合同/安全不变量/纯实现细节）已固化为约定，供未来抽模板重构遵循。

## 8. 性能与瘦身数据

### 8.1 重复实现收敛（核心瘦身指标）

| 指标 | 基线 | 批后 | Δ | 口径 |
|---|---|---|---|---|
| scope 检查逻辑实现 | 8（3 定义 + 5 内联判定） | 1（`tool-shared.requireScope/requireScopeReauth`；其余为一行谓词调用与域错误类薄包装） | **8→1** | `rg "function requireScope"` |
| WWW-Authenticate challenge 文本构造 | 5 处散写（3 种变体） | 1 处（`wwwAuthenticateChallenge`，变体参数） | **5→1** | 人工核读 |
| `authorizeNow` 过期判定 | 3 份拷贝 | 1 份共享 `authExpired` + 3 个域错误类一行包装 | **3→1** | `rg "function authorizeNow"` |
| 常量时间比较实现 | 4 份 | 1 实现（`auth/store.safeEqual`）+ 1 别名（`hashEqual`） | **4→1** | 人工核读 |
| `HEX64` 正则定义 | 11 份 | 1 份（`src/core/hex.ts`） | **11→1** | `rg "HEX64 = /"` |
| 64KiB 同语义上限常量 | 5 处异写法（64\*1024/65_536/65536） | 1 来源（`EXECUTOR_MESSAGE_MAX_BYTES`） | **5→1** | 人工核读 |
| 单飞集合常量 | 2 份 | 1 份（`INFLIGHT_FENCE_STATUSES`） | **2→1** | 人工核读 |
| 冻结 sendTarget 比对模板 | 4 处复制 | 1 helper（`assertFrozenSendTargetMatches`）4 调用 | **4→1** | 人工核读 |
| dispatch 手工 hex regex | 1 处内联 | 0（引用共享 HEX64） | **1→0** | 人工核读 |
| 重复安全实现合计 | **37 处** | **10 处**（含别名/薄包装） | **-27 处** | 上表加总 |

### 8.2 代码量与测试数据

| 指标 | 数值 | 口径 |
|---|---|---|
| 改动文件 | 31 tracked（+143/−121）+ 2 新增（`src/core/hex.ts`、本报告） | `git diff --stat` |
| src 净行数 | ≈ +19（近中性） | 去掉文档后计算 |
| 计划预估 vs 实际 | 计划预估净减 300–400 行（含 B3 删层）；B3 五项经核实不满足删层判据被否决，B5 仅记录 → 实际为"逻辑去重为主、行数近中性" | §6.1 |
| B1 定向验证 | 10 files / 168 tests 全绿（101s） | vitest，--maxWorkers=1 --testTimeout=90000 |
| B2 受影响验证 | 112 files / 2253 tests 全绿（1964.9s） | `vitest run --changed HEAD` |
| B4 定向验证 | 10 files / 283 tests 全绿（190.0s） | vitest 同上 |
| 归一复验 | 3 files / 108 tests 全绿（17.7s） | vitest 同上 |
| typecheck / build / git diff --check | 全部通过 | 每批门禁 |
| closeout 全量回归 | 见 §8.3 | `pnpm test --maxWorkers=1 --testTimeout=90000` |

**说明**：本次"瘦身"的实质是**重复安全实现 37→10（-27 处）**、消除多源漂移风险（如 HEX64 11 处独立定义可能各自漂移），而非行数削减；行数近中性是因为最大额的"删层"候选经证据核实均为真实信任边界（删除会削弱防护），以及共享原语附带的契约注释。这与用户要求第 5 条"不降低系统整体安全性"一致。

### 8.2b C 阶段数据（二次瘦身）

| 指标 | 数值 | 口径 |
|---|---|---|
| 模板重复实现 | 事务模板 6→1、证据 store 模板 4→1、store wx 锁 5→1（`simpleWxLock`） | 人工核读 |
| 新增共享原语 | `src/core/durable-store.ts`（≈200 行）、`src/core/evidence-store.ts`（≈130 行） | 一次性成本，后续新 store 零模板成本 |
| C 阶段净行数 | 40 tracked 文件 +637/−740（净 −103）；含新原语后 src 净 ≈ +230（共享原语是一次性投资，替代的多副本模板约 720 行） | `git diff --stat` |
| C1 验证 | 17 files 全绿（155s） | vitest --maxWorkers=1 --testTimeout=90000 |
| C3 验证 | 7 files 249/249 全绿（复跑） | 同上；首轮 6 个 `desktop-abandonment-repair` 失败定位为 PowerShell ACL 审计 8s 超时的既有环境敏感性（冷启动 ~2.6s），非本次改动，复跑全绿 |
| C4 验证 | 7 files 289/289 全绿 | 同上 |

### 8.3 closeout 全量回归

| 项目 | 结果 |
|---|---|
| 命令 | `pnpm test --maxWorkers=1 --testTimeout=90000`（唯一一次正式门禁，未并行任何其他测试） |
| 结果 | **183 files / 3854 tests 全部通过（0 failed），exit 0** |
| 耗时 | 2338.64s（tests 2115.29s） |
| 历史基线对比 | 记录基线 127 files / 2598 tests / 683–819s（2026-09-30）→ 本次 183 files / 3854 tests / 2338.6s；差异主要来自套件自身增长（近 10 天新增 R5e/安装 GC/supervisor 等批次测试）与机器负载差异，非本次改动引入（本次改动前后定向/受影响集合均在正常时长区间） |
| C 阶段 closeout（二次瘦身） | 同一命令再次执行：**183 files / 3854 tests 全部通过（0 failed），exit 0**，2522.2s（2026-10-09） |

## 9. 保留建议与证据（删除即开洞清单）

> 快照声明：本清单为 2026-10-09 评估记录快照，仅供审查追溯；现役安全边界以 [AGENTS.md「必须保留的边界」](../AGENTS.md) 为唯一权威，本表不作为独立约束源。

以下边界经核实为真实安全边界，**不建议任何移除**；命中测试为回归证据锚点：

| 边界 | 删除后果 | 命中测试 |
|---|---|---|
| 提交点锁内授权/绑定重验证（desktop/service.ts） | 旧快照越过撤权 → 投递到已撤销目标 | desktop-control、command-mailbox |
| mailbox 出队 verifyAccessTokenHash | 排队期间撤权/token 过期后仍投递 | command-mailbox |
| dispatch owner + outcome_unknown fail-closed | split-brain 产生第二次 send | r5e-executor-dispatch、r5e-independence |
| pairing 一次性 + PKCE + 限速 | 配对码暴力破解/授权码拦截 | pairing、oauth |
| stateCorrupt fail-closed | 损坏状态被静默重置 → 证据丢失/ID 重用 | desktop-result、dispatch-store 系列 |
| adminGuard loopback + 代理头拒绝 | 管理面暴露到公网隧道 | bridge 系列、gateway-health |
| route durable fence 仅 re-pair 重置 | 同 challenge 重放 Send | route-attestation（62 项矩阵） |
| begin-send 唯一冻结点 + frozen attempt 不迁移 | Sink 切换后旧载荷发往新 route | r5d2-result-bus-delivery-lifecycle |
| noWrite/replay 幂等合同 | crash-replay 重发/覆盖证据 | r5-result-bus、desktop-result |
| 跨语言 IPC 双侧校验 | 伪造 wire 绕过单侧校验 | desktop_protocol_test.py、desktop-ipc |
| terminal witness HMAC | 伪造"从未观察"结论 | r5h/command-cleanup 系列 |
| daemon 环境投影 allowlist | 密钥/会话上下文泄漏进 daemon 环境 | daemon-spawn、daemon_spawn_protocol_test.py |
| Windows Job fail-closed | 存活独立性错误声明（helper 被父 Job 连坐） | daemon-parent-death、daemon_spawn_protocol_test.py |
| 日志/输出脱敏 + 私钥块拒绝 | 凭据/私钥进入日志与执行输出 | execution-output |
| 审批不自动批准 + 本机确认 | 网页/MCP 越权代行用户意志 | desktop-control、popup-permission |

## 10. 定期审查机制

- **频次**：每季度一次轻量重复扫描（附录 grep 计数，约 30 分钟）；每 2 个 release 或每年一次全量门禁价值复审（本矩阵重评）。
- **检查清单**：
  1. 跑附录 grep 计数命令，任一计数环比上升 >20% 需调查并在矩阵补行；
  2. 新增/修改安全控制的变更必须补矩阵行（门禁ID、目标、处置）；
  3. fence 测试（`r5d1-result-bus-architecture`、`r5e-architecture`、`r5b/r5c-architecture`）全绿；
  4. 冻结门禁清单与 AGENTS.md "必须保留的边界" 一致性 diff；
  5. `docs/security.md` 与实现一致性抽查 2–3 项（每期轮换）。
- **提前触发**：新增/合并安全控制、OAuth scope 或 MCP 错误契约变更、fence 敏感目录（`src/result-bus/`、`src/feedback/companion-*`、`browser-companion/`、`src/executor-control/dispatch-*`）改动、安全事件或接近事件、MCP SDK major 升级。
- **责任**：Planner（规划与 Review）发起并复核矩阵；执行方跑扫描与数据采集；Owner（用户）批准任何冻结门禁语义变更。
- **归档**：审查结论追加至附录"审查记录"小节（日期/执行者/计数环比/结论/行动项）。

## 11. 附录

### 11.1 grep 计数命令

```powershell
rg -c "function requireScope|function authorizeNow|function safeEqual|function hashEqual|HEX64 = /|64 \* 1024|65536|scopes\.includes" src
rg -n "function requireScope|function authorizeNow|function safeEqual|function hashEqual|HEX64 = /" src
```

### 11.2 审查记录

| 日期 | 执行者 | 计数环比 | 结论 | 行动项 |
|---|---|---|---|---|
| 2026-10-09 | Codex | 基线→B7 见 §8 | B1/B2/B4/B6 收敛完成（重复实现 37→10）；B3/B5 核实保留/仅记录；8 项冻结门禁 0 项删语义；closeout 全量 183 files/3854 tests 0-failed | 执行 §10 定期审查；§7 候选待后续授权 |
| 2026-10-09 | Codex | C 阶段见 §8.2b | 二次瘦身：事务模板 6→1、证据 store 模板 4→1、store wx 锁 5→1（#19/#21/#22/#7 完成，#20 部分）；#12/#14 证据否决；closeout 全量 183 files/3854 tests 0-failed | #17/#10/退役类待后续授权；执行 §10 定期审查 |
| 2026-10-09 | Codex | 无新增重复实现（本轮为候选收尾） | #10 已完成（8 谓词 zod 收敛，boolean 合同不变，13 调用点零改动）；#17 代码级证据否决（无纯同步段重复，mutationGuard 跨 DOM mutation 点、beginSend 跨轮询/RPC await）；退役类延后并固化 4 项前置门禁 | typecheck/build 通过；定向 7 套件 293 测试 0-failed；开发迭代未跑全量，closeout 时再跑 |
