# 串行回归性能记录

## 当前状态（2026-10-15）

本次归档范围为串行回归优化：GC fixture 复用、Probe CLI 轻量入口、Supervisor/retention/build ID 等重复准备收缩，以及两处生产优化（Supervisor cycle 复用 `readConfig` 的 ownership 检查；历史格式化只缓存 artifact 路径、继续实时校验文件身份和内容）。具体覆盖取舍与阶段证据见下文。

- 最近一次正式串行全量是 2026-10-14 的 **180 文件 / 3061 测试 PASS，exit 0，wall 2053.108 秒**。之后的 retention 与 build ID 调整只有定向验证，不能把这份历史全量当作当前快照的完整门禁。
- 后续验证：retention 完整文件 **55/55 PASS**；build ID 完整文件 **7/7 PASS**。retention 的 post-confirm preview 从 40 次缩为 3 次，但单次耗时没有下降，尚无稳定提速证据。
- `desktop-abandonment-repair.test.ts` 的 fixture 优化候选尚未实施；现有 **68/68 PASS** 报告只是当前实现的诊断，不是优化后的结果，也未证明 `beforeEach` 是主要耗时来源。
- 正式门禁仍为 `pnpm test --maxWorkers=1 --testTimeout=90000`；`test:parallel` 与 `test:full:candidate` 均不能替代。此次文档收尾不因纯文档修改重复已通过的代码回归。
- 本次归档包含源码、测试与文档；安装、rollout、服务重启及线上验证不在范围内。ignored `.tooling` 诊断证据保留，不随源码提交，也未执行残留清理。

以下各节的“本轮”“未提交/推送”等措辞描述对应阶段当时的状态；提交与远端状态以 Git 为准。

观察日期按各阶段分别记录，时区 Asia/Shanghai。本文分阶段记录测试准备优化和旧伴侣源码退役；时间单位均为秒，源码验证不代表部署。

2026-10-14 核对：2026-10-13 的 ignored 原始证据目录 `.tooling/serial-regression-20261013/`、`.tooling/retire-companion-20261013/`、`.tooling/supervisor-init-20261013/`、`.tooling/process-init-20261013/` 本机目前均缺失。下文这些路径及保存位置描述仅作历史出处，已记录的历史实测值保留；本轮未重新核验旧 raw 文件。

## 第一阶段：旧伴侣退役前的测试准备提速

以下为第一阶段同轮单次定向 A/B 实测。

| 定向范围 | 前/后通过数 | wall（外部耗时）前→后 | Vitest 前→后 | case（用例耗时合计）前→后 |
| --- | --- | --- | --- | --- |
| Record CLI、GC apply、GC plan 三文件 | 98→99 PASS | 184.5707356→160.5120238 | 180.71→155.48 | 170.336→144.898 |
| Supervisor store 四个目标用例 | 4→4 PASS | 107.9268247→84.426213 | 105.01→81.17 | 100.135→74.430 |

两组 wall 合计从 292.4975603 降至 244.9382368，节省 47.5593235 秒（16.26%）。CLI 新增一个接线 guard，因此通过数增加一例。Supervisor 使用 `-t` 只匹配四例，其他 20 例显示 filtered skipped；这不是全量回归跳过用例。

CLI 各文件的 duration 拆分：`gc-apply` 85.238→87.454 秒，`gc-plan` 41.776→41.510 秒，`record-cli` 43.327→15.938 秒。已观测到的主要收益来自 Record CLI 和 Supervisor；GC 整文件尚无明确提速。GC CLI 合同用例合计约 54.995→54.043 秒，差值仅约 1 秒，单次对照不足以确认稳定收益，不宣称 GC 独立提速。

改动只收缩测试准备：Record CLI 复用已有轻量入口；GC 使用专用入口注册真实生产命令，并保留 `gc-plan.test.ts` 的 `healthyPlanRun` 通过完整生产入口执行成功 plan；Supervisor 四例只初始化真实私有目录，配置写入另有场景覆盖。独立 Node/tsx 进程、全部场景断言、真实 GC 业务与持久化及真实 ACL observer 均保留。受测锁/启动凭据仍经过真实 ACL 和身份验证；省掉的是无关配置事务所附带的重复校验。

## 复现命令

在仓库根目录执行，每次只运行一个测试进程。以下命令使用当前 checkout；前后对照需要分别使用对应版本，不能把当前代码重复运行作为历史基线。

```powershell
pnpm test tests/record-cli.test.ts tests/gc-apply.test.ts tests/gc-plan.test.ts --maxWorkers=1 --testTimeout=90000
pnpm test tests/supervisor-store.test.ts --maxWorkers=1 --testTimeout=90000 -t 'failure before acquiring the exact runtime|refuses an unknown or reused operation owner|rechecks operation lock identity before unlink|corrupt owner is busy and preserved'
```

如需保存 JSON，追加 `--reporter=default --reporter=json --outputFile=<本轮独立文件路径>`；wall 由外部计时，Vitest 耗时见日志，case 为 JSON 内通过用例的 `duration` 合计。原始前后 JSON、日志和 meta，以及第一阶段 full 证据保存在已忽略的 `.tooling/serial-regression-20261013/`，供本机复核。

正式完整门禁命令：

```powershell
pnpm test --maxWorkers=1 --testTimeout=90000
```

第一阶段、旧伴侣退役前的正式串行全量于 2026-10-13 14:11:25–14:49:19（Asia/Shanghai）完成：**194 文件 / 4090 测试全部通过，exit 0，pending/todo 0，无未处理错误标志**。wall 2274.7222464 秒（37 分 54.72 秒），Vitest 2271.68 秒。冻结输入哈希无变化，测试临时目录新增残留 0，结束后未发现 Vitest/candidate 进程；此处未做整机所有子进程或 listener 归属审计。`test:parallel` 仍是实验入口；candidate manifest 保持冻结失效，不刷新 manifest，也不作为正式门禁。

单次定向 A/B 不外推全套收益。2026-10-11 历史全量为 185 文件、3984 用例、wall 2197.56 秒，仅作历史参照；与第一阶段 194 文件范围不同，不能作为受控前后对照。

第一阶段静态检查：typecheck、git diff --check 通过。该阶段仅修改测试与文档，无生产代码改动，未额外运行独立 build；全量中的 packaging 构建测试正常执行。日志仍有既有 route.js.map 缺失诊断，最终退出码及报告通过，未扩大修改打包机制。

## 第二阶段：旧伴侣源码及专属测试退役

2026-10-13 本轮删除 26 个旧浏览器文件和 14 个纯旧测试文件，清理混合测试中的旧分支；现役轻量 Companion、共享 DOM/observer/write/click 依赖，以及 Bridge 安全门禁、Result Bus、receipt 与 MCP write-probe 保留。补回两个真实 click adapter 的 `mutationGuard` 返回 false / 抛异常时零点击用例。该阶段包含生产源码与构建清单改动，不适用第一阶段“仅测试与文档”的范围说明。

定向验证为 **24 文件 / 529 测试 PASS**；随后补充 click 用例的文件 **43 测试 PASS**。typecheck、build 与 `git diff --check` 通过。

正式串行全量于 **2026-10-13 16:15:36.7576173–16:50:53.1101349 +08:00** 完成：**180 文件 / 3046 测试全部通过，exit 0，failed/pending/todo 均为 0，无未处理错误输出**。wall 为 **2116.3532008 秒（35 分 16.35 秒）**，Vitest 为 **2114.07 秒**。

| 同日正式串行全量 | 旧伴侣退役前 | 旧伴侣退役后 | 差值 |
| --- | --- | --- | --- |
| 测试文件 | 194 | 180 | 减少 14 |
| 测试数 | 4090 | 3046 | 减少 1044（约 25.5%） |
| wall | 2274.7222464 秒 | 2116.3532008 秒 | 减少 158.3690456 秒（2 分 38.37 秒，约 6.96%） |
| Vitest | 2271.68 秒 | 2114.07 秒 | 减少 157.61 秒 |

以上是同日两次单次观测，不是受控、稳定的 A/B；主要耗时的未改模块也存在耗时变化，不能将全部差值归因于退役。第一阶段定向 A/B 的 47.5593235 秒（16.26%）证据独立保留，不能与第二阶段全量差值相加作为全量节省。

本轮 full 前后冻结输入哈希不变，新增测试临时目录残留 0，结束后无 Vitest/candidate 残留进程；这些检查不是整机进程归属审计。原始证据保存在已忽略的 `.tooling/retire-companion-20261013/`。

本轮未部署、重载扩展、重启服务、commit 或 push；Python helper 未改，未重复 Python 独立协议回归。真实网页和运行版本验收不由上述源码测试替代。

## 第三阶段：Supervisor 五项用例的重复初始化优化

本轮仅调整 `tests/supervisor-store.test.ts` 的五项测试准备及相邻中文注释。生产 ACL、超时、observer、teardown 与共享 hooks 均未改；该文件仍为 24 项，项目测试总数仍为 3046，未删除用例。

两个 launch 测试将 `createConfig` 改为真实 `withSupervisorOperation` noop。三个锁测试去掉前置 noop，在被测入口完成真实私有目录 ACL 后，于首次当前进程身份 probe 中一次性 seed 旧锁、替换前锁或破损锁；继续保留 `fakeProbe` 异步让步，新增 `seeded` 与 action 未调用断言。按源码调用链推导减少 15 次 ACL PowerShell 进程，未独立进行进程计数采样；没有缓存 ACL 或返回假成功。

以下为 2026-10-13 +08:00、相同 `-t` pattern 的五项定向 A/B：before 为 **18:26:07.4205939–18:27:27.2843440**，after 为 **18:31:50.2964093–18:32:35.4154749**，两次均 **5 PASS、exit 0**。其余 19 项由 `-t` 未选择，不是代码添加 skip。

| 五项定向范围 | before | after |
| --- | --- | --- |
| wall | 79.8812983 秒 | 45.1176323 秒 |
| Vitest | 77.64 秒 | 42.92 秒 |
| case 耗时合计 | 73.2671787 秒 | 39.0389185 秒 |

wall 减少 **34.763666 秒（43.51915497%，约 43.5%）**。这里只实测五项用例，不能宣称整文件或全量提速 43.5%，也不与前两阶段收益累加。

复现命令使用当前 checkout；复现 before 须使用证据中的 `supervisor-store.before.ts` 对应版本，不能将当前代码重复运行当作历史基线：

```powershell
pnpm test tests/supervisor-store.test.ts --maxWorkers=1 --testTimeout=90000 -t 'validates the exact launch identity|identical-content replacement before the child|refuses an unknown or reused operation owner|rechecks operation lock identity before unlink|corrupt owner is busy and preserved'
```

原始证据位于已忽略的 `.tooling/supervisor-init-20261013/`：`before.json`、`before.log`、`before-meta.json`，对应的 `after.json`、`after.log`、`after-meta.json`，以及基线源码快照 `supervisor-store.before.ts`。

最小改动经主代理和独立 explorer 审查，上述定向验证通过；本阶段 typecheck 与 `git diff --check` 均通过。未再跑全量、build、Python 独立回归或现场验收，未 commit、push、安装或重启。

## 第四阶段：其他慢测试的重复启动准备优化

本轮只修改 `tests/fork-scripts.test.ts`、`tests/fixtures/web-control-cli.ts` 与 `tests/web-control-cli.test.ts`；`tests/record-cli.test.ts` 是 fixture 调用方，参与回归但本轮未改。

Fork 从原未初始化 seed 通过普通 `cp` 复制独立 repo 与 remote，真实 update 一次生成第二份 tracking seed，再通过普通 `cp` 准备对应场景。创建 tracking 的用例仍用原 seed；其他五次准备 update 由新 seed 的一次 update 替代，按调用链净减少四次 PowerShell 启动及其内部初始化 Git 链。每例真实 Git remote URL、realpath、完整 `.git` 快照、无 hardlink 和严格清理均保留；被测 equal/ff/ahead/diverged/worktree，以及 HEAD/index/stash/dirty 保留路径的真实调用均未省略。

CLI fixture 按 `argv[2]` 的三个 switch 分支动态 import 真实 registration，每次仍启动独立 Node/tsx 进程，执行真实持久化动作并保留生产接线 guard；没有合并进程或删除用例。

以下为 2026-10-13 +08:00、同范围三文件 29 项的串行 A/B：before 为 **18:58:19.4078787–19:00:59.1047814**，after 为 **19:05:37.2427434–19:07:42.7649573**。两次均 **29 PASS、exit 0，failed/pending/todo 均为 0**。

| 三文件定向范围 | before | after |
| --- | --- | --- |
| wall | 159.6958923 秒 | 125.7584667 秒 |
| Vitest | 155.94 秒 | 122.99 秒 |
| fork-scripts：13 项文件耗时（JSON endTime − startTime） | 109.5783374 秒 | 92.4115344 秒 |
| web-control-cli：3 项文件耗时（JSON endTime − startTime） | 22.9294138 秒 | 16.8444055 秒 |
| record-cli：13 项文件耗时（JSON endTime − startTime） | 20.4523887 秒 | 11.2757820 秒 |

wall 减少 **33.9374256 秒（21.25128274%，约 21.25%）**。这是单次同范围测量，不外推全量收益，也不与前阶段直接累加；耗时较长的 Desktop repair/history、Result Bus 安全与真实恢复流程均保留。

复现命令使用当前 checkout；历史 before 对照须使用对应源码快照，不能将当前版本重复执行作为历史基线：

```powershell
pnpm test tests/fork-scripts.test.ts tests/web-control-cli.test.ts tests/record-cli.test.ts --maxWorkers=1 --testTimeout=90000
```

typecheck 与 `git diff --check` 通过，新增测试临时目录残留 0，未清理旧数据。证据位于已忽略的 `.tooling/process-init-20261013/`，包含 `before.json`、`before.log`、`before-meta.json`、对应 after 文件、`summary.json` 与三份 `*.before.ts` 源码快照。

未修改生产代码、timeout、retry 或正式串行策略；未运行全量、build、Python 独立回归或真实环境部署，未 commit 或 push。

## 2026-10-14：Supervisor 退役用例与生产 cycle 的重复校验优化

本轮两处改动：退役用例直接构造字段完整的 `SupervisorConfig`，删除与人工 cycle 无关的配置事务和读取，保留真实 lease 获取、释放及 runtime/lease 清理断言；生产 `cycle` 入口仅检查 lease，由真实 `readConfig` 完成 operation 复核。恢复前的 lease + operation 双复核及操作结束后的复核保留；真实 store、ACL_SCRIPT、15 秒超时、probe、ownership 与 teardown 均未改。

| 实测范围（秒） | 修改前 | 修改后 |
| --- | --- | --- |
| 退役用例 case 时间 | 两轮 48.9414284 / 40.9775338 | 22.1425688 |
| 退役用例真实 ACL 次数 | 两轮均 14 | 7 |
| 生产 cycle 分段 wall | 32.581155 | 18.9437162 |
| 生产 cycle 真实 ACL 次数 | 8 | 7 |

case 时间与 ACL 总耗时口径不同：退役用例两轮旧 ACL 总耗时为 48.562159 / 40.6336791 秒，本轮为 22.0613454 秒。cycle 对照使用同一新隔离 fixture、真实 store 和 lease，历史 factory 来自完整 Git blob，仅重定位相对 imports；准备阶段的 11 次 ACL 与释放阶段的 2 次 ACL 另计。所有观测 ACL 成功且 scriptHash 一致。调用次数减少已实测确定；时间是单次顺序观测，含 PowerShell 波动，不能把全部差值归因于这两处修改，也不外推全量收益。

默认轻量测试新增 5 项，覆盖入口 lease/operation 失权时 action 零执行、跨 observation await 失权时 ensure 零调用，以及健康路径顺序与无额外入口 operation 检查；`supervisor.test.ts` **30 项 PASS**。退役真实定向 **1 PASS** 与 cycle 真实对照 **1 PASS** 均 exit 0，后者是 ignored 诊断 harness，不计入默认测试。两次真实诊断输入 hash 前后不变，临时目录集合不变，fixture 已清理，结束后无 Vitest/candidate 残留。

本轮证据位于已忽略的 `.tooling/supervisor-optimize-20261014-101159/`，历史两轮位于 `.tooling/supervisor-profile-20261014-094218/`；退役旧 case 时间取历史 `comparison`，本轮结果见各自 Vitest JSON、ACL 原始记录与分段数据。此次修改前的串行全量 **180 文件 / 3046 测试 PASS**、wall 2330.0904895 秒（Vitest 2325.85 秒）仅作历史证据，不能替代本轮验证。本轮 typecheck、build 与文档 `git diff --check` 通过；未再跑全量、安装、部署或重启，源码 build 不代表部署。

## 2026-10-14：细节 fixture 与 GC CLI 重复准备优化

本轮仅修改五个测试文件：`legacy-reconciliation.test.ts`、`execution-result-reconciliation.test.ts`、`workspace-history-format.test.ts`、`gc-apply.test.ts`、`gc-plan.test.ts`。默认测试数量新增 0；收缩重复准备与 I/O，必要的生产校验、独立 state/root 和真实持久化入口保留。

同一观测 harness、同范围 14 项串行 before/after 均 **14 PASS、exit 0**；其余 147 项是 `-t` 未选择，不是新增 skip。计数使用 `vi.spyOn` 原样透传 `fs.openSync/closeSync/fsyncSync/renameSync/copyFileSync`，成功后统计，原异常继续抛出；fsync 根据 fd 的原始文件路径分类，rename 只计目标状态 JSON 提交，GC static copy 只计 checkout 的 `dist/core-assets`，不计 release 复制或子进程调用。

| 同范围真实文件操作 | before | after |
| --- | --- | --- |
| legacy 五例 output body fsync | 210 | 10 |
| outcome_unknown 三例 Desktop / Routing rename | 8 / 20 | 5 / 14 |
| outcome_unknown 三例 execution record fsync | 5 | 2 |
| repair 拒绝五例 body fsync / Desktop / Routing rename | 5 / 5 / 5 | 0 / 0 / 0 |
| repair 拒绝五例 Remote rename | 15 | 0 |
| repair 拒绝五例合法 execution record fsync | 5 | 5 |
| GC 十候选用例 checkout 静态资产 copy | 60 | 5 |

legacy 五例保留初始正文证据及每例 40 次真实 metadata 提交，只将填充正文改为空；horizon、保留索引、next ID、同 ID 漂移与无 snapshot 的拒绝断言不变。三个 outcome_unknown 用例取消无关默认 accepted Command、Desktop delivery 和 receipt 准备，其余 21 例仍每例独立创建默认 accepted fixture。repair 五例移除无关 full seed，真实 proof/quarantine、合法 record 哨兵、精准 error code 与全字节不变断言保留。正常 history seed 的 Remote 前两次事务合为一次，保留 previous 字段、workspace root gate 及最后 outputId 提交。

GC 每个 fixture 首 marker 完整生成静态 assets、dependency 摘要和 buildId，后续 marker 仅用真实 `writeBuildId` 刷新；`installCore` 仅读取 checkout 资产，发布写入独立 state/release。十候选用例共 12 个 marker，**真实 installCore 仍执行 12 次**，静态准备明确减少 55 次 copy；独立真实安装、GC、read-reference、fence 与 CLI 合同覆盖保留，空 markers 行为不变。

| 14 项单次观测（秒） | before | after |
| --- | --- | --- |
| 外部 wall（meta） | 32.8960925 | 44.4447052 |
| Vitest | 30.83 | 42.70 |
| tests | 20.37 | 20.76 |
| transform / collect | 3.62 / 7.90 | 10.04 / 16.69 |
| GC 十候选单 case | 4.0591373 | 11.5155742 |

I/O 计数下降已实测，但该轮 wall 增加，transform/collect 变慢，GC 单 case 也变慢；不能宣称 GC 稳定提速或整套提速，不以 case 合计推断全量收益。两次运行期间输入 hash 无变化，观测 harness hash 相同；测试临时目录前后均空，结束无 Vitest/candidate 残留。证据位于 `.tooling/detail-fixture-20261014-105402/` 的 `baseline/`、`after/`，含 JSON、log、meta、每例计数、输入 hash 和沙箱/进程快照，对照见 `after/comparison.json`。reconciliation 的 describe 名称调整，14 个 leaf case 名称相同；首次汇总按 fullName 比较失败及改为 leaf title 匹配的说明见 `after/comparison-note.txt`，未重跑测试。

另对 GC apply 参数互斥 case 做一次独立串行对照：去掉已由 `gc-plan.test.ts` 强断言覆盖的重复 plain gc 启动，真实 CLI spawn **5→4**，被移除 plain 启动原耗时 **3.0249431 秒**；wall **24.5332286→20.7541944 秒**，减少 **3.7790342 秒（15.40%）**。plain gc 的非零退出及 `--plan/--dry-run` 提示断言仍在 gc-plan；其他 apply 互斥断言保留。此结果只对应该单 case，证据为 `.tooling/gc-cli-dedupe-20261014-110950/counts.json`。

最终五个改动测试文件完整定向回归 **193 PASS、exit 0，failed/pending/todo 均为 0**；Vitest **299.63 秒**，wall **302.2259996 秒（5 分 02.23 秒）**。这是功能验证，不是全量门禁。输入 hash 无变化，新增测试临时残留 0，未删旧临时目录，无未处理错误标志，结束无 Vitest/gc-cli 残留；证据见 `.tooling/detail-fixture-20261014-105402/affected-regression/verification.json`。

上轮 Supervisor 改动的 typecheck/build 已通过，本轮仅测试与文档，不重复运行；本轮文档 `git diff --check` 通过。未跑全量、Python 独立回归、安装或部署，未 commit/push。后续继续定位 CLI 加载与 GC 准备成本；本记录不表示整个性能目标完成。


## 2026-10-14：Probe CLI 注册加载优化

本轮生产代码修改 0；仅新增 `tests/fixtures/probe-cli.ts` 并调整 `feedback-probe-cli.test.ts`、`write-probe-cli.test.ts`。轻量入口按 `argv[2]` 动态 import 真实 `registerFeedbackProbeCommands` / `registerSetupCommands`，复用生产 Commander 名称、描述、版本、help 与 `parseAsync` 错误处理。feedback 首次 status 与 write-probe 首次 status 保留完整 `src/cli/index.ts` smoke，其余 7 次走轻量入口；前后均为 **9 个独立 Node/tsx 进程**，未合并进程或模拟 command action。

真实 state/store、principal 绑定、MCP 开关、临时 Bridge 启动与关闭、运行中 Bridge 开关优先、nonce、坏文件不覆盖及不创建状态目录断言均保留；坏文件不泄漏原文的断言复用同一次失败调用。新增一个快速接线 guard 检查两个 command/function/module 三元组、生产 import/registration 及 Commander 设置，不增加子进程。

| 两文件单次串行观测 | before | after |
| --- | --- | --- |
| 通过数 | 6 PASS | 7 PASS（新增 1 guard） |
| 原有 6 场景 case 合计 | 27.5392447 秒 | 13.8078132 秒 |
| 外部 wall | 33.790 秒 | 19.501 秒 |
| 完整入口 / 轻量入口启动数 | 9 / 0 | 2 / 7 |

wall 减少 **14.289 秒（42.29%）**；新 guard 的 **11.2731ms** 单独计时，不混入原 6 场景合计。健康 Bridge 场景 **2.8627702→3.1295069 秒**略慢；这是单次顺序观测，不能宣称所有场景提速或外推全量收益，也不以 import 数量直接推断收益。

before/after 均 exit 0，使用相同透明 `node:child_process.execFile` 观测 harness，原参数、回调、返回值、异常及 `promisify.custom` 调用保留；原始记录含 entry/argv、start/end/duration 与 exit。两轮运行内输入 hash 不变，原有 9 项 dirty 与 harness 前后 hash 一致；无新增测试临时目录或 Vitest/探针 CLI 残留进程。证据位于已忽略的 `.tooling/probe-cli-20261014-113418/comparison.json`，对应目录保存原始 JSON、日志、子进程记录及输入快照。

复现当前定向范围：`pnpm test tests/feedback-probe-cli.test.ts tests/write-probe-cli.test.ts --maxWorkers=1 --testTimeout=90000`；历史 before 须使用对应旧源码，不能把当前代码重复运行作为基线。主代理独立检查实现和观测透传后接受；仅测试与文档改动，不重复 typecheck/build。文档 `git diff --check` 通过，未运行全量、安装、部署或提交。

## 2026-10-14：GC 准备与执行阶段定向诊断

对三个真实 GC 场景做一次串行分段观测：**3 PASS、83 项 filtered、exit 0**。此轮为当前实现诊断，没有旧版对照，尚未实施 seed 优化。

| 场景 | marker 数 | 准备耗时（ms） | GC 耗时（ms） |
| --- | --- | --- | --- |
| 合法 current 保留 | 2 | 263.5123 | 58.4690 |
| exact pending A 与无关 B | 3 | 443.5942 | 475.5167 |
| 十候选及无关损坏 release | 12 | 1873.2114 | 2555.9133 |

准备耗时为 installCore、全部 writeBuildId 及剔除内嵌 writeBuildId 后的 buildCoreFixture 耗时之和，合计 2580.3179ms；复核计算见同目录 `preparation-verification.json`。合计真实 `installCore` **17 次**、`writeBuildId` **17 次**、`buildCoreFixture` **3 次**。`planGc` **18 次**中，apply 内部 plan 已包含在 apply 耗时里，不可再次相加。十候选准备阶段 **72 次 fsync 合计 252.6257ms**；三个场景全部阶段 **106 次 fsync 合计 332.772ms**。fsync 数量和耗时只是成本的一部分，不能当作全部准备或 GC 成本。

tracked 输入前后 hash 相同，临时目录集合及 Node 进程身份集合无新增残留；证据为 `.tooling/gc-phase-20261014-113646/summary.json` 与 `evidence.json`。GC 预快照未覆盖 untracked `probe-cli.ts`；主代理另将 probe after 快照与当前文件 hash `68b290e4d94bae4341de3e1db2bd264c009432bfc0a92fc3e391ba119cb206fc` 比对一致，且这三个 GC case 不执行该入口。这是补充证据，不构成 GC 全仓输入的独立前后 hash 证明。

下一步候选是按 marker 序列通过真实安装生成隔离的普通 copy seed；实施前须证明 bootstrap、manifest、current 路径及可变文件隔离等价。此处仅记录候选，没有修改生产代码、测试准备或诊断原文件；不宣称本轮已获得 GC 对照收益。

## 2026-10-14：GC 安装模板复用与重复校验削减

仅新增 `tests/gc-fixture.ts` 并调整 `gc-plan.test.ts`、`gc-apply.test.ts`，生产 GC 与安装器不变。两个测试文件各自按完整 marker 序列缓存通过真实构建、真实安装生成的模板；每个 case 仍创建独立 state/checkout，通过普通文件复制生成副本，不使用 hardlink、junction 或共享可变文件。复制前后核对包含空目录的完整 snapshot、canonical root 与普通文件 `nlink=1`，仅重绑定 current/返回 metadata 的 `checkoutRoot`、`releaseRoot`。release manifest、bootstrap、build/artifact/manifest 摘要及 seed 的 installedAt 保持原值；空序列不生成安装记录。

新增 1 项实质等价及隔离测试：对照一次全新真实安装，核对 full 安装验证、manifest/bootstrap/checkout 字节与归一化 GC plan，覆盖重复 marker 与空序列；破坏一个副本后验证另一个及再次生成的副本仍完整。全新安装的 installedAt 与模板时间可以不同，比较其余非路径字段并检查模板时间原样保留，不能声称 fresh metadata 全字节一致。原真实 planGc/applyGc、删除前引用复核及 CLI smoke 均保留。

初版候选对每个 case 扫描全部积累模板，虽然两文件 wall 为 **138.135501→106.124259 秒**，但单独排除 CLI 的 83 组交替测量得到 fresh/cache 生命周期 **44.208454→51.377271 秒**，反而慢 **7.168817 秒（16.22%）**；其中 cache guard 耗时 **17.363347 秒**。因此未接受初版性能结论。最终每个 case 校验本次实际使用的模板，文件结束后统一检查全部模板，且检查失败也严格清理已登记目录；复制前后的完整检查与失败报告保留。

| 当前实现验证 | before / fresh | final / cache |
| --- | --- | --- |
| 完整 GC 两文件 | 86 PASS | 87 PASS（原 86 + 新增 1） |
| 外部 wall | 138.135501 秒 | 80.181672 秒 |
| Vitest total / tests | 136.18 / 128.67 秒 | 78.91 / 73.17 秒 |
| 真实安装次数 / 累计耗时 | 188 / 32.726603 秒 | 44 / 6.386557 秒 |
| 排除 CLI 的 83 组 fixture 生命周期 | 38.065367 秒 | 31.801113 秒 |

最终完整回归 exit 0，无失败、skip 或 todo。原 86 项真实安装 **188→38 次**；新增隔离测试额外 6 次（冷模板 3 + 全新安装 3），合计 44 次。after 的 14 个真实安装 root 是 **13 个冷模板 + 1 个全新安装**，不是 case 副本数；wrapper 不统计零安装的空模板，不能据此声称减少了独立 case 目录。

隔离生命周期 profile 原样使用基线 83 个实际 fixture 序列，按文件独立 cache，逐组交替 before/after 先后顺序，包含唯一昂贵的 12-marker 序列；无预暖、过滤或 retry。两方都计入目录创建、真实准备及相同 strict cleanup，cache 还计入 case guard 和最终全模板检查/清理。fresh 的 prepare/cleanup 为 **34.968662/3.096668 秒**，cache 的 prepare/case guard/case cleanup/final guard+cleanup 为 **22.370462/2.068916/6.097547/1.264188 秒**。真实安装 **188→38 次**，生命周期净省 **6.264255 秒（16.46%）**。首个普通 A/B 副本在每文件、每侧均经过 full verification，验证耗时单列且包含在 profile 外部 wall，未加入上述生命周期比较。此 profile 的 fresh 使用严格清理，与历史完整基线的 best-effort 清理不同，只用于同一次交替准备成本比较。

完整 wall 单次观测减少 **57.953830 秒（41.95%）**，但 5 个 CLI case 合计也从 **60.815501→32.038998 秒**，启动与运行环境存在明显波动，不能将完整 wall 改善全归于模板或外推全量降幅。是否保留模板以独立生命周期 profile 的正收益及当前 87 项行为回归为依据。

证据：基线 `.tooling/gc-seed-20261014-120119/metrics-audited.json`；初版 `.tooling/gc-seed-after-20261014-121229/` 与 `.tooling/gc-fixture-profile-20261014-122015/`；最终隔离测量 `.tooling/gc-fixture-profile-v2-20261014-122650/summary.json`、`final-audit.json`；当前完整回归 `.tooling/gc-seed-final-20261014-122956/metrics-final.json`、`comparison.json`、`final-audit.json`，主代理另独立生成 `primary-verification.json`。

最终测量和 v2 profile 均覆盖 556 个 tracked/nonignored untracked 输入，运行内 hash、Git 状态及 test-tmp 清单不变，无测试临时目录或进程残留；基线 555 输入到 final 仅两 GC 测试和新增 helper 改变。最终 helper SHA256 为 `e79e549900ce040c7c79b99b8f8bff2064eb2112b49c68a5bf5e0a22324eaa75`。setup/config 与基线字节相同；run/audit 仅验收数量从 86 调整为 87 及已留存的文本编码换行差异，最终四份 harness 与初版 after 字节相同。原 summary 的逐 case 名称映射由独立 audit 校正，准确实际调用点为 `tests/gc-fixture.ts:42`，不能使用旧 fixture 行号。

复现当前行为范围：`pnpm test tests/gc-plan.test.ts tests/gc-apply.test.ts --maxWorkers=1 --testTimeout=90000`。本轮仅测试及文档；通过后未因纯文档变更重复运行。未重新运行全量、typecheck/build、Python 独立回归、安装或部署，未 commit/push；生产代码所需 typecheck/build 仍使用本会话前轮证据，持续性能目标尚未完成。

## 2026-10-14：R5d2 schema 用例的无关 Routing 准备

仅修改 `tests/r5d2-result-bus-delivery-lifecycle.test.ts`。W、review-1b、review-2a、review-2b 的十个结果输入改为本文件私有 `schemaResult()`：每次创建独立合法 UUID、完整 canonical evidence、ISO 时间，并通过生产 `resultSchema.parse()` 校验；这些用例只做 Bus schema 校验或读取自己写入的腐败 Bus JSON，未使用 Routing 持久化 producer。真实 `canonicalResult()`、`queueEntry()`、其他 lifecycle/reconciliation、Active Sink 与原 assertions 保留。review-2b 另增加两个单 entry 的合法样本对照，随后仍真实写入双 in-flight JSON 并验证 `RESULT_BUS_STATE_CORRUPT`。

| 目标用例 | before（ms） | after（ms） | Routing store 调用 | fsync 调用 |
| --- | --- | --- | --- | --- |
| W | 558.2775 | 8.1186 | 4→0 | 11→0 |
| review-1b | 1915.1430 | 8.3906 | 16→0 | 35→0 |
| review-2a | 1406.1562 | 6.1204 | 12→0 | 27→0 |
| review-2b | 1100.6858 | 9.1603 | 8→0 | 19→0 |

四项合计 **4980.2625→31.7899ms**，本次净省 **4.948473 秒**。省掉实际 **40 次** Routing store 入口（20 registerRoute、10 createCommand、10 appendResult）和 **92 次** fsync；after 目标四项均为 0 store/fsync，实际 schema 校验及新增合法对照仍计入 case 时间。

before/after 都是同一完整文件 **36/36 PASS、exit 0**，无 failed/skip/todo。全文件 store **200→160**、fsync **1191→1099**；其余 32 项的真实 store/fsync 次数及 store commandId/operation 顺序逐 case 相同。V 的 5 组真实 Routing producer、所有 lifecycle、replay 数量、revision 与逐字节不变断言完整通过，前后保持 **20 次 store（10 registerRoute/5 createCommand/5 appendResult）及 147 次 fsync**；没有以手写数据替代真实恢复或迁移。

完整文件外部 wall **84.284486→65.688206 秒**，Vitest **80.49→64.43 秒**，tests **77.46→62.48 秒**。完整 wall 的单次差值 **18.596280 秒**还包含非目标 I/O 和 transform/collect 波动，不能全部归于这四项，也不外推全量降幅。store 耗时包含内部 fsync，二者不可相加；本次因四项真实提交全部移除而无需以另一个准备框架换取收益。

透明 observer 透传真实 registerRoute/createCommand/appendResult 与 fs.fsyncSync 的 this、参数、返回值和异常，collector 在恢复 fsync 后写原始记录；前后 setup/config/run 三份 harness 字节相同。两轮各自冻结 **556 个 tracked/nonignored untracked 输入**，运行内 hash、Git 状态、仓库 test-tmp 和 OS `c2c-r5d2-lifecycle-*` 临时目录集合不变，无相关 Node 残留；基线到 after 仅该测试文件改变，当前源 SHA256 为 `3c1b5df2bd7f9a5372b209aeeaee3184e3c39b81abbcc2b686f0bd8b5f7127b3`。

证据：`.tooling/r5d2-fixture-20261014-125050/baseline/metrics-summary.json`、`final-audit.json`；同目录 `after/comparison.json`、`final-audit.json`、`calls.json`。主代理独立比对 36 项同名结果、全部 32 非目标调用及 canonicalResult/queueEntry 与 HEAD 源码完全相同，保存 `after/primary-verification.json`。

复现当前范围：`pnpm test tests/r5d2-result-bus-delivery-lifecycle.test.ts --maxWorkers=1 --testTimeout=90000`。本轮仅测试与性能文档，通过后未因文档变更重复运行；未重跑全量、typecheck/build、Python 独立回归、安装或部署，未 commit/push。其他慢文件仍待后续细节审查，持续性能目标保持进行中。

## 2026-10-14：Supervisor post-crash 准备与覆盖路径校正

仅继续修改 `tests/supervisor-store.test.ts`，生产 store/ACL 脚本、15 秒 deadline、身份观察和 teardown 不变。post-crash 用例原先真实获取一个新 lease 只为取得 runtime 模板，随后立即改写 runtime/lease 为 dead owner。先验证真实 noop operation 初始化可减少两次 ACL；最终复用本文件已有的 probe-seeding 模式：在被测 acquireSupervisorLease 完成真实私有目录 ACL 后、首次当前 PID 且未指定 expected creationTime 的身份 probe 中，写入通过 `supervisorRuntimeSchema.parse()` 校验的完整 runtime/lease。每例仍独立普通文件、mode 0600，无共享缓存或 ACL 假成功。schema 字段、PID 防碰撞、seeded/file-exists 证据及原 exact missing≥2、nonce 更新、当前 PID、无 launch pin、release 成功断言均保留。

| 同一 post-crash case | before：新 lease 模板 | 中间：独立 noop 初始化 | final：受测入口注入 |
| --- | --- | --- | --- |
| 真实 ACL 调用 | 19 | 17 | 14 |
| case 耗时 | 62.849946 秒 | 55.879550 秒 | 52.735003 秒 |
| ACL 独占耗时合计 | 62.694988 秒 | 55.607290 秒 | 52.295520 秒 |

实际少 **5 次 PowerShell ACL 进程**；baseline 被移除的首次模板 acquire 五次 ACL 合计 **12.851504 秒**。final case 单次观测净省 **10.114943 秒（16.09%）**。这是具体准备的调用数削减及单 case 时间，不是整个 Supervisor 文件或全量回归降幅。

最终 14 次真实 ACL 是 store-directory 单独 2 次、lease+directory 5 次、runtime+directory 5 次、reclaim+directory 1 次、runtime-temp+directory 1 次；一条包含多个 target 的 ACL 只计一个进程，不能把 target 数或嵌套耗时再相加。被测入口现在首次创建目录，执行 set-directory；原被测入口在模板准备后执行 existing verify-directory，所以不能声称所有参数完全相同。首条目录门禁之后，其余 **13 条 target role/mode 序列**与 baseline 去掉首次准备后的序列保持一致，真实脚本 SHA256 `55e3ddeb322922c4c0ee9c4b94a8179377377c050792bdd7ba945b77da65e6bf` 未变，所有调用成功。回收及释放真实文件权限、内容、identity/snapshot 校验保留，没有手写 dev/ino/mtime/ctime 或缓存观察。

另将原 `will not overwrite an orphan runtime unless its exact recorded process is proven missing` 更正为 `runtime drift preserves the live lease and refuses a rival acquisition`：runtime 漂移使 release 失权返回 false，lease 文件仍在，竞争 acquire 先被这个 live lease 阻断，原名称不能证明孤儿 runtime 的 unknown probe 路径。保留该例全部真实 acquire/release/read，增加 lease/runtime 字节保持、精确 live lease probe>0 与 drifted runtime probe=0 断言；初始化身份 probe 未携带 expected，只对携带 expected 的 held-lease probe 计数。

名称校正用例 before/after 都是 **10 次真实 ACL**，ACL 独占耗时却 **25.643616→39.025070 秒**，case **25.697741→39.096304 秒**。两项定向整体 wall **95.325135→101.548253 秒**反而增加，不能把这个结果称为整组提速。未改的真实 PowerShell 调用存在明显波动；上述 post-crash 独立调用数减少与计时结果分别保留，不将所有时间差归因于代码。

验证分阶段：baseline 与中间 after 各 **2 PASS、22 filtered、exit 0**；最终再因目标 body 新改动只跑 post-crash **1 PASS、23 filtered、exit 0**。24 是发现数量，不能表述为本轮24项通过。最终单项外部 wall **59.188808 秒**、Vitest **57.20 秒**，不与原两项 wall 混算。其余 23 项 body、hooks、imports 与两项已通过的中间 source 逐字相同，包括 drift 的初始化 probe 修正；其中 drift 不重复运行，另外22项本轮未运行。私有 missing probe 只以现有≥2 assertion通过为证据，未独立采样，不能声称精确次数。

三阶段运行内 **556 个 tracked/nonignored 输入** hash、Git 状态及 test-tmp 清单不变，无相关测试/ACL残留进程。baseline 的 dirty exact 源码保存为 `.tooling/supervisor-crash-fixture-20261014-131616/baseline/sup-store.before.ts`；中间 after 同名文件是该阶段开跑前快照，不能代替原 baseline。setup/config 字节相同，最终 run 仅 pattern 与1PASS/23filtered验收范围调整，差异存 `final-post/harness-run.diff`。当前 source SHA256 `17deee193f509e762ae71de55f692e075731bf6c7360d8da44676d8acaa8ef34`；ACL helper SHA256 `249fd7ac9d1d4afb7e89d08e715b52c42bcc3d6c5c51bfea99921e5e2fde6339` 各阶段相同。

证据在 `.tooling/supervisor-crash-fixture-20261014-131616/` 的 baseline、after、final-post 三个目录：各有 JSON/log、raw acl-calls、输入快照与 final-audit。最终 `comparison.json` 和主代理独立生成的 `primary-verification.json` 复核真实调用、13条模式序列、目录模式差异及目标 body 外源码完全相同。

复现当前改动两项：`pnpm test tests/supervisor-store.test.ts --maxWorkers=1 --testTimeout=90000 -t 'only exact process-missing proof|runtime drift preserves the live lease'`。最终单项使用仅 `only exact process-missing proof` pattern。本轮仅测试与性能文档，未重跑完整 Supervisor 文件、串行全量、typecheck/build、Python 协议回归、安装或部署，未 commit/push；文档变更不触发已通过代码重复验证，持续优化目标仍进行中。

## 2026-10-14：多轮优化后的正式串行全量

唯一正式全量于 **14:02:56.578–14:42:42.612（Asia/Shanghai）** 自然结束，**180 文件 / 3053 项全部通过，exit 0，failed/pending/todo 0，无未处理错误标志**。命令为 `pnpm test --maxWorkers=1 --testTimeout=90000`，额外添加 default/json reporter 及独立输出路径；没有并行全量、retry 或重启。运行期间 556 个 tracked/nonignored 输入哈希、HEAD、Git 状态完全相同，仓库 test-tmp 无新增残留，结束后测试进程及最后观测的 owned 子进程集合为空。OS temp 新增 176 个未知条目，没有匹配已知测试前缀；未据此推断其归属或删除它们。

| 同日两次正式串行全量 | 08:46 基线 | 本次 | 差值 |
| --- | --- | --- | --- |
| 文件 / 用例 | 180 / 3046 | 180 / 3053 | 新增 7 项 |
| 外部 wall | 2330.090490 秒 | 2386.029164 秒 | 增加 55.938674 秒（2.40%） |
| Vitest total | 2325.85 秒 | 2382.83 秒 | 增加 56.98 秒 |
| Vitest collect | 120.33 秒 | 145.33 秒 | 增加 25.00 秒 |
| Vitest tests | 2090.06 秒 | 2120.22 秒 | 增加 30.16 秒 |

以下文件耗时统一取 JSON 的 endTime − startTime，不混用 default reporter 的 tests 时间。

| 文件 | 基线 | 本次 | 差值（秒） |
| --- | --- | --- | --- |
| supervisor-store | 629.627 | 548.291 | -81.336 |
| gc-apply | 87.833 | 54.222 | -33.611 |
| gc-plan | 29.945 | 34.121 | +4.176 |
| feedback-probe-cli | 16.673 | 7.953 | -8.721 |
| write-probe-cli | 12.570 | 8.279 | -4.291 |
| r5d2-result-bus-delivery-lifecycle | 75.964 | 67.188 | -8.776 |
| update-check | 19.242 | 53.072 | +33.830 |
| workspace-history-format | 110.045 | 131.185 | +21.140 |
| core-upgrade | 22.689 | 41.719 | +19.030 |
| gateway-supervisor | 14.429 | 32.339 | +17.910 |
| legacy-reconciliation | 69.168 | 86.696 | +17.528 |

本次局部文件改善没有带来全量提速。多项未改测试文件也明显变慢，且 collect 增加；这表明单次全量受到额外波动影响，但不足以把全部差值确认为环境原因。运行脚本每 45 秒另起 PowerShell/CIM 查询，共保存 54 次成功采样，before/after 快照另查两次。没有独立记录查询耗时，不能量化其干扰，更不能从实测 wall 中扣除估算值；后续定向测量仅使用原 ChildProcess/exec handle 观察，CIM 限于启动前与结束后。

新增 7 项分别为 Supervisor ownership/cycle 5 项、GC fixture 等价与隔离 1 项、Probe CLI 接线 1 项。另有三条 outcome_unknown 组标题、runtime drift 用例名称、GC CLI 重复 plain 调用与动态 PID 标题差异，不能将名称 diff 计作新增测试或删除业务覆盖。原 JSON 的 `numTotalTestSuites=491` 包含 describe 分组，不是文件数；driver 的 `full-meta.files` 沿用了该值，进度正则还漏数 12 个单用例文件。保留原始文件，独立验收以 `testResults.length=180`、3053 个 passed assertion 和最终日志为准，已在 `primary-verification.json` 标明计数限制。

证据：`.tooling/serial-regression-final-20261014-140201/` 的 `full.json`、`full.log`、`full-meta.json`、`process-scope.jsonl`、全部 before/after 快照，以及主代理独立生成的 `comparison.json`、`primary-verification.json`。运行中没有改动已启动的 driver；执行子代理出现容量错误后，主代理读到了原 suite 自行保存的终态并核对进程已结束，没有启动第二次全量。

此全量覆盖此前各轮优化，**不覆盖下节后来新增的配置准备优化**。完整 Supervisor 24 项、默认 Supervisor 30 项、GC 87 项与 R5d2 36 项均在本次真实执行通过；源码验证不代表安装或部署，未 commit/push、重启 Bridge 或重载网页伴侣。持续性能目标保持进行中。

## 2026-10-14：Supervisor 配置读取用例的重复事务准备

仅继续调整 `tests/supervisor-store.test.ts` 的三个用例。两个配置拒绝用例通过真实 `withSupervisorOperation` 初始化私有目录，随后用本文件私有 `seedConfig()` 写入完整合法配置；helper 使用生产 `supervisorConfigSchema.parse()` 校验全部 8 个字段，并以 mode 0600 写入每例独立文件。dead operation owner 用例则在被测入口完成真实目录 ACL 后、首次当前 PID 且 expected 未指定的 probe 中准备配置与旧锁。真实配置更新/原子提交的集成测试保留，未修改生产 store、ACL 脚本、deadline、probe 让步或 teardown。

| 同范围目标用例 | 真实 ACL before→after | case before→after（秒） |
| --- | --- | --- |
| workspace root mismatch | 7→4 | 19.585351→13.608784 |
| schema / extra key / hardlink / symlink / interrupted temp | 7→4 | 19.924056→20.228468 |
| exact dead operation owner 回收 | 15→9 | 47.596080→30.842531 |

两轮均 **3 PASS、21 filtered、exit 0**，发现数量 24 不代表本轮 24 项通过。合计真实 ACL **29→17**，准确减少 **12 次 PowerShell 进程**；外部 wall **93.460588→70.947123 秒**，单次净省 **22.513465 秒（24.09%）**；Vitest **91.69→69.42 秒**，case 合计 **87.105487→64.679783 秒**，ACL 独占时间 **86.811524→64.283374 秒**。schema 拒绝用例虽少三次 ACL，却略慢 0.304 秒，不能声称三个用例各自均提速，也不外推整文件或全量降幅。

所有真实调用成功，ACL 脚本 SHA256 仍为 `55e3ddeb322922c4c0ee9c4b94a8179377377c050792bdd7ba945b77da65e6bf`。前两个用例精确删除原准备中的三条 ACL，剩余 target role/mode 序列相同。dead owner 删除前置配置事务的六次 ACL；受测入口首次创建目录的 set-directory 替代原 verify-directory，其余八条 target role/mode 序列相同。文件身份及 ACL 仍由真实 store 校验，没有伪造 snapshot 或返回 ACL 假成功。新增 seeded、旧 PID 的精确 creationTime 与至少两次 missing probe、完整 config 相等、配置字节未改及操作锁已删除断言。

主代理用 TypeScript AST 和完整源码比对，确认仅三个 target body、schema import 和 helper 改变，其余 21 项、hooks 及既有初始化函数完全相同；独立 explorer 审查未发现需修正的问题。before/after setup/config/run 三份 harness 字节相同，两轮各自 556 个输入 hash、HEAD、Git 状态冻结，无测试临时目录或相关进程残留。旧 Windows symlink 创建权限不足时提前返回的既有覆盖限制保留，未将其表述为本机成功检查了 symlink。

证据：`.tooling/supervisor-config-seed-20261014-151146/` 的 baseline/after 原始 Vitest JSON、日志、ACL calls、metrics、输入快照与两阶段源码，以及 `comparison.json`、`primary-verification.json`。after 的 `sup-store.before.ts` 是该阶段开跑前快照，不能作为优化前源码；当前 source SHA256 为 `b578088dedb72aa8b18a3b0a7f67a30811e3f2aca79478ba870a11c5ff1048c5`。

复现范围：`pnpm test tests/supervisor-store.test.ts --maxWorkers=1 --testTimeout=90000 -t 'rejects a config whose workspace root does not match its identity|corrupt schemas, extra keys, hardlinks, links and interrupted temps fail closed|reclaims an exactly proven dead operation owner'`。本节没有新增测试或删除用例，只改测试及文档，`git diff --check` 通过；修改后未再跑完整 Supervisor、串行全量、typecheck/build 或 Python 独立回归，未安装、部署、commit/push。通过后不因纯文档修改重复执行代码测试，持续性能目标仍进行中。

## 2026-10-14：格式化确认的重复路径解析与 Git 快照启动

先用完整 `workspace-history-format` 和 `update-check` 两文件测量，基线 **33 PASS、exit 0**。81-artifact 用例中，额外 39 次真实输出准备只花 **0.594217 秒**，而格式化确认花 **36.224078 秒**；因此保留这 39 次真实 `saveExecutionOutput`，不为这点成本新增手写 index/body fixture。81 是 **15 个固定 snapshot 槽位 +40 个真实非空正文 +26 个 repair 文件**，固定槽位可能不存在，不能称为 81 个现存物理文件。

生产仅调整 `src/command-cleanup/workspace-history.ts` 的 confirm：`readJournal` 完成严格 schema/hash/identity/白名单及 canonical 路径检查后，局部数组保存各 artifact 的绝对路径字符串。每轮仍完整执行 `checkLocks`、journal 实时 fingerprint、全部 artifact 实时 `fileFingerprint` 和 body 目录清单检查；每份删除/替换及终态 fingerprint 继续调用原函数。缓存不包含 inode、权限、内容或观察结果，`afterBytes` 与期望 hash 的计算时机也保留。其他生产函数、公开参数、持久化格式、异常顺序与 Bridge 本机授权入口不变。

完成 81 个唯一 artifact stage 时，按实际通过的用例及原循环推导，confirm 内省去 **6885 次**重复 `artifactFile` 路径解析（83 次完整 validate ×81，加 mutation/final 两轮各81）；原 **6804 次** validate/final artifact `fileFingerprint` 调用仍执行，其内部每次重新检查 canonical 路径、单链接、realpath、文件身份及内容。这两个数字是源码控制流推导，**未独立动态采样局部函数次数**；锁/快照/删除函数的额外 fingerprint 不包含在 6804 内。

`tests/update-check.test.ts` 仅合并 remote-ahead 用例的 HEAD/upstream 引用快照，前后各一次真实 `git rev-parse HEAD refs/remotes/upstream/main`，直接比较完整输出；index、branch、status、stash、dirty 文件和其他六项场景保留。真实顶层 Git **182→180**，helper **42→40**，生产内部 **140→140**；七项生产 argv/status 序列归一化随机 case 路径和 commit SHA 后完全相同。合并的四次旧查询累计 **219.2316ms**，两次新查询 **152.1585ms**；仅观测省 **67.0731ms**，不能解释 update-check 整文件波动或宣称稳定大幅提速。

| 相同 observer 的完整两文件 | baseline | final |
| --- | --- | --- |
| 测试数 | 33 PASS | 37 PASS（新增四项安全验证） |
| runner wall | 146.672396 秒 | 152.899683 秒 |
| Vitest total | 142.81 秒 | 147.10 秒 |
| 原33项 case/hook 观察时间合计 | 139.525576 秒 | 137.451312 秒 |
| 81-artifact case/hook 时间 | 39.174588 秒 | 36.397012 秒 |
| 81-artifact confirm | 36.224078 秒 | 33.533006 秒 |

final 的四项新增安全验证合计 **5.312865 秒**，分别覆盖路径准备后正文漂移、同字节 journal inode 替换、隔离 workspace 内的 bodies junction 替换、处理一个 artifact 后剩余正文漂移；拒绝后完整未处理历史、正文/index、durable journal 及写入 fence 均保留。随后补充第五项：从真实中断形成 pending journal，追加其他 workspace 的真实普通文件及真实 fingerprint，重算自洽 snapshot hash，仍被入口白名单以 `WORKSPACE_HISTORY_JOURNAL_CORRUPT` 拒绝，所有字节不变。该新单项 **1 PASS、30 filtered、exit 0**，不将发现的31项称为此次31项通过。

81-artifact 的真实 save 次数前后均40；成功 fsync 分类及 index commit 完全一致：body40、index-temp40、index-lock41、initialized1、other58，index rename41。confirmation 单次净省 **2.691072 秒（7.43%）**；修改路径后的中间完整37项观察为 **30.073145 秒**，普通单文件30项也通过，但不选较快值替代最终对照。整组 wall 实际增加 **6.227286 秒**；runner 的 wall 包含结束后的输入/CIM审计，baseline/final 文件完成顺序不同，时间波动不能全归于代码，也不外推全量收益。

修复记录保留首次结果：复制 harness 的相对配置 import 错误导致 `after/after` 在执行测试前退出；后续 `after2` 与 `final` 使用原始、字节不变的 harness。Git 首次修改把带末尾换行的输出直接 split，且还保留一次独立 upstream 查询，完整定向出现 **1 failed /6 passed**；修复为完整输出比较并删除重复查询后，最终完整两文件 **37 PASS**，没有使用 Vitest retry、掩盖失败或重启已经运行的测试。

主代理独立核验全部原33个 case 名称保留，除加强81-artifact断言外，其余25项原 history case body 不变；生产只有 confirm 改变。baseline/final 三份原始 observer/config/run 字节相同，各轮556个 tracked/nonignored 输入、HEAD、Git状态冻结，无新 test-tmp 或相关测试进程残留。baseline 生产源码与 Git HEAD 相同，Git blob LF 和工作区 CRLF 已分别核对，未混用换行归一化文本与原字节哈希。

验证为最终完整 profile **37 PASS**、后补白名单 **1 PASS**，当前两目标文件38个不同用例均有通过证据；共享边界回归实际 **2文件/91 PASS**（legacy-history-cleanup29、companion-operations62）。边界命令额外写了不存在的 `companion-bridge-feedback.test.ts` filter，Vitest未执行该文件，不能计入覆盖；CLI/Companion格式化授权与保留配对身份的直接调用合同已在 history 文件完整回归通过。另一次启动审批超时未创建测试进程，按工具允许仅重试启动一次，实际测试无 retry。typecheck、build、`git diff --check` 通过；Python helper未改，不重复协议回归。

证据：`.tooling/history-update-fixture-20261014-153307/` 下 baseline、after2、final 的 JSON/log/raw metrics/输入与harness快照，`current-update-check.json` 的首次失败，`whitelist.json`、`related.json`、`comparison.json` 和 `primary-verification.json`。当前生产 source SHA256 为 `b817394109820887c98b3d10fcaa50d5f7916e668181cf993687e270867772ea`。

复现功能范围：`pnpm test tests/workspace-history-format.test.ts tests/update-check.test.ts --maxWorkers=1 --testTimeout=90000`；共享边界为 `pnpm test tests/legacy-history-cleanup.test.ts tests/companion-operations.test.ts --maxWorkers=1 --testTimeout=90000`。本轮包含生产改动，**尚未重新运行正式串行全量**；前一节180文件3053项的全量不覆盖本节。未 commit/push、安装、部署、重载伴侣或重启运行服务；源码 build 不等于部署。持续优化目标仍进行中。

## 2026-10-14：Supervisor launch fixture 重复 operation 初始化优化

仅调整 `tests/supervisor-store.test.ts` 五项 launch 用例的准备，将真实 `withSupervisorOperation` noop 换为 `tests/supervisor-acl-support.ts` 的私有 fixture 初始化；其余19项 body 不变。初始化限定在 `test-tmp` 内的 canonical、非链接普通目录，以 exclusive mkdir 拒绝已存在子目录；Windows 单次真实 PowerShell 设置 protected ACL、当前 SID owner 及仅该 SID 的 FullControl（ContainerInherit/ObjectInherit），显式 `SetOwner` 后使用与生产一致的 `Set-Acl`。15秒 deadline、原异常及真实生产校验保留，无缓存、弱化或 retry。

原始证据根为 `.tooling/supervisor-launch-fixture-20261014-170103/`，四阶段分别保存源码快照、命令、Vitest JSON、ACL raw 与输入审计；19 filtered 均为 `-t` 未选择，不能计作通过。

| 同范围五项单次观察 | baseline | after（首次） | final（失败版本） | final-set-acl（最终） |
| --- | --- | --- | --- | --- |
| 结果 | 5 PASS | 5 PASS | 0 PASS / 5 FAIL | 5 PASS |
| Vitest / harness exit | 0 / 1 | 0 / 0 | 1 / 1 | 0 / 0 |
| 真实 ACL 调用 | 42 | 32 | 5（仅初始化失败） | 32 |
| wall 秒 | 101.56935 | 160.3943712 | 38.1958869 | 99.9644535 |
| ACL 合计秒 | 95.5058414 | 150.8761134 | 15.0519745 | 93.7776119 |

baseline 的 harness 非零仅因两个 Codex `cua_node/server.mjs` 被误判 residual；`baseline/process-audit.json` 按已保存 PID、父PID和 argv 说明其不属测试，raw 原样保留，未做整机归属审计。首次 after 使用前置拒绝非当前 owner 的版本，虽然调用减少却更慢。后续 `final/` 显式 SetOwner 后用 `.NET SetAccessControl`，五项均发生真实 `UnauthorizedAccessException`、生产 verifier 调用为0；失败副本与 ACL 证据保留。修复为生产同款 `Set-Acl` 后另跑 `final-set-acl/`，不是重试掩盖失败。

最终发现24项、实际5 PASS/19 filtered，case 合计94.1843161秒。逐例 ACL 为 **5/14/5/14/4 → 3/12/3/12/2**，真实 PowerShell 减少10次（23.81%）；wall 单次减少1.6048965秒（约1.58%），不宣称稳定提速或全量收益。最终5次初始化脚本 SHA256 `4593b7e633ee9562bb394dca3f8a14ff78a432a67237497d815ae747fc6e7e00` 合计18.2035702秒，27次生产脚本 SHA256 `55e3ddeb322922c4c0ee9c4b94a8179377377c050792bdd7ba945b77da65e6bf` 合计75.5740417秒。剔除 baseline 每例最初3次准备与最终每例首个初始化后，剩余27次生产 role/mode/hash 顺序全部相同（`final-set-acl/comparison-audit.json`）；真实 pin/stat/hash、lease、handoff、release 及 strict teardown 保留。

四阶段各556个输入、HEAD和Git状态均冻结，`test-tmp` 前后空，strict teardown 成功；最终无 owned 测试进程残留，只有前后 CIM 快照，没有 periodic CIM，也不等于整机归属审计。支持层新增3项 guard，最终普通运行 **9 PASS、exit 0**（17:34:23，tests 125ms，`support.json`），覆盖路径/已存在目录拒绝、Windows 单调用边界与原异常、非Windows私有目录；mock 守卫不能替代上述真实 ACL 证据。

功能复现使用当前 checkout；精确观测 argv、独立 observer 配置及输出路径见 `final-set-acl/command.json`，历史 baseline 须使用对应源码快照：

```powershell
pnpm test tests/supervisor-store.test.ts --maxWorkers=1 --testTimeout=90000 -t 'validates the exact launch identity and installed release before handoff|publishes runtime before consuming exact startup pin and retains it for a long session|failure before acquiring the exact runtime leaves the startup pin intact|identical-content replacement between validation and handoff is retained and fails closed|identical-content replacement before the child reads the pin fails the original launcher proof'
```

此次仅测试与文档；未重跑整个 Supervisor、正式全量、typecheck、build、Python 回归、安装或部署。此前 history 生产改动的 typecheck/build 已通过，但随后正式全量仍未运行，不能作为本轮验收。性能目标继续进行中。

## 2026-10-14：update-check Git seed 的重复完整扫描

`tests/update-check.test.ts` 的七个用例都从同一份已验证的真实 Git remote/local seed 复制独立副本；每个副本的完整 `.git` snapshot、普通文件 `nlink=1`、remote 配置和路径隔离校验均保留。原实现还在每个 `afterEach` 再完整扫描一次从未被用例直接操作的 seedRoot，重复了模板完整性检查。现在 seedRoot 在构造时验证一次，套件结束前再统一复核一次；每个副本仍在复制后立即完整复核，失败时仍严格清理副本和 seed。

| `update-check.test.ts` 同范围单次观察 | baseline | after |
| --- | ---: | ---: |
| 结果 | 7 PASS / exit 0 | 7 PASS / exit 0 |
| seedRoot 用例后完整扫描 | 7 次 | 1 次 |
| Vitest tests | 21.5888615 秒 | 19.0707157 秒 |
| 外部 wall | 24.5240495 秒 | 21.8901139 秒 |

本次 wall 减少 **2.6339356 秒（10.74%）**，Vitest tests 减少 **2.5181458 秒（11.66%）**；这是单次同范围观测，不能归因或外推正式全量收益。两轮均无失败、pending、todo 或 `test-tmp` 残留，原有工作区 dirty 改动保留。复现范围为 `pnpm test tests/update-check.test.ts --maxWorkers=1 --testTimeout=90000`；本轮仅测试与文档，未运行正式全量、build、安装或部署。

## 2026-10-14：core-upgrade 前置拒绝用例去除无关安装

`core-upgrade.test.ts` 的 `rollout --result-file` 用例验证的是 CLI 在进入 `rollout()` 前以 exclusive `wx` 打开已有目标时拒绝覆盖，并断言原文件及 runtime 均不变。该路径不读取已安装 Core；此前却先构建并执行完整 `buildCoreFixture`/`installCore`。现在该用例使用只创建 workspace/state 的 bare fixture，其余 9 个需要安装产物、release metadata 或 Bridge 的用例仍使用完整 fixture。

| 同一单项串行观察 | baseline | after |
| --- | ---: | ---: |
| 结果 | 1 PASS / exit 0 | 1 PASS / exit 0 |
| Vitest tests | 4.471 秒 | 2.584 秒 |
| 外部 wall | 10.1352859 秒 | 8.2494084 秒 |

单项 wall 减少 **1.8858775 秒（18.61%）**，仅代表去除该场景无关安装；完整文件随后 **10/10 PASS**（tests 21.208 秒）。这是测试准备的单项观测，不外推全量收益。复现范围为 `pnpm test tests/core-upgrade.test.ts --maxWorkers=1 --testTimeout=90000`；本轮未运行正式全量、build、安装或部署。

## 2026-10-14：Supervisor operation 竞争用例的重复配置读取

`serializes config mutation across the complete async action and fails busy without running a rival action` 已在锁内通过 `operation.updateConfig()` 完成并返回完整配置；竞争方被拒绝后又调用一次独立 `readSupervisorConfig()`，重复执行目录和配置文件的严格身份/ACL 检查。现在直接断言锁内更新返回的配置，保留异步 gate、第二个 operation 的 `SUPERVISOR_BUSY`、rival action 零执行和最终锁释放；其他读路径由同文件配置用例覆盖。

| 同一单项串行观察 | baseline | after |
| --- | ---: | ---: |
| 结果 | 1 PASS / exit 0 | 1 PASS / exit 0 |
| Vitest tests | 21.243 秒 | 20.693 秒 |
| 外部 wall | 28.0380813 秒 | 27.0019466 秒 |

单项 wall 减少 **1.0361347 秒（3.70%）**，是一次重复 ACL/文件读取的削减，不外推 Supervisor 文件或正式全量收益。相关 operation-lock 六项定向回归随后 **6/6 PASS**；复现范围为 `pnpm test tests/supervisor-store.test.ts --maxWorkers=1 --testTimeout=90000 -t 'serializes config mutation across the complete async action and fails busy without running a rival action|reclaims an exactly proven dead operation owner|refuses an unknown or reused operation owner|rechecks operation lock identity before unlink and preserves a replacement|corrupt owner is busy and preserved|asserts operation ownership after a lock path is replaced'`。

## 2026-10-14：本轮优化后的正式串行全量

按正式门禁命令 `pnpm test --maxWorkers=1 --testTimeout=90000` 单独运行一次，**180/180 测试文件通过、3061/3061 测试通过、exit 0**。Vitest Duration 为 **2050.84 秒**，外部 wall 为 **2053.1082033 秒**（18:53:59.991–19:28:13.099，Asia/Shanghai）。`.tooling/test-tmp` 结束时为空；本轮没有并行全量、retry 或重启测试进程。

相对上一份正式全量参考（180 文件 / 3053 测试，wall 2386.029164 秒），本次 wall 少 **332.9209607 秒（13.95%）**，但测试数量增加 8 项，运行环境和文件完成顺序未做受控 A/B；该差值只作为累计观测，不能全部归因于本轮三个局部测试准备优化。日志中有一条既有 CLI 参数校验文本 `--port 0`，未形成失败，最终 error count 为 0。

本次全量原始日志保存在 `.tooling/serial-regression-followup-20261014-191000/full.log`；本轮改动仍未 commit、push、安装或部署。

## 2026-10-14：retention checkpoint 的重复准备与 cleanup 去重

`tests/legacy-reconciliation.test.ts` 原来的 holes=1/7/40 三项共享同一真实起点：seed、reconcile、40 次真实 `saveExecutionOutput` 形成 retention 淘汰。现在合为一项，按 `new-0..39` 累计执行真实 command cleanup，在删除第1、7、40条时保留全部原断言；三个 checkpoint 剩余 metadata 分别为39、33、0。保留真实 raw output、body 和 eviction，不手写 `retentionThrough=1`。baseline 的40条场景准备仅 **1281.727ms**，confirm 为 **34293.810ms**，主要耗时在 cleanup。

| 同 observer/config/run 的单次观察 | baseline | after |
| --- | ---: | ---: |
| 实际通过 / filtered / discovered | 3 / 54 / 57 | 1 / 54 / 55 |
| runner wall（含结束审计） | 66373.0861ms | 62805.955ms |
| Vitest tests | 59870ms | 52016ms |
| 填充 save（含 seed 的全部 save） | 120（123） | 40（41） |
| confirm | 48 | 40 |
| 公开 preview（preview / 后置 not_found） | 96（48 / 48） | 80（40 / 40） |
| readonly metadata / get / list | 各3 | 各3 |
| 实际 fsync | 1296 | 816 |

wall 单轮少 **3567.1311ms（约5.37%）**，after 每次 confirm 的平均耗时反而更高，不能宣称稳定提速或全量同比收益。fsync 和嵌套调用时间已包含在 API 时间内，不能相加，也不跨 phase 相减估算审计成本。叶用例3→1省去两次重复准备，三个状态仍覆盖；首个 checkpoint 失败会停止后续 checkpoint，诊断独立性有所减少。其余54项 body/helper/hook 不变，原有 negative raw 为空的 dirty 改动保留。

两阶段各556个 tracked/nonignored 输入的 hash、HEAD 和 Git状态冻结，observer/config/run 字节相同，`test-tmp` 前后为空，无关联 Vitest 残留；进程证据仅为前后 CIM 快照，不是整机进程归属审计。证据在 `.tooling/legacy-cleanup-phases-20261014-193922/` 的 baseline/after 原始 JSON、metrics、输入快照与 `after/phase-comparison.json`。

本轮另补强此前两项测试断言：Supervisor 竞争拒绝后及释放后，直接比较配置完整字节与 `JSON.stringify(saved)`，证明持久状态且不增加生产 ACL read；core bare fixture 同时核对退出码1和 stdout JSON 的 `error` 含 `EEXIST`，避免缺安装也返回1造成假绿。`assertion-repairs.json` 为 **2 PASS、32 filtered、34 discovered、exit 0**；这些是新断言验证，不将此前单轮 timing 改称补强后实测。

默认配置的完整 `affected-regression.json` 为 **55/55 PASS、exit 0**，Vitest tests **63278ms**；其中 target 的45.728秒是普通验证，不替代上表 profiling。主代理本轮 `pnpm run typecheck` 通过。复现使用 `pnpm test tests/legacy-reconciliation.test.ts --maxWorkers=1 --testTimeout=90000`，或追加 `-t 'retention horizon .*command cleanup'` 仅选择 checkpoint。此次仅测试与文档，未新增正式全量、build、Python回归、安装或部署；上一节180文件/3061项全量在本次修改前，不覆盖本节。未 commit/push。

## 2026-10-14：build ID 用例减少重复完整 finalizer

`tests/build-id.test.ts` 仅将第二次 `finalize()` 改为已有生产 `writeBuildId(dist)`；首次自定义目录 CLI 调用、全部原断言和其余用例保留，仍为7个用例、26处静态 `expect`。现有 packaging 两次完整 build 保留。自定义 CLI × 已有 assets × 重复完整 finalization 改由默认 CLI 重复完整 pipeline 与自定义目录 API 重复原子 publication 组合支撑，已不直接端到端验证同一组合；`scripts/write-build-id.mjs` 解析 dist 后没有默认/自定义目录分支。

| 同 observer/config/run 的单次观察 | baseline | after |
| --- | ---: | ---: |
| 实际通过 / filtered / discovered；exit | 1 / 6 / 7；0 | 1 / 6 / 7；0 |
| 真实直接 `execFileSync` 目标 CLI 调用 | 2次：3091.9777 / 3906.5164ms | 1次：2785.4228ms |
| 目标 case | 10089.0732ms | 5719.3801ms |
| runner wall（含结束审计） | 18411.5896ms | 13092.1528ms |

case 少 **4369.6931ms（43.31%）**，wall 少 **5319.4368ms（28.89%）**；仅为单次同范围观测，不外推全量。首次调用本身也变快，不能把总差全部归因于减少调用。未采样子进程内部 `dependencyHash`，少一次依赖扫描仅按源码推导。

两阶段各556个输入、HEAD、Git状态和 harness 均冻结；跨阶段仅目标源码变化，observer/config/run 完全相同，无新增 `test-tmp` 或关联 Vitest 残留。证据在 `.tooling/finalizer-repeat-phases-20261014-120747/`，汇总为 `primary-verification.json`。

普通默认配置完整文件为 **7/7 PASS、exit 0**，tests **5811ms**、Vitest **9.73秒**；`functional-20261014-1220` 是功能回归，不替代上述 A/B。复现：`pnpm test tests/build-id.test.ts --maxWorkers=1 --testTimeout=90000`。此次仅测试与文档，未新增正式全量、typecheck、build、Python回归、commit/push、安装或部署；此前180文件/3061项全量不覆盖本节。

## 2026-10-15：retention checkpoint 减少重复 post-confirm preview

`tests/legacy-reconciliation.test.ts` 的 retention 用例仍对 `new-0..39` 执行 40 次真实 `previewCommandCleanup` 与 `confirmCommandCleanup`，并在 1/7/40 三个 checkpoint 重验 metadata、reconciliation 和 index 字节。原实现还在每条 command 后立即再做一次 `preview` 断言 `not_found`；这 40 次 post-confirm 读取与 checkpoint 断言重复。现在保留每条真实 cleanup 的 confirmation，只在三个 checkpoint 对应的最后一条 command 做 `not_found` 重验，测试数量与真实 cleanup 覆盖不变。

| 同文件单次观察 | 修改前基线 | 当前 |
| --- | ---: | ---: |
| 测试结果 | 55 PASS | 55 PASS |
| Vitest tests | 52.97s | 59.17s |
| retention 用例 | 38.08s | 40.69s |
| post-confirm `not_found` 调用 | 40 | 3 |

本次记录的 Vitest tests 与 retention 用例耗时均没有下降；表中没有独立 wall 数据，不能用 tests 耗时代替外部 wall。运行环境未做受控 A/B，不能把差值归因于改动。调用数从源码控制流明确由 40 减为 3，减少 37 次只读准备，但尚无稳定耗时收益证据。没有修改生产代码、cleanup 事务、retention 语义或测试 timeout；本轮只运行该文件，未运行正式串行全量。

## 2026-10-15：桌面修复热点诊断（候选未实施）

`pnpm test tests/desktop-abandonment-repair.test.ts --maxWorkers=1 --testTimeout=90000 --reporter=json --outputFile=.tooling/desktop-abandonment-repair-current.json` 为 **68/68 PASS、exit 0**，逐用例 duration 合计 **76.738 秒**。它与历史全量中的 150.130 秒不是受控 A/B，不能声称提速。报告未分段采样 `beforeEach` 的 `updateDesktop`，将其替换为直接 JSON fixture 仅是候选，尚未写入源码或验证收益。

后续重复运行的执行会话失联，未取得最终退出码，不计为第二份通过证据。收尾时只读进程快照未发现相关 Vitest/candidate 进程，`.tooling/test-tmp` 仍有三个目录；保留现场，不据此宣称 strict teardown 成功。此次同步文档不继续实施该候选，也不新增正式全量结果。
