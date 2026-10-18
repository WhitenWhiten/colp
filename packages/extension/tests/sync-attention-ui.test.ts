/**
 * S7 / B2 (SR-09 popup · SR-11 · SR-04/SR-13 A-10): the popup and settings
 * contract for the paused / frozen replica exits.
 *
 * Same shape as `native-wait-ui.test.ts`: every string and decision comes from an
 * exported pure function, and the markup/worker wiring is pinned by readFile.
 * The engine-driven half of A-10 ("terminal does not schedule, but the exit
 * renders") lives in `durable-sync-engine-parked-scope.test.ts`.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import { holdsUnprovenIdentity } from '../src/sync-failure-class.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { validSyncAttentionRequest } from '../src/sw/messages.js';
import {
  SYNC_ATTENTION_CONFLICT_LABEL, SYNC_ATTENTION_COPIED_COPY, SYNC_ATTENTION_COPY_DIAGNOSTICS_LABEL,
  SYNC_ATTENTION_COPY_FAILED_COPY, SYNC_ATTENTION_OPTIONS_HOST,
  SYNC_ATTENTION_CENTER_LABEL, SYNC_MINIMUM_CYCLE_COPY, describeSyncAttention, inboundPauseCopy,
  isTerminalSyncAttention, rejectedWorkCopy, syncAttentionInput, syncAttentionTerminalCode, syncCenterHref,
  terminalFreezeReasonCopy, terminalFreezeReport, withNativeWaitFallback,
} from '../src/sync-attention-ui.js';
import type { PublicSyncAttention, RemoteDeleteResponse } from '../src/types.js';

const SYNC_CENTER = 'https://known.example/sync';

function attention(overrides: Partial<PublicSyncAttention> = {}): PublicSyncAttention {
  return { recoveryFrozen: false, queueProjection: 'idle', rejectedPending: false, conflictPending: false,
    nativeWaitPending: false, waitCount: 0, terminal: false, ...overrides };
}

function policy(overrides: Partial<Extract<RemoteDeleteResponse, { ok: true }>> = {}): RemoteDeleteResponse {
  return { ok: true, policy: 'sync', casVersion: 0, pendingCount: 0, pending: [], conflictPending: false,
    conflictHref: SYNC_CENTER, ...overrides };
}

describe('A-10 terminal freeze predicate and copy', () => {
  test('classifies exactly the engine terminal set, reusing holdsUnprovenIdentity', () => {
    assert.equal(syncAttentionTerminalCode('payload_too_large', undefined), 'payload_too_large');
    assert.equal(syncAttentionTerminalCode(undefined, 'payload_too_large'), 'payload_too_large');
    for (const code of ['recovery_identity_unproven', 'deletion_identity_unproven'] as const) {
      // The engine's own gate (durable-sync-engine.ts wakeOnce) is this predicate.
      assert.equal(holdsUnprovenIdentity(code), true, code);
      assert.equal(syncAttentionTerminalCode(code, undefined), code);
      assert.equal(syncAttentionTerminalCode(undefined, code), code);
    }
    // The scope code wins when both rows carry a code: it is the recorded reason.
    assert.equal(syncAttentionTerminalCode('payload_too_large', 'recovery_identity_unproven'),
      'recovery_identity_unproven');
    for (const code of ['network_unavailable', 'push_rejected', 'bookmark_api_error', 'stale_replica',
      'recovery_required', 'snapshot_page_missing', 'sync_cursor_expired', '']) {
      assert.equal(syncAttentionTerminalCode(code, undefined), undefined, code);
      assert.equal(syncAttentionTerminalCode(undefined, code), undefined, code);
    }
    assert.equal(isTerminalSyncAttention({ lastError: 'payload_too_large' }), true);
    assert.equal(isTerminalSyncAttention({ recoveryCode: 'recovery_identity_unproven' }), true);
    assert.equal(isTerminalSyncAttention({ lastError: 'network_unavailable', phase: 'offline' }), false);
  });

  test('explains the freeze with its reason, diagnostics and clipboard report', () => {
    for (const code of ['payload_too_large', 'recovery_identity_unproven', 'deletion_identity_unproven'] as const) {
      const copy = terminalFreezeReasonCopy(code);
      assert.match(copy, /Sync on this device has stopped/, code);
    }
    const input = { lastError: 'payload_too_large', recoveryCode: 'payload_too_large', phase: 'recovery' };
    assert.match(terminalFreezeReasonCopy('payload_too_large'), /transfer size/);
    assert.match(terminalFreezeReasonCopy('mapping_identity_collision'), /internal mismatch/);
    assert.doesNotMatch(terminalFreezeReasonCopy('mapping_identity_collision'), /missing/);
    // A missing half is stated as unrecorded, never invented.
    assert.match(terminalFreezeReport({ lastError: 'payload_too_large' }), /recoveryCode: \(not recorded\)/);
    const report = terminalFreezeReport(input, SYNC_CENTER);
    assert.match(report, /sync on this device has stopped/);
    assert.match(report, /recoveryCode: payload_too_large/);
    assert.match(report, /lastError: payload_too_large/);
    assert.match(report, /enginePhase: recovery/);
    assert.match(report, /syncCenter: https:\/\/known\.example\/sync/);
    assert.doesNotMatch(terminalFreezeReport(input), /syncCenter:/, 'no href, no link line');
  });

  test('renders the actionable exit alongside (not instead of) needsAttention', () => {
    const view = describeSyncAttention(syncAttentionInput(
      attention({ lastError: 'payload_too_large', recoveryCode: 'payload_too_large', phase: 'recovery',
        recoveryFrozen: true, terminal: true, terminalCode: 'payload_too_large' }),
      policy()));
    assert.equal(view.terminal.show, true);
    assert.equal(view.terminal.code, 'payload_too_large');
    assert.match(view.terminal.copy, /Sync on this device has stopped/);
    assert.equal(view.terminal.copyDiagnosticsLabel, SYNC_ATTENTION_COPY_DIAGNOSTICS_LABEL);
    assert.match(view.terminal.copyDiagnosticsLabel, /Copy diagnostics/);
    assert.equal(view.terminal.syncCenter.show, true);
    assert.equal(view.terminal.syncCenter.href, SYNC_CENTER);
    assert.equal(view.terminal.syncCenter.label, SYNC_ATTENTION_CENTER_LABEL);
    assert.match(view.terminal.syncCenter.label, /^Open Sync center on the web$/);
    // The two codes also arrive when only the scope row survived.
    const scopeOnly = describeSyncAttention(syncAttentionInput(
      attention({ recoveryCode: 'recovery_identity_unproven', lastError: 'recovery_identity_unproven' }),
      policy()));
    assert.equal(scopeOnly.terminal.show, true);
    assert.match(scopeOnly.terminal.report, /recovery_identity_unproven/);
    // No backend href means no rebuild link at all.
    const noHref = describeSyncAttention(syncAttentionInput(
      attention({ lastError: 'payload_too_large' }), { ok: false, error: 'not_connected' }));
    assert.equal(noHref.terminal.show, true);
    assert.equal(noHref.terminal.syncCenter.show, false);
    assert.equal(noHref.terminal.syncCenter.href, undefined);
  });
});

describe('SR-09 inbound pause copy', () => {
  test('states the exact blast radius and the minimum MV3 cycle', () => {
    const copy = inboundPauseCopy({ waitCount: 1 });
    assert.match(copy, /Incoming sync from Know-N is paused\. Uploads from this device are not affected/);
    assert.match(copy, /1 cloud item is waiting for your decision/);
    assert.match(copy, /no more often than every 30 seconds/);
    assert.match(SYNC_MINIMUM_CYCLE_COPY, /30 seconds/);
    const deletions = inboundPauseCopy({ remoteDeletePendingCount: 2 });
    assert.match(deletions, /2 cloud deletions are waiting for your decision/);
    assert.match(deletions, /Incoming sync from Know-N is paused/);
  });

  test('a native wait, a remote-delete decision or the engine flag all raise the pause line', () => {
    for (const input of [{ waitCount: 1 }, { waitCount: 3 }, { nativeWaitPending: true },
      { remoteDeletePendingCount: 1 }]) {
      assert.equal(describeSyncAttention(input).pause.show, true, JSON.stringify(input));
    }
    for (const input of [{}, { waitCount: 0 }, { remoteDeletePendingCount: 0 }]) {
      assert.equal(describeSyncAttention(input).pause.show, false, JSON.stringify(input));
    }
    const wait = describeSyncAttention(syncAttentionInput(attention({ waitCount: 2, nativeWaitPending: true }),
      policy()));
    assert.equal(wait.pause.nativeWait, true);
    assert.equal(wait.terminal.show, false);
    assert.equal(wait.conflict.show, false);
    // A pending remote-delete decision parks Pull through its own
    // `awaiting_confirmation` event, but asks for the inbox, not for the wait card.
    const inbox = describeSyncAttention(syncAttentionInput(attention(), policy({ pendingCount: 4 })));
    assert.equal(inbox.pause.show, true);
    assert.equal(inbox.pause.nativeWait, false);
    assert.equal(inbox.pause.remoteDeletePending, true);
    assert.match(inbox.pause.copy, /4 cloud deletions are waiting/);
  });

  test('the native-wait list fallback can only add a pause, never clear one', () => {
    // The aggregate is unavailable (signed out, worker asleep): the list read still parks.
    const fallback = withNativeWaitFallback({}, 2);
    assert.equal(fallback.waitCount, 2);
    assert.equal(fallback.nativeWaitPending, true);
    assert.match(describeSyncAttention(fallback).pause.copy, /2 cloud items are waiting/);
    assert.equal(describeSyncAttention(withNativeWaitFallback({}, 0)).pause.show, false);
    // An aggregate answer with no waits is never overwritten by a stale fallback.
    const answered = withNativeWaitFallback({ waitCount: 0 }, 2);
    assert.equal(answered.waitCount, 2, 'a listed wait is real even when the aggregate missed it');
    const alreadyWaits = withNativeWaitFallback({ waitCount: 3, nativeWaitPending: true }, 1);
    assert.equal(alreadyWaits.waitCount, 3);
  });

  test('rejected work is reported without pretending it is a conflict or a pause', () => {
    const view = describeSyncAttention({ rejectedPending: true });
    assert.equal(view.rejected.show, true);
    assert.match(view.rejected.copy, /could not be synced/);
    assert.match(rejectedWorkCopy(), /will not retry automatically/);
    assert.equal(view.conflict.show, false);
    assert.equal(view.pause.show, false);
    // A terminal freeze is the stronger statement; the rejected line stays quiet.
    assert.equal(describeSyncAttention({ rejectedPending: true, lastError: 'payload_too_large' }).rejected.show, false);
  });
});

describe('SR-11 conflict deep link', () => {
  test('shows the backend href for a conflict and hides everything without one', () => {
    const conflict = describeSyncAttention({ queueProjection: 'conflict', conflictHref: SYNC_CENTER });
    assert.equal(conflict.conflict.show, true);
    assert.equal(conflict.conflict.href, SYNC_CENTER);
    assert.equal(conflict.conflict.label, SYNC_ATTENTION_CONFLICT_LABEL);
    assert.equal(describeSyncAttention({ conflictPending: true, conflictHref: SYNC_CENTER }).conflict.show, true);
    // Both signals together still need a usable href.
    for (const href of [undefined, '', '   ', 'not-a-url', 'javascript:alert(1)', 'chrome-extension://x/sync',
      'data:text/html,x']) {
      const view = describeSyncAttention({ conflictPending: true, queueProjection: 'conflict',
        ...(href === undefined ? {} : { conflictHref: href }) });
      assert.equal(view.conflict.show, false, String(href));
      assert.equal(view.conflict.href, undefined, String(href));
    }
    // An idle queue is not a conflict even when the policy carries an href.
    assert.equal(describeSyncAttention({ queueProjection: 'syncing', conflictHref: SYNC_CENTER }).conflict.show, false);
    assert.equal(syncCenterHref(SYNC_CENTER), SYNC_CENTER);
    assert.equal(syncCenterHref('http://127.0.0.1:4173/sync'), 'http://127.0.0.1:4173/sync');
    assert.equal(syncCenterHref(undefined), undefined);
    assert.equal(syncCenterHref('javascript:alert(1)'), undefined);
  });

  test('merges the engine projection with the remote-delete policy without inventing an href', () => {
    const merged = syncAttentionInput(attention({ queueProjection: 'conflict' }),
      policy({ conflictPending: true }));
    assert.equal(merged.conflictPending, true);
    assert.equal(merged.conflictHref, SYNC_CENTER);
    const noHref = syncAttentionInput(attention({ queueProjection: 'conflict' }),
      policy({ conflictPending: true, conflictHref: 'javascript:alert(1)' }));
    assert.equal(noHref.conflictHref, undefined);
    assert.equal(describeSyncAttention(noHref).conflict.show, false);
    const offline = syncAttentionInput(attention({ queueProjection: 'conflict' }), { ok: false, error: 'not_connected' });
    assert.equal(offline.conflictHref, undefined);
    assert.equal(offline.remoteDeletePendingCount, 0);
  });
});

describe('sync attention wiring', () => {
  test('the aggregate is read-only: no scope means a refusal, a broken read a state error', async () => {
    const refused = await handleSyncAttentionRequest({
      scope: async () => { throw new Error('not_connected'); }, store: {} as never });
    assert.deepEqual(refused, { ok: false, error: 'not_connected' });
    const broken = await handleSyncAttentionRequest({
      scope: async () => ({ environment: 'production', serverId: 's', serverOrigin: 'https://known.example',
        accountId: 'a', browserProfileId: 'p', collectionId: 'c', replicaId: 'r', generation: 1 }),
      store: {} as never });
    assert.deepEqual(broken, { ok: false, error: 'state_unavailable' });
  });

  test('accepts only the parameterless read-only message', () => {
    assert.equal(validSyncAttentionRequest({ kind: 'known.sync.attention.get' }), true);
    assert.equal(validSyncAttentionRequest(null), false);
    assert.equal(validSyncAttentionRequest('known.sync.attention.get'), false);
    assert.equal(validSyncAttentionRequest([{ kind: 'known.sync.attention.get' }]), false);
    assert.equal(validSyncAttentionRequest({}), false);
    assert.equal(validSyncAttentionRequest({ kind: 'known.sync.attention.get', extra: 1 }), false);
    assert.equal(validSyncAttentionRequest({ kind: 'known.sync.attention.get', userGesture: true }), false);
    assert.equal(validSyncAttentionRequest({ kind: 'known.nativeWait.list' }), false);
  });

  test('popup and options keep the exits wired to the read-only facts', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const ui = await readFile(resolve(root, 'src/sync-attention-ui.ts'), 'utf8');
    const swHandler = await readFile(resolve(root, 'src/sw/sync-attention.ts'), 'utf8');
    const worker = await readFile(resolve(root, 'src/service-worker.ts'), 'utf8');
    const messages = await readFile(resolve(root, 'src/sw/messages.ts'), 'utf8');
    const popup = await readFile(resolve(root, 'src/popup.ts'), 'utf8');
    const popupHtml = await readFile(resolve(root, 'popup.html'), 'utf8');
    const options = await readFile(resolve(root, 'src/options.ts'), 'utf8');
    const optionsHtml = await readFile(resolve(root, 'options.html'), 'utf8');
    const optionsCss = await readFile(resolve(root, 'options.css'), 'utf8');
    const remoteDeleteUi = await readFile(resolve(root, 'src/remote-delete-ui.ts'), 'utf8');

    assert.match(ui, /known\.sync\.attention\.get/);
    assert.match(ui, /known\.nativeWait\.list/);
    assert.match(ui, /known\.remoteDelete\.policy\.get/);
    assert.match(ui, /holdsUnprovenIdentity/);
    assert.match(ui, /withNativeWaitFallback/);
    assert.doesNotMatch(ui, /innerHTML|insertAdjacentHTML|document\.write/);
    assert.match(swHandler, /projectNativeWaits/);
    assert.match(swHandler, /queueStatusProjection/);
    assert.match(swHandler, /metadata\?\.recoveryCode/);
    assert.match(worker, /validSyncAttentionRequest\(message\)/);
    assert.match(worker, /handleSyncAttentionRequest\(syncAttentionDeps\)/);
    assert.match(messages, /validSyncAttentionRequest/);

    /* T12: the popup no longer hosts an attention card — sync state compresses
       into the header chip; the SR-01 deep link survives in the overflow menu. */
    assert.match(popup, /open-native-wait/);
    // SR-09: the pause copy asks for the SR-01 card and the binder can only
    // reveal that deep link, never hide a pending wait.
    assert.match(ui, /getElementById\('open-native-wait'\)/);
    assert.ok(popupHtml.includes('id="open-native-wait"'));
    assert.ok(popupHtml.includes('View items waiting for confirmation'));

    assert.match(options, /bindSecondarySettings\(\)/);
    assert.match(await readFile(new URL('../src/options-secondary-settings.ts',import.meta.url),'utf8'), /initializeSettingsSection\('sync-attention-settings', bindSyncAttentionSettings\)/);
    for (const marker of [`id="${SYNC_ATTENTION_OPTIONS_HOST}"`,
      'id="sync-attention-settings-rejected"',
      'id="sync-attention-settings-terminal"', 'id="sync-attention-settings-copy-diagnostics"',
      'id="sync-attention-settings-sync-center"']) {
      assert.ok(optionsHtml.includes(marker), marker);
    }
    assert.ok(optionsHtml.indexOf('id="sync-card"') < optionsHtml.indexOf('id="sync-attention-settings"'),
      'the attention card lives inside the Sync center pane');
    assert.ok(optionsHtml.indexOf('id="sync-attention-settings"') < optionsHtml.indexOf('id="native-wait-settings"'),
      'a stopped sync leads the Status page, ahead of what waits');
    assert.match(ui, /dataset\.pane === 'sync'/);
    assert.match(optionsCss, /\.sync-attention-settings \{/);
    assert.match(optionsHtml, /class="inline-alert sync-attention-terminal" data-tone="danger"/);

    // SR-11 on the settings side: the existing conflict hint keeps taking the
    // backend href, and this card does not duplicate it.
    assert.match(remoteDeleteUi, /conflictLink\.href = response\.conflictHref/);
    assert.ok(optionsHtml.includes('id="remote-delete-conflict-link"'));
    assert.equal(optionsHtml.includes('id="sync-attention-settings-conflict-link"'), false,
      'the settings conflict link has a single owner');
    assert.ok(optionsHtml.includes(SYNC_ATTENTION_CONFLICT_LABEL));
    // The popup no longer carries the attention card — Options owns those exits.
    assert.ok(optionsHtml.includes(SYNC_ATTENTION_CENTER_LABEL));
    assert.match(SYNC_ATTENTION_COPIED_COPY, /copied/i);
    assert.match(SYNC_ATTENTION_COPY_FAILED_COPY, /Could not copy/);
  });
});


test('an interrupted rebuild remains actionable even before a new scope is registered', async () => {
  const result = await handleSyncAttentionRequest({ rebuildPending: async () => true,
    scope: async () => { throw new Error('not_connected'); }, store: {} as never });
  assert.ok(result.ok);
  assert.equal(result.attention.terminalCode, 'replica_rebuild_pending');
  const view = describeSyncAttention(syncAttentionInput(result.attention, undefined));
  assert.equal(view.terminal.show, true);
  assert.match(view.terminal.copy, /sync reset isn't finished/i);
});
