# COLP 同步状态机：Lean 4 模型

这是基于仓库实现手工建立并逐步扩展的协议抽象，分析基线为 `ef94b519`。
目标是检查局部失败隔离、浏览器调用不确定性、Ack、Push 顺序队列与健康上报之间的语义边界。
它包含可执行的状态探索、Lean 内核检查的定理、反例，以及一条实际 TypeScript 模块上的对应复现。
**它不是 TypeScript 实现正确性的证明，也不是完整同步系统的形式化。**
第二轮已增加游标判断的实现对照和多页延期账本。
第三轮已增加 Session 迁移、Snapshot 恢复与 bootstrap Ack 失效切片，
并复现了恢复结果对 Ack 中断时机敏感的问题，见 [交接模型与反例](HANDOFF.md)。
关于距离“1:1”还有哪些工作，见 [实现对应与 refinement 路线](REFINEMENT.md)。

## 运行

需要 [Lean 官方安装工具 elan](https://lean-lang.org/install/manual/)。
`lean-toolchain` 固定 Lean `4.35.0`，不依赖 Mathlib 或其他外部 Lean 包。
在仓库根目录运行：

```sh
npm run model:sync
```

同时运行模型与实际 TypeScript/IDB 的逐步骤对照：

```sh
npm run model:sync:implementation
```

该入口从刚编译的 Lean 可执行程序生成期望值，不使用手工复制的 golden JSON。
需要 extension 的开发依赖；专用 `model-tests` 不在默认的 `--dir tests` 测试范围内，
普通 extension 单元测试无需安装 Lean。

该命令构建定理和可执行程序，探索状态并输出反例，最后打印关键定理使用的公理。
没有 `sorry`、自定义 `axiom` 或 `native_decide`；具体有限轨迹用 `decide` 检查，
一般性定理用归纳、化简和 `omega` 证明。构建产物仅在忽略的 `.lake/` 下。

对应的实际模块复现：

```sh
cd packages/extension
npx vitest run tests/sync-formal-model-witnesses.test.ts
```

无需启动服务、数据库或浏览器。Lean 工具链是开发工具，不进入产品依赖。

## 模型与实现的对应

| 模型 | 实现依据 | 保留的状态与边界 |
|---|---|---|
| [Pull.lean](ColpSync/Pull.lean) | [应用循环](../../packages/extension/src/pull-apply-runtime.ts)、[条目隔离](../../packages/extension/src/pull-item-set-aside.ts)、[页面完成](../../packages/extension/src/pull-page-completion.ts)、[完成事务](../../packages/extension/src/sync-state/pull-repository.ts) | 两个已证明互不依赖的条目；调用开始、结果未知、成功、隔离、有效延期；发布游标、持久化 Ack 意图、服务端接收、客户端收到回执 |
| [Push.lean](ColpSync/Push.lean) | [Push worker](../../packages/extension/src/outbound-push-worker.ts)、[队列认领](../../packages/extension/src/sync-state/queue-repository.ts)、[队列依赖](../../packages/extension/src/sync-state/queue-hold.ts) | 未发送、已发送但未决、已结算、未发送即隔离；同一逻辑身份重试；有服务端序号证据后填平空位；独立尾项 |
| [Health.lean](ColpSync/Health.lean) | [唤醒](../../packages/extension/src/durable-sync-engine.ts)、[熔断包装](../../packages/extension/src/sync-circuit-breaker-engine.ts)、[上报投影](../../packages/extension/src/sw/replica-health-report.ts)、[服务端报告事务](../../packages/server/src/infrastructure/sync/replica-health-postgres.ts) | 同步 Session 与报告权限分离；问题数量、持久化停机、报告修订号；乱序报告；前置异常与尚未发送的上传 |
| [Command.lean](ColpSync/Command.lean) | [命令去重与执行](../../packages/extension/src/sw/replica-health-report.ts)、[串行入口](../../packages/extension/src/sw/replica-health.ts)、[服务端结算](../../packages/server/src/infrastructure/sync/replica-health-postgres.ts) | 先持久化 seen，再执行副作用，再存结果；任一阶段崩溃；重投递、结果上报 |
| [Cursor.lean](ColpSync/Cursor.lean) | [pull-ack-boundary.ts](../../packages/extension/src/pull-ack-boundary.ts) | spc2 格式/base36/元组顺序、整页 Ack 分类、游标写入分支；保留实现中的直接放行条件 |
| [Ledger.lean](ColpSync/Ledger.lean) | [延期完成](../../packages/extension/src/pull-page-completion.ts)、[确认](../../packages/extension/src/native-wait.ts)、[剪枝](../../packages/extension/src/sync-state/pull-workset.ts) | 任意多页、每页一个相关条目、generation/身份依据、延期确认、回执、重启、保留未解决证据 |
| [Authority.lean](ColpSync/Authority.lean) | [Session 迁移](../../packages/extension/src/sync-session-handoff.ts)、[原子 rebase](../../packages/extension/src/sync-state/recovery-repository.ts) | 引擎 revision 与本地工作分离；freeze/rebase/finalize 的 CAS；已确认游标、待处理 Ack 和页面的事务内重查 |
| [Recovery.lean](ColpSync/Recovery.lean) | [Snapshot 恢复](../../packages/extension/src/durable-sync-engine-recovery.ts)、[重启后的 pending Ack 分支](../../packages/extension/src/durable-sync-engine.ts) | 快照 cutover、响应丢失、原请求重试、bootstrap receipt、Session 激活、保留未知 native、两条路径的不同冻结结果 |
| [AckFence.lean](ColpSync/AckFence.lean) | [bootstrap 拒绝事务](../../packages/extension/src/sync-state/engine-repository.ts)、[恢复激活](../../packages/extension/src/sync-state/recovery-repository.ts) | revision 竞争、删除/冻结的原子回滚、旧 receipt、已完成 receipt、禁止无 bootstrap receipt 激活 |

`held` 表示条目和 durable issue 已在同一事务记录；`deferred` 表示延期关系已通过
[validatedPullDeferral](../../packages/extension/src/pull-deferral.ts) 的 intent/decision/generation 检查。
这两个抽象状态都不代表浏览器操作成功。普通 `unknown` 没有足够的延期授权，不能直接发布页面。
`succeed` 表示已获得可信结果或确认的身份依据，不是凭标题、URL、位置猜测成功。

这些是模型的明确前提：本版没有证明 IDB 事务、延期验证器、浏览器身份验证或依赖闭包本身正确。
Pull 模型只接受已经验证的服务端整页边界，不包含任意事件游标和签名伪造。

## 已检查的性质

| 性质 | 证据 | 范围 |
|---|---|---|
| 服务端 Ack 之前，页面中的每个条目都必须成功、持久化隔离或有有效延期 | `Pull.run_safe`、`ack_requires_accounted_page` | 对模型中任意有限长度动作序列的归纳证明 |
| 已开始/未知结果的调用不能当作“尚未执行”而直接隔离或重新创建 | `started_call_cannot_be_isolated` 等 | 条目转换规则；不证明浏览器 API 的实际调用次数 |
| 一个局部隔离不阻止独立条目应用及整页 Ack | `isolated_item_does_not_stop_peer` | 构造性进展轨迹；不宣称任意调度下必然进展 |
| 命令在保留去重证据期间最多执行一次 | `command_executes_at_most_once` | 任意长度轨迹，单一 command ID，串行执行 |
| Push 重试保留逻辑身份，未知队首不能被直接隔离或绕过 | `attempt_preserves_identity`、`unknown_head_blocks_tail` 等 | 每一步及任意次数重试；序号重排只允许未发送的洞 |
| 服务端健康报告修订号不倒退，无效权限不能写报告 | `revision_never_rewinds`、`invalid_authority_cannot_report` | 任意自然数修订号；完整权限检查抽象成布尔值 |
| 报告不会续期 Session，停止的副本仍可独立报告 | `health_does_not_renew_session`、`stopped_replica_can_report` | 假定新鲜凭据和有效安装证明 |

[Explore.lean](ColpSync/Explore.lean) 对 Pull 与 Command 做广度优先搜索并保留最短见证。
目前分别有 **81、11 个可达状态**，搜索到空 frontier；这只表示这两个有限抽象的图已遍历，
不是对生产系统状态空间的穷举。探索器自身未形式化验证；一般性安全结论依靠独立的归纳定理。
探索器耗尽 fuel 会报错，绝不把截断当作验证成功。
另有一个故意删除发布检查的 mutation：初始状态执行 `publish` 就必须被检测为违规，
用来确认检查不是无条件通过。

## 反例与实际问题

### G1：前置失败没有进入健康状态（已复现的实现缺口）

轨迹：

```text
本地已有 pending 上传
→ guard 读到旧引擎状态
→ wakeOnce 开头的 getScope 失败（尚未进入 try）
→ 错误向外传播，没有记录 lastError、熔断失败次数或安排下一次重试
→ 后续健康读取成功
→ issues=0、没有持久化 stop → 报告 syncing
→ 相同条件可再次发生
```

`Health.repeated_preflight_failures` 和 `pending_upload_never_sent_in_failed_cycles`
证明该轨迹族可持续任意多轮：报告都送达，但上传仍待处理。
[实现见证测试](../../packages/extension/tests/sync-formal-model-witnesses.test.ts)
使用真实 durable engine、真实 IDB repository 和真实健康报告函数，只在每次引擎的首个
`getScope` 读取注入一次失败；随后让真实健康读取成功，并用合法形状的 HTTP receipt 模拟服务器。
连续十次唤醒全部失败，上传保持 pending/attempt=0，十份报告仍为 `syncing`、零问题。
测试同时检查没有新增重试计划、错误记录或熔断历史。

这是现有[韧性审查记录](../../docs/sync/resilience-review-2026-10-17.md)末尾已提及的限制，
这里补上形式化轨迹族与永久实现见证，并不将它声称为首次发现。
服务端自己的 [activity 推断](../../packages/server/src/modules/sync/product-sync-center.ts)
只在存在未接收的远端流事件时判断 stalled/silent；它无法从尚未上传的纯本地变化推断这个缺口。
本测试没有运行真实服务端或 Chrome 调度器，不声称一次异常就会永久停止同步；
后续正常唤醒仍可能恢复，已有外部 alarm 的效果也未纳入此见证。

修复方向：让唤醒的最外层记录“尝试/完成/失败及代码”，包括前置读取失败；健康投影读取这份
事实。若 IDB 本身暂不可用，要有独立、有限且可清除的故障记录通道。报告心跳成功不能清除
引擎失败；只有真实同步进展或明确恢复才能清除。需保留 authority fence 与主动暂停语义。
本次仅建模和复现，未修改生产行为；修复后应将见证测试改为断言故障可见，并同步更新模型。

### B1：Ack 不表示所有条目已写入浏览器（设计边界）

```text
条目 A: start → loseResult → enrollDeferral
条目 B: start → succeed
整页发布 → Ack 意图落盘 → 服务端接收 Ack
A 仍为 deferred
```

`ack_can_precede_native_confirmation` 是合法轨迹，不是 Ack 安全漏洞。
活性要求必须另外描述“延期账本最终得到确认/决策/修复”，不能从 Ack 推出浏览器收敛。
实际模块的对应证据是 `native-wait-page-progress.test.ts`。

### B2：网络和重试公平仍不保证 Push 尾项进展（协议边界）

已发送队首始终拿不到可结算回执时，后续独立上传不能绕过其序号。
`retry_forever_can_block_independent_tail n` 对任意 `n` 成立，重试身份保持不变。
需要额外的环境前提：该逻辑操作最终可结算，或者进入显式修复路径。
实际系统在达到阈值后报告 stalled upload；这个报告阈值不属于 Push 抽象，
其实现对应检查为 `push-stalled-head.test.ts`。这个边界不能以“超过次数就当作未发送”修复。

### B3：命令最多执行一次，不保证至少执行一次（崩溃窗口）

```text
收到命令 → seen 落盘 → 崩溃 → 重投递 → command_interrupted → 服务端结算 failed
```

`settled_command_may_never_execute`：副作用可以一次也没有执行。
另一条轨迹 `interrupted_does_not_prove_no_effect`：副作用已经执行，但保存结果之前崩溃，
仍报告 interrupted。不能依据 `failed` 推断未执行，也不能无条件自动重放。
当前实现对此做了安全取舍；Rebuild 另有 archive completion evidence，尚未纳入此单命令模型。
实际对应检查为 `replica-health-report.test.ts` 和 `replica-health-outbox.test.ts`。

## 时序与活性前提

安全性质约束“不能发生什么”；自动恢复还需要环境承诺：

- 浏览器最终会再次调度引擎；休眠、终止 worker 和暂停不保证实时唤醒。
- 网络、账号权限和安装证明最终可用；报告通道和同步通道是不同能力。
- 已发送操作最终能取得可信结算；未知 native 调用最终获得确认或用户决策。
- 去重日志与延期证据在协议要求的有效期内不会丢失。

本版将等待、退避和网络无响应视为 stuttering，没有证明五分钟或十五分钟内最终送达。
报告修订号抽象为递增自然数；实现的 `max(now, previous+1)`、时钟回退和 JS safe-integer 上限未建模。
当前各个模型尚未证明其并发组合满足 refinement。

跨多页的延期偿还/剪枝和单副本 Session/Snapshot/Ack 交接现已有受限模型及实现对照。
后续最有价值的扩展是：跨账号/副本 generation 与完整 lease/credential 身份、
Snapshot 覆盖旧 native wait 的竞争、双副本与依赖闭包、>200 issue 的 admission stop，
以及报告/命令 final outbox 在换账号与副本替换时的保留期限。
每次增加转换，都应补上实际模块的轨迹检查，先排除抽象产生的假反例，再讨论生产修改。

## 本次验证记录

`npm run model:sync` 通过：定理编译、两个有限状态图探索、反例与 mutation 检查、公理审计均完成。
初版审计打印的依赖为 Lean 的 `propext`、`Quot.sound`，没有 `sorryAx`。
相关 extension 检查共 **7 个文件、23 个测试通过**：
`sync-formal-model-witnesses`、`durable-sync-engine-pull-set-aside`、`native-wait-page-progress`、
`replica-health-report`、`replica-health-outbox`、`push-stalled-head`、`pull-mutation-failure-boundary`。
新测试文件 ESLint、extension TypeScript typecheck 和 `git diff --check` 通过。
没有运行浏览器 E2E、真实数据库或真实服务端测试。

## 第二轮验证记录

`npm run model:sync:implementation` 已实际运行通过：

- `lake build` 编译全部模型、检查器及 JSON 导出器，公理审计无 `sorryAx`。
  当前审计包含 Lean 的 `propext`、`Quot.sound`、`Classical.choice`，无自定义公理。
- 游标排序 **400** 组、Ack 分类 **3,528** 组、游标写入 **8,400** 组，
  共 **12,328** 个输入与生产 TypeScript 函数输出一致。
- 四条真实模块轨迹，共 **39** 个宏步骤，每一步比较发布游标、已完成回执和保留页面/延期状态；
  另检查四个初始状态和 native create 没有因确认而重复执行。
- 新增专用测试 **2 个文件、8 个测试通过**，专用 TypeScript typecheck、ESLint 通过。
- `Ledger` 证明任意长度动作序列的 Ack 安全、旧 generation/缺少身份依据不能结算、
  延期确认保持游标和 Ack，以及任意多次后续页推进和剪枝仍保留原始未决条目。
- 检查只保留最新页面的错误剪枝规则，确实会删除未决证据；生产剪枝没有做这个改动。

游标源码的 connected-chain 分支不自行检查数字单调性：当 `previousCursor = publishedCursor`
时可直接放行。模型保留该行为，并以 TypeScript 复核。**这不是已确认的生产回退漏洞**；
它表明完整单调性证明还需要连接服务端游标签发、页面验证和 authority 并发约束。
当前对 detached-chain 分支已证明允许写入时 commit ordinal 不减。

这些是给定输入与轨迹的差分检查，不是 TypeScript/Lean 对所有输入的等价性证明。
实际重放使用真实 repository、applier、确认及剪枝模块，Chrome API 和服务端回执为替身。
没有运行浏览器 E2E、真实服务端或 PostgreSQL，也没有修改生产同步行为。

## 第三轮验证记录

`npm run model:sync:implementation` 再次实际通过，新增模型、导出器和关键公理审计均完成，
无 `sorry`、自定义 `axiom` 或 `native_decide`。
专用实现对照现在为 **5 个测试文件、21 个测试**，包括之前的 12,328 个游标输入与四条延期轨迹。
新增六条 Session 事务轨迹（23 步）、三条 bootstrap Ack 失效轨迹（12 步），
以及两条完整引擎恢复分支的 15 个持久化状态检查点（含两个初始状态）。
四组 unfreeze 布尔输入及 40 组 Session 分类输入也与生产函数一致。

相关现有 `sync-session-handoff`、`ds-10-bootstrap-ack-expiry`、`snapshot-issue-preservation`
共 **3 个文件、23 个测试**通过。专用 typecheck、改动文件 ESLint、`git diff --check` 通过。
没有运行真实服务端、数据库或浏览器；本轮的 Scope/Session 和 HTTP 回执为测试替身，
Snapshot 使用已完成的真实 staging，投影、cutover、Ack、激活和原 native wait 均经实际模块处理。

新问题 G2：同样的快照、Ack、active cursor 和未知 native 调用，直接恢复结束为
`recoveryFrozen=false`，而 Ack 响应返回后、回执落盘前中断再恢复结束为 `true`。
这种路径依赖及其边界详见 [HANDOFF.md](HANDOFF.md)。
