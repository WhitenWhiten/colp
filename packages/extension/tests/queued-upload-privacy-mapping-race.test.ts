import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { assertQueuedUploadAllowed } from '../src/queued-upload-boundary.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { bookmark, fixture, scope } from './bookmark-event-queue-harness.js';
import { endpoints } from './outbound-push-worker-harness.js';
import { REJOIN_TOKEN, rejoinSession } from './rejoin-http-fixture.js';

for (const kind of ['create', 'change', 'move'] as const) test(`the final ${kind} dispatch fails closed when a current private mapping disappears`, async () => {
  const f = await fixture(new IDBFactory(), { autoFlush: true, mappedNode: kind !== 'create' });
  try {
    const node = bookmark(kind === 'create' ? 'private-source' : 'mapped', 'folder-parent', 0,
      'Browser-only content', 'https://private.example.test/');
    f.api.put(node);
    if (kind === 'create') await f.queue.created(node.id, node);
    else if (kind === 'change') await f.queue.changed(node.id, { title: node.title, url: node.url });
    else {
      f.api.put({ ...node, parentId: 'root-selected' });
      await f.queue.moved(node.id, { parentId: 'root-selected', index: 0, oldParentId: 'folder-parent', oldIndex: 0 });
    }
    const [original] = await f.store.listQueue(scope); expect(original).toBeDefined();
    const native = f.api.node(node.id), session = await rejoinSession(scope);
    let finalDispatch = false, scopeReads = 0, injected = false, requests = 0;
    const store = { ...f.store, getScope: async (...args: Parameters<typeof f.store.getScope>) => {
      if (finalDispatch && ++scopeReads === 2) {
        // The first private-id check already succeeded. A later current
        // boundary read must not treat its now-missing proof as public.
        await f.store.deleteMapping(scope, 'root-private');
        f.api.put({ ...f.api.node('root-selected'), parentId: 'root-private' });
        injected = true;
      }
      return f.store.getScope(...args);
    } };
    await createOutboundPushWorker({ scope, store: f.store, endpoints: async () => endpoints,
      sessions: { get: async () => ({ credential: { accessToken: REJOIN_TOKEN, subject: scope.accountId }, session }) },
      ownerId: () => 'private-proof-race', schedule: () => undefined,
      assertUploadAllowed: queue => assertQueuedUploadAllowed({ scope, store, queue,
        parentOf: async id => (await f.api.get(id))[0]?.parentId }),
      dispatch: async (_row, send) => { finalDispatch = true; scopeReads = 0; return send(); },
      fetch: async () => { requests++; throw new Error('controlled_network_response_lost'); },
    }).drain();
    expect(injected).toBe(true);
    expect(requests, 'unprovable current privacy must prevent the actual fetch').toBe(0);
    const retained = await f.store.getQueueByOpId(scope, original!.opId);
    expect(retained).toMatchObject({ digest: original!.digest, sequence: original!.sequence, payload: original!.payload });
    expect(retained?.status).not.toBe('terminal');
    expect(await f.store.getQueueReceipt(scope, original!.sequence)).toBeNull();
    expect(f.api.node(node.id)).toEqual(native);
    expect(await f.store.getMappingByNativeId(scope, 'root-private')).toBeNull();
  } finally { f.store.close(); }
});
