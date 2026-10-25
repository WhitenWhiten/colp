import { LIMITS } from './limits.js';
import type { SiteDefinition } from './registry-types.js';
export interface SiteReadPolicy {
  /** Command ownership pacing; also the default request spacing for backward compatibility. */
  spacingMs: number; commandMs: number; activationMs: number; commandAttempts: number;
  /** Budgets for actual site requests, passed to every adapter factory before account detection. */
  requestSpacingMs: number; requestMs: number; attempts: number; backoffMs: number; maxAutomaticWaitMs: number; responseBytes: number;
}
export function readLimits(definition: Pick<SiteDefinition, 'readPolicy'>) {
  const configured = definition.readPolicy;
  const limits = { ...LIMITS, ...configured, requestSpacingMs: configured?.requestSpacingMs ?? configured?.spacingMs ?? LIMITS.spacingMs,
    commandAttempts: configured?.commandAttempts ?? configured?.attempts ?? LIMITS.attempts };
  for (const [key, min, max] of [['spacingMs', 1, 60000], ['commandMs', 1000, LIMITS.leaseMs - 2000], ['activationMs', 1000, 30000], ['attempts', 1, 10],
    ['commandAttempts', 1, 10], ['requestSpacingMs', 1, 60000], ['requestMs', 1, 30000], ['backoffMs', 1, 60000], ['maxAutomaticWaitMs', 1, 60000], ['responseBytes', 1024, LIMITS.responseBytes]] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < min || limits[key] > max) throw new Error('invalidReadPolicy');
  }
  return Object.freeze(limits);
}
