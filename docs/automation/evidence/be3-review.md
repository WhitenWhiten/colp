# BE-03 已执行部分审查

审查基线 `84e8239`（`feat/automation`），覆盖 `93f6d68..84e8239` 中 AW-22、23、24、25、26、30、31。
使用 thermo-nuclear-code-quality-review 标准检查结构、边界、状态迁移、测试和语义。
没有合并远端 PR；没有重审或重构 BE-01/02。共享 rule-service 仅修正 BE-03 引入的
executionPolicyId 替换语义，runtime 仅调整 workerEnabled 分支。

## 执行状态

| 任务 | 现有提交 | 结论 |
| --- | --- | --- |
| AW-22 | eabf2c8 | 策略、预算和复用身份已实现；补修跨日预算，补测策略分页 |
| AW-23 | 4bfd189 | claim/heartbeat/generation/uncertainty 已实现；补修失败后的 run 收敛 |
| AW-24 | f5c2d37 | typed result、同一 plan 恢复已实现；补修逐标签来源校验、空结果、未 ready 提交 |
| AW-25 | ac79c62 | 复用审批、保守 Undo、只读恢复已实现；相关回归通过 |
| AW-26 | 5f9fbd2 | 真实凭据配对与当前撤权已实现；相关回归通过 |
| AW-30 | 3bb4fd1 | 条件工具目录和直接调用权限一致性已实现；相关回归通过 |
| AW-31 | 84e8239 | HTTP/MCP 同源编排已实现；补修输入固定、调度和状态问题 |
| AW-32 / AW-55 / AW-64 | 无 | 未执行，不把本次审查当作 polling adapter、usage read model 或完整 backend E2E 的交付 |

设计包的 tasks.json 是 proposed plan，不是运行证据；本次新增范围限定的 status.md，链接实际提交和证据。
BE-03 因后三项尚未执行，不能宣称整批完成。

## 修复与结构调整

| 优先级 | 原问题 | 修复与验证 |
| --- | --- | --- |
| P1 | intake admission 的 `placed` 计划被当作成功证据；目的地在 admission 后失效仍把根分类标为 succeeded | 必须同时通过当前 source revision、live binding、实际 parent 检查；失败注入反例先得到 succeeded，修复后 blocked 且无 effect |
| P1 | 永久失败后 run 仍 running，依赖任务留在 pending；全部 optional task 被 policy 阻断时 intake 完成又可能让 run 显示 completed | 调度器按终态收敛 run，把失败依赖明确 blocked；failure、budget、stale 入口触发收敛；独立任务继续推进 |
| P1 | 固定输入时 note 不存在，之后新增 note 不在旧 revision map 中，旧 job 仍可领取 | 初次固定与当前检查共用相同的完整 note 集合查询；集合新增、删除、修订变化均使输入 stale，多个 note 明确 blocked |
| P1 | job 的历史 reservation 永久绕过日额度；昨天预留、今天重试时不竞争今天的 cap | reservation 主键改为 `(job_id, day)`，查询、插入和计数使用同一事务的 UTC 日期；保留旧日记录；跨日反例先复现后通过 |
| P1 | PUT 替换 worker 规则时省略 executionPolicyId，旧 view 展开仍保留之前授权 | 构造新 view 时先去掉旧 policy，再应用新完整输入；验证响应与持久读取均无旧策略 |
| P2 | 第一批 100 个 held/等待审批 run 可反复占用扫描预算，使后续 pending work 无法推进 | 扫描先排除 held/cancelled/当前 collection 不可用/不可推进的 busy run，只恢复 consumed plan；使用 target_partition 走现有索引；101 个不可推进 run 的压力边界仍能列出后面的真实工作 |
| P2 | 每条 tag 的来源被合并校验，一条有来源的 tag 可掩盖另一条只有模型证据的 tag；合法空 add 又无法提交 | 每个新增 tag 独立校验 pinned source；空 add 保存 accepted typed result，无伪造 canonical mutation，并能作为后继任务输入 |
| P2 | pending/blocked job 没有 input_json 时，提前提交可触发 null.map / 500；任务读取未统一使用完整 job authority | 先通过 lockWorkJob 当前 Owner/target/privacy/run 校验，再读取 pins；缺少 ready pins 返回明确 409，HTTP 反例覆盖 |

调度器去除递归重入，改为受声明 task 数量限制的循环，每步消费一个 pending task 或返回。
allowlisted 输入准备独立为 task-inputs，统一校验 TaskInput schema 和大小上限；note 查询不再
在固定和校验路径各写一份。worker command 改为 discriminated union，每个命令解析一次，
移除重复 parse 和把 heartbeat body 强转为 Lease 的错误类型关系。没有引入通用工作流框架。
手写新增/重构模块均远低于 1,000 行；生成的 OpenAPI/Node/vendor 文件本次未改动。

## 测试质量与实际执行

所有 PostgreSQL 测试均为 xvfb + Testcontainers PostgreSQL 16.4。使用真实 Owner API、
child-key/token exchange、canonical mutation 和 Plan/Approval ledger；只在故障/积压边界明确
注入存储状态。没有用成功的 mock dispatcher 冒充业务闭环。

反例阶段：

- 新增 5 个过滤案例，3 失败、2 通过：实际复现 run 不收敛、虚假 intake success、note 集合变化漏检；策略微秒分页本来正确，保留覆盖。
- 首轮修复后 worker-pipeline 11 项通过；策略套件新增跨日反例仍失败，确认昨天 reservation 绕过今天 cap。
- 后续修复跨日预算并验证同一 job 可保留两日 reservation，同一天重复调用仍只有一次预留。

完整相关回归命令：

```sh
xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/execution-policy.integration.test.ts \
  tests/integration/automation/job-leases.integration.test.ts \
  tests/integration/automation/typed-results.integration.test.ts \
  tests/integration/automation/approval-undo.integration.test.ts \
  tests/integration/automation/targets-pairing.integration.test.ts \
  tests/integration/automation/tool-catalog.integration.test.ts \
  tests/integration/automation/worker-pipeline.integration.test.ts
```

7 文件 41 项通过。之后增加的规则清除策略和空 tags 流程定向执行：

```sh
xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/worker-pipeline.integration.test.ts -t 'replacing a worker|empty sourced'
```

2 项通过，12 项按名称过滤跳过。执行策略/复用身份纯逻辑测试从 integration beforeEach 的
真实数据库初始化中移到 unit；无需为了一个纯函数启动数据库并运行 migrations。
`execution-policy.test.ts` 和 `typed-output-evidence.test.ts` 两个 unit 文件 4 项通过。
上述轮次有重复，不累加冒充不同测试数；完整回归时 policy 纯逻辑案例尚在旧 integration 文件中。

最后把相同的 collection 当前 Owner/存活边界提前到 candidate 扫描，
将积压反例加强为 50 个 held + 51 个 collection 不可用的 run；同一 xvfb integration 命令
选择 worker-pipeline 文件并加 `-t 'unavailable-collection backlog'`：1 项通过、13 项筛选跳过。

静态验证：server typecheck、修改文件 ESLint、check:imports、check:migrations -- 84e8239、
server build、git diff --check。未改契约，不重复无关 OpenAPI/前端/BE-01/02 套件。

## 迁移和边界

新增迁移 `202610301500_automation_daily_reservations.ts`，在实际 head 之后。升级仅改变
reservation 唯一约束，不删除历史记录。若已有同一 job 多日记录，down 会拒绝恢复旧单列
主键，不自动丢弃审计历史；上线应使用 forward migration。

本次没有实现 AW-32/55/64、Events、CEL、batch、broadcast、UI 或真实 provider 调用。
MCP 十五工具的现有验证仍是 application facade + PostgreSQL，不能代替 AW-64 的完整网络
与 worker 重启验收。动态授权、审批/Undo、崩溃恢复的结论限定在上述真实执行测试范围内。
所有本次启动的 app/临时 PostgreSQL 由 fixture/wrapper 回收；不保留后台服务。

## AW-32/55/64 后独立复审与修复

基线 `1db76fe`，工作树 `feat/colp-automation`。本轮首先独立验证已有 gate：
BE-01 API / BE-02 M1 后端 36 项、AW-64 / usage read model 11 项、参考 worker
传输 7 项通过。随后六个真实 PostgreSQL 反例全部失败，确认下列缺陷，不用原有
happy-path gate 通过替代状态收敛验证。

| 原问题 | 修复行为 |
| --- | --- |
| 明确选择目录的匹配事件预览为 0 run，实际产生摘要任务；pendingTasks 永远为空 | 预览与 admission 共用可执行 run 判断，保留目录时仍列出 enrichment，返回 worker 不可用诊断 |
| 日额度耗尽与永久 maxCalls 共用 terminal blocked，跨日后无法领取 | 显式区分 daily/calls，持久保存 UTC 恢复时间；轮询恢复原始输入、重新核对源与当日额度，等待期间保留后继 pending |
| 已领取任务提交旧输入返回 409，却留在 leased，之后被误记 unknownOutcome | 验证真实 lease/digest 后保留 typed output/attempt，返回契约已有的 stale 状态和诊断，收敛 run；不创建 Plan/effect |
| 审批后 collection revision 变化导致 500 和永远等待 | 转为持久 stale；过期/取消的原 Plan 转 review；未知提交失败保留同一 Plan，返回可重试错误，不重新规划 |
| Owner 拒绝最后一个 proposal 后 run 仍 running | 拒绝事务内收敛任务/run，不依赖原 worker 再提交 |
| 全局暂停拒绝运行中任务的 heartbeat/result，无法保留已生成输出 | 允许当前已领取任务续租和保存输出；效果仍受 pause commit guard 约束，恢复后只推进同一 proposal |

`202610301700_automation_budget_holds.ts` 追加于现有迁移之后。迁移根据已记录的
attempt 数量和 pinned maxCalls 区分旧预算阻塞；恢复不改变 immutable pins，不复活
cancelled/held run。预算读模型使用结构化原因，不再依赖英文 explanation 字符串。

原临时反例转为 `submission-lifecycle`、`daily-budget-recovery`、`worker-preview`
三个正式集成套件。AW-64 手动编辑案例改为实际参考 worker 完成调用，断言 stale
状态、无效果和 journal 清理；仅断言错误码不再算状态收敛证据。补充暂停保存后的
lease 到期/恢复、原 command 重放、过期审批、每日恢复不重置 maxCalls、等待期间
人工编辑及后继任务保留。HTTP 200/stale 表示保存了未采用结果，不表示效果成功。

实际验证环境：Node `v24.14.0`，PostgreSQL `16.4-alpine`；所有集成测试经 xvfb 启动。

```sh
xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/submission-lifecycle.integration.test.ts \
  tests/integration/automation/daily-budget-recovery.integration.test.ts \
  tests/integration/automation/worker-preview.integration.test.ts \
  tests/integration/automation/end-to-end.integration.test.ts \
  tests/integration/automation/worker-pipeline.integration.test.ts \
  tests/integration/automation/usage-read-model.integration.test.ts \
  tests/integration/automation/execution-policy.integration.test.ts \
  tests/integration/automation/typed-results.integration.test.ts \
  tests/integration/automation/job-leases.integration.test.ts \
  tests/integration/automation/approval-undo.integration.test.ts
```

本轮 54 项通过、1 项测试夹具失败：新增过期案例直接改不可变 Plan expiry，被数据库
正确拒绝。修正为在真实 prepare/reconcile 边界老化尚未生成 Plan 的 proposal；同命令
仅选择 `submission-lifecycle.integration.test.ts -t 'expired staged proposal'` 后 1 项
通过、4 项过滤跳过。保留不可变 Plan 约束，没有为测试关闭 trigger。

追加的升级和 BE-01/02 定向回归：

```sh
xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/budget-hold-migration.integration.test.ts \
  tests/integration/automation/api.integration.test.ts \
  tests/integration/automation/m1-backend.integration.test.ts \
  -t 'upgrade releases|placement satisfies|priority .* reports|node.created preview|preview creates no|authorized configuration'
```

9 项通过、28 项按名称过滤跳过。升级案例分别恢复旧日额度阻塞和保留已耗尽
maxCalls，验证输入摘要与历史 attempts 没有丢失。本轮共 64 个不同集成案例最终通过，
不累计修复前基线和重复运行。相关 unit 四文件 12 项、参考 worker transport 7 项通过。
server build（含 TypeScript 和迁移编译）、修改文件 ESLint、check:imports、
check:migrations against `1db76fe`、git diff --check 均通过。复用已发布字段与枚举，
未变更 wire schema、vendor 包或无关前端。测试临时服务全部回收。

## BE-01/02/03 联合审查（基线 70bf27f）

本轮按 backend-batches.json 核对三个批次的实现，覆盖 shared predicate / 配置与预览、
canonical facts / admission / receipt / Undo，以及 polling / lease / typed result / Plan 生命周期。
三个批次的主要路径均已实现；已有通过记录不能替代跨阶段反例。以下问题已直接修复。

| 优先级 | 问题与原行为 | 修复及验证 |
| --- | --- | --- |
| P1 | 必需目录移出 allowedAncestor 后，没有 folderRole 的摘要仍能提交并写入 annotation | 调度和 read/claim/submit/commit 共用现有 intake binding assessment；已租赁输出保留为 review，无 Plan/effect。真实 canonical move + HTTP 提交反例修复前产生了 annotation，修复后不再写入 |
| P1 | placement conflict 的预览显示 0 run / 无 pending tasks，admission 却启动摘要 worker，且绕过 runnable admission quota | 只有 runnable admission 初始化 worker jobs；冲突、覆盖和阻塞保留 review run。两条真实 enabled 规则的反例确认无 worker job、无预留 |
| P2 | 保留用户选定目录的 enrichment run 绕过每日 intake admission 限额 | 将该 run 纳入统一 admission accounting；溢出保持 waiting/pending，UTC rollover 后恢复原 pins，始终保留原目录 |
| P2 | imports=include 的 supplied preview 信任 userDefault，声明将移动并满足 classify.root；实际 source adapter 不认可该来源的 intake intent | 共享评估器对 import/automation/system 来源保留目录；include 的解释不再声称 import 被策略排除。三个纯逻辑反例及 authenticated preview 回归覆盖 |
| P2 | 未配置执行策略仍在 lifecycle 和 Owner rule read 中显示 active | health 复用 worker configuration inspection，按任务报告 executorUnavailable；可执行 intake 保持 degraded，仅有不可用 worker 的规则为 blocked。启动和 outbox health composition 传入当前 worker capability 与 credential verifier |
| P2 | 100 个 waiting run 可占满 polling 的候选扫描，挡住后面的可执行 run | 候选查询排除尚未完成 intake admission 的 waiting run。已有积压测试扩大到 202 个 held / unavailable / waiting run，验证后续工作仍可获取 |
| P2 | CLI 的 SIGINT/SIGTERM 没有立即传播至 adapter，只取消 HTTP；provider 可能继续运行 | cycle 接受并传递同一 signal，heartbeat 与 adapter 共用组合信号；取消后不开始新调用、不提交迟到输出，保留 unknownOutcome 恢复路径 |
| P2 | 固定 journal.tmp 已存在且权限为 0644 时，writeFile 的 mode 不收紧权限，rename 后 claim secret 随 journal 暴露 | 使用唯一临时路径和 wx/0600 独占创建，文件 sync 后原子替换，finally 回收临时文件；回归保留一个旧 0644 临时文件复现原问题 |

代码质量方面，修复复用原有评估、配额、绑定和配置检查，而没有在 HTTP/MCP 各复制一份规则。
health 的多层状态三元表达式改为显式分支；队列过滤在 SQL 候选阶段完成，避免反复扫描已知
不可执行记录。没有添加新框架、wire enum、schema 或迁移；不改写历史输出、已发生效果和历史配额。

测试质量方面，先复现三个 PostgreSQL 反例，再追加真实双规则冲突反例；上述四项修复前均失败。
来源 intent 的三个 unit 反例和 journal/取消的三个 transport 反例也先失败再通过。
集成测试使用真实 canonical mutation、鉴权 API、PostgreSQL 和 Plan，断言最终状态、pins、
无效果及跨日恢复；只有日界和积压夹具直接调整私有调度表。取消信号测试是注入传输的单元测试，
不冒充新的进程 SIGTERM E2E。journal 验证限定于进程恢复与权限，不声称系统断电恢复。

实际执行（Node 24.14.0，PostgreSQL 16.4-alpine，集成测试全部 xvfb）：

```sh
xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/worker-preview.integration.test.ts \
  tests/integration/automation/submission-lifecycle.integration.test.ts \
  tests/integration/automation/intake-policy.integration.test.ts

xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/worker-preview.integration.test.ts \
  tests/integration/automation/worker-pipeline.integration.test.ts \
  tests/integration/automation/api.integration.test.ts \
  -t 'conflicting placement previews|backlog cannot starve|real pairing|create binding|preview creates no|exact preview invalidates|competitors must honor'

npm --prefix packages/server run test:unit -- \
  tests/unit/automation/intake-admission-policy.test.ts \
  tests/unit/automation/preview-tasks.test.ts \
  tests/unit/automation/rule-evaluation.test.ts \
  tests/unit/automation/execution-policy.test.ts
node --test examples/worker-script/claim-and-summarize.test.mjs
```

第一组 15 项通过（当时 worker-preview 为 3 项）；第二组 9 项通过、47 项按名称过滤跳过。
共 24 个不同集成案例通过，不累加修复前反例或重复运行。相关 unit 15 项、transport 9 项通过。
server typecheck、server build、修改 TypeScript 文件 ESLint、check:imports 和 git diff --check 通过。
未运行全仓测试、浏览器 E2E、外部 provider 或 hosted Events；三个批次的结论限于本地后端实现。
