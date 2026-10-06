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

import { isRfc3339DateTime } from '../shared/date-time.js';
import { immutableJsonData } from '../shared/immutable-json.js';

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

/**
 * Deep equality for merge decisions.
 * - Primitives / null: Object.is
 * - Arrays: same length, element-wise recursive equality (order-sensitive)
 * - Plain objects: same own enumerable string key set (order-insensitive), recursive values
 * - Non-plain objects / mismatched types: unequal (fail closed toward conflict)
 */
export function deepEqualSyncMergeValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return left === right;
  if (typeof left !== 'object' || typeof right !== 'object') return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqualSyncMergeValue(left[index], right[index])) return false;
    }
    return true;
  }

  if (!isPlainDataObject(left) || !isPlainDataObject(right)) {
    return false;
  }

  const leftKeys = ownEnumerableStringKeys(left);
  const rightKeys = ownEnumerableStringKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  const rightSet = new Set(rightKeys);
  for (const key of leftKeys) {
    if (!rightSet.has(key)) return false;
    if (!deepEqualSyncMergeValue(ownDataValue(left, key), ownDataValue(right, key))) {
      return false;
    }
  }
  return true;
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
    merged[key] = freezeMergeValue(field.value);
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
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return {
      status: 'conflict',
      reason: `Tag Observed-Remove requires ${side} tags to be an array of strings when present; observation cannot be proven for non-string-array values.`,
    };
  }
  return { status: 'merged', tags: value as readonly string[] };
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

function freezeMergeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeMergeValue(item)));
  }
  if (!isPlainDataObject(value)) return value;
  const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownEnumerableStringKeys(value)) {
    clone[key] = freezeMergeValue(ownDataValue(value, key));
  }
  return Object.freeze(clone);
}
