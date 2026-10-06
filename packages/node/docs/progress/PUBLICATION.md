# Publication Profile Progress

**Current boundary:** `supportedProfiles` includes `publication`. The sections
below are a chronological implementation ledger, so statements about an empty or
unverified evidence artifact describe the named checkpoint unless explicitly
marked current. A deployment still owns the HTTP surface and must pass black-box
probes before publishing a Publication Manifest claim; see
[`HOST_INTEGRATION_BOUNDARY.md`](../HOST_INTEGRATION_BOUNDARY.md).

## Round 1

- Registry scope: 40 Publication requirements (`PUB-0001` through `PUB-0040`) at the shared base.

### PUB-0001 - accepted

- Requirement: A publication Mount declares `directory`, `collection`, and `snapshot` endpoints.
- Observable conditions: schema validation rejects a publication Mount when any one of the three endpoints is absent; semantic validation reports `missing_profile_endpoint` at the affected Mount; non-publication Mounts do not acquire these requirements.
- Production files: `src/semantic/publication-endpoints.ts`, `src/semantic/endpoint-contracts.ts`, `src/semantic/index.ts`.
- Test files: `tests/schema/pub-0001-publication-endpoints-contract.test.ts`, `tests/semantic/pub-0001-publication-endpoints-contract.test.ts`.
- First focused run: `npm test -- tests/schema/pub-0001-publication-endpoints-contract.test.ts tests/semantic/pub-0001-publication-endpoints-contract.test.ts` - 2 files passed, 10 tests passed.
- Focused and related regression run: `npm test -- tests/schema/pub-0001-publication-endpoints-contract.test.ts tests/semantic/pub-0001-publication-endpoints-contract.test.ts tests/semantic/manifest.test.ts tests/schema/registry.test.ts` - 4 files passed, 36 tests passed.
- Gates passed: `npm run typecheck`, `npm run check:protocol`, `npm run check:requirements`, `npm run check:traceability`, and `git diff --check`.
- Windows line-ending note: `check:traceability` passes immediately after its generator writes LF output, but restoring the two blob-identical generated files to a clean Git status makes its raw-string comparison report stale against the CRLF worktree. No traceability or generated-requirements content diff is retained.
- Out-of-scope baseline gate: `npm run check:types` reports stale generated TypeScript contracts. PUB-0001 does not change the generated schema or types, and generated types are outside this acceptance scope, so no generated-type repair was made.
- Registry: `PUB-0001` already maps to implementation `[schema, semantic]` and evidence ID `manifest.publication-endpoints`; no Registry edit required.
- Accepted commit: `feat(colp): satisfy PUB-0001 publication mount endpoints` (the commit containing this record).
- Protocol correction: no.
- Bundled evidence: empty/unverified.

## Round 2

### PUB-0002 - accepted

- Requirement: Clients follow declared endpoints and never infer object paths.
- Observable conditions: all three Publication GET operations expand only the explicitly selected Mount's absolute `directory`, `collection`, or `snapshot` declaration; static and custom `.json` paths are used verbatim; `baseUrl`, Collection canonical identity, and conventional object paths are never fallback request targets; Snapshot pagination follows the response `rel=next` Link; cross-Origin declared endpoints receive neither static caller headers nor undeclared credentials; HTTP `404` and `503` produce zero retry/fallback requests; fixed endpoint query duplication is rejected before endpoint I/O; server declarations and exact variable bindings reuse the Endpoint Contract Registry.
- Production files: `src/client/publication-endpoints.ts`, `src/client/index.ts`, `src/server/publication-endpoints.ts`, `src/server/index.ts`.
- Test files: `tests/client/pub-0002-endpoint-driven-contract.test.ts`, `tests/server/pub-0002-endpoint-driven-contract.test.ts`.
- First focused run: `npm exec vitest run -- tests/client/pub-0002-endpoint-driven-contract.test.ts tests/server/pub-0002-endpoint-driven-contract.test.ts` - 2 files passed, 19 tests passed.
- Focused and related regression run: `npm exec vitest run -- tests/client/pub-0002-endpoint-driven-contract.test.ts tests/server/pub-0002-endpoint-driven-contract.test.ts tests/client/client.test.ts tests/client/egress-policy.test.ts tests/server/contracts.test.ts` - 5 files passed, 85 tests passed.
- Gates passed: `npm run typecheck`, `npm run check:protocol`, `npm run check:requirements`, and `git diff --check`.
- Windows line-ending note: `npm run check:traceability` reports stale raw-string output against the CRLF worktree baseline. No traceability or generated-requirements content diff is retained, and the generator was not run during PUB-0002 acceptance.
- Out-of-scope baseline gate: `npm run check:types` reports stale generated TypeScript contracts. PUB-0002 does not change schema or generated types, so no generated-type repair was made.
- Registry: `PUB-0002` already maps to implementation `[client, server]` and evidence ID `http.endpoint-driven`; no Registry edit required.
- Accepted commit: `feat(colp): satisfy PUB-0002 declared endpoint navigation` (the commit containing this record).
- Protocol correction: no.
- Bundled evidence: empty/unverified.
- Residual risk: the server package exposes registry-backed route declarations and variable validation rather than binding a concrete HTTP framework; adapters must dispatch the exact declared template and response Link behavior without adding path conventions.

## Round 3

### PUB-0003 - accepted

- Requirement: Endpoint templates are absolute RFC 6570 Level 1 templates with exactly the variables registered for that endpoint.
- Observable conditions: Schema validation accepts absolute HTTPS and loopback-HTTP Level 1 templates and rejects relative, non-loopback HTTP, userinfo, Level 2/3 operators and modifiers, and malformed braces with an exact `uri-template` format error at the endpoint; semantic validation requires `directory` variables `[]` and `collection`/`snapshot` variables `[collectionId]`, treats repeated occurrences as one set member, reports missing Publication declarations exactly, and still validates a declared endpoint on a core-only Mount without requiring Publication endpoints there. Validation and expansion share the package's `url-template` RFC 6570 implementation, while exact variable sets and Publication GET operations come from the Endpoint Contract Registry; both client resolution and server declarations reuse the shared semantic contract.
- Production files: `src/semantic/publication-endpoint-templates.ts`, `src/semantic/index.ts`, `src/client/publication-endpoints.ts`, `src/server/publication-endpoints.ts`.
- Test files: `tests/schema/pub-0003-template-variables-contract.test.ts`, `tests/semantic/pub-0003-template-variables-contract.test.ts`.
- First focused run: `npm exec vitest run -- tests/schema/pub-0003-template-variables-contract.test.ts tests/semantic/pub-0003-template-variables-contract.test.ts` - 2 files passed, 32 tests passed.
- Focused and related regression run: `npm exec vitest run -- tests/schema/pub-0003-template-variables-contract.test.ts tests/semantic/pub-0003-template-variables-contract.test.ts tests/schema/formats-contract.test.ts tests/semantic/manifest.test.ts tests/client/pub-0002-endpoint-driven-contract.test.ts tests/server/pub-0002-endpoint-driven-contract.test.ts` - 6 files passed, 96 tests passed.
- Gates passed: `npm run typecheck`, `npm run check:protocol`, `npm run check:requirements`, and `git diff --check`.
- Windows line-ending note: `npm run check:traceability` reports stale raw-string output against the CRLF worktree baseline. No traceability or generated-requirements content diff was created or retained.
- Out-of-scope baseline gate: `npm run check:types` reports stale generated TypeScript contracts. PUB-0003 does not change schema or generated types, so no generated-type repair was made.
- Registry: `PUB-0003` already maps to implementation `[schema, semantic]` and evidence ID `manifest.template-variables`; no Registry edit required.
- Accepted subject: `feat(colp): satisfy PUB-0003 endpoint template contracts`.
- Protocol correction: no.
- Bundled evidence: empty/unverified.
- Residual risk: RFC 6570 behavior depends on the pinned `url-template` dependency and the package's Level 1 guard remaining aligned; framework adapters must continue to use the exported registry-backed server declarations rather than independently parsing templates.

## Round 4

### PUB-0004 - accepted

- Requirement: Snapshot page cursors bind revision, principal, query scope, and page size.
- Observable conditions: the server issues an opaque, at-most-128-character HMAC-SHA-256 cursor whose collision-safe framing authenticates the revision, Principal, optional `root`, optional `depth`, canonical `include` set, page size, and exclusive next position; key material is copied into an opaque destroyable capability; malformed tokens, wrong keys, invalid contexts, and scope mismatches expose only `invalid_cursor_scope`, while valid-shaped MAC comparison is constant-time. The client starts without `pageCursor`, follows exactly one server-provided `rel=next`, requires its cursor to match `page.nextCursor`, preserves scalar query values and page size, canonicalizes `include` as a set, rejects repeated scalars and cursors, retains existing URL/egress validation for cross-Origin Links, partitions cache entries by Principal and full page URL, and rejects a later `409 snapshot_expired` without returning partially assembled pages.
- Production files: `src/server/publication-snapshot-cursor.ts`, `src/server/index.ts`, `src/client/publication-snapshot-pagination.ts`, `src/client/index.ts`.
- Test files: `tests/server/pub-0004-snapshot-cursor-scope-contract.test.ts`, `tests/client/pub-0004-snapshot-cursor-scope-contract.test.ts`.
- First focused run: `npm test -- tests/server/pub-0004-snapshot-cursor-scope-contract.test.ts tests/client/pub-0004-snapshot-cursor-scope-contract.test.ts` - 2 files ran, 68 tests passed and 4 tests failed; all four failures were test false positives (three error-message matchers excluded the valid `must not exceed` boundary diagnostic, and the 128-character case overcounted the maximum next-position payload by one byte).
- Repaired focused run: the same 2-file command - 2 files passed, 76 tests passed.
- Focused and related regression run: `npm test -- tests/server/pub-0004-snapshot-cursor-scope-contract.test.ts tests/client/pub-0004-snapshot-cursor-scope-contract.test.ts tests/client/client.test.ts tests/client/egress-policy.test.ts tests/client/pub-0002-endpoint-driven-contract.test.ts tests/server/contracts.test.ts tests/server/problem-registry-drift.test.ts` - 7 files passed, 164 tests passed.
- Gates passed: `npm run typecheck`, `npm run check:protocol`, `npm run check:requirements`, and `git diff --check`.
- Windows line-ending note: `npm run check:traceability` reports the known stale raw-string output against the CRLF worktree baseline. No traceability or generated-requirements content was changed, and the generator was not run during PUB-0004 acceptance.
- Out-of-scope baseline gate: `npm run check:types` reports stale generated TypeScript contracts. PUB-0004 does not change schema or generated types, so no generated-type repair was made.
- Registry: `PUB-0004` already maps to implementation `[client, server]` and evidence ID `http.snapshot.cursor-scope`; no Registry edit required.
- Accepted subject: `feat(colp): satisfy PUB-0004 snapshot cursor scope`.
- Protocol correction: no.
- Bundled evidence: empty/unverified.
- Residual risk: revision retention and expiration are deployment lifecycle responsibilities. Adapters must retain a revision for the intended pagination window, map an expired revision to `409 snapshot_expired`, rotate cursor keys without invalidating supported in-flight windows unexpectedly, and avoid returning any page from a different revision.

## Round 5

### PUB-0005 - accepted

- Requirement: Clients atomically replace state only after complete ordered Snapshot assembly.
- Observable conditions: each wire page passes schema and page-level semantic validation before entering temporary assembly; pagination follows only the validated response `rel=next`; logical metadata, query scope, contiguous sequence, terminal boundary, and cross-page live IDs remain fixed; the terminal assembled graph receives complete Publication semantic validation; cropped Snapshots remain readable but cannot replace authoritative state; and a replacement performs semantic validation, an isolated deep clone/freeze, and a detached return clone before its sole state reference assignment. Retrieval, `409 snapshot_expired`, limits, timeout, pagination, identity, graph, or clone failures preserve the old state and do not interpret absent objects as deletions.
- Production files: `src/semantic/publication-snapshot-replacement.ts`, `src/semantic/index.ts`, `src/client/publication-snapshot-state.ts`, `src/client/index.ts`.
- Test files: `tests/semantic/pub-0005-snapshot-assembly-contract.test.ts`, `tests/client/pub-0005-snapshot-assembly-contract.test.ts`.
- First focused run: `npm test -- tests/semantic/pub-0005-snapshot-assembly-contract.test.ts tests/client/pub-0005-snapshot-assembly-contract.test.ts` - 2 files passed, 35 tests passed.
- Repaired focused run: the same 2-file command - 2 files passed, 36 tests passed. Acceptance tightened prototype-spy cleanup, guaranteed deferred-page gate release, and proved that failure while preparing the detached return value occurs before the state assignment.
- Focused and related regression run: `npm test -- tests/semantic/pub-0005-snapshot-assembly-contract.test.ts tests/client/pub-0005-snapshot-assembly-contract.test.ts tests/client/client.test.ts tests/client/snapshot-completeness-contract.test.ts tests/client/pub-0004-snapshot-cursor-scope-contract.test.ts tests/semantic/snapshot.test.ts tests/semantic/snapshot-metadata-contract.test.ts tests/semantic/snapshot-identity-contract.test.ts tests/semantic/snapshot-graph-contract.test.ts tests/semantic/snapshot-reference-contract.test.ts` - 10 files passed, 233 tests passed.
- Gates passed: `npm run typecheck`, `npm run check:protocol`, `npm run check:requirements`, and `git diff --check`.
- Windows line-ending note: `npm run check:traceability` reports the known stale raw-string output against the CRLF worktree baseline. No traceability or generated-requirements content was changed, and the generator was not run during PUB-0005 acceptance.
- Out-of-scope baseline gate: `npm run check:types` reports stale generated TypeScript contracts. PUB-0005 does not change schema or generated types, so no generated-type repair was made.
- Registry: `PUB-0005` already maps to implementation `[semantic, client]` and evidence ID `semantic.snapshot.assembly`; no Registry edit required.
- Accepted subject: `feat(colp): satisfy PUB-0005 atomic snapshot replacement`.
- Protocol correction: no.
- Bundled evidence: empty/unverified.
- Residual risk: concurrent `refreshSnapshot` calls commit complete validated assemblies in completion order; a slower earlier refresh can therefore replace a faster later refresh. Callers that require invocation-order freshness must serialize refreshes or add an application-level generation guard.

## Round 6

### PUB-0006 - accepted

- Requirement: Representation ETags include projection, query, content negotiation, and page identity.
- Observable conditions: the server helper emits deterministic quoted strong SHA-256 ETags over collision-safe framed fields for the exact representation bytes, revision, projection key, decoded query contract and value, concrete selected media type, protocol version, snapshot identity, and page identity. Snapshot and node-detail `include` values are canonical sets, while other decoded query array ordering remains significant; query object member order is canonical. Different pages at one revision produce different tags. Raw Accept alternatives, weights, and wildcards are rejected rather than treated as selected variants. Identity and query boundaries reject malformed, unsafe, cyclic, oversized, or control-bearing values without exposing their raw material in the tag.
- Production files: `src/server/publication-representation-etag.ts`, `src/server/index.ts` (minimal export only).
- Test file: `tests/server/pub-0006-representation-etag-contract.test.ts`.
- First focused run: `npm test -- --run tests/server/pub-0006-representation-etag-contract.test.ts` - 1 file ran, 96 tests passed and 1 test failed. The string representation path accepted a raw NUL, which is not a legal JSON text byte.
- Repaired focused run: `npx vitest run tests/server/pub-0006-representation-etag-contract.test.ts` - 1 file passed, 103 tests passed. The repair rejects raw NUL only for the string JSON-text path, preserves arbitrary `Uint8Array` bytes, proves pretty-printed JSON TAB/CR/LF hashes identically to its UTF-8 bytes, and validates concrete selected media types without rejecting legal quoted parameters.
- Focused and related regression run: `npx vitest run tests/server` - 7 files passed, 260 tests passed.
- Gates passed: `npm run typecheck`, `npm run check:protocol`, `npm run check:requirements`, and `git diff --check`.
- Windows line-ending note: `npm run check:traceability` reports the known stale raw-string output against the CRLF worktree baseline (`core.autocrlf=true`; the checked-out file has 209 CRLF line endings). No traceability or generated-requirements content was changed, and the generator was not run during PUB-0006 acceptance.
- Out-of-scope baseline gate: `npm run check:types` reports stale generated TypeScript contracts. PUB-0006 does not change schema or generated types, so no generated-type repair was made.
- Registry: `PUB-0006` already maps to implementation `[server]` and evidence ID `http.etag.variants`; no Registry edit required.
- Accepted subject: `feat(colp): satisfy PUB-0006 representation ETag variants`.
- Protocol correction: no.
- Bundled evidence: empty/unverified.
- Residual risk: HTTP framework adapters remain responsible for passing the final serialized response bytes, the actual selected response media type (never the raw `Accept` header), the validated decoded query DTO, and stable projection/snapshot/page identities. Supplying pre-serialization data or an unstable projection key would create incorrect validator identity despite the helper's framing.

## Round 7

### PUB-0007 - accepted

- Requirement: Authorization-varying responses are private no-store and vary by Authorization.
- Observable conditions: after the adapter selects the authorization-varying branch, the server policy always replaces any existing cache declaration with exactly `private, no-store`, including shared-cache candidates, and preserves valid existing `Vary` field-name tokens while adding one case-insensitive `Authorization` token. Repeated fields and OWS are normalized without mutating caller input; `Vary: *` retains its stronger wildcard semantics; empty members, invalid tokens, wildcard mixtures, control characters, CRLF injection, oversized values, malformed or conflicting Cache-Control directives, illegal runtime input types, unknown fields, and credential-bearing fields fail closed. Only the explicit anonymous-public branch can retain a validated shared-cache declaration. Outputs are isolated and frozen, and the policy applies equally to body-bearing, empty, success, not-modified, authorization-failure, and concealed responses.
- Production files: `src/server/publication-cache-policy.ts`, `src/server/index.ts` (minimal export only).
- Test file: `tests/server/pub-0007-authorization-cache-contract.test.ts`.
- First focused run: `npm exec vitest run -- tests/server/pub-0007-authorization-cache-contract.test.ts` - 1 file passed, 60 tests passed, 0 failed.
- Acceptance repair: five status/body parameter cases previously repeated the same header-only call without applying their parameters to a response. They now construct actual `Response` objects for HTTP 200, 204, 304, 403, and 404 and assert the production policy on the final response headers; no failing test was removed or relaxed.
- Final focused run: `npm exec vitest run -- tests/server/pub-0007-authorization-cache-contract.test.ts` - 1 file passed, 60 tests passed, 0 failed.
- Related server regression run: `npm exec vitest run -- tests/server` - 8 files passed, 320 tests passed, 0 failed.
- Gates passed: `npm run typecheck`, `npm run check:protocol`, `npm run check:requirements`, and `git diff --check`.
- Windows line-ending note: `npm run check:traceability` reports the known stale raw-string output against the CRLF worktree baseline (`core.autocrlf=true`; the checked-out file has 209 CRLF line endings). No traceability or generated-requirements content was changed, and the generator was not run during PUB-0007 acceptance.
- Out-of-scope baseline gate: `npm run check:types` reports stale generated TypeScript contracts. PUB-0007 does not change schema or generated types, so no generated-type repair was made.
- Registry: `PUB-0007` already maps to implementation `[server]` and evidence ID `http.cache.authorization`; no Registry edit required.
- Accepted subject: `feat(colp): satisfy PUB-0007 authorization cache policy`.
- Protocol correction: no.
- Bundled evidence: empty/unverified.
- Residual risk: HTTP framework adapters remain responsible for selecting `authorization-varying` whenever Authorization changes a representation and applying the returned headers to every response status. Misclassifying an authorization-dependent response as `anonymous-public`, or overwriting the returned headers later in the response pipeline, can violate the contract outside this framework-neutral helper.

## Round 8

### PUB-0008 - accepted

- Requirement: Errors use RFC 9457 Problem Details with a stable machine code.
- Observable conditions: the server constructs fresh `Response` objects with exact `application/problem+json`, registry-derived HTTP/body status and retryability, stable `https://collectionprotocol.org/problems/<hyphenated-code>` core type URIs, HTTPS extension namespace codes, bounded and isolated machine recovery fields, and no free-form title/detail input path that could echo secrets, signed URLs, private notes, or internal Principals. The client reaches only the Manifest-declared endpoint, retains the canonical parse/I-JSON/Schema/format stages, adds Publication semantic checks afterward for media type, HTTP/body/registry agreement and extension namespaces, rejects invalid UTF-8 Problem bytes at the parse stage, and classifies/recoveries only from `status`, `code`, registry policy, and documented machine fields. Human `title`/`detail` do not affect classification, recovery, or the public error message.
- Production files: `src/server/publication-problems.ts`, `src/server/index.ts` (minimal export only), `src/client/publication-problems.ts`, `src/client/index.ts`.
- Test files: `tests/server/pub-0008-problem-details-contract.test.ts`, `tests/client/pub-0008-problem-details-contract.test.ts`; two existing client fixtures were corrected in `tests/client/client.test.ts` and `tests/client/pub-0002-endpoint-driven-contract.test.ts` so their HTTP/body/registry statuses describe valid Problems while preserving their original assertions.
- First focused run: `npm exec vitest run -- tests/server/pub-0008-problem-details-contract.test.ts tests/client/pub-0008-problem-details-contract.test.ts` - 2 files passed, 85 tests passed, 0 failed. Static review found false-negative coverage: both sides omitted `errors[]`, the server type URI drifted to `collection-protocol.org` with underscore paths, and the tests accepted any HTTPS type URI.
- Acceptance repair: added all documented recovery fields including deeply frozen `errors[]`; restored the specification domain and hyphenated core type path; enforced bounded visible-ASCII HTTPS extension namespaces without user information; added fail-closed input, body-size, media-type ambiguity/charset, actual invalid UTF-8, parse/structural/Publication-semantic stage, cross-Origin declared endpoint, registry agreement, title/detail independence, isolation, and sensitive-message coverage. An intermediate expanded run had 2 files, 100 tests, 98 passed and 2 failed because two new assertions incorrectly expected duplicate members and `__proto__` at the structural stage; the assertions were corrected to the existing CORE parser's `parse` stage without changing CORE validation.
- Final focused run: the same 2-file command - 2 files passed, 100 tests passed, 0 failed.
- Related server regression: `npm exec vitest run -- tests/server` - 9 files passed, 375 tests passed, 0 failed.
- Related client regression: `npm exec vitest run -- tests/client` - 8 files passed, 174 tests passed, 0 failed.
- Gates passed: `npm run typecheck`, `npm run check:protocol`, `npm run check:requirements`, and `git diff --check`.
- Windows line-ending note: `npm run check:traceability` reports the known stale raw-string output against the CRLF worktree baseline. No TRACEABILITY or generated-requirements content was changed, and the generator was not run during PUB-0008 acceptance.
- Out-of-scope baseline gate: `npm run check:types` reports stale generated TypeScript contracts. PUB-0008 does not change schema or generated types, so no generated-type repair was made.
- Registry: `PUB-0008` already maps to implementation `[server, client]` and evidence ID `http.problems`; no Registry edit required.
- Protocol correction: no.
- Bundled evidence: empty/unverified.
- Residual risk: framework adapters must use the server response helper or preserve its exact status, media type, body, and recovery fields. Any separate authorization-aware layer that adds human `detail` text remains responsible for preventing secret, signed URL, private Note, internal Principal, and other unauthorized-data disclosure.

## Round 9

### PUB-0009 - accepted

- Requirement: Anonymous discovery excludes unlisted collections.
- Scope: anonymous Collection Directory only. Search, Feed, Sitemap, MCP, noindex behavior, authorized protected discovery, query decoding, sorting, cursor semantics, pagination semantics, and cache policy remain assigned to their separate requirements.
- Observable conditions: only canonical `public` Directory records enter anonymous query/sort/cursor/page processing; `unlisted`, `protected`, and `private` records are removed first while order is preserved. Candidate sets and derived pages have module-private runtime provenance, page entries must retain identities issued by the pre-pagination selector, and the final builder accepts only an issued page before revalidating every record and the complete Directory DTO. Raw pages, forged TypeScript brands, and a public-looking narrow window produced by paginating mixed storage first fail closed. Recognized hidden records are excluded after a safe own-data visibility read without traversing malformed URLs, counts, accessors, symbols, cycles, custom prototypes, extensions, or cross-Origin secret fields; malformed public records remain subject to strict JSON and canonical Schema validation. Inputs are not mutated, all outputs are isolated clones and deeply frozen, and sparse/accessor/symbol/cycle/depth/count-limit failures use bounded non-echoing errors.
- Production files: `src/server/publication-directory.ts`, `src/server/index.ts` (minimal export only).
- Test file: `tests/server/pub-0009-anonymous-directory-contract.test.ts` (73 exact expanded tests, each directly invoking the production server API and carrying evidence ID `http.directory.unlisted`).
- First focused run before independent acceptance repair: `npx vitest run tests/server/pub-0009-anonymous-directory-contract.test.ts --reporter=verbose` - 1 file passed, 65 tests passed, 0 failed. Static and behavioral review found false-positive coverage: the final builder accepted any cast raw public page and therefore could not prove selection preceded pagination, while the selector fully validated hidden records and allowed malformed hidden fields to cause an observable anonymous failure.
- Acceptance repair: added runtime-issued candidate-set and page boundaries backed by module-private `WeakSet` registries, identity membership enforcement for derived pages, final issued-page and canonical/public validation, early hidden exclusion without hidden-payload traversal, and explicit forged-brand, mixed-storage pre-pagination, malformed-hidden non-observability, custom-prototype, and unissued-page tests.
- Final focused run: `npx vitest run tests/server/pub-0009-anonymous-directory-contract.test.ts --reporter=default` - 1 file passed, 73 tests passed, 0 failed.
- Related server regression: `npx vitest run tests/server --reporter=default` - 10 files passed, 448 tests passed, 0 failed.
- Gates passed: `npm run typecheck`, `npm run check:protocol`, `npm run check:requirements`, and `git diff --check`.
- Out-of-scope baseline gate: `npm run check:types` reports the known stale generated TypeScript contracts. PUB-0009 changes neither Schema nor generated types, so no generated-type repair was made.
- Windows line-ending note: `npm run check:traceability` reports the known stale raw-string output against the CRLF worktree baseline. No TRACEABILITY or generated-requirements output was generated or edited.
- Registry: `PUB-0009` already maps to implementation `[server]` and evidence ID `http.directory.unlisted`; no Registry edit required.
- Protocol correction: no.
- Bundled evidence: empty/unverified.
- Residual risk: a storage/framework adapter must supply the complete pre-query anonymous candidate population to `selectAnonymousDirectoryCandidates` and retain selected object identities while filtering, sorting, and slicing. No in-process API can prove that an adapter omitted records before its first call; the runtime provenance boundary prevents later raw-window substitution but cannot audit an upstream datastore query outside this package.

## Round 10

### PUB-0010 - accepted

- Requirement: Query parameters use registered decoding and reject unknown or duplicate scalar parameters.
- Observable conditions: Publication Directory, Snapshot, Node Detail, and no-query Collection Metadata resolve their exact GET operation by runtime identity from the Endpoint Contract Registry. The server strictly decodes raw form query bytes, rejects malformed percent escapes, invalid UTF-8 or UTF-16, C0/C1 controls, empty fields, unknown or prototype-shaped decoded names, duplicate scalars, empty values, invalid typed/ranged integers, invalid enums/dates, comma-encoded arrays, duplicate array members, and any query on Collection Metadata with a stable frozen `400 invalid_query` result that never reflects values. Named `directoryQuery`, `snapshotQuery`, and `nodeDetailQuery` `$defs` validation runs after registered decoding. The client validates plain DTOs, omits `undefined`, rejects malformed UTF-16 in property names, scalar strings, array strings, and fixed endpoint strings as a non-reflecting `invalid_query` `TypeError`, emits arrays as repeated parameters, encodes legal supplementary characters as exact UTF-8 in deterministic named-contract property order, preserves existing fixed endpoint percent bytes and pair order, merges caller parameters before the same decoder, and rejects collisions or invalid fixed queries after Manifest discovery but before endpoint I/O, including cross-Origin endpoints. Raw input is bounded to 16 KiB by UTF-8 bytes and 16 parameters; DTOs are bounded to 8 properties and 8 array items.
- Production files: `src/server/publication-query.ts`, `src/server/index.ts` (minimal export), `src/client/publication-query.ts`, `src/client/index.ts`.
- Test files: `tests/server/pub-0010-query-codec-contract.test.ts`, `tests/client/pub-0010-query-codec-contract.test.ts`; `tests/client/pub-0004-snapshot-cursor-scope-contract.test.ts` updates one query-order expectation to the unified Registry-contract order without changing cursor-scope behavior.
- First focused run: `npx vitest run tests/server/pub-0010-query-codec-contract.test.ts tests/client/pub-0010-query-codec-contract.test.ts --reporter=default` - 2 files ran, 129 tests passed and 1 test failed out of 130. The failure was a test false positive: `vi.spyOn` attempted to redefine the intentionally frozen canonical validator method before production decoding ran.
- Acceptance repair: replaced the invalid spy with a delegating `ValidatorRegistry`; added exact and over-limit byte, parameter, array, and DTO budgets; added encoded unknown/prototype, distinct percent-spelled duplicate, malformed percent/UTF-8/control, empty separator/key, comma/duplicate array, unsafe/negative/leading-zero integer, fixed collision, no-query, sensitive non-reflection, fixed-byte preservation, cross-Origin exact URL, and pre-endpoint-I/O cases. Client errors retain the established `snapshotQuery`, unknown, duplicate-scalar, and no-query categories while adding stable `invalid_query`; no raw value is included.
- Independent re-acceptance baseline: the focused 2-file command passed 138 tests before the new boundary audit.
- Independent re-acceptance repair: explicitly rejects unpaired high/low UTF-16 surrogates at leading, middle, and trailing positions before `TextEncoder`, `URL`, or `encodeURIComponent` can replace them or throw a native `URIError`; covers scalar strings, array strings, parameter/DTO names, and fixed raw endpoint strings without reflection. Expanded controls through C1, prevented WHATWG URL normalization from stripping literal fixed TAB/LF, and added exact supplementary UTF-8 roundtrip and multibyte byte-budget boundaries.
- Fresh final-acceptance baseline: the current focused 2-file command ran 171 tests, with 170 passed and 1 failed. The literal-LF Manifest endpoint case was rejected by generic URI-template structural validation before the raw Publication endpoint assertion, so it did not produce the required stable `invalid_query` category.
- Final-acceptance repair: the real client now performs a bounded, structured I-JSON preflight of the four Publication endpoint source strings before URI-template validation or expansion. Literal TAB/LF/CR, other C0/C1 controls, and malformed UTF-16 therefore fail after Manifest I/O but before endpoint I/O with the same non-reflecting `invalid_query`; the normal wire validator retains ownership of all general Manifest parse failures. Added real `ColpClient` coverage for all seven source-text boundaries.
- Final focused run: the same 2-file command - 2 files passed, 177 tests passed, 0 failed (server 100, client 77).
- Focused and related regression run: `npx vitest run tests/client/client.test.ts tests/client/pub-0002-endpoint-driven-contract.test.ts tests/client/egress-policy.test.ts tests/server/contracts.test.ts tests/server/pub-0002-endpoint-driven-contract.test.ts tests/server/pub-0010-query-codec-contract.test.ts tests/client/pub-0010-query-codec-contract.test.ts --reporter=default` - 7 files passed, 262 tests passed, 0 failed.
- Complete server/client regression: `npx vitest run tests/server tests/client --reporter=default` - 20 files passed, 799 tests passed, 0 failed.
- Gates passed: `npm run typecheck`, `npm run check:protocol`, `npm run check:requirements`, and `git diff --check`.
- Out-of-scope baseline gate: `npm run check:types` reports the known stale generated TypeScript contracts. PUB-0010 changes neither Schema nor generated types, so no generated-type repair was made.
- Windows line-ending note: `npm run check:traceability` reports the known stale raw-string output against the CRLF worktree baseline. No TRACEABILITY or generated-requirements output was generated or edited.
- Registry: `PUB-0010` already maps to implementation `[server, client]` and evidence ID `http.query-codec`; no Registry edit required.
- Protocol correction: no.
- Bundled evidence: empty/unverified.
- Suggested single-commit boundary: `feat(colp): satisfy PUB-0010 publication query codec`.
- Residual risk: framework adapters must pass the untouched raw search component to `decodePublicationQuery` before routing/business logic and must preserve its `400 invalid_query` classification. Re-parsing with framework-coerced query objects can lose duplicate-key and malformed-byte evidence outside this package boundary.

## Round 11

### PUB-0011 - accepted

- Requirement: the server provides its Manifest at the sole Section 7 location, `/.well-known/collection-protocol`.
- Observable conditions: the framework-neutral production handler serves only exact `GET` and `HEAD` requests for the canonical, case-sensitive path. Trailing or doubled slashes, prefixes/suffixes, encoded spellings, queries, fragments, absolute URLs, non-canonical methods, unsupported methods, malformed request records, accessors, and Proxies fail closed as route misses before Manifest inspection. GET returns a detached canonical UTF-8 JSON snapshot with exact byte `Content-Length`; HEAD returns identical metadata without a body. The source must be plain, accessor-free, Proxy-free, acyclic bounded I-JSON, pass the canonical Manifest Schema and semantic validator, and contain an independently declared Publication mount. Errors are bounded and do not reflect Manifest or request secrets; repeated responses and headers are frozen.
- Production files: `src/server/publication-manifest-discovery.ts`, `src/server/index.ts` (minimal export only).
- Test file: `tests/server/pub-0011-manifest-discovery-contract.test.ts` (73 tests, each invoking the production server API and carrying evidence ID `http.manifest-discovery`).
- First focused run: `npm test -- --run tests/server/pub-0011-manifest-discovery-contract.test.ts` - 1 file failed; 73 tests ran, 61 passed and 12 failed. Eleven failures exposed that malformed/non-canonical request inputs threw instead of taking the fail-closed route-miss path; one test incorrectly claimed structural validity after removing `publication` while retaining profiles that depend on it.
- Acceptance repair: request inspection now returns a route miss for malformed control input and the one-shot handler validates the Manifest only after an exact route match. The no-Publication test now uses a structurally and semantically valid core-only mount before asserting the production Publication-mount guard. No test was deleted, skipped, ignored, or weakened, and no Schema or CORE assertion changed.
- Final focused run: `npm exec vitest run -- tests/server/pub-0011-manifest-discovery-contract.test.ts --reporter=default` - 1 file passed, 73 tests passed, 0 failed.
- Complete server regression: `npm exec vitest run -- tests/server` - 12 files passed, 621 tests passed, 0 failed.
- Publication Manifest regression: `npx vitest run tests/semantic/manifest.test.ts tests/semantic/pub-0001-publication-endpoints-contract.test.ts tests/schema/pub-0001-publication-endpoints-contract.test.ts --reporter=default` - 3 files passed, 18 tests passed, 0 failed.
- Gates passed: `npm run check:protocol`, `npm run check:requirements`, `npm run check:traceability`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- Out-of-scope baseline gate: `npm run check:types` reports the known stale generated TypeScript contracts. PUB-0011 changes neither Schema nor generated types, so no type generation was performed.
- Registry and generated assets: canonical `PUB-0011` maps to implementation `[server]` and test ID `http.manifest-discovery`. `npm run sync:protocol`, `npm run generate:evidence:empty`, and `npm run generate:traceability` were rerun; fixture Registry, generated requirements, evidence, and TRACEABILITY SHA-256 values were unchanged from their pre-generation values, proving the checked-in assets are stable generator output.
- Protocol correction: no.
- Bundled evidence: empty/unverified (`sourceRevision: unverified`, `passedRequirementIds: []`, 0 verified records).
- Stray compiler emit: none in the tracked or untracked source tree; build output remains confined to ignored `dist/`.
- Residual risk: an HTTP framework adapter must pass the original method and path without decoding or normalization, treat `null` as a route miss, and preserve the returned status, headers, UTF-8 body bytes, and HEAD body suppression. A reverse proxy or router that rewrites the well-known path, appends query data to the path field, or reserializes the body can violate the wire behavior outside this package boundary.

## Round 12

### PUB-0012 - accepted

- Requirement: every Manifest Mount independently declares its own `profiles`, `endpoints`, authentication, and limits. The selected `SPECIFICATION.md#colp-section-7` occurrence is `keywordOrdinal: 1`; client Endpoint/Link following and prohibition on guessing paths from `baseUrl` remain PUB-0013 and PUB-0014 and are not implemented or claimed here.
- Observable conditions: every Mount must expose all four declarations as own enumerable data properties; inherited, missing, non-enumerable, accessor-backed, Proxy-backed, non-plain, cyclic, cross-declaration aliases, and cross-Mount aliases fail closed without invoking accessors or Proxy traps. Multiple Mounts retain distinct values without fallback or merging. Accepted declaration graphs are detached into recursively frozen snapshots, and depth, aggregate value-count, and UTF-8 byte limits have exact accepted/rejected boundaries. The production Manifest discovery path executes this guard before its existing canonical snapshot, Schema, semantic, and Publication-profile checks.
- Production files: `src/server/publication-mount-declarations.ts`, `src/server/publication-manifest-discovery.ts`, `src/server/index.ts` (minimal export only).
- Test file: `tests/server/pub-0012-manifest-mount-declarations-contract.test.ts`.
- First focused run: `npm test -- tests/server/pub-0012-manifest-mount-declarations-contract.test.ts --reporter=verbose` - 1 file failed; 57 tests ran, 56 passed and 1 failed. The exact value-count boundary timed out after 5 seconds because dense-array membership used repeated linear `includes` checks over 100,000 keys.
- Acceptance repair: dense-array validation now builds one key `Set`, reducing the boundary from quadratic to linear work. A direct Proxy-backed Mount case was added to prove zero trap invocation; no test was deleted, skipped, ignored, or weakened, and no Schema or CORE assertion changed.
- Final focused run: `npm test -- tests/server/pub-0012-manifest-mount-declarations-contract.test.ts` - 1 file passed, 58 tests passed, 0 failed; test execution was 64 ms.
- Complete server regression: `npm test -- tests/server` - 13 files passed, 679 tests passed, 0 failed.
- Manifest and PUB-0011 regression: `npm test -- tests/server/pub-0011-manifest-discovery-contract.test.ts tests/server/pub-0012-manifest-mount-declarations-contract.test.ts tests/semantic/manifest.test.ts tests/semantic/pub-0001-publication-endpoints-contract.test.ts tests/schema/pub-0001-publication-endpoints-contract.test.ts` - 5 files passed, 149 tests passed, 0 failed.
- Example validation: `npm test -- tests/conformance/examples.test.ts` - 1 file passed, 28 tests passed, 0 failed.
- Gates passed: `npm run check:protocol`, `npm run check:requirements`, `npm run check:traceability`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- Out-of-scope baseline gate: `npm run check:types` reports the existing stale generated TypeScript contracts. `src/types/generated.ts` is unchanged from HEAD; PUB-0012 changes neither Schema nor generated types, and the acceptance scope forbids repairing that baseline here.
- Registry and generated assets: canonical `PUB-0012` maps only to implementation `[server]` and test ID `manifest.mount-declarations`. `npm run sync:protocol`, `npm run generate:evidence:empty`, and `npm run generate:traceability` were rerun; canonical Registry, fixture Registry, generated requirements, evidence, and TRACEABILITY SHA-256 values were identical before and after generation. Post-generation protocol, requirements, and traceability checks passed.
- Protocol correction: no. No CORE specification, Schema semantics, generated type, CORE test, client, sync, MCP, security, feed, publisher, adapter, conformance logic, or `src/server/json.ts` change is included.
- Bundled evidence: empty/unverified (`sourceRevision: unverified`, `passedRequirementIds: []`, 0 verified records).
- Stray compiler emit: none in tracked or untracked source; build output remains confined to ignored `dist/`.
- Residual risk: framework adapters must serve the discovery handler's already validated body rather than serialize a different Manifest object later. The helper can enforce independent declaration ownership only for the in-process graph it receives; configuration assembled or rewritten outside this package must still pass that complete final graph to discovery.

## Round 13

### PUB-0013 - accepted

- Requirement: the client follows the selected Manifest Mount's declared Endpoint and each paginated response's `rel=next` Link. The selected `SPECIFICATION.md#colp-section-7` occurrence is `keywordOrdinal: 2`; the separate PUB-0014 prohibition on guessing paths from `baseUrl` is not implemented or claimed here.
- Observable conditions: Directory, Collection, and Snapshot requests carry an immutable source record from the selected Mount Endpoint through the real `ColpClient` request path. Snapshot continuation targets are created only from exactly one valid `rel=next` on the current final response URL, including after redirects, and preserve their response source through relative, absolute, cross-Origin, and multi-page navigation. Missing, duplicate, malformed, fragmented, cursor-mismatched, query-scope-changing, malformed UTF-16/percent, control-bearing, and oversized Links fail before another request. HTTP errors do not establish continuations; redirect hops retain the original source; cache hits and matching 304 responses cannot forge it; cache partitions and cross-Origin credential isolation remain enforced.
- Opaque target boundary: established navigation handles are frozen empty objects whose URL and frozen source live only in a module-private `WeakMap`. Reflective copying cannot transfer authority, projected URLs are detached, and accessor/Proxy forgeries are rejected without executing getters or traps.
- Production files: `src/client/publication-navigation.ts`, `src/client/index.ts` (Publication request-path integration and minimal client export only).
- Test file: `tests/client/pub-0013-endpoint-link-following-contract.test.ts`.
- First focused run: `npm test -- tests/client/pub-0013-endpoint-link-following-contract.test.ts --reporter=verbose` - 1 file failed; 28 tests ran, 24 passed and 4 failed. Two failures exposed invalid unselected-Mount test templates that omitted required `{collectionId}` variables; two exposed a real transferable/reflection-triggering target brand and source representation.
- Acceptance repair: replaced exposed target state with a private `WeakMap` capability boundary, corrected the unselected-Mount fixtures to remain structurally valid and distinguishable, and aligned the partial Snapshot fixture's `complete` flag with its requested projection. No test was deleted, skipped, ignored, or weakened, and no CORE, Schema, conformance-control, adapter, server, publisher, sync, MCP, security, feed, or generated-type behavior changed.
- Final focused run: `npm test -- tests/client/pub-0013-endpoint-link-following-contract.test.ts -- --reporter=verbose` - 1 file passed, 28 tests passed, 0 failed.
- Complete client regression: `npm test -- tests/client` - 10 files passed, 279 tests passed, 0 failed.
- PUB-0002/0004/0010 regression: `npm test -- tests/client/pub-0002-endpoint-driven-contract.test.ts tests/client/pub-0004-snapshot-cursor-scope-contract.test.ts tests/client/pub-0010-query-codec-contract.test.ts` - 3 files passed, 106 tests passed, 0 failed. No independent server pagination suite exists; pagination consumption is client-owned and no server production file changed.
- Gates passed: `npm run typecheck`, `npm run check:protocol`, `npm run check:requirements`, `npm run check:traceability`, `npm test -- tests/conformance/examples.test.ts` (28 tests), `npm run build`, and `git diff --check`.
- Out-of-scope baseline gate: `npm run check:types` reports the existing stale generated TypeScript contracts. `src/types/generated.ts` and Schema files are unchanged from HEAD; PUB-0013 changes neither Schema nor generated types, so the forbidden baseline repair was not made.
- Registry and generated assets: canonical `PUB-0013` maps only to implementation `[client]` and test ID `http.endpoint-link-following`. `npm run sync:protocol`, `npm run generate:evidence:empty`, and `npm run generate:traceability` were rerun twice; canonical Registry, fixture Registry, generated requirements, evidence, and TRACEABILITY SHA-256 values were identical before and after the second generation. Protocol, requirements, and traceability checks then passed. `PUB-0014` remains `implementation: []` and `tests: []` in canonical, fixture, and generated Registry data.
- Protocol correction: no. Bundled evidence remains empty/unverified (`sourceRevision: unverified`, `passedRequirementIds: []`, 0 verified records).
- Stray compiler emit: none in tracked or untracked source; build output remains confined to ignored `dist/`.
- Residual risk: a custom `fetch` must honor `redirect: manual` and return the actual final response URL semantics expected by the client; upstream proxies or adapters that rewrite Link headers or response URLs outside this process can change navigation before the client receives it. Cross-Origin Endpoint and Link targets still require the caller's egress policy to make the deployment-specific trust decision.

## Round 14

### PUB-0014 - accepted

- Requirement: the Publication client follows declared Endpoint/Link targets and MUST NOT guess any route path from `mounts[].baseUrl`; selected occurrence is `SPECIFICATION.md#colp-section-7`, `keywordOrdinal: 3`.
- First focused run: `npm test -- tests/client/pub-0014-no-baseurl-path-guess-contract.test.ts -- --reporter=verbose` - 1 file ran, 41 tests ran, 38 passed and 3 failed. The three failures were test false positives: two supplied Schema-invalid `baseUrl`/fixed query fixtures and one supplied an unregistered Snapshot query key; the real client correctly rejected all three before endpoint I/O.
- Acceptance repair: corrected those fixtures to valid trailing-slash Manifest `baseUrl` values and registered query contracts; added a production `PublicationTransportBoundary` that reduces `baseUrl` to frozen origin/scheme state only, rejects inherited/accessor/Proxy sources without getter/trap execution, binds the boundary to its selected Mount, and leaves routing dependent only on declared Endpoint/Link values. Publisher `baseUrl` behavior is untouched.
- Observable conditions: directory, collection, and snapshot targets preserve declared paths across deep/encoded/query-bearing base paths, same-Origin and cross-Origin endpoints; missing/invalid endpoints, 404/503, missing/malformed/duplicate/cursor-mismatched Links, redirect Location failures, duplicate query/cursor, cache 304/partition, cross-Origin, and HTTPS downgrade paths never synthesize conventional fallback URLs. Opaque frozen navigation and transport handles reject copies, accessors, Proxies, foreign Mounts, malicious base URLs, and mutation-based state changes without exposing route paths.
- Final focused run: the same command - 1 file passed, 42 tests passed, 0 failed.
- Client regression: `npm test -- tests/client -- --reporter=default` - 11 files passed, 321 tests passed, 0 failed.
- PUB-0002/0010/0013 regression: 3 files passed, 115 tests passed, 0 failed.
- Gates passed: `npm run typecheck`, `npm run build`, `npm run check:protocol`, `npm run check:requirements`, `npm run check:traceability`, `npm test -- tests/conformance/examples.test.ts` (28 tests), and `git diff --check`.
- Out-of-scope baseline gate: `npm run check:types` reports the pre-existing stale generated TypeScript contracts. No Schema, generated type, CORE test, server, publisher, sync, MCP, security, feed, adapter, or conformance-control behavior was changed.
- Registry and generated assets: canonical and fixture Registry map only `PUB-0014` to implementation `[client]` and test ID `http.no-baseurl-path-guess`; `PUB-0015` remains empty. `npm run sync:protocol`, `npm run generate:evidence:empty`, and `npm run generate:traceability` were rerun; canonical/fixture/generated requirements, empty evidence, and TRACEABILITY SHA-256 values were stable before and after generation. Evidence remains empty/unverified (`sourceRevision: unverified`, `passedRequirementIds: []`).
- Stray output: no tracked or untracked `dist/` compiler emit; build output remains confined to ignored `dist/`.
- Residual risk: a custom fetch/framework adapter remains responsible for preserving the declared request URL, final response URL, Link header, and redirect semantics. This client boundary cannot audit path rewriting performed outside the package.

## Round 15

### PUB-0015 - accepted

- Requirement: Publication HTML pages and HTTP responses SHOULD expose the two exact discovery hints from `SPECIFICATION.md#colp-section-7`: `<link rel="collection-protocol" href="/.well-known/collection-protocol">` and `Link: </.well-known/collection-protocol>; rel="collection-protocol"`. This advisory does not add a general HTML router or claim PUB-0016 and later requirements.
- Production files: `src/server/publication-discovery-links.ts`, `src/server/publication-manifest-discovery.ts`, and `src/server/index.ts` (minimal server export). The fixed HTML fragment is adapter-ready; the existing real Manifest discovery GET/HEAD response path emits exactly one case-preserved `Link` field.
- Observable conditions: one-shot and prevalidated handlers return identical frozen response metadata for exact GET/HEAD requests; HEAD suppresses only the body. Route misses remain `null` before Manifest validation, and malformed Manifest errors disclose neither hint nor caller data. Header merging copies only own enumerable string data properties, rejects Link duplicates case-insensitively, inherited/Proxy/accessor/symbol/control/non-string input without invoking attacker code, and returns isolated frozen null-prototype maps. Input is bounded to 128 source fields, 16 KiB per UTF-8 value, and 64 KiB aggregate source header bytes.
- First focused run: `npm test -- --run tests/server/pub-0015-discovery-link-contract.test.ts` - 1 file failed; 23 tests ran, 20 passed and 3 failed. All three were false-negative assertions: a Vitest asymmetric matcher was passed to identity comparison, and two cases incorrectly expected `Reflect.set` on frozen objects to throw instead of returning `false`.
- Acceptance repair: corrected those assertions, added explicit prevalidated-handler GET/HEAD coverage and frozen response checks, and added production resource limits with accepted/rejected boundary tests. No test was deleted, skipped, ignored, or weakened.
- Final focused run: `npm test -- tests/server/pub-0015-discovery-link-contract.test.ts` - 1 file passed, 26 tests passed, 0 failed.
- Complete server regression: `npm test -- tests/server` - 14 files passed, 705 tests passed, 0 failed.
- PUB-0011 regression: `npm test -- tests/server/pub-0011-manifest-discovery-contract.test.ts` - 1 file passed, 73 tests passed, 0 failed.
- Example validation: `npm test -- tests/conformance/examples.test.ts` - 1 file passed, 28 tests passed, 0 failed.
- Gates passed: `npm run typecheck`, `npm run build`, `npm run check:protocol`, `npm run check:requirements`, `npm run check:traceability`, and `git diff --check`.
- Out-of-scope baseline gate: `npm run check:types` reports the pre-existing stale generated TypeScript contracts. PUB-0015 changes no Schema or generated TypeScript type, so the forbidden baseline repair was not made.
- Registry and generated assets: canonical, fixture, and generated PUB-0015 map to implementation `[server]` and test ID `http.discovery-link`; PUB-0016 is registered to `[client, server]` and `http.utf8`, while PUB-0017 remains empty. `npm run sync:protocol`, `npm run generate:evidence:empty`, and `npm run generate:traceability` preserve the SHA-256 of canonical/fixture requirements, generated requirements, evidence, and TRACEABILITY.
- Bundled evidence remains empty/unverified (`sourceRevision: unverified`, `passedRequirementIds: []`, 0 verified records). No CORE, Schema, generated type, CORE test, client, sync, MCP, security, feed, publisher, adapter, conformance-control, or `src/server/json.ts` file changed.
- Residual risk: an HTTP framework adapter must preserve the returned case-insensitive header semantics and must insert the exported HTML fragment into actual HTML pages. Proxy/CDN layers outside this package can still strip, coalesce, or rewrite Link metadata.

### PUB-0016 - accepted

- Requirement: Publication requests and responses MUST use UTF-8.
- Production files: `src/server/publication-http-utf8.ts`, `src/server/publication-problems.ts`, `src/server/publication-manifest-discovery.ts`, `src/server/index.ts`, and `src/client/index.ts`. The transport helpers use fatal UTF-8 decoding, byte-based `Content-Length`, explicit UTF-8 request metadata, and charset rejection on client responses; Manifest and Problem responses share the byte-accurate JSON response path.
- Evidence: `tests/server/pub-0016-http-utf8-contract.test.ts` contains 31 passing tests covering ASCII, multibyte and supplementary-plane values, invalid/truncated bytes, request/response metadata, exact lengths, Manifest/Problem responses, route and size boundaries, and detached handler snapshots. Every test name carries `[evidence:http.utf8]`.
- Gates passed: focused PUB-0016 (31), PUB-0008/PUB-0011/PUB-0015 regression (154), all `tests/server` (736), `npm run typecheck`, `npm run build`, `npm run check:protocol`, `npm run check:requirements`, `npm run check:traceability`, and `git diff --check`.
- Bundled evidence remains empty/unverified. PUB-0017 remains `implementation: []` and `tests: []`; no CORE, Schema, generated type, sync, MCP, security, feed, publisher, adapter, or `src/server/json.ts` files changed.

## Round 16

### PUB-0017 - accepted

- Production boundary: `src/server/publication-http-utf8.ts` now decodes UTF-8 JSON with the existing read-only `parseIJson` contract, rejecting duplicate members and unsafe/non-finite numbers before Publication dispatch. Response serialization first applies the existing strict JSON-data clone, preventing non-finite or unsafe numeric values from being silently coerced by `JSON.stringify`.
- Client response path remains CORE-owned and already uses `validateWireJsonDocument`/`parseIJson`; no client, CORE, Schema, generated type, test, or `src/server/json.ts` changes were made.
- Verification: `npm run typecheck`, `npm run build`, and existing `tests/server/pub-0016-http-utf8-contract.test.ts` plus `tests/server/pub-0008-problem-details-contract.test.ts` passed (86 tests).
- Evidence remains empty/unverified. Canonical, fixture, and generated Registry entries map PUB-0017 to implementation `[server]` and test ID `http.i-json`; PUB-0018 remains empty.

### PUB-0018 - accepted

- Original satisfy commit: `4ceaa260` (`feat(colp): satisfy PUB-0018 endpoint DTO validation`). The original focused baseline passed 1 file / 16 tests. Acceptance expanded `tests/server/pub-0018-endpoint-dto.test.ts` to 45 tests covering the complete Publication Registry mapping (`directoryQuery` / `collectionDirectory`, `collectionMetadata`, `snapshotQuery` / `snapshot`, and `nodeDetailQuery` / `nodeDetail`), exact named-validator selection, normal/negative/boundary cases, undefined DTO paths, root-schema-valid cross-endpoint impostors, and non-reflecting failures.
- The expanded pre-repair run failed 5 / passed 40 (45 total): `publicationOperation` selected only by endpoint and method, exposing publisher DTOs for `directory POST`, `collection PATCH` / `DELETE`, and `node PATCH` / `DELETE`. The repair now requires `candidate.profile === 'publication'` before method selection, preserving every legitimate Publication operation while returning the existing stable, non-reflective missing-contract error for non-Publication operations. Every Publication Query/request/response path therefore selects only its Registry-named `$defs`; the root Schema `anyOf` is never substituted.
- Registry mapping remains implementation `[client, server]` and test ID `http.endpoint-dto`; canonical, fixture, generated Registry, evidence, Schema, semantic, protocol, and Registry sources are unchanged. Evidence remains empty/unverified. The acceptance repair changes only the Publication DTO implementation, the focused PUB-0018 test, and this PUB-0018 progress entry; it is recorded by this correction commit.
- Verification: final focused passed 45/45; all client/server tests passed 1,883/1,883; the complete Schema suite plus Publication endpoint-driven client/server regressions passed 317/317 (and Schema plus focused passed 343/343); protocol examples passed 28/28 (27 examples, 55 required contracts, 3 semantic checks, 17 negative assertions). `npm run typecheck`, `npm run build`, `check:protocol`, `check:requirements`, `check:traceability`, `git diff --check`, and the forbidden-path audit passed. `check:types` retains the unchanged repository baseline failure (`Generated TypeScript contracts are stale`); generated contracts and their inputs were not modified.

## Round 17

### PUB-0019 - accepted

- Original satisfy commit: `dd15a54` (`feat(colp): satisfy PUB-0019 application JSON support`). The unchanged focused test passed 1 file / 11 tests. Acceptance expanded `tests/client/pub-0019-application-json.test.ts` across the real `ColpClient` Manifest, Directory, Collection Metadata, and Snapshot receive paths; `ColpClient` exposes no Publication Node Detail read method. Coverage now includes case-insensitive `application/json`, UTF-8 charset quoting and whitespace, missing-header compatibility, duplicate/ambiguous/unknown/malformed parameters, wrong and non-UTF-8 media declarations, fatal wire UTF-8, Problem media separation, relevant production I-JSON failures, non-reflective errors, cross-Origin credential/header behavior, and one regression preserving PUB-0020's existing vendor catalog contract.
- The expanded pre-repair run passed 31 and failed 6 of 37 tests. Four failures reproduced the implementation defect: malformed UTF-8 embedded inside otherwise valid JSON strings was decoded with replacement characters and accepted by successful Manifest, Directory, Collection Metadata, and Snapshot responses because `validUtf8` was checked only on the Problem branch. The other two failures corrected acceptance-test assumptions (a string `Response` synthesizes `text/plain;charset=UTF-8` when `Content-Type` is omitted, and the package's current I-JSON contract does not reject an escaped lone surrogate). The repaired focused suite is 36/36.
- The shared Publication client response path now rejects non-UTF-8 bytes immediately after bounded body reading and before Manifest pre-inspection, I-JSON parsing, schema validation, caching, or return. Successful failures retain the requested response definition and stable non-reflective parse error; unsuccessful responses retain the established `problem` definition and Problem Details error framing. The existing media parser and PUB-0020 vendor behavior were not broadened.
- Registry mapping remains implementation `[client]` and test ID `http.application-json`; canonical protocol, Registry, generated evidence, traceability, Schema, semantic/core tests, server, publisher, sync, MCP, security, feed, and generated types are unchanged. Evidence remains empty/unverified.
- Verification: final focused passed 36/36; related media, Problem, I-JSON, egress, endpoint, transport, and resource tests passed 228/228; all client tests passed 479/479; all client and server tests passed 1,908/1,908; protocol examples passed 28/28. `npm run typecheck`, `npm run build`, `check:protocol`, `check:requirements`, `check:traceability`, `git diff --check`, and the forbidden-path audit passed. `check:types` retains the unchanged repository baseline failure (`Generated TypeScript contracts are stale`); generated contracts and their inputs were not modified.

## Round 18

### PUB-0020 - implemented

- Added strict Publication vendor JSON media normalization in `src/client/publication-media.ts` and wired the real `ColpClient` response path. Declared `manifest`, `catalog`, `collection`, `snapshot`, `node`, and `problem` tokens require `version=0.1`; unknown resources, alternatives, weights, duplicate parameters, and non-UTF-8 charsets fail closed. Requests retain the baseline `Accept: application/json` for cache compatibility, while successful responses may use the registered vendor representation.
- Registry mapping: implementation `[client]`; test ID `http.vendor-json` (evidence remains empty/unverified).
- Verification: `npm run typecheck`; focused `tests/client/pub-0019-application-json.test.ts` and `tests/client/pub-0020-vendor-json.test.ts` passed (27 tests). PUB-0021 remains unchanged; no ETag/Vary/Last-Modified behavior added.

## Round 21

### PUB-0021 - accepted

- Added `src/server/publication-http-headers.ts` and exported it from the server entry point. `createPublicationRepresentationHttpHeaders` reuses the concrete representation ETag contract and emits a strong quoted `ETag` plus second-precision IMF-fixdate `Last-Modified`, while preserving caller headers and rejecting unsafe input before constructing `Headers`.
- ETag variation covers representation bytes, revision, projection, decoded query, pagination/page identity, negotiated media type, protocol version, and snapshot identity; PUB-0022 `If-None-Match` behavior remains unimplemented.
- Registry mapping: implementation `[server]`; test ID `http.validators`. Evidence remains empty/unverified.
- Verification: focused `tests/server/pub-0021-http-validators.test.ts` (16), PUB-0006 regression (103), all `tests/server` (784), typecheck, build, protocol, requirements, traceability, and diff-check passed.

## Round 22

### PUB-0022 - implemented

- Added the Publication-specific `validatePublicationIfNoneMatchEtag` boundary and wired the real `ColpClient` GET path. Cached validators and response ETags must be single strictly quoted entity-tags without CRLF or list delimiters; matching `304` responses return a detached cached representation, while missing or mismatched cache state fails closed. Existing origin credential isolation, egress authorization, and manual redirect handling remain unchanged.
- Registry mapping: implementation `[client]`; test ID `http.conditional`. Evidence remains empty/unverified. PUB-0023 and PUBLISH precondition entries remain unchanged.
- Verification: `npm run typecheck` and `npm run build`.

## Round 23

### PUB-0023 - accepted

- Requirement: Authorization-varying responses use `Cache-Control: private, no-store` and `Vary: Authorization`; anonymous public representations may remain eligible for shared caching.
- Production file: `src/server/publication-cache-policy.ts` (existing Publication cache-policy boundary; exported from `src/server/index.ts`). Authorization-varying responses replace caller cache directives with the mandatory private policy and merge `Authorization` into existing `Vary` fields without duplication; anonymous-public responses retain validated caller cache directives.
- Test file: `tests/server/pub-0023-authorization-cache-contract.test.ts` (18 tests; evidence ID `http.cache.authorization`).
- Verification: focused PUB-0023 (18), PUB-0007 regression (60), all server tests (802); `npm run typecheck`, `npm run build`, `npm run check:protocol`, `npm run check:requirements`, `npm run check:traceability`, and `git diff --check` passed.
- Registry mapping: canonical and mirrored entries map PUB-0023 to implementation `[server]` and test ID `http.cache.authorization`; generated requirements were refreshed by the protocol sync/check flow. Evidence remains empty/unverified.
- Scope: no CORE, Schema, generated type, client, sync, MCP, security, feed, publisher, adapter, or conformance-control behavior changed. No protocol correction.
- Residual risk: framework adapters must select `authorization-varying` whenever Authorization changes a representation and preserve the returned headers for every response status.

## Round 24

### PUB-0024 - accepted

- Requirement: media-type or protocol-version negotiated Publication responses merge `Vary: Accept, Collection-Protocol-Version` without overwriting existing `Authorization`, `Origin`, or other field names.
- Production files: `src/server/publication-http-headers.ts` applies the negotiated response boundary; `src/server/publication-vary.ts` centralizes validated, case-insensitive Vary merging and preserves standalone wildcard semantics; `src/server/publication-cache-policy.ts` reuses the helper without changing the PUB-0023 cache policy.
- Test files: `tests/server/pub-0024-vary-negotiation-contract.test.ts` (22 tests; evidence ID `http.vary.negotiation`) and the updated PUB-0021 preservation regression expectation.
- Verification: focused PUB-0024 (22), PUB-0021/PUB-0023 regressions (34), all server tests (824); typecheck, build, protocol, requirements, traceability, and diff checks passed.
- Registry mapping: canonical and mirrored entries map PUB-0024 to implementation `[server]` and test ID `http.vary.negotiation`; generated requirements and traceability were refreshed by package scripts. Bundled evidence remains empty/unverified.
- Scope: no CORE, Schema, generated type, client, sync, MCP, security, feed, publisher, adapter, or conformance-control behavior changed. No protocol correction.
- Residual risk: framework adapters must preserve the returned negotiated headers on every response status, including denials, concealment, no-content, and not-modified responses.

## Round 25

### PUB-0025 - accepted

- Requirement: the final public projection removes native source identifiers, profile IDs, local paths, non-anonymous annotations and attachments, ACL principal internal IDs, credentials other than key hints, private Sync conflict versions, non-public crawled bodies, and extensions outside the exact public-safe namespace allowlist.
- Production files: `src/server/publication-public-projection.ts` adds a detached, deeply frozen, fail-closed projection boundary with exact extension allowlisting, stable non-reflective errors, cycle/accessor/proxy/symbol/sparse-array rejection, and configurable depth/node budgets; `src/server/index.ts` exports it.
- Test file: `tests/server/pub-0025-public-projection-safety-contract.test.ts` (23 tests; evidence ID `projection.public-safety`). Coverage includes deep arrays, public/unlisted versus protected/private visibility, safe `sourceRefs` field preservation, secret and conflict redaction, exact namespace matching, hostile object shapes, resource limits, detachment, and over-redaction guards.
- Verification: focused PUB-0025 (23), Publication server regressions (756), all server tests (847); typecheck, build, protocol, requirements, traceability, and diff checks passed.
- Registry mapping: canonical and mirrored entries map PUB-0025 to implementation `[server]` and test ID `projection.public-safety`; generated requirements and traceability were refreshed by package scripts. Bundled evidence remains empty/unverified.
- Scope: no CORE, Schema, generated type, client, sync, MCP, feed, publisher, adapter, or conformance-control behavior changed. No protocol correction.
- Residual risk: framework adapters must invoke this boundary only after collection/ancestor authorization and before serialization, caching, feeds, or assistant delivery.

## Round 26

### PUB-0026 - accepted

- Requirement: HTTP clients send exactly one `Collection-Protocol-Version` request header containing the configured supported version (`0.1`).
- Production file: `src/client/index.ts`. The shared request-header boundary applies the protocol version after static, provider, and operation headers on every concrete fetch hop, including Manifest discovery, declared endpoints, pagination, conditional requests, and manual redirects. Cross-origin hops retain only the protocol header and explicitly authorized provider output while static/operation credentials remain isolated and browser credentials use `omit`.
- Hardening: unsupported configured versions and malformed static/provider/operation header input fail before fetch with stable non-reflective errors. Caller-controlled header sources cannot override or duplicate the protocol version.
- Test file: `tests/client/pub-0026-protocol-version-request-contract.test.ts` (evidence ID `http.protocol-version-request`).
- Registry mapping: implementation `[client]`; test ID `http.protocol-version-request`. Bundled evidence remains empty/unverified.

## Round 27

### PUB-0027 - accepted

- Requirement: Manifest GET and HEAD responses advertise cacheable, versioned representation metadata with `Cache-Control: public, max-age=300`, a strong representation-specific `ETag`, and `Content-Type: application/vnd.collection-protocol.manifest+json;version=0.1`.
- Production file: `src/server/publication-manifest-discovery.ts`. The existing strict discovery handlers retain their signatures, exact route and method behavior, canonical Manifest body, `Link`, and byte-accurate `content-length`; GET and HEAD expose identical headers while HEAD omits only the body.
- Test file: `tests/server/pub-0027-manifest-response-metadata-contract.test.ts` (13 tests; evidence ID `http.manifest-response-metadata`). Existing PUB-0011, PUB-0015, PUB-0016, and PUB-0020 Publication assertions were updated to require the new exact metadata rather than the superseded generic JSON header set.
- Verification: focused PUB-0027 (13), Publication regressions (130), all server tests (860); typecheck, build, protocol, requirements, traceability, and diff checks passed.
- Registry mapping: implementation `[server]`; test ID `http.manifest-response-metadata`. Bundled evidence remains empty/unverified.
- Scope: no CORE, Schema, generated type, client, sync, MCP, security, feed, publisher, adapter, or conformance-control behavior changed. No protocol correction.
- Residual risk: deployment adapters must forward the complete generated header map without replacing the vendor media type, validator, cache policy, or discovery `Link`.

## Round 28

### PUB-0028 - accepted

- Requirement: Publication `baseUrl` is display and same-Origin metadata only, its path must end in `/`, and the client never concatenates or relatively resolves it to invent an endpoint.
- Production file: `src/client/publication-transport-boundary.ts`. The existing opaque transport boundary now rejects a base path without the mandatory trailing slash before endpoint I/O while retaining only frozen Origin/scheme policy state; routing remains sourced exclusively from selected Manifest Endpoint declarations, response Links, and redirect Locations.
- Test file: `tests/client/pub-0028-baseurl-display-origin-only-contract.test.ts` (27 tests; evidence ID `http.baseurl-display-origin-only`). Coverage includes same- and cross-Origin declared endpoints, exact opaque pagination Links, deep/encoded/query/fragment display paths, missing/relative/invalid endpoints, HTTP errors, pagination and redirect failures, exact cache/conditional variants, hostile accessors/Proxies/credentialed/non-loopback values, non-reflective errors, and mutation/snapshot isolation.
- First focused run: 27 tests ran, 26 passed and 1 failed. The failure was a test-fixture scope mismatch: the first page declared `complete=false` while the requested logical query selected a complete Snapshot, so the client correctly rejected it before Link following.
- Acceptance repair: retained the complete Snapshot projection across both pages, matching the declared request while preserving the opaque cross-Origin Link assertion. No test was deleted, skipped, ignored, or weakened.
- Final focused run: 27 tests passed, 0 failed. Related PUB-0002/0004/0010/0013/0014/0022 and egress regressions passed (7 files, 190 tests).
- Registry mapping: implementation `[client]`; test ID `http.baseurl-display-origin-only`. Bundled evidence remains empty/unverified.
- Scope: no CORE, Schema, generated TypeScript type, server, publisher, adapter, sync, MCP, security, feed, or conformance-control behavior changed. No protocol correction.

## Round 30

### PUB-0030 - accepted

- Requirement: the five anonymous discovery channels share a pre-pagination boundary that excludes every non-public visibility and supplies exact `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer` response policy fields.
- Production files: `src/server/publication-discovery.ts` and `src/server/index.ts`. Public values are validated after detachment, deeply frozen, issued with channel/validator provenance, constrained by exact page/cursor shapes, and revalidated by the final output guard. Hidden malformed values short-circuit after their own visibility data property. Header inputs are copied, bounded, case-insensitively merged, and rejected on malformed shape, CR/LF/NUL, or UTF-8 size limits with fixed non-reflective errors.
- Test file: `tests/server/pub-0030-unlisted-discovery-controls-contract.test.ts` (63 tests; evidence ID `http.unlisted-discovery-controls`).
- First focused PUB-0030 plus PUB-0009 run: 131 tests, 123 passed and 8 failed. Two failures exposed real header error-classification defects. Six were rejected false positives: five expected one validator call despite the final detached-output guard, and one assumed `Object.freeze(Headers)` freezes its internal mutable header list.
- Acceptance repair: fixed both classifications, strengthened exact page/array and UTF-8 byte boundaries, and tested defensible fresh-copy `Headers` isolation. Final focused run: 136 passed. All server tests: 24 files, 923 passed. Typecheck, build, protocol, requirements, traceability, and diff checks passed.
- Registry mapping: implementation `[server]`; test ID `http.unlisted-discovery-controls`. Generated traceability is current; bundled evidence remains empty with 0 verified records.
- Scope: no CORE, feed, MCP, publisher, sync, forbidden profile, or global progress changes.

## Round 29

### PUB-0029 - accepted

- Requirement: Publication endpoints are absolute HTTPS URIs or RFC 6570 Level 1 templates; plain HTTP is accepted only for the literal `localhost`, `127.0.0.1`, and `[::1]` authorities, with optional ports.
- Production files: `src/semantic/publication-endpoint-templates.ts` and `src/client/publication-endpoints.ts`. Raw declarations are checked before URL normalization, expanded URLs are checked again before navigation, and failures use stable non-reflective transport errors.
- Test file: `tests/client/pub-0029-endpoint-transport-safety-contract.test.ts` (57 tests; evidence ID `http.endpoint-transport-safety`). Coverage includes HTTPS ports and queries, exact loopback HTTP, disguised and alternative-number loopback forms, non-loopback IPv4/IPv6, user information, schemes, relative references, unsupported template operators/modifiers, host variables, fragments, malformed and duplicate variables, pre-fetch rejection, and exact cross-origin preservation.
- First focused run: 56 tests ran, 50 passed and 6 failed. Literal fragments and duplicate variables escaped declaration validation, a discarded fragment reached endpoint I/O, and the positive cross-origin fixture used an unregistered fixed query key.
- Acceptance repair: fragments and duplicate variables are rejected at the raw declaration boundary, fragments cannot be cleared before concrete URL validation, variable authorities are rejected, and the positive fixture uses the registered `tag` query field without weakening Publication query contracts.
- Final focused run: 57 tests passed, 0 failed. Bundled evidence remains empty/unverified.
- Scope: no CORE, Schema, generated TypeScript type, server, publisher, adapter, sync, MCP, security, feed, or conformance-control behavior changed. No protocol correction.

## Round 31

### PUB-0031 - accepted

- Requirement: `protected` collections MAY appear in Directory only after an explicit authorization decision.
- Production files: `src/server/publication-authorized-directory.ts` adds the authorization-aware Directory boundary; `src/server/index.ts` exports it. Public records bypass authorization, protected records require an exact boolean `true`, and unlisted/private records are excluded before cloning, canonical validation, or predicate invocation. Selection precedes query, sorting, cursor, and pagination; opaque selection/page provenance, final visibility guards, canonical schema validation, bounded JSON inspection, detachment, deep freezing, and fixed non-reflective errors fail closed. Authorization-varying responses use `Cache-Control: private, no-store` and merge `Authorization` into `Vary` while preserving existing `Origin` and `Accept` fields.
- Test file: `tests/server/pub-0031-protected-authorization-contract.test.ts` (31 tests; evidence ID `http.directory.protected-authorization`). Coverage includes public bypass, exact true/false decisions, throwing/non-boolean predicates, hidden early exclusion, selection ordering, provenance and identity, canonical validation, limits, hostile shapes, detachment/freezing, cache metadata, and PUB-0009/PUB-0023/PUB-0030 regressions.
- First focused run: 31 tests ran, 30 passed and 1 failed because the fixture used non-schema `metadata` on a DirectoryCollection.
- Acceptance repair: changed only that fixture to canonical `extensions`; no assertions were removed or weakened. Final focused run: 31 passed. Combined PUB-0009/PUB-0023/PUB-0030/PUB-0031 regressions: 185 passed. All server tests: 25 files, 954 passed. Typecheck, build, protocol, requirements, traceability, and diff checks passed.
- Registry mapping: canonical and mirrored registries map PUB-0031 to implementation `[server]` and test ID `http.directory.protected-authorization`; generated traceability is current. Bundled evidence remains empty/unverified (0 verified records).
- Scope: no CORE, schema, generated types, client, sync, MCP, security, feed, publisher, adapter, or conformance-control behavior changed. No protocol correction.

## Round 32

### PUB-0032 - accepted

- Requirement: successful Collection Metadata GET and HEAD responses SHOULD expose the body-declared `self`, `canonical`, `snapshot`, optional Collection feed, and optional JSON Feed or Atom alternate targets through exact RFC 8288 `Link` relations and media types.
- Production files: `src/server/publication-collection-metadata-links.ts` adds a canonical Collection Metadata response boundary and `src/server/index.ts` exports it. The boundary validates and snapshots the complete wire document, preserves absolute same- and cross-Origin targets byte-for-byte, merges safe existing Links, deduplicates exact generated relations, rejects exclusive relation conflicts and hostile input, preserves unrelated Link metadata on errors while removing success-resource relations, and maintains GET/HEAD header parity plus caller cache, Vary, Origin, and other headers.
- Test file: `tests/server/pub-0032-collection-metadata-link-header.test.ts` (58 expanded tests; evidence ID `http.collection-metadata-link-header`). The initial run executed 55 tests: 54 passed and 1 failed because the cross-Origin assertion incorrectly expected unrelated body links such as `nodes` and `releases` in the Section 4 header. The repaired assertion checks only the five specified relation families and explicitly guards against fabricating the unrelated links.
- Acceptance hardening: added canonical `collectionMetadata` schema validation, case-insensitive registered relation conflict detection, safe unrelated-Link preservation on error responses, a 4096-character schema-aligned URL ceiling, and regressions for error header preservation and incomplete bodies.
- Final focused run: 58 passed, 0 failed. Registry mapping uses implementation `[server]` and test ID `http.collection-metadata-link-header`; generated requirements and traceability are refreshed. Bundled evidence remains empty/unverified.
- Baseline gate: `npm run check:types` still reports stale generated TypeScript contracts, but both `src/schema/generated/collection-protocol.schema.json` and `src/types/generated.ts` have blob hashes identical to `HEAD` and no diff in this requirement; the forbidden generated type contract was not modified to mask the pre-existing drift.
- Scope: no CORE behavior/tests/Registry/spec/schema/generated types, client, sync, MCP, security, feed, publisher, adapter, or global progress changes. No protocol correction.
- Residual risk: deployment adapters must forward the returned `Headers` without rewriting Link targets or dropping representation/cache/Vary/origin metadata.

## Round 33

### PUB-0033 - accepted

- Requirement: every page in a paginated Publication Snapshot series corresponds to one `snapshotId`, `revision`, `mode`, effective Principal, and decoded logical query scope.
- Production files: `src/server/publication-snapshot-page-series.ts` adds an opaque page-series capability and detached output guard; `src/server/index.ts` exports it. The boundary snapshots ordinary canonical caller values, validates each page and decoded `snapshotQuery`, fixes the five required identities, canonicalizes the `include` set, excludes only a validated continuation `pageCursor` from logical identity, and fails closed with stable non-reflective errors.
- Test file: `tests/server/pub-0033-snapshot-page-consistency-contract.test.ts` (52 final tests; evidence ID `http.snapshot.page-consistency`). The first unchanged 51-test run passed 48 and failed 3 because limit errors were asserted as `TypeError`. Independent acceptance also rejected two false-positive constraints: requiring inputs to be pre-deep-frozen was unsuitable for production adapters, and duplicate `include` entries are schema-invalid rather than an equivalent decoded set.
- Acceptance repair: canonical mutable snapshots/scopes are safely copied without invoking accessors; hostile Proxies, accessors, cycles, symbols, sparse arrays, invalid prototypes, malformed UTF-16, schema-invalid queries, and bounded-resource abuse remain rejected. Principal and query/cache variants are isolated, mismatches release no output, and later valid pages remain releasable. No PUB-0034 Link generation, page sequencing, `snapshot_expired`, or single-page policy was added.
- Verification: final focused PUB-0033 passed 52; combined PUB-0004 server/client, PUB-0005 client/semantic, PUB-0021, PUB-0023, PUB-0024, and PUB-0028 regressions passed 247; all server tests passed 1,064; examples passed 28. Typecheck, build, protocol, requirements, traceability, and diff checks passed.
- Registry mapping: canonical and mirrored registries map PUB-0033 to implementation `[server]` and test ID `http.snapshot.page-consistency`; generated requirements and traceability are current. Bundled evidence remains `sourceRevision: unverified` with no passed requirement IDs.
- Baseline gate: `npm run check:types` still reports stale generated TypeScript contracts. Both `src/schema/generated/collection-protocol.schema.json` and `src/types/generated.ts` are byte-identical to `HEAD`; forbidden generated types were not changed to conceal the pre-existing drift.
- Scope: no CORE behavior/tests/Registry/spec/schema/generated types, client, sync, MCP, security, feed, publisher, adapter, global progress, or other requirement mapping changed.
- Residual risk: deployment adapters must derive the effective Principal and pass the already-decoded canonical Snapshot query into this boundary for every emitted page.

## Round 34

### PUB-0034 - accepted

- Requirement: when another Publication Snapshot page exists, the response should carry exactly one server-provided `Link: <...pageCursor=...>; rel="next"`; clients follow that target and do not construct a Cursor URL.
- Production files: `src/server/publication-snapshot-next-link.ts` adds the bounded Snapshot GET/HEAD response boundary and `src/server/index.ts` exports it. The boundary validates the complete publication Snapshot, requires the `hasMore` / `nextCursor` / `nextUrl` state matrix, checks exactly one matching decoded `pageCursor`, preserves the supplied absolute or relative HTTP(S) URI reference byte-for-byte, permits plain HTTP only for the established loopback policy, safely merges or rejects existing `Link` relations, removes stale success continuations from errors, and preserves unrelated response metadata. The API exposes only `nextUrl`; the redundant `serverNextUrl` spelling was rejected as ambiguous.
- Test files: `tests/server/pub-0034-snapshot-next-link-contract.test.ts` and `tests/client/pub-0034-snapshot-next-link-regression.test.ts` (71 final tests; evidence ID `http.snapshot.next-link`). The first unchanged run executed 63 tests: 60 passed and 3 failed. Two failures were invalid tests (a matcher applied to `null`, and schema-invalid `+` characters in an opaque Cursor); the client fixture failed for the same invalid Cursor. Acceptance repair corrected those fixtures and added relative-reference, authority, transport-policy, header-boundary, and unambiguous-option coverage without weakening the required behavior.
- Client proof: the real `ColpClient` follows the exact opaque cross-Origin Link target, issues no guessed `pageCursor` request, does not reuse the first-page validator for the second page, and keeps the two representations in distinct cache entries. Existing PUB-0013 relative-Link behavior remains supported.
- Verification: final focused PUB-0034 passed 71; relevant PUB-0002/0004/0005/0013/0022/0023/0024/0028/0032/0033 regressions passed 412; all server and client tests passed 1,588; examples passed 28. Typecheck, build, protocol, requirements, traceability, and diff checks passed.
- Registry mapping: canonical and mirrored registries map PUB-0034 to implementation `[server, client]` and test ID `http.snapshot.next-link`; generated requirements and traceability are current. Bundled evidence remains `sourceRevision: unverified` with no passed requirement IDs.
- Baseline gate: `npm run check:types` still reports stale generated TypeScript contracts. `src/schema/generated/collection-protocol.schema.json` (`1667bac1bfc4a87c4a65fbb21fda418a912054b7`) and `src/types/generated.ts` (`5c5cbaef6063842bf9786c4cbea9d66b8011169d`) are identical to `HEAD`; forbidden generated types were not changed.
- Scope: no CORE behavior/tests/Registry/spec/schema/generated types, sync, MCP, security, feed, publisher, adapter, global progress, other requirement mapping, PUB-0033 behavior, PUB-0035 sequencing, expiration, or single-page policy changed.
- Residual risk: deployment adapters must provide the already-generated continuation URI reference and forward the returned headers without rewriting signed or otherwise opaque target bytes.

## Round 35

### PUB-0035 - accepted

- Requirement: static Collections and dynamic Collections whose complete authoritative Snapshot is at or below both configured small thresholds prefer a single terminal page with `complete=true`, `sequence=1`, `hasMore=false`, `nextCursor=null`, and no `rel=next`.
- Production files: `src/server/publication-snapshot-delivery-policy.ts` adds an adapter-facing classification and delivery boundary; `src/server/index.ts` exports it. The boundary validates only canonical decoded `snapshotQuery` values, recognizes the complete include set independent of order, measures the actual serialized UTF-8 representation and detached JSON object graph, enforces exact small and hard ceilings, and keeps classification as storage/service trust rather than request input. Dynamic representations over either small limit are handed to the existing pagination adapter; static representations remain single-page up to the hard safety ceiling.
- Acceptance repair: the initial implementation returned `preserve-page` for an authoritative static/small request when the adapter supplied an incomplete or already paged Snapshot, silently defeating the SHOULD. Such input now throws a stable `PublicationSnapshotAdapterContractError` with non-reflective code `publication_snapshot_adapter_noncompliance`; only explicitly cropped queries may preserve an existing canonical page. Additional tests cover escaped controls, multibyte keys, astral UTF-8, and exclusion of Principal/endpoint hints from policy input.
- Response contract: the single-page GET/HEAD helper composes the PUB-0034 response boundary with `nextUrl=null`, preserving caller cache, `Vary`, `Origin`, validator, and unrelated safe Link metadata while removing stale continuations from error responses. Acceptance re-review reproduced that a structurally forged `single-page` object bypassed planning; response authority is now an opaque nominal plan backed by module-local issued-object identity. Exact issued frozen plans remain reusable, while forged, copied, thawed/mutated, proxied, `paginate`, and `preserve-page` plans fail closed. It does not alter PUB-0005 replacement, PUB-0033 page-scope, or PUB-0034 continuation behavior.
- Test file: `tests/server/pub-0035-snapshot-single-page-preference.test.ts` (49 final tests; evidence ID `http.snapshot.single-page-preference`). The unchanged re-review baseline passed 48/48; the added negative regression reproduced the bypass at 48 passed/1 failed; the repaired final focused run passed 49/49. Related PUB-0005 client/semantic, Snapshot completeness client, PUB-0021/0023/0024, and PUB-0033/0034 regressions passed 231/231 (280/280 with focused); all 29 server files passed 1,183/1,183; examples passed 28/28.
- Registry mapping: canonical and mirrored registries map only PUB-0035 to implementation `[server]` and test ID `http.snapshot.single-page-preference`; generated requirements and traceability are current. Bundled evidence remains `sourceRevision: unverified` with no passed requirement IDs.
- Verification: typecheck, build, protocol, requirements, traceability, examples, and diff checks passed. The baseline `check:types` still reports stale generated TypeScript contracts; `src/schema/generated/collection-protocol.schema.json` (`1667bac1bfc4a87c4a65fbb21fda418a912054b7`) and `src/types/generated.ts` (`5c5cbaef6063842bf9786c4cbea9d66b8011169d`) are byte-identical to `HEAD` and were not changed.
- Scope: no CORE behavior/spec/schema/generated types/tests/Registry/conformance semantics, client, sync, MCP, security, feed, publisher, adapter, `server/json.ts`, global progress, other requirement mapping, or PUB-0005/0033/0034 behavior changed.
- Residual risk: deployment adapters must provide a complete authoritative Snapshot before invoking the policy, pass an issued single-page plan directly within the same loaded module instance, and handle `paginate` through the existing PUB-0033/PUB-0034 page-series and Link contracts; plans are intentionally not transferable through serialization, object copying, or duplicate package instances.

## Round 36

### PUB-0036 - accepted

- Requirement: static Publication mode MUST declare `profiles=["core", "publication"]`, adding `feed` when Feed is provided.
- Production file: `src/server/publication-static-manifest-profiles.ts`, exported from `src/server/index.ts`. The boundary snapshots and validates the complete canonical Manifest, checks exact ordered profiles per selected Mount, derives Feed provision from the three coherent endpoint/feature signals, isolates Mount selection, rejects hostile shared/cyclic/accessor/Proxy/sparse/symbol/control-bearing input, and enforces depth, value, and UTF-8 byte limits. Array inspection is bounded and linear. The returned `unverifiedCanonicalCandidate` is explicitly a detached candidate and never a verified profile claim or replacement for `assertProfileClaims`.
- Test file: `tests/server/pub-0036-static-manifest-profile-declaration.test.ts` (57 final tests; evidence ID `manifest.static-profile-declaration`). Initial unchanged run: 49 tests, 48 passed and 1 timed out in the broad resource-exhaustion case. Acceptance repair split the limit cases, added exhaustive `selectedMountIds` coverage, and proved the unverified candidate naming and claim boundary. Final focused run: 57 passed.
- Registry mapping: canonical and mirrored registries map only PUB-0036 to implementation `[server]` and test ID `manifest.static-profile-declaration`; generated requirements and traceability are current. Bundled evidence remains `sourceRevision: unverified` with no passed requirement IDs.
- Verification: required Manifest regressions and package status passed 187 tests; all server tests passed 1,240; typecheck, build, protocol, requirements, traceability, examples (28), and diff checks passed. `check:types` remains a pre-existing stale generated-contract baseline; generated schema/types hashes are unchanged from HEAD.
- Scope: no CORE claim/evidence/conformance/supportedProfiles/Manifest Schema/semantic/generated types/tests, other profile, global progress, or unrelated mapping changes. No protocol correction.
- Residual risk: adapters must still call the existing claim gate before publishing any profile claim; this helper only validates a static declaration and deliberately carries no runtime authorization capability.

## Round 37

### PUB-0037 - accepted

- Requirement: static Publication Manifest endpoints MUST contain the real absolute static file URLs/Templates; clients do not infer paths from `baseUrl`.
- Production file: `src/server/publication-static-endpoints.ts`, exported from `src/server/index.ts`. The boundary snapshots one selected Mount, binds directory/collection/snapshot variables through the existing Endpoint Contract Registry, enforces the exact static file layouts, and validates coherent optional instance/collection Feed declarations, profile, and feature. It accepts HTTPS and exact loopback HTTP, rejects relative or inferred paths, arbitrary layouts, query/fragment/userinfo, unsafe or duplicate/host variables, non-loopback HTTP, encoded path tricks, accessors, Proxies, cycles, sparse arrays, symbols, and bounded hostile graphs. Results are detached and frozen.
- Acceptance repair: the initial unchanged focused run executed 28 tests: 24 passed and 4 failed. Static validation accepted an encoded path and unclaimed Feed endpoints; two tests also conflicted with established contracts by placing loopback HTTP beneath an HTTPS transport boundary and by expecting the generic dynamic endpoint mapper to enforce static layouts. The implementation now compares original path text and enforces three-way Feed coherence. The tests preserve the transport and generic endpoint contracts while exercising the static boundary directly.
- Client proof: two isolated Mounts resolve their distinct cross-host declared directory files exactly; neither request target contains the Mount's unrelated `baseUrl` root. Valid registered Collection variables expand through the existing client resolver without changing client behavior.
- Test file: `tests/server/pub-0037-static-endpoint-declarations.test.ts` (29 final tests; evidence ID `manifest.static-endpoint-declarations`). Final focused run passed 29; required PUB-0001/0003/0011/0012/0027 and package-status regressions passed 216 including focused; all 31 server files passed 1,269; examples passed 28.
- Registry mapping: canonical and mirrored registries map only PUB-0037 to implementation `[server]` and test ID `manifest.static-endpoint-declarations`; generated requirements and traceability are current. Bundled evidence remains `sourceRevision: unverified` with no passed requirement IDs.
- Verification: typecheck, build, protocol, requirements, traceability, examples, and diff checks passed. The baseline `check:types` still reports stale generated TypeScript contracts; `src/schema/generated/collection-protocol.schema.json` (`1667bac1bfc4a87c4a65fbb21fda418a912054b7`) and `src/types/generated.ts` (`5c5cbaef6063842bf9786c4cbea9d66b8011169d`) are byte-identical to `HEAD` and were not changed.
- Scope: no CORE/schema/generated types/Endpoint Contract Registry/semantic/client contracts, other profile, global progress, unrelated mapping, or `server/json.ts` changed.
- Residual risk: deployment adapters must publish files at the declared absolute static targets and serve the Manifest through the existing discovery and claim-validation boundaries; this helper validates declarations but performs no deployment I/O.

## Round 38

### PUB-0038 - accepted

- Requirement: after Collection deletion, the server SHOULD return `410 Gone` at the original Canonical URL and retain that behavior for at least 30 days.
- Production file: `src/server/publication-deleted-collection.ts`, exported from `src/server/index.ts`. The boundary issues a frozen opaque tombstone with detached ISO timestamps, enforces an exact minimum of 30 24-hour days, matches the original canonical HTTP(S) URL byte-for-byte, serves only GET and HEAD during the half-open retention interval, and permanently fails closed after observed expiry so clock rollback cannot resurrect the route. The RFC 9457 response uses `application/problem+json`, `410 Gone`, `retryable=false`, `Cache-Control: no-store`, and `Referrer-Policy: no-referrer`; HEAD preserves GET status and headers with no body.
- Initial unchanged focused run: `npm test -- --run tests/server/pub-0038-deleted-collection-gone-retention.test.ts` executed 40 tests: 36 passed and 4 failed. Three failures exposed mutable `Date`-shaped tombstone output where the focused API expected detached serialized instants; the fourth exposed missing `Gone` status text on HEAD.
- Acceptance repair: tombstone dates are immutable ISO strings, HEAD preserves status text, valid lowercase percent escapes remain exact URL identity, clock prototype traversal is bounded and rejects hostile shapes without invoking traps, and forged tombstones remain unusable. Added coverage did not remove or weaken any initial assertion. Final focused run passed 42/42.
- Verification: focused plus Publication Problem/cache regressions passed 187/187; all 32 server test files passed 1,311/1,311; protocol examples passed 28/28. Typecheck, build, protocol, requirements, traceability, and diff checks passed.
- Registry mapping: canonical and mirrored registries map only PUB-0038 to implementation `[server]` and evidence ID `http.collection-gone-retention`; generated requirements and traceability are current. Bundled evidence remains `sourceRevision: unverified` with no passed requirement IDs. PUB-0039 remains unmapped and the 410 response deliberately contains no archive, migration, Owner, Link, or Location recovery data.
- Baseline gate: `npm run check:types` still reports stale generated TypeScript contracts. The generated schema and TypeScript contracts are unchanged from `HEAD` and were not regenerated or modified.
- Scope: no CORE behavior/spec/schema/generated types/tests/Registry/conformance semantics, other profile, global progress, other requirement mapping, `server/json.ts`, sync, MCP, security, feed, or publisher code changed. No protocol correction.
- Residual risk: deployment adapters must persist the deletion instant and original Canonical URL durably, recreate the tombstone after process restart, invoke this boundary before a replacement route, use a trustworthy non-rolling-back clock, and retain the tombstone longer when operational or legal policy requires it.

## Round 39

### PUB-0039 - accepted

- Requirement: a retained `410 Gone` response SHOULD point to one archive, migration address, or Owner page.
- Production file: `src/server/publication-deleted-collection.ts`, already exported from `src/server/index.ts`. A separate opt-in response path accepts only a frozen, module-issued recovery target, preserves PUB-0038's no-link API and retention timing, and publishes one exact validated target in both RFC 9457 Problem `links` and an RFC 8288 `Link` field for GET and HEAD. It remains a `410 Gone` advertisement: no fetch, redirect, `Location`, `308`, credential forwarding, or Section 14 migration state is created.
- Initial unchanged focused run: `npm test -- --run tests/server/pub-0039-gone-recovery-link.test.ts` passed 53/53 with no failures.
- Acceptance review: safe canonical HTTPS targets and exact localhost/IPv4/IPv6 loopback HTTP development targets are accepted byte-for-byte. Non-loopback HTTP, user information, fragments, malformed or encoded controls, unsafe Link delimiters, non-HTTP schemes, relative forms, hostile accessors/Proxies, forged issued targets, oversized values, and ambiguous input shapes fail closed without reflecting credentials or attacker text. Responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, expose only the issued public target, and keep the Problem and HTTP Link target/relation exactly aligned.
- Test file: `tests/server/pub-0039-gone-recovery-link.test.ts` (59 final tests; evidence ID `http.collection-gone-recovery-link`).
- Registry mapping: canonical and mirrored registries map only PUB-0039 to implementation `[server]` and test ID `http.collection-gone-recovery-link`; generated requirements and traceability are refreshed through package generators. Bundled evidence remains `sourceRevision: unverified` with no passed requirement IDs.
- Verification: final focused passed 59/59; PUB-0038 plus Publication Problem/cache/Link regressions passed 484/484 across 12 files; all 33 server files passed 1,370/1,370; protocol examples passed 28/28. Typecheck, build, protocol, requirements, traceability, and diff checks passed.
- Baseline gate: `npm run check:types` still reports the pre-existing stale generated TypeScript contracts. `src/schema/generated/collection-protocol.schema.json` (`1667bac1bfc4a87c4a65fbb21fda418a912054b7`) and `src/types/generated.ts` (`5c5cbaef6063842bf9786c4cbea9d66b8011169d`) remain byte-identical to `HEAD`.
- Scope: no `server/json.ts`, sync, MCP, security, feed, publisher, CORE Registry/spec/schema/generated types/semantic/conformance behavior/tests, other requirement mapping, or global progress changes. Only generator-owned Publication registry, traceability, and unverified evidence artifacts changed outside the implementation/test/progress files.
- Residual risk: deployment adapters must select and persist a reviewed public recovery target and invoke the opt-in helper while the PUB-0038 tombstone is active; the helper validates and advertises the target but deliberately does not verify remote ownership, availability, or content.

## Round 40

### PUB-0040 - accepted

- Requirement: In `mode=publication`, every non-redacted Bookmark `url` is an absolute HTTP(S) URL whose Authority contains no userinfo, including authorized Protected / Private Publication; authoritative and Sync representations retain the shared `$defs.bookmarkUrl` negotiation.
- Observable conditions: Publication Snapshot planner, low-level GET/HEAD/304 response serializer, next-link helpers, single-page response, and page-series creation/release reject unsafe non-redacted Bookmark URLs before serialization; redacted Bookmarks may omit `url`; accepted URL spelling is preserved byte-for-byte; authorization/visibility does not relax the rule; ordinary error-body and stale-navigation header behavior remains unchanged.
- Production files: `src/server/publication-bookmark-url-guard.ts`, `src/server/publication-snapshot-delivery-policy.ts`, `src/server/publication-snapshot-next-link.ts`, `src/server/publication-snapshot-page-series.ts`, `src/server/index.ts`.
- Test file: `tests/server/pub-0040-publication-bookmark-url-safety.test.ts`.
- First focused run (unchanged): `npx vitest run tests/server/pub-0040-publication-bookmark-url-safety.test.ts` - 1 file, 30 tests: 29 passed, 1 failed. The only failure was a false-positive expectation for existing Link-header canonicalization (`rel="describedby"` is serialized as `rel=describedby`).
- Repaired focused run: the same command - 1 file, 30 tests passed.
- Focused and related regression run: `npx vitest run tests/server/pub-0040-publication-bookmark-url-safety.test.ts tests/server/pub-0033-snapshot-page-consistency-contract.test.ts tests/server/pub-0034-snapshot-next-link-contract.test.ts tests/server/pub-0035-snapshot-single-page-preference.test.ts` - 4 files, 201 tests passed.
- Full server run: `npx vitest run tests/server` - 34 files, 1,400 tests passed.
- Protocol examples run: `npx vitest run tests/conformance/examples.test.ts` - 1 file, 28 tests passed.
- Gates passed: `npm run typecheck`, `npm run build`, `npm run check:protocol`, `npm run check:requirements`, `npm run check:traceability`, and `git diff --check`.
- Baseline gate: `npm run check:types` reports stale generated TypeScript contracts; no generated schema/types were changed because they are outside this acceptance scope.
- Registry: `PUB-0040` preserves its existing `schema` and `semantic` implementation mapping and adds `server`; evidence ID remains `publication.bookmark-url-safety`. Bundled evidence remains `sourceRevision=unverified` with `passedRequirementIds=[]`.
- Protocol correction: no.
- Forbidden-path audit: no changes under `src/semantic/snapshot.ts`, `src/schema/**`, generated TypeScript contracts, `tests/core/**`, or existing semantic/core tests; no Sync/MCP/security/feed/publisher production or tests were touched.
- Residual risk: framework adapters remain responsible for invoking the guarded Publication Snapshot APIs for any additional transport wrappers; shared authoritative/Sync Bookmark URL semantics are intentionally unchanged.

## Commit 9 (F-07): Registered vs Verified boundary (historical checkpoint)

Clarification only — no production, test, Registry, or evidence change. Does **not** claim the `publication` Profile verified.

### Module shape: library boundary helpers

The Publication module is largely **library boundary helpers** (query decode, authorization-aware selection, public projection, representation ETag, cache/Vary policy, Problem Details, Snapshot page/series builders, Manifest discovery). Callers compose them at the HTTP edge. The package does not bind a concrete framework and does not substitute for deployment I/O, durable storage, or black-box conformance probes.

### Registered ≠ Verified

| Term | Meaning |
|---|---|
| **Registered** | `requirements.yaml` `implementation` / `tests` are filled; code and evidence test IDs are mapped. Acceptance rounds record that mapping. |
| **Verified** | The Requirement ID is present in the version-bound **bundled evidence** artifact (clean-repo generator run) and/or passes package-owned **deployment conformance** probes. |

Registered is not synonymous with Verified. At this checkpoint, filling Registry fields and landing `feat(colp): satisfy PUB-*` commits did not authorize a Profile claim. The bundled evidence remained `sourceRevision: unverified` with empty `passedRequirementIds` / **0 verified records**. Later package gates added `publication` to `supportedProfiles`; this historical module-progress checkpoint still cannot authorize a deployment claim.

### Required adapter orchestration

Successful Publication GET adapters must keep this order (helpers only enforce steps they own when invoked):

1. **query decode** — registered decoder; reject unknown / duplicate scalars (`400 invalid_query`)
2. **authorize** — effective principal / policy (Security-owned decision; Publication consumes the result)
3. **public project** — where the channel requires it (`projectPublicationPublicWire` or forced builders)
4. **etag** — representation-specific validator over final identity / serialized bytes
5. **cache headers** — authorization-varying → `private, no-store` + `Vary: Authorization`; anonymous-public only when truly public
6. **body** — emit only the post-projection (or explicitly authorized non-projected) representation

Reordering (e.g. ETag over pre-projection bytes, shared-cache on auth-varying responses, body without projection on anonymous channels) voids the helper contract.

### Public projection policy (Commit 3 wiring)

- **Anonymous directory / discovery / snapshot**: builders **force** public projection before wire emission; adapters cannot skip projection by calling only those builders.
- **Authorized Directory (default)**: does **not** project, so principal-visible fields may remain; adapters must opt into `*PublicProjection` builders when public-safe wire is required.

### Residual risks

- Adapters that **bypass builders** and serialize authoritative objects directly can leak private / non-public material.
- **Collection metadata** response helpers do not force public projection; adapters own that step when the response is public-facing.
- **Directory cursor** issuance, retention, and scope remain adapter/storage responsibilities outside the selection/page provenance boundary.
- **Evidence at this checkpoint was unverified** - there were no bundled passed IDs and no deployment-conformance Profile claim. Registered remains distinct from Verified.

## Commit 22 (F-25): PUB-0007 / PUB-0023 shared evidence

Clarification only — no production, test, Registry, or evidence change.

`PUB-0007` and `PUB-0023` share evidence ID `http.cache.authorization`. `PUB-0023` is a SPEC Chinese-expression alias of the same authorization-cache policy; the authoritative focused test set is `tests/server/pub-0007-authorization-cache-contract.test.ts` (`pub-0007`). Treat `pub-0023` coverage as supplementary alias proof, not a separate policy surface.

## Commit 24 (F-24): public projection retains `sourceRefs.nativeParentId`

Clarification only — no production, test, Registry, or evidence change.

Public projection **intentionally retains** `sourceRefs.nativeParentId`. SPEC requires redaction of native source identifiers with `nativeId` as the forced field; `nativeParentId` is kept as a deliberate public-safe residual. If a product threat model treats parent-native linkage as sensitive, elevate that field to a MUST-redact rule in a later change — do not assume current retention is an oversight.
