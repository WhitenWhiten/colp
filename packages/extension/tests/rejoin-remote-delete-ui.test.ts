// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bindRejoinDecisions } from '../src/rejoin-decisions-ui.js';
import { bindSyncAttentionSettings } from '../src/sync-attention-ui.js';
import type { PublicRejoinDecision, RejoinDecisionResponse } from '../src/scope-rejoin-decisions.js';
import type { PublicSyncAttention } from '../src/types.js';

const remote: PublicRejoinDecision = { commandId: 'rejoin-remote-delete:folder', token: `sha256:${'a'.repeat(64)}`,
  title: 'Locally edited folder', kind: 'remote_delete', state: 'pending', affectedCount: 3 };
const markup = readFileSync('options.html', 'utf8');
let decisions: PublicRejoinDecision[], result: RejoinDecisionResponse, attention: PublicSyncAttention;
let send: ReturnType<typeof vi.fn<(message: Record<string, unknown>) => Promise<unknown>>>;
beforeEach(() => {
  decisions = [remote]; result = { ok: true, decisions: [] };
  attention = { phase: 'offline', recoveryFrozen: false, queueProjection: 'syncing', rejectedPending: false,
    conflictPending: false, nativeWaitPending: false, waitCount: 0, terminal: false,
    lastError: 'network_unavailable', retryAvailable: true, rebuildAvailable: false };
  document.body.innerHTML = '<section id="rejoin-decisions"></section>'
    + markup.match(/<section id="sync-attention-settings"[\s\S]*?<\/section>/u)![0]
    + '<p id="sync-attention-settings-feedback" hidden></p>';
  document.body.dataset.pane = 'sync';
  send = vi.fn(async (message: Record<string, unknown>) => {
    if (message.kind === 'known.sync.rejoinDecisions.get') return { ok: true, decisions: structuredClone(decisions) };
    if (message.kind === 'known.sync.rejoinDecisions.resolve') return structuredClone(result);
    if (message.kind === 'known.sync.attention.get') return { ok: true, attention: structuredClone(attention) };
    if (message.kind === 'known.remoteDelete.policy.get') return { ok: true, pendingCount: 0, conflictPending: false };
    if (message.kind === 'known.sync.engine.retry') return { ok: true };
    if (message.kind === 'known.scope.rebuild.preview') return { ok: true,
      preview: { replicaId: 'replica', generation: 1, revision: 'r1', targetFence: 0, queuedOperations: 2 } };
    throw new Error(`Unexpected runtime request: ${String(message.kind)}`);
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
});
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const action = (choice: string) => document.querySelector<HTMLButtonElement>(`[data-rejoin-action="${choice}"]`);
const confirmation = () => document.querySelector<HTMLInputElement>('[data-rejoin-delete-confirm]');
const resolves = () => send.mock.calls.filter(([message]) => message.kind === 'known.sync.rejoinDecisions.resolve');
async function screen() {
  const host = { panel: document.getElementById('rejoin-decisions')!, show: vi.fn(), onResolved: vi.fn() };
  const ui = bindRejoinDecisions(host); ui.setLibraryId('library'); ui.onConnection(true);
  await vi.waitFor(() => expect(host.panel.textContent).toContain(remote.title));
  return { ui, ...host };
}

test('a remote deletion offers Keep browser copy without authorizing any deletion', async () => {
  const f = await screen();
  expect(f.panel.textContent).toContain('current browser copy contains 3 items');
  expect(action('keep_local')?.disabled).toBe(false);
  expect(action('apply_remote_delete')?.disabled).toBe(true);
  action('keep_local')!.click();
  await vi.waitFor(() => expect(f.onResolved).toHaveBeenCalledTimes(1));
  expect(resolves().map(([message]) => message)).toEqual([{ kind: 'known.sync.rejoinDecisions.resolve',
    commandId: remote.commandId, token: remote.token, choice: 'keep_local', userGesture: true }]);
});

test('applying a cloud deletion requires the current full-subtree count and an explicit checked confirmation', async () => {
  const f = await screen();
  action('apply_remote_delete')!.click(); expect(resolves()).toEqual([]);
  const check = confirmation()!;
  expect(check.checked).toBe(false);
  expect(check.closest('label')!.textContent).toContain('removes 3 items from this browser');
  check.checked = true; check.dispatchEvent(new Event('change'));
  expect(action('apply_remote_delete')?.disabled).toBe(false);
  action('apply_remote_delete')!.click();
  await vi.waitFor(() => expect(f.onResolved).toHaveBeenCalledTimes(1));
  expect(resolves().map(([message]) => message)).toEqual([{ kind: 'known.sync.rejoinDecisions.resolve',
    commandId: remote.commandId, token: remote.token, choice: 'apply_remote_delete', userGesture: true,
    affectedCount: 3, confirmSubtree: true }]);
});

test('a changed subtree refreshes the token and count, clears consent and never resubmits automatically', async () => {
  const f = await screen();
  confirmation()!.checked = true; confirmation()!.dispatchEvent(new Event('change'));
  decisions = [{ ...remote, token: `sha256:${'b'.repeat(64)}`, affectedCount: 4 }];
  result = { ok: false, error: 'preview_stale' };
  action('apply_remote_delete')!.click();
  await vi.waitFor(() => expect(f.panel.textContent).toContain('current browser copy contains 4 items'));
  expect(confirmation()?.checked).toBe(false); expect(action('apply_remote_delete')?.disabled).toBe(true);
  expect(resolves()).toHaveLength(1); expect(f.onResolved).not.toHaveBeenCalled();
  result = { ok: true, decisions: [] };
  confirmation()!.checked = true; confirmation()!.dispatchEvent(new Event('change'));
  action('apply_remote_delete')!.click();
  await vi.waitFor(() => expect(f.onResolved).toHaveBeenCalledTimes(1));
  expect(resolves().at(-1)?.[0]).toMatchObject({ token: decisions[0]!.token, affectedCount: 4, confirmSubtree: true });
});

test('a blocked upload offers the existing retry control without retrying or resolving on navigation', async () => {
  decisions = [{ ...remote, blockedReason: 'unknown_upload', recoveryAction: 'retry_sync' }];
  bindSyncAttentionSettings(); const f = await screen();
  expect(action('keep_local')).toBeNull(); expect(action('apply_remote_delete')).toBeNull();
  expect(f.panel.textContent).toContain('result of an earlier upload is not confirmed');
  document.querySelector<HTMLButtonElement>('[data-rejoin-recovery="retry_sync"]')!.click();
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('sync-attention-settings-retry'));
  expect(f.show).toHaveBeenCalledTimes(1);
  expect(resolves()).toEqual([]);
  expect(send.mock.calls.some(([message]) => message.kind === 'known.sync.engine.retry')).toBe(false);
  (document.activeElement as HTMLButtonElement).click();
  await vi.waitFor(() => expect(send.mock.calls.filter(([message]) => message.kind === 'known.sync.engine.retry')).toHaveLength(1));
});

test('a blocked boundary opens the existing Reset confirmation and Cancel leaves the replica untouched', async () => {
  decisions = [{ ...remote, blockedReason: 'upload_boundary_changed', recoveryAction: 'reset_sync' }];
  attention = { ...attention, lastError: 'upload_boundary_changed', recoveryFrozen: true, terminal: true,
    retryAvailable: false, rebuildAvailable: true };
  bindSyncAttentionSettings(); await screen();
  document.querySelector<HTMLButtonElement>('[data-rejoin-recovery="reset_sync"]')!.click();
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('sync-attention-settings-rebuild'));
  expect(send.mock.calls.some(([message]) => String(message.kind).startsWith('known.scope.rebuild.'))).toBe(false);
  (document.activeElement as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.querySelector('.rebuild-confirm')).not.toBeNull());
  expect(document.querySelector('.rebuild-confirm-copy')!.textContent).toContain('2 changes that have not synced yet will be set aside');
  const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>('.rebuild-confirm button')).find(button => button.textContent === 'Cancel')!;
  cancel.click();
  await vi.waitFor(() => expect(document.querySelector('.rebuild-confirm')).toBeNull());
  expect(send.mock.calls.filter(([message]) => message.kind === 'known.scope.rebuild.preview')).toHaveLength(1);
  expect(send.mock.calls.some(([message]) => message.kind === 'known.scope.rebuild.confirm')).toBe(false);
  expect(resolves()).toEqual([]);
});

test.each(['pending_upload', 'native_unavailable'] as const)('a blocked %s decision can refresh without submitting a choice', async blockedReason => {
  decisions = [{ ...remote, blockedReason }]; const f = await screen();
  expect(action('keep_local')).toBeNull(); expect(action('apply_remote_delete')).toBeNull();
  const before = send.mock.calls.filter(([message]) => message.kind === 'known.sync.rejoinDecisions.get').length;
  decisions = [{ ...remote, affectedCount: 1 }];
  document.querySelector<HTMLButtonElement>('[data-rejoin-recovery="refresh"]')!.click();
  await vi.waitFor(() => expect(f.panel.textContent).toContain('current browser copy contains 1 item.'));
  expect(send.mock.calls.filter(([message]) => message.kind === 'known.sync.rejoinDecisions.get')).toHaveLength(before + 1);
  expect(confirmation()?.checked).toBe(false); expect(action('apply_remote_delete')?.disabled).toBe(true);
  expect(resolves()).toEqual([]);
});

test('an applying remote deletion retains its count without offering a second choice', async () => {
  decisions = [{ ...remote, state: 'applying' }]; const f = await screen();
  expect(f.panel.textContent).toContain('Finishing your saved choice');
  expect(action('keep_local')).toBeNull(); expect(action('apply_remote_delete')).toBeNull();
  expect(confirmation()).toBeNull(); expect(resolves()).toEqual([]);
});

test('navigation rechecks recovery availability and cannot activate a newly unavailable action', async () => {
  decisions = [{ ...remote, blockedReason: 'unknown_upload', recoveryAction: 'retry_sync' }];
  bindSyncAttentionSettings(); await screen();
  attention = { ...attention, retryAvailable: false };
  document.querySelector<HTMLButtonElement>('[data-rejoin-recovery="retry_sync"]')!.click();
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('sync-attention-settings'));
  expect(document.getElementById('sync-attention-settings-feedback')!.textContent).toContain('Sync status changed');
  expect(send.mock.calls.some(([message]) => message.kind === 'known.sync.engine.retry')).toBe(false);
  expect(resolves()).toEqual([]);
});

test('a recoverable issue focuses the existing issue Reset control without starting its confirmation', async () => {
  decisions = [{ ...remote, blockedReason: 'pending_upload', recoveryAction: 'reset_sync' }];
  attention = { ...attention, rebuildAvailable: true, retryAvailable: false, recoveryFrozen: false };
  bindSyncAttentionSettings(); await screen();
  document.querySelector<HTMLButtonElement>('[data-rejoin-recovery="reset_sync"]')!.click();
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('sync-attention-settings-issue-repair-rebuild'));
  expect(send.mock.calls.some(([message]) => String(message.kind).startsWith('known.scope.rebuild.'))).toBe(false);
  expect(resolves()).toEqual([]);
});

test('pagehide cancels navigation painting and both refresh intervals', async () => {
  vi.useFakeTimers();
  decisions = [{ ...remote, blockedReason: 'unknown_upload', recoveryAction: 'retry_sync' }];
  bindSyncAttentionSettings(); const f = await screen();
  let release!: (value: unknown) => void;
  const realSend = send.getMockImplementation()!;
  send.mockImplementation(message => message.kind === 'known.sync.attention.get'
    ? new Promise(resolve => { release = resolve; }) : realSend(message));
  document.querySelector<HTMLButtonElement>('[data-rejoin-recovery="retry_sync"]')!.click();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  window.dispatchEvent(new Event('pagehide')); const markup = document.body.innerHTML;
  release({ ok: true, attention }); await vi.advanceTimersByTimeAsync(0);
  expect(document.body.innerHTML).toBe(markup); expect(document.activeElement?.id).not.toBe('sync-attention-settings-retry');
  expect(vi.getTimerCount()).toBe(0); expect(f.onResolved).not.toHaveBeenCalled(); expect(resolves()).toEqual([]);
});

test.each([
  { ...remote, commandId: 'rejoin-order:folder' },
  { ...remote, blockedReason: 'unsupported' },
  { ...remote, recoveryAction: 'execute_now' },
])('invalid decision authority never exposes a remote-deletion choice: %j', async invalid => {
  send.mockResolvedValue({ ok: true, decisions: [invalid] });
  const panel = document.getElementById('rejoin-decisions')!;
  const ui = bindRejoinDecisions({ panel, show: vi.fn() }); ui.setLibraryId('library'); ui.onConnection(true);
  await vi.waitFor(() => expect(panel.textContent).toContain('could not be confirmed'));
  expect(action('keep_local')).toBeNull(); expect(action('apply_remote_delete')).toBeNull(); expect(resolves()).toEqual([]);
});

test('identical eight-second polling preserves the current confirmation and keyboard focus', async () => {
  vi.useFakeTimers(); const f = await screen(), checkbox = confirmation()!;
  checkbox.checked = true; checkbox.dispatchEvent(new Event('change')); checkbox.focus();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(send.mock.calls.filter(([message]) => message.kind === 'known.sync.rejoinDecisions.get')).toHaveLength(2);
  expect(confirmation()).toBe(checkbox); expect(checkbox.checked).toBe(true); expect(document.activeElement).toBe(checkbox);
  expect(action('apply_remote_delete')?.disabled).toBe(false);
  action('apply_remote_delete')!.click(); await vi.waitFor(() => expect(f.onResolved).toHaveBeenCalledTimes(1));
  expect(resolves()).toHaveLength(1);
});

test.each(['token', 'command', 'count', 'content'] as const)('a %s change invalidates consent and every retained old checkbox', async change => {
  const f = await screen(), checkbox = confirmation()!, oldDelete = action('apply_remote_delete')!;
  checkbox.checked = true; checkbox.dispatchEvent(new Event('change')); checkbox.focus();
  decisions = [{ ...remote, ...(change === 'token' ? { token: `sha256:${'c'.repeat(64)}` }
    : change === 'command' ? { commandId: 'rejoin-remote-delete:new-preview' }
      : change === 'count' ? { affectedCount: 4 } : { title: 'Updated browser content' }) }];
  await f.ui.refresh();
  expect(confirmation()).not.toBe(checkbox); expect(confirmation()?.checked).toBe(false);
  expect(action('apply_remote_delete')?.disabled).toBe(true); expect(document.activeElement).not.toBe(checkbox);
  oldDelete.click(); await Promise.resolve(); await Promise.resolve(); expect(resolves()).toEqual([]);
  confirmation()!.checked = true; confirmation()!.dispatchEvent(new Event('change'));
  action('apply_remote_delete')!.click(); await vi.waitFor(() => expect(f.onResolved).toHaveBeenCalledTimes(1));
  expect(resolves()).toHaveLength(1); expect(resolves()[0]![0]).toMatchObject({
    commandId: decisions[0]!.commandId, token: decisions[0]!.token, affectedCount: decisions[0]!.affectedCount });
});

test.each(['connection', 'library'] as const)('an %s reset clears consent even when the same decision returns', async reset => {
  const f = await screen(), checkbox = confirmation()!, oldDelete = action('apply_remote_delete')!;
  checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
  if (reset === 'connection') { f.ui.onConnection(false); f.ui.onConnection(true); }
  else { f.ui.setLibraryId('another-library'); f.ui.setLibraryId('library'); }
  await vi.waitFor(() => expect(confirmation()).not.toBeNull());
  expect(confirmation()).not.toBe(checkbox); expect(confirmation()?.checked).toBe(false);
  oldDelete.click(); await Promise.resolve(); await Promise.resolve(); expect(resolves()).toEqual([]);
  expect(action('apply_remote_delete')?.disabled).toBe(true);
});

test('an unconfirmed reply requires a new checkbox even when fresh evidence returns the same token', async () => {
  const f = await screen(), oldDelete = action('apply_remote_delete')!;
  confirmation()!.checked = true; confirmation()!.dispatchEvent(new Event('change'));
  result = { ok: false, error: 'extension_unavailable' }; oldDelete.click();
  await vi.waitFor(() => {
    expect(f.panel.textContent).toContain('The result could not be confirmed yet');
    expect(confirmation()?.disabled).toBe(false);
    expect(send.mock.calls.filter(([message]) => message.kind === 'known.sync.rejoinDecisions.get')).toHaveLength(2);
  });
  expect(confirmation()?.checked).toBe(false); expect(action('apply_remote_delete')?.disabled).toBe(true);
  expect(resolves()).toHaveLength(1); oldDelete.click(); await Promise.resolve(); await Promise.resolve();
  expect(resolves()).toHaveLength(1); expect(f.onResolved).not.toHaveBeenCalled();
  result = { ok: true, decisions: [] };
  confirmation()!.checked = true; confirmation()!.dispatchEvent(new Event('change')); action('apply_remote_delete')!.click();
  await vi.waitFor(() => expect(f.onResolved).toHaveBeenCalledTimes(1)); expect(resolves()).toHaveLength(2);
});
