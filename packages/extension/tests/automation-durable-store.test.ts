import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutomationDatabase, type PlacementIntent } from '../src/automation/indexeddb-store.js';
import { AUTOMATION_BUNDLE_KEY, AUTOMATION_RECEIPTS_KEY } from '../src/automation/messages.js';
import type { NativeBookmark } from '../src/automation/observed-create.js';
import { RECEIPT_MAX_AGE_MS } from '../src/automation/receipt-sync.js';
import { recoverPlacementIntents } from '../src/automation/recovery.js';
import type { AccountAutomation } from '../src/capture/contracts.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { COLLECTION_ID, NOW, folderRef } from './automation-fixture.js';

/**
 * The automation store outlives the worker and the browser (AC-10): the bundle,
 * the receipts and the write-ahead intents of observed moves.
 */
let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); });

describe('the automation database', () => {
  it('keeps the bundle, the receipts and the intents across a restart', async () => {
    const first = createAutomationDatabase(factory);
    await first.area().set(AUTOMATION_BUNDLE_KEY, { version: 1, ownerKey: 'owner' });
    await first.area().set(AUTOMATION_RECEIPTS_KEY, [{ version: 1, localReceiptId: 'r1' }]);
    await first.intents.put(intent('i1'));
    first.close();
    const restarted = createAutomationDatabase(factory);
    expect(await restarted.area().get(AUTOMATION_BUNDLE_KEY)).toEqual({ version: 1, ownerKey: 'owner' });
    expect(await restarted.area().get(AUTOMATION_RECEIPTS_KEY)).toEqual([{ version: 1, localReceiptId: 'r1' }]);
    expect((await restarted.intents.list()).map((item) => item.intentId)).toEqual(['i1']);
    await restarted.intents.remove('i1');
    expect(await restarted.intents.list()).toEqual([]);
  });

  it('moves values an earlier build kept in chrome.storage.local, once', async () => {
    const legacy = new MemoryStorageArea();
    await legacy.set({ [AUTOMATION_BUNDLE_KEY]: { version: 1, ownerKey: 'owner' }, [AUTOMATION_RECEIPTS_KEY]: [{ version: 1, localReceiptId: 'r1' }],
      'known.unrelated': true });
    const database = createAutomationDatabase(factory, { legacy });
    expect(await database.area().get(AUTOMATION_RECEIPTS_KEY)).toEqual([{ version: 1, localReceiptId: 'r1' }]);
    expect(await database.area().get(AUTOMATION_BUNDLE_KEY)).toEqual({ version: 1, ownerKey: 'owner' });
    expect(await legacy.get(null)).toEqual({ 'known.unrelated': true });
  });

  it('never lets an older copy overwrite what the database already holds', async () => {
    await createAutomationDatabase(factory).area().set(AUTOMATION_RECEIPTS_KEY, [{ version: 1, localReceiptId: 'newer' }]);
    const legacy = new MemoryStorageArea();
    await legacy.set({ [AUTOMATION_RECEIPTS_KEY]: [{ version: 1, localReceiptId: 'older' }], [AUTOMATION_BUNDLE_KEY]: { version: 1, ownerKey: 'owner' } });
    const database = createAutomationDatabase(factory, { legacy });
    expect(await database.area().get(AUTOMATION_RECEIPTS_KEY)).toEqual([{ version: 1, localReceiptId: 'newer' }]);
    expect(await database.area().get(AUTOMATION_BUNDLE_KEY)).toEqual({ version: 1, ownerKey: 'owner' });
    expect(await legacy.get(null)).toEqual({});
  });

  it('opens even when the old values cannot be moved, and tries again next time', async () => {
    const legacy = new MemoryStorageArea();
    await legacy.set({ [AUTOMATION_BUNDLE_KEY]: { version: 1, ownerKey: 'owner' } });
    const stuck = { get: (key: string) => legacy.get(key), remove: async () => { throw new Error('quota'); } };
    expect(await createAutomationDatabase(factory, { legacy: stuck }).area().get(AUTOMATION_BUNDLE_KEY)).toEqual({ version: 1, ownerKey: 'owner' });
    await createAutomationDatabase(factory, { legacy }).area().get(AUTOMATION_BUNDLE_KEY);
    expect(await legacy.get(null)).toEqual({});
  });

  it('tells pages about each change, since IndexedDB has no change events', async () => {
    const changed = vi.fn(async () => undefined);
    const database = createAutomationDatabase(factory, { changed });
    await database.area().get(AUTOMATION_BUNDLE_KEY);
    expect(changed).not.toHaveBeenCalled();
    await database.area().set(AUTOMATION_BUNDLE_KEY, { version: 1 });
    expect(changed).toHaveBeenCalledOnce();
  });

  it('writes and deletes several keys in one transaction, and says so once', async () => {
    const changed = vi.fn(async () => undefined);
    const area = createAutomationDatabase(factory, { changed }).area();
    await area.set('old', { version: 1 });
    await area.commit({ new: { version: 2 }, other: [1] }, ['old']);
    expect([await area.get('old'), await area.get('new'), await area.get('other')]).toEqual([undefined, { version: 2 }, [1]]);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

const OWNER = '["https://colp.example","owner"]';
const automation: AccountAutomation = { outcome: 'placed', ruleIds: ['rule-arxiv'], bundleRevision: 'b-1', settingsRevision: 1, satisfies: ['classify.root'],
  rule: { id: 'rule-arxiv', name: 'arXiv papers', revision: '1', bindingRevision: '1', semanticDigest: 'd' }, destination: folderRef('academic'),
  folderTitle: 'Academic', fromNativeId: '2', collectionId: COLLECTION_ID, replicaId: 'replica-1', generation: 2 };
function intent(intentId: string, over: Partial<PlacementIntent> = {}): PlacementIntent {
  return { intentId, id: intentId, ownerKey: OWNER, fromParentId: '2', dateAdded: NOW, createdAt: NOW, automation,
    page: { title: 'A paper', url: 'https://arxiv.org/abs/1' }, native: { nativeId: `n-${intentId}`, destinationNativeId: '10', movedAt: NOW }, ...over };
}

describe('recovering observed moves after a worker stop', () => {
  async function recover(intents: PlacementIntent[], tree: Record<string, NativeBookmark>, over: { ownerKey?: string | null; now?: number } = {}) {
    const left = new Map(intents.map((item) => [item.intentId, item])), recorded: string[] = [];
    const result = await recoverPlacementIntents({ ownerKey: OWNER, now: NOW + 5_000, ...over,
      list: async () => [...left.values()], remove: async (id) => { left.delete(id); },
      node: async (id) => tree[id] ?? null, record: async (item) => { recorded.push(item.intentId); } });
    return { result, recorded, left: [...left.keys()] };
  }
  const node = (id: string, parentId: string, dateAdded = NOW): NativeBookmark => ({ id, parentId, title: 'A paper', url: 'https://arxiv.org/abs/1', dateAdded });

  it('receipts a move that happened, and never makes one that did not', async () => {
    const run = await recover([intent('moved'), intent('stayed')], { 'n-moved': node('n-moved', '10'), 'n-stayed': node('n-stayed', '2') });
    expect(run).toEqual({ result: { recorded: 1, dropped: 1 }, recorded: ['moved'], left: [] });
  });

  it('leaves a removed, reused or since-moved bookmark alone', async () => {
    const run = await recover([intent('gone'), intent('reused'), intent('elsewhere')],
      { 'n-reused': node('n-reused', '10', NOW + 1), 'n-elsewhere': node('n-elsewhere', '20') });
    expect(run).toEqual({ result: { recorded: 0, dropped: 3 }, recorded: [], left: [] });
  });

  it('keeps another account’s intents for that account, until they expire', async () => {
    const theirs = intent('theirs', { ownerKey: '["https://colp.example","someone-else"]' });
    expect((await recover([theirs], { 'n-theirs': node('n-theirs', '10') })).left).toEqual(['theirs']);
    expect((await recover([theirs], {}, { ownerKey: null })).left).toEqual(['theirs']);
    const late = await recover([theirs], { 'n-theirs': node('n-theirs', '10') }, { now: NOW + RECEIPT_MAX_AGE_MS + 1 });
    expect(late).toEqual({ result: { recorded: 0, dropped: 1 }, recorded: [], left: [] });
  });
});
