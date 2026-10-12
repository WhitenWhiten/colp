// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setAnnotationStore } from '../src/popup-annotations.js';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { BOOKMARK_ANNOTATION_NOTICE } from '../src/bookmark-annotation-notice.js';
import { captureDetail } from '../src/capture/history-detail.js';
import type { CaptureTask } from '../src/capture/contracts.js';
import { task as base } from './fixtures/capture.js';

vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => new Set<string>() }));

const tree = [{ id: '0', title: '', children: [
  { id: '1', parentId: '0', title: 'Bookmarks bar', children: [
    { id: 'research', parentId: '1', title: 'Research', children: [] },
    { id: 'reading', parentId: '1', title: 'Reading', children: [] },
  ] },
] }];
const saved = (over: Partial<CaptureTask> = {}): CaptureTask => ({ ...base, captureId: '11111111-1111-4111-8111-111111111111', save: 'local-saved', classification: 'none', sync: 'local-only',
  nativeId: 'bm', title: 'Agents', url: 'https://example.org/agents', localLocation: { ...base.localLocation!, path: ['Bookmarks bar', 'Research'], nativeId: 'research' } as never, ...over });
type Message = { kind: string; commandId?: string; tags?: string[] };
let send: ReturnType<typeof vi.fn>;
let outcome: (message: Message) => unknown;
/** Capture commands, excluding navigation lookups and notifications of persisted local edits. */
const sent = (): Message[] => send.mock.calls.map((call) => call[0] as Message)
  .filter((message) => message.kind !== 'known.capture.links' && message.kind !== BOOKMARK_ANNOTATION_NOTICE);

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  setAnnotationStore(createBookmarkAnnotationStore());
  outcome = () => ({ ok: true });
  send = vi.fn(async (message: Message) => (message.kind === 'known.capture.links' ? { ok: false } : outcome(message)));
  vi.stubGlobal('chrome', { runtime: { sendMessage: send, getURL: (path: string) => `chrome-extension://x${path}` },
    bookmarks: { get: async () => [{ id: 'bm', parentId: 'research', title: 'Agents', url: 'https://example.org/agents', dateAdded: 5 }], getTree: async () => tree } });
});
afterEach(() => { setAnnotationStore(undefined); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function mount(task: CaptureTask, options: Partial<Parameters<typeof captureDetail>[1]> = {}) {
  const view = captureDetail(task, { close: () => undefined, ...options });
  document.body.append(view);
  return view;
}
const ready = (view: HTMLElement) => vi.waitFor(() => expect(view.querySelector('.folder-pill')).not.toBeNull());
const pick = (view: HTMLElement, id: string) => {
  view.querySelector<HTMLButtonElement>('.folder-pill')!.click();
  view.querySelector<HTMLButtonElement>(`.folder-opt[data-folder-id="${id}"]`)!.click();
};

test('the detail shows the title as its heading, a back button, and the three groups', async () => {
  const view = mount(saved());
  expect(view.querySelector('h1')?.textContent).toBe('Agents');
  expect(view.querySelector('.detail-back')?.textContent).toBe('History');
  await ready(view);
  expect(view.querySelector('.detail-fields .tag-input')).not.toBeNull();
  expect(view.querySelector('.detail-fields textarea')).not.toBeNull();
  expect(view.querySelector('.set-group h2')?.textContent).toBe('What happened');
  expect(view.textContent).not.toMatch(/undefined|local-saved|\bnull\b/u);
});

test('tags and a note are saved locally and notify the worker without sending a capture command', async () => {
  const view = mount(saved());
  await ready(view);
  const input = view.querySelector<HTMLInputElement>('.tag-input input')!;
  input.value = 'research'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const note = view.querySelector<HTMLTextAreaElement>('.detail-fields textarea')!;
  note.value = 'Read the second half'; note.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(view.querySelector<HTMLButtonElement>('.detail-foot .btn-primary')?.hidden).toBe(false));
  view.querySelector<HTMLButtonElement>('.detail-foot .btn-primary')!.click();
  await vi.waitFor(() => expect(view.querySelector('.detail-foot .grow')?.textContent).toBe('Saved.'));
  expect(sent()).toEqual([]);
  expect(send).toHaveBeenCalledWith({ kind: BOOKMARK_ANNOTATION_NOTICE, nativeId: 'bm' });
  const store = createBookmarkAnnotationStore();
  try { expect(await store.get({ id: 'bm', url: 'https://example.org/agents', dateAdded: 5 })).toMatchObject({ tags: ['research'], note: 'Read the second half' }); }
  finally { store.close(); }
});

test('choosing another folder sends the same correction the old editor sent, with the original parent', async () => {
  const view = mount(saved());
  await ready(view);
  pick(view, 'reading');
  view.querySelector<HTMLButtonElement>('.detail-foot .btn-primary')!.click();
  await vi.waitFor(() => expect(sent()).toHaveLength(1));
  expect(sent()[0]).toMatchObject({ kind: 'known.capture.edit', captureId: '11111111-1111-4111-8111-111111111111', parentNativeId: 'reading',
    originalParentNativeId: 'research', tags: [], userGesture: true });
  await vi.waitFor(() => expect(view.querySelector('.detail-status')?.textContent).toContain('Update recorded'));
});

test('overruling the AI pick rates it wrong first, and only decision tags still on the page travel with the correction', async () => {
  const withDecision = saved({ classification: 'applied', appliedRevision: 'r1', decisionId: 'decision',
    automatic: { decision: { tags: ['mcp', 'ai'], path: [], automaticApplied: true } } as never });
  const view = mount(withDecision);
  await ready(view);
  view.querySelector<HTMLButtonElement>('.tag-input .chip-remove')!.click();
  pick(view, 'reading');
  view.querySelector<HTMLButtonElement>('.detail-foot .btn-primary')!.click();
  await vi.waitFor(() => expect(sent()).toHaveLength(2));
  expect(sent()[0]).toMatchObject({ kind: 'known.capture.feedback', feedback: 'explicit_negative', nodeRevision: 'r1' });
  const edit = sent()[1]!;
  expect(edit.kind).toBe('known.capture.edit');
  expect(edit.tags).toEqual(['ai']);
});

test('a conflict or an unconfirmed update is reported in plain words and keeps the choice for a retry', async () => {
  outcome = () => { throw new Error('revision conflict'); };
  const view = mount(saved());
  await ready(view);
  pick(view, 'reading');
  const save = view.querySelector<HTMLButtonElement>('.detail-foot .btn-primary')!;
  save.click();
  await vi.waitFor(() => expect(view.querySelector('.detail-foot .grow')?.textContent).toContain('This bookmark changed'));
  expect(view.textContent).not.toMatch(/undefined|revision conflict/u);
  expect(view.querySelector<HTMLButtonElement>('.folder-pill')!.dataset.value).toBe('reading');
  outcome = () => ({ ok: true });
  save.click();
  await vi.waitFor(() => expect(view.querySelector('.detail-foot .grow')?.textContent).toBe('Saved.'));
  const commands = sent().map(message => message.commandId);
  expect(new Set(commands).size).toBe(1);
});

test('a correction that never confirmed can be discarded explicitly', async () => {
  const stuck = saved({ editIntent: { commandId: '22222222-2222-4222-8222-222222222222', parentNativeId: 'reading', originalParentNativeId: 'research', tags: [], ifMatch: null, completed: false } });
  const view = mount(stuck);
  await ready(view);
  const discard = Array.from(view.querySelectorAll('button')).find(button => button.textContent === 'Discard unconfirmed correction')!;
  discard.click();
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.capture.edit.cancel', editCommandId: '22222222-2222-4222-8222-222222222222', userGesture: true })));
  await vi.waitFor(() => expect(view.querySelector('.inline-alert')).toBeNull());
});

test('a record kept from before sign-in or restored from a backup is read-only', async () => {
  const view = mount(saved(), { readOnly: true });
  expect(view.querySelector('.folder-pill')).toBeNull();
  expect(view.querySelector('.detail-fields textarea')).toBeNull();
  expect(view.querySelector('.inline-alert')?.textContent).toContain('before sign-in');
});

test('a problem save offers its own action and no folder picker without a bookmark', async () => {
  const view = mount(saved({ nativeId: null, save: 'unknown' }));
  expect(view.querySelector('.folder-pill')).toBeNull();
  expect(Array.from(view.querySelectorAll('.detail-actions button')).map(button => button.textContent)).toContain('Check save result');
});
