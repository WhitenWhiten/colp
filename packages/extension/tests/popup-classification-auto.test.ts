// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { bindPopupClassification } from '../src/popup-classification.js';
import { MANUAL_CLASSIFICATION_AUTO } from '../src/manual-classification.js';
import { LOCAL_CLASSIFICATION_ENABLED } from '../src/classification-local-session.js';
import { validClassificationRequest, type ClassificationRequest } from '../src/classification-messages.js';
import { byId } from './fixtures/popup-shell.js';
import { mountSuggestShell } from './fixtures/popup-suggest.js';
import type { AiTagMode } from '../src/bookmark-preferences.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); delete document.body.dataset.captureMode; });

function popup({ local = true, auto = true, mode = 'manual', tagMode = 'add' as AiTagMode } = {}) {
  const shell = mountSuggestShell(mode);
  const field = document.createElement('input'); document.body.append(field);
  const values: Record<string, unknown> = { [MANUAL_CLASSIFICATION_AUTO]: auto, [LOCAL_CLASSIFICATION_ENABLED]: local };
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  const sent: ClassificationRequest[] = [];
  const reply = vi.fn().mockResolvedValue({ ok: true, nativeFolder: { folderId: '42', nativeId: '42', title: 'Recipes' },
    result: { folder: { decision: 'suggest', folderId: '42' }, tags: { mode: 'suggest', candidates: [{ tag: 'Cooking' }] },
      candidateCoverage: { l1Included: 1, l1Total: 1, descendantIncluded: 0, descendantTotal: 0 } } });
  const get = vi.fn(async (key: string) => ({ [key]: values[key] }));
  vi.stubGlobal('chrome', { storage: { local: { get }, onChanged: { addListener: vi.fn() } }, runtime: {
    sendMessage: async (message: ClassificationRequest) => {
      if (message.kind === 'known.classification.settings') return { ok: true, result: { settings: { executionMode: 'server_managed', autoTagMode: 'suggest' } } };
      sent.push(structuredClone(message)); return reply();
    },
  } });
  const chooseFolder = vi.fn(async () => true), inScope = vi.fn(async () => true);
  const folderPicked = vi.fn(() => false);
  const applied = vi.fn();
  const price = vi.fn(async () => ({ priceVersion: 'v1', unitPoints: 1 }));
  const binding = bindPopupClassification({ fields: [field], chip: shell.chip, chipLabel: shell.label, note: shell.note, tags: shell.tags,
    input: () => ({ ...(local ? {} : { collectionId: 'library' }), title: 'Pasta', url: 'https://example.org/pasta' }),
    chooseFolder, folderPicked, inScope, getManagedPrice: price, onApplied: applied, retry: byId<HTMLButtonElement>('folder-retry'),
    tagMode: async () => tagMode });
  return { ...shell, binding, sent, reply, values, get, field, chooseFolder, folderPicked, price, inScope, applied };
}

test.each([{ auto: false }, { mode: 'automatic' }])('opening with %j leaves classification waiting for a click', async settings => {
  const f = popup(settings); await f.binding.refresh(undefined);
  expect(f.sent).toEqual([]);
  expect(f.chip.hidden).toBe(false);
  expect(f.label.textContent).toBe('Suggest');
});

test('manual local suggestions fill the folder and tags for one save confirmation', async () => {
  const f = popup(); await f.binding.refresh(undefined);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({ kind: 'known.classification.local-preview', automatic: true });
  expect(f.sent[0]).not.toHaveProperty('userGesture');
  expect(validClassificationRequest(f.sent[0])).toBe(true);
  expect(f.chooseFolder).toHaveBeenCalledExactlyOnceWith('42', true);
  expect(f.applied).toHaveBeenCalledOnce();
  expect(f.binding.selectedTags()).toEqual(['Cooking']);
  expect(f.chip.hidden).toBe(true);
  // The accepted AI tag is a chip in the tag field, not a checkbox.
  expect(f.tags.tags()).toEqual(['Cooking']);
  expect(byId('tag-field').querySelector('.chip')?.textContent).toBe('Cooking');
  f.tags.remove('Cooking');
  expect(f.binding.selectedTags()).toEqual([]);
  await f.binding.refresh(undefined, true);
  expect(f.sent).toHaveLength(1);
  f.field.dispatchEvent(new Event('input'));
  await f.binding.refresh(undefined, true);
  expect(f.sent).toHaveLength(1);
});

test('Suggest offers the selected tags as chips to click and leaves the field alone', async () => {
  const f = popup({ tagMode: 'suggest' });
  f.reply.mockResolvedValue({ ok: true, nativeFolder: { folderId: '42', nativeId: '42', title: 'Recipes' },
    result: { folder: { decision: 'suggest', folderId: '42' }, candidateCoverage: {},
      tags: { mode: 'suggest', candidates: [{ tag: 'Cooking', noul: 0.9, selected: true }, { tag: 'Travel', noul: 0.2, selected: false }] } } });
  await f.binding.refresh(undefined);
  expect(f.sent[0]).toMatchObject({ document: { requested: { folder: true, tags: true } } });
  expect(f.chooseFolder).toHaveBeenCalledOnce();
  expect(f.tags.tags()).toEqual([]);
  // Only the tag the classifier selected is offered; the unconvincing one is not.
  expect(Array.from(byId('tag-suggest').querySelectorAll('button')).map(button => button.textContent)).toEqual(['Cooking']);
});

test('Off asks for no tags at all', async () => {
  const f = popup({ tagMode: 'off' });
  await f.binding.refresh(undefined);
  expect(f.sent[0]).toMatchObject({ document: { requested: { folder: true, tags: false } } });
  expect(f.tags.tags()).toEqual([]);
  expect(byId('tag-suggest').querySelectorAll('button')).toHaveLength(0);
});

test('Add fills the tags when the user asks for a suggestion, not only when the form opens', async () => {
  const f = popup({ auto: false });
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  await f.binding.refresh(undefined);
  expect(f.sent).toEqual([]);
  await f.press();
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  await vi.waitFor(() => expect(f.tags.tags()).toEqual(['Cooking']));
  // A clicked suggestion still waits for its folder chip to be applied.
  expect(f.chooseFolder).not.toHaveBeenCalled();
  expect(f.label.textContent).toBe('Recipes');
});

test('server suggestions retain the displayed billing quote and fill mapped results', async () => {
  const f = popup({ local: false }); await f.binding.refresh('library');
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({ kind: 'known.classification.preview', automatic: true,
    document: { billing: { priceVersion: 'v1', maxPoints: 1 }, requested: { folder: true, tags: true } } });
  expect(validClassificationRequest(f.sent[0])).toBe(true);
  // No sentence about selecting a folder: the pill changes and the AI mark appears.
  expect(f.line.hidden).toBe(true);
  expect(f.binding.selectedTags()).toEqual(['Cooking']);
  expect(f.chooseFolder).toHaveBeenCalledExactlyOnceWith('42', false);
  expect(f.chip.hidden).toBe(true);
});

test('automatic results keep a folder the user chose while classification was pending', async () => {
  const f = popup();
  let resolve!: (reply: unknown) => void;
  f.reply.mockImplementation(() => new Promise(value => { resolve = value; }));
  const refreshing = f.binding.refresh(undefined);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  expect(f.label.textContent).toBe('Suggesting…');
  expect(f.chip.getAttribute('aria-busy')).toBe('true');
  f.folderPicked.mockReturnValue(true);
  resolve({ ok: true, nativeFolder: { folderId: '42', nativeId: '42', title: 'Recipes' },
    result: { folder: { decision: 'suggest', folderId: '42' }, tags: { candidates: [] }, candidateCoverage: {} } });
  await refreshing;
  expect(f.chooseFolder).not.toHaveBeenCalled();
  expect(f.chip.hidden).toBe(true);
});

test('accepted suggested tags beyond three are kept out of the cloud selection', async () => {
  const f = popup();
  f.reply.mockResolvedValue({ ok: true, nativeFolder: null,
    result: { folder: { decision: 'later' }, tags: { candidates: ['A', 'B', 'C', 'D'].map(tag => ({ tag })) }, candidateCoverage: {} } });
  await f.binding.refresh(undefined);
  expect(f.binding.selectedTags()).toEqual(['A', 'B', 'C']);
  // The fourth stays a suggestion chip until the user accepts it.
  const suggestions = Array.from(byId('tag-suggest').querySelectorAll('button')).map(button => button.textContent);
  expect(suggestions).toEqual(['D']);
  f.tags.remove('A');
  Array.from(byId('tag-suggest').querySelectorAll('button')).find(button => button.textContent === 'D')!.click();
  expect(f.tags.tags()).toEqual(['B', 'C', 'D']);
  expect(f.binding.selectedTags()).toEqual(['B', 'C', 'D']);
  expect(f.chooseFolder).not.toHaveBeenCalled();
  expect(f.line.textContent).toBe('No folder suggested. Keep your chosen folder or pick another.');
});

test('an unavailable suggested folder leaves manual saving available and says so once', async () => {
  const f = popup(); f.chooseFolder.mockResolvedValue(false);
  await f.binding.refresh(undefined);
  expect(f.line.textContent).toContain('Choose a folder manually.');
  expect(f.chip.hidden).toBe(true);
  expect(f.applied).not.toHaveBeenCalled();
});

test.each([true, false])('a later result with candidates offers a forced folder-only retry in local=%s', async local => {
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  const f = popup({ local });
  f.reply.mockResolvedValueOnce({ ok: true, nativeFolder: null, result: { folder: { decision: 'later' },
    tags: { candidates: [{ tag: 'keep' }] }, candidateCoverage: { l1Included: 2 } } });
  await f.binding.refresh(local ? undefined : 'library');
  expect(f.label.textContent).toBe('Suggest again');
  expect(f.chip.hidden).toBe(false);
  f.reply.mockResolvedValueOnce({ ok: false, error: 'command_in_progress', sameRequestRetrySafe: true });
  await f.press();
  await vi.waitFor(() => expect(f.label.textContent).toBe('Check again'));
  expect(f.sent[1]).toMatchObject({ userGesture: true,
    document: { folderSelectionMode: 'require_candidate', requested: { folder: true, tags: false } } });
  const commands = f.sent.map(message => 'commandId' in message ? message.commandId : undefined);
  expect(commands[1]).not.toBe(commands[0]);
  await f.press();
  await vi.waitFor(() => expect(f.chip.dataset.state).toBe('apply'));
  expect(f.sent[2]).toEqual(f.sent[1]);
  expect(f.tags.tags()).toEqual(['keep']);
  expect(f.chooseFolder).not.toHaveBeenCalled();
  await f.press();
  await vi.waitFor(() => expect(f.chooseFolder).toHaveBeenCalledOnce());
});

test('a suggestion that is not applied automatically becomes a folder chip a click applies', async () => {
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  const f = popup({ auto: false });
  await f.binding.refresh(undefined);
  expect(f.label.textContent).toBe('Suggest');
  await f.press();
  await vi.waitFor(() => expect(f.label.textContent).toBe('Recipes'));
  expect(f.chip.dataset.state).toBe('apply');
  expect(f.chooseFolder).not.toHaveBeenCalled();
  await f.press();
  expect(f.chooseFolder).toHaveBeenCalledExactlyOnceWith('42', true);
  expect(f.applied).toHaveBeenCalledOnce();
  expect(f.chip.hidden).toBe(true);
});

test('an uncertain automatic result does not automatically retry or create a second charge', async () => {
  const f = popup({ local: false }); f.reply.mockResolvedValue({ ok: false, error: 'command_in_progress', sameRequestRetrySafe: true });
  await f.binding.refresh('library');
  expect(f.sent).toHaveLength(1);
  // The chip offers the same request again, in the error tone.
  expect(f.label.textContent).toBe('Check again');
  expect(f.line.dataset.tone).toBe('error');
  await f.binding.refresh('library', true);
  expect(f.sent).toHaveLength(1);
});

test('an edit while the browser preference is loading prevents an automatic request', async () => {
  const f = popup();
  let resolve!: (value: Record<string, unknown>) => void;
  f.get.mockImplementation(key => key === MANUAL_CLASSIFICATION_AUTO
    ? new Promise(value => { resolve = value; }) : Promise.resolve({ [key]: f.values[key] }));
  const refreshing = f.binding.refresh(undefined);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  f.field.dispatchEvent(new Event('input')); resolve({ [MANUAL_CLASSIFICATION_AUTO]: true });
  await refreshing; expect(f.sent).toEqual([]);
});

test.each(['already_saved', 'existence_unavailable', 'session_limit'])('a worker skip (%s) leaves an explicit Suggest action without modifying the form', async skipped => {
  const f = popup(); f.reply.mockResolvedValue({ ok: true, skipped });
  await f.binding.refresh(undefined);
  expect(f.chooseFolder).not.toHaveBeenCalled();
  expect(f.tags.tags()).toEqual([]);
  expect(f.line.hidden).toBe(true);
  expect(f.chip.dataset.state).toBe('run');
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  f.reply.mockResolvedValue({ ok: true, nativeFolder: null, result: { folder: { decision: 'later' }, tags: { candidates: [] }, candidateCoverage: { l1Included: 0 } } });
  await f.press();
  await vi.waitFor(() => expect(f.sent).toHaveLength(2));
  expect(f.sent[1]).toMatchObject({ userGesture: true });
  expect(f.sent[1]).not.toHaveProperty('automatic');
});

test('an explicit check after reopening uses the command chosen by the worker', async () => {
  const f = popup({ local: false }), commandId = crypto.randomUUID();
  f.reply.mockResolvedValueOnce({ ok: false, commandId, error: 'command_in_progress', sameRequestRetrySafe: true });
  await f.binding.refresh('library');
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  await f.press();
  await vi.waitFor(() => expect(f.sent).toHaveLength(2));
  expect(f.sent[1]).toMatchObject({ commandId, userGesture: true });
  expect(f.sent[1]).not.toHaveProperty('automatic');
});

test('automatic preview messages reject mixed triggers, absent consent and existing-node requests', () => {
  const message = { kind: 'known.classification.preview', automatic: true, collectionId: 'library', commandId: crypto.randomUUID(),
    document: { source: 'extension', bookmark: { title: 'Pasta', url: 'https://example.org/pasta', description: null }, requested: { folder: true, tags: false } } };
  expect(validClassificationRequest(message)).toBe(true);
  expect(validClassificationRequest({ ...message, userGesture: true })).toBe(false);
  expect(validClassificationRequest({ ...message, automatic: false })).toBe(false);
  expect(validClassificationRequest({ ...message, document: { source: 'extension', nodeId: 'existing', requested: message.document.requested } })).toBe(false);
  const forced = { ...message, document: { ...message.document, folderSelectionMode: 'require_candidate',
    rejectedFolderIds: ['a'], billing: { priceVersion: 'v1', maxPoints: 1 } } };
  expect(validClassificationRequest(forced)).toBe(false);
  const { automatic: _automatic, ...explicit } = forced;
  expect(validClassificationRequest({ ...explicit, userGesture: true })).toBe(true);
});
