// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { conflicted, scope } from './bootstrap-merge-attention-harness.js';
import { handleAttentionDecide, handleAttentionGet, withAttention } from '../src/sw/first-run-attention.js';
import { bindFirstRunOnboarding } from '../src/first-run-ui.js';
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.unstubAllGlobals(); document.body.replaceChildren(); });
test('clicking a local difference action authors real queue work and keeps attention open', async () => {
  const f = await conflicted();
  try {
    const html = await readFile('options.html', 'utf8');
    document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, runtime: { sendMessage: async (message: any) => {
      if (message.kind === 'known.firstRun.status') { const status = await f.coordinator.status(); return withAttention(status.phase, 'completed', status); }
      if (message.kind === 'known.firstRun.attention.get') return handleAttentionGet(f.store, scope, message.reportId, message.cursor, 'completed');
      return handleAttentionDecide(f.store, scope, message.reportId, message.itemId, 'completed', { ...message, input: f.input });
    } } });
    const el = (id: string) => document.getElementById(id)!;
    bindFirstRunOnboarding({ rootTree: el('root-tree'), saveRoots: el('save-roots') as HTMLButtonElement,
      requestPermission: el('request-bookmark-permission') as HTMLButtonElement,
      folderHeading: el('folder-heading'), folderIntro: el('folder-intro'), showPane() {} });
    await vi.waitFor(() => expect(el('first-run-error').textContent).toContain('4 items'));
    el('first-run-view-attention').click();
    await vi.waitFor(() => expect(el('first-run-attention-list').textContent).toContain('Local 0'));
    (el('first-run-attention-list').querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(async () => expect(await f.store.listQueue(scope)).toHaveLength(1));
    await vi.waitFor(() => expect(el('first-run-attention-list').textContent).toContain('waiting for convergence'));
    expect((await f.coordinator.status()).phase).toBe('needs_attention');
  } finally { f.store.close(); }
});
