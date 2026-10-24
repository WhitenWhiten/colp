import assert from 'node:assert/strict';
import { test } from 'vitest';
import { advanceSyncCircuit, CIRCUIT_WINDOW_MS, sameSyncProgress, syncProgress } from '../src/sync-circuit-breaker.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { ack, emptyPullPage, json, problem, scope, setup } from './durable-sync-engine-harness.js';

test('idle-renewal denials stop after five across worker restarts, report, and recover automatically', async () => {
  const f = await setup();
  for (let attempt = 1; attempt <= 5; attempt++) {
    f.sessionFailures.push(new Error('recovery_capability_premature'));
    const result = await f.reopen().wake(attempt === 1 ? 'manual' : 'startup');
    assert.equal(result?.circuitBreaker?.failures[0]?.attempts.length, attempt);
    assert.equal(result?.phase === 'error', attempt === 5);
    f.clock.now = result!.notBefore;
  }
  const stopped = (await f.store.getEngineState(scope))!;
  assert.equal(stopped.lastError, 'recovery_capability_premature');
  assert.equal(stopped.circuitBreaker?.trips, 1);
  const calls = f.sessionForces.length;
  f.clock.now = stopped.updatedAt + 1;
  for (const reason of ['startup', 'online', 'alarm'] as const) await f.reopen().wake(reason, { connectivityRestored: true });
  assert.equal(f.sessionForces.length, calls);
  const reports: any[] = [];
  assert.equal(await sendReplicaHealthReport({ scope, store: f.store, storage: new MemoryStorageArea(),
    origin: 'chrome-extension://known', mode: async () => 'enabled', extensionVersion: '0.2.0', now: () => f.clock.now,
    credential: async () => ({ accessToken: 'token', serverOrigin: scope.serverOrigin, subject: scope.accountId }),
    fetch: async (_url, init) => { reports.push(JSON.parse(String(init?.body)));
      return json(200, { accepted: true, replicaId: scope.replicaId, revision: reports.at(-1).revision, commands: [] }); },
  }), 'sent');
  // C-06: a breaker pause resumes by itself, so the Sync center is told a pause (degraded), not a stop.
  assert.equal(reports[0].state, 'degraded');
  assert.equal(reports[0].code, 'recovery_capability_premature');
  assert.ok(reports[0].actions.includes('retry'));
  assert.equal(f.sessionForces.length, calls);
  f.clock.now = stopped.notBefore;
  f.pullResponses.push(json(200, emptyPullPage('cursor-repaired')));
  f.ackResponses.push(json(200, ack('cursor-repaired')));
  const recovered = await f.reopen().wake('alarm');
  assert.equal(recovered?.phase, 'sleeping');
  assert.equal(recovered?.circuitBreaker, undefined);
  assert.equal(recovered?.lastError, undefined);
  f.store.close();
});

test('handled Pull authority denials count even when a renewed Session rotates its cursor', async () => {
  const f = await setup();
  for (let i = 0; i < 5; i++) {
    if (i > 0) f.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: `renewed-${i}` });
    f.pullResponses.push(problem(410, 'stale_replica', {}));
    const state = await f.reopen().wake('manual');
    f.clock.now = Math.max(f.clock.now + 1_000, state!.notBefore);
  }
  assert.equal((await f.store.getEngineState(scope))?.phase, 'error');
  assert.equal((await f.store.getEngineState(scope))?.lastError, 'stale_replica');
  f.store.close();
});

test('denials still count while other devices move the collection head between wakes', async () => {
  const f = await setup();
  for (let i = 0; i < 5; i++) {
    // Each renewed Session rebases the local checkpoint onto a newer collection revision, as it
    // does whenever another browser or the web edits the library between two denials.
    if (i > 0) f.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: `renewed-${i}`,
      serverRevision: `head-${i}` });
    f.pullResponses.push(problem(410, 'stale_replica', {}));
    const state = await f.reopen().wake('manual');
    f.clock.now = Math.max(f.clock.now + 1_000, state!.notBefore);
  }
  const stopped = (await f.store.getEngineState(scope))!;
  assert.equal(stopped.phase, 'error', 'a denial loop with no acked page or pushed op is not progress');
  assert.equal(stopped.lastError, 'stale_replica');
  assert.equal(stopped.circuitBreaker?.failures[0]?.attempts.length, 5);
  f.store.close();
});

test('unknown external failures have a finite bound and manual Retry probes immediately', async () => {
  const f = await setup();
  for (let i = 0; i < 5; i++) {
    f.sessionFailures.push(new Error(`external_failure_${i}`));
    const state = await f.reopen().wake('manual');
    f.clock.now = state!.updatedAt;
    if (i < 4) f.clock.now = state!.notBefore;
  }
  assert.equal((await f.store.getEngineState(scope))?.phase, 'error');
  f.pullResponses.push(json(200, emptyPullPage('fixed'))); f.ackResponses.push(json(200, ack('fixed')));
  assert.equal((await f.reopen().wake('manual'))?.phase, 'sleeping');
  f.store.close();
});

test('per-code windows reset on progress or expiry; cooldown grows to thirty minutes', () => {
  let state = advanceSyncCircuit(undefined, 'stale_replica', 'p1', 1)!;
  state = advanceSyncCircuit(state, 'need_authority', 'p1', 2)!;
  assert.deepEqual(state.failures.map(row => row.attempts.length), [1, 1]);
  state = advanceSyncCircuit(state, 'stale_replica', 'p1', 3)!;
  assert.equal(state.failures.find(row => row.code === 'stale_replica')?.attempts.length, 2);
  assert.equal(advanceSyncCircuit(state, 'stale_replica', 'p2', 4)?.failures[0]?.attempts.length, 1);
  assert.equal(advanceSyncCircuit(state, 'stale_replica', 'p1', CIRCUIT_WINDOW_MS + 4)?.failures[0]?.attempts.length, 1);
  for (let i = 0; i < 12; i++) state = advanceSyncCircuit(state, 'stale_replica', 'p1', 5 + i)!;
  assert.equal(state.retryAt! - 16, CIRCUIT_WINDOW_MS);
  let sliding = advanceSyncCircuit(undefined, 'stale_replica', 'p1', 0);
  for (const minute of [20, 21, 22, 31, 32]) sliding = advanceSyncCircuit(sliding, 'stale_replica', 'p1', minute * 60_000);
  assert.equal(sliding?.retryAt, 33 * 60_000);
  for (const code of ['network_unavailable', 'rate_limited', 'server_unavailable', 'concurrent_local_mutation']) {
    assert.equal(advanceSyncCircuit(undefined, code, 'p1', 1), undefined);
  }
});

test('progress names committed work and the push head; a rebased cursor matches what came before it', () => {
  const page = syncProgress({ cursorEvidence: { pullPageId: 'page-1', pageDigest: 'sha256:x' }, headOpId: null });
  const rebased = syncProgress({ cursorEvidence: { sessionAuthority: true }, headOpId: null });
  const nextPage = syncProgress({ cursorEvidence: { pullPageId: 'page-2', pageDigest: 'sha256:y' }, headOpId: null });
  const pushed = syncProgress({ cursorEvidence: { sessionAuthority: true }, headOpId: 'op-2' });
  assert.equal(sameSyncProgress(page, rebased), true, 'a Session rebase only drops evidence');
  assert.equal(sameSyncProgress(rebased, rebased), true);
  assert.equal(sameSyncProgress(page, nextPage), false, 'a committed page is progress');
  assert.equal(sameSyncProgress(rebased, page), false, 'evidence after a rebase is progress');
  assert.equal(sameSyncProgress(rebased, pushed), false, 'a moved push head is progress');
  assert.equal(sameSyncProgress('p1', 'p2'), false);
  // The window remembers the progress it opened on, so later real progress still resets it.
  const opened = advanceSyncCircuit(undefined, 'stale_replica', page, 1)!;
  const continued = advanceSyncCircuit(opened, 'stale_replica', rebased, 2)!;
  assert.equal(continued.progress, page);
  assert.equal(continued.failures[0]?.attempts.length, 2);
  assert.equal(advanceSyncCircuit(continued, 'stale_replica', nextPage, 3)?.failures[0]?.attempts.length, 1);
});
