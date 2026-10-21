/**
 * Plain-JSON helpers for conflict resolution (extracted from
 * `sync-conflict-resolution-postgres.ts` under the shrinking-only source-size
 * baseline).
 *
 * The failure callback keeps the caller's error vocabulary: every invalid
 * document must fail closed with the caller's own `SyncConflictResolutionError`
 * code rather than a generic error.
 */

import { encodeThrowingCanonicalJson } from '../../modules/canonical-json.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** UTF-16 key order. `invalid` runs when JSON.stringify yields nothing. */
export function stableJson(value: unknown, invalid: () => never): string {
  return encodeThrowingCanonicalJson(value, { keyOrder: 'utf16', onInvalid: invalid });
}

/** Reject class instances, arrays, accessors, and symbol keys before persisting user input. */
export function assertPlainCustomObject(
  value: unknown,
  invalid: () => never,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid();
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) {
      invalid();
    }
  }
  return value as Record<string, unknown>;
}
