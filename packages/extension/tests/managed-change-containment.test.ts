import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { managedLibraryKey } from '../src/site-adapters/copy-identity.js';
import { markManagedChange, managedSlotKey, type ManagedSlot } from '../../server/src/modules/source-archives/managed-copies.js';
const f = vi.hoisted(() => ({ db: undefined as unknown as ReturnType<typeof createSourceDatabase>, calls: [] as string[],
  temporary: false, adoptions: [] as string[], scope: { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' } }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { get db() { return f.db; } }, SITE_RECOVERY_ALARM: 'site' }));
vi.mock('../src/site-adapters/wake-scheduler.js', () => ({ scheduleSourceAlarm: vi.fn() }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => f.scope, assertCaptureOwner: async () => {} }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => f.scope }));
vi.mock('../src/sw/runtime.js', () => ({ syncState: { getMappingByNativeId: async () => ({ parentColpId: 'to', projection: { revision: '1' } }) } }));
vi.mock('../src/site-adapters/semantic-associations.js', () => ({ adoptSemanticAssociation: async (binding: { id: string }) => { f.adoptions.push(binding.id); if (binding.id === 'bad-adoption') throw new Error('source_copy_adoption_conflict'); } }));
vi.mock('../src/site-adapters/managed-runtime.js', () => ({ managedClientForLibrary: async () => ({ call: async (operation: string, input: { slot: ManagedSlot; nodeId: string; expected?: { nodeId: string } }) => {
  if (operation === 'managed.relocate') { f.calls.push(input.expected!.nodeId); if (input.expected!.nodeId === 'bad-relocation') throw new Error('source_copy_adoption_conflict'); return {}; }
  f.calls.push(input.nodeId);
  if (input.nodeId === 'temporary' && f.temporary) throw new Error('offline');
  const state = { bindings: { [managedSlotKey('library', input.slot)]: { collectionId: 'library', slot: input.slot, state: 'active' as const,
    node: { nodeId: input.nodeId === 'old-node' ? 'replacement-node' : input.nodeId, parentId: 'parent', title: 'Saved', url: null, revision: '1' } } }, receipts: {} };
  return markManagedChange(state, 'library', input.slot, input.nodeId, 'suppressed');
} }) }));
import { flushManagedChanges } from '../src/site-adapters/managed-change-runtime.js';
test('an invalid association is isolated while independent notifications continue', async () => {
  f.db = createSourceDatabase(new IDBFactory()); f.calls = [];
  try {
    await f.db.transaction(['meta'], 'readwrite', async tx => {
      for (const [key, nodeId] of [['a', 'old-node'], ['b', 'healthy-node']]) {
        const slot = { kind: 'folder', source: { site: 'fixture', identityVersion: 1, sourceAccount: 'user', sourceCollectionId: key } };
        tx.objectStore('meta').put({ reference: { library: f.scope, slot, nodeId }, state: 'suppressed' }, `managedManual:${managedLibraryKey(f.scope)}:${key}`);
      }
    });
    await flushManagedChanges();
    await flushManagedChanges();
    expect(f.calls).toEqual(['old-node', 'healthy-node']);
    expect(await f.db.read('meta', `managedManual:${managedLibraryKey(f.scope)}:b`)).toBeUndefined();
    const diagnostics = await f.db.transaction(['meta'], 'readonly', tx => new Promise<unknown[]>(resolve => { const req = tx.objectStore('meta').getAll(); req.onsuccess = () => resolve(req.result); }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ state: 'attention', reason: 'source_copy_adoption_conflict', value: expect.objectContaining({ reference: expect.objectContaining({ nodeId: 'old-node' }) }) }));
  } finally { await f.db.close(); }
});

test('transient failures remain scheduled while pages advance and retry after a restart', async () => {
  f.db = createSourceDatabase(new IDBFactory()); f.calls = []; f.temporary = true;
  const owner = managedLibraryKey(f.scope);
  try {
    await f.db.transaction(['meta'], 'readwrite', async tx => {
      for (let i = 0; i < 25; i++) {
        const nodeId = i === 0 ? 'temporary' : `node-${i}`;
        const slot = { kind: 'folder', source: { site: 'fixture', identityVersion: 1, sourceAccount: 'user', sourceCollectionId: `${i}` } };
        tx.objectStore('meta').put({ reference: { library: f.scope, slot, nodeId }, state: 'suppressed' }, `managedManual:${owner}:${String(i).padStart(2, '0')}`);
      }
    });
    await flushManagedChanges();
    expect(await f.db.read('meta', `managedManual:${owner}:00`)).toBeDefined();
    await flushManagedChanges();
    expect(f.calls).toContain('node-24');
    f.temporary = false;
    vi.resetModules();
    const restarted = await import('../src/site-adapters/managed-change-runtime.js');
    await restarted.flushManagedChanges();
    expect(await f.db.read('meta', `managedManual:${owner}:00`)).toBeUndefined();
    expect(f.calls.filter(id => id === 'temporary')).toHaveLength(2);
  } finally { f.temporary = false; await f.db.close(); }
});

test('relocation and adoption conflicts do not block independent entries', async () => {
  f.db = createSourceDatabase(new IDBFactory()); f.calls = []; f.adoptions = [];
  vi.stubGlobal('chrome', { bookmarks: { get: async (id: string) => [{ id, dateAdded: 10, title: 'Saved', url: 'https://example.test', parentId: 'native-parent' }] } });
  const owner = managedLibraryKey(f.scope);
  try {
    await f.db.transaction(['meta', 'contentBindings'], 'readwrite', async tx => {
      for (const id of ['bad-relocation', 'good-relocation']) {
        tx.objectStore('meta').put({ reference: { library: f.scope, slot: {} }, native: { nativeId: id, dateAdded: 10 }, nativeParent: 'native-parent',
          expected: { nodeId: id, from: 'from', to: 'to', title: 'Saved', url: 'https://example.test' } }, `managedRelocate:${owner}:${id}`);
      }
      for (const id of ['bad-adoption', 'good-adoption']) {
        tx.objectStore('contentBindings').put({ id, state: 'active' }, id);
        tx.objectStore('meta').put({ bindingKey: id, scope: f.scope }, `semanticAdoptPending:${owner}:${id}`);
      }
    });
    await flushManagedChanges();
    expect(f.calls).toEqual(['bad-relocation', 'good-relocation']);
    expect(f.adoptions).toEqual(['bad-adoption', 'good-adoption']);
    expect(await f.db.read('meta', `managedRelocate:${owner}:good-relocation`)).toBeUndefined();
    expect(await f.db.read('meta', `semanticAdoptPending:${owner}:good-adoption`)).toBeUndefined();
    const diagnostics = await f.db.transaction(['meta'], 'readonly', tx => new Promise<unknown[]>(resolve => { const req = tx.objectStore('meta').getAll(); req.onsuccess = () => resolve(req.result); }));
    expect(diagnostics.filter(value => (value as { state?: string }).state === 'attention')).toHaveLength(2);
  } finally { vi.unstubAllGlobals(); await f.db.close(); }
});
