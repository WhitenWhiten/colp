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
