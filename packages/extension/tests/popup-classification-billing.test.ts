// @vitest-environment happy-dom
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { bindPopupClassification } from '../src/popup-classification.js';
import type { ClassificationRequest } from '../src/classification-messages.js';
import { mountSuggestShell } from './fixtures/popup-suggest.js';

type PreviewRequest = Extract<ClassificationRequest, { kind: 'known.classification.preview' }>;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

async function popup() {
  const shell = mountSuggestShell();
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  const reply = vi.fn().mockResolvedValue({ ok: false, error: 'command_in_progress', sameRequestRetrySafe: true });
  const sent: PreviewRequest[] = [];
  vi.stubGlobal('chrome', { storage: { onChanged: { addListener: vi.fn() } }, runtime: {
    sendMessage: async (message: ClassificationRequest) => {
      if (message.kind === 'known.classification.settings') return { ok: true, result: { settings: { executionMode: 'server_managed', autoTagMode: 'off' } } };
      if (message.kind !== 'known.classification.preview') throw new Error('Unexpected message');
      sent.push(structuredClone(message)); return reply();
    },
  } });
  const price = vi.fn().mockResolvedValue({ priceVersion: 'v1', unitPoints: 1 });
  let input = { collectionId: 'library', title: 'Example', url: 'https://example.org' };
  const binding = bindPopupClassification({ input: () => input, inScope: async () => true, chooseFolder: async () => true, fields: [],
    getManagedPrice: price, chip: shell.chip, chipLabel: shell.label, note: shell.note, tags: shell.tags });
  await binding.refresh('library');
  return { ...shell, sent, price, reply, binding, setInput: (next: typeof input) => { input = next; },
    async click() { expect(shell.chip.disabled).toBe(false); const count = sent.length; await shell.press();
      await vi.waitFor(() => { expect(sent).toHaveLength(count + 1); expect(shell.label.textContent).not.toBe('Suggesting…'); }); } };
}

test('the cost is one note line, only while Know-N credits are about to be spent', async () => {
  const f = await popup();
  expect(f.line.textContent).toBe('Uses 1 credit');
  f.price.mockResolvedValue({ priceVersion: 'v2', unitPoints: 4 });
  f.reply.mockResolvedValueOnce({ ok: true, nativeFolder: null, result: { folder: { decision: 'later' }, tags: { candidates: [] }, candidateCoverage: {} } });
  await f.click();
  // Spent: the chip is gone and so is the sentence about the cost.
  expect(f.line.textContent).toBe('No folder suggested. Keep your chosen folder or pick another.');
  expect(f.line.textContent).not.toContain('credit');
});

test('sends the displayed price, not an unseen higher quote at click time', async () => {
  const f = await popup();
  f.price.mockResolvedValue({ priceVersion: 'v2', unitPoints: 2 });
  await f.click();
  expect(f.sent[0]!.document.billing).toEqual({ priceVersion: 'v1', maxPoints: 1 });
  expect(f.price).toHaveBeenCalledTimes(1);
});

test.each(['price-change', 'price-offline'] as const)('retries the entire original command with %s', async scenario => {
  const f = await popup(); await f.click();
  expect(f.label.textContent).toBe('Check again');
  if (scenario === 'price-change') f.price.mockResolvedValue({ priceVersion: 'v2', unitPoints: 2 });
  else f.price.mockRejectedValue(new TypeError('Offline'));
  f.setInput({ collectionId: 'library', title: 'Changed automatically', url: 'https://example.org/changed' });
  await f.click();
  expect(f.sent).toHaveLength(2);
  expect(f.sent[1]).toEqual(f.sent[0]);
  expect(f.price).toHaveBeenCalledTimes(1);
});

test('shows a changed server price and waits for a new click before a new command', async () => {
  const f = await popup();
  f.reply.mockResolvedValueOnce({ ok: false, error: 'credit_price_changed', sameRequestRetrySafe: false });
  f.price.mockResolvedValue({ priceVersion: 'v2', unitPoints: 2 });
  await f.click();
  await vi.waitFor(() => expect(f.line.textContent).toContain('Uses 2 credits'));
  expect(f.sent).toHaveLength(1);
  await f.click();
  expect(f.sent[1]!.commandId).not.toBe(f.sent[0]!.commandId);
  expect(f.sent[1]!.document.billing).toEqual({ priceVersion: 'v2', maxPoints: 2 });
});

test('the popup stylesheet never hides the note line that carries the cost', async () => {
  // happy-dom replaces URL, so new URL('../popup.css', import.meta.url) is http://localhost:3000/popup.css.
  const css = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../popup.css'), 'utf8');
  for (const match of css.matchAll(/([^{}]+)\{[^}]*display:\s*none[^}]*\}/g)) {
    assert.doesNotMatch(match[1]!, /#pp-note\b(?!\[hidden\])/);
  }
});

test('an explicit input reset creates a new intent', async () => {
  const f = await popup(); await f.click();
  f.binding.reset();
  f.setInput({ collectionId: 'library', title: 'New bookmark', url: 'https://example.org/new' });
  await f.click();
  expect(f.sent[1]!.commandId).not.toBe(f.sent[0]!.commandId);
  expect(f.sent[1]!.document).toMatchObject({ bookmark: { title: 'New bookmark' } });
});
