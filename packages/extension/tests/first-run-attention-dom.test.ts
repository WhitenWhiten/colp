// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { bindFirstRunOnboarding } from '../src/first-run-ui.js';

afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
async function mount(failure?: 'request_invalid' | 'reject' | 'empty') {
  const html = await readFile('options.html', 'utf8');
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  let pending = 4; const requests: any[] = [];
  const status = () => ({ ok: true, firstRun: 'completed', phase: pending ? 'needs_attention' : 'completed',
    attention: { reportId: 'run', conflictCount: pending, candidateCount: 0, pendingCount: pending } });
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, runtime: { sendMessage: async (message: any) => {
    requests.push(message);
    if (message.kind === 'known.firstRun.status') return status();
    if (failure === 'reject') throw new Error('worker unavailable');
    if (failure === 'empty') return undefined;
    if (failure) return { ok: false, error: failure };
    return { ...status(), items: [{ itemId: message.cursor ? 'last' : 'first', kind: 'conflict', label: message.cursor ? 'Last bookmark' : 'First bookmark', decision: 'open', locationCount: 2 }],
      ...(message.cursor ? {} : { nextCursor: '20' }) };
  } } });
  const el = (id: string) => document.getElementById(id)!;
  bindFirstRunOnboarding({ rootTree: el('root-tree'), saveRoots: el('save-roots') as HTMLButtonElement,
    requestPermission: el('request-bookmark-permission') as HTMLButtonElement, folderHeading: el('folder-heading'), folderIntro: el('folder-intro'), showPane() {} });
  await vi.waitFor(() => expect(el('first-run-error').textContent).toContain('4 items'));
  return { el, requests, resolved() { pending = 0; } };
}
for (const failure of [undefined, 'request_invalid', 'reject', 'empty'] as const) test(`real options DOM attention click (${failure ?? 'success'})`, async () => {
  const f = await mount(failure); f.el('first-run-view-attention').click();
  if (failure) { await vi.waitFor(() => expect(f.el('first-run-error').textContent).toContain('Could not load')); return; }
  await vi.waitFor(() => expect(f.el('first-run-attention-list').textContent).toContain('First bookmark'));
  (Array.from(f.el('first-run-attention-list').querySelectorAll('button')).find(button => button.textContent?.includes('Next'))!).click();
  await vi.waitFor(() => expect(f.el('first-run-attention-list').textContent).toContain('Last bookmark'));
  f.el('first-run-view-attention').click();
  await vi.waitFor(() => expect(f.el('first-run-attention-list').textContent).toContain('First bookmark'));
  f.resolved();
  await vi.waitFor(() => expect(f.el('first-run-attention').hidden).toBe(true), { timeout: 2000 });
});
