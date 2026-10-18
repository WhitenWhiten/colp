import type { DurableSyncEngineState } from './sync-state-store.js';
import { classifySyncFailure, refreshesReplicaIntegrity } from './sync-failure-class.js';

export const CIRCUIT_WINDOW_MS = 30 * 60_000;
export const CIRCUIT_THRESHOLD = 5;
const INITIAL_COOLDOWN_MS = 60_000;
export interface SyncCircuitBreaker {
  readonly progress: string;
  readonly failures: readonly { readonly code: string; readonly attempts: readonly number[] }[];
  readonly trips: number;
  readonly retryAt?: number;
}

/** Count failures across worker restarts, independently for each denial code. */
export function advanceSyncCircuit(prior: SyncCircuitBreaker | undefined, code: string | undefined,
  progress: string, now: number): SyncCircuitBreaker | undefined {
  const policy = classifySyncFailure(code);
  const integrity = refreshesReplicaIntegrity(code);
  if (policy?.class === 'replica' && !integrity || policy?.class === 'item') return undefined;
  if (!code || policy && policy.class !== 'authority' && !integrity) return prior?.progress === progress ? prior : undefined;
  const counterCode = integrity ? 'replica_integrity_refresh' : policy ? code : 'unknown_external_failure';
  const base = prior?.progress === progress ? prior : undefined;
  const failures = (base?.failures ?? []).map(row => ({ ...row,
    attempts: row.attempts.filter(at => now >= at && (integrity || now - at < CIRCUIT_WINDOW_MS)) })).filter(row => row.attempts.length > 0);
  const previous = failures.find(row => row.code === counterCode);
  const attempts = [...(previous?.attempts ?? []), now].slice(-CIRCUIT_THRESHOLD);
  const trips = base?.trips ?? 0;
  const tripped = attempts.length >= CIRCUIT_THRESHOLD || base?.retryAt !== undefined;
  return { progress, failures: [...failures.filter(row => row.code !== counterCode),
    { code: counterCode, attempts }],
  trips: tripped ? Math.min(trips + 1, 32) : trips,
  ...(tripped ? { retryAt: now + Math.min(CIRCUIT_WINDOW_MS, INITIAL_COOLDOWN_MS * 2 ** Math.min(trips, 5)) } : {}) };
}

export function circuitIsStopped(state: DurableSyncEngineState | null | undefined): boolean {
  return state?.phase === 'error' && state.circuitBreaker?.retryAt !== undefined;
}
