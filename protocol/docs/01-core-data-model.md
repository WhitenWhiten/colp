# 01. Core Data Model

> **In short:** The objects every COLP document is made of. A Collection owns a tree of Nodes (`root`, `folder`, `bookmark`, `separator`, `alias`) ordered by `position`. Annotations, Attachments, and Relations sit next to the tree as sidecars, deletions become tombstones, and a Snapshot packages all of it at one revision. The chapter ends with the validation rules a receiver runs before it trusts a document.
>
> **Read this if** you produce or consume any COLP data. **Profiles:** `core`.

<a id="colp-section-1"></a>

## 1. Design Goals

The core model serves two kinds of needs at once:

- Traditional browser bookmarks: trees, folders, order, titles, URLs, times, special root folders, and managed nodes.
- Knowledge collections: public descriptions, tags, notes, summaries, attachments, relations, reading state, graded visibility, and source references.

Core fields stay small and stable; platform-specific information goes into namespaced extensions.

<a id="colp-section-2"></a>

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

<a id="colp-section-2-1"></a>

### 2.1 Required Fields

| Field | Type | Rule |
|---|---|---|
| `schemaVersion` | string | Currently `0.1` |
| `id` | string | Stable, never reused |
| `kind` | enum | bookmarks / reading_path / knowledge_collection / mixed |
| `title` | string | May be an empty string, but the field must be present |
| `rootNodeId` | string | Points to the Node with kind=root |
| `visibility` | enum | public / unlisted / protected / private |
| `createdAt` | date-time | RFC 3339 |
| `updatedAt` | date-time | RFC 3339 |
| `revision` | string | Opaque version |

<a id="colp-section-2-2"></a>

### 2.2 Publication Policy

`publication.feedMode`:

- `live`: changes to public Nodes may enter the Feed one by one.
- `release`: only explicit Releases enter the Feed.
- `disabled`: there is no public Feed, but the Snapshot can still be read according to the access policy.

`includeNodeContent`:

- `metadata`: publish only titles, URLs, sources, and tags.
- `summary`: also publish public summaries and TL;DRs.
- `full`: may publish public body text or attachments. The server must check attachment visibility and copyright policy again.

<a id="colp-section-3"></a>

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

<a id="colp-section-3-1"></a>

### 3.1 Common Fields

| Field | Applies to | Description |
|---|---|---|
| `id` | all | Primary protocol ID |
| `collectionId` | all | The owning Collection |
| `kind` | all | root / folder / bookmark / separator / alias |
| `parentId` | non-root | Parent Node ID |
| `position` | non-root | Server-generated sibling order key |
| `title` | root/folder/bookmark/alias | Display name |
| `url` | bookmark | The original absolute URI the user bookmarked, validated by `$defs.bookmarkUrl`; authoritative and Sync representations may keep negotiated local schemes |
| `urlHash` | bookmark, optional | `sha-256=:<base64>:`; SHA-256 over the UTF-8 octets of the original `url` string of the same object, used only to select duplicate candidates |
| `targetNodeId` | alias | The referenced Node |
| `createdAt` | all | Creation time |
| `updatedAt` | all | Last content update time |
| `childrenModifiedAt` | root/folder | Last time the set of children changed |
| `lastUsedAt` | bookmark/alias | Last time it was opened |
| `deletedAt` | tombstone | Logical deletion time |
| `revision` | all | Version for conditional writes |
| `visibility` | non-root, optional | inherit / protected / private; defaults to inherit and can only tighten ancestor permissions |
| `redacted` | Publication projection, optional | `true` marks a safe placeholder for a restricted object, not an authoritative Node |
| `accessUrl` | redacted Node, optional | A user-facing sign-in, authorization, or subscription page; must not contain secrets |

Annotations, Attachments, and Relations are not embedded in Nodes. A canonical Snapshot stores one authoritative copy of each, in the top-level arrays. A Node Detail API may expand related objects temporarily through `included`, but their IDs and revisions must match the top-level representation.

When a resource reference crosses servers, `colp:/resources/~{serverUuid}/{resourceType}/~{id}` expresses its complete global identity. For example, `colp:/resources/~Server.A/node/~..` denotes exactly `("Server.A", "node", "..")`, and it is not equal to `("server.a", "node", "..")`. The authority-free form avoids case normalization of a URI host, and the `~` prefix of the value segments keeps the legal wire IDs `.` and `..` from being parsed as path traversal. The bare parent, alias, subject, relation, and provenance IDs already inside a Snapshot are still resolved in the Snapshot's same-Collection context, and their reference scope does not grow. This global identity URI is not the MCP Profile's `colp://{serverUuid}/...` resource locator; the latter has an authority, locates an MCP representation or operation, and is not another serialization of the global identity URI.

`redacted=true` is allowed only in projections with `mode=publication`. A Bookmark may omit `url`, but must keep its stable `id`, `collectionId`, `parentId`, `position`, `title`, and `revision`, and must explicitly use a tightened `visibility` of `protected` or `private`. Sync Snapshots, write responses, and authoritative storage representations must not contain redacted Nodes.

A missing `urlHash` is legal; it never causes a Bookmark to be rejected or to receive a different identity. When present, its value is the matching digest of the unrewritten `url` of the same Bookmark, and it never replaces or changes `url`. Equal hashes only mark candidates whose URL, content, and Collection semantics should be compared further; they do not establish that Nodes are equal and do not enter any object ID or reference field.

<a id="colp-section-3-2"></a>

### 3.2 Order

- `position` is a sortable, opaque ASCII token matching `^[0-9A-Za-z_-]{1,128}$`.
- Clients MUST compare positions by unsigned ASCII octet order, but must not interpret their structure. The restricted character set avoids differences between JavaScript UTF-16 ordering and the Unicode ordering of other languages.
- When creating or moving a Node, clients SHOULD submit `afterId` / `beforeId` and let the server assign the position.
- A server may rebalance positions without changing the visible order. A rebalance must atomically advance the Collection state revision and enter the Sync log, but should not produce user-level Feed events.
- A Snapshot MAY provide a derived `index`, but Sync must not depend on it, because concurrent inserts make it drift.

`index` is an I-JSON-safe, zero-based integer for a non-root Node: its rank, by `position`, among the Nodes with the same `parentId` in the whole logical Snapshot projection. The root may omit `index` or use `null`, and must not invent a sibling rank. Pagination does not restart the numbering; cropped or sparse projections number only the siblings actually represented in the projection. A server that cannot determine the sibling set of the complete projection should omit it.

`index` is only a display hint, not an authoritative Node field. Sync must not require, compare, or persist it as authoritative state, and must not use it to decide order. Receivers must ignore stale or tampered values and always compare `position` by unsigned ASCII octet order.

<a id="colp-section-3-3"></a>

### 3.3 Root and Folder Roles

Special browser root folders are expressed with `folderRole`:

- `root`
- `bookmarks-bar`
- `other-bookmarks`
- `mobile-bookmarks`
- `managed-bookmarks`
- `archive`
- `inbox`
- `recovered`
- `custom`

Each Collection has at most one live folder for each of `bookmarks-bar`, `other-bookmarks`, and `mobile-bookmarks`. `recovered` is unique per owning parent (the mount, or the Collection-root fallback) and must not be reused Collection-wide.

`managed-bookmarks` MUST be read-only by default.

This rule applies to components that actually accept, store, or modify the `managed-bookmarks` folder role. Supporting ordinary authoritative Node writes does not by itself mean a deployment supports this optional role; a deployment that has not enabled it may reject it at the input boundary, and must not fake managed-bookmark data to prove a generic write transaction. Publisher and Sync both provide generic Node mutation surfaces that may read or apply this role, so their authoritative write boundaries include the default read-only constraint.

<a id="colp-section-4"></a>

## 4. Source Reference

A source reference supports round-trip conversion and prevents sync loops.

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

Rules:

The profile ID rules in this section apply to components that actually create, store, or derive source reference profile IDs. Persisting a local random profile ID belongs to the browser or adapter role; server-side HMAC derivation and key rotation belong to a server role that enables that derivation. A deployment that only consumes Publication projections without source references takes on none of these roles.

- `profileId` must not upload a raw operating system path or a raw local profile identifier.
- `profileId` SHOULD use a random identifier or a server-keyed HMAC; a low-entropy local identifier must not be used as a plain hash.
- A random identifier MUST be generated once with a CSPRNG and persisted with the local profile.
- HMAC derivation includes server and tenant domain separation and carries a key version identifier in the result.
- HMAC input MUST use an unambiguous, deterministic byte encoding; the server key MUST NOT be sent to clients or written to logs. Key rotation uses a controlled mapping from version to key.
- `nativeCreatedAt` / `nativeModifiedAt` are always integers in Unix epoch milliseconds; a missing value is `null`. Unitless numbers and date strings must not be sent.
- A source reference belongs to the private mapping `(principal, replicaId, nodeId)`. A wire response returns only the mapping of the currently authorized replica itself and must not aggregate the native IDs of other users or devices.
- The same Node may have multiple source references in authoritative storage, one per replica mapping, but they are not public fields of the shared Node.
- Source references are private sync data by default and do not enter public Snapshots or Feeds.
- After a browser node is deleted, its mapping is kept at least until the tombstone expires.

<a id="colp-section-5"></a>

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

The authority requirements in this section apply to write deployments that actually create or modify AI content. A deployment that only reads or publishes existing projections does not take on the AI write role and does not need to provide an AI annotation write transaction.

AI-generated content MUST carry provenance:

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

The protocol does not require exposing the specific model name. Whether a public projection keeps model information is decided by the Collection policy, but `kind=ai` should not be silently rewritten as human.

The following rules apply to authoritative writes; they do not stop a publication policy from omitting the optional `provider` or `model` from a projection:

- When a human, imported, or derived write is applied to an existing `kind=ai` Annotation, the receiver MUST keep `kind`, `provider`, `model`, `generatedAt`, and `sourceNodeIds` exactly as they are in the current authoritative resource; fields of the same names in the request cannot overwrite, delete, or fill in these values.
- The server MUST NOT treat a deserialized request body, an ordinary validation context built by the caller, or caller-provided provenance as a trusted AI generation context. Only a context created by the server's trusted AI execution boundary may replace the AI identity fields above.
- When a trusted human write changes the `format` or `value` of an Annotation, the server MUST set `editedByHuman` to `true`; later non-AI writes cannot clear a value that is already `true` or lower it to `false`.

<a id="colp-section-5-2"></a>

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

Reading state is usually per-user data. A multi-user server must bind it to the principal instead of writing it into the public Node record.

`subject.type` can only be `collection` or `node`. The subject must exist in the same `collectionId`. A creator in a public projection uses a public actor URI and must not leak the internal principal ID.

<a id="colp-section-6"></a>

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

Common `rel` values:

- `icon`
- `favicon`
- `thumbnail`
- `cover`
- `snapshot`
- `archive`
- `transcript`
- `alternate`
- `enclosure`

A server must not publish an attachment automatically just because its Node is public.

Inline binary data such as Netscape `ICON=data:` is not a portable attachment URL. An adapter should decode it, limit its size, compute a digest, and write it to controlled blob or object storage to produce an HTTP(S) URL. When it cannot be materialized, it stays in the source extension and the adapter returns `favicon_sidecar_only`; an arbitrary `data:` URI must not be placed in an authoritative Attachment.

<a id="colp-section-7"></a>

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

Core relation types:

- `related`
- `precedes`
- `follows`
- `supports`
- `contradicts`
- `duplicate_of`
- `derived_from`
- `mentions`
- `custom`

Relations do not change the tree structure. A reading path may use both position and `precedes`, but position is the authoritative source of the default display order.

When `kind=reading_path` and there is only one path, the positions under the root are the core path order. When a `mixed` or `knowledge_collection` Collection maintains a subset path or several paths, it should store membership and the independent order in a namespaced extension with a public schema; that order must not be written back into tree positions or copied into a second authoritative Node tree.

<a id="colp-section-8"></a>

## 8. Sync Tombstone

A deleted object is represented in the sync layer as `$defs.syncTombstone`. A Publisher HTTP delete response uses the separate `$defs.deletionReceipt`, which contains no sync cursor:

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

- The minimum tombstone retention period is advertised to Sync clients as `tombstoneRetentionSeconds` in the Sync session result, and each tombstone records its earliest purge time in `purgeAfter`. Sync servers are advised to retain tombstones for at least 30 days.
- Within the retention period, an update from an old replica must not silently resurrect the object.
- Restoring must use an explicit `restore_node` operation.
- `resourceType` supports collection / node / annotation / attachment / relation; with `scope=subtree`, `affectedCount` describes the size of the deletion.
- `(resourceType, targetId)` must be mutually exclusive between live arrays and tombstones.
- Before a purge, the server must keep the prior representation and the private mappings needed for a restore; after the purge, a restore returns `410 resource_purged`.

<a id="colp-section-9"></a>

## 9. Snapshot

A Snapshot must validate against `$defs.snapshot`, contain the complete Collection representation and normalized top-level arrays, and must not use an empty object to stand for omitted content. Executable Publication, Protected Publication, and Sync examples are [`examples/collection-snapshot.json`](../examples/collection-snapshot.json), [`examples/protected-publication-snapshot.json`](../examples/protected-publication-snapshot.json), and [`examples/sync-snapshot.json`](../examples/sync-snapshot.json).

A Snapshot with `mode=publication` contains no tombstones, source references, or internal ACLs, and `syncCursor` must not appear. It can be used both as an anonymous public representation and as the authorized safe projection of a protected or private Collection; the objects it contains are still decided by scopes and ACLs. `mode=sync` requires authorization and filters sidecars by scopes and ACLs.

`complete=true` means that the request did not exclude authoritative objects through `root`, `depth`, or `include`; it may span multiple HTTP pages. When the Snapshot is used for authoritative replacement, bootstrap, or disaster recovery, the client must first verify that every page shares the same `snapshotId` and `revision`, that `page.sequence` is contiguous, that no object ID is duplicated, and that the last page has `page.hasMore=false`. A cropped projection must have `complete=false` and must not trigger deletion of missing objects.

HTTP `Content-Digest` verifies the actual response bytes. The optional in-body `contentDigest` may appear only on a single-page logical Snapshot with `complete=true`, `page.sequence=1`, and `page.hasMore=false`, and uses the `sha-256=:<base64>:` syntax; the digest covers the entire Snapshot serialized as RFC 8785 canonical JSON, excluding the `contentDigest` field itself. Paginated or cropped Snapshots must not carry an in-body `contentDigest`. Each page of a paginated Snapshot has its own ETag and HTTP `Content-Digest`, which cannot reuse a value derived only from the Collection revision; the HTTP fields and the in-body logical digest cover different things.

<a id="colp-section-10"></a>

## 10. Unknown Fields and Round-Trip Guarantees

The Sync round-trip rules in this section apply to deployments that act as a Sync server or provide equivalent Sync extension storage; the `core` data semantics dependency alone does not make a read-only Publication deployment a Sync server.

- Unknown top-level fields of core objects in the same exact protocol version MUST be rejected by strict validators.
- Data that needs forward extension and round-trip preservation MUST be placed in `extensions`.
- A Sync server MUST store and forward extensions it does not understand unchanged.
- An adapter that removes or degrades an extension MUST produce a `lossy_conversion` warning.

<a id="colp-section-11"></a>

## 11. Data Validation

- Every object MUST pass JSON Schema structural validation and then semantic validation before it is written.
- The structural schema of bookmark URLs forbids the executable `javascript`, `vbscript`, and `data` schemes; the mount's `features.bookmarkUrls.acceptedSchemes` further limits the schemes that can actually be written. `http` and `https` are allowed by default, and local implementations may add `file`, `about`, `chrome`, `edge`, `moz-extension`, and so on, but Publication and Feed must not return non-HTTP(S) URLs.
- Any authoritative Node write that creates or changes a parent edge MUST resolve the affected Node and the target parent in the same transaction or locked snapshot as the persistence, and verify that both belong to the same Collection and that the target parent's `kind` is `root` or `folder`.
- Ordinary Node create, move, re-parent, or restore operations MUST NOT create a new `root`, change the parent of the existing root, or set the `parentId` of a non-root Node to `null`; the single root can only be created atomically together with its Collection.
- The server MUST prevent parent cycles.
- `root` must not have a parent.
- `bookmark` must have a URL.
- `folder`, `root`, and `separator` must not have a URL.
- `alias` must have a `targetNodeId`, and its target must not form an alias cycle.
- The visibility of Annotations and Attachments must not be wider than that of their parent object.
- A Snapshot must contain exactly one root, and `collection.rootNodeId` must point to it.
- Every Node, Annotation, Attachment, and Relation must belong to the same Collection.
- Live IDs and tombstone IDs must not overlap; positions under the same parent must be non-empty and unique.
- Parent, alias, subject, relation, and provenance references must exist in the same Snapshot or in resolvable resources of the same Collection.
- `delete_subtree` MUST derive the complete member set from the authoritative parent/child relationships in the same transaction or locked snapshot as the deletion, apply authorization, read-only constraints, and the deletion policy to every Node in that set, and persist the deletion and `affectedCount` from the same set; an incomplete descendants list supplied by a caller or adapter is not an authoritative deletion plan.
- The I-JSON receiving boundary MUST enforce a deterministic maximum nesting depth and member and array-item budgets before constructing business objects; relying on a natural JavaScript call stack overflow is not depth control.
- Parent ancestry and subtree traversals MUST enforce a deterministic maximum depth and maximum number of visited Nodes, and fail closed before any persistence when the limit is exceeded.
- Remote input MUST NOT raise the parsing, ancestry, or subtree hard limits configured by the implementation or deployment. The concrete values are chosen by the deployment within the implementation's limits; over-limit HTTP requests use `413 payload_too_large`, and non-HTTP boundaries return a stable limit denial.

---

[← 00 Practical profile](00-practical-profile.md) · [All documents](../README.md#documents) · [Glossary](../GLOSSARY.md) · [02 HTTP, publication, and feed →](02-http-publication-feed.md)
