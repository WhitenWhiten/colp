import { ackEnvelope, headers, digest, jsonContentType, problemContentType } from './sync-engine-wire.js';
import { recoverAtSyncIssueCeiling } from './sync-issue-ceiling-recovery.js';
import { enforceSyncIssueCeiling, SYNC_ISSUE_CEILING_CODE } from './sync-issue-ceiling.js';
import { guardSyncWake } from './sync-circuit-breaker-engine.js';
import { circuitIsStopped } from './sync-circuit-breaker.js';
import { SyncFailureError, holdsInboundPull, holdsUnprovenIdentity, needsReplicaRebuild, persistentLocalSyncFailure } from './sync-failure-class.js';
import { recordRecoveryDiagnostic } from './recovery-diagnostic.js';
import { readEngineSessionAuthority } from './sync-session-handoff.js';
import type { SyncAckResult, SyncPullV02 } from '@know-n/colp/types';
import { readBoundedJson } from './json-response.js';
import { syncAckResult, syncPullV02 } from './generated/pull-effect-validators.js';
import type { AckIntentRecord, DurableSyncEngineState, JsonObject, MappingInput } from './sync-state-store.js';
import type { StoredSession } from './types.js';
import type { EngineOptions, PlacementRefreshOutcome } from './durable-sync-engine-types.js';
import { httpFailure, pullApplyAckState, retryAfterMilliseconds, stableError,
  recoveryCapability, recoveryCapabilityOf, responseProblemCode } from './durable-sync-engine-errors.js';
import { leftoverVirtualChildrenNeedReproject } from './recovery-guard.js';
import { resumeLocalProjection } from './local-projection-recovery.js';
import { assertCompleteSnapshotStaging } from './snapshot-staging-assert.js';
import { classifySessionAuthority, type SessionAuthority } from './session-client.js';
import { sessionTransportBudget } from './colp-transport-budget-browser.js';
import { mayUnfreezeForCompletedBootstrapAck, pendingNativeOrPullFacts } from './bootstrap-ack-unfreeze.js';
import { recoverSnapshot } from './durable-sync-engine-recovery.js';
import { freezeScopeRecovery } from './pull-recovery-freeze.js';
import { pullAckWarnings } from './pull-item-set-aside.js';
const DEFAULT_PULL_LIMIT = 100; const MAX_PULL_PAGES_PER_WAKE = 20; const MAX_NETWORK_BACKOFF_MS = 30_000;
// SYNC-F003: clamp the advisory pull cadence to the backend max (86_400s).
const MAX_RECOMMENDED_PULL_AFTER_SECONDS = 86_400;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const connectivityWakes = new WeakMap<object, Map<string, Promise<DurableSyncEngineState | null>>>();

export function createDurableSyncEngine(options: EngineOptions) {
  const fetcher = options.fetch ?? fetch; const now = options.now ?? Date.now; const random = options.random ?? Math.random;
  const requestTimeoutMilliseconds = options.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const responseReadOptions = { timeoutMilliseconds: requestTimeoutMilliseconds };
  const guardedWake = guardSyncWake(options, now, wakeOnce, transition, digest);
  let wakeTail: Promise<void> = Promise.resolve();
  // SR-14: the Push peer refreshes placement before rebasing a retried
  // create/move. Memoizing the attempt for one wake lets a single Pull answer
  // every rebase in it (a drain can rebase several rows, and a wake can drain
  // twice), capping the extra Pull traffic at one per wake.
  let placementRefreshAttempt: Promise<PlacementRefreshOutcome> | undefined;

  function wake(reason: 'startup' | 'alarm' | 'online' | 'manual', context: {
    readonly connectivityRestored?: boolean;
  } = {}) {
    const confirmedOnline = reason === 'online' && context.connectivityRestored === true;
    const coalesceConnectivityWake = reason === 'startup' || confirmedOnline;
    const wakeKey = coalesceConnectivityWake ? JSON.stringify(options.scope) : '';
    let storeWakes = connectivityWakes.get(options.store);
    const existing = coalesceConnectivityWake ? storeWakes?.get(wakeKey) : undefined;
    if (existing) return existing;
    const result = wakeTail.then(() => guardedWake(reason, confirmedOnline), () => guardedWake(reason, confirmedOnline));
    wakeTail = result.then(() => undefined, () => undefined);
    if (coalesceConnectivityWake) {
      storeWakes ??= new Map(); connectivityWakes.set(options.store, storeWakes); storeWakes.set(wakeKey, result);
      const cleanup = () => { if (storeWakes?.get(wakeKey) === result) storeWakes.delete(wakeKey); };
      void result.then(cleanup, cleanup);
    }
    return result;
  }

  async function wakeOnce(reason: 'startup' | 'alarm' | 'online' | 'manual', confirmedOnline: boolean) {
    placementRefreshAttempt = undefined;
    const scope = await options.store.getScope(options.scope); if (!scope) return null;
    let current = await state();
    if (scope.lifecycle === 'retired') return transition('retired', { recoveryFrozen: true });
    if (await recoverAtSyncIssueCeiling(options, sessionAuthority, now)) return state();
    current = await state();
    if (current.phase === 'error'  && !circuitIsStopped(current) && reason !== 'manual' && reason !== 'startup') return current;
    if (current.recoveryFrozen && holdsUnprovenIdentity(current.lastError) && await options.recoverIdentityFreeze?.()) current = await state();
    // A server-capped payload_too_large is terminal: refreshing authority reproduces the same 413.
    const recoveryScope = await options.store.getScope(options.scope);
    const recoveryCode = typeof recoveryScope?.metadata?.recoveryCode === 'string' ? recoveryScope.metadata.recoveryCode : undefined;
    if (current.recoveryFrozen && (holdsUnprovenIdentity(current.lastError)
        || current.lastError === 'payload_too_large' || needsReplicaRebuild(current.lastError)
        || recoveryCode === 'payload_too_large' || holdsUnprovenIdentity(recoveryCode) || needsReplicaRebuild(recoveryCode))) {
      if (holdsUnprovenIdentity(current.lastError)) options.schedule?.(30_000);
      return current;
    }
    try {
      if (current.localProjectionOwner !== undefined && !current.authorityRefreshRequired) {
        if (current.lastError === 'stale_replica' || current.lastError === 'sync_cursor_expired') {
          await transition('recovery', { recoveryFrozen: true, authorityRefreshRequired: true, notBefore: 0 });
          options.schedule?.(1_000); return state();
        }
        await reprojectLeftover(); current = await state();
        if (current.recoveryFrozen) return current;
      }
      const expiredConfirmation = current.connectivityConfirmationRevision !== undefined && current.notBefore <= now();
      const restartCandidate = current.connectivityConfirmationRevision === undefined && current.phase === 'offline'
        && current.lastError === 'network_unavailable' && current.notBefore > now()
        && !current.recoveryFrozen && !current.authorityRefreshRequired;
      const shouldConfirm = expiredConfirmation || restartCandidate && (reason === 'startup' || confirmedOnline);
      const interruptedCycle = (reason === 'startup' || confirmedOnline)
        && ['session', 'bootstrap', 'pulling', 'applying', 'acking', 'pushing'].includes(current.phase);
      let connectivityRestored = false;
      if (current.connectivityConfirmationRevision !== undefined && !expiredConfirmation && !interruptedCycle
          && reason !== 'manual') {
        options.schedule?.(Math.max(1_000, current.notBefore - now())); return current;
      }
      if (shouldConfirm) {
        const claim = await options.store.claimRestartConnectivity(options.scope, current.revision, now(),
          requestTimeoutMilliseconds);
        if (claim.outcome !== 'claimed') {
          if (claim.state.connectivityConfirmationRevision !== undefined && claim.state.notBefore > now()) {
            options.schedule?.(Math.max(1_000, claim.state.notBefore - now()));
          }
          return claim.state;
        }
        current = claim.state; connectivityRestored = true;
      }
      const leftover = !current.recoveryFrozen && await leftoverVirtualChildrenNeedReproject(options.store, options.scope);
      const outstanding = await firstOutstanding();
      const explicitWake = reason === 'manual' || reason === 'startup' || confirmedOnline;
      const replicaReady = Boolean((await options.store.getCursor(options.scope))?.cursor
        ?? (await options.store.getScope(options.scope))?.checkpoint?.cursor);
      const inboundPull = explicitWake && !current.recoveryFrozen && !current.authorityRefreshRequired
        && outstanding === null && replicaReady
        && (current.phase === 'offline' && (reason === 'manual' || !holdsInboundPull(current.lastError))
          || current.phase === 'sleeping' && confirmedOnline && current.lastError === undefined);
      const resumeLocalWork = explicitWake && !current.recoveryFrozen
        && (leftover
          || outstanding !== null && (current.phase === 'sleeping' && current.lastError === undefined
            || current.phase === 'offline')
          || inboundPull);
      if (current.notBefore > now() && !connectivityRestored && !resumeLocalWork && !interruptedCycle && !leftover) {
        options.schedule?.(current.notBefore - now()); return current;
      }
      if (current.recoveryFrozen && !current.authorityRefreshRequired
          && (current.lastError === 'stale_replica' || current.lastError === 'sync_cursor_expired')) {
        await transition('recovery', { recoveryFrozen: true, authorityRefreshRequired: true, notBefore: 0 });
        options.schedule?.(1_000); return state();
      }
      let refreshedAuthority: Awaited<ReturnType<typeof sessionAuthority>> | undefined;
      if (current.authorityRefreshRequired) {
        refreshedAuthority = await sessionAuthority(true);
        const refreshedClassification = classifySessionAuthority(refreshedAuthority.session, {
          authorityRefreshRequired: true, bootstrapped: true,
        });
        if (refreshedClassification === 'recovery') return await recover(refreshedAuthority, refreshedClassification);
        await options.store.rebaseActiveSessionAuthority(options.scope, {
          cursor: refreshedAuthority.session.collection.serverCursor,
          serverRevision: refreshedAuthority.session.collection.serverRevision,
          expectedEngineRevision: current.revision,
        });
        await transition('session', { sessionId: refreshedAuthority.session.sessionId,
          lastPublishedCursor: refreshedAuthority.session.collection.serverCursor,
          lastAckedCursor: refreshedAuthority.session.collection.serverCursor,
          recoveryFrozen: !mayUnfreezeForCompletedBootstrapAck(await pendingNativeOrPullFacts(options.store, options.scope)),
          authorityRefreshRequired: false, notBefore: 0 });
        current = await state();
      }
      const pendingAck = await options.store.getPendingAckIntent(options.scope);
      if (pendingAck) {
        const authority = await sessionAuthority(); const sent = await sendAck(pendingAck, authority);
        if (sent === 'recovery') return state();
        if (sent === 'discarded') return transition('recovery', { recoveryFrozen: true,
          authorityRefreshRequired: true, lastError: 'pull_ack_discarded' });
        if (sent === 'complete') {
          if (pendingAck.kind === 'bootstrap') {
            const cursor = await options.store.getCursor(options.scope);
            const active = await renewBootstrapAuthority(recoveryCapabilityOf(cursor) ?? pendingAck.cursor);
            return transition('sleeping', { sessionId: active.session.sessionId,
              recoveryFrozen: !mayUnfreezeForCompletedBootstrapAck(await pendingNativeOrPullFacts(options.store, options.scope)),
              notBefore: now() + 1_000, lastPublishedCursor: pendingAck.cursor, lastAckedCursor: pendingAck.cursor });
          }
          return sleep(authority.session);
        }
      }
      if (current.recoveryFrozen) {
        const [cursor, ackIntents] = await Promise.all([
          options.store.getCursor(options.scope), options.store.listAckIntents(options.scope)]);
        const completedBootstrap = ackIntents.find((intent: AckIntentRecord) =>
          intent.kind === 'bootstrap' && intent.state === 'complete' && intent.cursor === cursor?.cursor);
        if (completedBootstrap && mayUnfreezeForCompletedBootstrapAck(await pendingNativeOrPullFacts(options.store, options.scope))) {
          const active = current.authorityRefreshRequired
            ? await renewBootstrapAuthority(recoveryCapabilityOf(cursor) ?? completedBootstrap.cursor)
            : await sessionAuthority();
          await transition('sleeping', { sessionId: active.session.sessionId, recoveryFrozen: false,
            notBefore: now() + 1_000, lastPublishedCursor: completedBootstrap.cursor,
            lastAckedCursor: completedBootstrap.cursor });
          await reprojectLeftover();
          return state();
        }
      }
      await transition('session'); const authority = refreshedAuthority ?? await sessionAuthority();
      const ackIntents = await options.store.listAckIntents(options.scope);
      const bootstrappedReplica = ackIntents.some((intent: AckIntentRecord) => intent.kind === 'bootstrap'
        && intent.state === 'complete');
      const classification = classifySessionAuthority(authority.session, {
        authorityRefreshRequired: current.authorityRefreshRequired,
        bootstrapped: bootstrappedReplica,
      });
      if (classification !== 'active') return await recover(authority, classification);
      if (await options.store.hasRecoveryStaging(options.scope) || current.phase === 'bootstrap') {
        throw new SyncFailureError('session_authority_invalid');
      }
      await reprojectLeftover();
      const queue = await firstOutstanding();
      if ((queue?.payload.type === 'move_node' || queue?.payload.type === 'create_node')
          && !queue.attempt && queue.retry.attempt > 0) {
        // SR-14: this advisory Pull narrows the staleness a retried
        // create/move rebase would otherwise inherit, but it is not a verdict on
        // the wake. Only the three crash/terminal denials stay fatal; a
        // connectivity miss is recorded instead of persisting offline state, and
        // any other failure is a diagnostic so the push phase still gets its
        // turn with the durable facts that already exist.
        try {
          const pulledFirst = await pull(authority, false);
          if (pulledFirst === 'recovery') return state();
          if (pulledFirst === 'offline') {
            await recordPlacementRefreshFailure('network_unavailable');
          } else {
            // The advisory Pull just read the placement facts, so the rebases in
            // this wake may reuse them instead of pulling a second time.
            placementRefreshAttempt = Promise.resolve('continue');
          }
        } catch (error) {
          if (error instanceof Error && (error.message === 'worker_crash' || error.message === 'payload_too_large'
              || error.message === 'engine_revision_stale')) throw error;
          await recordPlacementRefreshFailure(stableError(error));
        }
      }
      if (queue) {
        await transition('pushing', { sessionId: authority.session.sessionId });
        const outcome = await options.pushWorker.drain(confirmConnectivityResponse);
        // Contended yields; unknown/deferred/gap/blocked still Pull so mapping facts can rebase.
        if (outcome.outcome === 'contended') return sleep(authority.session);
        if (outcome.outcome === 'recovery') return state();
        if (outcome.outcome === 'rejected') {
          // B1-1/S4 (SR-05): a non-retryable (or sequence_reuse-illegal) rejection is a
          // verdict on one operation, not on the replica. The worker already
          // settled that exact row as a terminal 'rejected' (outbound-push-worker
          // settleClaimedPush), and firstOutstanding()'s live set excludes
          // 'rejected', so nothing here disproves the rest of the local
          // projection. Freezing the scope (recoveryFrozen + authorityRefreshRequired)
          // would misreport a single bad op as a replica-wide divergence, and the
          // early return would stall the cursor for the facts the server did
          // accept. Record the user-visible divergence and keep this wake's Pull
          // so the accepted part converges; the row's terminal status keeps
          // surfacing through engine-public-stability queueStatusProjection.
          // The Pull transition clears lastError, which is fine: the durable row
          // stays the user-visible fact.
          await transition('session', { sessionId: authority.session.sessionId, lastError: 'push_rejected' });
        }
      }
      await reprojectLeftover();
      const pulled = await pull(authority);
      if (pulled === 'recovery') return state();
      if (pulled === 'offline') return options.store.getEngineState(options.scope);
      if (await enforceSyncIssueCeiling(options.store, options.scope, now())) return state();
      // The worker owns fresh native recapture. A settled hold is outside the
      // live lane, so this recovery pass must also run when that lane is empty.
      const afterPull = await firstOutstanding();
      const heldUploads = await options.store.listQueue(options.scope, 'set_aside', 0, 1);
      if (afterPull && !afterPull.attempt || heldUploads.length > 0) {
        await transition('pushing', { sessionId: authority.session.sessionId });
        const outcome = await options.pushWorker.drain(confirmConnectivityResponse);
        if (outcome.outcome === 'recovery') return state();
      }
      await reprojectLeftover();
      return sleep(authority.session);
    } catch (error) {
      if (error instanceof Error && error.message === 'worker_crash') throw error;
      if (error instanceof Error && error.message === 'engine_revision_stale') {
        options.schedule?.(1_000); return state();
      }
      if (error instanceof Error && error.message === 'payload_too_large') {
        // F013: see the frozen-wake gate above — this is an observable terminal
        // failure, not a retryable recovery denial.
        await freezeScopeRecovery(options.store, options.scope, 'payload_too_large', now);
        await transition('recovery', { authorityRefreshRequired: false, lastError: 'payload_too_large' });
        return state();
      }
      return offline(error);
    }
  }

  async function pull(authority: Awaited<ReturnType<typeof sessionAuthority>>, persistOffline = true): Promise<'complete' | 'recovery' | 'offline'> {
    if (Date.parse(authority.session.expiresAt) <= now() + 60_000) authority = await sessionAuthority();
    // hasMore pages continue in this wake; the page budget hands any tail to the next alarm.
    for (let pages = 0; pages < MAX_PULL_PAGES_PER_WAKE; pages += 1) {
      const held = await state(); const heldScope = await options.store.getScope(options.scope);
      // Freeze old-page apply until handover. lifecycle and recoveryFrozen are separate facts.
      if (held.authorityRefreshRequired || (held.recoveryFrozen && heldScope?.lifecycle === 'recovery_required')) return 'recovery';
      const endpoints = await options.endpoints();
      await options.pullApplier.resume();
      if (await enforceSyncIssueCeiling(options.store, options.scope, now())) return 'complete';
      if (await options.store.hasPullEventsAwaitingConfirmation(options.scope)) {
        await transition('sleeping', { sessionId: authority.session.sessionId, notBefore: now() + 30_000,
      networkBackoffCount: 0 }); return 'complete';
      }
      const [cursorRow, scopeRow] = await Promise.all([
        options.store.getCursor(options.scope), options.store.getScope(options.scope)]);
      const cursor = cursorRow?.cursor ?? scopeRow?.checkpoint?.cursor; if (!cursor) return 'recovery';
      await transition('pulling', { sessionId: authority.session.sessionId, lastPublishedCursor: cursor });
      await options.boundary?.('before_pull');
      const url = new URL(endpoints.syncPull); url.searchParams.set('sessionId', authority.session.sessionId);
      url.searchParams.set('cursor', cursor); url.searchParams.set('limit', String(DEFAULT_PULL_LIMIT));
      let response: Response;
      try { response = await networkFetch(url.toString(), { redirect: 'error', cache: 'no-store',
        headers: headers(authority, options.origin) }); }
      catch (error) { if (persistOffline) await offline(error); return 'offline'; }
      await options.boundary?.('after_pull');
      let consumedProblemCode: string | undefined;
      if ((response.status === 400 || response.status === 410 || response.status === 413)
          && problemContentType(response)) {
        const problem = await readBoundedJson(response, 128 * 1024, 'pull_problem_invalid', responseReadOptions) as Record<string, unknown>;
        if (problem.code === 'payload_too_large') {
          // F013: an authenticated payload_too_large problem means no byte-shaped
          // page can advance this cursor under the negotiated budget. Freeze the
          // scope as the observable terminal failure instead of re-pulling the
          // same cursor after every authority refresh.
          await freezeScopeRecovery(options.store, options.scope, 'payload_too_large', now);
          await transition('recovery', { sessionId: authority.session.sessionId,
            authorityRefreshRequired: false, lastError: 'payload_too_large' });
          return 'recovery';
        }
        if (problem.code === 'invalid_cursor_scope' || problem.code === 'sync_cursor_expired' || problem.code === 'stale_replica'
            || problem.code === 'snapshot_expired') {
          await transition('recovery', { sessionId: authority.session.sessionId, recoveryFrozen: true,
            authorityRefreshRequired: true, lastError: String(problem.code) });
          options.schedule?.(1_000); return 'recovery';
        }
        // The body is consumed; keep the parsed code (e.g. replica_retired) so the durable
        // error names the real denial instead of the generic pull_failed fallback.
        consumedProblemCode = typeof problem.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(problem.code)
          ? problem.code : undefined;
      }
      if (response.status !== 200 || !jsonContentType(response)) {
        throw httpFailure(response, consumedProblemCode ?? await responseProblemCode(response, 'pull_failed', requestTimeoutMilliseconds), now());
      }
      const document = await readBoundedJson(response, sessionTransportBudget(authority.session).pullResponseBytes, 'pull_invalid', responseReadOptions);
      if (!syncPullV02(document)) throw new SyncFailureError('pull_invalid');
      const page = document as SyncPullV02; await transition('applying', { sessionId: authority.session.sessionId });
      await options.pullApplier.stage(page, {
        reissued: response.headers.get('Known-Sync-Cursor-Reissued') === 'true',
      }); await options.pullApplier.resume(); await options.boundary?.('after_pull_apply');
      const published = (await options.store.getCursor(options.scope))?.cursor;
      if (published !== page.nextCursor && await enforceSyncIssueCeiling(options.store, options.scope, now())) return 'complete';
      const ack = pullApplyAckState(published, page.nextCursor,
        await options.store.hasPullEventsAwaitingConfirmation(options.scope));
      if (ack === 'not_durable') throw new SyncFailureError('pull_cursor_not_durable');
      if (ack === 'parked') {
        await transition('sleeping', { sessionId: authority.session.sessionId, notBefore: now() + 30_000,
          networkBackoffCount: 0 }); return 'complete';
      }
      if (published && published !== (await state()).lastAckedCursor) {
        const intent = await ackIntent('pull', authority.session.sessionId, published);
        const outcome = await sendAck(intent, authority);
        if (outcome === 'discarded') {
          // Pull ack identity invalidated: recover now, like the top-level path.
          await transition('recovery', { sessionId: authority.session.sessionId, recoveryFrozen: true,
            authorityRefreshRequired: true, lastError: 'pull_ack_discarded' }); return 'recovery';
        }
      }
      if (await enforceSyncIssueCeiling(options.store, options.scope, now())) return 'complete';
      if (page.hasMore) continue;
      // An active Session can resume Pull while a leftover native/page fact keeps
      // recovery frozen. Once that work and its Ack settle, the current cursor no
      // longer equals the historical bootstrap Ack: release this completed handoff.
      const settled = await state();
      if (settled.recoveryFrozen && !settled.authorityRefreshRequired && !settled.lastError
          && settled.lastAckedCursor === published && !await options.store.hasRecoveryStaging(options.scope)
          && !await options.store.getPendingAckIntent(options.scope)
          && (await options.store.listPullPages(options.scope, ['blocked'])).length === 0
          && mayUnfreezeForCompletedBootstrapAck(await pendingNativeOrPullFacts(options.store, options.scope))) {
        await transition('applying', { recoveryFrozen: false });
      }
      await transition('sleeping', { sessionId: authority.session.sessionId,
        notBefore: now() + Math.min(Math.max(1, page.recommendedPullAfterSeconds), MAX_RECOMMENDED_PULL_AFTER_SECONDS) * 1_000, networkBackoffCount: 0 });
      return 'complete';
    }
    await transition('sleeping', { sessionId: authority.session.sessionId, notBefore: now() + 1_000,
      networkBackoffCount: 0 }); return 'complete';
  }

  /** SR-14: best-effort journal for a refresh that did not land. The refresh is
   * advisory, so a bookkeeping write must never be why a push attempt is lost. */
  async function recordPlacementRefreshFailure(code: string) {
    try { await options.store.putScopeDiagnostic(options.scope, { kind: 'placement_refresh', code }); }
    catch { /* diagnostics are best-effort */ }
  }

  /**
   * SR-14: the narrow placement refresh the Push peer calls before rebasing a
   * retried create/move. It reuses the ordinary Pull path with
   * `persistOffline = false`: a failed refresh is a diagnostic on an advisory
   * read, not a verdict on the push attempt that asked for it, so the rebase
   * continues with the durable facts it already has instead of losing the
   * attempt. Only `worker_crash` escapes — the crash-injection contract must
   * still abort the surrounding wake. The attempt is memoized until the next
   * wake, so concurrent callers share one Pull (the Pull path never re-enters
   * this hook, so the memo cannot wait on itself).
   */
  async function refreshPlacement(): Promise<PlacementRefreshOutcome> {
    let attempt = placementRefreshAttempt;
    if (!attempt) { attempt = performPlacementRefresh(); placementRefreshAttempt = attempt; }
    try { return await attempt; }
    catch (error) {
      // Only the crash injection rejects; never memoize it, so a later drain in
      // the same scope can refresh after the injected abort.
      if (placementRefreshAttempt === attempt) placementRefreshAttempt = undefined;
      throw error;
    }
  }

  async function performPlacementRefresh(): Promise<PlacementRefreshOutcome> {
    try {
      const authority = await sessionAuthority(false);
      const pulled = await pull(authority, false);
      if (pulled === 'offline') await recordPlacementRefreshFailure('network_unavailable');
      return pulled === 'recovery' ? 'recovery' : 'continue';
    } catch (error) {
      if (error instanceof Error && error.message === 'worker_crash') throw error;
      await recordPlacementRefreshFailure(stableError(error));
      return 'continue';
    }
  }

  async function recover(authority: Awaited<ReturnType<typeof sessionAuthority>>, classification: Exclude<SessionAuthority, 'active'>) {
    return recoverSnapshot({
      options, now, transition, networkFetch, headers, projectRecovery, sendAck, renewBootstrapAuthority,
      ackEnvelope, digest, state,
    }, authority, classification);
  }

  async function ackIntent(kind: AckIntentRecord['kind'], sessionId: string, cursor: string) {
    const warnings = kind === 'pull' ? await pullAckWarnings(options.store, options.scope) : [];
    return options.store.beginAckIntent(options.scope, ackEnvelope(kind, sessionId, cursor, undefined, warnings));
  }

  async function projectRecovery(snapshotId: string) {
    const exported = await options.store.exportScope(options.scope);
    const staged = (exported.recoveryNodes as Array<{ mapping: MappingInput & { scopeKey?: string } }>).map((node) => {
      const { scopeKey: _scopeKey, ...mapping } = node.mapping; return mapping;
    });
    if (staged.every((mapping) => !mapping.nativeId.startsWith('recovery:'))) return;
    await transition('applying', { recoveryFrozen: true });
    const projected = await options.snapshotProjector(staged);
    await options.store.finalizeRecoveryMappings(options.scope, snapshotId, projected);
    await assertCompleteSnapshotStaging(options.store, options.scope,
      (exported.recoveryNodes as Array<{ parentId: string | null; colpId: string }>)
        .find((node) => node.parentId === null)?.colpId ?? '');
  }

  async function reprojectLeftover() {
    await resumeLocalProjection(options, sessionAuthority);
  }

  async function sendAck(intent: AckIntentRecord, authority: Awaited<ReturnType<typeof sessionAuthority>>) {
    if (intent.state === 'complete') {
      await transition('sleeping', { sessionId: authority.session.sessionId,
        lastPublishedCursor: intent.cursor, lastAckedCursor: intent.cursor,
        networkBackoffCount: 0 }); return 'complete' as const;
    }
    await transition('acking', { sessionId: authority.session.sessionId,
      lastPublishedCursor: intent.cursor }); await options.boundary?.('before_ack'); const endpoints = await options.endpoints();
    const response = await networkFetch(endpoints.syncAck, { method: 'POST', redirect: 'error', headers: {
      ...headers(authority, options.origin), 'Known-Sync-Session': intent.sessionId, 'Content-Type': intent.mediaType,
      'Idempotency-Key': intent.idempotencyKey }, body: intent.body });
    await options.boundary?.('after_ack');
    if (response.status !== 200 || !jsonContentType(response)) {
      const problem = await readBoundedJson(response, 128 * 1024, 'ack_problem_invalid', responseReadOptions)
        .catch(() => undefined);
      const code = problem && typeof problem === 'object' && !Array.isArray(problem)
        ? (problem as { readonly code?: unknown }).code : undefined;
      // The intent's Session/cursor identity can no longer be acknowledged.
      // Bootstrap must obtain fresh recovery authority; Pull can reissue its
      // cursor. Other denials retain the exact durable request for retry.
      const invalidatedIntent = problemContentType(response)
        && (response.status === 410 && (code === 'stale_replica' || code === 'sync_cursor_expired')
          || response.status === 404 && code === 'resource_not_found'
          || response.status === 400 && code === 'invalid_cursor_scope');
      if (invalidatedIntent && intent.kind === 'bootstrap') {
        await options.store.rejectBootstrapAckAndRequireAuthorityRefresh(options.scope, intent.intentId, {
          sessionId: authority.session.sessionId, updatedAt: now(), notBefore: now() + 1_000, errorCode: String(code),
        }); options.schedule?.(1_000);
        return 'recovery' as const;
      }
      if (invalidatedIntent && intent.kind === 'pull') {
        await options.store.discardPullAckIntent(options.scope, intent.intentId);
        options.schedule?.(1_000);
        return 'discarded' as const;
      }
      throw httpFailure(response, typeof code === 'string' ? code : 'ack_failed', now());
    }
    const document = await readBoundedJson(response, 128 * 1024, 'ack_invalid', responseReadOptions);
    if (!syncAckResult(document)
        || (document as SyncAckResult).ackedCursor !== intent.cursor
        || (document as SyncAckResult).replicaId !== options.scope.replicaId) throw new SyncFailureError('ack_invalid');
    await options.store.completeAckIntent(options.scope, intent.intentId, document as unknown as JsonObject);
    await transition('sleeping', { sessionId: authority.session.sessionId, lastPublishedCursor: intent.cursor,
      lastAckedCursor: intent.cursor, networkBackoffCount: 0 }); return 'complete' as const;
  }

  const sessionAuthority = (forceRefresh = false) => readEngineSessionAuthority(options, now, forceRefresh);
  async function renewBootstrapAuthority(capability: string) {
    const refreshState = await transition('bootstrap', { recoveryFrozen: true, authorityRefreshRequired: true, notBefore: 0 });
    const authority = await sessionAuthority(true);
    if (authority.session.replicaLease.state !== 'active' || authority.session.snapshotRequired) {
      throw new SyncFailureError('recovery_authority_not_activated');
    }
    const checkpoint = { cursor: authority.session.collection.serverCursor,
      serverRevision: authority.session.collection.serverRevision };
    if (recoveryCapability(capability)) await options.store.rebaseRecoveryCursor(options.scope, capability, checkpoint);
    else await options.store.rebaseActiveSessionAuthority(options.scope, {
      ...checkpoint, expectedEngineRevision: refreshState.revision,
    });
    return authority;
  }
  /** The lane head. A conflict the server already consumed waits for Pull, not for this lane. */
  function firstOutstanding() { return options.store.firstLaneQueue(options.scope); }
  async function sleep(session: StoredSession) { const prior = await state();
    const outstanding = await firstOutstanding();
    const retryAt = outstanding && outstanding.status !== 'gap' && outstanding.status !== 'blocked'
      ? outstanding.retry.notBefore : undefined;
    const idle = now() + 30_000;
    const notBefore = retryAt === undefined
      ? (prior.notBefore > now() ? prior.notBefore : idle) : Math.max(now(), retryAt);
    const next = await transition('sleeping', { sessionId: session.sessionId, notBefore, networkBackoffCount: 0 });
    try { await options.store.compactScope(options.scope, { now: now() }); }
    catch { await recordRecoveryDiagnostic(options.store, options.scope, 'idle_compaction', 'compaction_failed'); }
    options.schedule?.(Math.max(1_000, next.notBefore - now())); return next; }
  async function offline(error: unknown) { const prior = await state();
    const code = stableError(error);
    if (code === SYNC_ISSUE_CEILING_CODE) { await enforceSyncIssueCeiling(options.store, options.scope, now()); return state(); }
    if (persistentLocalSyncFailure(code)) return transition('error', { lastError: code, notBefore: 0, clearConnectivityConfirmation: true });
    const backoffCount = (prior.networkBackoffCount ?? 0) + 1;
    const retryAfter = retryAfterMilliseconds(error); const delay = retryAfter ?? Math.min(MAX_NETWORK_BACKOFF_MS,
      Math.max(1_000, Math.floor(Math.min(MAX_NETWORK_BACKOFF_MS, 1_000 * 2 ** Math.min(8,
        backoffCount)) * Math.max(0.1, Math.min(1, random()))))); const next = await transition(
      prior.recoveryFrozen ? 'recovery' : retryAfter === undefined ? 'offline' : 'sleeping', {
      notBefore: now() + delay, lastError: stableError(error), networkBackoffCount: backoffCount,
      clearConnectivityConfirmation: true }); options.schedule?.(delay); return next; }
  async function state() { return await options.store.getEngineState(options.scope) ?? {
    scopeKey: (await options.store.getScope(options.scope))!.scopeKey, phase: 'idle', revision: 0, updatedAt: now(),
    recoveryFrozen: false, authorityRefreshRequired: false, notBefore: 0 } satisfies DurableSyncEngineState; }
  async function transition(phase: DurableSyncEngineState['phase'], patch: Partial<DurableSyncEngineState>
    & { readonly expectedRevision?: number; readonly clearConnectivityConfirmation?: boolean } = {}) {
    const prior = await state(); return options.store.transitionEngine(options.scope, { phase, updatedAt: now(),
      recoveryFrozen: patch.recoveryFrozen ?? prior.recoveryFrozen, notBefore: patch.notBefore ?? prior.notBefore,
      authorityRefreshRequired: patch.authorityRefreshRequired ?? prior.authorityRefreshRequired,
      ...(('circuitBreaker' in patch ? patch.circuitBreaker : prior.circuitBreaker) === undefined ? {}
        : { circuitBreaker: 'circuitBreaker' in patch ? patch.circuitBreaker : prior.circuitBreaker }),
      ...(patch.recoveryFrozen === undefined && prior.localProjectionOwner !== undefined
        ? { localProjectionOwner: prior.localProjectionOwner } : {}),
      ...(!patch.clearConnectivityConfirmation && prior.connectivityConfirmationRevision !== undefined
        ? { connectivityConfirmationRevision: prior.connectivityConfirmationRevision } : {}),
      // Compare-and-swap every transition so a concurrent recovery/freeze write
      // cannot be overwritten by this stale read-modify-write.
      expectedRevision: patch.expectedRevision ?? prior.revision,
      ...(patch.lastPushServerCursor ?? prior.lastPushServerCursor ? { lastPushServerCursor:
        patch.lastPushServerCursor ?? prior.lastPushServerCursor } : {}),
      ...(patch.lastPushOutcomeHint ?? prior.lastPushOutcomeHint ? { lastPushOutcomeHint:
        patch.lastPushOutcomeHint ?? prior.lastPushOutcomeHint } : {}),
      ...(patch.networkBackoffCount !== undefined || prior.networkBackoffCount !== undefined
        ? { networkBackoffCount: patch.networkBackoffCount ?? prior.networkBackoffCount ?? 0 } : {}),
      ...(patch.sessionId ?? prior.sessionId ? { sessionId: patch.sessionId ?? prior.sessionId } : {}),
      ...(patch.lastPublishedCursor ?? prior.lastPublishedCursor ? { lastPublishedCursor:
        patch.lastPublishedCursor ?? prior.lastPublishedCursor } : {}),
      ...(patch.lastAckedCursor ?? prior.lastAckedCursor ? { lastAckedCursor: patch.lastAckedCursor
        ?? prior.lastAckedCursor } : {}), ...(patch.lastError ? { lastError: patch.lastError } : {}) }); }

  async function confirmConnectivityResponse() {
    const current = await state();
    if (current.connectivityConfirmationRevision !== undefined) {
      await options.store.confirmRestartConnectivity(options.scope, current.connectivityConfirmationRevision, now());
    }
  }

  async function networkFetch(input: RequestInfo | URL, init: RequestInit) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), requestTimeoutMilliseconds);
    try {
      const response = await fetcher(input, { credentials: 'omit', ...init, signal: controller.signal });
      await confirmConnectivityResponse(); return response;
    } finally { clearTimeout(timeout); }
  }
  return Object.freeze({ wake, state, refreshPlacement });
}

