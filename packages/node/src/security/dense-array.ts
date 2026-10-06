import { types as nodeTypes } from 'node:util';

/**
 * Configurable exact dense-array inspection for untrusted security inputs.
 *
 * Domain modules map {@link ExactDenseArrayInspectionFailure} to local
 * TypeError text and freeze as needed. This helper never throws.
 */

export type ExactDenseArrayInspectionOptions = {
  /** Inclusive minimum length. Default 0. */
  readonly minLength?: number;
  /**
   * Inclusive maximum length. Default 4_294_967_294 (same exclusive upper bound
   * as existing `< 4_294_967_295`).
   */
  readonly maxLength?: number;
  /**
   * When false (default), reject own keys other than `length` and dense indexes
   * 0..length-1. When true, extra own keys are ignored for density (indexes
   * still must cover 0..length-1 with data properties).
   */
  readonly allowExtraOwnKeys?: boolean;
  /**
   * When true (default), require prototype Array.prototype or null.
   * When false, skip custom-prototype rejection.
   */
  readonly requireStandardPrototype?: boolean;
};

export type ExactDenseArrayInspectionFailure =
  | 'not-array'
  | 'proxy'
  | 'custom-prototype'
  | 'invalid-length'
  | 'not-dense'
  | 'extra-keys'
  | 'non-data-entry';

export type ExactDenseArrayInspectionResult =
  | { readonly ok: true; readonly values: readonly unknown[] }
  | { readonly ok: false; readonly failure: ExactDenseArrayInspectionFailure };

/** Hard exclusive upper bound on array index space (2^32 − 1). */
const INDEX_SPACE_EXCLUSIVE_UPPER = 4_294_967_295;
/** Default inclusive maxLength when options omit it. */
const DEFAULT_MAX_LENGTH = 4_294_967_294;

/**
 * Configurable exact dense-array inspector (no domain error messages, no freeze).
 * Callers map failures to TypeError text and freeze as needed.
 */
export function inspectExactDenseArray(
  value: unknown,
  options?: ExactDenseArrayInspectionOptions,
): ExactDenseArrayInspectionResult {
  const minLength = options?.minLength ?? 0;
  const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH;
  const allowExtraOwnKeys = options?.allowExtraOwnKeys === true;
  const requireStandardPrototype = options?.requireStandardPrototype !== false;

  if (!Array.isArray(value)) {
    return { ok: false, failure: 'not-array' };
  }
  if (nodeTypes.isProxy(value)) {
    return { ok: false, failure: 'proxy' };
  }
  if (requireStandardPrototype) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype && prototype !== null) {
      return { ok: false, failure: 'custom-prototype' };
    }
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    (lengthDescriptor.value as number) < minLength ||
    (lengthDescriptor.value as number) > maxLength ||
    (lengthDescriptor.value as number) >= INDEX_SPACE_EXCLUSIVE_UPPER
  ) {
    return { ok: false, failure: 'invalid-length' };
  }
  const length = lengthDescriptor.value as number;

  const ownKeys = Reflect.ownKeys(value);
  const indexes = ownKeys.filter(
    (key): key is string =>
      typeof key === 'string' &&
      /^(?:0|[1-9]\d*)$/u.test(key) &&
      Number(key) < INDEX_SPACE_EXCLUSIVE_UPPER,
  );
  if (indexes.length !== length) {
    return { ok: false, failure: 'not-dense' };
  }

  if (!allowExtraOwnKeys) {
    const indexSet = new Set(indexes);
    for (const key of ownKeys) {
      if (key !== 'length' && (typeof key !== 'string' || !indexSet.has(key))) {
        return { ok: false, failure: 'extra-keys' };
      }
    }
  }

  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      return { ok: false, failure: 'non-data-entry' };
    }
    values.push(descriptor.value);
  }
  return { ok: true, values };
}
