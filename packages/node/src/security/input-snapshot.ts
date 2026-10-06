import { types as nodeTypes } from 'node:util';

import { inspectExactDenseArray } from './dense-array.js';

/**
 * Fail-closed snapshot helpers for untrusted security inputs.
 *
 * Design rules (shared by SEC guards):
 * - Check {@link nodeTypes.isProxy} before any operation that could run traps.
 * - Accept only plain records: object, not null, not array, prototype
 *   `Object.prototype` or `null`.
 * - Read only own data properties; accessors throw (never invoke getters).
 * - Dense arrays: standard/null prototype, data `length`, contiguous index
 *   data properties, no extra own keys.
 *
 * These helpers are **internal** snapshot primitives. Specialized modules may
 * keep local wrappers for named error messages or looser array rules.
 * Configurable dense-array inspection lives in {@link ./dense-array.js}.
 */

export {
  inspectExactDenseArray,
  type ExactDenseArrayInspectionFailure,
  type ExactDenseArrayInspectionOptions,
  type ExactDenseArrayInspectionResult,
} from './dense-array.js';

/** Plain own-data record accepted by security snapshot helpers. */
export type PlainRecord = Readonly<Record<PropertyKey, unknown>>;

/** Result of reading one own data property without invoking accessors. */
export type OwnDataProperty = {
  readonly found: boolean;
  readonly value?: unknown;
};

/**
 * True only for plain records: not a Proxy (checked first so traps never run),
 * not an array, and prototype is exactly `Object.prototype` or `null`.
 */
export function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) {
    return false;
  }
  return hasSafeRecordPrototype(value);
}

/**
 * True when `value` is not a Proxy and its prototype is exactly
 * `Object.prototype` or `null`. Callers that already know `value` is an object
 * can use this without re-testing `typeof` / array-ness.
 */
export function hasSafeRecordPrototype(value: object): boolean {
  if (nodeTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Assert that `value` is a plain record. Throws `TypeError` otherwise.
 *
 * @param name - Label used in error messages (default: `security input`).
 */
export function assertPlainRecord(value: unknown, name = 'security input'): asserts value is PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  if (!hasSafeRecordPrototype(value)) {
    throw new TypeError(`${name} must have a plain prototype`);
  }
}

/**
 * Read an own data property without invoking accessors.
 *
 * - Non-plain records → `{ found: false }` (fail closed, no throw).
 * - Missing key → `{ found: false }`.
 * - Accessor / non-data descriptor → throws `TypeError`.
 */
export function readOwnDataProperty(value: unknown, key: PropertyKey): OwnDataProperty {
  if (!isPlainRecord(value)) {
    return { found: false };
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return { found: false };
  }
  if (!('value' in descriptor)) {
    throw new TypeError(`Accessor properties are not valid security input: ${String(key)}`);
  }
  return { found: true, value: descriptor.value };
}

/**
 * Require an own data property; throw if missing, non-plain, or an accessor.
 *
 * @param name - Label for the required field (used in error messages).
 */
export function requireOwnDataProperty(value: unknown, key: PropertyKey, name: string): unknown {
  const field = readOwnDataProperty(value, key);
  if (!field.found) {
    throw new TypeError(`${name} is required`);
  }
  return field.value;
}

/**
 * Reject own keys that are not strings in `allowedKeys` (symbols and unknown
 * string keys fail closed). Does **not** require every allowed key to be present.
 *
 * @param name - Label used in the unknown-fields error message.
 */
export function exactOwnStringKeys(
  value: PlainRecord,
  allowedKeys: readonly string[],
  name = 'security input',
): void {
  const expected = new Set<string>(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new TypeError(`${name} has unknown fields`);
    }
  }
}

/**
 * Snapshot a dense array of own data index properties.
 *
 * Rejects Proxy arrays, custom prototypes (only `Array.prototype` or `null`),
 * non-data / non-safe-integer `length`, sparse holes, non-data index entries,
 * and extra own keys beyond `length` and contiguous indexes.
 *
 * @param name - Optional label for error messages.
 * @returns A frozen copy of the index values.
 */
export function snapshotDenseArray(value: unknown, name = 'array'): readonly unknown[] {
  const result = inspectExactDenseArray(value);
  if (!result.ok) {
    switch (result.failure) {
      case 'not-array':
      case 'proxy':
        throw new TypeError(`${name} must be a plain dense array`);
      case 'custom-prototype':
        throw new TypeError(`${name} must not inherit from a custom prototype`);
      case 'invalid-length':
        throw new TypeError(`${name} has an invalid length`);
      case 'not-dense':
        throw new TypeError(`${name} must be dense`);
      case 'extra-keys':
        throw new TypeError(`${name} must not contain extra properties`);
      case 'non-data-entry':
        throw new TypeError(`${name} entries must be own data properties`);
    }
  }
  return Object.freeze(result.values);
}
