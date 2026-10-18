import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import type { BookmarkEventRecord, JsonObject } from '../src/sync-state-store.js';
import { setup, scope, operation, problem, resetIndexedDb } from './outbound-push-worker-harness.js';

for (const mutation of ['move', 'delete', 'pending'] as const) {
  test(`a save whose batch predecessor ${mutation} is set aside, and the later save still uploads`, async () => {
    resetIndexedDb();
    const fixture = await setup({ createPlacement: 'bottom' });
    const { store } = fixture;
    try {
      const [event] = await store.listBookmarkEvents(scope);
      const context = event!.details.context as JsonObject;
      const placement = context.placement as JsonObject;
      const current: BookmarkEventRecord = { ...event!, details: { ...event!.details,
        context: { ...context, placement: { ...placement, batchOrder: 1, batchSize: 2 } } } };
      const previous: BookmarkEventRecord = { ...event!, eventId: 'predecessor-event', ordinal: 2,
        dedupeKey: 'predecessor-dedupe', nativeId: 'native-anchor-old', opId: 'committed-predecessor',
        details: { ...event!.details, context: { ...context,
          placement: { ...placement, batchOrder: 0, batchSize: 2 } } } };
      const db = await store.open();
      const tx = db.transaction('bookmark_events', 'readwrite');
      tx.objectStore('bookmark_events').put(current);
      tx.objectStore('bookmark_events').put(previous);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      });
      await store.allocateSequenceAndEnqueue(scope, { opId: 'later-op', batchId: 'later-batch',
        idempotencyKey: 'later-key', digest: 'sha256:later', endpointIdentity: 'syncPush',
        mediaType: 'application/json', baseRevision: null, operationRevision: 'local-later',
        status: 'pending', retry: { attempt: 0, notBefore: 0 },
        payload: { ...operation, opId: 'later-op', sequence: 2 } }, { allowUnstamped: true });
      let sends = 0;
      const worker = createOutboundPushWorker({ ...fixture.options,
        refreshPlacement: async () => {
          if (mutation === 'pending') await store.deleteMapping(scope, 'native-anchor-old');
          if (mutation === 'delete') await store.deleteMapping(scope, 'native-anchor-old');
          else await store.putMapping(scope, { nativeId: 'native-anchor-old',
            colpId: mutation === 'pending' ? 'pending-predecessor' : 'anchor-old', rootNativeId: 'root-native',
            parentNativeId: mutation === 'pending' ? 'native-parent' : 'other-parent',
            parentColpId: mutation === 'pending' ? 'root-push' : 'other-server-parent', nodeKind: 'bookmark',
            projection: { revision: mutation === 'pending' ? 'local-predecessor' : 'r2', digest: 'sha256:changed' } });
          return 'continue';
        },
        readChildrenOrder: async () => ['native-create'],
        fetch: async () => { sends++; return problem(409, 'position_context_stale', { retryable: true }); },
      });
      assert.equal((await worker.drain()).outcome, 'unknown');
      if (mutation === 'pending') {
        for (let retry = 0; retry < 2; retry++) {
          fixture.clock.now = (await store.listQueue(scope))[0]!.retry.notBefore;
          assert.equal((await worker.drain()).outcome, 'unknown');
        }
      }
      fixture.clock.now = (await store.listQueue(scope))[0]!.retry.notBefore;
      // The save that cannot be placed waits as one item; the later save is sent instead of waiting behind it.
      assert.equal((await worker.drain()).outcome, 'unknown', JSON.stringify(await store.listQueue(scope)));
      const rows = await store.listQueue(scope);
      assert.deepEqual([rows[0]?.status, rows[0]?.recovery?.code], ['set_aside', 'create_placement_unproven']);
      assert.equal(rows[1]?.opId, 'later-op');
      assert.equal(sends, 2);
      assert.equal((await store.getScope(scope))?.lifecycle, 'active');
      assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
      // The held save is never retried on its own.
      fixture.clock.now = rows[1]!.retry.notBefore;
      await worker.drain();
      const held = (await store.listQueue(scope))[0]!;
      assert.deepEqual([held.status, held.retry.attempt], ['set_aside', rows[0]?.retry.attempt]);
    } finally { store.close(); }
  });
}
