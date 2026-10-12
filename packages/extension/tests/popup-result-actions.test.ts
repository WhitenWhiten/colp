// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const bookmarks = vi.hoisted(() => ({ update: vi.fn(async () => undefined), move: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ personalBookmarks: bookmarks }));

import type { CaptureTask } from '../src/capture/contracts.js';
import { setAnnotationStore, type AnnotationStore } from '../src/popup-annotations.js';
import { bindPopupFields } from '../src/popup-fields.js';
import { createPopupNote } from '../src/popup-note.js';
import { createResultActions } from '../src/popup-result-actions.js';
import { bindResultFields } from '../src/popup-result-fields.js';
import { bindPopupPin } from '../src/popup-pin.js';
import { byId, mountPopupShell } from './fixtures/popup-shell.js';
import { task as base } from './fixtures/capture.js';

const saved = (over: Partial<CaptureTask> = {}): CaptureTask => ({ ...base, nativeId: '42', save: 'local-saved', classification: 'applied',
  decisionId: 'decision', appliedRevision: 'rev', title: 'Page', url: 'https://example.org/p',
  automatic: { decision: { tags: ['ai-tag'] } } as unknown as CaptureTask['automatic'], ...over });

const store = { get: vi.fn(async () => null), save: vi.fn(async () => null), tagCounts: vi.fn(async () => []), close: vi.fn() };
let request: ReturnType<typeof vi.fn>;
let folders: { userPicked: ReturnType<typeof vi.fn>; adopt: ReturnType<typeof vi.fn>; setParentVisible: ReturnType<typeof vi.fn> };
let latest: CaptureTask | undefined;

function setup(preview = false, folderId = () => 'ai-folder') {
  mountPopupShell({ mode: 'automatic' });
  const pin = bindPopupPin({ button: byId<HTMLButtonElement>('folder-pin'), hint: byId('folder-pin-hint') }, folderId);
  const note = createPopupNote(byId('pp-note'));
  const fields = bindPopupFields(() => undefined);
  folders = { userPicked: vi.fn(() => false), adopt: vi.fn(async () => undefined), setParentVisible: vi.fn() };
  const resultFields = bindResultFields({ folders: folders as never, fields, preview, pin });
  const close = vi.fn(); const show = vi.fn();
  const actions = createResultActions({ preview, request: request as never, current: () => latest, show, note, fields, resultFields,
    folders: folders as never, pin, close });
  return { actions, note, fields, resultFields, close, show, pin };
}

beforeEach(() => {
  Object.values(bookmarks).forEach((mock) => mock.mockClear());
  Object.values(store).forEach((mock) => mock.mockClear());
  setAnnotationStore(store as unknown as AnnotationStore);
  request = vi.fn(async () => ({ ok: true }));
  latest = undefined;
  vi.stubGlobal('chrome', {
    bookmarks: { get: vi.fn(async () => [{ id: '42', parentId: 'ai-folder', dateAdded: 9 }]) },
    tabs: { create: vi.fn(async () => ({})) }, runtime: { getURL: (path: string) => path },
  });
  Object.defineProperty(navigator, 'userActivation', { value: { isActive: true }, configurable: true });
});
afterEach(() => { setAnnotationStore(undefined); vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('Done rates the AI folder as right, then closes', async () => {
  const { actions } = setup();
  const task = saved();
  expect(await actions.done(task)).toBe(true);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.capture.feedback', feedback: 'explicit_positive', captureId: task.captureId }));
});

test('Done sends no rating when there was no AI decision', async () => {
  const { actions } = setup();
  expect(await actions.done(saved({ classification: 'none', decisionId: null }))).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

test('Done after a correction does not rate the AI folder as right', async () => {
  const { actions, resultFields } = setup();
  resultFields.markCorrected();
  expect(await actions.done(saved())).toBe(true);
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ feedback: 'explicit_positive' }));
});

test('a rating that cannot be saved keeps the popup open once, then lets Done through', async () => {
  const { actions, note } = setup();
  request.mockRejectedValue(new Error('offline'));
  expect(await actions.done(saved())).toBe(false);
  expect(note.current()).toBe('feedback');
  expect(await actions.done(saved())).toBe(true);
});

test('Done saves the tags and note the user changed, keyed by the saved bookmark', async () => {
  const { actions, fields, resultFields } = setup();
  const task = saved();
  await resultFields.sync(task);
  expect(fields.tags.tags()).toEqual(['ai-tag']);
  fields.tags.add('mine');
  fields.annotation.write({ tags: fields.tags.tags(), note: 'a note' });
  byId<HTMLTextAreaElement>('note-text').dispatchEvent(new Event('input'));
  expect(await actions.done(task)).toBe(true);
  expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ id: '42', url: task.url }),
    { tags: ['ai-tag', 'mine'], note: 'a note' }, { preserveTags: true, base: { tags: ['ai-tag'], note: '', sourceTags: [] } });
});

test('Done leaves the annotation store alone when nothing was edited', async () => {
  const { actions, resultFields } = setup();
  const task = saved();
  await resultFields.sync(task);
  expect(await actions.done(task)).toBe(true);
  expect(store.save).not.toHaveBeenCalled();
});

test('Done reports a failed save instead of closing', async () => {
  const { actions, fields, resultFields, note } = setup();
  const task = saved({ classification: 'none', decisionId: null });
  await resultFields.sync(task);
  store.save.mockRejectedValueOnce(new Error('idb'));
  fields.tags.add('x');
  expect(await actions.done(task)).toBe(false);
  expect(note.current()).toBe('feedback');
});

test('an edited title is written to the bookmark on Done', async () => {
  const { actions, resultFields } = setup();
  const task = saved({ classification: 'none', decisionId: null });
  await resultFields.sync(task);
  const title = byId<HTMLTextAreaElement>('tab-title');
  title.value = 'Better title'; title.dispatchEvent(new Event('input'));
  await actions.done(task);
  expect(bookmarks.update).toHaveBeenCalledWith('42', { title: 'Better title' });
});

test('Undo removes the native bookmark and reports it', async () => {
  const { actions } = setup();
  const task = saved();
  expect(await actions.undo(task)).toBe(true);
  expect(bookmarks.remove).toHaveBeenCalledWith('42');
  // The worker is told afterwards, so History stops showing the capture as saved.
  expect(request).toHaveBeenCalledWith({ kind: 'known.capture.remove', captureId: task.captureId, userGesture: true });
  expect(bookmarks.remove.mock.invocationCallOrder[0]!).toBeLessThan(request.mock.invocationCallOrder[0]!);
});

test('Undo still succeeds when the worker cannot record the removal, and a preview records nothing', async () => {
  const { actions } = setup();
  request.mockRejectedValue(new Error('worker asleep'));
  expect(await actions.undo(saved())).toBe(true);
  const sample = setup(true);
  request.mockClear();
  expect(await sample.actions.undo(saved())).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

test('Undo fails visibly when the bookmark cannot be removed', async () => {
  const { actions, note } = setup();
  bookmarks.remove.mockRejectedValueOnce(new Error('blocked'));
  expect(await actions.undo(saved())).toBe(false);
  expect(note.current()).toBe('feedback');
});

test('Remove and restore of an existing bookmark use the durable deletion journal', async () => {
  const send = vi.fn().mockResolvedValueOnce({ ok: true, preview: { digest: 'digest' } })
    .mockResolvedValueOnce({ ok: true, status: { planId: 'plan', commandId: 'original-command', applied: 1 } })
    .mockResolvedValueOnce({ ok: true, status: { undone: 1 } });
  chrome.runtime.sendMessage = send;
  const { actions } = setup();
  const existing = saved({ disposition: 'existing', nativeId: null,
    existence: { kind: 'local', exact: [{ nativeId: 'existing', writable: true }], similar: [], coverage: {} } as never });
  expect(await actions.remove(existing)).toBe(true);
  expect(send).toHaveBeenNthCalledWith(1, { kind: 'known.batch.preview', operation: 'delete', nativeIds: ['existing'] });
  expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'known.batch.confirm', nativeIds: ['existing'], previewDigest: 'digest' }));
  expect(bookmarks.remove).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(await actions.restore()).toBe(true);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'known.batch.undo', planId: 'plan', commandId: 'original-command' }));
});

test('a failed deletion or restore is reported and leaves the action retryable', async () => {
  const send = vi.fn().mockResolvedValueOnce({ ok: false });
  chrome.runtime.sendMessage = send;
  const { actions, note } = setup();
  const existing = saved({ disposition: 'existing', nativeId: null,
    existence: { kind: 'local', exact: [{ nativeId: 'existing', writable: true }], similar: [], coverage: {} } as never });
  expect(await actions.remove(existing)).toBe(false);
  expect(note.current()).toBe('feedback');
  send.mockResolvedValueOnce({ ok: true, preview: { digest: 'digest' } }).mockResolvedValueOnce({ ok: true, status: { planId: 'plan', applied: 1 } });
  expect(await actions.remove(existing)).toBe(true);
  send.mockResolvedValueOnce({ ok: false });
  expect(await actions.restore()).toBe(false);
  send.mockResolvedValueOnce({ ok: true, status: { undone: 1 } });
  expect(await actions.restore()).toBe(true);
});

test('Remove refuses multiple copies, read-only bookmarks, and preview mode', async () => {
  const send = vi.fn(); chrome.runtime.sendMessage = send;
  const { actions } = setup();
  for (const exact of [[{ nativeId: 'existing', writable: false }], [{ nativeId: 'a', writable: true }, { nativeId: 'b', writable: true }]]) {
    expect(await actions.remove(saved({ disposition: 'existing', existence: { exact } as never }))).toBe(false);
  }
  const preview = setup(true);
  expect(await preview.actions.remove(saved({ disposition: 'existing', existence: { exact: [{ nativeId: 'existing', writable: true }] } as never }))).toBe(false);
  expect(send).not.toHaveBeenCalled();
});

test('picking a folder rates the AI folder wrong once and sends a stable correction', async () => {
  const { actions, show } = setup();
  const task = saved();
  latest = task;
  request.mockResolvedValue({ ok: true, task: { ...task, revision: 2 } });
  expect(await actions.pick('chosen')).toBe(true);
  expect(await actions.pick('chosen')).toBe(true);
  const kinds = request.mock.calls.map(([message]) => (message as { kind: string; feedback?: string }).kind + ((message as { feedback?: string }).feedback ?? ''));
  expect(kinds.filter((kind) => kind === 'known.capture.feedbackexplicit_negative')).toHaveLength(1);
  const edits = request.mock.calls.map(([message]) => message as { kind: string; commandId: string; parentNativeId: string; originalParentNativeId: string })
    .filter((message) => message.kind === 'known.capture.edit');
  expect(edits).toHaveLength(2);
  expect(edits[0]).toMatchObject({ parentNativeId: 'chosen', originalParentNativeId: 'ai-folder' });
  expect(edits[0]!.commandId).toBe(edits[1]!.commandId);
  expect(show).toHaveBeenCalled();
});

test('a correction that was refused names the problem and does not mark the pick as the user\'s', async () => {
  const { actions, note, resultFields } = setup();
  latest = saved();
  request.mockImplementation(async (message: { kind: string }) => {
    if (message.kind === 'known.capture.edit') throw new Error('precondition_failed');
    return { ok: true };
  });
  expect(await actions.pick('chosen')).toBe(false);
  expect(note.current()).toBe('feedback');
  expect(folders.adopt).toHaveBeenCalledWith('ai-folder');
  expect(resultFields.wasCorrected()).toBe(false);
});

test('picking the folder the bookmark is already in does nothing', async () => {
  const { actions } = setup();
  latest = saved();
  await actions.pick('ai-folder');
  expect(request).not.toHaveBeenCalled();
});

test('an already-saved page defers its move to Done', async () => {
  const { actions } = setup();
  latest = saved({ disposition: 'existing', classification: 'none', decisionId: null });
  await actions.pick('elsewhere');
  expect(request).not.toHaveBeenCalled();
  expect(await actions.done(latest)).toBe(true);
  expect(bookmarks.move).toHaveBeenCalledWith('42', { parentId: 'elsewhere' });
});

test('History opens the history route, but a preview sends and opens nothing', async () => {
  const live = setup();
  live.actions.history(saved());
  await vi.waitFor(() => { expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'options.html#history' }); });
  const sample = setup(true);
  vi.mocked(chrome.tabs.create).mockClear();
  sample.actions.history(saved());
  expect(await sample.actions.done(saved())).toBe(true);
  await sample.actions.present(saved());
  expect(chrome.tabs.create).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

test('presenting a result tells the worker only when there is a server decision', async () => {
  const { actions } = setup();
  await actions.present(saved({ decisionId: null }));
  expect(request).not.toHaveBeenCalled();
  await actions.present(saved());
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.capture.presented' }));
});

test('the countdown running out sends the implicit rating; dismissal sends the unrated one', async () => {
  const { actions } = setup();
  await actions.timedOut(saved());
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ feedback: 'implicit_positive' }));
  request.mockClear();
  actions.dismissed(saved());
  await vi.waitFor(() => { expect(request).toHaveBeenCalledWith(expect.objectContaining({ feedback: 'dismissed_unrated' })); });
});

test('the result shows the saved pin and sends a pin changed in the panel on Done, after the folder move', async () => {
  const send = vi.fn(async (message: { kind: string }) => message.kind === 'known.bookmarks.pin.status'
    ? { ok: true, folders: { 'ai-folder': [] } } : { ok: true, blockers: [] });
  chrome.runtime.sendMessage = send as never;
  const { actions, resultFields, pin } = setup();
  const task = saved({ disposition: 'existing', existence: { exact: [{ nativeId: '42', writable: true }] } as never });
  latest = task;
  await resultFields.sync(task);
  await pin.refresh();
  const button = byId<HTMLButtonElement>('folder-pin');
  expect(button.hidden).toBe(false);
  expect(button.getAttribute('aria-pressed')).toBe('false');
  // Done without touching the pin sends nothing.
  expect(await actions.done(task)).toBe(true);
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.bookmarks.pin.set' }));
  await actions.pick('other-folder');
  button.click();
  expect(await actions.done(task)).toBe(true);
  expect(bookmarks.move).toHaveBeenCalledWith('42', { parentId: 'other-folder' });
  expect(send).toHaveBeenCalledWith({ kind: 'known.bookmarks.pin.set', userGesture: true, nativeId: '42', pinned: true });
  expect(bookmarks.move.mock.invocationCallOrder[0]!).toBeLessThan(send.mock.invocationCallOrder.at(-1)!);
});

test('a bookmark saved pinned shows its pin in the result, and a refused change keeps the panel open', async () => {
  store.get.mockResolvedValueOnce({ nativeId: '42', url: 'https://example.org/p', tags: [], note: null, pinned: true, updatedAt: 1, version: 1 } as never);
  const send = vi.fn(async (message: { kind: string }) => message.kind === 'known.bookmarks.pin.status'
    ? { ok: true, folders: { 'ai-folder': [] } } : { ok: false, error: 'pin_failed' });
  chrome.runtime.sendMessage = send as never;
  const { actions, resultFields, pin, note } = setup();
  const task = saved();
  await resultFields.sync(task);
  await pin.refresh();
  const button = byId<HTMLButtonElement>('folder-pin');
  expect(button.getAttribute('aria-pressed')).toBe('true');
  button.click();
  expect(await actions.done(task)).toBe(false);
  expect(note.current()).toBe('feedback');
});
