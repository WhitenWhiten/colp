# 07. NestJS Integration Profile

## 1. 目标形态

用户可以把协议作为 NestJS Module 加载到现有博客：

```ts
import { CollectionProtocolModule } from '@collection-protocol/node/nestjs'

@Module({
  imports: [
    CollectionProtocolModule.forRoot({
      mountPath: '/collections',
      publicOrigin: 'https://alice.example',
      ports: {
        core: new PostgresCoreReadPort(),
        publication: new PostgresPublicationReadPort(),
        publisher: new PostgresPublisherPort(),
        feed: new PostgresFeedProjectionPort(),
        sync: new PostgresSyncPort(),
        mcp: new StreamableHttpMcpPort(),
      },
      auth: new ExistingBlogAuthAdapter(),
      features: {
        publisher: true,
        feed: true,
        sync: true,
        mcp: true,
        admin: true,
      },
    }),
  ],
})
export class AppModule {}
```

协议包不应强制博客使用特定 ORM、身份系统或队列。

## 2. 推荐包结构

0.1 首发使用单包和 Subpath Export；Foundation Milestone 只公开合同工具链，后续入口只有在对应 Profile 实现并通过测试后才公开：

```text
@collection-protocol/node/schema
@collection-protocol/node/types
@collection-protocol/node/semantic
@collection-protocol/node/client
@collection-protocol/node/server
@collection-protocol/node/conformance

# 后续 Profile 入口
@collection-protocol/node/publisher
@collection-protocol/node/feed
@collection-protocol/node/sync
@collection-protocol/node/security
@collection-protocol/node/mcp
@collection-protocol/node/nestjs
```

NestJS 使用可选 Peer Dependency；Chromium / Firefox 等浏览器运行时 Adapter 成熟后独立发布，不并入 Node target。入口为空或尚未通过对应 Profile 测试时不得提前 Export。

<a id="colp-section-3"></a>

## 3. 可组合 Ports

Storage 不得用一个巨型接口强制所有 Adapter 实现未启用的 Profile。NestJS Module 接收按能力组合的 Ports；每个可选 Port 只在对应 Profile 启用时需要：

```ts
export interface CoreReadPort {
  listCollections(query: ListCollectionsQuery): Promise<CursorPage<Collection>>
  getCollection(id: string): Promise<Collection | null>
  listNodes(collectionId: string, query: ListNodesQuery): Promise<CursorPage<Node>>
  getNode(collectionId: string, nodeId: string): Promise<Node | null>
  listAnnotations(collectionId: string, query: SidecarQuery): Promise<CursorPage<Annotation>>
  getAnnotation(collectionId: string, annotationId: string): Promise<Annotation | null>
  listAttachments(collectionId: string, query: SidecarQuery): Promise<CursorPage<Attachment>>
  getAttachment(collectionId: string, attachmentId: string): Promise<Attachment | null>
  listRelations(collectionId: string, query: SidecarQuery): Promise<CursorPage<Relation>>
  getRelation(collectionId: string, relationId: string): Promise<Relation | null>
  getAccessPolicy(target: AccessTarget): Promise<AccessPolicy>
}

export interface PublicationReadPort {
  createSnapshot(collectionId: string, options: SnapshotOptions): Promise<Snapshot>
}

export interface PublisherReadPort {
  listReleases(collectionId: string, query: CursorPageQuery): Promise<CursorPage<Release>>
  getRelease(collectionId: string, releaseId: string): Promise<Release | null>
}

export interface PublisherResourceStore {
  createCollection(input: CollectionCreateRequest, context: WriteContext): Promise<CollectionCreateResult>
  updateCollection(id: string, patch: CollectionMergePatch, condition: RevisionCondition, context: WriteContext): Promise<Collection>
  applyOperations(batch: OperationBatch, context: WriteContext): Promise<OperationBatchResult>
  publishRelease(collectionId: string, input: ReleaseCreate, condition: RevisionCondition, context: WriteContext): Promise<ReleaseResult>
  updateAccessPolicy(target: AccessTarget, input: AccessPolicyInput, condition: RevisionCondition): Promise<AccessPolicy>
}

export interface PublisherTransaction {
  readonly resources: PublisherResourceStore
  readonly idempotency: IdempotencyStore
  readonly operations: OperationStore
  readonly audit: AuditStore
  readonly outbox: OutboxStore
}

export interface PublisherUnitOfWork {
  execute<T>(work: (tx: PublisherTransaction) => Promise<T>): Promise<T>
}

export interface PublisherPort {
  readonly reads: PublisherReadPort
  readonly unitOfWork: PublisherUnitOfWork
}

export interface FeedProjectionPort {
  pullEvents(cursor: string | null, options: FeedPullOptions): Promise<FeedPullResult>
}

export interface SyncStateStore {
  // Session、Replica、Sequence Receipt、Cursor、Conflict 与 Ack 持久化命令。
}

export interface SyncTransaction extends PublisherTransaction {
  readonly sync: SyncStateStore
}

export interface SyncUnitOfWork {
  execute<T>(work: (tx: SyncTransaction) => Promise<T>): Promise<T>
}

export interface SyncPort {
  readonly unitOfWork: SyncUnitOfWork
  createSnapshot(collectionId: string, options: SyncSnapshotOptions): Promise<Snapshot>
  pullEvents(cursor: string | null, options: SyncPullOptions): Promise<SyncPullResult>
}

export interface McpPort {
  bind(services: McpApplicationServices): Promise<McpServerHandle>
}

export interface CollectionProtocolPorts {
  readonly core: CoreReadPort
  readonly publication?: PublicationReadPort
  readonly publisher?: PublisherPort
  readonly feed?: FeedProjectionPort
  readonly sync?: SyncPort
  readonly mcp?: McpPort
}
```

`McpPort` 只是 Transport Adapter，必须绑定同一组 Application Services；`mcp-read` 复用 Core 读取服务，在具体 Resource 表示与 Publication 合同相同时可以复用其投影服务，但这不会形成 `publication` Profile 依赖。`mcp-write` 复用 Publisher Service，不得直接取得数据库连接。Sync 写入也复用 Publisher Operation 路径，但 `SyncTransaction` 额外包含 Sequence Receipt、Cursor 和 Conflict 状态，因此这些状态可与业务变更一起提交。

除 Collection + Root 的原子创建和不可变 Release 发布外，Node 与 Sidecar 写入 SHOULD 统一转换为核心 Operation 后交给 `applyOperations`。这样 HTTP、Sync 与 MCP 复用同一授权、冲突、审计和 Outbox 路径；Adapter 不维护第二套写入语义。

所有 Publisher 写路径必须在一个 `PublisherUnitOfWork.execute()` 回调内完成：抢占 Idempotency Key、检查前置条件、修改资源、追加 Operation / Audit / Outbox，并保存第一次请求的完整 `status`、`headers` 与 `body`。任一步失败必须回滚全部子 Store，子 Store 不得独立提交或逃逸事务回调。

`IdempotencyStore` 必须在数据库层对 `(principalId, protocolVersion, method, endpointKey, resourceIdentity, key)` 实施唯一约束；`requestDigest` 不属于唯一键，同一键的不同摘要返回 `409 idempotency_key_reused`。并发相同请求由 Adapter 的事务隔离与唯一约束串行化：等待首次结果并重放，或返回可重试的 `409 idempotency_in_progress`。进程内锁不能代替这个约束。

安全审计可以有独立的非事务写入 Port，但只用于认证失败、限流等没有业务状态变更的事件，不能用于需要和资源修改原子一致的审计。

## 4. Auth Port

```ts
export interface CollectionAuthAdapter {
  authenticate(request: RequestLike): Promise<Principal | null>
  authorize(principal: Principal | null, action: AuthorizedAction): Promise<AuthorizationDecision>
  getProtectedResourceMetadata(): Promise<OAuthProtectedResourceMetadata | null>
}
```

Blog 可以复用现有 Session Cookie 管理 Web Admin，同时为远程 API 和 MCP 提供 OAuth / API Key。

Cookie 认证的写请求仍必须实施 CSRF 防护。

Browser CORS Allowlist 需要允许 `If-Match`、`If-None-Match`、`Idempotency-Key`、`Collection-Protocol-Version` 和 `Content-Type`，并暴露 `ETag`、`Link`、`Location`、`Retry-After`、`Content-Digest`、`RateLimit`、`RateLimit-Policy` 与 `WWW-Authenticate`。CORS 不是认证或授权替代品。

## 5. Module Configuration

```ts
type CollectionProtocolOptions = {
  mountPath: string
  publicOrigin: string
  serverId?: string
  ports: CollectionProtocolPorts
  auth: CollectionAuthAdapter
  keyStore?: ApiKeyStore
  rateLimiter?: CollectionRateLimiter
  signer?: HttpMessageSigner
  queue?: CollectionEventQueue
  approval?: ApprovalProvider
  features: {
    directory?: boolean
    publisher?: boolean
    feed?: boolean
    jsonFeed?: boolean
    atom?: boolean
    webSub?: boolean
    sync?: boolean
    mcp?: boolean
    admin?: boolean
  }
  mcp?: {
    protocolVersion?: string
    endpoint?: string
    resources?: boolean
    tools?: boolean
    subscriptions?: boolean
    exposeToolsByScope?: boolean
  }
  defaults?: {
    visibility?: 'private' | 'protected' | 'unlisted' | 'public'
    feedMode?: 'release' | 'live' | 'disabled'
    tombstoneRetentionSeconds?: number
    minPollIntervalSeconds?: number
  }
}
```

Module 必须按 Profile 依赖检查 `ports`，不能因为 `features` 中的布尔值为真就宣称能力：

| Profile | 必需 Port |
|---|---|
| `core` | `core` |
| `publication` | `core`、`publication` |
| `publisher` | 已合规的 `publication`、`publisher.reads`、`publisher.unitOfWork`、Auth |
| `feed` | 已合规的 `publication`、`feed`；会产生事件的写入还要求 Publisher Transactional Outbox |
| `sync` | `core`、`sync.unitOfWork`，其 Transaction 必须包含完整 Publisher Transaction |
| `mcp-read` | `core`、`mcp` |
| `mcp-write` | 已合规的 `mcp-read`、`publisher`，以及高风险操作所需的 Approval Provider |

`queue` 只是消费已提交 Outbox 的执行方式，不能代替 `PublisherTransaction.outbox`。生产集成还应提供 `forRootAsync()` 与稳定 Provider Token，以便从 Nest DI 分别注入 Ports、Auth、Signer 和 Approval Provider。未启用 Profile 的 Port 可以完全不提供。

## 6. Generated Routes

模块按 Feature 注册端点：

```text
GET  /.well-known/collection-protocol

GET  /collections
POST /collections
GET  /collections/-/feed

GET    /collections/c/:collectionId
PATCH  /collections/c/:collectionId
DELETE /collections/c/:collectionId
GET    /collections/c/:collectionId/snapshot
GET    /collections/c/:collectionId/feed
POST   /collections/c/:collectionId/release
GET    /collections/c/:collectionId/releases
GET    /collections/c/:collectionId/releases/:releaseId
GET    /collections/c/:collectionId/releases/:releaseId/snapshot

POST   /collections/c/:collectionId/nodes
GET    /collections/c/:collectionId/nodes/:nodeId
PATCH  /collections/c/:collectionId/nodes/:nodeId
DELETE /collections/c/:collectionId/nodes/:nodeId
POST   /collections/c/:collectionId/nodes/:nodeId/move
POST   /collections/c/:collectionId/annotations
PATCH/DELETE /collections/c/:collectionId/annotations/:annotationId
POST   /collections/c/:collectionId/attachments
PATCH/DELETE /collections/c/:collectionId/attachments/:attachmentId
POST   /collections/c/:collectionId/relations
PATCH/DELETE /collections/c/:collectionId/relations/:relationId
GET/PATCH /collections/c/:collectionId/access

POST /collections/-/sync/sessions
GET  /collections/-/sync/snapshot
POST /collections/-/sync/push
GET  /collections/-/sync/pull
POST /collections/-/sync/ack
POST /collections/-/sync/conflicts/:conflictId/resolve

POST /collections/-/mcp

GET/PATCH /collections/-/admin/access
GET/POST  /collections/-/admin/keys
POST      /collections/-/admin/keys/:keyId/rotate
DELETE    /collections/-/admin/keys/:keyId
GET/PATCH /collections/-/admin/rate-limits
GET       /collections/-/admin/audit
```

## 7. Middleware 顺序

推荐：

```text
Request ID
→ Trusted Proxy / Client IP
→ Body Size Limit
→ Origin / CORS / CSRF
→ Authentication
→ Rate Limit
→ Authorization
→ Schema Validation
→ Revision / Idempotency
→ Controller
→ Audit
→ Signature / Content-Digest
→ Response
```

认证失败和限流失败也应产生轻量安全审计，但要采样，防止攻击制造无限日志。

## 8. Controller 与 Service 边界

- Controller 只处理 HTTP、Header、Status Code 和 DTO。
- Application Service 执行协议语义。
- Storage Adapter 只负责持久化。
- Feed Projection Service 负责脱敏，不能直接返回内部实体。
- MCP Adapter 调用同一 Application Service，禁止绕过 Authorization Guard。

## 9. 数据库建议

关系数据库示例：

```text
collections
collection_nodes
annotations
attachments
relations
source_refs
operations
sync_cursors
replicas
tombstones
conflicts
access_policies
api_keys
rate_limit_policies
approval_plans
audit_events
idempotency_records
outbox_events
feed_events
```

关键索引：

- `(collection_id, parent_id, position)`。
- `(replica_id, collection_id, sequence)` 唯一。
- `op_id` 唯一。
- Idempotency `(principal_id, protocol_version, method, endpoint_key, resource_identity, key)` 唯一，记录请求摘要与首次完整响应。
- `outbox_event_id` 唯一，并为未投递事件建立提交顺序索引。
- `(collection_id, canonical_url_hash)` 非唯一候选索引。
- Feed / Sync Cursor 提交顺序索引。
- Active Key ID。
- Tombstone PurgeAfter。

## 10. Event Outbox

写操作和 Feed / WebSub / Search Index 更新必须使用 Transactional Outbox：

```text
数据库事务：
  抢占 Idempotency Key
  更新 Collection / Node
  写 Operation Log
  写 Audit Event
  写 Outbox Event
  保存首次完整 HTTP Response
提交

后台 Worker：
  公共投影
  Feed Event
  WebSub Ping
  Search Index
  Cache Invalidation
```

不得在数据库提交前发送 Feed，否则消费者可能看到不存在的 Revision。

事务回调抛出异常时，上述六项必须全部回滚。Adapter Contract Test 应在 Resource、Operation、Audit、Outbox 和 Idempotency Result 每个边界注入失败，并验证重试只产生一份业务状态和事件；并发 Contract Test 应验证同一唯一键只有一个事务执行，其余请求重放首次响应或取得 `idempotency_in_progress`。

Module 启动时必须根据实际注册的 Route、Profile-specific Ports、Publisher Unit of Work、Auth 和 Outbox 能力计算 Mount `profiles`。依赖不完整时应拒绝启动相应 Feature 或降低 Manifest 声明，不能继续宣称完整 Profile。

## 11. Approval Provider

```ts
export interface ApprovalProvider {
  createPlan(input: ChangePlanInput, principal: Principal): Promise<ChangePlan>
  getPlan(planId: string, principal: Principal): Promise<ChangePlan | null>
  approve(planId: string, userSession: UserSession): Promise<void>
  consumeApproval(planId: string, context: CommitContext): Promise<ApprovedPlan>
}
```

MCP 高风险 Tool 和 Web Admin 使用同一 Approval Plan。

## 12. MCP Adapter

```ts
CollectionProtocolModule.forRoot({
  features: { mcp: true },
  mcp: {
    protocolVersion: '2026-07-28',
    endpoint: '/collections/-/mcp',
    resources: true,
    tools: true,
    subscriptions: true,
    exposeToolsByScope: true,
  },
})
```

MCP Server 在每次请求根据 Principal Scope 动态列出 Tools，请求携带 `_meta.io.modelcontextprotocol/protocolVersion: 2026-07-28` 与 client capabilities。Scope 变化时通过 `subscriptions/listen` 连接发送 `notifications/tools/list_changed`；不维护 MCP Session，不使用旧版 Session Header。

## 13. 公共博客集成

HTML 页面可以加入：

```html
<link rel="collection-protocol" href="/.well-known/collection-protocol">
<link rel="alternate" type="application/feed+json" href="/collections/-/feed.json">
```

Collection 详情页可以由博客模板渲染，但 JSON Canonical Endpoint 保持稳定。

## 14. 反向代理

部署在 Nginx、Caddy、Cloudflare 后：

- 配置可信代理列表，禁止伪造 `X-Forwarded-For`。
- Streamable HTTP SSE 关闭不必要缓冲。
- 保留并转发 `MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name`、`Mcp-Param-*`、`X-Accel-Buffering`、`ETag`、`If-Match`；不保留旧版 Session / SSE 恢复 Header（MCP 2026-07-28 不使用 Session 或 SSE 恢复）。
- 不缓存带 Authorization 的响应，除非有明确私有缓存策略。
- Sync、Admin、MCP 和任何因 Authorization 改变的响应使用 `Cache-Control: no-store`；SSE 还应限制连接数、队列字节、Idle Timeout 和最大生命周期。
- 对 `.well-known`、Manifest 和 Public Feed 可启用 CDN。

## 15. Static Reader Export

NestJS Publisher 可以生成静态 Bundle：

```ts
await protocol.exportStatic({
  output: './public',
  collections: 'public',
  formats: ['colp', 'json-feed'],
  sign: true,
})
```

静态 Bundle 适合 GitHub Pages、对象存储或 CDN，不包含 Admin、Sync 和写 MCP。

## 16. Conformance

`@collection-protocol/conformance` 应测试：

- Discovery 与 Link。
- Schema 与未知 Extension 保留。
- ETag、If-Match、412 / 428。
- Cursor Pagination。
- Feed 脱敏。
- 429 与 Retry-After。
- API Key Scope。
- OAuth Audience。
- Sync 幂等、Tombstone、Move、Conflict。
- MCP Tool Schema、Structured Content、Scope Filtering。
- 高风险操作必须 Plan / Approval / Commit。
- Key Secret 不进入 MCP Result。

## 17. Profile 交付顺序

本节使用“Profile 交付里程碑”，不使用 `Phase 1` 表示包脚手架或浏览器产品路线。Node 包的 Foundation Milestone 是 Schema、Types、Semantic、Client、Server 与 Conformance 工具链，不代表任何 Profile 已合规；Profile 的实现顺序与 `docs/10-implementation-contract.md` 一致：

1. `core + publication`：Manifest、Directory、Collection、Snapshot 与 Publication 安全投影。
2. `publisher`：条件写入、幂等、Publisher Unit of Work、Operation、Audit 与 Transactional Outbox。
3. `feed`：先完成 `release` 模式和 JSON Feed，再扩展 Live Feed / WebSub。
4. `sync`：Session、Snapshot、Push / Pull / Ack、Replica、Tombstone 与 Conflict 状态机。
5. `mcp-read` / `mcp-write`：Resources / Tools、OAuth 2.1、高风险 Approval Plan 与 Scope Filtering。

浏览器 Adapter、Admin UI、HTTP Signatures、公共 Conformance Registry 与 Server Directory 是独立产品轨道。它们可以按依赖成熟度并行推进，但不能改变上述 Profile 依赖，也不能用产品轨道完成度替代 Profile Conformance Evidence。
