# Session / Snapshot / Ack 交接：第三轮切片

建模基线为 `ef94b519`，修复前的模型、反例和实现见证已保存在提交 `aab68b3f`。
当前已修复 G2，并把原反例改为模型证明和实现回归。
`npm run model:sync:implementation` 同时运行 Lean 和真实客户端模块的对照。
新增三个小模型分别对应不同事务边界，尚未证明它们组合成全局状态机后的 refinement。

## G2（已修复）：bootstrap 完成的冻结结果取决于 Ack 中断时机

已使用真实 `createDurableSyncEngine` 复现：

1. Chrome 替身已执行一次 create，模拟在 API 返回与证据保存之间崩溃。
2. 重开 IDB，通过实际 applier 恢复为未知 native 调用，保留原始 intent/event。
3. 准备完整 Snapshot staging，包含该条目；用实际 projector、cutover 和 bootstrap Ack 恢复。
4. 比较不中断，以及服务端已返回 Ack 响应、客户端还没保存回执时中断并重启的两条路径。

以下为修复前的复现结果：

| 最终事实 | 直接完成 | Ack 响应后中断再恢复 |
|---|---|---|
| Snapshot 已提交、staging 已清理 | 是 | 是 |
| bootstrap Ack 已完成 | 是 | 是 |
| durable cursor | `active-cut` | `active-cut` |
| 原 native 调用仍未知 | 是 | 是 |
| Chrome create 次数 | 1 | 1 |
| `recoveryFrozen` | **false** | **true** |
| `authorityRefreshRequired` | false | true |
| Ack HTTP 请求数 | 1 | 2，原始请求字节相同 |

修复前，[recoverSnapshotPages](../../packages/extension/src/durable-sync-engine-recovery.ts)
完成激活后直接解除冻结，而 [wakeOnce 的 pending-bootstrap 分支](../../packages/extension/src/durable-sync-engine.ts)
会检查实际待处理工作并保持冻结，同时遗漏清除已经完成的 authority refresh 标志。

这确认了**相同未决事实、相同已确认远端边界，却因一次可恢复中断得到不同控制状态**。
与仓库已有的“bootstrap Ack 不证明 pending Pull 或未知 native 已结算”规则不一致。
这份证据没有证明数据丢失。当前三个 bootstrap 完成出口统一使用
[readCompletedBootstrapState](../../packages/extension/src/bootstrap-ack-unfreeze.ts)：
激活成功后清除 authority refresh；只要 native 或 Pull 仍未决，就保留本地工作冻结。
没有待处理工作时，两条路径都会解除冻结。

保持冻结又暴露了原确认恢复路径的循环依赖：已确认的旧 native 事件属于完成的 Snapshot 页，
冻结会阻止其执行，而其未完成又使冻结不能解除。修复还加入受限的恢复入口：
仅当事件属于当前 Snapshot、scope active、无待刷新 authority、generation/intent/event/延期绑定均匹配，
且原调用已开始、native 结果有可信身份依据时，允许它在冻结中完成。
`readPullApplyWorkset` 从 live event 索引找到这些页面和 intent，不扫描整个完成历史。
未知调用、新调用、其他 Snapshot、错误 generation 或缺少身份依据均不能经过该入口。

[Recovery.lean](ColpSync/Recovery.lean) 保留两条控制路径，统一完成政策，Lean 检查：

- cutover、Ack receipt 和 Session 激活都不把未知 native 变成已知。
- 没有完成的 bootstrap Ack 就不能激活恢复游标。
- 任意长度模型轨迹中，未知 native 存在时不会解除冻结。
- fresh/resumed 对任意同一输入状态的完成转换相同；最终冻结和 refresh 标志一致。
- 冻结中的 native 恢复必须有可信身份依据且 generation 匹配。

[recovery-witness.test.ts](../../packages/extension/model-tests/recovery-witness.test.ts)
从 Lean 导出的期望检查正常/中断 × native 未决/已结算四条真实引擎路径，共 30 个状态检查点。
检查点覆盖 cutover 后发送 Ack 之前、响应返回但回执未落盘、重启、回执已落盘、激活前后及最终状态。
同时检查未知调用未重建、原 Ack 请求精确重试；之后仅进行用户身份确认并唤醒引擎，
由真实引擎完成旧事件、发布/Ack 当前页并解除冻结，无需重新创建 native 或重复刷新 authority。
新增恢复入口还按 Lean 导出的 1,024 组布尔前提与生产 guard 对照。

## Session 迁移：CAS 与本地工作是不同维度

[Authority.lean](ColpSync/Authority.lean) 分开表示引擎 revision、Session、durable cursor、
冻结/refresh 标志、待处理 Ack、未完成 Pull、未知 native 与已确认游标证据。

`readEngineSessionAuthority` 的迁移实际包括：先检查、CAS 冻结、事务内重查并 rebase、CAS 完成。
**新增 Pull 页面不一定递增引擎 revision**，因此只校验 revision 无法证明没有新增本地工作。
`rebaseActiveSessionAuthority(requireConfirmedCursor=...)` 的事务内重查是必要的安全条件。

六条实际 repository 轨迹共 23 步比较状态和错误码，覆盖：

- 连续两次 Session 更新，以及 rebase 与完成之间重开 IDB。
- 冻结后出现新 Pull 工作，但引擎 revision 没有改变，rebase 必须拒绝。
- revision 被别的更新推进后，旧 rebase/finalize 都不得提交。
- pending Ack 保留原始身份和字节；captured cursor 不匹配时拒绝。
- 没有冻结/refresh authority 时拒绝直接 rebase。

这些轨迹调用真实事务原语，展开的是正常 Session 迁移的提交边界；
它们没有证明任意调用者都按该控制流执行，也没有覆盖所有回滚恢复路径。
`pending_work_blocks_rebase`、`stale_rebase_is_atomic_noop` 和 `stale_finish_is_atomic_noop`
是在模型任意状态上的局部证明。

另有四组布尔输入检查 bootstrap unfreeze guard，40 组输入检查 `classifySessionAuthority`：
合法 recovery Session 的 lease 仍为 `active`，恢复需求通过 `snapshotRequired` 及上下文表达，
不能把持久化 replica lifecycle 的 `recovery_required` 当成合法 Session lease 状态。

## bootstrap Ack 拒绝事务与迟到回执

[AckFence.lean](ColpSync/AckFence.lean) 的初始状态来自同一个真实引擎：服务端已接收 Ack，
客户端在保存回执前中断，原 bootstrap intent 仍 pending。
引擎 revision 以该检查点为相对零点，不把其数值当作 Session、lease 或浏览器 generation。

三条实际事务轨迹共 12 步验证：

1. revision 竞争使拒绝事务 CAS 失败时，事务内先执行的 intent 删除必须回滚。
   原 intent 仍可由其合法回执结算，然后激活。
2. 合法拒绝事务删除 intent 并原子冻结/要求刷新后，迟到的旧回执不能重新创建它，
   缺少已完成 bootstrap Ack 的激活必须失败。
3. 已完成的 bootstrap receipt 不能再被 pending-intent 拒绝事务删除。

模型证明 stale rejection 是完整 no-op、拒绝不改 cursor、absent intent 不会被迟到回执复活，
激活必须有完成的 receipt。
[ack-fence.test.ts](../../packages/extension/model-tests/ack-fence.test.ts)
比较实际错误码与持久化投影，并在每个失败后额外检查原 intent 和 cursor 均未变化。

## 验证范围

第三轮建模时共 5 个专用测试文件、21 个测试通过；相关现有交接、bootstrap 过期、Snapshot 保留测试
另有 3 个文件、23 个测试通过。修复后扩展为 24 个专用测试，最终验证记录见 [README](README.md)。
Lean 构建和公理审计无 `sorryAx`；专用 typecheck、改动文件 ESLint、`git diff --check` 也在修复后复核。

这里使用真实引擎、IDB repository、applier、Snapshot projector、cutover、确认和激活模块。
底层 IDB 是 fake-indexeddb，Chrome API、Session 提供者及 HTTP 服务端是替身；
Snapshot 从完整 staging 开始，没有覆盖 Snapshot HTTP 下载/签名校验。
没有启动真实服务端、PostgreSQL 或浏览器，服务端接受 Ack 仍是环境前提。

跨账号/副本 generation、服务端 lease/security epoch、在途消息与所有 await 的并发交错，
仍需要放入共同状态空间。当前结果是有实际实现约束的客户端纵向切片，不能视作端到端 1:1 验证。
