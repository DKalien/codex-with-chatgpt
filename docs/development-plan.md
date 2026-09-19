# 长期开发计划

本文件是本 workspace 持续维护的开发事实源，不是一次性 handoff。阶段完成、设计修正、
新风险或 `NEXT_EXPECTED_STEP` 变化时必须同步更新；历史观察与当前实现分开记录。

## Baseline（2026-09-13）

- 首轮开始 HEAD：`6c93f326eeac781af26eec1797b6c22c330ae33a`，工作区干净。
  status Review 修订开始时保留首轮 8 个文件的未提交修改，本轮不覆盖这些既有成果。
- 已实现 Machine Core immutable release、stable launcher/current pointer、按 workspace 隔离的
  rollout、exact Desktop execution receipt、历史 reconciliation/retirement/abandonment。
- 首轮开始机器部署状态为 `current`，安装与运行 build 均为
  `ae5989f7367861269b270630f19f6b71dcbf523699280beafe7d8f31a437e866`。
  首轮收尾只读 status 再次确认相同 build、`current` 且无 upgradePending；
  源码构建不等于安装，安装不等于运行 Bridge 已升级。
- 本轮仅执行 C；不安装机器 Core、不重启当前 Bridge、不实现 D/A/B、不 push。

## 目标、顺序与共享机制

执行顺序固定为 **C → A → D1 → D2 → B**（原 C→D→A→B 已因真实终态回流缺口调整）。

| 阶段 | 目标 | 状态 | 完成证据 |
| --- | --- | --- | --- |
| C0 | 测量 launcher/readCurrent 热路径时间及 I/O | done | 下方实际 v2 基线与隔离 v3 三次测量 |
| C1/C2 | trusted manifest、fast/full 验证与兼容原子发布；launcher/status 使用 fast | done | status Review 缺口已闭合，122 项定向测试通过；独立 hygiene 后全量 772/772，见下方 |
| A | 严格终态后自动反馈 EXECUTED | done | 本文下方 A 节；status 自动 reconciliation + pending/sent + Desktop durable recovery |
| D1 | 严格引用集 + 只读 GC plan | done | `release-references` + `gc-plan`；定向 21/21；见下方 D1 节 |
| D2 | maintenance lock / apply / safe delete | done | lock + two-pass apply + tombstone；定向见 D2 节 |
| B | 已证明 self-busy 的一次性 post-turn finalizer | done | structured idle + bounded finalizer + review/closeout；见下方 B 节 |
| E | 原任务 ChatGPT 对话的后台执行反馈与独立 review | preflight blocked | 2026-09-14 首轮仅做 E0 / 接收合同核验；见 [Phase E 预检](phase-e-feedback.md)，未开发生产回流 |

A/B 共享 strict terminal receipt/reconciliation，不建设万能 scheduler；B 单独使用有限生命周期
finalizer job。C/D 共享 trusted release manifest、reference graph 和 machine maintenance lock
方向；C 已完成 manifest，reference graph/维护锁扩展在 D1/D2。

## 安全合同

### C：启动性能

fast 不能冒充 full cryptographic verification。current pointer schema、
`stateDir/releases/<runtimeBuildId>` 的路径身份、manifest 与 pointer 的绑定、build-id、关键入口
和必要 bootstrap artifact 必须 fail closed。full 保留完整 dist buildId、artifact digest、
依赖快照和 symlink 边界验证；禁止仅凭 stat/cache 命中宣称完整性通过。

旧 v2 current/release 必须可启动；更新 machine bin helper/launcher 后、切 current pointer 前
的任一失败不得破坏旧 A。旧格式允许 fallback full，新格式才走 fast。同 buildId 不同内容拒绝，
checkout 修改/移动不能改变已安装 release。

### D：引用与清理

引用来源至少覆盖 current、running runtimeBuildId、pending upgrade、rollout/install/finalizer。
未知或损坏引用 fail closed。plan/apply 分离，apply 前重读引用集并在 machine maintenance lock
下核验；不得误删当前、运行中、待切换或 finalizer 所需 release。

D1 已落地只读层：`ReleaseReferenceGraph` 收集 current / runtime / runtime-upgrade；
悬空引用、损坏状态、坏 manifest、越界链接全部 fail closed。本轮无 apply。

### A：严格终态

accepted 绝不是 complete。必须匹配 exact workspace/controlSessionId/commandId/taskId/iteration/receipt；
重复、冲突或损坏历史 fail closed。EXECUTED 自动反馈只能从严格终态产生，不使用最新 test_status
或另一任务的记录替代，不重发不确定命令。

status 轮询用 `tryResolveTerminalExecutionRecord` 分类：missing / not_terminal 为 no-op，
terminal 在 executing 上自动推进 completed + pending；corrupt/duplicate/mismatch fail closed。
terminal truth ≠ feedback delivery acknowledgement：发送失败只保留 pending，不反推任务未完成。

Desktop：首次写入仍要求 exact current result context 与 accepted turn 对齐；已有 digest 一致的
终态在 context 暂时不可用（STATE_UNAVAILABLE/IPC）时只读恢复。context 可用且指向其他 turn
仍拒绝。不降低后续 turn 代记门禁。

### B：self-busy provenance

只有证明 blocker 是发起维护的当前 turn 本身时，才能安排一次性 post-turn finalizer。
清除 `CODEX_THREAD_ID`/`CODEX_SESSION_ID` 不证明 idle。真实 Desktop、approval、remote、history、
identity 与 named tunnel gates 不降低；finalizer 到期或结果不确定时停止，不常驻重试。

## 分阶段提交建议

1. `perf(core): 记录启动热路径测量基线`：本计划和开发测量工具。
2. `perf(core): 增加兼容的 release manifest 分级验证`：schema、发布与原子兼容作为一个可运行单元。
3. `perf(core): 将 launcher 切换为快速验证`：调用点、验证与安全保证文档。

这是后续审查时的提交拆分建议；本轮保留可审查工作区 diff，未执行 commit/push。
schema、发布兼容、类型和对应回归应作为同一可运行单元，不拆出不能启动的中间提交。

## 测试矩阵

| 范围 | 必需证据 |
| --- | --- |
| C0 | wall time、多次样本、readdir/stat/lstat/realpath/readFile 次数与 bytes；无绝对时间 CI 门槛 |
| 启动热路径 | 新格式 launcher 与 status 命令内不递归扫描 release/node_modules；以 I/O 断言而非计时验证 |
| 信任绑定 | pointer/manifest/releaseRoot/build-id/入口篡改均拒绝 |
| 深层内容 | 明确 fast 的保证边界；full 发现深层 artifact 篡改 |
| 向后兼容 | 旧 v2 可启动/迁移；中间 helper 更新与 pointer 原子失败后仍运行 A |
| 独立性 | checkout 修改/移动、依赖快照、symlink 越界、同 ID 冲突 |
| 回归 | core-install/rollout/build-id 定向测试；稳定后完整 Vitest |
| 必需门禁 | typecheck、build、git diff --check；未修改 Python helper 时不新增独立 Python 门禁 |
| 交付 | 当前 commandId 的 exact execution receipt 与本轮可读 output |

## C0 实际测量（2026-09-13）

开发工具：`scripts/measure-core-release.cjs`，仅以 Node 标准库包装同步 fs API，导出
`measureReadCurrent({ helper, stateDir, mode })`，也可运行 `--self-test`。普通启动不会加载它。
`--helper` 可指定不可变旧 helper；缺失 pointer 或验证失败以非零状态退出，不把失败计为成功启动。

正式基线使用机器 `bin/core-release.cjs` 和原 v2 state；新格式使用本轮构建的隔离安装
`.tooling/phase-c/isolated-machine`，没有切换机器 current 或启动 Bridge。新构建 ID 为
`171e916d31f75dcdb1408c9f1f3ed5eba26195f5f7fa3a49be6f86aadfc0a8a8`。

环境：Node v25.2.1 / Windows 10.0.19045 x64 / 4 CPU / 16253 MiB RAM。

| 测量 | 三次 wall time（ms） | 中位数（ms） | readdir | stat | lstat | realpath | readFile | bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 原已安装 v2 / full | 3259.80 / 3219.86 / 2965.90 | 3219.86 | 1101 | 410 | 5147 | 409 | 4742 | 70,210,932 |
| 隔离 v3 / full | 4036.27 / 3455.67 / 3409.92 | 3455.67 | 1101 | 410 | 5163 | 425 | 4756 | 70,321,230 |
| 隔离 v3 / fast | 37.83 / 26.71 / 32.01 | 32.01 | 0 | 0 | 16 | 17 | 16 | 96,711 |

上述 I/O 是每次稳定计数。旧 v2 的 release 内读取 70,210,517 bytes，其中 node_modules
为 67,889,087 bytes / 4493 次 readFile / 1062 次 readdir，证实扫描完整依赖树。
v3 fast 在 node_modules 仅检查顶层目录 lstat/realpath 各一次，无文件内容读取或目录枚举；
release 内读取 96,197 bytes。它消除启动前完整树扫描，同一 v3 比 full 少读约 99.86% 内容。

复现命令（绝对机器路径用实际安装目录替换）：

```powershell
node scripts/measure-core-release.cjs --helper "<machine-state>/bin/core-release.cjs" --state-dir "<machine-state>" --mode full --runs 3
node scripts/measure-core-release.cjs --state-dir .tooling/phase-c/isolated-machine --mode full --runs 3
node scripts/measure-core-release.cjs --state-dir .tooling/phase-c/isolated-machine --mode fast --runs 3
node .tooling/phase-c/isolated-machine/bin/c2c.js --help
```

计数是 JS fs API 调用而非内核 syscall；readBytes 是返回内容字节数，不代表物理磁盘读取。
计时包含测量器包装开销、OS 缓存和当时负载，不包含 helper 加载、Node/CLI 子进程启动或后续命令。
正式旧基线测量时构建也在运行，不能把跨安装 wall-time 比值当作稳定性能承诺。
完整原始 JSON 留在忽略目录 `.tooling/phase-c/` 并纳入本轮 execution_output 摘要；
CI 断言使用“不调用 readdir”与篡改拒绝，不使用绝对 wall-time 门槛。

## C 最终 schema、调用链与兼容性

- pointer v3 严格字段为 `version / checkoutRoot / installedAt / releaseRoot / runtimeBuildId /
  artifactSha256 / manifestSha256`。`releaseRoot` 必须精确为规范的 `stateDir/releases/<runtimeBuildId>`。
- manifest v2 严格字段为 `version / runtimeBuildId / artifactSha256 / bootstrap`；pointer 保存
  manifest 原始字节的 SHA-256。bootstrap 是固定 13 项相对路径 → SHA-256 的对象，不接受删减、
  额外项目或自行选择验证集。manifest 不进入 artifactHash，避免自引用。
- bootstrap 覆盖 `bin/c2c.js`、`package.json`、`dist/build-id.txt`、`dist/cli/index.js`、
  `scripts/` 下 core-release/core-launcher/install-core，以及 `dist/core-assets/` 中上述三个脚本、
  c2c-entry.js、package.json、dependencies-sha256.txt。pnpm-lock 快照由 full buildId/artifact 保护，
  不属于启动所需 bootstrap；深层 dist 与依赖文件也不在 fast 集内。
- fast 每次重新读/hash manifest 和 bootstrap，验证 current/manifest/入口规范普通文件及
  node_modules 顶层目录身份、build-id 内容与 runtimeBuildId 一致。没有 stat/mtime 缓存、
  没有全树枚举，也不把该结果称作 full integrity。
- `readCurrent(stateDir, mode = "full")` 是唯一格式实现；launcher 显式传 `"fast"`。
  TypeScript 的 `readCurrentInstall` / `getCurrentInstall` 只透传可选 `CoreVerification` 参数，
  默认仍为 full，不复制 release 格式。`readRuntimeUpgrade` 的验证级别是必填参数：status
  调用点明确传 fast，doctor 调用点明确传 full。链路是
  `status → readRuntimeUpgrade(fast) → getCurrentInstall(fast) → readCurrentInstall(fast) → readCurrent(fast)`。
  install/publish/protect-current/rollout 保持 full。doctor 的文本和 JSON 输出统一执行 full，
  并以 `report.core` 显示完整性结果；损坏时不显示校验通过。
  开发测量工具 `--mode full` 也提供显式只读 integrity 检查；本轮不新增生产 CLI 子命令。
- 旧 pointer v2 / manifest v1 在 fast 请求下仍 full。新安装仅在 bootstrap 快照与当前
  helper/launcher 字节一致时发布 v3；旧快照保留 v2，防止旧 helper 读取新 pointer。
  已存在 release 的 manifest 不重写，重装仍 full 核对同 ID 内容。旧 v1 freeze 保留支持。
- 新 helper/launcher 更新在先、pointer 原子切换在后；新代码兼容旧 pointer，因此中间态可启动 A，
  失败恢复旧 machine bin 与旧 pointer。回归注入 pointer rename 失败并在各次 bin 更新后真实启动 A。

## Observations、风险与未完成项

- 源码确认基线路径为 `core-launcher.cjs → readCurrent → verifyRelease → buildId(dist) + artifactHash(releaseRoot)`；
  每次旧 launcher 都遍历完整 release（含 node_modules），现已由 I/O 测量证实。
- 信任根仍是本机受信任 pointer/安装程序；本地能同时改写 pointer、manifest 和代码的攻击者不在
  digest 认证能力内。machine bin 本身也属于此信任根，只能检查规范路径，不能用未验证 helper
  自证内容安全；它必须允许与旧 release 中 helper 不同，才能安全完成分步升级。
- fast 不检测深层文件内容、额外文件或后来插入的深层 symlink；这类改动可能影响下一次 full
  检查前的运行。full 的完整 digest/buildId、依赖快照发布检查与链接边界保持，不弱化或冒充。
  验证到实际启动之间仍存在本机并发改写窗口，不宣称原子执行/防本机攻击者。
- 独立审查发现 legacy freeze 的 live bin/package 复制可能跟随外链，已改为验证实际源文件
  canonical regular 身份；machine bin 与 node_modules 顶层外链也已增加拒绝检查及回归。
  最后复核补齐 `protectCurrent` 的 v1 pointer 检查，与 `readCurrent` 共用 `readPointer`，
  通过外链访问旧 current 时在任何冻结/发布前拒绝。
- 既有原子 pointer 切换不等同于并发安装事务；本轮不把 D/B 的维护协调提前实现。
- 源码 C 完成后仍须用户按既有流程部署才改变机器启动性能；本轮隔离安装不是机器上线。
- D1 只读 reference graph / GC plan、D2 maintenance lock / apply、B post-turn finalizer 均已实现；A 自动终态回流已完成源码与测试。机器部署另按既有流程。

## 本轮验证与执行记录

### 首轮实现记录（历史）

- 首轮 core-install/rollout/build-id：99/99；增加 fast/legacy 回归后：114/114。
- 增加 bootstrap 外链检查后 core-install/core-upgrade：30/30；最终新增 node_modules 顶层检查
  随完整 Vitest 验证。真实隔离 v3 launcher `--help` 退出 0。
- 完整 Vitest：45 个文件，44 passed / 1 failed；747 项测试，746 passed / 1 failed，退出 1。
  唯一失败为 `tests/activation-skill.test.ts:72` 的 Project 路由文本断言：测试要求字面 `\n`，
  Windows checkout 的 `skill/SKILL.md` 使用 `\r\n`。已核对 Skill 与测试两份文件在换行归一化后
  均与本轮 baseline HEAD 完全一致，原文断言为 false、仅换行归一化即为 true。
  这是未修改文件的既有平台断言问题，本轮不修改 Activation 或使用 retry 掩盖失败。
- full 之后仅补 v1 pointer 的共用路径检查；最终 core-install/core-upgrade/rollout/build-id
  四文件 **122/122 通过**（包括 28 项 core-install）。无新关联疑点，不重复整套 full。
- 最终 typecheck、build 均退出 0；测量器 self-test、真实隔离 launcher `--help`、diff 检查通过。
  C 实现与相关验证完成，但不宣称全库全绿或机器已部署。
- 首轮 commandId：`core-phase-c-roadmap-20260913-001`，已在对应 active turn 内写入 exact
  execution receipt，`exitStatus=failed`、可读 outputId=53；不把 accepted 当作完成证据。

### status 热路径 Review 修订

- commandId：`phase-c-reviewfix-status-hotpath-20260913-001`。Review 确认首轮只优化 launcher，
  status 命令内部仍通过默认 full 再扫描 release；首轮仅测量 readCurrent/launcher 无法证明
  status 命令级目标完成。首轮把 status full 写成预期设计不正确，本节和上方合同已修正。
- 修订期间 C 重开为 in-progress，完成后恢复 done。仅新增显式验证级别透传和调用点选择；
  v2 fallback full、fast 损坏返回 unknown、维护 full 深层篡改检测均通过定向回归。
- 命令级测试在隔离 Bridge/state 中观测真实 status（文本/JSON）、session 和 doctor
  （文本/JSON）进程的 release readdir：status/session 必须为 0，doctor 必须大于 0。
  不以 wall time 作门槛，不部署到机器或重启本 workspace 的 Bridge。
- 定向 core-install/core-upgrade/rollout 共 **122/122 通过**（28 + 9 + 85），包含 v3 fast
  无枚举、v2 fallback full、pointer/manifest/bootstrap 损坏 unknown，以及默认 full/protect-current
  拒绝深层篡改。typecheck/build 均退出 0；源码审查确认 rollout 仍调用默认 full 的 readCurrentInstall。
- 另对新编译的 CLI（build `637d9dc009c05e0d61672835916886c1250f4808ab0f6a776e879d952ae144a5`）
  复用首轮完整 v3 隔离安装，检查真实命令内部 release I/O。只设置测试子进程的 C2C_STATE_DIR，
  不更新机器 current；测试 workspace 没有运行 Bridge，doctor 使用 --no-fix。

| 实际命令 | release readdir | release readFile | release bytes | node_modules bytes |
| --- | ---: | ---: | ---: | ---: |
| status --json | 0 | 15 | 96,197 | 0 |
| status | 0 | 15 | 96,197 | 0 |
| session --json | 0 | 0 | 0 | 0 |
| doctor --no-fix --json | 1101 | 4755 | 70,320,716 | 67,889,087 |
| doctor --no-fix | 1101 | 4755 | 70,320,716 | 67,889,087 |

此表是命令内部检查，不包含独立 launcher 的 fast 检查或 checkout 模块加载；session 的 0
不表示完整启动无 I/O。常规命令不再为展示 runtimeUpgrade 增加完整扫描。
文本 doctor 对停止 Bridge/未 allowlist 的隔离环境返回 1，但 Core 完整性检查通过；JSON
doctor 返回同一诊断信息。以上命令 I/O 计数已断言并保存在 `.tooling/phase-c-status/`，纳入新 receipt output。

- 本轮完整 Vitest 只运行一次：45 文件，44 passed / 1 failed；753 项测试，
  **752 passed / 1 failed**，退出 1，耗时 381.98 秒。唯一失败仍为未改动的
  `tests/activation-skill.test.ts:72` CRLF/LF 字面断言；本轮再次验证 Skill 与测试均与 HEAD
  换行归一化后的内容一致，未修改、重试或掩盖该问题。
- typecheck、build、git diff --check 均退出 0。实现与命令级目标已完成，但全库仍非全绿；
  新 commandId 的 receipt 保持 `exitStatus=failed`，附本轮独立可读 output。
  仅修改 docs 三份、src/core/install.ts、src/core/upgrade.ts、src/cli/index.ts 和
  tests/core-upgrade.test.ts；保留首轮其他 dirty 文件。未部署、commit/push、reset/stash 或启动 D/A/B。

### 独立 CRLF/LF 测试 hygiene 修复

- commandId：`fix-crlf-baseline-portability-20260913-001`。仅调整
  tests/activation-skill.test.ts 的输入/解析边界和本计划，不修改 Skill 业务文本或 Phase C 实现。
- 修复前重新运行该文件：18 passed / 1 failed（19 项），退出 1。实际 Skill 含 1326 个 CRLF；
  原字面 LF 断言不匹配，仅内存换行归一化后匹配，确认根因。
- 将契约分别应用于内存中的 LF、CRLF 输入，解析前统一为 LF，既有断言保持原样；
  不做磁盘换行转换，也不将断言改成宽松文本匹配。
- 状态：**done / green baseline**。定向测试首次修复后运行：LF、CRLF 各 19 项，
  共 **38/38 通过**。完整 Vitest 仅运行一次：**45 文件、772/772 全部通过**，退出 0，
  耗时 369.72 秒；无 retry，也没有通过修改 Skill 内容或弱化断言获得绿色结果。
- typecheck、build、git diff --check 均退出 0。修改前保存已跟踪文件及首轮新文件的
  SHA-256，最终核对 139 个文件，仅本测试与本计划变化；Skill 业务文本和 Phase C 源码
  字节一致。测试文件保留原有 CRLF 文件风格，LF/CRLF 输入转换只发生在内存中。
- 本次写入独立 exact execution receipt 和可读验证 output，保留前两轮失败记录的历史事实。
  未部署、dev-install、rollout、重启 Bridge、commit/push 或 reset/stash；D/A/B 未启动。

### A 自动终态回流（done）

架构决策：terminal truth 与 feedback delivery acknowledgement 解耦。

```
Execution terminal truth (JSONL ok/failed/blocked)
  → tryResolve 分类 (terminal | missing | not_terminal | throw)
  → status 自动 reconciliation (executing → completed + pending)
  → pending feedback 持久化
  → 发送 EXECUTED
       ├─ success → sent + feedbackMessageId
       └─ failure → 保持 pending，下一轮 recover/status 继续
```

实现要点：

- `tryResolveTerminalExecutionRecord`：missing/not_terminal 为 no-op；corrupt/duplicate/
  identity mismatch throw，不靠错误文案分支。`resolveTerminalExecutionRecord` 复用同一分类。
- `webControlStatus`：锁外分类，仅 terminal 需要写盘时进入 `changeControl`；
  `applyTerminalReconciliation` 是纯状态 helper，不递归 updateSession、不重新 enable。
- pending/sent：legacy 仅有 feedbackMessageId 可读；同 ID 再次确认规范化为 sent；
  不同 messageId fail closed；pending 不允许携带 feedbackMessageId。
- Desktop late-result：已有 exact terminal + digest 一致时，context 暂时不可用可只读恢复；
  首次写入与“context 可用且指向其他 turn”仍 fail closed。不删除 currentResultContext 门禁。
- Skill：status 自动发现 terminal 并返回 pendingFeedback；正常路径不要求手工 reconcile CLI。
- CLI：`web-control status` 输出 `pendingFeedback`；`recover`/`reconcile` 保留作诊断。

真实故障案例对应：

- Web Control boot messageId 拿不到 → 不阻塞 terminal；terminal 独立于 boot 确认。
- Desktop 晚于 context 窗口 → 已有终态可恢复；未写入且 context 已永久离开仍 fail closed
  （历史 unresolved，走既有 reconciliation/abandonment，不降低 turn 门禁）。
- 只有 accepted → 不 complete。
- 反馈发送失败 → 保留 pending，不重执行。

#### 2026-09-13 A 完成核对

- 代码：changed-and-verified。strict resolver、status 自动 reconciliation、pending/sent、
  Desktop durable prior recovery、Skill 自动回流说明均已落地。
- 运行态：pending。机器部署未更新本轮 dirty checkout。
- 文档：changed-and-verified。本计划与 Skill 已同步。
- 规则：verified-current。不 reset/stash/commit/push。
- 工作区：保留 Phase C、CRLF、D1 与 A 的未提交改动。

### D1 只读 reference graph + GC plan（done）

分层：`release-references`（引用发现）→ `gc-plan`（disposition）。本轮只读，无删除。

#### Reference graph

`collectReleaseReferences(stateDir)` 产出：

- `references: Map<buildId, ReleaseReference[]>`
- `referencedBuildIds`
- `issues[]` + `ok`
- kind 可扩展：本轮 `current` / `runtime` / `runtime-upgrade`；collector 列表结构上可追加
  install/rollout/finalizer，不为 B 伪造不存在状态。

收集规则：

| 源 | 校验 | 引用 |
| --- | --- | --- |
| current | 现有 `readCurrentInstall(stateDir,"fast")` 严格 identity | `current` |
| runtime/*.json | 文件名与 workspaceId 一致；strict schema；必须有 runtimeBuildId | `runtime:<ws>` |
| runtime-upgrades/*.json | 与 UpgradePending 等价 strict schema；workspace identity | `pending:<ws>` |

#### Fail-closed 规则

- runtime/pending 损坏、identity mismatch、文件名非 canonical → issue
- 引用了不存在的 release（dangling）→ issue，**不是可忽略悬空**
- current 指针无效/损坏 → issue；此时无法证明任何 release 是 current，相关 release 不得 keep
- release 根非真实目录 / symlink / 非 canonical realpath → unknown
- release.json 缺失、非严格字段、version 无效、runtimeBuildId≠目录、artifactSha256 无效、
  v2 bootstrap 键集或摘要格式错误 → unknown
- release 内链接越过 releaseRoot → unknown
- **任意 issue → 全局阻断**：所有 delete-candidate 降为 unknown，`bytesCandidateReclaimable=0`

#### Logical size

安全锚点永远是整个 releaseRoot（递归不把子目录当新根）：

- 普通文件：stat 大小
- symlink/junction：目标 realpath 必须在 releaseRoot 内；只计 link 自身 lstat 字节，
  **不跟随、不重复 target**
- 目录：同一 anchor 递归；visited realpath 防环；目录链接不跟随

#### GC plan JSON 契约

```json
{
  "ok": true,
  "stateDir": "...",
  "releases": [{ "buildId": "...", "path": "...", "disposition": "keep|delete-candidate|unknown", "reasons": ["current"], "logicalBytes": 0 }],
  "issues": ["source: message"],
  "totals": {
    "releaseCount": 0,
    "bytesKept": 0,
    "bytesCandidateReclaimable": 0,
    "issueCount": 0,
    "unknownReleaseCount": 0
  }
}
```

reasons 稳定标签：`current`、`runtime:<workspaceId>`、`pending:<workspaceId>`、
`manifest_mismatch`、`global_unknown_reference` 等。`c2c gc` 必须 `--plan` 或 `--dry-run`；
二者 disposition 等价。无 `--apply`。

CLI exit contract：`plan.ok === false` 时，**text 与 `--json` 都必须非零退出**；
JSON body 仍完整输出，不因 exit 1 丢失机器可读 plan。健康 plan 退出 0。

#### D1 验证

- 定向 `tests/gc-plan.test.ts`：**21/21 通过**（含悬空引用、坏 manifest、身份不匹配、
  symlink 越界/内部/环、只读、CLI exit contract）
- typecheck / build / git diff --check：通过

### D2 安全 GC apply + machine maintenance lock（done）

#### Maintenance lock

- 原语在 `scripts/core-release.cjs`（`tryAcquireMaintenanceLock` / `withMaintenanceLock`），
  TypeScript 经 `src/core/maintenance-lock.ts` 的 `createRequire` 复用，不复制第二套协议。
- **fresh-state bootstrap**：acquire 自己 `mkdir -p stateDir`（0700），不依赖 caller 预建目录。
- 文件：`stateDir/maintenance.lock`，`wx` + 0600。
- metadata：`version/operation/pid/startedAt/token`。
- 已有 lock → 稳定 `MAINTENANCE_BUSY`；**绝不按时间/PID 偷锁**。
- release 仅在 token 匹配时 unlink；被替换/无法证明归属 → fail closed，不 unlink。
- **unlink 实际失败** → `release()` 返回 false，不宣称 released；`withMaintenanceLock`
  抛 `MAINTENANCE_RELEASE_FAILED` 并附 `result`。destructive GC 若已发生则保留 items，
  但整体 `ok=false` + `maintenance_release_failed` issue。

#### Inherited handle 验证

`assertMaintenanceHandle(stateDir, handle)` 必须通过才能把 handle 传入 `ensureBridge`：
- `handle.path === canonical stateDir/maintenance.lock`
- lock 文件必须是 regular file（非 symlink/junction）；realpath === canonical path
- metadata 精确五字段 `version/operation/pid/startedAt/token`；`version===1`；pid 整数；
  operation 非空；startedAt 严格 ISO；token UUID
- `metadata.token === handle.token`
- mismatch / missing / replaced / extra field → `MAINTENANCE_HANDLE_INVALID` fail closed

#### Startup lease（封死 direct serve 绕过）

所有生产 bridge-start 路径在「准备启动 → runtime reference 落盘」区间必须参与同一 fence：

- `ensureBridge` parent：持有 maintenance + start.lock（nonce），经 env `C2C_STARTUP_LEASE`
  传给 spawn 的 `c2c serve` child。
- child：`consumeStartupLeaseFromEnv()` 读取后立即删除 env；`claimStartupLease` 做
  **跨进程 one-shot claim**（`startup-leases/<ws>.<leaseNonce>.claim`，`wx`）；
  已存在 claim → `STARTUP_LEASE_REPLAY` fail closed。
- parent 在 ready/failure 后 `cleanupStartupLeaseClaim`；crash 留下的 claim 人工恢复，不 steal。
- 无 lease 时 direct serve **自己** acquire maintenance + start.lock，runtime persist 后释放。
- start.lock 为 owner-safe `StartLockHandle`：strict metadata，release 仅在 workspaceId+nonce
  匹配时 unlink；失败返回 false，调用方必须暴露。

#### Maintenance release 语义

共享 `releaseMaintenanceOrThrow(handle, { result, actionError })`：
- 成功 action + release false → `MAINTENANCE_RELEASE_FAILED`，error.result 保留证据
- action 失败 + release 失败 → 保留原始 error，`cause` 挂 release failure
- token mismatch / unlink 失败 → 不 unlink 他人 lock；lock 留给人工恢复

rollout / ensureBridge / withMaintenanceLock / serve standalone 均走该 helper。

rollout / GC 共用 `rollout-fence.ts`：`tryAcquireRolloutFence` + `releaseRolloutFence`；
legacy 文件只视为 busy，不解析 steal。

#### Install / rollout / bridge-start fencing

| 操作 | fencing |
| --- | --- |
| `installCore` | 全程 maintenance（publish → bin → current switch） |
| rollout | 先 maintenance，再 `rollout.lock`；固定顺序 maintenance → rollout |
| `ensureBridge` | start.lock + maintenance（caller 未持有时自取；inherited 须 assert） |
| rollout → restartBridge | 传入已持有 maintenance handle，避免 nested deadlock |

Bridge start 关键区间持有 maintenance，因此与 apply 互斥；`*.start.lock` 不再被
reference collector 当作 corrupt runtime。

#### Apply 算法（两观察 + lock + atomic rollout fence）

```
initialPlan = planGc()          # 必须 ok
acquire maintenance
  atomically open rollout.lock (wx)  # 整个 destructive section 持有
    any start.lock? abort
    freshPlan = planGc()       # 必须 ok
    freshCandidates === initialCandidates
    per-candidate: hook → revalidate → rename tombstone → no-follow delete
  release rollout.lock            # close/unlink 失败 → ok=false + rollout_fence_release_failed
release maintenance             # 失败 → ok=false，保留 items
```

- 绝不信任旧 plan；D1 `GcPlan` 只是观察，不是删除授权。
- **GC 真正持有 `rollout.lock`**，不是只检查 existence：legacy rollout 已运行则 EEXIST abort；
  GC 持有时 legacy `openSync(wx)` 失败。
- 新 candidate / 消失 / current·runtime·pending 变化 → `stale_candidates`，不删新 candidate。

#### Tombstone / delete

- `releases/<buildId>` → atomic rename → `gc-trash/<buildId>.<nonce>`
- `gc-trash` 必须 canonical 真实目录
- `removeTreeNoFollow`：仅允许删除 `gc-trash` 锚点内；symlink unlink 自身，不跟随
- cleanup 失败 → `status=tombstoned` + 非零；`bytesDeleted` 只计真正完成删除

#### GcApplyResult 契约

```json
{
  "ok": true,
  "stateDir": "...",
  "mode": "apply",
  "items": [{ "buildId", "status": "deleted|tombstoned|skipped|error", "logicalBytes", "reason" }],
  "issues": [],
  "totals": { "candidateCount", "deletedCount", "tombstonedCount", "skippedCount", "bytesDeleted" }
}
```

#### CLI / doctor

- `c2c gc --plan | --dry-run | --apply` 互斥；各自 `--json`；plain / 组合拒绝。
- apply `ok=false` → text 与 JSON 均非零，JSON 仍完整。
- doctor 报告 `gcPlanSummary` + `maintenanceLockBusy`；**doctor --fix 绝不 apply**。
- status 热路径不扫 GC。

#### D2 验证（含 Review fix）

- `tests/maintenance-lock.test.ts`：含 fresh-stateDir install、assertMaintenanceHandle、release failure
- `tests/gc-apply.test.ts`：含 atomic rollout fence、真实 stale 断言
- `tests/bridge-maintenance-fence.test.ts`：GC-held / inherited handle / forged handle / apply∩ensureBridge
- `tests/gc-plan.test.ts`：21/21（D1 不回归）
- 完整 Vitest：见收尾

## NEXT_EXPECTED_STEP（历史记录）

历史源码阶段 C/A/D1/D2/B 已完成；其中 A 的 pending/sent 状态机制不等于无 DOM 的生产回流。
此前部署验收只对应各节记录的 build，不能代表后来所有源码均已在机器收敛。

以下为历史记录，不能覆盖后续 E1b3/E1b3d3b2 收官事实。2026-09-14 Phase E 首轮核验：干净 `main@dcf8db0` 与实时 origin/main 一致；当前源码运行产物、
installed/runtime 均为 `30cd260920fc8a2fc44ef00874c7f4a323f14108375d5ed0237807d3ece3051e`，
完整 release 校验和 128 项内存 emit 比对通过，本地及 named 公网健康。
但 `upgradePending=true / named_unhealthy` 仍保留，latest finalizer
`c5d31ea0-fcab-4058-8726-5af43b8227d8` 为 blocked，无 active job。本轮按已运行正确目标的规则
只读确认，未重新安装、rollout 或重启；**E0=blocked（遗留维护状态尚未收敛）**。

**RECEIVER_GATE=BLOCKED**：Workspace Agents 官方资料未证明进入指定已有普通 ChatGPT conversation
和最终可见消息回执；另有用户已确认的测试配置缺口（本轮尚未提供或确认测试目标/专用凭据）。
两类阻塞分开记录，补 token 不能解决路由缺口，也不据此断言整个 Phase E 不可行；真实事件/E2E 均为 0。
下一步先补齐原目标接收合同、账户与目标映射，明确遗留 pending 的限定 workspace 收敛范围；
条件成立后才做有限只读接收探针。独立 Agent 对话需用户确认需求变化。
生产 outbox、常驻 feedback pump、自动 revision 和 scheduler 不进入下一轮开发。
详细证据、能力矩阵及本轮普通 record 身份见 [Phase E 预检](phase-e-feedback.md)。

### B：strict post-turn finalizer（done）

**不是 generic scheduler**，只处理已证明的 self-busy。

#### Self-busy proof

`assessRolloutIdle`（normal rollout 与 finalizer 共用）产出结构化 `RolloutBlocker[]`：
self_turn 最后评估；同 self-thread 的 desktop active 不重复记 desktop_busy。
outcome_unknown 与原逻辑一致，不再 inspect。

仅当 **blockers 严格等于一个已 Desktop 证明的 self_turn** 才允许 schedule：
- CODEX_THREAD_ID + cwd workspace 匹配
- binding.threadId === origin
- `desktopIpc.currentExecution(workspace.root)` exact thread/host/project/root → runtimeStatus active/inProgress；普通 inspect 的 DESKTOP_BUSY 本身不授予 self proof

pairing/approval/other-desktop/remote/unproven → 普通 `pending_busy`，不 schedule。

#### Finalizer state / result

- active：`stateDir/post-turn-finalizers/<ws>.json`（strict，0600，atomic）
- result：`stateDir/post-turn-finalizer-results/<ws>.json`
- worker claim：`post-turn-finalizer-workers/<ws>.claim`（wx）
- commit 顺序：exact ownership → durable result → owner-safe 删 active
- unlink 失败 → `FINALIZER_ACTIVE_RELEASE_FAILED`（附 result）；active 保留 fail closed
- active target → release reference `finalizer:<ws>`；corrupt/dangling/workspaceRoot 错配全局阻断 GC
- result alone 不产生 release reference

#### Worker

- exact `node <target-release>/dist/cli/index.js post-turn-finalizer run`
- env 仅清 `CODEX_THREAD_ID` / `CODEX_SESSION_ID` / `C2C_STARTUP_LEASE`
- origin inspect 返回 DESKTOP_BUSY 或 active/inProgress → wait；仅实际 idle → preconditions + **normal** `rollout()`；其它错误仍 fail closed
- **rollout 前再次** `assertActiveJobOwnership`（precondition await 期间可丢失）
- 非 self-busy blocker 一律 terminal，不重试
- CLI orderly exit（含 owner-lost）在 finally 幂等 `releaseClaim()`；false → exit 1
- execution projection：`post_turn_<jobId>`，无 fake commandId/controlSession

#### UX

`c2c post-turn-finalizer status -w <ws>`；rollout item 可选 `finalizer:{jobId,status}`，
counts 契约兼容。

#### B Review / closeout

- 新 scheduled job **自动** spawn detached worker；existing 不再 spawn
- schedule `assessment` 必填；无 `assessRolloutIdle(workspace, null)` 绕过
- active 创建 `wx` no-clobber；identity 比较含 origin/runtime
- rollout 拿到 maintenance 后 **reconfirm** current install（`install_changed`）
- deadline = `job.expiresAt`；origin active → `wait`（`origin_still_active`）
- expectedRuntime 核对 build/pid/startedAt；pending reason 必须仍为 `busy`
- target entry canonical + current==target；strict finalizer schema 共享
- spawn 失败 → `worker_spawn_failed` result，ownership-checked commit，无 bypass
- result corrupt → `FINALIZER_RESULT_CORRUPT`；workspaceId 不匹配同码
- `rollout({ finalizerSpawnImpl })` 测试注入；生产默认真实 spawn

#### B 初始验证（历史基线）

- `tests/post-turn-finalizer.test.ts`：25/25（含 real rollout integration、
  precondition ownership 丢失、cleanup failure、strict reference）
- rollout / gc-plan / gc-apply / install / fork 回归全绿
- 完整 Vitest：**54 files / 896 passed / 0 failed**
- typecheck / build / git diff --check：通过
- 未部署、未 commit/push/reset/stash；未对真实机器执行 apply/rollout/restart

#### B real-protocol hotfix 与真实部署验收（2026-09-14）

- 定向 post-turn-finalizer + rollout：116/116；typecheck / build / diff-check 通过。
- output59 已通过 6 文件 / 82 tests，output60 通过剩余 48 文件 / 820 tests，共同覆盖当前 54 文件 / 902 tests；并非一次完整运行。
- 真实 dev-install -Test：53 文件 / 892 tests 通过（按脚本排除 fork-scripts），exit 0。
- 安装目标：`5b7733849f334d1bc75b88d7dcd065cfc169d098b644a714b9ef4a4504cccf2c`。
- 部署 turn 中保持 pending_busy / busy；production finalizer job `4aa51c07-bcaf-47f3-bed3-37cc358e9580` 已 scheduled。
- 后续 turn 只读确认该 job terminal `ok / upgraded`，finishedAt `2026-09-14T04:42:01.564Z`；status 显示 installed/runtime 均为上述目标，state=current，upgradePending=false。
- 此证据对应上述已安装 build；后续源码审查修订不代表机器已再次部署。

#### 最终提交审查修订

- 安装拒绝 machine bin 目录外链；GC runtime/pending 引用验证 canonical regular file 与 workspaceRoot 身份。
- 修订后 core-install 29/29、gc-plan + gc-apply 50/50；typecheck / build / diff-check 通过。
- 此次源码修订验收时未重新部署；2026-09-14 Phase E 的后续机器观察见
  [Phase E 预检](phase-e-feedback.md)，不得将本条历史状态当作当前机器结论。


## Phase E UI 探针 + E1a production feedback（2026-09-15 收官，未再部署）

- synthetic probe：默认关闭 `C2C_ENABLE_FEEDBACK_PROBE`；scope `feedback.probe`；UI `ui://c2c/feedback-probe/v4.html`
- production outbox：永久 scope `codex.feedback`；`stateDir/feedback/<ws>.json`；Desktop terminal → `C2C_EXECUTED`
- 验证：**57 files / 973 passed**；typecheck / build / `git diff --check`
- **not deployed**；next transport = browser companion

过程与终态详见 [phase-e-feedback.md](phase-e-feedback.md)。

## Phase E1b0 companion 委派 + reserved 状态机（2026-09-15，代码完成未部署）

- 状态机：`ready → reserved → claimed → observed|outcome_unknown`；reserved 可 release/stale→ready；claimed 仍不可逆
- 委派：one-time pairing intent → scoped companion credential（hash 存储）；绑定 `https://chatgpt.com/c/<id>`
- re-pair：有 in-flight（reserved/claimed/outcome_unknown）时 fail closed，禁止跨 companion 继承 attempt
- 公共面：`/api/companion/v1`（pair/state/reserve/release/begin-send/ack），经 tunnel；不弱化 MCP/admin
- MCP：`feedback_companion_pair|status|revoke`
- 验证：**58 files / 992 passed**；typecheck / build / `git diff --check`
- **not deployed**；不写 MV3/DOM；runtime 仍 pre-E1a

## Phase E1b1 Edge-first passive companion（2026-09-15，代码完成 + 真机验收通过，未部署 Bridge）

- 统一 route：`src/chatgpt/route.ts`；支持 `/c/<id>`、`www.`、`/g/g-.../c/<id>`（Project/GPT）
- MV3：`browser-companion/` → `dist/browser-companion`；permissions=`storage`+`activeTab`；hosts 仅 ChatGPT
- document ownership + popup 显式 Bind；SPA 轮询；只读 DOM adapter（未知不安全）
- ownership review-fix：popup status 经 content→SW；同 tab 换 document / 缺 documentId 清 owner
- **Edge 真机被动验收通过**（真实 Project conversation bind/reload/tab-switch；无 Send）
- **不** composer 写 / native Send / reserve / begin-send / Bridge deploy
- 验证：**60 files / 1024 passed**；typecheck / build（含 companion）/ diff-check
- **Bridge runtime not deployed**（extension 本机验收 ≠ Bridge rollout）
- next：**E1b2**

## Phase E1b2 transport + reversible reservation（2026-09-15~16，**code + server deployed**；live full-path **pending**）

现役（2026-09-16）：

- SW-only Bridge HTTP + credential；`TRUSTED_CONTEXTS`；optional host permission
- Pairing：exact owner + ownerProof；secret 仅 popup 内存；paste pairing JSON；origin local / intentId session
- Journal：`NONE → RESERVE_REQUESTED → RESERVED | RESERVATION_RECOVERY`；无 SEND_INTENT
- `/api/companion/v1`：pair/state/reserve/release；`companionApiUrl` 强制前缀
- fetchCompanion 保留 `Response.ok`；DOM idle：Stop 优先 + `text-submit-btn-text` action slot（generating 实证已锁）
- **已部署** Bridge runtime `637edb28`（workspace-scoped rollout）：认证后 `/state`、`/reserve` 自主 `reconcileFeedbackOutbox`，无需 MCP 踢一下
- MCP production feedback tools：**model-visible**（`ui.model` + `openai/visibility=public`）；OAuth `codex.feedback` 未放宽
- **不** begin-send / ack / composer / native Send
- 门禁：**61 files / 1059 passed**
- **live transport 端到端**（pair→state→reserve→release 在真机 Edge 完整通过）**仍 pending**；下一阶段 E1b3 在 Send 边界前必须先完成 live 验收

## Phase E1b3d3 production Send + late-positive ACK（2026-09-17，现役）

- Browser companion：显式 one-shot production Send（idle-only preflight）；durable journal 至 `OBSERVED_PENDING_ACK` / `OUTCOME_UNKNOWN`；**零自动重发**
- Late-positive：`OUTCOME_UNKNOWN` 仅在 exact server claimed/outcome_unknown + exact DOM user turn 时 `OBSERVED_PENDING_ACK → /ack → NONE`
- Trusted MCP ACK：`claimed|outcome_unknown` + exact attempt → `observed`；`observed` same-attempt 幂等；`retired_unknown` 拒绝
- Server-observed local closeout：authenticated `/state` exact observed proof + `inFlight=null` → SW clear local journal（零 DOM/ACK）
- Popup Recover：结构化 `ok/reason/action/zeroWrite/zeroClick/journal.*` + bounded diagnostic（无 message/credential）
- **Core deployed**：workspace `codex-with-chatgpt` build `6349ad98…`；live server event `observed`
- 详细终态见 [phase-e-feedback.md](phase-e-feedback.md)

## Phase E1b3d3b2 autonomy + exact message-body observation（2026-09-18，现役 code）

- Autonomy：默认 OFF；shadow 只读；armed 心跳调度 + journal-first recovery + durable cooldown + RESERVED continuation（不二次 reserve）
- Exact body observation：parent exact 或 parent ATTEMPT + ≤64 descendant **innerText full equality**；无 fuzzy/textContent authority
- Bounded diagnostics：heartbeat / evidence / recovery / DOM representation（allowlist，无 raw text/credential）
- Live ARMED E2E 已完成：最终 acceptance event 为 `eventId=2c6b1d23641f46c484410c45f9e92d1c`、`attemptId=587c6632-7fa3-487b-a42c-25922952324b`、status=`observed`；Reload、independent review、live ACK closeout 均完成，browser journal=`NONE`、Bridge `inFlight=none`。历史 event（包括 `e600aed6ef94…`）不再执行 Send、Recover、ACK、Retire、Reserve
- 详见 [phase-e-feedback.md](phase-e-feedback.md)

## Phase F1 operational hardening（2026-09-18，已完成；当前阶段为 Phase G）

### F1a operational readiness health（已合入 `44075ea`）

- 以现役 Browser Companion 的既有 SW status payload 为唯一数据源，新增纯诊断 health summary；不新增控制面或网络 endpoint。
- health summary 只暴露 mode、identity/owner/storage/transport 门禁、journal phase、in-flight、heartbeat 分桶新鲜度、cooldown 和 allowlisted decision/recovery reason；不含 message/DOM/credential/principal/document/tab/event/attempt 标识。
- 只读 popup health block 与状态 helper 不改变 reserve、begin-send、ACK、recover、retire 或 native Send 语义；`OUTCOME_UNKNOWN` / `OBSERVED_PENDING_ACK` 始终显示 recovery-required。
- F1a 门禁：**70 files / 1519 passed / 0 failed**；typecheck / build / `git diff --check` 通过。

### F1b resilience hardening（已合入 `90abcfe`）

- Test-first resilience matrix：SW restart hydrate、SEND_INTENT crash recovery、post-mutation fence、OBSERVED_PENDING_ACK、OUTCOME_UNKNOWN、owner loss、route drift、Bridge offline、authStale、durable cooldown、corrupt journal。
- Independent review 修复并合入：`OBSERVED_PENDING_ACK` 在 authenticated `/state` exact observed + `inFlight=null` 时支持 SW-only local closeout（zero DOM/ACK/Send）；解决 ACK 已成功但 response/local clear 因 crash 丢失后的 restart closeout。自动化入口：`tests/f1-companion-resilience.test.ts`（43 cases）；矩阵与契约见 [phase-f1-operational-hardening.md](phase-f1-operational-hardening.md)。

### F1c live resilience acceptance（2026-09-18，本轮）

- Live preconditions：Bridge running、`pairingActive=false`、runtime current；本会话无 Browser Companion 扩展控制面。
- Acceptance A/B/C/D 均 **automation-proven / live pending**：未操作历史 event、未创建 production event、未 Reload/rollout；结果与 operator 后续 live 边界见 [phase-f1-operational-hardening.md](phase-f1-operational-hardening.md)。
- 本轮仅文档，无 production code 变更。

- **NEXT_EXPECTED_STEP**：
  - **A/D**（owner / route resilience，**不需要** production event）：前提是 **paired + journal `NONE` + Bridge `inFlight=none` + SHADOW-only**。
  - **A** = reload / document ownership resilience：观察 owner-loss 必须用 **SHADOW**（`mode=off + journal=NONE + owner unavailable` 时 health 为 `off`，不是 `waiting_owner`）；结束恢复 OFF。
  - **D** = page route drift / ownership invalidation（**SHADOW-only**，禁止 ARMED）：route-change invalidation 清 owner → foreign-route heartbeat 非 exact owner → 不 production tick；返回原 route 不自动继承旧 owner（同 tabId ≠ 同 document）。
  - **transport identity drift**（bindingId / epoch / transport route 变化 → `disarmOnIdentityChange`）与 **page route drift** 分开，不混测。
  - **B/C** 仍需 future controlled fault injection + dedicated new event + independent review；禁止历史 event。
  - 历史 `NEXT_EXPECTED_STEP` 仅作收尾记录。

## Phase G — Seamless Daily Workflow（2026-09-18~19，当前阶段）

F1 已完成 Browser Companion 安全底座（operational readiness + recovery resilience）。
G 阶段聚焦用户体验与跨设备日常闭环，不再扩展 recovery 状态机。

### G1a — Unified Workflow Readiness（已合入）

- 新增纯只读工作流 readiness 聚合层：`src/workflow/readiness.ts` + CLI `c2c workflow status -w <workspace> --json`（`src/cli/workflow.ts`）。
- 输出有限 enum：`overall` / `nextAction` / connection·conversation·desktop·remote 投影 / `blockers`；不输出 threadId、bindingId、credential、raw command。
- Fail-closed：`authorization=unknown` / `connectorContract!=current` → `blocked`；`desktopCompatibility=none|legacy|incomplete` → `needs_authorization`。
- Project chat 使用 thread-scoped **`projectChats[]` map**（domain-separated fingerprint → verified URL，容量 128，满则 fail closed）：同 thread 可恢复自己的 Chat；`session.url` 仅作 latest/legacy 指针，**不是** ownership 真相。
- Desktop `currentTarget`（currentIdentity）与 `bindingAvailability`（inspect structured code）分离；`desktopErrorCode` 不依赖 `error.message`；identity 变化 → `blocked`。
- CLI 失败 JSON 仅 bounded code，不透传 `error.message`。
- **ready_local / reuse** = 本机执行路径已确认：connection ready + conversation ready + exact Desktop identity + binding inspect available + no unresolved delivery。**不等于** MCP request-scoped Connector scopes/schema 已验证（`desktopCompatibility` 仅为本地 AuthStore 汇总；G1b/G2 仍必须做 `workspace_info` + request desktopCompatibility + Connector schema check）。
- `exact + busy` → `busy`；`exact + unknown/unavailable` → `blocked`（机器 JSON 与 human 同定义，不软 Ready）。
- Bridge `running=stopped` → `needs_connection/repair_connection`（不因下游 admin facts 缺失误报 corrupt）。
- `projectChats[]` durable state **strict**：`null`/malformed/duplicate/超容量 → session corrupt fail closed，不 silent-normalize。
- 测试：`tests/workflow-readiness.test.ts` + `tests/workflow-cli.test.ts` + session fingerprint regression。
- 本阶段不改 Skill Activation、MCP `workspace_info`、Connector schema、Browser Companion。
- 路线：G1a 收口 → **G1b** Skill Activation 一次 readiness 只补缺失步骤（不得因 ready_local 跳过 web verification；恢复 Project chat 必须用 thread-aware URL projection，不得复用全局 `session.url`）→ G2 readiness 投影到 `workspace_info` → G3 跨设备从零 E2E。

- **G1a 已合入** `51cbe81`。

### G1b — Skill Activation consumes workflow readiness（已合入）

- `c2c session --json` 只读 `threadConversation`：Project `chatUrl` 仅来自 `projectChats` same_thread；禁止 `session.url` fallback。
- Activation 第一事实源为 `c2c workflow status`；`overall`/`nextAction` 分流；state-changing 后 bounded reread。
- `ready_local/reuse` 与 `ready_remote/use_remote` 不调用 bind-current；仍强制 request-scoped verification。
- Connector migration / Conversation Rebind 成功后 rerun `c2c workflow status`；仅 `nextAction=bind_current` 时才 Desktop bind-current。

### G2 — readiness projection into workspace_info（已通过 independent review，本轮合入）

- `workspace_info.workflow`：request-scoped bounded projection（`schemaVersion=1`），一次调用返回 workspace identity + connection/conversation/desktop/remote + `overall/nextAction` + `requestContext`。
- **Request token isolation**：`desktopCompatibility` 与 `authorization` 只来自当前 MCP request token（`ctx.desktopCompatibility(extra.authInfo)` / `requestAuthorization`），不借用机器 AuthStore aggregate；`runtimeUpgrade` 由 Bridge hook 只读投影，不 loopback probe。
- **Request conversation 与 durable `chatKnown` 分离**：MCP `conversation.chatKnown=false`、`chatBinding="none"`；官方 `_meta["openai/session"]` 只进入 `requestContext.conversationIdentity`；resolver `requestPolicy.currentConversation` 仅决定**本轮**是否可继续，不伪装 Project membership / same_thread durable binding。
- **Remote request scope gate**：`ready_remote` 前校验当前 request 具备 `codex.read + codex.control`；缺省 → `needs_authorization` + `remote_request_scope_missing|incomplete`。
- **Full-schema fail-closed fallback**：projection 失败时返回完整 `workflowOutputSchema` shape（`blocked/stop_unknown` + `workflow_projection_failed`），workspace identity 始终可作恢复入口；output schema 字段全部 bounded enum（共享 `readiness.ts` 常量 + `WORKFLOW_BLOCKER_CODES`）。
- **Connector contract 仍为 v1**（未 bump）；`workspace_info` 保持 readOnly；不自动执行 `nextAction`。
- 共享层：`src/workflow/facts.ts` + `src/workflow/request.ts`；CLI 仍走 `codex_thread` collector，不传 requestPolicy（G1a parity）。
- 测试：`tests/workflow-request.test.ts`、`tests/workflow-mcp-projection.test.ts`（HTTP Cases A/B/C + projection failure）、readiness/cli/mcp-integration 更新。

- **G2 已通过 independent review**（full suite 1628 passed）。

### G3 — route-principal attestation（2026-09-19，live E2E **PASS**）

G3 修复 Browser Companion 误绑错误 ChatGPT conversation 后 production Send 投错 chat 的问题。
`paired ≠ origin conversation attested`：pair 只注册 credential+route，**reserve/begin-send 要求 route 已验证**。

**现役实现（code committed `84e67e4`…`b961438`；workspace `2582910bf0d2` install `f728012c…`）**

- **Server contract**：pair 铸 pending challenge（`challengeId` + `challengeDigest`，绑定 workspace/binding/epoch/companion/route）；MCP `feedback_companion_route_confirm`（scope `codex.feedback`，principal 仅来自 `openai/session`）。wrong principal **不消费** challenge。
- **Browser gates**：route `PENDING` 时 Arm / Reserve / production begin-send 均拒绝；authenticated `/state` 为 **唯一** `VERIFIED` 权威；DOM 观察不得写 VERIFIED。
- **Attestation one-shot Send**：popup 不传 message；SW owns `[C2C_ROUTE_ATTEST]` body；dedicated CS runner；observer 仅 `collectBoundedDescendants`（≤64 BFS）+ `innerText` canonical equality + exact `challengeId` marker；**无 ATTEMPT_ID 语义**、无 production journal。
- **Durable fence**（`chrome.storage.local`）：`NONE → PAIRING_TRANSITION → ROUTE_ATTEST_DISPATCH → OBSERVED_PENDING_CONFIRM → VERIFIED | OUTCOME_UNKNOWN`；session latch 不够；corrupt fence fail closed；**任何 non-NONE fence（含不同 identity）一律 block**；transport clear 不清 fence；仅 re-pair（新 companionId+challengeId）写 matching `NONE`。
- **Pair barrier-first**：调 `/pair` 前 durable 写 `PAIRING_TRANSITION`；`prev*` 在改全局前捕获；`TRANSPORT+LOCAL+FENCE` 尽量同一次 `storage.local.set`；4xx 可恢复 prev fence，网络/5xx 保持 barrier；pair **非** success 若 durable commit 失败。
- **Post-write ready gate**（`b961438`）：write/verify 后按 send-probe 契约 poll——仅 `kind=send` + `enabled` + form `data-testid=send-button` 才 dispatch；`idle` 不是 click target；成功判定为 `click.ok`（生产返回 `clicked:1`）。
- **Classic packaging**：content_scripts **禁止** ESM `dom-adapter.js` / `turn-observer.js` / `route-attestation*.js`；CS 使用 `dom-adapter-global.js` / `turn-observer-global.js` / `route-attestation-global.js` / `route-attestation-run-global.js`；SW ESM import graph 保留原文件名；`send-probe-run` / `send-click-adapter` classic 为 IIFE + namespaced `__c2c*` 绑定；build fail-fast（manifest 禁 ESM、provider 先于 consumer、`new Function` parse、真实 `import()` dist ESM link 测试）。
- **Popup Grant Bridge access**（`9dc88d7`）：`chrome.permissions.request` 在 click handler **同步**调用（gesture-first）；Pair 仅 `permissions.contains`，缺权限 `bridge_permission_missing`。
- **门禁**：最近 full vitest **80 files / 1775 passed**；typecheck / build / `git diff --check`。Extension 需 Edge **Reload** `dist/browser-companion` 才加载新 CS/popup。

**边界（未改 / 不得弱化）**

- production journal / late-positive ACK / autonomy / pair credential / OAuth scope 门禁不变；无自动重发。
- Fence 实际字段：`companionId + challengeId + routeCanonical + …`（**无** bindingId/epoch）；server challenge digest 已绑 binding/epoch。
- HTTP authenticated `/state` 可含 attestation message（SW 恢复用）；popup SW payload 仅 `routeAttestationPending`。

- **G3 live acceptance：PASS（2026-09-19）**。跨设备 Desktop smoke 与 route-principal attestation 闭环已完成；后续实现不得把旧的 `live E2E pending` 当作当前状态。
- **NEXT_EXPECTED_STEP**：**G4 — new-Chat bounded bootstrap + same-browser rebind**。
  - Operator 顺序：**先**只读 `feedback_status` → 新 ChatGPT conversation → pair → route verify（`feedback_companion_route_confirm`）→ Arm → Desktop smoke。
  - 路径：`workspace_info` → bounded workflow readiness → 安全 Desktop/Remote → Codex 执行 → Companion 反馈回 **已验证** conversation → independent review → DONE。
  - 不要求用户手工搬 workspaceId / threadId / bindingId；不得自动降低授权、审批、`outcome_unknown` 或 Project ownership 门禁。
  - **前置约束**：`requestContext.conversationIdentity=available` ≠ Project membership ≠ durable same-thread Chat binding；live 闭环必须依赖 **route attestation VERIFIED**，不得把 `currentConversation` 当永久绑定。
  - 历史 Connector `test_status` 不得替代本次 live acceptance；后续仍以现役 runtime/status 为准。

### G4a + G4b — bounded bootstrap / same-browser rebind（2026-09-19，implementation ready for review）

- MCP `feedback_bootstrap_status` 只根据当前 request 的 `openai/session` principal 投影有限状态：`DISABLED`、`OWNED_VERIFIED`、`OWNED_NEEDS_BROWSER_REBIND`、`FOREIGN_SAFE_TO_TAKEOVER`、`BLOCKED_INFLIGHT`。仅 foreign-safe 返回 takeover 所需 `expectedEpoch + widgetId`；不返回 principal、credential、secret 或 hash。
- `reserved / claimed / outcome_unknown` 一律 `BLOCKED_INFLIGHT`；takeover 的 `expectedEpoch` CAS 与原有 in-flight fence 不变。
- takeover 后 predecessor credential 对 `/state`、`/reserve`、`/begin-send`、`/ack`、retire 等 production API 继续无效；它只可访问 `/rebind/init` 与 `/rebind/complete`。
- `/rebind/init` 仅接受同 workspace 的 immediate predecessor、exact successor epoch、无 in-flight 状态；创建持久化、TTL、one-shot challenge，不授予 production authority。
- current Chat 仍通过现役 `feedback_companion_route_confirm` 完成 request-scoped principal attestation；wrong principal 不消费 challenge。确认后 `/rebind/complete` 才旋转 fresh credential；Browser 再以 authenticated `/state` 取得唯一 `VERIFIED` 权威。
- Browser SW 复用既有 route-attestation runner、session latch 与 durable fence；init 前 barrier-first，网络/5xx/storage ambiguity 进入 fail-closed fence，不自动重发。autonomy 默认 OFF，identity 变化强制 disarm。
- cold `feedback_companion_pair` fallback 保留；未增加 manifest permission、自动 Arm、Connect & Arm 或第二套 DOM runner。
