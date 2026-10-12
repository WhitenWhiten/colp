import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { digestJson } from '../src/bookmark-event-codec.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { STORES } from '../src/sync-state/schema.js';
import { active, scope } from './kns-03-bootstrap-harness.js';

async function setup() {
  const indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB });
  await active(store); return { indexedDB, store };
}
const input: Parameters<ReturnType<typeof createSyncStateStore>['commitAdvancedPlan']>[1] = {
  planId: 'plan-1', metadata: { mode: 'upload', treeDigest: 'tree-before' },
  steps: [{ stepId: 'first', title: 'before' }, { stepId: 'second', parentId: 'parent-before' }], now: 10 };

describe('immutable advanced bootstrap plan authority', () => {
  test('reopen and repeated confirmation preserve the exact plan and executing progress', async () => {
    const { indexedDB, store } = await setup();
    const committed = await store.commitAdvancedPlan(scope, input);
    await store.settleAdvancedStep(scope, input.planId, 0, { expectedState: 'pending', state: 'executing',
      evidence: { opId: 'durable-op' } });
    store.close(); const reopened = createSyncStateStore({ indexedDB });
    assert.equal((await reopened.commitAdvancedPlan(scope, input)).digest, committed.digest);
    const loaded = await reopened.readAdvancedPlan(scope, input.planId);
    assert.deepEqual(loaded?.steps.map((step) => step.definition), input.steps);
    assert.equal(loaded?.steps[0]?.state, 'executing');
    assert.deepEqual(loaded?.steps[0]?.evidence, { opId: 'durable-op' });
    await assert.rejects(reopened.commitAdvancedPlan(scope, { ...input, steps: [{ stepId: 'changed' }] }),
      /advanced_plan_changed/);
    assert.deepEqual(await reopened.readAdvancedPlan(scope, input.planId), loaded);
  });

  test('concurrent confirmations admit one active plan atomically', async () => {
    const { store } = await setup();
    const results = await Promise.allSettled([
      store.commitAdvancedPlan(scope, input),
      store.commitAdvancedPlan(scope, { ...input, planId: 'another' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal((await store.listAdvancedPlans(scope)).length, 1);
    const exported = await store.exportScope(scope);
    assert.equal(exported.advancedPlans.length, 1);
    assert.equal(exported.advancedSteps.length, 2);
  });

  test('invalid final step leaves no partial header or earlier steps', async () => {
    const { store } = await setup(); const before = await store.exportScope(scope);
    await assert.rejects(store.commitAdvancedPlan(scope, { ...input,
      steps: [input.steps[0]!, { oversized: 'x'.repeat(300_000) }] }), /record_too_large/);
    assert.deepEqual(await store.exportScope(scope), before);
  });

  test('stale completions cannot reset progress and completion requires every terminal step', async () => {
    const { store } = await setup(); await store.commitAdvancedPlan(scope, input);
    await assert.rejects(store.completeAdvancedPlan(scope, input.planId, 20), /advanced_plan_incomplete/);
    await store.settleAdvancedStep(scope, input.planId, 0, { expectedState: 'pending', state: 'executing' });
    await assert.rejects(store.settleAdvancedStep(scope, input.planId, 0,
      { expectedState: 'pending', state: 'executing' }), /advanced_step_stale/);
    await store.settleAdvancedStep(scope, input.planId, 0, { expectedState: 'executing', state: 'terminal' });
    await assert.rejects(store.settleAdvancedStep(scope, input.planId, 0,
      { expectedState: 'terminal', state: 'executing' }), /advanced_step_transition_invalid/);
    await store.settleAdvancedStep(scope, input.planId, 1, { expectedState: 'pending', state: 'executing' });
    await store.settleAdvancedStep(scope, input.planId, 1, { expectedState: 'executing', state: 'terminal' });
    await store.completeAdvancedPlan(scope, input.planId, 30);
    assert.equal((await store.readAdvancedPlan(scope, input.planId))?.plan.state, 'completed');
  });

  test('tampered or missing stored steps fail closed on read', async () => {
    const { store } = await setup(); await store.commitAdvancedPlan(scope, input);
    const db = await store.open();
    const loaded = await store.readAdvancedPlan(scope, input.planId);
    const mutation = db.transaction(STORES.advancedSteps, 'readwrite');
    mutation.objectStore(STORES.advancedSteps).put({ ...loaded!.steps[0]!, definition: { stepId: 'tampered' } });
    await new Promise<void>((resolve, reject) => { mutation.oncomplete = () => resolve(); mutation.onabort = () => reject(mutation.error); });
    await assert.rejects(store.readAdvancedPlan(scope, input.planId), /advanced_step_corrupt/);
    await assert.rejects(store.settleAdvancedStep(scope, input.planId, 0,
      { expectedState: 'pending', state: 'executing' }), /advanced_step_corrupt/);
  });

  test('scope identity isolates confirmations and their evidence', async () => {
    const { store } = await setup(); await store.commitAdvancedPlan(scope, input);
    const other = { ...scope, browserProfileId: 'other-profile' };
    assert.equal(await store.readAdvancedPlan(other, input.planId), null);
    assert.deepEqual(await store.listAdvancedPlans(other), []);
    await assert.rejects(store.commitAdvancedPlan(other, input), /scope_not_found/);
  });

  test('retirement archives the immutable plan and removes its live steps', async () => {
    const { store } = await setup();
    const committed = await store.commitAdvancedPlan(scope, input);

    await store.retireScope(scope, { retiredAt: 100, reason: 'test-retirement' });

    assert.equal(await store.readAdvancedPlan(scope, input.planId), null);
    assert.deepEqual(await store.listAdvancedPlans(scope), []);
    const exported = await store.exportScope(scope);
    assert.deepEqual(exported.advancedPlans, []);
    assert.deepEqual(exported.advancedSteps, []);
    const archive = await store.exportArchive(scope);
    assert.deepEqual(archive.advancedPlans, [committed]);
    assert.ok(Array.isArray(archive.advancedSteps));
    assert.deepEqual((archive.advancedSteps as Array<{ readonly order: number }>).map((step) => step.order), [0, 1]);
  });

  test('account cleanup archives every advanced row and leaves no live plan', async () => {
    const { store } = await setup();
    await store.commitAdvancedPlan(scope, input);

    await store.cleanupAccount({ environment: scope.environment, serverId: scope.serverId,
      accountId: scope.accountId, browserProfileId: scope.browserProfileId });

    assert.deepEqual(await store.listAdvancedPlans(scope), []);
    const archive = await store.exportArchive(scope);
    assert.ok(Array.isArray(archive.advancedPlans));
    assert.ok(Array.isArray(archive.advancedSteps));
    assert.equal((archive.advancedPlans as unknown[]).length, 1);
    assert.equal((archive.advancedSteps as unknown[]).length, input.steps.length);
  });

  test('missing steps fail closed before a step can execute', async () => {
    const { store } = await setup(); await store.commitAdvancedPlan(scope, input);
    const loaded = await store.readAdvancedPlan(scope, input.planId);
    const db = await store.open();
    const mutation = db.transaction(STORES.advancedSteps, 'readwrite');
    mutation.objectStore(STORES.advancedSteps).delete([loaded!.steps[1]!.scopeKey, input.planId, 1]);
    await transactionComplete(mutation);

    await assert.rejects(store.readAdvancedPlan(scope, input.planId), /advanced_plan_corrupt/);
    await assert.rejects(store.settleAdvancedStep(scope, input.planId, 0,
      { expectedState: 'pending', state: 'executing' }), /advanced_plan_corrupt/);
  });

  test('a definition changed with a matching step digest cannot execute under the old plan', async () => {
    const { store } = await setup(); await store.commitAdvancedPlan(scope, input);
    const loaded = await store.readAdvancedPlan(scope, input.planId);
    const original = loaded!.steps[0]!;
    const definition = { ...original.definition, title: 'changed-after-confirmation' };
    const db = await store.open();
    const mutation = db.transaction(STORES.advancedSteps, 'readwrite');
    mutation.objectStore(STORES.advancedSteps).put({ ...original, definition, digest: digestJson(definition) });
    await transactionComplete(mutation);

    await assert.rejects(store.readAdvancedPlan(scope, input.planId), /advanced_plan_corrupt/);
    await assert.rejects(store.settleAdvancedStep(scope, input.planId, 0,
      { expectedState: 'pending', state: 'executing' }), /advanced_plan_corrupt/);
  });

  test('each record is capped at 256 KiB while one plan may span multiple records', async () => {
    const single = await setup();
    await assert.rejects(single.store.commitAdvancedPlan(scope, {
      planId: 'too-large', metadata: { mode: 'upload' },
      steps: [{ payload: 'x'.repeat(270_000) }], now: 10,
    }), /record_too_large/);

    const split = await setup();
    const largePlan = await split.store.commitAdvancedPlan(scope, {
      planId: 'split-large', metadata: { mode: 'upload' },
      steps: [{ payload: 'a'.repeat(200_000) }, { payload: 'b'.repeat(200_000) }], now: 10,
    });
    assert.equal(largePlan.stepCount, 2);
    assert.equal((await split.store.readAdvancedPlan(scope, 'split-large'))?.steps.length, 2);
    const exported = await split.store.exportScope(scope);
    assert.ok(JSON.stringify(exported.advancedSteps).length > 256 * 1024);
    assert.equal(exported.advancedSteps.length, 2);
  });
});

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
