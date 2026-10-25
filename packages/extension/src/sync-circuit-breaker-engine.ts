import { refreshesReplicaIntegrity } from './sync-failure-class.js';
import type { EngineOptions } from './durable-sync-engine-types.js';
import type { DurableSyncEngineState } from './sync-state-store.js';
import { advanceSyncCircuit, circuitIsStopped, stopProbeDue, syncProgress } from './sync-circuit-breaker.js';

export type WakeReason = 'startup' | 'alarm' | 'online' | 'manual' | 'probe';
type Transition = (phase: DurableSyncEngineState['phase'], patch: Partial<DurableSyncEngineState>
  & { readonly expectedRevision?: number; readonly clearConnectivityConfirmation?: boolean }) => Promise<DurableSyncEngineState>;

export function guardSyncWake(options: EngineOptions, now: () => number,
  wakeOnce: (reason: WakeReason, confirmedOnline: boolean, explicitRetry: boolean) => Promise<DurableSyncEngineState | null>,
  transition: Transition) {
  return async (reason: WakeReason, confirmedOnline: boolean, explicitRetry = false) => {
    try {
      const prior = await options.store.getEngineState(options.scope);
      const stopped = circuitIsStopped(prior);
      // A user's Retry is the only trigger that bypasses a stop's schedule; every other wake is automatic.
      const automatic = reason !== 'manual';
      if (stopped && automatic && refreshesReplicaIntegrity(prior?.lastError)) return prior;
      if (stopped && automatic && !stopProbeDue(prior!, now())) {
        options.schedule?.(prior!.notBefore - now()); return prior;
      }
      // Manual Retry is an explicit probe; startup/online cannot bypass the cooldown.
      if (stopped && reason === 'manual') await transition('error', {
        notBefore: 0, lastError: prior!.lastError, expectedRevision: prior!.revision });
      // The alarm that wakes a stopped engine at its scheduled time is the engine's own probe.
      const result = await wakeOnce(stopped && reason === 'alarm' ? 'probe' : reason, confirmedOnline, explicitRetry);
      if (!result || result.phase === 'retired' || result.revision === prior?.revision) return result;
      const current = await options.store.getEngineState(options.scope);
      if (!current) return result;
      const cursor = await options.store.getCursor(options.scope);
      const head = await options.store.firstLaneQueue(options.scope);
      // Only work this replica committed counts as progress (see `syncProgress`).
      const progress = syncProgress({ cursorEvidence: cursor?.evidence ?? null, headOpId: head?.opId ?? null });
      const breaker = current.lastError === undefined ? undefined
        : advanceSyncCircuit(prior?.circuitBreaker, current.lastError, progress, now(),
          { probe: automatic, consecutiveFailures: current.networkBackoffCount ?? 0 });
      if (breaker === undefined && prior?.circuitBreaker === undefined) return result;
      const stoppedNow = breaker?.retryAt !== undefined;
      const next = await transition(stoppedNow ? 'error' : current.phase, {
        expectedRevision: current.revision, circuitBreaker: breaker, lastError: current.lastError,
        ...(stoppedNow ? { notBefore: refreshesReplicaIntegrity(current.lastError) ? 0 : Math.max(current.notBefore, breaker.retryAt!), clearConnectivityConfirmation: true } : {}),
      });
      if (stoppedNow && !refreshesReplicaIntegrity(current.lastError)) options.schedule?.(Math.max(1_000, next.notBefore - now()));
      return next;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'engine_revision_stale') throw error;
      options.schedule?.(1_000); return options.store.getEngineState(options.scope);
    }
  };
}
