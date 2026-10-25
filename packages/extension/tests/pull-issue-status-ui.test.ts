// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';
import { setup } from './replica-rebuild-harness.js';
import { bindSyncAttentionSettings } from '../src/sync-attention-ui.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';

test('Status displays an unfrozen Pull issue and its Reset confirmation completes real replica rotation', async () => {
  const f = await setup({ degraded: true });
  try {
    vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://test/${path}`,
      sendMessage: async (request: any) => {
        if (request.kind === 'known.sync.attention.get') return handleSyncAttentionRequest({ scope: async () => f.scope, store: f.store });
        if (request.kind === 'known.remoteDelete.policy.get') return { ok: true, policy: 'sync', pendingCount: 0 };
        return f.rebuilder.handle(request);
      } }, tabs: { create: vi.fn() } });
    document.body.innerHTML = '<div id="sync-attention-settings"><div id="sync-attention-settings-recovery"><p id="sync-attention-settings-recovery-copy"></p></div>'
      + '<ul id="sync-attention-settings-issues" hidden></ul></div>';
    bindSyncAttentionSettings();
    await vi.waitFor(() => expect(document.getElementById('sync-attention-settings')?.hidden).toBe(false));
    // C-03: the item is a row with its name and a sentence, not a "Title: code" paragraph.
    await vi.waitFor(() => expect(document.querySelector('#sync-attention-settings-issues .sync-issue-title')?.textContent).toContain('Needs repair'));
    expect(document.getElementById('sync-attention-settings-recovery-copy')?.textContent).toBe('1 item needs attention.');
    const repair = document.getElementById('sync-attention-settings-issue-repair')!;
    expect(repair.hidden).toBe(false);
    (repair.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('.rebuild-confirm-copy')?.textContent).toContain('Your bookmarks stay'));
    (document.querySelector('.rebuild-confirm .btn-danger') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.registrations).toBe(1));
    expect((await f.credentials.loadBinding())?.replicaId).not.toBe(f.scope.replicaId);
    expect((await f.store.exportArchive(f.scope)).reason).toBe('user_replica_rebuild');
  } finally { f.store.close(); vi.unstubAllGlobals(); }
});
