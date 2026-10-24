import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createOutboundPushWorker, type PushSessionController } from '../src/outbound-push-worker.js';
import { MAX_REFUSED_ITEMS, REQUEST_REFUSED } from '../src/push-denial-containment.js';
import { replicaIssuesFromQueue } from '../src/sw/replica-health-report.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import type { JsonObject } from '../src/sync-state-store.js';
import { ack, emptyPullPage, json as engineJson, scope as engineScope, setup as engineSetup } from './durable-sync-engine-harness.js';
import {
  installOutboundPushIndexedDb, json, operation, scope, setup,
} from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

/**
 * A-F2 / W2C-15: one change answered by an intermediary (WAF, DLP, proxy) with an unnamed
 * 401/403/410 used to freeze Pull and Push for the whole replica; every wake then refreshed the
 * Session, unfroze, re-sent the same bytes and froze again. A working credential now means the
 * refusal is about that request: the change leaves the lane as one item and the rest uploads.
 */
const forbidden = () => new Response('<html>Forbidden by WAF</html>',
  { status: 403, headers: { 'Content-Type': 'text/html' } });

function accepted(init: RequestInit | undefined) {
  const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Array<{ opId: string; sequence: number }> };
  const op = body.operations[0]!;
  return json(200, { batchId: body.batchId, results: [{ opId: op.opId, sequence: op.sequence, status: 'applied',
    targetId: `node-${op.opId}`, revision: 'revision-1', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
}
const sentOp = (init: RequestInit | undefined) => (JSON.parse(String(init?.body)) as
  { operations: Array<{ opId: string }> }).operations[0]!.opId;

function sessionsThatRefresh(forced: boolean[], refresh: 'works' | 'fails'): PushSessionController {
  return { async get(forceRefresh = false) {
    forced.push(forceRefresh);
    if (forceRefresh && refresh === 'fails') throw new Error('session_failed');
    return { credential: { accessToken: 'access-token-push' }, session: { sessionId: 'session-push',
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const, credentialAuthorityDigest: 'a'.repeat(64),
      snapshotRequired: false, collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0',
        serverRevision: 'revision-0' }, replicaLease: { leaseId: 'lease-server', generation: '1',
        state: 'active' as const, expiresAt: '2099-01-01T00:00:00Z' } } };
  } };
}

async function enqueue(store: Awaited<ReturnType<typeof setup>>['store'], opId: string, payload: JsonObject) {
  await store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId, digest: `sha256:${opId}`,
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`,
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: { ...payload, opId } },
  { validateOperation: () => true, digestOperation: (value) => `sha256:${String(value.opId)}-${String(value.sequence)}` });
}
const other = (title: string): JsonObject => ({ ...operation, payload: { parentId: 'root-other',
  node: { kind: 'bookmark', title, url: `https://example.test/${title}` } } });

describe('A-F2 one refused request is an item, not a replica freeze', () => {
  test('with a working credential the refused change leaves the lane after five tries and later changes upload', async () => {
    const fixture = await setup(); const { store } = fixture; const forced: boolean[] = [];
    await enqueue(store, 'op-other', other('other'));
    const sent: string[] = [];
    const worker = createOutboundPushWorker({ ...fixture.options, sessions: sessionsThatRefresh(forced, 'works'),
      fetch: async (_url, init) => { sent.push(sentOp(init)); return sentOp(init) === 'op-push-1' ? forbidden() : accepted(init); } });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      assert.equal((await worker.drain()).outcome, 'unknown', `try ${attempt}`);
      const head = (await store.listQueue(scope)).find((row) => row.opId === 'op-push-1')!;
      assert.equal(head.status, 'unknown'); assert.equal(head.recovery?.code, 'push_authority_response_invalid');
      assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true, `no freeze after try ${attempt}`);
      assert.deepEqual(sent.filter((op) => op === 'op-other'), [], 'the sent head keeps the lane while it is retried');
      fixture.clock.now = head.retry.notBefore + 1;
    }
    assert.ok(forced.includes(true), 'the Session endpoint was asked for a fresh credential before the verdict');
    // The fifth refusal, with the credential proven, ends the retries of this one change.
    assert.equal((await worker.drain()).outcome, 'terminal');
    const rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((row) => [row.opId, row.status, row.recovery?.code]), [
      ['op-push-1', 'set_aside', REQUEST_REFUSED], ['op-other', 'terminal', undefined]]);
    assert.equal(rows[0]!.attempt, undefined, 'the refused bytes are no longer bound to a request');
    assert.deepEqual(sent, ['op-push-1', 'op-push-1', 'op-push-1', 'op-push-1', 'op-push-1', 'op-other']);
    const engine = await store.getEngineState(scope);
    assert.notEqual(engine?.recoveryFrozen, true); assert.notEqual(engine?.authorityRefreshRequired, true);
    assert.equal((await store.getScope(scope))?.lifecycle, 'active');
    // It is reported as an item the user can act on, like any other held change.
    const open = await readOpenSyncIssues(store, scope);
    assert.equal(open.total, 1);
    const [issue] = replicaIssuesFromQueue(open.queue);
    assert.equal(issue?.code, REQUEST_REFUSED); assert.equal(issue?.direction, 'push');
    store.close();
  });

  test('a credential that cannot be refreshed is still an authority problem for the whole replica', async () => {
    const fixture = await setup(); const { store } = fixture; const forced: boolean[] = [];
    const worker = createOutboundPushWorker({ ...fixture.options, sessions: sessionsThatRefresh(forced, 'fails'),
      fetch: async () => forbidden() });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await worker.drain();
      fixture.clock.now = (await store.listQueue(scope))[0]!.retry.notBefore + 1;
    }
    const escalated = await worker.drain();
    assert.equal(escalated.outcome, 'unknown');
    const head = (await store.listQueue(scope))[0]!;
    assert.equal(head.status, 'unknown'); assert.equal(head.recovery?.code, 'push_denial_escalated');
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal((await store.getScope(scope))?.lifecycle, 'recovery_required');
    store.close();
  });

  test('when many changes are refused the network is the problem: the old authority escalation takes over', async () => {
    const fixture = await setup(); const { store } = fixture;
    // MAX_REFUSED_ITEMS changes are already held for the same reason.
    for (let index = 0; index < MAX_REFUSED_ITEMS; index += 1) {
      await enqueue(store, `op-held-${index}`, other(`held-${index}`));
    }
    for (const row of await store.listQueue(scope)) {
      if (!row.opId.startsWith('op-held-')) continue;
      await store.setAsideQueue(scope, [row.sequence], REQUEST_REFUSED);
    }
    const worker = createOutboundPushWorker({ ...fixture.options, sessions: sessionsThatRefresh([], 'works'),
      fetch: async () => forbidden() });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await worker.drain();
      const head = (await store.listQueue(scope)).find((row) => row.opId === 'op-push-1')!;
      fixture.clock.now = head.retry.notBefore + 1;
    }
    await worker.drain();
    const head = (await store.listQueue(scope)).find((row) => row.opId === 'op-push-1')!;
    assert.equal(head.status, 'unknown', 'it is not held as one more item');
    assert.equal(head.recovery?.code, 'push_denial_escalated');
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, true);
    store.close();
  });

  test('a failure of another kind between refusals does not count as a repeat', async () => {
    const fixture = await setup(); const { store } = fixture; let calls = 0;
    const worker = createOutboundPushWorker({ ...fixture.options, sessions: sessionsThatRefresh([], 'works'),
      fetch: async () => { calls += 1; if (calls % 2 === 1) throw new TypeError('fetch failed'); return forbidden(); } });
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      await worker.drain();
      fixture.clock.now = (await store.listQueue(scope))[0]!.retry.notBefore + 1;
    }
    const head = (await store.listQueue(scope))[0]!;
    assert.equal(head.status, 'unknown', 'alternating network failures and refusals never reach the verdict');
    assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
    store.close();
  });
});

describe('A-F2 the replica keeps syncing around the refused change (engine level)', () => {
  test('14 wakes: the refused change is held after five sends, Pull continues and the next change uploads', async () => {
    const f = await engineSetup(); f.clock.now = Date.now();
    await f.enqueue('op-poison-1'); await f.enqueue('op-other-2');
    const sent: string[] = [];
    const endpoints = { syncPush: 'https://known.example/v1/push' } as never;
    const sessionFor = async () => ({ credential: { accessToken: 'access-token' }, session: {
      sessionId: f.sessionId, expiresAt: '2099-01-01T00:00:00Z', scope: 'collection' as const, acceptedProtocolVersion: '0.2' as const,
      snapshotRequired: false, collection: { collectionId: engineScope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
      replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active' as const, expiresAt: '2099-01-01T00:00:00Z' } } as never });
    const worker = createOutboundPushWorker({ scope: engineScope, store: f.store, endpoints: async () => endpoints,
      sessions: { get: async () => sessionFor() }, now: () => f.clock.now, random: () => 0, ownerId: () => 'owner',
      schedule: () => undefined, fetch: async (_url, init) => { const op = sentOp(init); sent.push(op);
        return op === 'op-poison-1' ? forbidden() : accepted(init); } });
    (f.push as { drain: unknown }).drain = (callback?: () => void) => worker.drain(callback);
    for (let wake = 0; wake < 14; wake += 1) {
      f.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: `cursor-renewed-${wake}` });
      f.pullResponses.push(engineJson(200, emptyPullPage(`cursor-after-${wake}`)));
      f.ackResponses.push(engineJson(200, ack(`cursor-after-${wake}`)));
      f.clock.now += 5 * 60_000;
      const state = await f.engine.wake('manual');
      assert.equal(state?.recoveryFrozen, false, `wake ${wake} is not frozen`);
    }
    assert.equal(sent.filter((op) => op === 'op-poison-1').length, 5, 'the refused bytes are sent five times, not for ever');
    assert.equal(sent.filter((op) => op === 'op-other-2').length, 1);
    const rows = await f.store.listQueue(engineScope);
    assert.deepEqual(rows.map((row) => [row.opId, row.status, row.recovery?.code]), [
      ['op-poison-1', 'set_aside', REQUEST_REFUSED], ['op-other-2', 'terminal', undefined]]);
    assert.ok(f.pullRequests.length >= 12, 'Pull was never starved');
    const final = await f.store.getEngineState(engineScope);
    assert.notEqual(final?.phase, 'error'); assert.notEqual(final?.phase, 'recovery');
    f.store.close();
  });
});
