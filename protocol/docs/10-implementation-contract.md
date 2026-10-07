# 10. Implementation Contract and Node Package Guide

> **In short:** The bridge from prose to code: the order in which to read the specification, the order in which to deliver profiles, tables that name the request and response schema (`$defs`) of every endpoint, the step-by-step algorithm for assembling a paginated Snapshot, the rules for publication projections, the shape of the Node package, and the minimum a usable implementation must do.
>
> **Read this if** you are writing an implementation, an SDK, or a validator. **Profiles:** all.

<a id="colp-section-1"></a>

## 1. Implementation Basis

Implementers read the specification in this order:

1. [`docs/00-practical-profile.md`](00-practical-profile.md): profile dependencies and the scope of a first implementation.
2. [`schemas/collection-protocol.schema.json`](../schemas/collection-protocol.schema.json): the machine contract for every core wire DTO.
3. The topic documents: HTTP behavior, the sync algorithm, and security or MCP adapter rules.
4. [`examples/*.json`](../examples) and [`scripts/validate_examples.py`](../scripts/validate_examples.py): positive examples, semantic checks, and negative examples.

If the prose and the schema disagree, the draft must fix the disagreement as a specification bug; implementers cannot pick one side. Profile conformance requires the structural schema, the semantic rules, and the HTTP behavior to pass together.

The `anyOf` at the schema root covers only resource and response representations that can be identified on their own. Requests, queries, and merge patches must compile validators from the `$defs` names given in the table below; the root schema must not replace endpoint-level validation, or an incomplete resource could be mistaken for another DTO.

<a id="colp-section-2"></a>

## 2. Recommended 0.1 Delivery Order

The first service and Node package SHOULD deliver in this order:

1. `core + publication`
2. `publisher`
3. `feed`, implementing `release` mode first
4. `sync`
5. `mcp-read` / `mcp-write`

Sync, MCP, OAuth, and the administration API do not block the first phase, but a package can export their types and schemas early. A runtime must not declare a profile that has not passed its tests.

Profile dependencies combine the data model and the wire / endpoint contracts; they do not automatically enable every deployment role in the dependent sections. A deployment conformance plan should separate a profile's inherent HTTP / transport contract from its conditional roles. Ordinary authoritative writes and the optional managed bookmark write boundary are different roles. Publisher and Sync can meet managed Nodes through their generic Node mutation surface, so their deployment conformance scope includes both, and Sync also requires unknown extension storage. AI content writes, a local profile ID store, and a server-side profile ID HMAC are required only when a deployment actually enables the corresponding role. An authoritative write deployment that declares neither Publisher nor Sync, and does not accept or store `managed-bookmarks`, must not fake that role to pass the managed bookmark tests. A read-only `core + publication` deployment must not be forced to implement these roles.

<a id="colp-section-3"></a>

## 3. HTTP Contract Index

| Capability | Endpoint key | Request `$defs` | Response `$defs` |
|---|---|---|---|
| Manifest | Fixed well-known location | — | `manifest` |
| Directory | `directory` | `directoryQuery` | `collectionDirectory` |
| Collection Metadata | `collection` | — | `collectionMetadata` |
| Snapshot | `snapshot` | `snapshotQuery` | `snapshot` |
| Node Detail | `node` | `nodeDetailQuery` | `nodeDetail` |
| Create Collection | `directory` POST | `collectionCreateRequest` | `collectionCreateResult` |
| Patch Collection | `collection` PATCH | `collectionMergePatch` | `collection` |
| Create Node | `nodes` | `nodeCreateRequest` | `node` |
| Patch Node | `node` PATCH | `nodeMergePatch` | `node` |
| Move Node | `nodeMove` | `nodeMoveRequest` | `nodeMoveResult` |
| Delete Node / Subtree | `node` DELETE | `nodeDeleteQuery` | `deleteResult` |
| Delete Other Resource | The corresponding item endpoint | — | `deleteResult` |
| Create Annotation | `annotations` | `annotationCreate` | `annotation` |
| Patch Annotation | `annotation` PATCH | `annotationMergePatch` | `annotation` |
| Create Attachment | `attachments` | `attachmentCreate` | `attachment` |
| Patch Attachment | `attachment` PATCH | `attachmentMergePatch` | `attachment` |
| Create Relation | `relations` | `relationCreate` | `relation` |
| Patch Relation | `relation` PATCH | `relationMergePatch` | `relation` |
| Publish Release | `release` | `releaseCreate` | `releaseResult` |
| Release History | `releases` | `cursorPageQuery` | `releaseDirectory` |
| Release Metadata | `releaseItem` | — | `releaseResult` |
| Instance Feed | `instanceFeed` | `feedQuery` | `feed` |
| Collection Feed | `collectionFeed` | `feedQuery` | `feed` |
| Collection Access | `collectionAccess` | `accessPolicyPatch` for PATCH | `accessPolicy` |
| Admin Key Directory / Create | `adminKeys` | `cursorPageQuery` / `apiKeyCreateRequest` | `apiKeyDirectory` / `apiKeyCreateResult` |
| Admin Key Rotate / Revoke | `adminKeyRotate` / `adminKey` | `apiKeyRotateRequest` / — | `apiKeyRotateResult` / `apiKeyRevokeResult` |
| Admin Rate Limit | `adminRateLimits` | `cursorPageQuery` / `rateLimitPolicyUpdateRequest` | `rateLimitDirectory` / `rateLimitPolicy` |
| Admin Audit | `adminAudit` | `auditQuery` | `auditDirectory` |
| Error | Any | — | `problem` |

Writes must implement the HTTP header contract together with the body DTO: `If-Match`, `Idempotency-Key`, `Location`, `ETag`, and status codes are not optional SDK details.

<a id="colp-section-4"></a>

## 4. Sync Contract Index

| Phase | Request `$defs` | Response `$defs` |
|---|---|---|
| Session | `syncSessionRequest` | `syncSessionResult` |
| Snapshot | `syncSnapshotQuery` | `snapshot`, `mode=sync` |
| Push | `syncPush` | `syncPushResult` |
| Pull | `syncPullQuery` | `syncPull` |
| Ack | `syncAckRequest` | `syncAckResult` |
| Conflict Resolve | `conflictResolutionRequest` | `conflictResolutionResult` |
| Conversion Preview | Adapter-specific input | `conversionPreview` |

A browser replica must provide `replica.binding`, stating an explicit `whole-profile` or `mounted-folder` boundary. Two-way Sync must not be enabled without a binding, a generation, or a persistent sidecar.

<a id="colp-section-5"></a>

## 5. Security and MCP Contract Index

- Access: `accessPolicy`, `accessPolicyPatch`
- API keys: `apiKeyMetadata`, `apiKeyCreateRequest`, `apiKeyCreateResult`, `apiKeyRotateRequest`, `apiKeyRotateResult`, `apiKeyDirectory`
- Rate limits: `rateLimitPolicy`, `rateLimitPolicyPatch`, `rateLimitDirectory`
- Audit: `auditEvent`, `auditDirectory`
- High-risk plans: `changePlanRequest`, `changePlan`, `changeCommitRequest`, `changeCommitResult`
- MCP tool discovery: `mcpToolsList`
- MCP request context: every request carries `_meta.io.modelcontextprotocol/protocolVersion`, `clientCapabilities`, and clientInfo; the result `_meta` carries serverInfo.
- MCP discovery: `server/discover` returns `supportedVersions` and `capabilities`, and the result declares `resultType`.
- MCP results and caching: results declare `resultType: complete | input_required`; cacheable list / read results carry `ttlMs` and `cacheScope: public | private`.
- MCP subscriptions: `subscriptions/listen` is a long-lived stream, and `notifications/subscriptions/acknowledged` carries the subscription ID.

MCP tool input / output schemas SHOULD reference the `$defs` above directly and must not copy them into a second set of DTOs with different meanings.

<a id="colp-section-6"></a>

## 6. Snapshot Assembly Algorithm

A client processes a complete paginated Snapshot as follows:

1. Request the first page and record `snapshotId`, `revision`, `mode`, and the query parameters.
2. Persist each page to a staging area after the schema and the current page's semantic checks pass.
3. Follow only the `rel=next` URL returned by the server.
4. Verify that the pinned fields of later pages are identical, that `page.sequence` is contiguous, and that object IDs are not repeated.
5. After receiving `page.hasMore=false`, run one complete semantic check on the combined graph.
6. Replace the local state atomically only when every page has `complete=true`.

Any failure discards the staged assembly; an object that did not appear is not interpreted as deleted.

<a id="colp-section-7"></a>

## 7. Publication Projection

`mode=publication` means a representation that has gone through publication redaction; it does not mean anonymously visible:

- Public / unlisted Collections can be read anonymously.
- Protected / private Collections can return the publication projection after authorization.
- SourceRefs, tombstones, internal principals, and extensions that are not on the allowlist are always removed.
- A bookmark with `redacted=true` is a safe placeholder: it keeps the title, tree position, revision, and optional `accessUrl`, and must remove the target URL.
- An unredacted bookmark keeps only an HTTP(S) `url` whose authority has no userinfo; authorization cannot let a target with userinfo, or a non-HTTP(S) target, enter the publication projection.

This lets a public page safely show that a restricted entry exists without leaking the actual resource address.

<a id="colp-section-8"></a>

## 8. Node Package Shape

The reference implementation ships as one package, `@collection-protocol/node`. Splitting it into several published packages too early would add version negotiation and circular dependency costs, so splitting is evaluated only after the API is stable. Each subpath is exported only once it is implemented and tested; empty placeholder subpaths are not published.

```text
@collection-protocol/node
├── schema            JSON Schema and validators compiled by $defs name
├── types             TypeScript types generated from the schema
├── semantic          Snapshot, Manifest, URI Template, and graph checks
├── client            Manifest-driven publication / publisher fetch client
├── server            Framework-agnostic DTOs, problems, and header helpers
├── publisher         Publisher write services and HTTP boundary
├── adapters          Browser binding, conversion, and profile ID helpers
├── feed              Feed events, cursors, and publication filtering
├── sync              Sync host: session, push, pull, ack, snapshot
├── sync/canonical    Canonical JSON and operation canonicalization
├── sync/browser      Browser bookmark mapping and replica sidecar helpers
├── sync/unsafe       Composition-free coordinators for tests and adapters only
├── delivery          Staged profile delivery plan (section 2)
├── security          Auth, scopes, origin, rate-limit, and audit helpers
├── mcp               MCP read / write tools over the core services
├── mcp/2026-07-28    MCP 2026-07-28 wire contract
├── testing           Fixtures and in-memory adapters for tests
└── conformance       Profile claims, evidence, and repository example runner
```

`Node`, `NodeCreate`, `Operation`, and `FeedEvent` must be strict discriminated unions; when a generic generator loses schema conditions, the generation chain must inject a tested strict TypeScript override. Production Sync hosts use `createSyncHost` from `sync`; `sync/unsafe` skips session, scope, and batch binding checks and must not be used in production. NestJS integration has no exported subpath; see [07](07-nestjs-integration.md) for an illustrative module.

<a id="colp-section-9"></a>

## 9. Minimum Acceptance Criteria

A usable Node implementation must at least:

- Validate dates, URIs, and URI Templates with Draft 2020-12 format assertions.
- Validate and expand endpoints with the same RFC 6570 parser, and check the exact variable set of each endpoint key.
- Use a strict I-JSON parser that rejects duplicate members, dangerous keys, and unsafe protocol integers while constructing objects, and enforces deterministic nesting depth and member / array item budgets.
- Provide an API that returns a validator by `$defs` name.
- Provide a machine-readable endpoint contract registry and a unified query codec; arrays use repeated parameters, and unknown parameters and repeated scalars fail.
- Build URLs from the Manifest instead of concatenating object paths.
- Run structural validation, paginated assembly, and complete graph semantic checks on Snapshots.
- Handle ETag / If-None-Match automatically, and require writers to provide If-Match.
- Generate or accept an idempotency key automatically, without changing the key of the same logical operation after a failure.
- Compute the canonical request digest from RFC 8785 and the normalized endpoint / query / media type.
- Decode `application/problem+json` to its stable `code` without parsing the error text.
- Remove publication extensions that are not on the allowlist by default.
- Run [`scripts/validate_examples.py`](../scripts/validate_examples.py) and pass every positive and negative example.

---

[← 09 Problem registry](09-problem-registry.md) · [All documents](../README.md#documents) · [Glossary](../GLOSSARY.md)
