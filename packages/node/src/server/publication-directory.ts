import { createValidatorRegistry } from '../schema/index.js';
import type { CollectionDirectory, DirectoryCollection } from '../types/index.js';
import { deepFreeze } from './deep-freeze.js';
import {
  projectPublicationPublicWire,
  PublicationPublicProjectionError,
  type PublicationPublicWireOptions,
} from './publication-public-projection.js';

/** Maximum number of records accepted at either anonymous Directory boundary. */
export const MAX_ANONYMOUS_DIRECTORY_CANDIDATES = 10_000;

const MAX_ANONYMOUS_DIRECTORY_JSON_DEPTH = 64;
const MAX_ANONYMOUS_DIRECTORY_JSON_VALUES = 1_000_000;
const INVALID_INPUT_MESSAGE = 'Anonymous Directory input is invalid.';
const CANDIDATE_LIMIT_MESSAGE = 'Anonymous Directory candidate limit exceeded.';
const NON_PUBLIC_PAGE_MESSAGE = 'Anonymous Directory page contains a non-public collection.';
const prototypeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const validators = createValidatorRegistry();

declare const anonymousDirectoryCandidateSetBrand: unique symbol;
declare const anonymousCollectionDirectoryPageBrand: unique symbol;

const issuedCandidateSets = new WeakSet<object>();
const issuedDirectoryPages = new WeakSet<object>();
/** Roots produced by select/page immutable detach; enables one-clone stage isolation. */
const issuedImmutableValues = new WeakSet<object>();

/**
 * Canonically validated public records selected before query, sort, cursor, or
 * pagination processing. A module-private runtime registry, reflected by this
 * opaque type, prevents raw storage results from impersonating a selection.
 */
export interface AnonymousDirectoryCandidateSet {
  readonly collections: readonly Readonly<DirectoryCollection>[];
  readonly [anonymousDirectoryCandidateSetBrand]: true;
}

/** A page produced from an AnonymousDirectoryCandidateSet by an adapter. */
export interface AnonymousCollectionDirectoryPage {
  readonly collections: readonly Readonly<DirectoryCollection>[];
  readonly nextCursor: string | null;
  readonly [anonymousCollectionDirectoryPageBrand]: true;
}

class CandidateLimitError extends Error {}
class NonPublicPageError extends Error {}

interface JsonInspectionState {
  values: number;
  readonly ancestors: WeakSet<object>;
}

/**
 * Select the only records eligible for anonymous Directory processing.
 *
 * Call this boundary before applying query filters, sorting, cursors, or page
 * limits. Candidate order is preserved for the downstream Directory pipeline.
 */
export function selectAnonymousDirectoryCandidates(
  candidates: unknown,
): AnonymousDirectoryCandidateSet {
  return withSanitizedDirectoryErrors(() => {
    const candidateValues = inspectCandidateArray(candidates);

    const publicCollections: Readonly<DirectoryCollection>[] = [];
    for (const sourceCandidate of candidateValues) {
      const visibility = ownDataProperty(sourceCandidate, 'visibility');
      if (visibility === 'unlisted' || visibility === 'protected' || visibility === 'private') continue;
      if (visibility !== 'public') throw new TypeError(INVALID_INPUT_MESSAGE);

      const candidate = immutableJson(sourceCandidate);
      if (!isCanonicalDirectoryCollection(candidate)) throw new TypeError(INVALID_INPUT_MESSAGE);
      publicCollections.push(candidate);
    }

    const selected = Object.freeze({
      collections: Object.freeze(publicCollections),
    }) as AnonymousDirectoryCandidateSet;
    issuedCandidateSets.add(selected);
    return selected;
  });
}

/**
 * Register a query/sort/cursor/pagination result derived from an issued
 * anonymous candidate set. Page records must retain their selected object
 * identities, so a raw or pre-paginated storage window cannot forge this
 * boundary with a TypeScript assertion.
 *
 * Proven selected identities are detached once (fast path) into a fresh page
 * shell so sibling pages and caller page inputs never share array/object
 * identity with the issued snapshot.
 */
export function createAnonymousCollectionDirectoryPage(
  selected: AnonymousDirectoryCandidateSet,
  page: { readonly collections: readonly Readonly<DirectoryCollection>[]; readonly nextCursor: string | null },
): AnonymousCollectionDirectoryPage {
  return withSanitizedDirectoryErrors(() => {
    if (typeof selected !== 'object' || selected === null || !issuedCandidateSets.has(selected)) {
      throw new TypeError(INVALID_INPUT_MESSAGE);
    }
    if (!isExactPageInput(page)) throw new TypeError(INVALID_INPUT_MESSAGE);

    const selectedIdentities = new Set(selected.collections);
    const sourceCollections = inspectExactArray(page.collections, MAX_ANONYMOUS_DIRECTORY_CANDIDATES);
    const detachedCollections: Readonly<DirectoryCollection>[] = [];
    for (const candidate of sourceCollections) {
      if (!selectedIdentities.has(candidate as Readonly<DirectoryCollection>)) {
        throw new TypeError(INVALID_INPUT_MESSAGE);
      }
      // Identity-proven select output: one structuredClone, skip dual JSON walks.
      detachedCollections.push(detachIssuedImmutable(candidate) as Readonly<DirectoryCollection>);
    }

    const issuedPage = Object.freeze({
      collections: Object.freeze(detachedCollections),
      nextCursor: page.nextCursor,
    }) as AnonymousCollectionDirectoryPage;
    issuedDirectoryPages.add(issuedPage);
    return issuedPage;
  });
}

/**
 * Build the final anonymous wire representation with a fail-closed visibility
 * check and mandatory public projection.
 *
 * This guard deliberately revalidates page records after pagination so an
 * adapter mistake cannot serialize an unlisted, protected, or private item.
 * The body then always passes through {@link projectPublicationPublicWire}
 * before return; adapters cannot skip projection by calling only this builder.
 *
 * @param options.publicExtensionNamespaces Defaults to `[]` (fail-closed).
 * Projection failures throw {@link PublicationPublicProjectionError}.
 */
export function buildAnonymousCollectionDirectory(
  page: AnonymousCollectionDirectoryPage,
  options: PublicationPublicWireOptions = {},
): Readonly<CollectionDirectory> {
  return withSanitizedDirectoryErrors(() => {
    if (typeof page !== 'object' || page === null || !issuedDirectoryPages.has(page)) {
      throw new TypeError(INVALID_INPUT_MESSAGE);
    }
    if (!isExactPageInput(page)) throw new TypeError(INVALID_INPUT_MESSAGE);
    if (page.collections.length > MAX_ANONYMOUS_DIRECTORY_CANDIDATES) {
      throw new CandidateLimitError();
    }

    // Reuse freeze/issued page item references; visibility is revalidated
    // fail-closed and public projection materializes the wire graph.
    const collections: Readonly<DirectoryCollection>[] = [];
    for (const candidate of page.collections) {
      if (!isCanonicalDirectoryCollection(candidate)) throw new TypeError(INVALID_INPUT_MESSAGE);
      if (candidate.visibility !== 'public') throw new NonPublicPageError();
      collections.push(candidate);
    }

    const directory = {
      protocolVersion: '0.1' as const,
      collections,
      nextCursor: page.nextCursor,
    };
    if (!validators.validate('collectionDirectory', directory).valid) {
      throw new TypeError(INVALID_INPUT_MESSAGE);
    }

    // Structure validated first; public projection is mandatory before wire.
    const projected = projectPublicationPublicWire(directory, options);
    if (!validators.validate('collectionDirectory', projected).valid) {
      throw new TypeError(INVALID_INPUT_MESSAGE);
    }
    return projected as unknown as Readonly<CollectionDirectory>;
  });
}

function inspectCandidateArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(INVALID_INPUT_MESSAGE);
  }
  const keys = Reflect.ownKeys(value);
  assertDensePlainArray(value, keys);
  const candidates: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(INVALID_INPUT_MESSAGE);
    }
    candidates.push(descriptor.value);
  }
  return candidates;
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(INVALID_INPUT_MESSAGE);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(INVALID_INPUT_MESSAGE);
  }
  return descriptor.value;
}

function isCanonicalDirectoryCollection(value: unknown): value is Readonly<DirectoryCollection> {
  return validators.validate('directoryCollection', value).valid;
}

function isExactPageInput(value: unknown): value is {
  readonly collections: readonly unknown[];
  readonly nextCursor: string | null;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2
    || keys.some((key) => typeof key !== 'string')
    || !keys.includes('collections')
    || !keys.includes('nextCursor')
  ) {
    return false;
  }
  const collections = Object.getOwnPropertyDescriptor(value, 'collections');
  const nextCursor = Object.getOwnPropertyDescriptor(value, 'nextCursor');
  return collections !== undefined
    && nextCursor !== undefined
    && 'value' in collections
    && 'value' in nextCursor
    && Array.isArray(collections.value)
    && (nextCursor.value === null || typeof nextCursor.value === 'string');
}

function immutableJson(value: unknown): unknown {
  // Valid JSON-data graphs remain JSON-data under structuredClone; skip a second walk.
  assertJsonData(value, 0, { values: 0, ancestors: new WeakSet<object>() });
  const clone: unknown = structuredClone(value);
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
    throw new TypeError(INVALID_INPUT_MESSAGE);
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

function inspectExactArray(value: unknown, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(INVALID_INPUT_MESSAGE);
  }
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    throw new TypeError(INVALID_INPUT_MESSAGE);
  }
  const length = lengthDescriptor.value as number;
  if (length > maximumLength) throw new CandidateLimitError();
  if (keys.length !== length + 1 || !keys.includes('length')) {
    throw new TypeError(INVALID_INPUT_MESSAGE);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(INVALID_INPUT_MESSAGE);
    }
    result.push(descriptor.value);
  }
  return result;
}

function assertJsonData(value: unknown, depth: number, state: JsonInspectionState): void {
  state.values += 1;
  if (state.values > MAX_ANONYMOUS_DIRECTORY_JSON_VALUES || depth > MAX_ANONYMOUS_DIRECTORY_JSON_DEPTH) {
    throw new TypeError(INVALID_INPUT_MESSAGE);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError(INVALID_INPUT_MESSAGE);
    }
    return;
  }
  if (typeof value !== 'object' || state.ancestors.has(value)) throw new TypeError(INVALID_INPUT_MESSAGE);

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if ((isArray && prototype !== Array.prototype) || (!isArray && prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError(INVALID_INPUT_MESSAGE);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || prototypeKeys.has(key))) {
    throw new TypeError(INVALID_INPUT_MESSAGE);
  }

  if (isArray) assertDensePlainArray(value, keys);

  state.ancestors.add(value);
  for (const key of keys) {
    if (isArray && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(INVALID_INPUT_MESSAGE);
    }
    assertJsonData(descriptor.value, depth + 1, state);
  }
  state.ancestors.delete(value);
}

function assertDensePlainArray(value: unknown[], keys: readonly PropertyKey[]): void {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    throw new TypeError(INVALID_INPUT_MESSAGE);
  }
  if (lengthDescriptor.value > MAX_ANONYMOUS_DIRECTORY_CANDIDATES) throw new CandidateLimitError();
  if (keys.length !== lengthDescriptor.value + 1 || !keys.includes('length')) {
    throw new TypeError(INVALID_INPUT_MESSAGE);
  }
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    if (!keys.includes(String(index))) throw new TypeError(INVALID_INPUT_MESSAGE);
  }
}

function withSanitizedDirectoryErrors<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PublicationPublicProjectionError) throw error;
    if (error instanceof CandidateLimitError) throw new RangeError(CANDIDATE_LIMIT_MESSAGE);
    if (error instanceof NonPublicPageError) throw new TypeError(NON_PUBLIC_PAGE_MESSAGE);
    throw new TypeError(INVALID_INPUT_MESSAGE);
  }
}
