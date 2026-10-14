// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { bindPopupClassification } from '../src/popup-classification.js';
import { LOCAL_CLASSIFICATION_ENABLED } from '../src/classification-local-session.js';
import type { ClassificationRequest } from '../src/classification-messages.js';
import type { AiTagMode } from '../src/bookmark-preferences.js';
import { mountSuggestShell } from './fixtures/popup-suggest.js';
import { byId } from './fixtures/popup-shell.js';

/** A rule chose the folder: the popup's AI asks for tags only, or nothing (AC-04, R09). */
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

function setup(options: { readonly local: boolean; readonly tagMode: AiTagMode; readonly ruled: () => boolean }) {
  const shell = mountSuggestShell();
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  const sent: ClassificationRequest[] = [];
  vi.stubGlobal('chrome', {
    storage: { onChanged: { addListener: vi.fn() }, local: { get: async () => (options.local ? { [LOCAL_CLASSIFICATION_ENABLED]: true } : {}) } },
    runtime: { sendMessage: async (message: ClassificationRequest) => {
      sent.push(structuredClone(message));
      if (message.kind === 'known.classification.settings') return { ok: true, result: { settings: { autoTagMode: 'suggest', executionMode: 'byok' } } };
      return { ok: true, nativeFolder: null, result: { folder: null, tags: { mode: 'suggest', candidates: [{ tag: 'Papers', selected: true }] },
        candidateCoverage: { l1Included: 0, l1Total: 0, descendantIncluded: 0, descendantTotal: 0 } } };
    } },
  });
  const binding = bindPopupClassification({ fields: [], chip: shell.chip, chipLabel: shell.label, note: shell.note, tags: shell.tags,
    input: () => ({ collectionId: 'library', title: 'A paper', url: 'https://arxiv.org/abs/1' }), inScope: async () => true,
    chooseFolder: async () => true, tagMode: async () => options.tagMode, ruleFolder: options.ruled });
  return { shell, sent, binding };
}

test('the user’s own AI is asked for tags only while a rule holds the folder', async () => {
  let ruled = true;
  const { shell, sent, binding } = setup({ local: true, tagMode: 'suggest', ruled: () => ruled });
  await binding.refresh(undefined);
  expect(shell.chip.hidden).toBe(false);
  expect(shell.label.textContent).toBe('Suggest tags');
  await shell.press();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({ kind: 'known.classification.local-preview', document: { requested: { folder: false, tags: true } } });
  // Suggest offers the tags; the folder pill is left to the rule.
  await vi.waitFor(() => expect(Array.from(byId('tag-suggest').querySelectorAll('button')).map((button) => button.textContent)).toEqual(['Papers']));
  expect(shell.chip.hidden).toBe(true);
  // The user picks their own folder: the chip offers folder suggestions again.
  ruled = false; binding.ruleChanged();
  expect(shell.chip.hidden).toBe(false);
  expect(shell.label.textContent).toBe('Suggest');
});

test('nothing is requested with tags off, or through a Know-N suggestion', async () => {
  const off = setup({ local: true, tagMode: 'off', ruled: () => true });
  await off.binding.refresh(undefined);
  expect(off.shell.chip.hidden).toBe(true);
  expect(off.sent).toHaveLength(0);
  document.body.replaceChildren();
  const cloud = setup({ local: false, tagMode: 'suggest', ruled: () => true });
  await cloud.binding.refresh('library');
  expect(cloud.shell.chip.hidden).toBe(true);
  expect(cloud.sent.filter((message) => message.kind !== 'known.classification.settings')).toHaveLength(0);
});
