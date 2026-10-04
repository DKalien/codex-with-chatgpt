# R5j：串行 profiling 与实验分组验证（command23–24）

## 当前状态：deferred，历史实验不用于晋升（2026-10-04）

command43 起用户已将 R5j 放到产品与生命周期工作之后；下方 command42 及更早 NEXT_EXPECTED_STEP 只是历史计划，不再要求继续 hotspot/worker 优化。当前实验清单为160文件/3356测试，packaging1/serial6/parallel153、support32，parallel workers3；仅因已审阅变更维护计数/hash，没有新的三连跑或 acceptance_ready 证据。

唯一正式全量仍为 `pnpm test --maxWorkers=1 --testTimeout=90000`；`test:parallel` 和 `test:full:candidate` 都不替代正式门禁。当前构建与最近完整串行/后续定向证据见 [开发计划](development-plan.md)。command39 的3054三连跑、command40–42的3064实验均不可用于当前3356清单晋升。

## command42：update-check seed节省6.45s，worker4仍超时（2026-10-03）

**当前决定：`worker4_not_accepted`；官方experimental candidate仍parallel workers3，acceptance_ready=false、authoritative=false。** 唯一worker4实验全部功能与安全门禁通过，但wall505.25s / runner505.11s超过480s；没有第二次实验、三连跑或正式serial full。当轮 NEXT_EXPECTED_STEP（现已 deferred）：Planner独立复核fixture与原始证据，调查fork-scripts真实PowerShell/Git启动成本及机器竞争；本轮不切换官方worker数。command40性能失败及command41超时保持有效，command39的3054历史三连跑不能用于当前3064晋升。

仅优化`tests/update-check.test.ts`的初始化fixture。suite lazy seed含普通remote仓库与真实`clone --no-hardlinks`的local；origin=`../remote`、upstream=`../absent-upstream`，upstream ref沿用原初始化。每例`fs.cpSync`递归复制整对，cache在case内，完整快照证明复制config与已用Git读取验证的相对URL一致；逐例canonical路径只能到自己的remote，缺失upstream限定case内部。seed/copy完整文件和目录hash包含.git refs/config/objects；拒绝symlink/junction、nlink非1、alternates、commondir/gitdir共享机制。每例后复核seed不变，case与seed均strict teardown，部分seed构造失败不创建第二个seed。suite隔离Git global/system config，与既有helper一致，结束恢复环境。

七个原scenario及断言从commit helper起逐字节等价（仅换行归一），保留真实checkForUpdates/fetch/remote及local commit/dirty/index/stash/tracking/checkout/detached/failed origin/force/cache。未改`src/cli/update-check.ts`或其他production src/Browser行为；command41进程归属runner及其测试文件与本轮开始逐字节一致。manifest只刷新update-check测试hash，32项support hashes完全不变；inventory仍151文件/3064测试、packaging1/serial6/parallel144，唯一共享dist writer与六个serial fences不变。

### 前后各一次standalone测量

同一命令：`pnpm exec vitest run tests/update-check.test.ts --maxWorkers=1 --testTimeout=90000 --reporter=default --reporter=./scripts/test-full-candidate-reporter.mjs`。前后均7/7 PASS、exit0、无skip/pending/retry/repeat/flaky；只给计时子进程设置Git Trace2输出，不保留源码插桩。suite是candidate reporter的file diagnostic duration，wall包含外层启动成本。

| 指标 | before | after | 减少 |
| --- | ---: | ---: | ---: |
| wall(s) | 41.6750733 | 35.2292571 | 6.4458162 |
| suite(s) | 38.8273674 | 32.1997538 | 6.6276136 |
| 初始bootstrap Git进程 | 49（7×7） | 10（suite一次） | 39 |
| scenario Git进程 | 172 | 172 | 0 |
| 顶层Git进程合计 | 221 | 182 | 39 |
| bootstrap Trace2窗口合计(s) | 9.057418 | 2.135809 | 6.921609 |

10次seed初始化包含原拓扑7次、origin改relative1次及origin/upstream URL读取2次。scenario仍为helper32次+checkForUpdates内部140次；剔除随机case路径与commit OID后，172条真实Git argv顺序完全一致。计数基于顶层Trace2 SID，排除Git自行派生的嵌套进程；时间窗口从每批首个Git start到末个Git exit，含批内间隙但不含首个spawn前的外部开销，不等同全部fixture或CPU时间。

| 原场景（秒，含该case hooks） | before | after |
| --- | ---: | ---: |
| equal / 旧缓存 | 4.7634 | 6.1800 |
| remote ahead / HEAD-index-stash-dirty 保留 | 5.0956 | 3.9113 |
| local ahead / 缓存后实时检查 | 4.9131 | 3.8961 |
| diverged | 4.2918 | 3.2414 |
| tracking branch / 切换失效 | 8.8098 | 6.9409 |
| upstream tracking / detached HEAD | 2.5373 | 1.0912 |
| force refresh / fetch 失败不缓存 | 8.4137 | 6.8988 |

首例after包含唯一seed构造，故比before慢；余下六例省去重复bootstrap。standalone wall实测节省15.47%，低于8s且未达15s目标，本轮未追加推测性复杂度。基线bootstrap Trace2总窗口仅9.06s，这一优化点可削减的已观测成本有限。39次初始化进程消除、场景调用同序及6.45s实际收益被视为有意义的fixture收益，因此在focused通过后执行已授权的唯一worker4实验；该收益不预先承诺full门槛。

### 唯一worker4全量实验

focused candidate guards **17/17 PASS**，typecheck、pre-freeze diff-check通过。冻结430个source/test/support文件，相对本轮开始只有update-check test及manifest两文件变化。ignored wrapper与官方runner仅两条import路径、checkout定位及parallel workers3→4不同，manifest/phases/reporter/audits一致；wrapper及430冻结hash在运行前后不变。CPU只读查询仍Intel Core i3-8100 @3.60GHz、4 cores / 4 logical processors。

| 实验 | wall(s) | runner(s) | packaging(s) | serial(s) | parallel(s) | files/tests | candidate exit |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| run1 | 505.25 | 505.11 | 32.66 | 61.53 | 399.00 | 151/3064，全passed | 0 |

未舍入wall=505.24994030000016s、runner=505.11322980000006s；分别超480s 25.2499403/25.1132298s，亦未达到≤450s强余量门槛。实验验收wrapper exit1；candidate功能/安全exit0。packaging1文件/1测试/worker1、serial6/69/worker1、parallel144/2994/worker4，timestamp证明顺序无重叠；151唯一文件、3064实际测试全部passed，skip/pending/retry/repeat均0、flaky=false，无race/lock测试失败。按命令只运行一次，不因超时重跑。

| 热点（秒） | command41 workers4 | command42 workers4 | 变化 |
| --- | ---: | ---: | ---: |
| fork-scripts | 222.37 | 241.97 | +19.60 |
| sleep-wake-feedback | 0.05 | 0.05 | -0.00 |
| companion-feedback | 17.11 | 16.12 | -0.99 |
| legacy-reconciliation | 80.31 | 81.25 | +0.94 |
| gc-apply | 77.62 | 77.01 | -0.61 |
| r5d2-result-bus-delivery-lifecycle | 65.13 | 68.05 | +2.92 |
| update-check | 90.29 | 83.07 | -7.23 |
| record-cli | 47.89 | 54.66 | +6.77 |

相对command41，update-check减少7.23s，fork-scripts增加19.60s，record-cli增加6.77s；parallel增加11.48s，wall增加7.03s，runner增加7.25s。相对command40 workers3 parallel462.94s，本轮399.00s减少63.94s，但两轮代码与负载不同，不能当成受控worker数对照。standalone已测得fixture成本削减；一次full仍无法分离机器负载、调度及竞争影响，也不能证明稳定性。下一观察重点仍是241.97s的fork-scripts及全局子进程竞争，不能据此削弱测试或超时。

barrier与结束后stored/computeBuildId/core-release均为`7550f6aa658123f608ca41dd7e9c51db1c2819c7e19c65f749a54604e6ac5734`，dist字节/目录快照不变。runner精确身份PID18796/Created `2026-10-03T13:59:20.3496920Z`；before/after原始快照经command41审计算法独立回放一致，global-new/attributed/ambiguous/unrelated均0、listener0、新test-tmp目录0。430冻结hash、精确manifest及官方workers3复核通过，没有事后删除残留或kill进程。

证据保留ignored `.tooling/command42/`（standalone原始report/Trace2、analysis、run1、independent-audit、freeze、wrapper差异）；runner原始目录`.tooling/r5j-candidate/1791035960620-58d03c6a-7a7b-480c-a8ff-5e77ab084678/`。官方`test`仍`vitest run`，CI/default gate不变；本轮无packaging外build、authoritative serial full、install/rollout/GC/endpoint switch/rebind/Retire/Abandon/commit/push。保留已有dirty及历史输出；实验结束后仅同步三份docs并执行最终diff检查。最后正常same-origin标准record返回精确command42，不使用task fallback/manual Result Bus，不预称trusted终态或Browser ACK。

## command41：保守进程归属修复，worker4单次超时，官方仍workers3（2026-10-03）

**决策：`worker4_not_accepted`；官方experimental runner保持parallel workers3，acceptance_ready=false、authoritative=false。** 本轮仅一次worker4实验，没有第二次实验、正式串行full或三连跑。command40的571.66/570.65s性能失败继续有效，command39的3054历史证据不用于当前3064晋升。NEXT_EXPECTED_STEP：Planner独立复核归属修复及本轮性能证据，优先聚焦fork-scripts/update-check的真实Git/子进程热点；不在本轮切换worker数或放宽超时。

command40进程误报的根因是旧`machineLeaks`将所有整机新增test-capable进程视为测试泄漏，未判断父链。现于测试前用`process.pid`在快照中匹配唯一精确PID/Created，缺失、重复或无效时间直接失败；创建时间保留Windows七位小数，比较不丢100ns精度。新进程父链命中runner精确身份则归属候选；命中其他精确pre-run身份才可确认无关。断链、重复身份、循环、元数据漂移、parent Created晚于child或PID复用歧义均作为泄漏；只有pre-run记录而after已消失的父进程不能排除运行中PID复用，仍fail closed。无进程名称豁免名单。仅归属/歧义进程拥有的listeners计入失败，另保留global-new/attributed/ambiguous/unrelated计数。快照仍只采集PID/ParentPID/Name/Created及listeners，不采集命令行或环境。

在现有进程审计测试项中扩充确定性断言，覆盖父/孙进程归属、无关父/孙及listener、缺失父链、消失父进程、PID复用、100ns时间差、重复记录、循环、缺失runner身份。原测试项不删减，focused仍**1文件/17测试PASS**，typecheck与diff-check PASS。仅修改runner、对应测试文件和manifest的两项hash；expectedTests保持3064、151文件、32 support hashes和packaging1/serial6/parallel144不变。430文件冻结后的实验前后hash完全一致，production src及Browser Companion无改动。

ignored `.tooling/command41/worker4.mjs`由当前runner精确生成，仅改变两条import路径、checkout定位和parallel workers3→4；manifest、phases、reporter及审计逻辑相同，副本hash前后不变。CPU只读查询为**Intel Core i3-8100 @3.60GHz，4 cores / 4 logical processors**。

| 单次worker4 | wall(s) | runner(s) | packaging(s) | serial(s) | parallel(s) | files/tests | candidate exit |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| run1 | 498.22 | 497.87 | 33.86 | 63.27 | 387.51 | 151/3064，全passed | 0 |

未舍入wall=498.21755870000015s、runner=497.8681865s，超480s分别18.217558700000154/17.86818649999998s，亦未达到≤430s强余量门槛；因此实验验收wrapper exit1，不能与candidate功能/安全exit0混淆。实际phase覆盖packaging1/1/worker1、serial6/69/worker1、parallel144/2994/worker4，顺序无重叠；151个唯一文件/3064实际测试均passed，无skip/pending/retry/repeat/flaky，未观察到race/lock测试失败。单次通过不能证明稳定性。

| 热点文件（秒） | command40 workers3 | command41 workers4 |
| --- | ---: | ---: |
| fork-scripts | 165.06 | 222.37 |
| sleep-wake-feedback | 0.03 | 0.05 |
| companion-feedback | 18.07 | 17.11 |
| legacy-reconciliation | 80.16 | 80.31 |
| gc-apply | 73.70 | 77.62 |
| r5d2-result-bus-delivery-lifecycle | 68.93 | 65.13 |
| update-check | 51.02 | 90.29 |
| record-cli | 44.28 | 47.89 |

实测parallel从462.94降至387.51s，减少75.43s（16.29%）；wall减少73.44s（12.85%），runner减少72.79s（12.75%）。没有控制机器负载的一组对照，不能把全部差值归因于workers4。fork-scripts增加57.30s、update-check增加39.27s，表明整体并行时间缩短并不等于单文件加速；下一步诊断目标是这两组真实Git/进程工作量及竞争，不是0.05s的sleep-wake-feedback。具体慢用例包括fork的local-ahead/diverged拒绝52.56s、equal/fast-forward30.89s，update-check的tracking/cache切换24.18s、force/fetch失败22.71s；本轮未调整这些测试或生产逻辑。

barrier及结束后stored/computeBuildId/core-release均为`7550f6aa658123f608ca41dd7e9c51db1c2819c7e19c65f749a54604e6ac5734`；dist字节/目录快照不变。runner身份为PID4056/Created `2026-10-03T13:20:47.7436590Z`，原始before/after快照经新算法独立回放一致。global-new0、attributed0、ambiguous0、unrelated0、listener0，新增test-tmp目录0；本次没有真实新增无关进程，排除分支由确定性场景覆盖，不声称本次live排除了command40那5个历史进程。

证据保留ignored `.tooling/command41/`，runner原始目录`.tooling/r5j-candidate/1791033648306-426631e4-f9ce-4729-9eb2-26961ec65f58/`。官方`test`仍`vitest run`，CI/default gate不变，无install/rollout/GC/endpoint switch/rebind/Retire/Abandon/commit/push。完成后仅同步三份docs并diff检查，最后正常same-origin标准record返回精确command41，不使用task fallback或人工Result Bus操作，不预称trusted终态或Browser ACK。

## command40：当前3064基线首轮未合格，streak停止（2026-10-03）

**当前状态：experimental candidate=`experimental_blocked`，acceptance_ready=false，authoritative=false。** command39的151/3054三连跑只属于历史冻结基线，不能用于当前3064测试的promotion。本轮仅完成run1，合格0/3；按STOP规则未启动run2/3，没有修复、重试或重分类。NEXT_EXPECTED_STEP：Planner独立复核本轮时间及机器进程审计证据，再决定后续任务；本轮不具备promotion资格。

pre-streak核验workspace为codex-with-chatgpt/2582910bf0d2，当前Desktop thread=`01a101c3-9904-71f1-8d9d-78550f40fa35`、binding=`3e866dc6-8c9c-41a8-9afe-861e6dacf899`。HEAD仍为`cedb95c7db4e6b7174ebf1313968d33ca5f74694`，无staged/conflict，已有dirty保留。430个source/test/support文件与`.tooling/auth-stale-recovery/frozen.json`的当前正式串行3064基线精确一致；command40冻结快照文件SHA-256=`0f5b63d28454bbd206aa07cb6523be3e78ddd1f3016e98f203864caec49d2986`。manifest精确151文件、expectedTests=3064、32 support hashes、packaging1/serial6/parallel144；唯一共享dist writer仍为desktop-helper-packaging，六个serial fences未变。官方`test`保持`vitest run`。

| 本轮 | wall(s) | runner(s) | packaging(s) | serial(s) | parallel(s) | files/tests | candidate exit | 资格 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| run1 | 571.66 | 570.65 | 32.34 | 62.28 | 462.94 | 151/3064，全passed | 1 | FAIL |
| run2/3 | — | — | — | — | — | 未启动 | — | STOP |

未舍入wall=571.6614673999993s、runner=570.6543347s，分别超过480s门槛91.66146739999931s和90.65433470000005s。只有一轮，故不计算三轮min/median/max/mean，也不借用历史样本补齐。packaging实际1文件/1测试/worker1，serial6/69/worker1，parallel144/2994/worker3，各phase exit0；151个唯一文件、3064个实际测试均passed，skip/pending/retry/repeat均0、flaky=false。phase时间戳证明packaging→serial→parallel严格顺序且无重叠。

| 指定热点文件 | run1(s) |
| --- | ---: |
| fork-scripts | 165.06 |
| sleep-wake-feedback | 0.03 |
| companion-feedback | 18.07 |
| legacy-reconciliation | 80.16 |
| gc-apply | 73.70 |
| r5d2-result-bus-delivery-lifecycle | 68.93 |
| update-check | 51.02 |
| record-cli | 44.28 |

packaging barrier与结束后独立复核的stored/computeBuildId/core-release均为`7550f6aa658123f608ca41dd7e9c51db1c2819c7e19c65f749a54604e6ac5734`。serial+parallel后dist字节/目录快照不变；430冻结hash与manifest/support复核不变；新增`.tooling/test-tmp`目录0、相关listener0。candidate机器快照检测到5个新增存活进程，报`new test-capable process/listener survived`并exit1：node11260、cmd11096、cmd7504、node20048、node16648，创建于12:52:46–47Z。只读归属复核显示其祖先为运行前已存在的codex.exe2056→ChatGPT.exe1864，三个node均使用Codex CUA runtime；无fixture、test runner或workspace命令行引用。该证据未指向候选测试后代，但不将机器审计结果重分类为PASS；耗时也独立超限。没有kill进程、删除残留或清理历史输出。

原始日志、冻结快照、独立分析及进程归属证据保留于ignored `.tooling/command40/`；runner原始目录为`.tooling/r5j-candidate/1791031574094-34f85c03-fcd4-48e5-ac36-17aa082771b2/`。本轮无source/test/support修改、正式serial full、packaging外build、install/rollout/GC/endpoint switch/rebind/Retire/Abandon/commit/push；streak结束后只同步三份指定文档并执行diff检查。command40投递查询曾为outcome_unknown；结束使用当前same-origin标准record，由既有严格self-reconcile/终态门禁决定回执，不手工改Bus、不预称trusted receipt或Browser ACK。

## 2026-10-03：原配对认证复核与 Bridge 恢复（普通用户请求）

实查 Bridge 原 PID16844 已不存在，local/admin 请求失败；原 Companion fbf58987-6868-40d2-8189-00fbeb4967f9 未 superseded、route attestation verified，Feedback binding/epoch 仍6135d264…/11。通过 current installed stable launcher 为2582910bf0d2执行 start --tunnel，复用原 named URL；新PID16188/creation134355028686992076/startedAt2026-10-03T12:07:50.008Z，运行8e155373…e2eebce，local/admin/named exact通过，四份Desktop/Feedback/Web Sink/Executor store启动前后逐字节不变。系统只读查询确认LastBootUpTime=2026-10-03T09:44:22.3476590Z（北京时间17:44），晚于旧Bridge启动；原进程随机器重启消失，之后未自动拉起。旧runtime没有matching graceful intent；未发现相关Application1000/1001崩溃事件。不能把该观察归因为Codex updater；机器启动后的独立恢复仍缺失，R5i supervisor/lifetime尚未完成。

已证明恢复缺口：旧版 authStale 一旦durable写入，requireProtectedTransport阻断GET /state，watchdog也被停用，失去用同一凭据复核的路径；旧版未记录触发原因，本次最初401/identity异常的来源未知。修复仅放行相同protected credential的只读/state复核，身份/route响应严格校验；exact成功持久化后才能清authStale。超时、5xx、401、身份漂移/坏响应、持久化失败均不授权Send；坏200响应不再被当成凭据已撤销的证据。请求身份与认证失败revision隔离迟到响应，bounded authStaleReason不含原响应文本。已有一分钟discovery alarm可复核旧标记，不拥有owner或Send能力，不re-pair/rebind/clear target；mutation gate、journal和route fence保留。popup允许GET /state并改为“认证待复核—保留原配对”，stale时productionEligible=false。

相关9 files/431 tests、typecheck/build/diff通过；checkout build三方ID=7550f6aa658123f608ca41dd7e9c51db1c2819c7e19c65f749a54604e6ac5734；最终正式串行full 151 files/3064 tests全PASS、exit0，Vitest1062.22s/wall1065.24s；430个冻结source/test/support hash在full前后不变，新增目录/child/listener/connection均0，build三方ID复核不变。新增10个auth恢复回归，151文件覆盖不变，candidate expectedTests更新3064并精确刷新hash；command39的3054测试三连跑仍是历史冻结基线，不代表新代码已获候选晋升资格。无Core install/rollout/GC/commit/push；用户重载扩展后用原凭据点击一次连接，实测同companionId/binding/epoch恢复connected、authStale=false、owner=true、VERIFIED、mode=armed、health=ready/journal=NONE，无重新配对；证明原凭据仍有效。command39原trusted output241随后从queued进入正常claimed，attempt885d8b4b-6e9f-4411-a568-94de07dad56f，未重录或人工Bus操作；后续只读检查原record与Bus项均已不存在，不把absence单独当作Browser observed/ACK独立证据。本轮为普通composer请求，不补记command39或伪造same-origin receipt。

## command39：fresh 三连跑合格，acceptance_ready（2026-10-03）

本次是同一冻结集合上的全新三连跑，未混入command35/36的历史候选结果。workspace精确为codex-with-chatgpt/2582910bf0d2；无staged/conflict，HEAD保持cedb95c7db4e6b7174ebf1313968d33ca5f74694，既有dirty保留。430个源码/测试/support hash与command37及command38部署基线完全一致，run1前冻结一次，三轮前后均校验不变；整个streak没有patch、重分类或失败重试。

manifest静态验证151文件恰好一次、expectedTests=3054、32个support hash精确，packaging1/serial6/parallel144，唯一共享dist writer仍为desktop-helper-packaging。每轮实际phase计数为packaging **1文件/1测试/worker1**、serial **6/69/worker1**、parallel **144/2984/worker3**；报告时间戳证明严格按packaging→serial→parallel顺序且无重叠。所有file/test state均passed，retryCount/repeatCount=0、flaky=false；无skip/pending。

| 轮次 | wall(s) | runner(s) | packaging(s) | serial(s) | parallel(s) | files/tests | exit | 双480s门槛 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| 1 | 476.71 | 475.80 | 29.51 | 57.64 | 376.66 | 151/3054 | 0 | PASS |
| 2 | 459.78 | 458.88 | 30.71 | 56.49 | 360.63 | 151/3054 | 0 | PASS |
| 3 | 450.11 | 449.23 | 27.66 | 54.44 | 356.18 | 151/3054 | 0 | PASS |

| 实测文件（秒） | run1 | run2 | run3 |
| --- | ---: | ---: | ---: |
| fork-scripts | 133.91 | 133.19 | 114.47 |
| legacy-reconciliation | 64.82 | 67.51 | 63.46 |
| gc-apply | 62.60 | 62.08 | 56.15 |
| r5d2-result-bus-delivery-lifecycle | 60.76 | 57.14 | 96.08 |
| update-check | 43.37 | 42.35 | 22.09 |
| record-cli | 40.15 | 31.89 | 29.07 |

wall min/median/max/mean = **450.11 / 459.78 / 476.71 / 462.20s**；runner = **449.23 / 458.88 / 475.80 / 461.30s**。资格判断使用未四舍五入原值，最慢wall距离480s仅3.29s；三次通过不意味着所有后续负载均有同样余量。

三轮packaging barrier的stored/computeBuildId/core-release均精确为 **`8e1553735dc817e60d758d8ffb156c41a2758d70562995470f09e1803e2eebce`**。每轮serial+parallel后的dist字节及目录快照不变；相对该轮pre-run快照，新增test-tmp目录0、可归因存活child0、listener0；未删除历史候选输出、未事后清残留或kill未知进程。430冻结hash与manifest/support在最终复核仍一致。原始日志、独立报告和汇总保留于ignored `.tooling/command39/`，三个runner artifact目录由run1/2/3.json精确引用。

**状态：experimental candidate = `acceptance_ready`，authoritative=false。NEXT_EXPECTED_STEP：Planner独立审查promotion语义。** package.json官方`test`仍`vitest run`，唯一正式full仍`pnpm test --maxWorkers=1 --testTimeout=90000`；未修改CI/default gate，未在本轮重跑正式serial full，未在packaging之外build。仅streak结束后更新三份docs并做diff-check；无source/test/support语义变化、install/rollout/GC/endpoint switch/rebind/Retire/Abandon/commit/push。command39最后正常same-origin record，terminal finalizer与Browser observed不预称成功。

## command38：reviewed acquisition 修复部署完成（2026-10-03）

430个command37冻结源码/测试/support hash不变，沿用已review的151/3054正式门禁，不重跑full/candidate/typecheck/build。stored/computeBuildId/core-release、installed full artifact及当前运行build全部精确为`8e1553735dc817e60d758d8ffb156c41a2758d70562995470f09e1803e2eebce`；installed `execution/{short-lock,output,records}.js`与reviewed dist逐字节相等，未在生产制造锁竞争。

| 验证 | 结果 |
| --- | --- |
| scoped rollout | 仅2582910bf0d2；upgraded1/pending0/error0 |
| runtime identity | 旧22824/creation134354762025198833消失；新16844/creation134354837905238319；startedAt2026-10-03T06:49:51.686Z |
| readiness | local/admin/named exact健康，immutable entry/provenance匹配；runtimeUpgrade=current/upgradePending=false；锁clear/idle PASS |
| bindings | Desktop/Feedback/Web Sink/Executor unchanged；Desktop available、unresolvedDelivery=false；Companion route VERIFIED |
| preserved authority | command10 unknown锁、dangling runtime、其他workspace runtime字节/身份不变；历史gc-trash目录身份不变 |
| install auto-GC | 候选0，deleted0/tombstoned0/skipped0/bytes0；partial仅dangling exact warning，global0/local1 |
| post-rollout plan | 2 releases；新8e keep，旧8256唯一候选72,095,173 bytes；unknown0/global0/local1；未追加apply |

本轮仅三份docs改动与部署检查，最终diff-check PASS，无源码/测试语义变化，无endpoint switch/rebind/Retire/Abandon/commit/push。command38正常same-origin record是新installed output/records的普通执行路径，不预称terminal trusted commit或Browser ACK。**NEXT：健康回流经独立确认后开始新的候选三连跑验收；candidate仍experimental，3054精确测试数与1/6/144分组、command36 fork seeds保持。** 未证明真实Codex updater resilience。

## command37：Windows execution 短锁 acquisition 分类修复（2026-10-03）

command36 的 450.51s 候选仍是 3053 PASS / 1 FAIL，不能作为性能验收成功；fork seed 优化保持不变。本轮只改 execution output/records 的锁获取分类，不扩展其他 store，不删除或抢占已有锁。

生产修改前，在 ignored `.tooling/command37/` 的独立状态运行六个真实 child，反复对同一 lock `wx/write/fsync/close/unlink`，每个进程只释放自身成功创建的锁，单 child 最长 30s。只记录 errno、次数及失败后路径可见性；所有 child 正常退出，锁均不存在。未识别底层 Windows holder/内核原因，不推断杀毒软件。

| 隔离检查 | wall | attempts / success | acquisition errno | 完整性 |
| --- | --- | --- | --- | --- |
| 修改前原始短锁竞争 | 31.32s | 17,874 / 8,586 | EEXIST 9,274；EPERM 14 | EPERM 后路径 present 2 / absent 12；fatal 0 |
| 修改前真实 output，6×80 | 18.83s | 4,831 / 480 | EEXIST 4,351 | ID 唯一连续、nextId 正确、retention 40、body 对应 |
| 修改后原始短锁竞争 | 31.45s | 18,409 / 8,848 | EEXIST 9,539；EPERM 22 | EPERM 后路径 present 6 / absent 16；fatal 0 |
| 修改后真实 output，6×80 | 16.89s | 3,814 / 480 | EEXIST 3,334 | ID/nextId/retention/body 全部通过 |
| 修改后真实 records，6×80，sync/async 混合 | 5.01s | 1,268 / 480 | EEXIST 788 | 480 条唯一记录、无丢失 |

原始竞争两轮实际复现 acquisition EPERM；生产 API 压力检查未复现 EPERM/EACCES，因此 Windows 两类权限 errno 的恢复/超时边界另以确定性 fs fault injection 证明，不能宣称真实 API 压力跑已覆盖每个 errno。临时诊断 instrumentation 已移除，原始结果留在 ignored 目录。

`src/execution/short-lock.ts` 只供三个 `openSync(lock, "wx")` catch 使用：EEXIST 保持竞争；Windows EPERM/EACCES 视为尚未取得写权限的 acquisition uncertainty。沿用每次 store acquisition **500ms** 截止与 **10ms** 等待（sync Atomics.wait / async timer），到期分别抛 `OUTPUT_STORE_BUSY` / `EXECUTION_RECORDS_BUSY`。非 Windows EPERM/EACCES、其他 errno 原样失败；不探测、删除、reclaim 他人锁。action、close、unlink 及 fsync 路径不变，错误不转换为 BUSY。

现有 output-atomicity 14 个用例内扩展三种 store（output/sync records/async records）的 transient/persistent、Windows/non-Windows、EEXIST/EPERM/EACCES/ENOENT/EIO 断言：成功重试 2 次/10ms，持续竞争 51 次/500ms 且零记录；async 无 Atomics.wait、timer 清零。post-commit unlink 失败，以及 records post-append fsync 失败，均原样失败；BUSY-only 调用方只写一次，保留恰好一份 metadata/body 或 JSONL。原有真实四 writer、retention/原子提交断言保留。

调用方审计：Remote controller 仅重试 typed OutputStoreBusyError（另有独立 Remote WORKSPACE_BUSY），records 无生产 BUSY 自动重试；strict index 的 BUSY 仅阻止读取，不产生写入。release/post-write errno 不能进入本次 acquisition 分类。未更改 receipt 身份、append 顺序或 fsync 语义。

focused 10 files / 211 tests PASS（Vitest 115.57s，wall 118.24s），typecheck/diff PASS，focused 新目录/child/listener/connection 残留均 0。candidate manifest 仅刷新 output-atomicity hash，expectedTests=3054、151 files、packaging1/serial6/parallel144 保持。

最终冻结后只跑一次正式 `pnpm test --maxWorkers=1 --testTimeout=90000`：**151 files / 3054 tests 全 PASS，exit0，Vitest 948.11s / wall 950.65s**。430 个源码/测试/support hash 在 full 与 build 前后均一致；新增 test-tmp/child/listener/connection 为 0，没有事后删残留或 kill 未知进程。canonical build PASS，stored/computeBuildId/core-release 三方精确相等：`8e1553735dc817e60d758d8ffb156c41a2758d70562995470f09e1803e2eebce`。Python helper 未改，不单独重复 Python gate。本轮最后走 command37 正常 same-origin record；active draft 的 trusted receipt 与 canonical handoff 由 turn terminal finalizer 核验，不预称 Browser observed/ACK。

本轮不运行 experimental candidate、不安装/rollout/GC/endpoint/rebind/commit/push。candidate 仍 experimental，command36 fork 优化未撤销；NEXT 为 Planner review 本轮生产锁修复及正式门禁，之后另行安排候选验收，不能用本轮串行通过代替三连跑。

## command36：fork-scripts seed bootstrap 优化；候选遇到 output lock EPERM（2026-10-03）

本轮只改`tests/fork-scripts.test.ts`及manifest hash，生产脚本/src/package.test均未改。Windows前后各一次相同命令：`pnpm test tests/fork-scripts.test.ts --maxWorkers=1 --testTimeout=120000 --config .tooling/command36/profile.config.mjs --reporter=default --reporter=./scripts/test-full-candidate-reporter.mjs`。ignored Vite transform仅在测量环境变量存在时插入内存计时，未向测试/生产源码写入instrumentation；完整候选使用原配置，不加载该插件。原始计时/日志留在ignored `.tooling/command36/`。

| 分段（包含子调用，不可重复累加） | before | after |
| --- | ---: | ---: |
| 13 tests，全通过，exit0：外层墙钟 | 111.18s | 97.37s |
| Vitest 文件 tests/hooks | 106.95s | 93.55s |
| makeGitRepo init/add/initial commit | 14次 / 5.36s | 2次 / 0.72s |
| makeDevRepo（含初始化/拷贝） | 8次 / 3.49s | 8次 / 1.04s |
| makeUpstreamRepo（含 bare remote/首次 push 或拷贝） | 6次 / 5.55s | 6次 / 1.93s |
| buildCoreFixture 初始 fixture | 8次 / 0.15s | 1次 / 0.017s |
| build-failure 的 B buildCoreFixture | 1次 / 0.014s | 1次 / 0.013s |
| dev-install 生产 PowerShell | 10次 / 46.88s | 10次 / 40.27s |
| update-upstream-track 生产 PowerShell | 12次 / 42.96s | 12次 / 41.72s |
| 场景显式 Git（不含重复 bootstrap） | 50次 / 5.42s | 50次 / 5.05s |
| fake pnpm 创建 | 7次 / 0.014s | 7次 / 0.012s |
| 每例 strict teardown（13次） | 0.714s | 0.610s |

总墙钟减少 **13.81s / 12.43%**，未达到节省20s目标。可直接对应的dev/upstream bootstrap合计9.04→2.97s；afterEach seed完整性检查另耗0.421s。PowerShell本身也波动7.85s，不能把全部墙钟收益归因于seed。新增suite seed的afterAll strict teardown在最终文件总耗时内，未被分段flush单独计时；前后测新增目录均0。没有为追求目标追加推测性改写，fake pnpm成本微小所以仍每例独立。

慢用例before→after：local-ahead/diverged18.28→17.05s；equal/fast-forward12.59→10.74s；build-failure11.24→8.57s；preserve10.32→9.71s；dev install repeat9.56→8.09s。这是standalone数据，不与command35并行负载下149.73/155.85s视作同条件基线。

实现边界：dev和upstream pair各一个惰性suite seed；每例`fs.cpSync`普通复制独立`.git`、源码与minimal dist，仍有独立installRoot/coreStateDir。upstream URL为`../remote`，通过真实Git读取、canonical path断言确认指向本例copied pair；每个seed/copy递归检查无symlink/junction、文件nlink=1，复制hash等于seed，afterEach复核seed全部字节/refs未变，afterAll严格清理seed。13个`it`测试体/断言/timeout逐字不变；真实writer clone、fetch、worktree、update-ref、stash和exact-process后台子进程测试保留。显式Git总数110→65，减少的是重复初始化，场景50次不变，另新增6次remote URL校验；PowerShell22次完全不变。

focused fork13、runner/strict-teardown guards17、typecheck/diff PASS。manifest仍151 files、packaging1/serial6/parallel144、expectedTests精确3054、support32；429个冻结hash稳定。唯一完整候选结果：

| phase | files/tests | seconds | result |
| --- | --- | ---: | --- |
| packaging | 1/1 | 27.69 | PASS |
| serial | 6/69 | 57.59 | PASS |
| parallel3 | 144/2984 | 350.99 | 2983 PASS / 1 FAIL |
| complete | 151/3054 | runner449.60 / wall450.51 | exit1：3053 PASS / 1 FAIL |

151文件恰好一次，零skipped/pending，phase无重叠；新增目录/child/listener0、dist字节/目录不变，packaging stored/computeBuildId/core-release均`8256ad7b704e7c109973b5c1436253f05a59aa24ed157fc766fbecfad3016765`。fork-scripts在候选中13/13 PASS、124.85s；其后legacy-reconciliation72.31s、gc-apply62.03s。**失败轮即使低于480s也不计性能验收通过，候选仍experimental/blocked；没有第二轮候选或三连跑。**

唯一失败是未修改的`tests/output-atomicity.test.ts`真实4-writer用例：`src/execution/output.ts:45`的`openSync(index.json.lock, "wx")`收到Windows `EPERM`。当前只对`EEXIST`作有界锁等待，其余错误直接拒绝。该fixture使用独立stateDir并`Promise.allSettled`等所有writer退出后才清理，路径不属于fork seed。源码/测试hash与command35一致；一次诊断性单独运行14/14 PASS，不能覆盖原失败。底层是Windows删除共享窗口、权限还是其他holder尚无充分证据，不笼统把EPERM当可重试busy，不删除锁、不改变生产完整性语义。

**NEXT_EXPECTED_STEP：Planner复核fixture改动与候选失败 → 聚焦output lock Windows EPERM的确定性复现/分类，再验证候选；功能门禁健康后才安排新三连跑。** 本轮不运行正式serial full、不独立build/install/rollout/GC/endpoint/rebind/commit/push。command36以同origin标准BLOCKED record收尾，不预称trusted commit或Browser observed/ACK。

## command35：精确覆盖合同与连续验收（2026-10-03）

结论：**仍为experimental，performance blocked，不是acceptance_ready。** 第1轮达标，第2轮功能通过但超过480s，依授权规则未启动第3轮；没有为凑齐三轮继续跑，也没有重跑正式serial full。

runner将历史`minimumTests=2919`改为machine-readable `expectedTests=3054`并精确相等校验；少/多一个测试、missing/duplicate文件均拒绝，每个file/case仍必须passed（skipped/pending拒绝）。在现有17个guard/teardown用例内补断言，没有增删用例，baseline仍151/3054。phase新增startedAt/endedAt以核验顺序，不改变测试语义。manifest只刷新runner和该测试hash；全量重审151文件、32个support hash，分组仍packaging1/serial6/parallel144。唯一共享checkout dist writer是desktop-helper-packaging；其余build/install测试只写隔离fixture。serial6为bridge-parent-death、daemon-parent-death、daemon-spawn、runtime、windows-process、web-control-cli。

| 轮次 | packaging：1文件/1测试 | serial：6文件/69测试 | parallel：144文件/2984测试 | runner秒 | 外层墙钟秒 | 结果 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 29.76 | 57.97 | 362.39 | 462.47 | **463.35** | exit0，151/3054全passed，≤480 |
| 2 | 28.90 | 58.23 | 386.23 | 484.90 | **485.86** | exit0，151/3054全passed，超限5.86秒 |
| 3 | — | — | — | — | — | 按超时停止规则未启动 |

仅已完成的**两轮**统计：wall min/median/max=463.35/474.61/485.86s；runner=462.47/473.69/484.90s，不是三轮验收统计。两轮都满足阶段不重叠、每个文件恰好一次、无skipped/pending；429个source/test/support冻结hash前后及轮间不变。每轮新增test-tmp目录0、可归属/保守新增node/python/git/cmd/powershell/pwsh/cloudflared进程0、listener0，未事后删目录/kill来掩盖残留。packaging屏障stored/computeBuildId/core-release均为`8256ad7b704e7c109973b5c1436253f05a59aa24ed157fc766fbecfad3016765`；serial+parallel后dist文件和目录快照完全相同。

主要差异来自parallel阶段增加23.84秒；packaging/serial基本稳定。文件duration是同worker内tests/hooks实测，不能直接当作整轮可节省墙钟：

| 文件 | 第1轮秒 | 第2轮秒 |
| --- | ---: | ---: |
| fork-scripts | 149.73 | 155.85 |
| legacy-reconciliation | 61.64 | 72.27 |
| gc-apply | 57.57 | 65.12 |
| r5d2-result-bus-delivery-lifecycle | 55.88 | 57.69 |
| update-check | 36.01 | 42.02 |
| record-cli | 41.21 | 36.39 |

fork-scripts第2轮最慢case：local-ahead/diverged 21.99s、隔离开发安装18.85s、构建失败保留已安装A 16.51s、equal/fast-forward 15.38s、保留dirty/staged/stash 14.51s。代码确认此文件反复创建隔离Git/安装fixture并执行真实PowerShell、Node和Git；pnpm是测试替身，不能把这些时间称为重复真实canonical build。尚无分段CPU或单次spawn归因，不把时间波动直接归因于某一种系统负载。

**NEXT_EXPECTED_STEP：R5j-c2，聚焦fork-scripts的fixture/PowerShell/Git bootstrap成本。** 先对上述case拆分setup/子进程/断言/teardown计时，只去重非被测setup（如可验证的不可变fixture种子，每case仍独立目录），保留真实脚本进程、安装/失败/保护/后台child退出、Git本地remote和dirty/staged/stash语义；不得换成mock或压缩OS等待来达标。最大热点优先，但本轮不承诺文件耗时能线性转化为wall收益。形成更稳的≤450s余量后，再重新冻结并开启新的三连跑。

本轮focused candidate guards **1文件/17测试PASS**；typecheck与git diff --check PASS。无production src/package.test/config变化，不需新增正式serial full；正式门禁仍`pnpm test --maxWorkers=1 --testTimeout=90000`。原始两轮log、JSON、before/after机器快照及分析在ignored `.tooling/command35/` 与各 `.tooling/r5j-candidate/<run>/`。未install/rollout/GC/endpoint/rebind/commit/push。command34 GC已闭环，暂无GC跟进；R5i-a部署与updater resilience未证明的边界不变。command35最后正常same-origin BLOCKED record，不预称Browser ACK。

## command32：已审核构建的部署核验（2026-10-03）

429个源码/测试/support hash与command31通过的151 files/3027 tests正式门禁一致，stored/computeBuildId/core-release/installed/running均为`59e436b7b4b16a9f21a96c745c27e9cbe5d5d269d6e77d1ae056d3f5edc56371`。该版本已于前一轮用户授权恢复时部署，因此本轮stable scoped rollout返回current=1、upgraded=0、pending/error=0，不重复install/restart/GC。fresh进程/健康/绑定检查通过；上轮GC保守跳过13项，零删除。按指令没有再跑正式full、candidate、typecheck或build，仅部署检查和文档diff门禁；candidate仍experimental。

command32最后执行same-origin标准record，后验回流不预称observed。本轮无法直接查看外部Edge认证`/state`，以同版本command31已确认的live证据与本轮严格只读状态区分报告；不伪造请求、不人工Bus操作。NEXT在command32回流健康后先做GC per-release fail-closed redesign，再恢复R5j验收。

## command31：生产 loopback forbidden-port 修复（2026-10-03）

command30消除了直接fixture Fetch问题，生产health/admin/doctor仍可能拒绝Bridge `EADDRINUSE → port=0`分配的合法端口。本轮迁移这些本机buffered请求到固定127.0.0.1的Node HTTP：1MiB上限、总deadline、无pool/redirect/retry；公网named与Browser/SDK Fetch不变。真实parent-death/runtime-prune继续测试生产API；provenance认证路径恢复使用生产adminFetch。新增helper测试隔离真实port=0 server，以逻辑6000验证零Fetch调用和资源释放，未固定端口或弱化断言。

Manifest新增loopback-http并刷新runtime/bridge-provenance hash：151 files，packaging1/serial6/parallel144。候选仍experimental，本轮不跑candidate。最终定向18 files/386 tests PASS，Vitest138.29s、外层140.77s；typecheck/diff PASS。最终冻结后仅一次正式serial full：**151 files/3027 tests PASS，exit0，Vitest922.72s、外层925.20s**（不能将正式serial的耗时当候选≤8m验收）。429个源码/测试/support hash在full前后及build后保持一致，定向/full新增test-tmp目录、残留child/listener/关联连接均0。

正式门禁后canonical build三方身份（stored/computeBuildId/core-release）为`59e436b7b4b16a9f21a96c745c27e9cbe5d5d269d6e77d1ae056d3f5edc56371`。部署pending Planner review；未install/rollout/GC/commit/push。之后GC per-release redesign优先于R5j候选验收。command31以同origin标准record收尾，trusted commit/网页observed由终态流水线及独立网页证据核验，不预称已完成。

后续恢复更新：command31原trusted output233/ok和canonical result已提交，未回流原因是旧c681运行时尚无command28投影修复。2026-10-03用户新增授权后，仅当前workspace安装/rollout上述59e436b7构建，运行PID23616；原记录由正常Browser请求投影并发送，用户确认exact attempt `7b87c323-ea5d-45a5-85fa-a1fcde52ca2d`已收到，本地状态已自动清理。429个冻结源码/测试/support hash仍未变，本次复用已通过的151/3027正式门禁，没有重复full/candidate。三份文档同步部署事实；GC保守跳过13项、零删除。NEXT仍优先GC per-release redesign，candidate保持experimental。

本报告记录 2026-10-02 同机一次测量，不代表并行门禁已通过。源码/测试语义未改；未执行第二次 full、test:parallel、独立 build、机器 install/rollout/GC、endpoint switch 或 commit/push。

## 测量与冻结

- 环境：Windows，Node v25.2.1，pnpm 11.24.0，安装版 Vitest 3.2.7，pool=threads。HEAD `cedb95c7db4e6b7174ebf1313968d33ca5f74694`；已有 dirty work 保留，无 staged/conflict。
- 唯一命令：`pnpm test --maxWorkers=1 --testTimeout=90000 --reporter=default --reporter=./.tooling/r5j-profile/reporter.mjs`。附加 reporter 不改变 include、timeout、worker、isolation 或用例选择；148 files / **2919 passed** / exit0 / unhandled errors0。
- 本地时间 18:12:41 启动外层，18:28:52 退出。外层 `perf_counter` 墙钟 **970.83s（16m10.83s）**；Vitest run **965.64s（16m05.64s）**。与 command21 的同口径 Vitest 946.92s 比为 +18.72s/+1.98%；单次测量不能归因成性能退化。
- 使用本地 Vitest 类型/实现已公开的 `onTestRunEnd`、`TestModule.diagnostic()`、`children.allTests()`、`TestCase.diagnostic()`。内置 JSON 不包含逐文件 prepare/collect/setup，所以临时 reporter 仅在结束时采集；收集序列化对象耗时3.91ms，文件写入在用例结束之后，外层墙钟包含它。没有高频采样或并发 profiler 负载。
- 全部 raw log、逐用例/逐文件 JSON、freeze、进程/端口/目录快照和分析脚本仅在 ignored `.tooling/r5j-profile/`；可用 `python .tooling/r5j-profile/analyze.py` 重新分析现有数据，无需再跑 full。run.py 有已存在 run.json 防重跑保护。
- run 前后 **459 个版本控制/非忽略文件 SHA-256 完全相同，其中 src/tests 369 个**。报告文档是在测试结束后写入。full 自带 packaging 用例执行两次 canonical build，这是原测试覆盖，不是另加的 build。

| Vitest 暴露的阶段 | 累计秒 |
| --- | ---: |
| tests + hooks | 853.68 |
| collect | 42.32 |
| prepare | 35.40 |
| setup | 3.44 |
| environment | 0.032 |
| transform（全局报告） | 4.73 |

transform 是导入相关指标，不能再与 collect 简单相加；上述阶段也不是操作系统 CPU 分析。tests/hooks 占外层墙钟约87.9%，所以单改 TS transform 不可能省掉约8分钟。文件阶段合计934.88s与 Vitest 墙钟差30.76s；外层启动/退出另约5.19s，保留为调度/未分解开销，不擅自归因为CPU。

## 热点：前25个文件（覆盖所有 ≥1% 墙钟项）

排序使用 module.duration，即文件内测试和 hooks 累计实测；不含该文件 prepare/collect/setup。百分比除以970.83s墙钟。前20项合计629.77s，占墙钟64.87%。P/S/R见下节。

| 排名 | 文件 | tests | 秒 | 墙钟占比 | 类别 | 代码与耗时对应的主要成本 |
| ---: | --- | ---: | ---: | ---: | --- | --- |
| 1 | [fork-scripts.test.ts](../tests/fork-scripts.test.ts) | 13 | 116.20 | 11.97% | R | PowerShell/Node/Git 多进程 + 临时安装 fixture；fake pnpm，不是重复真实 build |
| 2 | [web-control-cli.test.ts](../tests/web-control-cli.test.ts) | 2 | 57.90 | 5.96% | P | 多次 node --import tsx CLI 冷启动，独立进程持久化验证 |
| 3 | [legacy-reconciliation.test.ts](../tests/legacy-reconciliation.test.ts) | 57 | 56.10 | 5.78% | P | 真实 output retention + cleanup/preview 多次落盘、锁及 fsync |
| 4 | [r5d2-result-bus-delivery-lifecycle.test.ts](../tests/r5d2-result-bus-delivery-lifecycle.test.ts) | 29 | 50.88 | 5.24% | P | 多 store 状态迁移/真实文件持久化；stale 时间由参数推进 |
| 5 | [gc-apply.test.ts](../tests/gc-apply.test.ts) | 34 | 33.20 | 3.42% | P | 真实隔离 release/GC fixture + CLI 子进程；不是机器 GC |
| 6 | [execution-result-reconciliation.test.ts](../tests/execution-result-reconciliation.test.ts) | 16 | 31.51 | 3.25% | P | Desktop/receipt/routing/outbox/Bus 多 store 投影与持久化 |
| 7 | [desktop-helper-packaging.test.ts](../tests/desktop-helper-packaging.test.ts) | 1 | 28.41 | 2.93% | S | 清空 checkout dist + 两次 canonical build + hash + Python import |
| 8 | [record-cli.test.ts](../tests/record-cli.test.ts) | 13 | 27.90 | 2.87% | P | 13 个 CLI 场景反复 tsx 冷启动，部分场景填满40条输出 |
| 9 | [r5h-command-cleanup.test.ts](../tests/r5h-command-cleanup.test.ts) | 26 | 25.99 | 2.68% | P | cleanup phase/crash matrix，真实 store/lock/journal/文件删除 |
| 10 | [update-check.test.ts](../tests/update-check.test.ts) | 7 | 25.30 | 2.61% | P | 真实临时 Git init/clone/fetch/commit；无外网 remote |
| 11 | [gc-plan.test.ts](../tests/gc-plan.test.ts) | 25 | 21.54 | 2.22% | P | 多 release 文件复制/hash/manifest/reference fixture + CLI |
| 12 | [core-upgrade.test.ts](../tests/core-upgrade.test.ts) | 10 | 20.34 | 2.09% | P | 真实 status/doctor CLI + loopback Bridge + 隔离安装 fixture |
| 13 | [r5d3-result-bus-cutover.test.ts](../tests/r5d3-result-bus-cutover.test.ts) | 42 | 18.98 | 1.95% | P | 多 store cutover/持久化；部分真实 loopback HTTP |
| 14 | [desktop-receipt-finalizer.test.ts](../tests/desktop-receipt-finalizer.test.ts) | 33 | 18.07 | 1.86% | P | 真实 draft/claim/record 文件 + 部分 CLI；IPC/worker seam |
| 15 | [rollout.test.ts](../tests/rollout.test.ts) | 108 | 17.50 | 1.80% | P | 隔离 state/lock/evidence fixture；restart/admin/fetch 均 mock |
| 16 | [core-install.test.ts](../tests/core-install.test.ts) | 32 | 17.43 | 1.80% | P | 隔离 release/dependency junction/copy/hash + 真实 launcher 子进程 |
| 17 | [runtime.test.ts](../tests/runtime.test.ts) | 43 | 16.66 | 1.72% | S | 真实 loopback/server/CLI restart + 身份 mock；OS 敏感 |
| 18 | [companion-feedback.test.ts](../tests/companion-feedback.test.ts) | 57 | 15.59 | 1.61% | P | 多 store pairing/attestation/lifecycle + 少量 loopback HTTP |
| 19 | [routing-legacy.test.ts](../tests/routing-legacy.test.ts) | 35 | 15.26 | 1.57% | P | 隔离 routing/Desktop 文件；transport mock，无真实 Desktop send |
| 20 | [routing-result-outbox.test.ts](../tests/routing-result-outbox.test.ts) | 18 | 14.99 | 1.54% | P | 隔离 routing/outbox/reconciliation 多次 atomic 文件事务 |
| 21 | [feedback-probe-cli.test.ts](../tests/feedback-probe-cli.test.ts) | 3 | 14.11 | 1.45% | P | 真实 CLI bootstrap + 隔离 probe store |
| 22 | [r5-result-bus.test.ts](../tests/r5-result-bus.test.ts) | 13 | 12.06 | 1.24% | P | 隔离 canonical routing/outbox/Bus 文件与 schema |
| 23 | [install-gc.test.ts](../tests/install-gc.test.ts) | 4 | 11.78 | 1.21% | P | 真实 installer→fixture launcher→tsx GC；全在临时 Core |
| 24 | [routing.test.ts](../tests/routing.test.ts) | 23 | 11.18 | 1.15% | P | 隔离 route/command/result schema + atomic 文件事务 |
| 25 | [remote-control.test.ts](../tests/remote-control.test.ts) | 20 | 10.47 | 1.08% | R | Fake app-server + loopback/异步 controller；含2秒 unlock 子进程 |

### 最慢单用例

| 文件 | 用例（保留测试名称） | 秒 |
| --- | --- | ---: |
| web-control-cli.test.ts | 本地 Web Control CLI（独立进程，跨重读持久化） > 只在本地明确开启，接收后记录并反馈，重复 start 不执行 | 49.39 |
| legacy-reconciliation.test.ts | legacy accepted reconciliation > retention horizon 后正常 command cleanup 删除 40 条仍只读重验 snapshot | 32.60 |
| desktop-helper-packaging.test.ts | Desktop helper packaging > clean build 后 helper 唯一副本随 build 复制到 dist，runtime compatibility catalog 不再存在 | 28.41 |
| fork-scripts.test.ts | fork maintenance scripts > local-ahead 和 diverged 都停止且不覆盖 upstream-main | 19.70 |
| fork-scripts.test.ts | fork maintenance scripts > equal 状态不移动引用，远端快进时只做 fast-forward | 13.45 |
| core-upgrade.test.ts | 真实 status/doctor JSON 展示 build pending，build mismatch 不触发 Connector 修复 | 13.32 |
| gc-apply.test.ts | gc apply CLI contract > 互斥模式：plain / --plan --apply 拒绝；--apply --json 成功 | 12.30 |
| fork-scripts.test.ts | fork maintenance scripts > 同步时保留当前 branch、HEAD、dirty/staged/untracked 工作区和 stash | 11.50 |

`legacy-reconciliation` 的1/7/40条真实 cleanup分别2.28/6.81/32.60s，源码逐条调用 preview→confirm→not_found，成本随事务次数增长。R5d2的shadow reconciliation全状态矩阵7.89s；这类多文件/fsync成本仅据执行路径分类，尚未做系统 I/O trace，不能声称精确CPU/I/O百分比。

显式候选结论：daemon-parent-death **6.61s**、bridge-parent-death **5.90s**、daemon-spawn **4.42s**，180–240s只是上限；保留真实 taskkill/Job/认证 shutdown，不优先改。desktop-python 3.83s（一个 Python discover 子进程），不是主要瓶颈。install-gc 11.78s、core-install 17.43s使用小型临时 Core fixture，不能误认为每例复制真实整机安装。build-id 8.46s，其中真实 finalizer/依赖 hash 用例8.31s。packaging 28.41s的两次真实 build承担clean发布与确定性两项不同断言，不能删掉第二次冒充去重。

## 并行安全分类与资源边界

全148文件已做入口/相关 helper 静态资源扫描，热点25文件及已知进程、端口、build、安装、全局 mock 用例作进一步路径审查。**这是候选分类，不是并行稳定性证明；没有运行并行 full。**

- P = `parallel_safe_candidate`：125 文件。随机 per-file stateDir/fixture、独立进程 env 或显式 stateDir是正面证据；仍需分组后实跑确认。
- S = `serial_required`：6 文件。packaging必须独占共享dist；daemon/Bridge parent-death、daemon-spawn、runtime及windows-process暂留真实OS串行组。此策略是当前保守分组，不宣称永远不能并行。
- R = `needs_refactor_before_parallel`：17 文件。共享dist reader需要构建完成屏障；fixture残留/随机端口/后台child teardown需要先补齐。

关键审查证据：

1. `tests/setup-state-dir.ts` 每文件UUID stateDir，线程pool默认隔离；`tests/helpers.ts`随机临时目录。但进程 env、globalThis/fetch、Date/fake timers、fs/process mocks仍必须在文件内恢复，不开 `test.concurrent`。`rollout`/`post-turn-finalizer`只是mock cwd并restore；未发现真实 `process.chdir()`。候选并行必须保持worker isolation。
2. packaging删除/重建真实checkout dist；Companion十组左右的classic/ESM reader以及bridge-provenance的`dist/build-id.txt`不能和它竞跑。先完成同一个真实packaging门禁，再放行reader；缺artifact必须阻断，不能依赖现有部分exists-guard使断言被绕过。fixture内的dist与共享checkout dist已区分。
3. `port.test.ts`随机47000–47999并断言原端口可用；需要由OS分配并持有端口的确定性碰撞fixture，成功/失败路径都close。其他HTTP路径多为listen(0)/port0，数字123/48765等多数只是保存的假runtime，不能按字面一律认定真实端口冲突。
4. `fork-scripts`使用隔离InstallRoot/Core state、fake pnpm、临时repo/remote/Worktree；没有调用真实机器安装。后台8秒child用来证明安装不等管道，在断言后应等待该child退出再删fixture。Git通过隔离global/system配置或临时config执行；没有git global/system配置写入。
5. `web-control-cli`/`record-cli`/feedback-probe-cli、GC CLI等保留每次独立Node/tsx进程，这是跨进程持久化断言的一部分。先允许不同文件重叠，不把同文件调用并发或改同进程。
6. `tunnel`使用注入FakeCloudflaredProcess/fetch，`remote-app-server`用FakeProcess；它们不是外网live测试。windows-process会执行真实binary version探测，留串行OS组；Python协议使用临时文件，daemon寿命探测仍需真实OS。没有将Desktop/网页端negative行为带到生产。
7. 真实竞争测试（output-atomicity/dispatch-store-lock/Desktop result/control/executor dispatch）使用独立state和自己的child PID；候选分组须保留其内部并发与exit验证。PID、Job、外部程序不受C2C_STATE_DIR隔离保证覆盖。

## 泄漏核对

前后 Win32_Process 的PID+creation差集没有存活测试Node/Python/Git/daemon；新增的系统服务/SearchFilterHost不归因于测试，后快照自身PowerShell已退出。TCP Listen差集为空；未发现本轮遗留child/port。另查本轮开始后创建且仍存在的系统temp `c2c-*`目录为0（该部分按创建时间检查，未声称全系统扫描）。

**测试自身未满足“零state残留”：`.tooling/test-tmp`前后新增84个目录。** 分类恰为remote-state20、state27、prune-*22、gc-*4、auth/auth-html5、daemon-*4、dev-install-background1、other-ws1，完整名称见ignored analysis.json。这些是本轮测试临时状态，不是生产command历史；本轮保留现场，没有清理旧测试目录或任何机器业务证据。

直接可定位原因：remote-control用`cleanup(root, stateDir)`调用单参数helper，第二目录未清；runtime-prune的afterEach关闭server并恢复env，但没有移除其state/workspace；port/mcp-integration/oauth遗漏独立auth/state目录；startup-lease遗漏other-ws。daemon/fork目录与alive log/后台进程的早期teardown相符，但没有现场handle trace，不能把WinError32当作已证实根因。helper吞掉cleanup异常使这类残留不影响当前PASS。**因此R5j-e“无泄漏”验收未通过，不能提升实验并行脚本为权威。**

## 量化优化次序

当前file tests+setup/collect/prepare/env合计934.88s。暂留6文件串行组67.02s，其余867.85s；假设R组前置修复完成、所有其余文件可分组并行，理想均分下界是 `67.02 + 867.85/workers`：2 workers约500.95s、3约356.31s、4约283.99s。还需约35.95s现有未分解/外层开销，并行后也可能改变；磁盘fsync/进程创建竞争会增加时长。该模型不是实测加速结果。

| 顺序 | 单一可交付slice | 合理收益范围与限制 |
| --- | --- | --- |
| **NEXT R5j-b1** | **有构建屏障的隔离分组runner：先严格补齐fixture teardown/端口生命周期，packaging先独占完成，OS组串行，其余文件有界3-worker候选；每文件恰好一次、保留原全部断言与子进程语义** | 主要收益约490–570s，预计完整候选400–480s；相对2-worker理想下界+现有开销约537s，盲用现成parallel2不足8分钟。若I/O竞争超预算则该预测失败，不放宽门禁。 |
| R5j-c | CLI/Git/安装fixture bootstrap复用：仅复用只读种子并克隆到独立目录；保留新进程与真实安装/完整hash，避免重新创建不相关Git前史；同周期已有完整build可共享证据但不能删两次build确定性断言 | 可能减少串行工作量20–60s，3-worker墙钟增益通常仅约7–25s。单靠build/packaging不可能节省数分钟；不能把节约外层额外build计成本次full收益。 |
| R5j-d | 20–300ms轮询改事件/exit完成信号，UI flush改确定性微任务；保留真实进程存活观察与授权超时验证 | 预计串行工作量2–8s；daemon两次1秒存活窗口保留，不能把180/240s上限计作可省时间。优先级低于b/c。 |
| R5j-b2/e | 隔离审计通过后可评估4-worker候选；至少3次连续完整同覆盖、无race/flake/child/port/state残留，再由review提升唯一正式命令 | 4-worker理想含现有开销约320s；stretch≤300s需要另省至少20s墙钟，并留竞争余量，现实需约30–70s额外收益或证明调度开销下降。当前数据不足以承诺5分钟；合理候选约300–380s。 |

**NEXT_EXPECTED_STEP = Planner independent review → R5j-b1（fixture生命周期修复 + 构建屏障/资源分组的3-worker候选实现）**，不是再次profiling。当前正式门禁仍`pnpm test --maxWorkers=1 --testTimeout=90000`。后续开发每次最终源码冻结后一次正式full，R5j-e资格验收才另按明确范围完成3连跑。R5i-a保持deployed/verified，helper-breakaway且final/healthy Job=true；updater resilience未证明，R5i-b/c/d/e仍排在R5j之后。

## 148文件静态分类明细

每行秒数是测试+hooks；flags只定位审查入口，不证明每个命中都操作真实资源：E=env，G=global/process mock，C=child-process入口（可能mock），N=server入口（可能mock），F=隔离文件fixture，T=timer/poll（可能fake），D=共享dist reader屏障，L=teardown/端口待修，X=当前串行组。没有flags也不等于已获并行批准。所有≥1%文件均在上方逐项解释。

| 文件 | 秒 | 分类 | 资源入口 |
| --- | ---: | --- | --- |
| [action-indicator.test.ts](../tests/action-indicator.test.ts) | 0.014 | P | 只读/纯逻辑入口 |
| [activation-skill.test.ts](../tests/activation-skill.test.ts) | 0.018 | P | 只读/纯逻辑入口 |
| [architecture-separation.test.ts](../tests/architecture-separation.test.ts) | 0.027 | P | 只读/纯逻辑入口 |
| [auth-compatibility.test.ts](../tests/auth-compatibility.test.ts) | 1.125 | P | N,F |
| [bridge-maintenance-fence.test.ts](../tests/bridge-maintenance-fence.test.ts) | 0.879 | P | E,F |
| [bridge-parent-death.test.ts](../tests/bridge-parent-death.test.ts) | 5.897 | S | E,C,F,T,X |
| [bridge-provenance.test.ts](../tests/bridge-provenance.test.ts) | 1.469 | R | E,G,N,F,T,D |
| [browser-companion.test.ts](../tests/browser-companion.test.ts) | 0.024 | R | D |
| [build-id.test.ts](../tests/build-id.test.ts) | 8.462 | P | C,N,F |
| [chatgpt-route.test.ts](../tests/chatgpt-route.test.ts) | 0.009 | P | 只读/纯逻辑入口 |
| [classic-route-fence-regressions.test.ts](../tests/classic-route-fence-regressions.test.ts) | 0.026 | R | G,T,D |
| [claude-runner.test.ts](../tests/claude-runner.test.ts) | 0.076 | P | 只读/纯逻辑入口 |
| [companion-feedback.test.ts](../tests/companion-feedback.test.ts) | 15.592 | P | E,N,F |
| [control-protocol.test.ts](../tests/control-protocol.test.ts) | 0.013 | P | 只读/纯逻辑入口 |
| [core-install.test.ts](../tests/core-install.test.ts) | 17.433 | P | E,C,F |
| [core-upgrade.test.ts](../tests/core-upgrade.test.ts) | 20.337 | P | E,C,N,F |
| [daemon-parent-death.test.ts](../tests/daemon-parent-death.test.ts) | 6.611 | S | E,C,F,T,X |
| [daemon-spawn.test.ts](../tests/daemon-spawn.test.ts) | 4.424 | S | E,C,F,T,X |
| [desktop-abandonment-cli.test.ts](../tests/desktop-abandonment-cli.test.ts) | 0.075 | P | E,G,F |
| [desktop-abandonment.test.ts](../tests/desktop-abandonment.test.ts) | 3.169 | P | E,F |
| [desktop-control.test.ts](../tests/desktop-control.test.ts) | 7.608 | P | E,G,C,F,T |
| [desktop-current.test.ts](../tests/desktop-current.test.ts) | 0.311 | P | G,F |
| [desktop-envelope.test.ts](../tests/desktop-envelope.test.ts) | 0.380 | P | F |
| [desktop-helper-packaging.test.ts](../tests/desktop-helper-packaging.test.ts) | 28.412 | S | E,C,X |
| [desktop-interfaces.test.ts](../tests/desktop-interfaces.test.ts) | 2.603 | P | E,G,N,F |
| [desktop-ipc.test.ts](../tests/desktop-ipc.test.ts) | 0.124 | P | E,C,T |
| [desktop-outcome-resolution.test.ts](../tests/desktop-outcome-resolution.test.ts) | 1.641 | P | E,G,F |
| [desktop-python.test.ts](../tests/desktop-python.test.ts) | 3.832 | P | E,C |
| [desktop-r45e-architecture.test.ts](../tests/desktop-r45e-architecture.test.ts) | 0.019 | P | 只读/纯逻辑入口 |
| [desktop-receipt-finalizer.test.ts](../tests/desktop-receipt-finalizer.test.ts) | 18.074 | P | E,G,C,F,T |
| [desktop-receipt-skill.test.ts](../tests/desktop-receipt-skill.test.ts) | 0.006 | P | 只读/纯逻辑入口 |
| [desktop-result-cli.test.ts](../tests/desktop-result-cli.test.ts) | 1.806 | P | E,G,F |
| [desktop-result.test.ts](../tests/desktop-result.test.ts) | 5.776 | P | E,C,F |
| [desktop-unknown-reconciliation.test.ts](../tests/desktop-unknown-reconciliation.test.ts) | 0.527 | P | E,F |
| [dispatch-store-lock.test.ts](../tests/dispatch-store-lock.test.ts) | 1.680 | P | C,F |
| [e1b2-transport.test.ts](../tests/e1b2-transport.test.ts) | 0.207 | P | F |
| [e1b3-dom-capability.test.ts](../tests/e1b3-dom-capability.test.ts) | 0.028 | P | 只读/纯逻辑入口 |
| [e1b3-send-journal.test.ts](../tests/e1b3-send-journal.test.ts) | 0.021 | P | 只读/纯逻辑入口 |
| [e1b3-send-orchestration.test.ts](../tests/e1b3-send-orchestration.test.ts) | 0.026 | P | T |
| [e1b3d1-shadow-runtime.test.ts](../tests/e1b3d1-shadow-runtime.test.ts) | 0.049 | R | G,D |
| [e1b3d2a-write-probe.test.ts](../tests/e1b3d2a-write-probe.test.ts) | 0.039 | R | G,D |
| [e1b3d3a-send-probe.test.ts](../tests/e1b3d3a-send-probe.test.ts) | 0.272 | R | G,D |
| [e1b3d3b-production-send.test.ts](../tests/e1b3d3b-production-send.test.ts) | 0.157 | R | G,T,D |
| [e1b3d3b2-autonomy.test.ts](../tests/e1b3d3b2-autonomy.test.ts) | 0.033 | R | D |
| [endpoint-switch-lock.test.ts](../tests/endpoint-switch-lock.test.ts) | 0.143 | P | F |
| [endpoint.test.ts](../tests/endpoint.test.ts) | 0.006 | P | 只读/纯逻辑入口 |
| [execution-output.test.ts](../tests/execution-output.test.ts) | 0.073 | P | E,F |
| [execution-result-projector.test.ts](../tests/execution-result-projector.test.ts) | 5.865 | P | E,F |
| [execution-result-reconciliation.test.ts](../tests/execution-result-reconciliation.test.ts) | 31.510 | P | E,F |
| [execution-terminal.test.ts](../tests/execution-terminal.test.ts) | 0.096 | P | E,F |
| [executor-core.test.ts](../tests/executor-core.test.ts) | 0.365 | P | F,T |
| [f1-companion-resilience.test.ts](../tests/f1-companion-resilience.test.ts) | 0.036 | P | T |
| [feedback-bootstrap-runner.test.ts](../tests/feedback-bootstrap-runner.test.ts) | 0.129 | P | 只读/纯逻辑入口 |
| [feedback-companion-pair.test.ts](../tests/feedback-companion-pair.test.ts) | 0.250 | P | F |
| [feedback-decomposition.test.ts](../tests/feedback-decomposition.test.ts) | 0.020 | P | 只读/纯逻辑入口 |
| [feedback-finalization-repair.test.ts](../tests/feedback-finalization-repair.test.ts) | 0.201 | P | F |
| [feedback-finalization.test.ts](../tests/feedback-finalization.test.ts) | 0.403 | P | F |
| [feedback-probe-cli.test.ts](../tests/feedback-probe-cli.test.ts) | 14.110 | P | E,C,F |
| [feedback-probe.test.ts](../tests/feedback-probe.test.ts) | 0.757 | P | E,F,T |
| [fork-scripts.test.ts](../tests/fork-scripts.test.ts) | 116.201 | R | E,C,F,T,L |
| [g4-rebind-browser.test.ts](../tests/g4-rebind-browser.test.ts) | 2.536 | P | G,T |
| [g4c-connect.test.ts](../tests/g4c-connect.test.ts) | 0.010 | P | 只读/纯逻辑入口 |
| [gc-apply.test.ts](../tests/gc-apply.test.ts) | 33.203 | P | E,C,F |
| [gc-plan.test.ts](../tests/gc-plan.test.ts) | 21.541 | P | E,C,F |
| [git.test.ts](../tests/git.test.ts) | 7.586 | P | E,F |
| [install-gc.test.ts](../tests/install-gc.test.ts) | 11.777 | P | E,C,F |
| [legacy-reconciliation.test.ts](../tests/legacy-reconciliation.test.ts) | 56.103 | P | E,F |
| [legacy-retirement.test.ts](../tests/legacy-retirement.test.ts) | 3.628 | P | E,F |
| [maintenance-lock.test.ts](../tests/maintenance-lock.test.ts) | 0.397 | P | E,F |
| [mcp-integration.test.ts](../tests/mcp-integration.test.ts) | 3.918 | R | N,F,L |
| [named-health.test.ts](../tests/named-health.test.ts) | 0.037 | P | G,T |
| [oauth.test.ts](../tests/oauth.test.ts) | 0.317 | R | N,F,L |
| [output-atomicity.test.ts](../tests/output-atomicity.test.ts) | 6.024 | P | E,C,F |
| [pairing.test.ts](../tests/pairing.test.ts) | 0.013 | P | T |
| [popup-permission.test.ts](../tests/popup-permission.test.ts) | 0.099 | R | D |
| [port.test.ts](../tests/port.test.ts) | 0.090 | R | N,F,L |
| [post-turn-finalizer.test.ts](../tests/post-turn-finalizer.test.ts) | 1.950 | P | E,G,F |
| [prefs.test.ts](../tests/prefs.test.ts) | 0.027 | P | E,F |
| [production-feedback-message.test.ts](../tests/production-feedback-message.test.ts) | 0.013 | P | 只读/纯逻辑入口 |
| [production-feedback.test.ts](../tests/production-feedback.test.ts) | 3.697 | P | F |
| [r45f-architecture.test.ts](../tests/r45f-architecture.test.ts) | 0.033 | P | 只读/纯逻辑入口 |
| [r5-endpoint-architecture.test.ts](../tests/r5-endpoint-architecture.test.ts) | 0.014 | P | 只读/纯逻辑入口 |
| [r5-endpoint-core.test.ts](../tests/r5-endpoint-core.test.ts) | 0.158 | P | E,F |
| [r5-executor-binding-store.test.ts](../tests/r5-executor-binding-store.test.ts) | 3.318 | P | E,F |
| [r5-executor-mcp-auth.test.ts](../tests/r5-executor-mcp-auth.test.ts) | 0.976 | P | E,N,F |
| [r5-executor-mcp.test.ts](../tests/r5-executor-mcp.test.ts) | 0.008 | P | 只读/纯逻辑入口 |
| [r5-executor-service.test.ts](../tests/r5-executor-service.test.ts) | 1.204 | P | E,F |
| [r5-result-bus.test.ts](../tests/r5-result-bus.test.ts) | 12.058 | P | F |
| [r5-web-sink-browser.test.ts](../tests/r5-web-sink-browser.test.ts) | 0.751 | P | G |
| [r5-web-sink-companion.test.ts](../tests/r5-web-sink-companion.test.ts) | 0.592 | P | E,F |
| [r5-web-sink-http.test.ts](../tests/r5-web-sink-http.test.ts) | 0.581 | P | E,N,F |
| [r5-web-sink-mcp-auth.test.ts](../tests/r5-web-sink-mcp-auth.test.ts) | 0.470 | P | E,N,F |
| [r5-web-sink-mcp.test.ts](../tests/r5-web-sink-mcp.test.ts) | 0.004 | P | 只读/纯逻辑入口 |
| [r5-web-sink-service.test.ts](../tests/r5-web-sink-service.test.ts) | 1.176 | P | E,F |
| [r5-web-sink-store.test.ts](../tests/r5-web-sink-store.test.ts) | 1.605 | P | E,F |
| [r5b-architecture.test.ts](../tests/r5b-architecture.test.ts) | 0.014 | P | 只读/纯逻辑入口 |
| [r5c-architecture.test.ts](../tests/r5c-architecture.test.ts) | 0.015 | P | 只读/纯逻辑入口 |
| [r5d1-result-bus-architecture.test.ts](../tests/r5d1-result-bus-architecture.test.ts) | 0.015 | P | 只读/纯逻辑入口 |
| [r5d2-result-bus-delivery-lifecycle.test.ts](../tests/r5d2-result-bus-delivery-lifecycle.test.ts) | 50.876 | P | E,F |
| [r5d3-result-bus-cutover.test.ts](../tests/r5d3-result-bus-cutover.test.ts) | 18.977 | P | E,N,F |
| [r5e-architecture.test.ts](../tests/r5e-architecture.test.ts) | 0.013 | P | 只读/纯逻辑入口 |
| [r5e-executor-dispatch.test.ts](../tests/r5e-executor-dispatch.test.ts) | 4.863 | P | C,F |
| [r5e-independence.test.ts](../tests/r5e-independence.test.ts) | 0.960 | P | F |
| [r5e-web-sink-switch.test.ts](../tests/r5e-web-sink-switch.test.ts) | 1.619 | P | F |
| [r5g-cross-plugin-e2e.test.ts](../tests/r5g-cross-plugin-e2e.test.ts) | 6.361 | P | E,N,F,T |
| [r5h-cleanup-cli.test.ts](../tests/r5h-cleanup-cli.test.ts) | 0.899 | P | E,G,F |
| [r5h-command-cleanup.test.ts](../tests/r5h-command-cleanup.test.ts) | 25.989 | P | E,F |
| [r5h-desktop-cleanup.test.ts](../tests/r5h-desktop-cleanup.test.ts) | 1.132 | P | E,F |
| [r5h-execution-cleanup.test.ts](../tests/r5h-execution-cleanup.test.ts) | 1.716 | P | F |
| [r5h-feedback-cleanup-fence.test.ts](../tests/r5h-feedback-cleanup-fence.test.ts) | 4.428 | P | F |
| [r5h-projection-cleanup.test.ts](../tests/r5h-projection-cleanup.test.ts) | 9.358 | P | F |
| [r5h-workspace-cleanup-lock.test.ts](../tests/r5h-workspace-cleanup-lock.test.ts) | 1.669 | P | G,F |
| [record-cli.test.ts](../tests/record-cli.test.ts) | 27.898 | P | E,C,F |
| [record-desktop-discovery.test.ts](../tests/record-desktop-discovery.test.ts) | 0.063 | P | E,G,F |
| [remote-app-server.test.ts](../tests/remote-app-server.test.ts) | 0.017 | P | C |
| [remote-control.test.ts](../tests/remote-control.test.ts) | 10.468 | R | E,C,N,F,T,L |
| [rollout.test.ts](../tests/rollout.test.ts) | 17.505 | P | E,G,N,F,T |
| [route-attestation-runner.test.ts](../tests/route-attestation-runner.test.ts) | 0.058 | P | 只读/纯逻辑入口 |
| [route-attestation.test.ts](../tests/route-attestation.test.ts) | 0.522 | R | G,T,D |
| [routing-legacy.test.ts](../tests/routing-legacy.test.ts) | 15.257 | P | E,F |
| [routing-result-outbox.test.ts](../tests/routing-result-outbox.test.ts) | 14.994 | P | F |
| [routing.test.ts](../tests/routing.test.ts) | 11.178 | P | E,F |
| [runtime-prune.test.ts](../tests/runtime-prune.test.ts) | 0.373 | R | E,N,F,L |
| [runtime.test.ts](../tests/runtime.test.ts) | 16.656 | S | E,G,C,N,F,T,X |
| [sandbox-allow.test.ts](../tests/sandbox-allow.test.ts) | 0.020 | P | F |
| [search.test.ts](../tests/search.test.ts) | 0.705 | P | E,F |
| [serve-fence.test.ts](../tests/serve-fence.test.ts) | 3.267 | P | E,C,F |
| [session-projection.test.ts](../tests/session-projection.test.ts) | 0.088 | P | E,F |
| [session.test.ts](../tests/session.test.ts) | 0.067 | P | E,F |
| [sleep-wake-feedback.test.ts](../tests/sleep-wake-feedback.test.ts) | 0.021 | P | 只读/纯逻辑入口 |
| [startup-lease.test.ts](../tests/startup-lease.test.ts) | 0.237 | R | E,F,L |
| [tunnel.test.ts](../tests/tunnel.test.ts) | 0.413 | P | E,C,F |
| [update-check.test.ts](../tests/update-check.test.ts) | 25.305 | P | F |
| [watchdog-idempotence.test.ts](../tests/watchdog-idempotence.test.ts) | 0.012 | P | 只读/纯逻辑入口 |
| [web-control-cli.test.ts](../tests/web-control-cli.test.ts) | 57.903 | P | E,C,F |
| [web-control-feedback.test.ts](../tests/web-control-feedback.test.ts) | 0.834 | P | E,F |
| [web-control-lifecycle.test.ts](../tests/web-control-lifecycle.test.ts) | 0.162 | P | F |
| [web-control-state.test.ts](../tests/web-control-state.test.ts) | 0.978 | P | F |
| [windows-process.test.ts](../tests/windows-process.test.ts) | 1.682 | S | E,C,F,X |
| [workflow-cli.test.ts](../tests/workflow-cli.test.ts) | 0.017 | P | 只读/纯逻辑入口 |
| [workflow-mcp-projection.test.ts](../tests/workflow-mcp-projection.test.ts) | 2.372 | P | E,N,F |
| [workflow-readiness-collector.test.ts](../tests/workflow-readiness-collector.test.ts) | 0.087 | P | E,F |
| [workflow-readiness-routing.test.ts](../tests/workflow-readiness-routing.test.ts) | 0.070 | P | F |
| [workflow-readiness-session.test.ts](../tests/workflow-readiness-session.test.ts) | 0.189 | P | E,F |
| [workflow-request.test.ts](../tests/workflow-request.test.ts) | 1.964 | P | E,F |
| [workspace.test.ts](../tests/workspace.test.ts) | 0.079 | P | F |
| [write-probe-cli.test.ts](../tests/write-probe-cli.test.ts) | 7.104 | P | E,C,N,F |
| [write-probe.test.ts](../tests/write-probe.test.ts) | 0.821 | P | E,N,F |

## R5j-b1：隔离修复与实验分组 runner（command24）

本节是 command23 静态分类之后的实测更新。生产 src/browser-companion 字节未改；未 install/rollout/restart/commit/push，历史84个目录未被删除。正式门禁仍是 `pnpm test --maxWorkers=1 --testTimeout=90000`，`test:full:candidate` 明确实验性。

| 原残留类别 | 数量 | 修复与边界 |
| --- | ---: | --- |
| remote-state | 20 | remote-control 的 cleanup 第二参数曾被忽略；改为显式多目录严格清理，unlocker 失败路径也等待 exact child 退出。 |
| prune/gc roots + runtime-prune state | 50 | 24 个 state、22 个 prune root/parent/outside 和4个 GC fixture root 全部登记；server 关闭、mock/env 恢复之后删除。 |
| port/MCP/OAuth state + auth | 8 | 3个 state 与5个 auth/auth-html 补登记；MCP client/Bridge 先关闭。port A 使用 OS port=0，B 请求 A 的实际占用端口，取消随机区间猜测。 |
| daemon fixtures | 4 | live/in-job/env-projection 原测试留下存活 child；command24按spawn PID登记并等待ESRCH（其PID-reuse P2由下方command25修复）。parent-death WMI 在已退出后仍可能遇 Windows 文件释放窗口，严格 rm 使用有限原生重试；持续占用仍失败，不归因成已证明的生产 helper 泄漏。 |
| dev-install-background | 1 | 原8秒 linger 子进程跨测试尾端持有输出；先断言 installer 已返回且 exact child 仍活着，再显式终止、确认退出，之后删夹具。保留真实输出管道/后台进程断言。 |
| other-ws | 1 | startup-lease 的 inline workspace root 登记清理。 |

`tests/strict-teardown.ts` 仅供测试：路径必须是 test-tmp 后代且根不能是 link；先关闭所有者，再使用 Node 原生 rm 的 maxRetries=8/retryDelay=100ms（单个重试序列最多3.6秒），任何持续错误向上抛出。command24仅登记spawn/fixture的PID，EPERM/unknown不当退出，但raw-PID终止仍有reuse风险；command25改为同一HANDLE的exact creation/executable校验。12个新增回归覆盖分区/hash、漏/重/跳执行、dist指纹、PID reuse诊断、包含范围和清理失败传播。未改生产 daemon lifetime。

### 分类与 shared-dist 屏障

[显式分类清单](../scripts/test-full-candidate-manifest.json)为 **149文件：packaging 1 / serial 6 / parallel 142，即142P / 7S / 0R**。先前17个R：10个dist reader在packaging完成后只读；fork-scripts、port、runtime-prune、remote-control、mcp-integration、oauth、startup-lease补齐所有权/清理后进入候选。reader中9个Browser suite使用内存sandbox/VM而非真实DOM/网络，bridge-provenance的spawn/probe为mock、实际server用port0且afterEach关闭；env/mocks按文件隔离并恢复。Git/安装只在随机fixture中、全局Git配置禁用或指向fixture，未用真实机器安装路径。

packaging 单独执行原有两次真实canonical build并校验 stored/computeBuildId/Core-release 三方一致；随后 snapshot 包含 build-id.txt、全部artifact字节和空目录。其他OS组（bridge-parent-death、daemon-parent-death、daemon-spawn、runtime、windows-process）保持 maxWorkers=1，且与parallel不重叠。web-control-cli经实测改为第6个serial文件。

[runner](../scripts/test-full-candidate.mjs)保留canonical Vitest配置，仅分区include与maxWorkers=1/3；testTimeout=90000不变，用例自带timeout也保留。每阶段独立末尾reporter校验实际module/case集合，aggregate要求149文件恰好一次、有效passed tests>=2919且无skip/pending/error。新文件、重复分类、测试/共享helper/scripts/config/package hash漂移立即要求重新审计；runner不会自动刷新hash。支持清单与运行后dist复核阻止新mutator未经审计进入parallel；这不是静态证明任意代码无副作用。

### 实测与失败修正

首轮候选外层454.16s，149文件执行，只有web-control-cli完整流程因竞争耗时67.69s超过原60s限制；其余通过。新增目录/存活测试child/listener均0，dist一致。没有提高timeout；将它移到serial后重跑。首轮失败不能算成功加速证明。

第二轮候选149/2931全绿、外层466.76s，零新增目录/child/port及dist一致。随后唯一正式serial full测试149/2931通过（Vitest954.58s/墙钟956.60s），但审计发现1个新state目录。日志精确对应runtime.test.ts的ensure-start-lock fixture：只等待runtime文件删除，未等daemon退出，best-effort cleanup吞掉占用错误。补修为退出PID断言+严格cleanup；55项定向通过且新增目录0。第三轮是含此补修的最终候选，下列指标以第三轮为准。前两轮均不算当前代码的三连跑验收。

最终候选：**149 files / 2931 tests PASS / exit0**。runner含分类/前后审计墙钟 **463.53s**，pnpm外层 **464.50s**。相较command23墙钟970.83s减少 **52.2%**；8分钟目标 **达到**，5分钟stretch未达到。只是1次修正后完整通过，不是3连跑稳定性验收。

| phase | workers | files | tests | 墙钟秒 |
| --- | ---: | ---: | ---: | ---: |
| packaging | 1 | 1 | 1 | 26.73 |
| serial | 1 | 6 | 68 | 90.96 |
| parallel | 3 | 142 | 2862 | 334.92 |

每阶段串行衔接；前后机器进程PID+creation、监听端口和test-tmp目录差集审计：**新增存活child0 / listener0 / 新残留目录0**，没有通过删除残留或杀未知PID制造通过。packaging之后dist byte/directory snapshot完全一致。raw保存在ignored `.tooling/r5j-candidate/1790941410845-69c6819a-5b85-41a2-b1ec-aa2cf64185ca/` 及 `.tooling/r5j-b1/`。

正式串行full：**149 files / 2931 tests PASS / exit0**，Vitest **954.58s**，外层 **956.60s**。这是最后runtime teardown补修之前的正式结果；补修后已完成定向与候选，但因command24禁止第二次serial full，最终冻结后的正式门禁待次数授权。不能把候选冒充该门禁，也不宣称command24已完整closeout。

**NEXT_EXPECTED_STEP = 确认是否允许追加正式full（command24次数上限）→ 最终补修冻结后的serial gate → Planner review → R5j-b2/e稳定性验收。** 不把单次成功提升为权威；保留全部真实OS覆盖、两次clean/rebuild identity断言。R5i-a仍deployed/verified，Codex updater resilience未证明，R5i-b/c/d/e排在R5j之后。

### command24 最终文件与辅助门禁

- 新增：scripts/test-full-candidate.mjs、scripts/test-full-candidate-reporter.mjs、scripts/test-full-candidate-manifest.json、tests/strict-teardown.ts、tests/test-full-candidate.test.ts。
- 调整夹具：tests/remote-control.test.ts、tests/runtime-prune.test.ts、tests/port.test.ts、tests/mcp-integration.test.ts、tests/oauth.test.ts、tests/startup-lease.test.ts、tests/fork-scripts.test.ts、tests/daemon-spawn.test.ts、tests/daemon-parent-death.test.ts、tests/runtime.test.ts。
- 入口与文档：package.json、docs/r5j-regression-profile.md、docs/development-plan.md、docs/r5-endpoint-architecture.md。共19文件，已有其他dirty work保留，生产src/browser-companion未变。
- focused：9 fixture文件121项；后续runner及相邻复核3文件52项；runner分区修正12项；最终runtime teardown+runner 2文件55项，均PASS（这些是有交集的定向运行，不相加作唯一用例数）。
- 最终diff检查发现的port空白行尾空格已修正，仅空白变化并精确刷新manifest digest；runner+port 14项复核PASS。`git diff --check` PASS，19文件清单之外无本轮改动、无staged/conflict、历史目录保留。
- typecheck、canonical build PASS；stored/recomputed/Core-release一致：`29e3945669ffc64d9b0d5977c149d51145f1ed97c1f259993a4d38a7b884ffef`。没有安装该build。
- 第一轮正式full审计的1个本轮fixture残留，经日志归属、exact目录结构及无存活测试进程核对后单独清理；原始失败审计未改写，bounded hash证据见ignored `.tooling/r5j-b1/serial-residue-evidence.json`。未删除command23或更早的历史目录；不以这次人工收尾改写任何候选/正式运行的泄漏指标。
- 尚待确认：是否允许突破command24的“不得第二次serial full”上限，为最后runtime teardown补修追加最终冻结后的正式full。候选通过不能替代这项权威门禁。

### command25：fixture PID identity review fix

Planner 发现 command24 `stopFixtureProcess(pid)` 按 raw PID 终止的 P2：短命进程自然退出后，PID reuse 可能使 teardown 触碰无关进程。测试/support 修复改为 `FixtureProcessIdentity={pid,creationTime,executable}`；daemon 直接使用 spawn 返回的 finalProcess，fork 创建方在持有 ChildProcess handle 时同步取得 probe 并写入 fixture marker，remote unlocker 只等待自身 exit event。

Windows 测试 helper 只打开一次带 QUERY/TERMINATE/SYNCHRONIZE 权限的非继承 HANDLE；64位签名明确，在同一句柄上检查 exact creation/executable、TerminateProcess、WaitForSingleObject，finally CloseHandle。身份漂移、活着但权限/探测未知均拒绝终止；已退出目标不再追踪 raw PID；终止后只等待原 HANDLE，绝不重开/杀替代 PID。自然退出期间 query/terminate 可返回 ACCESS_DENIED，只有同一 HANDLE 在最多10秒内 signaled 才证明已退出，持续未知仍失败；外层 helper timeout 15秒。ChildProcess 等待的 timer/listeners 在 exit/error/timeout 后全部释放。没有修改生产 src、daemon lifetime 或历史机器状态。

14项确定性 Python HANDLE 回归使用 fake kernel（含64位handle、PID reuse、creation/exe drift、EPERM/unknown、退出竞态、有限等待、close）；Vitest新增5项覆盖其接线、真实 exact fixture exit、ChildProcess timer清理，总有效用例由2931增至2936。分组维持149文件：packaging1 / serial6 / parallel142；manifest只刷新本轮审计的测试/support字节hash。新增普通child仅拥有自己的进程，不操作共享Job、固定端口或机器安装状态。

本轮唯一实验候选 **149 files / 2936 tests / exit0**，runner **480.29s**、pnpm外层 **481.31s（约8分1秒）**；新增目录/存活测试child/listener均0，dist byte/directory snapshot不变。packaging28.87s（1/1）→ serial96.36s（6/68）→ parallel343.83s（142/2867），各阶段不重叠。相较command23墙钟970.83s减少50.4%，但本次 **超过480s目标1.31秒，≤8m未达成**；不把command24的464.50s代作当前冻结代码测量，也不宣称3连跑稳定。

定向末轮daemon/runner **31 PASS**，fork **13 PASS** 与remote **20 PASS**；Python **14 PASS**；typecheck/diff PASS。早期定向暴露短命进程正在退出时的ACCESS_DENIED窗口，最终改为同一HANDLE有限等待退出证明后补测；持续权限/探测未知仍失败。packaging保留原有真实canonical build及 stored/computeBuildId/Core-release 一致校验，ID为 `29e3945669ffc64d9b0d5977c149d51145f1ed97c1f259993a4d38a7b884ffef`，未额外build。最终测试/support冻结hash保持不变，生产src/browser-companion也与本轮开始一致。raw见ignored `.tooling/r5j-b1-pid/` 和 `.tooling/r5j-candidate/1790944728714-db2b6c28-b009-4bf0-91c0-e80231b3d963/`。

**NEXT_EXPECTED_STEP = Planner复核command25 → 等待明确次数授权 → 最终冻结后的正式serial full → 通过后才进入R5j-b2/e。** command24的954.58s正式full早于最终runtime teardown补修，不能当作command25的最终门禁；本轮明确不运行正式serial full，候选仍非权威。R5i-a仍deployed/verified，updater resilience未证明。未install/rollout/生产restart/endpoint/rebind/legacy cleanup/commit/push。

本轮实际改动11文件（保留既有dirty work）：
- tests/strict-teardown.ts；新增tests/fixture_process_teardown.py、tests/fixture_process_teardown_test.py。
- tests/daemon-spawn.test.ts、tests/fork-scripts.test.ts、tests/remote-control.test.ts、tests/test-full-candidate.test.ts。
- scripts/test-full-candidate-manifest.json（仅审计过的hash/support库存更新，分组不变）。
- docs/r5j-regression-profile.md、docs/development-plan.md、docs/r5-endpoint-architecture.md。

未降低断言、timeout或覆盖；没有用raw-PID kill消除残留。Windows是本轮真实验收平台；Linux仅提供pidfd retained-object路径并复用现有probe，未进行Linux live验收，不支持exact primitive的平台明确拒绝而不降级为raw PID。正式serial gate在command25完全未运行，仍需明确次数授权，之前不推进R5j-b2/e。

### command26：获授权的最终 serial gate 与 return-path 修复

command25 的 exact-process teardown 工作已有 trusted receipt/output228/ok；未正常回流由独立 return-path 缺陷阻塞，不能据此重跑开发或重记回执。command10 的空 lifecycle lock 无 owner proof，保留不抢占；canonical Bus 新增严格只读 legacy/cutover 降级边界，排除 legacy in-flight、拒绝未决迁移/损坏状态，legacy fallback 仍持完整锁。Browser 迟到旧 401 绑定 request credential witness；popup status/RPC 有界 10 秒且不自动 retry mutation。

五个改动测试（r5d3-result-bus-cutover、r5-web-sink-browser、popup-permission、e1b2-transport、e1b3d3b2-autonomy）使用本文件原有独立 state/VM，未新增共享 dist writer、真实固定端口、机器级状态或 child。manifest 只刷新审计后的 hash，仍149文件、packaging1/serial6/parallel142。分区/support 17项 PASS；本轮不增加实验候选运行，当前候选测量仍是 command25 的481.31s，三连跑资格仍未完成。

command26 已使用一次额外正式serial full授权：**147/149 files、2952/2954 tests、exit1、Vitest982.88s / 墙钟985.13s**；424文件hash在该run前后不变，新目录/存活测试child为0。两个失败已补修：router错误类型经adapter导出，shadow源码读取归一化CRLF。补修后4 files / 143 tests、typecheck、canonical build三方身份PASS，build为`c681654acc5a52572551f92b66610689c39f667e89b888bb46eb35cb4efd7f3f`；第六个改动测试重新审计并刷新manifest。用户追加一次授权后，最终正式serial gate为 **149 files / 2954 tests PASS、exit0、Vitest1008.61s / 墙钟1011.18s**；424文件冻结未漂移，新目录/存活测试child为0。未再跑候选或第三次正式full。部署前canonical rebuild三方identity仍一致，部署事实另行记录。此前失败的两个静态源码检查仅调整取样范围和 CRLF normalization，保留 Response.ok/durable-before-memory 原断言；新增异步行为测试未改生产 timeout 或 OS teardown 语义。R5j 下一步须在本次正式门禁与独立 review 后确定，不能以实验候选代替。

command26 scoped部署（2026-10-03本地时间）完成：built=installed=running `c681654acc5a52572551f92b66610689c39f667e89b888bb46eb35cb4efd7f3f`；canonical full-artifact verification PASS，rollout upgraded1/pending0/error0，PID15256→3380、startedAt=`2026-10-02T16:13:34.058Z`、creationTime=`134354312128903287`。local/admin/named health均exact200，runtimeUpgrade=current/upgradePending=false，原named URL及Desktop/Feedback/Web Sink/Executor binding与其他workspace runtime保持。matching helper-breakaway/inAnyJob=true仍不证明updater resilience；旧shutdown诊断对新runtime为conflict，未附着到新进程。GC initial_plan_unsafe下12候选全保留，deleted/tombstoned/bytes为0；command10空锁未删除或抢占。

command25仍使用原trusted output228/ok：部署后先queued、后正常Bus in-flight，随后receipt/Bus消失；用户从原网页回流提供ATTEMPT_ID `380887a7-bf6e-478c-8b4a-3c33747b0ac9`，installed cleanup preview（无confirm）为not_found/artifacts=[]。没有重录/重发、人工reserve/begin/ACK或manual cleanup。Browser用户确认“已连接，自动回流已开启”；本轮未reload扩展，Browser late401/popup timeout新代码须按用户正常reload/update路径生效。

command26收尾限制：追加full授权后当前resultTurnId=`01a0fd4d-ff74-7813-ae20-1387331371af`，原delivery origin=`01a0fd0d-3019-7f83-9521-e7ce89fcf5b8`；旧/新installed helper均只读分类not_applicable，无origin/native-continuation证明。标准same-origin record尚不能声称成功，禁止--task、指定旧turn或伪造receipt；本任务开发/部署已通过，command26 canonical return闭环仍blocked。

command26最终源码已补齐command24/25之后的正式串行门禁。实验candidate仍维持149文件、packaging1/serial6/parallel142；六个改动测试仅更新审计hash，未新增分区或shared-dist writer。三次连续candidate资格验收尚未执行。


### command27：R5j-c1 Web Control CLI cold-start reduction

先对原套件单独测量一次：2 tests PASS，Vitest56.21s、测试体55.64s、外层58.50s。ignored preload只记录spawnSync耗时/operation/PID/status，实际26个不同Node/tsx进程（web-control24、session1、record1），累计55.60s、单次2.03–2.59s。全部raw保存在ignored `.tooling/command27/`，无正文/env/credential。这不是靠timeout声明推断热点。

测试专用 `tests/fixtures/web-control-cli.ts` 只注册生产registerWebControlCommands/registerSessionCommands/registerRecordCommand，复用Commander选项、parseAsync错误边界与真实action/store代码；不导入无关CLI注册图。生产src无修改。静态回归同时验证生产index与fixture仍从相同模块导入并调用这三个register，fixture只含三项注册。严格teardown在同步child退出后删除本套件的两个隔离目录。

所有26次调用仍各自启动真实Node/tsx进程，没有batch/in-process替代；保持初始disabled→session URL、enable→boot/receive、accepted→start/duplicate-start、真实record --task→complete/feedback、disable/close→reopen/seenCommands这五类跨进程持久化checkpoint。原有local-user/owner mismatch、超大与malformed文件读取、假source/内容不回显、重复start、feedback及禁止执行自然语言断言全部保留。

优化后standalone：3 tests PASS，Vitest16.71s、测试体15.99s、外层19.07s；仍26个不同child PID，累计15.93s、单次0.58–0.82s。墙钟减少39.42s（67.4%），同样store/actions和进程数量下的主要收益来自删掉无关cold import graph。主流程46.44→13.60s，异常输入9.20→2.37s；新增接线断言约13ms。未合并操作、放宽timeout或修改生产代码。分组/support guards17 PASS、typecheck/diff PASS。

Manifest只刷新web-control-cli.test.ts并加入新fixture support hash；149文件仍packaging1/serial6/parallel142，有效测试由2954增至2955。本轮唯一candidate全部文件/用例恰好执行一次：**148/149 files、2954/2955 tests PASS，exit1；runner470.95s、外层472.11s**。

| phase | workers | files / tests executed | wall | result |
| --- | --- | --- | --- | --- |
| packaging barrier | 1 | 1 / 1 | 33.53s | PASS；两次真实canonical build/identity gate保留 |
| serial | 1 | 6 / 69 | 66.24s | PASS；web-control-cli为20.44s |
| parallel | 3 | 142 / 2885 | 359.22s | 2884 PASS / 1 FAIL |

新test-tmp目录、存活child、listener均0，dist byte/directory不变。419个冻结source/test/support文件前后无漂移，生产src/browser-companion未改；定向3项、manifest guards17项、typecheck/diff PASS。未运行正式serial full或第二次candidate。packaging生成的stored/computeBuildId/Core-release仍一致为`c681654acc5a52572551f92b66610689c39f667e89b888bb46eb35cb4efd7f3f`，无另行build/install/rollout。raw见ignored `.tooling/command27/` 与 `.tooling/r5j-candidate/1790959133963-90455ed4-2767-4e82-a7dd-30ae42ac08bd/`。

唯一失败为`r5-web-sink-http`的missing/wrong credential 401用例：Node Fetch在HTTP请求进入handler前返回`bad port`。fixture让真实Bridge监听`port=0`；本机只读`netsh int ipv4 show dynamicport tcp`显示起始1024、数量13977（1024..15000），与当前Node内置Undici的Fetch bad-port列表交叠。内置`requestBadPort`正是在URL端口属于此列表时返回该错误。因此OS分配端口不等于Fetch可访问端口；失败时的具体端口没有被记录，不能补猜。没有修改OS端口配置、生产Bridge或失败fixture，没有重试覆盖原失败。

测得外层472.11s比480s少7.89s，比450s多22.11s；但exit1使本次**不满足≤8m完整成功验收**，也不能声明稳定余量。跨command负载及测试数量不同，不能把standalone39.42s收益机械减到command25总时长上。**当前NEXT_EXPECTED_STEP = 新command聚焦测试专用HTTP端口/transport fixture兼容性，保留真实HTTP/auth语义、不改OS配置/生产行为；随后按新授权验证candidate。** 在此阻塞消除、完整exit0和余量确认之前，不进入R5j-b2/e三连跑，不提升候选为权威。未commit/push。

**Desktop授权边界（自command27起）：需要用户专有授权时，当前Desktop command先走标准BLOCKED record并终结，再请求授权；授权后的续作由ChatGPT投递新commandId。普通composer turn绝不提升为native continuation provenance。** 不补记command26，不复用其旧origin创建receipt。


### command28：新 canonical result 的降级 projection 缺口

只读现场确认command27有trusted same-origin receipt/output229（blocked）与canonical RoutingResult，Bus为空；command10 lifecycle lock仍是原0字节、无法证明owner的文件，未删除/抢占。command26只解决了已有Bus项的降级投递：prepare先执行legacy Feedback reconcile，遇COMMAND_CLEANUP_BUSY后进入readOnly cutover，而readOnly不backfill；因此command25可回流、新产生的command27却停在Bus之前。

修复将authenticated Web Sink canonical preparation排序为：严格Feedback snapshot → 独立canonical projection → 可选legacy enrichment/cutover。projection不在legacy catch内；新增projectAvailableResultBusCommands按command分组，持原lifecycle lock后重读RoutingResult，再用原enqueue事务。只隔离同command的COMMAND_CLEANUP_BUSY/COMMAND_CLEANUP_IN_PROGRESS；cleanup journal不重建，锁不抢占。Bus/routing损坏、workspace/immutable/digest冲突及其他异常仍失败；原reconcileWorkspaceResultBus继续严格行为。被跳过command已有queued Bus也不成为本次ready/reserve候选，in-flight单飞不绕过。

仅原有legacy COMMAND_CLEANUP_BUSY允许readOnly cutover降级；已有disposition严格复核，缺处置的历史counterpart仍RESULT_BUS_CUTOVER_REQUIRED，legacy in-flight/corrupt/cleanup transaction仍阻断。canonicalProjectionDegraded只含skippedCount和最多20条commandId/code，不含path/nonce/PID/正文；不是routing/GC authority。valid cleanup journal虽可单独跳过projection，legacy enrichment原有IN_PROGRESS全局拒绝仍保留，不伪装ready。

回归先red：degraded服务运行后新RoutingResult出现，旧/state仍pendingReady=0；修复后真实HTTP/state投影新项、/reserve精确一次且replay不写，旧锁/Feedback不改。覆盖自身锁/journal、Bus/routing损坏、immutable conflict、wrong workspace/route、未决/已有cutover。测试HTTP客户端复用新增test-only http-json.ts（Node http.request，agent=false，超时销毁socket）；r5-web-sink-http与cutover HTTP fixture保持真实port=0/TCP/Authorization/JSON/status断言，避开Fetch forbidden-port限制，不改OS或生产服务。

定向覆盖8 files/163 tests PASS（相关核心2文件78项、其余5文件68项、manifest17项）；首次扩大定向有1项新journal测试预期过宽，修正为保留legacy IN_PROGRESS拒绝后通过。随后唯一正式serial full：**148/149 files、2966/2967 tests PASS，exit1；Vitest841.95s/外层843.95s**。426个冻结文件前后无漂移，build为67dac3002a55b12baa86744dea84cb8ba639137b7c04751a28e91eca4ba4fe7a；新test-tmp目录0、listener0，结束采样出现的2个短命git进程后续只读复核原creation均已消失，未kill。

full唯一失败为companion-feedback的takeover/immediate-successor用例：本轮提前的route check在无Active Sink且旧Feedback epoch过期时先返回400，遮住原应优先的401。已补修为无canonical sink时先建立legacy credential authority，再检查route，均先于projection/mutation；保留原401断言和后续rebind流程。补修后companion-feedback、cutover、R5g、Web Sink HTTP共**4 files/128 tests PASS**；typecheck/canonical build/diff PASS。最终stored=computeBuildId=Core-release为**9af70c8912732a001ef7c40688e6d3116a567267288942d4f406ad297c63ff53**；没有补修后的正式full，不把定向通过冒充最终全量门禁。

本轮一次正式full限额已用完，**deployment BLOCKED**；未运行第二次full或实验candidate、未install/rollout/GC/commit/push。manifest仍packaging1/serial6/parallel142，仅刷新3个测试及新HTTP helper审计hash。关闭前只读复核command27 receipt/output229与RoutingResult hash未变、Bus仍空，command10空锁内容/file identity未变。installed/running仍c681654acc5a52572551f92b66610689c39f667e89b888bb46eb35cb4efd7f3f，故command27自动回流仍待新代码部署，未声称observed/ACK。command28以正常same-origin BLOCKED record收尾，不用--task或新ID冒充本轮receipt。

**当前NEXT：Planner以新commandId授权补修冻结代码的一次正式serial full；通过后沿用已有install/scoped-rollout授权恢复command27正常投递，再核对command28标准回执/结果，并在存在trusted证据时验证正常投影。** 不跨普通用户授权turn追补旧origin，不重录/重发command27；现役旧server仍有projection缺口，command28 canonical handoff也可能停在Bus之前，不能预报回流成功。

**NEXT（本轮回流收敛后）：GC per-release fail-closed redesign优先，区分真正global authority blocker与仅影响单release的未知reference；再恢复R5j候选验证/剩余热点。** 本轮不扩展GC规则，candidate仍experimental、三连跑未开始。R5i-a deployed/verified和updater resilience未证明保持。普通composer turn不提升为native continuation；不补记command26，不重录/重发command27。


### command29：最终串行门禁失败，部署停止（2026-10-03）

在 command28 最终修复快照上只执行了一次获授权的正式 `pnpm test --maxWorkers=1 --testTimeout=90000`：**149 files / 2967 tests，148 files / 2966 tests PASS，1 FAIL，exit1；Vitest 856.96s，外层859.60s**。运行前后426个source/test/support hash完全一致；新增test-tmp目录、残留child和listener均为0，无staged/conflicted文件。本轮没有修改生产、测试或support源码，也没有第二次full或candidate。

唯一失败在 `tests/bridge-provenance.test.ts:148`：真实Bridge以`port=0`监听，未认证`fetch(/admin/info)`在Node Fetch入口抛出`TypeError: fetch failed`，cause明确为`Error: bad port`。请求尚未到达HTTP鉴权或shutdown断言；实际分配端口未记录，不猜测数值。这是另一个真实HTTP fixture使用Fetch与OS动态端口不兼容的实例，不是command28修复的auth-order再次失败。本次full中companion-feedback57、cutover61、Result Bus17、R5g5、Web Sink HTTP5均PASS。按本轮失败分支约束，仅定位，不在本轮修复后追加full。

失败后只读核对stored/computeBuildId/Core-release仍一致为`9af70c8912732a001ef7c40688e6d3116a567267288942d4f406ad297c63ff53`；这不构成正式门禁PASS。本轮未另行typecheck、部署前canonical build、protect/install/GC/rollout。installed/running仍为`c681654acc5a52572551f92b66610689c39f667e89b888bb46eb35cb4efd7f3f`，PID3380；local health/authenticated admin/named public health身份一致，rollout只读gate idle=true，Desktop available、unresolvedDelivery=false、Web Sink VERIFIED。

**command27前置事实已变化**：本轮首次只读检查时receipt、RoutingResult、Bus均已不存在；installed cleanup preview（无confirm）返回`not_found / artifacts=[]`。不能再证明它与command28关闭时的output229/result hash相同，也不能把absence当Browser observed/ACK证明。本轮未重录、重发、重建、手工reserve/begin-send/ACK或清理command27；无可供恢复的本地artifact，回流原因/attempt需独立网页证据确认。command10原零字节锁的SHA256、file identity和mtime完全未变。

command29按正常same-origin `applicable/origin` 走标准BLOCKED record，最终active-turn draft仍须由terminal finalizer验证；不预称trusted receipt或canonical handoff/Browser observed已完成。未commit/push/rebind/endpoint switch，不补记command26。

**当前NEXT_EXPECTED_STEP：以新commandId修复provenance真实HTTP fixture（复用测试用Node HTTP client，保留真实鉴权/shutdown与生命周期断言，审查相邻ephemeral-port Fetch调用），并另行取得一次最终冻结后的正式full次数授权。** 通过后才沿用install/scoped rollout授权；回流健康后优先GC per-release fail-closed redesign（保留真正global authority blockers），再恢复R5j候选验收。candidate仍experimental，R5i-a已部署的历史结论保持，updater resilience仍未证明。


### command30：临时端口 HTTP fixture 修复（仅测试，2026-10-03）

command29唯一失败是provenance用例的`fetch(/admin/info)`在真实HTTP之前被Node Fetch的forbidden-port表拒绝；生产源码与auth-order补修无漂移。本轮先给原provenance用例加入禁止Fetch的确定性guard，确认RED，再替换fixture客户端；不靠碰巧分配到禁用端口或retry证明修复。

复用`tests/http-json.ts`：新增基于Node标准库`http.request`的buffered `requestHttp`，返回标准Response以保留status/headers/text/JSON；`requestJson`仍严格解析，HTML、空body和坏JSON明确拒绝。连接`agent:false`，默认10秒**总deadline**覆盖无响应/未完成body，request close清除timer；redirect仅manual，不添加自动follow或SSE/SDK适配。本轮未改生产timeout、OS端口范围，不采用固定safe port或retry-until-safe。

修复的9个suite：bridge-provenance、auth-compatibility、build-id、runtime、desktop-interfaces、write-probe、oauth、companion-feedback、r5g-cross-plugin-e2e。保留真实Bridge `port=0`、HTTP方法/header/body、鉴权status、OAuth redirect/text、安全header、JSON和生命周期断言。provenance的三个HTTP步骤均使用测试客户端，因为生产`adminFetch`同样使用Fetch；保留未认证404空body、认证200与无token泄漏，POST保留Bearer及`X-C2C-Shutdown-Reason: rollout`、5秒deadline，并验证durable intent。build-id的admin请求同理，仍验证真实server捕获build身份。

静态审计后测试源码中剩余`fetch(`为route-attestation源码字符串断言。**有意保留**SDK StreamableHTTPClientTransport及其内部Fetch、生产probeBridge/adminFetch/CLI真实客户端行为覆盖和Fetch timeout mocks：本地SDK确有fetch注入点，但还要求streaming/SSE/取消语义，本轮buffered helper不具备该完整合同，不能机械替代。故本轮证明的是直接HTTP fixture调用修复，不宣称所有间接生产/SDK Fetch路径已消除端口风险。

新增`tests/http-json.test.ts`8项：以禁止端口6000的逻辑URL进入Node HTTP，在request单元seam仅把TCP目的地映射到真实port=0 server（不绑定固定端口），验证零Fetch调用与真实401/201、method/header/body；验证text/empty/坏JSON、manual redirect/URLSearchParams、无响应/partial响应总超时、socket和timer释放。开发中发现的空404误用JSON解析、server close callback早于socket close事件及events.once因ECONNRESET提前reject的问题已修正；最终没有未处理异常或被放宽的断言。

**最终定向13 files / 285 tests PASS，exit0，Vitest100.09s / 外层102.03s；typecheck与git diff --check PASS。** 覆盖全部变更suite及r5-web-sink-http、r5d3 cutover、candidate manifest guards。427个最终冻结source/test/support文件在定向前后无漂移，生产src/Browser/package/构建脚本与本轮起点一致。新test-tmp目录0、listener0；结束采样2个短命git进程经PID+creation只读复核均已消失，未kill。

Manifest仅刷新9个已审suite hash、http-json支持文件hash，并显式新增helper测试分类：**150 files = packaging1 / serial6 / parallel143**；候选仍experimental。本轮没有正式serial full、candidate full、canonical build、install/rollout/GC、生产runtime/绑定操作、commit/push；tests-only改动不需重建Core。现有dist身份读取仍为`9af70c8912732a001ef7c40688e6d3116a567267288942d4f406ad297c63ff53`，不把旧build身份当作本轮全量或部署证据。

**当前NEXT_EXPECTED_STEP：Planner review本轮测试修复 → 新command单独授权最终冻结后的正式serial full → PASS后沿用已有install/scoped rollout授权。** 回流部署收敛后，用户要求的GC per-release fail-closed redesign仍优先于R5j候选验收；真正global authority corruption继续全局阻断。command30最后使用正常same-origin标准record，active draft的trusted commit/canonical handoff由terminal finalizer核验，不预称Browser observed/ACK；不补记旧command，不使用--task fallback。
