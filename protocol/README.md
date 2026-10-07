# The Collection Protocol

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

The Collection Protocol (COLP) is an open, HTTP-native protocol for bookmarks and curated knowledge collections. It describes how to publish a collection the way you publish a blog, how to sync bookmark trees between browsers and servers, and how to let AI assistants help without giving them more access than you meant to.

This folder is the specification. The prose in [`SPECIFICATION.md`](SPECIFICATION.md) and [`docs/`](docs) is normative. The [JSON Schemas](schemas), [examples](examples), and [requirement registries](requirements.yaml) are its machine-readable half, and CI keeps all of them in agreement. The reference implementation is [`@know-n/colp`](../packages/node).

**New to COLP?** Take the [five-minute tour](#colp-in-five-minutes), then follow the [reading path](#where-to-start) for what you are building. Unfamiliar words are explained in the [glossary](GLOSSARY.md).

## Contents

- [COLP in five minutes](#colp-in-five-minutes)
- [Where to start](#where-to-start)
- [Documents](#documents)
- [Schemas, examples, and requirements](#schemas-examples-and-requirements)
- [Design principles](#design-principles)
- [Status](#status)
- [Naming](#naming)

## COLP in five minutes

**1. Everything starts at the Manifest.** A server publishes one JSON document at `/.well-known/collection-protocol`. It lists one or more *mounts*, and each mount says which [profiles](#profiles) it supports and gives the URL of every endpoint. Clients follow those URLs, and the links inside responses, instead of building paths themselves.

```text
GET /.well-known/collection-protocol     → the Manifest
  mounts[0].endpoints.directory          → the list of Collections
    collections[0].links.snapshot        → one Collection, the whole tree
```

**2. A Collection is a tree with sidecars.** Every Collection has one root Node. Under it are folders, bookmarks, separators, and aliases, ordered by an opaque `position`, so the tree maps one-to-one onto a browser's bookmarks. Notes, summaries, files, and links between bookmarks sit next to the tree as Annotations, Attachments, and Relations.

**3. A Snapshot is a whole Collection at one revision.** Nodes arrive as a flat array with `parentId` and `position`, and each kind of sidecar has its own top-level array. A large Snapshot is split into pages, and a client swaps in the new state only after it has every page.

**4. Reading is plain, cache-friendly HTTP.** Every response carries an `ETag`, so a client that already has the data gets a cheap `304 Not Modified`. Errors are Problem Details with a stable `code` that programs can act on. A Feed tells followers what changed, and can also be offered as JSON Feed or Atom.

**5. Writing uses HTTP preconditions.** To change a resource, a client sends the `If-Match` ETag it last saw; if someone else changed the resource first, the server answers `412` instead of silently overwriting their work. Retryable POSTs carry an `Idempotency-Key`, so a retry never creates a duplicate.

**6. Sync exchanges operations, not trees.** Each device is a *replica*. It opens a session, pushes numbered operations such as "move node 9 after node 7", pulls the operations other replicas committed, and acknowledges what it applied. The server applies each operation, rebases it, or records an explicit conflict. Deletes leave tombstones so that an old device cannot bring a bookmark back.

**7. AI follows the same rules, through MCP.** Collections are MCP resources and changes are MCP tools, checked with the same scopes as the HTTP API. Anything high-risk, such as deleting a Collection or making it public, goes through plan, human approval, and commit.

**8. Private by default.** Syncing to a server is not publishing. A Collection is `public`, `unlisted`, `protected`, or `private`, and public projections strip source references, private notes, and anything not explicitly made public.

### Profiles

COLP is split into composable profiles. A mount declares only the profiles it fully passes, and a first server needs nothing beyond `core + publication`.

| Profile | Adds | Depends on | Chapter |
|---|---|---|---|
| `core` | Objects, strict schema, semantic checks, complete Snapshot | — | [01](docs/01-core-data-model.md) |
| `publication` | Discovery, directory, metadata, Snapshot, links, ETags, Problem Details | `core` | [02](docs/02-http-publication-feed.md) |
| `feed` | Public change stream with cursors, caching, and redaction | `publication` | [02](docs/02-http-publication-feed.md#colp-section-6) |
| `publisher` | Conditional, idempotent writes for every resource, and Releases | `publication` | [08](docs/08-write-api.md) |
| `sync` | Sessions, push, pull, ack, conflicts, and tombstones for one Collection | `core` | [03](docs/03-sync.md) |
| `mcp-read` | Read-only MCP resources and tools | `core` | [05](docs/05-mcp-profile.md) |
| `mcp-write` | MCP write tools, scopes, audit, and plan / commit for risky changes | `mcp-read`, `publisher` | [05](docs/05-mcp-profile.md#colp-section-11) |

Bundle names from earlier drafts, such as `reader`, `sync-server`, and `mcp-server`, are no longer used in new Manifests.

### What a deployment looks like

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

`c/` and `-/` are reserved route segments, so opaque Collection IDs cannot collide with `feed`, `sync`, `admin`, or `mcp`. This layout is only a recommendation: the real paths are whatever the Manifest's `endpoints` say, so clients must not hard-code it. A deployment can start with public reading and add Feed, writes, Sync, and MCP one at a time.

## Where to start

| If you want to… | Read, in this order |
|---|---|
| Understand the big picture | This page, then [SPECIFICATION §1–4](SPECIFICATION.md) and the [glossary](GLOSSARY.md) |
| Publish collections read-only, the smallest useful server | [00](docs/00-practical-profile.md), [01](docs/01-core-data-model.md), [02 §1–5](docs/02-http-publication-feed.md), [09](docs/09-problem-registry.md) |
| Read collections from an app or a script | [00 §4–7](docs/00-practical-profile.md#colp-section-4), [02 §2–5](docs/02-http-publication-feed.md#colp-section-2), [10 §6](docs/10-implementation-contract.md#colp-section-6), [09](docs/09-problem-registry.md) |
| Publish a feed of changes | [02 §6–11](docs/02-http-publication-feed.md#colp-section-6) |
| Accept writes from apps | [08](docs/08-write-api.md), [04](docs/04-auth-security-rate-limit.md), [09](docs/09-problem-registry.md) |
| Sync browser bookmarks | [03](docs/03-sync.md), [06](docs/06-browser-mapping.md), [04](docs/04-auth-security-rate-limit.md) |
| Let AI assistants manage collections | [05](docs/05-mcp-profile.md), [04](docs/04-auth-security-rate-limit.md) |
| Write an implementation in another language | [00](docs/00-practical-profile.md), [10](docs/10-implementation-contract.md), then the [schemas](schemas) and [examples](examples), and test it with [`colp-conformance`](../packages/conformance) |

Using TypeScript or Node.js? The reference package already implements every profile; start with its [README](../packages/node/README.md).

## Documents

| # | Document | What it covers | Profiles |
|---|---|---|---|
| | [Specification overview](SPECIFICATION.md) | Scope, the three kinds of data, IDs and versions, URLs, discovery, the endpoint table, HTTP rules, visibility, and versioning | all |
| 00 | [Practical profile](docs/00-practical-profile.md) | What to build first, how profiles depend on each other, and the minimal interoperable server and client | all |
| 01 | [Core data model](docs/01-core-data-model.md) | Collection, Node, Annotation, Attachment, Relation, tombstones, Snapshot, and validation rules | `core` |
| 02 | [HTTP, publication, and feed](docs/02-http-publication-feed.md) | Manifest, directory, metadata, Snapshot paging and caching, Feeds, JSON Feed, Atom, and static hosting | `publication`, `feed` |
| 03 | [Sync](docs/03-sync.md) | Replicas, sessions, bootstrap, push, pull, ack, conflicts, moves, deletes, and offline queues | `sync` |
| 04 | [Auth, security, and rate limits](docs/04-auth-security-rate-limit.md) | Principals, scopes, API keys, OAuth 2.1, access policy, rate limits, audit, and the threat matrix | all |
| 05 | [MCP profile](docs/05-mcp-profile.md) | MCP transport, resources, tools, change plans, and the rules that keep AI within its grant | `mcp-read`, `mcp-write` |
| 06 | [Browser mapping](docs/06-browser-mapping.md) | Field mappings for Chromium, Firefox, Netscape bookmark HTML, and Safari, and how lossy conversions are reported | `sync` |
| 07 | [NestJS integration](docs/07-nestjs-integration.md) | An illustrative way to embed COLP in an existing NestJS application | — |
| 08 | [Write API](docs/08-write-api.md) | Publisher HTTP requests and responses, status codes, Releases, and idempotent replay | `publisher` |
| 09 | [Problem registry](docs/09-problem-registry.md) | Every error `code`, its HTTP status, and how a client should recover | all |
| 10 | [Implementation contract](docs/10-implementation-contract.md) | Which schema validates each endpoint, the Snapshot assembly algorithm, and the shape of the Node package | all |
| | [Glossary](GLOSSARY.md) | Plain-language definitions of the terms used everywhere else | — |

Each chapter opens with a short summary and ends with links to the previous and next chapters.

## Schemas, examples, and requirements

| File | What it is |
|---|---|
| [`schemas/collection-protocol.schema.json`](schemas/collection-protocol.schema.json) | JSON Schema (Draft 2020-12) for every 0.1 wire document, each under a stable `$defs` name |
| [`schemas/collection-protocol-0.2.schema.json`](schemas/collection-protocol-0.2.schema.json) | The 0.2 additions: authoritative pull effects for Sync |
| [`requirements.yaml`](requirements.yaml), [`requirements-0.2.yaml`](requirements-0.2.yaml) | One record per normative statement: a stable ID, its level, profile, and source section, the implementing modules, and the tests that prove it |
| [`examples/`](examples) | 28 example documents, each checked against its `$defs` contract in CI |
| [`scripts/validate_examples.py`](scripts/validate_examples.py) | Runs the structural and semantic checks over every example |

| Area | Examples |
|---|---|
| Discovery and reading | [public-manifest](examples/public-manifest.json), [collection-directory](examples/collection-directory.json), [collection-metadata](examples/collection-metadata.json), [collection-snapshot](examples/collection-snapshot.json), [protected-publication-snapshot](examples/protected-publication-snapshot.json), [node-detail](examples/node-detail.json), [local-bookmark-node](examples/local-bookmark-node.json), [global-resource-identity](examples/global-resource-identity.json) |
| Publisher writes | [publisher-collection-create](examples/publisher-collection-create.json), [publisher-collection-create-result](examples/publisher-collection-create-result.json), [publisher-annotation-create](examples/publisher-annotation-create.json), [publisher-node-move](examples/publisher-node-move.json) |
| Releases and Feed | [release-directory](examples/release-directory.json), [release-result](examples/release-result.json), [public-feed](examples/public-feed.json) |
| Sync | [sync-session-request](examples/sync-session-request.json), [sync-session-result](examples/sync-session-result.json), [sync-snapshot](examples/sync-snapshot.json), [sync-push](examples/sync-push.json), [sync-push-result](examples/sync-push-result.json), [sync-pull](examples/sync-pull.json), [sync-pull-v02](examples/sync-pull-v02.json), [sync-update-operation](examples/sync-update-operation.json) |
| Security and MCP | [access-policy](examples/access-policy.json), [change-plan-request](examples/change-plan-request.json), [change-plan](examples/change-plan.json), [mcp-tools-list](examples/mcp-tools-list.json), [problem](examples/problem.json) |

To run the validator yourself (Python 3):

```bash
python -m venv .venv && . .venv/bin/activate
python -m pip install -r requirements-dev.txt
python scripts/validate_examples.py
```

## Design principles

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

## Status

| | |
|---|---|
| Specification version | `0.1-draft`, plus the `0.2` authoritative pull effects |
| Document date | 2026-07-16 |
| MCP baseline | `2026-07-28` (stateless, POST-only) |
| JSON Schema | Draft 2020-12 |
| Compatibility targets | Chromium Bookmarks API, Firefox WebExtensions Bookmarks API, Netscape Bookmark HTML, and Safari bookmark data read through an adapter |
| Wire contract | 0.1 is closed: every core DTO referenced by Publication, Publisher, Feed, Sync, security administration, and MCP has a stable `$defs` name |
| Reference implementation | [`../packages/node`](../packages/node) (`@know-n/colp`), with requirement-to-test traceability in [`TRACEABILITY.md`](../packages/node/docs/TRACEABILITY.md) |

While the specification is a draft, inconsistencies between the prose and the schema are fixed as bugs; see [Specification §1](SPECIFICATION.md#colp-section-1) for what that means for compatibility.

## Naming

Avoid the abbreviation `TCP`, which collides with the Transmission Control Protocol. Use:

- Human name: `Collection Protocol`
- Technical abbreviation: `COLP`
- URL / package identifier: `collection-protocol`
- API key prefix: `colp_`
