import { isProxy } from 'node:util/types';

import { createValidatorRegistry } from '../schema/index.js';
import type { CollectionDirectory, DirectoryCollection } from '../types/index.js';
import { deepFreeze } from './deep-freeze.js';
import {
  createPublicationCachePolicy,
  type PublicationCacheControlHeaderValue,
  type PublicationCachePolicyHeaders,
  type PublicationVaryHeaderValue,
} from './publication-cache-policy.js';
import {
  projectPublicationPublicWire,
  PublicationPublicProjectionError,
  type PublicationPublicWireOptions,
} from './publication-public-projection.js';

/** Maximum number of storage candidates accepted by the authorized Directory boundary. */
export const MAX_PUBLICATION_AUTHORIZED_DIRECTORY_CANDIDATES = 10_000;

const MAX_JSON_DEPTH = 64;
const MAX_JSON_VALUES = 1_000_000;
/**
 * Aggregate string/key bytes admitted for one authorized Directory selection.
 * Hosts may offer up to 500 records per page, each carrying a 1 KiB title, a
 * 2000-character summary and 64 tags of 64 characters, so a legitimate page
 * can approach 16 MiB; the ceiling bounds the N x MAX_JSON_VALUES
 * amplification without rejecting a full legitimate page.
 */
const MAX_JSON_BYTES = 16 * 1_048_576;
const MAX_CURSOR_LENGTH = 8_192;
const INVALID_INPUT = 'Publication authorized Directory input is invalid.';
const INVALID_PAGE = 'Publication authorized Directory page is invalid.';
const INVALID_OUTPUT = 'Publication authorized Directory output is invalid.';
const CANDIDATE_LIMIT = 'Publication authorized Directory candidate limit exceeded.';
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const validators = createValidatorRegistry();

declare const authorizedDirectoryCandidateSetBrand: unique symbol;
declare const authorizedDirectoryPageBrand: unique symbol;

export type PublicationProtectedDirectoryAuthorization = (
  candidate: Readonly<DirectoryCollection>,
) => boolean;

export interface PublicationAuthorizedDirectoryCandidateSet {
  readonly collections: readonly Readonly<DirectoryCollection>[];
  readonly [authorizedDirectoryCandidateSetBrand]: true;
}

export interface PublicationAuthorizedDirectoryPage {
  readonly collections: readonly Readonly<DirectoryCollection>[];
  readonly nextCursor: string | null;
  readonly [authorizedDirectoryPageBrand]: true;
}

export interface PublicationAuthorizedDirectoryCacheInput {
  readonly existingCacheControl?: PublicationCacheControlHeaderValue | undefined;
  readonly existingVary?: PublicationVaryHeaderValue | undefined;
}

export interface PublicationAuthorizedDirectoryResponse {
  readonly body: Readonly<CollectionDirectory>;
  readonly headers: PublicationCachePolicyHeaders;
}

const issuedSelections = new WeakSet<object>();
const issuedPages = new WeakSet<object>();
/** Roots produced by select/page immutable detach; enables one-clone stage isolation. */
const issuedImmutableValues = new WeakSet<object>();

/**
 * Select records before query, sorting, cursor, or pagination work.
 *
 * Public records are eligible directly. Protected records are eligible only
 * when the caller's explicit authorization decision is exactly true. Unlisted
 * and private records are skipped after reading only their own visibility, so
 * their remaining payload cannot influence discovery or authorization.
 */
export function selectPublicationAuthorizedDirectoryCandidates(
  candidates: unknown,
  authorizeProtected: PublicationProtectedDirectoryAuthorization,
): PublicationAuthorizedDirectoryCandidateSet {
  return sanitize(INVALID_INPUT, () => {
    if (typeof authorizeProtected !== 'function') throw new TypeError();
    const source = inspectExactArray(candidates, MAX_PUBLICATION_AUTHORIZED_DIRECTORY_CANDIDATES);
    const collections: Readonly<DirectoryCollection>[] = [];
    // Charge the complete selection against one graph budget. Applying the
    // per-record limit independently allowed a wide page of large records to
    // consume roughly N * MAX_JSON_VALUES before pagination was reached.
    const budget = { values: 0, bytes: 0 };

    for (const sourceCandidate of source) {
      const visibility = readOwnVisibility(sourceCandidate);
      if (visibility === 'unlisted' || visibility === 'private') continue;
      if (visibility !== 'public' && visibility !== 'protected') throw new TypeError();

      const candidate = immutableJson(sourceCandidate, budget);
      if (!validators.validate('directoryCollection', candidate).valid) throw new TypeError();
      if (visibility === 'protected') {
        const decision = authorizeProtected(candidate as Readonly<DirectoryCollection>);
        if (typeof decision !== 'boolean') throw new TypeError();
        if (!decision) continue;
      }
      collections.push(candidate as Readonly<DirectoryCollection>);
    }

    const selection = Object.freeze({
      collections: Object.freeze(collections),
    }) as PublicationAuthorizedDirectoryCandidateSet;
    issuedSelections.add(selection);
    return selection;
  });
}

/**
 * Register a query/sort/cursor/pagination result derived from an issued selection.
 *
 * Proven selected identities are detached once (fast path) into a fresh page
 * shell so sibling pages and caller page inputs never share array/object
 * identity with the issued snapshot.
 */
export function createPublicationAuthorizedDirectoryPage(
  selected: PublicationAuthorizedDirectoryCandidateSet,
  page: { readonly collections: readonly Readonly<DirectoryCollection>[]; readonly nextCursor: string | null },
): PublicationAuthorizedDirectoryPage {
  return sanitize(INVALID_PAGE, () => {
    if (typeof selected !== 'object' || selected === null || !issuedSelections.has(selected)) throw new TypeError();
    const inspected = inspectPage(page);
    const selectedIdentities = new Set<unknown>(selected.collections);
    const detached: Readonly<DirectoryCollection>[] = [];
    for (const collection of inspected.collections) {
      if (!selectedIdentities.has(collection)) throw new TypeError();
      // Identity-proven select output: one structuredClone, skip dual JSON walks.
      detached.push(detachIssuedImmutable(collection) as Readonly<DirectoryCollection>);
    }
    const issued = Object.freeze({
      collections: Object.freeze(detached),
      nextCursor: inspected.nextCursor,
    }) as PublicationAuthorizedDirectoryPage;
    issuedPages.add(issued);
    return issued;
  });
}

/**
 * Build serialization-ready Directory output and revalidate the detached page.
 * Only public and previously-authorized protected records can cross this guard.
 *
 * This path does **not** apply public projection so authorized protected
 * responses can retain principal-visible fields that public projection would
 * strip. For declared public-projection wire, use
 * {@link buildPublicationAuthorizedCollectionDirectoryPublicProjection}.
 */
export function buildPublicationAuthorizedCollectionDirectory(
  page: PublicationAuthorizedDirectoryPage,
): Readonly<CollectionDirectory> {
  return sanitize(INVALID_OUTPUT, () => buildAuthorizedDirectoryModel(page, true));
}

/**
 * Build authorized Directory wire and force public projection.
 *
 * Use only when the caller declares public-projection semantics for this
 * response (for example a mixed authorized surface that still must redline
 * secrets/extensions). Prefer
 * {@link buildPublicationAuthorizedCollectionDirectory} when protected
 * principal-visible fields must remain intact.
 *
 * Reuses freeze/issued page item references through validation; projection
 * materializes the wire graph so a pre-projection structuredClone is skipped.
 *
 * @param options.publicExtensionNamespaces Defaults to `[]` (fail-closed).
 * Projection failures throw {@link PublicationPublicProjectionError}.
 */
export function buildPublicationAuthorizedCollectionDirectoryPublicProjection(
  page: PublicationAuthorizedDirectoryPage,
  options: PublicationPublicWireOptions = {},
): Readonly<CollectionDirectory> {
  return sanitize(INVALID_OUTPUT, () => {
    const directory = buildAuthorizedDirectoryModel(page, false);
    const projected = projectPublicationPublicWire(directory, options);
    if (!validators.validate('collectionDirectory', projected).valid) throw new TypeError();
    return projected as unknown as Readonly<CollectionDirectory>;
  });
}

/**
 * Shared authorized Directory model construction.
 *
 * @param detachItems When true, clone each issued page item once for returned
 * body isolation (non-projection path). When false, reuse page item references
 * for a subsequent public-projection materialization.
 */
function buildAuthorizedDirectoryModel(
  page: PublicationAuthorizedDirectoryPage,
  detachItems: boolean,
): Readonly<CollectionDirectory> {
  if (typeof page !== 'object' || page === null || !issuedPages.has(page)) throw new TypeError();
  const inspected = inspectPage(page);
  const collections: Readonly<DirectoryCollection>[] = [];
  for (const sourceCollection of inspected.collections) {
    const collection = detachItems
      ? detachIssuedImmutable(sourceCollection)
      : sourceCollection;
    if (!validators.validate('directoryCollection', collection).valid) throw new TypeError();
    const visibility = readOwnVisibility(collection);
    if (visibility !== 'public' && visibility !== 'protected') throw new TypeError();
    collections.push(collection as Readonly<DirectoryCollection>);
  }

  const directory = {
    protocolVersion: '0.1' as const,
    collections,
    nextCursor: inspected.nextCursor,
  };
  if (!validators.validate('collectionDirectory', directory).valid) throw new TypeError();
  return (detachItems ? deepFreeze(directory) : directory) as Readonly<CollectionDirectory>;
}

/** Build the authorized Directory body together with its mandatory private cache metadata. */
export function createPublicationAuthorizedDirectoryResponse(
  page: PublicationAuthorizedDirectoryPage,
  cache: PublicationAuthorizedDirectoryCacheInput = {},
): PublicationAuthorizedDirectoryResponse {
  return sanitize(INVALID_OUTPUT, () => {
    assertCacheInput(cache);
    const body = buildPublicationAuthorizedCollectionDirectory(page);
    const headers = createPublicationCachePolicy({
      kind: 'authorization-varying',
      ...(cache.existingCacheControl === undefined
        ? {}
        : { existingCacheControl: cache.existingCacheControl }),
      ...(cache.existingVary === undefined ? {} : { existingVary: cache.existingVary }),
    });
    return Object.freeze({ body, headers });
  });
}

/**
 * Authorized Directory response that also forces public projection on the body.
 * Cache metadata remains authorization-varying; body projection defaults to
 * fail-closed extension allowlisting (`publicExtensionNamespaces: []`).
 */
export function createPublicationAuthorizedDirectoryPublicProjectionResponse(
  page: PublicationAuthorizedDirectoryPage,
  cache: PublicationAuthorizedDirectoryCacheInput = {},
  options: PublicationPublicWireOptions = {},
): PublicationAuthorizedDirectoryResponse {
  return sanitize(INVALID_OUTPUT, () => {
    assertCacheInput(cache);
    const body = buildPublicationAuthorizedCollectionDirectoryPublicProjection(page, options);
    const headers = createPublicationCachePolicy({
      kind: 'authorization-varying',
      ...(cache.existingCacheControl === undefined
        ? {}
        : { existingCacheControl: cache.existingCacheControl }),
      ...(cache.existingVary === undefined ? {} : { existingVary: cache.existingVary }),
    });
    return Object.freeze({ body, headers });
  });
}

function assertCacheInput(value: PublicationAuthorizedDirectoryCacheInput): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || (key !== 'existingCacheControl' && key !== 'existingVary'))) {
    throw new TypeError();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
  }
}

function inspectPage(value: unknown): {
  readonly collections: readonly unknown[];
  readonly nextCursor: string | null;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2
    || keys.some((key) => typeof key !== 'string' || (key !== 'collections' && key !== 'nextCursor'))
  ) throw new TypeError();
  const collections = Object.getOwnPropertyDescriptor(value, 'collections');
  const cursor = Object.getOwnPropertyDescriptor(value, 'nextCursor');
  if (collections === undefined || !collections.enumerable || !('value' in collections)) throw new TypeError();
  if (cursor === undefined || !cursor.enumerable || !('value' in cursor)) throw new TypeError();
  if (
    cursor.value !== null
    && (typeof cursor.value !== 'string' || cursor.value.length > MAX_CURSOR_LENGTH)
  ) throw new TypeError();
  return {
    collections: inspectExactArray(collections.value, MAX_PUBLICATION_AUTHORIZED_DIRECTORY_CANDIDATES),
    nextCursor: cursor.value as string | null,
  };
}

function inspectExactArray(value: unknown, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) throw new TypeError();
  const length = lengthDescriptor.value as number;
  if (length > maximumLength) throw new CandidateLimitError();
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
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) throw new TypeError();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'visibility');
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
  return descriptor.value;
}

function immutableJson(value: unknown, budget?: { values: number; bytes: number }): unknown {
  const state = budget ?? { values: 0, bytes: 0 };
  inspectJson(value, 0, { values: 0, ancestors: new WeakSet<object>() }, state);
  // The clone is structurally identical to the admitted source: re-inspect it
  // for structuredClone surprises, but do not charge the aggregate twice.
  const clone: unknown = structuredClone(value);
  inspectJson(clone, 0, { values: 0, ancestors: new WeakSet<object>() });
  const frozen = deepFreeze(clone);
  markIssuedImmutable(frozen);
  return frozen;
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

function inspectJson(
  value: unknown,
  depth: number,
  state: { values: number; readonly ancestors: WeakSet<object> },
  aggregate?: { values: number; bytes: number },
): void {
  state.values += 1;
  if (aggregate !== undefined) aggregate.values += 1;
  if (depth > MAX_JSON_DEPTH
      || state.values > MAX_JSON_VALUES
      || (aggregate !== undefined
        && (aggregate.values > MAX_JSON_VALUES || aggregate.bytes > MAX_JSON_BYTES))) throw new TypeError();
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (aggregate !== undefined) {
      aggregate.bytes += Buffer.byteLength(value, 'utf8');
      if (aggregate.bytes > MAX_JSON_BYTES) throw new TypeError();
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new TypeError();
    return;
  }
  if (typeof value !== 'object' || isProxy(value) || state.ancestors.has(value)) throw new TypeError();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || forbiddenKeys.has(key))) throw new TypeError();
  if (array) {
    const length = value.length;
    if (keys.length !== length + 1 || !keys.includes('length')) throw new TypeError();
  }
  state.ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') throw new TypeError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
    if (aggregate !== undefined) {
      aggregate.bytes += Buffer.byteLength(key, 'utf8');
      if (aggregate.bytes > MAX_JSON_BYTES) throw new TypeError();
    }
    inspectJson(descriptor.value, depth + 1, state, aggregate);
  }
  state.ancestors.delete(value);
}

class CandidateLimitError extends Error {}

function sanitize<Result>(message: string, operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PublicationPublicProjectionError) throw error;
    if (error instanceof CandidateLimitError) throw new RangeError(CANDIDATE_LIMIT);
    throw new TypeError(message);
  }
}
