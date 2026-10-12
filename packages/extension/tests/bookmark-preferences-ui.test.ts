import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test, vi } from 'vitest';
import { bindBookmarkPreferences } from '../src/bookmark-preferences-ui.js';

// Toasts need a real document; these tests drive the binder with a minimal fake.
vi.mock('../src/toast.js', () => ({ showToast: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
});

/* The bare minimum of an element the binder touches: switches and radios keep their state in aria-checked. */
class FakeElement {
  disabled = false; hidden = false; textContent = ''; value = ''; tabIndex = 0;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: unknown) => void>();
  addEventListener(name: string, listener: (event: unknown) => void) { this.listeners.set(name, listener); }
  dispatch(name: string) { this.listeners.get(name)?.({ preventDefault() {}, key: '' }); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  click() { this.dispatch('click'); }
  focus() {}
}

test('Options exposes both preference controls and explicit conflict choices', async () => {
  const html = await readFile(new URL('../options.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../src/bookmark-preferences-ui.ts', import.meta.url), 'utf8');
  assert.match(html, /id="bookmark-insert-top"/u);
  assert.match(html, /id="bookmark-insert-bottom"/u);
  assert.match(html, /id="bookmark-folders-first"/u);
  assert.match(html, /Also reorders your browser bookmarks/u);
  assert.match(html, /Turning this off stops sorting without restoring the previous order/u);
  assert.match(html, /bookmark-preferences-use-server/u);
  assert.match(html, /bookmark-preferences-use-local/u);
  assert.match(source, /known\.bookmark\.preferences\.get/u);
  assert.match(source, /resolve\('server'\)/u);
  assert.match(source, /resolve\('local'\)/u);
  assert.match(source, /requestVersion/u);
});

test.each(['position', 'folders'] as const)('editing %s during initial refresh submits only the edited field', async (field) => {
  const elements = Object.fromEntries([
    'bookmark-insert-top', 'bookmark-insert-bottom', 'bookmark-folders-first',
    'bookmark-preferences-status', 'bookmark-preferences-use-server', 'bookmark-preferences-use-local',
  ].map((id) => [id, new FakeElement()])) as Record<string, FakeElement>;
  elements['bookmark-insert-top']!.dataset.value = 'top'; elements['bookmark-insert-bottom']!.dataset.value = 'bottom';
  let resolveInitial!: (value: unknown) => void;
  const initial = new Promise((resolve) => { resolveInitial = resolve; });
  const messages: unknown[] = [];
  vi.stubGlobal('document', { dispatchEvent: vi.fn(), getElementById: (id: string) => elements[id] });
  vi.stubGlobal('chrome', { runtime: { sendMessage: (message: { kind: string }) => {
    if (message.kind === 'known.bookmark.preferences.get') return initial;
    messages.push(message);
    return Promise.resolve({ ok: true, preferences: { bookmarkInsertPosition: 'top', foldersFirst: true },
      scope: 'account', source: 'server', revision: '1', etag: '"1"', pending: false, conflict: false });
  } } });
  const displayed: boolean[] = [];
  const controller = bindBookmarkPreferences((foldersFirst) => displayed.push(foldersFirst));
  const refresh = controller.refresh();
  const control = elements[field === 'position' ? 'bookmark-insert-top' : 'bookmark-folders-first']!;
  control.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  resolveInitial({ ok: true, preferences: { bookmarkInsertPosition: 'bottom', foldersFirst: false },
    scope: 'account', source: 'server', revision: '0', etag: '"0"', pending: false, conflict: false });
  await refresh;
  assert.equal(elements['bookmark-insert-top']!.getAttribute('aria-checked'), 'true');
  assert.equal(elements['bookmark-insert-bottom']!.getAttribute('aria-checked'), 'false');
  assert.deepEqual(displayed, [true]);
  assert.deepEqual(messages, [{ kind: 'known.bookmark.preferences.update', userGesture: true,
    ...(field === 'position' ? { bookmarkInsertPosition: 'top' } : { foldersFirst: true }) }]);
});

test('panel duration and resume-when-online show only in Automatic mode (R13 E-09)', async () => {
  const html = await readFile(new URL('../options.html', import.meta.url), 'utf8');
  assert.match(html, /data-mode-only="automatic">\s*<div class="set-row-text"><label[^>]*for="capture-panel-duration"/u);
  assert.match(html, /id="capture-classification-automatic-only" data-mode-only="automatic"[\s\S]{0,900}id="capture-resume-online"/u);
  assert.match(html, /id="manual-classification-settings" data-mode-only="manual"/u);
  assert.match(html, /Finish suggestions after reconnecting/u);
  assert.doesNotMatch(html, /Resume authorized, unstarted classification/u);

  const elements = Object.fromEntries([
    'bookmark-insert-top', 'bookmark-insert-bottom', 'bookmark-folders-first',
    'bookmark-preferences-status', 'bookmark-preferences-use-server', 'bookmark-preferences-use-local',
    'capture-mode',
  ].map((id) => [id, new FakeElement()])) as Record<string, FakeElement>;
  const mode = elements['capture-mode']!;
  const automaticRow = new FakeElement(), manualRow = new FakeElement();
  automaticRow.dataset.modeOnly = 'automatic'; manualRow.dataset.modeOnly = 'manual';
  mode.value = 'manual';
  let captureMode = 'automatic';
  vi.stubGlobal('document', { dispatchEvent: vi.fn(), getElementById: (id: string) => elements[id],
    querySelectorAll: (selector: string) => selector === '[data-mode-only]' ? [automaticRow, manualRow] : [] });
  vi.stubGlobal('chrome', { runtime: { sendMessage: () => Promise.resolve({ ok: true,
    preferences: { bookmarkInsertPosition: 'top', foldersFirst: true, captureMode },
    scope: 'account', source: 'server', revision: '1', etag: '"1"', pending: false, conflict: false }) } });
  const controller = bindBookmarkPreferences();
  assert.equal(automaticRow.hidden, true);
  assert.equal(manualRow.hidden, false);
  await controller.refresh();
  assert.equal(mode.value, 'automatic');
  assert.equal(automaticRow.hidden, false);
  assert.equal(manualRow.hidden, true);
  captureMode = 'manual';
  mode.value = 'manual';
  mode.dispatch('change');
  assert.equal(automaticRow.hidden, true);
  assert.equal(manualRow.hidden, false);
});

test('the form-open suggestion and the tag mode sit with the Manual/Automatic choice on the Saving page', async () => {
  const html = await readFile(new URL('../options.html', import.meta.url), 'utf8');
  const saving = html.slice(html.indexOf('id="saving-card"'), html.indexOf('id="bookmark-preferences"'));
  assert.match(saving, /id="capture-mode-choices"[\s\S]*id="manual-classification-settings" data-mode-only="manual" data-ai-only/u);
  assert.match(saving, /id="ai-tag-mode-row" data-ai-only[\s\S]*data-value="off"[\s\S]*data-value="suggest"[\s\S]*data-value="add"/u);
  assert.doesNotMatch(html.slice(html.indexOf('id="ai-card"')), /id="capture-manual-suggestions"/u);
});

test('Tags from AI paints the effective mode, explains it for the current mode and saves a new choice', async () => {
  const ids = ['bookmark-insert-top', 'bookmark-insert-bottom', 'bookmark-folders-first', 'bookmark-preferences-status',
    'bookmark-preferences-use-server', 'bookmark-preferences-use-local', 'ai-tag-mode-hint', 'capture-mode'];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()])) as Record<string, FakeElement>;
  const tagButtons = ['off', 'suggest', 'add'].map((value) => { const button = new FakeElement(); button.dataset.value = value; return button; });
  const group = { querySelectorAll: () => tagButtons };
  elements['capture-mode']!.value = 'manual';
  const messages: { kind: string }[] = [];
  vi.stubGlobal('document', { dispatchEvent: vi.fn(), querySelectorAll: () => [],
    getElementById: (id: string) => id === 'ai-tag-mode' ? group : elements[id] });
  const preferences = { bookmarkInsertPosition: 'bottom', foldersFirst: true, captureMode: 'automatic' };
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, runtime: { sendMessage: async (message: { kind: string }) => {
    messages.push(message);
    return { ok: true, preferences: message.kind === 'known.bookmark.preferences.update' ? { ...preferences, aiTagMode: 'off' } : preferences,
      scope: 'device', source: 'cache', revision: '1', etag: '"1"', pending: false, conflict: false };
  } } });
  await bindBookmarkPreferences().refresh();
  assert.deepEqual(tagButtons.map((button) => button.getAttribute('aria-checked')), ['false', 'true', 'false']);
  assert.equal(elements['ai-tag-mode-hint']!.textContent, 'Shows up to 3 of your existing tags in the result panel. Click one to add it.');
  tagButtons[0]!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(messages.at(-1), { kind: 'known.bookmark.preferences.update', userGesture: true, aiTagMode: 'off' });
  assert.deepEqual(tagButtons.map((button) => button.getAttribute('aria-checked')), ['true', 'false', 'false']);
  assert.equal(elements['ai-tag-mode-hint']!.textContent, 'Suggestions pick a folder only.');
});
