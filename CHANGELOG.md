# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The specification and the Node.js package are versioned separately; until the first release, both are tracked under "Unreleased".

## [Unreleased]

### Specification

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

### Node.js package

- The default Node client checks DNS answers for private/local addresses before requests and redirects; custom transports can provide `resolveHost`. Public IPv6 URL hosts are normalized for DNS lookup.
- Publisher idempotency digests include `If-Match` preconditions and preserve opaque ETag contents while normalizing header list separators.
- Sync session verification rejects forged result objects; replica lifecycle ordinals are capped at 256 digits, and cross-Collection checkpoints are rejected before disclosure.
- Write candidates use bounded immutable JSON snapshots. MCP tool parameter headers are checked against `params.arguments`, and raw/decoded headers have size and count limits with bounded own-data traversal.
- Upgraded the MCP SDK packages (`@modelcontextprotocol/core`, `client`, `server`) from 2.0.0 to 2.3.1 to clear GHSA-6qxp-vccf-f47h in the dev-only SDK OAuth client. COLP's own OAuth client was reviewed and is not affected.
- OAuth safe log lines now keep the `issuer_mismatch` and `expected_issuer_required` denial reasons instead of dropping them.
- Simplified the conformance evidence workflow. `npm run refresh:evidence` runs the suite once and records each requirement whose tagged tests all passed; `npm run check:evidence` verifies the committed result. This replaces the source-revision-bound certificate, release gate, MCP candidate, and SDK acceptance scripts.
- The evidence artifact (schema version 2) contains `protocolVersion`, `packageVersion`, `requirementsDigest`, and `passedRequirementIds`. The digest covers requirement IDs, levels, profiles, and test IDs, so editing requirement wording does not invalidate evidence.
- MCP deployment conformance scopes take `mcpConformance: { packageVersion, requirementsDigest }` from `bundledConformanceEvidence`.
- Sync pull problem `type` URIs use the same `https://collectionprotocol.org/problems/` base as all other problems.

### Repository

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
