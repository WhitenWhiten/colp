// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import type { CaptureTask } from '../src/capture/contracts.js';
import { LOCAL_CLASSIFICATION_ENABLED } from '../src/classification-local-session.js';
import { bindPopupFields } from '../src/popup-fields.js';
import { createPopupNote } from '../src/popup-note.js';
import { setAnnotationStore, type AnnotationStore } from '../src/popup-annotations.js';
import { bindResultFields } from '../src/popup-result-fields.js';
import { bindResultSuggestions } from '../src/popup-result-suggestions.js';
import { byId, mountPopupShell } from './fixtures/popup-shell.js';
import { task as base } from './fixtures/capture.js';

afterEach(() => { setAnnotationStore(undefined); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

function trustedClick(button: HTMLButtonElement) {
  let handler: ((event: { isTrusted: boolean }) => void) | undefined;
  const original = button.addEventListener.bind(button);
  vi.spyOn(button, 'addEventListener').mockImplementation((type: string, callback: unknown, options?: unknown) => {
    if (type === 'click') handler = callback as typeof handler;
    original(type, callback as EventListener, options as boolean);
  });
  return () => handler!({ isTrusted: true });
}

function setup(local = true, preview = false) {
  mountPopupShell({ mode: 'automatic' });
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  setAnnotationStore({ get: async () => null, save: async () => null, tagCounts: async () => [], close: () => undefined } as unknown as AnnotationStore);
  const retry = byId<HTMLButtonElement>('folder-retry'), chip = byId<HTMLButtonElement>('folder-suggest');
  const pressRetry = trustedClick(retry), pressChip = trustedClick(chip);
  let current: CaptureTask = { ...base, nativeId: '42', save: 'local-saved', classification: 'applied', sync: 'confirmed',
    ...(local ? { scope: { ...base.scope, accountId: null, collectionId: null }, decisionId: null,
      local: { commandId: 'local', state: 'applied', folderNativeId: '100' } }
      : { decisionId: 'decision', appliedRevision: 'rev', automatic: { decision: { parentId: 'folder-original', tags: ['AI'] } } as CaptureTask['automatic'] }) };
  const note = createPopupNote(byId('pp-note')), fields = bindPopupFields(() => undefined);
  const folders = { userPicked: vi.fn(() => false), setParentVisible: vi.fn(),
    adopt: vi.fn(async (id: string) => { byId('dest-folder').textContent = id === '200' ? 'Italian' : 'Recipes'; }) };
  let parent = '100';
  const sent: { kind: string; document?: { rejectedFolderIds?: string[] }; commandId?: string }[] = [];
  const reply = vi.fn(async () => ({ ok: true, nativeFolder: { folderId: local ? '200' : 'folder-new', nativeId: '200', title: 'Italian' },
    result: { folder: { decision: 'l1_root', folderId: local ? '200' : 'folder-new' }, tags: { candidates: [] }, candidateCoverage: { l1Included: 1 } } }));
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({ [LOCAL_CLASSIFICATION_ENABLED]: local }) }, onChanged: { addListener: vi.fn() } },
    bookmarks: { get: async (id: string) => id === '42' ? [{ id, parentId: parent, url: current.url }]
      : [{ id, title: id === '100' ? 'Recipes' : 'Italian' }] },
    runtime: { sendMessage: async (message: { kind: string; folderId?: string }) => {
      if (message.kind === 'known.classification.settings') return { ok: true, result: { settings: { executionMode: 'server_managed', autoTagMode: 'off' } } };
      if (message.kind === 'known.classification.folder') return { ok: true, nativeFolder: { folderId: message.folderId,
        nativeId: message.folderId === 'folder-original' ? '100' : '200', title: 'Folder' } };
      sent.push(structuredClone(message)); return reply();
    } },
  });
  const resultFields = bindResultFields({ folders: folders as never, fields, preview });
  const apply = vi.fn(async (id: string) => { parent = id; current = { ...current, classification: 'manual', reason: 'classification_corrected' }; return true; });
  const pause = vi.fn(), price = vi.fn(async () => ({ priceVersion: 'v1', unitPoints: 1 }));
  const binding = bindResultSuggestions({ preview, current: () => current, fields, note, folders: folders as never,
    getManagedPrice: price, apply, pause, onApplied: resultFields.markSuggested });
  return { binding, retry, chip, fields, note, folders, resultFields, apply, pause, sent, reply, price,
    pressRetry, pressChip, current: () => current,
    setTask: (next: CaptureTask) => { current = next; },
    async sync() { await resultFields.sync(current); await binding.sync(current); },
  };
}

test.each([true, false])('an automatic %s result moves to another folder on retry without another capture', async local => {
  const f = setup(local); await f.sync();
  expect(f.retry.hidden).toBe(false);
  expect(f.sent).toEqual([]);
  expect(f.apply).not.toHaveBeenCalled();
  f.fields.tags.setTags(['keep']);
  f.pressRetry();
  await vi.waitFor(() => expect(f.apply).toHaveBeenCalledExactlyOnceWith('200'));
  expect(f.pause).toHaveBeenCalledOnce();
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({ kind: local ? 'known.classification.local-preview' : 'known.classification.preview',
    document: { rejectedFolderIds: [local ? '100' : 'folder-original'], requested: { folder: true, tags: false } } });
  expect(f.fields.tags.tags()).toEqual(['keep']);
  await vi.waitFor(() => expect(f.chip.hidden).toBe(true));
  expect(f.resultFields.wasCorrected()).toBe(true);
  expect(byId('ai-mark').hidden).toBe(false);
  await f.sync();
  expect(byId('ai-mark').hidden).toBe(false);
  expect(f.retry.hidden).toBe(false);
  expect(f.sent).toHaveLength(1);
  f.binding.dispose();
});

test('an uncertain correction keeps the alternative chip available to check the same edit', async () => {
  const f = setup(); await f.sync();
  f.apply.mockResolvedValueOnce(false);
  f.pressRetry();
  await vi.waitFor(() => expect(f.chip.dataset.state).toBe('apply'));
  expect(f.apply).toHaveBeenCalledOnce();
  expect(f.chip.hidden).toBe(false);
  expect(f.resultFields.wasCorrected()).toBe(false);
  f.pressChip();
  await vi.waitFor(() => expect(f.chip.hidden).toBe(true));
  expect(f.apply.mock.calls.map(([id]) => id)).toEqual(['200', '200']);
  expect(f.sent).toHaveLength(1);
  f.binding.dispose();
});

test('cloud results wait for native sync before exposing another suggestion', async () => {
  const f = setup(false), task = f.current();
  f.setTask({ ...task, sync: 'syncing' });
  await f.sync();
  expect(f.retry.hidden).toBe(true);
  expect(f.price).not.toHaveBeenCalled();
  f.setTask(task); await f.sync();
  expect(f.retry.hidden).toBe(false);
  f.binding.dispose();
});

test('a manual pick cancels an in-flight alternative and keeps subsequent polling from restoring it', async () => {
  const f = setup(); await f.sync();
  let finish!: (value: Awaited<ReturnType<typeof f.reply>>) => void;
  f.reply.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  f.pressRetry();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  f.binding.picked();
  finish({ ok: true, nativeFolder: { folderId: '200', nativeId: '200', title: 'Italian' },
    result: { folder: { decision: 'l1_root', folderId: '200' }, tags: { candidates: [] }, candidateCoverage: { l1Included: 1 } } });
  await f.sync();
  expect(f.retry.hidden).toBe(true);
  expect(f.chip.hidden).toBe(true);
  expect(f.apply).not.toHaveBeenCalled();
  expect(f.binding.active()).toBe(false);
});

test('the Options preview never seeds or sends a live retry', async () => {
  const f = setup(true, true); await f.sync();
  expect(f.retry.hidden).toBe(true);
  expect(f.sent).toEqual([]);
  expect(f.price).not.toHaveBeenCalled();
});

test.each([undefined, 2])('a saved later result with candidate count %s offers an explicit candidate-only retry', async folderCandidateCount => {
  const f = setup(), task = f.current();
  f.setTask({ ...task, classification: 'manual', reason: 'local_no_folder',
    local: { commandId: 'local', state: 'later', folderCandidateCount } });
  await f.sync();
  expect(f.chip.hidden).toBe(false);
  expect(byId('folder-suggest-label').textContent).toBe('Suggest again');
  expect(f.sent).toEqual([]);
  f.pressChip();
  await vi.waitFor(() => expect(f.chip.dataset.state).toBe('apply'));
  expect(f.sent[0]).toMatchObject({ document: { folderSelectionMode: 'require_candidate', requested: { folder: true, tags: false } } });
  expect(f.apply).not.toHaveBeenCalled();
  f.pressChip();
  await vi.waitFor(() => expect(f.apply).toHaveBeenCalledExactlyOnceWith('200'));
  f.binding.dispose();
});

test.each([true, false])('an automatic classification failure offers a folder-only retry in local=%s', async local => {
  const f = setup(local), task = f.current();
  f.setTask({ ...task, automaticIntent: true, classification: 'manual',
    reason: local ? 'local_provider_unavailable' : 'outcome_unknown',
    ...(local ? { local: { commandId: 'spent', state: 'unknown' } } : {}) });
  await f.sync();
  expect(f.chip.hidden).toBe(false);
  expect(byId('folder-suggest-label').textContent).toBe('Try again');
  expect(f.sent).toEqual([]);
  f.fields.tags.setTags(['keep']);
  f.pressChip();
  await vi.waitFor(() => expect(f.chip.dataset.state).toBe('apply'));
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({ document: { requested: { folder: true, tags: false } } });
  expect(f.fields.tags.tags()).toEqual(['keep']);
  expect(f.apply).not.toHaveBeenCalled();
  f.binding.dispose();
});

test.each(['manual', 'paused', 'manually_edited', 'classification_undone'])('a deliberate stop %s does not offer a retry', async reason => {
  const f = setup(), task = f.current();
  f.setTask({ ...task, classification: 'manual', reason, local: { commandId: 'local', state: 'unknown' } });
  await f.sync();
  expect(f.chip.hidden).toBe(true);
  f.binding.dispose();
});

test('editing a saved title keeps the explicit retry available and invalidates the old request', async () => {
  const f = setup(), task = f.current();
  f.setTask({ ...task, classification: 'manual', reason: 'local_no_folder', local: { commandId: 'local', state: 'later' } });
  await f.sync();
  const title = byId<HTMLTextAreaElement>('tab-title');
  title.value = 'Updated title'; title.dispatchEvent(new Event('input'));
  expect(f.chip.hidden).toBe(false);
  expect(byId('folder-suggest-label').textContent).toBe('Suggest again');
  f.pressChip();
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  expect(f.sent[0]).toMatchObject({ document: { bookmark: { title: 'Updated title' }, folderSelectionMode: 'require_candidate' } });
  f.binding.dispose();
});

test('a saved later result with no candidates offers no paid retry', async () => {
  const f = setup(), task = f.current();
  f.setTask({ ...task, classification: 'manual', reason: 'local_no_folders',
    local: { commandId: 'local', state: 'later', folderCandidateCount: 0 } });
  await f.sync();
  expect(f.chip.hidden).toBe(true);
  expect(f.sent).toEqual([]);
  f.binding.dispose();
});
