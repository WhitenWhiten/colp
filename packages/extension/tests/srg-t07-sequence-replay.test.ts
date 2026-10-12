import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { repairSequenceReuseRejected } from '../src/sequence-reuse-repair.js';
import { collectSaveStatusFacts } from '../src/save-status-facts.js';
import { projectSaveStatus, FIRST_RUN_NEEDS_ATTENTION, FIRST_RUN_SYNCING } from '../src/save-status.js';
import { queueStatusProjection } from '../src/engine-public-stability.js';
import type { JsonObject, QueueOperation } from '../src/sync-state-store.js';
import {
  installOutboundPushIndexedDb, json, operation, problem, resetIndexedDb, scope, setup,
} from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

function sessionFor(sessionId: string): Awaited<ReturnType<PushSessionController['get']>> {
  return {
    credential: { accessToken: `token-${sessionId}` },
    session: {
      sessionId, expiresAt: '2099-01-01T00:00:00Z', scope: 'collection',
      credentialAuthorityDigest: 'a'.repeat(64), snapshotRequired: false,
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
      replicaLease: { leaseId: 'lease-server', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
    },
  };
}

function rotatingSessions(): PushSessionController {
  return {
    async get(forceRefresh = false) {
      return sessionFor(forceRefresh ? 'session-new' : 'session-old');
    },
  };
}

/** A Session whose replica lease generation does not match the local scope. */
function generationSessions(generation: string): PushSessionController {
  return {
    async get() {
      const authority = sessionFor('session-push');
      return { ...authority, session: { ...authority.session,
        replicaLease: { ...authority.session.replicaLease, generation } } };
    },
  };
}

function appliedJson(opId: string, sequence: number, batchId: string, targetId = 'node-server-1') {
  return json(200, {
    batchId, results: [{ opId, sequence, status: 'applied', targetId, revision: 'revision-1',
      cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1',
  });
}

describe('T-07 cross-Session Sequence receipt and client settlement (SRG-11)', () => {
  test('Q-01: 401 then Session change, original op already applied → queue terminal, mapping 1:1', async () => {
    const fixture = await setup();
    const bodies: string[] = [];
    let call = 0;
    const worker = createOutboundPushWorker({
      ...fixture.options, sessions: rotatingSessions(),
      fetch: async (_url, init) => {
        const body = String(init?.body);
        bodies.push(body);
        call += 1;
        if (call === 1) return problem(401, 'authentication_required');
        const attempt = JSON.parse(body) as { batchId: string };
        return appliedJson(fixture.queued.opId, 1, attempt.batchId);
      },
    });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(bodies.length, 2);
    const first = JSON.parse(bodies[0]!) as { sessionId: string; operations: JsonObject[] };
    const second = JSON.parse(bodies[1]!) as { sessionId: string; operations: JsonObject[] };
    assert.deepEqual(first.operations, second.operations);
    assert.notEqual(first.sessionId, second.sessionId);
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'terminal');
    assert.notEqual(queued.status, 'rejected');
    const mapped = await fixture.store.getMappingByNativeId(scope, 'native-create');
    assert.equal(mapped?.colpId, 'node-server-1');
    assert.equal(await fixture.store.getMappingByColpId(scope, 'pending-op-push-1'), null);
  });

  test('Q-01: sequence_reuse without local evidence stays replayable with a real backoff, never silently rejected', async () => {
    const fixture = await setup();
    const worker = createOutboundPushWorker({
      ...fixture.options, sessions: rotatingSessions(),
      fetch: async () => problem(409, 'sequence_reuse', { retryable: false }),
    });
    const outcome = await worker.drain();
    assert.equal(outcome.outcome, 'unknown');
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'unknown');
    assert.equal(queued.recovery?.code, 'sequence_reuse');
    assert.equal(queued.sequence, 1);
    assert.equal(queued.opId, fixture.queued.opId);
    assert.ok(queued.retry.notBefore >= fixture.clock.now + 1_000);
    const pending = await fixture.store.getMappingByColpId(scope, 'pending-op-push-1');
    assert.equal(pending?.nativeId, 'native-create');
  });

  test('Q-02: same logical replay 100 times + worker restart → exactly one canonical effect', async () => {
    const fixture = await setup();
    const bodies: string[] = [];
    let sends = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      sends += 1;
      if (sends < 100) throw new TypeError('Failed to fetch');
      const attempt = JSON.parse(String(init?.body)) as { batchId: string };
      return appliedJson(fixture.queued.opId, 1, attempt.batchId);
    };
    for (let index = 0; index < 99; index += 1) {
      const unknown = await createOutboundPushWorker({ ...fixture.options, fetch: fetchImpl }).drain();
      assert.equal(unknown.outcome, 'unknown');
      fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore;
    }
    assert.equal((await createOutboundPushWorker({ ...fixture.options, fetch: fetchImpl }).drain()).outcome, 'terminal');
    assert.equal((await createOutboundPushWorker({ ...fixture.options, fetch: fetchImpl }).drain()).outcome, 'idle');
    assert.equal(sends, 100);
    const operations = bodies.map((body) => JSON.parse(body).operations[0]);
    assert.ok(operations.every((item) => item.opId === fixture.queued.opId && item.sequence === 1));
    const mapped = await fixture.store.getMappingByNativeId(scope, 'native-create');
    assert.equal(mapped?.colpId, 'node-server-1');
    assert.equal((await fixture.store.listMappings(scope)).filter((row) => row.nativeId === 'native-create').length, 1);
  });

  test('Q-03: an identity mismatch on reuse fails closed, and other refusals keep their own evidence', async () => {
    const fixture = await setup();
    const mismatch = createOutboundPushWorker({
      ...fixture.options, sessions: generationSessions('2'),
      fetch: async () => problem(409, 'sequence_reuse', { retryable: false }),
    });
    assert.equal((await mismatch.drain()).outcome, 'rejected');
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'rejected');
    assert.equal(queued.opId, fixture.queued.opId);
    assert.equal(queued.sequence, 1);
    assert.equal(queued.recovery?.code, 'sequence_reuse');
    await fixture.store.allocateSequenceAndEnqueue(scope, {
      opId: 'op-push-2', batchId: 'batch-push-2', idempotencyKey: 'idempotency-push-2',
      digest: 'sha256:operation-push-2', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: null, operationRevision: 'local-event-push-2', status: 'pending',
      retry: { attempt: 0, notBefore: 0 },
      payload: { ...operation, opId: 'op-push-2', sequence: 2 },
    }, { allowUnstamped: true });
    const illegalPayload = createOutboundPushWorker({
      ...fixture.options, sessions: generationSessions('1'),
      fetch: async () => problem(422, 'invalid_document', { retryable: false }),
    });
    assert.equal((await illegalPayload.drain()).outcome, 'rejected');
    assert.equal((await fixture.store.listQueue(scope)).find((row) => row.opId === 'op-push-2')?.recovery?.code,
      'invalid_document');
  });

  test('Q-05: sequence gap, deferred, conflict, rejected UI and the next safe operation', async () => {
    const fixture = await setup();
    assert.equal(queueStatusProjection([{ status: 'gap', recovery: { code: 'sequence_gap' } }]), 'syncing');
    assert.equal(queueStatusProjection([{ status: 'deferred' }]), 'syncing');
    assert.equal(queueStatusProjection([{ status: 'blocked', recovery: { code: 'conflict_pending' } }]), 'conflict');
    assert.equal(queueStatusProjection([{ status: 'rejected', recovery: { code: 'invalid_document' } }]), 'rejected');
    assert.equal(queueStatusProjection([{ status: 'unknown', recovery: { code: 'sequence_reuse' } }]), 'syncing');

    const processed = {
      scopeKey: 'scope', ordinal: 1, status: 'processed' as const, eventId: 'e1', dedupeKey: 'd1',
      opId: 'op-push-1', occurredAt: '2026-07-27T00:00:00Z', kind: 'create' as const,
      nativeId: 'native-create', details: {},
    };
    const storeFor = (row: QueueOperation) => ({
      async getScope() { return { firstRun: 'completed' }; },
      async getMappingByNativeId() {
        return { colpId: 'pending-op-push-1', projection: { revision: 'local-event-push-1' } };
      },
      async listBookmarkEvents() { return [processed]; },
      async getQueueByOpId() { return row; },
      async listProjectionIntents() { return []; },
      async getEngineState() { return null; },
      async listBootstrapRuns() { return []; },
    });
    const unknownReuse = await collectSaveStatusFacts({
      store: storeFor({
        ...fixture.queued, status: 'unknown', recovery: { code: 'sequence_reuse' },
      }),
      scope, nativeId: 'native-create', inSyncRange: true, paint: 'projected',
      localCreateSucceeded: true, online: true,
    });
    assert.equal(unknownReuse.needsAttention, true);
    assert.equal(projectSaveStatus(unknownReuse), "action-required");

    const illegal = createOutboundPushWorker({
      ...fixture.options, fetch: async () => problem(422, 'invalid_document', { retryable: false }),
    });
    assert.equal((await illegal.drain()).outcome, 'rejected');
    await fixture.store.allocateSequenceAndEnqueue(scope, {
      opId: 'op-push-2', batchId: 'batch-push-2', idempotencyKey: 'idempotency-push-2',
      digest: 'sha256:operation-push-2', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: null, operationRevision: 'local-event-push-2', status: 'pending',
      retry: { attempt: 0, notBefore: 0 },
      payload: { ...operation, opId: 'op-push-2', sequence: 2 },
    }, { allowUnstamped: true });
    const gap = createOutboundPushWorker({
      ...fixture.options, fetch: async () => problem(409, 'sequence_gap', { expectedSequence: 1 }),
    });
    assert.equal((await gap.drain()).outcome, 'gap');
    const heal = createOutboundPushWorker({
      ...fixture.options, fetch: async (_url, init) => {
        const attempt = JSON.parse(String(init?.body)) as { batchId: string; operations: Array<{ opId: string; sequence: number }> };
        assert.equal(attempt.operations[0]?.opId, 'op-push-2');
        return appliedJson('op-push-2', attempt.operations[0]!.sequence, attempt.batchId, 'node-server-2');
      },
    });
    assert.equal((await heal.drain()).outcome, 'terminal');
    const rows = await fixture.store.listQueue(scope);
    assert.equal(rows.find((row) => row.opId === 'op-push-2')?.status, 'terminal');
    assert.equal(rows.find((row) => row.opId === 'op-push-1')?.status, 'rejected');
    const rejectedFacts = await collectSaveStatusFacts({
      store: storeFor(rows.find((row) => row.opId === 'op-push-1')!),
      scope, nativeId: 'native-create', inSyncRange: true, paint: 'projected',
      localCreateSucceeded: true, online: true,
    });
    assert.equal(projectSaveStatus(rejectedFacts), "action-required");
    void FIRST_RUN_SYNCING;
  });

  test('Q-06: AUD-09 client settlement from a cross-Session applied replay', async () => {
    const fixture = await setup();
    let call = 0;
    const worker = createOutboundPushWorker({
      ...fixture.options, sessions: rotatingSessions(),
      fetch: async (_url, init) => {
        call += 1;
        if (call === 1) return problem(401, 'authentication_required');
        const attempt = JSON.parse(String(init?.body)) as { batchId: string; sessionId: string };
        assert.equal(attempt.sessionId, 'session-new');
        return appliedJson(fixture.queued.opId, 1, attempt.batchId);
      },
    });
    assert.equal((await worker.drain()).outcome, 'terminal');
    const mapped = await fixture.store.getMappingByNativeId(scope, 'native-create');
    assert.equal(mapped?.colpId, 'node-server-1');
    assert.equal((await fixture.store.listQueue(scope))[0]?.status, 'terminal');
  });

  test('parked sequence_reuse rows are scanned and repaired from durable evidence without a new sequence', async () => {
    // Production path: the worker parks the row as unknown, then the applied
    // create's durable mapping survives (rebindCreateInTransaction writes that
    // record) while the queue row never settled. No hand-built rejected row.
    const parked = await setup();
    const worker = createOutboundPushWorker({
      ...parked.options, fetch: async () => problem(409, 'sequence_reuse', { retryable: false }),
    });
    assert.equal((await worker.drain()).outcome, 'unknown');
    assert.equal((await parked.store.listQueue(scope))[0]?.status, 'unknown');
    await parked.store.deleteMapping(scope, 'native-create');
    await parked.store.putMapping(scope, { nativeId: 'native-create', colpId: 'node-server-1',
      rootNativeId: 'root-native', nodeKind: 'bookmark',
      projection: { revision: 'revision-1', digest: 'sha256:projection' } });

    const first = await repairSequenceReuseRejected(parked.store, scope);
    assert.equal(first.repaired, 1);
    assert.equal((await parked.store.listQueue(scope))[0]?.status, 'terminal');
    assert.equal((await parked.store.listQueue(scope))[0]?.sequence, 1);
    assert.equal((await parked.store.getMappingByNativeId(scope, 'native-create'))?.colpId, 'node-server-1');
    const again = await repairSequenceReuseRejected(parked.store, scope, {
      async lookupProjection() { return { targetId: 'node-other', revision: 'revision-other' }; },
    });
    assert.equal(again.repaired, 0);
    assert.equal((await parked.store.getMappingByNativeId(scope, 'native-create'))?.colpId, 'node-server-1');

    resetIndexedDb();
    const unproven = await setup();
    assert.equal((await createOutboundPushWorker({
      ...unproven.options, fetch: async () => problem(409, 'op_id_reused', { retryable: false }),
    }).drain()).outcome, 'unknown');
    const scan = await repairSequenceReuseRejected(unproven.store, scope);
    assert.equal(scan.repaired, 0);
    assert.equal(scan.attention, 1);
    const parkedRow = (await unproven.store.listQueue(scope))[0]!;
    assert.equal(parkedRow.status, 'unknown');
    assert.equal(parkedRow.sequence, 1);
    assert.equal(parkedRow.opId, 'op-push-1');
    assert.equal((await unproven.store.getMappingByColpId(scope, 'pending-op-push-1'))?.nativeId, 'native-create');
  });
});
