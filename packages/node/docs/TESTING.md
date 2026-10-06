# Testing Strategy

## Layers

1. Schema tests cover all named `$defs`, Format Assertions, discriminated variants, limits, and unknown properties.
2. Semantic tests cover trees, references, uniqueness, projections, extensions, and assembled Snapshots.
3. Contract tests exercise HTTP methods, media types, versions, status codes, headers, caching, and Problem Details.
4. State-machine tests exercise Publisher idempotency, Sync, Replica, Conflict, Tombstone, and approval lifecycles.
5. Security tests cover effective Scope, data projection, credential handling, Origin/CSRF, rate limits, SSRF boundaries, and redaction.
6. Adapter tests in this package exercise in-memory ports, fixtures, and fault injection. Real browser-extension processes belong to the embedding host or a separate extension package; they are not this repository's Baseline.

## Incremental test filename convention

New test files should follow one of these patterns (do not mass-rename existing evidence files):

| Pattern | Use when | Example |
| --- | --- | --- |
| `{area}-{requirement-id}-contract.test.ts` | Protocol / profile requirement contracts | `publish-0001-preconditions-contract.test.ts` |
| `{topic}.{requirement-id}.test.ts` | Security evidence IDs that already use dotted requirement labels | `https-enforcement.sec-0015.test.ts` |
| `{topic}-contract.test.ts` | Module contracts without a formal requirement number | `composition-contract.test.ts` |
| `{topic}.test.ts` | Focused unit / property / integration suites | `session-expiry.test.ts` |

Guidance:

- Prefer **hyphen-separated** names for new non-security files.
- Preserve **existing dotted security evidence filenames** (`*.sec-####.test.ts`, `*.m-#.test.ts`) when extending those suites; only use the hyphen form for brand-new security topics that do not inherit an evidence id.
- Keep the Vitest discovery surface as `**/*.test.ts` (and typecheck companions as `*.typecheck.ts`).
- Put suite evidence tags in `describe`/`it` titles as `[evidence:…]` rather than encoding them only in the filename.
- Integration and property suites live under `tests/integration/` and `tests/property/` respectively; do not co-locate them under unit module folders unless they are pure helpers.

## Baseline gates

- Keep all canonical examples valid and port every negative assertion from `scripts/validate_examples.py`.
- Map every registered Problem Code to a server response and client recovery test.
- GitHub Actions CI (`.github/workflows/colp-ci.yml`) proves the package on **ubuntu-24.04 + Node 22**. Node 24 and Linux / Windows / macOS coverage is a local release-ceremony item in `RELEASE_CHECKLIST.md`, not a CI Baseline gate alongside `npm run test:coverage:security`. Evidence-only CI (only tracked artifacts in `releaseEvidenceMutablePaths`) still runs `npm run test:process-contracts` in the `static` job.
- **Enforced non-regression floors** (current mandatory gates; not the repository target):
  - Repository aggregate gate in `vitest.config.ts`: lines/functions 95%, branches 90% across the included Core surface (`schema`, `semantic`, `client`, `server`, `adapters`, `delivery`, shared contracts, Sync, `mcp`, and `conformance`). That include does **not** cover `src/security` or `src/publisher`. Statement coverage remains enforced per implementation domain so V8 statement counts for defensive fail-closed branches are not treated as a single cross-Profile aggregate.
  - Domain non-regression floors under that aggregate: MCP (`src/mcp/**` branches 90 / functions 98 / lines 95 / statements 93) and Sync (`src/sync/**` branches 87 / functions 98 / lines 90 / statements 88). The aggregate Sync floor is **not** the Core-used Sync target; Tier A is gated separately.
  - Independent Security gate via `npm run test:coverage:security` (`vitest.security.config.ts` → `coverage/security/`): branches 90 / functions 98 / lines 95 / statements 90.
  - Independent Publisher gate via `npm run test:coverage:publisher` (`vitest.publisher.config.ts` → `coverage/publisher/`): current floor branches 88 / functions 99 / lines 90 / statements 88. This is the current Publisher non-regression floor, not the Core/Security 90/95 target.
  - Independent **Sync Core-used** gate via `npm run test:coverage:sync-core` (`vitest.sync-core.config.ts` → `coverage/sync-core/`): mandatory floor branches 90 / functions 98 / lines 95 / statements 90 over the Tier A manifest below. Tier B/C coverage must not offset Tier A gaps.
  - Any newly exported optional module must enter an enforced coverage surface; Sync, authorization, idempotency, and approval behavior retain their dedicated quality and evidence gates.
- **Targets** (not yet met by the floors above; do not describe current thresholds as satisfying these numbers):
  - Complete Core implementation surface: lines/functions 95%, branches 90%. Core-used Sync (Tier A `sync-core` gate) already enforces lines 95 / branches 90 as a mandatory floor.
  - MCP domain floors and Security already enforce lines 95 / branches 90 as mandatory floors.
- Run property and mutation tests on graph, cursor, idempotency, authorization, Sync, Feed, and Schema code.
- Property tests leave the fast-check seed unset by default so regular runs explore new inputs. On failure, reproduce the reported seed with `COLP_PROPERTY_SEED=<signed-32-bit-seed> npm test -- <test-file>`; do not commit a fixed seed as the permanent discovery mode.
- `tests/property/core-state-properties.test.ts` exercises the stateful surfaces with generated inputs. Critical mutation (`npm run test:mutation` -> `test:mutation:critical`) covers core, MCP, Security (including OAuth 2.1 and DPoP), Sync (including typed-update merge), Feed, and Schema decision modules (not Security/Sync barrel `index.ts` files). Mutation testing is developer-invoked and local only; GitHub Actions must not run or route any mutation test. Mutation targets use complete semantic files/directories rather than line ranges so refactors cannot silently move a decision outside the gate.
- Local mutation runs emit Stryker JSON reports plus compact domain summaries. The report tooling can aggregate those summaries into revision-bound local evidence, but GitHub Actions does not upload, cache, summarize, or gate on mutation results.
- Release mutation reruns local critical mutation (`test:mutation:core`, full `test:mutation:mcp`, Security, Sync) and adds Publisher plus Publication. The three optional MCP Stryker shards (`mcp-change-plan` / `mcp-write` / `mcp-read`) exist for local bounded runs; `test:mutation:critical` does not invoke them. Run `npm run test:mutation:release` explicitly from a clean local checkout when that additional evidence is needed; it is not part of a GitHub Actions workflow.
- `npm run check:benchmark:publication-snapshot-delivery` is developer-invoked and local only, like `test:mutation:*`. GitHub Actions must not run or route it, and it is not part of `npm run check`. The checker (`scripts/check-publication-snapshot-delivery-baseline.mjs`) never applies a committed absolute-Hz floor when `process.platform` or the running Node major differs from `reference.environment` (the captured floor is win32 / Node 24 at 12008.9 plans/s): `compareMode` `skip` warns and exits 0 without reading a bench report; `relative` compares only a previous same-OS/Node-major artifact at `reports/publication-snapshot-delivery-host-baseline.json`, and skips (exit 0) when that file is missing or from another platform/Node major. The npm wrapper still runs `vitest bench` first; invoke the checker script directly when you only need the skip/relative gate. Neither skip nor relative comparison is a CI or `npm run check` Baseline gate.
- Reject a Manifest profile claim unless its complete black-box conformance suite passes.
- Exercise the public delivery planner as a separate policy boundary: exact stage order, grouped-stage partial progress, release-first Feed, skip rejection, strict malformed-input rejection, and immutable detached results. Delivery completion must never alter Profile evidence or claims.
- Keep fixture filenames and `protocolExampleContracts` exactly equal so new canonical examples cannot bypass validation.
- Regenerate TypeScript and traceability during the default `check`; stale generated output is a release failure.
- Run ESM and CommonJS package smoke imports against the packed artifact.
- The default `npm run check` includes `check:mcp-legacy-absence` after `pack:check`, so the local command scans the packed tarball for Legacy MCP wire symbols.
- `npm run pack:check` also extracts the actual tarball into a temporary consumer without running lifecycle scripts, links only the production dependencies already installed from the lockfile, then requires/imports every declared runtime subpath and the packaged JSON Schema.
- Before the first stable release, complete `RELEASE_CHECKLIST.md` and record whether any stable `0.1` validator or Wire implementation existed outside this repository. A private development package and an untagged Draft do not establish that baseline by themselves.
- Keep the package HMAC golden vector stable. A deployment claiming Core must also prove that public key-version labels are never reassigned, old active mappings survive restart, stored IDs remain resolvable across rotation, and keys remain absent from diagnostics and logs.

# Sync Core-used coverage manifest (U-3)

Owner (this worktree): developer subagent on `known-p5` at commit `41ad711363eb79c87d9a76968407621fcdb64ee1`.
Decision rule when contested: **can the release-profile write state machine (Session → Sequence/Push/Pull → Replica lifecycle → tombstone purge) still complete without the file?** If yes and the file is adapter/composition/legacy, classify B or C. Tier C high coverage must never offset Tier A gaps.

Import-graph / export basis: package root re-exports Sync from `src/sync/index.js` (`src/index.ts`), and `./sync` is a first-class package export of that same barrel. Tier A is the durable coordinator + production dependency closure under `src/sync/` required for Core Sync write/read state machines. Stryker sync mutate list is a Tier A signal, not the sole definition.

**Change rules (all tiers):** Any new production import from a Tier A file into another `src/sync/*` module requires adding that dependency to Tier A (or documenting why it is adapter-only). Adding a package-root Sync export for a new coordinator requires a manifest row. Demoting an existing Tier A file to B/C requires an explicit review note in this section and must not be done solely to preserve coverage numbers. PRs that change Tier A must update the shared executable manifest in scripts/lib/sync-critical-manifest.mjs, this table, `vitest.sync-core.config.ts` `coverage.include`, and the sync-core contract test in the same change.

## Tier A — core (`sync-core` gate)

| File | Tier | Why included | Public entry | Gate | Change rule |
| --- | --- | --- | --- | --- | --- |
| `src/sync/session.ts` | A core | Durable Session create/verify/terminate; credential/scope/lease binding | `createSyncSession`, `verifySyncSessionContext`, `requireVerifiedSyncSession` (root + sync barrel) | `sync-core` | New Session binding dimension → update row + tests |
| `src/sync/session-bootstrap.ts` | A core | Collection bootstrap coordinator on Session write path | `coordinateSessionBootstrap` | `sync-core` | New bootstrap port → Tier A dep review |
| `src/sync/session-bootstrap-guards.ts` | A core | Production dependency of bootstrap shape and stored-state equality validation | (internal to bootstrap) | `sync-core` | Follows bootstrap imports |
| `src/sync/session-bootstrap-state.ts` | A core | Production dependency of `session-bootstrap.ts` (lane/aggregate state) | (internal to bootstrap; types via barrel) | `sync-core` | Follows bootstrap imports |
| `src/sync/sequence.ts` | A core | Sequence lane ownership, replay, gap/block, safe-integer advance | `coordinateSequenceOperation` | `sync-core` | New Sequence decision kind → update |
| `src/sync/sequence-validation.ts` | A core | Production dependency of `sequence.ts` (lane/request/receipt/evaluation normalization and equality) | (internal; types via barrel) | `sync-core` | Follows Sequence imports |
| `src/sync/push-transaction.ts` | A core | Atomic Push commit/rollback, receipt/conflict/cursor/audit/outbox matrix, `reevaluateDeferred` opt-in | `coordinatePushTransaction` | `sync-core` | New Push artifact → update |
| `src/sync/push-transaction-guards.ts` | A core | Production dependency of `push-transaction.ts` (request/plan/result/receipt normalization) | (internal; types via barrel) | `sync-core` | Follows push-transaction imports |
| `src/sync/push-unit-of-work.ts` | A core | Push adapter contract and execution scope (Collection + Sequence lanes in lock order) | `SyncUnitOfWork`, `PushExecutionScope` (types via barrel) | `sync-core` | Scope/lock-order change → update |
| `src/sync/pull.ts` | A core | Pull cursor order, event/cursor consistency, receiver-bound scope | `coordinateSyncPull` | `sync-core` | New Pull event kind → update |
| `src/sync/pull-cursor-lifecycle.ts` | A core | Pull start cursor: initial issuance, same-Session continuation, adapter-verified cross-Session handoff | via `coordinateSyncPull` / `host.pull` | `sync-core` | New cursor transition → update |
| `src/sync/canonical.ts` | A core | Browser-safe protocol digest + effect-page URL expansion; production `./sync` re-exports the same functions | `@collection-protocol/node/sync/canonical` | `sync-core` | Digest framing change → update corpus |
| `src/sync/canonical-json.ts` | A core | Production dependency of canonical digest (I-JSON snapshot + RFC 8785) | (internal; `encodeCanonicalJson` via canonical) | `sync-core` | Follows canonical imports |
| `src/sync/replica-lifecycle.ts` | A core | Replica active/expired/recovery/retired coordinator + VerifiedSession auth proof; system-initiated due expiry | `coordinateReplicaLifecycle`, `coordinateReplicaDueExpiry`, `createReplicaAuthProofFromVerifiedSession` | `sync-core` | New lifecycle command → update |
| `src/sync/replica-lifecycle-transitions.ts` | A core | Production dependency of replica-lifecycle transitions | (internal; `transitionReplicaLifecycle` re-export) | `sync-core` | Follows lifecycle imports |
| `src/sync/replica-lifecycle-parsing.ts` | A core | Production dependency of lifecycle parse/validate | (internal) | `sync-core` | Follows lifecycle imports |
| `src/sync/operation-reuse.ts` | A core | Lifetime op-id claim + reuse audit for Push/Sequence/Bootstrap | `claimSyncOperation`, `appendSyncOperationReuseAudit` | `sync-core` | New reuse code → update |
| `src/sync/tombstone-purge.ts` | A core | Durable tombstone purge coordinator (retention / ack / watermark) | `coordinateTombstonePurge` | `sync-core` | New purge reason → update |
| `src/sync/tombstone.ts` | A core | Sync Tombstone construction from Deletion Receipt + cursor | `createSyncTombstone` | `sync-core` | Receipt field change → update |
| `src/sync/typed-operations.ts` | A core | Production dependency of Push typed-update payload assert (SYNC-0016) | `assertSyncTypedUpdateOperationPayload` | `sync-core` | Follows Push typed-update imports |
| `src/sync/typed-update-merge.ts` | A core | Core Sync typed-update merge semantics for write planning (SYNC-0016); root-exported; without it hosts still push, but Core merge evidence lives here—not adapter | `mergeSyncTypedUpdate`, `mergeTypedUpdate` | `sync-core` | Merge rule change → update; do not demote to hide gaps |
| `src/shared/immutable-json.ts` | A core | Production dependency of Session/Sequence/Push/Pull/Bootstrap/tombstone immutability | `immutableJsonData` (also tested directly) | `sync-core` | Follows Tier A imports |
| `src/sync/internal-guards.ts` | A core | Production dependency of Tier A Promise/plain-object guards | (internal) | `sync-core` | Follows Tier A imports |

| `src/sync/authoritative-effect-kind.ts` | A core | Runtime Pull effect domain/binding validation extracted from pull.ts | assertEffectBinding via authoritative Pull | sync-core | Follow runtime imports; semantic negatives must recompute digests |
| `src/sync/host-composition-recipe.ts` | A core | Required typed-update merge and atomic same-target projections on the recommended production Push path | createTypedUpdateMergePushPreflight | sync-core | Runtime planning is not documentation-only composition |
| `src/sync/subtree-observation.ts` | A core | Runtime subtree observation export used by canonical Sync operations | subtreeDeleteSource | sync-core | Follows canonical runtime exports |
| `src/sync/pull-page-budget.ts` | A core | Whole-page member/byte budget and same-cut prefix selection for Pull event-store pages | via `coordinateSyncPull` | sync-core | Follows Pull runtime imports |

### Sync Stryker mutate list (local critical mutation)

`stryker.sync.config.mjs` `mutate` is a **subset** of the Tier A files above, not the `sync-core` coverage gate. `npm run test:mutation:sync` (via local `test:mutation:critical`) reads the shared manifest and mutates these eleven files:

- `src/sync/session.ts`
- `src/sync/sequence.ts`
- `src/sync/replica-lifecycle.ts`
- `src/sync/replica-lifecycle-transitions.ts`
- `src/sync/pull.ts`
- `src/sync/pull-cursor-lifecycle.ts`
- `src/sync/push-transaction.ts`
- `src/sync/push-unit-of-work.ts`
- `src/sync/typed-update-merge.ts`
- `src/sync/authoritative-effect-kind.ts`
- `src/sync/host-composition-recipe.ts`

Tier A files **deliberately omitted** from critical Sync mutation (still gated by `test:coverage:sync-core`; do not expand this mutate list here):

- `src/sync/session-bootstrap.ts`
- `src/sync/session-bootstrap-guards.ts`
- `src/sync/session-bootstrap-state.ts`
- `src/sync/sequence-validation.ts`
- `src/sync/replica-lifecycle-parsing.ts`
- `src/sync/operation-reuse.ts`
- `src/sync/tombstone-purge.ts`
- `src/sync/tombstone.ts`
- `src/sync/typed-operations.ts`
- `src/shared/immutable-json.ts`
- `src/sync/internal-guards.ts`
- `src/sync/canonical.ts`
- `src/sync/canonical-json.ts`
- `src/sync/subtree-observation.ts`
- `src/sync/pull-page-budget.ts`

The executable gate also walks value imports and exports inside src/sync, excluding type-only links. Extracting a runtime dependency now fails the gate until it is classified in the manifest. The recipe is promoted from Tier B because its projections directly determine atomic Push correctness.

### Contested Tier A decisions

| File | Decision | Reason |
| --- | --- | --- |
| `src/sync/replica-capability.ts` | **Tier B** (not A) | Safari adapter capability / public HTTP Manifest boundary (SYNC-0021). Core write SM (Session/Sequence/Push/Pull/Replica lifecycle/tombstone) completes without it. |
| `src/sync/typed-update-merge.ts` | **Tier A** | Not imported by Push today, but it is Core Sync write-semantics (root export) rather than host composition. Keeping it in Tier A prevents treating merge as optional adapter coverage. |
| `src/sync/composition.ts` | **Tier B** | Session-bound host composition wrappers; Core coordinators remain callable without it. |
| `src/sync/host.ts` | **Tier B** | Production `createSyncHost` exclusive-owner façade. |
| `src/sync/unsafe.ts` | **Tier B** | Explicit composition-free coordinator subpath; not a production default. |
| `src/sync/legacy.ts` | **Tier C** | Internal pure reducers kept for property tests; must not inflate Core-used numbers. |

## Tier B — adapter / composition (not `sync-core`)

| File | Tier | Why included | Public entry | Gate | Change rule |
| --- | --- | --- | --- | --- | --- |
| `src/sync/composition.ts` | B adapter-composition | Session-bound Push/Pull/Sequence host helpers | `coordinateSessionBound*` | adapter / aggregate Sync | Stay out of `sync-core` include |
| `src/sync/host.ts` | B adapter-composition | Typed exclusive `createSyncHost` production façade | `createSyncHost` | adapter / aggregate Sync | Stay out of `sync-core` include |
| `src/sync/unsafe.ts` | B adapter-composition | Explicit composition-free coordinators | `@collection-protocol/node/sync/unsafe` | adapter / COLP tests | Stay out of `sync-core` include |
| `src/sync/browser-batch-adapter.ts` | B adapter-composition | Browser batch driver | `applySyncBrowserBatch` | adapter / aggregate Sync | Stay out of `sync-core` |
| `src/sync/browser-event-translation.ts` | B adapter-composition | Browser event → operation translation | `translateSyncBrowserEvent` | adapter / aggregate Sync | Stay out of `sync-core` |
| `src/sync/root-mapping.ts` | B adapter-composition | Browser root mapping | `establishSyncRootMapping` | adapter / aggregate Sync | Stay out of `sync-core` |
| `src/sync/root-mapping-adapter.ts` | B adapter-composition | Root-mapping adapter types | (adapter) | adapter / aggregate Sync | Stay out of `sync-core` |
| `src/sync/sidecar.ts` | B adapter-composition | Sidecar persist/export | `persistSyncSidecar` | adapter / aggregate Sync | Stay out of `sync-core` |
| `src/sync/extension-relay.ts` | B adapter-composition | Extension carrier relay | `relaySyncExtensionCarrier` | adapter / aggregate Sync | Stay out of `sync-core` |
| `src/sync/netscape-bookmark.ts` | B adapter-composition | Netscape bookmark format conversion | `parseNetscapeBookmarkHtml` | adapter / aggregate Sync | Stay out of `sync-core` |
| `src/sync/separator-visual.ts` | B adapter-composition | Separator UI projection | `representSyncSeparatorVisually` | adapter / aggregate Sync | Stay out of `sync-core` |
| `src/sync/light-pull-advisory.ts` | B adapter-composition | Advisory before Push; not durable SM | `adviseLightPullBeforePush` | adapter / aggregate Sync | Stay out of `sync-core` |
| `src/sync/replica-capability.ts` | B adapter-composition | Safari Replica Capability declaration | `declareSafariReplicaCapability` | adapter / aggregate Sync | Stay out of `sync-core` |

Tier B retains the aggregate `src/sync/**` non-regression floor only; no separate release gate in U-3. A future adapter gate may pin B without folding into Tier A.

## Tier C — legacy / compatibility (not `sync-core`)

| File | Tier | Why included | Public entry | Gate | Change rule |
| --- | --- | --- | --- | --- | --- |
| `src/sync/legacy.ts` | C legacy-compatibility | Internal pure Sequence/tombstone/typed-update reducers for property tests; not exported from any package entry | (internal) | legacy / aggregate Sync | Never add to `sync-core` |
| `src/sync/index.ts` | C legacy-compatibility | Public barrel and shared receipt types | sync barrel | legacy / aggregate Sync | A new Tier A export must also list the implementing module under A |

Executable gate: `vitest.sync-core.config.ts` `coverage.include` must list every Tier A file path above. Contract: `tests/sync/sync-core-quality-gates-contract.test.ts`. Triage ledger: `reports/audit/sync-core-coverage-triage.md`.
