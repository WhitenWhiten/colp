/**
 * T02 cache contract: canonical query hash and Redis key builders.
 *
 * Query hashing reuses the repository-wide `canonicalJson` helper
 * (src/modules/commands/application/receipt.ts) plus node:crypto SHA-256 —
 * the cache module does not copy a sorting/encoding algorithm. The key layout
 * follows plan §4.1:
 *
 *   <prefix>:<env>:cache:v<schemaVersion>:<domainTag>:<locator>:epoch   (publication)
 *   <prefix>:<env>:cache:v<schemaVersion>:<domainTag>:epoch             (directory)
 *   <prefix>:<env>:cache:v<schemaVersion>:<domainTag>:<projection>:<epoch>:<queryHash>
 *
 * `{...}` domain tags are Redis Cluster hash tags so an epoch, its data keys
 * and its lock share one slot. Publication scopes carry a locator kind
 * (`pubid`/`pubslug`) that namespaces the epoch key text and the query-hash
 * input, so a collection ID and an unrelated slug that happen to share a
 * string never share an epoch or a data key. Collection bookmark-count uses
 * `{col:<collectionId>}`, never `{pub:...}`. The key builder is fail-closed:
 * it rejects empty/control-char/overlong IDs, invalid namespace parts, and
 * queries that did not pass normalization (raw whitespace, newlines, control
 * characters and URLs never reach the key text). Anonymous keys never carry
 * principalId.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../modules/commands/index.js';
import { CACHE_SCHEMA_VERSION } from './cache-envelope.js';
import { isRecord } from './cache-guards.js';

/** Version of the query-hash input contract (independent of CACHE_SCHEMA_VERSION). */
export const CACHE_QUERY_HASH_PROTOCOL_VERSION = 1;

/** Projection segment values used by Publication and collection bookmark-count domains. */
export const CACHE_PROJECTION = Object.freeze({
  PUBLICATION_METADATA: 'metadata',
  PUBLICATION_SNAPSHOT: 'snapshot',
  PUBLICATION_DIRECTORY_PAGE: 'page',
  COLLECTION_BOOKMARK_COUNT: 'bookmark-count',
  REPORT: 'report',
  REPORT_ISSUES: 'report-issues',
  REPORT_DIRECTORY: 'report-directory',
});

/**
 * Cache key scope. Publication domains scope by collection (and are pinned to
 * one cluster slot via `{pub:<collectionId>}`); the locator kind (`pubid` /
 * `pubslug`) namespaces the epoch and the query hash so an ID lookup and an
 * unrelated slug that happen to share a string never share an epoch. Directory
 * is a single global scope `{publication-directory}`. Collection bookmark-count
 * scopes by collection via `{col:<collectionId>}` (not `{pub:...}`) and does
 * not rotate epoch; data keys still use the epoch segment, fixed at `0`.
 */
export type CacheKeyDomain =
  | { readonly kind: 'publication'; readonly locator: 'pubid' | 'pubslug'; readonly collectionId: string }
  | { readonly kind: 'publication-directory' }
  | { readonly kind: 'collection-bookmark-count'; readonly collectionId: string }
  | { readonly kind: 'report'; readonly slug: string }
  | { readonly kind: 'report-directory' };


/** A query that passed `normalizeCacheQuery`. */
export type CacheNormalizedQuery = Readonly<Record<string, unknown>>;

export type CacheQueryRejectReason =
  | 'not_plain_object'
  | 'invalid_key'
  | 'forbidden_principal_key'
  | 'invalid_value'
  | 'contains_control_character'
  | 'contains_url';

export type CacheNormalizeResult =
  | { readonly kind: 'ok'; readonly query: CacheNormalizedQuery }
  | { readonly kind: 'rejected'; readonly reason: CacheQueryRejectReason };

export type CacheKeyRejectReason =
  | 'empty_id'
  | 'invalid_id_character'
  | 'id_too_long'
  | 'invalid_environment'
  | 'invalid_key_prefix'
  | 'invalid_schema_version'
  | 'invalid_protocol_version'
  | 'invalid_epoch'
  | 'invalid_projection'
  | 'unnormalized_query';

/** Programmer-error guard used by the key builders (never an HTTP error). */
export class CacheKeyError extends Error {
  readonly reason: CacheKeyRejectReason;
  constructor(reason: CacheKeyRejectReason, message: string) {
    super(message);
    this.name = 'CacheKeyError';
    this.reason = reason;
  }
}

const ID_CHARACTER_PATTERN = /^[A-Za-z0-9_.:-]+$/u;
const ID_MAX_LENGTH = 128;
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;
const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const PROJECTION_PATTERN = /^[a-z0-9_-]{1,32}$/u;
const QUERY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/u;
const URL_SCHEME_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

/**
 * Principal/identity keys that are forbidden in an anonymous normalized query.
 * Anonymous public cache keys must never carry principal identity, so a query
 * that smuggles one is rejected instead of silently hashed into the key.
 */
const FORBIDDEN_QUERY_PRINCIPAL_KEYS = new Set<string>([
  'principalId',
  'subjectId',
  'ownerSubjectId',
  'ownerId',
  'creatorSubjectId',
  'creatorId',
  'authorization',
  'cookie',
  'sessionToken',
  'session',
]);

function findValueViolation(value: unknown, seen = new Set<unknown>()): CacheQueryRejectReason | null {
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'invalid_value';
  if (typeof value === 'string') {
    if (CONTROL_CHARACTER_PATTERN.test(value)) return 'contains_control_character';
    if (URL_SCHEME_PATTERN.test(value)) return 'contains_url';
    return null;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return 'invalid_value';
    seen.add(value);
    for (const item of value) {
      const violation = findValueViolation(item, seen);
      if (violation !== null) return violation;
    }
    return null;
  }
  if (isRecord(value)) {
    if (seen.has(value)) return 'invalid_value';
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (!QUERY_KEY_PATTERN.test(key)) return 'invalid_key';
      if (FORBIDDEN_QUERY_PRINCIPAL_KEYS.has(key)) return 'forbidden_principal_key';
    }
    for (const item of Object.values(value)) {
      const violation = findValueViolation(item, seen);
      if (violation !== null) return violation;
    }
    return null;
  }
  return 'invalid_value';
}

/**
 * Validates and canonicalizes a raw query into a `CacheNormalizedQuery`.
 * Rejects non-object input, unsafe keys, principal/auth keys, non-JSON values,
 * control characters and raw URLs. Returned queries are safe inputs for the
 * query hash; the same predicate guards the key builder.
 */
export function normalizeCacheQuery(input: unknown): CacheNormalizeResult {
  if (!isRecord(input)) return { kind: 'rejected', reason: 'not_plain_object' };
  for (const key of Object.keys(input)) {
    if (!QUERY_KEY_PATTERN.test(key)) return { kind: 'rejected', reason: 'invalid_key' };
    if (FORBIDDEN_QUERY_PRINCIPAL_KEYS.has(key)) return { kind: 'rejected', reason: 'forbidden_principal_key' };
  }
  const violation = findValueViolation(input);
  if (violation !== null) return { kind: 'rejected', reason: violation };
  return { kind: 'ok', query: input as CacheNormalizedQuery };
}

function assertCollectionId(id: string, label: string): void {
  if (id.length === 0) throw new CacheKeyError('empty_id', `${label} must not be empty`);
  if (id.length > ID_MAX_LENGTH) throw new CacheKeyError('id_too_long', `${label} exceeds ${ID_MAX_LENGTH} characters`);
  if (!ID_CHARACTER_PATTERN.test(id)) {
    throw new CacheKeyError('invalid_id_character', `${label} contains control characters or unsupported characters`);
  }
}

function domainTag(domain: CacheKeyDomain): string {
  switch (domain.kind) {
    case 'publication':
      assertCollectionId(domain.collectionId, 'publication collectionId');
      return `{pub:${domain.collectionId}}`;
    case 'collection-bookmark-count':
      assertCollectionId(domain.collectionId, 'collection-bookmark-count collectionId');
      return `{col:${domain.collectionId}}`;
    case 'publication-directory':
      return '{publication-directory}';
    case 'report':
      assertReportSlug(domain.slug);
      return `{report:${domain.slug}}`;
    case 'report-directory':
      return '{report-directory}';
  }
}

function assertReportSlug(slug: string): void {
  if (slug.length === 0) throw new CacheKeyError('empty_id', 'report slug must not be empty');
  if (slug.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    throw new CacheKeyError('invalid_id_character', 'report slug is not canonical');
  }
}

function domainHashInput(domain: CacheKeyDomain): unknown {
  switch (domain.kind) {
    case 'publication':
      return { kind: 'publication', locator: domain.locator, collectionId: domain.collectionId };
    case 'collection-bookmark-count':
      return { kind: 'collection-bookmark-count', collectionId: domain.collectionId };
    case 'publication-directory':
      return { kind: 'publication-directory' };
    case 'report':
      return { kind: 'report', slug: domain.slug };
    case 'report-directory':
      return { kind: 'report-directory' };
  }
}

function epochKeyScope(domain: CacheKeyDomain): string {
  switch (domain.kind) {
    case 'publication':
      return `${domain.locator}:epoch`;
    case 'collection-bookmark-count':
    case 'publication-directory':
      return 'epoch';
    case 'report':
      return 'epoch';
    case 'report-directory':
      return 'epoch';
  }
}

function assertSchemaVersion(schemaVersion: number): void {
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 99) {
    throw new CacheKeyError('invalid_schema_version', 'cache schema version must be a safe integer in 1..99');
  }
}

function assertProtocolVersion(protocolVersion: number): void {
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1) {
    throw new CacheKeyError('invalid_protocol_version', 'query hash protocol version must be a positive safe integer');
  }
}

export interface CacheQueryHashInput {
  readonly domain: CacheKeyDomain;
  readonly projection: string;
  readonly query: CacheNormalizedQuery;
  readonly schemaVersion?: number;
  readonly protocolVersion?: number;
}

/**
 * Stable SHA-256/base64url digest over canonical JSON of
 * {protocolVersion, schemaVersion, domain, projection, query}. Field order in
 * the query is irrelevant because canonicalJson sorts keys; raw URLs, cookies,
 * authorization and principal objects never enter the hash because the query
 * must already be normalized.
 */
export function cacheQueryHash(input: CacheQueryHashInput): string {
  const schemaVersion = input.schemaVersion ?? CACHE_SCHEMA_VERSION;
  const protocolVersion = input.protocolVersion ?? CACHE_QUERY_HASH_PROTOCOL_VERSION;
  assertSchemaVersion(schemaVersion);
  assertProtocolVersion(protocolVersion);
  domainTag(input.domain); // validates collection identity
  if (!PROJECTION_PATTERN.test(input.projection)) {
    throw new CacheKeyError('invalid_projection', 'projection must be 1-32 lowercase [a-z0-9_-] characters');
  }
  const canonical = canonicalJson({
    protocolVersion,
    schemaVersion,
    domain: domainHashInput(input.domain),
    projection: input.projection,
    query: input.query,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

export interface CacheKeyOptions {
  readonly environment: string;
  readonly keyPrefix?: string;
  readonly schemaVersion?: number;
}

export interface CacheEpochKeyInput extends CacheKeyOptions {
  readonly domain: CacheKeyDomain;
}

export interface CacheDataKeyInput extends CacheKeyOptions {
  readonly domain: CacheKeyDomain;
  readonly projection: string;
  readonly epoch: number;
  readonly query: CacheNormalizedQuery;
}

function assertKeyContext(options: CacheKeyOptions): { prefix: string; environment: string; schemaVersion: number } {
  const prefix = options.keyPrefix ?? 'known';
  if (!KEY_PREFIX_PATTERN.test(prefix)) {
    throw new CacheKeyError('invalid_key_prefix', 'key prefix must be 1-64 chars, start alphanumeric, and use only [A-Za-z0-9_.:-]');
  }
  if (!ENVIRONMENT_PATTERN.test(options.environment)) {
    throw new CacheKeyError('invalid_environment', 'environment must be 1-64 chars of [A-Za-z0-9_.:-]');
  }
  const schemaVersion = options.schemaVersion ?? CACHE_SCHEMA_VERSION;
  assertSchemaVersion(schemaVersion);
  return { prefix, environment: options.environment, schemaVersion };
}

/**
 * Builds the epoch key for a cache scope. Epoch rotation (T03) uses this key
 * with an atomic INCR + PEXPIRE script. Publication scopes embed the locator
 * kind (`pubid`/`pubslug`) so the ID-scoped and slug-scoped epochs of the same
 * string are distinct keys that still share one cluster slot; the Directory
 * epoch key is unchanged. Collection bookmark-count does not rotate epoch, but
 * the builder still returns a `{col:<id>}` epoch key so callers do not throw.
 */
export function buildCacheEpochKey(input: CacheEpochKeyInput): string {
  const { prefix, environment, schemaVersion } = assertKeyContext(input);
  const tag = domainTag(input.domain);
  return `${prefix}:${environment}:cache:v${schemaVersion}:${tag}:${epochKeyScope(input.domain)}`;
}

/**
 * Builds the data key for one projection+epoch+query. Rejects empty/control/
 * overlong collection IDs, invalid namespace parts, invalid epoch/projection,
 * and any query that did not pass normalization, so raw whitespace, newlines,
 * control characters and URLs can never appear in the key.
 */
export function buildCacheDataKey(input: CacheDataKeyInput): string {
  const { prefix, environment, schemaVersion } = assertKeyContext(input);
  const tag = domainTag(input.domain);
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) {
    throw new CacheKeyError('invalid_epoch', 'epoch must be a non-negative safe integer');
  }
  if (!PROJECTION_PATTERN.test(input.projection)) {
    throw new CacheKeyError('invalid_projection', 'projection must be 1-32 lowercase [a-z0-9_-] characters');
  }
  const normalized = normalizeCacheQuery(input.query);
  if (normalized.kind !== 'ok') {
    throw new CacheKeyError('unnormalized_query', 'query must be normalized before it can be hashed into a cache key');
  }
  const queryHash = cacheQueryHash({
    domain: input.domain,
    projection: input.projection,
    query: normalized.query,
    schemaVersion,
  });
  return `${prefix}:${environment}:cache:v${schemaVersion}:${tag}:${input.projection}:${input.epoch}:${queryHash}`;
}
