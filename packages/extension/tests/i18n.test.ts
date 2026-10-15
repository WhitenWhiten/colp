// @vitest-environment happy-dom
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { check } from '../scripts/i18n-catalog.mjs';

type Catalog = Record<string, { message: string }>;
const zh = JSON.parse(readFileSync(resolve(import.meta.dirname, '../_locales/zh_CN/messages.json'), 'utf8')) as Catalog;

/** chrome.i18n.getMessage over one catalog, with Chrome's $1…$9 substitution. */
function useCatalog(catalog: Catalog): void {
  vi.stubGlobal('chrome', { i18n: { getMessage: (key: string, values: string[] = []) =>
    catalog[key]?.message.replace(/\$(\$|[1-9])/gu, (_, slot: string) => slot === '$' ? '$' : values[Number(slot) - 1] ?? '') ?? '' } });
}

async function freshI18n() {
  vi.resetModules();
  return import('../src/i18n.js');
}

afterEach(() => { vi.unstubAllGlobals(); });

test('without chrome.i18n the English at the call site is used, with substitutions', async () => {
  const { t, tn, listCopy } = await freshI18n();
  assert.equal(t('any_key', 'Saved to $1', 'Bar'), 'Saved to Bar');
  assert.equal(t('any_key', 'Costs $$5 for $1', 2), 'Costs $5 for 2');
  assert.equal(tn('any_count', 1, '$1 bookmark', '$1 bookmarks'), '1 bookmark');
  assert.equal(tn('any_count', 3, '$1 bookmark', '$1 bookmarks'), '3 bookmarks');
  assert.equal(listCopy(['a', 'b', 'c']), 'a, b, c');
});

test('the Chinese catalog drives copy, plural choice and list punctuation', async () => {
  useCatalog(zh);
  const { t, tn, listCopy, uiLanguage } = await freshI18n();
  assert.equal(uiLanguage(), 'zh-CN');
  assert.equal(t('common_cancel', 'Cancel'), zh.common_cancel!.message);
  assert.equal(tn('common_bookmarks', 1, '$1 bookmark', '$1 bookmarks'), zh.common_bookmarks_other!.message.replace('$1', '1'));
  assert.equal(listCopy(['a', 'b']), 'a、b');
});

test('localizePage translates marked text and attributes and sets the page language', async () => {
  useCatalog({ locale: { message: 'zh-CN' }, greet: { message: '你好' }, tip: { message: '提示' } });
  const { localizePage } = await freshI18n();
  document.body.innerHTML = '<p data-i18n="greet">Hello</p><button aria-label="Tip" data-i18n-aria-label="tip" data-tip="Tip" data-i18n-data-tip="tip"></button>';
  localizePage();
  assert.equal(document.querySelector('p')!.textContent, '你好');
  assert.equal(document.querySelector('button')!.getAttribute('aria-label'), '提示');
  assert.equal(document.querySelector('button')!.getAttribute('data-tip'), '提示');
  assert.equal(document.documentElement.lang, 'zh-CN');
});

type StorageStub = {
  local: { get(keys: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
  onChanged?: { addListener(cb: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void };
};
function stubLanguageStorage(storage: StorageStub): void {
  vi.stubGlobal('chrome', {
    i18n: { getMessage: () => 'browser copy' },
    runtime: { getURL: (path: string) => path },
    storage,
  });
}

test('a stored language overrides the resolved catalog, per key and for uiLanguage', async () => {
  let stored: unknown = 'zh-CN';
  const listeners = new Set<(changes: Record<string, { newValue?: unknown }>, area: string) => void>();
  stubLanguageStorage({
    local: {
      get: async () => ({ 'known.ui-language.v1': stored }),
      set: async (items) => { stored = items['known.ui-language.v1']; },
    },
    onChanged: { addListener: (cb) => listeners.add(cb) },
  });
  const catalogs: Record<string, Catalog> = {
    zh_CN: { locale: { message: 'zh-CN' }, greet: { message: '你好' } },
    en: { locale: { message: 'en' }, greet: { message: 'Hello' } },
  };
  vi.stubGlobal('fetch', async (url: string) => ({ ok: true, json: async () => catalogs[/_locales\/([^/]+)\//u.exec(url)![1]!] }));
  const { initI18n, onUiLanguageChanged, setUiLanguage, t, uiLanguage } = await freshI18n();

  assert.equal(await initI18n(), true);
  assert.equal(t('greet', 'Hi'), '你好');
  assert.equal(uiLanguage(), 'zh-CN');
  assert.equal(t('missing', 'Fallback'), 'browser copy', 'a key the override lacks falls back to chrome.i18n');

  let fired = 0;
  onUiLanguageChanged(() => { fired += 1; });
  await setUiLanguage('en');
  for (const listener of listeners) listener({ 'known.ui-language.v1': { newValue: 'en' } }, 'local');
  await vi.waitFor(() => assert.equal(fired, 1));
  assert.equal(t('greet', 'Hi'), 'Hello');
  assert.equal(uiLanguage(), 'en');

  await setUiLanguage('klingon');
  assert.equal(stored, 'auto', 'an unsupported choice coerces to following the browser');
});

test('module-level copy follows the pinned language once it resolves and when it changes', async () => {
  let stored: unknown = 'zh-CN';
  const listeners = new Set<(changes: Record<string, { newValue?: unknown }>, area: string) => void>();
  stubLanguageStorage({
    local: { get: async () => ({ 'known.ui-language.v1': stored }), set: async () => undefined },
    onChanged: { addListener: (cb) => listeners.add(cb) },
  });
  const catalogs: Record<string, Catalog> = {
    zh_CN: { locale: { message: 'zh-CN' }, common_synced: { message: '已同步' } },
    en: { locale: { message: 'en' }, common_synced: { message: 'Synced' } },
  };
  vi.stubGlobal('fetch', async (url: string) => ({ ok: true, json: async () => catalogs[/_locales\/([^/]+)\//u.exec(url)![1]!] }));
  const { initI18n, onUiLanguageChanged } = await freshI18n();
  // Imported before the catalog is fetched, exactly as a page's modules are.
  const draft = await import('../src/first-run-draft.js');
  const saveStatus = await import('../src/save-status.js');
  const feedback = await import('../src/save-feedback.js');
  assert.equal(draft.FIRST_RUN_SYNCED, 'browser copy', 'the browser catalog is all there is until the pinned one arrives');

  assert.equal(await initI18n(), true);
  assert.equal(draft.FIRST_RUN_SYNCED, '已同步');
  assert.equal(draft.FIRST_RUN_NEEDS_ATTENTION, draft.FIRST_RUN_ACTION_REQUIRED, 'aliases follow their source');
  assert.equal(saveStatus.SAVE_SAVED_TO_BROWSER, 'browser copy', 'a key the pinned catalog lacks falls back to the browser catalog');

  let fired = 0;
  onUiLanguageChanged(() => { fired += 1; });
  stored = 'en';
  for (const listener of listeners) listener({ 'known.ui-language.v1': { newValue: 'en' } }, 'local');
  await vi.waitFor(() => assert.equal(fired, 1));
  assert.equal(draft.FIRST_RUN_SYNCED, 'Synced');
  assert.equal(feedback.saveFeedbackMessage('saved'), saveStatus.SAVE_SAVED_TO_BROWSER, 'tables built from other copy are rebuilt too');
});

test('auto leaves the resolved catalog alone and never fetches', async () => {
  stubLanguageStorage({ local: { get: async () => ({}), set: async () => undefined } });
  const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  vi.stubGlobal('fetch', fetchSpy);
  const { initI18n, t } = await freshI18n();
  assert.equal(await initI18n(), false);
  assert.equal(fetchSpy.mock.calls.length, 0);
  assert.equal(t('greet', 'Hi'), 'browser copy');
});

test('the English catalog matches the code and every translation is complete and current', () => {
  assert.deepEqual(check(), []);
});

test('an element slot survives Chrome’s substitution, which drops control and private-use characters', async () => {
  // Measured in Chromium (browser rules follow-up U7): getMessage('automation_updatedAt', ['\u0000']) is "Updated .".
  vi.stubGlobal('chrome', { i18n: { getMessage: (key: string, values: string[] = []) => key === 'automation_updatedAt'
    ? 'Updated $1.'.replace('$1', (values[0] ?? '').replace(/[\u0000-\u001f-]/gu, '')) : '' } });
  let { t, SLOT, withSlot } = await freshI18n();
  assert.deepEqual(withSlot(t('automation_updatedAt', 'Updated $1.', SLOT), 'TIME'), ['Updated ', 'TIME', '.']);
  // A translation without the slot still shows the element, at its end.
  assert.deepEqual(withSlot('Updated.', 'TIME'), ['Updated.', 'TIME']);
  useCatalog(zh);
  ({ t, SLOT, withSlot } = await freshI18n());
  assert.equal(withSlot(t('automation_updatedAt', 'Updated $1.', SLOT), 'TIME').join(''), zh.automation_updatedAt!.message.replace('$1', 'TIME'));
});
