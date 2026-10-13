# BE-1 自审与修正

审查起点：`07ce22d`，工作树 `feat/automation-be1`。依据仍为审校包
`0.2.1-design` 与真实仓库实现。本记录纠正 AW-11 交付记录中“没有已知未完成实现项”
的过强结论；原记录保留为当时执行证据，不能据此推断不存在缺陷。

## 发现及处理

| 编号 | 级别 | 原问题与影响 | 修正位置 / 回归证据 |
| --- | --- | --- | --- |
| R1 | P1 | 竞争规则只求值谓词，未应用其自己的目录范围、导入策略和 hop 上限，产生假冲突或错误优先级结果。 | `application/rule-eligibility.ts` 统一准入检查；`preview-service.ts` 主规则与竞争规则共用。API 参数化测试中三个场景修复前失败；另保留触发类型场景。 |
| R2 | P1 | 竞争目录不可用时预演无冲突，目录恢复后旧预演仍能启用；摘要未固定竞争者的实时依赖状态。 | 一次准备竞争规则、解析状态和求值器，摘要固定目录身份、祖先与权限版本；恢复后旧预演 409，重新预演得到 conflict。 |
| R3 | P1 | 指定的 scope role 没有绑定时，currentState 使用空 folderId 抽样，范围扩大到整个显式集合。 | 抽样前检查 scope resolution；返回 `automation_binding_unavailable`，不扩大范围。修复前 API 返回 200。 |
| R4 | P2 | 所有角色失效一律阻塞 intake，包含没有被阶段使用的可选目录。 | 阶段依赖包含 scope/intake 及 mustBeWithinRole 传递约束；未使用的可选依赖仅告警，blockingStages=[]。验证、预演、启用、健康检查共用语义。 |
| R5 | P2 | 求值器归一化 host，但 normalizedDefinition 和 semanticDigest 使用原始值；等价规则摘要不同。 | 编译器导出隔离的 normalizedPredicate；规范化、摘要、新建/替换/预演/启用使用一致逻辑。覆盖大小写、尾点、IDNA、调用方修改、显示标签及真实语义变化。 |
| R6 | P2 / 契约漂移 | 对有限 DSL 自行添加整体 4096 字节限制，拒绝审校 Schema 合法表达式；旧测试只是固定了自行添加的行为。 | 移除总量限制，保留深度 16、节点 128 和字段 Schema 限制；HTTP 请求仍受 4 MiB 上界约束，capabilities 同步。CEL 的独立 4096 字符 Schema 未改变，CEL 在本机仍不可用。 |
| R7 | P2 | “不可变修订”只禁止 UPDATE，旧修订可直接 DELETE，破坏历史留存约束。 | 新增 `202610300300_automation_revision_delete_guard.ts`，保留已提交迁移；验证旧修订删除失败、未引用绑定集删除及账户级联清理成功。 |
| R8 | P2 | currentState 静默截断超过 128 层的祖先链，并以 truncated=false 返回成功，可能误判子树范围。 | 对超界、循环、不完整祖先链明确返回 409；通过真实 canonical 写入构造 129 层目录。修复前该场景返回 200。 |

R1–R8 的已复现问题均已修复。预演摘要还补齐 hopCount、changedFields、before 等事实字段，
避免检查使用的字段与摘要固定的字段不同；排除与事实内容无关的当前集合 ordinal、
合成 operationId 和时间字段，避免目录仅改名造成无关失效。

## 代码质量

* 去掉主规则与竞争规则两套准入逻辑，避免今后增加策略时只修其中一处。
* `parseContract` 使用生成的 `AutomationContracts[Name]` 返回类型，不再让调用方任意指定
  与 Schema 无关的泛型类型。
* 原始 evaluator 改为包内部实现；公开求值入口为 compilePredicate 成功结果的 evaluate。
  防止调用方绕过 Schema、算子及深度/节点校验。此前该可选子路径尚未公开发布，仓库内
  无直接 raw evaluator 消费者；公开入口说明和本地消费包同步更新。
* 归一化副本与 evaluator 闭包相互隔离，调用方修改输入或 normalizedPredicate 不改变求值结果。
* 持久化约束用追加迁移修正，没有改写已提交迁移或历史 JSON 修订。
* 文件规模没有超过既有预算；模块、基础设施、transport 的依赖边界检查通过。
* 仍有可维护性代价：部分文件一行执行多步，生成的 OpenAPI/Schema 与审校包镜像体积较大。
  本次仅抽取确有重复的准入逻辑，未开展整仓格式化或框架替换。

## 测试质量

新增测试先复现问题，再用于修正验证。最初核心 byte-cap 测试失败，API 首轮 8 个失败；
随后独立复现旧修订删除成功、深层祖先链被静默截断。没有把这些失败隐藏为“全部通过”。

新增 API 断言覆盖外部可观察的 outcome、状态码、错误码、归一化输出、摘要与生命周期，
不是仅比对内部 helper。目录深度场景使用真实 canonical 写入；目录恢复场景中的 SQL
软删/恢复仅用于隔离测试夹具，不宣称实现 canonical Restore 或 BE-2 Undo。

修订删除测试独立创建自己的配置；持久化和绑定测试的公共先决数据移至 beforeAll，
减少按测试名筛选时依赖前一个测试执行的情况。健康检查文件仍以共享夹具串联生命周期
场景；这不是随机顺序隔离测试。备份测试的池连接读取只证明 SQL 状态保留，已纠正
“模拟进程重启”的注释；没有真实启动/重启完整部署栈。

两次新测试编写中发生夹具错误：筛选 revision 测试遗漏先决配置，以及复制节点包含 generated
列。均先修正夹具再复现真实缺陷；这些夹具失败不计为产品缺陷证据。

## 实际最终验证

根目录为工作树；下面注明包目录的命令从对应 cwd 运行。未运行的检查不计为通过。

| 命令 | cwd | 结果 |
| --- | --- | --- |
| `npm run check:automation && npm run typecheck && npm run check:source-size && npm test -- tests/automation` | packages/node | 通过；5 文件 19 测试，271 源文件预算通过。 |
| `node packages/server/scripts/refresh-automation-package.mjs` | 根目录 | 通过；build/npm pack、本地依赖安装、两个锁文件与 runtime manifest 更新。 |
| `npm run pack:consumer-smoke` | packages/node | 通过；20 ESM/CJS 子路径、JSON Schema、9 文档示例及隔离消费者编译执行。 |
| `npm run test:integration:file -- tests/integration/automation` | packages/server | 通过；4 文件 34 测试，真实 PostgreSQL；含 fresh、旧基线到 BE-1 迁移头再追加修正迁移、约束、导出和 pg_dump/pg_restore。 |
| `npm run test:unit -- tests/unit/automation tests/unit/product/product-error-codes.test.ts tests/unit/product/product-route-manifest.test.ts` | packages/server | 通过；4 文件 17 测试。 |
| `npm run test:system:inner -- tests/unit/ci/import-dependency-graph.test.ts` | packages/server | 通过；23 测试。 |
| `npm run typecheck && npm run build` | packages/server | 通过；生产 TypeScript 与所有迁移构建。 |
| `npm exec eslint -- src/modules/automation src/infrastructure/automation src/transport/product/automation-rule-routes.ts migrations/202610300300_automation_revision_delete_guard.ts tests/integration/automation` | packages/server | 通过。 |
| `npm run openapi:ci` | packages/server | 通过；镜像、lint、catalog、examples、生成漂移、1.95.0 baseline 兼容性。 |
| `npm run check:imports` | packages/server | 通过。 |
| `npm run check:migrations -- 07ce22d` | packages/server | 通过；修正迁移排在原 BE-1 迁移头之后。 |
| `npm run runtime:manifest:check` | packages/server | 通过。 |
| `npm ci --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund --prefix runtime` | packages/server | 通过；174 生产包；实际导入 runtime 中本地包并检查 normalizedPredicate=arxiv.org 通过。 |
| `git diff --check` | 根目录 | 通过。 |

最终修正后运行的是适用检查，不是全仓 npm check、全仓覆盖率、mutation test 或线上验证。
浏览器目标 bundle 在 Node 中执行的测试只证明可打包与黄金结果一致，不能证明真实
Chrome/MV3 CSP 兼容；Ajv 运行时编译涉及动态代码生成，AW-49 消费前需要解决并验证。

## 范围漂移审查

* 已确认且修正的契约漂移：有限 DSL 的额外 4096 字节总量限制。
* 原有 additive API（GET pause、归档 DELETE、删除未被引用的绑定集）是 BE-1 配置闭环
  所需补充，已在 ADR/README 说明；不属于 UI 或业务执行。
* runtime 相关表、激活栅栏、既有 Outbox 上的健康复查属于 AW-09/AW-10/AW-11 的
  持久化及扩展契约。没有安装 facts 生产器、业务 admission、任务 claim、执行/提交、效果回执生产器。
* worker.ts 的变更仅挂接健康复查，不是 BE-3 polling worker。审校目录中的 MCP/未来
  批次文件是原样参考文档，不是已实现能力。
* 相对 e72b891，packages/web 与 packages/extension 没有改动；没有 UI E2E、模型调用、
  真实归档、Undo、Webhook/dot/Work 或 MCP Events 实现。没有扩张到 BE-2/3/4。

## 剩余风险与结论

未发现尚未修复的已复现 P1/P2 功能缺陷；这不等于没有缺陷。以下证据仍缺失：

1. 账户级 FOR UPDATE 将同一用户的配置查询/预演串行化；抽样祖先链、竞争规则解析存在
   多次查询。已有数量上界，没有做多用户或深树负载测试，不宣称性能目标通过。
2. 健康复查包装既有 durable projection sink，异常会影响该投影的重试完成；没有故障注入
   验证 commit-before-reply、数据库异常、启动部分失败和规则间故障隔离。
3. 真实浏览器/MV3 CSP、真实部署恢复与进程重启均未执行。前者为 AW-49 发行门槛，后两者
   需要部署验收；隔离 schema 恢复及 SQL 持久化证据不能替代它们。
4. 本次不是独立第三方审计，也未测量新增代码覆盖率或 mutation score。

BE-1 无界面闭环及本次受影响契约已通过真实回归，具备继续 BE-2 的代码与数据基础。
此前“全部验收、无已知问题”应改为有上述明确边界的结论；真实执行上线前应增加故障注入、
负载与部署恢复验证。执行器仍缺失是本批次约定状态，不能把 enabled 配置解释为自动化正在运行。

## 修正提交与工作树

按原有授权分别提交：AW-06 `bb571f0`、AW-05 `e08da1e`、AW-04 `0e28700`、
AW-09 `dd0106a`、AW-08 `13fcd0c`、AW-11 `327ae7d`、AW-10 `fae1edc`。
本记录与完整文件清单单独作为 AW-01 审查证据提交；没有 push。
完整 BE-1 文件清单见 [be1-files.txt](be1-files.txt)，本轮修改可比较 `07ce22d..HEAD`。
测试容器由 with-postgres 包装器回收，没有启动或保留本任务的 dev server。

## 独立复审后的六项修正（基于 60fe77f）

独立复审以 `~/ref/colp-automation-design` 为依据，确认它与仓库内设计快照一致。
原有相关测试通过，但七个临时复现用例暴露六项 P2 问题（祖先索引分别以查询和真实
canonical move / Outbox 验证）。本次按用户要求统一修复并提交；以下证据补充前文，
不把此前的“未发现已复现问题”视为当前代码正确性的保证。

| 问题 | 修正及回归 |
| --- | --- |
| 长 canonical 节点 ID 加前缀后超出 facts/response 的 128 字符限制 | current-state 以 server/collection/node 身份摘要生成稳定合成 ID。验证两个仅末字符不同的 128 字符 ID、响应和持久化结果 Schema、重复预演及激活。 |
| 初始 scopeChanged 绑定不索引真实祖先，无法靠祖先事件恢复 | 阻塞结果可携带已授权读取的实时快照，索引持续更新其物理祖先；快照仅用于监控，状态仍 blocked。用真实移动先移往另一个不允许的目录，再移回允许子树，验证无需手动健康查询即可消除阻塞。 |
| 更高优先级的不同目标胜出仍被计为当前规则命中 | 当前规则预演报告 conflict、胜出规则和目标，不声明 root satisfaction、不计入 plannedRunCount。验证较低优先级竞争者、同目标兼容、冲突激活拒绝。共享仲裁器仍按优先级选择赢家。 |
| node.created 无条件排除所有 automation 来源 | BE-1 intake 阶段拒绝来自同一 intake 阶段的 automation 重入，允许其他阶段的创建事件；继续检查 trigger、restore/import 策略和 hop 上限。此为 supplied-facts 预演，不宣称已实现 BE-2 因果生产或 admission。 |
| 改名/移动通知被普通重验自动清除 | 未确认的变更通知保留到确认或同角色、同类别的新通知替代；重复 Outbox 投递、health/dependencies 查询不清除通知。阻塞告警仍须通过实时重验才能恢复，确认不修复失效依赖。 |
| 未使用的可选依赖已删除仍返回 valid | 依赖接口直接使用本次绑定解析结果，不再从 blockingStages 推导资源有效性。验证删除、确认、恢复；可选依赖保持 warning 且 blockingStages=[]，规则验证继续有效。 |

移除了竞争者参数化测试中无法隔离 trigger 的场景（其同时删除 intake，即使触发过滤失效
也不会参与 placement）。替换用例直接检查 node.created 预演的正反结果，并覆盖不同
automation 阶段、同阶段重入和 hop 边界。API 预演公共 helper 现在校验完整 PreviewResult，
避免仅看 outcome 而漏掉响应 Schema 违规。

本次修正后的实际验证（cwd 为 `packages/server`）：

* `npm run test:integration:file -- tests/integration/automation/api.integration.test.ts tests/integration/automation/health.integration.test.ts tests/integration/automation/bindings.integration.test.ts`：真实 PostgreSQL，3 文件、36 测试全部通过。
* `npm run typecheck`：通过。
* `npm exec eslint -- src/modules/automation src/infrastructure/automation tests/integration/automation`：通过。
* `npm run check:imports` 与 `npm run build`：通过。
* 根目录 `git diff --check`：通过。

未修改公共 Schema、共享包、迁移、Web 或 Extension；因此未重跑无关测试及发行检查。
原有浏览器、负载、故障注入和完整部署恢复的证据限制仍然成立。测试容器由包装器回收。
