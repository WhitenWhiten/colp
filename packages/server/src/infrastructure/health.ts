export interface ReadinessProbe {
  verifyReady(): Promise<void>;
}

export const alwaysReady: ReadinessProbe = {
  async verifyReady(): Promise<void> {},
};

/**
 * F2 (legacy isolation): compose the API readiness probe from ONLY the
 * dependencies the runtime actually enabled. Absent (disabled) probes
 * contribute nothing, so a disabled Better Auth email surface or an absent
 * legacy OIDC chain never participates in readiness — and the legacy OIDC
 * issuer is never a readiness dependency in any mode (discovery stays a
 * startup check owned by bootstrap/api.ts).
 */
export function composeReadinessProbe(
  probes: ReadonlyArray<ReadinessProbe | null | undefined>,
): ReadinessProbe {
  const active = probes.filter((probe): probe is ReadinessProbe => probe !== null && probe !== undefined);
  if (active.length === 0) return alwaysReady;
  return {
    async verifyReady() {
      for (const probe of active) {
        await probe.verifyReady();
      }
    },
  };
}

/**
 * T10 cache readiness types (plan §5/§6.4 T10). They live here so the
 * transport layer can type the optional `cacheReadiness`/`cacheCapabilityReadiness`
 * dependencies without importing the cache infrastructure module. The bootstrap
 * composition produces structurally identical values through computeCacheReadiness.
 */

/** Main-probe fact: healthy | degraded | disabled (status only, never HTTP). */
export type CacheReadinessState = 'healthy' | 'degraded' | 'disabled';

/** Capability status for `/ready/features/cache`. */
export type CacheCapabilityStatus = 'ready' | 'degraded' | 'disabled' | 'not-ready';

export interface CacheCapabilityReadiness {
  readonly capability: 'cache';
  readonly status: CacheCapabilityStatus;
  readonly mode?: 'off' | 'shadow' | 'serve';
  readonly required?: boolean;
  readonly storeHealth?: 'healthy' | 'degraded';
  readonly circuitState?: 'closed' | 'open' | 'half_open';
  readonly reason?: string;
}
