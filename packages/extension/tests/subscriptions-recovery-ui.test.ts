// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openRecovery } from '../src/subscriptions-ui/recovery.js';
import { createDirectoryPreferences } from '../src/subscriptions-ui/directories.js';
import type { MappingDetail } from '../src/subscriptions-ui/detail.js';
import type { Send, SubscriptionCommand } from '../src/subscriptions-ui/client.js';
import { validateCommand } from '../src/bookmark-subscriptions/commands.js';
const id = '11111111-1111-4111-8111-111111111111', token = '22222222-2222-4222-8222-222222222222';
const detail = { mapping: { mappingId: id, generation: 'generation-1', digestMode: 'latest', editionLimit: 1 }, local: { rootNativeId: 'root', state: 'local_change' }, sourceRef: { sourceType: 'digest_series', sourceId: 'private-series' } } as MappingDetail;
const preview = { token, expiresAt: Date.now() + 60000, action: 'copy_detach', copyCount: 4, preservationPath: ['Personal', 'Preserved'], targetRequired: false, exitPreview: { targets: [{ profileLabel: 'This browser', effectiveAction: 'remove', policyOrigin: 'global' }] } };
const click = (name: string) => { const node = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === name); expect(node, name).toBeTruthy(); node!.click(); };
beforeEach(() => { document.body.replaceChildren(); vi.stubGlobal('chrome', { permissions: { contains: vi.fn(async () => true) }, runtime: { sendMessage: vi.fn(async () => ({ ok: true, preferences: {} })) } }); });
afterEach(() => { for (const dialog of Array.from(document.querySelectorAll('dialog'))) dialog.close(); vi.unstubAllGlobals(); });
function worker(handler: (command: SubscriptionCommand, requestId?: string) => Promise<unknown>): Send { return (async (command: SubscriptionCommand, requestId?: string) => { expect(validateCommand({ type: 'BOOKMARK_SUBSCRIPTIONS', requestId: requestId ?? crypto.randomUUID(), command })).toBe(true); return handler(command, requestId); }) as Send; }
it('requires explicit recovery confirmation and retries a lost reply using the frozen token and intent', async () => {
  const calls: { command: SubscriptionCommand; requestId?: string }[] = []; let attempts = 0; const completed = vi.fn(async () => undefined);
  const send = worker(async (command, requestId) => { calls.push({ command, requestId }); if (command.kind === 'recoveryPreview') return preview; if (command.kind === 'recoveryConfirm') { if (!attempts++) throw new Error('network_failed'); return { copy: { count: 4 }, exitBatch: {} }; } throw new Error('Unexpected command'); });
  openRecovery(send, detail, 'copy_detach', completed); await vi.waitFor(() => expect(document.body.textContent).toContain('Bookmarks to copy: 4'));
  expect(document.body.textContent).toContain('Personal › Preserved'); expect(document.body.textContent).toContain('Delete the folder'); expect(calls).toHaveLength(1);
  click('Keep a copy and remove'); await vi.waitFor(() => expect(document.body.textContent).toContain('The action is not confirmed')); expect(completed).not.toHaveBeenCalled();
  click('Keep a copy and remove'); await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
  const confirms = calls.filter(call => call.command.kind === 'recoveryConfirm'); expect(confirms).toHaveLength(2); expect(confirms[1]).toEqual(confirms[0]);
});
it('invalidates a changed recovery preview until the user explicitly reviews again', async () => {
  const calls: SubscriptionCommand[] = []; openRecovery(worker(async command => { calls.push(command); if (command.kind === 'recoveryPreview') return preview; throw new Error('preview_changed'); }), detail, 'copy_detach', vi.fn(async () => undefined));
  await vi.waitFor(() => expect(document.body.textContent).toContain('Bookmarks to copy')); click('Keep a copy and remove'); await vi.waitFor(() => expect(document.body.textContent).toContain('Local content changed after the preview'));
  const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === 'Keep a copy and remove')!; expect(confirm.disabled).toBe(true); expect(calls.filter(c => c.kind === 'recoveryPreview')).toHaveLength(1);
  click('Review recovery'); await vi.waitFor(() => expect(confirm.disabled).toBe(false)); expect(calls.filter(c => c.kind === 'recoveryPreview')).toHaveLength(2);
});
it('requires a native location when restoring a missing folder and previews source content before mutation', async () => {
  const calls: SubscriptionCommand[] = [];
  openRecovery(worker(async command => { calls.push(command); if (command.kind === 'folders') return { nodes: [{ id: 'bar', title: 'Bookmarks bar', disabled: false }] }; if (command.kind === 'recoveryPreview') return { ...preview, action: 'restore', exitPreview: undefined }; if (command.kind === 'sourcePreview') return { descriptor: { counts: { nodes: 1, bookmarks: 0, editions: 0, skipped: 0 }, skippedByReason: [], editions: [] }, nodes: [] }; throw new Error('Unexpected command'); }), { ...detail, local: { ...detail.local!, state: 'target_missing', rootNativeId: undefined } }, 'restore', vi.fn(async () => undefined));
  await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some(node => node.textContent === 'Bookmarks bar')).toBe(true)); expect(calls.some(c => c.kind === 'recoveryPreview')).toBe(false); click('Bookmarks bar'); click('Review recovery');
  await vi.waitFor(() => expect(calls.some(c => c.kind === 'sourcePreview')).toBe(true)); expect(calls.find(c => c.kind === 'recoveryPreview')).toMatchObject({ parentNativeId: 'bar', expectedGeneration: 'generation-1' }); expect(calls.some(c => c.kind === 'recoveryConfirm')).toBe(false); click('Cancel'); expect(calls.some(c => c.kind === 'recoveryConfirm')).toBe(false);
});
it('does not write local directory defaults until preview has received a second explicit confirmation', async () => {
  const calls: SubscriptionCommand[] = [], host = document.createElement('div'); document.body.append(host);
  const controller = createDirectoryPreferences(host, worker(async command => { calls.push(command); if (command.kind === 'directoryDefaults') return {}; if (command.kind === 'folders') return { nodes: [{ id: 'bar', title: 'Bookmarks bar', disabled: false }] }; if (command.kind === 'directoryPreview') return preview; if (command.kind === 'directoryConfirm') return { mountParentNativeId: 'bar' }; throw new Error('Unexpected command'); }));
  await vi.waitFor(() => expect(host.textContent).toContain('Where new subscription folders go')); click('Choose location'); await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).some(node => node.textContent === 'Bookmarks bar')).toBe(true)); click('Bookmarks bar'); click('Review location');
  await vi.waitFor(() => expect(document.body.textContent).toContain('Confirm location')); expect(calls.some(c => c.kind === 'directoryConfirm')).toBe(false); click('Confirm location'); await vi.waitFor(() => expect(calls.some(c => c.kind === 'directoryConfirm')).toBe(true)); controller.dispose();
});

it('does not freeze or confirm a copy exit while account policies are unsynced', async () => {
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true, pending: true, preferences: {} }); const send = vi.fn() as Send;
  openRecovery(send, detail, 'copy_detach', vi.fn(async () => undefined)); await vi.waitFor(() => expect(document.body.textContent).toContain('still syncing'));
  expect(send).not.toHaveBeenCalled(); expect(Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === 'Keep a copy and remove')?.disabled).toBe(true);
});
