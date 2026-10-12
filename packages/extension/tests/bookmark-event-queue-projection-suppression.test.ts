import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { bookmark, fixture, scope } from './bookmark-event-queue-harness.js';

test('projection update suppression keeps a mismatched local callback in the inbox', async () => {
  const { queue, store, api } = await fixture(new IDBFactory(), { mappedNode: true });
  try {
    await store.replaceProjectionIntents(scope, [{
      intentId: 'update:mapped', kind: 'update', colpId: 'mapped', order: 1,
      nativeId: 'mapped', suppression: 'recovery:update:mapped',
      title: 'Remote title', url: 'https://example.test/remote',
      generation: scope.generation, state: 'executing',
    }]);
    api.put(bookmark('mapped', 'root-selected', 0, 'Local edit', 'https://example.test/before'));

    assert.equal((await queue.changed('mapped', { title: 'Local edit' }, 'callback')).outcome, 'staged');
    const inbox = await store.listBookmarkEventsByStatus(scope, 'pending', 0, 100);
    assert.equal(inbox.length, 1);
    const draft = inbox[0]!.details.draft as {
      readonly payload: { readonly value: { readonly title: string } };
    };
    assert.equal(draft.payload.value.title, 'Local edit');
  } finally { await store.close(); }
});
