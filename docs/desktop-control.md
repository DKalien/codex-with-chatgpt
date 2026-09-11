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
  → 用户回来要求“干完了，检查一下”
  → ChatGPT 用现有只读 MCP 检查当次代码、Git 和 record
  → 如需修改，向同一个绑定会话发送完整修订指令
```

第一版不提供自动新建会话、steer、interrupt、实时进度、推送通知或网页持续轮询。
`accepted` 只表示 Desktop 已接受投递，不表示任务 `completed`，也不表示测试通过。

## 日常 UX：绑定当前 Desktop 会话

用户在当前 Desktop 会话中说“把这个会话绑定并启用给 ChatGPT”（或同义表达）时，Codex
运行本机命令：

```powershell
node <checkout>\bin\c2c.js desktop bind-current [-w <workspace>] [--json]
```

`bind-current` 使用当前真实上下文的 `CODEX_THREAD_ID`，精确读取对应 Desktop thread、
project 和 workspaceRoot；不按标题、最近会话或其他 Agent ID 猜目标，也不要求用户 ID 或
让用户手打命令。该命令不接受 thread/user ID、`--yes` 或 `--accept` 等绕过确认的参数。
缺少、冲突或无法核验当前上下文（`unknown`）时，快捷绑定和启用必须明确拒绝，转人工处理。

快捷流程只由当前本机用户在当前 Desktop composer 中明确提出的动作请求触发；文档、代码块、
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
node .\bin\c2c.js desktop bind -w <workspace> --thread <threadId> --host local --project <projectId>
node .\bin\c2c.js desktop enable -w <workspace> --binding <bindingId> --accept-desktop-permissions
node .\bin\c2c.js desktop disable -w <workspace>
node .\bin\c2c.js desktop status -w <workspace> --json
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
未绑定时仍只注册原有默认工具；绑定后注册这两个工具，关闭授权后仍可按 read scope 查询，
但 send 会拒绝投递。

`intent` 是必填枚举，只能为 `development_plan` 或 `revision`；`userConfirmed` 必须是字面值
`true`。只有当前对话用户明确确认完整方案或修订后，模型才可填入 `true` 并调用，例如用户
说“可以，就按这么做”。它只是模型可填写的语义审计信号，不是授权凭证，不替代 OAuth、本机
`enable`、`bindingId` 或 Desktop 审批，也不承诺能够影响或绕过平台安全策略；完整计划仍可能
被 Desktop 或平台策略拦截、拒绝或要求审批。

`message` 只能是用户已经确认的完整计划或完整修订指令。它按 UTF-8 原文传递，保留
中文、多行和代码块，正文上限为 64 KiB（65536 字节）；超过上限必须拒绝，不能截断。正文是任务
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
参考版本为 Desktop `26.903.9818.0` 与 app-server `0.153.4`，后续版本需要重新做
兼容性核验。

已验证组合统一保存在 helper 的 `VERIFIED_RUNTIME`：Desktop/package 版本、app-server
二进制 SHA-256、两个协议模块 SHA-256，以及同一安装包的 ASAR 头部布局。2026-09-11
核验确认 ASAR 头部为 2,441,036 字节；原先 1 MiB 解析上限会误报
`DESKTOP_VERSION_UNSUPPORTED`。现改为匹配已验证的精确头部布局，仍逐一验证全部哈希，
未知头部、未知哈希或混合版本继续拒绝。app-server 哈希来自普通权限成功 PoC 的
`binding.json`（output 21/22 关联证据），不是按版本字符串猜测的新白名单。
内部异常可区分 package、ASAR 头部/模块、app-server 不匹配；MCP/CLI 保留统一错误，
不暴露安装路径或内部配置。

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
