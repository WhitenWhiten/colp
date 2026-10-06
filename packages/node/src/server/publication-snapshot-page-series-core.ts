import { isProxy } from 'node:util/types';

import { createValidatorRegistry } from '../schema/index.js';
import { hasWellFormedUtf16 } from '../shared/utf16.js';
import type { Snapshot } from '../types/index.js';
import { assertPublicationSnapshotBookmarkUrls } from './publication-bookmark-url-guard.js';

const MAX_PRINCIPAL_BYTES = 4_096;
const MAX_QUERY_BYTES = 16 * 1_024;
const MAX_SNAPSHOT_BYTES = 64 * 1_024 * 1_024;
const MAX_SNAPSHOT_DEPTH = 64;
const MAX_SNAPSHOT_VALUES = 1_000_000;
const INVALID_INPUT = 'Publication Snapshot page-series input is invalid.';
const INPUT_LIMIT = 'Publication Snapshot page-series input limit exceeded.';
const CONTEXT_MISMATCH = 'Publication Snapshot page-series context does not match.';
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const INCLUDE_VALUES = new Set(['annotations', 'attachments', 'relations']);
const QUERY_KEYS = new Set(['root', 'depth', 'include', 'limit', 'pageCursor']);
const validators = createValidatorRegistry();

declare const publicationSnapshotPageSeriesBrand: unique symbol;

/** Explicit authorization partition and decoded Snapshot query for one page request. */
export interface PublicationSnapshotPageScope {
  /** Stable authorization/cache-variant partition for the effective Principal. */
  readonly principal: string;
  /** Value returned by the registered Snapshot query decoder. */
  readonly query: Readonly<Record<string, unknown>>;
}

/** Opaque capability fixing one Publication Snapshot page-series context. */
export interface PublicationSnapshotPageSeries {
  readonly [publicationSnapshotPageSeriesBrand]: true;
}

/** Canonical first page and its opaque continuation context. */
export interface PublicationSnapshotPageSeriesStart {
  readonly series: PublicationSnapshotPageSeries;
  readonly page: Readonly<Snapshot>;
}

interface PageSeriesState {
  readonly snapshotId: string;
  readonly revision: string;
  readonly mode: 'publication';
  readonly principal: string;
  readonly logicalQuery: string;
}

interface JsonCloneState {
  values: number;
  bytes: number;
  readonly ancestors: WeakSet<object>;
}

const issuedPageSeries = new WeakMap<object, PageSeriesState>();

class PageSeriesLimitError extends Error {}
class PageSeriesMismatchError extends Error {}

/**
 * Establishes a page-series from a canonical first Publication Snapshot and
 * its explicit authorization/query scope. Caller-owned values are inspected
 * without invoking accessors and copied before any context is retained.
 */
export function createPublicationSnapshotPageSeries(
  firstPage: unknown,
  scope: PublicationSnapshotPageScope,
): PublicationSnapshotPageSeriesStart {
  return sanitize(() => {
    const normalizedScope = normalizeScope(scope, false);
    const page = canonicalSnapshotPage(firstPage);
    if (page.mode !== 'publication') throw new TypeError();

    const series = Object.freeze({}) as PublicationSnapshotPageSeries;
    issuedPageSeries.set(series, Object.freeze({
      snapshotId: page.snapshotId,
      revision: page.revision,
      mode: page.mode,
      principal: normalizedScope.principal,
      logicalQuery: normalizedScope.logicalQuery,
    }));
    return Object.freeze({ series, page });
  });
}

/**
 * Releases a detached immutable page only when its Snapshot identity and the
 * caller's current Principal/logical query match the canonical first page.
 */
export function releasePublicationSnapshotPage(
  series: PublicationSnapshotPageSeries,
  page: unknown,
  scope: PublicationSnapshotPageScope,
): Readonly<Snapshot> {
  return sanitize(() => {
    if (typeof series !== 'object' || series === null || isProxy(series)) throw new TypeError();
    const state = issuedPageSeries.get(series);
    if (state === undefined) throw new TypeError();

    const normalizedScope = normalizeScope(scope, true);
    const canonicalPage = canonicalSnapshotPage(page);
    if (
      canonicalPage.mode !== state.mode
      || canonicalPage.snapshotId !== state.snapshotId
      || canonicalPage.revision !== state.revision
      || normalizedScope.principal !== state.principal
      || normalizedScope.logicalQuery !== state.logicalQuery
    ) {
      throw new PageSeriesMismatchError();
    }
    return canonicalPage;
  });
}

function normalizeScope(
  value: PublicationSnapshotPageScope,
  allowPageCursor: boolean,
): { readonly principal: string; readonly logicalQuery: string } {
  const scope = inspectPlainRecord(value);
  assertExactKeys(scope, new Set(['principal', 'query']));
  const principal = dataProperty(scope, 'principal');
  const query = dataProperty(scope, 'query');
  if (
    typeof principal !== 'string'
    || principal.length === 0
    || CONTROL_CHARACTER_PATTERN.test(principal)
    || !hasWellFormedUtf16(principal)
  ) throw new TypeError();
  if (Buffer.byteLength(principal, 'utf8') > MAX_PRINCIPAL_BYTES) throw new PageSeriesLimitError();
  return {
    principal,
    logicalQuery: normalizeLogicalQuery(query, allowPageCursor),
  };
}

function normalizeLogicalQuery(value: unknown, allowPageCursor: boolean): string {
  const query = inspectPlainRecord(value);
  const keys = Reflect.ownKeys(query);
  if (keys.some((key) => typeof key !== 'string' || !QUERY_KEYS.has(key))) throw new TypeError();

  const decoded: Record<string, string | number | readonly string[]> = Object.create(null) as Record<
    string,
    string | number | readonly string[]
  >;
  if (Object.hasOwn(query, 'root')) {
    const root = dataProperty(query, 'root');
    if (!isScopeString(root)) throw new TypeError();
    decoded.root = root;
  }
  if (Object.hasOwn(query, 'depth')) {
    const depth = dataProperty(query, 'depth');
    if (!Number.isSafeInteger(depth) || (depth as number) < 0) throw new TypeError();
    decoded.depth = depth as number;
  }
  if (Object.hasOwn(query, 'include')) {
    const include = inspectPlainArray(dataProperty(query, 'include'));
    const values: string[] = [];
    for (const item of include) {
      if (typeof item !== 'string' || !INCLUDE_VALUES.has(item)) throw new TypeError();
      values.push(item);
    }
    decoded.include = Object.freeze(values);
  }
  if (Object.hasOwn(query, 'limit')) {
    const limit = dataProperty(query, 'limit');
    if (!Number.isSafeInteger(limit) || (limit as number) < 1) throw new TypeError();
    decoded.limit = limit as number;
  }
  if (Object.hasOwn(query, 'pageCursor')) {
    const pageCursor = dataProperty(query, 'pageCursor');
    if (!allowPageCursor || !isScopeString(pageCursor)) throw new TypeError();
    if (Buffer.byteLength(pageCursor, 'utf8') > MAX_QUERY_BYTES) throw new PageSeriesLimitError();
    decoded.pageCursor = pageCursor;
  } else if (allowPageCursor) {
    throw new TypeError();
  }

  if (!validators.validate('snapshotQuery', decoded).valid) throw new TypeError();
  const normalized = { ...decoded };
  delete normalized.pageCursor;
  if (Array.isArray(normalized.include)) normalized.include = Object.freeze([...normalized.include].sort());
  const canonical = JSON.stringify(normalized);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_QUERY_BYTES) throw new PageSeriesLimitError();
  return canonical;
}

function canonicalSnapshotPage(value: unknown): Readonly<Snapshot> {
  const cloned = cloneJson(value, 0, {
    values: 0,
    bytes: 0,
    ancestors: new WeakSet<object>(),
  });
  if (!validators.validate('snapshot', cloned).valid) throw new TypeError();
  const snapshot = cloned as Readonly<Snapshot>;
  assertPublicationSnapshotBookmarkUrls(snapshot);
  return snapshot;
}

function cloneJson(value: unknown, depth: number, state: JsonCloneState): unknown {
  state.values += 1;
  if (depth > MAX_SNAPSHOT_DEPTH || state.values > MAX_SNAPSHOT_VALUES) throw new PageSeriesLimitError();
  if (value === null || typeof value === 'boolean') {
    addBytes(state, value === null ? 4 : value ? 4 : 5);
    return value;
  }
  if (typeof value === 'string') {
    if (!hasWellFormedUtf16(value)) throw new TypeError();
    addBytes(state, Buffer.byteLength(JSON.stringify(value), 'utf8'));
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new TypeError();
    addBytes(state, String(value).length);
    return value;
  }
  if (typeof value !== 'object' || isProxy(value) || state.ancestors.has(value)) {
    throw new TypeError();
  }

  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_SNAPSHOT_VALUES) throw new PageSeriesLimitError();
  if (keys.some((key) => typeof key !== 'string' || FORBIDDEN_KEYS.has(key))) throw new TypeError();
  state.ancestors.add(value);
  try {
    if (array) {
      const items = inspectFrozenArray(value, keys);
      const output: unknown[] = [];
      addBytes(state, 2 + Math.max(0, items.length - 1));
      for (const item of items) output.push(cloneJson(item, depth + 1, state));
      return Object.freeze(output);
    }

    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    addBytes(state, 2 + Math.max(0, keys.length - 1));
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
      if (!hasWellFormedUtf16(key)) throw new TypeError();
      addBytes(state, Buffer.byteLength(JSON.stringify(key), 'utf8') + 1);
      output[key] = cloneJson(descriptor.value, depth + 1, state);
    }
    return Object.freeze(output);
  } finally {
    state.ancestors.delete(value);
  }
}

function inspectPlainRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || isProxy(value)
  ) throw new TypeError();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || FORBIDDEN_KEYS.has(key))) throw new TypeError();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
  }
  return value as Readonly<Record<string, unknown>>;
}

function inspectPlainArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value)) throw new TypeError();
  return inspectFrozenArray(value, Reflect.ownKeys(value));
}

function inspectFrozenArray(value: unknown[], keys: readonly PropertyKey[]): readonly unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
  const length = dataProperty(value, 'length');
  if (!Number.isSafeInteger(length) || (length as number) < 0) throw new TypeError();
  if (keys.length !== (length as number) + 1 || !keys.includes('length')) throw new TypeError();
  const items: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
    items.push(descriptor.value);
  }
  return items;
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: ReadonlySet<string>): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size || keys.some((key) => typeof key !== 'string' || !expected.has(key))) {
    throw new TypeError();
  }
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) throw new TypeError();
  return descriptor.value;
}

function isScopeString(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !CONTROL_CHARACTER_PATTERN.test(value)
    && hasWellFormedUtf16(value);
}

function addBytes(state: JsonCloneState, bytes: number): void {
  state.bytes += bytes;
  if (state.bytes > MAX_SNAPSHOT_BYTES) throw new PageSeriesLimitError();
}

function sanitize<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PageSeriesLimitError) throw new RangeError(INPUT_LIMIT);
    if (error instanceof PageSeriesMismatchError) throw new TypeError(CONTEXT_MISMATCH);
    throw new TypeError(INVALID_INPUT);
  }
}
