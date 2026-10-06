import { isProxy } from 'node:util/types';

import { createPublicationProblemResponse } from './publication-problems.js';

/** Thirty exact 24-hour days, the minimum deleted-Collection retention window. */
export const PUBLICATION_DELETED_COLLECTION_MIN_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

const COLLECTION_DELETED_PROBLEM = 'https://collectionprotocol.org/problems/collection-deleted';
const INPUT_KEYS = new Set(['canonicalUrl', 'deletedAt', 'retentionMilliseconds']);
const RECOVERY_TARGET_INPUT_KEYS = new Set(['kind', 'url']);
const TOMBSTONE_CACHE_CONTROL = 'no-store';
const MAX_RECOVERY_TARGET_LENGTH = 4_096;

export const PUBLICATION_DELETED_COLLECTION_ARCHIVE_REL =
  'https://collectionprotocol.org/rels/archive' as const;
export const PUBLICATION_DELETED_COLLECTION_MIGRATION_REL =
  'https://collectionprotocol.org/rels/migration' as const;
export const PUBLICATION_DELETED_COLLECTION_OWNER_REL =
  'https://collectionprotocol.org/rels/owner' as const;

const RECOVERY_RELATIONS = Object.freeze({
  archive: PUBLICATION_DELETED_COLLECTION_ARCHIVE_REL,
  migration: PUBLICATION_DELETED_COLLECTION_MIGRATION_REL,
  owner: PUBLICATION_DELETED_COLLECTION_OWNER_REL,
});

declare const publicationDeletedCollectionTombstoneBrand: unique symbol;
declare const publicationDeletedCollectionRecoveryTargetBrand: unique symbol;

export interface PublicationDeletedCollectionClock {
  now(): Date;
}

export interface PublicationDeletedCollectionTombstoneInput {
  /** Exact, canonical serialization of the Collection's original HTTP(S) Canonical URL. */
  readonly canonicalUrl: string;
  readonly deletedAt: Date;
  /** Exact duration from deletion; defaults to, and cannot be less than, thirty days. */
  readonly retentionMilliseconds?: number;
}

export type PublicationDeletedCollectionRecoveryKind = keyof typeof RECOVERY_RELATIONS;

export interface PublicationDeletedCollectionRecoveryTargetInput {
  readonly kind: PublicationDeletedCollectionRecoveryKind;
  /** Canonical HTTPS URL, or exact loopback HTTP URL for local development. */
  readonly url: string;
}

/** Immutable recovery link issued only after Publication transport validation. */
export interface PublicationDeletedCollectionRecoveryTarget {
  readonly kind: PublicationDeletedCollectionRecoveryKind;
  readonly url: string;
  readonly relation: (typeof RECOVERY_RELATIONS)[PublicationDeletedCollectionRecoveryKind];
  readonly [publicationDeletedCollectionRecoveryTargetBrand]: true;
}

/** Immutable routing fact issued only after deleted-Collection retention validation. */
export interface PublicationDeletedCollectionTombstone {
  readonly canonicalUrl: string;
  /** Canonical UTC instant detached from the caller's mutable Date. */
  readonly deletedAt: string;
  /** Canonical UTC instant at the exclusive end of the retention interval. */
  readonly retentionUntil: string;
  readonly retentionMilliseconds: number;
  readonly [publicationDeletedCollectionTombstoneBrand]: true;
}

interface TombstoneState {
  readonly canonicalUrl: string;
  readonly deletedAtMilliseconds: number;
  readonly retentionUntilMilliseconds: number;
}

const issuedTombstones = new WeakMap<object, TombstoneState>();
const issuedRecoveryTargets = new WeakMap<object, Readonly<{
  kind: PublicationDeletedCollectionRecoveryKind;
  url: string;
  relation: (typeof RECOVERY_RELATIONS)[PublicationDeletedCollectionRecoveryKind];
}>>();

/**
 * Establishes the HTTP routing fact at deletion time. The input deliberately
 * has no reason, archive, migration, or owner fields, so those values cannot
 * accidentally appear in the baseline 410 response.
 */
export function createPublicationDeletedCollectionTombstone(
  input: PublicationDeletedCollectionTombstoneInput,
): PublicationDeletedCollectionTombstone {
  assertInput(input);
  const canonicalUrl = canonicalHttpUrl(input.canonicalUrl);
  const deletedAtMilliseconds = validDateMilliseconds(input.deletedAt, 'deletedAt');
  const retentionMilliseconds = input.retentionMilliseconds
    ?? PUBLICATION_DELETED_COLLECTION_MIN_RETENTION_MILLISECONDS;
  if (
    !Number.isSafeInteger(retentionMilliseconds)
    || retentionMilliseconds < PUBLICATION_DELETED_COLLECTION_MIN_RETENTION_MILLISECONDS
  ) {
    throw new RangeError(
      `retentionMilliseconds must be a safe integer of at least ${PUBLICATION_DELETED_COLLECTION_MIN_RETENTION_MILLISECONDS}.`,
    );
  }
  const retentionUntilMilliseconds = deletedAtMilliseconds + retentionMilliseconds;
  if (!Number.isSafeInteger(retentionUntilMilliseconds)) {
    throw new RangeError('Deleted-Collection retention end must be an exact Unix-millisecond instant.');
  }
  const retentionUntil = new Date(retentionUntilMilliseconds);
  if (!Number.isFinite(Date.prototype.getTime.call(retentionUntil))) {
    throw new RangeError('Deleted-Collection retention end must be a valid date.');
  }

  const tombstone = Object.freeze({
    canonicalUrl,
    deletedAt: new Date(deletedAtMilliseconds).toISOString(),
    retentionUntil: retentionUntil.toISOString(),
    retentionMilliseconds,
  }) as PublicationDeletedCollectionTombstone;
  issuedTombstones.set(tombstone, Object.freeze({
    canonicalUrl,
    deletedAtMilliseconds,
    retentionUntilMilliseconds,
  }));
  return tombstone;
}

/**
 * Issues exactly one archive, migration-address, or Owner-page target. This
 * validates a link only; response creation never fetches or follows it.
 */
export function createPublicationDeletedCollectionRecoveryTarget(
  input: PublicationDeletedCollectionRecoveryTargetInput,
): PublicationDeletedCollectionRecoveryTarget {
  const values = inspectRecoveryTargetInput(input);
  const relation = RECOVERY_RELATIONS[values.kind];
  const target = Object.freeze({
    kind: values.kind,
    url: canonicalRecoveryTargetUrl(values.url),
    relation,
  }) as PublicationDeletedCollectionRecoveryTarget;
  issuedRecoveryTargets.set(target, Object.freeze({
    kind: target.kind,
    url: target.url,
    relation: target.relation,
  }));
  return target;
}

/**
 * Returns the retained 410 response, or null when another route should handle
 * the request. Matching is deliberately the exact URL serialization: queries,
 * alternate origins, and URL-normalization aliases do not inherit the tombstone.
 */
export function createPublicationDeletedCollectionGoneResponse(
  request: Request,
  tombstone: PublicationDeletedCollectionTombstone,
  clock: PublicationDeletedCollectionClock,
): Response | null {
  return createGoneResponse(request, tombstone, clock);
}

/**
 * Returns the retained 410 with one validated recovery target represented by
 * the same absolute relation and URL in both Problem.links and Link.
 */
export function createPublicationDeletedCollectionGoneResponseWithRecoveryTarget(
  request: Request,
  tombstone: PublicationDeletedCollectionTombstone,
  recoveryTarget: PublicationDeletedCollectionRecoveryTarget,
  clock: PublicationDeletedCollectionClock,
): Response | null {
  return createGoneResponse(request, tombstone, clock, issuedRecoveryTargetState(recoveryTarget));
}

function createGoneResponse(
  request: Request,
  tombstone: PublicationDeletedCollectionTombstone,
  clock: PublicationDeletedCollectionClock,
  recoveryTarget?: Readonly<{
    url: string;
    relation: (typeof RECOVERY_RELATIONS)[PublicationDeletedCollectionRecoveryKind];
  }>,
): Response | null {
  const state = issuedTombstoneState(tombstone);
  const safeRequest = cloneRequest(request);
  const method = safeRequest.method;
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (safeRequest.url !== state.canonicalUrl) return null;

  const nowMilliseconds = readClock(clock);
  /*
   * 410 is recomputed from persisted deletedAt/retentionUntil and this clock
   * reading only. The window is half-open [deletedAt, retentionUntil). A later
   * reading inside it returns 410 again; one sample is not stored expiry, and
   * reissue or process restart has no latch to keep. Before deletedAt, or at
   * or after retentionUntil, another route owns the request. GET and HEAD
   * share the window. Irreversible exit needs a persisted authority and a
   * trusted time, not one clock sample in this process.
   */
  if (
    nowMilliseconds < state.deletedAtMilliseconds
    || nowMilliseconds >= state.retentionUntilMilliseconds
  ) {
    return null;
  }

  const problemResponse = createPublicationProblemResponse({
    code: COLLECTION_DELETED_PROBLEM,
    status: 410,
    retryable: false,
    ...(recoveryTarget === undefined
      ? {}
      : { recovery: { links: { [recoveryTarget.relation]: recoveryTarget.url } } }),
  });
  const response = new Response(problemResponse.body, {
    status: problemResponse.status,
    statusText: 'Gone',
    headers: problemResponse.headers,
  });
  response.headers.set('cache-control', TOMBSTONE_CACHE_CONTROL);
  response.headers.set('referrer-policy', 'no-referrer');
  if (recoveryTarget !== undefined) {
    response.headers.set('link', `<${recoveryTarget.url}>; rel="${recoveryTarget.relation}"`);
  }
  if (method === 'GET') return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function inspectRecoveryTargetInput(input: PublicationDeletedCollectionRecoveryTargetInput): {
  readonly kind: PublicationDeletedCollectionRecoveryKind;
  readonly url: string;
} {
  if (
    typeof input !== 'object'
    || input === null
    || isProxy(input)
    || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError('Deleted-Collection recovery target input must be a plain object.');
  }
  const values: Partial<Record<'kind' | 'url', unknown>> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !RECOVERY_TARGET_INPUT_KEYS.has(key)) {
      throw new TypeError('Deleted-Collection recovery target input contains an unsupported property.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Deleted-Collection recovery target input.${key} must be an enumerable data property.`);
    }
    values[key as 'kind' | 'url'] = descriptor.value;
  }
  if (!Object.hasOwn(values, 'kind') || !Object.hasOwn(values, 'url')) {
    throw new TypeError('Deleted-Collection recovery target input requires exactly kind and url.');
  }
  if (typeof values.kind !== 'string' || !Object.hasOwn(RECOVERY_RELATIONS, values.kind)) {
    throw new TypeError('Deleted-Collection recovery target kind must be archive, migration, or owner.');
  }
  if (typeof values.url !== 'string') {
    throw new TypeError('Deleted-Collection recovery target url must be a string.');
  }
  return { kind: values.kind as PublicationDeletedCollectionRecoveryKind, url: values.url };
}

function canonicalRecoveryTargetUrl(value: string): string {
  if (
    value.length === 0
    || value.length > MAX_RECOVERY_TARGET_LENGTH
    || /[^\x21-\x7e]/u.test(value)
    || /%(?![0-9A-Fa-f]{2})/u.test(value)
    || /%(?:0[0-9A-F]|1[0-9A-F]|7F|8[0-9A-F]|9[0-9A-F])/iu.test(value)
    || /[<>"\\]/u.test(value)
  ) {
    throw new TypeError('Deleted-Collection recovery target must be a safe canonical HTTP(S) URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Deleted-Collection recovery target must be a safe canonical HTTP(S) URL.');
  }
  const loopback = parsed.hostname.toLowerCase() === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]';
  if (
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
    || parsed.hostname === ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.hash !== ''
    || parsed.href !== value
  ) {
    throw new TypeError(
      'Deleted-Collection recovery target must be canonical HTTPS or exact loopback HTTP without user information or a fragment.',
    );
  }
  return parsed.href;
}

function assertInput(input: PublicationDeletedCollectionTombstoneInput): void {
  if (
    typeof input !== 'object'
    || input === null
    || isProxy(input)
    || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError('Deleted-Collection tombstone input must be a plain object.');
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !INPUT_KEYS.has(key)) {
      throw new TypeError('Deleted-Collection tombstone input contains an unsupported property.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Deleted-Collection tombstone input.${key} must be an enumerable data property.`);
    }
  }
  for (const required of ['canonicalUrl', 'deletedAt'] as const) {
    if (!Object.hasOwn(input, required)) {
      throw new TypeError(`Deleted-Collection tombstone input.${required} is required.`);
    }
  }
}

function canonicalHttpUrl(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 8_192
    || /[^\x20-\x7e]/u.test(value)
    || /%(?![0-9A-Fa-f]{2})/u.test(value)
  ) {
    throw new TypeError('canonicalUrl must be a canonical absolute HTTP(S) URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('canonicalUrl must be a canonical absolute HTTP(S) URL.');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.hostname === ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.hash !== ''
    || parsed.href !== value
  ) {
    throw new TypeError('canonicalUrl must be a canonical absolute HTTP(S) URL without user information or a fragment.');
  }
  return parsed.href;
}

function validDateMilliseconds(value: unknown, label: string): number {
  if (typeof value !== 'object' || value === null || isProxy(value) || !(value instanceof Date)) {
    throw new TypeError(`${label} must be a valid Date.`);
  }
  let milliseconds: number;
  try {
    milliseconds = Date.prototype.getTime.call(value);
  } catch {
    throw new TypeError(`${label} must be a valid Date.`);
  }
  if (!Number.isSafeInteger(milliseconds)) throw new TypeError(`${label} must be a valid exact Unix-millisecond Date.`);
  return milliseconds;
}

function issuedTombstoneState(value: unknown): TombstoneState {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Deleted-Collection tombstone must have been created by this module.');
  }
  const state = issuedTombstones.get(value);
  if (state === undefined) throw new TypeError('Deleted-Collection tombstone must have been created by this module.');
  return state;
}

function issuedRecoveryTargetState(value: unknown): Readonly<{
  kind: PublicationDeletedCollectionRecoveryKind;
  url: string;
  relation: (typeof RECOVERY_RELATIONS)[PublicationDeletedCollectionRecoveryKind];
}> {
  if (typeof value !== 'object' || value === null || isProxy(value)) {
    throw new TypeError('Deleted-Collection recovery target must have been created by this module.');
  }
  const state = issuedRecoveryTargets.get(value);
  if (state === undefined) {
    throw new TypeError('Deleted-Collection recovery target must have been created by this module.');
  }
  return state;
}

function cloneRequest(value: unknown): Request {
  if (typeof value !== 'object' || value === null || isProxy(value)) throw new TypeError('request must be a Fetch Request.');
  try {
    return Request.prototype.clone.call(value) as Request;
  } catch {
    throw new TypeError('request must be an unused Fetch Request.');
  }
}

function readClock(clock: PublicationDeletedCollectionClock): number {
  if (typeof clock !== 'object' || clock === null || isProxy(clock)) throw new TypeError('clock must provide now().');
  let descriptor: ((...arguments_: never[]) => unknown) | undefined;
  try {
    descriptor = findDataMethod(clock, 'now');
  } catch {
    throw new TypeError('clock must provide now().');
  }
  if (descriptor === undefined) throw new TypeError('clock must provide a data-method now().');
  let now: unknown;
  try {
    now = Reflect.apply(descriptor, clock, []);
  } catch {
    throw new TypeError('clock.now() must return a valid Date.');
  }
  return validDateMilliseconds(now, 'clock.now()');
}

function findDataMethod(value: object, key: string): ((...arguments_: never[]) => unknown) | undefined {
  let owner: object | null = value;
  let depth = 0;
  while (owner !== null) {
    if (depth > 32 || isProxy(owner)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor !== undefined) {
      return 'value' in descriptor && typeof descriptor.value === 'function'
        ? descriptor.value as (...arguments_: never[]) => unknown
        : undefined;
    }
    owner = Object.getPrototypeOf(owner) as object | null;
    depth += 1;
  }
  return undefined;
}
