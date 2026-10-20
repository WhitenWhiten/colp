import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();

for (const phase of ['native_result', 'page_complete'] as const) {
  test(`a ${phase} create retains an identical user bookmark with another native identity`, async () => {
    const f = await setup(phase === 'native_result' ? 'after_browser_call' : undefined);
    try {
      await f.applier.stage(f.page([f.createEvent('Bookmark')]));
      if (phase === 'native_result') await assert.rejects(() => f.applier.resume(), /worker_crash/);
      else await f.applier.resume();
      const intent = (await f.store.exportScope(scope)).intents[0]!;
      assert.equal(intent.nativeEventEvidence ?? null, null, 'the original callback has not arrived');
      const createdId = intent.nativeResultConfirmation?.nativeId;
      assert.equal(typeof createdId, 'string');
      const queue = createBookmarkEventQueue({ scope, store: f.store, autoFlush: false, api: {
        get: async id => (await f.api.get(id)).map(row => ({ ...row, title: row.title ?? '' })),
        getChildren: async id => (await f.api.getChildren(id)).map(row => ({ ...row, title: row.title ?? '' })),
      } });
      const copy = { id: 'user-copy', parentId: 'native-root', index: 3,
        title: 'Remote', url: 'https://example.test/' };
      f.api.seed(copy);
      assert.equal((await queue.created(copy.id, copy)).outcome, 'staged');
      // Delayed and duplicate callbacks for the API's actual identity still
      // suppress correctly, even after a sibling insertion shifts its index.
      for (let delivery = 0; delivery < 2; delivery++) {
        assert.equal((await queue.created(createdId!, { ...copy, id: createdId!, index: 7 })).outcome,
          'apply_intent_reserved');
      }
      assert.deepEqual((await f.store.listBookmarkEventsByStatus(scope, 'pending')).map(row => row.nativeId), ['user-copy']);
    } finally { f.store.close(); }
  });
}
