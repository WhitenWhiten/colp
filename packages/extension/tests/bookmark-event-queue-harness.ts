import type { IDBFactory } from 'fake-indexeddb';
import { createBookmarkEventQueue, type BookmarkEventApi } from '../src/bookmark-event-queue.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

export const scope: SyncScope = Object.freeze({ environment: 'production', serverId: 'server-a',
  serverOrigin: 'https://known.example', accountId: 'account-a', browserProfileId: 'profile-a',
  collectionId: 'collection-a', replicaId: 'replica-a', generation: 1 });

export async function fixture(indexedDB: IDBFactory, options: { mappedNode?: boolean; mappedSubtree?: boolean;
  autoFlush?: boolean; maxRecordBytes?: number; fault?: 'after_sequence' | 'after_queue' | 'after_event' } = {}) {
  const store = createSyncStateStore({ indexedDB, ...(options.maxRecordBytes ? { maxRecordBytes: options.maxRecordBytes } : {}) });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'collection-revision-3', cursor: 'cursor-3' }, selectedRoots: [], rootStatus: 'ready' });
  await store.configureBrowserRoots(scope, { discovered: [
    { nativeId: 'root-selected', ancestorNativeIds: [] },
    { nativeId: 'folder-parent', ancestorNativeIds: ['root-selected'] },
    { nativeId: 'root-private', ancestorNativeIds: [] },
    { nativeId: 'root-unselected', ancestorNativeIds: [] },
  ], selectedNativeIds: ['root-selected'], privateNativeIds: ['root-private'], status: 'ready' });
  const selectedRoot = await store.getMappingByNativeId(scope, 'root-selected');
  await store.putMapping(scope, { nativeId: 'root-selected', colpId: selectedRoot!.colpId,
    rootNativeId: 'root-selected', nodeKind: 'folder',
    projection: { revision: 'server-root-r1', childrenRevision: 'children-server-root-r1',
      digest: 'sha256:server-root-r1', content: { title: 'Selected root' } } });
  await mapping(store, 'folder-parent', 'folder-colp', 'root-selected', 'folder-revision-2', { title: 'Parent' });
  if (options.mappedNode) await mapping(store, 'mapped', 'mapped-colp', 'root-selected', 'server-revision-7',
    { title: 'Server before', url: 'https://example.test/before' });
  if (options.mappedSubtree) {
    await mapping(store, 'folder-parent', 'folder-colp', 'root-selected', 'folder-revision-2', { title: 'Parent' });
    await mapping(store, 'mapped', 'mapped-colp', 'root-selected', 'server-revision-7', { title: 'Child' });
    await mapping(store, 'mapped-separator', 'separator-colp', 'root-selected', 'server-revision-1', {});
  }
  const api = memoryApi();
  // The discovered roots are real folders under Chrome's root node, so an
  // ancestor walk ends at "0" instead of an id Chrome would not know.
  api.put({ id: '0', title: '', type: 'folder' as const, children: [] });
  for (const [index, id] of ['root-selected', 'root-private', 'root-unselected'].entries()) api.put(folder(id, '0', index, id));
  api.put(folder('folder-parent', 'root-selected', 0, 'Parent'));
  const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-07-27T00:00:00Z',
    uuid: deterministicIds(), autoFlush: options.autoFlush ?? false, fault: options.fault });
  return { queue, store, api, indexedDB };
}

export async function mapping(store: ReturnType<typeof createSyncStateStore>, nativeId: string, colpId: string,
  rootNativeId: string, revision: string, content: Record<string, string>, parentNativeId?: string) {
  await store.putMapping(scope, { nativeId, colpId, rootNativeId, ...(parentNativeId ? { parentNativeId } : {}),
    projection: { revision, childrenRevision: `children-${revision}`, digest: `sha256:${revision}`, content } });
}
export function folder(id: string, parentId: string, index: number, title: string, children: any[] = []) {
  return { id, parentId, index, title, type: 'folder' as const, children };
}
export function bookmark(id: string, parentId: string, index: number, title: string, url: string) {
  return { id, parentId, index, title, url, type: 'bookmark' as const };
}
export function separator(id: string, parentId: string, index: number) {
  return { id, parentId, index, title: '', type: 'separator' as const };
}
export function memoryApi(): BookmarkEventApi & { put(node: any): void; node(id: string): any } {
  const nodes = new Map<string, any>();
  return { put(node) { nodes.set(node.id, structuredClone(node)); }, node(id) { return structuredClone(nodes.get(id)); },
    // Chrome rejects an unknown id rather than returning [] (see bookmark-api-error.ts).
    async get(id) { const value = nodes.get(id); if (!value) throw new Error(`Can't find bookmark for id. ${id}`); return [structuredClone(value)]; },
    async getChildren(id) { return [...nodes.values()].filter((node) => node.parentId === id)
      .map((node) => structuredClone(node)); },
  };
}
export function deterministicIds(start = 0) { let value = start; return () => `local-${++value}`; }

export async function confirmQueued(store: ReturnType<typeof createSyncStateStore>, sequence: number,
  targetId: string, revision: string) {
  const row = (await store.listQueue(scope)).find(row => row.sequence === sequence)!;
  await store.completeQueueWithReceipt(scope, sequence, { opId: row.opId, operationDigest: row.digest,
    kind: 'terminal', receiptId: `receipt-${row.opId}`, resultDigest: `sha256:${row.opId}`,
    result: { results: [{ opId: row.opId, sequence, targetId, revision, status: 'applied' }] } });
}
