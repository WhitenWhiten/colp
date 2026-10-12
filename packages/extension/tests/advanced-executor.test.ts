import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { advanceConfirmedPlan } from '../src/bootstrap/advanced-executor.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { active, scope } from './kns-03-bootstrap-harness.js';

async function setup() {
  const indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB });
  await active(store); await store.commitAdvancedPlan(scope, { planId: 'plan', metadata: { mode: 'upload' },
    steps: [{ stepId: 'a' }, { stepId: 'b' }], now: 10 });
  return { store, indexedDB };
}

test('a crash after a side effect replays the executing step without repeating terminal predecessors', async () => {
  const { store, indexedDB } = await setup(); const effects: string[] = [];
  await assert.rejects(advanceConfirmedPlan({ store, scope, planId: 'plan', adapter: {
    async apply(step) {
      effects.push(String(step.definition.stepId));
      if (step.order === 1) throw new Error('worker_terminated');
      return { state: 'complete', evidence: { nativeId: 'created-a' } };
    },
  } }), /worker_terminated/);
  assert.deepEqual((await store.readAdvancedPlan(scope, 'plan'))?.steps.map((step) => step.state),
    ['terminal', 'executing']);
  store.close(); const reopened = createSyncStateStore({ indexedDB });
  const result = await advanceConfirmedPlan({ store: reopened, scope, planId: 'plan', adapter: {
    async apply(step, completed) {
      assert.equal(step.state, 'executing'); assert.equal(step.order, 1);
      assert.deepEqual(completed[0]?.evidence, { nativeId: 'created-a' });
      // Observation proves the second call committed before the worker died.
      assert.ok(effects.includes(String(step.definition.stepId)));
      return { state: 'complete', evidence: { nativeId: 'created-b' } };
    },
  } });
  assert.equal(result, 'completed'); assert.deepEqual(effects, ['a', 'b']);
});

test('waiting for a durable receipt never advances the dependent step', async () => {
  const { store } = await setup(); const visited: number[] = [];
  const result = await advanceConfirmedPlan({ store, scope, planId: 'plan', adapter: {
    async apply(step) { visited.push(step.order); return { state: 'waiting' }; },
  } });
  assert.equal(result, 'waiting'); assert.deepEqual(visited, [0]);
  assert.deepEqual((await store.readAdvancedPlan(scope, 'plan'))?.steps.map((step) => step.state),
    ['executing', 'pending']);
});

test('changed before-state pauses the plan and later automatic wakes do not overwrite it', async () => {
  const { store } = await setup(); let calls = 0;
  const adapter = { async apply() { calls += 1; return { state: 'changed' as const, code: 'native_changed' }; } };
  assert.equal(await advanceConfirmedPlan({ store, scope, planId: 'plan', adapter }), 'attention');
  assert.equal(await advanceConfirmedPlan({ store, scope, planId: 'plan', adapter }), 'attention');
  assert.equal(calls, 1);
  assert.equal((await store.readAdvancedPlan(scope, 'plan'))?.steps[0]?.error, 'native_changed');
});

test('revoking authority between steps prevents the next native or remote mutation', async () => {
  const { store } = await setup(); let revoked = false; let calls = 0;
  await assert.rejects(advanceConfirmedPlan({ store, scope, planId: 'plan',
    async assertAuthority() { if (revoked) throw new Error('authority_fenced'); }, adapter: {
      async apply() { calls += 1; revoked = true; return { state: 'complete', evidence: { nativeId: 'first' } }; },
    },
  }), /authority_fenced/);
  assert.equal(calls, 1);
  assert.deepEqual((await store.readAdvancedPlan(scope, 'plan'))?.steps.map((step) => step.state), ['terminal', 'pending']);
});
