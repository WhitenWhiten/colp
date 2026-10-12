// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openRecovery } from '../src/subscriptions-ui/recovery.js';
import type { MappingDetail } from '../src/subscriptions-ui/detail.js';
import type { Send, SubscriptionCommand } from '../src/subscriptions-ui/client.js';

const detail = { mapping: { mappingId: 'mapping', generation: 'g1' }, local: { rootNativeId: 'root', state: 'local_change' } } as MappingDetail;
const button = (label: string) => {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === label);
  expect(match, label).toBeTruthy();
  return match!;
};
beforeEach(() => {
  document.body.replaceChildren();
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => ({ ok: true, preferences: {} })) } });
});
afterEach(() => {
  for (const dialog of Array.from(document.querySelectorAll('dialog'))) dialog.close();
  vi.unstubAllGlobals();
});

it('requires review of the changed exit policy and an explicit second confirmation to reuse a completed copy', async () => {
  const calls: SubscriptionCommand[] = [];
  let previews = 0;
  const completed = vi.fn(async () => undefined);
  const send = (async (command: SubscriptionCommand) => {
    calls.push(command);
    if (command.kind === 'recoveryPreview') {
      previews++;
      return { token: 'preview-' + previews, expiresAt: Date.now() + 60000, copyCount: 3, copyReused: previews > 1,
        preservationPath: ['Personal', 'Saved copy'], targetRequired: false,
        exitPreview: { targets: [{ profileLabel: 'This browser', effectiveAction: previews > 1 ? 'keep' : 'remove', policyOrigin: 'global' }] } };
    }
    if (command.kind === 'recoveryConfirm' && command.token === 'preview-1') throw new Error('precondition_failed');
    return { copy: { count: 4 }, exitBatch: {} };
  }) as Send;
  openRecovery(send, detail, 'copy_detach', completed);
  const confirm = button('Keep a copy and remove');
  await vi.waitFor(() => expect(confirm.disabled).toBe(false));
  expect(document.body.textContent).toContain('Delete the folder');
  confirm.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('The preview changed'));
  expect(confirm.disabled).toBe(true);
  expect(previews).toBe(1);
  expect(completed).not.toHaveBeenCalled();
  button('Review recovery').click();
  await vi.waitFor(() => expect(confirm.disabled).toBe(false));
  expect(document.body.textContent).toContain('will be reused');
  expect(document.body.textContent).toContain('Keep the bookmarks as your own');
  expect(document.body.textContent).not.toContain('Delete the folder');
  expect(calls.filter(c => c.kind === 'recoveryConfirm')).toHaveLength(1);
  confirm.click();
  await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
  expect(calls.filter(c => c.kind === 'recoveryConfirm')).toEqual([
    { kind: 'recoveryConfirm', token: 'preview-1' }, { kind: 'recoveryConfirm', token: 'preview-2' },
  ]);
});

it('invalidates a reused copy preview if the saved copy changes before confirmation', async () => {
  const send = (async (command: SubscriptionCommand) => {
    if (command.kind === 'recoveryPreview') return { token: 'preview', expiresAt: Date.now() + 60000, copyCount: 3, copyReused: true, preservationPath: ['Saved copy'] };
    throw new Error('local_copy_changed');
  }) as Send;
  const completed = vi.fn(async () => undefined);
  openRecovery(send, detail, 'copy_detach', completed);
  const confirm = button('Keep a copy and remove');
  await vi.waitFor(() => expect(confirm.disabled).toBe(false));
  confirm.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('The copy changed'));
  expect(confirm.disabled).toBe(true);
  expect(completed).not.toHaveBeenCalled();
});
