/**
 * Deterministic Base / Current / Incoming three-way merge for typed Sync updates
 * (SYNC-0017 / protocol §6.3), including Tag Observed-Remove (OR-set) semantics.
 *
 * Apply model:
 * - Inputs `base` and `incoming` define the user-writable field domain (same key set
 *   as the typed update base/value payload after SYNC-0016 key-set validation).
 * - `current` is the server resource projection; keys only on current (server-managed
 *   evolution) stay out of the merge result — the host applies the returned patch
 *   onto current.
 * - Deep equality uses recursive JSON-like comparison: arrays are order-sensitive;
 *   plain objects compare own enumerable string keys without relying on key order.
 * - The `tags` key is never wholesale-array-replaced; it uses Observed-Remove.
 * - Concurrent `lastUsedAt` values take the newer valid RFC 3339 instant
 *   (protocol §10.2); unparseable values fail closed to conflict.
 */

import { types as nodeTypes } from 'node:util';
import { isRfc3339DateTime } from '../shared/date-time.js';
import { immutableJsonData } from '../shared/immutable-json.js';
import { hasDenseArrayOwnKeys } from '../shared/dense-array-keys.js';

export type SyncTypedMergeFieldResult =
  | { readonly outcome: 'merged'; readonly value: unknown }
  | { readonly outcome: 'conflict'; readonly field: string; readonly reason: string };

export type SyncTypedMergeConflict = {
  readonly field: string;
  readonly reason: string;
};

export type SyncTypedMergeResult =
  | {
      readonly status: 'merged';
      /** Frozen plain object whose keys match the base/incoming domain. */
      readonly value: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: 'conflict';
      readonly conflicts: readonly SyncTypedMergeConflict[];
    };

export type SyncTypedMergeInput = {
  readonly base: Readonly<Record<string, unknown>>;
  readonly current: Readonly<Record<string, unknown>>;
  readonly incoming: Readonly<Record<string, unknown>>;
};

export type SyncTagsMergeResult =
  | { readonly status: 'merged'; readonly tags: readonly string[] }
  | { readonly status: 'conflict'; readonly reason: string };

const MAX_SYNC_MERGE_DEPTH = 64;
const MAX_SYNC_MERGE_NODES = 10_000;
const MAX_SYNC_MERGE_MEMBERS = 100_000;
const MAX_SYNC_MERGE_BYTES = 16 * 1024 * 1024;

/** Count UTF-8 bytes without allocating a copy of an untrusted string. */
function utf8Bytes(value: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const width = code <= 0x7f
      ? 1
      : code <= 0x7ff
        ? 2
        : code >= 0xd800 && code <= 0xdbff
          && index + 1 < value.length
          && value.charCodeAt(index + 1) >= 0xdc00
          && value.charCodeAt(index + 1) <= 0xdfff
          ? (index += 1, 4)
          : 3;
    bytes += width;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

/**
 * Deep equality for merge decisions.
 * - Primitives / null: Object.is
 * - Arrays: same length, element-wise recursive equality (order-sensitive)
 * - Plain objects: same own enumerable string key set (order-insensitive), recursive values
 * - Non-plain objects / mismatched types: unequal (fail closed toward conflict)
 */
export function deepEqualSyncMergeValue(left: unknown, right: unknown): boolean {
  try {
    for (const value of [left, right]) {
      if (value !== null && typeof value === 'object') assertBoundedMergeGraph(value, 'equality input');
      else if (typeof value === 'string') addMergeBytes(0, value);
    }
  } catch {
    return false;
  }
  const pairs = new WeakMap<object, WeakSet<object>>();
  let visited = 0;
  const equal = (a: unknown, b: unknown, depth: number): boolean => {
    if (Object.is(a, b)) return true;
    if (depth > MAX_SYNC_MERGE_DEPTH || typeof a !== typeof b) return false;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (nodeTypes.isProxy(a) || nodeTypes.isProxy(b)) return false;
    const seen = pairs.get(a) ?? new WeakSet<object>();
    if (seen.has(b)) return true;
    seen.add(b);
    pairs.set(a, seen);
    visited += 1;
    if (visited > MAX_SYNC_MERGE_NODES) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)
        || !isPlainMergeArray(a) || !isPlainMergeArray(b)
        || a.length !== b.length || a.length > MAX_SYNC_MERGE_MEMBERS) return false;
      for (let index = 0; index < a.length; index += 1) {
        if (!equal(a[index], b[index], depth + 1)) return false;
      }
      return true;
    }
    if (!isPlainDataObject(a) || !isPlainDataObject(b)) return false;
    if (!hasOnlyEnumerableDataProperties(a) || !hasOnlyEnumerableDataProperties(b)) return false;
    const leftKeys = ownEnumerableStringKeys(a);
    const rightKeys = ownEnumerableStringKeys(b);
    if (leftKeys.length !== rightKeys.length || leftKeys.length > MAX_SYNC_MERGE_MEMBERS) return false;
    const rightSet = new Set(rightKeys);
    for (const key of leftKeys) {
      if (!rightSet.has(key) || !equal(ownDataValue(a, key), ownDataValue(b, key), depth + 1)) return false;
    }
    return true;
  };
  return equal(left, right, 0);
}

/**
 * Tag Observed-Remove (OR-set):
 * - deleted = set(baseTags) − set(incomingTags)  — only Base-observed members may be removed
 * - added   = set(incomingTags) − set(baseTags)
 * - result  = (set(currentTags) − deleted) ∪ added
 *
 * Concurrent adds present in Current but not in Base are retained (not in deleted).
 * Missing sides are treated as empty tag lists when undefined.
 * Non-string-array values when present → conflict (no silent array overwrite).
 */
export function mergeSyncTagsObservedRemove(input: {
  readonly baseTags: unknown;
  readonly currentTags: unknown;
  readonly incomingTags: unknown;
}): SyncTagsMergeResult {
  const baseCheck = normalizeTagsField(input.baseTags, 'base');
  if (baseCheck.status === 'conflict') return baseCheck;
  const currentCheck = normalizeTagsField(input.currentTags, 'current');
  if (currentCheck.status === 'conflict') return currentCheck;
  const incomingCheck = normalizeTagsField(input.incomingTags, 'incoming');
  if (incomingCheck.status === 'conflict') return incomingCheck;

  const baseSet = new Set(baseCheck.tags);
  const incomingSet = new Set(incomingCheck.tags);
  const deleted = new Set<string>();
  for (const tag of baseSet) {
    if (!incomingSet.has(tag)) deleted.add(tag);
  }
  const added: string[] = [];
  const addedSeen = new Set<string>();
  for (const tag of incomingCheck.tags) {
    if (!baseSet.has(tag) && !addedSeen.has(tag)) {
      addedSeen.add(tag);
      added.push(tag);
    }
  }

  // Deterministic materialization: set membership via OR-set, then lexicographic order.
  const resultSet = new Set<string>();
  for (const tag of currentCheck.tags) {
    if (!deleted.has(tag)) resultSet.add(tag);
  }
  for (const tag of added) {
    resultSet.add(tag);
  }
  const result = [...resultSet].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return Object.freeze({
    status: 'merged' as const,
    tags: Object.freeze(result) as readonly string[],
  });
}

/**
 * Deterministic three-way merge for one typed-update field domain.
 *
 * Rules per field key `k` (except `tags`):
 * 1. incoming deep-equals base → keep current (client did not change)
 * 2. current deep-equals base → take incoming (server unchanged)
 * 3. incoming deep-equals current → agree
 * 4. else → field conflict
 *
 * `tags` uses {@link mergeSyncTagsObservedRemove} instead of wholesale array replace.
 */
export function mergeSyncTypedUpdate({
  base,
  current,
  incoming,
}: {
  readonly base: Readonly<Record<string, unknown>>;
  readonly current: Readonly<Record<string, unknown>>;
  readonly incoming: Readonly<Record<string, unknown>>;
}): SyncTypedMergeResult {
  assertPlainMergeObject(base, 'base');
  assertPlainMergeObject(current, 'current');
  assertPlainMergeObject(incoming, 'incoming');

  const baseKeys = ownEnumerableStringKeys(base);
  const incomingKeys = ownEnumerableStringKeys(incoming);
  if (!sameKeyList(baseKeys, incomingKeys)) {
    throw new TypeError(
      'Typed update merge requires base and incoming to share the same own enumerable string keys.',
    );
  }

  // Domain = base/incoming keys only; current supersets (server-managed) are not emitted.
  const domainKeys = baseKeys.slice().sort();
  const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const conflicts: SyncTypedMergeConflict[] = [];
  const freezeValue = createMergeValueFreezer();

  for (const key of domainKeys) {
    const baseValue = ownDataValue(base, key);
    const incomingValue = ownDataValue(incoming, key);
    const currentValue = hasOwnDataKey(current, key)
      ? ownDataValue(current, key)
      : undefined;

    if (key === 'tags') {
      const tagResult = mergeSyncTagsObservedRemove({
        baseTags: baseValue,
        currentTags: currentValue,
        incomingTags: incomingValue,
      });
      if (tagResult.status === 'conflict') {
        conflicts.push(Object.freeze({ field: 'tags', reason: tagResult.reason }));
        continue;
      }
      merged[key] = Object.freeze(tagResult.tags.slice()) as readonly string[];
      continue;
    }

    const field = mergeScalarField(key, baseValue, currentValue, incomingValue);
    if (field.outcome === 'conflict') {
      conflicts.push(Object.freeze({ field: field.field, reason: field.reason }));
      continue;
    }
    merged[key] = freezeValue(field.value);
  }

  if (conflicts.length > 0) {
    return Object.freeze({
      status: 'conflict' as const,
      conflicts: Object.freeze(conflicts.slice()) as readonly SyncTypedMergeConflict[],
    });
  }

  return Object.freeze({
    status: 'merged' as const,
    value: Object.freeze(merged) as Readonly<Record<string, unknown>>,
  });
}

/**
 * Applies a merge result's domain patch to a JSON projection. An undefined
 * field means absence; null remains an explicit value. Fields outside the
 * patch are preserved. Hosts and atomic preflight use the same semantics.
 */
export function applySyncTypedUpdatePatch(
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  assertPlainMergeObject(current, 'current');
  assertPlainMergeObject(patch, 'patch');
  const projection = Object.assign(Object.create(null) as Record<string, unknown>, current);
  for (const key of ownEnumerableStringKeys(patch)) {
    const value = ownDataValue(patch, key);
    if (value === undefined) delete projection[key];
    else projection[key] = value;
  }
  return immutableJsonData(projection, 'Typed update applied projection');
}

function mergeScalarField(
  field: string,
  baseValue: unknown,
  currentValue: unknown,
  incomingValue: unknown,
): SyncTypedMergeFieldResult {
  if (field === 'lastUsedAt') {
    if (currentValue == null && incomingValue == null) return { outcome: 'merged', value: incomingValue };
    const newer = takeNewerRfc3339(currentValue, incomingValue);
    return newer === undefined
      ? { outcome: 'conflict', field, reason: 'lastUsedAt requires valid comparable RFC 3339 instants.' }
      : { outcome: 'merged', value: newer };
  }
  // 1. Client did not change relative to base → keep server current.
  if (deepEqualSyncMergeValue(incomingValue, baseValue)) {
    return { outcome: 'merged', value: currentValue };
  }
  // 2. Server unchanged relative to base → take client incoming.
  if (deepEqualSyncMergeValue(currentValue, baseValue)) {
    return { outcome: 'merged', value: incomingValue };
  }
  // 3. Both sides agree on the new value.
  if (deepEqualSyncMergeValue(incomingValue, currentValue)) {
    return { outcome: 'merged', value: incomingValue };
  }
  // 4. Concurrent divergent edits.
  return {
    outcome: 'conflict',
    field,
    reason: `Concurrent divergent edits on field "${field}" (base, current, and incoming disagree).`,
  };
}

function takeNewerRfc3339(currentValue: unknown, incomingValue: unknown): string | undefined {
  const current = comparableInstant(currentValue);
  const incoming = comparableInstant(incomingValue);
  if (currentValue == null) return incoming === undefined ? undefined : incomingValue as string;
  if (incomingValue == null) return current === undefined ? undefined : currentValue as string;
  if (current === undefined || incoming === undefined) return undefined;
  const width = Math.max(current.fraction.length, incoming.fraction.length);
  const order = incoming.second - current.second || incoming.leap - current.leap;
  const incomingWins = order > 0 || (order === 0
    && incoming.fraction.padEnd(width, '0') >= current.fraction.padEnd(width, '0'));
  return (incomingWins ? incomingValue : currentValue) as string;
}

function comparableInstant(value: unknown): { second: number; leap: number; fraction: string } | undefined {
  if (typeof value !== 'string' || !isRfc3339DateTime(value) || value.endsWith('-00:00')) return undefined;
  const parts = /^(.{17})([0-9]{2})(?:[.]([0-9]+))?([Zz]|[+-][0-9]{2}:[0-9]{2})$/u.exec(value)!;
  const leap = parts[2] === '60' ? 1 : 0;
  // Compare the preceding whole second, leap position, and exact decimal fraction.
  // Date.parse only normalizes the zone; it never receives fractional seconds.
  const second = Date.parse(parts[1]! + (leap ? '59' : parts[2]!) + parts[4]!);
  return Number.isFinite(second) ? { second, leap, fraction: parts[3] ?? '' } : undefined;
}

function normalizeTagsField(
  value: unknown,
  side: string,
): { status: 'merged'; tags: readonly string[] } | { status: 'conflict'; reason: string } {
  if (value === undefined) {
    return { status: 'merged', tags: Object.freeze([]) as readonly string[] };
  }
  const conflict = () => ({
      status: 'conflict',
      reason: `Tag Observed-Remove requires ${side} tags to be an array of strings when present; observation cannot be proven for non-string-array values.`,
    } as const);
  if (nodeTypes.isProxy(value) || !Array.isArray(value)) return conflict();
  try {
    assertBoundedMergeGraph(value, `${side} tags`);
  } catch {
    return conflict();
  }
  const tags: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'string') return conflict();
    tags.push(value[index]);
  }
  return { status: 'merged', tags: Object.freeze(tags) };
}

function isPlainDataObject(candidate: object): boolean {
  if (Array.isArray(candidate)) return false;
  const prototype = Object.getPrototypeOf(candidate);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainMergeObject(
  candidate: unknown,
  label: string,
): asserts candidate is Readonly<Record<string, unknown>> {
  if (nodeTypes.isProxy(candidate)) throw new TypeError(`Typed update merge ${label} cannot contain a Proxy.`);
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new TypeError(`Typed update merge ${label} must be a plain object.`);
  }
  if (!isPlainDataObject(candidate)) {
    throw new TypeError(`Typed update merge ${label} must have a plain or null prototype.`);
  }
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== 'string') {
      throw new TypeError(`Typed update merge ${label} must not have symbol keys.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(
        `Typed update merge ${label} members must be own enumerable data properties.`,
      );
    }
  }
  assertBoundedMergeGraph(candidate, label);
}

function assertBoundedMergeGraph(root: object, label: string): void {
  const seen = new WeakSet<object>();
  const active = new WeakSet<object>();
  const pending: Array<{ value: object; depth: number; exit?: boolean }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  let members = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    const { value, depth } = item;
    if (item.exit === true) {
      active.delete(value);
      continue;
    }
    if (active.has(value)) throw new RangeError(`Typed update merge ${label} cannot contain cycles.`);
    if (seen.has(value)) continue;
    if (depth > MAX_SYNC_MERGE_DEPTH || nodeTypes.isProxy(value)) {
      throw new RangeError(`Typed update merge ${label} exceeds its graph depth budget.`);
    }
    seen.add(value);
    active.add(value);
    pending.push({ value, depth, exit: true });
    nodes += 1;
    if (nodes > MAX_SYNC_MERGE_NODES) throw new RangeError(`Typed update merge ${label} is too large.`);
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array) {
      if (prototype !== Array.prototype && prototype !== null) throw new TypeError(`Typed update merge ${label} arrays must be plain.`);
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length > MAX_SYNC_MERGE_MEMBERS) {
        throw new RangeError(`Typed update merge ${label} array is too large.`);
      }
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Typed update merge ${label} must contain only plain objects.`);
    }
    const keys = Reflect.ownKeys(value);
    if (array && !hasDenseArrayOwnKeys(keys, (value as unknown[]).length)) {
      throw new TypeError(`Typed update merge ${label} arrays must be dense and contain no extra properties.`);
    }
    members += array ? Math.max(0, keys.length - 1) : keys.length;
    if (members > MAX_SYNC_MERGE_MEMBERS) throw new RangeError(`Typed update merge ${label} has too many members.`);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new TypeError(`Typed update merge ${label} must not contain symbol keys.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`Typed update merge ${label} contains an accessor.`);
      }
      bytes = addMergeBytes(bytes, key);
      const child = descriptor.value;
      if (typeof child === 'string') bytes = addMergeBytes(bytes, child);
      if (child !== null && typeof child === 'object') pending.push({ value: child, depth: depth + 1 });
    }
  }
}

function addMergeBytes(total: number, value: string): number {
  const remaining = MAX_SYNC_MERGE_BYTES - total;
  const size = utf8Bytes(value, remaining);
  if (size > remaining) throw new RangeError('Typed update merge value exceeds its byte budget.');
  return total + size;
}

function isPlainMergeArray(value: unknown[]): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (!hasDenseArrayOwnKeys(keys, value.length)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return false;
  }
  return true;
}

function hasOnlyEnumerableDataProperties(value: object): boolean {
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor;
  });
}

function ownEnumerableStringKeys(object: object): string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      continue;
    }
    keys.push(key);
  }
  return keys;
}

function hasOwnDataKey(object: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return (
    descriptor !== undefined
    && descriptor.enumerable === true
    && Object.prototype.hasOwnProperty.call(descriptor, 'value')
  );
}

function ownDataValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    return undefined;
  }
  return descriptor.value;
}

function sameKeyList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  for (const key of left) {
    if (!rightSet.has(key)) return false;
  }
  return true;
}

function createMergeValueFreezer(): (value: unknown) => unknown {
  const active = new WeakSet<object>();
  const clones = new WeakMap<object, unknown>();
  let nodes = 0;
  const freeze = (candidate: unknown, depth: number): unknown => {
    if (candidate === null || typeof candidate !== 'object') return candidate;
    if (nodeTypes.isProxy(candidate) || depth > MAX_SYNC_MERGE_DEPTH || active.has(candidate)) {
      throw new RangeError('Typed update merge value exceeds its graph budget.');
    }
    if (clones.has(candidate)) return clones.get(candidate);
    nodes += 1;
    if (nodes > MAX_SYNC_MERGE_NODES) throw new RangeError('Typed update merge value exceeds its node budget.');
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (candidate.length > MAX_SYNC_MERGE_MEMBERS) throw new RangeError('Typed update merge array is too large.');
        const clone: unknown[] = [];
        for (let index = 0; index < candidate.length; index += 1) clone.push(freeze(candidate[index], depth + 1));
        const frozen = Object.freeze(clone);
        clones.set(candidate, frozen);
        return frozen;
      }
      if (!isPlainDataObject(candidate)) return candidate;
      const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of ownEnumerableStringKeys(candidate)) clone[key] = freeze(ownDataValue(candidate, key), depth + 1);
      const frozen = Object.freeze(clone);
      clones.set(candidate, frozen);
      return frozen;
    } finally {
      active.delete(candidate);
    }
  };
  return (value) => freeze(value, 0);
}
