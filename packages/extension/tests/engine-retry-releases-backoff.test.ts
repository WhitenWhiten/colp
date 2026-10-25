import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { STALLED_SERVER_ATTEMPTS, STALLED_UPLOAD_ATTEMPTS, stalledUploadHead } from '../src/engine-public-stability.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import type { QueueOperation } from '../src/sync-state-store.js';
import { ack, emptyPullPage, json, scope, setup } from './durable-sync-engine-harness.js';

/**
 * A-F4: a sent head that is only waiting (`unknown`, `deferred`) sat behind its backoff of up to
 * five minutes, so the user's Retry replayed nothing and looked broken. Retry now makes the head's
 * next try due at once, and a server that keeps failing one sent change for a long time is
 * reported as a stalled upload instead of being filed under "busy" for ever.
 */
async function withWorker(fetchImpl: (op: string) => Response | Promise<Response>) {
  const f = await setup(); f.clock.now = Date.now();
  await f.enqueue('op-head-1');
  const sent: string[] = [];
  const session = async () => ({ credential: { accessToken: 'access-token' }, session: {
    sessionId: f.sessionId, expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const, acceptedProtocolVersion: '0.2' as const,
    snapshotRequired: false, collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
    replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active' as const, expiresAt: '2099-01-01T00:00:00Z' } } as never });
  const worker = createOutboundPushWorker({ scope, store: f.store, endpoints: async () => ({ syncPush: 'https://known.example/v1/push' } as never),
    sessions: { get: async () => session() }, now: () => f.clock.now, random: () => 0.5, ownerId: () => 'owner', schedule: () => undefined,
    fetch: async (_url, init) => { const op = (JSON.parse(String(init?.body)) as { operations: Array<{ opId: string }> }).operations[0]!.opId;
      sent.push(op); return fetchImpl(op); } });
  (f.push as { drain: unknown }).drain = (callback?: () => void) => worker.drain(callback);
  const wake = async (explicitRetry: boolean) => {
    f.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: `cursor-${f.forcedSessions.length}` });
    f.pullResponses.push(json(200, emptyPullPage(`cursor-p${f.pullResponses.length}`)));
    f.ackResponses.push(json(200, ack(`cursor-p${f.ackResponses.length}`)));
    return f.engine.wake('manual', { explicitRetry });
  };
  return { f, sent, wake };
}

describe('A-F4 Retry makes a waiting head due at once', () => {
  test('a manual wake respects the head backoff, an explicit Retry does not', async () => {
    const { f, sent, wake } = await withWorker(() => { throw new TypeError('Failed to fetch'); });
    await wake(false);
    assert.equal(sent.length, 1, 'the first try left');
    const waiting = (await f.store.listQueue(scope))[0]!;
    assert.equal(waiting.status, 'unknown'); assert.ok(waiting.retry.notBefore > f.clock.now, 'it waits out a backoff');
    const bound = JSON.stringify(waiting.attempt);

    await wake(false);
    assert.equal(sent.length, 1, 'an ordinary wake still waits for the backoff');

    await wake(true);
    assert.equal(sent.length, 2, 'Retry sends the next try at once');
    const after = (await f.store.listQueue(scope))[0]!;
    assert.equal(after.retry.attempt, 2, 'the attempt count is not reset');
    assert.equal(JSON.stringify(after.attempt), bound, 'and the exact bytes are replayed');
    f.store.close();
  });

  test('releaseQueueBackoff only touches rows that are waiting', async () => {
    const f = await setup(); f.clock.now = 1_000_000;
    for (const opId of ['op-a-1', 'op-b-2', 'op-c-3', 'op-d-4']) await f.enqueue(opId, { sequence: Number(opId.slice(-1)) });
    const lease = await f.store.acquireLease(scope, 'owner', f.clock.now, 60_000);
    const settleUnknown = async (notBefore: number) => {
      const claimed = (await f.store.claimNextQueue(scope, 'owner', lease.fence, f.clock.now))!;
      await f.store.settleClaimedPush(scope, claimed.sequence, 'owner', lease.fence,
        { outcome: 'unknown', retry: { attempt: 3, notBefore }, recovery: { code: 'push_network_failed' } });
      return claimed.opId;
    };
    await settleUnknown(f.clock.now + 200_000);
    // The head waits; the rows behind it are untouched pending rows.
    assert.equal(await f.store.releaseQueueBackoff(scope, f.clock.now), 1);
    const rows = await f.store.listQueue(scope);
    assert.deepEqual(rows.map((row: QueueOperation) => [row.status, row.retry.attempt, row.retry.notBefore]),
      [['unknown', 3, f.clock.now], ['pending', 0, 0], ['pending', 0, 0], ['pending', 0, 0]]);
    assert.equal(await f.store.releaseQueueBackoff(scope, f.clock.now), 0, 'already due: nothing to release');
    f.store.close();
  });
});

describe('A-F4 a server that keeps failing one sent change is eventually reported', () => {
  const row = (code: string, attempt: number): QueueOperation => ({ scopeKey: 's', sequence: 1, opId: 'op', batchId: 'b',
    idempotencyKey: 'k', digest: 'd', endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
    operationRevision: 'r', status: 'unknown', retry: { attempt, notBefore: 0 }, recovery: { code },
    attempt: { sessionId: 's', batchId: 'b', idempotencyKey: 'k', endpointIdentity: 'syncPush', mediaType: 'application/json',
      body: '{}', bodyDigest: 'x' }, payload: { type: 'create_node' } } as QueueOperation);

  test('a server that answers 5xx is a wait, then a stalled upload', () => {
    const code = 'push_server_unavailable';
    assert.equal(stalledUploadHead([row(code, STALLED_UPLOAD_ATTEMPTS)]), undefined, 'a busy server is not reported early');
    assert.equal(stalledUploadHead([row(code, STALLED_SERVER_ATTEMPTS - 1)]), undefined);
    assert.equal(stalledUploadHead([row(code, STALLED_SERVER_ATTEMPTS)])?.code, code);
  });

  // service_unavailable / internal_error are registered by the wire stream (transient); whether
  // they are reported early or only at STALLED_SERVER_ATTEMPTS, a long-failing head is reported.
  test.each(['service_unavailable', 'internal_error'])('%s on a head that keeps failing is reported', (code) => {
    assert.equal(stalledUploadHead([row(code, STALLED_SERVER_ATTEMPTS)])?.code, code);
  });

  test.each(['push_network_failed', 'rate_limited', 'server_unavailable', 'push_session_refresh_failed'])(
    '%s is never reported as a stalled upload however long it lasts', (code) => {
      assert.equal(stalledUploadHead([row(code, 500)]), undefined);
    });
});
