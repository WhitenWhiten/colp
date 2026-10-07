# 03. Synchronization Protocol

> **In short:** Two-way sync between trusted replicas such as browser extensions, desktop apps, and servers. A replica opens a session for one Collection and bootstraps from a Snapshot, then repeats one loop: push its numbered operations, pull everyone else's operations after its cursor, and ack what it applied. The server stays authoritative: it applies or rebases each operation or records an explicit conflict, and keeps a tombstone for every delete until its retention period has passed and every active replica has acknowledged it. The chapter ends with a [recommended sync loop](#colp-section-20).
>
> **Read this if** you build a sync client or a sync server. Browser specifics are in [06 Browser mapping](06-browser-mapping.md). **Profiles:** `sync`.

<a id="colp-section-1"></a>

## 1. Goals

The synchronization sub-protocol replicates data in both directions between browser extensions, desktop clients, web applications, personal servers, and other trusted replicas.

Where this chapter writes `{}` to keep a flow readable, it means "embed the corresponding complete object"; it is not an empty object that can be sent. Executable wire examples are in [`examples/sync-*.json`](../examples), and endpoint requests and responses must be validated against the named `$defs` listed in [`docs/10-implementation-contract.md`](10-implementation-contract.md).

It must handle:

- First synchronization.
- Offline edits and reconnection.
- Concurrency across multiple devices.
- Conversion between browser fields and protocol fields.
- Moves, reorders, and recursive deletes.
- Idempotent retries.
- Exposing and resolving conflicts.
- Tombstones and the resurrection of deleted objects by old replicas.

<a id="colp-section-1-1"></a>

### 1.1 Consistency Model

The first version uses a server-authoritative operation log, field-level merging, and explicit conflicts. It does not use a full CRDT as the wire model.

Reasons:

- Browser APIs are ordered trees and event streams and expose no CRDT identifiers.
- ACLs, publication, keys, deletes, and managed nodes need a clear server-side authorization order.
- Conflicts on titles, URLs, private notes, and similar fields usually need a user choice rather than automatic convergence that hides the ambiguity.
- Server-generated positions solve the vast majority of concurrent insert and move problems.

Implementations MAY use CRDTs internally, but their wire behavior must follow the operation, revision, conflict, and tombstone semantics in this document.

<a id="colp-section-2"></a>

## 2. Replica

Each independent sync replica has a stable `replicaId`:

```json
{
  "replicaId": "019b3dd0-7636-770a-a789-bf62d3eb91cc",
  "name": "Chrome on Alice's laptop",
  "kind": "browser_extension",
  "adapter": {
    "profile": "chromium-bookmarks-v1",
    "version": "1.0.0"
  },
  "capabilities": {
    "read": true,
    "write": true,
    "events": true,
    "separator": false,
    "alias": false,
    "annotations": "sidecar",
    "maxBatchOperations": 200
  },
  "binding": {
    "browserProfileId": "profile-hmac-1",
    "mountMode": "mounted-folder",
    "mountNativeId": "431",
    "generation": "generation-7"
  }
}
```

- A replica ID is generated at first install and kept across restarts.
- After a reinstall, the old replica ID must not be reused unless the complete local sync database was restored.
- Replica secrets or tokens must not be included in the replica object.

<a id="colp-section-3"></a>

## 3. Local State

A client persists at least:

- The replica ID.
- The last pull cursor of each Collection.
- The mapping between each protocol Node ID and its native ID.
- The local operation queue.
- Operations that were submitted but not yet acknowledged.
- Tombstones and conflicts.
- Adapter conversion warnings.
- Recently processed remote operation IDs, for loop detection.

Keeping cursors only in browser memory does not meet the Sync client requirements.

<a id="colp-section-4"></a>

## 4. Session Negotiation

`POST /collections/-/sync/sessions`

```json
{
  "protocolVersion": "0.1",
  "replica": {},
  "scope": "collection",
  "collection": {
    "collectionId": "collection-1",
    "lastCursor": "sync_01JZ...",
    "lastRevision": "r_1020",
    "bootstrapMode": "merge"
  },
  "clientTime": "2026-07-16T07:00:00Z"
}
```

An empty instance has no Collection to bind to. When a client needs to create the first Collection through Sync, it uses an instance-scoped session:

```json
{
  "protocolVersion": "0.1",
  "replica": {},
  "scope": "instance",
  "purpose": "create_collection",
  "clientTime": "2026-07-16T07:00:00Z"
}
```

`bootstrapMode`:

- `download`: the server overwrites the local managed range.
- `upload`: the local tree is the initial source; existing server data needs explicit handling.
- `merge`: both sides are kept; ID mapping, duplicate detection, and conflict generation are performed.
- `mirror`: the server is authoritative and extra local content may be deleted. This requires additional confirmation.

Response:

```json
{
  "sessionId": "syncsess_01JZ...",
  "expiresAt": "2026-07-16T08:00:00Z",
  "serverTime": "2026-07-16T07:00:01Z",
  "clockSkewMilliseconds": 1000,
  "acceptedProtocolVersion": "0.1",
  "scope": "collection",
  "maxBatchOperations": 200,
  "tombstoneRetentionSeconds": 2592000,
  "replicaLease": {
    "leaseId": "lease_01JZ...",
    "generation": "leasegen_7",
    "state": "active",
    "lastSeenAt": "2026-07-16T07:00:01Z",
    "expiresAt": "2026-08-15T07:00:01Z",
    "acknowledgedCursor": "sync_01JZ..."
  },
  "collection": {
    "collectionId": "collection-1",
    "snapshotRequired": false,
    "serverCursor": "sync_01K0...",
    "serverRevision": "r_1042"
  },
  "conversionPolicy": {
    "alias": "duplicate",
    "separator": "preserve_remote",
    "unknownExtensions": "preserve_remote"
  }
}
```

The normal mode in 0.1 is one session per Collection. That gives cursors, revisions, the authorization domain, atomic batches, and tombstone acks one clear scope each. Multi-Collection sessions may be used only when the Manifest declares `features.sync.multiCollectionSessions=true`, and must then provide a Collection revision vector; clients cannot assume they exist.

An instance-scoped session is the only exception, and must satisfy all of the following restrictions:

- `purpose` can only be `create_collection`, and the principal must have `sync:bootstrap`, `sync:push`, and `collections:create`.
- While the session is not yet bound to a Collection, it accepts only one batch with `atomic=true` that contains only one `create_collection`. That operation's `sequence` must be 1, `collectionId` and `targetId` must be omitted, and `baseRevision` must be `null`.
- After `applied`, the server creates the Collection and its root, writes the operation, sequence receipt, and cursor in the same transaction, and returns the generated `collectionId`, revision, and cursor in the result's `boundCollection`. The session then becomes Collection-scoped, and the next expected sequence for that Collection is 1; the instance lane's sequence is never mixed with the new Collection lane.
- `deferred` leaves the instance session unbound, and the client must retry with the same operation. `rejected` consumes the instance sequence and terminates the session; a corrected request must create a new instance session.
- The server must not allow an instance session to read, update, delete, release, or create a second time, and must not let the client reserve a Collection ID in advance.

A session ID is not an authentication credential. The server must bind it to the principal, the token or key ID, the OAuth client, the origin, the session scope, and the protocol version; a Collection-scoped session, or one whose creation has completed, must also be bound to the generated Collection. When access is revoked or the scope is downgraded, the session and its subscriptions are terminated immediately.

<a id="colp-section-5"></a>

## 5. Bootstrap

<a id="colp-section-5-1"></a>

### 5.1 Empty Server, Existing Browser Tree

1. The adapter reads the complete browser tree.
2. It generates protocol IDs and source references.
3. It creates a session with `scope=instance` and `purpose=create_collection`, and atomically creates the Collection and the root role mapping.
4. It uploads with a Snapshot import or a batch of create operations.
5. The server returns primary IDs, revisions, and cursors.
6. The client persists the mapping and the cursor.

<a id="colp-section-5-2"></a>

### 5.2 Existing Server, Empty Browser Tree

1. Download the Sync Snapshot.
2. Run a conversion preview.
3. The user confirms lossy items and the behavior of managed roots.
4. Write into the browser in parent-folder order.
5. Build the source reference mapping.
6. Acknowledge the Snapshot cursor.

<a id="colp-section-5-3"></a>

### 5.3 Data on Both Sides

Merge matching order:

1. An existing source reference native mapping.
2. An embedded protocol ID or a sidecar mapping.
3. A strict match on the same parent, same URL, and same title.
4. A candidate match on canonical URL plus a configurable time window.
5. When unsure, create an independent Node and return a duplicate candidate; never merge automatically.

Fuzzy matching must not delete either object directly.

<a id="colp-section-6"></a>

## 6. Operation Envelope

```json
{
  "opId": "019b3de2-7f76-7b8b-8ffc-941d6e6318dd",
  "replicaId": "019b3dd0-7636-770a-a789-bf62d3eb91cc",
  "sequence": 1842,
  "collectionId": "collection-1",
  "type": "move_node",
  "targetId": "node-9",
  "baseRevision": "r_1041",
  "occurredAt": "2026-07-16T07:05:00Z",
  "dependencies": ["019b3de1-..."],
  "payload": {
    "newParentId": "folder-4",
    "afterId": "node-7",
    "beforeId": null,
    "baseSourceParentRevision": "children_r_8",
    "baseTargetParentRevision": "children_r_9"
  },
  "source": {
    "adapterProfile": "chromium-bookmarks-v1",
    "nativeEvent": "onMoved"
  }
}
```

<a id="colp-section-6-1"></a>

### 6.1 Idempotency

- `(replicaId, sequenceScope, sequence)` MUST be unique. The `sequenceScope` of an ordinary session is `collectionId`; an instance session that is not yet bound uses `sessionId` as a temporary sequence scope.
- `sequence` starts at 1 and increases by one within a single replica and sequence scope; it must not be reused or skip numbers. Sequences of different Collections are independent, so one offline queue does not block other Collections.
- `opId` is unique for the lifetime of `serverUuid`; clients SHOULD use UUIDv7 to reduce the risk of collisions when migrating between servers.
- The server must persist the canonical request digest and the complete `operationResult`. When the same request is retried with the same `(replicaId, sequenceScope, sequence)` or `opId`, the server must return the persisted original result field for field; it must not execute it again, and must not substitute a less informative `duplicate` status.
- HTTP retries also use `Idempotency-Key`, whose value may equal the batch ID.
- When the same `(replicaId, sequenceScope, sequence)` or `opId` carries a different canonical request digest, the server MUST return `409 sequence_reuse` or `op_id_reused` and audit it.
- When an operation arrives with a sequence greater than the expected sequence, the server returns `409 sequence_gap` with `expectedSequence`; the client must fill the gap or bootstrap again, and the server must not guess by arrival order.
- A batch ID or idempotency key must be bound to the principal, the endpoint, and the request digest; the same key with a different body returns `409 idempotency_key_reused`.

Sequence receipt state machine:

| Result | Terminal | Consumes the sequence | Cursor |
|---|---:|---:|---|
| `applied` / `rebased` | yes | yes | Must be produced; the target resource changed authoritatively |
| `noop` | yes | yes | Must not be produced; there was no authoritative state change |
| `conflicted` | yes | yes | Must be produced; the target resource is unchanged, but the conflict is persisted and enters the pull order |
| `rejected` | yes | yes | Must not be produced; a corrected operation must use the next sequence |
| `deferred` | no | no | Must not be produced; the current expected sequence is kept |

`deferred` is the only non-terminal state. The server must store its digest, reason, and current result. While the reason persists, an identical retry returns the same result; once the reason is resolved, the same operation may move atomically from `deferred` to one terminal state. While a deferred receipt exists, every larger sequence of that replica in the same sequence scope returns `409 sequence_blocked` with the current `expectedSequence` and must not be executed ahead of it.

Only `rejected` and `deferred` results carry the required machine-readable `code`; only `deferred` MAY carry `retryAfterSeconds`. `applied` and `rebased` must not carry `conflictId`; `conflicted` must carry the persisted `conflictId` and a cursor. When the same sequence is retried, these fields must also stay identical field for field.

<a id="colp-section-6-2"></a>

### 6.2 Operation Types

Collection:

- `create_collection`
- `update_collection_metadata`
- `delete_collection`
- `restore_collection`
- `publish_release`

Node:

- `create_node`
- `update_node_content`
- `move_node`
- `reorder_children`
- `delete_node`
- `delete_subtree`
- `restore_node`

Sidecar data:

- `create_annotation`
- `update_annotation`
- `delete_annotation`
- `create_attachment`
- `update_attachment`
- `delete_attachment`
- `create_relation`
- `update_relation`
- `delete_relation`

Management of ACLs, keys, and rate limits does not enter the ordinary bookmark sync log; it uses a separate management audit stream.

<a id="colp-section-6-3"></a>

### 6.3 Payloads and Concurrency Boundaries

- `create_*` operations use dedicated create DTOs with `baseRevision=null`.
- An operation that modifies an existing object MUST provide `targetId` and `baseRevision`.
- An update operation uses a resource-specific payload containing the `base` the client observed and the desired `value`. After schema validation, the server MUST confirm that `base` and `value` contain exactly the same set of own fields and perform the cross-object key-set semantic check, returning `422 invalid_document` when they differ; the JSON Schema limits which field names are available.
- The server MUST perform a deterministic three-way merge of Base / Current / Incoming, so a JSON Pointer cannot be used to modify server-managed fields or prototype properties, or to bypass the move and reorder concurrency boundaries.

```json
{
  "base": {
    "title": "Old title",
    "tags": ["a", "b"]
  },
  "value": {
    "title": "New title",
    "tags": ["b", "c"]
  }
}
```
- `update_collection_metadata` uses `collectionMetadataUpdateOperationPayload` and `collectionMergePatch` and requires `collections:write`; changing visibility to `public` or `unlisted` additionally requires `access:write` and the same high-risk approval as over HTTP.
- `update_node_content` uses `nodeContentUpdateOperationPayload` and `nodeMergePatch` and requires `nodes:write`. `kind`, `parentId`, `position`, `sourceRefs`, IDs, revisions, and time fields cannot be expressed in its schema; parent and position can only be changed by `move_node` or `reorder_children`.
- `update_annotation`, `update_attachment`, and `update_relation` use their own typed payloads and require `annotations:write`, `attachments:write`, and `relations:write` respectively.
- The ordinary sync log does not accept `set_access_policy`, key, or rate-limit operations; those keep using the management API, the separate audit stream, and the corresponding management scopes.
- `move_node` uses `newParentId`, `afterId`, `beforeId`, `baseSourceParentRevision`, and `baseTargetParentRevision`. For a reorder within the same parent the two revisions are equal; for a move across parents they protect the source children set and the target children set separately.
- The observed-remove semantics for tags are derived from the set difference between `base.tags` and `value.tags`; only members already observed in the base can be removed. Members added by other operations to the current state that are not in the base must be kept. When the observation cannot be proven, a conflict is generated; tags cannot be overwritten like an ordinary array.
- An unknown operation type must be rejected or handled by version negotiation; it must never be executed by guessing from an open `payload`.
- An operation type that is valid in the schema but not yet implemented by the host must return the non-retryable `422 unsupported_operation` problem, and must not create a sequence receipt, advance the lane, or cause any mutation.

<a id="colp-section-7"></a>

## 7. Push

`POST /collections/-/sync/push`

```json
{
  "sessionId": "syncsess_01JZ...",
  "batchId": "batch_01JZ...",
  "atomic": false,
  "operations": [
    {
      "opId": "op_update_1842",
      "replicaId": "replica_laptop",
      "sequence": 1842,
      "collectionId": "collection-1",
      "type": "update_node_content",
      "targetId": "node-9",
      "baseRevision": "r_1041",
      "occurredAt": "2026-07-16T07:05:00Z",
      "dependencies": [],
      "payload": {
        "base": { "title": "Old title" },
        "value": { "title": "New title" }
      }
    }
  ]
}
```

Response:

```json
{
  "batchId": "batch_01JZ...",
  "results": [
    {
      "opId": "op_update_1842",
      "sequence": 1842,
      "status": "applied",
      "targetId": "node-9",
      "revision": "r_1043",
      "cursor": "sync_01K0...",
      "warnings": []
    }
  ],
  "serverCursor": "sync_01K0..."
}
```

Status:

- `applied`
- `rebased`
- `noop`
- `conflicted`
- `rejected`
- `deferred`

With `atomic=true`, the server must first complete preflight checks of scope, sequence, dependencies, schema, authorization, and preconditions; if any of them fails, the whole request returns a problem and every sequence stays unconsumed. Once inside the transaction, business state, canonical operations, sequence receipts, conflicts, cursors, audit, and outbox must all commit or all roll back. If any operation cannot reach a committable terminal state, the whole transaction rolls back, and the server must not return per-item results that look consumed. A server that does not support the required atomic boundary must reject the request rather than commit partially.

With `atomic=false`, the server processes the array in order, and each operation commits in its own complete transaction boundary as described above. A dependency inside a batch must point to an operation that has already reached a terminal state or to an earlier operation in the array; when a dependency has not reached a terminal state, the current operation returns `deferred` / `dependency_pending` and must not execute ahead of it. When a dependency was `rejected`, the current operation may end as `rejected` / `dependency_failed` and consume its own sequence. When the transaction fails, the operation's resource state, receipt, cursor, and audit are all rolled back, and the client can safely retry the same sequence.

<a id="colp-section-8"></a>

## 8. Pull

`GET /collections/-/sync/pull?sessionId=syncsess_...&cursor=sync_...&limit=200`

```json
{
  "events": [
    {
      "cursor": "sync_01K1...",
      "kind": "operation",
      "operation": {}
    }
  ],
  "nextCursor": "sync_01K1...",
  "hasMore": false,
  "collectionRevision": "r_1050",
  "recommendedPullAfterSeconds": 30
}
```

Rules:

- A pull may return accepted operations that originated from the current replica; the client recognizes echoes by operation ID.
- The server must not filter the current replica only by time, because other replicas may have generated transforms based on its operations.
- An expired cursor returns `410 sync_cursor_expired` with a Snapshot URL.
- The pull response order is the server commit order.
- Operations and conflicts share one `events` sequence, so that the true interleaved commit order can be expressed. Clients must apply events in order, unless events are explicitly independent and the client implementation can prove that doing otherwise is safe.
- A cursor must be bound to the session, principal, Collection, and protocol version; use across contexts returns `400 invalid_cursor_scope`.
- A pull must first fully verify the request cursor's signature, validity period, session, principal, Collection, protocol version, policy, page size, and authority handoff evidence. After verification, if `events` is empty, `hasMore` must be `false` and `nextCursor` must be byte-for-byte identical to the request `cursor`; the server must not re-sign it, extend its validity, or change the token by way of a key rotation. A first pull without a `cursor` is not subject to this identity rule: the server must issue a `nextCursor` bound to the current session and the initial exclusive tuple. For a non-empty page, `nextCursor` must equal the `cursor` of the last event and advance the exclusive tuple; a page that carries events but keeps the original tuple or cursor must be rejected. A durable handoff across sessions must still verify the old authority lineage first; empty pages keep echoing the input token until a non-empty page explicitly enters the new session's authority through an event cursor, or until session negotiation completes the switch before the pull through an explicit `serverCursor` rebase.

<a id="colp-section-8-1"></a>

### 8.1 COLP 0.2 Authoritative Pull Effects

In COLP 0.1, `syncPullEvent` stays exactly as it is: an operation event contains only `cursor`, `kind`, and the original `operation`, and must reject `effect`. A server that supports this section declares both `0.1` and `0.2` in the Manifest's `protocolVersions`; the client requests one version explicitly in the session request, and the server may only echo that version in `acceptedProtocolVersion` or reject it with a version negotiation problem. The session, the pull cursor, and the pull representation must be bound to the accepted version; 0.2 events must not be sent in a 0.1 session.

In COLP 0.2, an operation event MUST carry both the original operation and an immutable `effect`. The effect must be bound to the operation's `opId`, `replicaId`, `sequence`, `collectionId`, and canonical operation digest; the event `cursor` is still bound to the receiving replica's session and must not reuse the source replica's push result cursor. The `deleteCursor` of the Sync tombstone inside a delete effect is the stable mutation or source cursor persisted by the server; it belongs to the immutable effect and its `effectDigest`, and must not be rewritten into the receiver-bound event `cursor`. The same effect may be read by several replicas under different session cursors; a receiver's progress is expressed only by the event `cursor`. `operationDigest` and `effectDigest` use the RFC 9530 `sha-256=:base64:` format. The operation digest input is the canonical I-JSON of the complete operation; the effect digest input is the canonical I-JSON of the complete effect with the `effectDigest` member removed. Object members are sorted by UTF-16 code units in ascending order, arrays keep their wire order, and SHA-256 is computed over the UTF-8 encoding.

Only `applied` and `rebased` mutations may enter the operation stream. `noop`, `rejected`, and `deferred` must not produce mutation events; `conflicted` produces only a separate conflict event. A successful conflict resolution must create a new applied operation with a matching effect; it cannot rewrite the original conflicted operation as a mutation.

The effect is a closed union keyed by operation type:

| Operation | Effect kind | Required authority |
|---|---|---|
| `create_node` | `node_created` | The complete final Node (including the server ID and revision), placement, the parent children revision, and the new folder's own children revision (`null` for non-folders) |
| `update_node_content` | `node_content_updated` | The complete final Node and revision after merge or rebase |
| `move_node` | `node_moved` | The complete final Node, parent, anchors, position, and the source and target children revisions |
| `delete_node` | `node_deleted` | Deletion authority, the Sync tombstone, the delete revision, and the source parent children revision |
| `delete_subtree` | `subtree_deleted` | The root tombstone, exact member authority, member digest and count, and the source parent children revision |
| `restore_node` | `node_restored` | The complete final Node (original ID, new revision), placement (the original parent or a `recovered` folder), the target parent children revision, and the consumed tombstone `deleteCursor` |

<a id="restore-node-effect"></a>

`restore_node` already exists as a Sync Operation name. COLP 0.2 Pull now includes the matching `node_restored` effect so receivers apply restore from closed-union authority instead of guessing a `create_node`. After `node_restored`, Live Node and Tombstone for that ID are mutually exclusive. A purged Tombstone is `resource_purged` and is not restoreable. If the original Parent is gone, placement is the originating mount's `recovered` Folder (unique per parent). If that mount is gone, placement is the Collection-root `recovered` fallback. Receivers MUST NOT guess `bookmarks-bar`.

The canonical UTF-8 representation of an inline pull effect is at most 262144 bytes, with a maximum JSON depth of 32 and at most 10000 members. The exact member list of a subtree may inline at most 512 IDs; larger sets must use an immutable `effectRef`, which carries `pageCount`, `memberCount`, `memberDigest`, and `firstPageDigest`. The `syncEffectPages` HTTPS URI template in the Manifest is the only effect page endpoint; clients must expand it per RFC 6570 with the current `effectId` and a `pageNumber` starting at 1, and `effectRef` never copies or overrides the endpoint URL. The expanded result must not contain userinfo, query credentials, a fragment, or an authority outside the Manifest. Reads must use the normal authorization of the current session; the URL itself must not be a bearer capability or carry any credential.

Each effect page is at most 262144 bytes, 512 members, and JSON depth 32; a whole reference is at most 1024 pages and 524288 members. Page numbers start at 1 and increase by one, and `pageCount` and the effect ID never change. The first page has `previousPageDigest=null`, its `pageDigest` must equal the reference's `firstPageDigest`, and every later page must reference the previous page's `pageDigest` exactly. Each page digest is computed over the complete canonical page with `pageDigest` removed; the members of all pages, concatenated in page order, must match the event's `memberCount` and `memberDigest`. Responses must be immutable, session-authenticated, and `Cache-Control: private, no-store`. Any missing, out-of-order, or duplicated page, any digest or count mismatch, or any budget overrun must fail closed: no partial mutation may be applied and the cursor must not advance.

An effect may contain the Node content needed for normal synchronization within the selected Collection; it must not expose database primary keys, principals, credentials, browser native IDs or profile IDs, internal audit IDs, or any other server implementation identity. Historical operations must not be backfilled by guessing. A 0.2 deployment must announce the effect cutover of each Collection; a cursor from before the cutover returns `sync_cursor_expired` or `recovery_required` and requires a complete Snapshot, after which the server issues a new cursor bound to the 0.2 session.

A COLP 0.2 Sync Snapshot uses `syncSnapshotV02` and provides `parentRevisions` for every root or folder that appears on the page. When the client has finished every Snapshot page, it must have the children revision of every node in the complete tree that can be a parent; `resourceRevision` and `childrenRevision` are independent authorities and cannot stand in for each other.

<a id="colp-section-9"></a>

## 9. Ack

A client may acknowledge remote operations only after they have been written to the browser or local database and persisted:

```json
{
  "sessionId": "syncsess_01JZ...",
  "cursor": "sync_01K1...",
  "warnings": []
}
```

Acks are used to:

- Monitor replicas that fall behind.
- Decide whether a tombstone can be purged.
- Discover conversions that keep failing to apply.

The server must not delete a tombstone that other active replicas may still need just because one replica acknowledged it.

A replica must hold a server-side lease and be in one of the following states:

| State | Meaning | Allowed sync behavior |
|---|---|---|
| `active` | The lease has not expired and the session identity and replica binding are valid | May pull, push, and ack; a successful authenticated sync request may renew the lease |
| `expired` | `expiresAt` has passed and it is not yet known whether recovery is safe | The existing session is terminated; it must not push and can only renegotiate a session |
| `recovery_required` | The ack cursor is older than the retention window, or a tombstone after it has been purged | Can only download the authoritative Sync Snapshot and complete a bootstrap ack |
| `retired` | Explicitly retired by the user or an administrator | Terminal; the replica ID may never again establish a session or push |

The legal transitions are:

```text
new -> active
active -> expired                  (lease deadline)
active|expired -> recovery_required (cursor/tombstone window lost)
expired -> active                  (resume window still complete)
recovery_required -> active        (authoritative snapshot durably applied and acked)
active|expired|recovery_required -> retired
```

- Invalid, unauthorized, or failed requests must not renew the lease. The session `expiresAt` and the replica lease `expiresAt` are two independent deadlines; creating a new session must not automatically bypass the lease recovery check.
- When an `expired` replica renegotiates, the server must compare its persisted ack cursor, the earliest cursor that can currently be pulled, and `purgedThroughCursor`. When the window is complete it can recover to `active`; otherwise it moves to `recovery_required` and the server returns `410 stale_replica` with a Snapshot URL.
- The old queue of a `recovery_required` replica must not be pushed directly. The client must first download the authoritative Snapshot bound to a revision and cursor, rebuild its local mapping, handle or export unsynchronized local changes, and then persist the Snapshot ack. The server may restore `active` only after that ack and a new lease generation commit atomically.
- `retired` cannot be undone. Continuing to sync requires registering a new replica ID; the old replica's operations, receipts, and audit remain queryable according to the retention policy.
- Only `active` replicas take part in blocking tombstone purges. `expired` and `recovery_required` replicas do not block purges, but must pass the window check above before returning to `active`; `retired` also does not block purges and never recovers.

A Sync tombstone may be purged only when all of the following hold:

1. The minimum retention period has passed: the tombstone's `purgeAfter` time is in the past. A server sets `purgeAfter` no earlier than `deletedAt` plus the retention it advertises as `tombstoneRetentionSeconds`.
2. Every `active` replica has acknowledged a cursor no earlier than the delete event, and before that ack had resolved the old operations in its local queue that target the deleted range.
3. The server has atomically advanced `purgedThroughCursor`, so that replicas whose acks are older must enter `recovery_required`.
4. The server has compacted the membership of each deleted ID into a non-resurrectable deletion or generation watermark. The watermark is not a wire tombstone and must be kept at least until the end of the `serverUuid` lifetime, or until a namespace migration proves that the old IDs will never be accepted again.

The purge, `purgedThroughCursor`, the watermark, and the physical tombstone deletion must commit in one transaction. If any step fails, the purge boundary must not advance. A replica beyond the cursor or tombstone window returns `410 stale_replica`; a retired replica returns `410 replica_retired`.

<a id="colp-section-10"></a>

## 10. Conflict Model

<a id="colp-section-10-1"></a>

### 10.1 Principles

- Fields that can be merged safely are merged automatically.
- User-visible, irreversible ambiguity produces a conflict.
- Deletes and publication policy follow more conservative rules.
- The server's receive order is the final commit order, but it should not be presented as conflict-free user intent.

<a id="colp-section-10-2"></a>

### 10.2 Field Rules

| Field / operation | Default rule |
|---|---|
| Different fields changed concurrently | Field merge |
| `lastUsedAt` | Take the latest valid time |
| Tag add | Set union |
| Tag remove | Observed remove, based on revisions |
| Concurrent title change | Conflict; the server value is kept for now |
| Concurrent URL change | Conflict; no automatic choice |
| Concurrent private note change | Conflict; both versions are kept |
| Concurrent folder moves | The last server commit wins and a move conflict notice is generated |
| Concurrent inserts | Stable order by position + operation ID |
| Delete vs. update | Delete dominates; the update enters a conflict |
| Delete vs. move | Delete dominates |
| Parent deleted | Move to a recovered folder, or conflict |
| Move that would create a cycle | Reject |
| ACL / publication | No automatic merge; handled as separate management conflicts |

<a id="colp-section-10-3"></a>

### 10.3 Conflict

```json
{
  "id": "conflict_01JZ...",
  "collectionId": "collection-1",
  "targetId": "node-9",
  "type": "concurrent_field_update",
  "field": "/title",
  "base": "Old title",
  "server": "Server title",
  "incoming": "Laptop title",
  "incomingOpId": "op-1",
  "createdAt": "2026-07-16T07:05:01Z",
  "status": "open",
  "allowedResolutions": ["server", "incoming", "custom", "both"],
  "revision": "cr_2"
}
```

Conflict content is private sync data and does not enter the public Feed.

A conflict must carry its own `revision`. A resolution uses `If-Match` and `Idempotency-Key`; a custom value goes through the same schema, URL, authorization, and visibility checks as an ordinary write.

`both` applies only to conflicts that can safely be copied into two independent resources, such as a bookmark title or URL divergence. The server must generate a new ID for the copied object and write the resolution into the log as an authoritative operation; ACL, delete, publication, and key conflicts must not use `both`.

<a id="colp-section-11"></a>

## 11. Conflict Resolution

`POST /collections/-/sync/conflicts/{id}/resolve`

```json
{
  "resolution": "custom",
  "value": "Merged title",
  "baseConflictRevision": "cr_2"
}
```

Resolving a conflict produces a new authoritative operation that every replica can pull.

<a id="colp-section-12"></a>

## 12. Move and Reorder

<a id="colp-section-12-1"></a>

### 12.1 Move

The client submits a semantic position:

```json
{
  "newParentId": "folder-b",
  "afterId": "node-x",
  "beforeId": "node-y",
  "baseSourceParentRevision": "children_r_8",
  "baseTargetParentRevision": "children_r_9"
}
```

- `afterId` and `beforeId` may be omitted; omitting both means "place at the end".
- When both are provided they must be adjacent; otherwise the server returns `position_context_stale` with a summary of the current child order.
- The server assigns the position.

<a id="colp-section-12-2"></a>

### 12.2 Reorder Children

Used for a complete `onChildrenReordered` reported by a browser:

```json
{
  "parentId": "folder-a",
  "childIds": ["n3", "n1", "n2"],
  "baseChildrenRevision": "children_r_9"
}
```

If the list is missing a child or has an extra one, the server must not guess; it returns a conflict or asks the client to read the folder again.

<a id="colp-section-13"></a>

## 13. Deletion

<a id="colp-section-13-1"></a>

### 13.1 Delete Node

- Deleting a bookmark or an empty folder uses `delete_node`.
- Deleting a folder recursively uses `delete_subtree`.
- The Sync tombstone must record the root Node and a summary of the deleted range.
- The server does not have to generate a separate public Feed event for every Node in the subtree, but the Sync Snapshot must be able to stop old replicas from resurrecting any of the children.
- Internally, the server must keep the membership of every deleted ID or an equivalent generation watermark; the wire `syncTombstone` expresses the range with `scope=subtree`, `targetId`, the required `deleteCursor`, and `affectedCount`. A Publisher HTTP DELETE returns a `deletionReceipt` without `deleteCursor` and must not invent a cursor for a deployment without Sync.

**Subtree observation precondition.** A Sync deployment may require clients to prove which subtree they observed before a multi-member `delete_subtree`. Such a deployment requires the operation's `source.extensions["https://known.example/extensions/sync-subtree-observation-v1"]` (the namespace keeps its original identifier for wire compatibility). The value is `{version: 1, count, digest}`; `digest` encodes, with the canonical operation digest algorithm, `{rootId, members: [[id, resourceRevision], ...]}`, where members are sorted by ID in code point order, include the root, and contain no duplicate IDs. This is an operation precondition and is part of the immutable operation's digest and replay identity. The client freezes the value when it captures or previews the deletion; a retry must not re-read the current tree and regenerate it. The server compares the current members and versions inside the deletion transaction's lock; any change returns `revision_conflict`. In such a deployment, a request without this extension may only delete a root that currently has no children; a root with descendants returns `precondition_required`. This protection is independent of the root's resourceRevision and covers additions, updates, and moves at any depth. The reference package exports `subtreeDeleteSource()` to compute this value.

<a id="colp-section-13-2"></a>

### 13.2 Restore

Restore is a new operation:

- When the original parent is available, the Node returns near its original position.
- When the parent has been deleted, it is placed in the `recovered` folder of the owning mount; when the original mount has been deleted, it is placed in the `recovered` fallback under the Collection root. `bookmarks-bar` must not be guessed.
- If it conflicts with an existing ID, the original protocol ID is still used; an object that looks brand new must not be generated.

<a id="colp-section-14"></a>

## 14. Conversion Stages

Each direction consists of:

```text
native event / tree
  → adapter normalization
  → protocol validation
  → operation generation
  → server authorization
  → conflict / transform
  → authoritative operation
  → target adapter preview
  → native write + sidecar write
  → ack
```

<a id="colp-section-14-1"></a>

### 14.1 Conversion Preview

A preview must be supported before a first sync, a mirror, a large delete, or alias materialization:

```json
{
  "creates": 120,
  "updates": 18,
  "moves": 4,
  "deletes": 0,
  "sidecarOnly": 32,
  "lossy": 3,
  "warnings": []
}
```

<a id="colp-section-15"></a>

## 15. Offline Queue

- While offline, the client generates sequences normally.
- Operations are stored locally in dependency (topological) order.
- After reconnecting, the client pulls first, rebases the local queue, and then pushes.
- If pushing first would obviously cause conflicts, the client SHOULD do a light pull first.
- Later operations on a create that has not been uploaded yet may be compacted locally, for example by merging a create and an update.
- Operations that were already uploaded, or that other operations depend on, must not have their operation ID rewritten.

<a id="colp-section-16"></a>

## 16. Time and Clock Skew

- `occurredAt` is the user's device time, used only for display and diagnostics.
- Conflict ordering and authoritative commits must not depend on client time alone.
- The server records `receivedAt` and the commit order.
- Time fields such as `lastUsedAt` may accept client values, but should be checked for implausible future times.

<a id="colp-section-17"></a>

## 17. Snapshot Compaction

A server may compact the operation log, but must:

- Generate a new authoritative Snapshot.
- Keep the deletion information that is still inside the tombstone window.
- Make old cursors return `410` with a Snapshot URL.
- Not change the visible content of a Collection without the client being aware of it.

<a id="colp-section-18"></a>

## 18. Sync Rate Limits

- Sync pulls and feed polls use different buckets.
- Active sync clients may poll more often than anonymous feeds, but must still respect the interval returned by the server.
- The number of operations, the body size, and the concurrency of pushes are all limited.
- After a `429`, a client must not split its work into more, smaller requests to get around the limit.

<a id="colp-section-19"></a>

## 19. Security

- A sync token only allows the specified Collection by default.
- A browser extension must not receive key or ACL management scopes.
- The server must not return one user's source references to another user.
- Mirrors and large deletes require explicit confirmation or permission from deployment policy.
- Write-back to managed browser nodes must be rejected. Because Sync receives and applies remote Node operations, the generic mutation boundary of this profile recognizes the `managed-bookmarks` folder and its descendants and enforces the default read-only rule; an ordinary authoritative write deployment that takes on neither the Sync nor the managed-bookmark role does not need to accept or store that role.
- Adapters must prevent remote URLs from triggering internal browser pages, JavaScript URLs, or unsafe schemes.
- Every entry point (including MCP `sync.push`) must recursively check the highest risk of the operations. High-risk actions such as `delete_collection`, `delete_subtree`, mirror, public exposure, and key or ACL changes cannot bypass plan / commit or deployment confirmation policies through a generic batch.

<a id="colp-section-20"></a>

## 20. Recommended Sync Loop

```text
1. Read the local browser event queue
2. Deduplicate against known remote echoes
3. GET sync/pull(lastCursor)
4. Preview and apply remote operations
5. Persist the native mapping and the new cursor
6. POST sync/ack
7. Rebase the local unsent queue
8. POST sync/push
9. Store the result of each operation
10. If serverCursor advanced, pull again until hasMore=false
```

---

[← 02 HTTP, publication, and feed](02-http-publication-feed.md) · [All documents](../README.md#documents) · [Glossary](../GLOSSARY.md) · [04 Auth, security, and rate limits →](04-auth-security-rate-limit.md)
