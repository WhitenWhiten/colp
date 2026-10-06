/**
 * Documented time-unit brands and runtime asserts for security clocks.
 *
 * Values remain plain `number` at runtime (brands are erased). Do not assume
 * interchangeability between units — credential-restrictions use epoch
 * milliseconds; OAuth NumericDate, DPoP, and mutable-integrity claims use
 * Unix whole seconds.
 *
 * Runtime asserts are wired at the primary validation sites for those modules
 * (`assertEpochMilliseconds` / `assertUnixSeconds`). Ports still accept
 * `number` in public TypeScript surfaces; callers should not convert units.
 */

/**
 * Milliseconds since the Unix epoch (UTC).
 * Used by credential-restriction `notBefore` / `expiresAt` and related clocks.
 */
export type EpochMilliseconds = number & { readonly __brand: 'EpochMilliseconds' };

/**
 * Whole seconds since the Unix epoch (UTC).
 * Used by OAuth NumericDate, DPoP proof times, and mutable-integrity claims.
 */
export type UnixSeconds = number & { readonly __brand: 'UnixSeconds' };

/**
 * JWT / OAuth NumericDate: whole seconds since the Unix epoch.
 * Alias of {@link UnixSeconds}.
 */
export type NumericDateSeconds = UnixSeconds;

/** Narrow a number to {@link EpochMilliseconds} when it is a non-negative safe integer. */
export function assertEpochMilliseconds(
  value: number,
  name = 'value',
): asserts value is EpochMilliseconds {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be non-negative epoch milliseconds`);
  }
}

/** Narrow a number to {@link UnixSeconds} when it is a safe integer. */
export function assertUnixSeconds(value: number, name = 'value'): asserts value is UnixSeconds {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe-integer Unix seconds value`);
  }
}
