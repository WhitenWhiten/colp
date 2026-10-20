import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import { setAsidePullItem } from '../src/pull-item-set-aside.js';
import { executeNativeCreate } from '../src/native-create-executor.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { STORES } from '../src/sync-state/schema.js';
import { installKns05IndexedDb, mappingInput, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import type { SyncScope } from '../src/sync-state-store.js';

installKns05IndexedDb();
afterEach(() => vi.restoreAllMocks());
type OpEvent = Parameters<typeof setAsidePullItem>[2];

function observeMappingReads() {
  const counts = { calls: 0, rows: 0 }; const original = IDBObjectStore.prototype.getAll;
  vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = original.apply(this, args);
    if (this.name === STORES.mappings) {
      counts.calls++;
      request.addEventListener('success', () => { counts.rows += request.result.length; });
    }
    return request;
  });
  return counts;
}

for (const unrelated of [0, 958]) {
  test(`independent Pull items read no ancestry graph with ${unrelated} unrelated mappings and still apply`, async () => {
    const f = await setup();
    try {
      for (let i = 0; i < unrelated; i++) await f.store.putMapping(scope, mappingInput(`unrelated-native-${i}`, `unrelated-${i}`));
      await f.applier.stage(f.page([f.createEvent('Bookmark', 91), f.createEvent('Bookmark', 92),
        f.createEvent('Bookmark', 93)], 'cursor-three'));
      const events = await f.store.listPullEvents(scope, ['staged']); assert.equal(events.length, 3);
      const reads = observeMappingReads();
      for (const event of events) assert.equal(await setAsidePullItem(f.options, String(event.eventId),
        event.payload as unknown as OpEvent, 1_000), false);
      assert.deepEqual(reads, { calls: 0, rows: 0 });
      assert.equal(f.api.calls.length, 0);
      assert.equal((await f.store.listPullEvents(scope, ['staged'])).length, 3);
      assert.deepEqual(await f.store.listPullIssues(scope), []);
      vi.restoreAllMocks();
      await f.applier.resume();
      assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 3);
      assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-three');
      for (const id of [91, 92, 93]) assert.ok(await f.store.getMappingByColpId(scope, `node-created-${id}`));
    } finally { f.store.close(); }
  });
}

test('an issue created after an independent check protects the next check after reopening', async () => {
  const f = await setup();
  try {
    await f.applier.stage(f.page([f.createEvent('Bookmark', 91)], 'cursor-one'));
    const event = (await f.store.listPullEvents(scope, ['staged']))[0]!;
    const check = () => setAsidePullItem(f.options, String(event.eventId), event.payload as unknown as OpEvent, 1_000);
    assert.equal(await check(), false);
    await f.store.recordLocalIssue(scope, { nativeId: 'native-root', code: 'deletion_identity_unproven', now: 1_000 });
    f.store.close();
    assert.equal(await check(), true);
    assert.deepEqual((await f.store.listPullIssues(scope)).map(row => [row.nodeId, row.code]),
      [['node-created-91', 'parent_set_aside']]);
    assert.equal(f.api.calls.length, 0);
  } finally { f.store.close(); }
});

test('a native result lost during the first issue read is seen by the final native-wait check', async () => {
  const f = await setup();
  try {
    const child = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 92, collectionId: scope.collectionId,
      parentId: 'node-created-91' });
    await f.applier.stage(f.page([f.createEvent('Folder', 91), child], 'cursor-parent-child'));
    const [holder, dependent] = await f.store.listPullEvents(scope, ['staged']); assert.ok(holder && dependent);
    let injected = false;
    const options = { ...f.options, store: { ...f.store, async listBootstrapRuns(target: SyncScope) {
      const runs = await f.store.listBootstrapRuns(target);
      if (!injected) {
        injected = true;
        // The first projectNativeWaits read has completed. Execute a genuine
        // create now, lose its API receipt, and let the real executor classify
        // the persisted started intent on retry. No terminal receipt is seeded.
        await f.store.preparePullIntent(scope, String(holder.eventId), { intentId: 'late-holder',
          correlationId: 'late-holder', operationId: String(holder.operationId), eventId: String(holder.eventId),
          effectId: String(holder.effectId), state: 'intent_prepared',
          expected: { kind: 'create', nativeId: 'pending:node-created-91' }, expiresAt: Date.now() + 60_000 });
        const input = { scope, store: f.store, api: f.api, intentId: 'late-holder',
          owner: { scopeKey: scopeKey(scope), generation: scope.generation, commandId: 'pull',
            eventId: String(holder.eventId), colpId: 'node-created-91', substep: 'create' },
          parentNativeId: 'native-root', expected: { title: 'Remote' },
          create: () => f.api.create({ parentId: 'native-root', title: 'Remote' }) };
        await assert.rejects(executeNativeCreate({ ...input, crash: boundary => {
          if (boundary === 'after_create_before_evidence') throw new Error('worker_crash');
        } }), /worker_crash/u);
        assert.equal((await executeNativeCreate(input)).result, 'result_unknown');
      }
      return runs;
    } } };
    assert.equal(await setAsidePullItem(options, String(dependent.eventId), dependent.payload as unknown as OpEvent, 1_000), true);
    assert.equal(injected, true); assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 1);
    f.store.close();
    const waiting = await f.store.getPullEvent(scope, String(dependent.eventId));
    assert.equal(waiting?.state, 'awaiting_confirmation'); assert.equal(waiting?.deferredNativeIntentId, 'late-holder');
    const intent = await f.store.getApplyIntent(scope, 'late-holder');
    assert.equal(intent?.nativeResult, 'result_unknown'); assert.equal(intent?.apiResultEvidence, undefined);
    assert.deepEqual(await f.store.listPullIssues(scope), []);
  } finally { f.store.close(); }
});
