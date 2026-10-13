# BE-2 independent implementation, test and semantic review

审查基线 `6cc7d8a`，覆盖 BE-2 九项任务和对应设计的 M1 边界。不是只复跑已有测试：
重新检查 lifecycle、receipt authority、bundle ordering、恢复和测试 oracle，先复现缺陷再修复。

## Findings and fixes

| 问题 | 影响 | 修复与证据 |
| --- | --- | --- |
| Global resume 清除显式 run hold | 未获明确 continuePinned 的工作可能执行 | 全局 pause 仅通过 settings 阻断效果；resume 只唤醒未 hold 的 waiting runs。server-intake 回归验证显式 hold 不丢失。 |
| 当前规则已 paused 的旧 pinned 工作没有 resume wake | 已明确 continuePinned 的工作可能永久等待 | 全局 resume 对 owner 的所有合格 waiting runs 发 durable wake，不以当前 desiredState 过滤。 |
| continuePinned 仅修改当前规则修订 | edit 前的旧修订 hold 无法恢复 | pendingRuns 按 owner 和逻辑 rule 涵盖所有不可变修订；执行仍固定原 definition/binding。新增旧修订测试先失败后通过。 |
| Receipt 未验证 source scope 与竞争规则 | 匹配 URL 的越界、同优先级冲突 placement 可能被接受 | 复用 preview/server 的 scope、binding、priority arbitration；结合当前 activation ordinal 和 bundle pins，仅 placed 判定可满足 intake。两个负向测试先失败后通过。 |
| settingsRevision 只跟随 Pause ETag | 重排的规则快照不能可靠判新旧 | 独立 owner configuration epoch 涵盖规则、binding、pause；receipt 拒绝过期配置序号。Pause API ETag 不变。 |
| configuration-only composition 暴露 device runtime | 未安装 runtime 仍可能发 active bundle | device routes 与 manifest exclusion 同时受 runtime flag 控制；composition 测试覆盖配置开启、runtime 关闭。 |
| 部分测试依赖前一测试状态；digest 两端共享 oracle | 单独执行不可靠，共同漂移难以发现 | admission/source-position/device negative case 使用独立 fixture；M1 连续旅程明确为单个测试；增加按公开 contract 固定的 digest golden。 |

configuration epoch 使用 forward-only `202610300900_automation_configuration_epoch.ts`，
在此前五个 BE-2 迁移之后。升级从旧 settings 和已发 bundle 序号最大值之上开始；
实际 deploy restore 暂停 SQL 也推进序号，旧 schema 通过存在性检查兼容。

## Executed validation

所有 PostgreSQL integration 命令均以 `xvfb-run -a npm --prefix packages/server run
test:integration:file -- …` 执行，使用实际 Testcontainers PostgreSQL；没有把未发现的测试算通过。

- 首轮新增 receipt-semantics/server-intake 反例：5 项失败，3 项因筛选跳过。
  修复后两文件 8 项通过。追加 configuration epoch upgrade、restore 案例后，receipt-semantics
  单文件 5 项通过。旧修订 continuePinned 追加反例先 1 项失败、5 项筛选跳过；修复后
  server-intake 单文件 6 项全部通过。
- M1 backend gate、device receipts、placement Undo、admission、source position、bundles、
  persistence 七个相关 integration 文件：18 项通过。M1 gate 包含实际 pg_dump/pg_restore、
  提交前回滚、提交后未 ack 重放、真实 API/canonical Outbox worker 和 Undo。
- automation/MCP unit 六文件 13 项通过；最后新增独立 digest golden 与 composition gate 后，
  两文件 6 项通过。各次为针对变更的验证，计数不相加冒充不同案例数。
- server typecheck、修改源文件 ESLint、check:imports、build、openapi:ci、
  runtime:manifest:check、check:migrations（相对 `6cc7d8a`）、shell syntax 与 git diff whitespace 通过。
- 原任务更广的 canonical/shared-core 回归见 [AW-66](aw-66.md)；本次未重复无关测试。

测试资源通过 wrapper、fixture 和 app.close 回收，不保留本任务启动的服务。

## Semantic boundary

没有扩大到 M2 jobs/targets/model/Events 或 Web、Extension、native 实现；本报告不声称浏览器商店、
真实设备离线执行或线上部署验证。未知 Sync/default intent 仍保留当前位置；显式选择、imports、
restores 不发明自动归类授权。Receipt 的 rulePlacement 判定只描述已经验证的 canonical placement，
不授权另一轮移动；presave advisory beforeFolder 仍不能产生 Undo。历史快照保留 2,000-member 上限。

离线设备看到暂停的时间仍受 bundle 7 天有效期约束；5 分钟刷新是建议，不是即时吊销保证。
本次审查发现的实现与测试缺陷均已修复；没有用放宽 scope、替换 pin、推断 intent 或新增 M2
语义来绕过失败。BE-2 的完成范围仍是本仓库可执行、可恢复的 M1 backend gate。
