# 00. Practical Interoperability Profile

## 1. 目的

Collection Protocol 涵盖发布、同步、安全和 MCP，但一个实现不应为了交换一棵收藏树而先完成全部能力。本 Profile 定义首个版本应优先实现的最小互操作面，并把其余能力拆成可组合模块。

本文件是 0.1 Draft 的实施基线。其他章节与本文件冲突时，以更严格、更明确的规则为准。

## 2. 非目标

首个互操作版本不定义：

- 网页抓取、全文归档、搜索排序或推荐算法。
- 支付、订阅、DRM 或按次计费。
- 跨服务器分布式事务。
- 把 Feed 当作同步日志。
- 强制任何实现提供 OAuth、MCP、WebSub 或 HTTP Message Signatures。

这些能力可以作为独立扩展实现，但不得改变核心对象和 HTTP 语义。

<a id="colp-section-3"></a>

## 3. 可组合 Profile

Manifest 的每个 Mount 独立声明 `profiles`：

| Profile | 依赖 | 必需能力 |
|---|---|---|
| `core` | 无 | 核心对象、Snapshot、结构校验、语义校验 |
| `publication` | `core` | Discovery、Directory、Metadata、Snapshot、HTTP 缓存与错误 |
| `feed` | `publication` | 公开事件流、Cursor、脱敏、轮询提示 |
| `publisher` | `publication` | 条件写入、幂等、Collection / Node / Annotation / Attachment / Relation / Release 管理 |
| `sync` | `core` | 单 Collection Session、Push、Pull、Ack、Conflict、Tombstone |
| `mcp-read` | `core` | 当前 Principal 可见的只读 Resource / Tool |
| `mcp-write` | `mcp-read`, `publisher` | 写 Tool、审计、风险聚合、Plan / Commit |

Profile 是能力声明，不是营销级别。实现 MUST NOT 声明尚未通过对应 Conformance Test 的 Profile。

一致性证据来自 `requirements.yaml`：包级测试、部署 Endpoint 与必需 Port 必须同时完整。Manifest 配置不能单独制造 Profile 声明。

Profile 依赖表示数据模型、Wire Contract 与端点语义的依赖，不表示每个部署都承担依赖 Profile 章节中出现的全部可选角色。例如 `publication -> core` 要求 Publication 表示遵守 Core 对象与 Snapshot 语义，但只读 Publication 部署不因此成为 Sync Server、AI 内容写入端、本地浏览器 Profile Store 或服务端 Profile ID HMAC 派生端。普通权威 Node 写入也不表示部署接受或存储所有可选 Folder Role；只有实际支持 `managed-bookmarks` 的写入面才承担该角色的默认只读边界。部署一致性测试必须按实际声明的 Profile 和实际启用的角色选择；角色未启用时，不得为通过测试而伪造相应 Port、数据或持久化能力。

Manifest Endpoint 也按 Profile 组合：只有声明 `publication` 的 Mount 才必须提供 `directory`、`collection` 和 `snapshot`；Sync-only 或 MCP-only Mount 不得被迫伪造未实现的 Publication 端点。

## 4. 最小可互操作发布端

<!-- COLP-REQ PUB-0001 -->

首个服务端建议只实现 `core + publication`：

1. `GET /.well-known/collection-protocol`。
2. Manifest 中一个 Mount，以及该 Mount 的 `directory`、`collection`、`snapshot` Endpoint。
3. Collection Directory。
4. Collection Metadata 与链接。
5. 完整、单页、规范化 Snapshot。
6. `ETag`、`If-None-Match`、`304` 和 Problem Details。

该最小发布端是只读部署边界，不需要实现 Managed Bookmark 写入边界、Sync Extension 往返、AI Annotation 权威写入、本地浏览器 Profile ID 持久化或服务端 Profile ID HMAC 密钥轮换。部署若另外暴露这些角色，则必须分别满足对应规则和部署一致性测试。

首个客户端只需：

1. 读取 Manifest。
2. 选择同时声明 `core` 和 `publication` 的 Mount。
3. 跟随 Manifest Endpoint 与响应中的 Link，不猜测路径。
4. 校验 JSON Schema。
5. 校验树、引用和唯一性。
6. 持久化 `ETag`，下一次使用条件 GET。

## 5. Endpoint 驱动，不使用路径猜测

<!-- COLP-REQ PUB-0003 -->

<!-- COLP-REQ PUB-0002 -->

Collection ID 是不透明 ID，API 路径与人类 Canonical URL 是两个概念。Manifest 必须声明绝对 Endpoint 或 URI Template：

```json
{
  "id": "default",
  "baseUrl": "https://alice.example/collections/",
  "profiles": ["core", "publication", "feed"],
  "endpoints": {
    "directory": "https://alice.example/collections",
    "collection": "https://alice.example/collections/c/{collectionId}",
    "snapshot": "https://alice.example/collections/c/{collectionId}/snapshot",
    "instanceFeed": "https://alice.example/collections/-/feed",
    "collectionFeed": "https://alice.example/collections/c/{collectionId}/feed"
  }
}
```

模板只使用 RFC 6570 Level 1 变量。0.1 的标准变量为 `collectionId`、`nodeId`、`annotationId`、`attachmentId`、`relationId`、`releaseId`、`conflictId` 和 `keyId`。变量值必须进行 UTF-8 Percent Encoding，客户端不得把 ID 当作路径片段、Slug 或时间解析。

每个标准 Endpoint Key 的变量集合必须与 Endpoint Contract Registry 完全相等；对象端点省略必需变量与使用错误变量同样无效。验证与展开必须使用同一个 RFC 6570 实现。

推荐动态路由使用 `/c/{collectionId}` 表示对象，使用 `/-/` 表示实例级服务，以免与不透明 ID 冲突。静态托管可以声明 `.json` 文件路径，不需要伪装成动态路由。

## 6. Snapshot 只有一个权威表示

Canonical Snapshot 使用规范化顶层数组：

- `nodes`
- `annotations`
- `attachments`
- `relations`
- `tombstones`

Node 不再内嵌上述对象。Annotation 和 Attachment 使用 `subject` 指向 Collection 或 Node。Node Detail 响应可以通过 `included` 展开相关对象，但展开内容只是同一对象的副本，不是第二个权威版本。

Snapshot 的 `mode`：

- `publication`：发布脱敏投影；不得包含 Source Reference、Tombstone、内部 Principal 或非公开 Sidecar，可用于匿名或授权读取。
- `sync`：授权同步投影；可以包含 Source Reference、Tombstone 和私人对象，但仍受 Scope 与 ACL 限制。

`complete` 表示查询选择的是完整逻辑 Snapshot：使用 `root`、`depth` 或省略权威数组的 `include` 裁剪时必须为 `false`；仅因 HTTP 分页不得改为 `false`。

完整逻辑 Snapshot 可以分页。所有页面必须共享 `snapshotId`、`revision`、`mode`、查询作用域与 Collection 投影，`page.sequence` 从 1 连续递增。客户端只有在按服务器返回的 `next` Link 取得全部页面并收到 `page.hasMore=false` 后，才能把组合结果作为替换状态。任一页面丢失、重复、Revision 改变或 Cursor 过期都必须丢弃整次组装。

分页只使用 `page.nextCursor`。Sync 进度只使用 `syncCursor`。Feed 使用自己的 Cursor 命名空间，三者不得互换。

<a id="colp-section-7"></a>

## 7. 两阶段校验

<!-- COLP-REQ CORE-0002 -->

<!-- COLP-REQ CORE-0001 -->

JSON Schema 负责结构与 Format 校验。实现必须启用 Draft 2020-12 Format Assertion 或执行等价的 RFC 3339 / URI 校验；仅把 `format` 当注释不符合本 Profile。结构校验通过后，接收方 MUST 执行语义校验：

- 恰好一个 Root，且等于 `collection.rootNodeId`。
- 全部对象的 `collectionId` 一致。
- ID 唯一，Live ID 与 Tombstone ID 不重叠。
- 非 Root Parent 存在且为 Root 或 Folder。
- Parent 图和 Alias 图无环。
- 同 Parent 下的 Position 非空且唯一。
- Annotation / Attachment Subject、Relation Endpoint 和 Provenance 引用存在。
- Public Snapshot 不包含私有或内部字段。
- Publication Snapshot 可以在授权后承载 `protected` / `private` Collection 的安全投影；`mode` 描述投影类别，不代替 ACL。
- `redacted=true` 的受限 Bookmark 可以保留标题、位置和公开 Teaser，但必须移除目标 URL、Source Reference 和未公开字段。

仓库中的 `scripts/validate_examples.py` 同时执行两类校验。

## 8. 写入与 Sync 的安全下限

- `PATCH` 默认使用 `application/merge-patch+json`；JSON Patch 需要显式能力声明。
- `If-Match` 失败固定返回 `412`；缺少必需条件固定返回 `428`；`409` 只用于业务冲突。
- `Idempotency-Key` 必须绑定 Principal、Endpoint 和请求摘要。同 Key 不同 Body 返回 `409 idempotency_key_reused`。
- 0.1 的必需 Sync 模式是一 Session 一 Collection。多 Collection Session 是可选能力。
- `(replicaId, sequenceScope, sequence)` 必须连续且不可改写；普通 Session 的 Scope 是 `collectionId`，未绑定的 Instance Bootstrap 临时使用 `sessionId`。同 Sequence 不同 Operation 返回 `409 sequence_reuse`；出现 Gap 返回 `409 sequence_gap`。不同 Collection 的离线队列互不阻塞。
- Tombstone 只有在最短保留期结束、全部活跃 Replica 已 Ack 删除 Cursor 且 Purge Watermark 已持久化后才能 Purge。`expired` Replica 仅在保留窗口完整时可恢复，否则进入 `recovery_required` 并重新 Bootstrap；`retired` 是终态，继续同步必须注册新 Replica ID。旧 Queue 不得直接 Push。
- MCP `sync.push` 必须检查内嵌 Operation 的最高风险；Delete、Mirror、Public Exposure 等操作不能绕过 Plan / Commit。

## 9. 版本与扩展

同一精确协议版本内，新增数据只能进入 HTTPS Namespace `extensions`。核心字段变化必须发布新的 Schema 与协议版本。

权威 / Sync Bookmark URL 使用 `$defs.bookmarkUrl`，允许 Mount 明确声明的安全本地 Scheme；Publication / Feed 只允许 HTTP(S)，本地 Scheme 必须 Redact 或保留在授权 Sync 表示中。

公共投影的核心 Schema 允许 `extensions` 存在；是否可公开由部署配置的 Namespace Allowlist 和该 Namespace 的发布 Schema 做语义校验。未配置 Allowlist 时必须移除，而不是让基础 Schema 永久禁止全部扩展。

严格 Schema 可以使用 `additionalProperties: false`。客户端遇到更高版本时先进行版本协商，不得把未知核心字段当作已理解字段执行。中继若承诺未知数据往返，必须保存原始表示或拒绝降级，而不能静默丢失。
