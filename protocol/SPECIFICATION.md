# The Collection Protocol Specification 0.1-draft

## 1. 规范语言

本文中的 `MUST`、`MUST NOT`、`SHOULD`、`SHOULD NOT` 和 `MAY` 按 BCP 14 的含义解释。

Wire 格式中的字段、端点、错误码和 Scope 使用英文；说明文档使用中文。

本规范仍处于 `0.1-draft`。Draft 期间允许修正不一致的 Wire Contract；实现不得把 Draft 当作稳定发布版。未发布 tag、未对外承诺稳定性的私有 development 包不建立 `0.1` 兼容性基线。首次稳定发布必须在发布记录中确认此前是否存在对外稳定的 `0.1` Validator 或 Wire 实现：若不存在，可以把修正后的 Draft 冻结为初始基线；若存在，则按第 12 节选择新的 Minor 或 Major 版本，不能继续复用 `0.1`。首个实现应遵循 [Practical Interoperability Profile](docs/00-practical-profile.md)。

## 2. 协议范围

The Collection Protocol 定义五个相互独立但可组合的层：

1. **Core Data Model**：Collection、Node、Annotation、Attachment、Relation、Access Policy。
2. **Publication Protocol**：通过 HTTP 发现、读取、缓存和传播 Collection。
3. **Synchronization Protocol**：可信副本之间推送、拉取、转换、冲突处理和删除传播。
4. **Security Profile**：API Key、OAuth、ACL、Rate Limit、签名和审计。
5. **MCP Profile**：把前四层映射为 MCP Resources、Tools 和订阅通知。

实现可以只支持 Core 与 Publication。实现声称支持 Sync 或 MCP 时，必须满足对应文档中的完整 Profile。

本协议不定义网页抓取、全文归档、搜索排名、推荐算法、支付、DRM 或跨服务器分布式事务。这些能力必须作为独立扩展，不得改变核心交换语义。

## 3. 三类数据语义

<a id="colp-section-3-1"></a>

### 3.1 Snapshot

Snapshot 是某个 Collection 在一个确定 Revision 上的完整规范化状态。

- 用于首次导入、灾难恢复、静态托管和校验。
- Snapshot MUST 带 `snapshotId`、`mode`、`complete`、`revision`、`generatedAt`、分页状态和内容摘要策略。`complete` 表示查询选择的是完整逻辑 Snapshot，而不是当前 HTTP 页面是否为最后一页。
- 完整逻辑 Snapshot 可以分页。接收方只有在持久化同一 `snapshotId`、`revision` 和查询作用域的全部页面，并收到 `page.hasMore=false` 后，才可原子替换本地状态。
- Snapshot 中的 Node 采用扁平数组，通过 `parentId` 与 `position` 表达层级和顺序。
- Annotation、Attachment 和 Relation 只在 Snapshot 顶层数组中出现一次；Node 不内嵌第二份权威副本。
- `page.nextCursor` 只用于 Snapshot 分页；`syncCursor` 只用于同步进度；Feed Cursor 使用独立命名空间。分页页必须按 `page.sequence` 从 1 连续递增，客户端不得跳页或并行猜测 Cursor。

### 3.2 Sync

Sync 是受信任副本之间的双向状态复制。

- 必须支持幂等操作、离线队列、Tombstone、冲突与游标续传。
- 必须保留浏览器来源映射和转换警告。
- Sync 数据不自动成为公开数据。

### 3.3 Feed

<!-- COLP-REQ FEED-0003 -->

Feed 是面向关注者、聚合器和搜索引擎的传播视图。

- Feed 可以只发布 Collection Release，而不发布每次内部编辑。
- Feed 可以压缩、脱敏或合并事件。
- Feed 不得包含私人 Note、浏览器 Profile ID、原生节点 ID、密钥、ACL 内部标识或未明确公开的附件。
- Feed 历史的完整性不得作为恢复同步状态的唯一依据。

## 4. 资源模型

### 4.1 Collection

Collection 是一个独立的版本、访问和传播边界。它拥有：

- 稳定 ID 与 Canonical URL。
- 一个 Root Node。
- Collection 级元信息。
- 公开策略和访问策略。
- Revision、事件游标和可选 Release。
- 一个或多个 Creator / Maintainer。

Collection 的 `kind`：

- `bookmarks`：传统收藏夹树。
- `reading_path`：强调顺序和学习路径。
- `knowledge_collection`：包含注释、关系和来源引用信息。
- `mixed`：上述能力混用。

### 4.2 Node

Node 是树中的最小结构单位：

- `root`
- `folder`
- `bookmark`
- `separator`
- `alias`

`alias` 指向同一 Collection 内的另一个 Node。向不支持 Alias 的浏览器同步时，适配器必须将其物化为重复 Bookmark，或明确拒绝。

### 4.3 Annotation

Annotation 表达附加在 Collection 或 Node 上的内容：

- `note`
- `summary`
- `tldr`
- `highlight`
- `reading_state`
- `rating`
- `custom`

每条 Annotation 都有独立 `visibility`。私人 Annotation 即使其父 Node 公开，也不得进入公共投影。

AI Provenance 的身份字段由服务端可信生成边界建立。后续 Human、Imported 或 Derived 写入可以编辑内容，
但不能依据请求体中的 Provenance 改写既有 AI 的生成来源；完整规则见 `docs/01-core-data-model.md`。

<a id="colp-section-4-4"></a>

### 4.4 Extension

无法进入核心模型的来源专有数据必须放入 `extensions`：

```json
{
  "extensions": {
    "https://example.com/ns/repository-metadata/v1": {
      "stars": 18400,
      "language": "TypeScript"
    }
  }
}
```

扩展键 MUST 是没有 Userinfo、且任何显式端口均为非空十进制数字的 HTTPS Namespace URI；Namespace key 按原始字符串逐 Code Point 精确比较，不执行大小写折叠、默认端口消除或 Percent-Encoding 规范化。中间节点、同步服务器和导出工具对未知扩展 MUST 原样保留，除非安全策略明确移除。

同一精确协议版本内，新增数据 MUST 放入 `extensions`。新增核心字段需要新的 Schema / 协议版本，不能依赖旧版本 `additionalProperties` 行为偷偷扩展。

## 5. ID、时间和版本

<a id="colp-section-5-1"></a>

### 5.1 ID

- 新建对象 SHOULD 使用 UUIDv7。
- Wire ID 是不透明字符串，客户端不得从 ID 推断时间、所有者或 URL。
- Wire ID MUST 为 1 到 128 个 URI Unreserved ASCII 字符：`ALPHA / DIGIT / "-" / "." / "_" / "~"`。
- Collection、Node、Annotation、Attachment、Relation、Operation 和 Event 的 ID 在其服务器内 MUST 唯一且永不复用。
- 原生浏览器 ID 不得作为协议主 ID，应进入 `sourceRefs`。
- 全局资源身份是 `(serverUuid, resourceType, id)`。跨服务器引用 MUST 使用 Canonical URI，不能只发送裸 ID。

Canonical URI 的唯一串行化形式是
`colp:/resources/~{serverUuid}/{resourceType}/~{id}`。`serverUuid` 与 `id` 是解码后的 Wire ID；由于
Wire ID 仅包含 URI Unreserved ASCII 字符，其 Canonical URI 不含 Percent Encoding。
`resourceType` 固定为 `collection`、`node`、`annotation`、`attachment`、`relation`、`operation`
或 `event`。该形式没有 Authority、Userinfo、Port、Query 或 Fragment；`~` 前缀使值为 `.` 或 `..`
的合法 Wire ID 也不会被 URI Parser 当作路径遍历段归一化。

Canonical URI 按完整解码后的三元组逐字段、区分大小写比较，而不是按展示 URL 或 URI Parser
归一化后的字符串比较。裸 Wire ID 只在调用方同时提供同一服务器的 `serverUuid` 和预期
`resourceType` 的显式本地解析上下文时表示引用；没有该上下文的引用使用 Canonical URI。
这里的全局身份 URI 与 MCP Profile 的 `colp://{serverUuid}/...` Resource Locator 是两个不同的
URI 命名空间：前者无 Authority 且只编码资源身份三元组，后者有 Authority 并定位特定 MCP 表示或操作；
两者之间不存在隐式别名或通用字符串转换规则。
- URI Template 展开时必须对 ID 做 UTF-8 Percent Encoding；服务器按解码后的原始字节值比较，不执行大小写折叠。

<a id="colp-section-5-2"></a>

### 5.2 时间

- 时间使用 RFC 3339 字符串。
- 规范写入 SHOULD 使用 UTC 和 `Z`。
- 浏览器毫秒时间戳转换时必须保留原始值于 Source Reference，避免精度或时区误判。

### 5.3 Revision 与 Cursor

- `revision` 表示可进行条件写入的对象版本。
- `cursor` 表示事件日志位置。
- 两者均为服务器生成的不透明字符串。
- 客户端不得将 Cursor 当时间戳比较，不得自行递增。

<a id="colp-section-6"></a>

## 6. URL 与重复检测

- `url` 保存用户实际收藏的 URL，不进行破坏性重写。
- Bookmark 的权威 / Sync 表示使用 `$defs.bookmarkUrl`：结构上允许绝对本地 URI，但禁止 `javascript:`、`vbscript:`、`data:` 和控制字符。Mount 通过 `features.bookmarkUrls.acceptedSchemes` 声明实际接受的 Scheme，且至少包含 `http`、`https`。
- Publication、Feed 与面向 Assistant 的可导航 URL 只允许 Authority 不含 Userinfo 的 HTTP(S)。其他 Scheme 或含 Userinfo 的 URL 必须省略、Redact 或留在授权 Sync 表示中，不得直接公开。
- `canonicalUrl` MAY 保存经明确规则计算或页面声明的 Canonical URL。
- `urlHash` MAY 用于查重，但不得作为对象 ID。

Bookmark 的可选 `urlHash` Wire Syntax MUST 是 `sha-256=:<base64>:`，其中 Base64 MUST 使用
Canonical Padded Encoding，解码后恰为 32 Octets。Digest 输入 MUST 是 `url` 原始字符串的 UTF-8
Octets，不执行 URL 解析、规范化或重写。`urlHash` 缺失是合法的；出现时 MUST 与同一对象中保留
的原始 `url` 匹配。相等 Hash MUST 只选择待进一步比较的重复候选，MUST NOT 证明两个对象相同；
最终判断比较适用的 URL、内容和 Collection 语义。`urlHash` MUST NOT 写入或替代 `id`、
`collectionId`、Node 引用或任何其他对象 ID 字段。
- 默认规范化只能执行无争议操作，例如 scheme / host 大小写归一化、移除默认端口。
- 移除追踪参数、展开短链、删除 Fragment 等操作必须由命名的 `normalizationProfile` 控制。
- 带签名、临时令牌或顺序敏感 Query 的 URL MUST 保留原值。

<a id="colp-section-7"></a>

## 7. 协议发现

服务器 MUST 在以下位置之一提供 Manifest：

```text
/.well-known/collection-protocol
```

若协议挂载在子路径，Manifest 中的 `mounts[].baseUrl` 指向真实基地址。每个 Mount MUST 独立声明 `profiles`、`endpoints`、认证和限制；客户端 MUST 跟随 Endpoint / Link，MUST NOT 从 `baseUrl` 猜测路径。Endpoint Template 使用 RFC 6570 Level 1。

HTML 页面和 HTTP 响应 SHOULD 额外提供：

```html
<link rel="collection-protocol" href="/.well-known/collection-protocol">
```

```http
Link: </.well-known/collection-protocol>; rel="collection-protocol"
```

Manifest 必须声明 `serverUuid`、版本、Mount、端点、Profile、认证方式、页面限制和推荐轮询间隔。Profile 的端点依赖是 Wire Contract：例如 `publisher` 必须声明 Collection、Node、Annotation、Attachment、Relation 和 Release 的读写模板，不能只声明能力名称。

## 8. 端点总表

以下路径是推荐动态路由。Manifest 可以声明其他绝对路径，例如静态 `.json` 文件；客户端不得硬编码本表。`c/` 是对象路由保留段，`-/` 是实例服务保留段。

### 8.1 公共读取

| Method | Path | 含义 |
|---|---|---|
| GET | `/` | 可发现的 Collection 列表 |
| GET | `/-/feed` | 实例级公共事件流 |
| GET | `/c/{collectionId}` | Collection 元信息 |
| GET | `/c/{collectionId}/snapshot` | 完整或分页 Snapshot |
| GET | `/c/{collectionId}/nodes/{nodeId}` | 单个公开 Node |
| GET | `/c/{collectionId}/feed` | Collection 公开事件流 |

### 8.2 管理写入

| Method | Path | 含义 |
|---|---|---|
| POST | `/` | 创建 Collection |
| PATCH | `/c/{collectionId}` | 更新 Collection 元信息 |
| DELETE | `/c/{collectionId}` | 删除或归档 Collection |
| POST | `/c/{collectionId}/nodes` | 创建 Node |
| PATCH | `/c/{collectionId}/nodes/{nodeId}` | 更新 Node |
| DELETE | `/c/{collectionId}/nodes/{nodeId}` | 删除 Node / 子树 |
| POST | `/c/{collectionId}/nodes/{nodeId}/move` | 移动或重排 Node |
| POST | `/c/{collectionId}/annotations` | 创建 Annotation |
| PATCH/DELETE | `/c/{collectionId}/annotations/{annotationId}` | 更新或删除 Annotation |
| POST | `/c/{collectionId}/attachments` | 创建 Attachment 元数据 |
| PATCH/DELETE | `/c/{collectionId}/attachments/{attachmentId}` | 更新或删除 Attachment 元数据 |
| POST | `/c/{collectionId}/relations` | 创建 Relation |
| PATCH/DELETE | `/c/{collectionId}/relations/{relationId}` | 更新或删除 Relation |
| POST | `/c/{collectionId}/release` | 发布一次不可变公开 Release |
| GET | `/c/{collectionId}/releases` | 列出不可变 Release |
| GET | `/c/{collectionId}/releases/{releaseId}` | 获取 Release 元数据 |
| GET | `/c/{collectionId}/releases/{releaseId}/snapshot` | 获取不可变 Release Snapshot |

### 8.3 同步

| Method | Path | 含义 |
|---|---|---|
| POST | `/-/sync/sessions` | 协商副本、能力和 Bootstrap 模式 |
| GET | `/-/sync/snapshot` | 获取同步 Snapshot |
| POST | `/-/sync/push` | 幂等推送 Operation Batch |
| GET | `/-/sync/pull` | 按 Cursor 拉取 Operation / Conflict |
| POST | `/-/sync/ack` | 确认已持久化到本地 |
| POST | `/-/sync/conflicts/{id}/resolve` | 显式解决冲突 |

### 8.4 管理与安全

| Method | Path | 含义 |
|---|---|---|
| GET/PATCH | `/-/admin/access` | 默认访问策略 |
| GET/PATCH | `/c/{collectionId}/access` | Collection ACL / 发布策略 |
| GET/POST | `/-/admin/keys` | 列出或创建 Key 元信息 |
| POST | `/-/admin/keys/{keyId}/rotate` | 轮换 Key |
| DELETE | `/-/admin/keys/{keyId}` | 撤销 Key |
| GET/PATCH | `/-/admin/rate-limits` | 限流策略 |
| GET | `/-/admin/audit` | 审计日志 |
| POST/GET/DELETE | `/-/mcp` | MCP Streamable HTTP 与可选 Session 终止 |

<a id="colp-section-9"></a>

## 9. HTTP 基础规则

<!-- COLP-REQ SEC-0003 -->

<!-- COLP-REQ PUB-0007 -->

<!-- COLP-REQ PUB-0006 -->

- 请求与响应 MUST 使用 UTF-8。
- JSON MUST 遵循 I-JSON 互操作约束：不得有重复成员名，协议整数不得超出 IEEE 754 binary64 可精确表示范围，非有限数字不得出现。
- 每个 Endpoint 的 Query、请求 Body 和响应 Body MUST 使用 `docs/10-implementation-contract.md` 指定的命名 `$defs` 校验。Schema 根部 `anyOf` 只用于可独立识别的资源 / 响应表示，不得代替端点级 DTO 校验。
- Query 数组使用重复参数，例如 `include=annotations&include=attachments`。标量参数重复、空值和未知参数返回 `400 invalid_query`；客户端和服务器必须使用相同的 Endpoint Contract Registry 编解码。
- 客户端 MUST 支持 `application/json`。
- 实现 SHOULD 支持 `application/vnd.collection-protocol.*+json;version=0.1`。
- GET 响应 SHOULD 返回 `ETag` 和 `Last-Modified`。ETag 标识具体表示，必须包含投影、查询、分页和内容协商差异；不得只用 Collection Revision 生成所有页面共用的 ETag。
- 客户端 SHOULD 使用 `If-None-Match`，服务器可返回 `304 Not Modified`。
- 修改已有资源 MUST 使用 `If-Match`，避免静默覆盖。
- 缺少必需 Precondition 时服务器 MUST 返回 `428 Precondition Required`。
- `If-Match` 不匹配时 MUST 返回 `412 Precondition Failed`，并附当前 Revision / ETag。`409 Conflict` 只用于请求满足 HTTP Precondition 后仍存在的业务冲突。
- `PATCH` 默认使用 `application/merge-patch+json`。支持 `application/json-patch+json` 时必须在 Manifest 明确声明。
- 重试型 POST MUST 带 `Idempotency-Key`。
- Idempotency Key 必须绑定 Principal、Method、Endpoint Key、资源身份、协议版本和 Canonical Request Digest；同 Key 不同请求 MUST 返回 `409 idempotency_key_reused`。JSON Body 使用 RFC 8785，Query 使用已解码 DTO 的 Canonical JSON，Media Type 小写并移除可忽略空白。服务端必须在 Manifest 声明最短去重保留期。
- 分页使用不透明 `cursor`，不得使用易漂移的页码作为唯一机制。
- 错误响应使用 `application/problem+json`，并增加稳定的 `code`。
- 任何因 Authorization 而改变内容的响应 MUST 使用 `Cache-Control: private, no-store` 与 `Vary: Authorization`。匿名公开表示才可以使用 Shared Cache。
- 使用媒体类型或版本内容协商的响应 MUST 正确合并 `Vary: Accept, Collection-Protocol-Version`；不得覆盖已有 `Vary: Authorization` / `Origin`。

错误示例：

```json
{
  "type": "https://collectionprotocol.org/problems/revision-conflict",
  "title": "Revision conflict",
  "status": 409,
  "code": "revision_conflict",
  "detail": "The node changed after the supplied base revision.",
  "instance": "/collections/c1/nodes/n9",
  "currentRevision": "r_1042",
  "conflictId": "019b..."
}
```

<a id="colp-section-10"></a>

## 10. 可见性

Collection 的 `visibility`：

- `public`：进入 Collection 列表，可匿名读取。
- `unlisted`：访问语义等同匿名可读的 `public`，只是不进入 Directory。它不是认证或保密机制。
- `protected`：需要 API Key 或 OAuth Token。
- `private`：只允许显式 Principal。

Node、Annotation 和 Attachment 可以进一步收紧可见性，但不得放宽父级限制。Node 未声明 `visibility` 时继承；有效访问权限是 Collection、全部祖先 Node 与对象自身规则的交集。

公开投影 MUST 移除：

- `sourceRefs.nativeId`、`profileId`、本地路径。
- 私人 Annotation。
- ACL Principal 内部 ID。
- API Key、Token、Key Hint 之外的密钥信息。
- 同步 Conflict 的私人版本内容。
- 未明确公开的附件和抓取正文。
- 未经 Namespace Allowlist 明确标记为 Public-safe 的 Extension。未知 Extension 只在权威 / Sync 存储中保留，默认不进入 Public、Feed 或 Assistant 投影。

<a id="colp-section-11"></a>

## 11. 一致性 Profile

实现按 Mount 通过 Manifest 声明可组合 Profile：

```json
{
  "profiles": [
    "core",
    "publication",
    "feed",
    "publisher",
    "sync",
    "mcp-read",
    "mcp-write"
  ]
}
```

依赖关系和最小能力见 `docs/00-practical-profile.md`。若实现声明某 Profile，其对应的必需端点和语义 MUST 全部通过 Conformance Test。旧草案 Bundle 名称 `reader`、`sync-server`、`mcp-server` 不再用于新 Manifest。

稳定 Requirement ID、实现模块和测试证据记录在 `requirements.yaml`。Profile 声明必须同时满足：包级必需测试通过、部署已注册全部 Endpoint、事务 / 鉴权 / Outbox 等必需 Port 可用；配置布尔值本身不是一致性证据。

<a id="colp-section-12"></a>

## 12. 版本协商

- Manifest 提供 `protocolVersions`，按新到旧排列。
- HTTP 客户端 SHOULD 发送：

```http
Collection-Protocol-Version: 0.1
```

- 读取请求的 Header / Accept 版本不支持时返回 `406 unsupported_version`；写入请求的 Content-Type 版本不支持时返回 `415 unsupported_media_type`。响应列出 `supportedVersions`。
- 同一精确版本内只能通过 HTTPS Namespace `extensions` 新增数据。
- 新增核心可选字段、事件或能力需要发布新的 Minor Schema，并经过版本协商。
- 删除字段、改变默认含义或改变冲突规则必须升级 Major。
- 客户端不得执行未知核心字段或未知 Operation Type；应拒绝、协商版本或保留原始表示后透明转发，不得猜测执行。

## 13. 参考标准

- BCP 14 / RFC 2119 / RFC 8174：规范关键词。
- RFC 3339：日期时间。
- RFC 3986：URI。
- RFC 9110：HTTP Semantics。
- RFC 8288：Web Linking。
- RFC 6902：JSON Patch。
- RFC 7396：JSON Merge Patch。
- RFC 7493：I-JSON。
- RFC 6570：URI Template。
- RFC 9457：Problem Details for HTTP APIs。
- RFC 9421：HTTP Message Signatures。
- RFC 9530：HTTP Content-Digest。
- RFC 8785：JSON Canonicalization Scheme（仅用于可选逻辑摘要）。
- OAuth 2.1、RFC 8707、RFC 9449、RFC 9728：授权、Sender Constraint 与资源绑定。
- JSON Feed 1.1：可选公共 Feed 表示。
- CloudEvents 1.0：事件信封兼容目标。
- MCP Specification 2026-07-28：MCP Profile 基线（无状态、POST-only）。
