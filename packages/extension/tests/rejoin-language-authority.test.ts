// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { bindRejoinDecisions } from '../src/rejoin-decisions-ui.js';
import { bindPageLanguage } from '../src/page-language.js';
import { UI_LANGUAGE_KEY, uiLanguage } from '../src/i18n.js';
import type { PublicRejoinDecision } from '../src/scope-rejoin-decisions.js';

afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('a language change from another options page relocalizes unchanged decisions and requires fresh deletion consent', async () => {
  vi.useFakeTimers();
  const row: PublicRejoinDecision = { commandId: 'rejoin-remote-delete:folder', token: `sha256:${'a'.repeat(64)}`,
    title: 'Local folder', kind: 'remote_delete', state: 'pending', affectedCount: 3 };
  const messages = JSON.parse(readFileSync('_locales/zh_CN/messages.json', 'utf8')) as Record<string, { message: string }>;
  type StorageListener = (changes: Record<string, { newValue: unknown }>, area: string) => void;
  const listeners = new Set<StorageListener>();
  const requests: Record<string, unknown>[] = [];
  const send = vi.fn(async (request: Record<string, unknown>) => {
    requests.push(request);
    if (request.kind === 'known.sync.rejoinDecisions.get') return { ok: true, decisions: [structuredClone(row)] };
    if (request.kind === 'known.sync.rejoinDecisions.resolve') return { ok: true, decisions: [] };
    throw new Error(`undeclared runtime request ${String(request.kind)}`);
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send, getURL: (path: string) => `chrome-extension://language-page/${path}` },
    storage: { local: { get: async () => ({ [UI_LANGUAGE_KEY]: 'auto' }) },
      onChanged: { addListener: (listener: StorageListener) => listeners.add(listener) } } });
  vi.stubGlobal('fetch', async (url: string) => {
    expect(url).toBe('chrome-extension://language-page/_locales/zh_CN/messages.json');
    return Response.json(messages);
  });
  document.body.innerHTML = '<p data-i18n="common_refresh">Refresh</p><section id="decisions"></section>';
  await bindPageLanguage();
  const panel = document.getElementById('decisions')!, onResolved = vi.fn();
  const ui = bindRejoinDecisions({ panel, show: vi.fn(), onResolved }); ui.setLibraryId('library'); ui.onConnection(true);
  const checkbox = () => panel.querySelector<HTMLInputElement>('[data-rejoin-delete-confirm]');
  const deletion = () => panel.querySelector<HTMLButtonElement>('[data-rejoin-action="apply_remote_delete"]');
  await vi.waitFor(() => expect(checkbox()).not.toBeNull());
  const oldCheckbox = checkbox()!, oldButton = deletion()!;
  oldCheckbox.checked = true; oldCheckbox.dispatchEvent(new Event('change')); oldCheckbox.focus();
  expect(uiLanguage()).toBe('en');
  // This is the cross-document storage event; the current page does not reload.
  for (const listener of listeners) listener({ [UI_LANGUAGE_KEY]: { newValue: 'zh-CN' } }, 'local');
  await vi.waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'));
  expect(document.querySelector('[data-i18n="common_refresh"]')!.textContent).toBe(messages.common_refresh!.message);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(panel.querySelector('h2')!.textContent).toBe(messages.rejoin_heading!.message);
  expect(checkbox()).not.toBe(oldCheckbox); expect(checkbox()?.checked).toBe(false); expect(deletion()?.disabled).toBe(true);
  oldButton.click(); await vi.advanceTimersByTimeAsync(0);
  expect(requests.filter(request => request.kind === 'known.sync.rejoinDecisions.resolve')).toEqual([]);
  const reviewed = checkbox()!; reviewed.checked = true; reviewed.dispatchEvent(new Event('change')); reviewed.focus();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(checkbox()).toBe(reviewed); expect(reviewed.checked).toBe(true); expect(document.activeElement).toBe(reviewed);
  deletion()!.click(); await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  expect(requests.filter(request => request.kind === 'known.sync.rejoinDecisions.resolve')).toEqual([{
    kind: 'known.sync.rejoinDecisions.resolve', commandId: row.commandId, token: row.token,
    choice: 'apply_remote_delete', affectedCount: 3, confirmSubtree: true, userGesture: true,
  }]);
});
