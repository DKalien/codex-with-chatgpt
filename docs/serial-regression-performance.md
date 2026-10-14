# 串行回归性能记录

观察日期：2026-10-13，时区 Asia/Shanghai。本文分阶段记录测试准备提速和随后旧伴侣源码退役；时间单位均为秒，源码验证不代表部署。

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
