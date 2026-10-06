import { isProxy } from 'node:util/types';

/**
 * Shared deep-freeze / plain-JSON clone for protocol boundaries.
 *
 * Number policy (I-JSON / IEEE-safe magnitude):
 * - reject non-finite numbers (`NaN`, +/-`Infinity`)
 * - reject values whose absolute magnitude exceeds `Number.MAX_SAFE_INTEGER`
 *   (covers unsafe integers such as `MAX_SAFE_INTEGER + 1` and extreme floats)
 * - allow finite decimals within that magnitude (e.g. `1.5` in domain payloads)
 *
 * Protocol control fields still use explicit `Number.isSafeInteger` checks for
 * sequence numbers and string RFC3339 timestamps for times. This helper is the
 * shared deep-clone path so protocol boundaries do not drift.
 */

export const DEFAULT_IMMUTABLE_JSON_MAX_DEPTH = 64;
export const DEFAULT_IMMUTABLE_JSON_MAX_MEMBERS = 10_000;

export interface ImmutableJsonLimits {
  readonly maxDepth?: number;
  readonly maxMembers?: number;
}

export type DeepReadonly<Value> =
  Value extends (...args: never[]) => unknown
    ? Value
    : Value extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : Value extends object
        ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
        : Value;

interface SnapshotState {
  readonly label: string;
  readonly seen: Set<object>;
  readonly maxDepth: number;
  readonly maxMembers: number;
  members: number;
}

/** Whether a JS number is acceptable in protocol JSON clones. */
export function isJsonSafeNumber(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

/**
 * Deep-clones plain JSON data into a frozen, cycle-free structure.
 *
 * Accessors and Proxies are rejected before a member value is read. Arrays
 * must be dense and may not carry any own property other than their canonical
 * indices and `length`. Objects must use `Object.prototype` or `null` and only
 * enumerable own data properties with string keys.
 */
export function immutableJsonData<Value>(
  value: Value,
  label: string,
  seen = new Set<object>(),
): Value {
  return snapshotJsonValue(value, {
    label,
    seen,
    maxDepth: DEFAULT_IMMUTABLE_JSON_MAX_DEPTH,
    maxMembers: DEFAULT_IMMUTABLE_JSON_MAX_MEMBERS,
    members: 0,
  }, 0) as Value;
}

/** Deep-readonly variant for public trust boundaries with explicit budgets. */
export function immutableJsonSnapshot<Value>(
  value: Value,
  label: string,
  limits: ImmutableJsonLimits = {},
): DeepReadonly<Value> {
  const maxDepth = limits.maxDepth ?? DEFAULT_IMMUTABLE_JSON_MAX_DEPTH;
  const maxMembers = limits.maxMembers ?? DEFAULT_IMMUTABLE_JSON_MAX_MEMBERS;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError(`${label} maxDepth must be a non-negative safe integer.`);
  }
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 0) {
    throw new TypeError(`${label} maxMembers must be a non-negative safe integer.`);
  }
  return snapshotJsonValue(value, {
    label,
    seen: new Set<object>(),
    maxDepth,
    maxMembers,
    members: 0,
  }, 0) as DeepReadonly<Value>;
}

function snapshotJsonValue(value: unknown, state: SnapshotState, depth: number): unknown {
  if (depth > state.maxDepth) {
    throw new TypeError(`${state.label} exceeds the maximum JSON depth.`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!isJsonSafeNumber(value)) {
      throw new TypeError(`${state.label} contains a number that is not a JSON-safe number.`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${state.label} must contain only plain JSON data.`);
  }

  // Node's internal Proxy test does not invoke user traps. It must precede all
  // Reflect/Object inspection because those operations can invoke Proxy traps.
  if (isProxy(value)) {
    throw new TypeError(`${state.label} must not contain Proxy objects.`);
  }
  if (state.seen.has(value)) {
    throw new TypeError(`${state.label} must not contain cycles.`);
  }

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return snapshotArray(value, state, depth);
    }
    return snapshotObject(value, state, depth);
  } finally {
    state.seen.delete(value);
  }
}

function snapshotArray(value: unknown[], state: SnapshotState, depth: number): readonly unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${state.label} must contain only ordinary arrays.`);
  }

  const keys = Reflect.ownKeys(value);
  reserveMembers(state, keys.length);
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new TypeError(`${state.label} must not contain symbol keys.`);
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    throw new TypeError(`${state.label} contains an invalid array length.`);
  }
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1 || length > state.maxMembers) {
    throw new TypeError(`${state.label} arrays must be dense and have no extra properties.`);
  }

  const clone = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${state.label} arrays must contain only dense data properties.`);
    }
    Object.defineProperty(clone, key, {
      value: snapshotJsonValue(descriptor.value, state, depth + 1),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(clone);
}

function snapshotObject(
  value: object,
  state: SnapshotState,
  depth: number,
): Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${state.label} must contain only plain objects.`);
  }

  const keys = Reflect.ownKeys(value);
  reserveMembers(state, keys.length);
  const clone = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new TypeError(`${state.label} must not contain symbol keys.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${state.label} members must be enumerable data properties.`);
    }
    Object.defineProperty(clone, key, {
      value: snapshotJsonValue(descriptor.value, state, depth + 1),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(clone);
}

function reserveMembers(state: SnapshotState, count: number): void {
  if (count > state.maxMembers - state.members) {
    throw new TypeError(`${state.label} exceeds the maximum JSON member count.`);
  }
  state.members += count;
}
