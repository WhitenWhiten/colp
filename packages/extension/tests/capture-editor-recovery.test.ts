import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, test, expect, vi } from 'vitest';
import { createCaptureStore, type CaptureStore } from '../src/capture/store.js';
import { task, location } from './fixtures/capture.js';
import type { CaptureScope } from '../src/capture/contracts.js';
import type { AutomaticDecision } from '../src/capture/automatic.js';
import { ClassificationProductError } from '../src/classification-product-client.js';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { decisionTags } from '../src/capture/editor.js';
const state = vi.hoisted(() => ({ ledger: null as CaptureStore | null, scope: null as CaptureScope | null,
  mapped: true, inRange: true, correct: vi.fn(), wake: vi.fn(), location: null as CaptureTask['localLocation'] }));
vi.mock('../src/sw/capture.js', () => ({ get captureStore() { return state.ledger; } }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => state.scope, assertCaptureScope: async () => {},
  nativeCaptureLocation: async () => state.location }));
vi.mock('../src/sw/capture-privacy.js', () => ({ captureIsInSyncRange: async () => state.inRange }));
vi.mock('../src/sw/runtime.js', () => ({ syncState: { getMappingByNativeId: async () => state.mapped ? { nodeKind: 'folder', colpId: 'target' } : null },
  workCoordinator: { run: async (_lane: string, work: () => unknown) => work() } }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => ({}) }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: state.wake }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ readEffectiveBookmarkPreferences: async () => ({ learnFromCorrections: false }) }));
vi.mock('../src/capture/control.js', () => ({ readCaptureControl: async () => ({ evidenceGeneration: 0 }) }));
vi.mock('../src/classification-product-client.js', async original => ({ ...await original<object>(),
  createClassificationProductClient: () => ({ correctCapture: state.correct }) }));
import { handleCaptureEdit, handleCaptureEditCancel } from '../src/sw/capture-editor.js';
import { validCaptureEditCancel } from '../src/capture/editor.js';
import type { CaptureTask } from '../src/capture/contracts.js';
const request = { kind: 'known.capture.edit' as const, captureId: task.captureId, commandId: 'first',
  parentNativeId: 'valid', originalParentNativeId: 'original', tags: [] as string[], userGesture: true as const };
let parent = 'original';
const move = vi.fn(async (_id: string, destination: { parentId: string }) => { parent = destination.parentId; });
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  state.ledger = createCaptureStore(new IDBFactory()); state.scope = task.scope; state.mapped = true;
  state.correct.mockReset(); state.wake.mockReset(); state.inRange = true; state.location = location;
  parent = 'original'; move.mockClear();
  vi.stubGlobal('chrome', { bookmarks: { move, get: async (id: string) => id === 'deleted' ? [] :
    [{ id, title: 'Title', ...(id === 'native-saved' ? { parentId: parent, url: task.url } : {}) }] } });
});
afterEach(async () => { await state.ledger?.close(); vi.unstubAllGlobals(); });
async function claim(cloud = false) {
  const decision: AutomaticDecision = { decisionId: 'decision', captureId: task.captureId, collectionId: 'c', nodeId: 'node',
    status: 'suggested', reason: null, revision: 1, nodeEtag: '"r1"', originalParentId: 'original', parentId: null,
    suggestedParentId: 'target', tags: ['Old'], executionId: 'execution', createdAt: '2026-09-20T00:00:00Z', appliedAt: null,
    undoneAt: null, feedbackRevision: 0, effectiveFeedback: null };
  await state.ledger!.claim({ ...task, scope: state.scope!, nativeId: 'native-saved', save: 'local-saved', ...(cloud ? { decisionId: 'decision', automatic: {
    document: { captureId: task.captureId, nodeId: 'node', nodeEtag: '"r1"', policyVersion: 'capture-folder.v1',
      controlGeneration: 0, periodPoints: 10, billing: { priceVersion: 'price', maxPoints: 1 } },
    classifyCommandId: 'classify', applyCommandId: 'apply', applySubmitted: false, decision } } : {}) });
  return decision;
}
test.each(['a', null])('a local folder edit stays local for account %s and records its new location', async accountId => {
  state.scope = { ...task.scope, accountId, collectionId: accountId ? 'c' : null };
  state.inRange = false;
  state.location = { ...location, nativeId: 'native-saved', collectionId: null, nodeId: null, path: ['Local destination'] };
  await claim();
  const result = await handleCaptureEdit(request);
  expect(result.task).toMatchObject({ sync: 'local-only', localLocation: state.location, editIntent: { completed: true } });
  expect((await state.ledger!.get(state.scope, task.captureId))?.sync).toBe('local-only');
  expect(move).toHaveBeenCalledTimes(1);
  expect(state.correct).not.toHaveBeenCalled(); expect(state.wake).not.toHaveBeenCalled();
});
test('moving a native bookmark into the selected range still schedules sync', async () => {
  await claim();
  expect((await handleCaptureEdit(request)).task.sync).toBe('pending');
  expect(state.wake).toHaveBeenCalledWith('manual');
});
test('a stale cloud decision does not send a correction for a bookmark now outside the sync range', async () => {
  await claim(true); state.inRange = false;
  expect((await handleCaptureEdit(request)).task.sync).toBe('local-only');
  expect(move).toHaveBeenCalledTimes(1); expect(state.correct).not.toHaveBeenCalled();
});
test('a missing target fails before admission and permits a replacement command', async () => {
  await claim();
  await expect(handleCaptureEdit({ ...request, parentNativeId: 'deleted' })).rejects.toThrow();
  expect((await state.ledger!.get(task.scope, task.captureId))?.editIntent).toBeUndefined();
  state.mapped = true;
  await expect(handleCaptureEdit({ ...request, commandId: 'replacement' })).resolves.toMatchObject({ ok: true });
});
async function seedLegacyCloudIntent() {
  const current = (await state.ledger!.get(task.scope, task.captureId))!;
  await state.ledger!.update({ ...current, editIntent: { ...request, ifMatch: '"r1"', completed: false,
    state: 'outcome-unknown', learningEligible: true, evidenceGeneration: 2 },
    revision: current.revision + 1, updatedAt: Date.now() }, current.revision);
}
test('a legacy server rejection closes the command and permits a new correction', async () => {
  const decision = await claim(true);
  await seedLegacyCloudIntent();
  state.correct.mockRejectedValueOnce(new ClassificationProductError('revision_conflict', 409)).mockResolvedValueOnce(decision);
  await expect(handleCaptureEdit(request)).rejects.toThrow('revision_conflict');
  expect((await state.ledger!.get(task.scope, task.captureId))?.editIntent?.state).toBe('rejected');
  await expect(handleCaptureEdit({ ...request, commandId: 'replacement' })).resolves.toMatchObject({ ok: true });
  expect(move).not.toHaveBeenCalled();
  expect(state.correct).toHaveBeenCalledTimes(2);
});
test('a legacy transient Product-session expiry keeps the correction command replayable after re-auth', async () => {
  const decision = await claim(true);
  await seedLegacyCloudIntent();
  state.correct.mockRejectedValueOnce(new ClassificationProductError('reconnect_required', 401)).mockResolvedValueOnce(decision);
  await expect(handleCaptureEdit(request)).rejects.toThrow('reconnect_required');
  expect((await state.ledger!.get(task.scope, task.captureId))?.editIntent?.state).toBe('outcome-unknown');
  await expect(handleCaptureEdit(request)).resolves.toMatchObject({ ok: true });
  expect(state.correct).toHaveBeenCalledTimes(2);
  const [first, replay] = state.correct.mock.calls;
  expect(replay).toEqual(first);
});

test.each(['guest', 'paused', 'offline', 'unmapped'] as const)('%s: folder and tags persist locally without a Product correction', async mode => {
  state.scope = mode === 'guest' ? { ...task.scope, accountId: null, collectionId: null } : task.scope;
  state.inRange = mode === 'offline' || mode === 'unmapped'; state.mapped = mode !== 'unmapped';
  if (mode === 'offline') vi.stubGlobal('navigator', { onLine: false });
  state.correct.mockRejectedValue(new Error('network_offline'));
  const decision = await claim(mode !== 'guest');
  const annotations = createBookmarkAnnotationStore();
  const [bookmark] = await chrome.bookmarks.get('native-saved');
  await annotations.save(bookmark!, { tags: ['Old'], note: 'Keep my note' });
  await annotations.setPinned(bookmark!, true);
  const result = await handleCaptureEdit({ ...request, tags: [' #Local ', 'Local', 'CaseSensitive'] });
  expect(result.task.editIntent).toMatchObject({ execution: 'native', completed: true });
  expect(result.task.sync).toBe(state.inRange ? 'pending' : 'local-only');
  expect(move).toHaveBeenCalledTimes(1); expect(state.correct).not.toHaveBeenCalled();
  await annotations.close();
  const reopened = createBookmarkAnnotationStore();
  expect(await reopened.get(bookmark!)).toMatchObject({ tags: ['CaseSensitive', 'Local'], note: 'Keep my note', pinned: true,
    tagsSync: { state: 'dirty' } });
  expect(decisionTags({ ...result.task, automatic: result.task.automatic ? {
    ...result.task.automatic, decision: { ...decision, tags: ['Old cloud tag'] } } : undefined })).not.toContain('Old cloud tag');
  await reopened.close();
});

test('a legacy unknown cloud command cannot become a local command when sync is paused', async () => {
  await claim(true); await seedLegacyCloudIntent(); state.inRange = false;
  await expect(handleCaptureEdit(request)).rejects.toThrow('capture_edit_unavailable');
  expect((await state.ledger!.get(task.scope, task.captureId))?.editIntent).toMatchObject({ commandId: 'first', state: 'outcome-unknown' });
  expect(move).not.toHaveBeenCalled(); expect(state.correct).not.toHaveBeenCalled();
});
test('native success followed by interruption replays the same intent without moving twice', async () => {
  await claim();
  move.mockImplementationOnce(async (_id, destination) => { parent = destination.parentId; throw new Error('worker interrupted'); });
  await expect(handleCaptureEdit(request)).rejects.toThrow('worker interrupted');
  await expect(handleCaptureEdit({ ...request, commandId: 'different' })).rejects.toThrow('capture_edit_pending');
  await expect(handleCaptureEdit(request)).resolves.toMatchObject({ ok: true });
  await expect(handleCaptureEdit(request)).resolves.toMatchObject({ ok: true });
  expect(move).toHaveBeenCalledTimes(1);
});

test('a paused native edit stays native after sync resumes and retries without losing independent tags', async () => {
  await claim(true); state.inRange = false;
  const annotations = createBookmarkAnnotationStore();
  const [bookmark] = await chrome.bookmarks.get('native-saved');
  await annotations.save(bookmark!, { tags: ['Old', 'Personal'], note: 'Keep note' });
  move.mockImplementationOnce(async (_id, destination) => { parent = destination.parentId; throw new Error('worker interrupted'); });
  const edit = { ...request, tags: ['Kept'] };
  await expect(handleCaptureEdit(edit)).rejects.toThrow('worker interrupted');
  state.inRange = true;
  await expect(handleCaptureEdit(edit)).resolves.toMatchObject({ ok: true, task: { editIntent: { execution: 'native', completed: true } } });
  expect(move).toHaveBeenCalledTimes(1); expect(state.correct).not.toHaveBeenCalled();
  expect(await annotations.get(bookmark!)).toMatchObject({ tags: ['Kept', 'Personal'], note: 'Keep note' });
  await annotations.close();
});
async function seedLegacyIntent() {
  const current = (await state.ledger!.get(task.scope, task.captureId))!;
  await state.ledger!.update({ ...current, editIntent: { commandId: 'legacy', parentNativeId: 'valid',
    originalParentNativeId: 'original', tags: [], ifMatch: null, completed: false },
    revision: current.revision + 1, updatedAt: Date.now() }, current.revision);
}
const cancel = (editCommandId: string) => ({ kind: 'known.capture.edit.cancel' as const, captureId: task.captureId,
  commandId: crypto.randomUUID(), editCommandId, userGesture: true as const });
test('an unknown-outcome correction can only be abandoned by naming its command, then replaced', async () => {
  await claim();
  move.mockImplementationOnce(async (_id, destination) => { parent = destination.parentId; throw new Error('worker interrupted'); });
  await expect(handleCaptureEdit(request)).rejects.toThrow('worker interrupted');
  await expect(handleCaptureEdit({ ...request, commandId: 'different' })).rejects.toThrow('capture_edit_pending');
  await expect(handleCaptureEditCancel(cancel('other'))).rejects.toThrow('capture_edit_command_changed');
  expect((await state.ledger!.get(task.scope, task.captureId))?.editIntent?.state).toBe('outcome-unknown');
  await expect(handleCaptureEditCancel(cancel('first'))).resolves.toMatchObject({ ok: true });
  expect((await state.ledger!.get(task.scope, task.captureId))?.editIntent)
    .toMatchObject({ commandId: 'first', state: 'cancelled', completed: true });
  await expect(handleCaptureEdit({ ...request, commandId: 'replacement' })).resolves.toMatchObject({ ok: true });
});
test('a legacy pending intent without state blocks other commands and replays its own', async () => {
  await claim();
  await seedLegacyIntent();
  await expect(handleCaptureEdit({ ...request, commandId: 'different' })).rejects.toThrow('capture_edit_pending');
  await expect(handleCaptureEdit({ ...request, commandId: 'legacy' })).resolves.toMatchObject({ ok: true });
  expect((await state.ledger!.get(task.scope, task.captureId))?.editIntent)
    .toMatchObject({ commandId: 'legacy', state: 'completed', completed: true });
  expect(move).toHaveBeenCalledTimes(1);
});
test('a legacy pending intent without state can be abandoned through the explicit entry point', async () => {
  await claim();
  await seedLegacyIntent();
  await expect(handleCaptureEditCancel(cancel('legacy'))).resolves.toMatchObject({ ok: true });
  expect((await state.ledger!.get(task.scope, task.captureId))?.editIntent)
    .toMatchObject({ commandId: 'legacy', state: 'cancelled', completed: true });
  await expect(handleCaptureEdit({ ...request, commandId: 'replacement' })).resolves.toMatchObject({ ok: true });
});
test('the cancel whitelist requires a user gesture naming a well-formed command', () => {
  const base = { kind: 'known.capture.edit.cancel' as const, captureId: crypto.randomUUID(), commandId: crypto.randomUUID(),
    editCommandId: crypto.randomUUID(), userGesture: true as const };
  expect(validCaptureEditCancel(base)).toBe(true);
  expect(validCaptureEditCancel({ ...base, userGesture: false })).toBe(false);
  expect(validCaptureEditCancel({ ...base, editCommandId: 'not-a-uuid' })).toBe(false);
  expect(validCaptureEditCancel({ ...base, extra: 1 })).toBe(false);
});
