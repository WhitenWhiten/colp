# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The specification and the Node.js package are versioned separately; npm releases are recorded below while the specification remains a draft.

## [Unreleased]

## [0.1.1] - 2026-10-07

A security patch release. It hardens the trust boundaries that untrusted input reaches first — anonymous Publication reads, MCP subscription and Change Plan admission, Feed and Sync parsing, and the conformance runner's network access — closing authorization, resource-exhaustion, SSRF, and secret-handling findings from parallel security reviews. There are no specification changes.

### Node.js package

- Added `assertAnonymousPublicationPrimaryVisibility` (`server`), an anonymous-public primary-resource guard that runs after public projection and before schema validation, ETag generation, caching, and serialization. It fails closed on restricted Nodes, Collections, Directory entries, and Relations; on Snapshot ancestry inherited through a restricted or unknown ancestor; on restricted sidecars, cycles, and duplicate IDs; and on Annotation or Attachment subjects that point at an unknown Collection. Anonymous visibility checks for Snapshot, Directory, Feed, and Node resources now fail closed by default, including direct-builder and unlisted-publication paths.
- Authorized Publication HTTP reads are routed through the authorized projection instead of the anonymous path.
- The public-projection budget now meters discarded input as well as retained output — sparse-array holes, redacted fields, filtered annotations and attachments, unallowlisted extensions, and unsupported credential containers — and attachments on arbitrary object carriers, `sourceRefs`, and nested carriers are filtered out before they can reach an anonymous response.
- Directory, discovery, and snapshot-cursor paths pre-reserve UTF-8 byte budgets before cloning candidates, share check state across a request, and bind cursors to their Collection, Mount, and resource identities.
- Feed and Feed-query decoding caps parameters, repeated values, diagnostics, bytes, sparse arrays, accessors, and Proxies, and snapshots queries through native `URLSearchParams` methods; Snapshot pagination `Link` headers are bounded before parsing.
- MCP `subscriptions/listen` applies per-principal and per-client admission buckets plus an idle timeout on top of the existing lifetime, queue, rate, notification, and authorization bounds (`DEFAULT_MCP_LISTEN_MAX_CONCURRENT_SESSIONS`). The result and acknowledgement are built before subscribing, and request IDs are capped at 16,384 characters so oversized IDs cannot leave listeners or timers alive.
- MCP Change Plan admission now runs before validation, assessment, or store work, behind an aggregate concurrent-plan cap (`MCP_CHANGE_PLAN_DEFAULT_MAX_CONCURRENT_PLANS`) and an optional host `allowPlan` decision that falls back to the existing explicit rate port.
- MCP output scanning recognizes the native `colp_live_` and `colp_test_` API-key markers.
- Sync Sequence verifies replica ownership and enforces Push continuity with the new `PushSequenceBlockedError`, `PushSequenceGapError`, and `PushSequenceStateUnavailableError`, with durable lane state behind the `PushSequenceLaneStore`/`PushSequenceLaneState` ports. The Push lane cursor advances monotonically and accepts legal reverse-continuous atomic batches without rolling back.
- `coordinateTombstonePurge` accepts a `TombstonePurgeReadBudget` capped by `TOMBSTONE_PURGE_MAX_DELETED_MEMBERS` and `TOMBSTONE_PURGE_MAX_REPLICA_STATES`, and Pull operation/tombstone limits and atomic batch handling are enforced.
- Typed-update merge bounds equality, cloning, and graph traversal and rejects Proxies, accessors, Symbols, sparse arrays, subclasses, excessive depth/node/member/byte counts, and cycles; authoritative member strings and aggregate digest bytes are bounded before encoding or hashing.
- `ColpClient` now connects to the DNS-approved address instead of only checking answers: the default Node transport is a `pinnedFetch` (`PinnedNodeFetch`), and `resolveHost` (`ClientHostResolver`) must be paired with a transport that enforces address pinning — passing a plain custom `fetch` together with `resolveHost` is rejected. The private/local address policy additionally covers IPv6 special addresses and IPv4-compatible and NAT64 forms.
- Schema validation counts primitive strings inside arrays toward the structured-validation byte budget, and schema, publisher, and Node-write graph traversals are bounded with Proxy/accessor-safe structured-data walks (depth, node, member, UTF-8 byte, and cycle accounting).
- The MCP OAuth client fixes loopback/redirect handling and log injection, and the mutable-integrity verifier binds the target URI. Publisher normalization is bounded.

### Conformance runner

- Redirect handling charges each hop before DNS, applies one per-hop timeout signal to both DNS and transport, and consumes late resolver completion without starting a fetch after timeout.
- The runner rejects invalid `maxRequests`/`maxRedirects`, refuses HTTPS downgrades, and validates offline consumers.

### Repository

- The protocol example validator's Python dependencies are pinned and installed binary-only, with `pip check` enforced in CI.
- The clean-tarball consumer sandbox enforces network isolation, records cache provenance, and bounds publisher normalization.
- The large-prefix Sync regression test is allowed to finish under coverage.

## [0.1.0] - 2026-10-07

### Specification

- Moved canonical protocol, Schema, Problem, relation, and extension URIs to `https://know-n.com/colp/`; Feed event types use `com.know-n.colp.*`. This replaces the draft namespace and changes wire identifiers.

- The whole specification (`SPECIFICATION.md` and `docs/00`–`10`) is now in English. Normative keywords follow BCP 14 (RFC 2119 and RFC 8174), and every numbered section has a stable `colp-section-N` anchor.
- Aligned the prose with the schema and the reference implementation:
  - The MCP endpoint is stateless and POST-only; GET and DELETE are rejected.
  - The Manifest example declares `features.mcp.protocolVersion: "2026-07-28"`.
  - Tombstone retention is advertised as `tombstoneRetentionSeconds` in the Sync session result, and purge eligibility is driven by `purgeAfter`.
  - Effect page references document `firstPageDigest`.
  - The browser mapping lists the `lossy_conversion` warning code.
  - MCP risk levels and the high-risk tool list match the implementation, including `release.publish`, and servers advertise only the resource templates they implement.
  - Snapshot import is not part of 0.1, so the write API no longer refers to a `snapshotImport` endpoint key.
  - The NestJS guide is marked as illustrative and uses the real package subpaths.
  - The implementation contract lists the package's actual export subpaths.
- Removed product-specific notes that came from the project COLP was extracted from.
- The example validator now also validates the COLP 0.2 example (`sync-pull-v02.json`) against the 0.2 schema.
- Requirement records carry only `id`, `level`, `profile`, `source`, `requirement`, `implementation`, and `tests`; all requirement texts are in English.
- Made the specification easier to read without changing any requirement: a [glossary](protocol/GLOSSARY.md); a rewritten protocol README (English and Chinese) with a five-minute tour, a profile table, and a reading guide by role; an "In short" box and previous/next links on every chapter; links in place of bare file names; and prose that is no longer hard-wrapped.

### Node.js package

- Published the initial `0.1.0` npm release as `@know-n/colp`, with installation and usage instructions in all three repository READMEs. The runner is `@know-n/colp-conformance`; its release tarball depends on the matching registry version and includes the license.

- Added approachable entry points, without changing existing APIs:
  - `validateColpDocument` and `validateColpJsonDocument` (`semantic`) validate a document against its schema and the matching protocol rules in one call. `validatePublicationProblemSemantics` and `classifyPublicationProblem` are now also exported from `semantic`.
  - `composePublicationHttpReadFromRequest`, `createPublicationHttpReadRepresentation`, and `PUBLICATION_HTTP_READ_MEDIA_TYPES` (`server`) serve a Publication read straight from a Fetch `Request`, answer other methods with a `405` Problem, and derive the revision, media type, Snapshot identities, and Metadata `Link` headers from the document.
  - `createLoopbackEgressPolicy` (`client`) lets `ColpClient` follow redirects and Snapshot pages on a local server without turning off its private-network protection.
- Added an [API guide](packages/node/docs/API.md) that maps tasks to entry points, rewrote the package README and the Publication quickstart around the new helpers, and added a [documentation index](packages/node/docs/README.md). The API guide, the MCP host guide, and the browser batch guide now ship in the package, and the API guide's examples are compiled and run against the packed package like the other guides' examples.
- The Publication quickstart example now answers unsupported methods with a `405` Problem (PUB-0008) instead of an empty body.
- Publisher idempotency and request-digest boundaries now snapshot caller-owned inputs as plain own-data records and fail closed on Proxy/accessor inputs, including nested array accessors and custom array prototypes, before they can affect an identity or key decision. Non-string HTTP methods are rejected without invoking coercion hooks.
- Manifest semantics reject repeated URI-template variables, snapshot continuation links enforce the safe transport policy used by initial links, and ETag serialization rejects Proxy-backed values before inspection.
- Atom output includes entry content and validates every mapped event against the Feed event discriminator while preserving the documented omission of unsafe Bookmark targets.
- Removed tautological, fixture-count-only, and pseudo-negative tests, replaced export smoke checks with behavioral assertions, and capped Vitest at two workers so the full suite stays within ordinary CI memory limits.
- The default Node client checks DNS answers for private/local addresses before requests and redirects; custom transports can provide `resolveHost`. Public IPv6 URL hosts are normalized for DNS lookup.
- Publisher idempotency digests include `If-Match` preconditions and preserve opaque ETag contents while normalizing header list separators.
- Sync session verification rejects forged result objects; replica lifecycle ordinals are capped at 256 digits, and cross-Collection checkpoints are rejected before disclosure.
- Write candidates use bounded immutable JSON snapshots. MCP tool parameter headers are checked against `params.arguments`, and raw/decoded headers have size and count limits with bounded own-data traversal.
- Upgraded the MCP SDK packages (`@modelcontextprotocol/core`, `client`, `server`) from 2.0.0 to 2.3.1 to clear GHSA-6qxp-vccf-f47h in the dev-only SDK OAuth client. COLP's own OAuth client was reviewed and is not affected.
- OAuth safe log lines now keep the `issuer_mismatch` and `expected_issuer_required` denial reasons instead of dropping them.
- Simplified the conformance evidence workflow. `npm run refresh:evidence` runs the suite once and records each requirement whose tagged tests all passed; `npm run check:evidence` verifies the committed result. This replaces the source-revision-bound certificate, release gate, MCP candidate, and SDK acceptance scripts.
- The evidence artifact (schema version 2) contains `protocolVersion`, `packageVersion`, `requirementsDigest`, and `passedRequirementIds`. The digest covers requirement IDs, levels, profiles, and test IDs, so editing requirement wording does not invalidate evidence.
- MCP deployment conformance scopes take `mcpConformance: { packageVersion, requirementsDigest }` from `bundledConformanceEvidence`.
- Sync pull problem `type` URIs use the same `https://know-n.com/colp/problems/` base as all other problems.

### Repository

- The root README (English and Chinese) has a "Try it" section with the example server's real output, a "Find your way" table, and an updated repository layout. `CONTRIBUTING.md` has a "Writing documentation" section.
- The README banner and diagrams were redrawn: larger text that stays legible at README width, light and dark versions that follow the GitHub theme, a top-down architecture diagram with each client's profiles on its connection, and a profile graph that marks where to start. One script, `docs/assets/generate.mjs`, now generates every version.
- Added Japanese translations of the root README ([README.ja.md](README.ja.md)) and the protocol README ([protocol/README.ja.md](protocol/README.ja.md)), with Japanese versions of the banner and diagrams. Every README links to all three languages.
- The example server uses the new read helpers and `createLoopbackEgressPolicy`, and no longer hard-codes media types.
- Conformance requests follow redirects manually with per-hop egress validation and a redirect limit.
- Heap-copy measurements use V8 counters for sandbox compatibility; heavy snapshot and built export tests have local 30-second deadlines.
- Added `packages/conformance`, a black-box conformance runner (`colp-conformance`, `npm run conformance`) that checks a live server against 21 anonymous `core + publication` requirements and cites each by ID. CI runs its tests against the example server and a deliberately misbehaving proxy.
- The example server now answers unknown routes and methods with Problem Details (PUB-0008) and serves the Manifest with `Cache-Control: public, max-age=300`.
- Added a runnable example server, `packages/node/examples/publication-server.mjs` (`npm run example:publication`), which serves the `core + publication` profiles over `node:http`. CI runs its self-test after the build.
- Added `ROADMAP.md`, `GOVERNANCE.md`, `CODEOWNERS`, Dependabot configuration for npm, pip, and GitHub Actions, `.editorconfig`, and `.nvmrc`.
- The CI workflow now runs on every pull request so that `ci-gate` can be a required check; the `changes` job still skips the expensive jobs when no relevant paths changed.
- Added repository, homepage, bug tracker, and keyword metadata to `packages/node/package.json`.
- Moved the MCP host examples into `packages/node/docs/MCP_HOST_GUIDE.md` and removed the internal development logs (`docs/progress/`, `IMPLEMENTATION_PROGRESS.md`, and the `P1_*_MIGRATION.md` notes).
- Added English and Chinese READMEs with a banner and diagrams, plus contributing guidelines, a security policy, a code of conduct, and issue and pull request templates.
- CI validates the protocol examples and checks the committed evidence.
