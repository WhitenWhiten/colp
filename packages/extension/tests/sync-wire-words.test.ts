import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { issueSummaryCopy } from '../src/sync-issue-copy.js';
import { rebuildFailureCopy } from '../src/replica-rebuild-copy.js';
import { readReplicaRepairCapability } from '../src/replica-repair-capability.js';
import { describeSyncAttention } from '../src/sync-attention-view.js';
import { describeSyncProblem, problemOffersRetry, problemResetCannotHelp, syncProblemFamily } from '../src/sync-problem-catalog.js';
import { CODE_WHAT, FAMILY_WHAT } from '../src/sync-problem-copy.js';
import { projectReplicaHealth } from '../src/sw/replica-health-report.js';
import type { PublicSyncAttention } from '../src/types.js';
import { setup } from './replica-rebuild-harness.js';

/**
 * Stream 1 (the wire) added or changed these codes. Each has to read as what it is: a refusal a Reset cannot end says
 * what does end it and never offers the Reset; a sign-in that renews itself says so; a server outage is the server's.
 */
const WIRE_CODES = ['snapshot_too_large', 'session_invalid', 'clock_skew', 'service_unavailable', 'internal_error', 'rate_limited',
  'authentication_required', 'credential_revoked', 'insufficient_scope', 'resource_not_found', 'replica_retired', 'origin_not_allowed',
  'invalid_query', 'idempotency_key_reused', 'manifest_unavailable', 'server_version_mismatch', 'session_replica_unknown',
  'server_configuration_failed', 'bookmark_api_error', 'bookmark_write_quota', 'native_read_failed', 'pull_apply_move_cycle',
  'snapshot_native_projection_ambiguous', 'server_unavailable', 'network_unavailable', 'effect_page_transport_unavailable',
  'effect_page_failed', 'concurrent_local_mutation'] as const;
const NO_RESET = ['snapshot_too_large', 'server_version_mismatch', 'origin_not_allowed', 'invalid_query', 'idempotency_key_reused',
  'manifest_unavailable'] as const;

describe('every code the wire added has a sentence of its own, never its family\'s', () => {
  test.each(WIRE_CODES)('%s', code => {
    assert.ok(CODE_WHAT[code], 'it has its own words');
    const problem = describeSyncProblem(code, { now: 1_000_000 });
    // A retired browser's own sentence is the retired family's by design: there is nothing to add to it.
    if (code !== 'replica_retired') assert.notEqual(problem.what, FAMILY_WHAT[problem.family](), 'not the family sentence');
    assert.doesNotMatch(problem.what, /internal check|has no description for/u);
    assert.ok(problem.next.length > 0 || code === 'replica_retired', 'and says what happens next');
  });

  test('the family each lands in follows what ends it', () => {
    for (const code of ['authentication_required', 'credential_revoked', 'insufficient_scope']) assert.equal(syncProblemFamily(code), 'sign_in', code);
    for (const code of ['resource_not_found', 'session_invalid']) assert.equal(syncProblemFamily(code), 'authority', code);
    for (const code of ['clock_skew', 'bookmark_api_error', 'bookmark_write_quota', 'native_read_failed', 'server_configuration_failed']) {
      assert.equal(syncProblemFamily(code), 'waiting', code);
    }
    for (const code of ['service_unavailable', 'internal_error', 'rate_limited']) assert.equal(syncProblemFamily(code), 'server_busy', code);
    for (const code of ['origin_not_allowed', 'invalid_query', 'idempotency_key_reused', 'manifest_unavailable', 'server_version_mismatch',
      'session_replica_unknown']) assert.equal(syncProblemFamily(code), 'stop_local', code);
    assert.equal(syncProblemFamily('replica_retired'), 'retired');
    assert.equal(syncProblemFamily('snapshot_too_large'), 'stop_download');
  });

  test('a session the server forgot is renewed, not a retired browser; a session that could not start does not blame the clock', () => {
    assert.equal(syncProblemFamily('resource_not_found'), 'authority');
    const gone = describeSyncProblem('resource_not_found', { now: 1_000_000, retryAutomatic: true });
    assert.equal(gone.what, 'The server does not know this sync session any more: it expired or was replaced.');
    assert.doesNotMatch(gone.sentence, /Reset|Sync center/u);
    const session = describeSyncProblem('session_invalid', { now: 1_000_000, retryAutomatic: true });
    assert.equal(session.what, 'Sync could not start a session with the server.');
    assert.doesNotMatch(session.sentence, /clock/iu);
    assert.match(session.next, /update the extension, or sign out and in again/u);
  });

  test('a sign-in the server stopped accepting is renewed by sync; only a credential that is gone needs the person', () => {
    for (const code of ['authentication_required', 'credential_revoked', 'insufficient_scope']) {
      const { next } = describeSyncProblem(code, { now: 1_000_000, retryAutomatic: true });
      assert.equal(next, 'Sync signs in again by itself. If it keeps failing, sign in again from Account.', code);
    }
  });

  test('a server outage and an unreadable-body wrapper are the server\'s, and a wrapped code reads as the code inside', () => {
    assert.equal(describeSyncProblem('service_unavailable', { now: 1_000_000, retryAutomatic: true }).what, 'The server had a problem and could not answer.');
    const wrapped = describeSyncProblem('snapshot_503_service_unavailable', { now: 1_000_000, retryAutomatic: true });
    assert.equal(wrapped.family, 'server_busy');
    assert.equal(wrapped.what, 'The server had a problem and could not answer.');
    assert.equal(describeSyncProblem('snapshot_http_401', { now: 1_000_000, retryAutomatic: true }).family, 'sign_in');
    assert.equal(syncProblemFamily('snapshot_http_502'), 'integrity_snapshot', 'an unnamed wrapper still reads as the server\'s copy failing a check');
  });

  test('the browser\'s own limits are said as limits, with when sync tries again', () => {
    const quota = describeSyncProblem('bookmark_write_quota', { now: 1_000_000, retryAutomatic: true, retryAt: 1_060_000 });
    assert.equal(quota.what, 'The browser limits how fast bookmarks can be changed, so sync is pausing for a moment.');
    assert.match(quota.next, /^It will retry automatically\. Next attempt: /u);
    assert.equal(describeSyncProblem('native_read_failed', { now: 1_000_000 }).what, 'The browser could not read your bookmarks just now.');
  });

  test('the transport codes say what happened to the answer, and the ones that mend themselves carry no code', () => {
    const words = (code: string) => describeSyncProblem(code, { now: 1_000_000, retryAutomatic: true });
    assert.equal(words('server_unavailable').sentence, 'The server could not answer just now. It will retry automatically.');
    assert.equal(words('network_unavailable').sentence, 'The connection to the server dropped while it was answering. It will retry automatically.');
    assert.equal(words('effect_page_transport_unavailable').sentence,
      'The server did not recognize this sign-in while sync was downloading a change. It will retry automatically.');
    assert.equal(words('concurrent_local_mutation').sentence,
      'A bookmark was edited on this device while a change from your library was being applied. It will retry automatically.');
    // A refusal is not a failed safety check; it freezes the pull, so it keeps its code for support.
    const refused = words('effect_page_failed');
    assert.equal(refused.what, 'The server refused a request for part of a change from your library.');
    assert.doesNotMatch(refused.sentence, /safety check/u);
    assert.match(refused.sentence, /\(effect_page_failed\)$/u);
    // The same request answered with a body that is whole and wrong is a failed check.
    assert.match(words('effect_page_invalid').what, /failed a safety check/u);
  });

  test('a folder the library wants inside itself and an identical bookmark are told by name, with the way out', () => {
    assert.match(describeSyncProblem('pull_apply_move_cycle', { now: 1_000_000 }).sentence,
      /one of its own subfolders.*Move one of the two folders on any device to untangle them\./u);
    const ambiguous = describeSyncProblem('snapshot_native_projection_ambiguous', { now: 1_000_000 });
    assert.equal(ambiguous.next, 'Delete the extra copy and press Retry sync, and sync will add the bookmark.');
    assert.doesNotMatch(ambiguous.sentence, /Waiting for you|Deletions/u, 'it is not a native wait');
    assert.equal(issueSummaryCopy({ code: 'snapshot_native_projection_ambiguous', direction: 'local' }).includes('Delete the extra copy'), true);
    assert.match(issueSummaryCopy({ code: 'snapshot_content_target_missing', direction: 'local' }), /Deleted on this device while your library still has it/u);
    assert.match(issueSummaryCopy({ code: 'pull_apply_move_cycle', direction: 'pull' }), /untangle them/u);
  });

  test('a refused browser call reads as one, with Try again only when the row has it', () => {
    const plain = issueSummaryCopy({ code: 'apply_failed:bookmark_api_error', direction: 'pull' });
    assert.doesNotMatch(plain, /Try again/u);
    const withRetry = issueSummaryCopy({ code: 'apply_failed:bookmark_api_error', direction: 'pull', localActions: ['retry', 'dismiss'] });
    assert.match(withRetry, /Try again applies it; Dismiss keeps this browser's version\.$/u);
  });
});

describe('a refusal a Reset cannot end', () => {
  test.each(NO_RESET)('%s says what does end it and never points at a Reset', code => {
    assert.equal(problemResetCannotHelp(code), true);
    const problem = describeSyncProblem(code, { now: 1_000_000, resetOffered: true, stopKind: 'stopped', retryAt: 1_300_000 });
    assert.doesNotMatch(problem.sentence, /Reset sync on this device|reset sync on this device|Reset sync below/u);
    assert.match(problem.sentence, /^.*Sync checks again by itself at .*, and Retry sync checks now\./u, 'a stop that is probed says when');
    assert.equal(problemOffersRetry(code), true, 'Retry looks again, which is how it ends once the cause is gone');
  });

  test('the ones a Reset does end are not on the list', () => {
    for (const code of ['replica_retired', 'session_replica_unknown', 'queue_state_invalid', 'mapping_identity_conflict', 'sync_failed', undefined]) {
      assert.equal(problemResetCannotHelp(code), false, String(code));
    }
    assert.equal(problemResetCannotHelp('snapshot_503_snapshot_too_large'), false, 'only the spellings the client really produces');
  });

  test('a library too large for the server names the setting and says a Reset will not help', () => {
    const problem = describeSyncProblem('snapshot_too_large', { now: 1_000_000, resetOffered: true });
    assert.equal(problem.what, 'This library is too large for the server to send to a new device.');
    assert.match(problem.next, /SYNC_SNAPSHOT_MAX_BYTES.*Retry sync.*Resetting will not help\. Your bookmarks are safe\.$/u);
  });

  test('a browser the server does not recognize is the one where a Reset is the way back', () => {
    const base = { now: 1_000_000 };
    assert.match(describeSyncProblem('session_replica_unknown', { ...base, resetOffered: true }).next, /^Reset sync on this device to register this browser again\./u);
    assert.equal(describeSyncProblem('session_replica_unknown', base).next, 'Sign out and in again to register this browser. Your bookmarks here are kept.');
    assert.match(describeSyncProblem('session_replica_unknown', { ...base, resetUnavailableReason: 'offline' }).next, /needs a connection/u);
  });

  test('the card has no Reset button for them, whatever the engine says, and the Sync center is not offered one either', () => {
    for (const code of NO_RESET) {
      const view = describeSyncAttention({ phase: 'error', lastError: code, recoveryFrozen: true, retryAutomatic: false,
        rebuildAvailable: false, rebuildUnavailableReason: 'rebuild_cannot_help' });
      assert.equal(view.reset.show, false, code);
      const attention: PublicSyncAttention = { phase: 'error', lastError: code, recoveryFrozen: true, retryAutomatic: false,
        rebuildAvailable: false, rebuildUnavailableReason: 'rebuild_cannot_help', queueProjection: 'idle', rejectedPending: false,
        conflictPending: false, nativeWaitPending: false, waitCount: 0, terminal: false };
      const report = projectReplicaHealth({ attention, issues: [], serverRebuild: true });
      assert.equal(report.state, 'stopped', code);
      assert.deepEqual(report.actions, ['retry'], `${code}: Retry only`);
    }
  });

  test('a Reset asked for anyway is refused with a sentence, not a generic failure', () => {
    assert.match(rebuildFailureCopy('rebuild_cannot_help'), /^A reset would not help here: a new copy meets the same refusal\. Nothing was reset\./u);
  });
});

describe('the capability follows the same rule at the source', () => {
  async function calmWith(error: string | undefined) {
    const f = await setup();
    await f.store.transitionEngine(f.scope, { phase: 'error', recoveryFrozen: true, authorityRefreshRequired: false,
      updatedAt: 2000, notBefore: 0, ...(error ? { lastError: error } : {}) });
    return f;
  }

  test.each(NO_RESET)('%s: a Reset is not available, and the reason says why', async code => {
    const f = await calmWith(code);
    try {
      const capability = await readReplicaRepairCapability(f.store, f.scope);
      assert.deepEqual([capability.rebuildAvailable, capability.reason, capability.rebuildBlockedReason], [false, 'rebuild_cannot_help', undefined]);
    } finally { f.store.close(); }
  });

  test('a wrapped spelling counts, and any other stop keeps its Reset', async () => {
    const wrapped = await calmWith('snapshot_http_413_snapshot_too_large');
    try {
      // Not a spelling the client produces for this code: it is an unknown wrapped shape and keeps the exit.
      assert.equal((await readReplicaRepairCapability(wrapped.store, wrapped.scope)).rebuildAvailable, true);
    } finally { wrapped.store.close(); }
    const other = await calmWith('queue_state_invalid');
    try {
      assert.deepEqual((await readReplicaRepairCapability(other.store, other.scope)).rebuildAvailable, true);
    } finally { other.store.close(); }
  });
});
