import type { EngineOptions } from './durable-sync-engine-types.js';
import type { DurableSyncEngineState } from './sync-state-store.js';
import { advanceSyncCircuit, circuitIsStopped } from './sync-circuit-breaker.js';

type WakeReason = 'startup' | 'alarm' | 'online' | 'manual';
type Transition = (phase: DurableSyncEngineState['phase'], patch: Partial<DurableSyncEngineState>
  & { readonly expectedRevision?: number; readonly clearConnectivityConfirmation?: boolean }) => Promise<DurableSyncEngineState>;

export function guardSyncWake(options: EngineOptions, now: () => number,
  wakeOnce: (reason: WakeReason, confirmedOnline: boolean) => Promise<DurableSyncEngineState | null>,
  transition: Transition, digest: (value: unknown) => string) {
  return async (reason: WakeReason, confirmedOnline: boolean) => {
    try {
      const prior = await options.store.getEngineState(options.scope);
      if (circuitIsStopped(prior) && reason !== 'manual' && prior!.notBefore > now()) {
        options.schedule?.(prior!.notBefore - now()); return prior;
      }
      // Manual Retry is an explicit probe; startup/online cannot bypass the cooldown.
      if (circuitIsStopped(prior) && reason === 'manual') await transition('error', {
        notBefore: 0, lastError: prior!.lastError, expectedRevision: prior!.revision });
      const result = await wakeOnce(reason, confirmedOnline);
      if (!result || result.phase === 'retired' || result.revision === prior?.revision) return result;
      const current = await options.store.getEngineState(options.scope);
      if (!current) return result;
      const scope = await options.store.getScope(options.scope);
      const head = await options.store.firstLaneQueue(options.scope);
      // Renewing an opaque Session cursor alone is not logical server progress.
      const progress = digest([scope?.checkpoint?.serverRevision ?? null, head?.opId ?? null]);
      const breaker = current.lastError === undefined ? undefined
        : advanceSyncCircuit(prior?.circuitBreaker, current.lastError, progress, now());
      if (breaker === undefined && prior?.circuitBreaker === undefined) return result;
      const stopped = breaker?.retryAt !== undefined;
      const next = await transition(stopped ? 'error' : current.phase, {
        expectedRevision: current.revision, circuitBreaker: breaker, lastError: current.lastError,
        ...(stopped ? { notBefore: Math.max(current.notBefore, breaker.retryAt!), clearConnectivityConfirmation: true } : {}),
      });
      if (stopped) options.schedule?.(Math.max(1_000, next.notBefore - now()));
      return next;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'engine_revision_stale') throw error;
      options.schedule?.(1_000); return options.store.getEngineState(options.scope);
    }
  };
}
