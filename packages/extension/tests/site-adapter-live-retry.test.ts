import { retrySourceObservations } from '../src/site-adapters/local-source-problems.js';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { createLiveSourcePlanner } from '../src/site-adapters/live-planner.js';
import { legacySite } from '../src/site-adapters/registry.js';
import { deliverMembershipHint } from '../src/site-adapters/hint-delivery.js';
import type { AdapterContext } from '../src/site-adapters/contracts.js';
test('transient planning failure remains recoverable and does not hide another ready observation', async () => {
  const db = createSourceDatabase(new IDBFactory()), context = { connectionId: 'source', installationGeneration: 1, sourceSessionGeneration: 1 };
  try {
    await db.transaction(['authorities', 'meta', 'observations'], 'readwrite', async tx => {
      tx.objectStore('authorities').put({ enabled: true, ...context }, legacySite.adapterId);
      tx.objectStore('meta').put({ enabled: true, liveArchive: true }, 'policy:source');
      for (let i = 0; i < 21; i++) tx.objectStore('observations').put({ id: String(i), installationId: legacySite.adapterId, ordinal: i + 1, readyAt: 0,
        context, state: 'pending', observation: { type: 'membership.observed', item: { id: String(i) }, memberships: { mode: 'delta', added: ['101'], removed: [] } } }, String(i));
    });
    let online = false;
    const plan = vi.fn(async ({ itemId }: { itemId: string }) => { if (!online && itemId !== '20') throw Error('sourceSyncPending'); return { status: 'noMatch' as const }; });
    const alarm = vi.fn(), planner = createLiveSourcePlanner(db, { plan } as never, alarm);
    await planner.wake(); await planner.wake();
    expect(await db.read('observations', '0')).toMatchObject({ state: 'pending', retryReason: 'sourceSyncPending' });
    expect(await db.read('observations', '20')).toMatchObject({ state: 'settled' });
    online = true;
    await db.transaction(['observations'], 'readwrite', async tx => { const r = tx.objectStore('observations').get('0'); r.onsuccess = () => tx.objectStore('observations').put({ ...r.result, readyAt: 0 }, '0'); });
    await planner.wake(); expect(await db.read('observations', '0')).toMatchObject({ state: 'settled', planning: { reason: 'noMatch' } });
    await db.transaction(['observations'], 'readwrite', async tx => { const r = tx.objectStore('observations').get('1'); r.onsuccess = () => tx.objectStore('observations').put({ ...r.result, readyAt: 0 }, '1'); });
    plan.mockRejectedValueOnce(Error('sourceFactsUnresolved')); await planner.wake();
    expect(await db.read('work', 'observation:1')).toMatchObject({ dueAt: Number.MAX_SAFE_INTEGER, reason: 'sourceFactsUnresolved' });
    await retrySourceObservations(db, 'source');
    expect(await db.read('work', 'observation:1')).toBeUndefined();
    await planner.wake(); expect(await db.read('observations', '1')).toMatchObject({ state: 'settled', planning: { reason: 'noMatch' } });
  } finally { await db.close(); }
});
test('hint admission retries the original interaction and respects pause and deadline', async () => {
  const hint = { interactionId: 'interaction', itemId: 'video:av:1', added: ['101'], removed: [], code: 0 };
  const send = vi.fn().mockResolvedValueOnce({ status: 'rejected', reason: 'capacity' }).mockResolvedValue({ status: 'accepted', receiptId: 'receipt' });
  const sleep = vi.fn(async () => {}), context = { hint: send, signal: new AbortController().signal, deadlineAt: 10000 } as unknown as AdapterContext;
  expect(await deliverMembershipHint(context, hint, sleep, () => 0)).toMatchObject({ status: 'accepted' });
  expect(send).toHaveBeenNthCalledWith(2, hint); expect(sleep).toHaveBeenCalledOnce();
  send.mockReset().mockResolvedValue({ status: 'rejected', reason: 'paused' });
  expect(await deliverMembershipHint(context, hint, sleep, () => 0)).toMatchObject({ reason: 'paused' }); expect(send).toHaveBeenCalledOnce();
});
