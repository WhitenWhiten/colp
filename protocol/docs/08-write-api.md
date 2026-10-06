# 08. Publisher HTTP Write API

## 1. 适用范围

本文件定义 `publisher` Profile 的最小 Wire Contract。资源表示 Schema 与写入 DTO 必须分离：客户端不得伪造服务器管理的 `id`、Root、时间、Revision、Cursor 或审计字段。全部请求与响应 DTO 都在核心 Schema `$defs` 中具有稳定名称。

所有示例路径均为推荐动态路由；客户端实际使用 Manifest `endpoints` 和响应 Link。声明 `publisher` 却缺少任一必需写端点的 Manifest 无效。

<a id="colp-section-2"></a>

## 2. 通用规则

<!-- COLP-REQ PUBLISH-0001 -->

- 请求使用 UTF-8。
- 创建使用 `application/json`。
- PATCH 默认使用 `application/merge-patch+json`。
- 修改和删除已有资源必须发送该资源最后一次响应的 `If-Match`。
- 所有可重试 POST 必须发送 `Idempotency-Key`。
- Idempotency Key 绑定 Principal、Method、Endpoint Key、资源身份、协议版本和 Canonical Request Digest；JSON 使用 RFC 8785，已解码 Query 使用 Canonical JSON，Media Type 规范化为小写且移除可忽略空白。同 Key 不同请求返回 `409 idempotency_key_reused`。
- 成功创建返回 `201 Created`、`Location`、`ETag` 和完整创建结果。
- 成功修改返回 `200 OK`、新 `ETag` 和完整资源；不使用无法让客户端更新 Revision 的空 `204`。
- Schema 或候选图语义错误返回 `422 invalid_document`，授权范围错误返回 `403 insufficient_scope`，缺 `If-Match` 返回 `428`，ETag 不匹配返回 `412`，语义冲突返回 `409`。
- 仅当请求已通过 Authentication、Authorization 和 Concealment Policy，且 Node 自身或任一权威祖先的只读约束是实际拒绝原因时，Publisher MUST 返回 `403 node_read_only`；未授权或隐藏资源继续使用 Concealment Policy 选定的 403/404，不能暴露只读状态，也不能把真实的只读拒绝折叠为 `insufficient_scope` 或未注册短码。
- Publisher 的通用 Node 写入面可能遇到 `managed-bookmarks` Folder 或其后代，因此该 Profile 的写入边界包含该角色的默认只读规则；这一义务不表示仅提供其他权威写入能力的非 Publisher 部署接受或存储该可选角色。
- Parent/Subtree 遍历超过部署 Hard Limit 时返回 `413 payload_too_large`。权威 Ancestry 无法解析或已损坏属于服务端状态错误，不得把内部 Guard Denial Code 作为未注册的 Wire `code` 返回。
- 写入响应和错误响应使用 `Cache-Control: no-store`。

<a id="colp-section-3"></a>

## 3. 原子创建 Collection 与 Root

<!-- COLP-REQ PUBLISH-0003 -->

`POST /collections`

Collection 表示强制 `rootNodeId`，因此创建端点 MUST 在一个事务内同时创建 Collection 和唯一 Root。请求不得先创建悬空 Collection，也不得先创建无 Collection 的 Root。

```http
POST /collections HTTP/1.1
Content-Type: application/json
Idempotency-Key: 019b-create-interface-systems
```

```json
{
  "collection": {
    "kind": "knowledge_collection",
    "title": "Interface Systems",
    "summary": "A curated path into design engineering.",
    "visibility": "private",
    "publication": {
      "feedMode": "release",
      "includeNodeContent": "summary",
      "includeRelations": true
    },
    "extensions": {}
  },
  "root": {
    "title": "Interface Systems",
    "folderRole": "root"
  }
}
```

```http
HTTP/1.1 201 Created
Location: https://alice.example/collections/c/019b3ca2-8424-7cc2-9a61-4bf44c23f07a
ETag: "collection-r_1"
Content-Type: application/vnd.collection-protocol.collection-create-result+json;version=0.1
Cache-Control: no-store
```

响应 Body 必须通过 `collectionCreateResult`，包含完整 Collection、完整 Root 和 Link。可执行示例见 `examples/publisher-collection-create-result.json`；不得用空对象或只返回新 ID 代替完整结果。

Snapshot Import 是独立的高成本操作，不复用本端点。支持时由 Manifest 显式声明 `snapshotImport` Endpoint 与限制。

## 4. 更新 Collection

`PATCH /collections/c/{collectionId}`

```http
PATCH /collections/c/collection-1 HTTP/1.1
Content-Type: application/merge-patch+json
If-Match: "collection-r_17"
```

```json
{
  "summary": "Updated summary",
  "tags": ["design", "engineering", "systems"]
}
```

客户端不得 PATCH：`id`、`rootNodeId`、`createdAt`、`updatedAt`、`revision`、`eventCursor`。把 `visibility` 改为 `public` / `unlisted` 仍需 Access Scope；经 MCP 发起时必须走 Plan / Commit。

Application Service 必须把成功 PATCH 规范化为 `update_collection_metadata` Canonical Operation，并保存 Typed `base` / `value` Payload。

## 5. 删除 Collection

<!-- COLP-REQ PUBLISH-0005 -->

`DELETE /collections/c/{collectionId}`

本端点只执行可恢复的逻辑删除并创建 Deletion Receipt，不执行物理 Purge。物理 Purge 是部署级管理操作，不属于 `publisher` Profile。

成功返回 `200 OK` 和 `deletionReceipt`。Publisher 不依赖 Sync，因此响应不得要求或伪造 Sync Cursor：

```json
{
  "receipt": {
    "resourceType": "collection",
    "targetId": "collection-1",
    "collectionId": "collection-1",
    "scope": "single",
    "deletedAt": "2026-07-16T08:00:00Z",
    "deleteRevision": "r_18",
    "operationId": "op_delete_collection_18",
    "affectedCount": 1,
    "purgeAfter": "2026-08-15T08:00:00Z"
  }
}
```

此操作属于高风险操作，必须审计；MCP 调用必须走 Plan / Commit。

<a id="colp-section-6"></a>

## 6. 创建 Node

`POST /collections/c/{collectionId}/nodes`

```json
{
  "parentId": "root-1",
  "afterId": null,
  "beforeId": null,
  "node": {
    "kind": "bookmark",
    "title": "Example",
    "url": "https://example.com/",
    "tags": [],
    "extensions": {}
  }
}
```

- `parentId` MUST 在与创建相同的事务中解析为同 Collection 的 Root 或 Folder；普通 Node 创建端点不得接受 `null`，也不得创建 Root。
- `afterId` / `beforeId` 是语义位置，服务器生成 Position。
- 两者同时存在时必须相邻，否则返回 `409 position_context_stale`。
- Bookmark URL 必须通过 `$defs.bookmarkUrl`。默认接受 HTTP(S)；`file`、`about`、浏览器内部 Scheme 等需要 `features.bookmarkUrls.acceptedSchemes` 与部署策略同时允许，并且不得进入 Publication / Feed。

成功返回 `201 Created`、Node `Location`、Node `ETag` 和完整 Node。

## 7. 更新 Node

`PATCH /collections/c/{collectionId}/nodes/{nodeId}`

PATCH 只修改内容字段。移动与重排必须使用 Move 端点，避免 Parent / Position 在普通 Patch 中出现两套并发语义。

客户端不得 PATCH：`id`、`collectionId`、`kind`、`parentId`、`position`、`sourceRefs`、`createdAt`、`updatedAt`、`revision`、`deletedAt`。

把某字段设为 JSON `null` 按 RFC 7396 表示删除可选字段；不可为空的字段会返回 `422`。

Application Service 必须把成功 PATCH 规范化为 `update_node_content` Canonical Operation；不能转换成包含任意 JSON Pointer 的通用 Patch Operation。

<a id="colp-section-8"></a>

## 8. Move / Reorder

`POST /collections/c/{collectionId}/nodes/{nodeId}/move`

```json
{
  "newParentId": "folder-b",
  "afterId": "node-x",
  "beforeId": "node-y",
  "baseSourceParentRevision": "children_r_8",
  "baseTargetParentRevision": "children_r_9"
}
```

请求必须同时发送 Node 的 `If-Match`。即使源和目标是同一 Parent，也必须同时发送 Source / Target Children Revision，此时两值相同。服务器 MUST 在与 Move 相同的事务中验证源 Node、两个 Parent、目标 Parent 的 Root/Folder kind、同 Collection 约束和位置上下文授权，不能只检查 Node 本身；Root 不得通过本端点移动。成功返回更新后的 Node、源 Parent Revision、目标 Parent Revision和 Transform 后的 Position。

<a id="colp-section-9"></a>

## 9. 删除 Node / Subtree

`DELETE /collections/c/{collectionId}/nodes/{nodeId}`

Query 必须通过 `$defs.nodeDeleteQuery`。Boolean 只接受 `true` / `false`，未知参数和重复标量返回 `400 invalid_query`。

- Bookmark、Separator、Alias 或空 Folder 可以直接删除。
- 非空 Folder 若没有 `recursive=true`，返回 `409 folder_not_empty`。
- `recursive=true` 表示 `delete_subtree`，需要 `nodes:delete`。服务器 MUST 在与删除相同的事务中从权威 Parent/Child 关系导出完整子树，对每个成员执行授权与只读检查，并以同一成员集合执行删除、内部 Watermark 和 `affectedCount`；请求或适配器提交的 descendants 列表不能替代该遍历。
- 服务端必须保留每个已删除 ID 的内部删除成员关系，不能只保留根 ID 后允许旧副本更新子项。

成功返回 `200 OK` 和 Deletion Receipt；`receipt.affectedCount` 表示删除范围。超过部署安全阈值时，普通 HTTP 管理界面需要额外确认；MCP 必须走 Plan / Commit。

## 10. Annotation、Attachment 与 Relation

<!-- COLP-REQ PUBLISH-0004 -->

`publisher` 必须提供这些 Sidecar 的最小 CRUD：

```text
POST         /collections/c/{collectionId}/annotations
PATCH/DELETE /collections/c/{collectionId}/annotations/{annotationId}
POST         /collections/c/{collectionId}/attachments
PATCH/DELETE /collections/c/{collectionId}/attachments/{attachmentId}
POST         /collections/c/{collectionId}/relations
PATCH/DELETE /collections/c/{collectionId}/relations/{relationId}
```

Create 使用 `annotationCreate`、`attachmentCreate`、`relationCreate` DTO；不得提交服务器管理字段。PATCH 使用对应 Merge Patch DTO，并遵守 `If-Match`。删除返回 Deletion Receipt。Attachment 端点只管理协议元数据；二进制上传、抓取或对象存储签名 URL 不是本 Profile 的必需能力。

Application Service 必须把这些写入转换为 `create_*` / `update_*` / `delete_*` Canonical Operation。Attachment 使用 `create_attachment`、`update_attachment`、`delete_attachment`；Relation 使用 `create_relation`、`update_relation`、`delete_relation`。HTTP、Sync 和 MCP 不得维护第二套变更语义。

## 11. Release

`POST /collections/c/{collectionId}/release`

请求包含 Release 摘要和 Collection `If-Match`。成功返回 `201 Created`，`Location` 指向不可变 Release：

```text
/collections/c/{collectionId}/releases/{releaseId}
/collections/c/{collectionId}/releases/{releaseId}/snapshot
```

Release Snapshot 必须绑定 Release Revision，并提供 ETag / Content-Digest。历史 Feed Event 不得指向会变化的最新 `/snapshot`。

`GET /collections/c/{collectionId}/releases` 返回 `releaseDirectory`；`GET /collections/c/{collectionId}/releases/{releaseId}` 返回 `releaseResult`。Release 资源不可修改，恢复历史版本必须生成新的 Draft / Operation，不能覆盖历史 Release。

## 12. 幂等重放

<!-- COLP-REQ PUBLISH-0002 -->

服务器对 Idempotency Key 的记录至少保存 Manifest `limits.idempotencyRetentionSeconds`：

- 相同 Principal、Method、Endpoint、Key 和请求摘要：返回第一次请求的相同状态码、Location 和业务结果。
- 相同绑定但请求摘要不同：`409 idempotency_key_reused`，不得执行。
- 正在并发处理同一 Key：只允许一个执行；其他请求等待原结果或返回可重试的 `409 idempotency_in_progress`。
- 去重记录和业务事务必须原子提交，不能出现资源已创建但 Key 记录丢失的窗口。
