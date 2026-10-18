import { startPushLeaseRenewal } from './push-lease-renewal.js';
import { enforceSyncIssueCeiling } from './sync-issue-ceiling.js';
import { SyncFailureError } from './sync-failure-class.js';
import { holdRepeatedLocalFailure } from './push-local-failure.js';
import type { RecaptureQueueRow } from './queue-recapture.js';
import { rejectExcludedBootstrapUpload } from './bootstrap/upload-rejection.js';
import { sendBootstrapCreateBatch } from './outbound-push-batch.js';
import { createPushWorkBudget, recordPushBatchDecision, MAX_PUSH_DRAIN_OPERATIONS as MAX_DRAIN_OPERATIONS } from './push-work-budget.js';
import { releaseSettledQueueHolds, settlePushResult } from './outbound-push-settlement.js';
import { freezeScopeRecovery } from './pull-recovery-freeze.js';
import { stopDeniedMetadataAttempt } from './metadata-dispatch-recovery.js';
import { reasonCode } from './push-error-code.js';
import { recordKns09Stop } from './kns-09-release.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { colpCredentialHeaders } from './auth-client.js';
import { readBoundedJson } from './json-response.js';
import type { SyncEndpoints } from './manifest-client.js';
import { parseColpProblem, parseSyncPushResult } from './sync-push-wire.js';
import { persistMountBinding } from './pull-mount-apply.js';
import { createNodeFolderRole, isAuthoredMountRole, matchMountByRole, usableNativeRoot } from './push-mount-role.js';
import { rebaseTombstonedCreate, retainValidPlacementAnchors } from './tombstone-parent-rebase.js';
import { rebaseStaleCreatePlacement, savedCreatePlacement } from './create-placement-rebase.js';
import { pushRecoveryBarrierActive, releaseClaimForRecovery } from './push-recovery-barrier.js';
import { liveCreateNativeId, plannedCreateNativeId } from './bookmark-event-codec.js';
import { findProcessedMoveEvent } from './bookmark-event-pages.js';
import { repairSequenceReuseRejected, findSequenceReuseEvidence, sequenceReuseRepairAction } from './sequence-reuse-repair.js';
import {
  assertUnchangedOperationBytes, classifyLocalSequenceReuse,
} from './sequence-reuse-settlement.js';
import {
  AUTHORITY_STATUS, classifyPushProblem, createAuthorityRecovery, assertPushSession as assertSession, type PushProblemDisposition,
} from './push-authority.js';
import type { PlacementRefreshOutcome } from './durable-sync-engine-types.js';

export { classifyPushProblem };
export type { PushProblemDisposition };
import type { JsonObject, QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';
import type { StoredCredential, StoredSession } from './types.js';

const RESPONSE_MAX_BYTES = 128 * 1024;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const NETWORK_WATCHDOG_GRACE_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface PushSessionController {
  get(forceRefresh?: boolean): Promise<{ readonly credential: Pick<StoredCredential, 'accessToken' | 'subject'>;
    readonly session: StoredSession }>;
}
export type DrainOutcome = { readonly outcome: 'idle' | 'contended' | 'terminal' | 'deferred' | 'gap' | 'blocked'
  | 'unknown' | 'rejected' | 'recovery'; readonly sequence?: number;
  /**
   * Items the drain could not settle on its own: unconverged
   * `sequence_reuse`/`op_id_reused` rows seen by the repair pass at drain start,
   * or transport/authority refusals that demand session/scope recovery.
   */
  readonly attention?: number };
interface WorkerOptions {
  readonly recaptureHeld?: RecaptureQueueRow;
  readonly scope: SyncScope; readonly store: ReturnType<typeof createSyncStateStore>;
  readonly endpoints: () => Promise<SyncEndpoints>; readonly sessions: PushSessionController;
  readonly fetch?: typeof fetch; readonly now?: () => number; readonly random?: () => number;
  readonly ownerId?: () => string; readonly schedule?: (delayMilliseconds: number) => void;
  readonly origin?: string;
  readonly leaseDurationMilliseconds?: number; readonly requestTimeoutMilliseconds?: number;
  readonly drainBudgetMilliseconds?: number; readonly initialBatchOperations?: number;
  readonly settlementFault?: 'after_receipt';
  readonly boundary?: (point: 'before_attempt_persist' | 'after_attempt_persist', queue: QueueOperation) => Promise<void>;
  readonly dispatch?: (queue: QueueOperation, send: () => Promise<Response>) => Promise<Response>;
  readonly dispatchBatch?: (rows: readonly QueueOperation[], send: () => Promise<Response>) => Promise<Response>;
  readonly beforeDispatch?: (queue: QueueOperation) => Promise<void>;
  readonly assertUploadAllowed?: (queue: QueueOperation) => Promise<void>;
  readonly onTerminal?: (queue: QueueOperation) => Promise<void>;
  /** Pull/mapping refresh before rebasing a retried move_node. Lost-response retries keep `attempt`. */
  readonly refreshPlacement?: () => Promise<PlacementRefreshOutcome | void>;
  readonly readChildrenOrder?: (parentNativeId: string) => Promise<readonly string[]>;
  /** Advanced import owns its own recovery protocol and explicitly opts through this barrier. */
  readonly allowRecoveryFrozenPush?: () => boolean | Promise<boolean>;
}

export function createOutboundPushWorker(options: WorkerOptions) {
  const fetcher = options.fetch ?? fetch; const now = options.now ?? Date.now; const random = options.random ?? Math.random;
  const ownerId = options.ownerId?.() ?? crypto.randomUUID();
  const leaseDuration = options.leaseDurationMilliseconds ?? DEFAULT_LEASE_MS;
  const requestTimeout = options.requestTimeoutMilliseconds ?? DEFAULT_TIMEOUT_MS;
  const workBudget = createPushWorkBudget(requestTimeout, options.initialBatchOperations);
  const authorityRecovery = createAuthorityRecovery({ scope: options.scope, store: options.store,
    sessions: options.sessions, persistUnknown: (queue, fence, reason, retryAfter) =>
      persistUnknown(queue, fence, reason, retryAfter ?? null) });

  async function drain(onNetworkResponse?: () => void | Promise<void>): Promise<DrainOutcome> {
    if (await enforceSyncIssueCeiling(options.store, options.scope, now())) return { outcome: 'recovery' };
    const repair: { attention: number } = { attention: 0 };
    const outcome = await runDrain(repair, onNetworkResponse);
    if (await enforceSyncIssueCeiling(options.store, options.scope, now())) return { outcome: 'recovery' };
    return repair.attention > 0 ? { ...outcome, attention: repair.attention } : outcome;
  }

  async function runDrain(repair: { attention: number },
    onNetworkResponse?: () => void | Promise<void>): Promise<DrainOutcome> {
    const initial = now(); const lease = await options.store.acquireLease(options.scope, ownerId, initial, leaseDuration);
    if (lease.outcome === 'contended') {
      options.schedule?.(Math.max(1_000, (lease.expiresAt ?? initial + leaseDuration) - now()));
      return { outcome: 'contended' };
    }
    const renewal = startPushLeaseRenewal({ store: options.store, scope: options.scope, ownerId,
      fence: lease.fence, duration: leaseDuration, now });
    // A 'gap' head whose hole is entirely rejected history is realigned onto
    // the server's expectedSequence evidence before claiming, so surviving
    // local edits converge instead of stalling behind refused operations.
    repair.attention = await repairSequenceReuse();
    try {
      await options.store.realignQueueAfterGap(options.scope, ownerId, lease.fence, now(),
        (payload) => `sha256:${digestJson(payload)}`);
    } catch (error) {
      // The barrier stands and the next drain retries the realign, but a failed
      // pass must not vanish: report attention and journal the reason so a stuck
      // gap is distinguishable from "nothing to repair".
      repair.attention += 1;
      try { await options.store.putScopeDiagnostic(options.scope,
        { kind: 'queue_realign', code: reasonCode(error, 'realign_failed') }); } catch { /* best effort */ }
    }
    // Settled dependencies are re-captured from the browser as fresh tail operations.
    if (options.recaptureHeld) repair.attention += await releaseSettledQueueHolds(options.store, options.scope, options.recaptureHeld);
    let last: DrainOutcome = { outcome: 'idle' }; let diagnosed = false;
    const deadline = now() + (options.drainBudgetMilliseconds ?? 20_000);
    try { for (let count = 0; count < MAX_DRAIN_OPERATIONS; count += 1) {
      if (await enforceSyncIssueCeiling(options.store, options.scope, now())) return { outcome: 'recovery' };
      if (count > 0 && now() >= deadline) break;
      renewal.assertCurrent();
      if (await pushRecoveryBarrierActive(options.store, options.scope,
        options.allowRecoveryFrozenPush)) return { outcome: 'recovery' };
      const queue = await options.store.claimNextQueue(options.scope, ownerId, lease.fence, now());
      if (!queue) { await scheduleOutstanding(); return last; }
      if (queue.mediaType !== 'application/json') {
        const outcome = await persistLocalFailure(queue, lease.fence, 'push_media_type_invalid');
        if (outcome === 'terminal') { last = { outcome, sequence: queue.sequence }; continue; }
        return { outcome, sequence: queue.sequence };
      }
      let authority: Awaited<ReturnType<PushSessionController['get']>>;
      try { authority = await options.sessions.get(false); assertSession(authority.session, options.scope, now()); }
      catch (error) { const outcome = await persistUnknown(queue, lease.fence,
        reasonCode(error, 'push_session_unavailable')); return { outcome, sequence: queue.sequence }; }
      let bound = queue;
      let refreshEnteredRecovery = false;
      try { await options.assertUploadAllowed?.(queue); await options.boundary?.('before_attempt_persist', queue);
        const rebased = queue.attempt ? queue : await rebasePlacement(queue, lease.fence);
        if (rebased === 'recovery') {
          refreshEnteredRecovery = true;
        } else if (typeof rebased === 'string') {
          last = { outcome: rebased, sequence: queue.sequence };
          if (rebased !== 'terminal') return last; continue;
        } else {
          bound = await ensureAttempt(rebased as QueueOperation, authority.session, lease.fence);
          await options.boundary?.('after_attempt_persist', bound);
        }
      }
      catch (error) {
        if (reasonCode(error, '') === 'bootstrap_upload_excluded') {
          await rejectExcluded(queue, lease.fence, error); last = { outcome: 'rejected', sequence: queue.sequence }; continue;
        }
        const outcome = await persistLocalFailure(queue, lease.fence, reasonCode(error, 'push_attempt_bind_failed'));
        if (outcome === 'terminal') { last = { outcome, sequence: queue.sequence }; continue; }
        return { outcome, sequence: queue.sequence };
      }
      if (refreshEnteredRecovery || await pushRecoveryBarrierActive(options.store, options.scope,
        options.allowRecoveryFrozenPush)) {
        await releaseClaimForRecovery({ store: options.store, scope: options.scope, queue: bound,
          ownerId, fence: lease.fence, now: now() });
        return { outcome: 'recovery', sequence: queue.sequence };
      }
      options.schedule?.(requestTimeout + NETWORK_WATCHDOG_GRACE_MS);
      const batchLimit = workBudget.limit(Math.min(authority.session.maxBatchOperations ?? 1,
        MAX_DRAIN_OPERATIONS - count), deadline - now());
      if (!diagnosed) {
        diagnosed = true;
        await recordPushBatchDecision(options.store, options.scope, queue,
          authority.session.maxBatchOperations ?? 1, batchLimit);
      }
      const started = now();
      const batch = (!options.dispatch || options.dispatchBatch) && await sendBootstrapCreateBatch({
        first: bound, fresh: !queue.attempt && queue.retry.attempt === 0,
        limit: batchLimit,
        store: options.store, scope: options.scope, ownerId, fence: lease.fence, now,
        ...authority, endpoint: (await options.endpoints()).syncPush, fetch: fetcher,
        origin: options.origin, timeoutMs: requestTimeout, dispatch: options.dispatchBatch,
        beforeDispatch: options.beforeDispatch, onNetworkResponse,
        barrier: () => pushRecoveryBarrierActive(options.store, options.scope, options.allowRecoveryFrozenPush),
        prepare: async row => {
          await options.assertUploadAllowed?.(row);
          await options.boundary?.('before_attempt_persist', row);
          const rebased = await rebasePlacement(row, lease.fence);
          if (typeof rebased === 'string') throw new SyncFailureError('push_batch_placement_changed');
          const prepared = await ensureAttempt(rebased, authority.session, lease.fence);
          await options.boundary?.('after_attempt_persist', prepared); return prepared;
        },
        settle: (row, response) => sendClaim(row, authority, lease.fence, repair, undefined, response),
        unknown: (row, code, retryAfter) => persistUnknown(row, lease.fence, code, retryAfter),
      });
      if (batch) {
        workBudget.observe(now() - started, batch.count, batch.outcome === 'unknown');
        count += batch.count - 1; last = { outcome: batch.outcome, sequence: batch.sequence };
        if (batch.outcome !== 'terminal') return last; continue;
      }
      const outcome = await sendClaim(bound, authority, lease.fence, repair, onNetworkResponse);
      workBudget.observe(now() - started, 1, outcome === 'unknown');
      last = { outcome, sequence: queue.sequence };
      if (outcome !== 'terminal') return last;
    }
    options.schedule?.(boundedBackoff(1, random)); return last;
    } finally { renewal.close(); }
  }

  /**
   * The repair pass runs at drain start-up. An unconverged row is reported
   * through the returned attention count and a scope diagnostic; a failed pass
   * must not vanish into an empty catch either.
   */
  async function rejectExcluded(queue: QueueOperation, fence: number, error: unknown) {
    return rejectExcludedBootstrapUpload(options.store, options.scope, queue, ownerId, fence, error);
  }

  async function repairSequenceReuse(): Promise<number> {
    try { return (await repairSequenceReuseRejected(options.store, options.scope)).attention; }
    catch {
      try { await options.store.putScopeDiagnostic(options.scope,
        { kind: 'sequence_reuse_repair', code: 'repair_scan_failed' }); } catch { /* best effort */ }
      return 1;
    }
  }

  /**
   * `sequence_reuse`/`op_id_reused` means "this client's result is unknown", not
   * "this did not execute". Route it by real identity facts: an illegal proof is
   * a permanent operation failure, existing local authority converges the row to
   * terminal, and the remaining rows stay replayable with growing backoff.
   */
  async function handleSequenceReuse(queue: QueueOperation, code: 'sequence_reuse' | 'op_id_reused',
    authority: Awaited<ReturnType<PushSessionController['get']>>, fence: number, retryAfter: string | null) {
    const recorded = await options.store.getScope(options.scope);
    const evidence = await findSequenceReuseEvidence(options.store, options.scope, queue);
    const classification = classifyLocalSequenceReuse({ code, scope: options.scope, queue,
      session: authority.session, replicaLifecycle: recorded?.lifecycle ?? 'active',
      hasLocalEvidence: evidence !== null, credentialSubject: authority.credential.subject });
    if (classification === 'illegal') {
      await options.store.settleClaimedPush(options.scope, queue.sequence, ownerId, fence,
        { outcome: 'rejected', recovery: { code } });
      return 'rejected' as const;
    }
    // Neither reconcile nor unknown may replay the identical bytes without a
    // strictly increasing backoff. If the immediate convergence below cannot
    // run, the durable unknown row is rescanned by the next drain's repair pass.
    const outcome = await persistUnknown(queue, fence, code, retryAfter);
    if (classification === 'reconcile' && evidence) {
      try {
        await options.store.repairSequenceReuseRow(options.scope, queue.sequence,
          sequenceReuseRepairAction(queue, evidence));
        return 'terminal' as const;
      } catch { /* the parked row keeps its evidence and is rescanned next drain */ }
    }
    return outcome;
  }

  async function sendClaim(queue: QueueOperation, initialAuthority: Awaited<ReturnType<PushSessionController['get']>>,
    fence: number, repair: { attention: number },
    onNetworkResponse?: () => void | Promise<void>, acceptedResponse?: Response): Promise<Exclude<DrainOutcome['outcome'], 'idle' | 'contended'>> {
    if (queue.payload.collectionId !== options.scope.collectionId) {
      recordKns09Stop('outOfScopeUpload', options.scope);
      await freezeScopeRecovery(options.store, options.scope, 'push_scope_mismatch');
      return persistUnknown(queue, fence, 'push_scope_mismatch');
    }
    let authority = initialAuthority; let refreshed = false;
    for (let authenticationAttempt = 0; authenticationAttempt < 2; authenticationAttempt += 1) {
      const attempt = queue.attempt; if (!attempt) return persistUnknown(queue, fence, 'push_attempt_missing');
      const body = attempt.body; const controller = new AbortController();
      let timeout!: ReturnType<typeof setTimeout>;
      const timedOut = new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => {
        controller.abort(); reject(new DOMException('Push request timed out', 'AbortError'));
      }, requestTimeout); });
      const withinDeadline = <T>(operation: Promise<T>) => Promise.race([operation, timedOut]);
      let response: Response;
      try {
        if (!acceptedResponse) await options.beforeDispatch?.(queue);
        const send = async () => withinDeadline(fetcher((await options.endpoints()).syncPush, { method: 'POST', redirect: 'error',
          credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/json',
            ...colpCredentialHeaders(authority.credential.accessToken),
            'Content-Type': attempt.mediaType, 'Idempotency-Key': attempt.idempotencyKey,
            ...(options.origin ? { Origin: options.origin } : {}) }, body }));
        response = acceptedResponse ?? await (options.dispatch ? options.dispatch(queue,send) : send());
      } catch (error) {
        clearTimeout(timeout);
        if (reasonCode(error, '') === 'bootstrap_upload_excluded') return rejectExcluded(queue, fence, error);
        if (await stopDeniedMetadataAttempt({ error, store: options.store, scope: options.scope,
          queue, ownerId, fence, now })) return 'recovery';
        return persistUnknown(queue, fence, reasonCode(error, 'push_network_failed'));
      }
      try {
        await onNetworkResponse?.();
        if (response.status === 401 && !refreshed) {
        const retryAfter = response.headers.get('Retry-After');
        // Parse the denial outside the refresh attempt: a malformed body or an
        // unnamed 401 code is an authority problem with its own bounded replay
        // path, not a credential failure that may loop forever.
        let denial: ReturnType<typeof parseColpProblem> | undefined;
        if (problemContentType(response)) {
          try {
            denial = parseColpProblem(await withinDeadline(
              readBoundedJson(response, RESPONSE_MAX_BYTES, 'push_problem_invalid')));
          } catch { denial = undefined; }
        }
        if (!denial || denial.code !== 'authentication_required' || denial.status !== 401) {
          return authorityRecovery.handleUnexplained(queue, fence, 'push_denial_unrecognized', retryAfter, repair);
        }
        try {
          authority = await options.sessions.get(true); assertSession(authority.session, options.scope, now());
          queue = await ensureAttempt(queue, authority.session, fence, true);
          refreshed = true; continue;
        } catch (error) {
          // A refresh that cannot mint authority is an authority problem, not a
          // silent operation failure: keep the row replayable and record it.
          repair.attention += 1;
          try { await options.store.putScopeDiagnostic(options.scope,
            { kind: 'push_authority', code: 'push_session_refresh_failed' }); } catch { /* best effort */ }
          return persistUnknown(queue, fence, reasonCode(error, 'push_session_refresh_failed'));
        }
        }
        if (response.status === 200 && jsonContentType(response)) {
        try {
          const parsed = parseSyncPushResult(await withinDeadline(
            readBoundedJson(response, RESPONSE_MAX_BYTES, 'push_response_invalid')), queue);
          return await settlePushResult({ ...options, ownerId, fence, now, random, digestJson, retryDelay,
            authoritativeCreate, bindSpecialRoleMount }, queue, parsed);
        } catch (error) {
          const code = reasonCode(error, 'push_result_processing_failed');
          if (code === 'mapping_identity_collision') {
            recordKns09Stop('mappingIdentityCollision', options.scope);
            await freezeScopeRecovery(options.store, options.scope, 'mapping_identity_collision');
          }
          return persistUnknown(queue, fence, code);
        }
        }
        if (problemContentType(response)) {
        try {
          const problem = parseColpProblem(await withinDeadline(
            readBoundedJson(response, RESPONSE_MAX_BYTES, 'push_problem_invalid')));
          if (problem.status !== response.status) return persistUnknown(queue, fence, 'push_problem_status_mismatch');
          if (problem.code === 'sequence_gap' || problem.code === 'sequence_blocked') {
            const outcome = problem.code === 'sequence_gap' ? 'gap' as const : 'blocked' as const;
            const delay = retryDelay(queue.retry.attempt + 1, undefined, response.headers.get('Retry-After'), now(), random);
            await options.store.settleClaimedPush(options.scope, queue.sequence, ownerId, fence, { outcome,
              retry: { attempt: queue.retry.attempt + 1, notBefore: now() + delay }, recovery: {
                code: problem.code, ...(problem.expectedSequence ? { expectedSequence: problem.expectedSequence } : {}) } });
            // A gap may be healable from the expectedSequence evidence, but
            // realign runs at drain start: schedule that next drain instead
            // of leaving the barrier to a distant alarm.
            if (outcome === 'gap') options.schedule?.(delay);
            return outcome;
          }
          if (problem.code === 'revision_conflict' && problem.conflictId
              && (queue.payload.type === 'move_node' || queue.payload.type === 'update_node_content')) {
            await options.store.settleClaimedPush(options.scope, queue.sequence, ownerId, fence, { outcome: 'blocked',
              retry: { attempt: queue.retry.attempt, notBefore: now() }, recovery: { code: 'conflict_pending' } });
            return 'blocked';
          }
          const disposition = classifyPushProblem(problem);
          if (disposition === 'reuse') {
            try {
              return await handleSequenceReuse(queue, problem.code as 'sequence_reuse' | 'op_id_reused', authority,
                fence, response.headers.get('Retry-After'));
            } catch (error) {
              return persistUnknown(queue, fence, reasonCode(error, 'sequence_reuse_settlement_failed'),
                response.headers.get('Retry-After'));
            }
          }
          const rebase = placementRebase(queue.payload.type, problem.code)
            || (problem.code === 'resource_not_found' && queue.payload.type === 'create_node'
              && !queue.idempotencyKey.startsWith(`${queue.opId}.placement.`)
              && Boolean(await savedCreatePlacement(options.store, options.scope, queue.opId)));
          if (disposition === 'retryable' || rebase) {
            return persistUnknown(queue, fence, problem.code, rebase ? null : response.headers.get('Retry-After'),
              rebase);
          }
          if (disposition === 'rejected') {
            await options.store.settleClaimedPush(options.scope, queue.sequence, ownerId, fence, {
              outcome: 'rejected', recovery: { code: problem.code } });
            return 'rejected';
          }
          if (disposition === 'authority') {
            return authorityRecovery.handleRefusal(queue, fence, problem, refreshed, repair,
              response.headers.get('Retry-After'));
          }
        } catch {
          // A malformed or oversized Problem on an authority status is still an
          // authority refusal: it gets the same bounded escalation instead of
          // an unbounded identical replay.
          if (AUTHORITY_STATUS.has(response.status)) {
            return authorityRecovery.handleUnexplained(queue, fence, 'push_authority_response_invalid',
              response.headers.get('Retry-After'), repair);
          }
          /* malformed/oversized Problem remains an unknown commit outcome */
        }
        }
        // A bodyless (or non-Problem) authority status is the same refusal as an
        // unparseable one: it takes the bounded escalation instead of replaying
        // the identical bytes forever. Non-authority statuses stay unrecognized.
        if (AUTHORITY_STATUS.has(response.status)) {
          return authorityRecovery.handleUnexplained(queue, fence, 'push_authority_response_invalid',
            response.headers.get('Retry-After'), repair);
        }
        return persistUnknown(queue, fence, 'push_response_unrecognized', response.headers.get('Retry-After'));
      } finally { clearTimeout(timeout); }
    }
    return persistUnknown(queue, fence, 'push_authentication_exhausted');
  }

  /** A repeated local failure of a never-sent change leaves the lane as one item (see push-local-failure.ts). */
  async function persistLocalFailure(queue: QueueOperation, fence: number, reason: string): Promise<'unknown' | 'terminal'> {
    if (await holdRepeatedLocalFailure({ store: options.store, scope: options.scope, ownerId }, queue, fence, reason)) return 'terminal';
    return persistUnknown(queue, fence, reason);
  }

  async function persistUnknown(queue: QueueOperation, fence: number, reason: string, retryAfter: string | null = null,
    clearAttempt = false) {
    const attempt = queue.retry.attempt + 1;
    const delay = clearAttempt && queue.retry.attempt === 0 ? 0
      : retryDelay(attempt, undefined, retryAfter, now(), random);
    await options.store.settleClaimedPush(options.scope, queue.sequence, ownerId, fence, { outcome: 'unknown',
      retry: { attempt, notBefore: now() + delay }, recovery: { code: reason },
      ...(clearAttempt ? { clearAttempt: true as const } : {}) });
    if (delay > 0) options.schedule?.(delay); return 'unknown' as const;
  }
  async function rebasePlacement(queue: QueueOperation, fence: number): Promise<
    QueueOperation | 'terminal' | 'blocked' | 'unknown' | 'recovery'> {
    if (queue.payload.type === 'create_node') return rebaseCreatePlacement(queue, fence);
    if (queue.payload.type !== 'move_node') return queue;
    const nested = queue.payload.payload;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return queue;
    const inner = nested as JsonObject;
    const targetId = queue.payload.targetId;
    if (typeof targetId !== 'string') return queue;
    const retrying = queue.retry.attempt > 0;
    if (retrying && await options.refreshPlacement?.() === 'recovery') return 'recovery';
    const target = await options.store.getMappingByColpId(options.scope, targetId);
    const destId = typeof inner.newParentId === 'string' ? inner.newParentId : undefined;
    const dest = destId ? await options.store.getMappingByColpId(options.scope, destId) : null;
    const mappedParent = target?.parentColpId ? await options.store.getMappingByColpId(options.scope, target.parentColpId)
      : target?.parentNativeId ? await options.store.getMappingByNativeId(options.scope, target.parentNativeId) : null;
    const optimistic = destId !== undefined && mappedParent?.colpId === destId
      && target?.projection.revision === queue.operationRevision;
    const source = optimistic
      ? (await authoredSourceParent(queue.opId, destId) ?? mappedParent) : mappedParent;
    const sourceRev = liveRevision(source?.projection.childrenRevision);
    const destRev = liveRevision(dest?.projection.childrenRevision);
    const nodeRev = liveRevision(target?.projection.revision);
    const nextInner: JsonObject = {
      ...(retrying ? await retainValidPlacementAnchors(options.store, options.scope, inner, destId) : inner),
      ...(sourceRev ? { baseSourceParentRevision: sourceRev } : {}),
      ...(destRev ? { baseTargetParentRevision: destRev } : {}),
    };
    const nextBase = nodeRev ?? (typeof queue.payload.baseRevision === 'string' ? queue.payload.baseRevision : null);
    const changed = nextInner.baseSourceParentRevision !== inner.baseSourceParentRevision
      || nextInner.baseTargetParentRevision !== inner.baseTargetParentRevision
      || nextBase !== queue.payload.baseRevision
      || nextInner.afterId !== inner.afterId || nextInner.beforeId !== inner.beforeId;
    if (changed || retrying) {
      const payload = { ...queue.payload, baseRevision: nextBase, payload: nextInner };
      return options.store.rebaseClaimedPush(options.scope, queue.sequence, ownerId, fence, {
        payload, digest: `sha256:${digestJson(payload)}`,
        idempotencyKey: `${queue.opId}.rebase.${queue.retry.attempt}`, baseRevision: nextBase,
      });
    }
    return queue;
  }

  /** Recover legacy creates; authored save placement instead requires its original parent. */
  async function rebaseCreatePlacement(queue: QueueOperation, fence: number):
  Promise<QueueOperation | 'terminal' | 'unknown' | 'recovery'> {
    const parent = await rebaseTombstonedCreate({ store: options.store, scope: options.scope, queue, ownerId, fence,
      refreshPlacement: options.refreshPlacement, digestJson });
    if (typeof parent === 'string' || parent.digest !== queue.digest || parent.idempotencyKey !== queue.idempotencyKey) return parent;
    return rebaseStaleCreatePlacement({ store: options.store, scope: options.scope, queue: parent, ownerId, fence, digestJson,
      readChildrenOrder: options.readChildrenOrder,
      defer: code => persistUnknown(queue, fence, code, null, true) });
  }
  async function authoredSourceParent(opId: string, destId: string) {
    const match = await findProcessedMoveEvent(
      (afterOrdinal, limit) => options.store.listBookmarkEvents(options.scope, afterOrdinal, limit),
      opId,
    );
    if (!match) return null;
    const context = match.details.context;
    const nativeId = context && typeof context === 'object' && !Array.isArray(context)
      ? (context as JsonObject).sourceParentNativeId : undefined;
    if (typeof nativeId !== 'string') return null;
    const mapped = await options.store.getMappingByNativeId(options.scope, nativeId);
    return mapped && mapped.colpId !== destId ? mapped : null;
  }
  async function authoritativeCreate(queue: QueueOperation, targetId: string, revision: string) {
    const pending = await options.store.getMappingByColpId(options.scope, `pending-${queue.opId}`);
    const planned = plannedCreateNativeId(queue.opId);
    const live = planned ? await options.store.getMappingByNativeId(options.scope, planned) : null;
    const nativeId = liveCreateNativeId(pending?.nativeId) ?? liveCreateNativeId(live?.nativeId) ?? planned;
    // Mount-resolve, import, and already-bound natives settle terminal without
    // a pending-* mapping. Bootstrap local-only creates carry the native id on
    // the planned opId and must bind native↔colp on this receipt.
    if (!nativeId) return undefined;
    const current = pending ?? live ?? await options.store.getMappingByNativeId(options.scope, nativeId);
    if (current?.colpId === targetId) return undefined;
    if (current && current.colpId !== `pending-${queue.opId}` && !current.colpId.startsWith('pending-')) {
      return undefined;
    }
    return { nativeId, targetId, revision };
  }
  async function bindSpecialRoleMount(queue: QueueOperation, targetId: string, revision: string) {
    const role = createNodeFolderRole(queue); if (!isAuthoredMountRole(role)) return;
    const mapping = await options.store.getMappingByColpId(options.scope, `pending-${queue.opId}`);
    const mounts = await options.store.listMountBindings(options.scope);
    const nativeRoot = usableNativeRoot(mapping?.nativeId) ?? usableNativeRoot(mapping?.rootNativeId);
    const mount = (nativeRoot ? mounts.find((item) => item.nativeRootId === nativeRoot) : undefined)
      ?? matchMountByRole(mounts, role, queue.opId);
    if (!mount || mount.status === 'detached') return;
    if (mount.remoteMountNodeId && mount.remoteMountNodeId !== targetId) return;
    await persistMountBinding(options.store, options.scope, mount, targetId);
    await options.store.bindMountMapping(options.scope, {
      nativeId: mount.nativeRootId, colpId: targetId, mountId: mount.mountId,
      ...(mount.rootRole ? { rootRole: mount.rootRole } : {}), revision,
    });
  }
  async function ensureAttempt(queue: QueueOperation, session: StoredSession, fence: number,
    replaceAfterAuthenticationDenial = false) {
    if (queue.attempt && (!replaceAfterAuthenticationDenial || queue.attempt.sessionId === session.sessionId)) return queue;
    const batchId = `${session.sessionId}.${crypto.randomUUID()}`;
    const body = encodeRequest(queue, session.sessionId, batchId);
    if (queue.attempt) assertUnchangedOperationBytes(queue.attempt.body, body);
    return options.store.bindPushAttempt(options.scope, queue.sequence, ownerId, fence, {
      sessionId: session.sessionId, batchId, idempotencyKey: queue.idempotencyKey, endpointIdentity: 'syncPush',
      mediaType: 'application/json', body, bodyDigest: digestBytes(body), startedAt: now(),
    }, replaceAfterAuthenticationDenial);
  }
  async function scheduleOutstanding() {
    const first = await options.store.firstLaneQueue(options.scope);
    if (first && first.status !== 'gap' && first.status !== 'blocked') {
      options.schedule?.(Math.max(1_000, first.retry.notBefore - now()));
    }
  }
  return Object.freeze({ drain });
}

function encodeRequest(queue: QueueOperation, sessionId: string, batchId: string) {
  return canonicalJson({ sessionId, batchId, atomic: false, operations: [queue.payload] });
}
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new SyncFailureError('push_request_invalid'); return encoded; }
function digestJson(value: unknown) { return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value)))); }
function digestBytes(value: string) { return bytesToHex(sha256(new TextEncoder().encode(value))); }
function jsonContentType(response: Response) { return /^application\/json(?:\s*;|$)/iu.test(response.headers.get('Content-Type') ?? ''); }
function problemContentType(response: Response) { return /^application\/problem\+json(?:\s*;|$)/iu.test(response.headers.get('Content-Type') ?? ''); }
function retryDelay(attempt: number, seconds: number | undefined, header: string | null, current: number,
  random: () => number) { const protocol = seconds === undefined ? 0 : seconds * 1_000;
  const parsed = parseRetryAfter(header, current); return Math.min(MAX_BACKOFF_MS,
    Math.max(protocol, parsed, boundedBackoff(attempt, random))); }
function parseRetryAfter(value: string | null, current: number) { if (!value) return 0;
  if (/^\d+$/u.test(value)) return Math.min(MAX_BACKOFF_MS, Number(value) * 1_000);
  const date = Date.parse(value); return Number.isFinite(date) ? Math.min(MAX_BACKOFF_MS, Math.max(0, date - current)) : 0; }
function boundedBackoff(attempt: number, random: () => number) { const exponent = Math.min(8, Math.max(0, attempt));
  const ceiling = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** exponent); return Math.max(1_000, Math.floor(ceiling *
    Math.min(1, Math.max(0, random())))); }
function placementRebase(type: unknown, code: string) {
  return (type === 'move_node' || type === 'create_node')
    && (code === 'position_context_stale' || code === 'revision_conflict');
}
function liveRevision(value: string | null | undefined) {
  return typeof value === 'string' && !value.startsWith('pending-') && !value.startsWith('local-') ? value : undefined;
}
