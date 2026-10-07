/**
 * P4A-I14 focused unit/contract suite: the bounded cleanup coordinator
 * (`runCleanupBatch`) + the I14 pure contract helpers + the adapter's
 * delete/confirm translation.
 *
 * Proves, with a recording in-memory store and a faithful in-memory ledger
 * (NO PostgreSQL, NO mock provider idempotence as a pass):
 *  - match -> DELETE exact key -> repeat HEAD absent -> completeCleanup
 *    'deleted' (DELETE 2xx alone is never absence; a DELETE 2xx with the
 *    object still present stays unknown_retryable);
 *  - initially missing / absent-before -> confirmed_absent with ZERO DELETE;
 *  - candidate mismatch (same key, different etag/size) -> quarantine with
 *    ZERO DELETE;
 *  - DELETE-success-but-response-lost converges via confirmed HEAD absent;
 *  - HEAD/DELETE timeout/5xx/unknown stay unknown_retryable with a BOUNDED
 *    in-process retry budget, then the claim lease is released (takeoverable);
 *  - commit-response-lost re-reads the DATABASE (committed_deleted /
 *    not_committed) — never infers rollback from the exception;
 *  - keyset cursor advance + short-page reset (fairness), retention deadline
 *    passed through to the claim, exact claimed key only (no key derived from
 *    the blob current pointer), no generation/tombstone row deletion;
 *  - the I14 pure helpers (retention boundary = DB-clock inclusive,
 *    resolveCleanupCommitUnknown) and the adapter delete/confirm translation
 *    including the RO-store fail-closed fallback.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createGenerationObjectStoreAdapter,
} from '../../../src/infrastructure/object-storage/index.js';
import {
  BlobStoreError,
} from '../../../src/infrastructure/object-storage/index.js';
import {
  generationRetentionDeadlineExpired,
  resolveCleanupCommitUnknown,
  runCleanupBatch,
  type AttachmentsLedgerPort,
  type CleanupFaultInjector,
  type RunCleanupBatchInput,
} from '../../../src/modules/attachments/index.js';
import {
  CleanupCommitOutcomeUnknownError,
  InMemoryCleanupLedger,
  InMemoryCleanupObjectStore,
  InMemoryCleanupUow,
  cleanupCrash,
  identityFor,
  makeI14Config,
  type InMemoryCleanupTx,
  type InMemoryGenerationRow,
} from '../../support/phase4a-i14-test-helpers.js';

type I14Tx = InMemoryCleanupTx;

const CONFIG = makeI14Config();

function rowFor(id: ReturnType<typeof identityFor>, overrides: Partial<InMemoryGenerationRow> = {}): Omit<InMemoryGenerationRow, 'attemptToken' | 'leaseOwner' | 'leaseGeneration' | 'leaseExpiresAt'> {
  return {
    generationId: id.generationId,
    blobId: id.blobId,
    key: id.key,
    fingerprint: id.fingerprint,
    observedEtag: `"etag-${id.generationId}"`,
    observedSize: 7,
    state: 'retired',
    createdAt: new Date('2026-08-08T00:00:00.000Z'),
    retiredAt: new Date('2025-06-01T00:00:00.000Z'),
    orphanedAt: null,
    currentGenerationId: id.generationId === 'never-current' ? null : `${id.generationId}-next`,
    ...overrides,
  };
}

function deps(
  ledger: InMemoryCleanupLedger,
  store: InMemoryCleanupObjectStore,
  uow: InMemoryCleanupUow,
  overrides: Partial<RunCleanupBatchInput<I14Tx>> = {},
): RunCleanupBatchInput<I14Tx> {
  return {
    ledger: ledger as unknown as AttachmentsLedgerPort<I14Tx>,
    objectStore: store,
    uow,
    config: CONFIG,
    leaseOwner: 'cleaner-1',
    ...overrides,
  };
}

function seedRetired(ledger: InMemoryCleanupLedger, id: ReturnType<typeof identityFor>, overrides: Partial<InMemoryGenerationRow> = {}): void {
  ledger.seed(rowFor(id, overrides));
}

describe('P4A-I14 pure contract: retention boundary and commit-unknown recovery', () => {
  test('retention uses the DB-clock deadline inclusively; null timestamps are never expired', () => {
    const now = Date.parse('2026-08-08T00:00:00.000Z');
    const deadline = now - 90 * 24 * 60 * 60 * 1000;
    assert.equal(generationRetentionDeadlineExpired(new Date(deadline), null, 90, now), true, 'exactly-at-deadline is expired (<=)');
    assert.equal(generationRetentionDeadlineExpired(new Date(deadline - 1), null, 90, now), true, 'past deadline is expired');
    assert.equal(generationRetentionDeadlineExpired(new Date(deadline + 1), null, 90, now), false, 'before deadline is retained');
    assert.equal(generationRetentionDeadlineExpired(new Date(deadline), new Date(deadline - 1), 90, now), true, 'orphaned_at applies when retired_at is null');
    assert.equal(generationRetentionDeadlineExpired(null, null, 90, now), false, 'no retirement timestamp is never treated as expired');
  });

  test('commit-unknown recovery decides from the DATABASE re-read, never the exception', () => {
    const fence = { attemptToken: 'tok', leaseOwner: 'cleaner', leaseGeneration: 3n };
    assert.equal(resolveCleanupCommitUnknown({
      attemptedClaim: fence,
      reRead: { outcome: 'found', row: { generationState: 'deleted', cleanupAttemptToken: 'tok', cleanupLeaseOwner: 'cleaner', cleanupLeaseGeneration: 3n } },
    }).decision, 'committed_deleted');
    assert.equal(resolveCleanupCommitUnknown({
      attemptedClaim: fence,
      reRead: { outcome: 'found', row: { generationState: 'quarantined', cleanupAttemptToken: null, cleanupLeaseOwner: null, cleanupLeaseGeneration: 0n } },
    }).decision, 'committed_quarantined');
    assert.equal(resolveCleanupCommitUnknown({
      attemptedClaim: fence,
      reRead: { outcome: 'found', row: { generationState: 'deletion_pending', cleanupAttemptToken: 'tok', cleanupLeaseOwner: 'cleaner', cleanupLeaseGeneration: 3n } },
    }).decision, 'not_committed');
    assert.equal(resolveCleanupCommitUnknown({
      attemptedClaim: fence,
      reRead: { outcome: 'found', row: { generationState: 'deletion_pending', cleanupAttemptToken: 'other', cleanupLeaseOwner: 'cleaner', cleanupLeaseGeneration: 4n } },
    }).decision, 'not_committed', 'a newer owner took over; the late CAS must never be replayed');
    assert.equal(resolveCleanupCommitUnknown({ attemptedClaim: fence, reRead: { outcome: 'not_found' } }).decision, 'inconsistent');
  });
});

describe('P4A-I14 coordinator: claim -> HEAD -> DELETE -> confirm HEAD -> CAS', () => {
  test('happy path: match -> DELETE exact key -> repeat HEAD absent -> completeCleanup deleted (DELETE 2xx is never absence by itself)', async () => {
    const id = identityFor(1);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, id);
    const store = new InMemoryCleanupObjectStore();
    store.seed(id.key, `"etag-${id.generationId}"`, 7);
    const uow = new InMemoryCleanupUow(ledger);

    const result = await runCleanupBatch(deps(ledger, store, uow));
    assert.equal(result.claimed, 1);
    assert.deepEqual(result.outcomes.map((o) => o.kind), ['deleted']);
    assert.deepEqual(store.deleteCalls.map((call) => call.key), [id.key], 'exactly one DELETE on the exact claimed key');
    assert.deepEqual(store.headCalls.map((call) => call.key), [id.key, id.key], 'HEAD before + repeat confirm HEAD on the same key');
    const complete = ledger.completeCalls[0]!;
    assert.equal(complete.verdict, 'deleted');
    assert.equal(ledger.row(id.generationId)!.state, 'deleted', 'the row transitions to deleted; it is never removed');
    assert.equal(store.objects.has(id.key), false, 'retired bytes are confirmed absent');
  });

  test('initially missing / absent-before confirms absence with ZERO DELETE', async () => {
    const id = identityFor(2);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, id);
    const store = new InMemoryCleanupObjectStore();
    const uow = new InMemoryCleanupUow(ledger);

    const result = await runCleanupBatch(deps(ledger, store, uow));
    assert.deepEqual(result.outcomes.map((o) => o.kind), ['confirmed_absent']);
    assert.equal(store.deleteCalls.length, 0, 'an already-absent candidate sends no DELETE');
    assert.equal(ledger.completeCalls[0]!.verdict, 'confirmed_absent');
    assert.equal(ledger.row(id.generationId)!.state, 'deleted');
  });

  test('candidate mismatch (same key, different etag/size) quarantines with ZERO DELETE', async () => {
    const id = identityFor(3);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, id);
    const store = new InMemoryCleanupObjectStore();
    store.seed(id.key, '"different-etag"', 99);
    const uow = new InMemoryCleanupUow(ledger);

    const result = await runCleanupBatch(deps(ledger, store, uow));
    assert.deepEqual(result.outcomes.map((o) => o.kind), ['quarantined']);
    assert.equal(store.deleteCalls.length, 0, 'identity mismatch must send NO DELETE');
    assert.equal(ledger.completeCalls[0]!.verdict, 'candidate_mismatch');
    assert.equal(ledger.row(id.generationId)!.state, 'quarantined', 'the corruption is quarantined for an operator');
  });

  test('DELETE-success-but-response-lost converges via confirmed HEAD absent, not a permanent error', async () => {
    const id = identityFor(4);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, id);
    const store = new InMemoryCleanupObjectStore();
    store.seed(id.key, `"etag-${id.generationId}"`, 7);
    store.options.deleteScript = [{ class: 'unknown' }];
    store.options.headScript = ['default', { class: 'not_found' }];
    const uow = new InMemoryCleanupUow(ledger);

    const result = await runCleanupBatch(deps(ledger, store, uow, { config: makeI14Config({ cleanup: { leaseMs: 60_000, retryCount: 0 } }) }));
    assert.deepEqual(result.outcomes.map((o) => o.kind), ['deleted'], 'unknown DELETE reconciled to absent via the confirm HEAD converges as deleted');
    assert.equal(store.deleteCalls.length, 1);
    assert.equal(ledger.row(id.generationId)!.state, 'deleted');
  });

  test('DELETE 2xx alone is NOT absence: object still present after confirm HEAD stays unknown_retryable', async () => {
    const id = identityFor(5);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, id);
    const store = new InMemoryCleanupObjectStore();
    store.seed(id.key, `"etag-${id.generationId}"`, 7);
    store.options.deleteScript = [{ class: 'deleted' }];
    store.options.headScript = ['default', 'default'];
    const uow = new InMemoryCleanupUow(ledger);

    const result = await runCleanupBatch(deps(ledger, store, uow));
    assert.deepEqual(result.outcomes.map((o) => o.kind), ['unknown_retryable']);
    assert.equal(ledger.completeCalls[0]!.verdict, 'unknown_retryable');
    assert.equal(ledger.row(id.generationId)!.state, 'deletion_pending', 'the lease is released; the claim is takeoverable');
    assert.equal(ledger.row(id.generationId)!.leaseOwner, null, 'unknown releases the claim lease');
  });

  test('HEAD timeout/5xx/unknown stays unknown_retryable with a BOUNDED retry budget and NO delete', async () => {
    const id = identityFor(6);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, id);
    const store = new InMemoryCleanupObjectStore();
    store.seed(id.key, `"etag-${id.generationId}"`, 7);
    store.options.headScript = [{ class: 'retryable' }, { class: 'unknown' }];
    const uow = new InMemoryCleanupUow(ledger);

    const result = await runCleanupBatch(deps(ledger, store, uow, { config: makeI14Config({ cleanup: { leaseMs: 60_000, retryCount: 1 } }) }));
    assert.deepEqual(result.outcomes.map((o) => o.kind), ['unknown_retryable']);
    assert.equal(store.headCalls.length, 2, 'bounded retry = retryCount + 1 attempts, then release');
    assert.equal(store.deleteCalls.length, 0, 'an inconclusive HEAD never leads to DELETE');
    assert.equal(ledger.row(id.generationId)!.leaseOwner, null, 'unknown releases the lease for a later worker');
  });

  test('bounded retry converges within the budget: retryable HEAD then ok -> deleted', async () => {
    const id = identityFor(7);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, id);
    const store = new InMemoryCleanupObjectStore();
    store.seed(id.key, `"etag-${id.generationId}"`, 7);
    store.options.headScript = [{ class: 'retryable' }, 'default'];
    const uow = new InMemoryCleanupUow(ledger);

    const result = await runCleanupBatch(deps(ledger, store, uow, { config: makeI14Config({ cleanup: { leaseMs: 60_000, retryCount: 1 } }) }));
    assert.deepEqual(result.outcomes.map((o) => o.kind), ['deleted']);
    assert.equal(store.headCalls.length, 3, 'retryable head-before + ok head-before + confirm head');
  });

  test('commit-response-lost re-reads the DATABASE and decides committed_deleted', async () => {
    const id = identityFor(8);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, id);
    const store = new InMemoryCleanupObjectStore();
    store.seed(id.key, `"etag-${id.generationId}"`, 7);
    let commits = 0;
    const uow = new InMemoryCleanupUow(ledger, {
      afterCommitAcknowledged: () => {
        commits += 1;
        // claim tx = 1, completeCleanup tx = 2 (lost ack), re-read tx = 3 (no-op).
        if (commits === 2) throw new CleanupCommitOutcomeUnknownError();
      },
    });

    const result = await runCleanupBatch(deps(ledger, store, uow));
    const outcome = result.outcomes[0]!;
    assert.equal(outcome.kind, 'commit_unknown');
    if (outcome.kind === 'commit_unknown') {
      assert.equal(outcome.decision, 'committed_deleted', 'the re-read proves the CAS landed despite the lost ack');
    }
    assert.ok(ledger.readStateCalls.includes(id.generationId), 'the recovery re-reads the generation row');
    assert.equal(ledger.row(id.generationId)!.state, 'deleted');
  });

  test('commit-response-lost with the CAS not committed stays not_committed (safe retry, no false success)', async () => {
    const id = identityFor(9);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, id);
    const store = new InMemoryCleanupObjectStore();
    store.seed(id.key, `"etag-${id.generationId}"`, 7);
    // Simulate a before-commit fault that rolled the CAS back: the row is back
    // in deletion_pending with the SAME claim fence after the failed attempt
    // (fresh ledger => deterministic first claim fence token-1/cleaner-1/1).
    let commits = 0;
    const faultUow = new InMemoryCleanupUow(ledger, {
      afterCommitAcknowledged: async () => {
        commits += 1;
        // Roll the CAS back on the completeCleanup transaction (2nd execute).
        if (commits !== 2) return;
        const row = ledger.row(id.generationId)!;
        row.state = 'deletion_pending';
        row.attemptToken = 'token-1';
        row.leaseOwner = 'cleaner-1';
        row.leaseGeneration = 1n;
        row.leaseExpiresAt = new Date(Date.now() + 60_000);
        throw new CleanupCommitOutcomeUnknownError();
      },
    });
    const result = await runCleanupBatch(deps(ledger, store, faultUow));
    const outcome = result.outcomes[0]!;
    assert.equal(outcome.kind, 'commit_unknown');
    if (outcome.kind === 'commit_unknown') assert.equal(outcome.decision, 'not_committed');
  });
});

describe('P4A-I14 coordinator: batch cursor, retention passthrough, and safety invariants', () => {
  test('the coordinator passes batch size, lease TTL, and retired retention days to the claim', async () => {
    const id = identityFor(10);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, id);
    const store = new InMemoryCleanupObjectStore();
    const uow = new InMemoryCleanupUow(ledger);
    await runCleanupBatch(deps(ledger, store, uow, { config: makeI14Config({ cleanupBatchSize: 7, cleanup: { leaseMs: 5_000, retryCount: 1 } }) }));
    const call = ledger.claimCalls[0]!;
    assert.equal(call.limit, 7);
    assert.equal(call.leaseTtlSeconds, 5);
    assert.equal(call.retiredRetentionDays, 90);
  });

  test('keyset cursor advances on a full page and resets on a short page (bounded fairness)', async () => {
    const ledger = new InMemoryCleanupLedger();
    for (let n = 11; n <= 20; n += 1) seedRetired(ledger, identityFor(n));
    const store = new InMemoryCleanupObjectStore();
    const uow = new InMemoryCleanupUow(ledger);
    const cfg = makeI14Config({ cleanupBatchSize: 4 });
    const full = await runCleanupBatch(deps(ledger, store, uow, { config: cfg, cursor: null }));
    assert.equal(full.claimed, 4);
    assert.ok(full.nextCursor, 'a full page advances the keyset cursor');
    // The next run passes the coordinator's cursor back into the claim.
    const short = await runCleanupBatch(deps(ledger, store, uow, { config: cfg, cursor: full.nextCursor }));
    assert.equal(ledger.claimCalls[1]!.cursor?.generationId, full.nextCursor!.generationId);
    assert.equal(ledger.claimCalls[1]!.cursor?.createdAtIso, full.nextCursor!.createdAtIso);
    assert.equal(short.claimed, 4, 'the remaining 6 candidates page again with the advanced cursor');
    const final = await runCleanupBatch(deps(ledger, store, uow, { config: cfg, cursor: short.nextCursor }));
    assert.equal(final.claimed, 2);
    assert.equal(final.nextCursor, null, 'a short page signals the next run to restart from the beginning (no starvation)');
  });

  test('a claim with no candidates returns an empty result', async () => {
    const ledger = new InMemoryCleanupLedger();
    const store = new InMemoryCleanupObjectStore();
    const uow = new InMemoryCleanupUow(ledger);
    const result = await runCleanupBatch(deps(ledger, store, uow));
    assert.equal(result.claimed, 0);
    assert.deepEqual(result.outcomes, []);
    assert.equal(result.nextCursor, null);
  });

  test('late-upload reconciliation: an orphaned generation with a late object is deleted; with no object it is confirmed absent', async () => {
    const late = identityFor(21);
    const absent = identityFor(22);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, late, { state: 'orphaned', orphanedAt: new Date('2025-06-01T00:00:00.000Z'), retiredAt: null });
    seedRetired(ledger, absent, { state: 'orphaned', orphanedAt: new Date('2025-06-01T00:00:00.000Z'), retiredAt: null });
    const store = new InMemoryCleanupObjectStore();
    store.seed(late.key, `"etag-${late.generationId}"`, 7);
    const uow = new InMemoryCleanupUow(ledger);

    const result = await runCleanupBatch(deps(ledger, store, uow));
    const kinds = new Map(result.outcomes.map((o) => [o.generationId, o.kind]));
    assert.equal(kinds.get(late.generationId), 'deleted', 'orphaned late-upload bytes are deleted and confirmed absent');
    assert.equal(kinds.get(absent.generationId), 'confirmed_absent', 'orphaned with no object is confirmed absent');
    assert.deepEqual(store.deleteCalls.map((call) => call.key), [late.key], 'only the late-upload body is deleted');
  });

  test('the exact claimed key is used — never a key derived from the blob current pointer', async () => {
    const retired = identityFor(23);
    const current = identityFor(24);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, retired, { currentGenerationId: current.generationId });
    // The current generation has a DIFFERENT key; a naive "current pointer"
    // derivation would delete the active body.
    const store = new InMemoryCleanupObjectStore();
    store.seed(retired.key, `"etag-${retired.generationId}"`, 7);
    store.seed(current.key, `"etag-${current.generationId}"`, 7);
    const uow = new InMemoryCleanupUow(ledger);

    const result = await runCleanupBatch(deps(ledger, store, uow));
    assert.deepEqual(result.outcomes.map((o) => o.kind), ['deleted']);
    assert.deepEqual(store.deleteCalls.map((call) => call.key), [retired.key], 'only the claimed retired key is deleted');
    assert.equal(store.objects.has(current.key), true, 'the active body is never touched');
  });

  test('the generation/tombstone row is never deleted, only transitioned', async () => {
    const id = identityFor(25);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, id);
    const store = new InMemoryCleanupObjectStore();
    store.seed(id.key, `"etag-${id.generationId}"`, 7);
    const uow = new InMemoryCleanupUow(ledger);
    await runCleanupBatch(deps(ledger, store, uow));
    assert.ok(ledger.row(id.generationId), 'the durable generation row survives cleanup');
    assert.equal(ledger.row(id.generationId)!.state, 'deleted');
  });

  test('crash hooks fire in the documented order and a crash aborts before the CAS', async () => {
    const id = identityFor(26);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, id);
    const store = new InMemoryCleanupObjectStore();
    store.seed(id.key, `"etag-${id.generationId}"`, 7);
    const uow = new InMemoryCleanupUow(ledger);
    const fired: string[] = [];
    const injector: CleanupFaultInjector = {
      afterClaim: async () => { fired.push('afterClaim'); },
      beforeHead: async () => { fired.push('beforeHead'); },
      afterHead: async () => { fired.push('afterHead'); },
      beforeDelete: async () => { fired.push('beforeDelete'); },
      afterDelete: async () => { fired.push('afterDelete'); },
      beforeConfirmHead: async () => { fired.push('beforeConfirmHead'); },
      afterConfirmHead: async () => { fired.push('afterConfirmHead'); },
      beforeCompleteCas: async () => { fired.push('beforeCompleteCas'); },
    };
    await runCleanupBatch(deps(ledger, store, uow, { faultInjector: injector }));
    assert.deepEqual(fired, [
      'afterClaim', 'beforeHead', 'afterHead', 'beforeDelete', 'afterDelete',
      'beforeConfirmHead', 'afterConfirmHead', 'beforeCompleteCas',
    ]);
  });

  test('a crash before the complete CAS leaves the durable claim; a restarted run converges', async () => {
    const id = identityFor(27);
    const ledger = new InMemoryCleanupLedger();
    seedRetired(ledger, id);
    const store = new InMemoryCleanupObjectStore();
    store.seed(id.key, `"etag-${id.generationId}"`, 7);
    const uow = new InMemoryCleanupUow(ledger);

    await assert.rejects(
      runCleanupBatch(deps(ledger, store, uow, {
        faultInjector: { beforeCompleteCas: () => cleanupCrash('beforeCompleteCas') },
      })),
      /cleanup_crash:beforeCompleteCas/,
    );
    // Restart after the lease expires (DB lease expiry takeover): the store
    // already deleted the object, so a fresh claim converges via confirmed
    // HEAD absent — never a duplicate DELETE or a permanent error.
    ledger.expireLeases();
    const restarted = await runCleanupBatch(deps(ledger, store, uow));
    assert.deepEqual(restarted.outcomes.map((o) => o.kind), ['confirmed_absent']);
    assert.equal(store.deleteCalls.length, 1, 'the restarted run sends NO second DELETE; the body was already confirmed absent');
    assert.equal(ledger.row(id.generationId)!.state, 'deleted');
  });
});

describe('P4A-I14 adapter: deleteExact/confirmAbsent translation over the I06 surface', () => {
  interface FakeI06 {
    headExact: (handle: { generationId: string; key: string }, options?: { expectedEtag?: string; signal?: AbortSignal }) => Promise<{ found: boolean; identity?: { generationId: string; size: number; etag: string; metadata: Record<string, string> } }>;
    readBounded: () => Promise<never>;
    deleteExact?: (handle: { generationId: string; key: string }) => Promise<{ outcome: 'deleted' | 'absent' | 'unknown' }>;
    confirmAbsent?: (handle: { generationId: string; key: string }) => Promise<{ absent: boolean }>;
  }

  const handle = { generationId: 'gen-1', key: 'k1' };

  test('I06 delete outcomes and thrown BlobStoreError classes translate to the closed module union', async () => {
    const base: FakeI06 = {
      headExact: async () => ({ found: false }),
      readBounded: async () => { throw new Error('unused'); },
    };
    const adapter = createGenerationObjectStoreAdapter(base as never);

    const deleted = await adapter.deleteExact(handle);
    assert.equal(deleted.class, 'denied', 'a store without a delete path fails closed');

    const withDelete = createGenerationObjectStoreAdapter({
      ...base,
      deleteExact: async () => ({ outcome: 'deleted' }),
      confirmAbsent: async () => ({ absent: true }),
    } as never);
    assert.equal((await withDelete.deleteExact(handle)).class, 'deleted');
    assert.equal((await withDelete.confirmAbsent(handle)).absent, true);

    const absent = createGenerationObjectStoreAdapter({
      ...base,
      deleteExact: async () => ({ outcome: 'absent' }),
    } as never);
    assert.equal((await absent.deleteExact(handle)).class, 'not_found');

    const unknown = createGenerationObjectStoreAdapter({
      ...base,
      deleteExact: async () => ({ outcome: 'unknown' }),
    } as never);
    assert.equal((await unknown.deleteExact(handle)).class, 'unknown');

    const denied = createGenerationObjectStoreAdapter({
      ...base,
      deleteExact: async () => { throw new BlobStoreError({ class: 'denied', code: 'access_denied' }); },
    } as never);
    assert.equal((await denied.deleteExact(handle)).class, 'denied');

    const retryable = createGenerationObjectStoreAdapter({
      ...base,
      deleteExact: async () => { throw new BlobStoreError({ class: 'retryable', code: 'provider_retryable' }); },
    } as never);
    assert.equal((await retryable.deleteExact(handle)).class, 'retryable');
  });

  test('confirmAbsent falls back to headExact for a RO-only store; an inconclusive confirm is absent:false', async () => {
    const ro = createGenerationObjectStoreAdapter({
      headExact: async () => ({ found: false }),
      readBounded: async () => { throw new Error('unused'); },
    } as never);
    assert.equal((await ro.confirmAbsent(handle)).absent, true);
    const present = createGenerationObjectStoreAdapter({
      headExact: async () => ({ found: true, identity: { generationId: 'gen-1', size: 1, etag: '"e"', metadata: {} } }),
      readBounded: async () => { throw new Error('unused'); },
    } as never);
    assert.equal((await present.confirmAbsent(handle)).absent, false);
    const inconclusive = createGenerationObjectStoreAdapter({
      headExact: async () => { throw new BlobStoreError({ class: 'retryable', code: 'provider_retryable' }); },
      readBounded: async () => { throw new Error('unused'); },
    } as never);
    assert.equal((await inconclusive.confirmAbsent(handle)).absent, false, 'an inconclusive confirm is never "absent"');
  });
});
