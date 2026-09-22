# C2C Agent Protocol

Control plane: the current Codex agent's in-app browser (structured ChatGPT UI messages).
Data plane: MCP (ChatGPT pulls files, diffs, search results itself).

Never mix the two: control messages carry task intent and state, never file bodies or logs.
The original `[C2C]` flow below is Normal Mode. Optional `[C2C_CONTROL]` is separate.

## States

```
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

| State | Sender | Meaning |
| --- | --- | --- |
| INIT | Codex | New task; asks ChatGPT to inspect + plan |
| PLAN | ChatGPT | Executable plan for the next iteration |
| EXECUTING | Codex | (optional) execution in progress |
| EXECUTED | Codex | Iteration finished; metadata only |
| REVIEW | ChatGPT | (implicit) ChatGPT is inspecting via MCP |
| DONE | ChatGPT | Success criteria met |
| BLOCKED | ChatGPT | Cannot proceed; contains reason |
| ERROR | either | Protocol/infrastructure failure |
| HANDOFF | Codex | Continuation brief sent to a replacement conversation |

There is no `STATE: RESUME`. If Codex restarts mid-task, it reads a **local
checkpoint** on the session file (`protocolState`, `waitingFor`, goal, issues,
next step). Those values are not ChatGPT protocol states. ChatGPT still sees
only the table above. If the original chat is gone, Codex sends HANDOFF
built from the checkpoint (never from logs).

Local checkpoint values (session only):

| Checkpoint | Meaning |
| --- | --- |
| `INIT` | INIT sent; waiting for PLAN |
| `PLAN_RECEIVED` | PLAN in hand; not finished executing |
| `EXECUTING` | Codex is applying the current PLAN |
| `EXECUTED_LOCAL` | Recorded locally; EXECUTED not yet typed |
| `EXECUTED_SENT` | EXECUTED typed; waiting for review |
| `DONE` / `BLOCKED` | Terminal; DONE should `--clear-checkpoint` |

Legacy sessions without a checkpoint keep the old loop. The first normal
iteration after this version writes a checkpoint automatically.

Do not re-pair, recreate the connector, or rewrite Project instructions
just to resume.

## Message format

Every control message starts with `[C2C]` and key-value headers, then sections.
Keep messages < 1 KB. No diffs, no logs, no file bodies.

### INIT (Codex → ChatGPT)

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
Implement dark mode.

INSTRUCTION:
Inspect the connected workspace through Codex with ChatGPT MCP.
Create an implementation plan for Codex.
```

### PLAN (ChatGPT → Codex)

```
[C2C]
STATE: PLAN
TASK_ID: c2c_f81a
ITERATION: 1

GOAL:
...

RATIONALE:
...

ACTIONS:
1. ...
2. ...
3. ...

FILES_LIKELY_INVOLVED:
...

TESTS:
...

SUCCESS_CRITERIA:
...
```

Plans must be finite, concrete, executable. Not 40-step epics.

### EXECUTED (Codex → ChatGPT)

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
If execution_output lists a readable item for this iteration, list then read it.
If status is restricted, ignore it and review from git_diff.
```

Before sending EXECUTED, Codex records the iteration:
`c2c record --task c2c_f81a --iteration 1 --changed-files ... --tests ... --exit-status ok`
and, when a test/build/lint/typecheck was run, `--command` plus `--output-file`.
ChatGPT reads metadata via `execution_summary` / `test_status`. Command output
is a separate opt-in: `execution_output` (`list` then `read`). Codex nominates
the log; a **local sanitizer** decides whether ChatGPT may see the body
(tokens/paths redacted; private keys withheld entirely; size/line caps).
Restricted items appear in `list` with no body. Old records without output
stay valid. Never paste logs into the control message.

### DONE / BLOCKED (ChatGPT → Codex)

```
[C2C]
STATE: DONE
TASK_ID: c2c_f81a
ITERATION: 3

SUMMARY:
...
```

```
[C2C]
STATE: BLOCKED
TASK_ID: c2c_f81a
ITERATION: 3

REASON:
...

NEEDS:
...
```

### HANDOFF (Codex → new ChatGPT conversation)

`c2c session --json` → `conversation.mode` chooses how chats are grouped.

- **long-chat:** one long-lived C2C conversation per workspace. Codex opens a
  replacement chat only when the user asks, the old chat lags, or the chat was
  lost.
- **project:** one ChatGPT Project (collection) per workspace. A new Codex
  conversation starts a new chat **inside that Project**. The same Codex
  conversation keeps using its saved chat URL.

Right after the boot prompt, Codex sends a HANDOFF so the new chat can
continue — a brief, never a data dump (the new chat re-reads code via MCP).
Project instructions and project-only memory hold durable workspace identity.
HANDOFF still wins for the current task:

Trust order: connector (current code) > HANDOFF (this task) > Project
instructions > Project memory.

```
[C2C]
STATE: HANDOFF
TASK_ID: c2c_f81a
ITERATION: 4

ORIGINAL_GOAL:
Implement dark mode with a persisted user preference.

PROGRESS:
- Iter 1-2: theme context + toggle implemented, reviewed OK.
- Iter 3: persistence added; review found the toggle flashes on load.

CURRENT_STATE:
EXECUTED (iteration 4 fix applied, not yet reviewed).

KNOWN_ISSUES:
Flash-on-load fix needs verification in src/theme/ThemeProvider.tsx.

NEXT_EXPECTED_STEP:
Independently review iteration 4 via git_diff and reply PLAN or DONE.
```

## Loop limits

`maxIterations` (default 12, configurable in `.c2c.json`). When reached, Codex
pauses and asks the user whether to continue.

## Boot Prompt

Send once at the start of every new C2C conversation:

```
You are the planning and review layer of a Codex coding session.

Codex owns execution.
You own high-level reasoning, planning and review.

You have access to the current local workspace through the
"Codex with ChatGPT" MCP connector.

Rules:

1. Do not ask Codex to paste files that are available through MCP.
2. Inspect only the files needed for the task.
3. Use MCP to inspect current code, git status and diff.
4. Produce concise executable plans.
5. Codex will execute your plan using its own harness.
6. After Codex reports EXECUTED, independently inspect the diff.
   If execution_output lists a readable item for this iteration, list
   then read it. If status is restricted, ignore the body and review
   from git.
7. Do not assume an implementation succeeded just because Codex says so.
8. Continue until the implementation satisfies the success criteria.
9. Avoid unnecessary rewrites.
10. Return C2C structured control messages.
11. Be substantive. PLAN and review replies must carry enough signal for
    Codex to act on: rationale, per-file natural-language suggestions
    (which file, what to change and why), risks worth checking, and test
    advice. Never reply with a bare one-liner. Substance over length —
    but do not generate 40-step epics either.
12. If you receive a HANDOFF message, this conversation continues an
    existing task. Trust the handoff brief for history, re-read any code
    you need through MCP, and resume from NEXT_EXPECTED_STEP.
13. If this chat sits in a ChatGPT Project, use only the connector named
    in that Project's instructions. Do not use another workspace's connector.
```

## MCP Remote Control

新增 codex_create_thread / codex_submit_task（codex.control）与
codex_task_status / codex_thread_status（codex.read），仅本地授权后列出。
MCP 写入只完成校验和持久化排队；Controller 异步使用官方 app-server。
创建返回 queued/requestId，按 requestId 查询得到实际 threadId 后才能提交任务；提交返回 queued/taskId。
Controller 使用 initialize、thread/start、thread/resume、turn/start，监听 turn/completed 才判定完成。
重复 ID 返回原记录；模糊执行状态保留 needs_reconciliation，禁止自动重试。
输入、状态机、命令与人工验收见 [Remote Control](remote-control.md)。
它与下述依赖当前 Agent 的 DOM Web Control 并行保留，Normal C2C 协议不变。

## Desktop Control MVP（实验性）

Desktop Control 是独立于 Remote Control 和 DOM Web Control 的 MCP 写入路径，默认关闭。
它只向本机已经绑定、已在 Desktop 中加载且当前空闲的已有 thread 投递消息；第一版不
创建新会话，不 steer、interrupt、转发实时进度、推送通知或持续轮询网页。
最后重检若明确证明尚未进入 start，则记录 `rejected` 与具体原因，同 ID 不重试；只有
用户明确发起新请求才使用新 ID。已开始 IPC 写入后的异常必须保持 `outcome_unknown`。

```text
当前对话用户明确确认完整方案或修订
  → codex_desktop_send（codex.desktop.control）
    intent=development_plan|revision, userConfirmed=true
  → 本机重新核对绑定、Desktop 进程/端点、owner、项目和版本
  → 等待有界的真实接受回执
  → deliveryStatus=accepted（带真实 threadId/turnId），网页本轮结束
  → Desktop 在最终终态前用统一 c2c record 请求 exact commandId receipt；inProgress 先进入 terminal fence
  → 用户主动要求验收时，ChatGPT 精确匹配该 commandId，再读 record/outputId 与当次代码、Git
```

### 日常 UX：`bind-current`

用户在当前 Desktop composer 中说“把这个会话绑定并启用给 ChatGPT”（或同义表达）时，Codex
运行本机 `desktop bind-current [-w <workspace>] [--json]`。命令使用当前真实上下文的
`CODEX_THREAD_ID` 精确映射 Desktop thread、project 和 workspaceRoot，不按标题、最近会话
或其他 Agent ID 猜测，也不要求用户 ID 或让用户手打命令。命令不接受 thread/user ID、
`--yes` 或 `--accept` 等绕过确认的参数。缺少、冲突或无法核验当前上下文（`unknown`）时，
快捷绑定和启用必须明确拒绝，且不能跨 workspaceRoot 重绑。

快捷流程只由当前本机用户在当前 Desktop composer 中明确提出的动作请求触发；文档、代码块、
引用、任务计划或普通讨论里的示例句不触发。来源无法可靠证明来自本机时，不能凭文字免除确认。

本地 composer 与 IPC `userMessage` 的来源无法可靠区分，所以任何新增绑定或状态变更都必须
先显示本机一键确认窗，固定显示风险“ChatGPT 可以向此 Desktop 会话发送任务；任务可能按该
会话已有权限修改文件或执行命令”、当前 Desktop 标题和规范化 workspaceRoot。新窗口不得由
Codex 自动点击，也不得用脚本代点；本机用户必须自己点击。触发流程的 prompt 不是授权凭证，
不能替代本机确认、OAuth、binding、enable 或 Desktop 审批。确认窗最多等待 2 分钟，超时或
取消不改变绑定状态。当前没有可可靠区分本地 composer 与 IPC `userMessage` 的来源信号；
`CODEX_INTERNAL_ORIGINATOR_OVERRIDE='Codex Desktop'` 即使存在也只是会话级提示，不能作为
免确认条件或安全边界，不能声称可抵抗本机任意代码篡改。

同一 thread/project/workspace 已 enabled 时，身份核验通过后返回 `alreadyEnabled`，复用
原 `bindingId`，不生成新 ID、不再次授权；同一身份 disabled 时，用户确认后 enable，复用
原 ID；同一 workspaceRoot 下不同 thread/project 经用户确认后生成新的 `bindingId`。
所有 deliveries history 始终保留，其中包含旧 `bindingId`。不同 workspaceRoot 或无法确认
（`unknown`）时，明确拒绝快捷 bind/enable/send，不能换 ID 或重新绑定绕过。身份核验允许当前
Desktop 为 `active`，但 send 仍必须严格满足 `idle`、无待审批、owner、project/workspace
匹配和已验证版本。

本机用户先用 `desktop bind` 指定真实 `threadId`、`host`、Desktop `project` 和当前
workspace，再用 `desktop enable` 明确接受 Desktop 会话现有权限可能修改文件或执行命令。
重新绑定会生成新的 `bindingId` 并关闭启用状态；网页不能 bind、enable 或调整本机权限。
这组显式命令仍是高级 fallback；不新增 MCP bind 工具。
命令和使用限制见 [Desktop Control](desktop-control.md)。

`codex_desktop_status`（`codex.desktop.read`）只读取当前绑定、可用性和指定投递记录，
不发送消息。发送必须同时满足有效 OAuth `codex.desktop.control`、本机 enable 和匹配
的当前 `bindingId`。`codex_desktop_send` 的 `message` 是完整的已确认计划或修订指令，
投递层将正文封装为固定 `C2C_DESKTOP_TASK`；原正文和包含 envelope/JSON 转义的完整 wire
分别检查 64 KiB（65536 字节）上限，超限拒绝，不能截断或解释成 shell、路径、原始 RPC。
`intent` 必填且只能是 `development_plan` 或 `revision`；`userConfirmed` 必须是字面值
`true`，只有当前对话用户明确确认后模型才能填写，例如用户说“可以，就按这么做”。它只是模型
可填写的语义审计信号，不是授权凭证，不替代 OAuth、本机 enable、bindingId 或 Desktop 审批，
也不承诺能够影响或绕过平台安全策略；完整计划仍可能被 Desktop 或平台策略拦截、拒绝或要求审批。
请求不覆盖 model/provider/cwd/effort/sandbox/approval/permissions 等执行设置。
send 的风险标注保持 `readOnlyHint:false`、`destructiveHint:true`、`openWorldHint:true`、
`idempotentHint:true`；`idempotent` 仅表示同一 `commandId` 防止重复尝试，不是网络 exactly-once。

`accepted` 仅表示投递被 Desktop 接受，不是 `completed`，也不是测试通过。忙、待审批、
无 owner、离线、错项目、workspace 不匹配、提权或版本不兼容时零发送并返回明确错误。
回执超时、断线或落盘不明返回 `outcome_unknown`；不要重发、换 `commandId` 或重新绑定绕过，
整个 workspace（包括新绑定）的后续投递暂停，必须先由本机用户人工核对；MVP 没有自动
恢复或恢复接口。

执行 receipt 只能由统一 `c2c record` 在匹配 delivery.threadId / delivery.turnId 的真实当前
terminal turn 写入；写入前及幂等返回前仍须复核，后续 turn 不能代记。若当前 turn 仍为
`inProgress`，只写入受保护的 pending draft，不产生 trusted receipt；当前 canonical history
无法证明 record 后没有继续的 command/tool activity 时，通过 `FINAL_RECEIPT_REQUIRED` 控制反馈
要求重新只读核对，而不是伪造 `C2C_EXECUTED`。该命令在可证明终态时自动升级为
`desktop_<commandId>` trusted receipt；`desktop record-result` 仍保留为低层/测试/高级显式入口。
控制事件由声明 `feedbackControlEventVersion=1` 的运行中 Bridge 统一投影；detached worker
只持久化 alert，旧运行时保持可读且不会被写入前向事件。维护修复不会删除 alert 或改写绑定状态。
Review 必须从 `execution_summary` 精确匹配该 commandId，再读取 outputId；缺失时明确报告
“本轮验收记录缺失”，不得引用历史 `test_status` 冒充本轮通过。完整 envelope、幂等和输出限制
见 [自动验收记录](desktop-control.md#自动验收记录)。

状态持久化 `commandId`、OAuth `clientId`、`bindingId`、正文摘要、投递阶段及真实
thread/turn ID。必要的这些投递元数据可以由状态查询返回，但状态、日志和
`execution_summary` 不复制完整正文、配置、凭据或 transcript。跨进程锁和原子写保证同
client、同 ID、同参数重放返回原记录，`intent` 或其他参数冲突时拒绝；发送前先保存“可能已发送”，崩溃或
重启不自动重发。这是防重复尝试，不宣称网络 exactly-once。

状态 `revision` 可选；旧记录读取时默认 `0`，读取不迁移或回填。只有正常写入才递增
`revision`，确认提交会核对它以发现确认期间的撤权、重新绑定等 ABA 变化；发现变化时阻断
快捷操作并要求重新确认。

状态格式仍为 `version: 1`。`delivery.intent` 读取时可选，仅兼容缺少该字段的旧记录；新写入
记录必须保存 `intent`。读取不迁移、回填或修改旧历史，旧记录在 `status` 返回中继续缺省
`intent`。使用缺少该字段的旧 `commandId` 再次 `send` 时，无法证明新的 `intent` 与原请求
相同，按 `DESKTOP_COMMAND_CONFLICT` 拒绝，并引导先用 `status` 查看原记录。`outcome_unknown`
阻断规则保持不变。

IPC 只在本机受控使用，Windows helper 使用 `C2C_DESKTOP_PYTHON` 或 `python`，不要求
管理员权限、不启动第二个 app-server/router，也不通过 Tunnel 暴露原始 RPC。只放行已
验证 Desktop/app-server 版本，未知版本停止；Desktop 重启后重新发现进程和 owner。
已知 idle/start 内部协议在检查和发送之间没有原子 CAS，目标可能在窗口内改变，因此回执
不匹配也按未知结果处理。profile 标识与 `override=null` 属于不同字段层次，设置继承只是
源码推断；provider 和服务端最终权限解析可能仍是 unknown，不能据此声称所有权限设置已通过。

自动化假 Desktop/假 IPC 只能验证边界和防重复；真实确认窗口、绑定与投递 E2E 仍需人工验收，
不能据此宣称真实会话已经验证。

## Web Control Mode

默认关闭，只能由当前 Codex **本地用户明确开启**；网页 ENABLE/PAUSE 不在协议内。
Normal `[C2C]` checkpoint 不变，新增 `webControl` 不更新 Normal 的 task/iteration/checkpoint。
同一主代理按顺序处理任务，不并行跑两套协议。

```text
本地 enable + 一次 Control Boot
  → 绑定 Chat 的完整 Assistant COMMAND
  → Agent 核对真实网页用户委派 + CLI 校验并持久化 accepted
  → start / executing → 主代理执行或委派 → c2c record
  → complete / completed → 网页 EXECUTED → 只读 MCP Review
  → 新 COMMAND（同一 task 下一 iteration）或 DONE（继续等待新用户任务）
```

### COMMAND / DONE

一条完整顶层 Assistant 消息，只能包含一个控制块；最多 8192 UTF-8 字节，接受 LF/CRLF
和单个完整的外层 code fence（无语言或 `text`）。固定顺序、字段不重复、无额外字段/嵌套块。
所有 ID 为 1–128 位 ASCII 字母、数字、下划线或短横线；KIND 只允许 TASK/ANALYZE/TEST/REVIEW。
正文三段非空，段内可换行但不能插入空行；段间恰好一个空行，不能夹入额外大写协议字段。
只允许任务级自然语言，不是 Shell/JSON RPC，拒绝 SHELL_COMMAND/EXECUTABLE 等字段。

```text
[C2C_CONTROL]
STATE: COMMAND
CONTROL_SESSION_ID: ctrl_example
WORKSPACE_ID: workspace_example
COMMAND_ID: cmd_unique_001
KIND: TASK

GOAL:
修复已确认的模型切换错误。

INSTRUCTIONS:
保留当前用户修改，按本地规则选择实现和验证方式。

SUCCESS_CRITERIA:
复现用例与相关回归测试通过。
```

DONE 严格使用以下五行，绑定最近完成的 COMMAND，不能关闭整个 mode：

```text
[C2C_CONTROL]
STATE: DONE
CONTROL_SESSION_ID: ctrl_example
WORKSPACE_ID: workspace_example
COMMAND_ID: cmd_unique_001
```

### 本地 CLI 与观察证明

所有日常命令使用已安装的 `node "<稳定 launcher 路径>"`，明确 `-w <workspace>`，返回 JSON。
源码 checkout 入口仅用于明确的开发验证；构建与机器安装的区别见 [架构](architecture.md)。
CLI 只保存/验证任务和元数据，不执行自然语言、不连接浏览器、不监听公网。

| 命令 | 用途 |
| --- | --- |
| `web-control enable --url <实际Chat> --local-user` | 本地用户授权后开启，返回状态和一次 Boot Prompt |
| `web-control status` | 查看有效期、绑定、历史和活动命令；无状态时 disabled |
| `web-control disable --local-user` | 本地关闭，保留历史与在途结果 |
| `web-control boot` / `boot-sent --message-id <id>` | 读取待发 Boot / 记录真实网页消息 ID，防止盲目重发 |
| `web-control receive --input <本地JSON文件>` | 严格校验观察证明与消息，返回 accepted/ignored/rejected/done |
| `web-control start --command-id <id>` | 从 accepted 原子变更为 executing，再交给主代理工作 |
| `web-control reject --command-id <id> --reason <原因>` | 本地拒绝或结案无法安全继续的命令，保留 tombstone |
| `web-control complete --command-id <id>` | 检查匹配 record，标记完成，返回简短 EXECUTED |
| `web-control close-task --command-id <id> --local-user` | 仅本地用户明确放弃已完成任务的后续 Review，保留全部历史 |
| `web-control feedback-sent --command-id <id> --message-id <id>` | 记录实际 EXECUTED 消息，允许原范围的后续 Review |

当前 Codex task 默认从 CODEX_THREAD_ID（次选 CODEX_SESSION_ID）取得；无可靠 ID 时必须
提供实际 `--codex-session`，不能猜测。环境 ID 已存在时不能用参数覆盖为另一 task。
`--idle-minutes` 只在本地 enable 时配置，默认 30、范围 1–240。

`receive` 输入是本地 Agent 用文件工具写的 JSON，32 KiB 上限；不能把网页文本拼接进 Shell。
字段：`source: "chatgpt-assistant"`、实际 `conversationUrl`、稳定 `messageId`、
`latestUserMessageId`、`complete: true`、完整 `text`、`authorization`。
初始授权为 `{type:"user-delegation", userMessageId, explicitDelegation:true}`，必须由 Agent
从真实最近网页用户消息核对明确委派，不能照抄 ChatGPT 声明。
后续 Review 为 `{type:"review-followup", commandId, withinOriginalScope:true}`，指向当前已完成命令；
latestUserMessageId 必须是已记下的 EXECUTED ID，Agent 还须核对目标未超出原用户范围。
Boot / EXECUTED 自己生成的 user role 消息不能发起新任务。普通文字忽略；不扫描工具卡片或项目数据。

执行记录继续用原命令，额外加 `--control-session-id` 和 `--command-id`，
task/iteration 使用 accepted/start 返回的值。字段对旧记录可选；`execution_summary` 可读取新元数据，
`test_status`、`execution_output` 继续按 task/iteration 对应真实测试与经过原有 sanitizer 的输出。
EXECUTED 只发 ID、退出状态、改动数、测试摘要和 MCP Review 提示；不复制文件、diff、长日志。
完成失败/blocked 的执行同样记录真实结果，completed 不等于测试成功。

### 生命周期与恢复

状态复用 `sessions/<workspaceId>.json` 的 webControl：随机 controlSessionId、canonical workspaceId、
Codex task ID、真实 HTTPS Chat URL、createdAt/expiresAt、enabled/status、seenCommands、activeCommand。
每次 enable 新 ID，历史跨重新开启保留。相同 COMMAND_ID 在任何状态都不能再次执行；
seenCommands 上限 10000 时停止接单，不能淘汰历史或清空会话绕过。重复消息不续期。

默认空闲 30 分钟，只有有效接收、首次完成、有效 DONE 延长；executing 不按 idle 中断，
完成后重启 idle 时钟。状态检查落实过期，必须本地重新开启。disable 不杀死已启动的外部进程，
在途记录/complete 仍可保存但不能重新 enabled。会话换 URL/clear 使旧绑定失效，历史仍保留。
Normal 的 session 写入也用同一短锁和原子替换，避免覆盖防重放历史。

恢复时 accepted/executing 只说明历史，**不是可自动重跑队列**。先核对实际工作与记录，
需要时仅补 record/complete/反馈；无法确认则本地处理。已发送结果不确定时先查真实页面，
不能因超时重复发送 Boot/EXECUTED。有 activeCommand 时不能重新 enable 丢弃它。
completed 即使过期/关闭也能补反馈；若无法继续 Review，只能由本地用户明确要求 close-task
后再开启，不能自动结案。本地 reject 消耗本次用户委派，不能用同一用户消息换 ID 重试。
损坏的会话拒绝操作并保留原文件；遗留 .lock 要先核对 PID，
确认原写入者已结束后人工移除，不能删除 JSON。系统不自动清理锁或回滚到可能丢失 ID 的旧状态。

浏览器 wait 每次 20–30 秒，无法可靠等待时以相同间隔轮询；每次检查本地输入与状态。
达到原 maxIterations（默认 12）需本地用户决定继续。主代理必须留在当前 turn，不能发 final
后假称继续监听。**Web Control only works while the corresponding Codex control session remains active.**
不提供后台唤醒、daemon、第二 app-server、`codex exec resume` 或直接子代理调用。
完整操作流程由 [Skill](../skill/SKILL.md#web-control-mode仅本地明确开启默认关闭) 驱动。

## Project instructions

New workspaces store durable identity in the ChatGPT Project settings
(指令), not in every boot prompt. The Skill fills this template once.
Never put a public or temporary URL in the instructions — only the
connector **name**.

```
You are the planning and review layer for one local workspace. Codex executes.

This Project is bound only to:
- Workspace name: {{workspace_name}}
- Kind: {{project_type}} ({{languages}} / {{frameworks}})
- Connector (use this one only): {{connector_name}}

When you call tools, use ONLY that connector. Do not use any other
Codex with ChatGPT connector. If workspace_info names a different
workspace, stop. Do not plan. Do not use this Project's memory.

Read code, git, diffs, and any released command output through that
connector. Never ask anyone to paste file bodies, diffs, or logs. After
EXECUTED, call execution_output (list, then read) when a readable item
exists; if status is restricted, review from git instead. Never upload
the repo into this Project's files or sources.

When facts conflict, trust this order:
1. Current code from the connector
2. A HANDOFF in this chat (this task's goal, progress, next step)
3. These instructions
4. This Project's memory (durable architecture only; stale memory loses)

This Project's memory is only for this workspace. On HANDOFF, trust the
brief, re-read code through the connector, and resume at NEXT_EXPECTED_STEP.

Be substantive: why, which file, what to test. No empty one-liners and
no 40-step epics. Use C2C control messages.
```
