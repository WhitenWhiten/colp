# P1 reliability migration

Status: proposed changes under review. The source changes and regression tests
in this branch are not a deployment-conformance claim. Full package verification
and real database concurrency tests remain required before merge and deployment.

## Publisher rollback boundary

`executePublisherGuardedNodeWrite` now lets Core guard failures reject the
transaction callback. A concealed Problem is mapped only after the UnitOfWork
has rejected and rollback has completed. In particular, a writer that stages
business mutations and then fails affected-node validation must not commit.

Adapters must preserve the original rejection while rolling back, reject on an
unknown commit outcome, and never turn a rejected callback into a committed
return value. Authentication/concealment failures that occur before the Core
write path keep their existing response semantics.

The new rollback regression tests inspect committed state and rollback order,
not merely the returned error code.

## Linear array validation

Core and Publisher structured-data checks now share
`src/shared/plain-structured-data.ts`. Dense array own-key validation is linear
and does not read array element accessors. Prototype, descriptor and Proxy
checks remain in place. This is an internal helper, not a new package export.

The regression tests exercise malformed arrays and count property accesses for
large inputs rather than relying on machine-dependent timing thresholds. This
change does not make all large graph operations non-blocking; host traversal
limits and operation-cost admission remain necessary.

## Collection creation idempotency

For `executePublisherCollectionCreate`, `binding.resourceIdentity` must name the
stable authenticated instance/mount creation scope. It must not be the newly
allocated `collectionId` or `rootNodeId`. Use the same stable scope when building
the canonical request digest; exclude allocated result IDs from the request
body and digest dimensions.

A retry may arrive with different unused server IDs. If the durable claim is a
replay, the stored Collection/Root pair wins and its internal referential
integrity is checked independently of those new IDs. Only a newly claimed
request reserves and persists its proposed IDs.

Audit existing callers and stored idempotency keys before adopting this
contract. An old result-ID-keyed claim will not automatically match a new
scope-keyed retry. Preserve the original retention guarantee and provide an
explicit migration/reconciliation policy; do not simply discard old claims or
claim duplicate-free retries across the migration without evidence.

## Bootstrap Session writes and lock scope

`SessionBootstrapSessionStore.save(session, expected)` now receives the exact
active, instance-scoped, unbound Session observed by the coordinator. The adapter
must atomically compare that expected state (or an equivalent storage version)
and perform the update in the same database transaction as all other bootstrap
writes. A mismatch must reject the transaction. It must never overwrite a bound
or terminated Session.

Serialize bootstrap work by `lane.sessionId` across Replica IDs and server
processes, including concurrent Session termination. `(replicaId, sessionId)`
remains the receipt identity; it is not a sufficient shared-Session lock key.
A read-back inside one transaction is not a substitute for a conditional write
or cross-process isolation.

An older one-argument `save` implementation can still satisfy TypeScript's
function compatibility rules. Compilation alone therefore does not establish
migration: inspect the adapter implementation and verify the condition in real
database concurrency tests. The package does not provide database locks.

## Replica lifecycle scope

`coordinateSessionBoundReplicaLifecycle` and `createSyncHost().replica` require
a Collection-scoped Session whose Collection exactly matches the lifecycle key.
Instance bootstrap Sessions with `collectionId: null` are not wildcard authority
for registration, retirement, renewal, resume, or recovery operations on existing
Collections. Hosts still own Replica identity binding and command authorization.

## Focused verification

Run from `packages/node/` after the repository's lockfile-based dependency setup:

```sh
npm run typecheck
npm run check:source-size
npx vitest run \
  tests/publisher/node-write-rollback-regression.test.ts \
  tests/publisher/publish-0012-collection-root-atomic-contract.test.ts \
  tests/publisher/publish-0013-node-read-only-concealment.test.ts \
  tests/publisher/unit-of-work.test.ts \
  tests/shared/dense-array-keys.test.ts \
  tests/shared/plain-structured-data.test.ts \
  tests/sync/replica-session-scope-regression.test.ts \
  tests/sync/session-bootstrap.test.ts \
  tests/sync/session-bootstrap-guards.test.ts \
  tests/sync/composition-contract.test.ts
npm run test:coverage:publisher
npm run test:coverage:sync-core
```

These are verification instructions.
The in-memory test adapters implement the expected-state write condition; this
does not attest an external database adapter or cross-process Session lock.

Do not hand-edit the bundled evidence. After source or test changes, run
`npm run refresh:evidence` and then the release checks. Until those checks and adapter migration are complete, keep the PR in
draft and do not merge or advertise new deployment claims.
