import { LIMITS } from './limits.js';
import type { SiteDefinition } from './registry-types.js';
export interface SiteReadPolicy { spacingMs: number; commandMs: number; activationMs: number; attempts: number }
export function readLimits(definition: Pick<SiteDefinition, 'readPolicy'>) {
  const limits = { ...LIMITS, ...definition.readPolicy };
  for (const [key, min, max] of [['spacingMs', 1, 60000], ['commandMs', 1000, LIMITS.leaseMs - 2000], ['activationMs', 1000, 30000], ['attempts', 1, 10]] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < min || limits[key] > max) throw new Error('invalidReadPolicy');
  }
  return Object.freeze(limits);
}
