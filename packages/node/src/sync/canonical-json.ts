import { TextByteBudget } from '../shared/text-budget.js';

/**
 * Browser-safe I-JSON snapshot + RFC 8785 canonical JSON.
 *
 * No Node builtins. Rejects undefined, non-finite / unsafe-integer numbers,
 * cycles, accessors, symbol keys, non-plain prototypes, and sparse arrays.
 * Does not invoke toJSON. Unicode is hashed as UTF-8 of the canonical JSON
 * (no NFC/NFD normalization).
 */

import canonicalize from 'canonicalize';

export const CANONICAL_JSON_MAX_DEPTH = 32;
export const CANONICAL_JSON_MAX_MEMBERS = 10_000;
export const CANONICAL_JSON_MAX_BYTES = 8 * 1024 * 1024;

export interface CanonicalJsonLimits {
  readonly maxDepth?: number;
  readonly maxMembers?: number;
  readonly maxBytes?: number;
}

interface SnapshotState {
  readonly label: string;
  readonly seen: Set<object>;
  readonly maxDepth: number;
  readonly maxMembers: number;
  members: number;
  readonly bytes: TextByteBudget;
}

export function isCanonicalJsonSafeNumber(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

export function canonicalJsonSnapshot(
  value: unknown,
  label: string,
  limits: CanonicalJsonLimits = {},
): unknown {
  const maxDepth = limits.maxDepth ?? CANONICAL_JSON_MAX_DEPTH;
  const maxMembers = limits.maxMembers ?? CANONICAL_JSON_MAX_MEMBERS;
  const maxBytes = limits.maxBytes ?? CANONICAL_JSON_MAX_BYTES;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0
    || !Number.isSafeInteger(maxMembers) || maxMembers < 1
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(`${label} limits are invalid.`);
  }
  return snapshotJsonValue(value, {
    label,
    seen: new Set<object>(),
    maxDepth,
    maxMembers,
    members: 0,
    bytes: new TextByteBudget(maxBytes, label),
  }, 0);
}

export function encodeCanonicalJson(value: unknown, label: string): string {
  const snapshot = canonicalJsonSnapshot(value, label);
  const encoded = canonicalize(snapshot);
  if (encoded === undefined) {
    throw new TypeError(`${label} must contain only canonical I-JSON values.`);
  }
  return encoded;
}

function snapshotJsonValue(value: unknown, state: SnapshotState, depth: number): unknown {
  if (depth > state.maxDepth) {
    throw new TypeError(`${state.label} exceeds the maximum JSON depth.`);
  }
  if (value === null || typeof value === 'boolean') {
    state.bytes.charge(value === null || value === true ? 4 : 5);
    return value;
  }
  if (typeof value === 'string') {
    state.bytes.jsonString(value);
    return value;
  }
  if (typeof value === 'number') {
    if (!isCanonicalJsonSafeNumber(value)) {
      throw new TypeError(`${state.label} contains a number that is not a JSON-safe number.`);
    }
    state.bytes.charge(JSON.stringify(value).length);
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${state.label} must contain only plain JSON data.`);
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
  // `Reflect.ownKeys` includes the array's non-enumerable `length` slot; it
  // is metadata, not a JSON member.  Counting it made an exactly 10,000-item
  // authoritative effect exceed the advertised 10,000-member bound.
  reserveMembers(state, length);
  state.bytes.charge(2 + Math.max(0, length - 1));
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
  state.bytes.charge(2 + Math.max(0, keys.length - 1));
  const clone = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new TypeError(`${state.label} must not contain symbol keys.`);
    }
    state.bytes.jsonString(key);
    state.bytes.charge(1); // Object-member colon.
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
