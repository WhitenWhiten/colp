// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { bindPopupClassification } from '../src/popup-classification.js';
import { LOCAL_CLASSIFICATION_ENABLED } from '../src/classification-local-session.js';
import type { ClassificationRequest } from '../src/classification-messages.js';
import { mountSuggestShell } from './fixtures/popup-suggest.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

test('local mode suggests and selects a browser folder while signed out, with no collection', async () => {
  const shell = mountSuggestShell();
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  const sent: ClassificationRequest[] = [];
  vi.stubGlobal('chrome', {
    storage: { onChanged: { addListener: vi.fn() }, local: { get: async () => ({ [LOCAL_CLASSIFICATION_ENABLED]: true }) } },
    runtime: { sendMessage: async (message: ClassificationRequest) => {
      sent.push(structuredClone(message));
      if (message.kind !== 'known.classification.local-preview') throw new Error(`Unexpected ${message.kind}`);
      return { ok: true, nativeFolder: { folderId: '42', nativeId: '42', title: 'Recipes' },
        result: { folder: { decision: 'suggest', folderId: '42' }, tags: { mode: 'off', candidates: [] },
          candidateCoverage: { l1Included: 1, l1Total: 1, descendantIncluded: 0, descendantTotal: 0 } } };
    } },
  });
  const chosen: [string, boolean][] = [];
  const binding = bindPopupClassification({ fields: [], chip: shell.chip, chipLabel: shell.label, note: shell.note, tags: shell.tags,
    // Signed out: the page input has no collection.
    input: () => ({ title: 'Pasta', url: 'https://example.org/pasta' }),
    inScope: async () => false, chooseFolder: async (id, anyFolder) => { chosen.push([id, anyFolder]); return true; } });
  await binding.refresh(undefined);

  // The own-service chip is offered without an account, and says where the page goes only as a tooltip.
  expect(shell.chip.hidden).toBe(false);
  expect(shell.label.textContent).toBe('Suggest');
  expect(shell.chip.title).toBe('Suggestions are sent directly to your own AI service.');
  expect(shell.line.hidden).toBe(true);
  await shell.press();
  await vi.waitFor(() => expect(shell.label.textContent).toBe('Recipes'));
  // No collection, account or billing: only the local-first message is sent.
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ kind: 'known.classification.local-preview' });
  expect(sent[0]).not.toHaveProperty('collectionId');

  await shell.press();
  expect(chosen).toEqual([['42', true]]);
});

test('with no AI available the chip and the note stay out of the popup', async () => {
  const shell = mountSuggestShell();
  vi.stubGlobal('chrome', { storage: { onChanged: { addListener: vi.fn() }, local: { get: async () => ({}) } },
    runtime: { sendMessage: async () => ({ ok: false, error: 'unavailable' }) } });
  const binding = bindPopupClassification({ fields: [], chip: shell.chip, chipLabel: shell.label, note: shell.note, tags: shell.tags,
    input: () => ({ title: 'Pasta', url: 'https://example.org/pasta' }), inScope: async () => true, chooseFolder: async () => true });
  await binding.refresh(undefined);
  await binding.refresh('library');
  expect(shell.chip.hidden).toBe(true);
  expect(shell.line.hidden).toBe(true);
});
