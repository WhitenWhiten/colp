import assert from 'node:assert/strict';
import { test } from 'vitest';
import { advanceSyncCircuit, CIRCUIT_WINDOW_MS } from '../src/sync-circuit-breaker.js';
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
      return json(200, { accepted: true, replicaId: scope.replicaId, revision: f.clock.now }); },
  }), 'sent');
  assert.equal(reports[0].state, 'stopped');
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
