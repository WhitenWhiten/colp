# The Collection Protocol Specification 0.1-draft

> **In short:** The overview that the numbered chapters build on. It names the five layers of the protocol, defines the three kinds of data (Snapshot, Sync, and Feed), and sets the rules every profile shares: IDs, times, revisions, URLs, discovery, the recommended endpoint layout, HTTP behavior, visibility, and version negotiation.
>
> **Read this if** you are implementing any part of COLP. For a gentler start, take the [five-minute tour](README.md#colp-in-five-minutes) first, and keep the [glossary](GLOSSARY.md) open for unfamiliar terms. **Profiles:** all.

<a id="colp-section-1"></a>

## 1. Conventions

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` in this document are to be interpreted as described in BCP 14 (RFC 2119 and RFC 8174) when, and only when, they appear in all capitals.

Field names, endpoint keys, problem codes, and scope names on the wire are ASCII identifiers. They are case-sensitive and are never translated.

This specification is at `0.1-draft`. While it is a draft, inconsistent wire contracts may still be corrected, and implementations must not treat the draft as a stable release. Unpublished tags and private development packages that have not promised stability do not establish a `0.1` compatibility baseline. The first stable release must state in its release notes whether any publicly stable `0.1` validator or wire implementation existed before it: if none existed, the corrected draft may be frozen as the initial baseline; if one existed, the release must choose a new minor or major version under Section 12 and must not keep reusing `0.1`. A first implementation should follow the [Practical Interoperability Profile](docs/00-practical-profile.md).

<a id="colp-section-2"></a>

## 2. Scope

The Collection Protocol defines five layers that are independent but composable:

1. **Core Data Model**: Collection, Node, Annotation, Attachment, Relation, and Access Policy.
2. **Publication Protocol**: discovering, reading, caching, and distributing Collections over HTTP.
3. **Synchronization Protocol**: push, pull, conversion, conflict handling, and deletion propagation between trusted replicas.
4. **Security Profile**: API keys, OAuth, ACLs, rate limits, signatures, and audit.
5. **MCP Profile**: a mapping of the first four layers onto MCP resources, tools, and subscription notifications.

An implementation may support only Core and Publication. An implementation that claims Sync or MCP support must satisfy the complete profile defined in the corresponding document.

This protocol does not define web crawling, full-text archiving, search ranking, recommendation algorithms, payment, DRM, or distributed transactions across servers. Such capabilities must be separate extensions and must not change the core exchange semantics.

<a id="colp-section-3"></a>

## 3. Three Kinds of Data

<a id="colp-section-3-1"></a>

### 3.1 Snapshot

A Snapshot is the complete, normalized state of one Collection at one specific revision.

- It is used for first import, disaster recovery, static hosting, and validation.
- A Snapshot MUST carry `snapshotId`, `mode`, `complete`, `revision`, `generatedAt`, the pagination state, and the content digest policy. `complete` states that the query selected the complete logical Snapshot; it does not say whether the current HTTP page is the last page.
- A complete logical Snapshot may be paginated. A receiver may atomically replace local state only after it has persisted every page for the same `snapshotId`, `revision`, and query scope and has received `page.hasMore=false`.
- Nodes in a Snapshot form a flat array; `parentId` and `position` express hierarchy and order.
- Annotations, Attachments, and Relations appear exactly once, in top-level Snapshot arrays. A Node does not embed a second authoritative copy of them.
- `page.nextCursor` is used only for Snapshot pagination, `syncCursor` only for synchronization progress, and Feed cursors use their own namespace. Pages must be numbered by `page.sequence`, starting at 1 and increasing by one. Clients must not skip pages or guess cursors in parallel.

<a id="colp-section-3-2"></a>

### 3.2 Sync

Sync is two-way state replication between trusted replicas.

- It must support idempotent operations, offline queues, tombstones, conflicts, and resumable cursors.
- It must preserve browser source mappings and conversion warnings.
- Sync data does not automatically become public data.

<a id="colp-section-3-3"></a>

### 3.3 Feed

A Feed is a distribution view for followers, aggregators, and search engines.

- A Feed may publish only Collection Releases instead of every internal edit.
- A Feed may compact, redact, or merge events.
- A Feed must not contain private notes, browser profile IDs, native node IDs, secrets, internal ACL identifiers, or attachments that were not explicitly made public.
- The completeness of Feed history must not be the only basis for recovering synchronization state.

<a id="colp-section-4"></a>

## 4. Resource Model

<a id="colp-section-4-1"></a>

### 4.1 Collection

A Collection is an independent boundary for versioning, access, and distribution. It has:

- A stable ID and a canonical URL.
- One Root Node.
- Collection-level metadata.
- A publication policy and an access policy.
- A revision, an event cursor, and optional Releases.
- One or more creators or maintainers.

Collection `kind`:

- `bookmarks`: a traditional bookmark tree.
- `reading_path`: emphasizes order and learning paths.
- `knowledge_collection`: includes annotations, relations, and source references.
- `mixed`: a combination of the above.

<a id="colp-section-4-2"></a>

### 4.2 Node

A Node is the smallest structural unit of the tree:

- `root`
- `folder`
- `bookmark`
- `separator`
- `alias`

An `alias` points to another Node in the same Collection. When syncing to a browser that does not support aliases, an adapter must either materialize the alias as a duplicate bookmark or explicitly refuse.

<a id="colp-section-4-3"></a>

### 4.3 Annotation

An Annotation is content attached to a Collection or a Node:

- `note`
- `summary`
- `tldr`
- `highlight`
- `reading_state`
- `rating`
- `custom`

Every Annotation has its own `visibility`. A private Annotation must not enter a public projection, even if its parent Node is public.

The identity fields of AI provenance are established by the server's trusted generation boundary. Later human, imported, or derived writes may edit the content, but cannot rewrite the generation source of existing AI content based on the provenance in a request body. See [`docs/01-core-data-model.md`](docs/01-core-data-model.md) for the complete rules.

<a id="colp-section-4-4"></a>

### 4.4 Extension

Source-specific data that does not fit the core model must be placed in `extensions`:

```json
{
  "extensions": {
    "https://example.com/ns/repository-metadata/v1": {
      "stars": 18400,
      "language": "TypeScript"
    }
  }
}
```

An extension key MUST be an HTTPS namespace URI without userinfo, in which any explicit port is a non-empty decimal number. Namespace keys are compared exactly, code point by code point, with no case folding, default-port removal, or percent-encoding normalization. Intermediaries, sync servers, and export tools MUST preserve unknown extensions unchanged unless a security policy explicitly removes them.

Within one exact protocol version, new data MUST be placed in `extensions`. A new core field requires a new schema and protocol version; it cannot rely on the `additionalProperties` behavior of an older version to slip in.

<a id="colp-section-5"></a>

## 5. IDs, Time, and Versions

<a id="colp-section-5-1"></a>

### 5.1 IDs

- New objects SHOULD use UUIDv7.
- Wire IDs are opaque strings. Clients must not infer time, ownership, or URLs from an ID.
- A wire ID MUST consist of 1 to 128 URI unreserved ASCII characters: `ALPHA / DIGIT / "-" / "." / "_" / "~"`.
- Collection, Node, Annotation, Attachment, Relation, Operation, and Event IDs MUST be unique within their server and are never reused.
- Native browser IDs must not be used as primary protocol IDs; they belong in `sourceRefs`.
- The global identity of a resource is `(serverUuid, resourceType, id)`. A cross-server reference MUST use the canonical URI and cannot send a bare ID alone.
- When a URI template is expanded, IDs must be UTF-8 percent-encoded. Servers compare the decoded raw byte values and do not fold case.

**Canonical resource URI.** The only serialization of the canonical URI is `colp:/resources/~{serverUuid}/{resourceType}/~{id}`. `serverUuid` and `id` are decoded wire IDs. Because wire IDs contain only URI unreserved ASCII characters, the canonical URI contains no percent-encoding. `resourceType` is one of `collection`, `node`, `annotation`, `attachment`, `relation`, `operation`, or `event`. The form has no authority, userinfo, port, query, or fragment. The `~` prefix ensures that legal wire IDs whose value is `.` or `..` are not normalized away by a URI parser as path-traversal segments.

Canonical URIs are compared field by field, case-sensitively, on the fully decoded triple, not as display URLs or as strings normalized by a URI parser. A bare wire ID denotes a reference only when the caller also supplies an explicit local resolution context with the `serverUuid` of the same server and the expected `resourceType`; without that context, references use the canonical URI. This global identity URI and the MCP Profile's `colp://{serverUuid}/...` resource locator are two different URI namespaces: the former has no authority and encodes only the resource identity triple, while the latter has an authority and locates a specific MCP representation or operation. There is no implicit alias or general string conversion between them.

<a id="colp-section-5-2"></a>

### 5.2 Time

- Times are RFC 3339 strings.
- Canonical writes SHOULD use UTC with `Z`.
- When converting browser millisecond timestamps, the original value must be kept in the source reference, to avoid precision and time zone mistakes.

<a id="colp-section-5-3"></a>

### 5.3 Revisions and Cursors

- `revision` identifies an object version that can be used for conditional writes.
- `cursor` identifies a position in an event log.
- Both are opaque strings generated by the server.
- Clients must not compare cursors as timestamps and must not increment them.

<a id="colp-section-6"></a>

## 6. URLs and Duplicate Detection

- `url` stores the URL the user actually bookmarked, without destructive rewriting.
- The authoritative and Sync representations of a Bookmark use `$defs.bookmarkUrl`: it structurally allows absolute local URIs, but forbids `javascript:`, `vbscript:`, `data:`, and control characters. A mount declares the schemes it actually accepts in `features.bookmarkUrls.acceptedSchemes`, which includes at least `http` and `https`.
- Navigable URLs in Publication, Feed, and assistant-facing output allow only HTTP(S) whose authority has no userinfo. URLs with other schemes or with userinfo must be omitted, redacted, or kept in the authorized Sync representation; they must not be published directly.
- `canonicalUrl` MAY store a canonical URL that was computed by an explicit rule or declared by the page.
- `urlHash` MAY be used for duplicate detection, but must not be used as an object ID.
- Default normalization may perform only uncontroversial operations, such as lowercasing the scheme and host and removing a default port.
- Removing tracking parameters, expanding short links, deleting fragments, and similar operations must be controlled by a named `normalizationProfile`.
- URLs with signatures, temporary tokens, or order-sensitive queries MUST keep their original value.

**URL hash.** The wire syntax of the optional Bookmark `urlHash` MUST be `sha-256=:<base64>:`, where the Base64 MUST use canonical padded encoding and decode to exactly 32 octets. The digest input MUST be the UTF-8 octets of the original `url` string, without URL parsing, normalization, or rewriting. A missing `urlHash` is legal; when present it MUST match the original `url` preserved in the same object. Equal hashes MUST only select duplicate candidates for further comparison and MUST NOT prove that two objects are the same; the final decision compares the applicable URL, content, and Collection semantics. `urlHash` MUST NOT be written into or substitute for `id`, `collectionId`, Node references, or any other object ID field.

<a id="colp-section-7"></a>

## 7. Discovery

A server MUST provide a Manifest at the following location:

```text
/.well-known/collection-protocol
```

If the protocol is mounted under a sub-path, `mounts[].baseUrl` in the Manifest points to the real base address. Each mount MUST declare its own `profiles`, `endpoints`, authentication, and limits; clients MUST follow endpoints and links and MUST NOT guess paths from `baseUrl`. Endpoint templates use RFC 6570 Level 1.

HTML pages and HTTP responses SHOULD additionally provide:

```html
<link rel="collection-protocol" href="/.well-known/collection-protocol">
```

```http
Link: </.well-known/collection-protocol>; rel="collection-protocol"
```

The Manifest must declare the `serverUuid`, versions, mounts, endpoints, profiles, authentication methods, page limits, and recommended polling interval. A profile's endpoint dependencies are part of the wire contract: for example, `publisher` must declare the read and write templates for Collection, Node, Annotation, Attachment, Relation, and Release, not just a capability name.

<a id="colp-section-8"></a>

## 8. Endpoint Overview

The paths below are recommended dynamic routes. A Manifest may declare other absolute paths, such as static `.json` files; clients must not hard-code this table. `c/` is the reserved route segment for objects and `-/` is the reserved segment for instance services.

<a id="colp-section-8-1"></a>

### 8.1 Public Reads

| Method | Path | Meaning |
|---|---|---|
| GET | `/` | Discoverable Collection list |
| GET | `/-/feed` | Instance-wide public event stream |
| GET | `/c/{collectionId}` | Collection metadata |
| GET | `/c/{collectionId}/snapshot` | Complete or paginated Snapshot |
| GET | `/c/{collectionId}/nodes/{nodeId}` | A single public Node |
| GET | `/c/{collectionId}/feed` | Public event stream of one Collection |

<a id="colp-section-8-2"></a>

### 8.2 Authoring Writes

| Method | Path | Meaning |
|---|---|---|
| POST | `/` | Create a Collection |
| PATCH | `/c/{collectionId}` | Update Collection metadata |
| DELETE | `/c/{collectionId}` | Delete or archive a Collection |
| POST | `/c/{collectionId}/nodes` | Create a Node |
| PATCH | `/c/{collectionId}/nodes/{nodeId}` | Update a Node |
| DELETE | `/c/{collectionId}/nodes/{nodeId}` | Delete a Node or subtree |
| POST | `/c/{collectionId}/nodes/{nodeId}/move` | Move or reorder a Node |
| POST | `/c/{collectionId}/annotations` | Create an Annotation |
| PATCH/DELETE | `/c/{collectionId}/annotations/{annotationId}` | Update or delete an Annotation |
| POST | `/c/{collectionId}/attachments` | Create Attachment metadata |
| PATCH/DELETE | `/c/{collectionId}/attachments/{attachmentId}` | Update or delete Attachment metadata |
| POST | `/c/{collectionId}/relations` | Create a Relation |
| PATCH/DELETE | `/c/{collectionId}/relations/{relationId}` | Update or delete a Relation |
| POST | `/c/{collectionId}/release` | Publish an immutable public Release |
| GET | `/c/{collectionId}/releases` | List immutable Releases |
| GET | `/c/{collectionId}/releases/{releaseId}` | Get Release metadata |
| GET | `/c/{collectionId}/releases/{releaseId}/snapshot` | Get an immutable Release Snapshot |

<a id="colp-section-8-3"></a>

### 8.3 Synchronization

| Method | Path | Meaning |
|---|---|---|
| POST | `/-/sync/sessions` | Negotiate replica, capabilities, and bootstrap mode |
| GET | `/-/sync/snapshot` | Get a Sync Snapshot |
| POST | `/-/sync/push` | Push an operation batch idempotently |
| GET | `/-/sync/pull` | Pull operations and conflicts by cursor |
| POST | `/-/sync/ack` | Acknowledge what has been persisted locally |
| POST | `/-/sync/conflicts/{id}/resolve` | Resolve a conflict explicitly |

<a id="colp-section-8-4"></a>

### 8.4 Administration and Security

| Method | Path | Meaning |
|---|---|---|
| GET/PATCH | `/-/admin/access` | Default access policy |
| GET/PATCH | `/c/{collectionId}/access` | Collection ACL and publication policy |
| GET/POST | `/-/admin/keys` | List or create key metadata |
| POST | `/-/admin/keys/{keyId}/rotate` | Rotate a key |
| DELETE | `/-/admin/keys/{keyId}` | Revoke a key |
| GET/PATCH | `/-/admin/rate-limits` | Rate-limit policies |
| GET | `/-/admin/audit` | Audit log |
| POST | `/-/mcp` | MCP Streamable HTTP endpoint (stateless and POST-only; `GET` and `DELETE` are rejected, see [`docs/05-mcp-profile.md`](docs/05-mcp-profile.md)) |

<a id="colp-section-9"></a>

## 9. HTTP Rules

- Requests and responses MUST use UTF-8.
- JSON MUST follow the I-JSON interoperability constraints: no duplicate member names, no protocol integer outside the range that IEEE 754 binary64 represents exactly, and no non-finite numbers.
- The query, request body, and response body of every endpoint MUST be validated with the named `$defs` listed in [`docs/10-implementation-contract.md`](docs/10-implementation-contract.md). The root `anyOf` of the schema is only for independently recognizable resource and response representations and must not replace endpoint-level DTO validation.
- Query arrays use repeated parameters, for example `include=annotations&include=attachments`. A repeated scalar parameter, an empty value, or an unknown parameter returns `400 invalid_query`. Clients and servers must encode and decode with the same endpoint contract registry.
- Clients MUST support `application/json`.
- Implementations SHOULD support `application/vnd.collection-protocol.*+json;version=0.1`.
- GET responses SHOULD return `ETag` and `Last-Modified`. An ETag identifies a specific representation and must reflect differences in projection, query, page, and content negotiation; one ETag derived only from the Collection revision must not be shared by every page.
- Clients SHOULD use `If-None-Match`; servers may answer `304 Not Modified`.
- Modifying an existing resource MUST use `If-Match`, to avoid silent overwrites.
- When a required precondition is missing, the server MUST return `428 Precondition Required`.
- When `If-Match` does not match, the server MUST return `412 Precondition Failed` with the current revision or ETag. `409 Conflict` is only for business conflicts that remain after the HTTP precondition has been satisfied.
- `PATCH` uses `application/merge-patch+json` by default. Support for `application/json-patch+json` must be declared explicitly in the Manifest.
- A retried POST MUST carry `Idempotency-Key`.
- An idempotency key must be bound to the principal, method, endpoint key, resource identity, protocol version, and canonical request digest; the same key with a different request MUST return `409 idempotency_key_reused`. JSON bodies use RFC 8785, queries use the canonical JSON of the decoded DTO, and media types are lowercased with ignorable whitespace removed. Servers must declare the minimum deduplication retention in the Manifest.
- Pagination uses an opaque `cursor`; drifting page numbers must not be the only mechanism.
- Error responses use `application/problem+json` with an added stable `code`.
- Any response whose content changes with authorization MUST use `Cache-Control: private, no-store` and `Vary: Authorization`. Only anonymous public representations may use shared caches.
- A response that uses media type or version content negotiation MUST correctly merge `Vary: Accept, Collection-Protocol-Version`, without overwriting an existing `Vary: Authorization` or `Origin`.

Example error:

```json
{
  "type": "https://know-n.com/colp/problems/revision-conflict",
  "title": "Revision conflict",
  "status": 409,
  "code": "revision_conflict",
  "detail": "The node changed after the supplied base revision.",
  "instance": "/collections/c1/nodes/n9",
  "currentRevision": "r_1042",
  "conflictId": "019b..."
}
```

<a id="colp-section-10"></a>

## 10. Visibility

Collection `visibility`:

- `public`: listed in the Collection directory and readable anonymously.
- `unlisted`: same access semantics as anonymously readable `public`, but not listed in the directory. It is not an authentication or secrecy mechanism.
- `protected`: requires an API key or OAuth token.
- `private`: only explicitly granted principals.

Nodes, Annotations, and Attachments may tighten visibility further, but must not loosen a parent's restriction. A Node without a declared `visibility` inherits it; the effective access is the intersection of the rules of the Collection, every ancestor Node, and the object itself.

A public projection MUST remove:

- `sourceRefs.nativeId`, `profileId`, and local paths.
- Private Annotations.
- Internal IDs of ACL principals.
- API keys, tokens, and any secret information beyond a key hint.
- Private versions of the content of Sync conflicts.
- Attachments and captured page bodies that were not explicitly made public.
- Extensions that a namespace allowlist has not explicitly marked as public-safe. Unknown extensions are kept only in authoritative and Sync storage and by default do not enter public, Feed, or assistant projections.

<a id="colp-section-11"></a>

## 11. Conformance Profiles

Implementations declare composable profiles per mount in the Manifest:

```json
{
  "profiles": [
    "core",
    "publication",
    "feed",
    "publisher",
    "sync",
    "mcp-read",
    "mcp-write"
  ]
}
```

Dependencies and minimum capabilities are listed in [`docs/00-practical-profile.md`](docs/00-practical-profile.md). If an implementation declares a profile, all required endpoints and semantics of that profile MUST pass the conformance tests. The legacy draft bundle names `reader`, `sync-server`, and `mcp-server` are no longer used in new Manifests.

Stable requirement IDs, implementing modules, and test evidence are recorded in [`requirements.yaml`](requirements.yaml). A profile claim must satisfy all of the following: the package-level required tests pass, the deployment has registered every endpoint, and the required ports (transactions, authorization, outbox, and so on) are available. A configuration boolean is not conformance evidence by itself.

<a id="colp-section-12"></a>

## 12. Version Negotiation

- The Manifest provides `protocolVersions`, ordered from newest to oldest.
- HTTP clients SHOULD send:

```http
Collection-Protocol-Version: 0.1
```

- When the header or `Accept` version of a read request is not supported, the server returns `406 unsupported_version`; when the `Content-Type` version of a write request is not supported, it returns `415 unsupported_media_type`. The response lists `supportedVersions`.
- Within one exact version, new data can be added only through HTTPS-namespaced `extensions`.
- New optional core fields, events, or capabilities require a new minor schema and version negotiation.
- Removing a field, changing a default meaning, or changing conflict rules requires a new major version.
- Clients must not execute unknown core fields or unknown operation types. They should reject them, negotiate a version, or keep the original representation and forward it transparently; they must not guess how to execute them.

<a id="colp-section-13"></a>

## 13. References

- BCP 14 / RFC 2119 / RFC 8174: requirement key words.
- RFC 3339: date and time.
- RFC 3986: URI.
- RFC 9110: HTTP semantics.
- RFC 8288: Web Linking.
- RFC 6902: JSON Patch.
- RFC 7396: JSON Merge Patch.
- RFC 7493: I-JSON.
- RFC 6570: URI Template.
- RFC 9457: Problem Details for HTTP APIs.
- RFC 9421: HTTP Message Signatures.
- RFC 9530: HTTP Content-Digest.
- RFC 9651: Structured Field Values for HTTP (used by the `RateLimit` header fields).
- RFC 8785: JSON Canonicalization Scheme (for canonical digests).
- OAuth 2.1, RFC 7591, RFC 8707, RFC 9207, RFC 9449, RFC 9728: authorization, dynamic client registration, resource indicators, issuer identification, sender constraints, and protected resource metadata.
- JSON Feed 1.1: optional public feed representation.
- CloudEvents 1.0: event envelope compatibility target.
- MCP Specification 2026-07-28: MCP Profile baseline (stateless, POST-only).

---

[All documents](README.md#documents) · [Glossary](GLOSSARY.md) · [00 Practical profile →](docs/00-practical-profile.md)
