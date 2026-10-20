# colp-server 与浏览器插件同步正确性审计及修复 — 2026-10-20

## 交付范围

本轮把审计发现拆为 S01–S25，分别实现产品修复与真实场景回归，并在多轮独立审查后再次修正。集成基线是 main@`a7800c8877edb51179a6137376834bb02b3ed03a`，本报告对应的审查代码为 `0922c112bd649f5e0ddf75d7ee6c319579359b86`。代码、测试和复审修正保留为 269 个独立提交，详见[逐任务提交索引](sync-correctness-commit-index-2026-10-20.md)。主修复提交是入口；判断最终实现需要同时读取对应任务的后续提交。

PR：[WhitenWhiten/colp#90](https://github.com/WhitenWhiten/colp/pull/90)。定向验证均注明来源；发布判断使用 PR 当前 HEAD 的完整必选检查，较早提交的通过结果不能替代当前提交。此交付只创建、更新并推送 PR，不合并或部署。

审查分工覆盖服务端事务、协议与权限，插件同步状态机与浏览器事件，界面与真实用户流程，以及测试质量和覆盖率。实现者与最终审查者分开；独立审查先保留能失败的复现，再由另一位实现者修复，审查者随后核对原断言及相邻路径。

## 必须维持的同步规则

1. **数据和身份可追溯。** 结果未知时，已发送请求的 operation ID、sequence、digest、幂等键和请求字节保持不变。API 返回、native 事件和用户确认是不同证据，不能互相冒充。
2. **用户后续编辑独立存在。** 远端确认只结算对应旧动作；后续改名、拖动、删除和范围选择必须保留。可证明未调用的操作可以重新准入，已开始或结果未知的调用继续原恢复路径。
3. **授权在副作用之前仍有效。** 账号、profile、scope generation、根目录、排除范围、权限和确认身份在最终写入前复核；延迟响应或旧 Options 页面不获得新授权。
4. **持久结果决定 UI 文案。** 排队或开始执行不等于已保存；浏览器事件不等于调用确定成功；关闭确认框不等于不曾发生创建。
5. **问题保持可解释。** 相关项保留保护与恢复入口，能证明独立的工作继续推进。未知结果、完整性损坏和协议顺序限制保留真实状态，不能靠丢记录或虚假 Ack 制造成功。
6. **规模增长不改变正确性。** 减少重复读取和复制，同时从同一新事务读取一致的 shadow 与 durable mapping；不依赖过期缓存，不截断仍有语义的历史。

## 逐任务修复

| 任务 | 用户场景 | 修复后的行为 | 主提交 |
|---|---|---|---|
| S01 | 当前同步范围与权限 | 每次上传、下载及最终浏览器调用前重新检查账号、代际、范围和权限；排除项及未确认的新范围不能被旧命令写入。 | [d5087b16](https://github.com/WhitenWhiten/colp/commit/d5087b166dd12d8e47e82825cf4f53de60a1c389) |
| S02 | 首次同步的持久确认 | 确认内容与实际执行的根目录、范围和代际绑定；回复丢失、页面重开或 worker 重启不会把旧预览当作新授权。 | [72069e9f](https://github.com/WhitenWhiten/colp/commit/72069e9f8a5ba047eef3dd9623b025ce31e1bef4) |
| S03 | URL 身份 | 保留路径末尾斜杠和片段路由；编辑与冲突解决不再把用户的不同 URL 合并。 | [8e2d7726](https://github.com/WhitenWhiten/colp/commit/8e2d77267baca15cf1f494a45362260195c8ff81) |
| S04 | 多字段编辑与合并 | 独立保留标题、URL、描述及命名空间的意图和来源；冲突选择不会丢掉同一次编辑的其他字段。 | [bc175058](https://github.com/WhitenWhiten/colp/commit/bc175058a1fda06755eed2cb384a8c76b217002d) |
| S05 | 远端删除与本地未完成工作 | 远端删除先检查未发送、已发送结果未知、恢复中和隔离中的本地工作；Reset/副本退休保留可恢复的原始证据。 | [b69a0bb6](https://github.com/WhitenWhiten/colp/commit/b69a0bb605e023c28b8817ee429b424c209f7628) |
| S06 | 浏览器 create 回声身份 | 用精确 API 返回或确认记录关联 native ID；并发手动创建不能抢占云端身份，也不能产生重复上传。 | [d3c8e85b](https://github.com/WhitenWhiten/colp/commit/d3c8e85b83012740fad7fa6a267001a7f336c2fc) |
| S07 | 回声后的连续用户编辑 | 云端确认只结算对应的旧动作；后续拖动、改名、删除仍作为独立用户操作保留，并可在普通恢复流程中继续处理。 | [324b227b](https://github.com/WhitenWhiten/colp/commit/324b227b263ead2ccea91e3325c3d0941ec14b44) |
| S08 | 排序、历史增长与首次同步性能 | 恢复相对顺序；当前 Pull 映射与未发布 shadow 在同一新事务中读取，避免每次查映射复制整段历史。 | [6cc82122](https://github.com/WhitenWhiten/colp/commit/6cc821223b9801fc4f818a9767a3552ccf121e09) |
| S09 | 暂停、重新加入与删除决策 | 成员与原始决策持久化；恢复使用真实 native 回执，重复执行和重启不漏成员，也不默认为删除授权。 | [c7e2c7cb](https://github.com/WhitenWhiten/colp/commit/c7e2c7cb3e391b4b04aefa27e10fcf17d482f572) |
| S10 | 账号、设备和浏览器根目录隔离 | 账号切换、不同 profile 和同名根目录分别保持身份，延迟响应不能跨账号或跨根写入。 | [49468a13](https://github.com/WhitenWhiten/colp/commit/49468a1391dca8d7da465088623f900714e0f28f) |
| S11 | 空书签标题 | 浏览器、服务端和当前 API 契约一致地保留空标题，避免正常书签变成永久失败项。 | [3c9e86ea](https://github.com/WhitenWhiten/colp/commit/3c9e86ea246de9ccd0c0f32051326be1067bb961) |
| S12 | 标题与文本契约 | 从共享策略生成浏览器和服务端校验；真实冲突表单按 UTF-8 字节限制检查，保留无效输入供用户修改。 | [07d60498](https://github.com/WhitenWhiten/colp/commit/07d60498ba5b0b6023ef2738af1cecc557d8460d) |
| S13 | URL 元数据来源 | URL 被改写或恢复副本后，使旧 URL 的元数据失效；迟到的元数据不会覆盖新 URL 对应的信息。 | [2184f0f0](https://github.com/WhitenWhiten/colp/commit/2184f0f0e664249cd9ff886b5807b24568aed76c) |
| S14 | 扩展命名空间持久化 | 冲突合并后的命名空间值进入 canonical 写入；API 成功不再掩盖字段未落盘。 | [d50379c6](https://github.com/WhitenWhiten/colp/commit/d50379c6cd4a61f031346036d0640db54201e6bf) |
| S15 | 可执行的冲突选择 | 菜单只提供与保留意图相符的操作；执行时再次检查权限和修订，过期页面不能执行旧选择。 | [162c34be](https://github.com/WhitenWhiten/colp/commit/162c34bec614eca9d244b529686c51c7e026091c) |
| S16 | 只同步根目录直属书签 | 全部子目录排除时，根目录直属书签仍可被明确选择并同步。 | [22090736](https://github.com/WhitenWhiten/colp/commit/22090736dc7c6c04b6b578402741c8caf400ba34) |
| S17 | 确认超时与重新打开 | 丢失响应后按精确确认身份恢复；页面变更和重开不重放不同的命令。 | [8bd4a855](https://github.com/WhitenWhiten/colp/commit/8bd4a8550bbe6d7ce1c4299f40b16ad951e71d11) |
| S18 | 稍后处理的真实含义 | “稍后”保留用户当前选择及新授权，不静默启动未确认同步，也不回滚较新的设置。 | [2cc03958](https://github.com/WhitenWhiten/colp/commit/2cc039587ac389d4596752b6aa43f69d2fade211) |
| S19 | 多个设置页并发 | 页面状态按当前根目录和代际校验；旧设置页不能覆盖另一个页面已经确认的结果。 | [ed71342c](https://github.com/WhitenWhiten/colp/commit/ed71342c2e406ba49c7123b83325c2318d4c4b12) |
| S20 | 保存完成反馈 | 只有持久化命令回执提交后才显示已保存；排队、执行中、失败和已提交有不同反馈。 | [07da80a3](https://github.com/WhitenWhiten/colp/commit/07da80a3c1761c8be8b855714d30267ebc4ee34c) |
| S21 | 进度、问题提示与恢复入口 | 进度由当前确认范围和真实队列事实投影；阻塞原因、受影响项和可用操作与实际状态相符。 | [efd45718](https://github.com/WhitenWhiten/colp/commit/efd457189d5644532a714f4d2c21b295bf24431c) |
| S22 | 真实场景与发布检查 | 补齐数据库重开、浏览器事件、worker 停止、响应丢失、真实 PostgreSQL、MV3 用户流程及逐模块覆盖率门槛。 | [a7719218](https://github.com/WhitenWhiten/colp/commit/a7719218002bc694ae3bae46764fadb43cdc391f) |
| S23 | 不支持的恢复位置 | 对未支持的 restore placement 明确拒绝；不先修改数据、不虚假确认成功。 | [de3ad96c](https://github.com/WhitenWhiten/colp/commit/de3ad96c677a20739ff9c47cd221e16819519ba0) |
| S24 | 范围命令中断恢复 | 持久化命令与 journal，按原始范围、代际、确认和回执继续；中断后不重复副作用。 | [741c9f2c](https://github.com/WhitenWhiten/colp/commit/741c9f2c0bf1d538ed2266ff2ffcc782015d6ed7) |
| S25 | 本地不支持的 URL | 保留仅本地支持的书签，首次同步显示清楚的原因和计数；不把它们算作成功上传或静默删除。 | [56abbcec](https://github.com/WhitenWhiten/colp/commit/56abbcec539b83d614403c4a37024ec9f3516f22) |

S26/S27 对应的 favicon GET 检查和页面计数呈现已在集成的上游主分支，复核后保留，未制造重复修复提交：[e61842c2](https://github.com/WhitenWhiten/colp/commit/e61842c26f244e4cc99b792908ee4bb285a60d54)、[9ceca936](https://github.com/WhitenWhiten/colp/commit/9ceca9366a7b8aa6063ca23e6198fdcb4f47b832)、[0fc314ba](https://github.com/WhitenWhiten/colp/commit/0fc314ba321d2be1dd39704fc724c21193dcfb6b)。

## 最终独立审查发现与修正

### 并发创建与不确定结果

独立审查通过已注册 worker 入口复现了手动创建与同步创建的回调竞态：先到的手动事件可能占用同步操作身份，造成错误映射或重复上传。[4f72ff5a](https://github.com/WhitenWhiten/colp/commit/4f72ff5a15d049be0dcb1d67e2a994b5f12da28f) 保留 in-flight 候选，最终由精确 API 返回或明确确认决定 native 身份，独立手动事件仍上传一次。

另一条 observed-create 恢复路径把仅有事件误当为确定结果。[8916b57b](https://github.com/WhitenWhiten/colp/commit/8916b57b1464a77d7d82165f5093145f5214bb23) 移除捷径：没有回执时保留 unknown；有 API 回执时使用精确 ID；明确 Bind 保留自己的确认种类。[f6d9eb9d](https://github.com/WhitenWhiten/colp/commit/f6d9eb9d8740cdaef2d8ceba3b81481b8140bddc) 补上回执写入、mapping 尚未写入时用户又改名或删除的中断场景。独立审查对应 16 个完整 worker 用例及 28 个相邻用例通过；重叠的作者测试不重复累计。

### 连续拖动、再次重试及改标题

首次修复保留 A→B→C 中后续用户动作，但独立复现进一步在 placement 证明窗口加入 C→D：第一次拒绝正确，后续普通重试却一直使用旧 preimage。另一个实际 callback 场景在拒绝后继续改标题并重开数据库，仍永久拒绝推进旧 Pull 事件。

最终修复只对可证明尚未调用的 move 重新准入：两次读取并核对标题/URL 捕获证据、当前 native 状态及父节点/锚点，再以原 intent 和事件状态的事务 CAS 更新 preimage。捕获读取属于准入证据，不声称与 Chrome 或捕获记录构成同一原子事务。已开始、已有 API/native 回执、已有确认或结果未知的记录保留原恢复语义。删除仍由完整的逐成员未调用 ledger 判断。新 move intent 明确保存未调用事实，防止重开时旧 backfill 将其误当为历史 unknown。

独立复现先出现两项普通重试失败；可编译的首次修复又暴露 12 项状态和邻接路径回归，均保留原断言继续修正。最后的来源提交为 `0922c112bd649f5e0ddf75d7ee6c319579359b86`，[run 39502188432](https://github.com/WhitenWhiten/colp/actions/runs/39502188432)：17 文件 /186 测试全部通过，零跳过；完整插件 TypeScript、lint 与源码大小检查通过。 独立审查已确认原复现和整行 unknown/receipt 断言未放宽，合法重启恢复及相邻删除/范围路径通过。。

### 大书签集首次同步

原始 958 书签测试在早期修复后仍超时。真实 Chromium 诊断指向频繁的只读 IDB 事务和整段历史复制。[92d701ae](https://github.com/WhitenWhiten/colp/commit/92d701ae14b34a6f1a9e1f34d16c763b8c70f2d8) 对当前 Pull shadow 和 durable mapping 使用同一新只读事务，保持 publication、delete、unbind、recreate、跨连接可见性和回滚语义。

原样 958 书签正常和丢失批次响应用例分别在 2.5 分钟、2.4 分钟通过，原 240 秒终态断言、样本规模和数据检查未变。96 操作的生产 worker 预算测试另外证明 288 次 lookup 对应 288 个新只读 mapping 事务、零个 mapping 写事务，并验证队列回执、Pull echo、page complete 和 Ack。该测试使用受控端口与 fake IndexedDB，不能当作真实浏览器性能成绩。

### 真正经过恢复入口的队列测试

[fb4e81d2](https://github.com/WhitenWhiten/colp/commit/fb4e81d2c3a819aceecc0fab4a11484cce0c85ac) 增加两个独立审查的流程：真实 bookmark callback 入队、Push 响应丢失、数据库重开、租约接管和原请求精确重试；HTML 导入的父子依赖、错误回执拒绝、事务中断回滚、重开后逐项结算。断言覆盖整个 unknown attempt、receipt、mapping 和队列，并实际触发原先遗漏的三个拒绝分支，没有直接向 IDB 注入成功终态。导入回执通过真实仓储结算接口驱动；真实服务器幂等性由 PostgreSQL 与浏览器栈流程另行验证。

### 表单字节边界

真实 Web 冲突表单存在字符数与服务端 UTF-8 字节限制不一致的问题。[7fe1c7f2](https://github.com/WhitenWhiten/colp/commit/7fe1c7f2abeb2143669f955893ce3722f52e9de5) 在 POST 前验证描述 16384 字节、URL/canonical URL 4096 字节，恰好上限仍可提交；超限保留输入并要求明确修改后再次提交。独立验证 42 项 Web 和 20 项服务端校验通过，服务端限制未放宽。

## 测试改进与验收矩阵

| 真实使用情境 | 要观察的结果 | 验证层 |
|---|---|---|
| 请求到达但响应丢失 | 保留相同请求身份和字节；重试不重复创建 | 实际 Push worker、IDB 重开、真实服务端与浏览器 |
| Chrome 已执行但 worker 尚未保存回执就停止 | 不假定没执行；保留 unknown 或按精确回执恢复 | 注册 worker、真实 MV3 终止和持久 profile |
| 连续拖动、改名或删除 | 旧确认不抹掉新意图；普通重试能推进；未知队列不被改写 | 实际事件队列、Pull applier、事务 CAS 与数据库重开 |
| 同时打开两个设置页 | 旧页面被代际/确认校验拒绝，不覆盖新设置 | Options DOM/runtime 与持久命令 |
| 暂停、排除、重新加入、Reset 中断 | 原决策与成员保留，可恢复且不重复副作用 | 持久 journal、IDB 重开、真实 PostgreSQL |
| 两账号或浏览器 profile | 根目录和迟到响应互相隔离 | 持久 Chromium profiles 与服务端权限 |
| 导入父子目录且部分响应出错 | 未完成父项不使子项落错位置；回滚保留精确身份 | HTML import coordinator 与真实 queue settlement |
| 大量书签及长期历史 | 原预算内完成，最终数量、身份、顺序正确 | 原始 958 书签真实 Chromium、读取预算与跨连接测试 |
| 空标题、片段路由、多字节文本、不支持的 URL | 保留输入，策略跨端一致，错误可修正 | 生成契约、服务端、实际表单与首次同步 UI |

覆盖率检查纳入 **188 个插件模块**，逐模块检查 lines、branches、functions、statements。新增模块设为四项 80%，原有 187 个模块的门槛逐键比对保持不变，mapping-view 四项 100% 也未降低。服务端审计另外覆盖 12 个模块。完整测量由当前 PR 的必选 CI 执行，定向测试覆盖率不能替代完整门槛。

## 来源明确的验证记录

| 范围 | 运行及来源 | 结果与边界 |
|---|---|---|
| 真实 958 书签首次同步与丢失批次响应 | [run 39497843445](https://github.com/WhitenWhiten/colp/actions/runs/39497843445/job/118887415163)；`cdb523701ee0ccc443c0f09f10d1b178f3cab1b2` | 2 PASS；正常2.5分钟、丢响应2.4分钟；原始240秒终态断言、样本和数据检查保持不变。 |
| 映射读取一致性与事务预算 | [run 39498240477](https://github.com/WhitenWhiten/colp/actions/runs/39498240477/job/118888778961)；`cdb523701ee0ccc443c0f09f10d1b178f3cab1b2` | 5文件28测试及独立96操作worker测试通过，完整TypeScript通过；部分V8全局分支75.78%导致任务失败，不能作为完整覆盖率通过。新映射读取模块与mapping-view四指标100%。 |
| 发送响应丢失与导入中断恢复 | [run 39499068936](https://github.com/WhitenWhiten/colp/actions/runs/39499068936/job/118891607440)；`fb4e81d2c3a819aceecc0fab4a11484cce0c85ac` | 2个真实生产模块/IDB重开流程通过，完整TypeScript通过；队列写入原先未覆盖的3个拒绝位置均执行。完整owner门槛由最终CI重新测量。 |
| 真实Chrome子项未知结果与明确绑定 | [run 39491499676](https://github.com/WhitenWhiten/colp/actions/runs/39491499676/job/118865549950)；`3a2db5b4a78b7d1f0e1b8711aa387e3728e5a213` | 1 PASS /48秒；实际native create/onCreated、MV3停止、持久profile重启和Options Bind。此为较早提交证据，最终CI再次执行必选流程。 |
| 真实PostgreSQL副本退休与重放 | [run 39457764063](https://github.com/WhitenWhiten/colp/actions/runs/39457764063) | 31项副本退休和2项其余重放用例通过；限于该运行的记录提交。 |
| Reset元数据opt-out、204响应丢失与重启 | [run 39460311403](https://github.com/WhitenWhiten/colp/actions/runs/39460311403) | 通过；限于该运行的记录提交。 |
| 服务端同步审计覆盖率 | [run 39461691074](https://github.com/WhitenWhiten/colp/actions/runs/39461691074)；`4b607549` | 25文件292测试、12个owner全部通过；最终同提交CI仍需重跑。 |
| 持久浏览器profile隔离与Keep-cloud | [run 39473284392](https://github.com/WhitenWhiten/colp/actions/runs/39473284392)；`4e2fea30` | 2个真实浏览器流程通过；限于该运行的记录提交。 |

早期完整插件测量对应来源 [4d25330c](https://github.com/WhitenWhiten/colp/commit/4d25330c43f0ce5ebb0ed49adfd3dce8d551ba40)：747 文件、5959 测试，其中 5951 通过、8 失败；总 L/B/F/S 为 96.13/87.73/94.83/92.36%，但 queue-repository 行覆盖 94.39% 未达原 94.9% 门槛。三项连续拖动问题及五项真实父节点/挂载 fixture 问题随后分别修正；新增队列流程实际执行遗漏分支。这段历史保留为问题来源，不作为最终通过声明。

映射读取的第一次定向 V8 运行使用默认 5 秒单测配置；按仓库原有 15 秒配置和并行度重跑后 28 项行为全部通过，但部分测试集合的全局分支 75.78% 仍使该诊断任务失败。该结果如实保留，完整集合的 global 与逐模块门槛未降低。

## 完整 PR 发布检查

最终提交必须在 [PR Checks](https://github.com/WhitenWhiten/colp/pull/90/checks) 同时通过现有 colp-ci 必选流程：静态与协议/生成物校验、Node 包及依赖检查、服务端测试与六个真实 PostgreSQL shard、服务端审计覆盖率、Web、插件类型/lint/源文件大小/build/单测及覆盖率、MV3、真实同步栈、KNS-09、onboarding/recovery/web 三类生命周期流程，由 ci-gate 汇总。全部 E2E 走 xvfb。任何失败继续作为独立修正提交处理，不跳过任务或降低原门槛。

临时诊断 workflow 只在各自分支使用，完成后删除；最终 PR 不包含这些一次性 workflow。运行日志与永久回归测试保留。

## 兼容性与发布顺序

- [插件 schema](../../packages/extension/src/sync-state/schema.ts) 从 IndexedDB v20 升为 v21，存储持久范围确认、进度与结果；旧二进制不能打开升级后的数据库，安装旧包不能假定可读取新状态。
- 服务端新增 [202611010500](../../packages/server/migrations/202611010500_sync_deleted_conflict_recovery.ts) 和 [202611010600](../../packages/server/migrations/202611010600_empty_bookmark_titles.ts)，位于已有 010400 之后。先扩展数据库，再发布使用新契约的应用；存在新恢复菜单或空标题数据时 down 明确拒绝，避免通过改写用户数据降级。
- Product API 新增 product-v1.1.99.0.yaml 与 product-v1.1.100.0.yaml 基线，product-v1.1.98.0.yaml 保持不变。副本退休 v2 独立协商，旧服务端兼容路径继续严格校验。
- 以上是发布说明，本次未执行部署、生产迁移或合并。

本审计对已列明规则、代码路径与故障时序提供永久回归和来源明确的验证。网络、浏览器权限或用户明确决策仍可能使同步等待；产品应如实呈现原因并保留数据和恢复入口。
