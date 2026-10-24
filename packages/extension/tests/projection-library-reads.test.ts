/**
 * B-16 (Snapshot projection): `executeProjectionIntents` listed every mapping and every projection intent again for each
 * create (the occupancy map), and the check after Chrome's answer listed the projection intents once more, so projecting a
 * Snapshot of N bookmarks read O(N^2) rows. The claims of the whole library are now read only for a create that meets an
 * equal bookmark or a recorded answer, and the open intents' claims are held in memory for the run.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { recordedProjectionCreate } from '../src/projection-create-receipt.js';
import {
  createIdentityNeedsOccupancy, occupancyByNative, resolveCreateIdentity,
} from '../src/projection-native-occupancy.js';
import { projectVirtualSnapshotChildren } from '../src/recovery-projection-executor.js';
import { createProjectionSuppression, type ProjectionIntentRecord } from '../src/recovery-overlay.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { fakeChrome } from './recovery-projection-chrome-fixture.js';

const scope: SyncScope = {
  environment: 'development', serverId: 'server-plr', serverOrigin: 'https://known.example',
  accountId: 'account-plr', browserProfileId: 'profile-plr', collectionId: 'collection-plr',
  replicaId: 'replica-plr', generation: 1,
};
const parent: MappingInput = { nativeId: '1', colpId: 'folder-colp', rootNativeId: '1', nodeKind: 'folder',
  projection: { revision: 'r1', digest: 'd-parent', content: { title: 'Parent' } } };
const node = (colpId: string, title = colpId): MappingInput => ({ nativeId: `recovery:${colpId}`, colpId, rootNativeId: '1',
  nodeKind: 'bookmark', parentColpId: 'folder-colp',
  projection: { revision: 'r2', digest: `sha256:${colpId}`, content: { title, url: `https://example.test/${colpId}` } } });

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

async function ready(seed: Parameters<typeof fakeChrome>[0] = [{ id: '1', title: 'Parent' }]) {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-plr', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: ['folder-colp'], rootStatus: 'ready' });
  await store.putMapping(scope, parent);
  return { store, chrome: fakeChrome(seed) };
}

const WHOLE_LIBRARY_READS = ['listMappings', 'listProjectionIntents', 'listApplyIntents'];
function counting(store: Awaited<ReturnType<typeof ready>>['store']) {
  const calls: Record<string, number> = {};
  const wrapped = Object.fromEntries(Object.entries(store).map(([name, value]) => {
    if (typeof value !== 'function' || !WHOLE_LIBRARY_READS.includes(name)) return [name, value];
    return [name, (...args: unknown[]) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return (value as (...rest: unknown[]) => unknown).apply(store, args);
    }];
  })) as unknown as typeof store;
  return { wrapped, calls };
}

describe('projecting a Snapshot', () => {
  test('lists the library the same number of times for 6 bookmarks as for 30', async () => {
    const measured: Record<string, number>[] = [];
    for (const count of [6, 30]) {
      indexedDB = new IDBFactory();
      const { store, chrome } = await ready();
      const reads = counting(store);
      const bound = [parent, ...Array.from({ length: count }, (_, index) => node(`b${index}`))];
      await projectVirtualSnapshotChildren({ scope, store: reads.wrapped, api: chrome.api, bound });
      assert.equal(chrome.creates, count, 'every bookmark was created');
      assert.equal((await store.listProjectionIntents(scope)).filter((intent) => intent.state === 'terminal').length, count);
      measured.push(reads.calls);
      store.close();
    }
    assert.deepEqual(measured[1], measured[0], `reads of the whole library per run: ${JSON.stringify(measured)}`);
  });

  test('an equal bookmark that another node owns is still not adopted (the claims are read for it)', async () => {
    const { store, chrome } = await ready([{ id: '1', title: 'Parent' },
      { id: '7', parentId: '1', index: 0, title: 'twin', url: 'https://example.test/a' }]);
    await store.putMapping(scope, { ...node('owner', 'twin'), nativeId: '7', parentNativeId: '1',
      projection: { revision: 'r1', digest: 'sha256:owner', content: { title: 'twin', url: 'https://example.test/a' } } });
    await projectVirtualSnapshotChildren({ scope, store, api: chrome.api,
      bound: [parent, { ...node('a', 'twin'), projection: { revision: 'r2', digest: 'sha256:a', content: { title: 'twin', url: 'https://example.test/a' } } }] });
    assert.equal(chrome.creates, 1, 'a is created beside the twin');
    assert.notEqual((await store.getMappingByColpId(scope, 'a'))?.nativeId, '7');
    assert.equal((await store.getMappingByNativeId(scope, '7'))?.colpId, 'owner');
    store.close();
  });

  test('a browser id that an open intent of another node already observed is not claimed by a create that Chrome answers with it', async () => {
    // Chrome's next id is 5, and the open (ambiguous) intent of node c observed 5 before: b's create must not take it.
    const { store, chrome } = await ready([{ id: '1', title: 'Parent' }, { id: '4', parentId: '99', title: 'elsewhere' }]);
    const intent = (colpId: string, order: number, extra: Partial<ProjectionIntentRecord>): ProjectionIntentRecord => ({
      intentId: `create:${colpId}`, kind: 'create', colpId, order, generation: 1,
      suppression: createProjectionSuppression('1', colpId, `https://example.test/${colpId}`), parentColpId: 'folder-colp',
      parentNativeId: '1', title: colpId, url: `https://example.test/${colpId}`, folder: false, state: 'pending', ...extra });
    await store.replaceProjectionIntents(scope, [intent('b', 1, {}), intent('c', 2, { state: 'ambiguous', observedNativeId: '5' })]);
    const { executeProjectionIntents } = await import('../src/recovery-projection-executor.js');
    await executeProjectionIntents({ scope, store, api: chrome.api, selectedRootNativeId: '1', seedMappings: [parent, node('b'), node('c')] });
    assert.equal(chrome.creates, 1);
    assert.match((await store.getMappingByColpId(scope, 'b'))?.nativeId ?? 'recovery:none', /^recovery:/u, 'b did not take 5');
    assert.equal((await store.listProjectionIntents(scope)).find((row) => row.colpId === 'b')?.state, 'ambiguous');
    store.close();
  });
});

describe('when a create needs the claims of the whole library', () => {
  const intent = (extra: Partial<ProjectionIntentRecord> = {}) => ({ colpId: 'x', title: 'Same', url: 'https://example.test/same', ...extra });
  const child = (id: string, title: string, url?: string) => ({ id, title, ...(url ? { url } : {}) });

  test('only with an observed browser id or an equal-content child', () => {
    assert.equal(createIdentityNeedsOccupancy(intent(), [child('1', 'Other', 'https://example.test/other')]), false);
    assert.equal(createIdentityNeedsOccupancy(intent(), []), false);
    assert.equal(createIdentityNeedsOccupancy(intent({ observedNativeId: 'recovery:x' }), []), false);
    assert.equal(createIdentityNeedsOccupancy(intent({ observedNativeId: '9' }), []), true);
    assert.equal(createIdentityNeedsOccupancy(intent(), [child('2', 'Same', 'https://example.test/same')]), true);
  });

  test('when it says no, no map of claims can change what resolveCreateIdentity answers', () => {
    const hostile = occupancyByNative({ liveMappings: ['1', '2', '3'].map((nativeId) => ({
      nativeId, colpId: `other-${nativeId}`, rootNativeId: '1', nodeKind: 'bookmark' as const,
      projection: { revision: 'r', digest: 'd' } })) });
    const cases = [
      { intent: intent(), children: [child('1', 'Other', 'https://example.test/other'), child('2', 'Another')] },
      { intent: intent(), children: [] },
      { intent: intent({ observedNativeId: 'recovery:x' }), children: [child('3', 'Else')] },
    ];
    for (const { intent: item, children } of cases) {
      assert.equal(createIdentityNeedsOccupancy(item, children), false);
      const empty = resolveCreateIdentity({ intent: item, children, occupancy: new Map() });
      assert.deepEqual(resolveCreateIdentity({ intent: item, children, occupancy: hostile }), empty);
      assert.deepEqual(empty, { action: 'create' });
    }
  });

  test('a recorded answer reads the claims only when it names a bookmark that is still there', async () => {
    let loads = 0;
    const loader = async () => { loads += 1; return new Map<string, string>(); };
    const receipt = (nativeId: string) => ({ getApplyIntent: async () => ({ apiResultEvidence: { nativeId } }) as never });
    assert.equal(await recordedProjectionCreate({ getApplyIntent: async () => null }, scope, 'i', [{ id: '9' }], loader, 'x'), undefined);
    assert.equal(await recordedProjectionCreate(receipt('8'), scope, 'i', [{ id: '9' }], loader, 'x'), undefined);
    assert.equal(loads, 0, 'no receipt, or a receipt for a bookmark that is gone, reads nothing');
    assert.equal(await recordedProjectionCreate(receipt('9'), scope, 'i', [{ id: '9' }], loader, 'x'), '9');
    assert.equal(loads, 1);
  });
});
