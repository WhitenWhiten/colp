# 02. HTTP Publication and Feed Protocol

## 1. 目标

HTTP 层允许任何站点在一个普通路径下公开 Collection。例如：

```text
https://alice.example/collections
```

消费者不需要协议提供方的专用账号，也不需要安装特定客户端。浏览器、Feed Reader、搜索服务、命令行工具和 AI 都可以使用同一组资源。

<a id="colp-section-2"></a>

## 2. Discovery Manifest

`GET /.well-known/collection-protocol`

```json
{
  "protocol": "https://collectionprotocol.org/spec/0.1",
  "protocolVersions": ["0.1"],
  "serverId": "https://alice.example/",
  "serverUuid": "019b3c67-a03c-7f02-9c7e-1ee8d50a77de",
  "title": "Alice's Collections",
  "mounts": [
    {
      "id": "default",
      "baseUrl": "https://alice.example/collections/",
      "profiles": ["core", "publication", "feed", "publisher", "mcp-read", "mcp-write"],
      "endpoints": {
        "directory": "https://alice.example/collections",
        "collection": "https://alice.example/collections/c/{collectionId}",
        "snapshot": "https://alice.example/collections/c/{collectionId}/snapshot",
        "node": "https://alice.example/collections/c/{collectionId}/nodes/{nodeId}",
        "nodes": "https://alice.example/collections/c/{collectionId}/nodes",
        "nodeMove": "https://alice.example/collections/c/{collectionId}/nodes/{nodeId}/move",
        "annotations": "https://alice.example/collections/c/{collectionId}/annotations",
        "annotation": "https://alice.example/collections/c/{collectionId}/annotations/{annotationId}",
        "attachments": "https://alice.example/collections/c/{collectionId}/attachments",
        "attachment": "https://alice.example/collections/c/{collectionId}/attachments/{attachmentId}",
        "relations": "https://alice.example/collections/c/{collectionId}/relations",
        "relation": "https://alice.example/collections/c/{collectionId}/relations/{relationId}",
        "release": "https://alice.example/collections/c/{collectionId}/release",
        "releases": "https://alice.example/collections/c/{collectionId}/releases",
        "releaseItem": "https://alice.example/collections/c/{collectionId}/releases/{releaseId}",
        "releaseSnapshot": "https://alice.example/collections/c/{collectionId}/releases/{releaseId}/snapshot",
        "collectionAccess": "https://alice.example/collections/c/{collectionId}/access",
        "instanceFeed": "https://alice.example/collections/-/feed",
        "collectionFeed": "https://alice.example/collections/c/{collectionId}/feed",
        "mcp": "https://alice.example/collections/-/mcp"
      },
      "features": {
        "feed": { "modes": ["live", "release"] },
        "patch": { "mediaTypes": ["application/merge-patch+json"] },
        "bookmarkUrls": { "acceptedSchemes": ["http", "https", "file"] },
        "mcp": { "resources": true, "tools": true }
      },
      "auth": {
        "anonymousRead": true,
        "apiKeys": true,
        "oauth": true,
        "protectedResourceMetadata": "https://alice.example/.well-known/oauth-protected-resource/collections/-/mcp"
      },
      "limits": {
        "maxPageSize": 200,
        "maxSnapshotNodes": 10000,
        "minPollIntervalSeconds": 60,
        "recommendedPollIntervalSeconds": 300,
        "idempotencyRetentionSeconds": 86400
      }
    }
  ],
  "signing": {
    "httpMessageSignatures": true,
    "jwksUrl": "https://alice.example/.well-known/jwks.json"
  }
}
```

Manifest 响应 SHOULD：

- `Cache-Control: public, max-age=300`
- `ETag`
- `Content-Type: application/vnd.collection-protocol.manifest+json;version=0.1`

规则：

- `serverUuid` 在服务器迁移和重启后保持稳定。
- `baseUrl` 只用于展示与同源判断，MUST 以 `/` 结尾；客户端不得用字符串拼接或 URL 相对解析猜测端点。
- `profiles`、`endpoints`、`features`、`auth` 和 `limits` 均以 Mount 为作用域。
- Endpoint 必须是绝对 HTTPS URI 或 RFC 6570 Level 1 Template。开发环境 MAY 使用 `http://localhost`、`http://127.0.0.1` 或 `http://[::1]`，不得把该例外用于非 Loopback 主机。
- Endpoint Key 的变量集合必须与 Registry 完全一致；例如 `node` 必须恰好使用 `collectionId` 与 `nodeId`。实现使用同一个 RFC 6570 Parser 做验证和展开。
- 客户端必须跟随 `endpoints` 和资源响应中的 `links`。
- `publisher` Profile 必须声明 `nodes`、`node`、`nodeMove`、`annotations`、`annotation`、`attachments`、`attachment`、`relations`、`relation`、`release`、`releases`、`releaseItem` 和 `releaseSnapshot`。
- 支持 HTTP 管理 API 时才声明 `features.admin`，并同时声明 `adminAccess`、`adminKeys`、`adminKey`、`adminKeyRotate`、`adminRateLimits` 和 `adminAudit`；全为 `false` 时应省略整个 Feature。

<a id="colp-section-3"></a>

## 3. Collection Directory

<!-- COLP-REQ PUB-0009 -->

`GET /collections`

查询参数：

- `cursor`
- `limit`
- `tag`
- `creator`
- `kind`
- `updatedSince`
- `q`

响应：

```json
{
  "protocolVersion": "0.1",
  "collections": [
    {
      "id": "collection-1",
      "canonicalUrl": "https://alice.example/collections/interface-systems",
      "title": "Interface Systems",
      "summary": "A curated path into design engineering.",
      "kind": "knowledge_collection",
      "tags": ["design", "engineering"],
      "language": "en",
      "creators": [
        {
          "id": "https://alice.example/about",
          "name": "Alice",
          "url": "https://alice.example/"
        }
      ],
      "nodeCount": 48,
      "updatedAt": "2026-07-16T06:30:00Z",
      "visibility": "public",
      "links": {
        "self": "https://alice.example/collections/c/collection-1",
        "canonical": "https://alice.example/collections/interface-systems",
        "snapshot": "https://alice.example/collections/c/collection-1/snapshot",
        "feed": "https://alice.example/collections/c/collection-1/feed"
      },
      "extensions": {}
    }
  ],
  "nextCursor": null
}
```

规则：

- 只列出 `public` Collection。
- `unlisted` 不得出现在 Directory，但知道 Canonical URL 的客户端可以读取。
- Anonymous Directory、Search、实例 Feed、Sitemap 和 MCP List 均不得重新发现 `unlisted`。其 HTML / HTTP 响应 SHOULD 使用 `X-Robots-Tag: noindex, nofollow` 与 `Referrer-Policy: no-referrer`。
- `protected` MAY 仅在授权后出现在 Directory。
- Directory 不返回完整 ACL。
- 默认排序为 `updatedAt DESC, id ASC`；Cursor 指向最后一项之后的排他位置，并绑定 Principal、过滤器、排序、Limit 和协议版本。
- `nextCursor=null` 表示当前结果集已排空。响应因授权而与匿名结果不同时必须 `private, no-store`，不能进入 Shared Cache。

<a id="colp-section-4"></a>

## 4. Collection Metadata

`GET /collections/c/{collectionId}` 返回 Collection 公共投影与链接。`canonicalUrl` 是面向人的页面，API `self` 是独立 JSON 资源：

响应必须通过 `collectionMetadata`，包含完整 Collection 和 Link，不使用空对象占位。可执行示例见 `examples/collection-metadata.json`。

服务器 SHOULD 同时发送 Link Header：

```http
Link: </collections/c/collection-1>; rel="self"; type="application/vnd.collection-protocol.collection+json"
Link: </collections/interface-systems>; rel="canonical"; type="text/html"
Link: </collections/c/collection-1/snapshot>; rel="https://collectionprotocol.org/rels/snapshot"; type="application/vnd.collection-protocol.snapshot+json"
Link: </collections/c/collection-1/feed>; rel="https://collectionprotocol.org/rels/feed"; type="application/vnd.collection-protocol.feed+json"
Link: </collections/c/collection-1/feed.json>; rel="alternate"; type="application/feed+json"
```

<a id="colp-section-5"></a>

## 5. Snapshot Retrieval

`GET /collections/c/{collectionId}/snapshot`

查询参数：

- `pageCursor`：超大树分页。
- `limit`：节点页大小。
- `include=annotations&include=attachments&include=relations`。数组使用重复参数，不使用逗号分隔。
- `depth`：可选的最大层级。
- `root`：只取某个子树。

所有 Query 先按 `snapshotQuery` 解码再做 Schema 校验。未知参数、重复标量、空值或非法 Boolean / Integer 返回 `400 invalid_query`。

`mode=publication` 中未使用 `redacted=true` 的 Bookmark `url` MUST 是 Authority 不含 Userinfo 的绝对 HTTP(S) URL。该限制同样适用于授权后的 Protected / Private Publication；授权可以决定是否返回目标 URL，但不能使 `user:password@host` 成为可发布 URL。权威 / Sync 表示仍按 `$defs.bookmarkUrl` 保留协商允许的原始 URI。

<a id="colp-section-5-1"></a>

### 5.1 一致性

<!-- COLP-REQ PUB-0004 -->

- 分页 Snapshot 的所有页面 MUST 对应同一个 `snapshotId`、`revision`、`mode`、Principal 和查询作用域。
- `page.sequence` 从 1 连续递增；客户端只能跟随响应提供的 `rel=next` URL，不能并行构造后续 Cursor。
- `page.nextCursor` 必须绑定该 Revision、Principal、`root`、`depth`、`include` 和页面大小，且为排他的下一页位置。
- 有下一页时响应 SHOULD 同时发送 `Link: <...pageCursor=...>; rel="next"`；URL 必须来自服务器，不得由客户端拼接 Cursor。
- 若 Revision 在分页期间过期，服务器返回 `409 snapshot_expired`，客户端重新开始。
- 对静态或较小 Collection，服务器 SHOULD 返回单页完整 Snapshot。
- `syncCursor` 不得用于分页；公共 Snapshot 不得返回 Sync Cursor。
- 没有 `root`、`depth` 裁剪，且未使用 `include` 或 `include` 明确覆盖 annotations、attachments、relations 全部权威数组的逻辑 Snapshot 使用 `complete=true`，无论是否分页。客户端取得全部页面前仍不得执行 destructive replace / mirror。省略任一权威数组的裁剪响应使用 `complete=false`。

### 5.2 缓存

```http
ETag: "snapshot-public-r_1042-p1-7f2c"
Cache-Control: public, max-age=60
Content-Digest: sha-256=:...:
```

对于 Protected Collection，默认：

```http
Cache-Control: private, no-store
Vary: Authorization
```

ETag 标识实际表示和页面。不同 `include`、`depth`、`root`、Principal、媒体类型或分页位置不得复用同一 ETag。

访问策略可能收紧的可变 Snapshot 不应使用 `stale-while-revalidate`。长期公共缓存应优先使用不可变 Release Snapshot URL；Public → Private / Delete 时服务端必须清理自己控制的 CDN 与 Shared Cache。

<a id="colp-section-6"></a>

## 6. Feed Event Model

<!-- COLP-REQ FEED-0001 -->

Feed Event 与 CloudEvents 1.0 兼容：

Feed 中出现的 Bookmark 导航 URL MUST 是 Authority 不含 Userinfo 的绝对 HTTP(S) URL；不能安全投影的目标必须省略或使用不含目标 URL 的 Redacted 摘要。

```json
{
  "specversion": "1.0",
  "id": "019b3d0b-...",
  "source": "https://alice.example/collections",
  "type": "org.collectionprotocol.node.created.v1",
  "subject": "collections/c/collection-1/nodes/node-9",
  "time": "2026-07-16T06:30:00Z",
  "datacontenttype": "application/json",
  "collectionprotocolversion": "0.1",
  "data": {
    "collectionId": "collection-1",
    "node": {
      "id": "node-9",
      "kind": "bookmark",
      "title": "New resource",
      "url": "https://example.com/article"
    }
  }
}
```

标准 Event Type：

- `org.collectionprotocol.collection.created.v1`
- `org.collectionprotocol.collection.updated.v1`
- `org.collectionprotocol.collection.deleted.v1`
- `org.collectionprotocol.release.published.v1`
- `org.collectionprotocol.node.created.v1`
- `org.collectionprotocol.node.updated.v1`
- `org.collectionprotocol.node.moved.v1`
- `org.collectionprotocol.node.deleted.v1`
- `org.collectionprotocol.annotation.published.v1`
- `org.collectionprotocol.access.publication_changed.v1`

Access Event 只能说明公开状态发生变化，不得携带 Key、内部 Principal 或私人规则。

每个标准 Event Type 的 `data` 使用精确判别合同：Release 必须带 `releaseId`、不可变 Snapshot URL、Digest 与 Change Counts；Node 事件只使用脱敏的 `feedNode`；Delete 只携带 Node ID 和必要摘要。核心事件不允许任意额外字段。扩展事件的 `type` 必须是 HTTPS URI，数据只能进入命名空间 `extensions`。

## 7. Feed Response

`GET /collections/c/{collectionId}/feed?cursor=...&limit=50`

首次请求省略 Cursor 时默认返回“保留窗口内最新一页”，事件仍按提交顺序升序排列。客户端可显式使用 `from=now` 只取得当前 Checkpoint，或在服务器允许时使用 `from=beginning` 从最早保留事件开始；`from` 与 `cursor` 不得同时出现。

```json
{
  "protocolVersion": "0.1",
  "feedUrl": "https://alice.example/collections/c/collection-1/feed",
  "collectionUrl": "https://alice.example/collections/interface-systems",
  "title": "Interface Systems updates",
  "events": [],
  "nextCursor": "feed_01JZ...",
  "hasMore": false,
  "poll": {
    "notBefore": "2026-07-16T06:35:00Z",
    "recommendedAfterSeconds": 300
  },
  "hubs": []
}
```

### 7.1 Cursor

<!-- COLP-REQ FEED-0002 -->

- Feed Cursor 与 Sync Cursor 不是同一个命名空间。
- Feed Cursor 是不透明字符串。
- 请求 Cursor 表示“从该 Checkpoint 之后开始”，边界是排他的。响应事件按服务器提交顺序升序排列。
- `nextCursor` 是处理完本响应后的新 Checkpoint，即使 `events` 为空也可以前进。`hasMore=true` 时客户端应立即继续拉取，否则按 Poll Hint 等待。
- Cursor 必须绑定 Principal、Feed、过滤器和协议版本，跨上下文复用必须拒绝。
- 客户端应该只在全部事件持久化后保存 `nextCursor`。
- Feed 投递语义是至少一次。Event ID 在服务器内稳定且不复用；客户端必须按 Event ID 幂等去重。
- 服务端可压缩旧 Feed；Cursor 过期时返回 `410 feed_cursor_expired`，并提供最新 Snapshot URL。

<a id="colp-section-7-2"></a>

### 7.2 Feed Mode

`live` 模式：

- 允许公开 Node Create / Update / Move / Delete。
- 服务器可以在短时间窗口合并连续 Update。

`release` 模式：

- 内部编辑不产生公共事件。
- `POST /release` 生成 `release.published`。
- Event Data 包含 Release 摘要、Change Count、Snapshot URL 和 Release Revision。
- Release Snapshot URL MUST 指向不可变资源，例如 `/c/{collectionId}/releases/{releaseId}/snapshot`，并提供 Digest。不得只指向会随最新状态变化的 `/snapshot`。

对个人策展人，`release` 是默认推荐模式，可以避免关注者被拖拽、改标题等细小操作刷屏。

<a id="colp-section-8"></a>

## 8. JSON Feed 1.1 表示

实现 MAY 提供：

```text
/collections/-/feed.json
/collections/c/{id}/feed.json
```

Content-Type：`application/feed+json`

映射：

| Collection Protocol | JSON Feed 1.1 |
|---|---|
| Feed URL | `feed_url` |
| Collection Canonical URL | `home_page_url` |
| Creator | `authors` |
| Event ID | `items[].id` |
| Event Time | `date_published` |
| Event Subject URL | `url` |
| Bookmark URL | `external_url` |
| Event Summary | `content_text` / `summary` |
| Collection Tags | `tags` |
| Attachment | `attachments` |

核心 Feed Event 不包含 Attachment Payload。JSON Feed 表示层从发布者显式提供、按 Event ID 关联的 Attachment 投影元数据生成 `items[].attachments`，不从 Event 的未知字段推断 Attachment，也不为此扩展当前 Event Schema。每项投影元数据包含 JSON Feed 1.1 要求的绝对 HTTP(S) `url` 和 `mime_type`；未知 Event ID 或非法元数据使该次映射失败，输出不保留调用方可变引用。

协议专有数据放入 `_collection_protocol` Extension。

JSON Feed 是传播兼容层，不得用于双向同步。

<a id="colp-section-9"></a>

## 9. Atom 表示

实现 MAY 提供 Atom 1.0。Atom Entry ID 必须稳定，Bookmark 外部 URL 使用 `rel=related`，事件或 Collection 页面使用 `rel=alternate`。

<a id="colp-section-10"></a>

## 10. WebSub

实现 MAY 在 Feed 中声明 WebSub Hub：

```json
{
  "hubs": [
    {
      "type": "WebSub",
      "url": "https://hub.example/"
    }
  ]
}
```

WebSub 通知只表示“Feed 已变化”。订阅者收到通知后仍应使用条件 GET 拉取 Feed，不应把通知正文作为权威数据。

<a id="colp-section-11"></a>

## 11. 轮询与缓存行为

客户端 MUST：

- 遵守 Manifest 的 `minPollIntervalSeconds`。
- 优先使用 ETag 与 `If-None-Match`。
- 遇到 `429` 使用 `Retry-After`。
- 对 `5xx` 使用指数退避与随机抖动。
- 不因用户打开页面而绕过后台轮询限制。
- 多个本地订阅 SHOULD 合并为单次实例级请求，避免 N+1 轮询。

建议退避：

```text
delay = min(serverMax, base * 2^attempt) + random(0, jitter)
```

成功响应后使用服务器推荐间隔重置退避。

<a id="colp-section-12"></a>

## 12. 静态托管模式

只读 Publisher 可以把以下文件部署为静态 JSON：

```text
/.well-known/collection-protocol
/collections/index.json
/collections/items/{id}/index.json
/collections/items/{id}/snapshot.json
/collections/items/{id}/feed.json
```

静态模式：

- MUST 声明 `profiles=["core", "publication"]`，提供 Feed 时额外声明 `feed`。
- MUST 在 Manifest `endpoints` 中声明上述真实绝对文件 URL / Template；客户端不执行路径推断。
- 不提供写入、Sync 或远程 MCP Tools。
- 可以提供只读 MCP Server 作为独立进程读取这些文件。
- 使用 CDN ETag、Cache-Control 和可选 HTTP Signature。

<a id="colp-section-13"></a>

## 13. 删除与消失

- Collection 删除时 Feed 发布 `collection.deleted`。
- 服务器 SHOULD 在原 Canonical URL 返回 `410 Gone`，并保留最少 30 天。
- `410` 响应 SHOULD 指向归档、迁移地址或 Owner 页面。
- Node 删除事件只公开 Node ID 和必要摘要，不公开私人删除原因。

## 14. 迁移

Collection 迁移到新服务器时：

- 原地址返回 `308 Permanent Redirect` 或 `410` + `movedTo`。
- Manifest 或 Collection Metadata 提供新的 Canonical URL。
- 新服务器保留 Collection ID 或提供 `formerIds`。
- Feed 发布 `collection.moved` Extension Event。
- 消费者必须防止无限重定向和跨域凭据泄漏，Authorization Header 不得自动转发给未信任的新 Origin。
