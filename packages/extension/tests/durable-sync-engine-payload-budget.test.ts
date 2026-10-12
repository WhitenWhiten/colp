import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  ack, json, problem, emptyPullPage, recoverySnapshot, scope, setup,
} from './durable-sync-engine-harness.js';

// F013: an authenticated `payload_too_large` problem is a durable fact about the
// negotiated transport budget, not a transient denial — the same request can
// never succeed, so the engine must bound its adaptation and surface an
// observable failure instead of re-deriving the same 413 forever.
describe('durable sync engine payload_too_large adaptation (F013)', () => {

  test('freezes the scope terminally on an authenticated pull payload_too_large instead of re-pulling forever', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(problem(413, 'payload_too_large', {}));
    await fixture.engine.wake('alarm');
    let exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.phase, 'recovery');
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.authorityRefreshRequired, false);
    assert.equal(exported.engine.lastError, 'payload_too_large');
    assert.equal(exported.scope?.lifecycle, 'recovery_required');
    assert.equal(exported.scope?.metadata?.recoveryCode, 'payload_too_large');
    assert.equal(fixture.pullRequests.length, 1);
    assert.deepEqual(fixture.sessionForces, [false]);

    // Later wakes must not retry the same pull or refresh authority: the
    // negotiated page budget is server-capped, so a fresh Session re-derives
    // the same 413. The frozen recovery state is the observable failure.
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-after-413')));
    fixture.ackResponses.push(json(200, ack('cursor-after-413')));
    fixture.clock.now += 2_000;
    await fixture.engine.wake('alarm');
    exported = await fixture.store.exportScope(scope);
    assert.equal(fixture.pullRequests.length, 1);
    assert.deepEqual(fixture.sessionForces, [false]);
    assert.equal(exported.engine.phase, 'recovery');
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.lastError, 'payload_too_large');
  });

  test('halves the Snapshot page limit on payload_too_large and completes recovery', async () => {
    // Subject is the Snapshot transport-budget negotiation, not projection identity:
    // this fixture's Chrome world cannot satisfy the production identity verification.
    const fixture = await setup({ useStandInProjector: true });
    fixture.pullResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('alarm');
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: true, cursor: 'cursor-stale' });
    fixture.snapshotResponses.push(problem(413, 'payload_too_large', {}),
      problem(413, 'payload_too_large', {}),
      json(200, recoverySnapshot(1, true, 'page-2')), json(200, recoverySnapshot(2, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await fixture.engine.wake('online');
    const exported = await fixture.store.exportScope(scope);
    const requests = fixture.snapshotRequests.map((request) => new URL(request.url));
    assert.deepEqual(requests.map((url) => url.searchParams.get('limit')), ['100', '50', '25', '25']);
    assert.equal(requests[0]!.searchParams.has('pageCursor'), false);
    assert.equal(requests[3]!.searchParams.get('pageCursor'), 'page-2');
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(exported.engine.recoveryFrozen, false);
    assert.equal(exported.cursor.cursor, 'cursor-recovered');
  });

  test('rebuilds the staged Snapshot chain from page one at the halved limit after a mid-chain 413', async () => {
    // Subject is the Snapshot transport-budget negotiation, not projection identity:
    // this fixture's Chrome world cannot satisfy the production identity verification.
    const fixture = await setup({ useStandInProjector: true });
    fixture.pullResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('alarm');
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: true, cursor: 'cursor-stale' });
    fixture.snapshotResponses.push(json(200, recoverySnapshot(1, true, 'page-2')),
      problem(413, 'payload_too_large', {}),
      json(200, recoverySnapshot(1, true, 'page-2-half')), json(200, recoverySnapshot(2, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await fixture.engine.wake('online');
    const exported = await fixture.store.exportScope(scope);
    const requests = fixture.snapshotRequests.map((request) => new URL(request.url));
    assert.deepEqual(requests.map((url) => url.searchParams.get('limit')), ['100', '100', '50', '50']);
    assert.deepEqual(requests.map((url) => url.searchParams.get('pageCursor')),
      [null, 'page-2', null, 'page-2-half']);
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(exported.cursor.cursor, 'cursor-recovered');
  });

  test('rebuilds a staged Snapshot chain whose signed page cursor pins a smaller limit', async () => {
    // Subject is the Snapshot transport-budget negotiation, not projection identity:
    // this fixture's Chrome world cannot satisfy the production identity verification.
    const fixture = await setup({ useStandInProjector: true });
    fixture.pullResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('alarm');
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: true, cursor: 'cursor-stale' });
    // The chain is staged at the halved limit, then the worker crashes before
    // the next page — the durable nextCursor was signed for limit=50.
    fixture.snapshotResponses.push(problem(413, 'payload_too_large', {}),
      json(200, recoverySnapshot(1, true, 'page-2-at-50')));
    fixture.crashAt = 'after_snapshot_page';
    await assert.rejects(() => fixture.engine.wake('online'), /worker_crash/);
    await fixture.store.transitionEngine(scope, { phase: 'recovery', updatedAt: fixture.clock.now,
      recoveryFrozen: true, authorityRefreshRequired: true, notBefore: 0, sessionId: 'session-renewed' });
    fixture.store.close();
    // The resumed fetch still asks for limit=100, so the server denies the
    // limit-50 cursor with invalid_cursor_scope; the client must discard the
    // staged chain once and rebuild from page one instead of looping offline.
    fixture.forcedSessions.push({ sessionId: 'session-renewed', state: 'active',
      snapshotRequired: true, cursor: 'cursor-stale' });
    fixture.snapshotResponses.push(problem(400, 'invalid_cursor_scope', {}),
      json(200, recoverySnapshot(1, true, 'page-2b')), json(200, recoverySnapshot(2, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await fixture.reopen().wake('online');
    const exported = await fixture.store.exportScope(scope);
    const requests = fixture.snapshotRequests.map((request) => new URL(request.url));
    assert.deepEqual(requests.map((url) => url.searchParams.get('limit')), ['100', '50', '100', '100', '100']);
    assert.deepEqual(requests.map((url) => url.searchParams.get('pageCursor')),
      [null, null, 'page-2-at-50', null, 'page-2b']);
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(exported.cursor.cursor, 'cursor-recovered');
  });

  test('freezes the scope terminally when limit 1 still exceeds the negotiated Snapshot page budget', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('alarm');
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: true, cursor: 'cursor-stale' });
    for (let index = 0; index < 7; index += 1) {
      fixture.snapshotResponses.push(problem(413, 'payload_too_large', {}));
    }
    await fixture.engine.wake('online');
    let exported = await fixture.store.exportScope(scope);
    const requests = fixture.snapshotRequests.map((request) => new URL(request.url));
    assert.deepEqual(requests.map((url) => url.searchParams.get('limit')),
      ['100', '50', '25', '12', '6', '3', '1']);
    assert.equal(exported.engine.phase, 'recovery');
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.authorityRefreshRequired, false);
    assert.equal(exported.engine.lastError, 'payload_too_large');
    assert.equal(exported.scope?.lifecycle, 'recovery_required');
    assert.equal(exported.scope?.metadata?.recoveryCode, 'payload_too_large');
    assert.deepEqual(fixture.sessionForces, [false, true]);

    // Terminal: another wake neither re-fetches the Snapshot nor refreshes the Session.
    fixture.clock.now += 2_000;
    await fixture.engine.wake('online');
    exported = await fixture.store.exportScope(scope);
    assert.equal(fixture.snapshotRequests.length, 7);
    assert.deepEqual(fixture.sessionForces, [false, true]);
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.lastError, 'payload_too_large');
  });
});
