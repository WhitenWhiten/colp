/**
 * T05 readiness composition (plan §5 / §6.4 T05): combines the cache mode, the
 * circuit breaker state and the store health into the `cache=healthy|degraded|disabled`
 * readiness fact consumed by T10/T11 readiness probes.
 *
 * - `disabled` is decided solely by mode=off (no Redis client exists).
 * - `degraded` is decided by an open/half-open breaker or a degraded store.
 * - `healthy` means the cache layer is enabled and currently reliable.
 *
 * The result is a status fact only: it never blocks API liveness and never
 * decides HTTP availability on its own — the required/readiness semantics are
 * owned by T10/T11 (KNOWN_CACHE_REQUIRED).
 */
import type { CacheCircuitState } from './cache-circuit-breaker.js';
import type { CacheHealthState } from './cache-store.js';

export type CacheMode = 'off' | 'shadow' | 'serve';

export type CacheReadinessState = 'healthy' | 'degraded' | 'disabled';

export interface CacheReadinessInput {
  readonly mode: CacheMode;
  readonly circuitState: CacheCircuitState;
  readonly storeHealth: CacheHealthState;
}

export function computeCacheReadiness(input: CacheReadinessInput): CacheReadinessState {
  if (input.mode === 'off') return 'disabled';
  if (input.circuitState === 'open' || input.circuitState === 'half_open') return 'degraded';
  if (input.storeHealth === 'degraded') return 'degraded';
  return 'healthy';
}
