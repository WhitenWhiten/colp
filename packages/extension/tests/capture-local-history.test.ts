import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createCaptureStore } from '../src/capture/store.js';
import { listBrowserCaptureHistory } from '../src/capture/local-history.js';
import { task } from './fixtures/capture.js';

test('this browser includes guest history after sign-in, without exposing another account or reassigning ownership', async () => {
  const store = createCaptureStore(new IDBFactory());
  const scope = { ...task.scope, accountId: 'a' };
  try {
    for (const [id, accountId, createdAt] of [['guest', null, 3], ['own', 'a', 2], ['other', 'b', 4]] as const) {
      await store.claim({ ...task, captureId: id, commandId: id, scope: { ...scope, accountId }, createdAt,
        disposition: 'cancelled', save: 'local-saved', sync: 'local-only' });
    }
    const items = await listBrowserCaptureHistory(store, scope);
    expect(items.map(item => item.captureId)).toEqual(['guest', 'own']);
    expect(items[0]?.historyReadOnly).toBe(true);
    expect(items[0]?.scope.accountId).toBeNull();
    expect(items[1]?.historyReadOnly).toBeUndefined();
    const guestScope = { ...scope, accountId: null };
    expect((await store.getForOwner(guestScope, 'guest'))?.scope.accountId).toBeNull();
    expect((await listBrowserCaptureHistory(store, guestScope)).map(item => item.captureId)).toEqual(['guest']);
  } finally { await store.close(); }
});

test('merging two owner histories preserves a bounded, complete timeline across pages', async () => {
  const store = createCaptureStore(new IDBFactory());
  const scope = { ...task.scope, accountId: 'a' };
  try {
    for (let i = 0; i < 110; i++) await store.claim({ ...task, captureId: String(i).padStart(3, '0'), commandId: String(i),
      scope: { ...scope, accountId: i % 2 ? 'a' : null }, createdAt: i, disposition: 'cancelled', save: 'local-saved', sync: 'local-only' });
    const ids: string[] = []; let before: readonly [number, string] | undefined;
    for (;;) {
      const page = await listBrowserCaptureHistory(store, scope, before); ids.push(...page.map(item => item.captureId));
      const last = page.at(-1); if (!last || page.length < 50) break; before = [last.createdAt, last.captureId];
    }
    expect(ids).toHaveLength(110); expect(new Set(ids).size).toBe(110);
    expect(ids[0]).toBe('109'); expect(ids.at(-1)).toBe('000');
  } finally { await store.close(); }
});
