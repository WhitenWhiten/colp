# Sync Progress

| Requirement | Status | Evidence tests | Acceptance attempt | Planned subject | Protocol Correction |
|---|---|---:|---:|---|---|
| SYNC-0001 | Accepted | 20 | 1 | `feat(colp): satisfy SYNC-0001 principal collection session binding` | No |
| SYNC-0002 | Accepted | 28 | 1 | `feat(colp): satisfy SYNC-0002 durable sequence replay` | No |
| SYNC-0003 | Accepted | 30 | 1 | `feat(colp): satisfy SYNC-0003 typed update DTO boundaries` | No |
| SYNC-0004 | Accepted | 47 | 1 | `feat(colp): satisfy SYNC-0004 atomic push transaction` | No |
| SYNC-0005 | Accepted | 44 | 1 | `feat(colp): satisfy SYNC-0005 authoritative pull order` | No |
| SYNC-0006 | Accepted | 58 | 1 | `feat(colp): satisfy SYNC-0006 durable tombstone purge` | No |
| SYNC-0007 | Accepted | 68 | 1 | `feat(colp): satisfy SYNC-0007 atomic session bootstrap` | No |
| SYNC-0008 | Accepted | 25 | 1 | `feat(colp): satisfy SYNC-0008 sync tombstone cursor boundary` | No |
| SYNC-0009 | Accepted | 70 | 1 | `feat(colp): satisfy SYNC-0009 durable replica lifecycle` | No |
| SYNC-0010 | Accepted | 38 | 1 | `test(colp): satisfy SYNC-0010 canonical wire model boundary` | No |
| SYNC-0011 | Accepted | 47 | 1 | `test(colp): satisfy SYNC-0011 durable sequence scope uniqueness` | No |
| SYNC-0012 | Accepted | 66 | 1 | `feat(colp): satisfy SYNC-0012 lifetime operation id uniqueness` | No |
| SYNC-0013 | Accepted | 79 | 1 | `feat(colp): satisfy SYNC-0013 audited operation reuse conflicts` | No |
| SYNC-0014 | Accepted | 52 | 1 | `test(colp): satisfy SYNC-0014 result field semantics` | No |
| SYNC-0015 | Accepted | 126 | 1 | `test(colp): satisfy SYNC-0015 operation target revision boundary` | No |
| SYNC-0016 | Accepted | 11 | 1 | `feat(colp): satisfy SYNC-0016 typed update key-set semantics` | No |
| SYNC-0017 | Accepted | 25 | 1 | `feat(colp): satisfy SYNC-0017 three-way merge and Tag OR-set` | No |
| SYNC-0018 | Accepted | 6 | 2 | `feat(colp): satisfy SYNC-0018 light-pull advisory surface` | No |
| SYNC-0019 | Accepted | 6 | 2 | `feat(colp): satisfy SYNC-0019 browser batch ordering` | No |
| SYNC-0020 | Accepted | 6 | 2 | `feat(colp): satisfy SYNC-0020 Netscape bookmark production parser` | No |
| SYNC-0021 | Accepted | 5 | 1 | `feat(colp): satisfy SYNC-0021 Safari replica capability boundary` | No |
| SYNC-0022 | Accepted | 13 | 1 | `feat(colp): satisfy SYNC-0022 dynamic root mapping` | No |
| SYNC-0023 | Accepted | 6 | 2 | `feat(colp): satisfy SYNC-0023 separator visual projection` | No |
| SYNC-0024 | Accepted | 15 | 1 | `feat(colp): satisfy SYNC-0024 sidecar persistence` | No |
| SYNC-0025 | Accepted | 9 | 1 | `feat(colp): satisfy SYNC-0025 sidecar export entry point` | No |
| SYNC-0026 | Accepted | 10 | 1 | `feat(colp): satisfy SYNC-0026 delete subtree translation` | No |

## Honesty notes (SYNC-V-001 / SYNC-V-014)

- **Accepted** only when production code under `packages/node/src/sync/**` plus registered evidence tags reasonably satisfy the requirement.
- **SYNC-0016** covers key-set equality + post-schema `422 invalid_document` cross-object check only (`validateSyncTypedUpdateOperationPayload`). It does **not** claim three-way merge.
- **SYNC-0017** production merge is `mergeSyncTypedUpdate` (`typed-update-merge.ts`) with Tag Observed-Remove via `mergeSyncTagsObservedRemove`. Evidence: `sync.typed-update-merge` (+ boundary `sync.typed-update-merge-boundary`). Key-set validation remains SYNC-0016 only.
- **SYNC-0018** production advisory is `adviseLightPullBeforePush` (`light-pull-advisory.ts`); host-supplied conflict facts fail closed toward `pull_first`.
- **SYNC-0020** production parser is `parseNetscapeBookmarkHtml` (`netscape-bookmark.ts`); tests bind the production API via `sync.netscape-bookmark`. Parser fail-closed rejects non-http(s) HREF schemes (`javascript:`, `data:`, `file:`, etc.) after entity decode.
- **SYNC-0023** production projection is `projectSyncSeparatorForUi` / `representSyncSeparatorForUiMode`; tests bind the production API via `sync.separator-visual`.

## Composition honesty (SYNC-V-005 / SYNC-V-006 / SYNC-V-008 / SYNC-V-009)

- **Production host façade:** `createSyncHost` on `@collection-protocol/node/sync` requires a branded `VerifiedSyncSession` and exactly one write owner. Bare `coordinatePushTransaction`, `coordinateSyncPull`, and `coordinateSequenceOperation` live only on `@collection-protocol/node/sync/unsafe`.
- **Protocol digest identity:** Node and MV3 import `@collection-protocol/node/sync/canonical` (no Node builtins). Production `./sync` re-exports the same digest function objects.
- **Session-bound Push batchId:** `host.push` / `coordinateSessionBoundPush` accept only `bindSyncPushBatchId` (`b1.<sessionLength>.<sessionId>.<suffix>`, binding version 1). The suffix is non-empty, the length is canonical, and the id is one wire `opaqueId` of at most 128 characters. Session `a` and session `a.b` do not accept each other. A legacy `sessionId` or `sessionId.<suffix>` prefix is not unique; `legacySyncPushBatchInReceiptScope` matches an old retry only when the full session, principal, endpoint, and digest agree. When b1 framing would exceed 128 characters, the mint uses `b2.<sessionDigest>.<suffixDigest>`: two domain-separated SHA-256 base64url digests covering the full inputs, in 90 wire characters. Every legal Session and local ID up to 128 characters remains usable; b1 IDs that already fit keep their exact bytes and remain accepted for retries. `readSyncPushBatchBinding` returns the digests for version 2, not raw IDs. A host that derives its own server batch id still scopes that receipt by Session. The client `batchId` does not authorize a receipt.
- **Required host order:** verify Session → `createSyncHost({ owner, session })` → `host.sequence` or `host.push`; Pull via `host.pull`. See `packages/node/docs/ARCHITECTURE.md` § Sync composition boundary and [`SYNC_HOST_COMPOSITION.md`](../SYNC_HOST_COMPOSITION.md).
- **Typed-update merge-in-preflight:** For `update_*` operations, Push preflight **must** call `mergeSyncTypedUpdate` before apply. Prefer `createTypedUpdateMergePushPreflight` so Base/Current/Incoming merge cannot be skipped when hosts invent their own preflight glue. See [`SYNC_HOST_COMPOSITION.md`](../SYNC_HOST_COMPOSITION.md).
- **SYNC-V-009 exclusive ownership:** Sequence and Push are alternative opId reservation owners. Sequence alone enforces `sequence_gap` / `sequence_blocked`. Push does not embed Sequence continuity. There is **no** dual-owner sequenced-push facade (would violate reservation ownership).
- **SYNC-V-006 Replica auth:** Production request paths use `coordinateSessionBoundReplicaLifecycle`, which verifies the Session runtime brand and Collection binding before minting `ReplicaAuthProof`. Bare `authenticated: true` remains compatibility-only Host trust on the low-level coordinator. Test-only proof helpers live on the **testing surface only** (not package root / sync barrel).
- **SYNC-V-008 legacy pure helpers:** `decideSequence`, `canPurgeTombstone`, `haveMatchingTypedUpdateFields`, `transitionReplicaLifecycle`, etc. remain dual-exported with `@deprecated` and `src/sync/legacy.ts`; durable coordinators / `validateSyncTypedUpdateOperationPayload` are the production APIs.

## Residual audit closures (SYNC-V-007 / V-010 / V-011 / V-012 / V-013)

- **SYNC-V-007 Snapshot URL HTTPS default:** Expired Pull recovery accepts only absolute `https:` Snapshot URLs by default. Opt into `http:` via `coordinateSyncPull(..., { allowInsecureSnapshotUrl: true })`. Embedded URL credentials are always rejected. Optional `assertSnapshotUrlSafe` (e.g. built-in `rejectPrivateOrLocalSnapshotUrl` / `withRecommendedSnapshotUrlHostPolicy`) is the SSRF/allowlist hook after transport checks. **Bare** Pull: omitted hook = transport-only. **Session-bound** Pull: omitted hook defaults to `rejectPrivateOrLocalSnapshotUrl` (CGNAT + decimal/hex IPv4 literals included). Hosts that **fetch** Snapshot URLs still own DNS rebinding / allowlist policy.
- **SYNC-V-010 Wire integration:** See [`SYNC_WIRE_COMPLETENESS.md`](../SYNC_WIRE_COMPLETENESS.md). The package-level Sync capability and evidence are complete and `supportedProfiles` includes `sync`. Conflict-resolution and acknowledgement routes, framework middleware, persistence adapters, and the deployed HTTP surface remain host-owned. A host must pass deployment probes before publishing a Sync Manifest claim.
- **SYNC-V-011 Session `expiresAt`:** Optional RFC 3339 lease on create/active Session. `verifySyncSessionContext` durably terminates with `lease_expired` when server time (`terminatedAt`) is at or after `expiresAt`. Field remains optional (backward compatible).
- **SYNC-V-012 Number strictness:** Push/Pull/Sequence/bootstrap deep clones share `immutableJsonData` (`src/shared/immutable-json.ts`): finite numbers within ±`Number.MAX_SAFE_INTEGER` magnitude (allows domain decimals such as `1.5`; rejects NaN/±Infinity/unsafe integers). Explicit sequence fields still use `Number.isSafeInteger`. Protocol times stay RFC 3339 strings.
- **SYNC-V-013 Reservation owner brand:** `operationIdReservationOwner` is a compile-time brand; runtime exclusivity is host composition + durable claim store (docs on UoW types, `SYNC_HOST_COMPOSITION_NOTES`, `ARCHITECTURE.md`). No dual-owner facade.
