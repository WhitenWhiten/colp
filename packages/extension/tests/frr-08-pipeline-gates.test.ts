import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { beforeEach, test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { recordKns09Stop, resetKns09MetricsForTests, setKns09MutationSwitchesForTests } from '../src/kns-09-release.js';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();
beforeEach(() => { resetKns09MetricsForTests(); setKns09MutationSwitchesForTests(); });

test('the real event ingress stops creating Operations after the out-of-scope detector fires', async () => {
  const f = await setup();
  const queue = createBookmarkEventQueue({ store: f.store, scope, api: {
    get: async id => (await f.api.get(id)).map(node => ({ ...node, title: node.title ?? '' })),
    getChildren: async id => (await f.api.getChildren(id)).map(node => ({ ...node, title: node.title ?? '' })),
  }, autoFlush: false });
  recordKns09Stop('outOfScopeUpload', scope);
  const result = await queue.created('fresh', { id: 'fresh', parentId: 'native-root', title: 'Fresh', url: 'https://example.test/fresh' });
  await queue.flush();
  assert.equal(result.outcome, 'filtered');
  assert.equal((await f.store.listQueue(scope)).length, 0);
});

test('the real Pull applier retains its pending cursor while mutation is paused and resumes after reopening', async () => {
  const f = await setup(); await f.applier.stage(f.page([f.mutationEvent('update')]));
  setKns09MutationSwitchesForTests({ coordinator: false, ui: true });
  await assert.rejects(() => f.applier.resume(), /sync_paused/);
  assert.notEqual((await f.store.getCursor(scope))?.cursor, 'cursor-next');
  assert.equal(f.api.calls.length, 0);
  setKns09MutationSwitchesForTests({ coordinator: true, ui: true });
  await f.applier.resume();
  assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-next');
});
