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
