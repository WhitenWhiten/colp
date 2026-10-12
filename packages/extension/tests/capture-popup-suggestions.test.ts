// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { initializeCapturePopup } from '../src/capture/popup.js';
import type { CaptureTask } from '../src/capture/contracts.js';
import { LOCAL_CLASSIFICATION_ENABLED } from '../src/classification-local-session.js';
import { bindPopupFields } from '../src/popup-fields.js';
import { createPopupNote } from '../src/popup-note.js';
import { setAnnotationStore, type AnnotationStore } from '../src/popup-annotations.js';
import { task as base } from './fixtures/capture.js';
import { byId, mountPopupShell } from './fixtures/popup-shell.js';

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  setAnnotationStore(undefined); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren();
});

test('the automatic popup moves its saved bookmark to the alternative the retry returns', async () => {
  mountPopupShell({ mode: 'pending' });
  const query = `?surface=${crypto.randomUUID()}`;
  vi.stubGlobal('location', { href: `https://example.org/popup.html${query}`, search: query });
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  const buttons = ['folder-retry', 'folder-suggest'] as const;
  const clicks = new Map<string, (event: { isTrusted: boolean }) => void>();
  for (const id of buttons) {
    const button = byId<HTMLButtonElement>(id), original = button.addEventListener.bind(button);
    vi.spyOn(button, 'addEventListener').mockImplementation((type: string, callback: unknown, options?: unknown) => {
      if (type === 'click') clicks.set(id, callback as (event: { isTrusted: boolean }) => void);
      original(type, callback as EventListener, options as boolean);
    });
  }
  setAnnotationStore({ get: async () => null, save: async () => null, tagCounts: async () => [], close: () => undefined } as unknown as AnnotationStore);
  let parent = '100';
  let current: CaptureTask = { ...base, captureId: crypto.randomUUID(), nativeId: '42', save: 'local-saved', classification: 'applied',
    scope: { ...base.scope, accountId: null, collectionId: null }, sync: 'local-only',
    local: { commandId: crypto.randomUUID(), state: 'applied', folderNativeId: '100' } };
  const requests: { kind: string; parentNativeId?: string; document?: unknown }[] = [];
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({ [LOCAL_CLASSIFICATION_ENABLED]: true }) }, onChanged: { addListener: vi.fn() } },
    tabs: { query: async () => [{ url: current.url, title: current.title }] },
    bookmarks: { get: async (id: string) => id === '42' ? [{ id, parentId: parent, url: current.url }]
      : [{ id, title: id === '100' ? 'Recipes' : 'Italian' }] },
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() }, sendMessage: async (message: { kind: string; parentNativeId?: string }) => {
      requests.push(structuredClone(message));
      switch (message.kind) {
        case 'known.bookmark.preferences.local': return { ok: true, preferences: { captureMode: 'automatic', resultPanelAutoDismissMs: 0 } };
        case 'known.capture.context': return { ok: true, actionPopup: true };
        case 'known.capture.start': case 'known.capture.get': return { ok: true, task: current };
        case 'known.classification.local-preview': return { ok: true, nativeFolder: { folderId: '200', nativeId: '200', title: 'Italian' },
          result: { folder: { decision: 'l1_root', folderId: '200' }, tags: { candidates: [] }, candidateCoverage: { l1Included: 1 } } };
        case 'known.capture.edit':
          parent = message.parentNativeId!;
          current = { ...current, classification: 'manual', reason: 'classification_corrected' };
          return { ok: true, task: current };
        default: throw new Error(`Unexpected ${message.kind}`);
      }
    } },
  });
  const fields = bindPopupFields(() => undefined), note = createPopupNote(byId('pp-note'));
  const folders = { userPicked: () => false, setParentVisible: vi.fn(),
    adopt: async (id: string) => { byId('dest-folder').textContent = id === '100' ? 'Recipes' : 'Italian'; } };
  expect(await initializeCapturePopup({ fields, note, folders: folders as never, onPick: () => undefined })).toBe(true);
  await vi.waitFor(() => expect(byId('folder-retry').hidden).toBe(false));
  expect(document.body.dataset.captureMode).toBe('automatic');
  expect(byId('ai-mark').hidden).toBe(false);
  clicks.get('folder-retry')!({ isTrusted: true });
  // Retrying turns the current pick down: its answer replaces it without a second click.
  await vi.waitFor(() => expect(parent).toBe('200'));
  expect(requests.find(message => message.kind === 'known.classification.local-preview')).toMatchObject({
    document: { rejectedFolderIds: ['100'], requested: { folder: true, tags: false } } });
  await vi.waitFor(() => expect(byId('folder-suggest').hidden).toBe(true));
  expect(requests.filter(message => message.kind === 'known.capture.edit')).toHaveLength(1);
  expect(requests.filter(message => message.kind === 'known.capture.start')).toHaveLength(1);
  expect(byId('dest-folder').textContent).toBe('Italian');
  expect(byId('ai-mark').hidden).toBe(false);
  expect(byId('folder-retry').hidden).toBe(false);
  expect(byId('capture-alert').hidden).toBe(true);
});
