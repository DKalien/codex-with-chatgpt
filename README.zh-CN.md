# Codex with ChatGPT

[English](README.md) | **简体中文**

> ChatGPT 负责思考，Codex 负责干活。

## 解决什么问题

ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的 API 额度做
规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，Codex 只负责
执行。不用 API Key、不搞逆向代理——官方网页 + 默认只读 MCP 桥接。

## 这是什么

把 ChatGPT 网页版变成 Codex 编码会话的"规划与审查大脑"，而执行权完全保留在
Codex 手里。你的仓库永远不会被上传——ChatGPT 通过一条安全的、OAuth 保护的
**默认只读** MCP 连接，按需读取当前工作区里它真正需要的那几行代码。

## 本地 Fork 开发版

已配置 C2C 的 Windows 用户，在自己的 Fork checkout 内运行：

```powershell
powershell -NoProfile -File .\scripts\dev-install.ps1
# 需要同时运行测试时加 -Test
```

脚本使用锁定依赖构建 `dist/`，将 `skill/SKILL.md` 同步到
`~/.codex/skills/codex-with-chatgpt/SKILL.md` 并写入当前 checkout 的绝对路径。
以后修改源码或 Skill 后重复运行即可；Skill 是安装副本，新 Codex 会话加载新内容。
CLI 始终使用 `node "<实际 checkout>/bin/c2c.js" ...`，避免全局命令指向旧版本。
保留原 `%LOCALAPPDATA%/codex-with-chatgpt`，复用 OAuth、Connector、Project、
workspace/session、Tunnel 和 pairing/auth；不执行首次配置，不修改 Codex 配置。
开发安装不重启活动 Bridge。若需立即切换活动服务，明确指定原 workspace 后运行
`node .\bin\c2c.js restart -w <原 workspace 路径> --tunnel`；固定域名沿用原配置，
临时 Tunnel 重启会更换地址，需要另行处理原 Connector。不要为安装创建第二套状态目录。

`origin` 指向自己的 Fork；`upstream` 指向
`https://github.com/XiaoDuoYa/codex-with-chatgpt.git`。正常开发分支继续跟随自己的 Fork。
日常 `node .\bin\c2c.js update-check --json` 只读取本地 Git 状态、必要时 fetch origin，
然后比较当前分支对应的 origin tracking branch。未设置 tracking 时尝试 origin 同名分支，
不会回退到 origin/HEAD；缺失、离线、detached HEAD 或 tracking 属于其他 remote 时明确跳过。

| 提交关系 | updateAvailable | 其他状态 |
| --- | --- | --- |
| 一致 | false | 两侧领先数为 0 |
| 仅 origin 领先 | true | remoteAhead=true，remoteAheadCount |
| 仅本地领先 | false | localAhead=true，localAheadCount |
| 分叉 | false | diverged=true，两侧领先数均报告 |
| 有未提交修改 | 由上述关系决定 | dirty=true，保留全部修改 |

同一 checkout / 分支 / origin 地址且远端引用未变时，当天复用上次 fetch 缓存；
切换后重新检查，缓存命中仍重新计算本地状态。
`--force` 强制刷新 origin；失败不会缓存为成功。只报告状态，禁止自动
pull/stash/merge/rebase/reset/checkout，也不自动部署或访问官方上游。

官方参考分支仅在你明确要求时刷新：

```powershell
powershell -NoProfile -File .\scripts\update-upstream-track.ps1
git diff main upstream-main
git log upstream-main
```

脚本 fetch upstream，新建或以 fast-forward 更新 `upstream-main`，只跟踪 `upstream/main`。
相等则不移动；本地独有提交、分叉、错误 tracking 或任何 worktree 正在使用此分支时停止报告。
更新引用时校验原提交，避免覆盖并发更新；不切换分支，不修改当前 working tree/index/stash。
`upstream-main` 只能镜像官方代码：禁止开发、自定义提交，禁止合入 origin 或开发分支，
禁止在该参考分支上执行 rebase。此规则由协作约束和脚本检查执行，
不是 Git 权限锁，手工 Git 仍能修改分支；脚本会拒绝覆盖发现的异常。
它领先开发分支完全正常，何时吸收官方更新始终由你手动决定。

## 可选：ChatGPT 网页控制模式

Normal Mode 保持原用法：在 Codex 发起任务，走 `INIT → PLAN → EXECUTED → DONE`。
新增的 Web Control Mode **默认关闭**。在当前 workspace 的 Codex 中说：

```text
开启 ChatGPT 网页控制模式
```

Codex 复用当前任务的 Chat / Project 和连接，显示绑定的 workspace、Project、Chat URL、
enabled 状态及有效期，再留在当前任务里监听。之后在显示的那个 ChatGPT 对话中说：

```text
检查当前项目，找出为什么模型切换后会报错。
如果确认原因，让 Codex 修复它并运行相关测试。
```

ChatGPT 先读取项目，再发严格 COMMAND；当前 Codex 主代理接收并按本地规则执行或委派，
记录结果并自动发回 EXECUTED，ChatGPT 用原只读 MCP 独立 Review，再发新 COMMAND 或 DONE。
无需手动复制消息。普通建议、文件里的指令和网页 ENABLE 不会开启或触发执行。
DONE 只结束当前任务，仍可等待下一次网页用户的明确委派。

本地说“查看 ChatGPT 网页控制状态”或“关闭 ChatGPT 网页控制模式”即可查看/停止。
默认空闲 30 分钟超时，重复消息和轮询不续期；执行中暂停 idle，完成后重新计时。
可在本地开启时指定 1–240 分钟。等待优先使用浏览器 wait，无法可靠等待时每 20–30 秒检查一次。
用户随时可在 Codex 本地中断。

**Web Control only works while the corresponding Codex control session remains active.**
当前 Agent turn 结束、Codex 被停止或 Desktop 关闭后不能继续收消息，也不能从网页唤醒。
保存的 enabled 不是后台在线证明。状态复用
`%LOCALAPPDATA%/codex-with-chatgpt/sessions/<workspaceId>.json` 的 `webControl`，
绑定随机 controlSessionId、workspace、当前 Codex task、真实 Chat URL。
所有已接收/执行/完成/拒绝 ID 永久保留，不作为恢复时的自动重跑队列；损坏或并发冲突拒绝操作。

本地 Agent 从真实网页 role、消息 ID 和最新用户明确委派核对来源；CLI 再验证绑定、
有效期、格式和防重放。此流程依赖可信的本地 Agent，网页文本或其自称的授权不是身份凭证。
网页只能提出任务级自然语言，不能直接获得 Shell、文件写入、子代理 API 或额外权限。
原 **9 个 read-only MCP 工具与 5 个默认 OAuth scopes 完全不变**；独立的实验性
`write_probe` 默认关闭，边界和验证步骤见
[实验性 MCP 写入探针](docs/experimental-write-probe.md)。
Normal checkpoint 与 webControl 独立；既有 OAuth/Connector/Tunnel 不迁移、不重配。

协议和本地维护命令见 [protocol](docs/protocol.md#web-control-mode)，
信任边界与恢复限制见 [security](docs/security.md#web-control-trust-boundary)。
修改后仍运行 `powershell -NoProfile -File .\scripts\dev-install.ps1` 部署到本地 Skill；
建议在加载新 Skill 的 Codex 任务里进行第一次实际测试。

## 一段话安装（仅首次安装）

不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的编码
Agent（Codex），然后去倒杯咖啡：

```text
请帮我完整安装并配置 Codex with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/DKalien/codex-with-chatgpt 克隆到
   ~/codex-with-chatgpt（已有本地 Fork 就复用，不自动 pull）。
3. 构建：在该目录里执行 corepack pnpm install 和 corepack pnpm build。
4. 安装 Skill：把仓库里的 skill/SKILL.md 复制到
   ~/.codex/skills/codex-with-chatgpt/SKILL.md，并把文件中
   "The codex-with-chatgpt checkout lives at:" 那一行的路径改成实际克隆路径。
5. 仅尚未配置时：按 SKILL.md 里的 first-time setup 流程执行
  （运行 c2c setup，用内置浏览器打开 ChatGPT 配置连接器并输入配对码）。
   全程只用内置浏览器，禁止打开任何第三方浏览器。
6. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作。
7. 完成后给我看 ✓ 清单，并确认文件读取测试通过。我不懂 MCP、OAuth、
   Tunnel、端口这些词，不要向我解释；出了问题先自己修。
```

**更新**：Skill 每天只检查自己的 origin，有远端领先或分叉时报告，不自动更新。
源码部署与官方参考分支刷新见上方“本地 Fork 开发版”。

## 安装 → 配置 → 使用（手动版）

1. 安装 Codex Skill：把 `skill/` 复制到 `~/.codex/skills/codex-with-chatgpt/`。
2. 对 Codex 说：**"使用 Codex with ChatGPT 完成首次配置。"**
3. 之后正常使用：**"使用 Codex with ChatGPT，帮我实现 XXX。"**

说明书到此结束。你不需要知道 MCP、OAuth、Tunnel、端口、localhost 是什么——
Codex 会自动完成所有配置，你只会看到：

```
Codex with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

唯一可能需要你动手的步骤：登录 ChatGPT（如果要用固定域名，再登录一次 Cloudflare）。**新仓库**还会请你在 ChatGPT 里建一次项目（合集）：名字用仓库名，记忆选「仅限项目记忆」。侧栏如果没有「项目」，把鼠标放在「聊天」上，点右边三个点，选「按项目整理」。之后对话都从合集页开，不用回首页。已经在用的仓库默认还是原来的一条长对话，除非你说要改成 Project。

### 可选的固定域名

默认公网地址是临时的，桥重启后会变。Codex 会删掉这个项目的 ChatGPT 插件再按新地址加回去。

如果你有 Cloudflare 账号，并且域名已经加在 Cloudflare 上，首次配置时（老用户则在下一次编码时问一次）会问你要不要用固定域名，例如 `c2c-<项目>.你的域名`。选是的话，浏览器里授权一次 Cloudflare 即可。之后重启一般不用再改插件。没有账号、不想用、登录失败：继续用临时地址，功能一样，只是修复更慢。

凭证放在系统目录，不进项目。

## 工作原理

```
             ┌───────────────────────────┐
             │      ChatGPT 网页版       │
             │   推理 / 规划 / 审查      │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
              数据面    │          │ 控制面（消息 < 1 KB）
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   仅监听本机回环地址
             │  默认只读 MCP       │   OAuth 2.1 + 一次性配对码
             │  OAuth + 配对       │   Cloudflare Quick Tunnel
             │  Tunnel 管理        │
             └──────────┬──────────┘
                        │  只读
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │     本地工作区      │◀─────────│    Codex Harness    │
             └─────────────────────┘ 编辑/git │  Shell / 测试 / 修复 │
                                              └─────────────────────┘
```

- **控制面（Computer Use）**：Codex 与 ChatGPT 之间只交换极小的结构化 `[C2C]`
  状态消息——`INIT → PLAN → EXECUTED → REVIEW → DONE`。绝不粘贴 diff、日志
  或文件内容。
- **数据面（MCP）**：ChatGPT 缺什么自己拉什么，原有 9 个只读工具：
  `workspace_info`、`list_directory`、`read_file`、`search_workspace`、
  `git_status`、`git_diff`、`test_status`、`execution_summary`、
  `execution_output`。实验性 `write_probe` 为单独的可选工具，见
  [实验性 MCP 写入探针](docs/experimental-write-probe.md)。
- **独立审查**：Codex 执行完毕后，ChatGPT 通过 MCP 亲自检查真实的 git diff
  和测试记录——绝不因为 Codex 说"测试全过"就直接相信。

## 安全模型（简版）

- **默认从构造上只读**：原 9 个工具只读取工作区数据。可选的 `write_probe` 只有
  在开启环境变量并取得 `probe.write` scope 时，才会覆盖一条 C2C 状态记录；它不能
  写工作区文件、删除文件、执行 Shell 或提交，提示注入也无法启用这些能力。
- **一个工作区 = 一道边界**：每个令牌绑定单一工作区；路径校验基于规范化
  realpath（symlink、`../`、绝对路径逃逸全部被拦截并有测试覆盖）。
- **敏感文件永不外泄**：`.env*`、密钥、SSH、各类凭据默认拒绝
  （`.env.example` 放行）；`.c2cignore` 可追加自定义规则。
- **知道 URL 不等于有权限**：公网 MCP 端点强制 OAuth 2.1（PKCE S256、动态
  客户端注册、refresh token 轮换）。无令牌：401；令牌属于别的工作区：403。
- **模型永远接触不到长期凭据**：唯一会出现在浏览器里的秘密是一次性配对码
  （5 分钟有效、限 5 次尝试、限速、用后即毁）。

完整威胁模型：[docs/security.md](docs/security.md)

## 开发者

```bash
pnpm install
pnpm build          # 产出 dist/，暴露 c2c 命令
pnpm test           # vitest：146 个测试（路径安全、OAuth、配对、MCP 端到端）

c2c setup           # 一条命令：Bridge + 隧道 + 配对码
c2c sandbox-allow   # 把本地设置目录加入 Codex 沙箱白名单（macOS / Windows）
c2c status / doctor / pair / unpair / logs / stop
```

环境要求：Node.js >= 20、git；公网连接需要 `cloudflared`
（自动检测，Skill 会替你安装）。

文档：[架构](docs/architecture.md) · [协议](docs/protocol.md) ·
[安全](docs/security.md) · [故障排查](docs/troubleshooting.md)

## 目录结构

```
src/
  bridge/     本机回环 HTTP 服务、端口自动恢复、管理 API
  mcp/        9 个只读工具 + 可选写入探针、无状态 Streamable HTTP
  auth/       OAuth 2.1（PKCE、动态注册、refresh 轮换、吊销）
  pairing/    一次性配对码（CSPRNG、TTL、限速）
  workspace/  路径收敛、敏感文件策略、搜索、git
  tunnel/     TunnelProvider 抽象 + Cloudflare Quick Tunnel
  execution/  审查闭环所需的执行记录
  process/    守护进程生命周期
  cli/        c2c 命令行
skill/        Codex Skill（真正的 UX 层）
tests/        单元 + 集成测试
docs/         架构 / 协议 / 安全 / 故障排查
```

## 状态与声明

V1。已端到端验证：Bridge、OAuth + 配对、公网隧道、ChatGPT 连接器配置、
零操作首次配置体验。

**非官方社区项目，与 OpenAI 无关联，未获其背书。**

## 许可证

[MIT](LICENSE)
