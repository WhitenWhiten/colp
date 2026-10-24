import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { classificationDocument } from '../src/classification-intent.js';
import type { ClassificationPreviewReply } from '../src/classification-preview-reply.js';
import { CLASSIFICATION_PREVIEW_PREFIX, type ClassificationPreviewMessage } from '../src/classification-preview-store.js';
import { LOCAL_CLASSIFICATION_ENABLED, LOCAL_CLASSIFICATION_KEY } from '../src/classification-local-session.js';
import { MANUAL_CLASSIFICATION_AUTO } from '../src/manual-classification.js';
import type { CaptureExistence } from '../src/capture/contracts.js';
import { location } from './fixtures/capture.js';

const f = vi.hoisted(() => ({
  scope: { serverOrigin: 'https://known.test', accountId: 'account', authorityGeneration: 1, collectionId: 'library' },
  mode: 'manual', policyRevision: 1,
  existence: vi.fn(), local: vi.fn(), cloud: vi.fn(),
}));
vi.mock('../src/sw/classification-destination.js', () => ({ classificationDestinationPolicy: { snapshot: async () => ({ digest: `fixture-policy-${f.policyRevision}`, excluded: new Set(), constrained: false }), assertAllowed: async () => {}, assertCurrent: async (digest: string) => { if (digest !== `fixture-policy-${f.policyRevision}`) throw new Error('destination_policy_changed'); }, assertCloudSupported: async () => {} } }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => ({ ...f.scope }), captureExistence: f.existence,
  assertCaptureScope: async (scope: unknown) => { if (JSON.stringify(scope) !== JSON.stringify(f.scope)) throw new Error('capture_scope_changed'); } }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ readEffectiveBookmarkPreferences: async () => ({ captureMode: f.mode }) }));
vi.mock('../src/sw/classification-local.js', () => ({ localClassificationPreview: f.local }));
vi.mock('../src/sw/scope.js', () => ({ loadConfig: async () => ({ serverOrigin: f.scope.serverOrigin }),
  currentSyncScope: async () => ({ ...f.scope, replicaId: 'replica', generation: '1' }) }));
vi.mock('../src/sw/runtime.js', () => ({ store: { loadCredential: async () => ({ subject: f.scope.accountId, serverOrigin: f.scope.serverOrigin }),
  fence: { assertWritable: async (generation: number) => { if (generation !== f.scope.authorityGeneration) throw new Error('fenced'); } } },
  syncState: { getMappingByColpId: async () => ({ colpId: 'recipes', nativeId: '42', nodeKind: 'folder' }) } }));
vi.mock('../src/classification-product-client.js', async original => ({ ...await original<object>(),
  createClassificationProductClient: () => ({ preview: f.cloud }) }));
vi.mock('../src/bookmark-event-ingress.js', () => ({ resolveIngressBoundary: async () => ({ selectedNative: new Set(['1']) }) }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ isSubscriptionExcluded: async () => false }));
vi.mock('../src/bookmark-subscriptions/barrier.js', () => ({ withSubscriptionRead: async (work: () => unknown) => work() }));

import { handleClassificationRequest } from '../src/sw/classification.js';

const page = { title: 'Pasta', url: 'https://example.org/pasta' };
const context = { generation: 1, signal: new AbortController().signal };
const sender = { id: 'extension', url: `chrome-extension://extension/popup.html?surface=${crypto.randomUUID()}` };
let localStorage: MemoryStorageArea, sessionStorage: MemoryStorageArea;

const result = () => ({ contractVersion: '1.0.0', collectionId: 'library', source: { kind: 'incoming', nodeId: null },
  taxonomyRevision: '1', folder: { decision: 'l2', folderId: 'recipes', confidence: 1, probabilities: [{ folderId: 'recipes', probability: 1 }] },
  tags: { mode: 'suggest', candidates: [{ tag: 'Cooking', selected: true, noul: 0.99 }] },
  candidateCoverage: { policyVersion: 'v1', l1Included: 1, l1Total: 1, descendantIncluded: 0, descendantTotal: 0, tagTotal: 1, tagIncluded: 1 } });
function existence(exact: CaptureExistence['exact'] = [], complete = true): CaptureExistence {
  return { kind: exact.length ? 'local' : complete ? 'not-found' : 'unavailable', exact, similar: [],
    coverage: { local: complete ? 'complete' : 'unavailable', cloud: 'not-checked', collectionIds: [], checkedAt: Date.now(), stale: false } };
}
function message(local = true, automatic = true): ClassificationPreviewMessage {
  const body = { commandId: crypto.randomUUID(), document: classificationDocument(page, { tags: true }),
    ...(automatic ? { automatic: true as const } : { userGesture: true as const }) };
  return local ? { kind: 'known.classification.local-preview', ...body }
    : { kind: 'known.classification.preview', collectionId: 'library', ...body };
}
async function send(request: ClassificationPreviewMessage): Promise<ClassificationPreviewReply> {
  return handleClassificationRequest(request, context, sender) as Promise<ClassificationPreviewReply>;
}
async function provider(local: boolean) {
  await localStorage.set({ [LOCAL_CLASSIFICATION_ENABLED]: local });
  return local ? f.local : f.cloud;
}

beforeEach(async () => {
  localStorage = new MemoryStorageArea(); sessionStorage = new MemoryStorageArea();
  await localStorage.set({ [MANUAL_CLASSIFICATION_AUTO]: true, [LOCAL_CLASSIFICATION_ENABLED]: true,
    [LOCAL_CLASSIFICATION_KEY]: { generation: 'provider-1', secret: 'fixture-secret' } });
  Object.assign(f.scope, { serverOrigin: 'https://known.test', accountId: 'account', authorityGeneration: 1, collectionId: 'library' });
  f.mode = 'manual'; f.policyRevision = 1; f.existence.mockReset().mockResolvedValue(existence());
  f.local.mockReset().mockResolvedValue({ ok: true, result: result(), nativeFolder: { folderId: 'recipes', nativeId: '42', title: 'Recipes' } });
  f.cloud.mockReset().mockResolvedValue(result());
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  vi.stubGlobal('chrome', { storage: { local: localStorage, session: sessionStorage },
    runtime: { id: 'extension', getContexts: async () => [{ contextType: 'POPUP', documentId: 'popup', documentUrl: sender.url }] },
    bookmarks: { get: async (id: string) => [{ id, title: 'Recipes', ...(id === '1' ? {} : { parentId: '1' }) }] } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test.each([true, false])('an already-saved page never reaches the provider on form-open, local=%s', async local => {
  const call = await provider(local);
  f.existence.mockResolvedValue(existence([{ ...location, url: page.url }]));
  expect(await send(message(local))).toEqual({ ok: true, skipped: 'already_saved' });
  expect(call).not.toHaveBeenCalled();
  expect(await sessionStorage.get(null)).toEqual({});
});

test.each([true, false])('an unavailable existence check suppresses implicit classification, local=%s', async local => {
  const call = await provider(local);
  f.existence.mockResolvedValue(existence([], false));
  expect(await send(message(local))).toEqual({ ok: true, skipped: 'existence_unavailable' });
  expect(call).not.toHaveBeenCalled();
});

test('dispatch waits for bookmark identity even when popup initialization runs in parallel', async () => {
  let resolve!: (value: CaptureExistence) => void;
  f.existence.mockImplementation(() => new Promise(value => { resolve = value; }));
  const pending = send(message());
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  expect(f.local).not.toHaveBeenCalled();
  resolve(existence([{ ...location, url: page.url }]));
  expect(await pending).toMatchObject({ skipped: 'already_saved' });
  expect(f.local).not.toHaveBeenCalled();
});

test.each([true, false])('explicit reclassification of an existing page remains available, local=%s', async local => {
  const call = await provider(local);
  f.existence.mockResolvedValue(existence([{ ...location, url: page.url }]));
  expect(await send(message(local, false))).toMatchObject({ ok: true, result: { folder: { folderId: 'recipes' } } });
  expect(call).toHaveBeenCalledOnce();
  expect(f.existence).not.toHaveBeenCalled();
});

test.each([true, false])('reopening an unsaved page reuses its suggestion and command, local=%s', async local => {
  const call = await provider(local), first = message(local);
  expect(await send(first)).toMatchObject({ ok: true, commandId: first.commandId });
  const reopened = await send(message(local));
  expect(reopened).toMatchObject({ ok: true, commandId: first.commandId, result: { tags: { candidates: [{ tag: 'Cooking', selected: true }] } } });
  expect(call).toHaveBeenCalledOnce();
  expect(f.existence).toHaveBeenCalledTimes(2);
  const retained = JSON.stringify(await sessionStorage.get(null));
  expect(retained).not.toMatch(/fixture-secret|probabilities|confidence|noul|Pasta|example\.org/u);
});

test('concurrent openings share one provider call', async () => {
  let resolve!: (reply: unknown) => void;
  f.local.mockImplementation(() => new Promise(value => { resolve = value; }));
  const first = send(message()), second = send(message());
  await vi.waitFor(() => expect(f.local).toHaveBeenCalledOnce());
  resolve({ ok: true, result: result(), nativeFolder: null });
  const replies = await Promise.all([first, second]);
  expect(replies[0]!.commandId).toBe(replies[1]!.commandId);
  expect(f.local).toHaveBeenCalledOnce();
});

test('a bookmark saved after an earlier suggestion takes precedence over the retained result', async () => {
  await send(message());
  f.existence.mockResolvedValue(existence([{ ...location, url: page.url }]));
  expect(await send(message())).toMatchObject({ skipped: 'already_saved' });
  expect(f.local).toHaveBeenCalledOnce();
});

test('lost cloud responses are observed on reopening and retried only by an explicit action with the same command', async () => {
  await provider(false);
  f.cloud.mockRejectedValueOnce(new Error('response_lost'));
  const first = message(false), reply = await send(first);
  expect(reply).toMatchObject({ ok: false, commandId: first.commandId, sameRequestRetrySafe: true });
  expect(await send(message(false))).toMatchObject(reply);
  expect(f.cloud).toHaveBeenCalledOnce();
  expect(await send({ ...message(false, false), commandId: reply.commandId! })).toMatchObject({ ok: true });
  expect(f.cloud).toHaveBeenCalledTimes(2);
  expect(f.cloud.mock.calls.map(call => call[2])).toEqual([first.commandId, first.commandId]);
});

test.each([true, false])('a worker restart after dispatch retention fails never creates another implicit command, local=%s', async local => {
  const call = await provider(local), first = message(local);
  const set = sessionStorage.set.bind(sessionStorage);
  const retention = vi.spyOn(sessionStorage, 'set').mockImplementation(async values => {
    if (Object.values(values).some(value => (value as { reply?: unknown }).reply)) throw new Error('lost_completion');
    await set(values);
  });
  expect(await send(first)).toMatchObject({ ok: true });
  retention.mockRestore();
  vi.resetModules();
  const restarted = (await import('../src/sw/classification.js')).handleClassificationRequest;
  expect(await restarted(message(local), context, sender)).toMatchObject({ ok: false, commandId: first.commandId,
    sameRequestRetrySafe: !local, error: local ? 'local_result_unknown' : 'classification_unavailable' });
  expect(call).toHaveBeenCalledOnce();
});

test('changed page input, provider configuration and authority each create a distinct intent', async () => {
  await send(message());
  await send({ ...message(), document: classificationDocument({ ...page, title: 'Updated pasta' }, { tags: true }) });
  await localStorage.set({ [LOCAL_CLASSIFICATION_KEY]: { generation: 'provider-2' } });
  await send(message());
  f.scope.authorityGeneration++;
  await send(message());
  expect(f.local).toHaveBeenCalledTimes(4);
});

test('a changed source never silently dispatches an implicit cloud suggestion', async () => {
  expect(await send(message(false))).toMatchObject({ ok: false, error: 'manual_suggestions_disabled' });
  expect(f.cloud).not.toHaveBeenCalled();
});

test.each(['not-popup', 'disabled', 'automatic-mode'])('form-open authorization rejects %s before looking up or classifying the page', async reason => {
  if (reason === 'not-popup') vi.spyOn(chrome.runtime, 'getContexts').mockResolvedValue([]);
  if (reason === 'disabled') await localStorage.set({ [MANUAL_CLASSIFICATION_AUTO]: false });
  if (reason === 'automatic-mode') f.mode = 'automatic';
  expect(await send(message())).toMatchObject({ ok: false, error: 'manual_suggestions_disabled' });
  expect(f.existence).not.toHaveBeenCalled(); expect(f.local).not.toHaveBeenCalled();
});

test('a stale collection request cannot poison the active collection suggestion', async () => {
  await provider(false);
  const stale = message(false);
  if (stale.kind !== 'known.classification.preview') throw new Error('expected_cloud_request');
  expect(await send({ ...stale, collectionId: 'other-collection' })).toMatchObject({ ok: false, error: 'classification_scope_changed' });
  expect(await send(message(false))).toMatchObject({ ok: true });
  expect(f.cloud).toHaveBeenCalledOnce();
});

test('a cloud cache hit is fenced when the account changes during the read', async () => {
  await provider(false);
  await send(message(false));
  const get = sessionStorage.get.bind(sessionStorage);
  vi.spyOn(sessionStorage, 'get').mockImplementation(async keys => {
    const values = await get(keys);
    f.scope.authorityGeneration++;
    return values;
  });
  await expect(send(message(false))).rejects.toThrow('fenced');
  expect(f.cloud).toHaveBeenCalledOnce();
});

test('retention is bounded and a full session still permits explicit requests', async () => {
  await sessionStorage.set(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`${CLASSIFICATION_PREVIEW_PREFIX}${i}`, { version: 1, commandId: crypto.randomUUID() }])));
  expect(await send(message())).toMatchObject({ ok: true, skipped: 'session_limit' });
  expect(f.local).not.toHaveBeenCalled();
  expect(await send(message(true, false))).toMatchObject({ ok: true });
  expect(f.local).toHaveBeenCalledOnce();
});

test('failure to retain a command prevents implicit dispatch', async () => {
  vi.spyOn(sessionStorage, 'set').mockRejectedValue(new Error('storage_unavailable'));
  await expect(send(message())).rejects.toThrow('storage_unavailable');
  expect(f.local).not.toHaveBeenCalled();
});

test('a damaged retained intent never silently creates another implicit call', async () => {
  await send(message());
  const key = Object.keys(await sessionStorage.get(null)).find(name => name.startsWith(CLASSIFICATION_PREVIEW_PREFIX))!;
  await sessionStorage.set({ [key]: null });
  expect(await send(message())).toMatchObject({ ok: false, sameRequestRetrySafe: false });
  expect(f.local).toHaveBeenCalledOnce();
  expect(await send(message(true, false))).toMatchObject({ ok: true });
  expect(f.local).toHaveBeenCalledTimes(2);
});

test('destination policy changes invalidate cached previews and reject a late provider reply', async () => {
  await send(message()); await send(message()); expect(f.local).toHaveBeenCalledTimes(1);
  f.policyRevision++; await send(message()); expect(f.local).toHaveBeenCalledTimes(2);
  let resolve!: (reply: ClassificationPreviewReply) => void;
  f.local.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const pending = send(message(true, false)); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  f.policyRevision++; resolve({ ok: true, result: result(), nativeFolder: { folderId: 'recipes', nativeId: '42', title: 'Recipes' } });
  await expect(pending).rejects.toThrow('destination_policy_changed');
});
