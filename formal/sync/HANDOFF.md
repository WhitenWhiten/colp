# Session / Snapshot / Ack 交接：第三轮切片

本轮继续以 `ef94b519` 的生产实现为依据，不修改生产行为。
`npm run model:sync:implementation` 同时运行 Lean 和真实客户端模块的对照。
新增三个小模型分别对应不同事务边界，尚未证明它们组合成全局状态机后的 refinement。

## G2：bootstrap 完成的冻结结果取决于 Ack 中断时机

已使用真实 `createDurableSyncEngine` 复现：

1. Chrome 替身已执行一次 create，模拟在 API 返回与证据保存之间崩溃。
2. 重开 IDB，通过实际 applier 恢复为未知 native 调用，保留原始 intent/event。
3. 准备完整 Snapshot staging，包含该条目；用实际 projector、cutover 和 bootstrap Ack 恢复。
4. 比较不中断，以及服务端已返回 Ack 响应、客户端还没保存回执时中断并重启的两条路径。

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

[recoverSnapshotPages](../../packages/extension/src/durable-sync-engine-recovery.ts)
完成激活后直接写 `recoveryFrozen=false`。
[wakeOnce 的 pending-bootstrap 分支](../../packages/extension/src/durable-sync-engine.ts)
则使用 [mayUnfreezeForCompletedBootstrapAck](../../packages/extension/src/bootstrap-ack-unfreeze.ts)
检查实际待处理工作，因未知 native 而保持冻结。后者还保留了激活前设置的 authority refresh 标志。

这确认了**相同未决事实、相同已确认远端边界，却因一次可恢复中断得到不同控制状态**。
与仓库已有的“bootstrap Ack 不证明 pending Pull 或未知 native 已结算”规则不一致。
这份证据没有证明数据丢失，也没有证明独立条目必须全部被冻结；需要先统一恢复完成时
对未决 native 的阻塞粒度，再让两条路径使用同一政策。全局冻结过多和过早解除冻结都应由
后续组合模型检验其实际影响。本轮保留当前行为作为反例，未做生产修复。

[Recovery.lean](ColpSync/Recovery.lean) 显式保留这两条分支，Lean 检查：

- cutover、Ack receipt 和 Session 激活都不把未知 native 变成已知。
- 没有完成的 bootstrap Ack 就不能激活恢复游标。
- 合法 fresh 轨迹可以在未知调用仍存在时解除冻结。
- fresh/resumed 轨迹最终达到同一 cursor 和未知事实，冻结标志却不同。

[recovery-witness.test.ts](../../packages/extension/model-tests/recovery-witness.test.ts)
从 Lean 导出的期望检查两条真实引擎路径，共 15 个状态检查点。
检查点覆盖 cutover 后发送 Ack 之前、响应返回但回执未落盘、重启、回执已落盘、激活前后及最终状态。
同时检查未知调用未重建、原 Ack 请求精确重试。

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

本轮共 5 个专用测试文件、21 个测试通过；相关现有交接、bootstrap 过期、Snapshot 保留测试
另有 3 个文件、23 个测试通过。Lean 构建和公理审计通过，无 `sorryAx`；专用 typecheck、
改动文件 ESLint、`git diff --check` 通过。

这里使用真实引擎、IDB repository、applier、Snapshot projector、cutover、确认和激活模块。
底层 IDB 是 fake-indexeddb，Chrome API、Session 提供者及 HTTP 服务端是替身；
Snapshot 从完整 staging 开始，没有覆盖 Snapshot HTTP 下载/签名校验。
没有启动真实服务端、PostgreSQL 或浏览器，服务端接受 Ack 仍是环境前提。

跨账号/副本 generation、服务端 lease/security epoch、在途消息与所有 await 的并发交错，
仍需要放入共同状态空间。当前结果是有实际实现约束的客户端纵向切片，不能视作端到端 1:1 验证。
