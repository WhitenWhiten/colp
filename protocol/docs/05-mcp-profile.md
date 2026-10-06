# 05. Native MCP Profile

## 1. 设计目标

Collection Protocol MCP Profile 让 AI 能够：

- 读取 Collection、Node、Feed、同步状态和公开策略。
- 搜索、创建、修改、移动和删除收藏内容。
- 管理公开性、访问密钥、ACL、限流和同步副本。
- 在高风险操作前展示影响范围并获得用户确认。

MCP 只是 Core HTTP API 的适配层。权限、Revision、审计、限流和冲突规则不能在 MCP 中另起一套。

基线：MCP Specification `2026-07-28`（无状态、POST-only）。

官方规范链接：

- [MCP 2026-07-28 Changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2026-07-28 Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP 2026-07-28 Server Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [MCP 2026-07-28 Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)
- [MCP 2026-07-28 MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)

<a id="colp-section-2"></a>

## 2. 传输

<!-- COLP-REQ MCP-0017 -->

<!-- COLP-REQ MCP-0016 -->

远程端点（POST-only）：

```text
POST /collections/-/mcp
```

使用 MCP Streamable HTTP（`2026-07-28`）：

- JSON-RPC 2.0，UTF-8。
- 端点只接受 POST；GET 和 DELETE 不属于 MCP 合同，作为负控拒绝，不创建 SSE 也不执行清理逻辑。
- 每次 POST 的 Accept 必须同时包含 `application/json` 与 `text/event-stream`。
- 请求必须携带 `MCP-Protocol-Version: 2026-07-28`，且与请求 `_meta.io.modelcontextprotocol/protocolVersion` 一致；携带不支持的版本值时返回 `UnsupportedProtocolVersionError (-32022)`，缺失 `_meta` 信封或缺失其中必填字段时返回 `-32602` Invalid Params，缺失该 Header 或 Header 与 body 冲突时返回 `HeaderMismatchError (-32020)`（对齐上游 `_meta` 合同；2026-08-27 修订）。
- 服务器必须校验 Origin。
- 协议不提供 Session：携带 Session 标识 Header 时直接拒绝，不忽略后继续执行；旧 Session 语义见 §27 拒绝样例。
- 客户端在每次请求携带 `_meta.io.modelcontextprotocol/protocolVersion`、`io.modelcontextprotocol/clientCapabilities`，并推荐携带 clientInfo；结果 `_meta` 携带 serverInfo。

本地集成 MAY 使用 stdio。stdio 凭据从环境或本地 Secret Store 获取，不使用远程 OAuth Flow。

协议错误使用稳定编号：Header 不匹配返回 `HeaderMismatchError (-32020)`，缺 required client capability 返回 `-32021`，不支持版本返回 `-32022`；应用自定义错误只使用 `-32000..-32019`。每次请求都不依赖先前协商状态；listen 长连接状态只存在于该 POST 请求生命周期，断线后客户端重新 listen 并重新读取 Resource，不基于事件 ID 补发；旧恢复语义见 §27 拒绝样例。

<a id="colp-section-3"></a>

## 3. MCP Authorization

远程写入必须使用 OAuth 2.1 Profile：

- Protected Resource Metadata。
- Authorization Server Discovery。
- PKCE S256。
- `resource=https://alice.example/collections/-/mcp`。
- Audience Validation。
- 不允许 Token Passthrough。
- Scope Upgrade 使用 403 `insufficient_scope`。

OAuth client issuer 绑定见 `docs/04-auth-security-rate-limit.md` 的 6.1：授权响应 `iss`、DCR `application_type` 与按 issuer 隔离的凭据是 MCP OAuth client 的必要合同。

匿名 MCP MAY 只暴露公开 Resources，不暴露 Tools。

## 4. Capabilities

<!-- COLP-REQ MCP-0007 -->

<!-- COLP-REQ MCP-0006 -->

Manifest 中声明 `mcp-read` 或 `mcp-write` 的 Mount 必须同时声明 `mcp` Endpoint，并将 `features.mcp.resources` 设为 `true`。`mcp-read` 可以将 `features.mcp.tools` 设为 `false`；Resource-only Server 仍是合法的 `mcp-read` 实现。若 `mcp-read` 将其设为 `true`，暴露的 Tool 必须全部为只读 Tool。

声明 `mcp-write` 的 Mount 必须将 `features.mcp.tools` 设为 `true`，并同时声明它依赖的 `mcp-read` 与 `publisher` Profile。

Manifest 的 `features.mcp.protocolVersion` 固定为 `2026-07-28`；`mcp-read` / `mcp-write` 的唯一 MCP 基线是 `2026-07-28`，不接受任意版本或 supported-version 数组。

只读服务器：

```json
{
  "capabilities": {
    "resources": {
      "listChanged": true
    }
  }
}
```

可写服务器：

```json
{
  "capabilities": {
    "resources": {
      "listChanged": true
    },
    "tools": {
      "listChanged": true
    }
  }
}
```

当 Scope 或用户授权改变可见 Tool 集合时，服务器通过 `subscriptions/listen` 连接发送 `notifications/tools/list_changed`。

## 5. Resource URI

<!-- COLP-REQ MCP-0001 -->

### 5.1 Public Resource

如果 MCP Client 可直接访问公开 URL，使用 HTTPS：

```text
https://alice.example/collections/c/collection-1
https://alice.example/collections/c/collection-1/snapshot
```

### 5.2 Logical / Protected Resource

```text
colp://{serverUuid}/collections/{collectionId}
colp://{serverUuid}/collections/{collectionId}/snapshot
colp://{serverUuid}/collections/{collectionId}/nodes/{nodeId}
colp://{serverUuid}/collections/{collectionId}/feed
colp://{serverUuid}/collections/{collectionId}/access
colp://{serverUuid}/sync/status
colp://{serverUuid}/audit/{auditId}
```

`colp` 是自定义 URI Scheme。Authority 使用 Manifest 中稳定的 `serverUuid`，不得使用会改变的展示名。

<a id="colp-section-6"></a>

## 6. Resource Templates

服务器 SHOULD 暴露以下模板。Authority 必须直接使用本服务器的实际 `serverUuid`，它不是让客户端填写的模板变量：

```json
[
  {
    "uriTemplate": "colp://019b3c67-a03c-7f02-9c7e-1ee8d50a77de/collections/{collectionId}",
    "name": "collection",
    "title": "Collection metadata",
    "mimeType": "application/vnd.collection-protocol.collection+json"
  },
  {
    "uriTemplate": "colp://019b3c67-a03c-7f02-9c7e-1ee8d50a77de/collections/{collectionId}/nodes/{nodeId}",
    "name": "collection-node",
    "title": "Collection node",
    "mimeType": "application/vnd.collection-protocol.node+json"
  },
  {
    "uriTemplate": "colp://019b3c67-a03c-7f02-9c7e-1ee8d50a77de/collections/{collectionId}/feed?cursor={cursor}",
    "name": "collection-feed",
    "title": "Collection changes",
    "mimeType": "application/vnd.collection-protocol.feed+json"
  }
]
```

## 7. Resources

### 7.1 Collection Directory

- URI：`colp://{serverUuid}/collections`
- 只返回当前 Principal 可见 Collection。
- 匿名 List / Search 必须排除 `unlisted` Collection；知道精确 URI 后的读取与“可发现”是两种权限。
- Resource Annotation：`audience=["user","assistant"]`。

### 7.2 Collection Snapshot

- URI：`colp://{serverUuid}/collections/{id}/snapshot`。Collection Metadata 使用不带 `/snapshot` 的 URI，两者不得复用。
- 大 Collection 可只返回摘要和 Resource Link 到 Snapshot Page。
- `annotations.lastModified` 对应 Collection UpdatedAt。

### 7.3 Node

- URI：`colp://{serverUuid}/collections/{id}/nodes/{nodeId}`。
- 私人 Annotation 只有在 Scope 允许时出现。

### 7.4 Access Summary

- URI：`colp://{serverUuid}/collections/{id}/access`。
- 返回人类可读摘要与机器结构，不返回 Secret。

### 7.5 Sync Status

- 当前 Replica、Last Cursor、Pending Operations、Open Conflicts 和 Conversion Warnings。

### 7.6 Audit

- 仅 `audit:read`。
- 默认按时间倒序分页。
- 敏感字段 Redact。

## 8. 资源变更订阅（subscriptions/listen）

<!-- COLP-REQ MCP-0021 -->

服务器通过单条长连接的 POST `subscriptions/listen` 提供变更通知：

```text
subscriptions/listen
notifications/subscriptions/acknowledged
notifications/resources/updated
notifications/resources/list_changed
```

过滤字段：

- `toolsListChanged`。
- `promptsListChanged`。
- `resourcesListChanged`。
- `resourceSubscriptions`（Resource URI 数组）。

第一条消息必须是 `notifications/subscriptions/acknowledged`，其 `_meta.io.modelcontextprotocol/subscriptionId` 等于发起请求的 JSON-RPC id；后续通知都携带该 subscription ID。`notifications/progress` 与 `notifications/message` 等 request-scoped 通知只留在各自请求的流上。连接不提供恢复；服务器不得在客户端未订阅的类型上发送通知。

适合订阅：

- Collection Metadata。
- Feed Cursor。
- Sync Status。
- Approval Plan Status。

通知只表示资源已变更。客户端必须重新 Read Resource，不能把通知当完整状态。

<a id="colp-section-9"></a>

## 9. Tool Naming

<!-- COLP-REQ MCP-0002 -->

工具名使用小写点分命名：

```text
collections.list
collections.get
nodes.create
access.plan_change
```

名称限制在 ASCII 字母、数字、下划线、连字符和点，长度不超过 128。

所有 Tool 必须提供 JSON Schema `inputSchema`，写工具 SHOULD 提供 `outputSchema` 和 `structuredContent`。

## 10. 只读 Tools

| Tool | Scope | 说明 |
|---|---|---|
| `collections.list` | collections:list | 分页列出 Collection |
| `collections.get` | collections:read | 获取元信息 |
| `collections.search` | collections:read | 搜索标题、Tag、Creator |
| `collections.get_snapshot` | nodes:read | 默认只取 Node 核心字段；包含 Sidecar 时还需要对应 read Scope |
| `nodes.get` | nodes:read | 获取单个 Node |
| `nodes.search` | nodes:read | 搜索 URL、Title、Tag；搜索 Annotation 另需 annotations:read |
| `feed.get_changes` | feed:read | 拉取公共或授权 Feed |
| `sync.get_status` | sync:pull | 查看 Cursor、Queue 和 Conflict |
| `access.get` | access:read | 查看公开性和 Effective Policy |
| `keys.list` | keys:read | 仅 Key Metadata |
| `rate_limits.get` | rate_limits:read | 查看限流策略 |
| `audit.list` | audit:read | 查看审计记录 |

## 11. 普通写 Tools

| Tool | Scope | 风险 |
|---|---|---|
| `collections.create` | collections:create | medium |
| `collections.update` | collections:write | low / medium |
| `nodes.create` | nodes:write | low |
| `nodes.update` | nodes:write | low |
| `nodes.move` | nodes:write | medium |
| `annotations.create` | annotations:write | low |
| `annotations.update` | annotations:write | low |
| `attachments.create` | attachments:write | medium |
| `attachments.update` | attachments:write | medium |
| `relations.create` | relations:write | low |
| `relations.update` | relations:write | low |
| `release.preview` | release:publish | low |
| `release.publish` | release:publish | high |
| `sync.preview` | sync:pull | low |
| `sync.push` | sync:push | medium |
| `sync.resolve_conflict` | sync:resolve | medium |

修改、移动、重排、删除和冲突解决 Tool 必须要求目标 `baseRevision`；跨 Parent Move 还必须带源 / 目标 Children Revision。`dryRun` 可以附加，但不能替代并发 Precondition。Create Tool 使用 Idempotency Key，不要求不存在对象的 Revision。

## 12. 高风险 Tools

<!-- COLP-REQ MCP-0003 -->

以下操作不得设计成一步完成：

- `collections.delete`
- `nodes.delete_subtree`，超过安全阈值时
- `access.visibility` 变为 public / unlisted
- `access.set_policy`
- `keys.create`
- `keys.rotate`
- `keys.revoke`
- `rate_limits.set`
- `sync.mirror`
- 大批量覆盖、删除或公开 Annotation / Attachment

风险按展开后的实际 Operation 聚合，而不是按外层 Tool 名判断。通用 `sync.push`、批量 Tool 或自定义 Tool 内含任一高风险 Operation 时，整个调用必须走 Plan / Commit；不得用 Generic Batch 绕过确认。

统一使用 Plan / Commit：

```text
changes.plan
changes.commit
changes.cancel
```

## 13. Change Plan

<!-- COLP-REQ MCP-0004 -->

### 13.1 Plan

```json
{
  "operations": [
    {
      "type": "set_visibility",
      "collectionId": "collection-1",
      "baseRevision": "acl_17",
      "input": {
        "visibility": "public"
      }
    }
  ],
  "reason": "User asked to publish the collection",
  "dryRun": true
}
```

结果：

```json
{
  "planId": "plan_01JZ...",
  "expiresAt": "2026-07-16T07:20:00Z",
  "risk": "high",
  "requiresApproval": true,
  "approvalMethod": "out_of_band",
  "approvalUri": "https://alice.example/collections/approvals/plan_01JZ...",
  "summary": "Make Interface Systems publicly listed and readable without a key.",
  "impact": {
    "collections": 1,
    "nodes": 48,
    "annotations": 6,
    "attachments": 0,
    "relations": 12,
    "privateFieldsExcluded": ["sourceRefs", "private annotations", "ACL principals"]
  },
  "requiredScopes": ["access:write"],
  "baseRevisions": {
    "collection-1": "r_1042",
    "access:collection-1": "acl_17"
  }
}
```

`operations[]` 必须通过 `$defs.changePlanOperation` 的判别联合，不能使用开放 `payload` 猜测命令。Plan 必须绑定最终用户 Subject、OAuth Client、请求上下文、Canonical Operations Digest 和 Base Revisions。知道 `planId` 不得让另一个 Principal、Client 或请求上下文提交该 Plan。

### 13.2 Approval

高风险 Plan 的批准必须来自用户可见界面或受信任宿主，而不是模型自己生成一个布尔值。

推荐流程：

1. MCP Tool 返回 `approvalUri`。
2. Host 向用户展示 Summary、Diff、影响范围和权限。
3. 用户在服务器页面批准。
4. 服务器将 Plan 标记为 approved，并把批准状态绑定同一 Subject、OAuth Client 与请求上下文。
5. AI 调用 `changes.commit(planId)`；服务器依据请求的认证身份与已批准状态提交，不要求模型持有 Secret。跨 Host 回调若必须使用一次性 Token，该 Token 只能由 Host 在传输层附加，不进入 Tool Input 或模型文本。

如果宿主支持可信确认回调，可以替代 Approval URI，但必须记录 Audit。

Approval Token 必须短期、单次、哈希存储，并绑定同一 Plan / Subject / Client。Approval 页面必须重新认证并实施 CSRF 防护；Summary、Diff 和影响范围由服务器根据存储的 Canonical Plan 重新生成，不能信任模型提供的描述。

### 13.3 Commit

Commit 必须重新验证：

- Plan 未过期。
- 用户批准存在。
- Base Revision 未变化。
- Scope 仍有效。
- Rate Limit 允许。
- 操作影响未超出 Plan。
- Approval 尚未被消费，且 Commit 的 Canonical Operation Digest 与 Plan 完全一致。

任一条件失败则 Commit 不执行，要求重新 Plan。

Commit 必须在单一事务中 compare-and-consume Approval，并使用 Idempotency Key。并发 Commit 只能有一个执行；重试返回首次 Commit 的原结果，不能二次执行。

## 14. API Key Tools 的秘密处理

<!-- COLP-REQ MCP-0005 -->

### 14.1 禁止返回 Secret 给模型

`keys.create` / `keys.rotate` 的 MCP Structured Content 不得包含明文 Secret。

返回：

```json
{
  "keyId": "key_01JZ...",
  "name": "Feed reader",
  "scopes": ["collections:read", "feed:read"],
  "expiresAt": "2026-10-16T00:00:00Z",
  "secretAvailable": true,
  "revealUri": "https://alice.example/collections/keys/key_01JZ.../reveal"
}
```

- Reveal URI 需要当前用户重新认证。
- Secret 只显示一次。
- Reveal 页面使用 `Cache-Control: no-store`。
- 页面不应把 Secret 发送回 MCP Client 或模型上下文。

## 15. Tool Schema 示例

```json
{
  "name": "nodes.create",
  "title": "Create bookmark node",
  "description": "Create a bookmark, folder, separator, or alias in a collection. Does not publish private data unless the collection policy already allows it.",
  "inputSchema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "collectionId": { "type": "string" },
      "parentId": { "type": "string" },
      "afterId": { "type": ["string", "null"] },
      "node": { "$ref": "https://collectionprotocol.org/schema/0.1#/$defs/nodeCreate" },
      "dryRun": { "type": "boolean", "default": false }
    },
    "required": ["collectionId", "parentId", "node"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "node": { "$ref": "https://collectionprotocol.org/schema/0.1#/$defs/node" },
      "warnings": {
        "type": "array",
        "items": { "$ref": "https://collectionprotocol.org/schema/0.1#/$defs/warning" }
      }
    },
    "required": ["node", "warnings"]
  },
  "_meta": {
    "collection-protocol/risk": "low",
    "collection-protocol/confirmation": "policy"
  }
}
```

## 16. Tool Error

业务错误作为 Tool Result：

```json
{
  "content": [
    {
      "type": "text",
      "text": "The folder changed since revision r_1041. Read the folder again and retry with the current revision."
    }
  ],
  "structuredContent": {
    "code": "revision_conflict",
    "currentRevision": "r_1043",
    "retryable": true
  },
  "isError": true
}
```

未知 Tool、无效 JSON-RPC 或不满足 Tool Schema 使用 Protocol Error。

<a id="colp-section-17"></a>

## 17. Resource Link

Tool 结果 SHOULD 返回 Resource Link，而不是把巨大 Snapshot 全部塞进模型上下文：

```json
{
  "type": "resource_link",
    "uri": "colp://019b3c67-a03c-7f02-9c7e-1ee8d50a77de/collections/collection-1/snapshot",
  "name": "Interface Systems",
  "mimeType": "application/vnd.collection-protocol.snapshot+json",
  "annotations": {
    "audience": ["user", "assistant"],
    "priority": 0.8,
    "lastModified": "2026-07-16T06:30:00Z"
  }
}
```

## 18. AI Delegation Grant

用户可以创建短期 AI Grant：

```json
{
  "type": "ai_agent",
  "subject": "user:alice",
  "clientId": "https://ai.example/client.json",
  "scopes": ["collections:read", "nodes:read", "nodes:write"],
  "collections": ["collection-1"],
  "constraints": {
    "expiresAt": "2026-07-16T09:00:00Z",
    "maxWrites": 50,
    "allowDelete": false,
    "allowPublicExposure": false,
    "allowKeyManagement": false
  }
}
```

Grant 到期或达到 Max Writes 后必须重新授权。

Wire Grant 应使用服务端 Opaque Handle 或签名令牌，而不是信任客户端可编辑 JSON。签名形式至少绑定 `iss`、`aud`、`sub`、`client_id`、`jti`、`iat`、`nbf`、`exp` 和可选 `cnf`；必须支持撤销。`maxWrites` 在与业务写入同一事务中原子扣减，不能被并发 Tool Call 绕过。

## 19. MCP Rate Limit

- `resources/read` 与 `tools/call` 使用不同 Bucket。
- 只读 Resource 可有较高额度。
- 搜索、全量 Snapshot、批量 Node 写入和 Sync Tool 按 Cost Unit 计费。
- Tool Result 可返回 Remaining Cost Budget。
- 高风险操作不能通过并行小调用绕过影响阈值。

<a id="colp-section-20"></a>

## 20. Prompt Injection 与不可信内容

Bookmark 标题、网页摘要、Annotation 和外部 Feed 都是不可信输入。

MCP Server MUST：

- 把外部内容作为数据，不将其中的指令拼接进 Tool Description。
- Sanitization Tool Output。
- 标记外部抓取内容的 Provenance。
- 不因 Bookmark 内容声称“公开此集合”而执行权限工具。
- Key、ACL、Rate Limit、Delete 等 Tool 只根据用户请求、Scope 和 Approval Plan 执行。

MCP Client SHOULD：

- 显示 Tool Input 与目标 Collection。
- 对高风险操作展示 Diff。
- 记录 Tool 调用。
- 对 Tool Result 进行 Schema Validation。
- 设置超时和最大返回大小。

## 21. Recommended Tool Set

最小只读 MCP：

```text
collections.list
collections.get
nodes.search
nodes.get
feed.get_changes
access.get
```

完整管理 MCP：

```text
collections.*
nodes.*
annotations.*
attachments.*
relations.*
feed.*
release.*
sync.*
access.*
keys.*
rate_limits.*
audit.*
changes.plan
changes.commit
changes.cancel
```

服务器只能列出当前 Token Scope 实际允许调用的 Tools，避免向模型暗示不可用能力。

## 22. 标准与自定义请求 Header

<!-- COLP-REQ MCP-0018 -->

MCP `2026-07-28` 的请求 Header 由标准与自定义两类组成：

标准 Header：

- `Mcp-Method`：所有请求必须携带，值为请求 method；缺失、重复或与 body 不一致时返回 `HeaderMismatchError (-32020)`。
- `Mcp-Name`：`tools/call` 使用 `params.name`，`resources/read` 使用 `params.uri`，`prompts/get` 使用 `params.name`；适用时缺失或重复同样按 `-32020` 拒绝。
- `MCP-Protocol-Version`：必须为 `2026-07-28`。

自定义 Header：

- Tool `inputSchema` 可用 `x-mcp-header` 声明字段映射到 `Mcp-Param-{Name}`。
- 值编码必须使用大小写敏感的 Base64 sentinel `=?base64?...?=`。
- 只支持原始 integer / string / boolean，不支持 number、对象或数组。
- `x-mcp-header` 只能通过 `properties` 链静态可达，不能出现在 `items`、组合关键字、条件或 `$ref` 内。
- Header 名必须符合 RFC 9110 token 规则且大小写不敏感唯一。
- 非法编码、错误 sentinel、Schema 未声明或值与 body 不一致的 `Mcp-Name` / `Mcp-Param-*` 一律拒绝。

## 23. Server Discovery

<!-- COLP-REQ MCP-0019 -->

服务器必须实现 `server/discover`：

- 请求只包含 `_meta`。
- 结果必须包含 `resultType: "complete"`、`supportedVersions` 与 `capabilities`，并推荐包含 serverInfo（语义见官方规范）。
- 结果可携带 `instructions`、`ttlMs` 与 `cacheScope`。
- discovery 对客户端可选；stdio 兼容探测也使用同一 discovery 方法。
- `serverInfo` 是服务器自报信息，不构成安全边界。

发现与 `mcp-read` / `mcp-write` 能力清单只描述 `2026-07-28` 及服务器当前真实能力。

## 24. 结果与缓存

<!-- COLP-REQ MCP-0020 -->

所有方法结果必须声明 `resultType`：`complete` 或 `input_required`；未声明的旧式结果按 `complete` 兼容处理，但新实现必须显式声明。

可缓存的结果必须携带缓存元数据：

- `ttlMs`：非负整数的有效时间（毫秒）。
- `cacheScope`：`public` 或 `private`。

适用缓存元数据的 list / read 结果包括 `tools/list`、`prompts/list`、`resources/list`、`resources/read`、`resources/templates/list` 与 `server/discover`。结果 `_meta` 推荐携带 `io.modelcontextprotocol/serverInfo`；per-request `io.modelcontextprotocol/logLevel` 可 opt-in `notifications/message`。

## 25. MRTR 补充输入与确认

<!-- COLP-REQ MCP-0022 -->

需要补充输入或用户确认的 Tool 返回 `resultType: "input_required"`：

- 可携带 `inputRequests`：服务器分配字符串键到 ElicitRequest / CreateMessageRequest / ListRootsRequest 的映射。
- 可携带不透明 `requestState`；客户端重试时必须原样回传 `requestState`，不得检查其内容。
- 客户端重试使用新的 JSON-RPC id。
- `inputRequests` 与 `requestState` 至少提供其一；不得发送客户端未声明的 `inputRequests`。
- 服务器必须对影响授权或业务逻辑的 `requestState` 做完整性保护（Principal、TTL 与发起请求摘要），并拒绝被篡改的 `requestState`；推荐绑定 Principal、TTL 与请求 method 及关键参数。
- 高风险 Plan / Approval 使用 `input_required` 等待用户确认，不要求模型持有 Secret。

## 26. Tool Schema 预算（JSON Schema 2020-12）

<!-- COLP-REQ MCP-0023 -->

Tool `inputSchema` / `outputSchema` 使用 JSON Schema 2020-12：

- 允许 2020-12 关键字；`$ref` 解析与组合关键字的资源使用必须满足硬预算（引用解析、组合深度、节点数与字节数）。
- `structuredContent` 可为任意 JSON 值。
- `tools/list` 返回顺序必须确定性排序（语义见官方规范）。

## 27. 迁移说明与拒绝样例

<!-- COLP-REQ MCP-0024 -->

本文档只描述 MCP `2026-07-28` 无状态基线。以下旧语义仅作为拒绝样例，不是本版本合同；COLP 不提供 `2025-11-25` 兼容层、版本回退开关或 Session Store。

旧启动生命周期与 Session：

```text
initialize
notifications/initialized
Mcp-Session-Id
```

旧传输动词与恢复：

```text
GET  /collections/-/mcp
DELETE /collections/-/mcp
Last-Event-ID
```

旧订阅、日志与辅助方法：

```text
resources/subscribe
resources/unsubscribe
notifications/roots/list_changed
logging/setLevel
ping
```

服务器遇到上述 method、Header 或动词时，直接返回对应拒绝错误（不支持 method / version），不忽略后继续执行，也不尝试恢复旧事件流。
