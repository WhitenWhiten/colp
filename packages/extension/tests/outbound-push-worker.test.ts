import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import type { JsonObject } from '../src/sync-state-store.js';
import {
  installOutboundPushIndexedDb, json, operation, problem, resetIndexedDb, scope, setup,
} from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

describe('P3-31 outbound Push protocol and exact retry', () => {
  test.each([
    ['applied', { revision: 'revision-server-1', cursor: 'cursor-1', targetId: 'node-server-1' }],
    ['rebased', { targetId: 'node-server-1', revision: 'revision-server-1', cursor: 'cursor-1',
      transform: { title: 'Public' } }],
    ['noop', {}],
    ['rejected', { code: 'policy_denied' }],
  ] as const)('persists a complete terminal %s receipt and never sends another sequence first', async (status, extra) => {
    const fixture = await setup(); const requests: Array<{ body: string; key: string }> = [];
    const result = { opId: fixture.queued.opId, sequence: 1, status, warnings: [], ...extra };
    const worker = createOutboundPushWorker({ ...fixture.options, fetch: async (_url, init) => {
      requests.push({ body: String(init?.body), key: new Headers(init?.headers).get('Idempotency-Key')! });
      return json(200, { batchId: fixture.queued.batchId, results: [result], serverCursor: 'cursor-1' });
    } });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal((await worker.drain()).outcome, 'idle');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.queue[0]?.status, 'terminal');
    assert.deepEqual(exported.receipts[0]?.result, { batchId: fixture.queued.batchId,
      results: [result], serverCursor: 'cursor-1' });
    assert.equal(requests.length, 1);
  });

  test('persists conflicted receipt as a durable barrier and does not send the next sequence', async () => {
    const fixture = await setup(); let requests = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, fetch: async () => { requests += 1;
      return json(200, { batchId: fixture.queued.batchId, results: [{ opId: fixture.queued.opId, sequence: 1,
        status: 'conflicted', cursor: 'cursor-1', conflictId: 'conflict-1', warnings: [] }], serverCursor: 'cursor-1' }); } });
    assert.equal((await worker.drain()).outcome, 'blocked');
    await fixture.store.allocateSequenceAndEnqueue(scope, { opId: 'op-push-2', batchId: 'batch-push-2',
      idempotencyKey: 'idempotency-push-2', digest: 'sha256:operation-push-2', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: fixture.queued.baseRevision,
      operationRevision: 'local-event-push-2', status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { ...operation, opId: 'op-push-2', sequence: 2 } }, { allowUnstamped: true });
    assert.equal((await worker.drain()).outcome, 'idle');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.queue[0]?.status, 'blocked'); assert.equal(exported.queue[0]?.recovery?.code, 'conflict_pending');
    assert.equal(exported.queue[1]?.status, 'pending'); assert.equal(exported.receipts[0]?.kind, 'terminal');
    assert.equal(requests, 1);
  });

  test('reuses opId, sequence, batchId, digest, Idempotency-Key and exact Operation bytes after timeout and restart', async () => {
    const fixture = await setup(); const requests: string[] = []; let attempt = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      requests.push(String(init?.body)); attempt += 1;
      if (attempt === 1) throw new DOMException('timed out', 'AbortError');
      return json(200, { batchId: fixture.queued.batchId, results: [{ opId: fixture.queued.opId, sequence: 1,
        status: 'applied', targetId: 'node-server-1', revision: 'revision-1', cursor: 'cursor-1', warnings: [] }],
      serverCursor: 'cursor-1' });
    };
    assert.equal((await createOutboundPushWorker({ ...fixture.options, fetch: fetcher }).drain()).outcome, 'unknown');
    const unknown = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(unknown.status, 'unknown'); assert.equal(unknown.opId, fixture.queued.opId);
    fixture.clock.now = unknown.retry.notBefore;
    assert.equal((await createOutboundPushWorker({ ...fixture.options, fetch: fetcher }).drain()).outcome, 'terminal');
    assert.equal(requests.length, 2); assert.equal(requests[0], requests[1]);
    assert.equal(JSON.parse(requests[0]!).operations[0].opId, fixture.queued.opId);
    assert.equal(JSON.parse(requests[0]!).operations[0].sequence, fixture.queued.sequence);
  });

  test('reclaims an unexpired claim under the next fence and replays its exact body after worker termination', async () => {
    const fixture = await setup(); const requests: string[] = [];
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const abandoned = assert.rejects(createOutboundPushWorker({ ...fixture.options, requestTimeoutMilliseconds: 10,
      fetch: async (_url, init) => { requests.push(String(init?.body)); requestStarted();
        return new Promise<Response>(() => undefined); } }).drain(), /stale_fence/u);
    await started;

    const recovered = await createOutboundPushWorker({ ...fixture.options, fetch: async (_url, init) => {
      const body = String(init?.body); requests.push(body); const attempt = JSON.parse(body) as { batchId: string };
      return json(200, { batchId: attempt.batchId, results: [{ opId: fixture.queued.opId, sequence: 1,
        status: 'applied', targetId: 'node-server-1', revision: 'revision-1', cursor: 'cursor-1', warnings: [] }],
      serverCursor: 'cursor-1' }); } }).drain();

    assert.equal(recovered.outcome, 'terminal'); assert.equal(requests.length, 2);
    assert.equal(requests[0], requests[1]);
    assert.equal((await fixture.store.listQueue(scope))[0]?.status, 'terminal');
    await abandoned;
  });

  test('refreshes 401 only through the Session controller and preserves the logical operation envelope', async () => {
    const fixture = await setup(); const bodies: string[] = []; const authorizations: string[] = [];
    const forced: boolean[] = [];
    const sessions: PushSessionController = { async get(forceRefresh = false) { forced.push(forceRefresh);
      return { credential: { accessToken: forceRefresh ? 'fresh-access' : 'old-access' }, session: {
        sessionId: 'session-old', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection',
        credentialAuthorityDigest: 'a'.repeat(64),
        snapshotRequired: false,
        collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
        replicaLease: { leaseId: 'lease-server', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } } };
    } };
    let call = 0; const worker = createOutboundPushWorker({ ...fixture.options, sessions, fetch: async (_url, init) => {
      bodies.push(String(init?.body)); authorizations.push(new Headers(init?.headers).get('Authorization')!); call += 1;
      return call === 1 ? problem(401, 'authentication_required') : json(200, { batchId: fixture.queued.batchId,
        results: [{ opId: fixture.queued.opId, sequence: 1, status: 'noop', warnings: [] }], serverCursor: 'cursor-1' });
    } });
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.deepEqual(forced, [false, true]); assert.deepEqual(authorizations, [
      'Bearer old-access',
      'Bearer fresh-access',
    ]);
    assert.equal(bodies[0], bodies[1]);
  });

  test('fails closed on a non-retryable Problem instead of repeatedly classifying it as unknown', async () => {
    const fixture = await setup(); const scheduled: number[] = [];
    const worker = createOutboundPushWorker({ ...fixture.options, schedule: (delay) => scheduled.push(delay),
      fetch: async () => problem(422, 'invalid_document', { retryable: false }) });
    assert.equal((await worker.drain()).outcome, 'rejected');
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'rejected');
    assert.equal(queued.recovery?.code, 'invalid_document');
    assert.deepEqual(scheduled, [16_000]);
  });

  test('durably binds Session, batch, exact body bytes and fingerprint before the first fetch', async () => {
    const fixture = await setup(); let body = '';
    const worker = createOutboundPushWorker({ ...fixture.options, fetch: async (_url, init) => {
      body = String(init?.body); throw new TypeError('Failed to fetch');
    } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const persisted = (await fixture.store.listQueue(scope))[0]!.attempt!;
    assert.equal(persisted.sessionId, 'session-push');
    assert.match(persisted.batchId, /^session-push\./);
    assert.equal(persisted.body, body);
    assert.equal(JSON.parse(body).batchId, persisted.batchId);
    assert.equal(JSON.parse(body).sessionId, persisted.sessionId);
    assert.match(persisted.bodyDigest, /^[0-9a-f]{64}$/);
  });

  test('realigns surviving work onto the server sequence after a rejected hole and converges', async () => {
    // Journey: op-1 permanently rejected (lane still expects 1) → op-2 gets
    // the sequence_gap evidence → the next drain realigns op-2 down onto
    // sequence 1 with fresh operation bytes and pushes it to terminal.
    const fixture = await setup();
    const rejectedWorker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => problem(422, 'invalid_document', { retryable: false }) });
    assert.equal((await rejectedWorker.drain()).outcome, 'rejected');

    await fixture.store.allocateSequenceAndEnqueue(scope, { opId: 'op-push-2', batchId: 'batch-push-2',
      idempotencyKey: 'idempotency-push-2', digest: 'sha256:operation-push-2', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: null, operationRevision: 'local-event-push-2',
      status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { ...operation, opId: 'op-push-2', sequence: 2 } }, { allowUnstamped: true });
    const gapScheduled: number[] = [];
    const gapWorker = createOutboundPushWorker({ ...fixture.options, schedule: (delay) => gapScheduled.push(delay),
      fetch: async () => problem(409, 'sequence_gap', { expectedSequence: 1 }) });
    assert.equal((await gapWorker.drain()).outcome, 'gap');
    // The healable gap schedules its own retry instead of waiting for a
    // distant alarm.
    assert.ok(gapScheduled.length >= 2, 'gap settle must schedule the healing drain');

    const bodies: string[] = [];
    const healWorker = createOutboundPushWorker({ ...fixture.options, fetch: async (_url, init) => {
      const body = String(init?.body); bodies.push(body);
      const attempt = JSON.parse(body) as { batchId: string };
      return json(200, { batchId: attempt.batchId, results: [{ opId: 'op-push-2', sequence: 1,
        status: 'applied', targetId: 'node-server-2', revision: 'revision-1', cursor: 'cursor-1', warnings: [] }],
      serverCursor: 'cursor-1' });
    } });
    assert.equal((await healWorker.drain()).outcome, 'terminal');
    assert.equal(bodies.length, 1);
    const sent = JSON.parse(bodies[0]!) as { operations: Array<{ opId: string; sequence: number }> };
    assert.deepEqual(sent.operations.map((op) => [op.opId, op.sequence]), [['op-push-2', 1]]);

    const rows = await fixture.store.listQueue(scope);
    assert.deepEqual(rows.map((item) => [item.sequence, item.opId, item.status]), [
      [1, 'op-push-2', 'terminal'],
      [2, 'op-push-1', 'rejected'],
    ]);
    assert.equal(rows[1]!.recovery?.code, 'invalid_document');
  });

  test.each([
    [409, 'sequence_gap', 'gap'], [409, 'sequence_blocked', 'blocked'],
  ] as const)('persists %s/%s recovery without treating it as terminal', async (status, code, outcome) => {
    const fixture = await setup(); const worker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => problem(status, code, { expectedSequence: 1 }) });
    assert.equal((await worker.drain()).outcome, outcome);
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, outcome); assert.equal(queued.recovery?.expectedSequence, 1);
    assert.equal((await fixture.store.exportScope(scope)).receipts.length, 0);
  });

  test('persists deferred receipt and honors the larger of Retry-After and bounded jitter backoff', async () => {
    const fixture = await setup(); const scheduled: number[] = [];
    const worker = createOutboundPushWorker({ ...fixture.options, random: () => 0.5,
      schedule: (delay) => scheduled.push(delay), fetch: async () => json(200, { batchId: fixture.queued.batchId,
        results: [{ opId: fixture.queued.opId, sequence: 1, status: 'deferred', code: 'pending_parent',
          retryAfterSeconds: 17, warnings: [] }], serverCursor: 'cursor-0' }) });
    assert.equal((await worker.drain()).outcome, 'deferred');
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'deferred'); assert.equal(queued.retry.notBefore, fixture.clock.now + 17_000);
    assert.deepEqual(scheduled, [16_000, 17_000]);
  });

  test.each([[503, undefined], [429, '23']] as const)('keeps %s as unknown and applies bounded retry policy', async (status, retryAfter) => {
    const fixture = await setup(); const scheduled: number[] = [];
    const worker = createOutboundPushWorker({ ...fixture.options, random: () => 1, schedule: (delay) => scheduled.push(delay),
      fetch: async () => problem(status, status === 429 ? 'rate_limited' : 'service_unavailable', undefined, retryAfter) });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'unknown'); assert.equal(queued.retry.attempt, 1);
    assert.deepEqual(scheduled, [16_000, retryAfter ? 23_000 : 2_000]);
  });

  test('offline, abort, malformed content type and oversized response remain unknown without credential leakage', async () => {
    for (const response of [() => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.reject(new DOMException('worker stopped', 'AbortError')),
      () => Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'text/plain' } })),
      () => Promise.resolve(new Response('x'.repeat(128 * 1024 + 1), { status: 200,
        headers: { 'Content-Type': 'application/json' } }))]) {
      resetIndexedDb();
      const fixture = await setup(); const worker = createOutboundPushWorker({ ...fixture.options, fetch: response as typeof fetch });
      assert.equal((await worker.drain()).outcome, 'unknown');
      const serialized = JSON.stringify(await fixture.store.exportScope(scope));
      assert.doesNotMatch(serialized, /access-token|native-private|PRIVATE/);
    }
  });

  test('records a bounded response failure when a 200 response violates the Push result contract', async () => {
    const fixture = await setup();
    const worker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => json(200, { batchId: fixture.queued.batchId, results: [{
        opId: fixture.queued.opId, sequence: 1, status: 'applied',
        cursor: 'cursor-1',
        warnings: [],
      }], serverCursor: 'cursor-1' }) });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'unknown');
    assert.equal(queued.recovery?.code, 'push_response_invalid');
  });

  test('keeps a valid Push receipt replayable when settlement fails after persistence', async () => {
    const fixture = await setup();
    const worker = createOutboundPushWorker({ ...fixture.options, settlementFault: 'after_receipt',
      fetch: async () => json(200, { batchId: fixture.queued.batchId, results: [{
        opId: fixture.queued.opId, sequence: 1, status: 'applied', targetId: 'node-server-1',
        revision: 'revision-1', cursor: 'cursor-1', warnings: [],
      }], serverCursor: 'cursor-1' }) });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'unknown');
    assert.equal(queued.recovery?.code, 'fault_injected');
  });

  test('keeps the request timeout armed while a successful response body is still streaming', async () => {
    const fixture = await setup();
    const worker = createOutboundPushWorker({ ...fixture.options, requestTimeoutMilliseconds: 10,
      fetch: async (_url, init) => {
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
        init?.signal?.addEventListener('abort', () => stream.error(new DOMException('timed out', 'AbortError')));
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    assert.equal((await fixture.store.listQueue(scope))[0]?.status, 'unknown');
  });

  test('binds exactly one pending custom mount by opId when two customs exist', async () => {
    const fixture = await setup();
    assert.equal((await createOutboundPushWorker({ ...fixture.options, fetch: async () => json(200, {
      batchId: fixture.queued.batchId, results: [{ opId: fixture.queued.opId, sequence: 1, status: 'applied',
        targetId: 'node-server-1', revision: 'revision-1', cursor: 'cursor-1', warnings: [] }],
      serverCursor: 'cursor-1',
    }) }).drain()).outcome, 'terminal');
    await fixture.store.putMountBinding(scope, {
      mountId: 'mount-custom-a', nativeRootId: 'native-a', remoteMountNodeId: null, boundaryVersion: '1',
      materialized: false, status: 'pending', customSourceKey: 'folder-a',
    });
    await fixture.store.putMountBinding(scope, {
      mountId: 'mount-custom-b', nativeRootId: 'native-b', remoteMountNodeId: null, boundaryVersion: '1',
      materialized: false, status: 'pending', customSourceKey: 'folder-b',
    });
    const opId = 'b3.confirm.mount.folder-a';
    const custom: JsonObject = {
      opId, replicaId: scope.replicaId, sequence: 2, collectionId: scope.collectionId, type: 'create_node',
      baseRevision: null, occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [],
      payload: { parentId: 'root-push', node: { kind: 'folder', title: 'Custom A', folderRole: 'custom' } },
    };
    await fixture.store.allocateSequenceAndEnqueue(scope, {
      opId, batchId: 'batch-custom-a', idempotencyKey: opId, digest: 'sha256:custom-a',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
      operationRevision: 'local-custom-a', status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: custom,
    }, { allowUnstamped: true });
    assert.equal((await createOutboundPushWorker({ ...fixture.options, fetch: async () => json(200, {
      batchId: 'batch-custom-a', results: [{ opId, sequence: 2, status: 'applied',
        targetId: 'remote-custom-a', revision: 'revision-custom', cursor: 'cursor-2', warnings: [] }],
      serverCursor: 'cursor-2',
    }) }).drain()).outcome, 'terminal');
    const mounts = await fixture.store.listMountBindings(scope);
    assert.equal(mounts.find((row) => row.mountId === 'mount-custom-a')?.remoteMountNodeId, 'remote-custom-a');
    assert.equal(mounts.find((row) => row.mountId === 'mount-custom-b')?.remoteMountNodeId, null);
  });

  test('does not claim the only unbound custom when the opId does not match', async () => {
    const fixture = await setup();
    assert.equal((await createOutboundPushWorker({ ...fixture.options, fetch: async () => json(200, {
      batchId: fixture.queued.batchId, results: [{ opId: fixture.queued.opId, sequence: 1, status: 'applied',
        targetId: 'node-server-1', revision: 'revision-1', cursor: 'cursor-1', warnings: [] }],
      serverCursor: 'cursor-1',
    }) }).drain()).outcome, 'terminal');
    await fixture.store.putMountBinding(scope, {
      mountId: 'mount-custom-only', nativeRootId: 'native-only', remoteMountNodeId: null, boundaryVersion: '1',
      materialized: false, status: 'pending', customSourceKey: 'folder-only',
    });
    const opId = 'b3.confirm.mount.folder-other';
    const custom: JsonObject = {
      opId, replicaId: scope.replicaId, sequence: 2, collectionId: scope.collectionId, type: 'create_node',
      baseRevision: null, occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [],
      payload: { parentId: 'root-push', node: { kind: 'folder', title: 'Other', folderRole: 'custom' } },
    };
    await fixture.store.allocateSequenceAndEnqueue(scope, {
      opId, batchId: 'batch-custom-other', idempotencyKey: opId, digest: 'sha256:custom-other',
      endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
      operationRevision: 'local-custom-other', status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: custom,
    }, { allowUnstamped: true });
    assert.equal((await createOutboundPushWorker({ ...fixture.options, fetch: async () => json(200, {
      batchId: 'batch-custom-other', results: [{ opId, sequence: 2, status: 'applied',
        targetId: 'remote-other', revision: 'revision-other', cursor: 'cursor-2', warnings: [] }],
      serverCursor: 'cursor-2',
    }) }).drain()).outcome, 'terminal');
    assert.equal((await fixture.store.listMountBindings(scope))
      .find((row) => row.mountId === 'mount-custom-only')?.remoteMountNodeId, null);
  });

  test('persists unknown when fetch ignores AbortSignal and never settles', async () => {
    const fixture = await setup(); const scheduled: number[] = [];
    const worker = createOutboundPushWorker({ ...fixture.options, requestTimeoutMilliseconds: 10,
      schedule: (delay) => scheduled.push(delay),
      fetch: async () => new Promise<Response>(() => undefined) });
    assert.equal((await worker.drain()).outcome, 'unknown');
    assert.equal((await fixture.store.listQueue(scope))[0]?.status, 'unknown');
    assert.equal(scheduled[0], 1_010);
  });

});

describe('F038 repair failures stay observable', () => {
  test('a realign failure reports attention and a durable diagnostic instead of a silent catch', async () => {
    const fixture = await setup();
    const store = { ...fixture.store, realignQueueAfterGap: async () => {
      throw new Error('queue_ledger_corrupt');
    } };
    const worker = createOutboundPushWorker({ ...fixture.options, store,
      fetch: async () => json(200, { batchId: fixture.queued.batchId, results: [{ opId: fixture.queued.opId,
        sequence: 1, status: 'applied', targetId: 'node-server-1', revision: 'revision-1',
        cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' }) });
    const first = await worker.drain();
    // The barrier still stands: the drain completes and the failure is observable.
    assert.equal(first.outcome, 'terminal');
    assert.ok((first.attention ?? 0) >= 1, 'realign failure must surface attention');
    const diagnostics = await fixture.store.exportDiagnostics();
    assert.ok(diagnostics.records.some((row) => row.kind === 'queue_realign'
      && row.code === 'queue_ledger_corrupt'), 'realign failure must leave a durable diagnostic');
    // A later drain retries the realign and reports again rather than wedging.
    const second = await worker.drain();
    assert.ok((second.attention ?? 0) >= 1);
  });

  test('a healthy drain reports no repair attention', async () => {
    const fixture = await setup();
    const worker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => json(200, { batchId: fixture.queued.batchId, results: [{ opId: fixture.queued.opId,
        sequence: 1, status: 'applied', targetId: 'node-server-1', revision: 'revision-1',
        cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' }) });
    const outcome = await worker.drain();
    assert.equal(outcome.outcome, 'terminal');
    assert.equal(outcome.attention, undefined);
  });
});
