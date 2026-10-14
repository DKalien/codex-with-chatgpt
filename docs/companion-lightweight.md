# 轻量 Browser Companion

本文描述 2026-10-13 当前源码合同；机器部署与验收状态以文末注明时间的观察快照为准。

## 使用

1. 在具体 ChatGPT 对话中打开扩展弹窗。首次使用粘贴 Bridge 提供的配对 JSON，包含 `workspaceId`、`bridgeOrigin`、`intentId` 和 `secret`。
2. 单独点击“授权 Bridge 访问”。该按钮只请求 JSON 或所选项目的精确 origin 权限；Pair 不会自动请求权限。
3. 点击“配对并连接当前对话”。JSON 的项目会自动登记并选中，无需额外手动选择；密钥只留在本次弹窗内存中，不保存到 local/session。
4. 若 Bridge 要求本机确认，在本机窗口由用户本人核对 workspace 与完整目标 URL。确认后按原 requestId 自动完成 commit/bind，无需第二次点击或向 ChatGPT 发送 route 验证消息。
5. 按需点击“开启自动回流”或“暂停自动回流”；用户选择会保留。已有配对时只需选择项目并点击“连接当前对话”。任务详情从“打开任务面板”查看。

空白首页没有具体对话 URL 时先建立对话。配对、本机确认回流与 Desktop/MCP 任务执行授权是不同能力；连接不会修改 Desktop 目标、OAuth scopes 或其他 workspace。

## 默认运行链

[manifest](../browser-companion/manifest.json) 默认加载：

- `popup/lightweight.html` / `lightweight.js`：项目、配对、显式访问授权、连接、回流启停、状态与错误。
- `bridge-client.js`：每项目凭据与偏好、Bridge 请求、真实 tab/document 关联及任务面板请求。
- `content-lite.js`：转发真实页面身份，报告 DOM 状态，执行一次已授权 DOM 操作并观察精确结果；DOM adapter 使用构建后的 classic artifacts。

项目 registry 继续使用 `c2c_companion_projects_v1`；项目凭据与偏好使用每 workspace 的受保护存储。content 与 popup 不接收长期凭据。2026-10-13 本轮已从源码退役旧 `service-worker.js`、`content-script.js`、`popup/popup.html`、专属 phase/owner-proof/route-attest/fence/journal/autonomy/send-probe 编排与测试，构建不再产出这些旧入口。共享 DOM/observer/write/click/route/project-context 依赖和 operations 任务面板保留；Bridge legacy 协议、Result Bus 与 receipt 历史兼容合同不变。本轮退役尚未部署，不代表已安装扩展或运行中的 Bridge 已升级。

## Bridge 与浏览器的职责

Bridge 判定 OAuth scope、本机确认、binding/enable、owner/project/workspace、版本/hash、审批、防重放和 outcome_unknown。网页伴侣只调用 Bridge 已授权的轻量接口、执行 DOM 交互并回报观察结果；不能通过页面文本或本地开关批准执行权限。

连接为 `/pair` → 按需 `/route/local/request` → 查询原 requestId → `/route/local/commit` → `/web-sink/bind-current`。配对不等于发送许可；本机 `local_user` 证明仅授权 canonical Result Bus 回流地址，不代替旧 Feedback 或任务面板的 MCP principal。服务端 `VERIFIED` 与目标 Web Sink 一致后才显示连接完成。

回流为安全心跳 → Bridge reserve → `/begin-send` 携带 `once:true` → 首次授权成功后向原 tab/document 执行一次 DOM 写入/点击 → 精确正文与 ATTEMPT 观察 → ACK。`once` 在 Bridge 持久化状态与锁内判定；重复 begin-send 不再授予 DOM 发送许可。`claimed` / `outcome_unknown` 只观察原 attempt。连接变化不迁移旧冻结目标，也不使未知消息获得第二次发送机会。

## 等待与错误恢复

- `bridge_permission_missing`：先独立授权精确 Bridge origin，再继续；Pair 不会代为弹权限窗。
- `PENDING`：在本机确认窗口核对目标。弹窗每 1.5 秒查询状态，最多约 90 秒；关闭弹窗停止等待，稍后可刷新状态查询原申请。
- `LOCAL_ROUTE_CANCELLED` / `LOCAL_ROUTE_EXPIRED`：本机申请取消或过期，不显示已连接；若仍要连接，由用户重新明确发起。
- 连接申请或提交响应丢失：保留原 requestId，按 Bridge 状态查询并完成提交/绑定，不自动发起新 requestId；服务端单次消费与锁决定可否提交。
- DOM 发送超时、页面变化、扩展重启或响应丢失：只观察原 attempt，不重复写入或点击。唯一标记还不足以 ACK，仍须精确正文匹配。

错误直接显示在弹窗中。不要改 ID、清空记录、重新配对或重复发送来绕过不确定结果。旧 Bridge 不支持本机确认时应升级兼容运行时，不静默退回 route 验证消息。更多说明见[安全模型](security.md)、[架构](architecture.md)与[排障](troubleshooting.md)。

## 部署与验收观察快照

以下为 2026-10-13（北京时间）、本轮旧伴侣源码退役之前的本机观察，不代表之后的实时状态或本轮退役验收。

- 正式串行全量回归：194 个文件、4087 个 tests 通过，exit 0。随后 `formatPending` / `www` 两处小修的定向回归为 7 个文件、138 个 tests 通过；最终 `typecheck`、`build` 与 `git diff --check` 通过。Python Desktop 89 项、daemon 29 项通过。
- 已安装轻量实现 build `c30737ce0e7e553f4fde34882041279c951087721eb3368d30016728b899a0df`；workspace `2582910bf0d2` / `d94af68105aa` 由同一 Gateway PID `19868` 托管，运行版本均为 current，无 pending。
- Desktop 旧 runtime fence 在 Codex 重启后失效；本轮通过正式 `desktop disable` → `desktop bind-current` 和用户本机确认刷新身份，保留原 bindingId。随后 `desktop status` 为 `available:true`、无未决投递，同面板使用的 `inspectDesktopBinding` 返回 `runtimeStatus:active`；可用与 active 不代表已投递，实际发送仍要求 idle。
- 用户已刷新真实 ChatGPT 对话页，并明确复核任务面板显示“可接收结果”；这是用户反馈证据。浏览器工具初始化因 kernel assets 路径缺失而失败，本轮未直接核验浏览器运行版本，也未完成真实 Desktop task delivery、DOM Send 或双 workspace Send/observed。mock、HTTP 与状态可用不能替代这些验收。
- v2rayN 适配仅将机器 Gateway 现有 `proxy` 从 `http://127.0.0.1:7897` 改为 `http://127.0.0.1:10808`；经既有身份认证 shutdown 后恢复两个原有 running intent，其余 config 精确不变，未修改 OAuth、绑定、历史或全局代理。真实 tunnel-client PID `22152` 的参数已包含 `10808`。
- A/B 公网 `/health` 直连与显式 `10808` 代理均为 HTTP 200；Gateway OAuth metadata 直连及 curl 显式 `10808` 均为 HTTP 200，curl SSL verify 为 0。同一 URL 的 PowerShell 显式代理请求出现 TLS EOF，仍需定位；这些结果不证明全部网络流量都已走代理。代理维护边界见[排障](troubleshooting.md#v2rayn-与-gateway-代理)。
