import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createCaptureStore, type CaptureStore } from '../src/capture/store.js';
import { task } from './fixtures/capture.js';
import type { CaptureAutomation, CaptureTask } from '../src/capture/contracts.js';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { LOCAL_CLASSIFICATION_KEY } from '../src/classification-local-session.js';

/** Local-first automatic save: classify with the user's own provider, then file the browser bookmark. */
const f = vi.hoisted(() => ({
  scope: { accountId: null, serverOrigin: 'https://known.test', authorityGeneration: 1, collectionId: null },
  ledger: null as CaptureStore | null,
  parent: 'inbox',
  classify: vi.fn(),
  move: vi.fn(),
  lanes: [] as string[],
  storage: null as MemoryStorageArea | null,
  aiTagMode: undefined as 'off' | 'suggest' | 'add' | undefined,
}));

vi.mock('../src/sw/classification-destination.js', () => ({ classificationDestinationPolicy: { snapshot: async () => ({ digest: 'fixture-policy', excluded: new Set(), constrained: false }), assertAllowed: async () => {}, assertCurrent: async () => {}, assertCloudSupported: async () => {} } }));
vi.mock('../src/sw/runtime.js', () => ({
  workCoordinator: { run: async (lane: string, work: (context: { generation: number; signal: AbortSignal }) => unknown) => {
    f.lanes.push(lane); return work({ generation: 1, signal: new AbortController().signal }); } } }));
vi.mock('../src/sw/capture-native.js', () => ({
  nativeCaptureLocation: async (nativeId: string) => ({ nativeId, nodeId: null, collectionId: null, collectionTitle: null,
    path: ['Bookmarks bar', f.parent === 'recipes' ? 'Recipes' : 'Inbox'], writable: true, url: 'https://example.org/pasta' }) }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ handleBookmarkPreferencesRequest: async () => ({ ok: true, pending: false, conflict: false,
  preferences: { captureMode: 'automatic', resumeClassificationWhenOnline: true, ...f.aiTagMode ? { aiTagMode: f.aiTagMode } : {} } }) }));
vi.mock('../src/capture/control.js', async original => ({ ...await original<object>(),
  readCaptureControl: async () => ({ paused: false, generation: 0, consent: null }) }));
vi.mock('../src/classification-local-session.js', async original => ({ ...await original<object>(),
  localClassificationEnabled: async () => true }));
vi.mock('../src/sw/classification-local.js', () => ({ runLocalClassification: f.classify }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ isSubscriptionExcluded: async () => false,
  personalBookmarks: { move: f.move } }));

import { classifyLocalCapture } from '../src/sw/capture-local.js';

const reply = (decision: 'l2' | 'later', folder: string | null) => ({ ok: true,
  result: { folder: { decision, folderId: folder }, candidateCoverage: { l1Included: 1 } }, nativeFolder: folder ? { folderId: folder, nativeId: folder, title: 'Recipes' } : null });

function seed(patch: Partial<CaptureTask> = {}): CaptureTask {
  const now = Date.now();
  return { ...task, scope: f.scope, createdAt: now, updatedAt: now, save: 'local-saved', classification: 'waiting',
    targetNativeId: 'inbox', nativeId: 'saved', title: 'Pasta', url: 'https://example.org/pasta',
    localLocation: { nativeId: 'saved', nodeId: null, collectionId: null, collectionTitle: null, path: ['Inbox'], writable: true, url: 'https://example.org/pasta' },
    sync: 'local-only', local: { commandId: null, state: 'waiting' }, ...patch };
}

beforeEach(async () => {
  f.ledger = createCaptureStore(new IDBFactory()); f.parent = 'inbox'; f.lanes.length = 0; f.aiTagMode = undefined;
  f.classify.mockReset(); f.move.mockReset().mockImplementation(async (_id: string, to: { parentId: string }) => { f.parent = to.parentId; });
  f.storage = new MemoryStorageArea();
  await f.storage.set({ [LOCAL_CLASSIFICATION_KEY]: { endpoint: 'http://localhost:8080/classify' } });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('chrome', { bookmarks: { get: async (id: string) => id === 'saved'
    ? [{ id, parentId: f.parent, title: 'Pasta', url: 'https://example.org/pasta' }] : [] },
    storage: { local: f.storage, session: new MemoryStorageArea() } });
});
afterEach(async () => { await f.ledger?.close(); vi.unstubAllGlobals(); });

test('signed out, a confident local decision files the bookmark with no account, credits or confirmation', async () => {
  f.classify.mockResolvedValue(reply('l2', 'recipes'));
  const created = await f.ledger!.claim(seed());
  const result = await classifyLocalCapture(created, f.ledger!);
  expect(f.move).toHaveBeenCalledWith('saved', { parentId: 'recipes' });
  // Not the account-fenced 'classification' lane: signed out, that lane rejects every task.
  expect(f.lanes).toEqual(['local-classification']);
  expect(result).toMatchObject({ classification: 'applied', reason: null, decisionId: null,
    local: { state: 'applied', fromNativeId: 'inbox', folderNativeId: 'recipes', folderTitle: 'Recipes' } });
  expect(result.localLocation?.path).toEqual(['Bookmarks bar', 'Recipes']);
  expect(f.classify.mock.calls[0]![0].document).toEqual({ source: 'extension',
    bookmark: { title: 'Pasta', url: 'https://example.org/pasta', description: null }, requested: { folder: true, tags: true } });
  expect(f.classify.mock.calls[0]![0].excludeBookmarkId).toBe('saved');
});

test('"later" keeps the save where it is', async () => {
  f.classify.mockResolvedValue(reply('later', null));
  const result = await classifyLocalCapture(await f.ledger!.claim(seed()), f.ledger!);
  expect(f.move).not.toHaveBeenCalled();
  expect(result).toMatchObject({ classification: 'manual', reason: 'local_no_folder', local: { state: 'later', folderCandidateCount: 1 } });
});

test.each(['existing', 'cancelled'] as const)('a %s capture never reaches the local provider even with a saved receipt', async disposition => {
  const created = await f.ledger!.claim(seed({ disposition }));
  expect(await classifyLocalCapture(created, f.ledger!)).toMatchObject({ disposition, classification: 'waiting' });
  expect(f.classify).not.toHaveBeenCalled(); expect(f.move).not.toHaveBeenCalled();
});

test('an intentional new copy stays eligible although its URL already has another bookmark', async () => {
  f.classify.mockResolvedValue(reply('l2', 'recipes'));
  const created = await f.ledger!.claim(seed({ saveAnother: true, existence: { kind: 'local', exact: [
    { nativeId: 'other-copy', nodeId: null, collectionId: null, collectionTitle: null, path: ['Recipes'], writable: true, url: 'https://example.org/pasta' },
  ], similar: [], coverage: { local: 'complete', cloud: 'not-checked', collectionIds: [], checkedAt: Date.now(), stale: false } } }));
  expect(await classifyLocalCapture(created, f.ledger!)).toMatchObject({ classification: 'applied' });
  expect(f.classify).toHaveBeenCalledOnce(); expect(f.move).toHaveBeenCalledOnce();
});
test('an explicitly bound semantic reclassification can classify an existing copy without a fabricated create', async () => {
  f.classify.mockResolvedValue(reply('l2', 'recipes'));
  const created = await f.ledger!.claim(seed({ disposition: 'existing', contentIntent: { bindingId: 'binding', itemId: 'video:av:1', connectionId: null,
    mode: 'reclassify', captureIntentId: task.captureId, nativeId: 'saved', dateAdded: 10, title: 'Pasta', url: 'https://example.org/pasta', parentId: 'inbox' } }));
  expect(await classifyLocalCapture(created, f.ledger!)).toMatchObject({ disposition: 'existing', save: 'local-saved', classification: 'applied' });
  expect(f.move).toHaveBeenCalledOnce(); expect(f.classify).toHaveBeenCalledOnce();
});

test('automatic own-AI tags are saved locally without erasing the user note', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const annotations = createBookmarkAnnotationStore();
  try {
    await annotations.save({ id: 'saved', url: 'https://example.org/pasta' }, { tags: ['kept'], note: 'My note' });
    f.classify.mockResolvedValue({ ...reply('l2', 'recipes'), result: { folder: { decision: 'l2', folderId: 'recipes' }, tags: { candidates: [{ tag: 'Cooking' }] } } });
    expect((await classifyLocalCapture(await f.ledger!.claim(seed()), f.ledger!)).classification).toBe('applied');
    expect(await annotations.get({ id: 'saved' })).toMatchObject({ tags: ['Cooking', 'kept'], note: 'My note' });
  } finally { annotations.close(); }
});

test('Suggest keeps the selected tags for the result panel and writes none; Off asks for none', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const tagged = { ...reply('l2', 'recipes'), result: { folder: { decision: 'l2', folderId: 'recipes' }, candidateCoverage: { l1Included: 1 },
    tags: { candidates: [{ tag: 'Cooking', noul: 0.9, selected: true }, { tag: 'Travel', noul: 0.1, selected: false }] } } };
  f.classify.mockResolvedValue(tagged);
  f.aiTagMode = 'suggest';
  const suggested = await classifyLocalCapture(await f.ledger!.claim(seed()), f.ledger!);
  expect(f.classify.mock.calls[0]![0].document.requested).toEqual({ folder: true, tags: true });
  expect(suggested).toMatchObject({ classification: 'applied', local: { state: 'applied', suggestedTags: ['Cooking'] } });
  const annotations = createBookmarkAnnotationStore();
  try { expect((await annotations.get({ id: 'saved' }))?.tags ?? []).toEqual([]); } finally { annotations.close(); }

  f.aiTagMode = 'off'; f.parent = 'inbox';
  const off = await classifyLocalCapture(await f.ledger!.claim(seed({ captureId: crypto.randomUUID(), commandId: crypto.randomUUID() })), f.ledger!);
  expect(f.classify.mock.calls[1]![0].document.requested).toEqual({ folder: true, tags: false });
  expect(off.local).not.toHaveProperty('suggestedTags');
});

test('a user move before classification wins and the provider is never called', async () => {
  f.parent = 'elsewhere';
  const result = await classifyLocalCapture(await f.ledger!.claim(seed()), f.ledger!);
  expect(f.classify).not.toHaveBeenCalled(); expect(f.move).not.toHaveBeenCalled();
  expect(result).toMatchObject({ classification: 'manual', reason: 'manually_edited', manualFence: 1 });
});

test('a worker restart during the provider call never repeats it', async () => {
  const running = seed({ classification: 'running', local: { commandId: 'spent', state: 'running', fromNativeId: 'inbox' } });
  const result = await classifyLocalCapture(await f.ledger!.claim(running), f.ledger!);
  expect(f.classify).not.toHaveBeenCalled(); expect(f.move).not.toHaveBeenCalled();
  expect(result).toMatchObject({ classification: 'manual', reason: 'local_result_unknown', local: { state: 'unknown' } });
});

test('a provider failure keeps the bookmark and says why', async () => {
  f.classify.mockResolvedValue({ ok: false, error: 'local_key_required' });
  const result = await classifyLocalCapture(await f.ledger!.claim(seed()), f.ledger!);
  expect(f.move).not.toHaveBeenCalled();
  expect(result).toMatchObject({ classification: 'manual', reason: 'local_key_required' });
});

test.each(['http://localhost:8080/classify', 'http://127.0.0.1:8080/classify', 'http://[::1]:8080/classify'])('offline automatic classification tries %s and applies its result', async endpoint => {
  vi.stubGlobal('navigator', { onLine: false });
  await f.storage!.set({ [LOCAL_CLASSIFICATION_KEY]: { endpoint } });
  f.classify.mockResolvedValue(reply('l2', 'recipes'));
  const result = await classifyLocalCapture(await f.ledger!.claim(seed()), f.ledger!);
  expect(f.classify).toHaveBeenCalledOnce();
  expect(f.move).toHaveBeenCalledWith('saved', { parentId: 'recipes' });
  expect(result).toMatchObject({ classification: 'applied', reason: null, save: 'local-saved' });
});

test.each(['https://api.typesafe.ai/v1/systemone', 'http://192.168.1.20:8080/classify', 'http://model.local:8080/classify'])('offline automatic classification queues network endpoint %s', async endpoint => {
  vi.stubGlobal('navigator', { onLine: false });
  await f.storage!.set({ [LOCAL_CLASSIFICATION_KEY]: { endpoint } });
  const result = await classifyLocalCapture(await f.ledger!.claim(seed()), f.ledger!);
  expect(f.classify).not.toHaveBeenCalled(); expect(f.move).not.toHaveBeenCalled();
  expect(result).toMatchObject({ classification: 'waiting', reason: 'offline', save: 'local-saved', local: { state: 'waiting', commandId: null } });
});

test('an unreachable loopback provider keeps the saved bookmark and reports the call failure', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  f.classify.mockResolvedValue({ ok: false, error: 'local_provider_unavailable' });
  const result = await classifyLocalCapture(await f.ledger!.claim(seed()), f.ledger!);
  expect(f.classify).toHaveBeenCalledOnce(); expect(f.move).not.toHaveBeenCalled();
  expect(result).toMatchObject({ classification: 'manual', reason: 'local_provider_unavailable', save: 'local-saved' });
});

test('a user move while the offline loopback call is running wins over its result', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  f.classify.mockImplementation(async () => { f.parent = 'elsewhere'; return reply('l2', 'recipes'); });
  const result = await classifyLocalCapture(await f.ledger!.claim(seed()), f.ledger!);
  expect(f.classify).toHaveBeenCalledOnce(); expect(f.move).not.toHaveBeenCalled();
  expect(result).toMatchObject({ classification: 'manual', reason: 'manually_edited', save: 'local-saved' });
});

test('a concurrent sync-status write is re-applied instead of losing the local result', async () => {
  const created = await f.ledger!.claim(seed());
  f.classify.mockImplementation(async () => {
    const current = (await f.ledger!.get(created.scope, created.captureId))!;
    await f.ledger!.update({ ...current, revision: current.revision + 1, sync: 'pending' }, current.revision);
    return reply('l2', 'recipes');
  });
  const result = await classifyLocalCapture(created, f.ledger!);
  expect(result).toMatchObject({ classification: 'applied', sync: 'pending', local: { state: 'applied' } });
});

test('an unexpected failure leaves a readable reason instead of a save stuck waiting for classification', async () => {
  f.classify.mockResolvedValue(reply('l2', 'recipes'));
  f.move.mockRejectedValue(new Error('bookmark tree unavailable'));
  const created = await f.ledger!.claim(seed());
  const result = await classifyLocalCapture(created, f.ledger!);
  expect(result).toMatchObject({ classification: 'manual', reason: 'local_classification_failed', local: { state: 'unknown' } });
  expect(await f.ledger!.get(created.scope, created.captureId)).toMatchObject({ classification: 'manual', reason: 'local_classification_failed' });
});

describe('after a rule placed the save (AC-04)', () => {
  const automation: CaptureAutomation = { outcome: 'placed', ruleIds: ['rule-arxiv'], bundleRevision: 'b-1', settingsRevision: 1,
    satisfies: ['classify.root'], rule: { id: 'rule-arxiv', name: 'arXiv papers', revision: '1', bindingRevision: '1', semanticDigest: 'digest' },
    destination: { serverUuid: 'server', collectionId: 'c', nodeId: 'academic' }, folderTitle: 'Inbox', fromNativeId: 'other',
    collectionId: 'c', replicaId: 'replica', generation: 1 };
  const tagsOnly = { ok: true, nativeFolder: null, result: { folder: null, candidateCoverage: { l1Included: 0 },
    tags: { candidates: [{ tag: 'Papers', selected: true }, { tag: 'Physics', selected: true }] } } };
  const fresh = () => seed({ captureId: crypto.randomUUID(), commandId: crypto.randomUUID(), automation });

  test('Suggest and Add ask the user’s own AI for tags only and never move the bookmark', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    f.classify.mockResolvedValue(tagsOnly);
    f.aiTagMode = 'suggest';
    const suggested = await classifyLocalCapture(await f.ledger!.claim(fresh()), f.ledger!);
    expect(f.classify.mock.calls[0]![0].document.requested).toEqual({ folder: false, tags: true });
    expect(suggested).toMatchObject({ classification: 'applied', reason: null, targetNativeId: 'inbox',
      local: { state: 'kept', suggestedTags: ['Papers', 'Physics'] } });
    expect(suggested.local).not.toHaveProperty('folderNativeId');

    f.aiTagMode = 'add';
    const added = await classifyLocalCapture(await f.ledger!.claim(fresh()), f.ledger!);
    expect(f.classify.mock.calls[1]![0].document.requested).toEqual({ folder: false, tags: true });
    expect(added).toMatchObject({ classification: 'applied', local: { state: 'kept' } });
    const annotations = createBookmarkAnnotationStore();
    try { expect((await annotations.get({ id: 'saved' }))?.tags).toEqual(['Papers', 'Physics']); } finally { annotations.close(); }
    expect(f.move).not.toHaveBeenCalled();
  });

  test('Off sends nothing, and no tag vocabulary yet ends quietly', async () => {
    f.aiTagMode = 'off';
    expect(await classifyLocalCapture(await f.ledger!.claim(fresh()), f.ledger!)).toMatchObject({ classification: 'none', reason: null });
    expect(f.classify).not.toHaveBeenCalled();
    f.aiTagMode = 'suggest';
    f.classify.mockResolvedValue({ ok: false, error: 'local_no_tags' });
    expect(await classifyLocalCapture(await f.ledger!.claim(fresh()), f.ledger!)).toMatchObject({ classification: 'applied', reason: null, local: { state: 'kept' } });
  });
});
