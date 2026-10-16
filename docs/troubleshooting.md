# 常见问题排查

下文 `c2c` 指 `node "%LOCALAPPDATA%\codex-with-chatgpt\bin\c2c.mjs"`。先运行 `c2c status --json` 看整体状态，日志在状态目录的 `logs/gateway.log`。

## Gateway 没有运行

`c2c gateway status` 会列出 cloudflared / tunnel-client 各自的状态；显示「重启中」时括号里是最近一次退出原因。`gateway start` 前会检查两个可执行文件是否存在，缺失时直接报 `GATEWAY_EXE_MISSING`。`c2c gateway status` 显示未运行时执行 `c2c gateway start`。仍失败时看 `logs/gateway.log`：常见原因是 `gateway configure` 未完成、端口被占用、`cloudflared` / `tunnel-client` 路径不对、未执行 `gateway set-key`。子进程异常退出会自动按 2s→60s 退避重启。Gateway 被强制结束（如任务管理器）时 `cloudflared` / `tunnel-client` 可能残留，下次启动前请在任务管理器中结束它们，避免重复 tunnel 连接。日志超过 5MB 时在下次启动时轮转为 `gateway.log.1`。

升级新构建后需 `c2c gateway stop` 再 `c2c gateway start`；Gateway 正在服务任务时先确认再重启。

## OAuth 配对码

ChatGPT 授权页要求配对码时运行 `c2c gateway pair` 获取一次性短时有效的码。过期或输错就重新获取。Connector 已授权过则无需重建。

日志里 tunnel-client 的 `mcp probe timed out after 2s` 只是启动探测超时（其上限固定 2 秒，公网往返接近该值），随后会出现 `poller started`，不影响使用。

## Desktop 忙碌或不可用

- `DESKTOP_UNAVAILABLE`：Codex Desktop 没有运行或命名管道不存在，启动 Desktop 后重试。
- `DESKTOP_BUSY`：目标会话在等待时间内一直不空闲，消息没有发送也没有记录；等任务结束后用同一 commandId 再发即可。
- `DESKTOP_NOT_BOUND`：先在目标会话运行 `c2c desktop bind-current -w <项目> --json`。
- `c2c desktop status -w <项目> --json` 可查看绑定与可用性（未绑定时不探测 Desktop，`available` 为 false）。
- Codex 沙箱内运行 `c2c` 可能因访问命名管道或写状态目录被拒，需在沙箱外运行同一命令（Skill 已要求）。Codex 工具整体报 `helper_unknown_error: setup refresh had errors` 时，查看 `~\.codex\.sandbox\sandbox.<日期>.log`；`open ACL target for update` 表示项目目录所有者不是当前用户，用管理员 PowerShell 执行 `takeown /f <项目> /r /d y` 后重开 Codex。

## 投递结果未知（unknown）

`start-turn` 字节可能已送达但没收到确认，不会自动重发。先在 Codex Desktop 里看该会话是否收到消息；没收到则让 ChatGPT 用**新的 commandId** 重发。同一 commandId 不会重发，内容不同还会报 `COMMAND_CONFLICT`。`accepted` 只表示 Desktop 接收了消息，执行是否完成看 `codex_task_result`。

## 执行完了但 ChatGPT 没收到通知

1. 伴侣 token 是否正确（`c2c companion token`，泄露后用 `--rotate`，重新填入扩展）。
2. 该项目是否已连接到当前 ChatGPT 对话页（伴侣弹窗点击连接，项目内对话 `/g/<项目>/c/<id>` 也可以），该标签页是否仍开着且停留在该对话。切到其他标签页可以继续工作，但 Chrome 会限流后台定时器，回调可能延迟；“省内存”丢弃标签页后不会运行，可把 chatgpt.com 加入始终保持活动。
3. 打开伴侣弹窗看“最近状态”：`页面未就绪：composer_dirty` 表示输入框里有内容（伴侣不会覆盖，发送或清空后自动继续）；`generating` 表示 ChatGPT 仍在回复；`发送 … 失败：<原因>` 表示点击前失败，已放回队列等待下次心跳。
4. 通知状态：`pending` 等待伴侣领取；`claimed` 已领取但页面未确认。长时间停在 `claimed` 说明发送未被确认，确认对话里确实没有该通知后，在伴侣里执行“重新发送”（requeue）。已 `delivered` 的通知不会再发。
5. 即使没有通知，也可让 ChatGPT 直接调用 `codex_task_result` 读取结果。

## Codex 没有写 record

`c2c record` 必须在 `[C2C_DESKTOP_TASK]` turn 的最终回复前执行，其他 turn 不能代记。没有结果时 `codex_task_result` 为空；在该会话里提醒 Codex 补记（用同一 commandId），再次 record 会覆盖结果。
