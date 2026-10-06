import { deepFreeze } from './deep-freeze.js';
import {
  projectPublicationPublicWire,
  PublicationPublicProjectionError,
  type PublicationPublicWireOptions,
} from './publication-public-projection.js';

/** Publication surfaces that must never rediscover a non-public Collection. */
export const PUBLICATION_DISCOVERY_CHANNELS = Object.freeze([
  'anonymous-directory',
  'search',
  'instance-feed',
  'sitemap',
  'mcp-list',
] as const);

export type PublicationDiscoveryChannel = (typeof PUBLICATION_DISCOVERY_CHANNELS)[number];

/** Maximum number of storage candidates accepted by one discovery operation. */
export const MAX_PUBLICATION_DISCOVERY_CANDIDATES = 10_000;
/** Maximum aggregate size accepted for caller-supplied anti-discovery headers. */
export const MAX_PUBLICATION_ANTI_DISCOVERY_HEADER_BYTES = 64 * 1024;

const MAX_JSON_DEPTH = 64;
const MAX_JSON_VALUES = 1_000_000;
const MAX_CURSOR_LENGTH = 8_192;
const MAX_HEADER_COUNT = 128;
const MAX_HEADER_NAME_LENGTH = 256;
const MAX_HEADER_VALUE_LENGTH = 8_192;
const INVALID_DISCOVERY_INPUT = 'Publication discovery input is invalid.';
const INVALID_DISCOVERY_PAGE = 'Publication discovery page is invalid.';
const CANDIDATE_LIMIT = 'Publication discovery candidate limit exceeded.';
const NON_PUBLIC_OUTPUT = 'Publication discovery output contains a non-public item.';
const INVALID_HEADERS = 'Publication anti-discovery headers are invalid.';
const OVERSIZE_HEADERS = 'Publication anti-discovery headers exceed the size limit.';
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const channelSet: ReadonlySet<string> = new Set(PUBLICATION_DISCOVERY_CHANNELS);

declare const discoveryCandidateSetBrand: unique symbol;
declare const discoveryPageBrand: unique symbol;

export type PublicationDiscoveryValidator<Value> = (value: unknown) => value is Value;

export interface PublicationDiscoveryCandidateSet<Value> {
  readonly channel: PublicationDiscoveryChannel;
  readonly items: readonly Readonly<Value>[];
  readonly [discoveryCandidateSetBrand]: true;
}

export interface PublicationDiscoveryPage<Value> {
  readonly channel: PublicationDiscoveryChannel;
  readonly items: readonly Readonly<Value>[];
  readonly nextCursor: string | null;
  readonly [discoveryPageBrand]: true;
}

export interface PublicationDiscoveryOutput<Value> {
  readonly channel: PublicationDiscoveryChannel;
  readonly items: readonly Readonly<Value>[];
  readonly nextCursor: string | null;
}

interface IssuedSelection<Value> {
  readonly channel: PublicationDiscoveryChannel;
  readonly validator: PublicationDiscoveryValidator<Value>;
}

const issuedSelections = new WeakMap<object, IssuedSelection<unknown>>();
const issuedPages = new WeakMap<object, IssuedSelection<unknown>>();
/** Roots produced by select/page immutable detach; enables one-clone stage isolation. */
const issuedImmutableValues = new WeakSet<object>();

/**
 * Remove hidden Collections before any query, sort, cursor, or pagination work.
 * Hidden records are inspected only far enough to read their own visibility;
 * malformed secret payloads therefore cannot affect anonymous discovery.
 */
export function selectPublicationDiscoveryCandidates<Value>(
  channel: PublicationDiscoveryChannel,
  candidates: unknown,
  validate: PublicationDiscoveryValidator<Value>,
): PublicationDiscoveryCandidateSet<Value> {
  return sanitizeDiscoveryError(INVALID_DISCOVERY_INPUT, () => {
    assertChannel(channel);
    if (typeof validate !== 'function') throw new TypeError();
    const source = inspectCandidateArray(candidates);
    const items: Readonly<Value>[] = [];
    for (const candidate of source) {
      const visibility = readOwnVisibility(candidate);
      if (visibility === 'unlisted' || visibility === 'protected' || visibility === 'private') continue;
      if (visibility !== 'public') throw new TypeError();
      const detached = immutableJson(candidate);
      if (!safeValidate(validate, detached)) throw new TypeError();
      items.push(detached);
    }
    const selection = Object.freeze({ channel, items: Object.freeze(items) }) as PublicationDiscoveryCandidateSet<Value>;
    issuedSelections.set(selection, { channel, validator: validate } as IssuedSelection<unknown>);
    return selection;
  });
}

/**
 * Register the post-filter query/sort/cursor/pagination result.
 *
 * Proven selected identities are detached once (fast path) into a fresh page
 * shell so sibling pages and caller page inputs never share array/object
 * identity with the issued snapshot.
 */
export function createPublicationDiscoveryPage<Value>(
  selected: PublicationDiscoveryCandidateSet<Value>,
  page: { readonly items: readonly Readonly<Value>[]; readonly nextCursor: string | null },
): PublicationDiscoveryPage<Value> {
  return sanitizeDiscoveryError(INVALID_DISCOVERY_PAGE, () => {
    if (typeof selected !== 'object' || selected === null) throw new TypeError();
    const issued = issuedSelections.get(selected);
    if (issued === undefined) throw new TypeError();
    const inspected = inspectPage(page, false);
    const selectedItems = new Set<unknown>(selected.items);
    const detachedItems: Readonly<Value>[] = [];
    for (const item of inspected.items) {
      if (!selectedItems.has(item)) throw new TypeError();
      // Identity-proven select output: one structuredClone, skip dual JSON walks.
      detachedItems.push(detachIssuedImmutable(item) as Readonly<Value>);
    }
    const result = Object.freeze({
      channel: issued.channel,
      items: Object.freeze(detachedItems),
      nextCursor: inspected.nextCursor,
    }) as PublicationDiscoveryPage<Value>;
    issuedPages.set(result, issued);
    return result;
  });
}

/**
 * Produce serialization-ready output, failing closed if the issued page is
 * invalid, non-public, or no longer satisfies the channel's validator.
 *
 * The final envelope always passes through {@link projectPublicationPublicWire}
 * so anonymous discovery adapters cannot skip public projection.
 *
 * @param options.publicExtensionNamespaces Defaults to `[]` (fail-closed).
 * Projection failures throw {@link PublicationPublicProjectionError}.
 */
export function buildPublicationDiscoveryOutput<Value>(
  page: PublicationDiscoveryPage<Value>,
  options: PublicationPublicWireOptions = {},
): Readonly<PublicationDiscoveryOutput<Value>> {
  try {
    if (typeof page !== 'object' || page === null) throw new TypeError();
    const issued = issuedPages.get(page);
    if (issued === undefined) throw new TypeError();
    const inspected = inspectPage(page, true);
    if (inspected.channel !== issued.channel) throw new TypeError();
    // Reuse freeze/issued page item references after fail-closed visibility
    // revalidation. Public projection materializes the wire graph, so a second
    // structuredClone of every item is unnecessary.
    const outputItems: Readonly<Value>[] = [];
    for (const item of inspected.items) {
      const visibility = readOwnVisibility(item);
      if (visibility !== 'public') throw new NonPublicOutputError();
      outputItems.push(item as Readonly<Value>);
    }
    const envelope = {
      channel: issued.channel,
      items: outputItems,
      nextCursor: inspected.nextCursor,
    };
    // Visibility checked; public projection is mandatory before wire emission.
    const projected = projectPublicationPublicWire(envelope, options);
    if (
      typeof projected !== 'object'
      || projected === null
      || Array.isArray(projected)
    ) throw new TypeError();
    const projectedItems = Object.getOwnPropertyDescriptor(projected, 'items');
    if (
      projectedItems === undefined
      || !projectedItems.enumerable
      || !('value' in projectedItems)
      || !Array.isArray(projectedItems.value)
    ) throw new TypeError();
    for (const item of projectedItems.value) {
      const visibility = readOwnVisibility(item);
      if (visibility !== 'public') throw new NonPublicOutputError();
      if (!safeValidate(issued.validator, item)) throw new TypeError();
    }
    return projected as unknown as Readonly<PublicationDiscoveryOutput<Value>>;
  } catch (error) {
    if (error instanceof PublicationPublicProjectionError) throw error;
    if (error instanceof CandidateLimitError) throw new RangeError(CANDIDATE_LIMIT);
    if (error instanceof NonPublicOutputError) throw new TypeError(NON_PUBLIC_OUTPUT);
    throw new TypeError(INVALID_DISCOVERY_PAGE);
  }
}

type PublicationHeadersInit = Headers | readonly (readonly [string, string])[] | Readonly<Record<string, string>>;

/**
 * Copy response headers and add the anti-discovery policy required by every
 * Publication discovery surface. Existing unrelated fields are preserved.
 */
export function mergePublicationAntiDiscoveryHeaders(headers?: PublicationHeadersInit): Headers {
  const entries = inspectHeaderEntries(headers);
  let result: Headers;
  try {
    result = new Headers(entries);
    result.set('X-Robots-Tag', 'noindex, nofollow');
    result.set('Referrer-Policy', 'no-referrer');
  } catch {
    throw new TypeError(INVALID_HEADERS);
  }
  return result;
}

/** Alias suitable for response-builder call sites. */
export const createPublicationAntiDiscoveryHeaders = mergePublicationAntiDiscoveryHeaders;
/** Alias suitable for middleware call sites. */
export const applyPublicationAntiDiscoveryHeaders = mergePublicationAntiDiscoveryHeaders;

class CandidateLimitError extends Error {}
class NonPublicOutputError extends Error {}

function assertChannel(channel: unknown): asserts channel is PublicationDiscoveryChannel {
  if (typeof channel !== 'string' || !channelSet.has(channel)) throw new TypeError();
}

function inspectCandidateArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError();
  if (length > MAX_PUBLICATION_DISCOVERY_CANDIDATES) throw new CandidateLimitError();
  if (keys.length !== length + 1 || !keys.includes('length')) throw new TypeError();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
    result.push(descriptor.value);
  }
  return result;
}

function readOwnVisibility(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'visibility');
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
  return descriptor.value;
}

function inspectPage(
  value: unknown,
  requireChannel: boolean,
): { readonly channel?: unknown; readonly items: readonly unknown[]; readonly nextCursor: string | null } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  const expected = requireChannel ? ['channel', 'items', 'nextCursor'] : ['items', 'nextCursor'];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) throw new TypeError();
  if (keys.some((key) => typeof key !== 'string' || !expected.includes(key))) throw new TypeError();
  const channel = Object.getOwnPropertyDescriptor(value, 'channel');
  const items = Object.getOwnPropertyDescriptor(value, 'items');
  const cursor = Object.getOwnPropertyDescriptor(value, 'nextCursor');
  if (requireChannel && (channel === undefined || !channel.enumerable || !('value' in channel))) throw new TypeError();
  if (items === undefined || !items.enumerable || !('value' in items) || !Array.isArray(items.value)) throw new TypeError();
  if (cursor === undefined || !cursor.enumerable || !('value' in cursor)) throw new TypeError();
  if (cursor.value !== null && (typeof cursor.value !== 'string' || cursor.value.length > MAX_CURSOR_LENGTH)) throw new TypeError();
  const inspectedItems = inspectExactArray(items.value, MAX_PUBLICATION_DISCOVERY_CANDIDATES);
  return {
    ...(requireChannel ? { channel: channel!.value } : {}),
    items: inspectedItems,
    nextCursor: cursor.value,
  };
}

function safeValidate<Value>(validate: PublicationDiscoveryValidator<Value>, value: unknown): value is Value {
  try {
    return validate(value) === true;
  } catch {
    return false;
  }
}

function immutableJson(value: unknown): Readonly<never> {
  inspectJson(value, 0, { values: 0, ancestors: new WeakSet<object>() });
  const clone: unknown = structuredClone(value);
  inspectJson(clone, 0, { values: 0, ancestors: new WeakSet<object>() });
  const frozen = deepFreeze(clone);
  markIssuedImmutable(frozen);
  return frozen as Readonly<never>;
}

/**
 * Stage-isolation clone for values already admitted by {@link immutableJson}.
 * Performs one structuredClone + deepFreeze without repeating JSON tree walks.
 */
function detachIssuedImmutable(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !issuedImmutableValues.has(value)) {
    throw new TypeError();
  }
  const clone: unknown = structuredClone(value);
  const frozen = deepFreeze(clone);
  markIssuedImmutable(frozen);
  return frozen;
}

function markIssuedImmutable(value: unknown): void {
  if (typeof value === 'object' && value !== null) {
    issuedImmutableValues.add(value);
  }
}

function inspectJson(value: unknown, depth: number, state: { values: number; ancestors: WeakSet<object> }): void {
  state.values += 1;
  if (depth > MAX_JSON_DEPTH || state.values > MAX_JSON_VALUES) throw new TypeError();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new TypeError();
    return;
  }
  if (typeof value !== 'object' || state.ancestors.has(value)) throw new TypeError();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || forbiddenKeys.has(key))) throw new TypeError();
  if (array) {
    const length = value.length;
    if (keys.length !== length + 1 || !keys.includes('length')) throw new TypeError();
  }
  state.ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
    inspectJson(descriptor.value, depth + 1, state);
  }
  state.ancestors.delete(value);
}

function inspectHeaderEntries(headers: PublicationHeadersInit | undefined): [string, string][] {
  try {
    if (headers === undefined) return [];
    let entries: [string, string][];
    if (headers instanceof Headers) {
      entries = Array.from(Headers.prototype.entries.call(headers));
    } else if (Array.isArray(headers)) {
      if (Object.getPrototypeOf(headers) !== Array.prototype) throw new TypeError();
      if (headers.length > MAX_HEADER_COUNT) throw new RangeError();
      entries = inspectExactArray(headers, MAX_HEADER_COUNT).map((entry) => {
        if (!Array.isArray(entry) || Object.getPrototypeOf(entry) !== Array.prototype || entry.length !== 2) throw new TypeError();
        const tuple = inspectExactArray(entry, 2);
        if (typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string') throw new TypeError();
        return [tuple[0], tuple[1]];
      });
    } else {
      if (typeof headers !== 'object' || headers === null) throw new TypeError();
      const prototype = Object.getPrototypeOf(headers) as unknown;
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
      entries = Reflect.ownKeys(headers).map((key) => {
        if (typeof key !== 'string' || forbiddenKeys.has(key)) throw new TypeError();
        const descriptor = Object.getOwnPropertyDescriptor(headers, key);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') {
          throw new TypeError();
        }
        return [key, descriptor.value];
      });
    }
    if (entries.length > MAX_HEADER_COUNT) throw new RangeError();
    let size = 0;
    for (const [name, value] of entries) {
      if (name.length === 0) throw new TypeError();
      const nameBytes = new TextEncoder().encode(name).length;
      const valueBytes = new TextEncoder().encode(value).length;
      if (nameBytes > MAX_HEADER_NAME_LENGTH || valueBytes > MAX_HEADER_VALUE_LENGTH) throw new RangeError();
      if (/[^!#$%&'*+.^_`|~0-9A-Za-z-]/u.test(name) || /[\r\n\0]/u.test(value)) throw new TypeError();
      size += nameBytes + valueBytes;
      if (size > MAX_PUBLICATION_ANTI_DISCOVERY_HEADER_BYTES) throw new RangeError();
    }
    return entries;
  } catch (error) {
    if (error instanceof RangeError || error instanceof CandidateLimitError) {
      throw new RangeError(OVERSIZE_HEADERS);
    }
    throw new TypeError(INVALID_HEADERS);
  }
}

function inspectExactArray(value: readonly unknown[], maximumLength: number): unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError();
  if (length > maximumLength) throw new CandidateLimitError();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) throw new TypeError();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
    result.push(descriptor.value);
  }
  return result;
}

function sanitizeDiscoveryError<Result>(message: string, operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CandidateLimitError) throw new RangeError(CANDIDATE_LIMIT);
    throw new TypeError(message);
  }
}
