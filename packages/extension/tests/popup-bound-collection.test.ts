// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { COLLECTIONS_CACHE } from '../src/collections-cache.js';
import { COLLECTION_BINDING, createBoundCollection, resolveBoundCollection } from '../src/popup-bound-collection.js';
import { paintDestSync } from '../src/popup-dest-sync.js';
import { createPopupNote } from '../src/popup-note.js';

const library = (id: string, title: string) => ({ id, title, kind: 'bookmarks', visibility: 'private' });
const A = '01J0000000000000000000000A';
const B = '01J0000000000000000000000B';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('the stored binding wins, even when the list does not name it', () => {
  expect(resolveBoundCollection([library(A, 'Mine'), library(B, 'Work')], B)).toEqual({ id: B, title: 'Work' });
  expect(resolveBoundCollection([library(A, 'Mine')], B)).toEqual({ id: B, title: '' });
});

test('an unbound account stays local regardless of how many cloud libraries it owns', () => {
  expect(resolveBoundCollection([library(A, 'Mine')], undefined)).toBeUndefined();
  expect(resolveBoundCollection([library(A, 'Mine'), library(B, 'Work')], undefined)).toBeUndefined();
  expect(resolveBoundCollection([], undefined)).toBeUndefined();
});

test('reads the cache first, then follows the worker list without sending a selection', async () => {
  const sendMessage = vi.fn(async (_message: unknown) => ({ ok: true, collections: [library(A, 'Mine'), library(B, 'Work')] }));
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn(async () => ({ [COLLECTION_BINDING]: B })) } },
  });
  const bound = createBoundCollection();
  expect(bound.known()).toBe(false);
  bound.fromCache({ [COLLECTIONS_CACHE]: { accountId: 'u', accountLabel: 'me', fetchedAt: 1,
    collections: [library(A, 'Mine')] } }, 'me');
  expect(bound.known()).toBe(true);
  expect(bound.current()).toBeUndefined();
  await bound.refresh();
  expect(bound.current()).toEqual({ id: B, title: 'Work' });
  expect(bound.libraryCount()).toBe(2);
  expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([{ kind: 'known.collections.list' }]);
});

test('a successful list that omits the stored library clears the binding', async () => {
  let stored: Record<string, unknown> = { [COLLECTION_BINDING]: A };
  const remove = vi.fn(async (key: string) => { delete stored[key]; });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn(async () => ({ ok: true, collections: [library(B, 'Work')] })) },
    storage: { local: { get: vi.fn(async () => ({ ...stored })), remove } },
  });
  const bound = createBoundCollection();
  bound.fromCache({
    [COLLECTIONS_CACHE]: { accountId: 'u', accountLabel: 'me', fetchedAt: 1, collections: [library(A, 'Mine')] },
    [COLLECTION_BINDING]: A,
  }, 'me');
  expect(bound.current()).toEqual({ id: A, title: 'Mine' });
  await bound.refresh();
  expect(bound.current()).toBeUndefined();
  expect(remove).toHaveBeenCalledWith(COLLECTION_BINDING);
});

test('a parsed library list that no longer contains the binding is not a sync target', () => {
  const bound = createBoundCollection();
  bound.fromCache({
    [COLLECTIONS_CACHE]: { accountId: 'u', accountLabel: 'me', fetchedAt: 1, collections: [library(B, 'Work')] },
    [COLLECTION_BINDING]: A,
  }, 'me');
  expect(bound.current()).toBeUndefined();
});

test('a failed refresh keeps the cached answer', async () => {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => { throw new Error('gone'); }) } });
  const bound = createBoundCollection();
  bound.fromCache({ [COLLECTION_BINDING]: A }, undefined);
  await bound.refresh();
  expect(bound.current()).toEqual({ id: A, title: '' });
});

function noteLine() {
  const line = document.createElement('p');
  return { line, note: createPopupNote(line) };
}

test('the passive note says the save stays local and links to sync settings', () => {
  const create = vi.fn();
  vi.stubGlobal('chrome', { tabs: { create }, runtime: { getURL: (path: string) => `chrome-extension://id/${path}` } });
  const { line, note } = noteLine();
  paintDestSync(note, { kind: 'choose-library' });
  expect(line.textContent).toBe('No Know-N sync · Choose what syncs');
  line.querySelector('button')!.click();
  expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://id/options.html#sync/collections' });
  paintDestSync(note, { kind: 'no-library' });
  expect(line.textContent).toBe('No Know-N sync · Set up sync');
});

test('a save that syncs, or has nothing to say, leaves the note empty', () => {
  const { line, note } = noteLine();
  paintDestSync(note, { kind: 'no-library' });
  expect(line.hidden).toBe(false);
  paintDestSync(note, { kind: 'synced' });
  expect(line.textContent).toBe('');
  expect(line.hidden).toBe(true);
  paintDestSync(note, { kind: 'none' });
  expect(line.hidden).toBe(true);
});

test('"Sync this folder…" lands the save first, then deep-links the folder', async () => {
  const create = vi.fn();
  vi.stubGlobal('chrome', { tabs: { create }, runtime: { getURL: (path: string) => `chrome-extension://id/${path}` } });
  const { line, note } = noteLine();
  const requestSave = vi.fn(async () => true);
  paintDestSync(note, { kind: 'local', folderId: 'b 1', requestSave });
  expect(line.textContent).toBe("This folder isn't synced to Know-N · Sync this folder…");
  line.querySelector('button')!.click();
  await vi.waitFor(() => expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://id/options.html#sync/folders?native=b%201' }));
  expect(requestSave.mock.invocationCallOrder[0]!).toBeLessThan(create.mock.invocationCallOrder[0]!);
});

test('a save that does not land keeps the popup open instead of opening settings', async () => {
  const create = vi.fn();
  vi.stubGlobal('chrome', { tabs: { create }, runtime: { getURL: (path: string) => path } });
  const { line, note } = noteLine();
  const requestSave = vi.fn(async () => false);
  paintDestSync(note, { kind: 'local', folderId: 'b', requestSave });
  line.querySelector('button')!.click();
  await vi.waitFor(() => expect(requestSave).toHaveBeenCalledOnce());
  expect(create).not.toHaveBeenCalled();
});
