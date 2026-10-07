# Architecture

## Source of truth

The repository's [`protocol/`](../../../protocol) directory is normative. The package copies its JSON Schema, examples, and Requirement Registry through `scripts/sync-protocol-assets.mjs`; CI checks byte-for-byte equality. TypeScript declarations and traceability records are generated from the copied contracts.

Conditional JSON Schema constructs that generic generators cannot preserve are replaced in generated declarations with tested strict discriminated unions from `src/types/strict.ts`. Runtime validation remains governed by the canonical Schema.

If prose, Schema, examples, or implementation disagree, treat the disagreement as a protocol issue. Do not silently select one interpretation in implementation code.

## Package boundary

The first release remains one npm package, but only implemented subpaths are exported. This keeps protocol version negotiation, generated types, semantic validation, and HTTP wire behavior on one version without turning empty future modules into compatibility commitments. Framework-specific helpers are optional integration aids rather than Profile-completion requirements; browser adapters use separate browser-targeted packages.

The package root is a metadata-only boundary. `src/index.ts` exports only `protocolVersion`, `packageStatus`, and `supportedProfiles`; all protocol behavior and types are available exclusively from their owning public subpaths. Root business exports were removed as an intentional development-phase breaking change so applications cannot accidentally initialize unrelated domains through an aggregate barrel.

The public `adapters` subpath is the shared contract for those browser-targeted packages. `transformExportExtensionCarrier` preserves namespaces and returns policy removal audits; `createAdapterConversionResult` deterministically turns every removal and explicit `declareExtensionDegradation` audit into a structured `lossy_conversion` warning and requires `lossless: false`. It rejects reserved hand-written warnings, fabricated or duplicate audits, malformed audit paths, removal audits from other surfaces, and lossless assertions that contradict the supplied evidence. Returned warnings and audits are detached, stably ordered, and immutable.

The initial contract/tooling work is called the **Foundation Milestone**, not `Phase 1`; it carries no Profile claim. Profile delivery terminology follows `docs/10-implementation-contract.md`: `core + publication`, `publisher`, release-mode `feed`, `sync`, then `mcp-read` / `mcp-write`. Browser adapters and administrative products are separate delivery tracks and do not redefine that order.

`delivery/index.ts` makes that recommended order observable without changing protocol dependency semantics. Its registry has exactly five immutable stages. `planDelivery` interprets completion facts as an oldest-to-newest event ledger, allows either order within a grouped stage, requires release mode for the first Feed delivery, preserves partial grouped-stage progress, and rejects both skipped stages and a later event followed by an earlier-stage event. The returned canonical status is detached and immutable and has no conversion to `VerifiedProfileClaims`: implementation delivery, evidence eligibility, and Manifest publication remain three distinct boundaries.

Package and deployment ownership is defined in
[`HOST_INTEGRATION_BOUNDARY.md`](HOST_INTEGRATION_BOUNDARY.md). In short, the
package owns reusable protocol behavior and the host owns framework route
registration, middleware attachment, trusted connection facts, concrete ports,
and the running deployment. Missing host wiring is not a missing package feature;
package evidence is not deployment evidence.

## MCP package surface and migration (COLP-MCP-12)

MCP `2026-07-28` adapters are published only through the two supported
subpaths; the package root never re-exports MCP adapter API (migration
decision §8.2, development plan §2). Developers must explicitly choose one of:

| Subpath | Purpose |
| --- | --- |
| `@collection-protocol/node/mcp` | Default entry — the completed Modern `2026-07-28` Read + shared surface (authorization bindings, stateless shared Resource/Tool cores, change signals, per-request context, discovery/result, Resource and Read Tool adapters, subscriptions/listen, schema budget, pinned SDK boundary, OAuth client security) plus the Modern Write/MRTR adapter (`createMcp20260728WriteToolAdapter`, COLP-MCP-13). |
| `@collection-protocol/node/mcp/2026-07-28` | Explicit version-identified entry exposing the exact same surface as `/mcp` (re-exports the same module; the package-surface contract test asserts the key sets are equal). |

Neither entry exports the legacy Session binding, the legacy read server
session, the handshake method, old subscription methods, Legacy transport
types or pre-Modern adapter/factory signatures. The pre-Modern helper modules
under `src/mcp/` (read mount/read client/collections tools/change plan/write
tools/etc.) remain internal implementation and are not part of any public
entry. Minimal host examples (Resource-only, Read Tools, and Write) live in
[`MCP_HOST_GUIDE.md`](MCP_HOST_GUIDE.md) with type-checked mirrors under
`tests/mcp/examples/`.

A host may add a product compatibility surface outside the Profile endpoint.
That surface must not enter Manifest, Profile claims, or conformance evidence.
COLP MCP entries remain `2026-07-28` only
(`@collection-protocol/node/mcp` and
`@collection-protocol/node/mcp/2026-07-28`).

### Old Session API migration table

| Old API / concept | New API / concept |
| --- | --- |
| `McpSessionBinding` | `McpAuthorizationBinding` discriminated union (`/mcp`) |
| Plan `sessionId` binding | authenticated principal / client / credential / audience / security-epoch binding |
| `McpReadResourceServerSession` | per-request `Mcp20260728RequestContext` |
| per-Session `createMcpReadResourceServer` | reusable stateless Read application core / adapter (`createMcpStatelessReadCore` + `createMcp20260728ResourceAdapter` / `createMcp20260728ReadToolAdapter`) |
| `subscribeResource` / `unsubscribeResource` | `createMcp20260728SubscriptionsListenAdapter` over the `McpChangeSignalSourcePort` |
| `initialize` capability | `server/discover` + per-request capabilities |
| undiscriminated result | required `resultType` + applicable cache metadata (`Mcp20260728Result`) |
| `createMcpStdioCredentialBinding` / `McpStdioCredentialBinding` | `mapStdioEvidenceToAuthenticatedBinding` (token-free verified evidence) |
| `createMcpReadExposure` / `createMcpReadMountAdapter` / `createMcpReadToolGateway` / `createMcpReadClient` | Modern adapters above (internal-only pre-Modern factories removed from the public surface) |
| `createMcpWriteExposure` / `createMcpWriteMountAdapter` / `createMcpWriteToolGateway` | `createMcp20260728WriteToolAdapter` (COLP-MCP-13); the internal Write Gateway / change-plan factories stay off the public entries |
| server-initiated request + `elicitationId` / completion notification | MRTR `input_required` + server-minted `requestState` + client retry (`changes.plan` / `changes.commit`); no roots/sampling/elicitation is initiated |

## Dependency direction

```text
schema/types
    -> semantic
    -> client/server
    -> publisher/feed/sync/security
    -> mcp/framework adapters
    -> conformance/testing
```

Protocol behavior depends on injected ports for storage, authentication, transactions, idempotency, outbox delivery, rate limits, signing, and approval. Framework adapters must call the same application services and must not implement a second set of write semantics.

Framework integrations compose Profile-specific ports instead of requiring one storage adapter to implement every optional Profile. Publisher writes run through a `PublisherUnitOfWork`; its transaction owns the server ID ledger plus resource, idempotency, operation, audit, and outbox stores backed by one database transaction. Sync transactions require the same ledger. The idempotency binding has a database-level unique constraint, and the first complete response is saved in that transaction for exact replay. Process-local locks are not a substitute for the adapter's cross-process transaction and uniqueness guarantees.

Unknown Sync extensions are canonical business state, not projection metadata. `SyncExtensionStore` keys each carrier by resource type and resource ID, so Collection, Node, Annotation, Attachment, Relation, Release, Replica, and future resource kinds remain isolated. Its atomic `compareAndSet` replaces the complete namespace map at an expected resource revision; an explicit `delete` replacement removes the member, while `replace` with `{}` preserves a present empty map. A server with several extension-bearing carriers invokes the same transaction-bound contract for each addressed resource rather than merging maps.

Publication extension validation distinguishes producer and consumer boundaries. Producers enforce their deployment Namespace allowlist and remove unapproved data before publication. Consumers still validate exact HTTPS Namespace syntax, but preserve valid unknown payloads as opaque JSON without interpreting or executing them; installing an extension handler is a separate trust decision and is never required merely to receive a Snapshot.

`relaySyncExtensionCarrier` validates and detaches the replacement before entering `SyncExtensionUnitOfWork`, verifies the store's returned identity, revision, and JSON value, then saves the exact replay receipt in that transaction. Both carrier and receipt must pass transaction-local read-back equality before the callback completes, and the unit of work must return that callback's exact result after committing carrier and receipt together. Rollback, uncertain commit, malformed or non-Promise adapter output, mismatched storage output, callback-result substitution, and partial persistence reject without an acknowledgement; stale CAS returns an immutable revision conflict. An exact retry reloads the committed receipt after restart and proves its carrier still equals the request bound to its digest, while `loadSyncExtensionCarrier` reloads canonical state for pull and Snapshot projection. Stored, loaded, and replayed values are detached and deeply immutable, preserve namespace keys and falsey JSON values, distinguish missing from empty, and compare JSON objects without depending on member order. Canonical writes never accept a security/removal policy; optional filtering is a detached downstream load projection whose removals are returned as audit records and cannot update the store.

Random local Profile IDs use `getOrCreateRandomProfileId` with a `LocalProfileIdStore`. The store key is an opaque, stable, device-local Profile handle: it is not a wire identifier and must not be uploaded, logged remotely, derived by raw hashing a sensitive path, or used as HMAC input by this random-ID API. `getOrCreate` owns the entire read/create decision. It must serialize concurrent first use across processes (or use equivalent database locking/isolation), invoke the supplied CSPRNG allocator only after absence is established inside that serialized boundary, insert the allocator's exact value, and resolve its Promise only after commit. Existing committed values and concurrent losers return the committed winner without invoking their allocator. A store that allocates optimistically and then loses a uniqueness race violates this interface; supporting that design requires a future discriminated result contract rather than returning a different winner after allocation. Storage errors, rollback, and uncertain commit reject without exposing the generated value; after a crash, a committed row is reused and an uncommitted row is absent and may be generated anew. The coordinator rejects malformed stored IDs, non-random ID envelopes, non-Promise store results, multiple allocator calls, and any store result that differs from the value allocated by that operation.

Server-keyed Profile IDs are available only from the package's `./server` subpath. `createProfileIdHmacKey` copies caller-supplied bytes into an opaque handle with no key getter, enumerable state, JSON representation, or diagnostic/error echo; `createHmacProfileId` accepts only that handle and returns only the public versioned Profile ID. Each derivation uses and then zeroes a working copy. Retiring a key requires calling the handle's idempotent `destroy()`, which removes and zeroes the package-owned copy; subsequent derivation fails with a static error. The root, client, and adapter surfaces do not export the HMAC factory, handle, options, or derivation function, so key-bearing configuration cannot enter their DTO or wire APIs through this package. The original input buffer remains caller-owned: the package cannot erase it, prevent the caller from independently logging it, or protect a key before import or after compromise of the server process. Server composition code must erase that input after import and keep handles out of generic configuration/log metadata. Its persistent public-version-to-handle map must never reassign or reuse a version label, must retain every version needed to resolve stored identifiers, and must restore the same mapping after restart. These properties are deployment responsibilities verified by the `core.profile-id-key-rotation` black-box probe, not behavior inferred by the stateless HMAC helper.

The exact framing is a package API contract, not a protocol-wide promise that independent deployments generate equal opaque IDs. Its fixed compatibility vector uses key bytes `00..1f`, key version `v1`, server scope `server.example`, tenant scope `tenant-1`, and string local ID `Profile/e\u0301/\u7528\u6237`; the result is `prf.h1.v1.jPlng8qXDyjhW30apPwPrim8J_5t5gH19VvKFe5KE4U`. The vector protects this package and compatible SDKs from accidental framing changes.

The server ID ledger is append-only and shared by Collection, Node, Annotation, Attachment, Relation, Operation, and Event. Its database key is the decoded, case-sensitive ID alone, not `(resourceType, id)` or `(collectionId, id)`. `reserveServerIds` submits an entire creation set through `reserveAll` in the same database transaction as business state, Operations, Events, audit, and outbox records; any collision rejects and rolls the set back. A uniqueness collision has one winner and is surfaced as `ServerIdAlreadyReservedError`; it is distinct from HTTP idempotency and Sync Operation replay. A failed transaction rolls back its uncommitted reservations with all other writes. Once a transaction commits, ledger rows are permanent: resource deletion, tombstone purge, retention cleanup, and service restart never remove them. Storage adapters must not expose ledger deletion or release operations.

AI-generated Annotation content crosses the server mutation boundary with an opaque, one-shot context created by `createAiAnnotationGenerationContext`; request JSON and caller-supplied `provenance.kind` are never generation-origin signals. The context is built where the server invokes or accepts output from an AI provider, then passed exactly once to `prepareAnnotationCreate`, `prepareAnnotationResource`, or `prepareAnnotationMergePatch` before persistence and Operation creation. Those functions attach canonical `kind: ai` provenance and `generatedAt`, validate the complete wire shape, resolve every `sourceNodeId` in the Annotation's Collection, and return an immutable copy. Every mutation route must also pass a server-created one-shot context for human, imported, or derived content, so a route cannot silently default unknown output to human. A trusted human edit context preserves an existing AI kind and timestamp while setting `editedByHuman` for content changes; provenance removal or downgrade is rejected. Provider and model are recorded when known, but model disclosure remains optional. Public projection may redact policy-controlled provider/model fields without changing the authoritative AI kind.

`semantic/endpoint-contracts.ts` is the shared HTTP contract registry for endpoint variables, Query DTOs, request / response DTOs, methods, headers, and success statuses. Client, server, and conformance code must consume this registry rather than duplicate endpoint tables.

## Wire validation boundary

Every JSON receive boundary uses one ordered gate: I-JSON parse, Draft 2020-12 structure and format assertion, then one semantic validation call. Parse failure returns the original `Error`; schema failure uses the established `structural` stage and retains the complete Ajv error list, including `format` keyword diagnostics; semantic failure retains the complete issue list. No dispatcher, cache insertion, pagination follow-up, adapter conversion, transaction, idempotency reservation, or persistence operation may observe the candidate document before all three stages pass.

`createValidatorRegistry` rejects caller-supplied Ajv instances whose format validation is disabled, replaces any previously loaded canonical Schema, installs the package's RFC 3339, RFC 3986 URI, and RFC 6570 Level 1 URI Template assertions, and eagerly compiles every public definition. The final result comes from a module-private canonical Ajv rather than caller-controlled code generation, subclass overrides, or format functions. This also prevents later mutation of a supplied Ajv from weakening a lazily compiled validator. The returned registry is frozen. `validateWireDocument` recognizes registries created by this constructor; a structurally compatible wrapper or substitute is also checked by the internal canonical validators before semantics can run, so instrumentation remains possible without allowing a false structural result to bypass format assertions.

`validateWireJsonDocument` is the shared source-text gate. `validateServerWireDocument` delegates to it before request dispatch, and the client uses it for every network JSON body, including Problem Details. Cached representations are untrusted parsed values and therefore re-enter at `validateWireDocument` before use; an invalid cache entry is deleted. Snapshot pages pass the gate individually before their Link header is followed, and assembled multi-page state is returned only after assembly semantics pass. Write and import adapters that start from an already parsed candidate enter at `validateWireDocument`; adapter-specific Bookmark hash checks remain semantic validators supplied to that gate, never replacements for structure or format validation.

Parsed values are not authorized for persistence by the receive gate alone. Every server write path enters the generic `executeValidatedWrite` boundary with its canonical Schema `DefinitionName`, semantic validator, and transaction-bound persistence callback. The boundary makes a detached, deeply immutable candidate, runs `validateWireDocument`, strictly checks the semantic validator's result contract, and invokes the writer exactly once only after both stages succeed. Structural and semantic failures are returned with their existing stage diagnostics; thrown or contradictory validators, values that cannot be detached, and non-Promise writers reject. Writer resolution becomes the successful result, while writer rejection or uncertain persistence propagates unchanged. The same immutable validated value is passed to persistence and returned to the caller, so caller aliases and validator mutation cannot change the authorized object. Parsing remains a separate receive concern, and profile-specific transaction, authorization, idempotency, parent-cycle, and other business guards remain composition responsibilities around this gate.

Bookmark URL storage and HTTP endpoint navigation are separate boundaries. A write or import adapter uses `preserveBookmarkUrl` to apply the shared `$defs.bookmarkUrl` safety assertion and then carries the returned string unchanged; it must not parse and serialize it, substitute `canonicalUrl`, or infer sensitivity from query parameter names. This preserves signed, temporary-token, and caller-declared order-sensitive URLs, including their query order, escapes, case, port, and fragment. The client's request-only URL handling may resolve links and derive normalized loop/cache keys, but those navigation values must never be written back into Bookmark `url` fields.

`executeGuardedNodeWrite` is the recommended server boundary for ordinary Node writes. Its ID-only mutation union cannot express a Root create or a null ordinary Parent; Collection + Root creation remains a separate atomic operation. The boundary detaches and deeply freezes the complete typed candidate before entering the unit of work, and passes that exact object to validation, authorization, member policy, and persistence. After validation, a required coarse pre-authorization/concealment hook runs before any authoritative graph read. Inside the transaction or locked snapshot, Core then resolves authoritative `StrictNode` and Collection state, builds a frozen plan, performs per-participant ACL and mutation-policy decisions, applies inherited read-only policy, and only then calls persistence. The plan separately identifies authorization participants, modified Node records or child sets, and the exact deleted Node range/count, so a surviving Parent never inflates a deletion receipt. `resolveChildren(parentId, limit)` returns a bounded page and `hasMore`; Core rejects an over-budget page before expansion, iteratively derives subtree membership, detects cross-level cycles, and verifies non-recursive Folder deletion is empty. `maxDepth` and `maxVisitedNodes` have safe defaults and package hard ceilings. The writer returns its actual modified and deleted sets/count; any malformed, missing, extra, or duplicate ID rejects before the transaction callback can commit. Resolver, hook, unit-of-work, and writer ports must return native Promises. Denials carry frozen stable codes; HTTP adapters apply concealment before mapping them to the registered Problem contract. The package-owned `core.node-subtree-transaction` deployment probe seeds a multi-level subtree and surviving sibling, then verifies the exact deletion count, complete member removal, and neighbor preservation against a real adapter.

`evaluateNodeMutationPolicy`, `executeNodeMutationPolicyGuardedWrite`, `evaluateParentCycleGuard`, and `executeParentCycleGuardedWrite` remain exported as compatibility-level building blocks. They do not constitute the complete Node write security boundary: the policy helper trusts `resolveDescendants` completeness and has no shared traversal budget, while the cycle helper intentionally permits null Parent proposals and does not validate authoritative Node kind. New HTTP, Sync, MCP, and adapter write paths use `executeGuardedNodeWrite`; legacy users must migrate before making a Profile claim. A `managed-bookmarks` Folder with no `constraints` is a read-only boundary, and explicit `constraints.readOnly=false` overrides that role default in both the compatibility policy helper and the composed boundary.

The optional Bookmark `urlHash` is a semantic invariant of the resulting resource, not an independently writable hint. Server and import adapters use the shared `semantic/bookmark-url-hash.ts` validators after structural validation: creates compare the supplied fields directly, complete Node and Snapshot representations compare against their own preserved `url`, and JSON Merge Patch writes compare against the resource produced from the current Node plus the patch. An omitted patch member preserves its sibling, while `null` removes that member. Adapters must reject a resulting Bookmark whose present hash does not match the exact preserved URL; they must not parse, normalize, or rewrite the URL before hashing.

URL-hash comparison is isolated in `areUrlHashDeduplicationCandidates`, whose boolean result is only a signal to perform further duplicate comparison. The helper accepts hashes rather than resources, so it cannot determine identity, choose a canonical resource, create an alias, merge resources, or conclude that a duplicate exists. Protocol identity remains exclusively the case-sensitive `(serverUuid, resourceType, id)` tuple implemented by `sameGlobalResourceIdentity`; distinct tuples remain distinct regardless of equal hashes, URLs, content, or Collection context. A collision or stale hash may at most produce an extra candidate and cannot override that identity relation.

## Sync composition boundary

Sync durable coordinators are intentionally **composition-free** so adapters and unit tests can exercise persistence without a full auth stack. Hosts that expose HTTP/MCP Sync surfaces must compose Session verification and choose an exclusive write owner.

### Required host order (SYNC-V-005 / SYNC-Q-019)

1. `verifySyncSessionContext` (or `requireVerifiedSyncSession` / `assertVerifiedSyncSession`) — durable credential and scope gate; produces a **runtime-branded** `VerifiedSyncSession` only on the active path (`isVerifiedSyncSession`).
2. `createSyncHost({ owner: 'sequence' | 'push', session })` — typed exclusive write dispatcher. The host cannot dispatch the other write coordinator.
3. Pull via `host.pull` (session-bound principal / collection / session / protocolVersion binding).

`coordinateSessionBoundPush`, `coordinateSessionBoundPull`, and `coordinateSessionBoundSequence` remain the primitives the host wraps. Bare `coordinatePushTransaction`, `coordinateSyncPull`, and `coordinateSequenceOperation` are **not** on `@collection-protocol/node/sync`; import `@collection-protocol/node/sync/unsafe` only from tests and adapter fixtures.

Protocol digest identity (canonical JSON, SHA-256 framing, effect/page/member projection, effect-page URI expansion) lives on `@collection-protocol/node/sync/canonical`. That subpath has no Node builtins so MV3 can import it. Production `./sync` re-exports the same function objects; do not ship a second digest algorithm.

`@collection-protocol/node/sync/browser` extends that subpath with the other browser-oriented Sync helpers (browser event translation and batch application, root mapping, sidecars, Netscape bookmark parsing, separator presentation, transport budgets, light-Pull advice, typed-update payload validation). Its dependency graph contains no Node built-ins or implicit `Buffer` use, verified by a `platform: 'browser'` esbuild bundle. Helpers built on the immutable JSON snapshot (for example `mergeSyncTypedUpdate`) keep their Node-backed Proxy rejection and remain server-side on `./sync`.

`host.push` fail-closes unless `request.batchId` is the versioned binding from `bindSyncPushBatchId` for the verified Session's full `sessionId`. The encoding is `b1.<sessionLength>.<sessionId>.<suffix>` (binding version 1): `sessionLength` is the canonical decimal length, the suffix is an independent non-empty opaque segment, and the whole value is one wire `opaqueId` of at most 128 characters. Session `a` and session `a.b` do not accept each other's batch ids. A legacy `sessionId` or `sessionId.<suffix>` value is not a unique binding, because `opaqueId` may contain `.`; `legacySyncPushBatchInReceiptScope` matches an old retry only when the full session, principal, endpoint, and digest all agree. When b1 framing would exceed 128 characters, the mint uses `b2.<sessionDigest>.<suffixDigest>`: two domain-separated SHA-256 base64url digests covering the full inputs, in 90 wire characters. Every legal Session and local ID up to 128 characters remains usable; b1 IDs that already fit keep their exact bytes and remain accepted for retries. `readSyncPushBatchBinding` returns the digests for version 2, not raw IDs. A host that derives its own server batch id still scopes that receipt by Session. The client `batchId` does not authorize a receipt.

### Exclusive opId ownership (SYNC-V-009)

`coordinateSequenceOperation` and `coordinatePushTransaction` are **alternative top-level owners**. Sequence enforces lane continuity (`sequence_gap` / `sequence_blocked`). Push does **not** embed that continuity check; it owns batch atomicity, dual-index receipts, and lifetime opId / sequence reuse claims.

Hosts MUST NOT nest Sequence inside Push preflight or transaction callbacks, nest Push inside a Sequence evaluator, or claim both reservation owners for the same request boundary. There is intentionally **no** dual-owner “sequenced push” facade: combining both would violate the reservation contract. Hosts that need gap/blocked semantics choose Sequence as the sole owner for that path; hosts that need Push batch semantics choose Push and accept that lane continuity is outside that coordinator.

Documented notes also live on `SYNC_HOST_COMPOSITION_NOTES` in `src/sync/composition.ts`.

### Host composition recipe (typed-update merge)

See also `packages/node/docs/SYNC_HOST_COMPOSITION.md` § **Production path vs explicit unsafe** for a side-by-side integration table.

Production hosts should follow `createSyncHost` (`src/sync/host.ts`) and `SYNC_HOST_COMPOSITION_RECIPE`:

1. Session-first gate, then `createSyncHost({ owner, session })`
2. Exclusive write owner: Sequence **or** Push (never both; no dual-owner facade)
3. Pull via `host.pull`
4. **Typed-update Push preflight must call `mergeSyncTypedUpdate` (Base / Current / Incoming) before apply.** Prefer `createTypedUpdateMergePushPreflight({ loadCurrent, planMerged, planConflict, planOther })`.

### OpId reservation owner brand (SYNC-V-013)

`operationIdReservationOwner: 'push' | 'sequence' | 'session-bootstrap'` is a **compile-time ownership brand** on unit-of-work types. It is **not** a runtime cross-coordinator mutex. Exclusive claim of operation IDs for a write path is enforced by host composition (choose exactly one owner) plus durable claim-store discipline (`operation-reuse` / server-ID ledger). Nesting Push and Sequence on the same request boundary is a host contract violation the brand cannot prevent at runtime.

### Expired Pull Snapshot URL policy (SYNC-V-007)

`coordinateSyncPull` accepts an optional fourth argument `SyncPullSnapshotUrlOptions`. By default only absolute `https:` Snapshot URLs are accepted on expired-cursor recovery. Hosts may pass `{ allowInsecureSnapshotUrl: true }` to also accept `http:`. Embedded credentials (`userinfo`) are always rejected.

Optional `assertSnapshotUrlSafe?: (url: URL, raw: string) => void` runs **after** scheme and userinfo checks so hosts can reject private/local addresses or enforce allowlists without DNS I/O in this package. If the hook throws, the error propagates (fail-closed).

- **Bare** `coordinateSyncPull`: omitted hook = transport-only (private IP literals still accepted for backward compatibility).
- **Session-bound** `coordinateSessionBoundPull`: omitted hook installs `rejectPrivateOrLocalSnapshotUrl` via `withRecommendedSnapshotUrlHostPolicy`. Pass an explicit hook (allowlist or intentional no-op) to override.

Built-in `rejectPrivateOrLocalSnapshotUrl(url)` rejects loopback, RFC1918 private, CGNAT `100.64.0.0/10`, link-local (including `169.254.169.254`), unspecified, decimal/`0x`-hex single-number IPv4 forms of those ranges, and common IPv6 private/local forms (and IPv4-mapped equivalents) via pure hostname/IP-literal checks. **Not** a complete SSRF solution (no DNS); hosts that fetch Snapshot URLs should prefer allowlists.

### Replica lifecycle authentication (SYNC-V-006)

`coordinateReplicaLifecycle` is the low-level durable state machine. It accepts `authenticated: true` only on a command built by `asReplicaAuthenticatedCommand` from a `ReplicaAuthProof`; a hand-written flag or a copied command throws. Production request paths should use `coordinateSessionBoundReplicaLifecycle`, which verifies a branded Session and its Collection binding before minting `ReplicaAuthProof` and building the authenticated command. Hosts with an external authentication boundary may use `assertReplicaCallerAuthenticated({ authenticated: true, source: 'host-verified' })`, but that remains explicit Host trust. The dangerous `createUnverifiedReplicaAuthProofForTests` / `createTestReplicaAuthProof` helpers are **testing-surface only** (not re-exported from the package root or `sync` barrel).

### Legacy pure reducers (SYNC-V-008)

Pure helpers such as `decideSequence`, `createSequenceState`, `recordSequenceResult`, `canPurgeTombstone`, `haveMatchingTypedUpdateFields`, and `transitionReplicaLifecycle` do not establish adapter persistence or authority. They live in `src/sync/legacy.ts` for property tests and local modelling and are not exported from any package entry. Prefer the durable coordinators and `validateSyncTypedUpdateOperationPayload` for production paths. `haveMatchingTypedUpdateFields` is a weak `Object.keys` check and is not a substitute for SYNC-0016 typed-update validation.

## Conformance claims

`supportedProfiles` publishes the exact package-verified set `core`, `publication`, `publisher`, `feed`, `sync`, `mcp-read`, and `mcp-write`. A deployment claim still requires package-owned black-box probe evidence. The requirement registry (`protocol/requirements.yaml`) gives each normative statement a stable ID, a `colp-section-N` source anchor, the implementing modules, and the test IDs that verify it; `check:traceability` rejects malformed records, duplicate IDs, and missing anchors.

Build-time evidence comes from one full Vitest run whose test names carry registered `[evidence:<test-id>]` tags. `npm run generate:evidence` records a requirement as passed only when every one of its tagged tests passed, and writes the protocol version, package version, requirements digest, and passed requirement IDs to `src/conformance/generated/evidence.json`; `check:evidence` reruns the suite and fails when the committed file is stale. Runtime configuration cannot supply passing tests or Requirement IDs; deployment evidence is issued only after package-owned black-box scenarios drive a deployment test-control adapter and validate the resulting state observations.

Profile evaluation checks the complete transitive dependency closure: `publication -> core`, `feed -> publication`, `publisher -> publication`, `sync -> core`, `mcp-read -> core`, and `mcp-write -> mcp-read + publisher`. These edges express data-model, wire, endpoint, and reusable-port dependencies; they do not assign every optional Core deployment role to every dependent Profile. Every dependency must still have its endpoints, ports, Profile-owned deployment probes, and all MUST / MUST_NOT package evidence.

Deployment probe selection uses an explicit immutable scope. `createDeploymentConformancePlan` strictly validates the exact Manifest Profile list and enabled generic capabilities, adds Profile-implied capabilities, and returns canonical `profiles`, `capabilities`, and `probeIds`. Profile-owned probes cover the Profile's black-box wire or transport contract; `core` itself has no unconditional stateful deployment probe. The optional capability scopes are `core-authoritative-writes`, `managed-bookmark-writes`, `sync-extension-storage`, `ai-content-writes`, `local-profile-id-storage`, and `server-profile-id-hmac`. The authoritative-write scope proves general ID, validation, tree, and transaction guarantees; it does not imply that a host accepts or stores the optional `managed-bookmarks` Folder role. Hosts that do expose mutation over that role declare `managed-bookmark-writes` and prove its default read-only boundary. `publisher` and `sync` imply both write capabilities because their generic Node mutation paths can encounter Managed Nodes; Sync additionally implies Sync Extension storage, and `mcp-write` receives Publisher's implications through its explicit dependency closure. A `core + publication` scope therefore requires the Publication HTTP probe without pretending to expose authoritative writes, Managed Bookmark handling, Sync, AI-write, browser-local Profile ID, or server Profile ID HMAC roles.

`runDeploymentConformanceProbes` executes exactly the scope-derived asynchronous black-box plan and returns opaque, process-local evidence only after every scenario succeeds. The evidence binds the canonical Profile scope, effective capability scope, and passed probe IDs; the evaluator rejects reconstructed or copied evidence and rejects a claim whose dependency closure is not covered by that scope. `runDeploymentConformanceProbe` can execute one official scenario for adapter development but deliberately returns no publishable evidence. Package evidence is stored in the repository and checked against a fresh test run in CI. Only the profiles listed in `supportedProfiles` are package-level claims. Deployment Manifest claims remain subject to the separate runtime and black-box probe gates.

`evaluateProfileClaims` reports the Profiles a probed deployment is eligible to claim. Its result is diagnostic and is not publishable evidence. Manifest production must use `assertProfileClaims` on the exact requested list and serialize the immutable snapshot it returns: the assertion rejects unknown or legacy names, duplicates, omitted explicit dependencies, and any requested Profile outside the eligible set. The caller-owned request remains untrusted and may be mutable; returning eligible claims alone is not a sufficient write-boundary check because a caller can otherwise forget or incorrectly implement the comparison.
