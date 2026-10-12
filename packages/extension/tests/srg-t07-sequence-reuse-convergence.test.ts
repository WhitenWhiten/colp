import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import {
  classifyPushProblem, createOutboundPushWorker, type PushSessionController,
} from '../src/outbound-push-worker.js';
import { repairSequenceReuseRejected } from '../src/sequence-reuse-repair.js';
import { classifyLocalSequenceReuse } from '../src/sequence-reuse-settlement.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import type { JsonObject, QueueOperation } from '../src/sync-state-store.js';
import type { StoredSession } from '../src/types.js';
import {
  installOutboundPushIndexedDb, json, operation, problem, resetIndexedDb, scope, setup,
} from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

type Fixture = Awaited<ReturnType<typeof setup>>;
interface SessionOverrides {
  readonly sessionId?: string; readonly generation?: string; readonly subject?: string; readonly collectionId?: string;
}

function authorityFor(overrides: SessionOverrides = {}) {
  return {
    credential: { accessToken: 'token-push', subject: overrides.subject ?? scope.accountId },
    session: {
      sessionId: overrides.sessionId ?? 'session-push', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const,
      credentialAuthorityDigest: 'a'.repeat(64), snapshotRequired: false,
      collection: { collectionId: overrides.collectionId ?? scope.collectionId, serverCursor: 'cursor-0',
        serverRevision: 'revision-0' },
      replicaLease: { leaseId: 'lease-server', generation: overrides.generation ?? '1', state: 'active' as const,
        expiresAt: '2099-01-01T00:00:00Z' },
    },
  };
}
function sessionsFor(overrides: SessionOverrides = {}): PushSessionController {
  return { async get() { return authorityFor(overrides); } };
}

/**
 * Reachability of this fixture: `rebindCreateInTransaction` writes exactly this
 * durable mapping (nativeId → server colpId, server revision) the moment an
 * applied create receipt settles. Reproducing it without the queue settlement
 * models the F001 "the server already executed the operation but the client
 * lost the result" state — the only state in which a reuse 409 can be
 * reconciled instead of replayed.
 */
async function bindAppliedCreate(fixture: Fixture) {
  await fixture.store.deleteMapping(scope, 'native-create');
  await fixture.store.putMapping(scope, { nativeId: 'native-create', colpId: 'node-server-1',
    rootNativeId: 'root-native', nodeKind: 'bookmark', projection: { revision: 'revision-1',
      digest: 'sha256:projection', content: { title: 'Public', url: 'https://example.test/public' } } });
}

async function enqueueSecond(fixture: Fixture) {
  await fixture.store.allocateSequenceAndEnqueue(scope, { opId: 'op-push-2', batchId: 'batch-push-2',
    idempotencyKey: 'idempotency-push-2', digest: 'sha256:operation-push-2', endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: null, operationRevision: 'local-event-push-2', status: 'pending',
    retry: { attempt: 0, notBefore: 0 },
    payload: { ...operation, opId: 'op-push-2', sequence: 2 } }, { allowUnstamped: true });
}

function attemptFor(body: JsonObject, sessionId = 'session-push') {
  return { sessionId, batchId: 'batch-push-1', idempotencyKey: 'idempotency-push-1',
    endpointIdentity: 'syncPush' as const, mediaType: 'application/json' as const,
    body: JSON.stringify({ sessionId, batchId: 'batch-push-1', atomic: false, operations: [body] }),
    bodyDigest: 'sha256:body' };
}
function queueRow(overrides: Partial<QueueOperation> = {}): QueueOperation {
  return { scopeKey: scopeKey(scope), sequence: 1, opId: 'op-push-1', batchId: 'batch-push-1',
    idempotencyKey: 'idempotency-push-1', digest: 'sha256:operation-push-1', endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: null, operationRevision: 'local-event-push-1', status: 'claimed',
    retry: { attempt: 0, notBefore: 0 }, attempt: attemptFor(operation), payload: operation, ...overrides };
}

describe('F001 sequence_reuse / op_id_reused convergence channel', () => {
  test('reuse without local evidence stays unknown with a real backoff and is covered by the repair scan', async () => {
    const fixture = await setup(); let sends = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, sessions: sessionsFor(),
      fetch: async () => { sends += 1; return problem(409, 'sequence_reuse', { retryable: false }); } });
    const outcome = await worker.drain();
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(sends, 1);
    const parked = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(parked.status, 'unknown');
    assert.equal(parked.recovery?.code, 'sequence_reuse');
    assert.equal(parked.retry.attempt, 1);
    assert.ok(parked.retry.notBefore >= fixture.clock.now + 1_000, 'reuse replay must carry a real backoff');

    const scan = await repairSequenceReuseRejected(fixture.store, scope);
    assert.equal(scan.repaired, 0);
    assert.equal(scan.attention, 1);
    const rescanned = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(rescanned.status, 'unknown', 'an unprovable reuse row must stay replayable');
    assert.equal(rescanned.retry.notBefore, parked.retry.notBefore, 'the repair pass must not zero the backoff');
    assert.equal(rescanned.retry.attempt, parked.retry.attempt);
    const diagnostics = await fixture.store.exportDiagnostics();
    assert.ok(diagnostics.records.some((row) => row.kind === 'sequence_reuse_repair'),
      'an unpairable reuse row must leave a visible record on the existing diagnostic channel');

    const early = await createOutboundPushWorker({ ...fixture.options, sessions: sessionsFor(),
      fetch: async () => { sends += 1; return problem(409, 'sequence_reuse', { retryable: false }); } }).drain();
    assert.equal(early.outcome, 'idle', 'the backoff must be honored before the identical bytes are replayed');
    assert.equal(sends, 1);
  });

  test('reuse with an authoritative local projection converges to terminal with a receipt and is never resent', async () => {
    const fixture = await setup(); let sends = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, sessions: sessionsFor(),
      fetch: async () => { sends += 1; return problem(409, 'sequence_reuse', { retryable: false }); } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    await bindAppliedCreate(fixture);

    const scan = await repairSequenceReuseRejected(fixture.store, scope);
    assert.equal(scan.repaired, 1);
    const healed = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(healed.status, 'terminal');
    assert.ok(healed.retry.notBefore >= fixture.clock.now + 1_000, 'repair must preserve the parked backoff');
    const receipt = await fixture.store.getQueueReceipt(scope, 1);
    assert.equal(receipt?.opId, 'op-push-1');
    assert.equal(receipt?.kind, 'terminal');
    assert.equal((await fixture.store.getMappingByNativeId(scope, 'native-create'))?.colpId, 'node-server-1');
    assert.equal((await worker.drain()).outcome, 'idle');
    assert.equal(sends, 1);
  });

  test('reuse classified as reconcile on the drain path settles terminal without replaying the bytes', async () => {
    const fixture = await setup();
    await bindAppliedCreate(fixture);
    let sends = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, sessions: sessionsFor(),
      fetch: async () => { sends += 1; return problem(409, 'op_id_reused', { retryable: false }); } });
    const outcome = await worker.drain();
    assert.equal(outcome.outcome, 'terminal');
    assert.equal(sends, 1);
    const row = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(row.status, 'terminal');
    assert.equal(row.recovery, undefined);
    assert.equal((await fixture.store.getQueueReceipt(scope, 1))?.kind, 'terminal');
    assert.equal((await fixture.store.getMappingByNativeId(scope, 'native-create'))?.colpId, 'node-server-1');
    assert.equal((await worker.drain()).outcome, 'idle');
    assert.equal(sends, 1);
  });

  test('an illegal reuse proof fails the operation permanently and does not wedge the queue head', async () => {
    const fixture = await setup();
    const worker = createOutboundPushWorker({ ...fixture.options, sessions: sessionsFor({ generation: '2' }),
      fetch: async () => problem(409, 'sequence_reuse', { retryable: false }) });
    assert.equal((await worker.drain()).outcome, 'rejected');
    const refused = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.recovery?.code, 'sequence_reuse', 'the refusal must keep the reuse evidence');
    assert.equal((await fixture.store.getQueueReceipt(scope, 1)), null, 'a refusal is not a receipt');

    await enqueueSecond(fixture);
    let sends = 0;
    const next = createOutboundPushWorker({ ...fixture.options, sessions: sessionsFor(),
      fetch: async (_url, init) => { sends += 1;
        const attempt = JSON.parse(String(init?.body)) as { batchId: string };
        return json(200, { batchId: attempt.batchId, results: [{ opId: 'op-push-2', sequence: 2, status: 'applied',
          targetId: 'node-server-2', revision: 'revision-2', cursor: 'cursor-2', warnings: [] }],
        serverCursor: 'cursor-2' }); } });
    assert.equal((await next.drain()).outcome, 'terminal');
    assert.equal(sends, 1);
    assert.equal((await fixture.store.listQueue(scope)).find((row) => row.opId === 'op-push-2')?.status, 'terminal');
  });

  test('branch order: reuse routing precedes both the retryable and retryable:false branches', async () => {
    assert.equal(classifyPushProblem({ code: 'sequence_reuse', retryable: false }), 'reuse');
    assert.equal(classifyPushProblem({ code: 'op_id_reused', retryable: false }), 'reuse');
    assert.equal(classifyPushProblem({ code: 'sequence_reuse', retryable: true }), 'reuse');
    assert.equal(classifyPushProblem({ code: 'sequence_reuse' }), 'reuse');
    assert.equal(classifyPushProblem({ code: 'service_unavailable' }), 'retryable');
    assert.equal(classifyPushProblem({ code: 'service_unavailable', retryable: false }), 'rejected');
    assert.equal(classifyPushProblem({ code: 'invalid_document', retryable: false }), 'rejected');
    assert.equal(classifyPushProblem({ code: 'node_read_only' }), 'unrecognized');

    // retryable:true must not bypass the reuse classification …
    const illegalFixture = await setup();
    const illegal = createOutboundPushWorker({ ...illegalFixture.options, sessions: sessionsFor({ generation: '2' }),
      fetch: async () => problem(409, 'sequence_reuse', { retryable: true }) });
    assert.equal((await illegal.drain()).outcome, 'rejected');

    // … and retryable:false must not swallow it either.
    resetIndexedDb();
    const parkedFixture = await setup();
    const parked = createOutboundPushWorker({ ...parkedFixture.options, sessions: sessionsFor(),
      fetch: async () => problem(409, 'sequence_reuse', { retryable: false }) });
    assert.equal((await parked.drain()).outcome, 'unknown');
    assert.equal((await parkedFixture.store.listQueue(scope))[0]?.status, 'unknown');
  });

  test('classifier facts are real comparisons instead of hardcoded matches', () => {
    const session: StoredSession = authorityFor().session;
    const matching = queueRow();
    const base = { code: 'sequence_reuse' as const, scope, replicaLifecycle: 'active' as const };
    assert.equal(classifyLocalSequenceReuse({ ...base, queue: matching, session, hasLocalEvidence: false,
      credentialSubject: scope.accountId }), 'unknown');
    assert.equal(classifyLocalSequenceReuse({ ...base, queue: matching, session, hasLocalEvidence: true,
      credentialSubject: scope.accountId }), 'reconcile');
    assert.equal(classifyLocalSequenceReuse({ ...base, queue: matching, session, hasLocalEvidence: false,
      credentialSubject: 'account-other' }), 'illegal');
    assert.equal(classifyLocalSequenceReuse({ ...base, queue: queueRow({ scopeKey: 'other-scope' }), session,
      hasLocalEvidence: false }), 'illegal', 'a row stored under another account scope is illegal');
    assert.equal(classifyLocalSequenceReuse({ ...base, queue: matching, session, hasLocalEvidence: false }), 'unknown',
      'a host without a credential subject still proves the account through the account-scoped row key');

    const changed = { ...operation, payload: { parentId: 'root-push', node: { kind: 'bookmark',
      title: 'Changed', url: 'https://example.test/public' } } };
    assert.equal(classifyLocalSequenceReuse({ ...base, session, hasLocalEvidence: false,
      queue: queueRow({ attempt: attemptFor(changed) }) }), 'illegal', 'different attempt bytes are illegal');
    const { attempt: _attempt, ...withoutAttempt } = matching;
    assert.equal(classifyLocalSequenceReuse({ ...base, queue: withoutAttempt, session, hasLocalEvidence: false }),
      'illegal', 'unprovable operation bytes must not be treated as matching');
    assert.equal(classifyLocalSequenceReuse({ ...base, queue: queueRow({ payload: { ...operation, collectionId: 'other' } }),
      session, hasLocalEvidence: false }), 'illegal');
    assert.equal(classifyLocalSequenceReuse({ ...base, queue: queueRow({ payload: { ...operation, replicaId: 'other' } }),
      session, hasLocalEvidence: false }), 'illegal');
    assert.equal(classifyLocalSequenceReuse({ ...base, queue: queueRow(), session: authorityFor({ generation: '2' }).session,
      hasLocalEvidence: false }), 'illegal');
    assert.equal(classifyLocalSequenceReuse({ ...base, replicaLifecycle: 'retired', queue: matching, session,
      hasLocalEvidence: false }), 'illegal');
    assert.equal(classifyLocalSequenceReuse({ ...base, queue: queueRow({ opId: 'op-other' }), session,
      hasLocalEvidence: false }), 'illegal');
  });

  test('the drain-start repair pass itself converges a parked row before it can be replayed', async () => {
    const fixture = await setup(); let sends = 0;
    const options = { ...fixture.options, sessions: sessionsFor(),
      fetch: async () => { sends += 1; return problem(409, 'sequence_reuse', { retryable: false }); } };
    assert.equal((await createOutboundPushWorker(options).drain()).outcome, 'unknown');
    assert.equal(sends, 1);
    await bindAppliedCreate(fixture);
    // Past the backoff a replay would be permitted again, so only the repair
    // pass running inside the drain can keep the identical bytes off the wire.
    fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore + 1;
    const second = await createOutboundPushWorker(options).drain();
    assert.equal(second.outcome, 'idle');
    assert.equal((await fixture.store.listQueue(scope))[0]?.status, 'terminal');
    assert.equal(sends, 1, 'the drain-start repair pass must converge instead of replaying');
  });

  test('an unprovable parked row surfaces attention on the drain outcome and the diagnostic channel', async () => {
    const fixture = await setup(); let sends = 0;
    const options = { ...fixture.options, sessions: sessionsFor(),
      fetch: async () => { sends += 1; return problem(409, 'sequence_reuse', { retryable: false }); } };
    assert.equal((await createOutboundPushWorker(options).drain()).outcome, 'unknown');
    fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore + 1;
    const second = await createOutboundPushWorker(options).drain();
    assert.equal(second.outcome, 'unknown');
    assert.equal(sends, 2);
    assert.equal(second.attention, 1, 'an unprovable reuse row must be reported through the drain outcome');
    const diagnostics = await fixture.store.exportDiagnostics();
    // `exportDiagnostics` can fall back to a structural-corruption record shape;
    // the diagnostic rows themselves are unknown-keyed records.
    const records = diagnostics.records as readonly Record<string, unknown>[];
    const record = records.find((row) => row.code === 'unprovable_reuse');
    assert.ok(record, 'the repair pass must leave a durable diagnostic, not an empty catch');
    assert.equal(record.kind, 'sequence_reuse_repair');
    assert.deepEqual(record.details, { opId: 'op-push-1', sequence: 1, status: 'unknown', code: 'sequence_reuse' });
  });

  test('the reuse repair never rewrites a parked backoff back to zero', async () => {
    const fixture = await setup();
    const lease = await fixture.store.acquireLease(scope, 'owner-push', fixture.clock.now, 30_000);
    const claimed = await fixture.store.claimNextQueue(scope, 'owner-push', lease.fence!, fixture.clock.now);
    await fixture.store.settleClaimedPush(scope, claimed!.sequence, 'owner-push', lease.fence!, { outcome: 'unknown',
      retry: { attempt: 3, notBefore: fixture.clock.now + 60_000 }, recovery: { code: 'sequence_reuse' } });
    await fixture.store.repairSequenceReuseRow(scope, 1, { outcome: 'unknown' });
    const row = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(row.status, 'unknown');
    assert.equal(row.retry.attempt, 3);
    assert.equal(row.retry.notBefore, fixture.clock.now + 60_000);
  });

  test('a failed repair pass stays visible and does not abort the drain', async () => {
    const fixture = await setup();
    const store = { ...fixture.store,
      async listQueue(input: typeof scope, status?: QueueOperation['status'], afterSequence?: number, limit?: number) {
        if (status === 'rejected') throw new Error('repair_list_failed');
        return fixture.store.listQueue(input, status, afterSequence, limit);
      } };
    const worker = createOutboundPushWorker({ ...fixture.options, store,
      sessions: sessionsFor(),
      fetch: async (_url, init) => { const attempt = JSON.parse(String(init?.body)) as { batchId: string };
        return json(200, { batchId: attempt.batchId, results: [{ opId: 'op-push-1', sequence: 1, status: 'applied',
          targetId: 'node-server-1', revision: 'revision-1', cursor: 'cursor-1', warnings: [] }],
        serverCursor: 'cursor-1' }); } });
    const outcome = await worker.drain();
    assert.equal(outcome.outcome, 'terminal');
    assert.ok((outcome.attention ?? 0) >= 1, 'a failed repair pass must surface attention');
    const diagnostics = await fixture.store.exportDiagnostics();
    assert.ok(diagnostics.records.some((row) => row.code === 'repair_scan_failed'),
      'a failed repair pass must leave a visible record instead of an empty catch');
  });
});
