# 04. Authorization, Security and Rate Limits

## 1. 安全边界

协议把身份、权限、公开策略和限流分开：

- Authentication：请求者是谁。
- Authorization：请求者能做什么。
- Publication：哪些数据可对公网投影。
- Rate Limit：在多长时间内能做多少次。
- Audit：谁在何时做了什么。

“拥有读取权限”不代表“可以把内容公开”；“拥有写入权限”也不代表“可以管理 Key 或 ACL”。

<a id="colp-section-2"></a>

## 2. Principal

<!-- COLP-REQ SEC-0005 -->

Principal Type：

- `user`
- `group`
- `oauth_client`
- `api_key`
- `service`
- `ai_agent`
- `public`

`public` 是服务器合成的匿名 Principal，不是“所有请求”或“所有已认证 Principal”的通配符。只有请求未通过任何 Credential 建立身份时，身份集合才包含唯一的 `{ "type": "public", "id": "public" }`；实现 MUST NOT 把 `public` 加入已包含 User、Group、OAuth Client、API Key、Service 或 AI Agent 的身份集合。调用方提交的 `public` 身份不得使已认证请求同时按匿名请求求值。

AI Agent 必须同时记录：

- 最终用户 Subject。
- OAuth Client ID 或 API Key ID。
- MCP 请求上下文（协议版本与 clientInfo）。
- Agent / Host 名称。
- 是否由用户确认。

## 3. Scope

<!-- COLP-REQ SEC-0001 -->

核心 Scope：

### 3.1 Read

- `collections:list`
- `collections:read`
- `nodes:read`
- `annotations:read`
- `attachments:read`
- `relations:read`
- `source_refs:read`
- `feed:read`
- `audit:read`

### 3.2 Write

- `collections:create`
- `collections:write`
- `collections:delete`
- `nodes:write`
- `nodes:delete`
- `annotations:write`
- `attachments:write`
- `relations:write`
- `release:publish`

### 3.3 Sync

- `sync:bootstrap`
- `sync:pull`
- `sync:push`
- `sync:resolve`

<a id="colp-section-3-4"></a>

### 3.4 Administration

- `access:read`
- `access:write`
- `keys:read`
- `keys:write`
- `rate_limits:read`
- `rate_limits:write`
- `server:admin`

Token / Key SHOULD 进一步限制：

- Collection ID Allowlist。
- Node Subtree。
- IP / Origin 条件。
- 最大操作数。
- 有效时间。
- 是否允许 Public Exposure。

读取 Scope 采用字段投影：`nodes:read` 不隐含 `annotations:read`、`attachments:read`、`relations:read` 或 `source_refs:read`。Snapshot、搜索、MCP Resource 和 Tool 必须分别检查所请求的 Included 数据；默认只返回 Node 核心字段。

## 4. Role

Role 是 Scope Bundle，不是协议判断的最终依据：

| Role | 默认 Scope |
|---|---|
| Reader | collections:read, nodes:read, feed:read |
| Editor | Reader + collections:write, nodes:write, annotations:write, attachments:write, relations:write |
| Publisher | Editor + release:publish |
| Sync Client | sync:bootstrap, sync:pull, sync:push + limited node scopes |
| Admin | access / keys / rate limits / audit |
| Owner | 全部 Collection 级 Scope |

服务器必须按 Effective Scope 校验，而不是只检查 Role 名称。

## 5. API Key

### 5.1 Key 格式

建议：

```text
colp_live_<keyId>_<secret>
colp_test_<keyId>_<secret>
```

- Secret 至少 256 bit 随机熵。
- `keyId` 可公开，用于查找和审计。
- Secret 只在创建时显示一次。
- 服务端只存储 Keyed Digest，不存明文。
- 日志最多记录前缀和 Key ID，不记录 Secret。

<a id="colp-section-5-2"></a>

### 5.2 使用

```http
Authorization: Bearer colp_live_...
```

API Key MUST NOT 放入 Query String。原因包括浏览器历史、Referer、代理日志和截图泄漏。

### 5.3 Key 类型

- `read_key`：读取指定 Protected Collection / Feed。
- `sync_key`：浏览器插件或服务副本同步。
- `publisher_key`：写 Collection 与 Release。
- `admin_key`：管理 Access、Key 和 Rate Limit。
- `one_time_key`：一次性导入、迁移或配对。

每个 Key 必须包含：

```json
{
  "id": "key_01JZ...",
  "name": "Chrome on laptop",
  "type": "sync_key",
  "scopes": ["sync:pull", "sync:push", "nodes:read", "nodes:write"],
  "collections": ["collection-1"],
  "createdAt": "2026-07-16T06:00:00Z",
  "expiresAt": "2026-10-16T06:00:00Z",
  "lastUsedAt": null,
  "lastUsedIp": null,
  "status": "active"
}
```

Key List API 永不返回 Secret。

### 5.4 轮换

- Rotate 创建新 Secret，Key ID 可以保留或生成新 ID。
- 允许配置短暂 Overlap Window。
- 旧 Secret 到期后立即拒绝。
- 轮换和撤销产生高优先级 Audit Event。

<a id="colp-section-6"></a>

## 6. OAuth 2.1

远程 MCP 和第三方应用 SHOULD 使用 OAuth 2.1 Profile：

- MCP Server 作为 Resource Server。
- 必须提供 RFC 9728 Protected Resource Metadata。
- 客户端必须使用 Authorization Server Metadata 或 OIDC Discovery。
- Authorization 和 Token 请求必须使用 RFC 8707 `resource` 参数。
- Access Token 必须绑定目标 Collection Protocol Resource Audience。
- 必须使用 Authorization Header，禁止 Query Token。
- 公共客户端必须使用 PKCE S256。
- Access Token 应短期有效，Refresh Token 应轮换。
- 服务器禁止 Token Passthrough。
- Key / ACL / Public Exposure / Purge 等高风险远程管理 SHOULD 使用 DPoP（RFC 9449）或 mTLS Sender-constrained Access Token，降低 Bearer Token 重放风险。

示例 Protected Resource Metadata：

```json
{
  "resource": "https://alice.example/collections/-/mcp",
  "authorization_servers": ["https://auth.alice.example"],
  "scopes_supported": [
    "collections:read",
    "nodes:read",
    "nodes:write",
    "sync:pull",
    "sync:push"
  ]
}
```

Scope 不足：

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope",
  scope="access:write",
  resource_metadata="https://alice.example/.well-known/oauth-protected-resource/collections/-/mcp"
```

### 6.1 OAuth client issuer 绑定（MCP 2026-07-28）

<!-- COLP-REQ SEC-0019 -->

MCP OAuth 客户端必须把授权响应中的 `iss`（RFC 9207）与发起授权时记录的 Authorization Server Issuer 精确比对；缺失或不一致时必须中止 code 交换，不携带客户端凭据继续。动态客户端注册（RFC 7591）必须声明 `application_type`。客户端凭据必须按 issuer 隔离：同一 client_id / client_secret 不得跨 Authorization Server 复用；issuer 变更时客户端必须重新注册。资源服务器仍逐请求验证 Access Token，issuer 绑定不替代 Token 校验。

<a id="colp-section-7"></a>

## 7. Access Policy

<!-- COLP-REQ SEC-0002 -->

```json
{
  "visibility": "protected",
  "entries": [
    {
      "principal": { "type": "public", "id": "public" },
      "effect": "deny",
      "scopes": ["collections:read", "nodes:read"]
    },
    {
      "principal": { "type": "api_key", "id": "key_reader_1" },
      "effect": "allow",
      "scopes": ["collections:read", "nodes:read", "feed:read"]
    }
  ],
  "publication": {
    "listInDirectory": false,
    "allowSearchIndexing": false,
    "allowEmbedding": false
  },
  "revision": "acl_17"
}
```

规则：

- Explicit Deny 优先于 Allow。
- 所有 Policy 层都强制继承：服务器必须依次求值 Server Default、Collection、全部祖先 Node 与对象 Policy。`AccessPolicy` 和 `AccessPolicyPatch` 不提供 `inherit` 布尔值或任何跳过祖先的开关。
- Node Policy 只能收紧父 Collection / Node Policy，不能恢复任何上层已移除的 Scope。
- ACL 写入必须使用 `If-Match`。
- ACL 变化不得使用一般 Node Write Scope。
- 将 `private` 或 `protected` 改为 `public` 属于高风险操作。
- 从公开状态收紧为 `protected` / `private` 或删除时，服务器必须清理自己控制的 CDN / Shared Cache、撤销当前可变 URL 的发布索引，并停止签发新的公共响应。规范无法召回已被第三方下载的数据，确认界面必须明确说明公开可能不可逆。

Effective Policy 按以下顺序求值：

1. 构造请求身份集合：已认证请求包含最终用户、Group、OAuth Client、API Key / Service 等已验证身份，但不包含 `public`；仅当不存在任何已认证身份时，使用唯一的合成 `public` 身份。`public` ACL Entry 只匹配匿名请求，不是 Principal 通配符。
2. 从 Credential / Grant Scope 开始，固定依次处理服务器默认策略、Collection、全部祖先 Node 与对象策略；实现 MUST NOT 省略、重排或短路这条链。
3. 每一层把当前 Scope 与该层匹配的 Allow Scope 取交集，再移除全部匹配 Deny。`public` / `unlisted` Visibility 是独立于 Principal ACL 的公开读取授权来源，可供匿名或已认证请求使用；`public` ACL Entry 仍只匹配匿名请求。
4. 子层只能继续取交集，不能恢复父层已移除的 Scope。任意层 Explicit Deny 都优先。
5. 默认决策为 Deny。资源是否用 `403` 还是隐藏为 `404` 由 Endpoint 的 Concealment Policy 决定，但同一资源类型必须一致，且不得通过响应差异泄漏 private / unlisted 资源存在性。

## 8. Rate Limit

<!-- COLP-REQ SEC-0004 -->

<a id="colp-section-8-1"></a>

### 8.1 Bucket

服务器 SHOULD 至少区分：

- Anonymous Feed Read。
- Authenticated Read。
- Sync Pull。
- Sync Push。
- General Write。
- MCP Tool Call。
- Admin / Key Management。

Bucket Key 可包含 Principal、IP、Collection、Endpoint Class。

实现 MUST 同时具备 Subject / Credential、IP 和实例级上限，不能只选择其中一个维度。Batch、Sync Push 和 MCP Tool 按展开后的 Operation Cost 与受影响对象数计费；拆成并行小请求不得降低总 Cost。SSE / Subscription 另行限制连接数、订阅资源数、队列字节、事件速率、Idle Timeout 和最大生命周期。Grant `maxWrites` 与限流计数必须原子扣减。

<a id="colp-section-8-2"></a>

### 8.2 响应头

成功和限流响应 SHOULD 使用 RFC 9651：

```http
RateLimit: "feed:anonymous";r=83;t=27
RateLimit-Policy: "feed:anonymous";q=120;w=60
```

旧 `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` 只能作为显式兼容扩展，不属于 0.1 核心合同。

限流时：

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 27
Content-Type: application/problem+json
```

```json
{
  "type": "https://collectionprotocol.org/problems/rate-limited",
  "title": "Too many requests",
  "status": 429,
  "code": "rate_limited",
  "retryAfterSeconds": 27,
  "bucket": "feed:anonymous"
}
```

### 8.3 配置模型

```json
{
  "id": "feed:anonymous",
  "scope": {
    "endpointClass": "feed",
    "principalType": "public"
  },
  "limit": 120,
  "windowSeconds": 60,
  "burst": 20,
  "concurrency": 10,
  "minIntervalMilliseconds": 500,
  "action": "reject",
  "revision": "rl_8"
}
```

### 8.4 安全下限

远程管理 API 不得允许把管理和认证端点设为无限制。实现必须提供硬编码或部署级 Minimum Safety Policy，应用级配置不能降低该下限。

<a id="colp-section-9"></a>

## 9. 请求安全

- 全部远程端点 MUST 使用 HTTPS。
- Streamable HTTP MCP MUST 校验 Origin，防止 DNS Rebinding。
- CORS 默认关闭，按明确 Origin Allowlist 开启。
- 服务器必须限制请求体、批次、解析成员数、图遍历 Node 数、深度、URL 长度和附件大小；远端请求不能放宽部署 Hard Limit。
- JSON Parser 必须在构造业务对象前执行确定的嵌套深度与成员/数组项预算，防止原型污染与超深嵌套；捕获运行时调用栈溢出不能替代显式预算。
- I-JSON Parser 必须在构造业务对象前拒绝重复成员、超出安全范围的协议整数、非有限数字和 `__proto__` / `constructor` / `prototype` 等原型污染键；先用普通 `JSON.parse` 再检查重复键不符合要求。
- URL 抓取功能必须防止 SSRF。每个 Redirect Hop 都要重新解析和校验 DNS / IP，拒绝 Loopback、Link-local、Private、ULA、CGNAT、Multicast、Unspecified 和云 Metadata 地址；连接到已验证 IP，同时保留正确 TLS SNI。
- 抓取器禁止 URL Userinfo，限制 Redirect 次数、响应字节、解压比、总时长和并发。Authorization、Cookie 和 Collection Protocol 凭据不得转发到抓取目标或跨 Origin Redirect。
- 推荐通过隔离的 Egress Proxy 执行抓取；只检查第一次 DNS 解析不符合 SSRF 防护要求。
- HTML / Markdown 输出必须按目标上下文 Sanitization。
- Attachment 下载应进行 MIME Sniffing 防护、Content-Disposition 和大小限制。
- 日志必须 Redact Authorization、Cookie、Secret、Sync Session ID 和私人 Note。
- Bookmark、Attachment、Approval 等 URL 的 Query / Fragment 视为潜在 Secret。日志和 Problem Details 默认只保留 Scheme、Host 与 Path Hash，不回显完整 URL。

<a id="colp-section-10"></a>

## 10. Content Integrity

公开 Snapshot 和 Feed SHOULD 提供：

```http
Content-Digest: sha-256=:...:
Signature-Input: sig1=("@method" "@target-uri" "content-digest" "content-type");keyid="ed25519-2026-01";alg="ed25519"
Signature: sig1=:...:
```

- 使用 RFC 9530 Content-Digest。
- 使用 RFC 9421 HTTP Message Signatures。
- 推荐 Ed25519。
- Public Key 通过 JWKS 或 Manifest 声明。
- Key Rotation 必须保留足够时间的旧公钥用于验证历史 Release。
- 可变资源的签名输入 SHOULD 覆盖 `@status`、`created`、`expires`、`etag` 和协议版本，客户端必须限制最大陈旧期。历史 Release 使用带 Release ID / Revision 的不可变 URI。

签名证明内容来自某个服务器，不自动证明 Bookmark 指向的外部网页真实、安全或未变化。

## 11. Audit Log

高价值操作必须审计：

- 登录、授权和 Scope Upgrade。
- Key 创建、显示、轮换、撤销。
- ACL 与公开性变化。
- Rate Limit 变化。
- Collection 删除、Restore、Release。
- 大批量 Sync、冲突解决。
- MCP 高风险工具调用。

```json
{
  "id": "audit_01JZ...",
  "time": "2026-07-16T06:30:00Z",
  "actor": {
    "principalId": "user:alice",
    "clientId": "https://ai-client.example/client.json",
    "agent": "Example AI Host"
  },
  "action": "access.visibility.changed",
  "target": "collection:interface-systems",
  "result": "success",
  "risk": "high",
  "confirmation": {
    "required": true,
    "method": "out_of_band",
    "confirmedAt": "2026-07-16T06:29:58Z"
  },
  "metadata": {
    "from": "protected",
    "to": "public"
  }
}
```

Audit Log 不应记录 Bookmark 私人正文、Token 或完整 Key。

## 12. 默认安全策略

新服务器推荐默认值：

- 新 Collection：`private`。
- 新 Annotation：`private`。
- 新 API Key：90 天有效、限定 Collection、最小 Scope。
- 匿名 Directory：60 秒最小轮询。
- MCP 写工具：OAuth 必需。
- Public Exposure、Delete、Key、ACL、Rate Limit：二阶段确认。
- Feed：默认 `release` 而不是 `live`。
- Public Snapshot：不包含 SourceRef、私人 Annotation、抓取正文和本地附件。
- 未知 Extension：权威 / Sync 存储保留，公共、Feed 和 Assistant 投影默认排除；只有显式 Allowlist 且具有发布 Schema 的 Namespace 可公开。

## 13. Threat Matrix

| 威胁 | 主要防护 |
|---|---|
| API Key 泄漏 | Header 传输、只显示一次、Digest 存储、Scope / Collection / Expiry 限制、轮换 |
| Token 被错误服务接收 | RFC 8707 Resource、Audience Validation、禁止 Token Passthrough |
| DNS Rebinding 到本地 MCP | Origin Validation、本地只绑定 127.0.0.1、认证 |
| SSRF 抓取内网 URL | Scheme Allowlist、DNS / IP 校验、禁止 Metadata 与私网、响应大小限制 |
| Prompt Injection 触发管理操作 | 外部内容视为数据、Tool Scope、Change Plan、Out-of-band Approval |
| AI 读取明文 Key | MCP Result 不返回 Secret，只提供 Reveal URI |
| 公开 Collection 意外泄漏私人 Note | 独立 Visibility、Public Projection Allowlist、Release Preview |
| 并发覆盖 | ETag、If-Match、Base Revision、Conflict |
| 旧副本复活已删除节点 | Tombstone、Delete Dominates、显式 Restore |
| 轮询或 Tool 滥用 | 独立 Bucket、429、Retry-After、Cost Unit、并发限制 |
| 审计日志泄密 | Redaction、最小 Metadata、访问 Scope、保留策略 |
| 恶意扩展字段 | Namespace、Schema / Size Limit、输出 Sanitization、未知字段不执行 |
| 大树 / 深层 JSON DoS | Body、Depth、Node、Batch、Pagination 与执行时间限制 |
