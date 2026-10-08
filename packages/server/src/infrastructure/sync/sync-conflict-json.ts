/**
 * Plain-JSON helpers for conflict resolution (extracted from
 * `sync-conflict-resolution-postgres.ts` under the shrinking-only source-size
 * baseline).
 *
 * The failure callback keeps the caller's error vocabulary: every invalid
 * document must fail closed with the caller's own `SyncConflictResolutionError`
 * code rather than a generic error.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deterministic JSON with sorted object keys; `invalid` runs when JSON.stringify yields nothing. */
export function stableJson(value: unknown, invalid: () => never): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, invalid)).join(',')}]`;
  if (isRecord(value)) return `{${Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0).map(([key, item]) =>
    `${JSON.stringify(key)}:${stableJson(item, invalid)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) invalid();
  return encoded as string;
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
