/**
 * Internal Sync assertion helpers shared across coordinator modules.
 * Not part of the public package surface — import only from `packages/node/src/sync/**`.
 */

/** Reject non-thenable adapter returns before awaiting them. */
export function requirePromise<Value>(candidate: Promise<Value>, label: string): Promise<Value> {
  if (
    typeof candidate !== 'object'
    || candidate === null
    || typeof (candidate as { readonly then?: unknown }).then !== 'function'
  ) {
    throw new TypeError(`${label} must return a Promise.`);
  }
  return candidate;
}

/**
 * Assert a plain data object whose own keys are a subset of `allowedKeys`.
 * Members must be enumerable data properties (no accessors / symbols).
 */
export function assertPlainDataObject(
  candidate: object,
  allowedKeys: ReadonlySet<string>,
  label: string,
): void {
  if (Array.isArray(candidate)) throw new TypeError(`${label} must be a plain object.`);
  const prototype = Object.getPrototypeOf(candidate) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must have a plain or null prototype.`);
  }
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new TypeError(`${label} contains an unknown member.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} members must be enumerable data properties.`);
    }
  }
}

/** Assert a non-empty (after trim) string. */
export function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

/** Return a non-empty (after trim) string or throw. */
export function nonEmptyString(value: unknown, label: string): string {
  assertNonEmpty(value, label);
  return value;
}
