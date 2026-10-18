import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { ack, json, networkFailure, emptyPullPage, scope, setup } from './durable-sync-engine-harness.js';

// SR-14 (audit 2026-09-12 §S7 / synthesis row SR-14): the Push peer rebases a
// retried `move_node`/`create_node` against local mapping facts. Production
// never handed the worker a refresh hook, so those rebases could only ever use
// facts as old as the last Pull, and the advisory pre-Push Pull swallowed every
// failure (connectivity included) without a trace. These tests pin the engine
// side of the fix: a narrow refresh that reuses the Pull path, never persists
// offline state, dedupes to one Pull per wake, and journals what it could not
// do instead of deciding the wake.

type Fixture = Awaited<ReturnType<typeof setup>>;

async function diagnosticRows(fixture: Fixture) {
  const exported = await fixture.store.exportDiagnostics();
  return exported.records as ReadonlyArray<Record<string, unknown>>;
}

/** A live retried create row: `retry.attempt > 0` with no bound attempt, which
 * is exactly the head shape the advisory pre-Push Pull keys off. */
async function enqueueRetriedCreate(fixture: Fixture, opId = 'op-placement-1') {
  return await fixture.store.allocateSequenceAndEnqueue(scope, {
    opId, batchId: `batch-${opId}`, idempotencyKey: `key-${opId}`, digest: `sha256:${opId}`,
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
    operationRevision: `local-${opId}`, status: 'pending', retry: { attempt: 1, notBefore: 0 },
    payload: { opId, replicaId: scope.replicaId, sequence: 1, collectionId: scope.collectionId,
      type: 'create_node', baseRevision: null, occurredAt: '2026-07-28T00:00:00Z', dependencies: [], payload: {} },
  }, { allowUnstamped: true });
}

function refreshDiagnostics(records: ReadonlyArray<Record<string, unknown>>) {
  return records.filter((row) => row.kind === 'placement_refresh');
}

describe('SR-14 engine placement refresh', () => {
  test('a timed-out Pull aborts the request and leaves a retryable offline state', async () => {
    let aborted = false;
    const fixture = await setup({ requestTimeoutMilliseconds: 5, fetch: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
      }) });
    try {
      await fixture.engine.wake('manual');
      assert.equal(aborted, true);
      assert.equal((await fixture.store.getEngineState(scope))?.phase, 'offline');
      assert.notEqual((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
    } finally { fixture.store.close(); }
  });

  test('a failed Session refresh is journalled without losing its cause', async () => {
    const fixture = await setup();
    try {
      fixture.sessionFailures.push(new Error('session_authority_invalid'));
      assert.equal(await fixture.engine.refreshPlacement(), 'continue');
      assert.equal(refreshDiagnostics(await diagnosticRows(fixture))[0]?.code, 'session_authority_invalid');
    } finally { fixture.store.close(); }
  });

  test('an idle compaction failure keeps the completed Pull and schedules the next wake', async () => {
    const fixture = await setup({ compactScope: async () => { throw new Error('storage unavailable'); } });
    try {
      fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
      fixture.ackResponses.push(json(200, ack('cursor-1')));
      await fixture.engine.wake('manual');
      assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-1');
      assert.equal((await fixture.store.getEngineState(scope))?.phase, 'sleeping');
      assert.ok((await diagnosticRows(fixture)).some(row => row.code === 'compaction_failed'));
      assert.ok(fixture.scheduled.length > 0);
    } finally { fixture.store.close(); }
  });

  test('refreshPlacement walks the real Pull path and advances the cursor', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(json(200, ack('cursor-1')));

    await fixture.engine.refreshPlacement();

    assert.deepEqual(fixture.order, ['resume', 'pull:cursor-0', 'stage:cursor-1', 'resume', 'ack:cursor-1']);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor?.cursor, 'cursor-1');
    assert.equal(exported.engine?.phase, 'sleeping');
    assert.equal(exported.engine?.lastError, undefined);
    assert.deepEqual(refreshDiagnostics(await diagnosticRows(fixture)), []);
  });

  test('a failed refresh records a diagnostic instead of persisting offline state', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(networkFailure('placement refresh'));

    await fixture.engine.refreshPlacement();

    const state = (await fixture.store.getEngineState(scope))!;
    // `pull` records the attempt as phase 'pulling' before it touches the
    // network; what must not happen is the offline projection (`offline()`),
    // i.e. no offline/recovery phase, no lastError, no freeze and no backoff.
    assert.notEqual(state.phase, 'offline');
    assert.notEqual(state.phase, 'recovery');
    assert.equal(state.lastError, undefined);
    assert.equal(state.recoveryFrozen, false);
    assert.deepEqual(fixture.scheduled, []);
    const misses = refreshDiagnostics(await diagnosticRows(fixture));
    assert.equal(misses.length, 1);
    assert.equal(misses[0]!.code, 'network_unavailable');
  });

  test('a recovery Pull result is returned to the Push peer as a hard barrier', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(410, {
      type: 'https://know-n.com/colp/problems/sync_cursor_expired',
      title: 'sync_cursor_expired', status: 410, code: 'sync_cursor_expired',
    }, { 'Content-Type': 'application/problem+json' }));

    assert.equal(await fixture.engine.refreshPlacement(), 'recovery');
    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.phase, 'recovery');
    assert.equal(state.recoveryFrozen, true);
    assert.equal(state.authorityRefreshRequired, true);
  });

  test('worker_crash still escapes and does not poison the next refresh', async () => {
    const fixture = await setup();
    fixture.crashAt = 'before_pull';

    await assert.rejects(() => fixture.engine.refreshPlacement(), /worker_crash/);

    // The crash injection contract aborts the surrounding wake, but it must not
    // memoize the rejection: the next drain in the same scope refreshes again.
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(json(200, ack('cursor-1')));
    await fixture.engine.refreshPlacement();
    assert.ok(fixture.order.includes('pull:cursor-0'));
    assert.equal((await fixture.store.getEngineState(scope))?.lastError, undefined);
  });

  test('concurrent callers share one Pull and the window resets on the next wake', async () => {
    const fixture = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    fixture.pullResponses.push(gate.then(() => json(200, emptyPullPage('cursor-1'))));
    fixture.ackResponses.push(json(200, ack('cursor-1')));

    const first = fixture.engine.refreshPlacement();
    const second = fixture.engine.refreshPlacement();
    release();
    await Promise.all([first, second]);
    await fixture.engine.refreshPlacement();
    assert.equal(fixture.order.filter((entry) => entry === 'pull:cursor-0').length, 1,
      'a drain rebasing several retried rows must not multiply Pull traffic');

    // A new wake opens a fresh window even when it does no network work itself.
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-2')));
    fixture.ackResponses.push(json(200, ack('cursor-2')));
    await fixture.engine.wake('manual');
    await fixture.engine.refreshPlacement();
    assert.equal(fixture.order.filter((entry) => entry === 'pull:cursor-1').length, 1,
      'the next wake opens a fresh refresh window');
  });
});

describe('SR-14 advisory pre-Push Pull', () => {
  test('a connectivity miss is journalled and the Push phase still gets its turn', async () => {
    const fixture = await setup();
    await enqueueRetriedCreate(fixture);
    fixture.pullResponses.push(networkFailure('advisory placement pull'), json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(json(200, ack('cursor-1')));

    await fixture.engine.wake('manual');

    // The advisory Pull ran first, then Push, then the wake's own Pull. The
    // advisory miss cannot advance the cursor, so the wake Pull repeats
    // cursor-0 and converges it on its own.
    assert.ok(fixture.order.includes('push'));
    assert.ok(fixture.order.indexOf('pull:cursor-0') < fixture.order.indexOf('push'));
    assert.equal(fixture.order.filter((entry) => entry === 'pull:cursor-0').length, 2);
    assert.equal(fixture.order.filter((entry) => entry === 'stage:cursor-1').length, 1);
    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.phase, 'sleeping');
    assert.equal(state.lastError, undefined);
    const misses = refreshDiagnostics(await diagnosticRows(fixture));
    assert.equal(misses.length, 1);
    assert.equal(misses[0]!.code, 'network_unavailable');
  });

  test('a non-fatal failure is journalled with its own code instead of being swallowed', async () => {
    const fixture = await setup();
    await enqueueRetriedCreate(fixture);
    fixture.pullResponses.push(json(200, { not: 'a pull page' }), json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(json(200, ack('cursor-1')));

    await fixture.engine.wake('manual');

    assert.ok(fixture.order.includes('push'));
    const misses = refreshDiagnostics(await diagnosticRows(fixture));
    assert.equal(misses.length, 1);
    assert.equal(misses[0]!.code, 'pull_invalid');
    assert.equal((await fixture.store.getEngineState(scope))!.phase, 'sleeping');
  });

  test('a landed advisory Pull serves the peer rebase refresh in the same wake', async () => {
    const fixture = await setup();
    await enqueueRetriedCreate(fixture);
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')), json(200, emptyPullPage('cursor-2')));
    fixture.ackResponses.push(json(200, ack('cursor-1')), json(200, ack('cursor-2')));
    // The real worker asks the engine for a placement refresh before rebasing a
    // retried row; the fake peer reproduces that call at the same point.
    const engine = fixture.engine;
    const replay = fixture.push.drain.bind(fixture.push);
    fixture.push.drain = async () => { const outcome = await replay(); await engine.refreshPlacement(); return outcome; };

    await fixture.engine.wake('manual');

    // One Pull for the advisory read, one for the wake's own Pull: the rebase
    // refresh reused the advisory facts instead of adding a third request.
    assert.equal(fixture.order.filter((entry) => entry === 'pull:cursor-0').length, 1);
    assert.equal(fixture.order.filter((entry) => entry === 'pull:cursor-1').length, 1);
    assert.equal((await fixture.store.getEngineState(scope))!.phase, 'sleeping');
    assert.deepEqual(refreshDiagnostics(await diagnosticRows(fixture)), []);
  });
});

describe('SR-14 production wiring (src/sw/engine.ts)', () => {
  // Static anchor only: the behavior of `refreshPlacement` itself is covered by
  // the engine tests above, and the rebase-side call order by
  // tests/outbound-push-worker-rebase.test.ts.
  test('the worker hook is late-bound to engine.refreshPlacement before any drain', async () => {
    const source = await readFile(resolve('src/sw/engine.ts'), 'utf8');
    assert.match(source, /refreshPlacement: async \(\) => placementRefreshEnabled[\s\S]{0,120}placementRefresh/,
      'the production worker must receive a refreshPlacement hook');
    assert.match(source, /allowRecoveryFrozenPush: \(\) => !placementRefreshEnabled/,
      'only engine-less advanced drains may cross the recovery barrier');
    assert.match(source, /placementRefresh = \(\) => engine\.refreshPlacement\(\);/,
      'the holder must delegate to the engine implementation');
    assert.match(source, /pushWorker: worker/);
    const assigned = source.indexOf('placementRefresh = () => engine.refreshPlacement();');
    const firstDrain = source.indexOf('await worker.drain(');
    assert.ok(assigned > 0 && firstDrain > assigned,
      'the holder must be assigned before the first worker drain');
  });

  test('the engine-less drains stay refresh-free while the wake enables it', async () => {
    const source = await readFile(resolve('src/sw/engine.ts'), 'utf8');
    const bootstrap = source.indexOf('if (bootstrapComplete)');
    const enabled = source.indexOf('placementRefreshEnabled = true;');
    const wake = source.indexOf('await engine.wake(');
    assert.match(source, /let placementRefreshEnabled = false;/);
    // The bootstrap / apply-not-allowed drains project nothing, so the refresh
    // Pull must not become reachable from them; the engine wake enables it.
    assert.ok(bootstrap > 0 && enabled > bootstrap, 'the gate opens after the engine-less branches');
    assert.ok(wake > enabled, 'the gate opens before the engine wake');
  });
});
