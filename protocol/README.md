# The Collection Protocol

[English](README.md) | [简体中文](README.zh-CN.md)

The Collection Protocol (COLP) is an open draft protocol for bookmarks, public knowledge collections, and AI-managed curation tools.

Goals:

1. Standardize browser bookmarks and knowledge collections: hierarchy, order, metadata, and attached information.
2. Standardize two-way sync between browsers, clients, personal servers, and hosted services.
3. Provide public distribution comparable to RSS, Atom, and JSON Feed.
4. Support public and unlisted links, key-based access, OAuth, permissions, rate limits, signatures, and audit.
5. Map natively to MCP resources and tools, so AI can manage collections and their sharing policy under the user's control.

## Status

| | |
|---|---|
| Specification version | `0.1-draft`, plus the `0.2` authoritative pull effects |
| Document date | 2026-07-16 |
| MCP baseline | `2026-07-28` (stateless, POST-only) |
| JSON Schema | Draft 2020-12 |
| Compatibility targets | Chromium Bookmarks API, Firefox WebExtensions Bookmarks API, Netscape Bookmark HTML, and Safari bookmark data read through an adapter |
| Wire contract | 0.1 is closed: every core DTO referenced by Publication, Publisher, Feed, Sync, security administration, and MCP has a stable `$defs` name |
| Reference implementation | [`../packages/node`](../packages/node) (`@collection-protocol/node`), with requirement-to-test traceability in [`TRACEABILITY.md`](../packages/node/docs/TRACEABILITY.md) |

The repository provides the schemas, 28 executable examples, a machine-readable requirement registry, semantic checks, and negative assertions.

Avoid the abbreviation `TCP`, which collides with the Transmission Control Protocol. Use:

- Human name: `Collection Protocol`
- Technical abbreviation: `COLP`
- URL / package identifier: `collection-protocol`
- API key prefix: `colp_`

## Documents

| Document | Contents |
|---|---|
| [SPECIFICATION.md](SPECIFICATION.md) | Overall architecture, versioning, objects, and the endpoint table |
| [00 Practical profile](docs/00-practical-profile.md) | The minimum interoperable surface to implement first, profile dependencies, and compatibility boundaries |
| [01 Core data model](docs/01-core-data-model.md) | Core data model and extension mechanism |
| [02 HTTP, publication, and feed](docs/02-http-publication-feed.md) | Discovery, HTTP API, public Feed, and caching |
| [03 Sync](docs/03-sync.md) | Replicas, operation log, cursors, conflicts, and conversion semantics |
| [04 Auth, security, and rate limits](docs/04-auth-security-rate-limit.md) | Keys, OAuth, ACLs, rate limits, signatures, and audit |
| [05 MCP profile](docs/05-mcp-profile.md) | MCP resources, tools, and confirmation of high-risk operations |
| [06 Browser mapping](docs/06-browser-mapping.md) | Browser bookmark field mapping and lossy conversion |
| [07 NestJS integration](docs/07-nestjs-integration.md) | An illustrative NestJS module shape and deployment advice |
| [08 Write API](docs/08-write-api.md) | Publisher HTTP write requests, responses, status codes, and idempotency |
| [09 Problem registry](docs/09-problem-registry.md) | Stable error codes, HTTP statuses, and client recovery actions |
| [10 Implementation contract](docs/10-implementation-contract.md) | Machine contract index, pagination assembly, and the Node package guide |

Machine-readable contracts:

- [schemas/collection-protocol.schema.json](schemas/collection-protocol.schema.json): the 0.1 core JSON Schema.
- [schemas/collection-protocol-0.2.schema.json](schemas/collection-protocol-0.2.schema.json): the 0.2 authoritative pull effect additions.
- [requirements.yaml](requirements.yaml) and [requirements-0.2.yaml](requirements-0.2.yaml): stable requirement IDs, profiles, implementing modules, and test IDs.

## Examples

Every file in [`examples/`](examples) is validated against a named `$defs` contract by `scripts/validate_examples.py`.

| Area | Examples |
|---|---|
| Discovery and reading | [public-manifest](examples/public-manifest.json), [collection-directory](examples/collection-directory.json), [collection-metadata](examples/collection-metadata.json), [collection-snapshot](examples/collection-snapshot.json), [protected-publication-snapshot](examples/protected-publication-snapshot.json), [node-detail](examples/node-detail.json), [local-bookmark-node](examples/local-bookmark-node.json), [global-resource-identity](examples/global-resource-identity.json) |
| Publisher writes | [publisher-collection-create](examples/publisher-collection-create.json), [publisher-collection-create-result](examples/publisher-collection-create-result.json), [publisher-annotation-create](examples/publisher-annotation-create.json), [publisher-node-move](examples/publisher-node-move.json) |
| Releases and Feed | [release-directory](examples/release-directory.json), [release-result](examples/release-result.json), [public-feed](examples/public-feed.json) |
| Sync | [sync-session-request](examples/sync-session-request.json), [sync-session-result](examples/sync-session-result.json), [sync-snapshot](examples/sync-snapshot.json), [sync-push](examples/sync-push.json), [sync-push-result](examples/sync-push-result.json), [sync-pull](examples/sync-pull.json), [sync-pull-v02](examples/sync-pull-v02.json), [sync-update-operation](examples/sync-update-operation.json) |
| Security and MCP | [access-policy](examples/access-policy.json), [change-plan-request](examples/change-plan-request.json), [change-plan](examples/change-plan.json), [mcp-tools-list](examples/mcp-tools-list.json), [problem](examples/problem.json) |

Run the validator:

```bash
python -m venv .venv && . .venv/bin/activate
python -m pip install -r requirements-dev.txt
python scripts/validate_examples.py
```

## Where to Start

A first interoperable implementation only needs `core + publication`:

1. Declare absolute endpoints or URI Templates in the Manifest; clients must not guess paths. A Manifest that declares a profile must declare every endpoint that profile requires.
2. Serve the Collection Directory, Collection Metadata, and a complete single-page Snapshot.
3. Return an independent `ETag` for every actual HTTP representation, and report errors with Problem Details that validate.
4. Validate structure with the core schema, then run semantic checks for the tree, references, uniqueness, and visibility.

Feed, writes, Sync, and MCP are composable profiles, not prerequisites of a first implementation. See [00 Practical profile](docs/00-practical-profile.md) for the recommended order, and [10 Implementation contract](docs/10-implementation-contract.md) for the machine contract index and the Node package delivery order.

## Design Principles

- **Browser first.** The core model must express a real browser bookmark tree without loss.
- **Extend without polluting.** What browsers cannot express goes into standard sidecar fields or namespaced extensions.
- **Private by default.** Syncing to a server is not publishing to the internet.
- **Feed is not Sync.** A Feed is a public projection; Sync is a consistency protocol between trusted replicas.
- **Offline first.** Every write can enter a local queue and replay idempotently when the network returns.
- **No silent loss.** Every lossy conversion returns a machine-readable warning.
- **Least privilege.** Tokens, keys, and AI grants are limited by scope, object, and lifetime.
- **AI can act, but not beyond its grant.** MCP reuses the same permission model; high-risk operations use a preview and two-phase confirmation.
- **HTTP native.** Caching, ETags, conditional requests, status codes, and Problem Details are part of the protocol.
- **Independently deployable.** A personal blog, a web app, or static hosting can implement only the profiles it needs.

## Composable Conformance Profiles

| Profile | Must implement |
|---|---|
| `core` | Core objects, strict schema, semantic checks, complete Snapshot |
| `publication` | Discovery, Directory, Metadata, Snapshot, links, ETag, Problem Details |
| `feed` | Public event stream, cursors, caching, and redaction; depends on `publication` |
| `publisher` | Writes for Collection, Node, Annotation, Attachment, Relation, and Release, with conditional requests and idempotency; depends on `publication` |
| `sync` | Single-Collection session, Push, Pull, Ack, Conflict, Tombstone; depends on `core` |
| `mcp-read` | Read-only resources / tools; depends on `core` |
| `mcp-write` | Write tools, scopes, audit, and high-risk plan / commit; depends on `mcp-read` + `publisher` |

An implementation declares only the profiles it fully passes. Bundle names from earlier drafts, such as `reader`, `sync-server`, and `mcp-server`, are no longer used in new Manifests.

## Example Deployment

```text
https://alice.example/
├── .well-known/collection-protocol
└── collections/
    ├──                       GET Collection list
    ├── c/{collectionId}      GET Collection metadata
    ├── c/{collectionId}/snapshot
    ├── c/{collectionId}/feed
    └── -/
        ├── feed              GET instance public change stream
        ├── sync/*            two-way sync
        ├── admin/*           keys, permissions, rate limits, and audit
        └── mcp               MCP Streamable HTTP endpoint
```

`c/` and `-/` are reserved route segments, so opaque Collection IDs cannot collide with `feed`, `sync`, `admin`, or `mcp`. The real paths are still declared by the Manifest's `endpoints`; clients must not hard-code the layout above.

A deployment can implement only public reading, then add Feed, writes, Sync, and MCP step by step. Nothing requires implementing everything at once.
