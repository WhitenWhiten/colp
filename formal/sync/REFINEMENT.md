# 距离实现语义 1:1 还有多远

工程上有价值的“1:1”是：每个会影响同步正确性的实际状态和持久化边界，都有模型中的对应；
实际执行的一步能够映射到模型的一步或多步，忽略纯内部计算时允许 stuttering。
目前具备协议骨架、部分局部函数对照和有限实现轨迹检查，距离整个系统的这种保证仍有明显差距。
不能用 Lean 行数、探索状态数或测试用例数推导完成百分比。

## 当前对应程度

| 层次 | 当前证据 | 尚未取得的保证 |
|---|---|---|
| 纯判断函数 | `Cursor.lean` 按源码移植排序、Ack 分类、游标写入的分支；12,328 个组合输入与生产函数一致 | 所有字符串的解析与分支等价性；签名/账号鉴权不属于这个解析器 |
| 单页及错误隔离 | `Pull` 的任意长度轨迹安全证明，实际局部失败复现 | 任意条目数、依赖闭包、删除与移动的完整效果 |
| 多页延期/确认/剪枝 | `Ledger` 的无界页数性质；四条实际模块轨迹逐宏步骤对照 | 所有交错执行、事件类型、延期依赖图及预算组合 |
| 单副本 Session/Snapshot/Ack 交接 | `Authority`/`Recovery`/`AckFence` 的局部证明，六条事务迁移、三条 Ack 失效轨迹和两条完整引擎恢复路径对照 | 尚未把各模型组合为同一全局状态机；未覆盖全部 await、跨账号/副本 generation 与服务端 Session/lease 验证 |
| Push 与命令 | 简化状态机、部分无界性质与反例 | 完整 sequence receipt、冲突、重排、批量部分提交、命令生命周期与 final outbox |
| 服务端与插件组合 | 健康报告事务的局部抽象；客户端收到合法 Ack 回执的边界 | PostgreSQL 锁/回滚、服务端序号与 Session 状态机、真实网络消息队列及两端组合证明 |
| 实现 refinement | Lean 导出的输入/期望值驱动实际模块测试，无手工维护期望快照 | 没有证明所有实际实现步骤都被模型包含；运行时与存储原语仍属可信基础 |

## 本轮增加的实现连接

入口：仓库根目录 `npm run model:sync:implementation`。
[Export.lean](Export.lean) 生成 JSON 测试向量与轨迹检查点，
[model-tests](../../packages/extension/model-tests) 用实际模块执行同一动作并比较投影。
专用 typecheck 包含 extension 的 Chrome ambient 类型，默认单元测试不依赖 Lean。

| Ledger 动作 | 实际执行 | 比较的投影 |
|---|---|---|
| `publish true` | stage 真实 create effect；在 Chrome create 后、证据保存前注入崩溃；重开 IDB；恢复为未知调用并登记延期；真实页面完成事务 | 发布页序号，保留页面及事件是否完成 |
| `publish false` | stage 并应用一个独立的真实 create effect | 同上；检查实际 API 调用数量 |
| `ack n` | `beginAckIntent` 的真实发布/证据检查，`completeAckIntent` 持久化合法模拟回执 | 已完成 intent 的最大页序号；并非真实服务端接受证明 |
| `confirm p g proof` | `confirmNativeWait` 使用实际 waitRef/intentId；错误 generation 或缺少 nativeId 时拒绝，成功后 resume 完成 detached event | 原页面条目完成，较新的游标和回执保持不变 |
| `prune` | 真实 `prunePullHistory(scope, 1)` | 未解决页保留，已解决旧页可清理 |
| `crash` | 关闭、重开同一 fake IndexedDB 实例及 applier，保留 Chrome 替身的实际副作用 | 持久化状态不变 |

期望状态只由 Lean 计算。适配器独立读取实际 cursor、页面、event 和 Ack intent；
不以 Lean 的期望值写入存储，也不直接造出 `authority_committed` 成功状态。
`publish true` 需要真实经过 started/unknown/延期路径；确认必须绑定之前那次 create 的实际 nativeId。
每条轨迹最后还检查实际 create 次数等于发布的测试事件数，防止丢失回执后自动重复创建。

这里一次“动作”会折叠若干真实异步步骤，例如确认后 resume 的 detached completion。
只检查这些宏步骤的检查点，尚未覆盖宏步骤内部每个 await 之间的崩溃与竞争。
Chrome API、IDB 实现和服务端回执的替身边界应始终保留在验证说明中。

## 需要补齐的主要层次

1. **完整的事务转换与 authority。** 建立 Session/lease/credential/generation/engine revision 的不同身份，
   明确每个 await 之前捕获的 authority、CAS 前提、失败结果和回滚。加入 Snapshot 新旧 cut、
   native wait 的保留/补偿及 Ack 意图失效，避免把“刷新成功”误当成应用进展。
2. **端到端组合与交错。** 把服务端 sequence/push/pull/Ack 事务、多个 replica、客户端数据库、
   Chrome 和双向消息队列放入同一状态空间。显式加入丢请求、丢回执、重复、乱序、worker 重启、
   账户切换和命令执行。先对小范围数据穷举，再证明不依赖数量上限的不变量。
3. **实现到模型的映射证据。** 为真实存储状态定义投影关系，逐个持久化点证明或检查对应转换。
   可将关键纯内核提取为共享语义/受限描述，再由两端解释；若继续手工移植，需更强的差分检查和漂移检查。
   TypeScript、浏览器和数据库本身的语义不能因 Lean 定理成立而自动视为已验证。
4. **带环境前提的活性。** 说明调度公平、网络最终可达、权限恢复、服务端最终结算和用户决策等前提，
   证明每个可恢复条目最终推进或可见地停在明确修复出口。需要排除无限 stuttering；
   “总能发健康报告”或“游标前进”都不能单独推出每个条目最终收敛。

核心 refinement 义务可写成：

```text
R(实际状态 c, 模型状态 m) 且 c → c'
⇒ 存在 m'，使 m →* m' 且 R(c', m')
```

此外还要证明实际初始状态与模型初始状态对应，以及模型安全性质能通过 R 转移到实际状态。
当前测试是在给定输入和轨迹上检查部分 R；上面这个全称命题尚未证明。

第三轮已完成单副本 Session/Snapshot/Ack 交接的第一段纵向切片，
见 [交接模型、真实模块对照与反例](HANDOFF.md)。它连接了真实 cutover 与未知 native、
丢失 Ack 响应后的原请求重试、激活、CAS 失败回滚和迟到回执，但还没有覆盖所有中断点。

后续应先把客户端 Ack 意图与服务端 Ack/Session 事务、lease generation、
collection/security epoch 放入共同状态空间，显式表示在途请求和回执；
随后扩大 Snapshot 下载/投影中断、跨账号/副本替换及 native 结果确认的交错。
恢复冻结路径依赖已修复，旧反例保存在 `aab68b3f`，当前模型改为验证完成政策一致性。
后续组合模型应保持这一回归，并检查可信 native 确认后能最终解除本地冻结。
