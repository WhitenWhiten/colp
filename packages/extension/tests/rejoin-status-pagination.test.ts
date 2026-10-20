import 'fake-indexeddb/auto';
import { expect, test, vi } from 'vitest';
import { readUnresolvedConsumedQueueIssues, readUnresolvedQueuePage } from '../src/sync-status-queue.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import type { QueueOperation, SyncScope } from '../src/sync-state-store.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { rejectedOrderFixture, rejectQueueRow } from './rejoin-rejected-harness.js';

installKns05IndexedDb();

test('resolved real rejoin receipts do not hide a later rejected user edit after reopen', async () => {
  const f = await rejectedOrderFixture();
  try {
    await f.compare(); await f.resolve('keep_local_order');
    const originals = await f.getStore().listQueue(scope);
    expect(originals.length).toBeGreaterThanOrEqual(2);
    for (const row of originals) await rejectQueueRow(f.getStore(), row);
    const receipts = await Promise.all(originals.map(row => f.getStore().getQueueReceipt(scope, row.sequence)));
    const attention = () => handleSyncAttentionRequest({ scope: async () => scope, store: f.getStore() });
    expect((await readUnresolvedConsumedQueueIssues(f.getStore(), scope)).map(row => row.opId).sort())
      .toEqual(originals.map(row => row.opId).sort());
    expect(await attention()).toMatchObject({ ok: true, attention: { rejectedPending: true, issueCount: originals.length } });
    await f.refresh(); await f.resolve('keep_remote_order');
    expect(await attention()).toMatchObject({ ok: true, attention: { rejectedPending: false, issueCount: 0 } });
    expect(await readUnresolvedConsumedQueueIssues(f.getStore(), scope)).toEqual([]);

    await f.api.update('native-a', { title: 'A new user edit' });
    const queue = f.queue(); await queue.changed('native-a', { title: 'A new user edit' }); await queue.flush();
    const later = (await f.getStore().listQueue(scope)).find(row => !originals.some(prior => prior.opId === row.opId))!;
    expect(later).toBeDefined(); await rejectQueueRow(f.getStore(), later);
    f.reopen();
    const read = vi.fn(f.getStore().listQueue);
    const live = await readUnresolvedQueuePage({ ...f.getStore(), listQueue: read }, scope, 'terminal', 2);
    expect(live.map(row => row.opId)).toEqual([later.opId]);
    expect(read.mock.calls.some(([, , after]) => (after ?? 0) >= 2)).toBe(true);
    expect(await attention()).toMatchObject({ ok: true, attention: { rejectedPending: true, issueCount: 1 } });
    expect((await readUnresolvedConsumedQueueIssues(f.getStore(), scope)).map(row => row.opId)).toEqual([later.opId]);
    expect(await Promise.all(originals.map(row => f.getStore().getQueueReceipt(scope, row.sequence)))).toEqual(receipts);
  } finally { f.getStore().close(); }
});

test('consumed-issue compatibility reads traverse a full terminal page and exclude accepted history', async () => {
  const accepted = Array.from({ length: 1_000 }, (_, i) => ({ ...row(i + 1, ''), status: 'terminal' as const, recovery: undefined }));
  const refused = { ...row(1_001, 'parent_deleted'), status: 'terminal' as const,
    recovery: { code: 'parent_deleted', resultStatus: 'rejected' } };
  const rows = [...accepted, refused];
  const store = { listQueue: vi.fn(async (_scope: SyncScope, _status?: QueueOperation['status'], after = 0, limit = 1_000) =>
    rows.filter(value => value.sequence > after).slice(0, limit)) };
  expect(await readUnresolvedConsumedQueueIssues(store, scope)).toEqual([refused]);
  expect(store.listQueue.mock.calls.map(([, status, after]) => [status, after])).toEqual([['terminal', 0], ['terminal', 1_000]]);
  expect(await readUnresolvedConsumedQueueIssues({}, scope)).toEqual([]);
  const malformed = { listQueue: async () => Array.from({ length: 1_000 }, () => ({ ...refused, sequence: 0 })) };
  await expect(readUnresolvedConsumedQueueIssues(malformed, scope)).rejects.toThrow('queue_page_cursor_invalid');
});

const row = (sequence: number, code: string): QueueOperation => ({ scopeKey: 'scope', sequence, opId: `op-${sequence}`,
  batchId: `batch-${sequence}`, idempotencyKey: `key-${sequence}`, digest: `sha256:${sequence}`, endpointIdentity: 'syncPush',
  mediaType: 'application/json', baseRevision: 'r0', operationRevision: `local-${sequence}`, status: 'rejected',
  retry: { attempt: 1, notBefore: 0 }, recovery: { code }, payload: {} });

test('legacy settled rows do not exhaust a full raw page when a thin store lacks sidecars', async () => {
  const rows = [row(1, 'recaptured'), row(2, 'target_already_deleted'), row(3, 'resource_id_unavailable')];
  const store = { listQueue: vi.fn(async (_scope: SyncScope, _status?: QueueOperation['status'], after = 0, limit = 1_000) =>
    rows.filter(value => value.sequence > after).slice(0, limit)) };
  expect(await readUnresolvedQueuePage(store, scope, 'rejected', 2)).toEqual([rows[2]]);
  expect(store.listQueue.mock.calls.map(([, , after]) => after)).toEqual([0, 2]);
  expect(await readUnresolvedQueuePage(store, scope, 'rejected', 1)).toEqual([rows[2]]);
});

test('malformed paging fails instead of looping forever or silently reporting idle', async () => {
  const store = { listQueue: vi.fn(async () => [row(0, 'recaptured')]) };
  await expect(readUnresolvedQueuePage(store, scope, 'rejected', 1)).rejects.toThrow('queue_page_cursor_invalid');
  for (const limit of [0, 1_001, 0.5, Number.NaN]) {
    await expect(readUnresolvedQueuePage(store, scope, 'rejected', limit)).rejects.toThrow('queue_page_limit_invalid');
  }
  expect(store.listQueue).toHaveBeenCalledTimes(1);
});
