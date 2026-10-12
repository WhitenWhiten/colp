// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CaptureTask } from '../src/capture/contracts.js';
import { setAnnotationStore, type AnnotationStore } from '../src/popup-annotations.js';
import { bindPopupFields } from '../src/popup-fields.js';
import { bindResultFields } from '../src/popup-result-fields.js';
import { mountPopupShell } from './fixtures/popup-shell.js';
import { task as base } from './fixtures/capture.js';

const saved = (over: Partial<CaptureTask> = {}): CaptureTask => ({ ...base, nativeId: '42', save: 'local-saved', classification: 'applied',
  decisionId: 'decision', appliedRevision: 'rev', sync: 'syncing', url: 'https://example.org/p', ...over });

let parent: string;
let moved: (id: string, info: { parentId: string }) => void;
let picked: boolean;
const folders = { userPicked: () => picked, adopt: vi.fn(async () => undefined), setParentVisible: vi.fn() };

beforeEach(() => {
  mountPopupShell({ mode: 'automatic' });
  setAnnotationStore({ get: async () => null, save: async () => null, tagCounts: async () => [], close: () => undefined } as unknown as AnnotationStore);
  parent = 'saved-in';
  picked = false;
  folders.adopt.mockClear();
  vi.stubGlobal('chrome', { bookmarks: {
    get: vi.fn(async () => [{ id: '42', parentId: parent, dateAdded: 1 }]),
    onMoved: { addListener: (listener: typeof moved) => { moved = listener; } },
  } });
});
afterEach(() => { setAnnotationStore(undefined); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function bind(fields = bindPopupFields(() => undefined)) {
  return bindResultFields({ folders: folders as never, fields, preview: false });
}

test('the pill names the folder the bookmark was saved in, then the one the AI moved it to once sync lands', async () => {
  const result = bind();
  await result.sync(saved({ classification: 'running', appliedRevision: null, sync: 'pending' }));
  expect(folders.adopt).toHaveBeenLastCalledWith('saved-in');
  // The decision is applied, but the native bookmark has not moved yet.
  await result.sync(saved());
  expect(folders.adopt).toHaveBeenLastCalledWith('saved-in');
  // Sync confirms with no other change to the task: the bookmark now lives somewhere else.
  parent = 'software-development';
  await result.sync(saved({ sync: 'confirmed' }));
  expect(folders.adopt).toHaveBeenLastCalledWith('software-development');
});

test('a move reported by the browser repaints the pill without waiting for the next task update', async () => {
  const result = bind();
  await result.sync(saved());
  moved('42', { parentId: 'software-development' });
  expect(folders.adopt).toHaveBeenLastCalledWith('software-development');
  moved('other-bookmark', { parentId: 'elsewhere' });
  expect(folders.adopt).toHaveBeenLastCalledWith('software-development');
});

test('once the user picked a folder neither a task update nor a browser move overrides it', async () => {
  const result = bind();
  await result.sync(saved());
  picked = true;
  folders.adopt.mockClear();
  parent = 'software-development';
  await result.sync(saved({ sync: 'confirmed' }));
  moved('42', { parentId: 'software-development' });
  expect(folders.adopt).not.toHaveBeenCalled();
});

test('a confirmed alternative remains selected while its cloud correction is still syncing', async () => {
  const result = bind();
  await result.sync(saved());
  result.markSuggested();
  folders.adopt.mockClear();
  await result.sync(saved({ classification: 'manual', sync: 'syncing' }));
  expect(folders.adopt).not.toHaveBeenCalled();
  expect(document.getElementById('ai-mark')!.hidden).toBe(false);
  parent = 'alternative';
  await result.sync(saved({ classification: 'manual', sync: 'confirmed' }));
  expect(folders.adopt).toHaveBeenLastCalledWith('alternative');
});

test('a manual folder pick clears the alternative AI mark even before its correction finishes', async () => {
  const result = bind();
  await result.sync(saved());
  result.markSuggested();
  picked = true;
  await result.sync(saved({ classification: 'manual' }));
  expect(document.getElementById('ai-mark')!.hidden).toBe(true);
});

test.each([
  ['own AI', { local: { commandId: 'c', state: 'applied', folderNativeId: 'saved-in', suggestedTags: ['Cooking'] } }],
  ['Know-N', { automatic: { decision: { suggestedTags: ['Cooking'], tags: [] } } }],
] as const)('%s suggested tags are offered as chips and join the bookmark only when clicked', async (_source, over) => {
  const fields = bindPopupFields(() => undefined), result = bind(fields);
  await result.sync(saved(over as unknown as Partial<CaptureTask>));
  const chips = () => Array.from(document.getElementById('tag-suggest')!.querySelectorAll('button'));
  expect(chips().map(chip => chip.textContent)).toEqual(['Cooking']);
  expect(fields.tags.tags()).toEqual([]);
  expect(result.editedAnnotation()).toBeUndefined();
  chips()[0]!.click();
  expect(fields.tags.tags()).toEqual(['Cooking']);
  expect(result.editedAnnotation()?.annotation.tags).toEqual(['Cooking']);
});
