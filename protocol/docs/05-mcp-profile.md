# 05. Native MCP Profile

<a id="colp-section-1"></a>

## 1. Design Goals

The Collection Protocol MCP Profile lets AI assistants:

- Read Collections, Nodes, Feeds, sync status, and publication policy.
- Search, create, modify, move, and delete bookmarked content.
- Manage publication, access keys, ACLs, rate limits, and sync replicas.
- Show the impact of high-risk operations and obtain user confirmation before running them.

MCP is only an adapter over the core HTTP API. Permissions, revisions, audit, rate limits, and conflict rules cannot be redefined separately for MCP.

Baseline: MCP Specification `2026-07-28` (stateless, POST-only).

Official specification links:

- [MCP 2026-07-28 Changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2026-07-28 Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP 2026-07-28 Server Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [MCP 2026-07-28 Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)
- [MCP 2026-07-28 MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)

<a id="colp-section-2"></a>

## 2. Transport

Remote endpoint (POST-only):

```text
POST /collections/-/mcp
```

It uses MCP Streamable HTTP (`2026-07-28`):

- JSON-RPC 2.0 over UTF-8.
- The endpoint accepts only POST. GET and DELETE are not part of the MCP contract; they are rejected as negative cases, never open an SSE stream, and never run cleanup logic.
- The `Accept` header of every POST must include both `application/json` and `text/event-stream`.
- Requests must carry `MCP-Protocol-Version: 2026-07-28`, and it must match the request's `_meta.io.modelcontextprotocol/protocolVersion`. An unsupported version value returns `UnsupportedProtocolVersionError (-32022)`; a missing `_meta` envelope or a missing required field inside it returns `-32602` Invalid Params; a missing header, or a header that conflicts with the body, returns `HeaderMismatchError (-32020)` (aligned with the upstream `_meta` contract; revised 2026-08-27).
- The server must validate the origin.
- The protocol has no session: a request that carries a session identifier header is rejected outright, never ignored and then executed. The legacy session semantics are listed in the rejection examples of Section 27.
- On every request the client carries `_meta.io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`, and is recommended to carry clientInfo; the result `_meta` carries serverInfo.

Local integrations MAY use stdio. Over stdio, credentials come from the environment or a local secret store, not from a remote OAuth flow.

Protocol errors use stable numbers: a header mismatch returns `HeaderMismatchError (-32020)`, a missing required client capability returns `-32021`, and an unsupported version returns `-32022`; application-defined errors use only `-32000..-32019`. No request depends on previously negotiated state. The state of a long-lived listen connection exists only for the lifetime of that POST request; after a disconnect the client listens again and re-reads resources, and there is no redelivery based on event IDs. The legacy resumption semantics are listed in the rejection examples of Section 27.

<a id="colp-section-3"></a>

## 3. MCP Authorization

Remote writes must use the OAuth 2.1 profile:

- Protected resource metadata.
- Authorization server discovery.
- PKCE S256.
- `resource=https://alice.example/collections/-/mcp`.
- Audience validation.
- No token passthrough.
- Scope upgrades use 403 `insufficient_scope`.

For OAuth client issuer binding, see Section 6.1 of `docs/04-auth-security-rate-limit.md`: the authorization response `iss`, the DCR `application_type`, and per-issuer isolated credentials are a required contract for MCP OAuth clients.

Anonymous MCP MAY expose only public resources and no tools.

<a id="colp-section-4"></a>

## 4. Capabilities

A mount that declares `mcp-read` or `mcp-write` in the Manifest must also declare the `mcp` endpoint and set `features.mcp.resources` to `true`. `mcp-read` may set `features.mcp.tools` to `false`; a resource-only server is still a valid `mcp-read` implementation. If `mcp-read` sets it to `true`, every exposed tool must be read-only.

A mount that declares `mcp-write` must set `features.mcp.tools` to `true` and also declare the `mcp-read` and `publisher` profiles it depends on.

`features.mcp.protocolVersion` in the Manifest is always `2026-07-28`; the only MCP baseline of `mcp-read` and `mcp-write` is `2026-07-28`, and arbitrary versions or arrays of supported versions are not accepted.

Read-only server:

```json
{
  "capabilities": {
    "resources": {
      "listChanged": true
    }
  }
}
```

Writable server:

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

When a change in scopes or user authorization changes the set of visible tools, the server sends `notifications/tools/list_changed` over a `subscriptions/listen` connection.

<a id="colp-section-5"></a>

## 5. Resource URIs

<a id="colp-section-5-1"></a>

### 5.1 Public Resources

If the MCP client can access the public URL directly, use HTTPS:

```text
https://alice.example/collections/c/collection-1
https://alice.example/collections/c/collection-1/snapshot
```

<a id="colp-section-5-2"></a>

### 5.2 Logical and Protected Resources

```text
colp://{serverUuid}/collections/{collectionId}
colp://{serverUuid}/collections/{collectionId}/snapshot
colp://{serverUuid}/collections/{collectionId}/nodes/{nodeId}
colp://{serverUuid}/collections/{collectionId}/feed
colp://{serverUuid}/collections/{collectionId}/access
colp://{serverUuid}/sync/status
colp://{serverUuid}/audit/{auditId}
```

`colp` is a custom URI scheme. The authority is the stable `serverUuid` from the Manifest, never a display name that can change.

<a id="colp-section-6"></a>

## 6. Resource Templates

A server SHOULD expose the following templates for the resources it serves; it advertises only templates for resource kinds it actually implements. The authority is this server's actual `serverUuid`, written directly into the template; it is not a template variable for the client to fill in:

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

<a id="colp-section-7"></a>

## 7. Resources

<a id="colp-section-7-1"></a>

### 7.1 Collection Directory

- URI: `colp://{serverUuid}/collections`
- Returns only the Collections visible to the current principal.
- Anonymous lists and searches must exclude `unlisted` Collections; reading a known exact URI and being able to discover it are two different permissions.
- Resource annotation: `audience=["user","assistant"]`.

<a id="colp-section-7-2"></a>

### 7.2 Collection Snapshot

- URI: `colp://{serverUuid}/collections/{id}/snapshot`. Collection metadata uses the URI without `/snapshot`; the two must not be shared.
- A large Collection may return only a summary and a resource link to a Snapshot page.
- `annotations.lastModified` corresponds to the Collection's `updatedAt`.

<a id="colp-section-7-3"></a>

### 7.3 Node

- URI: `colp://{serverUuid}/collections/{id}/nodes/{nodeId}`.
- Private annotations appear only when the scopes allow them.

<a id="colp-section-7-4"></a>

### 7.4 Access Summary

- URI: `colp://{serverUuid}/collections/{id}/access`.
- Returns a human-readable summary and a machine structure, never secrets.

<a id="colp-section-7-5"></a>

### 7.5 Sync Status

- The current replica, last cursor, pending operations, open conflicts, and conversion warnings.

<a id="colp-section-7-6"></a>

### 7.6 Audit

- Only with `audit:read`.
- Paginated in reverse chronological order by default.
- Sensitive fields are redacted.

<a id="colp-section-8"></a>

## 8. Resource Change Subscriptions (subscriptions/listen)

The server provides change notifications through a single long-lived POST `subscriptions/listen` connection:

```text
subscriptions/listen
notifications/subscriptions/acknowledged
notifications/resources/updated
notifications/resources/list_changed
```

Filter fields:

- `toolsListChanged`.
- `promptsListChanged`.
- `resourcesListChanged`.
- `resourceSubscriptions` (an array of resource URIs).

The first message must be `notifications/subscriptions/acknowledged`, whose `_meta.io.modelcontextprotocol/subscriptionId` equals the JSON-RPC id of the opening request; every later notification carries that subscription ID. Request-scoped notifications such as `notifications/progress` and `notifications/message` stay on the stream of their own request. The connection offers no resumption; the server must not send notifications of a type the client did not subscribe to.

Good candidates for subscription:

- Collection metadata.
- The Feed cursor.
- Sync status.
- Approval plan status.

A notification only means that a resource has changed. The client must read the resource again and must not treat the notification as complete state.

<a id="colp-section-9"></a>

## 9. Tool Naming

Tool names use lowercase dot-separated names:

```text
collections.list
collections.get
nodes.create
access.plan_change
```

Names are limited to ASCII letters, digits, underscores, hyphens, and dots, and are at most 128 characters long.

Every tool must provide a JSON Schema `inputSchema`; write tools SHOULD provide `outputSchema` and `structuredContent`.

<a id="colp-section-10"></a>

## 10. Read-only Tools

| Tool | Scope | Description |
|---|---|---|
| `collections.list` | collections:list | List Collections, paginated |
| `collections.get` | collections:read | Get metadata |
| `collections.search` | collections:read | Search titles, tags, and creators |
| `collections.get_snapshot` | nodes:read | Core Node fields only by default; including sidecars also requires the corresponding read scopes |
| `nodes.get` | nodes:read | Get a single Node |
| `nodes.search` | nodes:read | Search URLs, titles, and tags; searching annotations also requires annotations:read |
| `feed.get_changes` | feed:read | Pull a public or authorized Feed |
| `sync.get_status` | sync:pull | View cursors, queues, and conflicts |
| `access.get` | access:read | View publication state and the effective policy |
| `keys.list` | keys:read | Key metadata only |
| `rate_limits.get` | rate_limits:read | View rate-limit policies |
| `audit.list` | audit:read | View audit records |

<a id="colp-section-11"></a>

## 11. Ordinary Write Tools

| Tool | Scope | Risk |
|---|---|---|
| `collections.create` | collections:create | low |
| `collections.update` | collections:write | low |
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
| `sync.preview` | sync:pull | low |
| `sync.push` | sync:push | medium |
| `sync.resolve_conflict` | sync:resolve | medium |

The listed risk is the tool's own risk; the risk of a call is the highest risk of the operations it expands to (Section 12). For example, a `collections.update` that makes a Collection `public` or `unlisted` is high risk.

Modify, move, reorder, delete, and conflict resolution tools must require the target's `baseRevision`; a move across parents must also carry the source and target children revisions. `dryRun` may be added, but cannot replace the concurrency precondition. Create tools use an idempotency key and do not require the revision of an object that does not exist yet.

<a id="colp-section-12"></a>

## 12. High-Risk Tools

The following operations must not be designed as a single step:

- `collections.delete`
- `nodes.delete_subtree`, when above a safety threshold
- `access.visibility` changing to public or unlisted
- `access.set_policy`
- `keys.create`
- `keys.rotate`
- `keys.revoke`
- `rate_limits.set`
- `release.publish`
- `sync.mirror`
- Large-scale overwrite, deletion, or publication of annotations or attachments

Risk is aggregated over the actual operations after expansion, not judged by the outer tool name. When a generic `sync.push`, a batch tool, or a custom tool contains any high-risk operation, the whole call must go through plan / commit; a generic batch must not be used to bypass confirmation.

Plan / commit uses these tools:

```text
changes.plan
changes.commit
changes.cancel
```

<a id="colp-section-13"></a>

## 13. Change Plan

<a id="colp-section-13-1"></a>

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

Result:

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

`operations[]` must validate against the discriminated union `$defs.changePlanOperation`; an open `payload` must not be used to guess a command. A plan must be bound to the end-user subject, the OAuth client, the request context, the canonical operations digest, and the base revisions. Knowing a `planId` must not let another principal, client, or request context commit that plan.

<a id="colp-section-13-2"></a>

### 13.2 Approval

Approval of a high-risk plan must come from a user-visible interface or a trusted host, not from a boolean the model generates itself.

Recommended flow:

1. The MCP tool returns `approvalUri`.
2. The host shows the user the summary, the diff, the impact, and the permissions.
3. The user approves on the server's page.
4. The server marks the plan as approved and binds the approval to the same subject, OAuth client, and request context.
5. The AI calls `changes.commit(planId)`; the server commits based on the request's authenticated identity and the approved state, and does not require the model to hold a secret. If a cross-host callback must use a one-time token, only the host may attach that token at the transport layer; it never enters the tool input or the model's text.

If a host supports a trusted confirmation callback, it can replace the approval URI, but must be audited.

Approval tokens must be short-lived, single-use, stored hashed, and bound to the same plan, subject, and client. The approval page must re-authenticate and enforce CSRF protection; the summary, diff, and impact are regenerated by the server from the stored canonical plan, and model-provided descriptions are not trusted.

<a id="colp-section-13-3"></a>

### 13.3 Commit

A commit must revalidate that:

- The plan has not expired.
- A user approval exists.
- The base revisions have not changed.
- The scopes are still valid.
- The rate limit allows it.
- The impact of the operations does not exceed the plan.
- The approval has not been consumed yet, and the canonical operation digest of the commit matches the plan exactly.

If any condition fails, the commit is not executed and a new plan is required.

A commit must compare-and-consume the approval in a single transaction and use an idempotency key. Of concurrent commits only one may execute; a retry returns the original result of the first commit and never executes twice.

<a id="colp-section-14"></a>

## 14. Secret Handling in API Key Tools

<a id="colp-section-14-1"></a>

### 14.1 Never Return Secrets to the Model

The MCP structured content of `keys.create` and `keys.rotate` must not contain the plaintext secret.

Return instead:

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

- The reveal URI requires the current user to authenticate again.
- The secret is shown only once.
- The reveal page uses `Cache-Control: no-store`.
- The page should not send the secret back to the MCP client or the model context.

<a id="colp-section-15"></a>

## 15. Tool Schema Example

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

<a id="colp-section-16"></a>

## 16. Tool Errors

Business errors are returned as a tool result:

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

Unknown tools, invalid JSON-RPC, or input that does not satisfy the tool schema use protocol errors.

<a id="colp-section-17"></a>

## 17. Resource Links

Tool results SHOULD return resource links instead of stuffing an entire large Snapshot into the model context:

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

<a id="colp-section-18"></a>

## 18. AI Delegation Grant

A user can create a short-lived AI grant:

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

When a grant expires or reaches its maximum writes, authorization must be obtained again.

A wire grant should use a server-side opaque handle or a signed token rather than trusting client-editable JSON. A signed form binds at least `iss`, `aud`, `sub`, `client_id`, `jti`, `iat`, `nbf`, `exp`, and an optional `cnf`, and must support revocation. `maxWrites` is decremented atomically in the same transaction as the business write and cannot be bypassed with concurrent tool calls.

<a id="colp-section-19"></a>

## 19. MCP Rate Limits

- `resources/read` and `tools/call` use different buckets.
- Read-only resources may have a higher quota.
- Search, full Snapshots, bulk Node writes, and sync tools are charged in cost units.
- A tool result may return the remaining cost budget.
- High-risk operations cannot bypass impact thresholds through parallel small calls.

<a id="colp-section-20"></a>

## 20. Prompt Injection and Untrusted Content

Bookmark titles, web page summaries, annotations, and external feeds are all untrusted input.

The MCP server MUST:

- Treat external content as data, and never splice instructions from it into tool descriptions.
- Sanitize tool output.
- Mark the provenance of externally fetched content.
- Never run a permission tool because bookmark content claims "publish this collection".
- Run key, ACL, rate-limit, delete, and similar tools only on the basis of the user's request, scopes, and an approval plan.

The MCP client SHOULD:

- Show the tool input and the target Collection.
- Show a diff for high-risk operations.
- Record tool calls.
- Validate tool results against their schema.
- Set timeouts and a maximum result size.

<a id="colp-section-21"></a>

## 21. Recommended Tool Set

Minimal read-only MCP:

```text
collections.list
collections.get
nodes.search
nodes.get
feed.get_changes
access.get
```

Full management MCP:

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

The server lists only the tools that the current token's scopes actually allow it to call, so that the model is not led to believe in capabilities it does not have.

<a id="colp-section-22"></a>

## 22. Standard and Custom Request Headers

The request headers of MCP `2026-07-28` fall into two groups, standard and custom.

Standard headers:

- `Mcp-Method`: required on every request, with the request method as its value; when it is missing, duplicated, or inconsistent with the body, the server returns `HeaderMismatchError (-32020)`.
- `Mcp-Name`: `tools/call` uses `params.name`, `resources/read` uses `params.uri`, and `prompts/get` uses `params.name`; where it applies, a missing or duplicated header is likewise rejected with `-32020`.
- `MCP-Protocol-Version`: must be `2026-07-28`.

Custom headers:

- A tool's `inputSchema` may use `x-mcp-header` to declare that a field maps to `Mcp-Param-{Name}`.
- Value encoding must use the case-sensitive Base64 sentinel `=?base64?...?=`.
- Only primitive integer, string, and boolean values are supported, not numbers, objects, or arrays.
- `x-mcp-header` may only be reachable statically through a chain of `properties`; it cannot appear inside `items`, composition keywords, conditionals, or `$ref`.
- Header names must follow the RFC 9110 token rule and be unique case-insensitively.
- An `Mcp-Name` or `Mcp-Param-*` header with an invalid encoding, a wrong sentinel, no schema declaration, or a value inconsistent with the body is always rejected.

<a id="colp-section-23"></a>

## 23. Server Discovery

The server must implement `server/discover`:

- The request contains only `_meta`.
- The result must contain `resultType: "complete"`, `supportedVersions`, and `capabilities`, and is recommended to contain serverInfo (see the official specification for semantics).
- The result may carry `instructions`, `ttlMs`, and `cacheScope`.
- Discovery is optional for clients; stdio compatibility probing also uses the same discovery method.
- `serverInfo` is self-reported by the server and is not a security boundary.

Discovery and the `mcp-read` / `mcp-write` capability lists describe only `2026-07-28` and the server's real current capabilities.

<a id="colp-section-24"></a>

## 24. Results and Caching

Every method result must declare `resultType`: `complete` or `input_required`. A legacy result without a declaration is treated as `complete` for compatibility, but new implementations must declare it explicitly.

Cacheable results must carry cache metadata:

- `ttlMs`: a non-negative integer lifetime in milliseconds.
- `cacheScope`: `public` or `private`.

The list and read results that cache metadata applies to are `tools/list`, `prompts/list`, `resources/list`, `resources/read`, `resources/templates/list`, and `server/discover`. The result `_meta` is recommended to carry `io.modelcontextprotocol/serverInfo`; a per-request `io.modelcontextprotocol/logLevel` can opt in to `notifications/message`.

<a id="colp-section-25"></a>

## 25. MRTR: Additional Input and Confirmation

A tool that needs additional input or user confirmation returns `resultType: "input_required"`:

- It may carry `inputRequests`: a map from server-assigned string keys to ElicitRequest, CreateMessageRequest, or ListRootsRequest.
- It may carry an opaque `requestState`; when the client retries it must echo `requestState` unchanged and must not inspect its content.
- The client retry uses a new JSON-RPC id.
- At least one of `inputRequests` and `requestState` is provided; `inputRequests` the client did not declare must not be sent.
- The server must protect the integrity of any `requestState` that affects authorization or business logic (principal, TTL, and a digest of the originating request) and reject a tampered `requestState`; binding the principal, TTL, request method, and key parameters is recommended.
- High-risk plans and approvals use `input_required` to wait for user confirmation, without requiring the model to hold a secret.

<a id="colp-section-26"></a>

## 26. Tool Schema Budgets (JSON Schema 2020-12)

Tool `inputSchema` and `outputSchema` use JSON Schema 2020-12:

- 2020-12 keywords are allowed; `$ref` resolution and resource use by composition keywords must stay within hard budgets (reference resolution, composition depth, node count, and byte size).
- `structuredContent` may be any JSON value.
- `tools/list` must return tools in a deterministic order (see the official specification for semantics).

<a id="colp-section-27"></a>

## 27. Migration Notes and Rejection Examples

This document describes only the stateless MCP `2026-07-28` baseline. The legacy semantics below are listed only as examples of what is rejected; they are not part of this version's contract. COLP provides no `2025-11-25` compatibility layer, no version fallback switch, and no session store.

Legacy startup lifecycle and sessions:

```text
initialize
notifications/initialized
Mcp-Session-Id
```

Legacy transport verbs and resumption:

```text
GET  /collections/-/mcp
DELETE /collections/-/mcp
Last-Event-ID
```

Legacy subscription, logging, and helper methods:

```text
resources/subscribe
resources/unsubscribe
notifications/roots/list_changed
logging/setLevel
ping
```

When the server meets any of the methods, headers, or verbs above, it returns the corresponding rejection error (unsupported method or version) directly; it never ignores them and continues, and never tries to resume a legacy event stream.
