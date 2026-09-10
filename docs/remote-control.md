# MCP Remote Control（第三阶段）

| 模式 | 控制路径 | 在线条件 |
| --- | --- | --- |
| Normal C2C | Codex → ChatGPT Planner / Reviewer | 当前本地 Agent 和网页流程 |
| DOM Web Control | ChatGPT COMMAND → 内置浏览器 → 当前 Codex | 对应 Agent turn 正在监听 |
| MCP Remote Control | 任意设备 ChatGPT → HTTPS MCP → durable queue → Controller → Codex app-server | 本机 Bridge、Tunnel、Controller 正在运行 |

Remote Control 不依赖 Codex Desktop 窗口、当前 conversation、in-app browser 或 DOM listener。
电脑需保持运行并联网。没有 ChatGPT 主动推送、远程 Shell、任意路径注册、自动审批或开机启动。
当前开发环境中的 ChatGPT Pro 账户已经实测支持 MCP write actions；不同账户/套餐/rollout 可能不同。
write_probe 仍默认关闭，正式功能不依赖 C2C_ENABLE_WRITE_PROBE。

## 第一次跨设备测试

```powershell
cd D:\python\codex-with-chatgpt
node .\bin\c2c.js remote enable
node .\bin\c2c.js start --tunnel
node .\bin\c2c.js controller start
node .\bin\c2c.js remote status --json
```

如果 PATH 中的 Codex 较旧，可在本地启动时指定 `controller start --codex <codex.exe绝对路径>`，
或设置本地 `C2C_CODEX_EXECUTABLE`。MCP 不能设置该路径。
本开发环境实测可用的启动命令是：

```powershell
node .\bin\c2c.js controller start --codex 'C:\Users\10630\AppData\Local\OpenAI\Codex\bin\fd4c151a749f3ab4\codex.exe'
```

不要照抄这台电脑的路径到其他电脑；升级后使用匹配配置的新安装路径。

确认 remoteControl:true、controller:running、appServer:running、bridge:healthy、tunnel:running。
Tunnel running 表示本地进程状态，外网可达性需实际验证。status 给出的 workspaceId 是 MCP 输入，不能传绝对路径。
在另一台设备的 ChatGPT Plugins 打开对应 Connector，Refresh，应看到原 9 个只读工具加 4 个 codex_* 工具。
授权需 codex.control 和 codex.read；旧 token refresh 不自动增权。提示重新授权时核对工作区与权限，
本机 `node .\bin\c2c.js pair` 取得一次性配对码。随后在新 ChatGPT 对话中说：

> 给当前项目创建一个新的 Codex 会话线程，让它检查 README 与 package.json 是否一致。不要修改文件。
> 用 codex_thread_status 等待 threadId 后提交 ANALYZE 任务，稍后用 codex_task_status 查询。

创建异步返回 accepted:true/status:queued/requestId。按 requestId 查询到 completed 后获得实际 threadId。
提交任务立即返回 taskId/status:queued。turn/start 返回不表示完成，必须等任务终态。
最终 Agent 回答经现有 sanitizer 保存到 execution_output，execution_summary 包含输出 ID。
tests:null、changedFiles:[] 表示 Controller 未自动采集测试与文件列表，需核对输出及 git_diff，不能解读成零修改或测试通过。

## 工具与授权

| 工具 | 输入 | Scope |
| --- | --- | --- |
| codex_create_thread | workspaceId, requestId, purpose? | codex.control |
| codex_submit_task | workspaceId, threadId, commandId, kind, goal, instructions?, successCriteria? | codex.control |
| codex_task_status | workspaceId, taskId | codex.read |
| codex_thread_status | workspaceId, requestId? 或 threadId? | codex.read |

kind 仅 TASK/ANALYZE/TEST/REVIEW；ID 仅 1–128 位字母数字、下划线、连字符，单段任务文本最多 8192 字符。
不接受 cwd、shellCommand、argv、rawRpc、model、model_provider、base_url、api_key。
每 Bridge 只接受其自身 workspaceId；线程必须由本工作区 C2C 创建。只读状态不返回完整输入、transcript 或配置。
写工具标注 readOnlyHint:false、destructiveHint:true、idempotentHint:true、openWorldHint:true。
幂等标注依赖持久 ID 去重；底层 thread/start、turn/start 不能盲目重试。
权限由 _meta.securitySchemes 声明，服务端独立检查，缺权返回 INSUFFICIENT_SCOPE 和 OAuth challenge。
OAuth codex.control **且** 本地 enabled 才能派发，网页不能启用工作区。默认只列原 9 个工具。

## 状态与恢复

`%LOCALAPPDATA%\codex-with-chatgpt\remote-control\<workspaceId>.json` 保存 enabled、规范化 root、
线程请求、任务队列、Controller 心跳及审计元数据；遵循 C2C_STATE_DIR 覆盖。
目标仅保存在任务记录，审计不复制 prompt 或 token。目录/文件用现有 0700/0600 模式，Windows 另依赖用户目录 ACL。
修改使用 .lock 短锁、临时文件 fsync + rename。损坏或遗留锁停止操作；先核对锁内 PID，保留 JSON 后人工恢复锁。
不能删除 JSON 清空历史。相同 requestId/commandId 和参数返回原记录，不同参数或 client 冲突拒绝。
各类最多 100 queued、10000 历史，满后拒绝，永不淘汰幂等 ID。

每工作区一 Controller、一专属 stdio app-server，同时最多一个 turn，其他任务排队。
不同工作区独立；手动 Desktop 任务或其他程序不受这个队列的串行限制。
重启保留 queued，starting/running/awaiting_approval 改为 needs_reconciliation 并占用槽位，禁止重跑。
即使创建响应丢失，也保留 requestId：可能有一个需人工认领的线程，但不会重试创建第二个。

```powershell
node .\bin\c2c.js controller stop
node .\bin\c2c.js controller status --json
node .\bin\c2c.js remote disable
```

stop 保存停止请求并结束专属 app-server，未确认结束的 turn 保留待核对。
disable 停止接单和消费，不伪称取消正在执行的 turn；要停止执行另用 controller stop。
已经收到终态的任务在 disabled 时仍投影 execution record 和经 sanitizer 处理的 final response，
投影完成后才应用禁止新任务消费的 guard。输出存储使用跨进程文件短锁；短暂竞争由 Controller 重试，保留待投影正文。
output index 先原子提交，再删除超出 40 条 retention 的旧正文；崩溃可留下 orphan body，但不会覆盖它或提前删除已引用正文。
index 损坏、读取失败，或 index 缺失但初始化标记/正文仍存在时停止操作，不重置 nextId。遗留锁需核对 PID 后人工恢复。
审批或用户输入请求标 awaiting_approval，不自动应答。第一版不转发审批 UI；需在本地停止 Controller，
用官方 Codex 恢复相应 thread 核对。确定旧执行已停止、不会再写入后：

```powershell
node .\bin\c2c.js remote reconcile --task <taskId> --confirm-stopped
# 创建请求使用 --request <requestId> 代替 --task
```

reconcile 要求旧 Controller PID 退出，只将待核对记录结束为 cancelled 并保留 ID，不重跑。
执行记录是队列终态的投影，崩溃可能重复一条 summary，但不会重复执行任务。
最终回答只在当前 Controller 内短暂缓存，崩溃后可能缺该条 execution_output，任务历史仍保留。

## 实际协议与限制

本机 codex-cli 0.148.0 / 0.153.4 的 `codex app-server generate-ts` 用于核对类型，真实任务使用 0.153.4。
启动 `codex app-server --stdio`，JSONL JSON-RPC initialize / initialized 后：
thread/start `{cwd}` → thread/resume `{threadId}`（跨 Controller 恢复时）→ turn/start `{threadId,input}`。
核对响应 cwd。模型/provider、sandbox、approval 继承本机配置，项目 AGENTS.md 由 Codex 正常发现。
不覆写安全配置、不操作 Codex 私有数据库/会话文件。
turn/completed 的 completed/failed/interrupted 映射为 completed/failed/cancelled；
丢连接、超时或未知状态保守待核对。app-server 标为 experimental，升级后应重新核对生成类型并做 smoke test。
本地 PATH 中 CLI 可能与 Desktop 使用不同版本；此实现以 PATH 中可执行 Codex 为准。
启动后先 config/read 检查工作区配置可加载，再报告 appServer:running；不输出配置值。
本机旧 PATH 版本 0.148.0 能 initialize，但 thread/start 无法解析新版 features 表。
0.153.4 完成真实 MCP → 后台 Controller → thread/start → turn/start → completed，
核对测试工作区 README/package.json 一致，返回 C2C_REMOTE_SMOKE_OK，且两个输入文件内容保持不变。
创建与任务各重放一次均复用原 ID。该 smoke 使用本机 HTTP MCP，尚未替代另一台设备经 HTTPS Tunnel 的人工验收。

错误区分 REMOTE_CONTROL_DISABLED、INSUFFICIENT_SCOPE、UNKNOWN_WORKSPACE、CONTROLLER_OFFLINE、
CODEX_APP_SERVER_UNAVAILABLE、THREAD_CREATE_FAILED、TASK_ALREADY_EXISTS、TASK_QUEUE_FULL、WORKSPACE_BUSY、
TASK_FAILED、AWAITING_APPROVAL，不把不确定响应当成成功。

## 开发验证（2026-09-10）

build、git diff --check 通过；完整 Vitest 为 25 文件、275 项全部通过。
其中 Remote Control 18 项、app-server client 4 项，覆盖 scope、本地授权、幂等、队列容量、
锁/损坏、重启不重跑、并发限制、完成/失败/中断、审批等待和初始化未就绪。
Normal C2C、原 9 工具、DOM Web Control 和默认关闭的 write_probe 回归均通过。
真实 smoke 的线程为 `01a08bba-e27e-7af3-9eb3-c09f9801959e`，结果 completed；未做另一台设备人工测试。

同日 P2 修复后：26 文件、282 项完整测试通过，targeted 60 项通过，typecheck/build/diff check 通过。
新增真实 4 进程并发写入（60 个唯一 ID、保留 40 条 metadata/body 对应）、提交失败/损坏/读取失败/orphan 回归，
以及 disable 后仍投影终态和跨进程锁竞争下保留正文的 Controller 回归；两个 P2 均有 RED → GREEN 证明。
