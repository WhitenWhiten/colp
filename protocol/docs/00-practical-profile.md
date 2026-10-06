# 00. Practical Interoperability Profile

<a id="colp-section-1"></a>

## 1. Purpose

The Collection Protocol covers publication, synchronization, security, and MCP, but an implementation should not have to build all of that just to exchange one bookmark tree. This profile defines the smallest interoperable surface a first version should implement, and splits everything else into composable modules.

This document is the implementation baseline for the 0.1 draft. Where another chapter conflicts with this document, the stricter and more explicit rule wins.

<a id="colp-section-2"></a>

## 2. Non-goals

The first interoperable version does not define:

- Web crawling, full-text archiving, search ranking, or recommendation algorithms.
- Payment, subscriptions, DRM, or per-use billing.
- Distributed transactions across servers.
- Using a Feed as a synchronization log.
- A requirement that every implementation provide OAuth, MCP, WebSub, or HTTP Message Signatures.

These capabilities may be implemented as separate extensions, but must not change the core objects or the HTTP semantics.

<a id="colp-section-3"></a>

## 3. Composable Profiles

Each mount in the Manifest declares its own `profiles`:

| Profile | Depends on | Required capabilities |
|---|---|---|
| `core` | — | Core objects, Snapshot, structural validation, semantic validation |
| `publication` | `core` | Discovery, directory, metadata, Snapshot, HTTP caching and errors |
| `feed` | `publication` | Public event stream, cursors, redaction, polling hints |
| `publisher` | `publication` | Conditional writes, idempotency, management of Collection / Node / Annotation / Attachment / Relation / Release |
| `sync` | `core` | Single-Collection session, push, pull, ack, conflicts, tombstones |
| `mcp-read` | `core` | Read-only resources and tools visible to the current principal |
| `mcp-write` | `mcp-read`, `publisher` | Write tools, audit, risk aggregation, plan / commit |

A profile is a capability claim, not a marketing tier. An implementation MUST NOT declare a profile that has not passed the corresponding conformance tests.

Conformance evidence comes from `requirements.yaml`: package-level tests, deployment endpoints, and required ports must all be complete. Manifest configuration alone cannot create a profile claim.

A profile dependency is a dependency on the data model, wire contract, and endpoint semantics. It does not mean that every deployment takes on every optional role mentioned in the chapters of the profiles it depends on. For example, `publication -> core` requires that Publication representations follow the Core object and Snapshot semantics, but a read-only Publication deployment does not thereby become a Sync server, an AI content writer, a local browser profile store, or a server-side profile ID HMAC deriver. Ordinary authoritative Node writes likewise do not mean that a deployment accepts or stores every optional folder role; only a write surface that actually supports `managed-bookmarks` takes on that role's default read-only boundary. Deployment conformance tests must be selected by the profiles actually declared and the roles actually enabled; when a role is not enabled, a deployment must not fake the corresponding ports, data, or persistence just to pass a test.

Manifest endpoints are composed by profile as well: only a mount that declares `publication` must provide `directory`, `collection`, and `snapshot`. A Sync-only or MCP-only mount must not be forced to fake Publication endpoints it does not implement.

<a id="colp-section-4"></a>

## 4. Minimal Interoperable Publisher

A first server is advised to implement only `core + publication`:

1. `GET /.well-known/collection-protocol`.
2. One mount in the Manifest, with that mount's `directory`, `collection`, and `snapshot` endpoints.
3. The Collection directory.
4. Collection metadata and links.
5. A complete, single-page, normalized Snapshot.
6. `ETag`, `If-None-Match`, `304`, and Problem Details.

This minimal publisher is a read-only deployment boundary. It does not need a managed-bookmark write boundary, Sync extension round-tripping, authoritative AI annotation writes, local browser profile ID persistence, or server-side profile ID HMAC key rotation. A deployment that additionally exposes any of these roles must satisfy the corresponding rules and deployment conformance tests for each.

A first client only needs to:

1. Read the Manifest.
2. Choose a mount that declares both `core` and `publication`.
3. Follow Manifest endpoints and the links in responses, without guessing paths.
4. Validate against the JSON Schema.
5. Validate the tree, references, and uniqueness.
6. Persist the `ETag` and use a conditional GET next time.

<a id="colp-section-5"></a>

## 5. Endpoint-Driven, No Path Guessing

A Collection ID is opaque, and an API path and a human-facing canonical URL are two different things. The Manifest must declare absolute endpoints or URI templates:

```json
{
  "id": "default",
  "baseUrl": "https://alice.example/collections/",
  "profiles": ["core", "publication", "feed"],
  "endpoints": {
    "directory": "https://alice.example/collections",
    "collection": "https://alice.example/collections/c/{collectionId}",
    "snapshot": "https://alice.example/collections/c/{collectionId}/snapshot",
    "instanceFeed": "https://alice.example/collections/-/feed",
    "collectionFeed": "https://alice.example/collections/c/{collectionId}/feed"
  }
}
```

Templates use only RFC 6570 Level 1 variables. The standard variables in 0.1 are `collectionId`, `nodeId`, `annotationId`, `attachmentId`, `relationId`, `releaseId`, `conflictId`, and `keyId`. Variable values must be UTF-8 percent-encoded, and clients must not parse IDs as path segments, slugs, or times.

The variable set of each standard endpoint key must equal the one in the endpoint contract registry exactly; an object endpoint that omits a required variable is as invalid as one that uses a wrong variable. Validation and expansion must use the same RFC 6570 implementation.

Recommended dynamic routes use `/c/{collectionId}` for objects and `/-/` for instance services, so that they cannot collide with opaque IDs. Static hosting may declare `.json` file paths and does not need to imitate dynamic routes.

<a id="colp-section-6"></a>

## 6. A Snapshot Has One Authoritative Representation

A canonical Snapshot uses normalized top-level arrays:

- `nodes`
- `annotations`
- `attachments`
- `relations`
- `tombstones`

Nodes no longer embed these objects. Annotations and Attachments use `subject` to point at a Collection or Node. A Node Detail response may expand related objects through `included`, but the expanded content is only a copy of the same object, not a second authoritative version.

Snapshot `mode`:

- `publication`: the redacted publication projection. It must not contain source references, tombstones, internal principals, or non-public sidecars, and can be used for anonymous or authorized reads.
- `sync`: the authorized synchronization projection. It may contain source references, tombstones, and private objects, but remains limited by scopes and ACLs.

`complete` states that the query selected the complete logical Snapshot. It must be `false` when the response is cropped by `root`, `depth`, or an `include` that omits an authoritative array; it must not become `false` merely because of HTTP pagination.

A complete logical Snapshot may be paginated. All pages must share the `snapshotId`, `revision`, `mode`, query scope, and Collection projection, and `page.sequence` starts at 1 and increases by one. A client may use the combined result as replacement state only after it has fetched every page by following the `next` link returned by the server and has received `page.hasMore=false`. A missing or duplicated page, a changed revision, or an expired cursor must discard the whole assembly.

Pagination uses only `page.nextCursor`. Sync progress uses only `syncCursor`. Feeds use their own cursor namespace. The three must not be interchanged.

<a id="colp-section-7"></a>

## 7. Two-Stage Validation

JSON Schema is responsible for structure and format validation. Implementations must enable Draft 2020-12 format assertion or perform equivalent RFC 3339 and URI validation; treating `format` as an annotation only does not conform to this profile. After structural validation passes, the receiver MUST perform semantic validation:

- Exactly one root, equal to `collection.rootNodeId`.
- Every object has the same `collectionId`.
- IDs are unique, and live IDs do not overlap tombstone IDs.
- Every non-root parent exists and is a root or folder.
- The parent graph and the alias graph are acyclic.
- Positions under the same parent are non-empty and unique.
- Annotation and Attachment subjects, Relation endpoints, and provenance references exist.
- A public Snapshot contains no private or internal fields.
- After authorization, a Publication Snapshot may carry the safe projection of a `protected` or `private` Collection; `mode` describes the projection category and does not replace ACLs.
- A restricted Bookmark with `redacted=true` may keep its title, position, and public teaser, but must drop the target URL, source references, and unpublished fields.

`scripts/validate_examples.py` in this repository performs both kinds of validation.

<a id="colp-section-8"></a>

## 8. Safety Floor for Writes and Sync

- `PATCH` uses `application/merge-patch+json` by default; JSON Patch requires an explicit capability declaration.
- A failed `If-Match` always returns `412`; a missing required condition always returns `428`; `409` is only for business conflicts.
- `Idempotency-Key` must be bound to the principal, the endpoint, and the request digest. The same key with a different body returns `409 idempotency_key_reused`.
- The required Sync mode in 0.1 is one session per Collection. Multi-Collection sessions are an optional capability.
- `(replicaId, sequenceScope, sequence)` must be contiguous and must not be rewritten. The scope of an ordinary session is `collectionId`; an unbound instance bootstrap temporarily uses `sessionId`. The same sequence with a different operation returns `409 sequence_reuse`; a gap returns `409 sequence_gap`. Offline queues of different Collections never block each other.
- A tombstone may be purged only after its minimum retention period has ended, every active replica has acknowledged the delete cursor, and the purge watermark has been persisted. An `expired` replica can recover only while its retention window is complete; otherwise it moves to `recovery_required` and bootstraps again. `retired` is terminal: continuing to sync requires registering a new replica ID. An old queue must not be pushed directly.
- MCP `sync.push` must check the highest risk among the embedded operations; delete, mirror, public exposure, and similar operations cannot bypass plan / commit.

<a id="colp-section-9"></a>

## 9. Versions and Extensions

Within one exact protocol version, new data can only go into HTTPS-namespaced `extensions`. A change to core fields requires a new schema and protocol version.

Authoritative and Sync bookmark URLs use `$defs.bookmarkUrl`, which allows the safe local schemes a mount declares explicitly. Publication and Feed allow only HTTP(S); local schemes must be redacted or kept in the authorized Sync representation.

The core schema of a public projection allows `extensions` to be present; whether an extension may be published is decided semantically by the deployment's configured namespace allowlist and that namespace's publication schema. Without a configured allowlist, extensions must be removed, rather than having the base schema forbid every extension permanently.

A strict schema may use `additionalProperties: false`. A client that meets a newer version negotiates the version first and must not act on unknown core fields as if it understood them. A relay that promises round-tripping of unknown data must keep the original representation or refuse to downgrade, instead of silently dropping data.
