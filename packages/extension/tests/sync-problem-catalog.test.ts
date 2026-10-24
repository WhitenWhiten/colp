import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'vitest';
import { SYNC_FAILURE_TABLE, classifySyncFailure } from '../src/sync-failure-class.js';
import { describeSyncProblem, problemOffersRetry, syncProblemFamily, type SyncProblemFamily } from '../src/sync-problem-catalog.js';
import { describeSyncAttention, terminalFreezeReasonCopy } from '../src/sync-attention-view.js';
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
    const withButton = terminalFreezeReasonCopy('mapping_identity_conflict', { rebuildAvailable: true });
    assert.match(withButton, /Reset sync on this device to continue/u);
    const blocked = terminalFreezeReasonCopy('mapping_identity_conflict', { rebuildAvailable: false,
      rebuildUnavailableReason: 'upload_outcome_unsettled' });
    assert.doesNotMatch(blocked, /Reset sync on this device to continue/u);
    assert.match(blocked, /no confirmed result/u);
    assert.match(blocked, /Sync center on the web/u);
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
