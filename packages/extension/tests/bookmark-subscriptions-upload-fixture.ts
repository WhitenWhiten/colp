import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncStateStore, type BookmarkEventRecord, type QueueOperation, type SyncScope } from '../src/sync-state-store.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { STORES } from '../src/sync-state/schema.js';

export const personalScope: SyncScope = {
  environment: 'production', serverId: 'server', serverOrigin: 'https://known.test',
  accountId: 'personal-account', browserProfileId: 'profile', collectionId: 'personal',
  replicaId: 'replica', generation: 1,
};
export function outgoing(opId = 'outgoing'): QueueOperation {
  return { scopeKey: scopeKey(personalScope), sequence: 1, opId, batchId: opId, idempotencyKey: opId,
    digest: 'sha256:' + opId, endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: null, operationRevision: 'local-' + opId, status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node_content', targetId: 'lost-mapping-' + opId } };
}
export function event(ordinal: number, overrides: Partial<BookmarkEventRecord> = {}): BookmarkEventRecord {
  return { scopeKey: scopeKey(personalScope), ordinal, eventId: 'event-' + ordinal, dedupeKey: 'dedupe-' + ordinal,
    occurredAt: '2026-09-25T00:00:00Z', kind: 'change', nativeId: 'native-' + ordinal,
    details: {}, status: 'processed', opId: 'op-' + ordinal, ...overrides };
}
export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });
}
export async function seedEvents(db: IDBDatabase, events: BookmarkEventRecord[]) {
  const tx = db.transaction(STORES.bookmarkEvents, 'readwrite');
  const done = committed(tx);
  for (const item of events) tx.objectStore(STORES.bookmarkEvents).put(item);
  await done;
}
export async function personalStore(indexedDB = new IDBFactory()) {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...personalScope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 100 }, checkpoint: null, selectedRoots: [] });
  return store;
}
