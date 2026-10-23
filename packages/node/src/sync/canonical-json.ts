import { TextByteBudget } from '../shared/text-budget.js';
import { readJsonSnapshotProof, recordJsonSnapshotProof } from '../shared/json-snapshot-proof.js';

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
  observedDepth: number;
  arrays: number;
  readonly bytes: TextByteBudget;
}

const canonicalSnapshotEncodings = new WeakMap<object, string>();

export const canonicalJsonDiagnostics = {
  snapshotWalks: 0,
  snapshotReuses: 0,
  encodes: 0,
  encodeReuses: 0,
  reset(): void {
    this.snapshotWalks = 0;
    this.snapshotReuses = 0;
    this.encodes = 0;
    this.encodeReuses = 0;
  },
};

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
  if (value !== null && typeof value === 'object') {
    const proof = readJsonSnapshotProof(value);
    if (
      proof?.exact
      && proof.observedDepth <= maxDepth
      && proof.observedJsonMembers <= maxMembers
      && proof.observedBytes <= maxBytes
    ) {
      canonicalJsonDiagnostics.snapshotReuses += 1;
      return value;
    }
  }
  canonicalJsonDiagnostics.snapshotWalks += 1;
  const state: SnapshotState = {
    label,
    seen: new Set<object>(),
    maxDepth,
    maxMembers,
    members: 0,
    observedDepth: 0,
    arrays: 0,
    bytes: new TextByteBudget(maxBytes, label),
  };
  return snapshotJsonValue(value, state, 0);
}

export function encodeCanonicalJson(value: unknown, label: string): string {
  return encodeKnownCanonicalSnapshot(canonicalJsonSnapshot(value, label), label);
}

/** Canonicalize a snapshot this module already produced, reusing its encoded bytes. */
export function encodeKnownCanonicalSnapshot(snapshot: unknown, label: string): string {
  if (snapshot !== null && typeof snapshot === 'object' && readJsonSnapshotProof(snapshot)) {
    const cached = canonicalSnapshotEncodings.get(snapshot);
    if (cached !== undefined) {
      canonicalJsonDiagnostics.encodeReuses += 1;
      return cached;
    }
  }
  canonicalJsonDiagnostics.encodes += 1;
  const encoded = canonicalize(snapshot);
  if (encoded === undefined) {
    throw new TypeError(`${label} must contain only canonical I-JSON values.`);
  }
  if (snapshot !== null && typeof snapshot === 'object' && readJsonSnapshotProof(snapshot)) {
    canonicalSnapshotEncodings.set(snapshot, encoded);
  }
  return encoded;
}

/**
 * Canonical form of a proven snapshot after one own key is removed.
 * The omitted object's byte length is not the full value's byte budget.
 */
export function canonicalFormOmitting(snapshot: object, omitKey: string, label: string): string {
  const digestInput: Record<string, unknown> = {};
  for (const key of Object.keys(snapshot)) {
    if (key === omitKey) continue;
    digestInput[key] = (snapshot as Record<string, unknown>)[key];
  }
  const encoded = canonicalize(digestInput);
  if (typeof encoded !== 'string') {
    throw new TypeError(`${label} must contain only canonical I-JSON values.`);
  }
  return encoded;
}

function snapshotJsonValue(value: unknown, state: SnapshotState, depth: number): unknown {
  if (depth > state.maxDepth) {
    throw new TypeError(`${state.label} exceeds the maximum JSON depth.`);
  }
  if (depth > state.observedDepth) state.observedDepth = depth;
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
  const proof = readJsonSnapshotProof(value);
  if (proof?.exact && depth + proof.observedDepth <= state.maxDepth
      && proof.observedJsonMembers <= state.maxMembers - state.members
      && proof.observedBytes <= state.bytes.remaining) {
    reserveMembers(state, proof.observedJsonMembers);
    state.bytes.charge(proof.observedBytes);
    state.arrays += proof.observedMembers - proof.observedJsonMembers;
    state.observedDepth = Math.max(state.observedDepth, depth + proof.observedDepth);
    return value;
  }
  state.seen.add(value);
  const outerDepth = state.observedDepth;
  const membersBefore = state.members, arraysBefore = state.arrays, bytesBefore = state.bytes.bytes;
  state.observedDepth = depth;
  try {
    const snapshot = Array.isArray(value) ? snapshotArray(value, state, depth) : snapshotObject(value, state, depth);
    const members = state.members - membersBefore;
    const ownMembers = members + state.arrays - arraysBefore;
    recordJsonSnapshotProof(snapshot, {
      maxDepth: state.maxDepth - depth, maxMembers: Math.max(state.maxMembers, ownMembers), maxBytes: state.bytes.limit,
      observedDepth: state.observedDepth - depth, observedMembers: ownMembers, observedJsonMembers: members,
      observedBytes: state.bytes.bytes - bytesBefore, exact: true,
    });
    return snapshot;
  } finally {
    state.observedDepth = Math.max(outerDepth, state.observedDepth);
    state.seen.delete(value);
  }
}

function snapshotArray(value: unknown[], state: SnapshotState, depth: number): readonly unknown[] {
  state.arrays++;
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
