import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test, vi } from 'vitest';

/**
 * W2A-01: `upgrade_failed` was only ever produced by the injected test fault; a real upgrade that aborted
 * (a full disk, a browser error) surfaced as a transaction that "merely aborted". An open that fails while the
 * version change is running is now named for what it is, and the store reports it as its own state.
 */
vi.mock('../src/sync-state/schema.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/sync-state/schema.js')>(),
  // The browser aborts the version change transaction (what a full disk does to it).
  upgrade: (_db: IDBDatabase, tx: IDBTransaction) => { tx.abort(); },
}));

describe('an upgrade that did not finish', () => {
  test('is upgrade_failed, not a transaction that merely aborted', async () => {
    const { createSyncStateStore } = await import('../src/sync-state-store.js');
    const store = createSyncStateStore({ indexedDB: new IDBFactory() });
    assert.deepEqual(await store.storageState(), { state: 'upgrade_failed', code: 'upgrade_failed' });
  });
});
