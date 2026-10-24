import { freezeScopeRecovery } from './pull-recovery-freeze.js';
import { holdRefusedRequest, repeatsDenial, REQUEST_REFUSED_ATTEMPTS } from './push-denial-containment.js';
import { isSequenceReuseCode } from './sequence-reuse-settlement.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';
import type { StoredSession } from './types.js';

export function assertPushSession(session: StoredSession, scope: SyncScope, current: number) {
  if (session.scope !== 'collection' || session.collection.collectionId !== scope.collectionId
      || session.replicaLease.state !== 'active'
      || Date.parse(session.expiresAt) <= current || Date.parse(session.replicaLease.expiresAt) <= current) {
    throw new Error('sync_session_invalid');
  }
}

/**
 * T-02/F004: transport/authority refusals are not operation-level verdicts.
 *
 * A Push Problem is routed by one ordered decision (`classifyPushProblem`), and
 * the refusals that name a credential, replica or cursor problem are handed to
 * the recovery layer instead of the permanent `rejected` settlement: the queue
 * row stays replayable and the drain demands the session refresh or scope
 * recovery that can actually settle it.
 */
const RETRYABLE_PROBLEM = new Set([
  'position_context_stale', 'snapshot_expired', 'idempotency_in_progress', 'sequence_gap', 'sequence_blocked',
  'dependency_failed', 'precondition_failed', 'precondition_required', 'rate_limited', 'internal_error',
  'service_unavailable',
]);
const AUTHORITY_PROBLEM = new Set([
  'authentication_required', 'insufficient_scope', 'origin_not_allowed', 'csrf_failed',
  'stale_replica', 'replica_retired', 'resource_purged', 'sync_cursor_expired', 'feed_cursor_expired',
  'need_authority',
]);
/** Remaining 401/403/410 status classes are authority refusals even unnamed. */
export const AUTHORITY_STATUS = new Set([401, 403, 410]);
/** Consecutive replays of an unnamed authority refusal before escalating. */
export const AUTHORITY_REPLAY_LIMIT = 3;
const SAFE_PROBLEM_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
export function safeAuthorityCode(code: string, status: number) {
  if (SAFE_PROBLEM_CODE.test(code)) return code;
  if (status === 410) return 'push_authority_expired';
  if (status === 401) return 'push_authentication_rejected';
  return 'push_authority_denied';
}
function classifiedRetryable(problem: { readonly code: string; readonly retryable?: boolean }) {
  if (problem.retryable === true) return true;
  if (problem.retryable === false) return false;
  return RETRYABLE_PROBLEM.has(problem.code);
}
export type PushProblemDisposition = 'reuse' | 'authority' | 'retryable' | 'rejected' | 'unrecognized';
/**
 * Single routing decision for a Push Problem. The order is the contract:
 * `sequence_reuse`/`op_id_reused` is classified against the local operation
 * identity before any generic retryable or permanent-refusal handling, so
 * adding a code to RETRYABLE_PROBLEM (or flipping the protocol `retryable`
 * flag) can never turn a reuse refusal back into an unclassified replay or a
 * silent permanent rejection. Authority codes and the 401/403/410 status class
 * follow, so a refused credential/replica can never reach the operation-level
 * `rejected` branch; an explicit `retryable:false` still marks the
 * operation-level semantic refusals (`invalid_document`, `node_read_only`, …)
 * because the explicit flag precedes the status class.
 */
export function classifyPushProblem(problem: { readonly code: string; readonly retryable?: boolean;
  readonly status?: number }): PushProblemDisposition {
  if (isSequenceReuseCode(problem.code)) return 'reuse';
  if (AUTHORITY_PROBLEM.has(problem.code)) return 'authority';
  if (classifiedRetryable(problem)) return 'retryable';
  if (problem.retryable === false) return 'rejected';
  if (problem.status !== undefined && AUTHORITY_STATUS.has(problem.status)) return 'authority';
  return 'unrecognized';
}

type AuthorityStore = Pick<ReturnType<typeof createSyncStateStore>,
  'putScopeDiagnostic' | 'getScope' | 'registerScope' | 'getEngineState' | 'transitionEngine'
  | 'rebaseClaimedPush' | 'setAsideClaimedPush' | 'listQueue'>;

export function createAuthorityRecovery(input: {
  readonly scope: SyncScope; readonly store: AuthorityStore;
  readonly sessions: { get(forceRefresh?: boolean): Promise<{ readonly session: StoredSession }> };
  readonly ownerId: string; readonly now: () => number;
  /** The worker's durable `unknown` settlement: keeps the row replayable. */
  readonly persistUnknown: (queue: QueueOperation, fence: number, reason: string,
    retryAfter?: string | null) => Promise<'unknown'>;
}) {
  /**
   * A parsed transport/authority refusal is never an operation-level verdict.
   * The row stays replayable and the drain drives the layer that can actually
   * recover: a forced credential refresh for an authentication refusal, a scope
   * recovery freeze for a replica/cursor authority refusal. `attention` and the
   * scope diagnostic make the refusal observable without a permanent rejection.
   */
  async function handleRefusal(queue: QueueOperation, fence: number,
    problem: { readonly code: string; readonly status: number }, alreadyRefreshed: boolean,
    repair: { attention: number }, retryAfter: string | null): Promise<'unknown'> {
    repair.attention += 1;
    const authorityCode = safeAuthorityCode(problem.code, problem.status);
    try { await input.store.putScopeDiagnostic(input.scope, { kind: 'push_authority', code: authorityCode }); }
    catch { /* the durable unknown row below still carries the refusal */ }
    if (problem.status === 401 || problem.code === 'authentication_required') {
      if (alreadyRefreshed) {
        // Fresh credentials were already refused: only authority recovery can
        // settle this, and re-refreshing in a loop would discard the verdict.
        try { await freezeScopeRecovery(input.store, input.scope, 'push_authentication_rejected'); }
        catch { /* the replayable unknown row keeps the evidence */ }
        return input.persistUnknown(queue, fence, 'push_authentication_rejected', retryAfter);
      }
      try { await input.sessions.get(true); } catch { /* the next drain retries the refresh */ }
      return input.persistUnknown(queue, fence, 'push_authentication_refresh_required', retryAfter);
    }
    try { await freezeScopeRecovery(input.store, input.scope, authorityCode); }
    catch { /* the replayable unknown row keeps the evidence */ }
    return input.persistUnknown(queue, fence, authorityCode, retryAfter);
  }

  /**
   * An authority response we cannot name (unnamed 401/403/410, unparseable authority Problem)
   * must neither replay the identical bytes for ever nor freeze the replica for a refusal that
   * may be about this one request (A-F2, see push-denial-containment.ts). The row's durable
   * attempt counter bounds the replays: `claimNextQueue` clears `recovery`, so `attempt` is the
   * only counter that survives a claim. Past the bound the Session endpoint is asked for a fresh
   * credential. If that fails the refusal is an authority problem (credential refresh plus scope
   * recovery, as before); if it works and the same bytes are still refused after
   * REQUEST_REFUSED_ATTEMPTS tries, this one change leaves the lane as an item.
   */
  async function handleUnexplained(queue: QueueOperation, fence: number, reason: string,
    retryAfter: string | null, repair: { attention: number }): Promise<'unknown' | 'terminal'> {
    if (queue.retry.attempt < AUTHORITY_REPLAY_LIMIT || !repeatsDenial(queue)) {
      return input.persistUnknown(queue, fence, reason, retryAfter);
    }
    repair.attention += 1;
    try { await input.store.putScopeDiagnostic(input.scope,
      { kind: 'push_authority', code: 'push_denial_escalated' }); } catch { /* the queue row keeps the code */ }
    if (await credentialStillWorks()) {
      if (queue.retry.attempt + 1 < REQUEST_REFUSED_ATTEMPTS) return input.persistUnknown(queue, fence, reason, retryAfter);
      if (await holdRefusedRequest({ store: input.store, scope: input.scope, ownerId: input.ownerId },
        queue, fence)) return 'terminal';
    }
    try { await freezeScopeRecovery(input.store, input.scope, 'push_denial_escalated'); }
    catch { /* the replayable unknown row keeps the evidence */ }
    return input.persistUnknown(queue, fence, 'push_denial_escalated', retryAfter);
  }

  /** A forced Session refresh is a different request: only a real authority problem can fail it. */
  async function credentialStillWorks() {
    try { assertPushSession((await input.sessions.get(true)).session, input.scope, input.now()); return true; }
    catch { return false; }
  }

  return Object.freeze({ handleRefusal, handleUnexplained });
}
