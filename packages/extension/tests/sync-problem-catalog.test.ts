import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'vitest';
import { SYNC_FAILURE_TABLE, classifySyncFailure } from '../src/sync-failure-class.js';
import { describeSyncProblem, problemOffersRetry, syncProblemFamily, type SyncProblemFamily } from '../src/sync-problem-catalog.js';
import { describeSyncAttention, terminalFreezeReasonCopy } from '../src/sync-attention-view.js';
import { issueSummaryCopy } from '../src/sync-issue-copy.js';
import { syncIssueRows } from '../src/sync-issue-rows.js';
import { projectReplicaHealth } from '../src/sw/replica-health-report.js';
import type { PublicSyncAttention } from '../src/types.js';

/**
 * C-19: the problem catalog is checked against the failure table itself. Every
 * key the table lists, and every shape the engine synthesises, must read as a
 * sentence with its code, in English and in Chinese, so a new key can never
 * render as a dead end (plan item 11).
 */
const TABLE_KEYS = Object.keys(SYNC_FAILURE_TABLE);
const ZH = JSON.parse(readFileSync(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8')) as
  Record<string, { readonly message: string }>;

/** Chrome's own substitution, so `t()` reads a catalog the way the browser would. */
function installCatalog(messages: Record<string, { readonly message: string }>): void {
  (globalThis as { chrome?: unknown }).chrome = { i18n: { getMessage(key: string, substitutions: string[] = []) {
    const entry = messages[key];
    return entry ? entry.message.replace(/\$(\$|[1-9])/gu, (_, slot: string) => slot === '$' ? '$' : substitutions[Number(slot) - 1] ?? '') : '';
  } } };
}
afterEach(() => { delete (globalThis as { chrome?: unknown }).chrome; });

const SYNTHESISED = ['snapshot_404_resource_not_found', 'snapshot_http_502', 'snapshot_410_sync_cursor_expired', 'sync_failed',
  'type_error', 'quota_exceeded_error', 'replica_retired', 'resource_not_found', 'origin_not_allowed', 'insufficient_scope',
  'authentication_required', 'credential_revoked', 'session_invalid', 'service_unavailable', 'internal_error',
  'bookmark_api_error', 'snapshot_native_projection_ambiguous:colp-7:keep extra local siblings', 'replica_rebuild_pending',
  'sync_stuck', 'sync_not_completing', 'health_http_503', 'some_code_nobody_has_seen_yet'];

describe('every code resolves to a readable sentence (C-19, plan item 11)', () => {
  test('the table is walked at test time, not listed here', () => {
    assert.ok(TABLE_KEYS.length > 300, `the table has ${TABLE_KEYS.length} keys`);
  });

  test('each table key has a family, a sentence, a next step, and shows its code unless it mends itself quietly', () => {
    for (const code of TABLE_KEYS) {
      const problem = describeSyncProblem(code, { now: 1_000 });
      assert.notEqual(problem.family, 'unknown', `${code} fell through to the unregistered family`);
      assert.ok(problem.what.length > 20, code);
      assert.ok(problem.sentence.startsWith(problem.what) && problem.sentence.length > problem.what.length, code);
      assert.doesNotMatch(problem.sentence, /\$[1-9]/u, `${code} left a placeholder`);
      const quiet = problem.byItself && problem.family !== 'unknown';
      if (!quiet) assert.ok(problem.sentence.endsWith(`(${code})`), `${code}: ${problem.sentence}`);
    }
  });

  test('a code outside the table still reads as a sentence with its code in brackets', () => {
    for (const code of SYNTHESISED) {
      const problem = describeSyncProblem(code, { now: 1_000 });
      assert.ok(problem.what.length > 20, code);
      assert.doesNotMatch(problem.sentence, /\$[1-9]/u, code);
      if (!problem.byItself || problem.family === 'unknown') {
        assert.ok(problem.sentence.includes(`(${code.length > 64 ? code.slice(0, 63) : code}`), `${code}: ${problem.sentence}`);
      }
    }
    assert.equal(describeSyncProblem('some_code_nobody_has_seen_yet').family, 'unknown');
    assert.match(describeSyncProblem('some_code_nobody_has_seen_yet').sentence, /\(some_code_nobody_has_seen_yet\)$/u);
  });

  test('a missing code is still a sentence, never an empty card', () => {
    const problem = describeSyncProblem(undefined);
    assert.ok(problem.sentence.length > 20);
    assert.equal(problem.family, 'unknown');
  });

  test('the family follows the table entry: class and exit decide the words', () => {
    const expected: Record<string, SyncProblemFamily> = {
      network_unavailable: 'offline', server_unavailable: 'server_busy', rate_limited: 'server_busy', ack_pending: 'waiting',
      permission_revoked: 'permission', stale_replica: 'authority', sync_cursor_expired: 'authority',
      pull_page_invalid: 'integrity_pull', snapshot_invalid: 'integrity_snapshot', anchor_parent_mismatch: 'item_mapping',
      mapping_identity_conflict: 'rebuild', payload_too_large: 'rebuild', recovery_identity_unproven: 'decide',
      native_result_unknown: 'confirm', record_too_large: 'codec', queue_state_invalid: 'stop_upload',
      pull_cursor_missing: 'stop_download', import_plan_invalid: 'stop_first_sync', batch_plan_invalid: 'stop_feature',
      engine_state_invalid: 'stop_local', replica_rebuild_pending: 'rebuild', replica_retired: 'retired',
      credential_revoked: 'sign_in', sync_stuck: 'stalled', sync_not_completing: 'stalled',
    };
    for (const [code, family] of Object.entries(expected)) assert.equal(syncProblemFamily(code), family, code);
  });

  test('Chinese: every table key and every synthesised shape renders translated, with its code and no placeholder left', () => {
    const english = new Map<string, string>();
    for (const code of [...TABLE_KEYS, ...SYNTHESISED]) english.set(code, describeSyncProblem(code, { now: 1_000, resetOffered: true }).sentence);
    installCatalog(ZH);
    const failures: string[] = [];
    for (const code of [...TABLE_KEYS, ...SYNTHESISED]) {
      const chinese = describeSyncProblem(code, { now: 1_000, resetOffered: true }).sentence;
      if (chinese === english.get(code)) failures.push(`${code}: not translated`);
      if (/\$[1-9]/u.test(chinese)) failures.push(`${code}: placeholder left`);
      if (!/[一-鿿]/u.test(chinese)) failures.push(`${code}: no Chinese text`);
    }
    assert.deepEqual(failures, []);
  });
});

describe('the Reset sentence never promises a button that is not there (C-13)', () => {
  test('a terminal code says where Reset is when the card has none', () => {
    // A real freeze code that the (stale) SyncAttentionTerminalCode union leaves out; the view casts it the same way.
    const withButton = terminalFreezeReasonCopy('mapping_identity_conflict' as never, { rebuildAvailable: true });
    assert.match(withButton, /Reset sync on this device to continue/u);
    const noReason = terminalFreezeReasonCopy('mapping_identity_conflict' as never, { rebuildAvailable: false });
    assert.doesNotMatch(noReason, /Reset sync on this device to continue/u);
    assert.match(noReason, /Sync center on the web/u);
    // K3: a Reset that is needed but cannot run now says why, and neither reason sends the person to the web
    // (the Sync center's Reset needs a connection too, and an unsettled bookmark change blocks it there as well).
    const offline = terminalFreezeReasonCopy('mapping_identity_conflict' as never, { rebuildAvailable: false,
      rebuildUnavailableReason: 'offline' });
    assert.match(offline, /Resetting needs a connection, because a change may already have reached the server\. Connect and try again\./u);
    assert.doesNotMatch(offline, /Sync center on the web/u);
    const unsettled = terminalFreezeReasonCopy('mapping_identity_conflict' as never, { rebuildAvailable: false,
      rebuildUnavailableReason: 'native_outcome_unsettled' });
    assert.match(unsettled, /no confirmed result yet/u);
    assert.match(unsettled, /under Waiting for you/u);
    assert.doesNotMatch(unsettled, /Sync center on the web/u);
  });

  test('rebuild-exit codes no longer claim that bookmarks are missing, except the one where one is', () => {
    for (const code of ['mapping_identity_conflict', 'create_ambiguous', 'create_evidence_missing',
      'snapshot_placement_local_identity_unproven', 'pull_apply_evidence_missing']) {
      assert.doesNotMatch(terminalFreezeReasonCopy(code as never), /bookmarks on this device are missing/u, code);
    }
    assert.match(terminalFreezeReasonCopy('pull_apply_target_missing'), /no longer on this device/u);
  });

  test('delete_subtree_changed and managed_not_writable describe themselves, not a failed identity check', () => {
    assert.match(describeSyncProblem('delete_subtree_changed').what, /gained bookmarks on another device/u);
    assert.match(describeSyncProblem('managed_not_writable').what, /managed by your browser/u);
  });

  test('the size limit has a next step, and a reset that is not finished points at the button', () => {
    assert.match(terminalFreezeReasonCopy('payload_too_large'), /whoever runs your Know-N server/u);
    assert.match(terminalFreezeReasonCopy('replica_rebuild_pending', { rebuildAvailable: true }), /Press Reset sync on this device to finish it/u);
    assert.doesNotMatch(terminalFreezeReasonCopy('replica_rebuild_pending', { rebuildAvailable: true }), /Try again to finish/u);
  });

  test('a ceiling stop names the way out that does not archive anything', () => {
    assert.match(terminalFreezeReasonCopy('sync_issue_ceiling', { rebuildAvailable: true }), /Try again or dismiss some of the items below, or all of one kind/u);
  });
});

describe('one Retry rule for the card and the Sync center (C-14)', () => {
  const calm: PublicSyncAttention = { recoveryFrozen: false, queueProjection: 'idle', rejectedPending: false, conflictPending: false,
    nativeWaitPending: false, waitCount: 0, terminal: false };

  test('for every table key the extension offers Retry exactly when the Sync center does', () => {
    for (const code of TABLE_KEYS) {
      const policy = classifySyncFailure(code)!;
      // The state this code puts the browser in: terminal codes freeze it, the rest stop it after repeated errors.
      const terminal = policy.exit === 'rebuild' || policy.exit === 'decide';
      const attention: PublicSyncAttention = { ...calm, phase: 'error', lastError: code, retryAutomatic: false,
        recoveryFrozen: terminal || policy.freezesPull === true, terminal, ...(terminal ? { terminalCode: code as never } : {}) };
      const card = describeSyncAttention({ ...attention, rebuildAvailable: false });
      const shown = terminal ? card.terminal.retry : card.recovery.retry;
      const center = projectReplicaHealth({ attention, issues: [] }).actions.includes('retry');
      assert.equal(center, shown, `${code}: card ${shown}, Sync center ${center}`);
      assert.equal(shown, problemOffersRetry(code), code);
    }
  });

  test('exit-stop codes offer it on both; a frozen Reset-only state and a retired browser offer it on neither', () => {
    for (const code of ['queue_state_invalid', 'record_too_large', 'pull_invalid', 'engine_state_invalid']) {
      assert.equal(problemOffersRetry(code), true, code);
    }
    for (const code of ['mapping_identity_conflict', 'payload_too_large', 'replica_rebuild_pending', 'replica_retired']) {
      assert.equal(problemOffersRetry(code), false, code);
    }
  });
});

describe('the codes the push lane and browser storage added (stream 2, phase 2a)', () => {
  const at = 1_000_000;
  const say = (code: string, context: Record<string, unknown> = {}) => describeSyncProblem(code, { now: at, ...context }).sentence;

  test('browser storage reads as itself: what failed, what to do, never "an internal check"', () => {
    assert.match(say('storage_blocked'), /another Know-N window is still using it\. Close other Know-N windows/u);
    assert.match(say('storage_unavailable'), /could not read or save sync data just now/u);
    assert.equal(describeSyncProblem('indexeddb_failure').what, describeSyncProblem('storage_unavailable').what);
    assert.match(say('quota_exceeded'), /no room left to save sync data\. Free up some disk space/u);
    assert.match(say('future_schema'), /newer version of the extension.*Update the extension, or reset the sync data/u);
    assert.match(say('diagnostic_read_only'), /damaged and cannot be changed\. Reset the sync data on this device/u);
    assert.match(say('upgrade_failed'), /could not update its data.*Free some disk space/u);
    for (const code of ['storage_blocked', 'storage_unavailable', 'quota_exceeded', 'storage_record_rejected', 'future_schema', 'diagnostic_read_only', 'upgrade_failed']) {
      assert.doesNotMatch(say(code), /internal check/u, code);
    }
  });

  test('a record the store refuses is cleared by a Reset: the button when the card has it, the reason when it cannot run', () => {
    assert.match(say('storage_record_rejected', { resetOffered: true }), /Reset sync on this device to clear it/u);
    assert.match(say('storage_record_rejected'), /Copy details to investigate/u);
    assert.match(say('storage_record_rejected', { resetUnavailableReason: 'offline' }), /Resetting needs a connection/u);
  });

  test('a change the server may own that cannot be settled says what waits behind it and what ends it', () => {
    for (const code of ['push_response_invalid', 'push_problem_invalid', 'push_problem_status_mismatch', 'push_result_processing_failed']) {
      assert.match(say(code), /answer about a change could not be understood, so uploads behind it are waiting/u, code);
      assert.match(say(code, { resetOffered: true }), /Retry sync sends it again/u, code);
    }
    assert.match(say('queue_head_unreadable', { resetOffered: true }), /cannot be read on this device, so later uploads are waiting\. Reset sync on this device to clear it/u);
    assert.match(say('push_attempt_operation_changed', { resetOffered: true }), /could not be sent again, so later uploads are waiting\. Reset sync/u);
    assert.match(say('push_server_unavailable'), /server is not answering the upload/u);
  });

  test('a stop that is probed says when it looks again, and that Retry looks now; the old "tries once more" is gone', () => {
    const stopped = say('queue_state_invalid', { stopKind: 'stopped', retryAt: at + 300_000, retryAutomatic: false, resetOffered: true });
    assert.match(stopped, /internal check\. Sync checks again by itself at .+, and Retry sync checks now\. If it keeps stopping, copy details and reset sync/u);
    assert.doesNotMatch(stopped, /tries once more/u);
    // The deadline passed (the probe is due or running): "soon", never a time in the past.
    assert.match(say('queue_state_invalid', { stopKind: 'stopped', retryAt: at - 1, retryAutomatic: false }), /Sync checks again by itself soon, and Retry sync checks now/u);
    // A code with a next step of its own keeps it after the schedule.
    assert.match(say('future_schema', { stopKind: 'stopped', retryAt: at + 300_000, retryAutomatic: false }), /Retry sync checks now\. Update the extension/u);
    assert.match(say('push_response_invalid', { stopKind: 'stopped', retryAt: at + 300_000, retryAutomatic: false }), /Retry sync checks now\. If it keeps stopping/u);
  });

  test('every stop in the table is worded with its schedule when the engine probes it', () => {
    for (const [code, entry] of Object.entries(SYNC_FAILURE_TABLE)) {
      if (entry.exit !== 'stop') continue;
      const sentence = say(code, { stopKind: 'stopped', retryAt: at + 300_000, retryAutomatic: false });
      assert.match(sentence, /Sync checks again by itself at .+, and Retry sync checks now\./u, code);
      assert.doesNotMatch(sentence, /Retry sync tries once more/u, code);
      assert.ok(sentence.endsWith(`(${code})`), code);
    }
  });

  test('a wait that never ended says so first, then when it looks again, then what to do', () => {
    const stalled = say('session_handoff_pending', { stopKind: 'stalled', retryAt: at + 900_000, retryAutomatic: false });
    assert.match(stalled, /^Sync has been stuck on the same step for a long time\. Sync is waiting for something on this device to finish\. Sync checks again by itself at .+, and Retry sync checks now\. If it stays this way, copy details to investigate/u);
    assert.ok(stalled.endsWith('(session_handoff_pending)'));
  });

  test('the card for a stopped engine uses the schedule, offers Retry, and never calls it a cooldown', () => {
    const view = describeSyncAttention({ phase: 'error', lastError: 'queue_state_invalid', retryAutomatic: false, stopKind: 'stopped',
      retryAt: Date.now() + 300_000, recoveryFrozen: false, issueCount: 0 });
    assert.equal(view.recovery.show, true);
    assert.equal(view.recovery.retry, true);
    assert.match(view.recovery.copy, /Sync checks again by itself at .+, and Retry sync checks now\./u);
    assert.doesNotMatch(view.recovery.copy, /paused after repeated errors/u);
  });

  test('items held before anything was sent read as items: a refused request, withdrawn consent, an unreadable change', () => {
    const rows = syncIssueRows([
      { direction: 'push', code: 'push_request_refused', issueId: 'a', localActions: ['retry'] },
      { direction: 'push', code: 'metadata_sync_disabled', issueId: 'b', localActions: ['retry'] },
      { direction: 'push', code: 'queue_row_unreadable', issueId: 'c', localActions: ['retry'] },
      { direction: 'push', code: 'queue_head_unreadable' },
      { direction: 'local', code: 'sync_step_failed', stage: 'history_prune', rootCause: 'quota_exceeded', count: 3 },
    ]).rows;
    assert.deepEqual(rows.map(row => row.summary), [
      'A firewall or network filter keeps refusing this change, so it was set aside. Everything else keeps syncing',
      'It includes tags or a description, which you chose not to sync, so it was not uploaded',
      'One saved change could not be read, so it was set aside. The bookmark is unchanged; Try again saves it again',
      'A change that may already have reached the server cannot be read on this device, so later uploads are waiting. Resetting sync on this device clears it',
      'Part of syncing keeps failing (clearing old sync history) and will be tried again. Cause: quota_exceeded']);
    assert.deepEqual(rows.map(row => row.title), ['A bookmark on this device', 'A bookmark on this device', 'A saved change', 'A saved change', 'Part of syncing']);
    assert.deepEqual(rows.map(row => row.actions), [['retry'], ['retry'], ['retry'], [], []]);
  });

  test('a step that keeps failing names the part and the cause when it knows them, and a reset that cannot finish says so', () => {
    const step = (extra: Record<string, unknown>) => issueSummaryCopy({ code: 'sync_step_failed', direction: 'local', ...extra });
    assert.equal(step({}), 'Part of syncing keeps failing and will be tried again');
    assert.equal(step({ rootCause: 'quota_exceeded' }), 'Part of syncing keeps failing and will be tried again. Cause: quota_exceeded');
    assert.equal(step({ stage: 'wake' }), 'Part of syncing keeps failing (the sync pass) and will be tried again');
    assert.equal(step({ stage: 'rebuild_resume', rootCause: 'scope_mismatch' }), 'The reset could not finish (scope_mismatch). It is tried again on the next pass');
    assert.equal(step({ stage: 'no_such_stage', rootCause: 'x' }), 'Part of syncing keeps failing and will be tried again. Cause: x');
  });
});
