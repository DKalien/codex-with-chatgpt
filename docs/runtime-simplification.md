# 执行与回流精简合同（2026-10-08）

本文记录当前 checkout 的源码合同，覆盖旧 R4 shadow 双写和 legacy 执行结果发送设计；不证明安装、运行版本或机器历史已经迁移。历史 R4 文件、receipt、cutover 抑制记录和未知发送证据均保留。控制提醒 `FINAL_RECEIPT_REQUIRED` 继续自动回流，不转换成可信执行结果。

## 六项收敛

| 范围 | 当前职责 |
| --- | --- |
| Executor 接口 | Plugin 负责发现、检查及证据；发送只走 production backend 和现有 durable sender。删除 raw `ExecutorPlugin.deliver` 及旧默认 adapter 注册集合。 |
| Desktop 查询 | 共用精确保存 binding 的 target、runtime fence 和返回身份检查。CLI 当前会话、MCP 保存会话及面板的不同业务判断保留；异步查询后仍重新核对授权和绑定。 |
| 提交后投影 | 只处理刚提交的 command；workspace 全量 backfill 用于恢复，后台维护继续有界分批。没有新增持久 cursor。 |
| canonical compatibility writer | 移到 `tests/helpers`，只构造和核验历史 fixture；完整构建排除旧编译产物。新源码没有审计/回滚写入口。 |
| Desktop 结果发布 | trusted receipt → canonical RoutingResult → Result Bus。新结果不再新增 R4 outbox entry。 |
| 旧执行结果退役 | 新执行结果只由 Bus 投递；旧 Feedback 自动发送仅保留控制提醒。历史执行结果禁止新领取、预约或 begin-send。 |

## 结果提交与恢复

`prepareResultReconciliation` 在可信 receipt 提交前持久化恢复意图。receipt 与 RoutingResult 落盘后，先释放该阶段的 records/command 锁，再重新取得同一个 command 的生命周期权限、重读 source 并幂等写入 Bus；Bus 成功后才清除恢复项。

Bus busy、损坏、不可变摘要冲突或清除恢复项失败均返回 `reconciliation_needed`。record、finalizer 和显式 reconcile 返回非零退出码，保留已提交 receipt/result；不得换 commandId 或重新发送任务。相同结果重放不重复追加。两阶段之间已清理的 command 不重建。

恢复项继续复用既有独立文件 `<workspaceId>.result-reconciliation.json`，避免新增持久状态。历史 `<workspaceId>.result-outbox.json` 的旧 entries 仍可供严格读取、历史清理和审计，但不再是新结果提交的完成条件。只读 `desktop result-reconciliation-status` 查询成功仍退出 0，并用 count/items 明确报告 pending；查询成功不表示结果已经入 Bus。

相关实现：[reconciler](../src/routing/execution-result-reconciler.ts)、[单 command 投影](../src/result-bus/service.ts)、[恢复意图](../src/routing/result-outbox-store.ts)。

## 控制通知与历史证据

生产 Feedback projector 只产生 `FINAL_RECEIPT_REQUIRED`。旧非 routed execution records/output 保留本机读取，停止新增旧 `C2C_EXECUTED` Feedback 事件。canonical 和 official 结果保持各自证据来源，经 Bus 发送。

历史 canonical queued/ready 事件由原 cutover 合同精确匹配并永久归 Bus 所有；observed/retired 的永久抑制继续生效。无法匹配可信 Bus 结果的历史执行事件通过 `legacyDrainRequired` 布尔值与 `legacyDrainPending` 数量只读报告，不暴露其他 route 的任务身份；没有控制通知可领取时，旧执行结果不能充当 fallback，返回 `RESULT_BUS_LEGACY_DRAIN_REQUIRED`。

旧 reserved/claimed/outcome_unknown 保留原全局 fence、冻结目标及 attempt，只允许按原严格身份 release、exact ACK 或显式 retire；禁止开始、重放或改目标发送。控制通知继续受 Feedback 主体、route VERIFIED、单飞仲裁和 Bridge 持久 attempt 约束；轻量 Companion 只观察原 attempt，浏览器 journal/proof 链仅保留旧兼容。源码升级不自动排空、清理或改写真实机器历史。

旧执行 in-flight 的公开状态携带 `sendAllowed: false`；原 claimed 在公开查询中保守呈现为 `outcome_unknown`，阻止旧扩展继续发送，durable 原状态与 attempt 不变。当前轻量 Companion 对旧执行 attempt 仅允许观察和 exact ACK，不写入 DOM；旧兼容链不再为该历史 journal 铸造发送 proof。Bus 和控制通知按 Bridge 持久 attempt 的原恢复合同执行。

相关实现：[Bus 与控制通知](../src/bridge/result-bus-delivery.ts)、[控制投影](../src/feedback/projector.ts)、[Feedback lifecycle](../src/feedback/delivery-lifecycle.ts)。历史 fixture 位于 [tests/helpers](../tests/helpers/)。

## 网页完成信号与固定通知（2026-10-10）

新 Result Bus attempt 在首次 `reserved → claimed` 的原事务内固定 `messageFormat: signal-v1`。Bridge 的 begin-send 与 state 恢复载荷只返回结构化 `signal`（`type: execution_ended`、`version: 1`、`workspaceId`、`commandId`、`taskId`、`attemptId`）和 `messageSha256`，不发送通知文本或执行详情。Browser Companion 使用自己的固定模板生成三行通知；Bridge 持久 attempt 是发送与恢复权威，轻量版按单次授权发送、观察原 attempt 并 exact ACK，旧兼容版仍使用原 journal/proof 流程：

```text
本轮执行已结束，请读取结果（自动通知，非新授权）。
WORKSPACE_ID: <workspaceId> | COMMAND_ID: <commandId> | TASK_ID: <taskId>
ATTEMPT_ID: <attemptId>
```

通知只唤醒网页读取结果；所有 canonical `ok/failed/blocked` 与 official `completed/failed/cancelled` 使用相同中性正文，不表示业务完成、测试通过或用户新授权。完整 `rawSummary`、`machineEvidence`、测试与输出仍留在原结果存储，通过只读 MCP 查询：官方任务按 `workspaceId/taskId` 调用 `codex_task_result`；Desktop 按同一 workspace 与 exact commandId 核验 receipt、`test_status`、`execution_summary` 和 `execution_output`。网页无需处理完整结果来拼通知。

纯模板模块由 Browser 所有；Bridge 只共享 renderer 计算现有正文 hash。`signal-v1` 正文与字段规范必须冻结；后续文案或规范改变需引入新格式版本并保留旧模板重建，不能把它当作可随意替换的 UI 文案，否则在途 attempt（包括旧兼容 journal）与正文 hash 将不一致。信号字段、模板版本或 attempt 不符时停止发送，route VERIFIED、冻结目标、Bridge 持久 attempt、防重复和送达证明仍按原合同执行；旧兼容 journal/proof 不成为默认轻量版的发送权威。没有新增推送信道、自动重试或文本 fallback。

缺失 `messageFormat` 的历史 claimed/outcome_unknown attempt 继续生成原 canonical/official 正文与原 hash；读取和 claimed 精确重放不补写字段、不换 ID、不改原状态字节。旧 queued/reserved 尚未开始发送，在新运行时首次 begin-send 时才选择 `signal-v1`。`FINAL_RECEIPT_REQUIRED` 控制通知保持原文字与授权边界。

部署需协调 Bridge、Gateway 与支持信号模板的 Browser Companion：旧网页遇到信号应 fail closed，需显式 Reload 后再按原 attempt 恢复；禁止自动退回文本或新建 attempt 来规避版本差异。新字段会被旧运行时 strict schema 拒读；已产生 `signal-v1` 状态后不能直接回滚到不支持该字段的 release，也不得删除字段伪装 legacy。源码构建不代表安装或在运行服务已升级。

相关实现：[冻结格式](../src/result-bus/delivery-lifecycle.ts)、[信号载荷](../src/bridge/result-bus-delivery.ts)、[网页模板](../src/browser/completion-notification.ts)。

## 当前项目历史格式化

格式化按本机授权和精确预览确认清空当前 workspace 历史，保留连接、配对、绑定及其他 workspace。快照列出实际输出正文和已完成修复档案，不另设文件总数上限；每项仍校验路径、指纹和重复项。执行输出原有的保留数量策略不变。

轻量网页在确认请求发出前持久化 workspaceId 与确认摘要；响应丢失只读查询原摘要，不自动重新提交格式化。仅 Bridge 返回精确匹配的 `noMutation:true` 拒绝证据时移除本轮待确认标识；`cleaned` 结果才清理该 workspace 的浏览器历史与 pending 标识。未知、错误或身份不匹配保留待核验状态。旧兼容 SW 的 intent 撤回流程仅用于原入口。

相关实现：[工作区格式化](../src/command-cleanup/workspace-history.ts)、[轻量网页操作入口](../browser-companion/bridge-operations.js)；旧 `service-worker.js` 仅保留兼容入口。

## 轻量 Companion 与当前部署（2026-10-13）

默认 manifest 已切换到 `bridge-client.js`、`content-lite.js` 与轻量弹窗，网页只连接、操作 DOM 与回报观察；Bridge 承担全部安全判定。旧 SW/proof/fence/journal 链保留兼容回归，不再是默认运行链。源码合同、正式门禁、已安装/运行 build、Desktop 本机重新确认与用户网页复核统一见[轻量 Companion](companion-lightweight.md#部署与验收观察快照)，下方旧部署记录只代表各自标注时点。

真实 Desktop task delivery、DOM Send 与双 workspace Send/observed 仍未完成；浏览器运行版本直接核验和 PowerShell 显式代理 TLS EOF 原因也仍待定位。当前状态可用及用户面板反馈不替代真实发送验收。

## legacy 退役前置门禁（2026-10-09 固化，退役延后）

legacy/Bus cutover 双轨、receipt-finalizer draft v1/v2/v3 兼容等退役类代码为迁移期代码，暂不逐条删检查。整体退役须先达成以下前置门禁，全部满足后再单独立项执行；未达成前保持现状：

1. M4/M5 双项目真实 Send/observed 与同一插件双项目验收完成（见[统一 Gateway 计划](unified-gateway-plan.md)）。
2. `legacyDrainPending` 清零：无可匹配可信 Bus 结果的历史执行事件遗留。
3. 49 条 suppressed 历史 Bus 与 14 条 exact abandonment 走 exact manual cleanup 方案（绝不自动删历史；涉数据完整性，须逐条核验身份后人工处置）。
4. receipt-finalizer draft v1/v2/v3 无存续消费方。

退役是删除迁移期代码与历史兼容读取，不降低任何 AGENTS.md「必须保留的边界」门禁。

## 接口迁移与回滚

- CLI JSON 的 `resultOutbox` 改为 `resultReconciliation`；成功值不再提供 `outboxEntryId` / `outboxReplayed`。外部脚本应读取 `resultReconciliation.status` 与 `resultBus.projected/replayed`，不能继续判断 shadow 的 `resultBus.status`。
- 源码调用方直接使用 `codexDesktopAdapter`；需要测试替身时仍显式传入 adapter。Plugin registry 仅校验发现/检查合同，不能提供备用 raw send。
- 旧 schema、历史读取及 cleanup 合同继续保留。需要旧写行为时只能经明确的版本回滚流程恢复兼容 release；新源码不提供 compatibility writer，也不自动安装或降级。回滚前必须核验前向状态兼容性与 release 引用，不能把新控制事件交给不支持它的旧运行时。
- OAuth scope、owner/project/workspace/version/hash、本机 binding/enable、审批、防重放、`outcome_unknown` 和真实 commandId receipt 门禁保持。查询快照不是发送授权，`accepted` 不是执行完成。

## 验证范围

定向回归覆盖精确身份漂移、Bus 故障及重放、提交响应丢失、cleanup 交错、控制提醒投递和旧执行结果禁止新发送；正式门禁仍为 `pnpm test --maxWorkers=1 --testTimeout=90000`，另运行 typecheck/build/diff 检查。实验性并行清单仍保持独立审计门禁，不因本次精简重新启用。

2026-10-11 本轮验收：启动回执改为原子发布，WMI 直接复用创建时进程证据；格式化移除快照文件数上限，并撤回本地已拒绝、尚未发送的本轮请求凭证。生产代码净增 13 行，无新增依赖。typecheck、build、diff 检查通过；格式化与浏览器定向回归 188 项通过，Python daemon/Desktop 协议分别 29/89 项通过。

ACL 修复前的正式串行全量：185 文件、3,982 项测试，3,973 项通过、9 项失败，退出码 1，耗时 2,210.45 秒。其后修复 4 项旧文本响应合同断言及 1 项固定字符窗口定位，三文件定向复验 72/72 通过；生产实现未为兼容旧测试恢复文本响应。当时剩余 4 项为 supervisor Windows ACL 子进程 8 秒超时，该次验收未通过，失败现场保留。

ACL 修复仅将子进程预算从 8 秒调整为 15 秒，`ACL_SCRIPT` 本体不变，无新增门禁。定向回归 42 项通过（18 项 mock、24 项 store）；修复后唯一一次正式串行全量为 185 文件、3,984 项全部通过、0 失败，退出码 0，耗时 2,194.85 秒。typecheck、build、diff 及上述 Python 29/89 项结果继续有效，未因纯文档同步重跑。

Core `29070c2a3bf925ca56a6f63c6925ea887c47564409a00ec2b2732ec5abc14848` 已完整安装，Bridge（PID 100272）与 Gateway（PID 151988）均运行此 build。现场安装 rollout 的 named 健康检查及旧 Gateway 清理最初失败；Bridge 通过认证 `tunnel/start` 恢复 named，诊断未再次重启 Bridge；Gateway 经双 native 死亡证明与稳定快照，将两条 stale owner 记录 rename 归档后合法冷启动。最终 rollout 为 current 1、pending 0、error 0，`upgradePending=false`。2026-10-11 12:29（UTC+8）现场验证 Bridge 公网 health、Gateway 本机 health 和公网 OAuth metadata 返回 200；真实 OAuth 工具可列出两个 workspace，本对话 Desktop 状态为 enabled/available 且 unresolved=false。

14 份受保护文件中 13 份 hash 未变；`auth/gateway.json` hash 已变化，当前 client、13 个 scopes 及真实 OAuth 工具可用已核验，未清空或重配授权。没有部署前 token 字段快照，不据此断言变化的唯一原因或完全字节保留。用户已确认扩展 Reload，未获取实际浏览器运行产物 hash，也未执行真实 DOM Send。当前 Codex 连接的一次 `feedback_companion_status` 返回 MCP internal error，尚未在真实 ChatGPT 页面核验原因；未为此改生产实现或降低主体门禁。本轮未迁移或清理业务历史，未 commit/push。

### 三合一验收与部署（2026-10-11）

Bridge/Gateway 合并为单一 Node owner，机器与已登记 workspace 的原域名共用一个 named Cloudflare tunnel；各 workspace 仍使用独立 Bridge 模块、loopback admin listener 和原状态目录。OAuth、绑定、历史和 workspace 授权隔离保持，不新增依赖或任务队列。上述 12:29 的两个独立 Node 进程快照已被本轮统一部署替代。

首次正式回归为 188 文件、4,051 项断言全部通过，但 Vitest `onTaskUpdate` RPC 超时导致退出码 1，门禁未通过且原证据保留。假 native probe 补充 `setImmediate` 等待，与真实子进程 I/O 一样让出事件循环，保留真实 ACL 检查；两个最长用例定向通过后，重新执行正式串行门禁：188 文件、4,051 项全部通过，无未处理错误，退出码 0，耗时 2,293.28 秒。typecheck/build/diff 检查通过；Desktop/daemon Python 协议分别 89/29 项通过。

Core `6eab64df6598f1db933ec3ea0a72bd1bf177d9211e3b1ad6a2c9f13e0a83219c` 经既有安装入口部署。一次性迁移在旧 owner 退出后遇维护锁重入，未写配置；释放锁后复用原 configure 与 explicit lifecycle 入口完成恢复，临时工具也已修正。旧 Bridge/Gateway 与各自 owned children 退出已取得 native missing 证明，不按旧 PID 强杀或清除未知锁。Cloudflare 中机器域名及两个 workspace CNAME 现均指向原机器 tunnel；原 workspace URL 和 OAuth issuer 保持不变。

15:38（Asia/Shanghai）现场验收：Gateway/Bridge 共用 PID `172536`，管理端口 `48765`、共享入口 `48766` 均仅监听 loopback；cloudflared `175252` 与 tunnel-client `151324` 经 exact native identity 核验。16 项 HTTP 检查全部通过：原 workspace 公网 health 与两个 OAuth discovery 返回 200，未认证 MCP 返回 401，公网 admin/internal 与未知 Host 返回 404；`nx-quotation-system` 保持停止、原域名返回 503。真实 OAuth Connector 可列出两个原授权项目，Desktop 保持本对话绑定且 enabled/available、无未决投递。15:32 的迁移后独立快照中，47 份授权、绑定、历史与 registry/key 文件缺失 0、hash 变化 0。真实 Connector 查询后的最终复核中，其余 46 份仍未变，`auth/gateway.json` hash 已变化；4 个 auth store 的客户端、workspace 和 scope profiles 均与部署前一致，不据此断言 token 文件字节不变或变化的唯一原因。无关系统 Cloudflared 服务仍为 PID `4772`。

公网探针的 Python 默认 User-Agent 被 Cloudflare 返回 403/1010，Node/浏览器 User-Agent 返回 200；验收探针已按 Node 请求复验，未改变 Cloudflare 安全配置。本机 PowerShell Host 请求需 `-NoProxy`，避免系统代理把它转为公网请求。`status.bridgeProvenance` 的 conflict 对应保留的旧独立 Bridge 证据；统一 owner 的身份以 Gateway native/runtime 与 hosted workspace 合同核验，不删除历史诊断记录。

本轮未执行真实任务发送、Browser DOM Send 或双项目 Send/observed，也未新增开机自启、异常退出 watchdog、commit 或 push。部署与验收证据保存在 ignored `.tooling/unified-service-20261011/root/`，纯文档收尾不重跑代码回归。

2026-10-08 源码验收：正式串行回归 180 个文件、3,806 项测试全部通过，退出码 0，耗时 2,129.04 秒；typecheck、build 和 diff 检查通过。回归包含构建后的 classic Browser Send 行为及 Python helper 离线协议验证。`src/` 与 `browser-companion/` 合计净减少 326 行，未新增依赖。

2026-10-08 验收没有安装 release、重启当前 Bridge、迁移真实历史或执行真实网页 Send，也没有 commit/push。回归中仍有既有的 `route-esm.js` 引用 `route.js.map` 缺失提示，未导致测试失败，本次不扩大范围处理。
