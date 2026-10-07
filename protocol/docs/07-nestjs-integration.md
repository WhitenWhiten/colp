# 07. NestJS Integration (Illustrative)

> **In short:** An illustrative example, not a required design, of embedding COLP in an existing server application, using NestJS as the framework. It sketches a module, the ports a host implements (storage, authentication, outbox, and approvals), the generated routes, middleware order, database suggestions, and the order in which to deliver profiles. The reference package `@collection-protocol/node` is framework-neutral and does not ship a NestJS module.
>
> **Read this if** you are wiring COLP into a server application. **Profiles:** none of its own.

This chapter describes how a host application, using NestJS as the example framework, embeds the protocol. The module shape, option names, and routes below are illustrative. The reference package `@collection-protocol/node` is framework-neutral: it provides the protocol logic and port interfaces, and does not publish a NestJS module.

<a id="colp-section-1"></a>

## 1. Target Shape

A user can load the protocol into an existing blog as a NestJS module:

```ts
import { CollectionProtocolModule } from './collection-protocol.module'

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

The protocol package should not force the blog to use a particular ORM, identity system, or queue.

<a id="colp-section-2"></a>

## 2. Package Structure

The reference implementation is a single package with subpath exports. A subpath is exported only after the corresponding profile is implemented and tested:

```text
@collection-protocol/node/schema
@collection-protocol/node/types
@collection-protocol/node/semantic
@collection-protocol/node/client
@collection-protocol/node/server
@collection-protocol/node/publisher
@collection-protocol/node/feed
@collection-protocol/node/sync
@collection-protocol/node/security
@collection-protocol/node/mcp
@collection-protocol/node/conformance
```

Framework modules such as NestJS live in the host, or in a separate package with NestJS as an optional peer dependency. Browser runtime adapters for Chromium, Firefox, and others are published separately when they mature and are not merged into the Node target. An entry point that is empty or has not yet passed its profile tests must not be exported early.

<a id="colp-section-3"></a>

## 3. Composable Ports

Storage must not force every adapter to implement profiles it has not enabled through one giant interface. The module receives ports composed by capability; each optional port is needed only when its profile is enabled:

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
  // Persistence commands for sessions, replicas, sequence receipts, cursors, conflicts, and acks.
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

`McpPort` is only a transport adapter and must be bound to the same set of application services. `mcp-read` reuses the core read services, and may reuse the projection services of Publication where a resource representation is the same as the Publication contract, but this does not create a dependency on the `publication` profile. `mcp-write` reuses the publisher service and must not obtain database connections directly. Sync writes also reuse the publisher operation path, but `SyncTransaction` additionally contains the sequence receipt, cursor, and conflict state, so that state can be committed together with the business change.

Except for the atomic creation of a Collection with its root and for publishing an immutable Release, Node and sidecar writes SHOULD be converted into core operations and handed to `applyOperations`. HTTP, Sync, and MCP then share the same authorization, conflict, audit, and outbox path, and adapters do not maintain a second set of write semantics.

Every publisher write path must complete inside one `PublisherUnitOfWork.execute()` callback: claiming the idempotency key, checking preconditions, modifying resources, appending the operation, audit, and outbox entries, and saving the complete `status`, `headers`, and `body` of the first request. If any step fails, every sub-store must roll back; sub-stores must not commit independently or escape the transaction callback.

`IdempotencyStore` must enforce a database-level unique constraint on `(principalId, protocolVersion, method, endpointKey, resourceIdentity, key)`. `requestDigest` is not part of the unique key; a different digest for the same key returns `409 idempotency_key_reused`. Concurrent identical requests are serialized by the adapter's transaction isolation and the unique constraint: they wait for the first result and replay it, or return a retryable `409 idempotency_in_progress`. An in-process lock cannot replace this constraint.

Security auditing may have a separate non-transactional write port, but only for events without business state changes, such as failed authentication or rate limiting; it cannot be used for audits that must be atomically consistent with resource changes.

<a id="colp-section-4"></a>

## 4. Auth Port

```ts
export interface CollectionAuthAdapter {
  authenticate(request: RequestLike): Promise<Principal | null>
  authorize(principal: Principal | null, action: AuthorizedAction): Promise<AuthorizationDecision>
  getProtectedResourceMetadata(): Promise<OAuthProtectedResourceMetadata | null>
}
```

A blog can keep using its existing session cookies for its web admin, while offering OAuth and API keys for the remote API and MCP.

Cookie-authenticated write requests must still enforce CSRF protection.

The browser CORS allowlist needs to allow `If-Match`, `If-None-Match`, `Idempotency-Key`, `Collection-Protocol-Version`, and `Content-Type`, and to expose `ETag`, `Link`, `Location`, `Retry-After`, `Content-Digest`, `RateLimit`, `RateLimit-Policy`, and `WWW-Authenticate`. CORS is not a substitute for authentication or authorization.

<a id="colp-section-5"></a>

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

The module must check `ports` against the profile dependencies; it cannot claim a capability just because a boolean in `features` is true:

| Profile | Required ports |
|---|---|
| `core` | `core` |
| `publication` | `core`, `publication` |
| `publisher` | A conforming `publication`, `publisher.reads`, `publisher.unitOfWork`, auth |
| `feed` | A conforming `publication`, `feed`; writes that produce events also require the publisher transactional outbox |
| `sync` | `core`, `sync.unitOfWork`, whose transaction must contain the complete publisher transaction |
| `mcp-read` | `core`, `mcp` |
| `mcp-write` | A conforming `mcp-read`, `publisher`, and the approval provider needed for high-risk operations |

`queue` is only a way to consume the committed outbox; it cannot replace `PublisherTransaction.outbox`. A production integration should also provide `forRootAsync()` and stable provider tokens, so that ports, auth, the signer, and the approval provider can be injected separately through Nest DI. Ports of profiles that are not enabled can be left out entirely.

<a id="colp-section-6"></a>

## 6. Generated Routes

The module registers endpoints by feature:

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

<a id="colp-section-7"></a>

## 7. Middleware Order

Recommended:

```text
Request ID
→ Trusted proxy / client IP
→ Body size limit
→ Origin / CORS / CSRF
→ Authentication
→ Rate limit
→ Authorization
→ Schema validation
→ Revision / idempotency
→ Controller
→ Audit
→ Signature / Content-Digest
→ Response
```

Failed authentication and rate limiting should also produce lightweight security audit events, but sampled, so that attackers cannot generate unlimited logs.

<a id="colp-section-8"></a>

## 8. Controller and Service Boundaries

- Controllers handle only HTTP, headers, status codes, and DTOs.
- Application services carry out protocol semantics.
- Storage adapters only handle persistence.
- The feed projection service is responsible for redaction and must not return internal entities directly.
- The MCP adapter calls the same application services and must not bypass the authorization guard.

<a id="colp-section-9"></a>

## 9. Database Suggestions

Example relational tables:

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

Key indexes:

- `(collection_id, parent_id, position)`.
- Unique `(replica_id, collection_id, sequence)`.
- Unique `op_id`.
- Unique idempotency key `(principal_id, protocol_version, method, endpoint_key, resource_identity, key)`, recording the request digest and the complete first response.
- Unique `outbox_event_id`, with a commit-order index over undelivered events.
- A non-unique candidate index on `(collection_id, canonical_url_hash)`.
- Commit-order indexes for Feed and Sync cursors.
- Active key IDs.
- Tombstone `purgeAfter`.

<a id="colp-section-10"></a>

## 10. Event Outbox

Writes and the updates of Feed, WebSub, and search indexes must use a transactional outbox:

```text
Database transaction:
  Claim the idempotency key
  Update the Collection / Node
  Write the operation log
  Write the audit event
  Write the outbox event
  Save the complete first HTTP response
Commit

Background worker:
  Public projection
  Feed event
  WebSub ping
  Search index
  Cache invalidation
```

A Feed must not be sent before the database commits, or consumers may see a revision that does not exist.

When the transaction callback throws, all six steps above must roll back. Adapter contract tests should inject failures at each boundary (resource, operation, audit, outbox, and idempotency result) and verify that a retry produces only one copy of the business state and events; concurrency contract tests should verify that only one transaction executes for the same unique key, while the other requests replay the first response or receive `idempotency_in_progress`.

When the module starts, it must compute the mount `profiles` from the routes, profile-specific ports, publisher unit of work, auth, and outbox capabilities that are actually registered. When dependencies are incomplete, it should refuse to start the affected feature or lower the Manifest claim; it cannot keep claiming a complete profile.

<a id="colp-section-11"></a>

## 11. Approval Provider

```ts
export interface ApprovalProvider {
  createPlan(input: ChangePlanInput, principal: Principal): Promise<ChangePlan>
  getPlan(planId: string, principal: Principal): Promise<ChangePlan | null>
  approve(planId: string, userSession: UserSession): Promise<void>
  consumeApproval(planId: string, context: CommitContext): Promise<ApprovedPlan>
}
```

High-risk MCP tools and the web admin use the same approval plan.

<a id="colp-section-12"></a>

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

The MCP server lists tools dynamically on every request according to the principal's scopes; requests carry `_meta.io.modelcontextprotocol/protocolVersion: 2026-07-28` and the client capabilities. When scopes change, the server sends `notifications/tools/list_changed` over a `subscriptions/listen` connection; it keeps no MCP session state and uses no legacy session header.

<a id="colp-section-13"></a>

## 13. Public Blog Integration

HTML pages can add:

```html
<link rel="collection-protocol" href="/.well-known/collection-protocol">
<link rel="alternate" type="application/feed+json" href="/collections/-/feed.json">
```

A Collection detail page may be rendered by the blog's templates, while the JSON canonical endpoint stays stable.

<a id="colp-section-14"></a>

## 14. Reverse Proxies

When deployed behind Nginx, Caddy, or Cloudflare:

- Configure the list of trusted proxies and do not allow `X-Forwarded-For` to be forged.
- Turn off unnecessary buffering for Streamable HTTP SSE.
- Keep and forward `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`, `X-Accel-Buffering`, `ETag`, and `If-Match`; do not keep legacy session or SSE resumption headers (MCP 2026-07-28 uses neither sessions nor SSE resumption).
- Do not cache responses that carry `Authorization` unless there is an explicit private caching policy.
- Sync, admin, MCP, and any response that changes with authorization use `Cache-Control: no-store`; SSE should also limit the number of connections, queued bytes, idle timeout, and maximum lifetime.
- A CDN can be enabled for `.well-known`, the Manifest, and public Feeds.

<a id="colp-section-15"></a>

## 15. Static Reader Export

A NestJS publisher can generate a static bundle:

```ts
await protocol.exportStatic({
  output: './public',
  collections: 'public',
  formats: ['colp', 'json-feed'],
  sign: true,
})
```

A static bundle suits GitHub Pages, object storage, or a CDN, and contains no admin, Sync, or writable MCP.

<a id="colp-section-16"></a>

## 16. Conformance

`@collection-protocol/node/conformance` and the deployment's own tests should cover:

- Discovery and links.
- Schema and unknown extension preservation.
- ETag, If-Match, 412 / 428.
- Cursor pagination.
- Feed redaction.
- 429 and Retry-After.
- API key scopes.
- OAuth audience.
- Sync idempotency, tombstones, moves, and conflicts.
- MCP tool schemas, structured content, and scope filtering.
- Plan / approval / commit for high-risk operations.
- Key secrets never entering MCP results.

<a id="colp-section-17"></a>

## 17. Profile Delivery Order

This section speaks of "profile delivery milestones" and does not use `Phase 1` for package scaffolding or a browser product roadmap. The foundation milestone of the Node package is the schema, types, semantic, client, server, and conformance tooling, and does not mean that any profile conforms. Profiles are implemented in the same order as in [`docs/10-implementation-contract.md`](10-implementation-contract.md):

1. `core + publication`: Manifest, directory, Collection, Snapshot, and the safe Publication projection.
2. `publisher`: conditional writes, idempotency, the publisher unit of work, operations, audit, and the transactional outbox.
3. `feed`: first `release` mode and JSON Feed, then live feeds and WebSub.
4. `sync`: the session, Snapshot, push / pull / ack, replica, tombstone, and conflict state machines.
5. `mcp-read` / `mcp-write`: resources and tools, OAuth 2.1, high-risk approval plans, and scope filtering.

Browser adapters, an admin UI, HTTP signatures, a public conformance registry, and a server directory are separate product tracks. They can progress in parallel as their dependencies mature, but cannot change the profile dependencies above, and the completion of a product track cannot replace profile conformance evidence.

---

[← 06 Browser mapping](06-browser-mapping.md) · [All documents](../README.md#documents) · [Glossary](../GLOSSARY.md) · [08 Write API →](08-write-api.md)
