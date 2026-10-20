# colp-server 与浏览器插件同步正确性审计及修复 — 2026-10-20

## 交付范围

本轮把审计发现拆为 S01–S25，分别实现产品修复与真实场景回归，并在多轮独立审查后再次修正。集成基线是 main@`a7800c8877edb51179a6137376834bb02b3ed03a`，本报告对应的审查代码为 `1364ad54055df29cff2e36e5f557ebd00990306a`。代码、测试、复审修正和审计文档按第一父链追踪为 284 个独立提交，另有 5 个既有 PR 分支提交保留在合并图中并单列附录，详见[逐任务提交索引](sync-correctness-commit-index-2026-10-20.md)。主修复提交是入口；判断最终实现需要同时读取对应任务的后续提交。

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

独立复现先出现两项普通重试失败；可编译的首次修复又暴露 12 项状态和邻接路径回归，均保留原断言继续修正。该阶段的来源提交为 `0922c112bd649f5e0ddf75d7ee6c319579359b86`，[run 39502188432](https://github.com/WhitenWhiten/colp/actions/runs/39502188432)：17 文件 /186 测试全部通过，零跳过；完整插件 TypeScript、lint 与源码大小检查通过。 独立审查已确认原复现和整行 unknown/receipt 断言未放宽，合法重启恢复及相邻删除/范围路径通过。

### 大书签集首次同步

原始 958 书签测试在早期修复后仍超时。真实 Chromium 诊断指向频繁的只读 IDB 事务和整段历史复制。[92d701ae](https://github.com/WhitenWhiten/colp/commit/92d701ae14b34a6f1a9e1f34d16c763b8c70f2d8) 对当前 Pull shadow 和 durable mapping 使用同一新只读事务，保持 publication、delete、unbind、recreate、跨连接可见性和回滚语义。

在历史来源 `cdb523701ee0ccc443c0f09f10d1b178f3cab1b2` 上，原样 958 书签正常和丢失批次响应用例分别在 2.5 分钟、2.4 分钟通过，原 240 秒终态断言、样本规模和数据检查未变。随后完整集成 CI 在 `b0bda063d4e129520664e8a1bce734aae98961b7` 再次暴露两项超时，因此这次历史通过不作为最终验收；追加诊断、修复和验证见下一节。该阶段 96 操作的生产 worker 预算测试另外证明 288 次 lookup 对应 288 个新只读 mapping 事务、零个 mapping 写事务，并验证队列回执、Pull echo、page complete 和 Ack。该测试使用受控端口与 fake IndexedDB，初始状态为 snapshot_pending，没有覆盖整个首次同步收尾；不能当作真实浏览器性能成绩或完整 bootstrap 终态的证明。

### 真正经过恢复入口的队列测试

[fb4e81d2](https://github.com/WhitenWhiten/colp/commit/fb4e81d2c3a819aceecc0fab4a11484cce0c85ac) 增加两个独立审查的流程：真实 bookmark callback 入队、Push 响应丢失、数据库重开、租约接管和原请求精确重试；HTML 导入的父子依赖、错误回执拒绝、事务中断回滚、重开后逐项结算。断言覆盖整个 unknown attempt、receipt、mapping 和队列，并实际触发原先遗漏的三个拒绝分支，没有直接向 IDB 注入成功终态。导入回执通过真实仓储结算接口驱动；真实服务器幂等性由 PostgreSQL 与浏览器栈流程另行验证。

### 表单字节边界

真实 Web 冲突表单存在字符数与服务端 UTF-8 字节限制不一致的问题。[7fe1c7f2](https://github.com/WhitenWhiten/colp/commit/7fe1c7f2abeb2143669f955893ce3722f52e9de5) 在 POST 前验证描述 16384 字节、URL/canonical URL 4096 字节，恰好上限仍可提交；超限保留输入并要求明确修改后再次提交。独立验证 42 项 Web 和 20 项服务端校验通过，服务端限制未放宽。

## 完整集成 CI 的追加发现与修正

[完整运行 39503249599](https://github.com/WhitenWhiten/colp/actions/runs/39503249599) 对应 `b0bda063d4e129520664e8a1bce734aae98961b7`，28 个任务中 23 个成功、5 个失败（含汇总 ci-gate）。六个真实 PostgreSQL 分片均通过；扩展的全量单测与覆盖率运行复现同样三项行为失败，onboarding 另有一项旧文案断言失败，958 书签正常与丢响应两项未在原 240 秒内达到完成状态。重复运行的同一断言不重复计为独立缺陷。

- **恢复授权顺序。** [239ee14d85](https://github.com/WhitenWhiten/colp/commit/239ee14d85b316c52b34eb55ae6d19fcba038e9b) 只在真正适用的 own `node_created` 路径读取 provisional parent。原实现过早为 restore 求值父映射，截断 `need_authority` 恢复路径。原恢复错误、native create 仅一次和未知结果/精确回执断言保留。
- **最新移动记录的完整身份。** [3f9a8609c0](https://github.com/WhitenWhiten/colp/commit/3f9a8609c09dfe26b28ec8012c1f0efb1ad2f30f) 先选最新未被覆盖的 move，再将 scopeKey、opId、sequence、replicaId、collectionId 与持久行和当前 scope 绑定。最新行缺失或错配身份时，不能退回较旧行取得移动依据。新增缺失/错配负例、真实 stamp 正例和实际 Push unknown 后的整行/attempt/receipt 不变检查。[d7936e7c9e](https://github.com/WhitenWhiten/colp/commit/d7936e7c9e7646f1736ba0b3bfe0f3010e87c0f0) 单独修正新正例的调用输入：调用方必须提供新的 opId，stamp 负责 scope 与 sequence；全部相等性断言保持不变。
- **真实故障注入边界。** [27227944cb](https://github.com/WhitenWhiten/colp/commit/27227944cb7773f242980422b97c352a575b7552) 将旧的 point-read stub 移到产品实际调用的 coherent mapping reader。拒绝后与恢复后分别断言故障总共恰好触发一次，继续验证游标未提前推进、原 native evidence 保留、无重复创建。
- **范围预览的实际数量。** [1364ad5405](https://github.com/WhitenWhiten/colp/commit/1364ad54055df29cff2e36e5f557ebd00990306a) 将陈旧的 `1 added` 改为真实 fixture 的完整语义：总计 11 书签/2 目录，新增 1 目录/10 书签；新增列表只包含新目录，确认前 canonical IDs 不变。原重连、确认、60 秒上传预算和防重复复制断言保留。

恢复与身份修正在 `d7936e7c9e7646f1736ba0b3bfe0f3010e87c0f0` 上经[运行 39506347781](https://github.com/WhitenWhiten/colp/actions/runs/39506347781)验证：22 文件/241 测试全部通过，零跳过；完整 TypeScript、Lint 和源码大小检查通过。独立审查者逐提交核对原断言、59 项生命周期测试及创建回执相邻路径。范围预览修正在独立来源 `40ce50b3fde28a2c8118ad47ad2c8d62196977f9` 上经[运行 39505613484](https://github.com/WhitenWhiten/colp/actions/runs/39505613484)验证，两条完整真实浏览器流程、完整 TypeScript、spec lint 和产物隐私检查全部通过，并由另一位实现者反向独立审查。

上述完整覆盖率测量的 188 个模块均达到原四项门槛（总 L/B/F/S 为 96.36/87.93/95.24/92.62%）；该任务因三项行为失败仍然失败，不能当作完整 CI 通过。后续组合提交必须重新完成全部必选任务。

### 大规模首次同步、按需父映射读取与覆盖率遗漏

完整集成的两次 240 秒超时保留为失败记录。随后的无 observer 原始测试在 `d7936e7c9e7646f1736ba0b3bfe0f3010e87c0f0` 上正常/丢响应分别 2.9/2.6 分钟通过；诊断运行 `43c9a2621ffc97128fe67d0431e989e3b569b912` 只用于观察当前开销，不能代表无观测场景或证明单一超时原因。不同运行的耗时不用于声称修复产生了某个百分比的加速。

[6f6faf0756](https://github.com/WhitenWhiten/colp/commit/6f6faf075623fe79052ea0fca97803195fe8cf70) 删除两个 replay 入口的冗余父读取：已有 provisional mapping 时不消费该参数，fallback 构造才求值。prepare 仍传入已经读取的父映射；projection 和 parent revision publication 保留各自新的读取。[95b370668a](https://github.com/WhitenWhiten/colp/commit/95b370668afb08d743053a76628effd454a7cb61) 另行把新增 await 放到最后的 native/canonical identity collision 检查之前，保持检查顺序。没有跨 wake 缓存、schema 或并发语义变更。

实际生产 applier 的恢复预算证明：有 pending mapping 的 prepared 与 started 重开路径，各由 3 次 coherent IDB 读取降为 2 次；fallback 仍需 3 次、canonical 路径仍为 2 次。这是相应路径的工作量证据，不是整轮同步速度保证。`6f6faf075623fe79052ea0fca97803195fe8cf70` 上原始 958 两种场景另有 2 PASS（3.6/3.4 分钟，总 7.2 分钟）；最后集成源码仍由完整 CI 再验。

最初新增的两个缺失父映射负例错误地要求 prepared 阶段抛异常，导致定向 258 项中 256 通过、2 失败。独立审查沿真实 owner 确认：prepared 可持久隔离该 item，并推进已 accounted-for 的页面；started 必须拒绝继续。[ff4ba1f84a](https://github.com/WhitenWhiten/colp/commit/ff4ba1f84a61fdccd8e389e3c3147cbecb0198a1) 将其补强为四个分阶段负例，保留五个已通过正例原文。验证真实删除、coherent parent 为 null、精确 issue/code/node/event/count、零 native create、无 canonical mapping/receipt，以及二次重开后的事实。prepared 页面完成仅允许协议定义的 `echoApplied: true`；未知 Push 的身份、请求体、摘要、sequence、status 和 attempt 保持不变。started 拒绝路径要求整个队列行原样且游标不推进。

审查还确认 `pull-self-create.ts` 原先不在 coverage include 清单中，因此不是被总体覆盖率兜底的受测 owner。[b7670e0b9a](https://github.com/WhitenWhiten/colp/commit/b7670e0b9afa348d4bd94b10afbb96c5a71f88b5) 单独把它加入第 189 个 owner，四项门槛均为 80%，同步 catalog、baseline、contract 与说明；原有 188 项的每个数值逐键一致。

同源 `b7670e0b9afa348d4bd94b10afbb96c5a71f88b5` 的 26 文件/260 项行为测试、完整 TypeScript、lint 与源码大小检查均通过，但首次 helper 实测 L/B/F/S 为 85/75.67/100/80%，分支未达 80%，因此该诊断任务仍失败。已保留未覆盖位置并追加真实操作身份与并发映射拒绝场景；不通过降低门槛来闭环。

`b7670e0b9afa348d4bd94b10afbb96c5a71f88b5` 的原始 958 场景随后在[运行 39509543622](https://github.com/WhitenWhiten/colp/actions/runs/39509543622/job/118926841068)通过：正常与丢批次响应各 3.1 分钟、合计 6.4 分钟，2 PASS、零跳过，未添加 observer。完整 TypeScript、原 spec lint、生产构建及产物隐私检查通过。后续 `113ff442cb0197b1920ac28aacb7d9c358a160d5` 只增加四个恢复边界用例，产品代码未变。

四个实际故障用例在 [113ff442cb0](https://github.com/WhitenWhiten/colp/commit/113ff442cb0197b1920ac28aacb7d9c358a160d5) 单独提交：lazy parent 读取期间发生 native/canonical 映射冲突，以及失去 provisional mapping 后遇到与真实 unknown 请求不一致的序号/内容。[运行 39510797387](https://github.com/WhitenWhiten/colp/actions/runs/39510797387/job/118931024960) 的 26 文件/264 测试全部通过，helper L/B/F/S 为 100/94.59/100/92%，完整 TypeScript、lint、781 文件/零例外的大小检查通过。该来源的 helper 门槛通过只证明已测路径，随后独立成对复现仍发现下述遗漏。

### 保留临时映射时的请求身份校验

独立审查沿 stage、prepare、replay、mapping commit 和 page publication 核对后，确认 pending mapping 的快捷返回没有后置队列绑定。审查者在 [32bfbfec1b](https://github.com/WhitenWhiten/colp/commit/32bfbfec1b8a98d06d95d7443ca5237389be9e3f) 保留全部原 13 项，仅新增两个成对负例：真实 callback 分配序号 2、前序请求已有持久回执、实际 Push 失去响应成为 unknown；回复自己的 operation/effect 摘要均合法，但与原请求的序号或 payload 矛盾，同时保留 pending mapping。

[运行 39510885940](https://github.com/WhitenWhiten/colp/actions/runs/39510885940/job/118931324013) 中原 13 项通过、新 2 项失败，类型/lint/大小检查仍通过。两个用例在真实 prepare 崩溃、数据库重开与 resume 后均到达错误终态：原 pending 被绑定为正式 canonical ID，unknown 队列被标 `echoApplied: true`，事件成为 `page_complete`，`cursor-next` 和 API evidence 已发布，而没有拒绝。这个结果证明了客户端面对已知矛盾来源时的完整性缺口；不表示规范服务端必然会产生这种回复。

[0bb094d0ea](https://github.com/WhitenWhiten/colp/commit/0bb094d0ea5264cfcea1d0a795653654c3c0fd7d) 单独修正 pending 命中路径：在返回映射前重新读取同 scope、同 opId 的持久队列；记录存在时必须为 create_node、sequence 相等且 canonical operation digest 一致，否则抛 `pull_source_binding_invalid`。无队列的历史映射继续经过调用方现有 native 证明，已 canonical 且有真实回执的分支保持既有处理。该修正给 pending 命中增加一次队列读取；先前 2/3/2 的预算仅统计 coherent mapping 事务，不能据此宣称所有读取都减少。

[7e30eebfbb](https://github.com/WhitenWhiten/colp/commit/7e30eebfbbe7eaea29bc103f3f1dbb5c1119f597) 单独调整两个 fallback 负例的前置条件：先经真实 Push 得到 unknown，再由公开仓储删除 provisional mapping，之后提交自洽但错误的回复。它们不再依赖旧漏洞来准备错误 intent。真实 stage preflight 在持久化页面之前便调用来源 guard，因此无 event/intent 进入执行、无 canonical/cursor/evidence 发布，整条未知请求、旧回执和 native 数据原样保留。原九个恢复/读取预算用例、两个延迟碰撞用例以及独立 pending 两个完整终态 oracle 均保留。

修复后的固定来源 `7e30eebfbbe7eaea29bc103f3f1dbb5c1119f597` 在[运行 39511498054](https://github.com/WhitenWhiten/colp/actions/runs/39511498054/job/118933359495) 完成 27 文件/324 测试，全部通过、零跳过。包括本文件 15 项、既有 pull-applier 58 项、own-create-replay 8 项、回执身份 24 项以及相邻生命周期/映射恢复检查；这些是 324 项的子集，不能重复累计。helper L/B/F/S 为 100/95.34/100/92.85%，四项 80% 门槛通过；完整 TypeScript、lint 和 781 文件/零例外的大小检查通过。独立审查者亲读固定 checkout 和完整日志，核对两条原失败 oracle 逐字保留，关闭该来源的身份语义问题。新的队列读取成本仍须接受同源原始 958 与最终 PR 完整 CI 的检验；相关运行与最终结论以 PR Checks 及 PR 验证栏为准。





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

覆盖率检查纳入 **189 个插件模块**，逐模块检查 lines、branches、functions、statements。新增 coherent mapping reader 与 provisional self-create helper 均设为四项 80%；前者加入时保留原 187 项，后者加入时再逐键确认原 188 项全部不变，mapping-view 四项 100% 也未降低。服务端审计另外覆盖 12 个模块。完整测量由当前 PR 的必选 CI 执行，定向测试覆盖率不能替代完整门槛。

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
| 完整集成 CI 追加修正：恢复授权、移动身份、真实故障注入 | [run 39506347781](https://github.com/WhitenWhiten/colp/actions/runs/39506347781/job/118916114591)；`d7936e7c9e7646f1736ba0b3bfe0f3010e87c0f0` | 22文件241测试全部通过，零跳过；完整TypeScript、lint、源码大小检查通过。独立审查闭环；本记录不替代最终完整CI。 |
| 范围预览数量与完整首次同步 UI 流程 | [run 39505613484](https://github.com/WhitenWhiten/colp/actions/runs/39505613484/job/118913642925)；`40ce50b3fde28a2c8118ad47ad2c8d62196977f9` | 2项真实PostgreSQL/Chromium流程全部通过，零跳过；保留确认、重连、60秒预算和防重复断言。来源为独立测试修复分支。 |
| 958 书签额外观测（仅诊断） | [run 39506664543](https://github.com/WhitenWhiten/colp/actions/runs/39506664543/job/118917184897)；`43c9a2621ffc97128fe67d0431e989e3b569b912` | 2项观测场景通过，2.2/2.1分钟；observer窗口110.386/110.114秒。产品来源d793；无缩样本或放宽预算；包含观测代码，不能替代无诊断原始验收。 观测环境可能影响调度，不能由此推导无观测场景的耗时或生命周期。 |
| 追加修正后、优化前的原始958书签验收 | [run 39507746794](https://github.com/WhitenWhiten/colp/actions/runs/39507746794/job/118920832392)；`d7936e7c9e7646f1736ba0b3bfe0f3010e87c0f0` | 2 PASS，零跳过；正常2.9分钟、丢响应2.6分钟，总5.7分钟。未使用observer，958样本/240秒终态/300秒测试预算及终态断言不变；不替代最后集成提交的CI。 |
| R6 按需父读取阶段的原始 958 浏览器验收 | [run 39509543622](https://github.com/WhitenWhiten/colp/actions/runs/39509543622/job/118926841068)；`b7670e0b9afa348d4bd94b10afbb96c5a71f88b5` | 真实 PostgreSQL/MV3，正常与丢批次响应 2 PASS、0 skip，3.1/3.1 分钟（总 6.4 分钟）；无 observer、原样本/预算/终态不变。完整集成仍须重新验收。 |
| R6 fallback 身份与延迟映射碰撞 | [run 39510797387](https://github.com/WhitenWhiten/colp/actions/runs/39510797387/job/118931024960)；`113ff442cb0197b1920ac28aacb7d9c358a160d5` | 26 文件/264 PASS、0 skip；helper L/B/F/S 100/94.59/100/92%，TS/lint/大小通过。该通过未覆盖随后单独发现的 pending 快路问题。 |
| R6 独立 pending 身份发布失败复现 | [run 39510885940](https://github.com/WhitenWhiten/colp/actions/runs/39510885940/job/118931324013)；`32bfbfec1b8a98d06d95d7443ca5237389be9e3f` | 原 13 PASS，新 2 FAIL；两项均错误发布 canonical mapping、echo 和 cursor，TS/lint/大小通过。保留失败，后续产品修复使用原终态断言复验。 |
| R6 pending 来源绑定、历史兼容及恢复边界闭环 | [run 39511498054](https://github.com/WhitenWhiten/colp/actions/runs/39511498054/job/118933359495)；`7e30eebfbbe7eaea29bc103f3f1dbb5c1119f597` | 27 文件/324 PASS、0 skip；helper L/B/F/S 100/95.34/100/92.85%，TS/lint/781 文件零例外通过；独立两条失败终态 oracle 保持原文并转绿。完整 189-owner 和原始浏览器终态由后续 PR CI 验证。 |

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
