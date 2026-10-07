# Glossary

[Protocol README](README.md) · [Specification](SPECIFICATION.md)

Short, plain-language definitions of the words the specification uses. The glossary is not normative: each entry links to the section that defines the term, and that section wins if the two ever seem to disagree.

[A](#ack) · [B](#bookmark) · [C](#change-plan) · [D](#directory) · [E](#endpoint-key) · [F](#feed) · [I](#idempotency-key) · [M](#manifest) · [N](#node) · [O](#operation) · [P](#position) · [R](#redacted-node) · [S](#scope) · [T](#tombstone) · [V](#visibility) · [W](#wire-id)

### Ack

The Sync step in which a replica tells the server which cursor it has durably applied. The server uses acks to spot replicas that fall behind and to decide when a tombstone can be purged. See [03 §9](docs/03-sync.md#colp-section-9).

### Alias

A Node of kind `alias` that points at another Node in the same Collection through `targetNodeId`. When a browser has no aliases, an adapter either turns it into a duplicate bookmark or refuses it. See [01 §3](docs/01-core-data-model.md#colp-section-3) and [06 §8](docs/06-browser-mapping.md#colp-section-8).

### Annotation

Content attached to a Collection or a Node: a note, summary, TL;DR, highlight, reading state, rating, or custom value. Every Annotation has its own visibility, and AI-written ones carry provenance. Annotations are [sidecars](#sidecar). See [01 §5](docs/01-core-data-model.md#colp-section-5).

### Attachment

Metadata about a file that belongs to a Collection or a Node, such as a favicon, a cover image, or an offline copy of a page. An Attachment is never published just because its Node is public. See [01 §6](docs/01-core-data-model.md#colp-section-6).

### Bookmark

A Node of kind `bookmark`. It always has a `url`, which keeps exactly what the user saved. See [01 §3](docs/01-core-data-model.md#colp-section-3).

### Change plan

The two-step flow for high-risk changes made through MCP, such as deleting a Collection or making it public. `changes.plan` describes the change and its impact, a person approves it outside the model, and `changes.commit` applies it only if nothing changed in the meantime. See [05 §12–13](docs/05-mcp-profile.md#colp-section-12).

### Collection

The unit of versioning, access, and distribution: one tree of Nodes under a single root, plus metadata, a visibility, a publication policy, and a revision. Its `kind` is `bookmarks`, `reading_path`, `knowledge_collection`, or `mixed`. See [Specification §4.1](SPECIFICATION.md#colp-section-4-1) and [01 §2](docs/01-core-data-model.md#colp-section-2).

### Conflict

A record the Sync server creates when an incoming operation cannot be merged on its own, for example when two devices renamed the same bookmark differently. Someone resolves it explicitly, and its content stays private. See [03 §10–11](docs/03-sync.md#colp-section-10).

### Cursor

An opaque position issued by the server. There are three kinds, and they are never interchangeable: `page.nextCursor` pages through one Snapshot, the Sync cursor tracks Sync progress, and a Feed cursor tracks a Feed. Clients store cursors and send them back, but never parse, compare, or increment them. See [Specification §3.1](SPECIFICATION.md#colp-section-3-1) and [§5.3](SPECIFICATION.md#colp-section-5-3).

### Directory

The list of `public` Collections on a mount, served at the `directory` endpoint. `unlisted` Collections never appear in it. See [02 §3](docs/02-http-publication-feed.md#colp-section-3).

### Endpoint key

The name of an endpoint in a mount's `endpoints` map, such as `directory`, `snapshot`, or `nodeMove`. Each key has a fixed set of URI Template variables and named request and response schemas. See [02 §2](docs/02-http-publication-feed.md#colp-section-2) and [10 §3](docs/10-implementation-contract.md#colp-section-3).

### ETag

The HTTP validator of one exact response: the same Collection gets different ETags for different pages, queries, projections, and media types. Clients send it back in `If-None-Match` to get a cheap `304 Not Modified`, and in `If-Match` to write without overwriting someone else's change. See [Specification §9](SPECIFICATION.md#colp-section-9) and [02 §5.2](docs/02-http-publication-feed.md#colp-section-5-2).

### Extension

Data outside the core model, stored in `extensions` under an HTTPS namespace key such as `https://example.com/ns/repository-metadata/v1`. Servers keep extensions they do not understand, and publish them only when an allowlist says they are safe. See [Specification §4.4](SPECIFICATION.md#colp-section-4-4).

### Feed

A public stream of changes to one Collection or to a whole instance, for followers, feed readers, and aggregators. It can also be served as JSON Feed 1.1 or Atom. In `live` mode individual edits are published, in `release` mode only [Releases](#release) are, and `disabled` turns the Feed off. A Feed is not a Sync log. See [02 §6–10](docs/02-http-publication-feed.md#colp-section-6).

### Folder role

The `folderRole` that marks a special browser folder, such as `bookmarks-bar`, `other-bookmarks`, or the read-only `managed-bookmarks`. See [01 §3.3](docs/01-core-data-model.md#colp-section-3-3) and [06 §6](docs/06-browser-mapping.md#colp-section-6).

### Idempotency key

The `Idempotency-Key` header on a POST that may be retried. A retry with the same key and the same request returns the first result instead of running twice; the same key with a different request fails with `409 idempotency_key_reused`. See [Specification §9](SPECIFICATION.md#colp-section-9) and [08 §12](docs/08-write-api.md#colp-section-12).

### Manifest

The JSON document at `/.well-known/collection-protocol` that describes a server: its `serverUuid`, its protocol versions, and its mounts. Every client starts here, and follows the URLs it lists instead of guessing paths. See [Specification §7](SPECIFICATION.md#colp-section-7) and [02 §2](docs/02-http-publication-feed.md#colp-section-2).

### MCP

The Model Context Protocol, which AI assistants use to call tools and read resources. The `mcp-read` and `mcp-write` profiles map COLP onto it, with the same permissions as the HTTP API. See [05](docs/05-mcp-profile.md).

### Mount

One protocol surface listed in a Manifest, with its own `baseUrl`, `profiles`, `endpoints`, `features`, `auth`, and `limits`. A server can expose several mounts. See [02 §2](docs/02-http-publication-feed.md#colp-section-2).

### Node

One item in a Collection's tree. Its `kind` is `root`, `folder`, `bookmark`, `separator`, or `alias`, and `parentId` plus `position` place it in the tree. See [01 §3](docs/01-core-data-model.md#colp-section-3).

### Operation

One change a Sync replica sends to the server, such as `create_node` or `move_node`. It carries an `opId`, the `replicaId`, a [sequence](#sequence) number, and the `baseRevision` it was made against, so the server can apply it, rebase it, or record a conflict. See [03 §6](docs/03-sync.md#colp-section-6).

### Position

The opaque ASCII sort key that orders siblings under one parent, compared byte by byte. Servers assign positions; clients ask for a place with `afterId` and `beforeId`. See [01 §3.2](docs/01-core-data-model.md#colp-section-3-2).

### Principal

Whoever makes a request: a `user`, `group`, `oauth_client`, `api_key`, `service`, or `ai_agent`, or the anonymous `public` principal the server uses when no credential was presented. See [04 §2](docs/04-auth-security-rate-limit.md#colp-section-2).

### Problem

An error response in the RFC 9457 `application/problem+json` format, with a stable `code` such as `precondition_failed`. Clients decide what to do from `status` and `code`, never from the human-readable text. See [09](docs/09-problem-registry.md).

### Profile

A named, testable set of capabilities that a mount can claim: `core`, `publication`, `feed`, `publisher`, `sync`, `mcp-read`, and `mcp-write`. A mount declares only the profiles it fully passes. See [00 §3](docs/00-practical-profile.md#colp-section-3) and [Specification §11](SPECIFICATION.md#colp-section-11).

### Projection

A view of a Collection prepared for one audience. A Snapshot with `mode=publication` has been redacted for publishing, with no source references, tombstones, or private data, even when an authorized reader asks for it. A Snapshot with `mode=sync` is the authorized view for trusted replicas. See [00 §6](docs/00-practical-profile.md#colp-section-6) and [10 §7](docs/10-implementation-contract.md#colp-section-7).

### Pull

The Sync step in which a replica fetches the operations committed after its cursor. See [03 §8](docs/03-sync.md#colp-section-8).

### Push

The Sync step in which a replica sends a batch of its local operations. Retrying a push never applies an operation twice. See [03 §7](docs/03-sync.md#colp-section-7).

### Redacted node

A placeholder in a publication projection, marked `redacted: true`, that shows that a restricted bookmark exists while leaving out its URL. See [01 §3.1](docs/01-core-data-model.md#colp-section-3-1).

### Relation

A typed link between two Nodes, such as `related`, `precedes`, or `contradicts`. Relations never change the tree. See [01 §7](docs/01-core-data-model.md#colp-section-7).

### Release

An immutable, published version of a Collection with its own permanent Snapshot URL. When a Collection's Feed runs in `release` mode, followers see only Releases, not every small edit. See [08 §11](docs/08-write-api.md#colp-section-11) and [02 §7.2](docs/02-http-publication-feed.md#colp-section-7-2).

### Replica

One independent copy that syncs with the server, such as a browser profile or a desktop app, identified by a stable `replicaId`. A replica is `active`, `expired`, `recovery_required`, or `retired`. See [03 §2](docs/03-sync.md#colp-section-2) and [03 §9](docs/03-sync.md#colp-section-9).

### Requirement ID

A stable identifier such as `CORE-0001` for one normative statement. The registries in [`requirements.yaml`](requirements.yaml) and [`requirements-0.2.yaml`](requirements-0.2.yaml) record each statement's source section and the tests that prove it.

### Revision

An opaque version string the server generates for a Collection or an object. Writes and Sync operations name the revision they were based on, which is how lost updates are detected. See [Specification §5.3](SPECIFICATION.md#colp-section-5-3).

### Root

The single Node of kind `root` at the top of every Collection. It is created together with its Collection, and no later write can give it a parent or add a second one. See [01 §11](docs/01-core-data-model.md#colp-section-11).

### Scope

A permission carried by a token or an API key, such as `nodes:read` or `sync:push`. Read scopes are narrow: `nodes:read` does not include `annotations:read`. See [04 §3](docs/04-auth-security-rate-limit.md#colp-section-3).

### Separator

A Node of kind `separator`, a visual divider between bookmarks. See [06 §9](docs/06-browser-mapping.md#colp-section-9).

### Sequence

The per-replica counter on every Sync Operation. `(replicaId, sequenceScope, sequence)` must be contiguous and is never reused, which is what makes a retried push safe. See [03 §6.1](docs/03-sync.md#colp-section-6-1).

### Session

The context a Sync replica negotiates before it pushes or pulls, normally bound to one Collection, one principal, and one credential. A session ID is not a credential. See [03 §4](docs/03-sync.md#colp-section-4).

### Sidecar

Data that lives next to the tree instead of inside a Node: Annotations, Attachments, and Relations. A Snapshot keeps exactly one copy of each, in its top-level arrays. See [01 §5–7](docs/01-core-data-model.md#colp-section-5).

### Snapshot

The complete state of one Collection at one revision: the Collection, a flat `nodes` array, and the top-level `annotations`, `attachments`, `relations`, and (for Sync) `tombstones` arrays. A large Snapshot is split into pages, and a client replaces its local copy only after it has every page. See [Specification §3.1](SPECIFICATION.md#colp-section-3-1) and [01 §9](docs/01-core-data-model.md#colp-section-9).

### Source reference

The private link between a protocol Node and a browser's own bookmark record (`sourceRefs`), used for round trips and to stop sync loops. It never appears in public data. See [01 §4](docs/01-core-data-model.md#colp-section-4).

### Tombstone

The record a deletion leaves behind in Sync, so that an old replica cannot bring the object back. A tombstone is purged only after its retention period has passed and every active replica has acknowledged the delete. See [01 §8](docs/01-core-data-model.md#colp-section-8) and [03 §9](docs/03-sync.md#colp-section-9).

### Visibility

Who may read something. A Collection is `public` (listed and readable anonymously), `unlisted` (readable anonymously but never listed), `protected` (needs an API key or OAuth token), or `private` (only principals granted access). Nodes, Annotations, and Attachments can tighten what they inherit but never loosen it. See [Specification §10](SPECIFICATION.md#colp-section-10).

### Wire ID

The opaque identifier of an object: 1 to 128 URI-unreserved ASCII characters. Clients must not read times, owners, or URLs into it. Across servers, an object is identified by `(serverUuid, resourceType, id)`. See [Specification §5.1](SPECIFICATION.md#colp-section-5-1).
