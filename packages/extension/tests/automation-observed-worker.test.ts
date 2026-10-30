import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createBundleStore } from '../src/automation/bundle-store.js';
import { automationsPaused, createPauseStatusStore } from '../src/automation/pause-status.js';
import { automationDatabase } from '../src/automation/indexeddb-store.js';
import { COLLECTION_ID, NOW, compiledRule, folderRef, ruleBundle } from './automation-fixture.js';

/**
 * The worker side of star-button creations: noted in session storage, judged
 * once after the settle window, with causation read from Sync and import state.
 */
const f = vi.hoisted(() => ({
  scope: { environment: 'production', serverId: 'https://colp.example', serverOrigin: 'https://colp.example', accountId: 'owner',
    browserProfileId: 'profile', collectionId: 'c_personal', replicaId: 'replica-1', generation: 2 },
  events: [] as { kind: string; details: Record<string, unknown> }[],
  mappings: {} as Record<string, string>,
  importing: false,
  moves: [] as [string, string][],
  receipts: [] as unknown[],
  feedback: [] as unknown[],
  imports: [] as (() => void)[],
  tree: new Map<string, { id: string; parentId: string; title: string; url?: string; dateAdded?: number; folderType?: string }>(),
}));
vi.mock('../src/sw/runtime.js', () => ({
  hasBookmarkPermission: async () => true, sw: {},
  syncState: {
    listBookmarkEventsByNative: async () => f.events,
    getMappingByNativeId: async (_scope: unknown, nativeId: string) => {
      const colpId = Object.keys(f.mappings).find((key) => f.mappings[key] === nativeId);
      return colpId ? { colpId, nativeId, nodeKind: nativeId.startsWith('n') ? 'bookmark' : 'folder' } : null;
    },
    getMappingByColpId: async (_scope: unknown, colpId: string) => f.mappings[colpId] ? { nativeId: f.mappings[colpId], nodeKind: 'folder' } : null,
  },
}));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => f.scope }));
vi.mock('../src/sw/automation.js', async () => {
  const runtime = await import('../src/sw/runtime.js');
  const { automationDatabase: database } = await import('../src/automation/indexeddb-store.js');
  return {
    automationArea: () => database().area(),
    sourceAutomationsPaused: async () => automationsPaused(
      await createBundleStore(database().area(), f.scope).read(),
      await createPauseStatusStore({ get: async key => (await chrome.storage.local.get(key))[key],
        set: async (key, value) => chrome.storage.local.set({ [key]: value }) }, f.scope).read(), Date.now()),
    recordPlacementReceipt: async (receipt: unknown) => { f.receipts.push(receipt); },
    automationProjectionDeps: (scope: unknown) => ({
      mappingByColpId: (colpId: string) => runtime.syncState.getMappingByColpId(scope as never, colpId),
      mappingByNativeId: async (nativeId: string) => {
        const mapping = await runtime.syncState.getMappingByNativeId(scope as never, nativeId);
        return mapping ? { colpId: mapping.colpId, nodeKind: 'folder' } : null;
      },
      nativeNode: async (nativeId: string) => (await chrome.bookmarks.get(nativeId))[0] ?? null,
    }),
  };
});
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ personalBookmarks: { move: async (id: string, to: { parentId: string }) => {
  f.moves.push([id, to.parentId]); f.tree.set(id, { ...f.tree.get(id)!, parentId: to.parentId }); } } }));
vi.mock('../src/local-import/store.js', () => ({ createLocalImportStore: () => ({ plan: async () => (f.importing ? { state: 'running' } : undefined) }) }));
vi.mock('../src/save-feedback.js', () => ({ presentSaveFeedback: async (feedback: unknown) => { f.feedback.push(feedback); } }));

import { installObservedCreates, observeCreatedBookmark, observeRemovedBookmark, resumeObservedCreates, settleDue } from '../src/sw/automation-observed.js';

const tree = f.tree;
const paper = { url: 'https://arxiv.org/abs/1706.03762', title: 'Attention Is All You Need' };
const star = async (id: string, parentId = '2', url = paper.url) => {
  tree.set(id, { id, parentId, title: paper.title, url, dateAdded: NOW });
  await observeCreatedBookmark(id, tree.get(id)!);
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] }); vi.setSystemTime(NOW);
  vi.stubGlobal('__KNOWN_EXTENSION_EVIDENCE__', false);
  Object.assign(f, { events: [{ kind: 'create', details: { context: { parentNativeId: '2' } } }], mappings: { other: '2', academic: '10' },
    importing: false, moves: [], receipts: [], feedback: [], imports: [] });
  tree.clear();
  for (const node of [{ id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar' }, { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other' },
    { id: '10', parentId: '1', title: 'Academic' }, { id: '20', parentId: '1', title: 'Reading' }]) tree.set(node.id, node);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', {
    storage: { local: new MemoryStorageArea(), session: new MemoryStorageArea() },
    bookmarks: { get: async (id: string) => (tree.has(id) ? [tree.get(id)!] : []),
      onImportBegan: { addListener: (listener: () => void) => { f.imports[0] = listener; } },
      onImportEnded: { addListener: (listener: () => void) => { f.imports[1] = listener; } } },
    runtime: { sendMessage: async () => undefined },
  });
  await createBundleStore(automationDatabase().area(), { serverOrigin: 'https://colp.example', accountId: 'owner' })
    .install(ruleBundle([compiledRule({ folder: folderRef('academic') })]), NOW);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const pauseAccount = () => createPauseStatusStore({ get: async key => (await chrome.storage.local.get(key))[key],
  set: async (key, value) => chrome.storage.local.set({ [key]: value }) }, f.scope).apply({ ok: true,
  pause: { paused: true, revision: '2', pausedAt: new Date(NOW).toISOString(), pausedBy: 'owner', heldJobs: 0 } }, NOW);

describe('observed creations in the worker', () => {
  it('honors an independent account pause with an older active bundle, including during settling', async () => {
    await star('before-pause');
    await pauseAccount();
    await star('after-pause');
    vi.setSystemTime(NOW + 3_001);
    await settleDue();
    expect(f.moves).toEqual([]);
    expect(f.receipts).toEqual([]);
  });

  it('rechecks a pause learned after the placement intent was persisted', async () => {
    const intents = automationDatabase().intents, put = intents.put.bind(intents);
    vi.spyOn(intents, 'put').mockImplementation(async intent => { await put(intent); await pauseAccount(); });
    await star('n1');
    vi.setSystemTime(NOW + 3_001);
    await settleDue();
    expect(f.moves).toEqual([]);
    expect(f.receipts).toEqual([]);
  });

  it('moves a starred page once after the settle window, with its receipt and notice', async () => {
    await star('n1');
    await settleDue();
    expect(f.moves).toEqual([]);
    vi.setSystemTime(NOW + 3_000);
    // The settle timer fires on its own; its intent and receipt are IndexedDB writes.
    await vi.advanceTimersByTimeAsync(3_100);
    await vi.waitFor(() => expect(f.moves).toEqual([['n1', '10']]));
    await vi.waitFor(() => expect(f.receipts).toHaveLength(1));
    // The write-ahead intent is done once its receipt exists.
    expect(await automationDatabase().intents.list()).toEqual([]);
    expect(f.receipts).toEqual([expect.objectContaining({ path: 'observed', collectionId: COLLECTION_ID, replicaId: 'replica-1', generation: 2,
      beforeFolder: folderRef('other'), native: expect.objectContaining({ nativeId: 'n1', destinationNativeId: '10' }) })]);
    expect(f.feedback).toEqual([expect.objectContaining({ code: 'saved', entry: 'page', nativeId: 'n1',
      message: 'Moved “Attention Is All You Need” to Academic by rule “Place research papers in Academic”.' })]);
    // Handed over once: later passes never repeat it.
    await settleDue(NOW + 10_000);
    expect(f.moves).toHaveLength(1);
  });

  it('leaves a bookmark starred into a folder, the extension’s own save and a projection alone', async () => {
    await star('n1', '20');
    f.events = [{ kind: 'create', details: { context: { placement: { intentId: 'i' } } } }];
    await star('n2');
    await settleDue(NOW + 3_000);
    f.events = []; f.mappings = { ...f.mappings, 'server-node': 'n3' };
    await star('n3');
    await settleDue(NOW + 3_000);
    expect(f.moves).toEqual([]);
    expect(f.feedback).toEqual([]);
  });

  it('treats creations during an import and re-created pages as not intake', async () => {
    const at = async (offset: number) => { vi.setSystemTime(NOW + offset); await vi.advanceTimersByTimeAsync(0); };
    installObservedCreates();
    // The browser's own import.
    f.imports[0]!();
    await star('n1');
    await settleDue(NOW + 3_000);
    f.imports[1]!();
    // Know-N's import, after the browser's import and its grace period.
    await at(60_000);
    f.importing = true;
    await star('n2');
    await settleDue(NOW + 63_000);
    expect(f.moves).toEqual([]);
    // A page re-created moments after it was removed: an undo or a restore.
    f.importing = false;
    await observeRemovedBookmark({ node: { url: 'https://arxiv.org/abs/2' } });
    await star('n3', '2', 'https://arxiv.org/abs/2');
    await settleDue(NOW + 63_000);
    expect(f.moves).toEqual([]);
    // Control: the same moment, a page that was never removed is filed.
    await star('n4');
    await settleDue(NOW + 63_000);
    expect(f.moves).toEqual([['n4', '10']]);
  });

  it('receipts a move a worker crash cut off from its receipt, and never makes a move late', async () => {
    const ownerKey = JSON.stringify(['https://colp.example', 'owner']);
    const automation = { outcome: 'placed', ruleIds: ['rule-arxiv'], bundleRevision: 'b-1', settingsRevision: 1, satisfies: ['classify.root'],
      rule: { id: 'rule-arxiv', name: 'arXiv papers', revision: '1', bindingRevision: '1', semanticDigest: 'd' }, destination: folderRef('academic'),
      folderTitle: 'Academic', fromNativeId: '2', collectionId: COLLECTION_ID, replicaId: 'replica-1', generation: 2 } as const;
    const intent = (intentId: string, nativeId: string) => ({ intentId, id: intentId, ownerKey, fromParentId: '2', dateAdded: NOW, createdAt: NOW,
      automation, page: paper, native: { nativeId, destinationNativeId: '10', movedAt: NOW } });
    tree.set('n1', { id: 'n1', parentId: '10', title: paper.title, url: paper.url, dateAdded: NOW });
    tree.set('n2', { id: 'n2', parentId: '2', title: paper.title, url: paper.url, dateAdded: NOW });
    await automationDatabase().intents.put(intent('moved', 'n1'));
    await automationDatabase().intents.put(intent('not-moved', 'n2'));
    await resumeObservedCreates();
    expect(f.receipts).toEqual([expect.objectContaining({ localReceiptId: 'moved', path: 'observed', native: expect.objectContaining({ nativeId: 'n1' }) })]);
    expect(f.moves).toEqual([]);
    expect(await automationDatabase().intents.list()).toEqual([]);
  });

  it('observes nothing for an account without rules in force', async () => {
    await createBundleStore(automationDatabase().area(), { serverOrigin: 'https://colp.example', accountId: 'owner' })
      .install(ruleBundle([], { paused: true, settingsRevision: 2 }), NOW);
    await star('n1');
    expect(await chrome.storage.session.get('known.automation.observed.v1')).toEqual({});
  });
});
