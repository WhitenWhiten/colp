# Sync host composition recipe

**Status:** package integration guidance for a host-owned Sync HTTP surface

**Module:** `packages/node/src/sync/host.ts` (`createSyncHost`), `host-composition-recipe.ts`  
**Related:** `composition.ts` session-bound gates, `ARCHITECTURE.md` § Sync composition boundary

The package supplies the Sync behavior and required composition order. The host
owns route registration, middleware, authentication, durable ports, and probe
execution. See [`HOST_INTEGRATION_BOUNDARY.md`](HOST_INTEGRATION_BOUNDARY.md).

## Production path vs explicit unsafe

Production hosts import **only** `@collection-protocol/node/sync` and call
`createSyncHost({ owner: 'sequence' | 'push', session })` with a package-minted
`VerifiedSyncSession`. The returned host can dispatch exactly one write owner
plus session-bound Pull / Replica.

Composition-free coordinators (`coordinateSequenceOperation`,
`coordinatePushTransaction`, `coordinateSyncPull`) are **not** on `./sync`.
They live on the explicit `@collection-protocol/node/sync/unsafe` subpath for
COLP tests and adapter fixtures. That subpath is not a production default.
Production hosts must not import it.

| Concern | `./sync/unsafe` | Production `createSyncHost` |
|--------|------------------|-----------------------------|
| Session credential / scope | Not enforced | Branded Session required at construction; scope checked per method |
| Verified session brand | N/A | Runtime brand; forged objects fail closed |
| Push `batchId` ↔ Session | Not enforced | `bindSyncPushBatchId` then `host.push` |
| Typed-update three-way merge | Easy to skip | `createTypedUpdateMergePushPreflight` |
| Snapshot URL private/local | Transport-only unless hook set | Session-bound default |
| Sequence vs Push ownership | Host discipline only | Typed XOR dispatcher; no dual-owner facade |
| Replica auth | Proof-built command required (`asReplicaAuthenticatedCommand`) | `host.replica` mints proof from the Session |

## Checklist (`SYNC_HOST_COMPOSITION_RECIPE`)

1. **Session first, on every request** — call `requireVerifiedSyncSession` with current authentication, binding and server time, then `createSyncHost` in the same process. `verifySyncSessionContext` returns a result union, not the branded Session required by the factory.
2. **Exclusive write owner** — `owner: 'sequence'` **or** `owner: 'push'`. Never nest; no dual-owner “sequenced push” facade.
3. **Pull after Session** — `host.pull` (or `coordinateSessionBoundPull`).
4. **Typed-update merge in preflight** — for `update_*`, Push preflight **must** call `mergeSyncTypedUpdate({ base, current, incoming })` before apply.

## Request lifetime and cluster boundaries

`createSyncHost` captures a verified snapshot; it does not reload the Session
store, reauthenticate a credential, or refresh its lease on later method calls.
Construct it inside each request and discard it afterward. Derive verification
input from the current trusted request binding, credential status, effective
scopes and server time, not a previous request or caller-supplied JSON.

The following wrapper verifies before invoking any host work. Its callback is
the current request handler; do not retain or return the host/session for reuse.
For a Sequence deployment, use the same verification order and construct
`createSyncHost({ owner: 'sequence', session })` instead.

<!-- colp-consumer: sync-request-lifetime -->
```ts
import {
  createSyncHost,
  requireVerifiedSyncSession,
  type PushSyncHost,
  type PushReplicaOwnershipVerifier,
  type SyncSessionStore,
  type VerifySyncSessionContextInput,
} from '@collection-protocol/node/sync';

export async function withSyncPushRequest<Result>(
  store: SyncSessionStore,
  input: VerifySyncSessionContextInput,
  pushOwnershipVerifier: PushReplicaOwnershipVerifier,
  handle: (host: PushSyncHost) => Promise<Result>,
): Promise<Result> {
  const session = await requireVerifiedSyncSession(store, input);
  const host = createSyncHost({ owner: 'push', session, pushOwnershipVerifier });
  return handle(host);
}
```

`VerifiedSyncSession` has a process-local object-identity brand. Do not send
it or a host object across worker/process boundaries, serialize it for reuse,
or cast a loaded record to the branded type. Each worker re-verifies against
the shared durable Session store and creates its own request-scoped host.
Store termination must be atomic, irreversible, and visible to other workers.

`terminatedAt` — on `terminateSyncSession` and as the server time passed to
`verifySyncSessionContext` / `requireVerifiedSyncSession` — must be an RFC 3339
date-time with an offset, the same contract as `expiresAt`. It is validated
before any store call, because credential revocation, scope reduction and lease
expiry may persist it as the termination time. Lease expiry stays inclusive
(`now >= expiresAt`). A stored terminated record whose `terminatedAt` is
malformed (for example written by an older adapter) fails closed on read with a
`TypeError`; the Session remains unusable, and the record should be repaired
to a valid timestamp.

The lower-level `coordinateSessionBound*` APIs additionally accept
`{ kind: 'verify', store, input }` and perform the gate for that call.
`kind: 'verify'` is not a `createSyncHost` option. Their
`kind: 'verified'` form requires a freshly minted Session from this request.

## Production helper (host-port sketch)

This sketch runs inside a request; Session store, verification input, database
ports and operation planners are supplied by the host.

```ts
import {
  bindSyncPushBatchId,
  createSyncHost,
  createTypedUpdateMergePushPreflight,
  requireVerifiedSyncSession,
} from '@collection-protocol/node/sync';

const session = await requireVerifiedSyncSession(sessionStore, verificationInput);
const host = createSyncHost({ owner: 'push', session, pushOwnershipVerifier });
const preflight = createTypedUpdateMergePushPreflight({
  loadCurrent: async (operation) => /* server projection for operation.targetId */,
  planMerged: async ({ merged, operation, item }) => /* applied/rebased plan using merged */,
  planConflict: async ({ conflicts, operation }) => /* conflicted plan */,
  planOther: async (item, index) => /* create/delete/move/… plans */,
});

const request = {
  batchId: bindSyncPushBatchId(session.sessionId, 'local-batch-1'), // versioned opaqueId; not a sessionId prefix
  atomic: true,
  serverCursor: '…',
  operations: [/* … */],
};

await host.push(unitOfWork, request, preflight);
```

`pushOwnershipVerifier(session, { replicaId, collectionId })` must consult the
host's durable principal/tenant/credential-to-Replica binding and return `true`
only for an authorized Replica. Every distinct Replica is checked before any
receipt lookup, claim, audit or batch write, including exact receipt replays.
Missing evidence denies Push; `false` denies ownership and malformed evidence
is an adapter error. Checks only in `preflight` cannot protect replays, which
skip that callback. The lifecycle `ownershipVerifier` remains separate.
Direct `coordinateSessionBoundPush` callers supply `pushOwnershipVerifier` on
the Session gate or pass it as the fifth argument. Hosts that previously relied
on route checks must wire that verifier explicitly before calling Push.

- `base` / `incoming` come from `operation.payload.base` / `operation.payload.value` (after SYNC-0016 assert).
- `current` is host-loaded server state.
- On `status: 'merged'`, use `applySyncTypedUpdatePatch(current, merged)` to apply the domain patch. An `undefined` patch value preserves/removes a missing field; explicit `null` remains a value. Unmentioned fields remain unchanged. Persist these same semantics rather than spreading the patch or replacing current with raw incoming.
- On `status: 'conflict'`, host builds the conflicted `PushPreparedOperation`.
- **Session-bound Push `batchId`:** `coordinateSessionBoundPush` accepts only the versioned binding from `bindSyncPushBatchId` (`b1.<sessionLength>.<sessionId>.<suffix>`, binding version 1). `sessionLength` is the canonical decimal length of the full session id, the suffix is an independent non-empty opaque segment, and the whole id is one wire `opaqueId` of at most 128 characters. Session `a` and session `a.b` do not accept each other's ids. A legacy `sessionId` or `sessionId.<suffix>` value is **not** a unique binding: `opaqueId` may contain `.`. `legacySyncPushBatchInReceiptScope` is the compatibility entry, and it matches a retry only when the full session, principal, endpoint, and digest all agree. When b1 framing would exceed 128 characters, the mint uses `b2.<sessionDigest>.<suffixDigest>`: two domain-separated SHA-256 base64url digests covering the full inputs, in 90 wire characters. Every legal Session and local ID up to 128 characters remains usable; b1 IDs that already fit keep their exact bytes and remain accepted for retries. `readSyncPushBatchBinding` returns the digests for version 2, not raw IDs. A host that derives its own server batch id still scopes that receipt by Session; the client `batchId` does not authorize a receipt. Do not use `sessionId:` or `sessionId/` — those characters are not legal in `opaqueId`.
- **Verified session brand:** Use the request-lifetime recipe above. Plain active records and copied/serialized branded records are rejected; the factory and its methods do not substitute for the per-request durable verification gate.
- **Deferred receipts:** both write owners share one contract — a stored `deferred` receipt replays exactly unless the request sets `reevaluateDeferred: true`. With the flag, Push re-runs preflight for that operation and hands it `context.previousDeferredReceipt` (same shape as `SequenceEvaluationContext.previousDeferredReceipt`); a still-deferred plan replays the stored receipt unchanged, a terminal plan replaces the receipt and appends the operation normally. In an atomic batch a still-deferred re-evaluation throws `AtomicPushNotCommittableError`.

### Push unit of work and serialization scope

`SyncUnitOfWork.execute(work, scope)` receives a `PushExecutionScope` derived
from the validated request: the sorted `collectionIds` and the Sequence
`lanes` (`replicaId`, `sequenceScope`) the transaction touches, sorted by
`replicaId` then `sequenceScope`. An atomic batch — including the transaction
that only persists a reuse-denial audit — covers every lane in the batch; each
non-atomic operation covers its own lane. The adapter must:

- serialize transactions per lane across processes, acquiring lane locks in
  `scope.lanes` order (row locks or advisory locks); disjoint lanes need not
  wait on each other;
- keep `(replicaId, sequenceScope, sequence)` receipts unique;
- keep operation IDs globally unique (a unique lifetime-claim index), because
  lane locks do not cover the same opId arriving on two lanes;
- commit receipt, business, audit and outbox writes atomically;
- reject — never resolve — on a uniqueness race or an uncertain commit, so a
  retry observes the durable receipt and replays or is denied.

`receipts.save(receipt, condition)` receives a `PushReceiptWriteCondition`
matching Sequence's receipt conditions. `{ kind: 'absent' }` (first
evaluation) inserts only when no receipt exists for the operation ID or the
Sequence tuple. `{ kind: 'replace_deferred', operationId, digest }` (a
terminal deferred re-evaluation) replaces only a `deferred` receipt with that
identity and digest; terminal receipts are never overwritten. Still-deferred
re-evaluations and replays perform no receipt write. Check the condition
atomically with the write and throw `PushReceiptConditionFailedError` when it
fails: the coordinator lets it propagate, the transaction rolls back, and the
host treats it as retryable (the retry replays or is denied). Report storage
faults with their own errors and never as `SyncOperationReuseError`. An
insert-only adapter that ignores `condition` cannot serve `reevaluateDeferred`;
that is an adapter limitation, not a coordinator fault.

`SyncTransaction` lists only what Push uses: `receipts`, the lifetime claim
and reuse-audit stores, `appendOperation`, `saveConflict`, `allocateCursor`,
`appendAudit` and `appendOutbox`. The former `replicas`,
`advancePurgedThroughCursor` and `saveDeletionWatermark` members were never
called by Push and were removed; Replica and purge ports live on
`ReplicaLifecycleTransaction` and the Tombstone purge transaction. Adapter
classes keep compiling; an object literal annotated as `SyncTransaction`
that still sets those members must drop them (excess-property check).

The `scope` argument was added without changing the callback position, so an
adapter written against the earlier one-argument signature still compiles.
Such an adapter remains correct if it serializes all Push transactions
globally or binds one request per transaction; `scope` lets it narrow
serialization to the affected lanes.

### Transaction callbacks run exactly once

Every Sync unit of work (`SyncUnitOfWork`, `SequenceCoordinatorUnitOfWork`,
`ReplicaLifecycleUnitOfWork`, `TombstonePurgeUnitOfWork`,
`SessionBootstrapUnitOfWork`) must invoke the callback it is given exactly
once per `execute` call. A second invocation throws `TypeError`, and the
coordinator also rejects a result that is not the one its callback returned.

This rules out transaction helpers that re-run the callback on a transient
error, such as a retrying `withTransaction` or a serialization-failure loop
around the callback. Open one transaction, run the callback once, and on a
transient failure roll back and reject `execute`. Retry at the coordinator
call: the request is validated again and persisted receipts replay whatever
already committed, so the retry is safe for both atomic and non-atomic Push
and for Sequence.

### Receipt retention

Lifetime Operation claims must outlive receipts. If a host purges old
receipts, a late retry of a purged Operation finds its claim (or a consumed
Sequence) without a receipt, and the coordinators throw
`SyncOperationReceiptUnavailableError` (`code: 'receipt_unavailable'`). The
Operation was consumed and must not run again, but its result is gone: answer
with a non-retryable Problem that sends the client to recovery, not a 500.
The error is also what a faulty adapter that loses a live receipt produces, so
hosts that never purge receipts can keep treating it as an adapter fault.

### Reuse denial after partial non-atomic progress

`atomic=false` commits each operation in its own transaction, so a
`sequence_reuse` / `op_id_reused` denial of operation *n* leaves operations
`0 … n-1` durable. The coordinator throws `PushOperationReuseError`, a
subclass of `SyncOperationReuseError`: hosts keep answering `409` with the
persisted audit, and may additionally surface `error.progress`:

- `results` — the committed (or replayed) prefix results;
- `failed` — index, `opId`, lane, `sequence` and `digest` of the denied operation;
- `serverCursor` — the latest cursor committed by this invocation, else the
  request's `serverCursor`.

The prefix snapshots each result under the same individual JSON budgets as a
successful Push, with the normal batch-count bound. It does not impose a
single-result member, depth or byte budget on the combined committed prefix.

Clients should persist the prefix results, then inspect local state for the
denied operation (the registry says to stop and check). Resending the
committed operations replays their stored results without new business
writes; resending the denied operation unchanged will be denied again, so
split or repair the batch rather than retrying it as is. Atomic batches keep
throwing plain `SyncOperationReuseError`; a denial there commits nothing.

### Deferred evaluation context

The recommended merge helper forwards an optional immutable evaluationContext
to every host callback: loadCurrent(operation, item, index, evaluationContext),
planMerged(mergeContext, evaluationContext),
planConflict(conflictContext, evaluationContext), and
planOther(item, index, evaluationContext). loadCurrent and its chosen planner
receive the same object. During deferred re-evaluation its
previousDeferredReceipt is a detached, deeply frozen copy; atomicBatch retains
the coordinator's opaque identity. Existing callbacks may omit the extra
parameter. First evaluation does not contain a previousDeferredReceipt, and
terminal receipt replay does not invoke these callbacks.

### Atomic typed-update projections

Atomic admission accepts applied, rebased, noop, and persisted conflicted outcomes.
A rejected or deferred item, including an exact replay of a stored result, rejects
the entire atomic request before business apply. Previously committed receipts are
unchanged; no new claims or receipts survive the failed transaction. Non-atomic
requests retain per-item rejection/deferred semantics. Hosts should throw their
typed authorization or precondition error during preflight for a specific Problem.

Each atomic preparation pass supplies a fresh opaque context.atomicBatch identity.
The merge helper overlays earlier applied/rebased typed patches on the same target;
later typed updates see that projected state before any apply callback runs.
Aborted, retried, and concurrent requests do not share projected state. Hosts must
persist the exact merged domain patch and provide isolation against other writers.

The generic helper cannot predict arbitrary create/delete/move effects. Atomic
mixed operations addressing the same target fail before apply and require a
host-provided pure preflight with a complete projected state model. Different
targets and non-atomic mixed operations remain supported.
Creates without a server-assigned target are tracked by operation identity, so
independent creates do not alias each other. Parent children-revision/placement
projection remains part of the host's planning and isolation responsibilities.

## Pull cursor lifecycle

`SyncPullRequestContext.cursor` is `string | null`. The Cursor store decides
every transition; the coordinator only checks that each answer is bound to the
exact cursor, Session and position it asked about (03-sync.md §8).

| Request | Store method | Result |
| --- | --- | --- |
| `cursor: null` (first Pull of a Session) | `issueInitialCursor(binding)` | Persist and return an `active` record bound to the current Session at the initial exclusive position. An empty page returns that cursor; a nonempty page ends with the final event cursor. Without the method, initial Pull throws. |
| Cursor recorded under the current Session | `resolveCursor` | Ordinary continuation. |
| Cursor recorded under an earlier Session, same principal, Collection and protocol version | `authorizeCursorHandoff(request)` | Return an authorization that echoes `cursor`, `fromSessionId`, `toSessionId` and `commitOrdinal` only when durable lineage evidence proves the succession (same Replica, lease/policy continuity, unexpired issuance). Return `null` otherwise → `400 invalid_cursor_scope`. A rebinding answer throws. Without the method, every cross-Session cursor is `invalid_cursor_scope`. |
| Different principal, Collection or protocol version | — | `400 invalid_cursor_scope`; the handoff hook is never consulted. |

Matching principal and Collection is only the precondition for asking about a
handoff, never the authorization. After a verified handoff, empty pages keep
echoing the input cursor byte for byte; the first nonempty page moves the
client into the new Session through event cursors, which must be bound to the
current Session. Expiry of a cross-Session cursor (`410 sync_cursor_expired`)
is disclosed only after its lineage is authorized.

Event cursors of a nonempty page are resolved through the optional
`resolveCursors(cursors)` in one call per page (at most `limit`, capped at
`SYNC_PULL_MAX_LIMIT`). Return exactly one record per requested cursor, in any
order; a missing, duplicate, unrequested or mismatched (Session, principal,
Collection, protocol, state or commit position) record fails the page. Without
`resolveCursors` the coordinator calls `resolveCursor` once per event — N+1
interface calls per page, whose database cost depends on the adapter. That
fallback remains supported for compatibility.

The start cursor and the event page come from two separate port calls, so
retention or a Tombstone purge can advance between them. `readCommittedAfter`
must therefore check `afterCommitOrdinal` against its earliest retained
position inside the read itself and throw `SyncPullLogTruncatedError`
(optionally with a Snapshot URL) when events after it are gone. The
coordinator turns that into `410 sync_cursor_expired`. Returning the events
that remain would hand the client a page with a silent gap.

Session rotation does not by itself require a new Bootstrap. Besides Pull
handoff, Session negotiation can rebase the client through an explicit
`serverCursor`, after which the client presents a cursor already bound to the
new Session. A Bootstrap or Snapshot is required only for recovery (cursor or
tombstone window lost, protocol-version cutover).

## Replica lease expiry

The lifecycle transaction's `readAuthoritativeTime()` is the only clock for
lease decisions. A well-formed `leaseExpiresAt` that is not later than that
time (`register`, `resume`, `complete_recovery`, `renew`), or a renewal that
does not strictly extend the current lease, returns
`{ state: 'denied', code: 'invalid_lease_expiry' }` without applying the
requested lease, a `recovery_required` transition, or a Snapshot Ack. This
happens when a host computes the expiry from its own clock and the
transaction's time has moved past it; recompute from fresh authoritative time
and retry. Malformed instants and reused lease identities remain `TypeError`
input-contract failures. Hosts that derive the expiry inside the transaction
from a validated duration (for example from database time) avoid
the race entirely. An already-elapsed active lease is still durably expired
first; a subsequent renewal is then `stale_replica`. This automatic expiry
is also committed when a `resume` request returns `invalid_lease_expiry`.
It records an already elapsed lease, independently of the denied request;
retrying that request does not write the expiry again.

## Replica acknowledgement

Resume and Tombstone purge both read a Replica's `acknowledgedCommitOrdinal`,
so the host must keep it current. After a client reports the cursor it has
durably applied (`POST sync/ack`), resolve that cursor through the Cursor
store, check it is bound to this Replica's Session and Collection, and issue

```ts
await host.replica(unitOfWork, { replicaId, collectionId }, {
  type: 'acknowledge', cursor, commitOrdinal: record.commitOrdinal, succeeded: true,
});
```

The acknowledgement only moves forward: an older or repeated position commits
without a write, including a newly authorized Session cursor for the same
commit ordinal after rotation. The stored cursor is retained for a no-op;
the host must still resolve and validate the presented cursor's binding before
issuing the command. A non-active Replica is denied `stale_replica`. Do not
write `acknowledgedCursor` / `acknowledgedCommitOrdinal` outside this command.

## Expired Pull Snapshot URL host policy

**Who fetches owns SSRF.** Transport safety (HTTPS + no userinfo) is not SSRF safety.

- `coordinateSessionBoundPull` **defaults** `assertSnapshotUrlSafe` to `rejectPrivateOrLocalSnapshotUrl` via `withRecommendedSnapshotUrlHostPolicy` when the hook is omitted.
- Bare `coordinateSyncPull` stays transport-only when the hook is omitted (backward compatible).
- Built-in rejector is pure hostname/IP-literal only (RFC1918, loopback, link-local, CGNAT `100.64.0.0/10`, decimal/`0x` IPv4 forms, common IPv6). No DNS — rebinding and public names that resolve private remain host-owned; prefer allowlists for production fetchers.

```ts
import {
  coordinateSessionBoundPull,
  withRecommendedSnapshotUrlHostPolicy,
} from '@collection-protocol/node/sync';

// Default session-bound path already installs private/local rejector:
await coordinateSessionBoundPull(gate, request, cursors, events);

// Explicit allowlist (overrides default):
await coordinateSessionBoundPull(gate, request, cursors, events, {
  assertSnapshotUrlSafe: (url) => {
    if (url.hostname !== 'snapshots.example.com') {
      throw new TypeError('Snapshot URL host not allowlisted.');
    }
  },
});

// Bare Pull still needs an explicit hook if you fetch recovery URLs:
// coordinateSyncPull(request, cursors, events, withRecommendedSnapshotUrlHostPolicy())
```

## Boundary reminders

- `@collection-protocol/node/sync/unsafe` stays composition-free and is not a production default.
- `host.push` binds `batchId` to the Session; the unsafe Push coordinator does not.
- This recipe does not mount routes or produce a deployment Profile claim; package-level Sync support is recorded separately in `supportedProfiles`.
- Sequence continuity remains Sequence-only; Push batch semantics remain Push-only.

## Complete subtree effect pages

After validating the bound operation effect, pass its root identity along with
the reference when validating the complete page series:

```ts
validateAuthoritativePullEventPages(pages, {
  ...effect.effectRef,
  effectId: effect.effectId,
  rootId: effect.rootTombstone.targetId,
});
```

`rootId` is required: a count and digest alone cannot prove the deletion includes
its root. This pre-release API tightening requires existing callers to supply the
root from their validated `subtree_deleted` effect. Do not apply partial pages or
advance a receiver cursor before the complete series passes validation.

## Root mapping concurrency

Root mapping initialization coalesces concurrent calls for the same adapter/root.
Hosts sharing browser state across adapter handles, workers, or processes must
implement SyncRootMappingAdapter.withRootMappingLock with a shared exclusive lock,
held through reading, root creation, and mapping persistence. Root creation must
leave a discoverable serverRootId marker for retry after mapping-save failure.
The local in-flight map is not a cross-process lock or a durable cache.

## Logical Operation vs HTTP attempt (C-01)

`SequenceOperationRequest` is the logical Operation identity: `replicaId`, `sequenceScope`,
`sequence`, `operationId`, and canonical `digest`. HTTP Session, Bearer, client/server batch,
request date, and tracing belong to the transport attempt. They MUST NOT change a successful
logical identity. Auth, account, Collection, and Replica lifetime checks stay **before** receipt
lookup. Same opId/sequence with different Operation bytes remains `sequence_reuse` / `op_id_reused`
and is not "did not execute". COLP compares the host-supplied `digest` as an opaque
string. A host that changes its digest algorithm should store which algorithm produced each
receipt and present a matching digest for replay when Operation bytes still match; it
must not map an algorithm change to `sequence_reuse`.

Public `assembleSnapshotPages` remains Sync **0.1**. Sync 0.2 paged Snapshot accumulation is a
separate, host-owned typed helper. Do not pass V02
pages to `assembleSnapshotPages` via `as any`.

## Trusted-host lifecycle exports

The public `./sync` barrel deliberately keeps `coordinateSessionBootstrap`,
`coordinateTombstonePurge`, `coordinateReplicaDueExpiry`, and `coordinateReplicaLifecycle`.
Bootstrap admission and durable maintenance fences belong to their host adapters;
Replica mutation uses a branded authentication proof. These helpers must not be wired
directly to untrusted request bodies. They are distinct from the three composition-free
data-plane entrypoints (`coordinatePushTransaction`, `coordinateSyncPull`,
`coordinateSequenceOperation`), which are restricted to `./sync/unsafe`.
The old comment claiming *all* bare coordinators were absent was too broad.

### Pull page memory budget

The SDK selects the largest prefix within its fixed whole-page member/byte budget from the same event-store read, then copies and validates that prefix. Truncation sets `hasMore: true` and ends the cursor at the last returned event. The original cut revision is retained; there is no re-query at a smaller limit. Single-event byte exemptions and per-event validation remain in force, so a legal large event stays deliverable and a malformed event cannot advance the cursor. Budget probing is bounded by the 1,000-entry request ceiling and uses descriptor reads, without invoking accessors.
