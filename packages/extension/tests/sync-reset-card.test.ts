// @vitest-environment happy-dom
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, test, vi } from 'vitest';
import { cancelPendingResetConfirmation, rebuildFailureCopy, replicaRebuildConfirmation, storageResetConfirmation,
  storageResetDoneCopy, storageResetFailureCopy } from '../src/replica-rebuild-copy.js';
import { bindSyncAttentionSettings } from '../src/sync-attention-ui.js';
import { describeSyncAttention, type SyncAttentionInput } from '../src/sync-attention-view.js';
import type { PublicSyncAttention } from '../src/types.js';

/**
 * K3 (C-01, C-02) and W2A-01/W2A-02 on the Status card: the Reset button is on the card exactly when the attention read
 * says a Reset is possible; the confirmation says which kind of Reset it is and why; a Reset that is needed but blocked
 * says why instead of showing a button; a reset that cannot finish can be cancelled; a sync database that cannot be used
 * offers "Reset local sync data".
 */
afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const stuck: SyncAttentionInput = { phase: 'error', lastError: 'queue_state_invalid', retryAutomatic: false, recoveryFrozen: false, issueCount: 0 };

describe('the Reset button is on the card exactly when a Reset is possible', () => {
  test('in a terminal state, a stopped one and a frozen one that is not terminal, without a rule of its own about the freeze', () => {
    for (const input of [{ ...stuck, lastError: 'mapping_identity_conflict', recoveryFrozen: true }, stuck,
      { ...stuck, lastError: 'sync_failed', recoveryFrozen: true }]) {
      assert.equal(describeSyncAttention({ ...input, rebuildAvailable: true }).reset.show, true, input.lastError);
      assert.equal(describeSyncAttention({ ...input, rebuildAvailable: false }).reset.show, false, input.lastError);
      assert.equal(describeSyncAttention({ ...input }).reset.show, false, input.lastError);
    }
  });

  test('says which kind of Reset it is, and offers Cancel only for a reset that is pending', () => {
    assert.equal(describeSyncAttention({ ...stuck, rebuildAvailable: true }).reset.mode, 'local');
    assert.equal(describeSyncAttention({ ...stuck, rebuildAvailable: true, rebuildMode: 'server_fenced' }).reset.mode, 'server_fenced');
    assert.equal(describeSyncAttention({ ...stuck, rebuildAvailable: true }).reset.cancel, false);
    assert.equal(describeSyncAttention({ ...stuck, lastError: 'replica_rebuild_pending', rebuildAvailable: true, rebuildCancelAvailable: true }).reset.cancel, true);
  });

  test('a card without a Reset says why it has none: offline, or a bookmark change that has no result yet', () => {
    const offline = describeSyncAttention({ ...stuck, lastError: 'push_response_invalid', rebuildAvailable: false, rebuildMode: 'server_fenced',
      rebuildBlockedReason: 'offline', rebuildUnavailableReason: 'offline' });
    assert.equal(offline.reset.show, false);
    assert.equal(offline.reset.blocked, 'Resetting needs a connection, because a change may already have reached the server. Connect and try again.');
    assert.ok(offline.notes.lines.includes(offline.reset.blocked!));
    const unsettled = describeSyncAttention({ ...stuck, rebuildAvailable: false, rebuildBlockedReason: 'native_outcome_unsettled',
      rebuildUnavailableReason: 'native_outcome_unsettled' });
    assert.match(unsettled.notes.lines.join(' '), /no confirmed result yet, so Reset is not available\. Decide it under Waiting for you first/u);
  });

  test('a sentence that already says it is not said twice, and a healthy or available card says nothing', () => {
    const rebuild = describeSyncAttention({ ...stuck, lastError: 'mapping_identity_conflict', recoveryFrozen: true, rebuildAvailable: false,
      rebuildBlockedReason: 'offline', rebuildUnavailableReason: 'offline' });
    assert.match(rebuild.terminal.copy, /Resetting needs a connection/u);
    assert.deepEqual(rebuild.notes.lines.filter(line => line.includes('needs a connection')), []);
    assert.equal(describeSyncAttention({ ...stuck, rebuildAvailable: true, rebuildBlockedReason: 'offline' }).reset.blocked, undefined);
    assert.equal(describeSyncAttention({ rebuildAvailable: false, rebuildUnavailableReason: 'rebuild_not_required' }).reset.blocked, undefined);
  });

  test('every Reset-only state points at the button when the card has one, and at the reason when it does not', () => {
    const withButton = describeSyncAttention({ ...stuck, lastError: 'mapping_identity_conflict', recoveryFrozen: true, rebuildAvailable: true });
    assert.match(withButton.terminal.copy, /Reset sync on this device to continue/u);
    const noButton = describeSyncAttention({ ...stuck, lastError: 'mapping_identity_conflict', recoveryFrozen: true, rebuildAvailable: false });
    assert.doesNotMatch(noButton.terminal.copy, /Reset sync on this device to continue/u);
  });
});

describe('the confirmation says which Reset it is, and why', () => {
  test('a local Reset keeps its words: the bookmarks stay, the unsent changes are set aside', () => {
    assert.match(replicaRebuildConfirmation(0), /^Your bookmarks stay on this device and in your library\./u);
    assert.match(replicaRebuildConfirmation(2, 'local'), /2 changes that have not synced yet will be set aside and not retried/u);
    assert.doesNotMatch(replicaRebuildConfirmation(2, 'local'), /connection|server/u);
  });

  test('a server-fenced Reset says a change may already be on the server, that the server is told first, and that it needs a connection', () => {
    for (const queued of [0, 3]) {
      const text = replicaRebuildConfirmation(queued, 'server_fenced');
      assert.match(text, /may already have reached the server, and sync can't tell whether it did/u);
      assert.match(text, /the server first stops taking anything from this browser's current sync copy/u);
      assert.match(text, /This needs a connection\./u);
      assert.match(text, /Your bookmarks stay on this device and in your library\./u);
      assert.match(text, /Reset sync now\?$/u);
      assert.equal(/3 changes that have not synced yet will be set aside/u.test(text), queued === 3);
    }
    assert.notEqual(replicaRebuildConfirmation(1, 'server_fenced'), replicaRebuildConfirmation(1, 'local'));
  });

  test('a Reset that did not start says nothing was reset, with what to do', () => {
    assert.match(rebuildFailureCopy('offline'), /needs a connection/u);
    assert.match(rebuildFailureCopy('native_outcome_unsettled'), /Waiting for you/u);
    assert.match(rebuildFailureCopy('fence_unauthorized'), /Nothing was reset\. Sign in again from Account, then reset\./u);
    assert.match(rebuildFailureCopy('rate_limited'), /Nothing was reset; try again in a minute/u);
    assert.match(rebuildFailureCopy('server_unavailable'), /Nothing was reset; try again later/u);
    assert.match(rebuildFailureCopy('fence_session_unavailable'), /Nothing was reset; try again/u);
    assert.match(rebuildFailureCopy('fence_refused'), /did not accept the reset \(fence_refused\)\. Nothing was reset/u);
    assert.match(rebuildFailureCopy('account_switch'), /different account/u);
    assert.match(rebuildFailureCopy('rebuild_not_cancellable'), /already started and can only be finished/u);
    assert.match(rebuildFailureCopy('stale_ref'), /Sync state changed/u);
    assert.equal(rebuildFailureCopy('anything_else'), "Reset isn't finished yet. Try again.");
  });

  test('giving up a pending reset says nothing was changed and the reset can be pressed again', () => {
    assert.match(cancelPendingResetConfirmation(), /Nothing on this device has been changed yet, so sync stays as it was/u);
  });
});

describe('resetting the sync data itself says what is saved first', () => {
  test('the unsent changes it can read are saved to an archive; nothing readable, or nothing at all, says so', () => {
    assert.match(storageResetConfirmation({ unsentChanges: 1, readable: true }), /^This resets the sync data stored in this browser\. Your bookmarks are not changed\. 1 unsent change is saved to a local archive first\./u);
    assert.match(storageResetConfirmation({ unsentChanges: 12, readable: true }), /12 unsent changes are saved to a local archive first/u);
    assert.match(storageResetConfirmation({ unsentChanges: 0, readable: true }), /No unsent changes were found/u);
    assert.match(storageResetConfirmation({ unsentChanges: 0, readable: false }), /could not be read at all, so nothing can be saved first/u);
    assert.match(storageResetConfirmation({ unsentChanges: 0, readable: true }), /becomes a new device on the server\. Reset the sync data now\?$/u);
  });

  test('says what was kept and what was too much, and why a reset did not run', () => {
    assert.equal(storageResetDoneCopy({ archivedChanges: 0, omittedChanges: 0 }), 'Sync data on this device was reset. Your bookmarks were not changed.');
    assert.match(storageResetDoneCopy({ archivedChanges: 4, omittedChanges: 0 }), /4 unsent changes were saved to a local archive\./u);
    assert.match(storageResetDoneCopy({ archivedChanges: 20000, omittedChanges: 1 }), /1 more change was too much to keep\./u);
    assert.match(storageResetFailureCopy('archive_failed'), /could not save a copy of your unsent changes, so nothing was reset/u);
    assert.match(storageResetFailureCopy('storage_reset_blocked'), /Close other Know-N windows; the reset finishes by itself/u);
    assert.match(storageResetFailureCopy('storage_reset_not_needed'), /works now, so there is nothing to reset/u);
    assert.match(storageResetFailureCopy('storage_reset_failed'), /could not finish \(storage_reset_failed\)\. Try again\./u);
  });
});

describe('the Status card around the Reset buttons', () => {
  const base: PublicSyncAttention = { recoveryFrozen: false, queueProjection: 'idle', rejectedPending: false, conflictPending: false,
    nativeWaitPending: false, waitCount: 0, terminal: false, retryAutomatic: false, phase: 'error', lastError: 'queue_state_invalid' };

  interface Fake { attention: PublicSyncAttention; replies: Record<string, unknown>; sent: Array<Record<string, unknown>> }

  async function mount(attention: PublicSyncAttention, replies: Record<string, unknown> = {}): Promise<Fake> {
    vi.useFakeTimers();
    const fake: Fake = { attention, replies, sent: [] };
    vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, sendMessage: async (message: { kind: string }) => {
      fake.sent.push(message as never);
      if (message.kind === 'known.sync.attention.get') return { ok: true, attention: fake.attention };
      return fake.replies[message.kind] ?? { ok: false, error: 'not_connected' };
    } }, tabs: { create: vi.fn() } });
    const markup = await readFile('options.html', 'utf8');
    const start = markup.indexOf('<section id="sync-attention-settings"');
    document.body.innerHTML = markup.slice(start, markup.indexOf('<section id="native-wait-settings"', start));
    document.body.dataset.pane = 'sync';
    bindSyncAttentionSettings();
    await vi.advanceTimersByTimeAsync(0);
    return fake;
  }
  const node = (suffix: string) => document.getElementById(`sync-attention-settings-${suffix}`) as HTMLElement;
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const confirmText = () => document.querySelector('.rebuild-confirm-copy')?.textContent;
  const press = async (element: Element | null) => { (element as HTMLButtonElement).click(); await settle(); await settle(); };
  const sentKinds = (fake: Fake) => fake.sent.map(message => String(message.kind));

  test('a terminal card shows the button when a Reset is possible, and hides it with the reason when it is not', async () => {
    const terminal = { ...base, lastError: 'mapping_identity_conflict', terminal: true, terminalCode: 'mapping_identity_conflict' as const, recoveryFrozen: true };
    const fake = await mount({ ...terminal, rebuildAvailable: true, rebuildMode: 'local' });
    assert.equal(node('terminal').hidden, false);
    assert.equal(node('rebuild').hidden, false);
    fake.attention = { ...terminal, rebuildAvailable: false, rebuildMode: 'server_fenced', rebuildBlockedReason: 'offline', rebuildUnavailableReason: 'offline' };
    await vi.advanceTimersByTimeAsync(8_000);
    assert.equal(node('rebuild').hidden, true);
    assert.match(node('terminal-copy').textContent!, /Resetting needs a connection, because a change may already have reached the server/u);
    assert.equal(node('rebuild-cancel').hidden, true);
  });

  test('outside a terminal card the Reset is under the card whenever it is possible, frozen or not', async () => {
    await mount({ ...base, recoveryFrozen: true, rebuildAvailable: true });
    const repair = document.getElementById('sync-attention-settings-issue-repair')!;
    assert.equal(repair.hidden, false, 'a frozen engine used to hide it');
    const calm = await mount({ ...base, lastError: undefined, phase: 'sleeping', retryAutomatic: true, rebuildAvailable: false, rebuildUnavailableReason: 'rebuild_not_required' } as never);
    assert.equal(document.getElementById('sync-attention-settings-issue-repair')!.hidden, true);
    assert.deepEqual(sentKinds(calm).filter(kind => kind.startsWith('known.scope.rebuild')), []);
  });

  test('a local Reset is previewed, confirmed in words, and sent with the preview it was confirmed for', async () => {
    const preview = { replicaId: 'r1', generation: 2, revision: 7, queuedOperations: 2, targetFence: 'sha256:x', mode: 'local' };
    const fake = await mount({ ...base, rebuildAvailable: true, rebuildMode: 'local' }, {
      'known.scope.rebuild.preview': { ok: true, preview }, 'known.scope.rebuild.confirm': { ok: true, result: 'setup_required' } });
    await press(document.querySelector('#sync-attention-settings-issue-repair button'));
    assert.match(confirmText()!, /2 changes that have not synced yet will be set aside and not retried/u);
    assert.doesNotMatch(confirmText()!, /needs a connection/u);
    await press(document.querySelector('.rebuild-confirm .btn-danger'));
    const confirm = fake.sent.find(message => message.kind === 'known.scope.rebuild.confirm')!;
    assert.deepEqual(confirm, { kind: 'known.scope.rebuild.confirm', userGesture: true, replicaId: 'r1', generation: 2, revision: 7, targetFence: 'sha256:x' });
  });

  test('a server-fenced Reset spells out why the server is told first and that a connection is needed; nothing is sent before the answer', async () => {
    const preview = { replicaId: 'r1', generation: 2, revision: 7, queuedOperations: 0, targetFence: 'sha256:x', mode: 'server_fenced' };
    const fake = await mount({ ...base, rebuildAvailable: true, rebuildMode: 'server_fenced' }, {
      'known.scope.rebuild.preview': { ok: true, preview }, 'known.scope.rebuild.confirm': { ok: false, code: 'fence_unauthorized' } });
    await press(document.querySelector('#sync-attention-settings-issue-repair button'));
    assert.match(confirmText()!, /may already have reached the server/u);
    assert.match(confirmText()!, /This needs a connection\./u);
    assert.equal(sentKinds(fake).includes('known.scope.rebuild.confirm'), false, 'only the preview so far');
    await press(document.querySelector('.rebuild-confirm .btn-danger'));
    assert.match(document.getElementById('sync-attention-settings-issue-repair-feedback')!.textContent!, /Your sign-in no longer works, so the server could not be told\. Nothing was reset\./u);
  });

  test('saying no sends nothing and gives the button back', async () => {
    const preview = { replicaId: 'r1', generation: 2, revision: 7, queuedOperations: 0, targetFence: 'sha256:x', mode: 'local' };
    const fake = await mount({ ...base, rebuildAvailable: true }, { 'known.scope.rebuild.preview': { ok: true, preview } });
    await press(document.querySelector('#sync-attention-settings-issue-repair button'));
    await press(document.querySelector('.rebuild-confirm .btn-ghost'));
    assert.equal(document.querySelector('.rebuild-confirm'), null);
    assert.equal(sentKinds(fake).includes('known.scope.rebuild.confirm'), false);
    assert.equal((document.querySelector('#sync-attention-settings-issue-repair button') as HTMLButtonElement).disabled, false);
  });

  test('a preview that is refused says why: offline, or a bookmark change with no result yet', async () => {
    await mount({ ...base, rebuildAvailable: true }, { 'known.scope.rebuild.preview': { ok: false, code: 'offline' } });
    await press(document.querySelector('#sync-attention-settings-issue-repair button'));
    assert.match(document.getElementById('sync-attention-settings-issue-repair-feedback')!.textContent!, /Resetting needs a connection/u);
  });

  test('a pending reset that cannot finish offers Cancel pending reset, asks first, and reads the card again', async () => {
    const pending = { ...base, lastError: 'replica_rebuild_pending', terminal: true, terminalCode: 'replica_rebuild_pending' as const, recoveryFrozen: true,
      rebuildAvailable: true, rebuildMode: 'local' as const, rebuildCancelAvailable: true, issueCount: 1,
      issues: [{ direction: 'local' as const, code: 'sync_step_failed', stage: 'rebuild_resume', rootCause: 'scope_mismatch', count: 3 }] };
    const fake = await mount(pending, { 'known.scope.rebuild.cancel': { ok: true, result: 'cancelled' } });
    assert.equal(node('rebuild-cancel').hidden, false);
    assert.equal(node('rebuild-cancel').textContent, 'Cancel pending reset');
    assert.match(node('terminal-copy').textContent!, /Press Reset sync on this device to finish it/u);
    assert.match(document.querySelector('#sync-attention-settings-issues .set-row-hint')!.textContent!, /The reset could not finish \(scope_mismatch\)/u);
    await press(node('rebuild-cancel'));
    assert.match(confirmText()!, /Nothing on this device has been changed yet/u);
    assert.equal(sentKinds(fake).includes('known.scope.rebuild.cancel'), false);
    fake.attention = base;
    await press(document.querySelector('.rebuild-confirm .btn-danger'));
    assert.deepEqual(fake.sent.find(message => message.kind === 'known.scope.rebuild.cancel'), { kind: 'known.scope.rebuild.cancel', userGesture: true });
    assert.equal(node('feedback').textContent, 'The reset was cancelled. Sync on this device is as it was before.');
    assert.equal(node('terminal').hidden, true, 'the card was read again');
    assert.equal(node('rebuild-cancel').hidden, true);
  });

  test('a reset that has already started cannot be cancelled, and the card says so', async () => {
    const pending = { ...base, lastError: 'replica_rebuild_pending', terminal: true, terminalCode: 'replica_rebuild_pending' as const, recoveryFrozen: true,
      rebuildAvailable: true, rebuildCancelAvailable: true };
    const fake = await mount(pending, { 'known.scope.rebuild.cancel': { ok: false, code: 'rebuild_not_cancellable' } });
    fake.attention = { ...pending, rebuildCancelAvailable: undefined };
    await press(node('rebuild-cancel'));
    await press(document.querySelector('.rebuild-confirm .btn-danger'));
    assert.match(node('feedback').textContent!, /already started and can only be finished/u);
    assert.equal(node('rebuild-cancel').hidden, true);
  });

  test('a sync database that cannot be used says so, lists no items, and offers Reset local sync data', async () => {
    const newer: PublicSyncAttention = { ...base, lastError: 'future_schema', storageState: 'newer_version', storageResetAvailable: true,
      terminal: true, issueCount: 1, rebuildAvailable: false, issues: [{ direction: 'local', code: 'future_schema', rootCause: 'newer_version' }] };
    const fake = await mount(newer, {
      'known.sync.storage.reset.preview': { ok: true, preview: { state: 'newer_version', code: 'future_schema', unsentChanges: 3, readable: true } },
      'known.sync.storage.reset.confirm': { ok: true, result: 'reset', archivedChanges: 3, omittedChanges: 0 } });
    assert.match(node('recovery-copy').textContent!, /saved by a newer version of the extension.*Update the extension, or reset the sync data on this device\./u);
    assert.equal(node('issues').hidden, true);
    assert.equal(node('storage-reset').hidden, false);
    assert.equal(node('storage-reset').textContent, 'Reset local sync data');
    assert.equal(document.getElementById('sync-attention-settings-issue-repair')!.hidden, true, 'the extension-side Reset needs the very database that cannot be read');
    await press(node('storage-reset'));
    assert.match(confirmText()!, /3 unsent changes are saved to a local archive first/u);
    assert.equal(sentKinds(fake).includes('known.sync.storage.reset.confirm'), false);
    fake.attention = { ...base, lastError: undefined, phase: 'sleeping', retryAutomatic: true } as never;
    await press(document.querySelector('.rebuild-confirm .btn-danger'));
    assert.deepEqual(fake.sent.find(message => message.kind === 'known.sync.storage.reset.confirm'), { kind: 'known.sync.storage.reset.confirm', userGesture: true });
    assert.match(node('feedback').textContent!, /Sync data on this device was reset\. Your bookmarks were not changed\. 3 unsent changes were saved to a local archive\./u);
  });

  test('a failure of the data reset says nothing changed when the copy could not be saved', async () => {
    const damaged: PublicSyncAttention = { ...base, lastError: 'diagnostic_read_only', storageState: 'read_only', storageResetAvailable: true, terminal: true };
    await mount(damaged, {
      'known.sync.storage.reset.preview': { ok: true, preview: { state: 'read_only', code: 'diagnostic_read_only', unsentChanges: 0, readable: false } },
      'known.sync.storage.reset.confirm': { ok: false, code: 'archive_failed' } });
    await press(node('storage-reset'));
    assert.match(confirmText()!, /could not be read at all, so nothing can be saved first/u);
    await press(document.querySelector('.rebuild-confirm .btn-danger'));
    assert.match(node('feedback').textContent!, /could not save a copy of your unsent changes, so nothing was reset/u);
  });

  test('a storage failure that mends itself says it retries, and what to do if it does not; no reset button without the capability', async () => {
    await mount({ ...base, lastError: 'quota_exceeded', storageState: 'unavailable', terminal: false, retryAutomatic: true, retryAvailable: true });
    assert.match(node('recovery-copy').textContent!, /no room left to save sync data.*If it keeps happening, free some disk space or reset the sync data on this device\./u);
    assert.equal(node('storage-reset').hidden, true);
  });
});
