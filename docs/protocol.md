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

所有命令使用当前 Fork 的 `node <checkout>/bin/c2c.js`，明确 `-w <workspace>`，返回 JSON。
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
