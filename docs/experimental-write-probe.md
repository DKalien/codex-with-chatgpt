# 实验性 MCP 写入探针

> 当前实现已落盘，但 ChatGPT 的真实调用尚未验证。本实验只验证当前账户和连接是否接受 MCP write action，不宣称 ChatGPT 或 Pro 支持该能力。

## 默认边界

- `C2C_ENABLE_WRITE_PROBE` 只有精确为 `1` 才启用，默认关闭。
- 关闭探针时，`tools/list` 包含原 9 个 read-only 工具和始终可发现的两个 Desktop schema；开启后额外注册 `write_probe`。原 5 个 OAuth scopes 不变，探针另用独立的 `probe.write` scope，并且只在显式请求、完成相应授权后可调用。Desktop Control 按自己的 `codex.desktop.*` scopes 校验；schema 可发现不表示已获权，实际发送另需本机 binding/enable 及其余门禁。
- 输入严格为 `{ "nonce": "..." }`。`nonce` 只能是 1–128 个英文字母、数字、下划线或短横线；不接受 `path` 或 `note`。
- 唯一副作用是把 `{nonce,timestamp,workspaceId,tool}` 写入 `getStateDir()/write-probe.json`，覆盖上一条记录。逻辑位置返回为 `c2c-state/write-probe.json`；不会修改工作区、删除文件或执行命令。
- 成功响应包含 `ok:true`、`written:true`、`nonce`、`timestamp` 和 `location`。
- 工具 annotations 为 `readOnlyHint:false`、`destructiveHint:true`、`idempotentHint:false`、`openWorldHint:false`。SDK 当前 `registerTool` 只支持 `_meta`，因此 scope 元数据位于 `_meta.securitySchemes`（OAuth2、`probe.write`）。缺 scope 时返回 `INSUFFICIENT_SCOPE` 和 `_meta.mcp/www_authenticate`。

## 只读状态检查

使用机器安装返回的稳定 launcher，明确目标 workspace；以下变量在后续手工步骤中复用。

```powershell
$c2cLauncher = '<稳定 launcher 绝对路径>'
$c2cWorkspace = '<目标 workspace 绝对路径>'
node $c2cLauncher write-probe-status -w $c2cWorkspace --json
```

`enabled` 来自运行中 Bridge 的 `/admin/info`：旧 Bridge 或状态不确定时为 `null`，Bridge 已停止时为 `false`。`configured` 是当前 CLI 进程的环境变量，不等于运行中 Bridge 的状态。`exists`、`nonce`、`timestamp`、`workspaceId` 和 `location` 只读取固定状态文件，不创建目录或文件；没有 `clear` 命令。

Windows 默认状态文件为 `%LOCALAPPDATA%\codex-with-chatgpt\write-probe.json`。`C2C_STATE_DIR` 只用于可信本地配置或测试隔离，不要把它设为代码 workspace。

## 手工验证

1. 在 PowerShell 中进入仓库并启用探针。仅在源码或 Skill 更新后，先运行 `powershell -NoProfile -File .\scripts\dev-install.ps1` 部署：

   ```powershell
   cd D:\python\codex-with-chatgpt
   $env:C2C_ENABLE_WRITE_PROBE = '1'
   node $c2cLauncher restart -w $c2cWorkspace --tunnel
   node $c2cLauncher write-probe-status -w $c2cWorkspace --json
   ```

2. 运行 focused test：

   ```powershell
   node node_modules/vitest/vitest.mjs run tests/write-probe.test.ts
   ```

   该测试只验证 `tools/list` 等本地行为，不等于 ChatGPT 已成功调用。

3. 打开 [ChatGPT Plugins](https://chatgpt.com/plugins)，找到当前 workspace 的精确 Connector 名称并点 **Refresh**；确认工具列表出现 `write_probe`、`readOnlyHint=false` 后，在新对话中选择该连接。若缺少 `probe.write`，用 `node $c2cLauncher pair -w $c2cWorkspace` 生成一次性配对码，并按授权页重新授权；确认同意页包含“C2C 状态写入实验”。旧 refresh token 不会自动扩权；不要自动删除 connector、unpair、重做 tunnel 或 project。

4. 真实 `write_probe` 调用由用户在新对话中手工发送。可直接发送：

   ```text
   调用当前 C2C Connector 的 write_probe，nonce 使用 c2c-pro-write-test-20260910-001。
   ```

   然后在本地再次运行 `node $c2cLauncher write-probe-status -w $c2cWorkspace --json`，核对 nonce 与本次测试值一致、timestamp 是本次调用时间、workspaceId 属于当前工作区。只有实际落盘才算完成调用验证：

   | 结果 | 判定 |
   | --- | --- |
   | A | 本地关闭：`enabled=false`，工具不注册。 |
   | B | 本地已注册但网页看不到：优先检查连接缓存或产品过滤；不能据此判定调用成功。 |
   | C | 网页可见但不能调用：可能是产品能力或 scope/permission；没有 nonce 落盘就不是成功。 |
   | D | 调用 write action 时出现用户确认，确认后实际 nonce 落盘：`write action supported with confirmation`。OAuth 重新授权不决定 D/E。 |
   | E | 本次 write action 无额外操作确认即实际 nonce 落盘：`write action supported`。此前是否重新授权不影响 E。 |

   仅有 `tools/list`、focused test、工具卡片或返回文本，都不能把结果判为 D/E；D/E 必须以实际 nonce 落盘区分。本次实验结果仍未验证。

5. 验证后关闭探针并刷新连接：

   ```powershell
   Remove-Item Env:C2C_ENABLE_WRITE_PROBE -ErrorAction SilentlyContinue
   node $c2cLauncher restart -w $c2cWorkspace --tunnel
   node $c2cLauncher write-probe-status -w $c2cWorkspace --json
   ```

   再 Refresh 该连接，确认 `write_probe` 消失。已有状态记录不会由关闭操作删除。

参考：[Deploy and connect](https://developers.openai.com/plugins/deploy/connect-chatgpt)（Refresh 流程）、[Build auth](https://developers.openai.com/plugins/build/auth)（tool security metadata 与 auth challenge）和 [Plugins reference](https://developers.openai.com/plugins/reference)（`_meta.securitySchemes`）。
