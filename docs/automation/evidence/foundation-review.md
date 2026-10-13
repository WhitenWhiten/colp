# BE-1 + BE-2 foundation review

审查基线：`544d732`。按 `13-backend-first.md` 的两个批次一起核对，而不是分别重复验收。
覆盖 shared finite core、binding/preview/lifecycle/health、canonical facts、Outbox/admission、
pinned runs、device bundle/receipt、placement/Undo、恢复与 API 契约；不扩展到 BE-3/M2。

## Confirmed findings

| 严重度 | 问题与复现 | 修复 |
| --- | --- | --- |
| 高 | 已 unpaused 时再次提交 resume 会重建 activation fence，跳过队列中尚未消费的已提交事件。 | 同状态 Pause 请求在校验 If-Match 后返回当前状态，不推进序号、不重建准入区间。真实恢复仍取新高水位。 |
| 高 | 已 enabled 时提交新 preview 与同状态 lifecycle 请求，同样可能丢失待消费的 source。 | 保留当前 activation 区间；仍验证精确 preview、当前权限并应用明确的 pendingRuns 策略。 |
| 中 | BE-1 允许 editor 配置/预览，BE-2 只执行 collection Owner 规则；开启 runtime 后 editor 规则会误报 active。 | collection snapshot 区分当前 Owner；运行时 enable 拒绝缺少 Owner 权限，health 报 blocked，validate/preview 提供说明，device bundle 同样检查 Owner。保留既有 editor 配置和预览能力。 |
| 中 | Run API 丢失私有记录中的执行解释，也无法区分显式 hold 与普通 waiting。 | 通过契约调整增加可选 held/explanation；server 返回有界业务解释，不暴露私有 facts 或 explanation_json。列表、详情和取消响应均覆盖。 |
| 中 | 取消后的 run 收到真实迟到 Sync placement 证据，会新增 effect 而不变更 Run revision。 | 只有新插入 effect 时推进 Run revision；保持 cancelled，不重新执行；同一效果的新 receipt identity 也不会重复增加效果或推进 revision。 |
| 低 | BE-1 留下的 preview 文案在安装 BE-2 后仍声称 runtime unavailable。 | 明确为 preview only/no effect，运行能力仍由 capabilities/health 判定。 |

Run 的新增字段使用 `contract-adjustments.json` 同源生成 shared schema/types 和 Product
OpenAPI；本地打包依赖、lockfiles 与 runtime manifest 同步，不修改已冻结 baseline。
没有新数据库迁移，也没有修改旧事件证据或改变 placement 授权模型。

## Review of cross-batch invariants

| 约束 | 审查范围与验证落点 |
| --- | --- |
| 一个有限语言与判定模型 | schema、compiler、normalizer、digest、role graph；preview/admission/receipt 使用相同 scope、binding 和 priority arbitration。shared core 正反例与 server semantic suites。 |
| 配置不能隐式启动新语义 | 精确未过期 preview、不可变 rule/binding 修订、语义编辑暂停、pending work 固定旧 pin、Owner 与 editor 权限边界。api/health/foundation/server-intake。 |
| capture、消费、效果的事务边界 | 私有 event-time before/after、逐 ordinal 检查、每 source receipt、effect/cursor 原子提交、Outbox generation/expiry commit fence。fact-capture/source-position/admission/M1 gate。 |
| pause、resume、retry 不丢失或重复工作 | 真正恢复跳过暂停区间；同状态请求不重置区间；显式 hold 不被全局恢复解除；旧修订 continuePinned 不重绑。foundation/admission/server-intake。 |
| device claims 不是授权 | bearer/session/Origin、当前 generation、canonical Sync create/move、authenticated bundle pins、scope/priority、input/result digest；仅 classify.root。device-receipts/receipt-semantics/late-receipt-review。 |
| 历史和 Undo 不放大效果 | 真实 canonical operation、稳定 effect identity、原目录必须已证明、当前 Owner/resource/content fences、单书签补偿 move。placement-undo/M1 gate，迟到历史更新正确推进 ETag。 |
| 恢复与包契约不漂移 | 真实 pg_dump/pg_restore 与 deploy pause SQL、configuration epoch、closed DTO、生成检查与旧 OpenAPI baseline 兼容、本地实际 package 构建。persistence/M1 gate 与契约检查。 |

测试质量补强：新增 foundation suite 每个测试独立建库；迟到 receipt 测试经真实 Sync
操作移动绑定目录、创建书签、产生 blocked admission、取消、修复目录、提交 placement，
不直接写伪造的 effect/run。source-position 新增独立连接在 consumer 写入后替换 lease，
证明 consumer 写入与 source cursor 同时回滚，而替换后的 lease 保留。
配置 API、run API 与 bundle suite 也改为每个测试独立数据库/应用；原来仅截断配置表或
共享 bundle counter，会遗留 canonical 节点或依赖执行顺序。对这三文件额外执行固定种子的乱序回归。

## Executed evidence

- 首轮 foundation 四项测试：两项准入水位缺陷和 API 解释缺失按预期失败；editor 案例首先因
  fixture 缺少必填 reason 失败，补齐后单独复跑，真正复现 active/blocked 错误。不将 fixture 错误当作产品证据。
- 修复后 foundation 与 source-position 两文件：7 项通过。
- 迟到 receipt 初版 fixture 使用 Owner canonical move，正确触发已有 Sync session 撤销；
  改为真实同设备 Sync move 后，复现 revision 仍为 2 的缺陷。修复覆盖取消状态与重复回执。
- shared core：6 文件、22 项通过；server automation unit：6 文件、11 项通过。
- `xvfb-run -a npm --prefix packages/server run test:integration:file -- tests/integration/automation`：
  16 文件、84 项通过，包含上述迟到 receipt 修复与重复证据不变更 revision 的检查。
- 隔离 fixture 后，api、runs、bundles 三文件额外以 `--sequence.shuffle --sequence.seed=20261012`
  在 xvfb/PostgreSQL 下运行：3 文件、39 项通过。这个计数是重排回归，不与 84 项相加。
- typecheck、build、修改 src 和 test 文件 ESLint、check:imports、openapi:ci、
  runtime:manifest:check、shared check:automation/source-size/traceability/protocol 与 git diff --check 通过。
  OpenAPI 对冻结的 1.95.0 baseline 无 breaking change。
  测试创建的 PostgreSQL、Xvfb、Fastify/worker 资源均由 wrapper/fixture 生命周期回收。

## Remaining scope

这些结果是本仓库 M1 backend 基础的证据，不是 native browser、MV3/store、线上负载或部署验收。
AW-44 的完整 retention/load 工作仍属后续批次。当前限制继续明确：每 Owner 500 条规则、
每 slice 最多 10 个 source/placement、历史快照最多 2,000 live members；离线设备暂停曝光仍受
7 天 bundle expiry 约束，建议 5 分钟刷新。M2 policy/target/job/Events/model 路径仍未启用。
