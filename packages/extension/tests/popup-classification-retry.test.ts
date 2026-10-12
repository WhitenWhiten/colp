// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { bindPopupClassification } from '../src/popup-classification.js';
import { MANUAL_CLASSIFICATION_AUTO } from '../src/manual-classification.js';
import { LOCAL_CLASSIFICATION_ENABLED } from '../src/classification-local-session.js';
import { validClassificationRequest, type ClassificationRequest } from '../src/classification-messages.js';
import { byId } from './fixtures/popup-shell.js';
import { mountSuggestShell } from './fixtures/popup-suggest.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

const folderReply = (folderId: string, title: string, tag = 'Cooking') => ({ ok: true, nativeFolder: { folderId, nativeId: folderId, title },
  result: { folder: { decision: 'l1_root', folderId }, tags: { mode: 'suggest', candidates: [{ tag }] },
    candidateCoverage: { l1Included: 1, l1Total: 1, descendantIncluded: 0, descendantTotal: 0 } } });

/** The manual popup after its automatic suggestion put "Recipes" in the folder pill. */
async function applied({ local = true } = {}) {
  const shell = mountSuggestShell();
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  const retry = byId<HTMLButtonElement>('folder-retry');
  let click: ((event: { isTrusted: boolean }) => unknown) | undefined;
  const original = retry.addEventListener.bind(retry);
  vi.spyOn(retry, 'addEventListener').mockImplementation((type: string, handler: unknown) => {
    if (type === 'click') click = handler as typeof click;
    original(type, handler as EventListener);
  });
  const field = document.createElement('input'); document.body.append(field);
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  const values: Record<string, unknown> = { [MANUAL_CLASSIFICATION_AUTO]: true, [LOCAL_CLASSIFICATION_ENABLED]: local };
  const sent: ClassificationRequest[] = [];
  const reply = vi.fn().mockResolvedValueOnce(folderReply('42', 'Recipes'));
  vi.stubGlobal('chrome', { storage: { local: { get: async (key: string) => ({ [key]: values[key] }) }, onChanged: { addListener: vi.fn() } }, runtime: {
    sendMessage: async (message: ClassificationRequest) => {
      if (message.kind === 'known.classification.settings') return { ok: true, result: { settings: { executionMode: 'server_managed', autoTagMode: 'suggest' } } };
      if (message.kind === 'known.classification.folder') return { ok: true, nativeFolder: { folderId: message.folderId, nativeId: message.folderId, title: 'x' } };
      sent.push(structuredClone(message)); return reply();
    },
  } });
  const chooseFolder = vi.fn(async () => true), onApplied = vi.fn();
  const binding = bindPopupClassification({ fields: [field], chip: shell.chip, chipLabel: shell.label, note: shell.note, tags: shell.tags, retry,
    input: () => ({ ...(local ? {} : { collectionId: 'library' }), title: 'Pasta', url: 'https://example.org/pasta' }),
    chooseFolder, folderPicked: () => false, inScope: async () => true, onApplied, tagMode: async () => 'add',
    getManagedPrice: async () => ({ priceVersion: 'v1', unitPoints: 1 }) });
  await binding.refresh(local ? undefined : 'library');
  const press = () => click!({ isTrusted: true });
  /** Click "suggest another" and wait until its request has settled. */
  const again = async () => {
    const count = sent.length; press();
    await vi.waitFor(() => { expect(sent).toHaveLength(count + 1); expect(retry.hasAttribute('aria-busy')).toBe(false); });
  };
  return { ...shell, binding, retry, field, sent, reply, chooseFolder, onApplied, pressRetry: press, again };
}

test('suggest another turns down the applied folder and applies a different one in its place', async () => {
  const f = await applied();
  expect(f.onApplied).toHaveBeenCalledOnce();
  expect(f.retry.hidden).toBe(false);
  expect(f.retry.getAttribute('aria-label')).toBe('Suggest another folder');

  f.reply.mockResolvedValueOnce(folderReply('7', 'Italian', 'Pasta'));
  await f.again();
  expect(f.sent).toHaveLength(2);
  expect(f.sent[1]).toMatchObject({ kind: 'known.classification.local-preview', userGesture: true,
    document: { requested: { folder: true, tags: false }, rejectedFolderIds: ['42'] } });
  expect(f.sent[1]).not.toHaveProperty('automatic');
  expect(validClassificationRequest(f.sent[1])).toBe(true);
  // The new folder replaces the old pick at once; the tags already chosen stay as they were.
  expect(f.chip.hidden).toBe(true);
  expect(f.chooseFolder).toHaveBeenLastCalledWith('7', true);
  expect(f.onApplied).toHaveBeenCalledTimes(2);
  expect(f.tags.tags()).toEqual(['Cooking']);
  expect(f.retry.hidden).toBe(false);

  // Not that one either: both folders are turned down.
  f.reply.mockResolvedValueOnce(folderReply('9', 'Quick meals'));
  await f.again();
  expect(f.sent[2]).toMatchObject({ document: { rejectedFolderIds: ['42', '7'] } });
  expect(f.chooseFolder).toHaveBeenLastCalledWith('9', true);
  expect(f.onApplied).toHaveBeenCalledTimes(3);
  expect(f.chip.hidden).toBe(true);
});

test('the retry spins in place of the chip while it runs', async () => {
  const f = await applied();
  let finish!: (value: unknown) => void;
  f.reply.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  f.pressRetry();
  await vi.waitFor(() => expect(f.retry.getAttribute('aria-busy')).toBe('true'));
  expect(f.retry.disabled).toBe(true);
  expect(f.chip.hidden).toBe(true);
  finish(folderReply('7', 'Italian'));
  await vi.waitFor(() => expect(f.retry.hasAttribute('aria-busy')).toBe(false));
  expect(f.retry.disabled).toBe(false);
});

test('an alternative that cannot be applied keeps the earlier pick and says so', async () => {
  const f = await applied();
  f.chooseFolder.mockResolvedValueOnce(false);
  f.reply.mockResolvedValueOnce(folderReply('7', 'Italian'));
  await f.again();
  expect(f.chooseFolder).toHaveBeenLastCalledWith('7', true);
  expect(f.onApplied).toHaveBeenCalledOnce();
  expect(f.line.textContent).toBe('This folder is no longer available. Choose a folder manually.');
  expect(f.chip.hidden).toBe(true);
  expect(f.retry.hidden).toBe(false);
});

test('when nothing else fits the applied folder stays and the note says so', async () => {
  const f = await applied();
  f.reply.mockResolvedValueOnce({ ok: true, nativeFolder: null, result: { folder: { decision: 'later', folderId: null }, tags: { mode: 'off', candidates: [] },
    candidateCoverage: { l1Included: 0, l1Total: 0, descendantIncluded: 0, descendantTotal: 0 } } });
  await f.again();
  expect(f.line.textContent).toBe('No other folder fits. Keep this one or pick another.');
  expect(f.chip.hidden).toBe(true);
  expect(f.retry.hidden).toBe(true);
  const count = f.sent.length;
  f.pressRetry();
  expect(f.sent).toHaveLength(count);
});

test('a model later result with remaining candidates still allows another suggestion', async () => {
  const f = await applied();
  f.reply.mockResolvedValueOnce({ ok: true, nativeFolder: null, result: { folder: { decision: 'later', folderId: null },
    tags: { candidates: [] }, candidateCoverage: { l1Included: 2 } } });
  await f.again();
  expect(f.retry.hidden).toBe(false);
});

test('the rejection cap preserves an uncertain command until its receipt is checked', async () => {
  const f = await applied({ local: false });
  for (let i = 0; i < 7; i++) {
    f.reply.mockResolvedValueOnce(folderReply(`alternative-${i}`, `Folder ${i}`));
    await f.again();
  }
  f.reply.mockResolvedValueOnce({ ok: false, error: 'command_in_progress', sameRequestRetrySafe: true });
  await f.again();
  const pending = f.sent.at(-1)!;
  expect(pending).toMatchObject({ document: { rejectedFolderIds: expect.any(Array) } });
  expect('document' in pending && pending.document.rejectedFolderIds).toHaveLength(8);
  expect(f.retry.hidden).toBe(false);
  expect(f.retry.title).toContain('Check again');
  f.reply.mockResolvedValueOnce(folderReply('last', 'Last folder'));
  await f.again();
  expect(f.sent.at(-1)).toEqual(pending);
  expect(f.retry.hidden).toBe(true);
  expect(f.chip.hidden).toBe(true);
  expect(f.chooseFolder).toHaveBeenLastCalledWith('last', false);
});

test('a retry-safe failure resends the identical command and editing the page drops the retry', async () => {
  const f = await applied({ local: false });
  expect(f.retry.title).toBe('Suggest another folder · Uses 1 credit');
  f.reply.mockResolvedValueOnce({ ok: false, error: 'provider_unavailable', sameRequestRetrySafe: true });
  await f.again();
  expect(f.chip.hidden).toBe(true);
  expect(f.retry.hidden).toBe(false);
  f.reply.mockResolvedValueOnce(folderReply('7', 'Italian'));
  await f.again();
  expect(f.sent[2]).toEqual(f.sent[1]);
  expect(f.sent[1]).toMatchObject({ kind: 'known.classification.preview', document: { rejectedFolderIds: ['42'], billing: { maxPoints: 1 } } });
  expect(validClassificationRequest(f.sent[1])).toBe(true);

  f.field.dispatchEvent(new Event('input'));
  expect(f.retry.hidden).toBe(true);
});

test('turned-down folder lists stay closed and bounded', () => {
  const base = { kind: 'known.classification.local-preview', commandId: crypto.randomUUID(), userGesture: true,
    document: { source: 'extension', bookmark: { title: 'Pasta', url: 'https://example.org/', description: null }, requested: { folder: true, tags: false } } };
  const withIds = (rejectedFolderIds: unknown) => ({ ...base, document: { ...base.document, rejectedFolderIds } });
  expect(validClassificationRequest(withIds(['1', '2']))).toBe(true);
  for (const ids of [[], ['1', '1'], [''], [1], Array.from({ length: 9 }, (_, i) => `${i}`), '1']) expect(validClassificationRequest(withIds(ids))).toBe(false);
});
