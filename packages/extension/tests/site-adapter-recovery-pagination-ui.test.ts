// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';

test('recovery page requests and renders subsequent binding pages and retries the selected row', async () => {
  document.body.innerHTML = '<button id="read-bindings"></button><div id="content-bindings"></div><div id="content-summary"></div><pre id="status"></pre><button id="repair-status"></button><button id="repair-recover"></button><button id="repair-export"></button>';
  const sendMessage = vi.fn(async (message: { kind: string; cursor?: string }) => {
    if (message.kind.endsWith('retryUnsubmitted')) return { ok: true };
    return { ok: true, connectionId: null, nextCursor: message.cursor ? null : 'next', bindings: [{ id: message.cursor ? 'second' : 'first', itemId: 'item', title: message.cursor ? 'Second' : 'First', state: 'pending', connectionId: null, native: false, retryable: true }] };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage }, i18n: { getMessage: () => '' } });
  await import('../src/site-adapters/settings-recovery.js');
  document.querySelector<HTMLButtonElement>('#read-bindings')!.click();
  await vi.waitFor(() => expect(document.querySelector('#content-bindings')!.textContent).toContain('First'));
  const more = Array.from(document.querySelectorAll<HTMLButtonElement>('#content-bindings button')).find(b => b.textContent === 'Load more associations')!;
  more.click();
  await vi.waitFor(() => expect(document.querySelector('#content-bindings')!.textContent).toContain('Second'));
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.siteAdapters.content.list', cursor: 'next' }));
  const retries = Array.from(document.querySelectorAll<HTMLButtonElement>('#content-bindings button')).filter(b => b.textContent === 'Prepare to save again');
  retries[1]!.click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.siteAdapters.content.retryUnsubmitted', bindingId: 'second', itemId: 'item' })));
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

const ADDED = Date.UTC(2026, 9, 28, 12);
test('recovery offers an explicit existing-folder selection for an unknown creation', async () => {
  vi.resetModules();
  document.body.innerHTML = '<button id="read-bindings"></button><div id="content-bindings"></div><div id="content-summary"></div><pre id="status"></pre><button id="repair-status"></button><button id="repair-recover"></button><button id="repair-export"></button><div id="repair-summary"></div><div id="repair-records"></div><div id="repair-feedback"></div><div id="repair-hint"></div>';
  const sendMessage = vi.fn(async (message: { kind: string }) => message.kind.endsWith('.status')
    ? { ok: true, attention: [], folderRecovery: [{ commandId: 'command', title: 'Favorites', parentId: 'parent' }] } : { ok: true });
  vi.stubGlobal('chrome', { runtime: { sendMessage }, i18n: { getMessage: () => '' }, bookmarks: {
    get: async () => [{ id: 'parent', title: 'Archive' }],
    getChildren: async () => [{ id: 'chosen', title: 'Favorites', dateAdded: ADDED }, { id: 'other', title: 'Unrelated', dateAdded: ADDED + 1 }],
  } });
  await import('../src/site-adapters/settings-recovery.js');
  document.querySelector<HTMLButtonElement>('#repair-status')!.click();
  await vi.waitFor(() => expect(document.querySelector('#repair-records')!.textContent).toContain('Favorites'));
  const button = document.querySelector<HTMLButtonElement>('#repair-records button')!;
  // The candidate is named by when it was added, never by the raw timestamp.
  expect(button.textContent).toContain('2026'); expect(button.textContent).not.toContain(String(ADDED)); button.click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.siteAdapters.repair.adoptFolder', commandId: 'command', nativeId: 'chosen', dateAdded: ADDED })));
});

test('recovery requires an explicit decision before retrying an absent folder', async () => {
  vi.resetModules();
  document.body.innerHTML = '<button id="read-bindings"></button><div id="content-bindings"></div><div id="content-summary"></div><pre id="status"></pre><button id="repair-status"></button><button id="repair-recover"></button><button id="repair-export"></button><div id="repair-summary"></div><div id="repair-records"></div><div id="repair-feedback"></div><div id="repair-hint"></div>';
  const sendMessage = vi.fn(async (message: { kind: string }) => message.kind.endsWith('.status')
    ? { ok: true, attention: [], folderRecovery: [{ commandId: 'command', title: 'Favorites', parentId: 'parent' }] } : { ok: true });
  vi.stubGlobal('chrome', { runtime: { sendMessage }, i18n: { getMessage: () => '' }, bookmarks: { get: async () => [{ title: 'Archive' }], getChildren: async () => [] } });
  await import('../src/site-adapters/settings-recovery.js'); document.querySelector<HTMLButtonElement>('#repair-status')!.click();
  await vi.waitFor(() => expect(document.querySelector('#repair-records')!.textContent).toContain('risk of a duplicate'));
  expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.siteAdapters.repair.retryFolder' }));
  document.querySelector<HTMLButtonElement>('#repair-records button')!.click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.siteAdapters.repair.retryFolder', commandId: 'command' })));
});
