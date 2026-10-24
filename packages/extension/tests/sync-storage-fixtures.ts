import type { IDBFactory } from 'fake-indexeddb';
import { DATABASE_NAME, type SyncScope } from '../src/sync-state-store.js';

/** Shared by the W2A-01 tests: an account/replica identity and databases in the states the store cannot use. */
export const storageScope: SyncScope = { environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a', replicaId: 'replica-a', generation: 1 };

/**
 * Creates the sync database at `version` with `rows` in the upload queue and nothing else (no indexes, no other
 * store): for a newer version this is "written by a newer extension"; at the current version it is a database
 * with missing stores.
 */
export async function seedDatabase(factory: IDBFactory, version: number, rows: readonly Record<string, unknown>[] = [],
  stores: readonly string[] = ['outbound_queue']) {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, version);
    request.onupgradeneeded = () => {
      for (const name of stores) {
        const store = request.result.createObjectStore(name, { keyPath: ['scopeKey', 'sequence'] });
        if (name === 'outbound_queue') for (const row of rows) store.put(row);
      }
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
}

/** A factory whose database cannot be opened: the browser's storage failed with this exception. */
export function failingFactory(name: string): IDBFactory {
  return { open: () => { throw new DOMException('Internal error opening backing store for indexedDB.open.', name); } } as unknown as IDBFactory;
}

/** The names of the databases the factory holds. */
export async function databaseNames(factory: IDBFactory): Promise<string[]> {
  return (await factory.databases()).map(info => info.name ?? '');
}
