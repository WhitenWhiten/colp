# 01. Core Data Model

## 1. 设计目标

核心模型同时满足两类需求：

- 传统浏览器收藏夹：树、文件夹、顺序、标题、URL、时间、特殊根目录和受管节点。
- 知识集合：公开说明、标签、笔记、摘要、附件、关系、阅读状态、分级可见性和来源引用。

核心字段保持小而稳定；平台专有信息进入 Namespace Extension。

## 2. Collection

```json
{
  "schemaVersion": "0.1",
  "id": "019b3ca2-8424-7cc2-9a61-4bf44c23f07a",
  "canonicalUrl": "https://alice.example/collections/interface-systems",
  "slug": "interface-systems",
  "kind": "knowledge_collection",
  "title": "Interface Systems",
  "summary": "A curated path into design engineering.",
  "description": {
    "format": "markdown",
    "value": "Start with layout primitives..."
  },
  "language": "en",
  "tags": ["design", "engineering"],
  "icon": {
    "url": "https://alice.example/media/interface-icon.png",
    "mimeType": "image/png"
  },
  "cover": {
    "url": "https://alice.example/media/interface-cover.webp",
    "mimeType": "image/webp"
  },
  "creators": [
    {
      "id": "https://alice.example/about",
      "name": "Alice",
      "url": "https://alice.example/",
      "avatar": "https://alice.example/avatar.png"
    }
  ],
  "rootNodeId": "019b3ca2-9a3f-7e07-8f18-cc4f2cb4bca8",
  "visibility": "public",
  "publication": {
    "feedMode": "release",
    "includeNodeContent": "summary",
    "includeRelations": true
  },
  "createdAt": "2026-07-01T09:00:00Z",
  "updatedAt": "2026-07-16T06:30:00Z",
  "revision": "r_1042",
  "eventCursor": "cur_01JZ...",
  "extensions": {}
}
```

### 2.1 必需字段

| 字段 | 类型 | 规则 |
|---|---|---|
| `schemaVersion` | string | 当前为 `0.1` |
| `id` | string | 稳定、不复用 |
| `kind` | enum | bookmarks / reading_path / knowledge_collection / mixed |
| `title` | string | 可以为空字符串，但字段必须存在 |
| `rootNodeId` | string | 指向 kind=root 的 Node |
| `visibility` | enum | public / unlisted / protected / private |
| `createdAt` | date-time | RFC 3339 |
| `updatedAt` | date-time | RFC 3339 |
| `revision` | string | 不透明版本 |

### 2.2 Publication Policy

`publication.feedMode`：

- `live`：公开 Node 变更可逐条进入 Feed。
- `release`：只有显式 Release 进入 Feed。
- `disabled`：没有公共 Feed，但 Snapshot 仍可按访问策略读取。

`includeNodeContent`：

- `metadata`：只发布标题、URL、来源和标签。
- `summary`：额外发布公开 Summary / TL;DR。
- `full`：可发布公开正文或附件。服务器必须再次检查附件可见性与版权策略。

## 3. Node

```json
{
  "id": "019b3ca4-cb18-7a4f-b8c5-76fa50fd0ea2",
  "collectionId": "019b3ca2-8424-7cc2-9a61-4bf44c23f07a",
  "kind": "bookmark",
  "parentId": "019b3ca2-9a3f-7e07-8f18-cc4f2cb4bca8",
  "position": "a0V",
  "title": "Radix Primitives",
  "url": "https://github.com/radix-ui/primitives",
  "canonicalUrl": "https://github.com/radix-ui/primitives",
  "urlHash": "sha-256=:uZN+eomhBcN5ZOiZABp/qpHVu4Be33EHus9yORGX1VE=:",
  "description": "Accessible UI primitives.",
  "tags": ["components", "accessibility"],
  "createdAt": "2026-07-01T09:20:00Z",
  "updatedAt": "2026-07-15T10:00:00Z",
  "lastUsedAt": "2026-07-16T05:02:00Z",
  "revision": "r_1041",
  "visibility": "inherit",
  "constraints": {
    "readOnly": false,
    "reason": null
  },
  "sourceRefs": [
    {
      "system": "chromium",
      "replicaId": "019b3dd0-7636-770a-a789-bf62d3eb91cc",
      "profileId": "prf.r1.cUHbd3dJu1MKBsqkDhmRbJgdWH2jo6SefIZ6V4hR9qg",
      "nativeId": "431",
      "nativeParentId": "1",
      "nativeIndex": 4,
      "rootRole": "bookmarks-bar",
      "syncing": true,
      "capturedAt": "2026-07-16T05:10:00Z"
    }
  ],
  "extensions": {
    "https://example.com/ns/repository-metadata/v1": {
      "sourceType": "github",
      "stars": 18400,
      "forks": 1100,
      "language": "TypeScript"
    }
  }
}
```

### 3.1 通用字段

| 字段 | 适用 | 说明 |
|---|---|---|
| `id` | 全部 | 协议主 ID |
| `collectionId` | 全部 | 所属 Collection |
| `kind` | 全部 | root / folder / bookmark / separator / alias |
| `parentId` | 非 root | 父 Node ID |
| `position` | 非 root | 服务器生成的同级顺序键 |
| `title` | root/folder/bookmark/alias | 显示名称 |
| `url` | bookmark | 用户收藏的原始绝对 URI，通过 `$defs.bookmarkUrl`；权威 / Sync 可保留协商过的本地 Scheme |
| `urlHash` | bookmark 可选 | `sha-256=:<base64>:`；对同一对象 `url` 原始字符串的 UTF-8 Octets 计算 SHA-256，仅用于筛选查重候选 |
| `targetNodeId` | alias | 被引用 Node |
| `createdAt` | 全部 | 创建时间 |
| `updatedAt` | 全部 | 最后内容更新时间 |
| `childrenModifiedAt` | root/folder | 子项集合最后更新时间 |
| `lastUsedAt` | bookmark/alias | 最近打开时间 |
| `deletedAt` | Tombstone | 逻辑删除时间 |
| `revision` | 全部 | 条件写入版本 |
| `visibility` | 非 root 可选 | inherit / protected / private；默认 inherit，只能收紧祖先权限 |
| `redacted` | Publication 投影可选 | `true` 表示这是受限对象的安全占位，不是权威 Node |
| `accessUrl` | redacted Node 可选 | 面向用户的登录、授权或订阅页面；不得包含 Secret |

Annotation、Attachment 和 Relation 不内嵌在 Node 中。Canonical Snapshot 只在顶层数组保存一份权威对象。Node Detail API 可以通过 `included` 临时展开相关对象，但对象 ID 与 Revision 必须与顶层表示一致。

跨服务器携带资源引用时，使用 `colp:/resources/~{serverUuid}/{resourceType}/~{id}` 表示完整全局身份。
例如 `colp:/resources/~Server.A/node/~..` 精确表示 `("Server.A", "node", "..")`；它与
`("server.a", "node", "..")` 不相等。Authority-free 形式避免 URI Host 的大小写归一化，值段的
`~` 前缀避免合法的 `.` 和 `..` Wire ID 被解析为路径遍历。Snapshot 内已有的 Parent、Alias、Subject、
Relation 和 Provenance 裸 ID 仍由 Snapshot 的同 Collection 上下文解析，不扩大其引用范围。
该全局身份 URI 不等同于 MCP Profile 的 `colp://{serverUuid}/...` Resource Locator；后者带 Authority，
定位 MCP 表示或操作，且不作为全局身份 URI 的另一种串行化形式。

`redacted=true` 只允许出现在 `mode=publication` 的投影。Bookmark 可省略 `url`，但必须保留稳定 `id`、`collectionId`、`parentId`、`position`、`title`、`revision`，并显式使用 `protected` 或 `private` 的收紧 `visibility`。Sync Snapshot、写入响应和权威存储表示不得包含 redacted Node。

`urlHash` 缺失是合法的，不会导致 Bookmark 被拒绝或被赋予不同身份。出现时，其值是同一
Bookmark 中未重写 `url` 的匹配 Digest，且不会替代或改变 `url`。相等 Hash 只表示应进一步比较
URL、内容和 Collection 语义的候选，不建立 Node 相等关系，也不进入任何对象 ID 或引用字段。

<a id="colp-section-3-2"></a>

### 3.2 顺序

<!-- COLP-REQ CORE-0006 -->

- `position` 是可排序的不透明 ASCII Token，匹配 `^[0-9A-Za-z_-]{1,128}$`。
- 客户端 MUST 按无符号 ASCII Octet 顺序比较，但不得自行解释其结构。限制字符集可避免 JavaScript UTF-16 与其他语言 Unicode 排序不一致。
- 客户端创建或移动 Node 时 SHOULD 提交 `afterId` / `beforeId`，由服务器分配 Position。
- Snapshot MAY 提供派生的 `index`，但 Sync 不得依赖 Index，因为并发插入会使其漂移。

`index` 是非 Root Node 在整个逻辑 Snapshot 投影中、同一 `parentId` 下按 `position` 排序后的 I-JSON 安全零基整数。Root 可省略 `index` 或使用 `null`，不得虚构 Sibling 序号。分页不重置序号，裁剪或稀疏投影只对投影中实际表示的 Sibling 编号；服务端无法确定完整投影内的 Sibling 集合时应省略它。

`index` 只是显示提示而非 Node 的权威字段。Sync 不得要求、比较或持久化它作为权威状态，不得用它决定顺序；接收方必须忽略陈旧或被篡改的值，并始终以无符号 ASCII Octet 顺序比较 `position`。
- 服务器可在不改变可见顺序的情况下重平衡 Position；重平衡必须原子推进 Collection State Revision 并进入 Sync Log，但不应产生用户级 Feed 事件。

<a id="colp-section-3-3"></a>

### 3.3 Root 与 Folder Role

浏览器特殊根目录通过 `folderRole` 表达：

- `root`
- `bookmarks-bar`
- `other-bookmarks`
- `mobile-bookmarks`
- `managed-bookmarks`
- `archive`
- `inbox`
- `recovered`
- `custom`

`bookmarks-bar` / `other-bookmarks` / `mobile-bookmarks` 在每个 Collection 中至多一个活动 Folder。`recovered` 按所属 parent（mount 或 Collection-root fallback）唯一，不得按 Collection 全局复用。

`managed-bookmarks` MUST 默认为只读。

该规则适用于实际接受、存储或修改 `managed-bookmarks` Folder Role 的组件。支持普通权威 Node 写入不自动表示部署支持该可选角色；未启用该角色的部署可以在输入边界拒绝它，不得为证明通用写事务而伪造 Managed Bookmark 数据。Publisher 与 Sync 均提供可能读取或应用该角色的通用 Node 变更面，因此其权威写入边界包含默认只读约束。

<a id="colp-section-4"></a>

## 4. Source Reference

Source Reference 用于往返转换和防止同步回环。

```json
{
  "system": "firefox",
  "adapterVersion": "1.2.0",
  "replicaId": "019b3dd0-7636-770a-a789-bf62d3eb91cc",
  "profileId": "prf.r1.cUHbd3dJu1MKBsqkDhmRbJgdWH2jo6SefIZ6V4hR9qg",
  "nativeId": "toolbar_____",
  "nativeParentId": "root________",
  "nativeIndex": 0,
  "nativeCreatedAt": 1752647400123,
  "nativeModifiedAt": 1752647420456,
  "nativeType": "folder",
  "rootRole": "bookmarks-bar",
  "syncing": null,
  "capturedAt": "2026-07-16T06:00:00Z"
}
```

规则：

本节的 Profile ID 规则适用于实际创建、保存或派生 Source Reference Profile ID 的组件。本地随机 Profile ID 持久化属于浏览器 / Adapter 角色；服务端 HMAC 与密钥轮换属于启用该派生方式的服务端角色。只消费不含 Source Reference 的 Publication 投影的部署不承担这些角色。

- `profileId` 不得上传原始操作系统路径或本地 Profile 标识。
- `profileId` SHOULD 使用随机标识或服务端带密钥 HMAC；低熵本地标识不得直接使用裸 Hash。
- 随机标识 MUST 使用 CSPRNG 一次生成并随本地 Profile 持久化。
- HMAC 派生包含服务端与租户域分离，并在结果中携带密钥版本标识。
- HMAC 输入 MUST 使用无歧义的确定性字节编码；服务端密钥 MUST NOT 发送给客户端或写入日志。密钥轮换使用版本到密钥的受控映射。
- `nativeCreatedAt` / `nativeModifiedAt` 统一为 Unix Epoch Milliseconds 整数；没有值时使用 `null`，不得发送无单位 Number 或日期 String。
- Source Reference 归属于 `(principal, replicaId, nodeId)` 私有映射。Wire 响应只返回当前授权 Replica 自己的 Mapping，不能把其他用户或设备的 Native ID 聚合返回。
- 同一 Node 可以在权威存储中有多个 Source Reference，表示多个副本上的映射，但它们不是共享 Node 的公共字段。
- Source Reference 默认是私有同步数据，不进入公共 Snapshot 或 Feed。
- 删除浏览器节点后，映射至少保留到 Tombstone 到期。

## 5. Annotation

```json
{
  "id": "019b3ca6-0f4e-7a28-a141-013e05048ff4",
  "collectionId": "019b3ca2-8424-7cc2-9a61-4bf44c23f07a",
  "subject": {
    "type": "node",
    "id": "019b3ca4-cb18-7a4f-b8c5-76fa50fd0ea2"
  },
  "type": "note",
  "format": "markdown",
  "value": "Read after the layout primitives section.",
  "visibility": "private",
  "creator": {
    "id": "https://alice.example/about",
    "name": "Alice"
  },
  "createdAt": "2026-07-15T02:00:00Z",
  "updatedAt": "2026-07-15T02:00:00Z",
  "revision": "r_909",
  "provenance": {
    "kind": "human"
  }
}
```

<a id="colp-section-5-1"></a>

### 5.1 Provenance

本节的权威性要求适用于实际创建或修改 AI 内容的写入部署。只读取或发布既有投影的部署不因此获得 AI 写入角色，也不需要提供 AI Annotation 写事务。

AI 生成内容 MUST 带 Provenance：

```json
{
  "provenance": {
    "kind": "ai",
    "provider": "user-configured",
    "model": "optional-model-name",
    "generatedAt": "2026-07-15T02:00:00Z",
    "editedByHuman": true,
    "sourceNodeIds": ["node-1", "node-2"]
  }
}
```

协议不要求暴露具体模型名称。公开投影是否保留模型信息由 Collection Policy 决定，但 `kind=ai` 不应被静默改写为 human。

以下规则适用于权威写入，不限制 Publication Policy 从投影中省略可选的 `provider` 或 `model`：

- 对既有 `kind=ai` Annotation 执行 Human、Imported 或 Derived 来源的写入时，接收方 MUST 从当前权威资源原样保留 `kind`、`provider`、`model`、`generatedAt` 和 `sourceNodeIds`；请求中的同名字段不能覆盖、删除或补写这些值。
- 服务端 MUST NOT 把反序列化请求体、调用方构造的普通 Validation Context 或 caller-provided Provenance 当作可信 AI generation context。只有服务端可信 AI 执行边界创建的 context 可以替换上述 AI 身份字段。
- 当可信 Human 写入改变 Annotation 的 `format` 或 `value` 时，服务端 MUST 将 `editedByHuman` 设为 `true`；后续非 AI 写入不能把已经为 `true` 的值清除或降为 `false`。

### 5.2 Reading State

```json
{
  "type": "reading_state",
  "visibility": "private",
  "value": {
    "status": "in_progress",
    "progress": 0.42,
    "completedAt": null
  }
}
```

Reading State 通常是每用户数据。多用户服务器必须将其与 Principal 绑定，而不是写入公共 Node 主记录。

`subject.type` 只能是 `collection` 或 `node`。Subject 必须存在于同一 `collectionId`；公共投影中的 Creator 使用公开 Actor URI，不得泄漏内部 Principal ID。

## 6. Attachment

```json
{
  "id": "019b3ca7-...",
  "collectionId": "019b3ca2-8424-7cc2-9a61-4bf44c23f07a",
  "subject": {
    "type": "node",
    "id": "019b3ca4-cb18-7a4f-b8c5-76fa50fd0ea2"
  },
  "rel": "snapshot",
  "url": "https://alice.example/media/article.mhtml",
  "mimeType": "multipart/related",
  "title": "Offline snapshot",
  "size": 483920,
  "digest": "sha-256=:base64digest:",
  "visibility": "private",
  "createdAt": "2026-07-15T03:00:00Z",
  "updatedAt": "2026-07-15T03:00:00Z",
  "revision": "r_910"
}
```

常见 `rel`：

- `icon`
- `favicon`
- `thumbnail`
- `cover`
- `snapshot`
- `archive`
- `transcript`
- `alternate`
- `enclosure`

服务器不得因为 Node 公开就自动公开附件。

Netscape `ICON=data:` 等内联二进制不是可移植 Attachment URL。Adapter 应解码、限制大小、计算 Digest 并写入受控 Blob / 对象存储后生成 HTTP(S) URL；无法物化时保留在来源 Extension 并返回 `favicon_sidecar_only`，不得把任意 `data:` URI放入权威 Attachment。

## 7. Relation

```json
{
  "id": "019b3ca8-...",
  "collectionId": "019b3ca2-8424-7cc2-9a61-4bf44c23f07a",
  "type": "related",
  "fromNodeId": "node-a",
  "toNodeId": "node-b",
  "label": "Explains the layout principle used by",
  "visibility": "public",
  "createdAt": "2026-07-15T03:20:00Z",
  "updatedAt": "2026-07-15T03:20:00Z",
  "revision": "r_911"
}
```

核心 Relation Type：

- `related`
- `precedes`
- `follows`
- `supports`
- `contradicts`
- `duplicate_of`
- `derived_from`
- `mentions`
- `custom`

Relation 不改变树结构。阅读路径可同时使用 Position 和 `precedes`，但 Position 是默认展示顺序的权威来源。

`kind=reading_path` 且只有一条路径时，Root 下的 Position 是核心路径顺序。在 `mixed` / `knowledge_collection` 中维护路径子集或多条路径时，应使用具有公开 Schema 的 Namespace Extension 保存 membership 与独立 order；不得把该顺序写回树 Position 或复制成第二棵权威 Node 树。

## 8. Sync Tombstone

删除对象在同步层表示为 `$defs.syncTombstone`。Publisher HTTP 删除响应使用独立的 `$defs.deletionReceipt`，不包含 Sync Cursor：

```json
{
  "resourceType": "node",
  "targetId": "node-9",
  "collectionId": "collection-1",
  "scope": "single",
  "deletedAt": "2026-07-16T06:00:00Z",
  "deletedBy": "principal_alice",
  "deleteRevision": "r_1050",
  "operationId": "op_delete_node_1050",
  "deleteCursor": "sync_01K2...",
  "affectedCount": 1,
  "purgeAfter": "2026-08-15T06:00:00Z"
}
```

- Tombstone 最低保留期由 Manifest 声明，Sync Server 推荐不少于 30 天。
- 在保留期内，旧副本的 Update 不得静默复活对象。
- 恢复必须使用显式 `restore_node` Operation。
- `resourceType` 支持 collection / node / annotation / attachment / relation；`scope=subtree` 时 `affectedCount` 表示删除范围。
- Live Array 与 Tombstone 的 `(resourceType, targetId)` 必须互斥。
- 服务端在 Purge 前必须保留足以 Restore 的 Prior Representation 和私有 Mapping；Purge 后 Restore 返回 `410 resource_purged`。

## 9. Snapshot

Snapshot 必须通过 `$defs.snapshot`，包含完整 Collection 表示和规范化顶层数组，不允许用空对象代表省略内容。可执行的 Publication、Protected Publication 和 Sync 示例分别见 `examples/collection-snapshot.json`、`examples/protected-publication-snapshot.json` 与 `examples/sync-snapshot.json`。

`mode=publication` 的 Snapshot 不包含 Tombstone、Source Reference 和内部 ACL；`syncCursor` 也不得出现。它既可用于匿名公开表示，也可用于授权后的 protected / private 安全投影，具体对象仍由 Scope / ACL 决定。`mode=sync` 需要授权，并按 Scope / ACL 过滤 Sidecar。

`complete=true` 表示请求没有通过 `root`、`depth` 或 `include` 排除权威对象；它可以跨多个 HTTP 页面。用于权威替换、Bootstrap 或灾难恢复时，客户端必须先验证全部页面共享同一 `snapshotId` 与 `revision`、`page.sequence` 连续、对象 ID 无重复，并且最后一页 `page.hasMore=false`。裁剪投影必须 `complete=false`，不能触发缺失对象删除。

HTTP `Content-Digest` 校验实际响应字节。可选的体内 `contentDigest` 只允许出现在 `complete=true`、`page.sequence=1`、`page.hasMore=false` 的单页逻辑 Snapshot，使用 `sha-256=:<base64>:` 语法；摘要覆盖按 RFC 8785 Canonical JSON 序列化且排除 `contentDigest` 字段自身的整个 Snapshot。分页或裁剪 Snapshot 不得携带体内 `contentDigest`。分页 Snapshot 的每页 ETag / HTTP `Content-Digest` 独立，不能复用仅由 Collection Revision 生成的值；HTTP 字段与体内逻辑摘要不是同一覆盖范围。

<a id="colp-section-10"></a>

## 10. 未知字段与往返保证

<!-- COLP-REQ CORE-0008 -->

本节的 Sync 往返规则适用于承担 Sync Server 或等价 Sync Extension 存储角色的部署；`core` 数据语义依赖本身不使只读 Publication 部署成为 Sync Server。

- 同一精确协议版本的核心对象顶层未知字段 MUST 被严格校验器拒绝。
- 需要向前扩展和往返保留的数据 MUST 放入 `extensions`。
- Sync Server 不理解的 Extension MUST 原样存储和转发。
- Adapter 删除或降级 Extension 时 MUST 产生 `lossy_conversion` Warning。

<a id="colp-section-11"></a>

## 11. 数据校验

<!-- COLP-REQ CORE-0009 -->

<!-- COLP-REQ CORE-0007 -->

<!-- COLP-REQ CORE-0005 -->

<!-- COLP-REQ CORE-0004 -->

<!-- COLP-REQ CORE-0003 -->

- 所有对象在写入前 MUST 先通过 JSON Schema 结构校验，再通过语义校验。
- Bookmark URL 的结构 Schema 禁止可执行的 `javascript`、`vbscript`、`data` Scheme；Mount 的 `features.bookmarkUrls.acceptedSchemes` 再限制实际可写 Scheme。默认允许 `http`、`https`，本地实现可增加 `file`、`about`、`chrome`、`edge`、`moz-extension` 等，但 Publication / Feed 不得返回非 HTTP(S) URL。
- 任何创建或改变 Parent Edge 的权威 Node 写入 MUST 在与持久化相同的事务或锁定快照中解析受影响 Node 与目标 Parent，并验证二者属于同一 Collection 且目标 Parent 的 `kind` 是 `root` 或 `folder`。
- 普通 Node 创建、移动、重挂载或恢复操作 MUST NOT 创建新的 `root`、改变现有 Root 的 Parent，或使非 Root Node 的 `parentId` 变为 `null`；唯一 Root 只能随 Collection 原子创建。
- 服务器 MUST 防止 Parent Cycle。
- `root` 不得有 Parent。
- `bookmark` 必须有 URL。
- `folder`、`root`、`separator` 不得有 URL。
- `alias` 必须有 `targetNodeId`，且目标不得形成 Alias Cycle。
- Annotation 与 Attachment 的可见性不得宽于父对象。
- Snapshot 必须恰好包含一个 Root，且 `collection.rootNodeId` 指向它。
- 所有 Node、Annotation、Attachment 和 Relation 必须属于同一 Collection。
- Live ID 与 Tombstone ID 不得重叠；同一 Parent 下 Position 必须非空且唯一。
- Parent、Alias、Subject、Relation 和 Provenance 引用必须存在于同一 Snapshot 或可解析的同 Collection 资源中。
- `delete_subtree` MUST 在与删除相同的事务或锁定快照中从权威 Parent/Child 关系导出完整成员集合，对集合中的每个 Node 执行授权、只读约束和删除策略，并使用同一集合持久化删除及 `affectedCount`；调用方或适配器提供的不完整 descendants 列表不是权威删除计划。
- I-JSON 接收边界 MUST 在构造业务对象之前执行确定的最大嵌套深度与成员/数组项预算；依赖 JavaScript 调用栈自然溢出不构成深度控制。
- Parent Ancestry 与 Subtree 遍历 MUST 执行确定的最大深度和最大访问 Node 数预算，并在超限时于任何持久化前失败关闭。
- 远端输入 MUST NOT 提高实现或部署配置的解析、Ancestry 或 Subtree Hard Limit。具体数值由部署在实现上限内选择；HTTP 超限使用 `413 payload_too_large`，非 HTTP 边界返回稳定的 limit denial。
