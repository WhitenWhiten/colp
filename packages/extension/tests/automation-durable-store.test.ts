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
import type { PendingObservation } from '../src/automation/observed-queue.js';

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

  it('rejects a failed legacy read, leaves those values in place, and migrates them on the next open', async () => {
    const bundle = { version: 1, ownerKey: 'owner' };
    const legacy = new MemoryStorageArea();
    await legacy.set({ [AUTOMATION_BUNDLE_KEY]: bundle });
    let unavailable = true;
    const flaky = { get: async (key: string) => { if (unavailable) throw new Error('legacy_unavailable'); return legacy.get(key); },
      remove: (key: string | string[]) => legacy.remove(key) };
    const database = createAutomationDatabase(factory, { legacy: flaky });
    await expect(database.area().get(AUTOMATION_BUNDLE_KEY)).rejects.toThrow('legacy_unavailable');
    expect(await legacy.get(null)).toEqual({ [AUTOMATION_BUNDLE_KEY]: bundle });
    unavailable = false;
    expect(await database.area().get(AUTOMATION_BUNDLE_KEY)).toEqual(bundle);
    expect(await legacy.get(null)).toEqual({});
  });

  it('keeps legacy values when their removal fails, and removes them once on retry without overwriting newer data', async () => {
    const bundle = { version: 1, ownerKey: 'legacy' };
    const legacy = new MemoryStorageArea();
    await legacy.set({ [AUTOMATION_BUNDLE_KEY]: bundle });
    let removals = 0;
    const flaky = { get: (key: string) => legacy.get(key), remove: async (key: string | string[]) => {
      if (removals++ === 0) throw new Error('quota'); await legacy.remove(key);
    } };
    const database = createAutomationDatabase(factory, { legacy: flaky });
    await expect(database.area().get(AUTOMATION_BUNDLE_KEY)).rejects.toThrow('quota');
    expect(await legacy.get(null)).toEqual({ [AUTOMATION_BUNDLE_KEY]: bundle });
    expect(await database.area().get(AUTOMATION_BUNDLE_KEY)).toEqual(bundle);
    expect(removals).toBe(2);
    expect(await legacy.get(null)).toEqual({});
  });

  it('shares one migration and removes each legacy value once between concurrent opens', async () => {
    const bundle = { version: 1, ownerKey: 'owner' }, receipts = [{ version: 1, localReceiptId: 'r1' }];
    const legacy = new MemoryStorageArea();
    await legacy.set({ [AUTOMATION_BUNDLE_KEY]: bundle, [AUTOMATION_RECEIPTS_KEY]: receipts });
    const reads: string[] = [], removals: string[] = [];
    const slow = {
      get: async (key: string) => { reads.push(key); await new Promise<void>((resolve) => setTimeout(resolve, 5)); return legacy.get(key); },
      remove: async (key: string | string[]) => { removals.push(...(Array.isArray(key) ? key : [key])); await legacy.remove(key); },
    };
    const database = createAutomationDatabase(factory, { legacy: slow });
    const [migrated, observedReceipts, intents] = await Promise.all([database.area().get(AUTOMATION_BUNDLE_KEY),
      database.area().get(AUTOMATION_RECEIPTS_KEY), database.intents.list()]);
    expect([migrated, observedReceipts, intents]).toEqual([bundle, receipts, []]);
    expect(reads.sort()).toEqual([AUTOMATION_BUNDLE_KEY, AUTOMATION_RECEIPTS_KEY].sort());
    expect(removals.sort()).toEqual([AUTOMATION_BUNDLE_KEY, AUTOMATION_RECEIPTS_KEY].sort());
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

const scope = { environment: 'production' as const, serverId: 'server', serverOrigin: 'https://colp.example', accountId: 'owner',
  browserProfileId: 'profile', collectionId: COLLECTION_ID, replicaId: 'replica', generation: 2 };
const observation = (id: string, over: Partial<PendingObservation> = {}): PendingObservation => ({ id, scope, ownerKey: OWNER,
  nativeId: `n-${id}`, title: 'A paper', url: 'https://arxiv.org/abs/1', parentId: '2', dateAdded: NOW, observedAt: NOW,
  state: 'pending', attempts: 0, nextAttemptAt: NOW + 3_000, ...over });

describe('durable observed evaluation and its native boundary', () => {
  it('keeps a claimed evaluation across restart, and atomically hands it to a native intent', async () => {
    const first = createAutomationDatabase(factory);
    await first.observations.save(observation('one'));
    const entry = (await first.observations.claim('one', NOW + 3_000))!;
    first.close();
    const restarted = createAutomationDatabase(factory);
    expect(await restarted.observations.list()).toMatchObject([{ id: 'one', state: 'processing', attempts: 1 }]);
    // A failed intent write must keep the observation, including if the transaction already queued its deletion.
    await expect(restarted.observations.handoff(entry, { ...intent('move'), page: { title: () => undefined, url: 'x' } } as unknown as PlacementIntent)).rejects.toThrow();
    expect(await restarted.observations.list()).toMatchObject([{ id: 'one', state: 'processing' }]);
    expect(await restarted.intents.list()).toEqual([]);
    await restarted.observations.handoff(entry, intent('move'));
    expect(await restarted.observations.list()).toEqual([]);
    expect(await restarted.intents.list()).toMatchObject([{ intentId: 'move', observation: { id: 'one' } }]);
    // A catch after commit cannot resurrect an evaluation and repeat a possibly completed move.
    expect(await restarted.observations.fail('one', { stage: 'intent', code: 'storage_unavailable', retryable: true }, NOW + 3_001)).toBeNull();
    expect(await restarted.observations.claim('one', NOW + 3_001, true)).toBeNull();
    restarted.close();
  });

  it('fences pending work on sign-out while preserving another account’s observations', async () => {
    const database = createAutomationDatabase(factory);
    await database.observations.save(observation('mine'));
    await database.observations.save(observation('theirs', { ownerKey: 'another-owner' }));
    await database.clearAccount(OWNER);
    expect(await database.observations.list()).toMatchObject([{ id: 'theirs' }]);
    await expect(database.observations.handoff(observation('mine', { state: 'processing' }), intent('move'))).rejects.toThrow('observation_context_changed');
    expect(await database.intents.list()).toEqual([]); database.close();
  });

  it('cannot resurrect signed-out work from a late reconciliation or failure callback', async () => {
    const database = createAutomationDatabase(factory);
    await database.observations.save(observation('one'));
    const claimed = (await database.observations.claim('one', NOW + 3_000))!;
    await database.observations.handoff(claimed, intent('move'));
    await database.clearAccount(OWNER);
    expect(await database.observations.abandon('move', { stage: 'move', code: 'move_not_confirmed', retryable: false })).toBe(false);
    expect(await database.intents.defer('move', 'bookmark_unavailable')).toBe(false);
    expect(await database.observations.list()).toEqual([]); expect(await database.intents.list()).toEqual([]);
    database.close();
  });

  it('refuses a full evaluation queue without evicting admitted bookmarks', async () => {
    const database = createAutomationDatabase(factory);
    for (let index = 0; index < 100; index++) await database.observations.save(observation(String(index)));
    await expect(database.observations.save(observation('overflow'))).rejects.toThrow('observation_queue_full');
    expect(await database.observations.list()).toHaveLength(100);
    expect((await database.observations.list()).map(item => item.id)).not.toContain('overflow'); database.close();
  });
});

describe('recovering observed moves after a worker stop', () => {
  it('continues recovering other moves when the first receipt cleanup cannot be persisted', async () => {
    const left = new Map(['flaky', 'healthy'].map(id => [id, intent(id)])), recorded: string[] = [];
    await recoverPlacementIntents({ ownerKey: OWNER, now: NOW + 5_000, list: async () => [...left.values()],
      remove: async id => { if (id === 'flaky') throw new Error('storage_unavailable'); left.delete(id); },
      node: async id => ({ id, parentId: '10', title: 'Paper', url: 'https://arxiv.org/abs/1', dateAdded: NOW }),
      record: async item => { recorded.push(item.intentId); },
      defer: async (item, recoveryProblem) => { left.set(item.intentId, { ...item, recoveryProblem }); } });
    expect(recorded).toEqual(['flaky', 'healthy']);
    expect([...left.values()]).toMatchObject([{ intentId: 'flaky', recoveryProblem: 'receipt_unavailable' }]);
  });
  it('retains unavailable work and still recovers independent moves', async () => {
    const left = new Map(['unavailable', 'healthy'].map(id => [id, intent(id)])), recorded: string[] = [];
    const result = await recoverPlacementIntents({ ownerKey: OWNER, now: NOW + 5_000,
      list: async () => [...left.values()], remove: async id => { left.delete(id); },
      node: async id => { if (id === 'n-unavailable') throw new Error('Temporary API failure'); return node(id, '10'); },
      record: async item => { recorded.push(item.intentId); },
      defer: async (item, recoveryProblem) => { left.set(item.intentId, { ...item, recoveryProblem }); },
    });
    expect(result).toEqual({ recorded: 1, dropped: 0 });
    expect(recorded).toEqual(['healthy']);
    expect([...left.values()]).toMatchObject([{ intentId: 'unavailable', recoveryProblem: 'bookmark_unavailable' }]);
  });

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
