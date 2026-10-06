# 09. Problem Code Registry

## 1. 通用格式

<!-- COLP-REQ PUB-0008 -->

错误响应使用 RFC 9457 `application/problem+json`，并包含稳定的 ASCII `code`。客户端根据 `status`、`code` 和机器可读恢复字段处理；不得解析 `title` 或 `detail` 文本。

```json
{
  "type": "https://collectionprotocol.org/problems/precondition-failed",
  "title": "Precondition failed",
  "status": 412,
  "code": "precondition_failed",
  "detail": "The resource changed after the supplied ETag.",
  "instance": "/collections/c/collection-1",
  "currentRevision": "r_18",
  "currentEtag": "collection-r_18",
  "retryable": true
}
```

`detail` 不得回显 Secret、完整签名 URL、私人 Note、内部 Principal 或其他未授权数据。

## 2. 核心注册表

| HTTP | `code` | 含义 | 客户端恢复 |
|---|---|---|---|
| 400 | `invalid_json` | JSON 语法、重复成员、数字范围或安全键不符合 I-JSON | 修正文档，不自动重试 |
| 400 | `invalid_query` | Query 包含未知参数、重复标量、空值或非法编码 | 按 Endpoint Query `$defs` 重建请求 |
| 400 | `invalid_cursor_scope` | Cursor 用于错误 Principal、Endpoint、Collection、Filter 或版本 | 丢弃 Cursor，从对应资源重新开始 |
| 401 | `authentication_required` | 缺少、过期或无效 Credential | 按 `WWW-Authenticate` 重新认证 |
| 406 | `unsupported_version` | 读取请求的 Header / Accept 版本不受支持 | 从 `supportedVersions` 重新协商 |
| 415 | `unsupported_media_type` | 写入媒体类型或其版本不受支持 | 使用 Manifest 声明的请求媒体类型 |
| 422 | `unsupported_operation` | Operation 合法但当前宿主尚未实现 | 不要重试；等待能力协商或升级宿主 |
| 403 | `insufficient_scope` | Principal 有效但 Scope / 对象授权不足 | 不重试；可启动显式授权升级 |
| 403 | `node_read_only` | Node 自身或权威祖先的只读约束拒绝本次写入 | 不自动重试；等待约束或受管策略改变 |
| 403 | `origin_not_allowed` | MCP / Browser Origin 不在 Allowlist | 停止请求并检查部署 Origin 配置 |
| 403 | `csrf_failed` | Cookie 写请求缺少有效 CSRF 证明 | 重新加载可信页面并取得新 CSRF Token |
| 404 | `resource_not_found` | 资源不存在或 Concealment Policy 隐藏其存在 | 不猜测 ID；根据上级资源重新发现 |
| 405 | `method_not_allowed` | Endpoint 不支持该 Method | 使用 `Allow` 与 Endpoint Contract Registry |
| 409 | `revision_conflict` | HTTP Precondition 已满足，但发生领域冲突 | 读取 Conflict / 当前资源并让用户选择 |
| 409 | `position_context_stale` | after / before 邻接关系已改变 | 重新读取 Parent Children 后重试 |
| 409 | `snapshot_expired` | 分页期间固定 Revision 已不可用 | 从第一页重新获取 Snapshot |
| 409 | `idempotency_key_reused` | 同 Key 携带不同请求摘要 | 生成新 Key；原请求不得执行 |
| 409 | `idempotency_in_progress` | 同 Key 的首次请求仍在执行 | 按 Retry-After 重试同一请求 |
| 409 | `sequence_gap` | Replica Sequence 跳号 | 从 `expectedSequence` 补齐或 Bootstrap |
| 409 | `sequence_blocked` | Expected Sequence 存在 deferred receipt | 先解除并重试被阻塞的 Expected Sequence |
| 409 | `sequence_reuse` | 同 Sequence 携带不同 Operation | 停止同步并人工检查本地状态 |
| 409 | `op_id_reused` | 同 Op ID 携带不同 Operation | 停止同步并检查本地幂等状态 |
| 409 | `dependency_failed` | Batch 中依赖的 Operation 未成功 | 修复或重新提交依赖后重试 |
| 409 | `folder_not_empty` | 删除非空 Folder 但未明确递归 | 提示用户选择非递归取消或确认子树删除 |
| 410 | `feed_cursor_expired` | Feed 历史已压缩 | 跟随 Snapshot Link，重建公开状态 |
| 410 | `sync_cursor_expired` | Sync Log 已压缩 | 下载权威 Sync Snapshot 并 Bootstrap |
| 410 | `stale_replica` | Replica 超过 Lease / Tombstone Window | 丢弃旧基线，完成权威 Bootstrap 后再 Push |
| 410 | `replica_retired` | Replica 已显式退役 | 创建新 Replica，不得复用旧 Queue |
| 410 | `resource_purged` | Tombstone 和 Prior Representation 已清理 | 不可恢复；创建新对象需新 ID |
| 412 | `precondition_failed` | `If-Match` 不成立 | 读取当前 ETag / Revision 后重做用户操作 |
| 413 | `payload_too_large` | Body、批次、深度或附件超过限制 | 缩小请求，不得拆分绕过总 Cost 限制 |
| 422 | `invalid_document` | JSON 形状、Format 或语义图校验失败 | 修正文档；使用 `errors[]` 定位 JSON Pointer |
| 428 | `precondition_required` | 缺少必需 `If-Match` | 读取资源并带 ETag 重试 |
| 429 | `rate_limited` | Bucket / Cost Budget 耗尽 | 遵守 `Retry-After`，不得拆单绕过 |
| 500 | `internal_error` | 未分类的服务器故障 | 使用同一 Idempotency Key 谨慎重试可重试操作 |
| 503 | `service_unavailable` | 临时维护、依赖或容量不可用 | 遵守 `Retry-After` 并指数退避 |

Node Guard 的内部 denial 与 HTTP Problem 映射如下：

- 候选 Parent 不是 Root/Folder、普通 Node 产生 `parentId=null`、Root invariant 被破坏或候选图形成 Cycle，使用 `422 invalid_document`，并在 `errors[]` 中给出稳定 path/keyword。
- Parent Ancestry、Subtree、解析深度或成员预算超过部署 Hard Limit，使用 `413 payload_too_large`。
- 请求指向不存在或被 Concealment Policy 隐藏的资源，使用 `404 resource_not_found`。
- 权威存储中的 Ancestry 无法解析、约束已损坏或事务无法建立一致快照，使用 `500 internal_error` 或在可恢复依赖故障时使用 `503 service_unavailable`；`node_ancestry_unresolved`、`invalid_node_constraints` 等 helper denial 不是可直接上 Wire 的 Core Problem Code。

## 3. 恢复字段

错误按需提供：

- `currentRevision`
- `currentEtag`
- `expectedSequence`
- `supportedVersions`
- `retryAfterSeconds`
- `snapshotUrl`
- `conflictId`
- `errors[]`，每项包含 `path`、`keyword`、`message`
- `links`，例如 `current`、`snapshot`、`authorization`

扩展错误码使用 HTTPS Namespace URI，不得占用未注册的短 ASCII Core Code。
