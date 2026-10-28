import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { localSourceProgress } from '../src/site-adapters/local-progress.js';
import { managedLibraryKey } from '../src/site-adapters/copy-identity.js';
import { localTransferKey } from '../src/site-adapters/local-identity.js';
test('source confirmation, native work and association failures remain distinct from ordinary sync idleness', async () => {
  const db = createSourceDatabase(new IDBFactory()), owner = { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' };
  try {
    await db.transaction(['authorities', 'meta', 'work', 'transfers', 'observations'], 'readwrite', async tx => {
      tx.objectStore('authorities').put({ enabled: true, connectionId: 'source', installationId: 'bundled.bilibili' }, 'bundled.bilibili');
      tx.objectStore('meta').put({ enabled: true, liveArchive: true }, 'policy:source');
      tx.objectStore('meta').put(['hint'], 'confirmationQueue:v1');
      tx.objectStore('observations').put({ state: 'pending', context: { connectionId: 'source' } }, 'accepted');
      tx.objectStore('work').put({ id: 'plan', connectionId: 'source', dueAt: 0 }, 'plan');
      tx.objectStore('transfers').put({ commandId: 'pending', connectionId: 'source', ownerKey: managedLibraryKey(owner), state: 'pending', dueAt: 0 }, 'pending');
      tx.objectStore('transfers').put({ commandId: 'attention', connectionId: 'source', ownerKey: managedLibraryKey(owner), state: 'attention', dueAt: Number.MAX_SAFE_INTEGER }, 'attention');
      tx.objectStore('transfers').put({ commandId: 'foreign', connectionId: 'other', ownerKey: managedLibraryKey({ ...owner, accountId: 'other' }), state: 'pending', dueAt: 0 }, 'foreign');
      tx.objectStore('meta').put({ at: 123, commandId: 'pending' }, 'localPipelineLast:source');
      tx.objectStore('meta').put({ associatedAt: 456 }, localTransferKey('pending'));
    });
    expect(await localSourceProgress(db, 'source')).toMatchObject({ available: true, pendingConfirmation: 1, pendingLocal: 2, pendingSync: 1, attention: 1, lastSavedAt: 123, associatedAt: 456 });
    expect(await localSourceProgress(db, undefined, owner)).toMatchObject({ pendingSync: 1, attention: 1 });
    expect(await localSourceProgress(db, 'other')).toMatchObject({ pendingLocal: 0, pendingSync: 1, attention: 0 });
  } finally { await db.close(); }
});
test('an unreadable source store reports unknown progress rather than an idle success', async () => {
  const db = { transaction: async () => { throw Error('unavailable'); } } as unknown as ReturnType<typeof createSourceDatabase>;
  expect(await localSourceProgress(db)).toMatchObject({ available: false });
});
