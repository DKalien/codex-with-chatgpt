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

旧 reserved/claimed/outcome_unknown 保留原全局 fence、冻结目标及 attempt，只允许按原严格身份 release、exact ACK 或显式 retire；禁止开始、重放或改目标发送。控制通知继续受 Feedback 主体、route VERIFIED、单飞仲裁和 Companion journal 约束。源码升级不自动排空、清理或改写真实机器历史。

旧执行 in-flight 的公开状态携带 `sendAllowed: false`；原 claimed 在公开查询中保守呈现为 `outcome_unknown`，阻止旧扩展继续发送，durable 原状态与 attempt 不变。当前 Companion 恢复仅允许观察和 exact ACK，不再为该历史 journal 铸造发送 proof 或写入 DOM；Bus 和控制通知保留原恢复流程。

相关实现：[Bus 与控制通知](../src/bridge/result-bus-delivery.ts)、[控制投影](../src/feedback/projector.ts)、[Feedback lifecycle](../src/feedback/delivery-lifecycle.ts)。历史 fixture 位于 [tests/helpers](../tests/helpers/)。

## 接口迁移与回滚

- CLI JSON 的 `resultOutbox` 改为 `resultReconciliation`；成功值不再提供 `outboxEntryId` / `outboxReplayed`。外部脚本应读取 `resultReconciliation.status` 与 `resultBus.projected/replayed`，不能继续判断 shadow 的 `resultBus.status`。
- 源码调用方直接使用 `codexDesktopAdapter`；需要测试替身时仍显式传入 adapter。Plugin registry 仅校验发现/检查合同，不能提供备用 raw send。
- 旧 schema、历史读取及 cleanup 合同继续保留。需要旧写行为时只能经明确的版本回滚流程恢复兼容 release；新源码不提供 compatibility writer，也不自动安装或降级。回滚前必须核验前向状态兼容性与 release 引用，不能把新控制事件交给不支持它的旧运行时。
- OAuth scope、owner/project/workspace/version/hash、本机 binding/enable、审批、防重放、`outcome_unknown` 和真实 commandId receipt 门禁保持。查询快照不是发送授权，`accepted` 不是执行完成。

## 验证范围

定向回归覆盖精确身份漂移、Bus 故障及重放、提交响应丢失、cleanup 交错、控制提醒投递和旧执行结果禁止新发送；正式门禁仍为 `pnpm test --maxWorkers=1 --testTimeout=90000`，另运行 typecheck/build/diff 检查。实验性并行清单仍保持独立审计门禁，不因本次精简重新启用。

2026-10-08 源码验收：正式串行回归 180 个文件、3,806 项测试全部通过，退出码 0，耗时 2,129.04 秒；typecheck、build 和 diff 检查通过。回归包含构建后的 classic Browser Send 行为及 Python helper 离线协议验证。`src/` 与 `browser-companion/` 合计净减少 326 行，未新增依赖。

本次没有安装 release、重启当前 Bridge、迁移真实历史或执行真实网页 Send，也没有 commit/push。回归中仍有既有的 `route-esm.js` 引用 `route.js.map` 缺失提示，未导致测试失败，本次不扩大范围处理。
