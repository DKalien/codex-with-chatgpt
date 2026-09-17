# 实验性 Desktop Control（MVP）

Desktop Control 是默认关闭的 MCP 写入能力。它只把 ChatGPT 已确认的完整计划
投递到本机已经绑定、已经在 Desktop 中加载且当前空闲的会话；它不会创建新的会话。
本功能依赖 Desktop 的版本绑定内部 IPC，不能当作公开稳定 API。

## 用户流程

```text
ChatGPT 讨论并确认完整方案
  → codex_desktop_send
  → Desktop 返回真实投递接受结果
  → ChatGPT 结束本轮，用户在 Desktop 观看执行
  → Desktop 执行 Agent 在最终回复前写入本轮 commandId 的 execution receipt
  → 用户回来要求“干完了，检查一下”
  → ChatGPT 用现有只读 MCP 检查当次代码、Git 和 record
  → 如需修改，向同一个绑定会话发送完整修订指令
```

第一版不提供自动新建会话、steer、interrupt、实时进度、推送通知或网页持续轮询。
`accepted` 只表示 Desktop 已接受投递，不表示任务 `completed`，也不表示测试通过。

## 自动验收记录

投递层为已确认正文添加固定 `C2C_DESKTOP_TASK` 内部 envelope，携带 workspaceId、commandId、
intent；调用方不能覆盖内部字段。replay/hash 仍以原正文为准，完整 wire（包括 envelope 的
JSON 转义）必须满足 64 KiB 限额，外层 IPC JSON 控制行也按现有 512 KiB 限额精确校验；
超限拒绝，不截断。Skill 据此在最终回复前记录本轮结果。

隐藏本机命令 `c2c desktop record-result -w <workspace> --command-id <id> --changed-files "<文件列表>"
--tests "<本轮摘要或 not run>" --exit-status <ok|failed|blocked> --json` 仅接受当前 workspace 的
历史 accepted command。`CODEX_THREAD_ID` 仅为线索；本机命令通过现有受控 Desktop IPC 和
实时状态验证真实 thread/workspace/root、owner/project、版本/hash、执行进程来源以及唯一当前
`inProgress` active turnId；idle 时仅允许 canonical history 最新侧完整且最后一条为 terminal 的
turn。两种情况均必须同时匹配原 delivery.threadId 和 delivery.turnId。
不接受调用方传入 turnId；仅伪造环境变量不足以记录。same thread 的后续 turn、无/多个/
未知 active turn、状态读取失败及 turnId mismatch 都拒绝，且不写 record/output。
disable/rebind 不阻止原 active accepted turn 在最终回复前收尾，其他 turn 不能代记；
写入前和幂等返回前都重新验证 exact result context；只对短暂 STATE_UNAVAILABLE 做有界重试。
进程核验耗时导致旧快照超过 2 秒时，result 路径仅尝试一次新 serial 的新鲜快照并重新核验；
保留原 2 秒快照上限和独立总时限，旧缓存、超时、owner/process 变化仍拒绝。
命令不执行 shell；可用
`--command`、`--output-file`（UTF-8，最多 256 KiB，超限先汇总）、`--exit-code` 保存已执行输出，
沿用 execution_output 的敏感内容过滤。无测试明确记录 not run；changed-files 只列本轮实际改动，
notes 说明已有脏工作区。不会清理旧改动。

记录固定关联 `commandId`、`taskId=desktop_<commandId>`、`iteration=1`。相同内容重试不追加，
冲突拒绝，不覆盖证据。rejected/outcome_unknown/身份未知均不能生成 receipt；记录失败必须报告
“本轮验收记录缺失”，不能宣称闭环完成。没有新增网页写 record 工具，也没有改变 Connector contract。

用户要求 Review 时，先用 `execution_summary` 精确匹配刚才 delivery 的 commandId，再读取对应
outputId 的 `execution_output`。不能把最新 test_status 或历史测试当本轮通过证据；找不到匹配记录
就明确报告“本轮验收记录缺失”，仍可审查 git/diff。投递 accepted 与执行结果始终分别报告。

## 日常 UX：绑定当前 Desktop 会话

新工作区推荐对 Codex 说“启用 ChatGPT 工作流”。现有 Skill 在完成 setup/repair、
session/Project 路由和 workspace_info 校验后，统一调用下方 `desktop bind-current`。
该入口仅编排现有流程，不构成额外授权；本节身份校验、本机确认和投递门禁全部照常执行。
原有单独绑定话术继续有效。

用户在当前 Desktop 会话中说“把这个会话绑定并启用给 ChatGPT”（或同义表达）时，Codex
运行本机命令：

```powershell
node "<stable launcher>" desktop bind-current [-w <workspace>] [--json]
```

`bind-current` 使用当前真实上下文的 `CODEX_THREAD_ID`，精确读取对应 Desktop thread、
project 和 workspaceRoot；不按标题、最近会话或其他 Agent ID 猜目标，也不要求用户 ID 或
让用户手打命令。该命令不接受 thread/user ID、`--yes` 或 `--accept` 等绕过确认的参数。
缺少、冲突或无法核验当前上下文（`unknown`）时，快捷绑定和启用必须明确拒绝，转人工处理。

快捷流程只由当前本机用户在当前 Desktop composer 中明确请求绑定或“启用 ChatGPT 工作流”触发；
非 Desktop 或上下文无法核验时不能完成绑定，Activation 不能报告 Ready。文档、代码块、
引用、任务计划或普通讨论里的示例句不触发。来源无法可靠证明来自本机时，不能凭文字免除确认。

由于本地 composer 与 IPC `userMessage` 的来源无法可靠区分，凡是会新增绑定或改变启用状态
的路径都必须弹出本机一键确认窗。窗口固定显示以下风险和身份信息：

- 风险（固定）：ChatGPT 可以向此 Desktop 会话发送任务；任务可能按该会话已有权限修改文件或执行命令。
- Desktop 标题：当前真实标题。
- workspace：当前规范化的 workspaceRoot。

新窗口不得由 Codex 自动点击，也不得用脚本代点确认；必须由本机用户自己点击确认。用户
说的 prompt 只是触发日常流程的自然语言，**不是授权凭证**，不能替代本机确认、OAuth、
绑定、启用或 Desktop 审批。确认窗最多等待 2 分钟，超时或取消都不改变绑定状态。

当前没有可可靠区分本地 composer 和 IPC `userMessage` 的来源信号。即使会话环境出现
`CODEX_INTERNAL_ORIGINATOR_OVERRIDE='Codex Desktop'`，它也只是会话级提示，不能作为免确认
条件或安全边界；不能声称它能抵抗本机任意代码篡改。

绑定身份按以下规则复用或更新：

| 已核验身份 | 行为 |
| --- | --- |
| 同一 thread/project/workspace，已 enabled | 身份核验通过后返回 `alreadyEnabled`；复用原 `bindingId`，不生成新 ID，不再次授权。 |
| 同一 thread/project/workspace，disabled | 本机用户确认后重新 enabled；复用原 `bindingId`，保留全部 deliveries history。 |
| 同一 workspaceRoot 但不同 thread/project | 本机用户确认后生成新的 `bindingId` 并启用；旧 deliveries history 保留，其中含旧 `bindingId`。 |
| 不同 workspaceRoot | 拒绝当前检查，不执行跨 workspace 快捷重绑。 |
| 任一身份、项目、workspace 或版本无法确认（`unknown`） | 阻断快捷 bind/enable/send，等待本机用户人工核对；不能靠换 ID 绕过。 |

绑定身份核验可以接受 Desktop 状态为 `active`，因为它核对的是当前真实上下文；这不放宽
投递门禁。`codex_desktop_send` 仍必须在发送时严格满足目标 `idle`、无待审批、owner
匹配、project/workspace 匹配以及已验证版本。传统显式 `desktop bind` + `desktop enable`
命令仍保留为高级 fallback；不新增 MCP bind 工具。

## 本机绑定与授权

每个 workspace 只保留一个当前绑定。绑定必须由本机用户明确指定真实 Desktop
thread，并同时核对 host、Desktop project、实际 cwd 和 workspaceRoot；不能按标题、
最近时间或当前开发 Agent ID 猜测目标。

```powershell
node "<稳定 launcher 路径>" desktop bind -w <workspace> --thread <threadId> --host local --project <projectId>
node "<稳定 launcher 路径>" desktop enable -w <workspace> --binding <bindingId> --accept-desktop-permissions
node "<稳定 launcher 路径>" desktop disable -w <workspace>
node "<稳定 launcher 路径>" desktop status -w <workspace> --json
```

`bind` 会生成不可混淆的 `bindingId`，并返回目标名称和 `threadId`。重新绑定会生成
新的 `bindingId`，同时要求重新 `enable`；旧网页请求不能借此转投新目标。网页端不能
执行 `bind`、`enable` 或修改本机权限。

`enable` 的确认含义是：启用期间，获授权客户端可以向这个绑定会话发送任务，任务
可能按该 Desktop 会话已有权限修改文件或执行命令。本机用户可以随时 `disable`。
Desktop 执行过程中需要的审批仍由用户在 Desktop 中处理。
普通 Windows 权限只表示发送进程未提升，不代表 Desktop 使用受限沙箱。历史实验的
`danger-full-access` 属于原会话设置，不是本功能默认值，也不是启用前提；本功能不会复制或开启它。

## MCP 工具与投递条件

| 工具 | 输入 | Scope | 行为 |
| --- | --- | --- | --- |
| `codex_desktop_send` | `workspaceId`、`bindingId`、`commandId`、`intent`、`userConfirmed`、`message` | `codex.desktop.control` | 写入投递请求，返回接受结果 |
| `codex_desktop_status` | `workspaceId` 及可选 `commandId` | `codex.desktop.read` | 读取绑定、可用性和投递状态，不发送、恢复或切换目标 |

两个 scope 独立于 `codex.control`、`codex.read`、默认 5 个 scope 和 `probe.write`。
工具声明与服务端检查必须分别体现 read/write 语义；旧 OAuth token 不会自动获得
Desktop scope。
这两个工具的 schema 始终注册/可发现，避免 Connector 在首次发现时因尚未绑定而永久缓存缺失工具。
发现 schema 不授予调用权限：未绑定时，有 read scope 的 status 只返回未绑定；send 拒绝投递。
关闭授权后仍须有效 read scope 才能查询；发送继续检查全部本机门禁。

## 机器级 Core 与安全滚动升级

安装 Skill 使用机器级稳定 launcher，程序版本共享，workspace 的 OAuth、Connector、tunnel、
session/Project/checkpoint、Desktop 和 records 严格隔离。`runtimeBuildId` 来自实际构建产物，
不同于 Connector contract；单纯内部 build 变化绝不触发 Connector migration 或 pair/OAuth。
launcher 校验并执行机器目录中的不可变 release（含独立依赖）；checkout 只是源码来源。
重新构建或移动 checkout 不会提前启用新代码，只有成功安装并原子切换 current 后才使用新版。
并发 rollout 未取得机器锁时只报告 `rollout_busy`，不会回写虚假的 pending。
本机 `rollout --json` 只重启已认证且健康的 named workspace，保持固定 URL；quick 不自动重启。
当前执行 turn、Desktop busy/approval/unresolved outcome、Remote active/uncertain/queued、配对中或
身份未知均跳过，绝不为了升级打断任务。原 binding/enable、版本/hash、owner、审批、replay 和
outcome_unknown 门禁保持。`status/doctor --json` 的 `runtimeUpgrade` 报告安装/运行 build 与 pending。
第一阶段没有常驻 Supervisor；当前 Review Bridge 按 active 跳过，后续空闲时再受控 rollout。

receipt 机制上线前留下的旧 accepted delivery 不会按时间自动推断完成。必要时可针对明确的历史
`commandId` 执行一次本机核对：

```
c2c desktop legacy-reconcile -w <workspace> --command-id <历史 commandId> --json
```

只读发现使用 `c2c desktop legacy-reconcile -w <workspace> --list --json`，与 `--command-id`
互斥。返回的 `items` 仅含 `commandId`、`status`：`reconciled` 表示现有证据重验通过；
`retired` / `abandoned` 表示已通过对应历史等待处置；`eligible` 表示可显式核对；
`missing_execution` / `missing_output` 表示缺少必要证据；
`conflict` 表示事实不合格或与已存证据冲突。只列出缺失 intent 的 accepted，并排除已有
Desktop receipt 的记录，不返回 thread/turn ID 或消息正文。JSONL、output index 或证据存储
损坏时整个发现失败。list 不写文件、不自动核对、不触发 rollout；发现结果也不代表执行已迁移。

该入口只接受缺失 `intent` 的旧 delivery，并严格要求唯一的终态 execution record、匹配的
`outputId` 与 output index 元数据，以及 execution/output 时间晚于 accepted delivery。核对结果只写入
独立的本机 reconciliation 证据摘要，不伪造 `desktopReceiptSha256`，不修改 Desktop delivery、
execution JSONL 或 output index，也不会触发 rollout。普通 `c2c record`、重复/冲突/损坏/缺证据的
状态继续 fail-closed；当前和未来含 `intent` 的 delivery 永远不能走此入口。

新 reconciliation 证据同时保存严格的 output metadata snapshot。后续每次仍重验 delivery 和
execution record；原 output 仍在 index 时必须与 snapshot 完全一致。只有严格读取的 index
已满 `MAX_OUTPUT_RECORDS`，且最老 retained id 大于原 outputId，才可使用 snapshot 证明正常
retention 淘汰。其他缺失、metadata 变化或 index 损坏仍拒绝。旧证据若没有 snapshot，仍要求
原 output 存在，不自动回填或推断淘汰；显式 CLI 和 rollout 都遵守相同复核。

对没有任何 execution 或对应 orphan output 的 pre-receipt 等待项，可显式使用
`c2c desktop legacy-retire -w <workspace> --command-id <历史 commandId> --json`。
仅允许缺失 intent 的 accepted、有合法 turnId、旧 thread 不等于当前 binding、没有
outcome_unknown 或 reconciliation 证据。必须实时确认旧目标明确 `DESKTOP_TARGET_NOT_FOUND`，
然后确认当前 binding idle；IPC 前后本地事实变化会拒绝。证据独立保存，不改历史，不表示
任务完成或成功，也不补 execution/receipt。list 以 `retired` 单独显示。
每次 rollout 仍检查 retired 旧 thread：明确不存在或 idle 才能继续，active/inProgress 仍 busy，
其它未知状态继续阻塞；当前 binding 永远正常检查。reconciliation 与 retirement 双证据、
损坏证据、后续出现执行证据或旧 thread 成为当前 binding 都 fail-closed。

owner discovery 的精确 `no-client-found` 响应表示没有客户端可处理该 thread，首次发现报告
`DESKTOP_NO_OWNER`，指定 owner 的复核报告 `DESKTOP_OWNER_CHANGED`；它不是 IPC 超时，也不
证明 thread 不存在。global project assignment、磁盘中的终态历史或 `notLoaded` 状态不能
代替当前 Desktop 的新鲜状态证明。

对符合上述 pre-receipt、无 execution/output 资格的 ownerless 历史等待项，可在当前绑定的
Desktop 维护 turn 中显式执行 `desktop legacy-retire --command-id <id> --ownerless`。
此模式只接受经过进程、版本和 project 前后复核的 `DESKTOP_NO_OWNER`，独立证据明确记录
`kind: ownerless`、观测时间和维护 thread/turn；它表示停止把该旧投递视为活动等待项，绝不
表示不存在、完成或成功。普通 retirement 的 missing-target 门槛不变。
maintenanceThreadId / maintenanceTurnId 仅为创建时审计信息，正常 rebind 后不迁移或重写，
也不要求当前 binding 仍等于原维护 thread；当前 binding 仍不得是被处置的历史 thread。
创建及幂等返回前两次 `currentResultContext` 必须证明同一个当前 binding 的 active 维护 turn，
并保留 workspace/project/host/runner/approval/freshness 门禁；此授权仅用于写历史处置证据。
rollout 仍要求当前 binding idle，每次重查旧 thread；只有显式 ownerless 证据才允许无 owner，
owner 恢复且 active/inProgress 时重新阻塞，其他未知错误仍 fail-closed。同一旧 thread 任一
accepted 未被相应处置时不能借用该豁免。list 以 `retired` 表示这一非 completion 处置。

### 显式行政停止等待

`desktop history -w <workspace> --json` 只读列出 accepted 的 `commandId` 与
`receipted / reconciled / retired / abandoned / unresolved` 状态。它与 rollout 共用严格证据
判定，不返回消息正文；损坏或双证据拒绝读取，不把错误当作已解决。

对于本机用户明确决定不再等待的历史 accepted，可以使用独立的行政 abandonment：

```text
c2c desktop abandon -w <workspace> --command-ids <id1,id2,...> --json
c2c desktop abandon -w <workspace> --command-ids <相同精确列表> --confirm <上一步 confirmationSha256> --json
```

第一条只读预览，明确提示“仅停止等待，不代表完成/成功”；第二条才是本机显式确认。
没有 `--all` 或动态候选全选。集合排序并拒绝重复，确认摘要绑定集合和对应不可变事实；
确认后发生变化不能顺带处置新增项。独立 store 原子保存批次与每条 delivery 的摘要，保留
当前维护 thread/turn 的证明，不写 execution record/output，不伪造 receipt，不改写 delivery。

带 intent 的历史 accepted 可以显式 abandonment；当前 binding/current thread、outcome_unknown、
已有可信 receipt/reconciliation/retirement 的条目不允许。维护身份首尾通过 currentResultContext
复核，幂等也重新验证，进程/owner/project/turn 或本机事实变化均拒绝。共享证据锁防止不同处置
同时提交；双证据、损坏、部分写入不覆盖或清理。

行政决定只停止等待列出的旧 commandId。因此它们所在的旧 thread 之后恢复 active，也不撤销
这一决定；当前 binding 仍始终实时检查，新 commandId 仍正常检查，outcome_unknown 仍全局阻塞。
rollout 从不自动生成 abandonment，active/inProgress 时仍禁止重启 Bridge。

## 旧 Connector 兼容检测与迁移

“启用 ChatGPT 工作流”会先检查当前 Bridge 的 `connectorContractVersion: 1` 和只读
`desktopCompatibility.status`。无有效授权、旧默认 scopes、Desktop scopes 不完整、current、
unknown/corrupt 分别处理；两个 Desktop scope 必须在同一有效授权上下文内，不能拼接不同 token。
admin 的 current 仅表示存在一份完整有效授权（含可刷新 grant）；access 到期仍可沿用现有 OAuth
刷新，不因此重建 Connector。`workspace_info` 另返回实际当前请求的
契约版本和兼容状态，两者都必须 current。其他客户端的完整授权不能使旧 token 升级。
这些状态不包含原始 token、secret 或凭据。旧 runtime 缺字段时先按既有流程刷新当前 workspace
runtime 后重查；开发/复核本功能不会自动重启正在服务本次 MCP Review 的 Bridge。

随后在精确当前 Connector 上检查 ChatGPT 实际可见 schema，不调用 send：两 Desktop 工具均需
存在，send 必填 workspaceId、bindingId、commandId、intent、userConfirmed、message，intent 包含
development_plan/revision，userConfirmed 只能为 true。无法读取或归属不明时停止。

本地与网页契约都 current 时不重建；明确 legacy/incomplete 或旧/缺失 schema 才迁移。
legacy migration 遇到 quick 地址时，先升级当前 workspace 的 named 固定地址；健康 named 保持不变。
可复用机器上唯一明确的 zone，但必须为当前 workspace 创建自己的 hostname/tunnel，不能复制其他
workspace 的绑定。zone 不明确只询问一次域名。使用现有 `tunnel choose --mode named --require-named`
严格模式：失败保留原状态并报告未就绪，不 fallback quick、不提前重建 Connector。

固定地址健康后，迁移复用机器 auto/manual 偏好、最终 named mcpUrl 和精确 connectorName，仅同名 Delete + create、
新配对码及 OAuth 授权，不用 Reconnect/Edit、不操作其他 workspace、不创建第二个 Connector。
保留 Project、session、checkpoint、taskId、iteration 及 Project instructions。
迁移后重新 doctor/status，要求 named 健康，再做 workspace_info 身份匹配和 schema 检查，全通过才继续 bind-current/Ready。
unknown/corrupt/mismatch 不得通过迁移清空；不自动批准发送或降低任何原有门禁。

同名 Connector 重建后，原聊天若明确返回 `tool has been disabled` 或仍显示旧 schema，
在本地迁移与授权检查已通过的前提下走 Conversation Rebind，不再次重建 Connector。
Project 模式在原 projectUrl 内新建 Chat，long-chat 复用 switch-chat；boot + 必要 HANDOFF 后，
使用精确 connectorName 重新验证 workspace_info、实际授权和 Desktop schema。
全部通过才只更新 session.url，保留 Project、connectorName、checkpoint、task/iteration 及 instructions。
新聊天验证失败则保留原 URL 并停止，不循环开聊天、不提前绑定或 Ready。

`intent` 是必填枚举，只能为 `development_plan` 或 `revision`；`userConfirmed` 必须是字面值
`true`。只有当前对话用户明确确认完整方案或修订后，模型才可填入 `true` 并调用，例如用户
说“可以，就按这么做”。它只是模型可填写的语义审计信号，不是授权凭证，不替代 OAuth、本机
`enable`、`bindingId` 或 Desktop 审批，也不承诺能够影响或绕过平台安全策略；完整计划仍可能
被 Desktop 或平台策略拦截、拒绝或要求审批。

`message` 只能是用户已经确认的完整计划或完整修订指令。它按 UTF-8 原文传递，保留
中文、多行和代码块；完整 envelope 消息上限为 64 KiB（65536 字节），正文可用空间相应减少；超过上限必须拒绝，不能截断。正文是任务
级自然语言，不能当作 shell、路径、原始 RPC 或工具结果执行。请求不接受或不覆盖
`model`、`provider`、`cwd`、`effort`、`sandbox`、`approval`、`permissions` 等执行设置。
这不保证正文无害：已授权客户端的恶意任务文本仍可能按 Desktop 当前权限和审批流程影响
Desktop 行为；本功能不承诺抵御已经获授权客户端。

`codex_desktop_send` 的风险标注保持 `readOnlyHint:false`、`destructiveHint:true`、
`openWorldHint:true` 和 `idempotentHint:true`；这里的 `idempotent` 仅表示同一
`commandId` 防止重复尝试，不是网络 exactly-once，也不是授权凭证。

发送同时要求有效 OAuth `codex.desktop.control`、本机 `desktop enable` 和匹配的当前
`bindingId`。目标忙、待审批、没有 owner、Desktop 离线、项目或 workspace 不匹配、
提权或版本不兼容时零发送，并返回明确的失败原因；第一版没有“等空闲后自动发送”的
隐藏队列。

投递只等待有界的接受回执。收到真实 `threadId`/`turnId` 后返回
`deliveryStatus=accepted`；不要等待 Codex 完成，也不要把接受回执写成执行完成记录。
回执超时、断线或落盘不明时返回 `outcome_unknown`，提醒不要重发。结果不明期间整个
workspace（包括重新绑定后的目标）暂停后续投递，必须由本机用户人工核对；不能换一个
`commandId` 或重新绑定绕过它。MVP 没有自动恢复或恢复接口。
若最后重检明确证明尚未进入 IPC start（例如刚变忙或出现审批），保存 `rejected` 与明确错误，
同 ID 重放仍返回该拒绝记录。处理原因后只能由用户明确发起新请求；不会排队或自动重试。
任何进入 start 后的断线、部分写入或回执异常都不能归为这种“确定未发送”。

## 防重复与恢复

C2C 自有状态会保存 `commandId`、OAuth `clientId`、`bindingId`、原文摘要、投递阶段及
真实 `threadId`/`turnId`。状态使用跨进程锁和原子写入；损坏时拒绝继续发送，不清空
历史、不重置计数。

同一 client、同一 `commandId` 和同一参数再次请求时返回原记录；同 ID 但 `intent`、目标、
正文或客户端不同则明确拒绝。实际 IPC 发送前先保存“可能已发送”记录，崩溃、超时、断线、
回执丢失或重启都不会自动重发。这个机制防止重复尝试，不能宣称网络上的 exactly-once。
此保证针对进程崩溃与重启；文件 fsync/原子替换不承诺抵御存储设备丢写或历史文件被人为回滚。

状态中的 `revision` 可选；旧记录读取时默认 `0`，读取不会迁移或回填。只有正常写入才递增
`revision`，确认提交会核对它以发现确认期间的撤权、重新绑定等 ABA 变化；发现变化时阻断
快捷操作并要求重新确认。

状态格式仍为 `version: 1`。`delivery.intent` 读取时可选，仅兼容缺少该字段的旧记录；新写入
记录必须保存 `intent`。读取不会迁移、回填或修改旧历史，旧记录在 `status` 返回中继续缺省
`intent`。使用缺少该字段的旧 `commandId` 再次 `send` 时，无法证明新的 `intent` 与原请求
相同，按 `DESKTOP_COMMAND_CONFLICT` 拒绝，并引导先用 `status` 查看原记录。`outcome_unknown`
的 workspace 阻断规则不变。

`disable` 或重新绑定不能撤回已经越过提交点的在途请求，也不能把它伪装成未发送；
状态查询应如实保留该阶段。重新绑定后的新会话必须重新本地授权，且不能绕过 workspace
级别的 `outcome_unknown` 阻断。

## 本机 IPC 与版本门禁

IPC 发送前会重新核验 Desktop 服务进程、端点、owner 和绑定目标的新鲜状态；Desktop
重启后重新发现，不能永久信任旧 PID。已知的 Desktop idle/start 内部协议在检查和实际
发送之间没有原子 CAS，目标可能在窗口内改变；因此回执不匹配或不明时必须按未知结果
处理，不能据此宣称 exactly-once。未知版本停止，不能自动降级验证。本机已验证的
精确组合包括 Desktop `26.903.9818.0` / app-server `0.153.4`，
Desktop `26.908.4834.0` / app-server `0.154.0-alpha.6.2`，以及
Desktop `26.908.9136.0` / app-server `0.154.0-alpha.6.2`；其他组合仍须重新核验。
这不是“所有 26.908 都兼容”，而是三个分别固定的 exact runtime。

已验证组合统一保存在 helper 的 `VERIFIED_PROFILES`，每个协议 profile 包含精确运行时组合：Desktop/package 版本、app-server
二进制 SHA-256、两个协议模块 SHA-256，以及同一安装包的 ASAR 头部布局。2026-09-11
核验确认 ASAR 头部为 2,441,036 字节；原先 1 MiB 解析上限会误报
`DESKTOP_VERSION_UNSUPPORTED`。现改为匹配已验证的精确头部布局，仍逐一验证全部哈希，
未知头部、未知哈希或混合版本继续拒绝。旧组合的 app-server 哈希来自普通权限成功 PoC 的
`binding.json`（output 21/22 关联证据），不是按版本字符串猜测的新白名单。
本地 `c2c desktop compatibility --json` 提供只读兼容性诊断，不绑定、不启用、不投递，
也不修改机器状态。返回 `observedDesktopVersion`、`observedAppServerVersion`、`status`
和匹配的 `profile`，不返回 token、pipe、进程路径或原始 IPC 数据。
`current` 表示精确版本组合及全部 profile 哈希通过；`unverified` 表示观察到的组合没有
已验证 profile；`incompatible` 表示匹配组合的完整性或协议要求不符。无法读取的版本为
`null`，不能猜成已验证版本。诊断成功不代表 owner、项目、运行态或投递权限通过。

`DESKTOP_VERSION_UNSUPPORTED` 保留原错误码，附带同样的安全诊断字段。Activation 应直接
报告实际观察版本；不要把这里的 Desktop 协议 profile 与 OAuth Connector 的
`desktopCompatibility` 混淆，也不能通过重新配对修复协议不兼容。
新增组合必须审计 IPC 请求版本、owner、project/workspace、turn state、current identity、
current execution 和 prepare/send 假设，并固定同一安装包的精确版本及 hash。
协议兼容才复用 `desktop-ipc-v1`；协议变化须新增独立 profile 并保留旧组合。
不接受 wildcard、版本范围或“更新版本默认兼容”。真实投递前先完成只读身份验证，
再经原本的本机确认、OAuth、idle、审批、binding 和 replay 门禁进行最小 E2E。

2026-09-12 升级审计观察到 Desktop `26.908.4834.0`、实际运行 app-server
`0.154.0-alpha.6.2`（直接读取运行文件的静态 provenance 版本标记）。运行中 app-server SHA-256 为
`081e4de4be8e38fac6ed4d95e3b1a0b9f6d31c090ddc36e1696b349fe406f575`；
ASAR 头部为 `(4, 2489280, 2489276, 2489269)`，主模块
`.vite/build/src-CCXHtyvY.js` SHA-256 为
`a42da38cbb14b28399f1d54fcf453bffc5e9802663e7e098f187c8378f4c7a40`。
UI 模块 `webview/assets/app-initial-d9bed9d614d8.js` SHA-256 为
`7c3a89e7e224f76031b45a88f72af8cd60f0c3d47aac9ca34b2c70e11dfe9867`。
静态核验确认请求版本、following/snapshot、owner 和 start 返回结构保持兼容；固定上述
hash 后，在主会话进行真实只读握手，普通权限、runner ancestor、project/workspace、owner、
新鲜 snapshot 及唯一 `inProgress` turn 全部通过，因此该精确组合复用 `desktop-ipc-v1`。
安装包内附 app-server 的 hash 不同，不作为该运行组合的替代项。只读证据不冒充真实 send/receipt E2E。
正式 `current_identity` 与 `current_execution` 也已通过；当前会话为 active，`inspect` 和
`prepare` 均返回 `DESKTOP_BUSY`、`notSent=true`。完整 hash 复核仍逐次执行；只有未知
hash 才额外扫描静态版本标记，避免重复扫描使快照超过原有 2 秒新鲜度限制。

2026-09-17 只读审计新增 Desktop `26.908.9136.0` / app-server `0.154.0-alpha.6.2`
exact 组合。运行中 app-server SHA-256 为
`960c111d47afd61669954b9df9e56083e302edbfa3ef6962d81dcc14a30051dc`；
ASAR 头部仍为 `(4, 2489280, 2489276, 2489269)`。IPC 主模块
`.vite/build/src-CCXHtyvY.js` SHA-256 仍为
`a42da38cbb14b28399f1d54fcf453bffc5e9802663e7e098f187c8378f4c7a40`，
与 `26.908.4834.0` byte-identical；request versions 仍为 initialize=0、
thread-owner-discovery=1、thread-follower-start-turn=2，静态审计未发现
owner/project/workspace/snapshot/following/turn identity protocol change。
UI 模块变为 `webview/assets/app-initial-bcc2ff475eb6.js`，SHA-256 为
`3c15444f96a8d48844258618fe0d4278409e626f0ee563a77d2c669ec669c510`。
app-server provenance marker 改为 compact 形式
`standalonelocal buildversion: `，且 platform delimiter 可为换行；
parser 仍仅接受 exact accepted markers，歧义一律 fail closed。
因为 IPC 协议语义未变，该组合复用 `desktop-ipc-v1`，但 desktop/app-server/module
hash 仍整组单独固定；不接受版本范围、wildcard 或“26.908 默认兼容”。

Windows 受控 helper 需要 Python 3.11 或更高版本，使用环境变量 `C2C_DESKTOP_PYTHON`
指定解释器路径，未设置时使用 `python`；它
只负责必要的标准库 IPC 和身份核验，不要求管理员权限，不借用 renderer/Agent 身份，
不启动第二个 app-server、router 或通用执行器。正文通过 stdin 或受控 IPC 传递，不能
拼接 shell 命令。内部 IPC 只在本机使用，不能把原始 RPC 暴露到 Tunnel。

Desktop 的 profile 标识、`override=null` 和最终权限解析属于不同字段层次；“设置继承”
是基于源码的推断，不是所有设置都能从 IPC 观察到的事实；provider 和服务端最终权限解析
可能仍是 unknown。不要把 provider、模型、sandbox、approval 或其他私有设置复制进请求，
也不要在状态、日志或 `execution_summary` 中返回完整计划、配置、凭据或 transcript；必要的
`bindingId`、`threadId` 和 `turnId` 等投递元数据可以返回。

协议适配参考 `NathanZane/codex-mobile` 固定提交
`f79e6807ca0b9d6052afd24f822ee41b9a52e07d` 中的 `CodexDesktopIpcClient.ts` 和
`platform.ts`，保留其 MIT 许可证与来源说明；不安装 Discord 集成，不运行上游安装脚本，
也不直接用上游 `main` 覆盖本机协议适配。

## 执行记录与人工验收

发送的完整计划中必须明确要求 Desktop 执行后通过现有 `record` 流程，以 `commandId`/`taskId` 关联真实摘要、
测试结果和可读 `execution_output`。投递记录不能冒充执行记录，历史测试也不能作为本次
任务通过的证据。ChatGPT 只有在用户主动回来要求验收时，才通过只读 MCP 检查当前代码、
Git 和相关 record；检查后如需修订，再向同一 Desktop 绑定发送完整的新指令。

这是版本绑定的实验性功能。自动化假 Desktop/假 IPC 测试可以验证边界和防重复，不能
替代人工确认真实 Desktop 的目标可见性、权限提示、执行结果和用户审批行为。

开发回归使用 `pnpm test --maxWorkers=1`；其中 `desktop-python.test.ts` 会调用 Python
标准库 unittest 运行离线 helper 测试，因此测试环境也需要 Python 3.11+。所有 Desktop
自动化用假进程、假 pipe 和隔离状态，不向真实 Desktop 发送消息。
自动化假 Desktop/假 IPC 只能验证边界和防重复；真实确认窗口、绑定与投递 E2E 仍需人工验收。
