# BE-4 / BE-5 收尾检查与执行证据

基线 `490428a`，工作树 `/home/whiten/known/colp-wt/automation`，分支
`feat/colp-automation`。AW-02 使用已有证据；AW-27、28、29、44、46、41、57、58
各有独立提交，见 [状态表](../status.md)。本轮未访问真实 dot、未更改远程 spike、
未发布服务、未改 Web/extension 运行时。

## 交叉检查中修复的问题

- 真正 MCP HTTP 调用暴露了本地 `$defs` 被错误当成核心 COLP 定义的问题；修复闭合
  schema 的解析并通过既有 canonical-schema 回归。此前直接服务调用不能代替这项证据。
- 回调已返回 410/413 或 2xx 时，接收方响应正文不参与投递判定。只在挑战验证读取
  有界正文，避免超大正文把终止响应误判成重试。每次发送仍重新签名原始持久字节。
- 回调返回前工作已被领取时，成功收据仍记 accepted；撤销、暂停、订阅代次及当前
  权限继续受检查。后台停止不再继续启动本轮剩余的网络尝试。
- 订阅刷新更新经过认证的、无 bearer 的凭据观察；数据库直接将 refreshBefore
  限制在凭据到期之前，避免应用／数据库两次取时的微小漂移。即将过期凭据需先刷新。
- Events 发现、worker、能力 DTO、健康检查和接受计数都遵守安装状态／功能开关。
  未启用时统计为 unavailable/null；接受计数不等于完成任务数。
- Run-once 和 mark-read 的命令回放重新检查当前 Owner/source 权限，旧成功回执
  不能绕过撤权。关闭 runtime 后不能启动旧的手动预览。历史容量错误有明确拒绝。
- 已验证设备回执可能晚于 canonical 源游标；现在按持久 intake 效果补查有界的
  完成记录，并用独立阶段 receipt 去重。不是重新扫描当前书签来计数。
- 已知 server-only digest/review count 规则没有浏览器 intake 部分，不进入 browser
  bundle；完整的受支持 M1 intake 仍输出，其他不支持的规则仍拒绝，不偷偷降级。
- 输出顺序与读水位保留数据库微秒精度；新输出不会因时钟重复／回拨落到旧水位后面。
- 新模块通过公开 facade 导入；只添加明确的 Automation→hardened-egress 和路由
  注册依赖。未放宽整个模块层级的 import 规则。

## 实际验证

所有后端 E2E 均使用 Node 22 + `xvfb-run -a`；PostgreSQL 由测试工具隔离创建和回收。
只运行本次功能及受其影响的既有路径。不同轮次有重复，以下不把重复执行累加为新案例。

| 检查 | 结果 |
| --- | --- |
| 10 文件交叉集成（Events、manual、count、output、既有 polling/preview/usage） | 45 案例；43 通过，2 项暴露夹具返回创建时 draft 而非启用后状态；修复夹具后既有 preview 4 项通过 |
| 修正后的定向回归，含 fresh/upgrade/真实 pg_dump/pg_restore | 24 案例；22 通过，2 项新权限测试的软删除夹具违反 collection/root/children 约束；改成同事务删除完整树后复测通过 |
| 最后 manual/output/bundle/迟到 device 组合 | 4 文件 9 项全部通过，80.00 秒 |
| 双目标路由、过期密钥清除、稳定重订阅 | 新增 1 项通过；不将共享 credential 说成两个隔离身份 |
| OAuth 刷新观察及期限 | 新增 1 项通过；初次回归抓到期限超出凭据约 14ms，修复为数据库 LEAST 后使用零容差断言 |
| 输出微秒精度定向复测 | 原输出分页／后到未读／命令回放权限案例通过 |
| 服务端相关 unit（webhook/config/admission/evaluation/preview） | 26 项通过 |
| Node Events / canonical schema closure / Automation schema | 45 项通过 |
| 构建和边界 | server build（含迁移编译）、typecheck、check:imports、OpenAPI/Automation drift、5 个新增迁移顺序、git diff --check 通过 |
| 本地 package | Node build/pack、server vendor、npm 10 runtime manifest 已刷新；未发布 npm |

上述集成覆盖共 **56 个不同案例**，按发现的问题定向复测，没有声称存在一个一次性
56/56 的单命令日志。AW-44 另记录 500,000 次评估和有界队列负载测量，不当作生产 SLA。

主要重现入口：

```sh
# Node 22/npm 10
xvfb-run -a npm --prefix packages/server run test:integration:file -- \
  tests/integration/automation/events-subscriptions.integration.test.ts \
  tests/integration/automation/events-delivery.integration.test.ts \
  tests/integration/automation/events-retention.integration.test.ts \
  tests/integration/automation/events-lifecycle.integration.test.ts \
  tests/integration/automation/run-once.integration.test.ts \
  tests/integration/automation/count-batch.integration.test.ts \
  tests/integration/automation/count-batch-device.integration.test.ts \
  tests/integration/automation/run-outputs.integration.test.ts \
  tests/integration/automation/worker-pipeline.integration.test.ts \
  tests/integration/automation/worker-preview.integration.test.ts \
  tests/integration/automation/usage-read-model.integration.test.ts \
  tests/integration/automation/persistence.integration.test.ts \
  tests/integration/automation/bundles.integration.test.ts
```

迟到 device 案例使用真实 Sync/session/receipt 验证，executor 为明确标注的存储夹具；
真实 worker 配对／MCP／效果证据由其他集成案例承担，不混淆证据类型。

真实 dot 的账号隔离、平台 rescan、host burst 行为及真实 hosted 完整生命周期仍按
[AW-46](aw-46.md) 保留为外部验收。全部本轮临时测试服务关闭；原有远程 spike 未动。
