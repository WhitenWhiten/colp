# 08. Publisher HTTP Write API

<a id="colp-section-1"></a>

## 1. Scope

This document defines the minimum wire contract of the `publisher` profile. Resource representation schemas and write DTOs must be separate: clients must not forge server-managed `id`, root, time, revision, cursor, or audit fields. Every request and response DTO has a stable name in the core schema `$defs`.

All example paths are recommended dynamic routes; clients actually use the Manifest `endpoints` and response links. A Manifest that declares `publisher` but lacks any required write endpoint is invalid.

<a id="colp-section-2"></a>

## 2. General Rules

- Requests use UTF-8.
- Creation uses `application/json`.
- PATCH uses `application/merge-patch+json` by default.
- Modifying and deleting an existing resource must send the `If-Match` of the resource's latest response.
- Every retryable POST must send `Idempotency-Key`.
- An idempotency key is bound to the principal, method, endpoint key, resource identity, protocol version, and canonical request digest: JSON uses RFC 8785, the decoded query uses canonical JSON, and the media type is normalized to lowercase with ignorable whitespace removed. The same key with a different request returns `409 idempotency_key_reused`.
- A successful create returns `201 Created`, `Location`, `ETag`, and the complete create result.
- A successful modification returns `200 OK`, the new `ETag`, and the complete resource; an empty `204`, which would not let the client update its revision, is not used.
- A schema or candidate-graph semantic error returns `422 invalid_document`, an authorization scope error returns `403 insufficient_scope`, a missing `If-Match` returns `428`, an ETag mismatch returns `412`, and a semantic conflict returns `409`.
- Only when the request has passed authentication, authorization, and the concealment policy, and the read-only constraint of the Node itself or of any authoritative ancestor is the actual reason for rejection, the publisher MUST return `403 node_read_only`. Unauthorized or hidden resources keep using the 403 / 404 chosen by the concealment policy and must not expose the read-only state, and a genuine read-only rejection must not be folded into `insufficient_scope` or an unregistered short code.
- The generic Node write surface of a publisher may meet a `managed-bookmarks` folder or its descendants, so this profile's write boundary includes the default read-only rule of that role; this obligation does not mean that a non-publisher deployment that only offers other authoritative write capabilities accepts or stores this optional role.
- A parent or subtree traversal that exceeds the deployment's hard limit returns `413 payload_too_large`. Unresolvable or corrupted authoritative ancestry is a server state error, and an internal guard denial code must not be returned as an unregistered wire `code`.
- Write responses and error responses use `Cache-Control: no-store`.

<a id="colp-section-3"></a>

## 3. Atomically Create a Collection and Its Root

`POST /collections`

The Collection representation requires `rootNodeId`, so the create endpoint MUST create the Collection and its single root in one transaction. A request must not first create a dangling Collection, or first create a root without a Collection.

```http
POST /collections HTTP/1.1
Content-Type: application/json
Idempotency-Key: 019b-create-interface-systems
```

```json
{
  "collection": {
    "kind": "knowledge_collection",
    "title": "Interface Systems",
    "summary": "A curated path into design engineering.",
    "visibility": "private",
    "publication": {
      "feedMode": "release",
      "includeNodeContent": "summary",
      "includeRelations": true
    },
    "extensions": {}
  },
  "root": {
    "title": "Interface Systems",
    "folderRole": "root"
  }
}
```

```http
HTTP/1.1 201 Created
Location: https://alice.example/collections/c/019b3ca2-8424-7cc2-9a61-4bf44c23f07a
ETag: "collection-r_1"
Content-Type: application/vnd.collection-protocol.collection-create-result+json;version=0.1
Cache-Control: no-store
```

The response body must validate against `collectionCreateResult` and contain the complete Collection, the complete root, and links. See `examples/publisher-collection-create-result.json` for an executable example; an empty object, or returning only the new ID, must not replace the complete result.

Snapshot import is a separate, expensive operation and does not reuse this endpoint. COLP 0.1 defines no Snapshot import endpoint; a future version may add one with its own Manifest endpoint key and limits.

<a id="colp-section-4"></a>

## 4. Update a Collection

`PATCH /collections/c/{collectionId}`

```http
PATCH /collections/c/collection-1 HTTP/1.1
Content-Type: application/merge-patch+json
If-Match: "collection-r_17"
```

```json
{
  "summary": "Updated summary",
  "tags": ["design", "engineering", "systems"]
}
```

Clients must not PATCH `id`, `rootNodeId`, `createdAt`, `updatedAt`, `revision`, or `eventCursor`. Changing `visibility` to `public` or `unlisted` still requires an access scope, and when initiated through MCP must go through plan / commit.

The application service must normalize a successful PATCH into an `update_collection_metadata` canonical operation and store the typed `base` / `value` payload.

<a id="colp-section-5"></a>

## 5. Delete a Collection

`DELETE /collections/c/{collectionId}`

This endpoint only performs a recoverable logical deletion and creates a deletion receipt; it does not perform a physical purge. A physical purge is a deployment-level administrative operation and is not part of the `publisher` profile.

A success returns `200 OK` and a `deletionReceipt`. The publisher does not depend on Sync, so the response must not require or invent a sync cursor:

```json
{
  "receipt": {
    "resourceType": "collection",
    "targetId": "collection-1",
    "collectionId": "collection-1",
    "scope": "single",
    "deletedAt": "2026-07-16T08:00:00Z",
    "deleteRevision": "r_18",
    "operationId": "op_delete_collection_18",
    "affectedCount": 1,
    "purgeAfter": "2026-08-15T08:00:00Z"
  }
}
```

This is a high-risk operation and must be audited; an MCP call must go through plan / commit.

<a id="colp-section-6"></a>

## 6. Create a Node

`POST /collections/c/{collectionId}/nodes`

```json
{
  "parentId": "root-1",
  "afterId": null,
  "beforeId": null,
  "node": {
    "kind": "bookmark",
    "title": "Example",
    "url": "https://example.com/",
    "tags": [],
    "extensions": {}
  }
}
```

- `parentId` MUST be resolved, in the same transaction as the creation, to a root or folder of the same Collection; the ordinary Node create endpoint must not accept `null` and must not create a root.
- `afterId` / `beforeId` are a semantic position; the server generates the position.
- When both are present they must be adjacent; otherwise the server returns `409 position_context_stale`.
- The bookmark URL must validate against `$defs.bookmarkUrl`. HTTP(S) is accepted by default; `file`, `about`, internal browser schemes, and so on require both `features.bookmarkUrls.acceptedSchemes` and the deployment policy to allow them, and must not enter Publication or Feed.

A success returns `201 Created`, the Node `Location`, the Node `ETag`, and the complete Node.

<a id="colp-section-7"></a>

## 7. Update a Node

`PATCH /collections/c/{collectionId}/nodes/{nodeId}`

PATCH modifies only content fields. Moves and reorders must use the move endpoint, so that parent and position do not have two concurrent semantics in an ordinary patch.

Clients must not PATCH `id`, `collectionId`, `kind`, `parentId`, `position`, `sourceRefs`, `createdAt`, `updatedAt`, `revision`, or `deletedAt`.

Setting a field to JSON `null` deletes an optional field per RFC 7396; a non-nullable field returns `422`.

The application service must normalize a successful PATCH into an `update_node_content` canonical operation; it cannot convert it into a generic patch operation containing arbitrary JSON Pointers.

<a id="colp-section-8"></a>

## 8. Move / Reorder

`POST /collections/c/{collectionId}/nodes/{nodeId}/move`

```json
{
  "newParentId": "folder-b",
  "afterId": "node-x",
  "beforeId": "node-y",
  "baseSourceParentRevision": "children_r_8",
  "baseTargetParentRevision": "children_r_9"
}
```

The request must also send the Node's `If-Match`. Even when the source and the target are the same parent, both the source and target children revisions must be sent; in that case the two values are equal. The server MUST verify, in the same transaction as the move, the source Node, both parents, that the target parent's kind is root or folder, the same-Collection constraint, and the authorization of the position context, rather than checking only the Node itself; the root must not be moved through this endpoint. A success returns the updated Node, the source parent revision, the target parent revision, and the position after transformation.

<a id="colp-section-9"></a>

## 9. Delete a Node or Subtree

`DELETE /collections/c/{collectionId}/nodes/{nodeId}`

The query must validate against `$defs.nodeDeleteQuery`. Booleans accept only `true` / `false`; unknown parameters and repeated scalars return `400 invalid_query`.

- Bookmarks, separators, aliases, and empty folders can be deleted directly.
- A non-empty folder without `recursive=true` returns `409 folder_not_empty`.
- `recursive=true` means `delete_subtree` and requires `nodes:delete`. The server MUST derive the complete subtree from the authoritative parent/child relationships in the same transaction as the deletion, perform authorization and read-only checks on every member, and execute the deletion, the internal watermark, and `affectedCount` from the same member set; a descendants list submitted by the request or an adapter cannot replace this traversal.
- The server must keep the internal deletion membership of every deleted ID; it cannot keep only the root ID and then let old replicas update the children.

A success returns `200 OK` and a deletion receipt; `receipt.affectedCount` describes the size of the deletion. Above the deployment's safety threshold, an ordinary HTTP management UI needs additional confirmation; MCP must go through plan / commit.

<a id="colp-section-10"></a>

## 10. Annotation, Attachment, and Relation

`publisher` must provide minimal CRUD for these sidecars:

```text
POST         /collections/c/{collectionId}/annotations
PATCH/DELETE /collections/c/{collectionId}/annotations/{annotationId}
POST         /collections/c/{collectionId}/attachments
PATCH/DELETE /collections/c/{collectionId}/attachments/{attachmentId}
POST         /collections/c/{collectionId}/relations
PATCH/DELETE /collections/c/{collectionId}/relations/{relationId}
```

Creation uses the `annotationCreate`, `attachmentCreate`, and `relationCreate` DTOs and must not submit server-managed fields. PATCH uses the corresponding merge patch DTO and follows `If-Match`. Deletion returns a deletion receipt. The attachment endpoints manage only protocol metadata; binary upload, fetching, and signed object storage URLs are not required capabilities of this profile.

The application service must convert these writes into `create_*` / `update_*` / `delete_*` canonical operations. Attachments use `create_attachment`, `update_attachment`, and `delete_attachment`; relations use `create_relation`, `update_relation`, and `delete_relation`. HTTP, Sync, and MCP must not maintain a second set of change semantics.

<a id="colp-section-11"></a>

## 11. Release

`POST /collections/c/{collectionId}/release`

The request contains a release summary and the Collection's `If-Match`. A success returns `201 Created`, with `Location` pointing to the immutable release:

```text
/collections/c/{collectionId}/releases/{releaseId}
/collections/c/{collectionId}/releases/{releaseId}/snapshot
```

A release Snapshot must be bound to the release revision and provide an ETag and Content-Digest. Historical Feed events must not point to the latest `/snapshot`, which changes.

`GET /collections/c/{collectionId}/releases` returns a `releaseDirectory`; `GET /collections/c/{collectionId}/releases/{releaseId}` returns a `releaseResult`. Release resources cannot be modified; restoring a historical version must produce a new draft or operation, never overwrite a historical release.

<a id="colp-section-12"></a>

## 12. Idempotent Replay

The server keeps idempotency key records for at least the Manifest's `limits.idempotencyRetentionSeconds`:

- Same principal, method, endpoint, key, and request digest: return the same status code, `Location`, and business result as the first request.
- Same binding but a different request digest: `409 idempotency_key_reused`, and the request must not be executed.
- The same key being processed concurrently: only one execution is allowed; other requests wait for the original result or return a retryable `409 idempotency_in_progress`.
- The deduplication record and the business transaction must commit atomically; there can be no window in which the resource has been created but the key record is lost.
