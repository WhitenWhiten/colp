import { createHash, timingSafeEqual } from 'node:crypto';

import type { GlobalResourceIdentity, UrlHash } from '../types/generated.js';
import { sameGlobalResourceIdentity } from './resource-identity.js';

const URL_HASH_PREFIX = 'sha-256=:';
const URL_HASH_SUFFIX = ':';
const URL_HASH_LENGTH = 54;
// A 32-octet digest has 42 full Base64 characters and a final sextet with two zero pad bits.
const URL_HASH_PATTERN = /^sha-256=:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=:$/;

/** Compute the protocol URL hash over the exact UTF-8 bytes of the preserved URL string. */
export function createUrlHash(url: string): UrlHash {
  if (typeof url !== 'string') {
    throw new TypeError('URL hash input must be a string.');
  }
  return `${URL_HASH_PREFIX}${createHash('sha256').update(url, 'utf8').digest('base64')}${URL_HASH_SUFFIX}`;
}

/** Return whether a syntactically valid URL hash matches the exact preserved URL string. */
export function urlHashMatches(url: string, urlHash: unknown): boolean {
  if (!isUrlHash(urlHash)) return false;
  const expected = Buffer.from(createUrlHash(url));
  const actual = Buffer.from(urlHash);
  return timingSafeEqual(expected, actual);
}

/**
 * Compare two URL-hash hints as a deduplication pre-filter.
 *
 * `true` means only that both hints are present, syntactically valid, and equal. The
 * corresponding objects are candidates for later URL, content, and Collection-semantic
 * comparison; the result neither proves they are duplicates nor selects a winner. In
 * particular, it is not an object-identity comparison: distinct protocol IDs and global
 * resource identity tuples remain distinct when this function returns `true`.
 *
 * This comparison does not verify that either hint is current or matches its preserved URL.
 * Callers must validate each hint against its own URL with `urlHashMatches` (or the semantic
 * Bookmark validators) before using this candidate signal.
 */
export function areUrlHashDeduplicationCandidates(
  left: unknown,
  right: unknown,
): boolean {
  if (!isUrlHash(left) || !isUrlHash(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export interface UrlHashDeduplicationInput {
  readonly url: string;
  readonly urlHash?: unknown;
}

export interface UrlHashDeduplicationSemantics<Left, Right> {
  readonly contentMatches: (left: Left, right: Right) => boolean;
  readonly collectionMatches: (left: Left, right: Right) => boolean;
}

export type UrlHashDeduplicationDecision = Readonly<{
  hashCandidate: boolean;
  semanticMatch: boolean;
  reason:
    | 'hash_not_candidate'
    | 'hash_not_current'
    | 'url_mismatch'
    | 'content_mismatch'
    | 'collection_mismatch'
    | 'semantic_match';
}>;

/**
 * Evaluate the complete URL-hash candidate pipeline without conflating it with identity.
 * Expensive content and Collection semantics run only after both hints are current and the
 * exact preserved URLs match. A semantic match is still not proof that two IDs name one object.
 */
export function evaluateUrlHashDeduplication<
  Left extends UrlHashDeduplicationInput,
  Right extends UrlHashDeduplicationInput,
>(
  left: Left,
  right: Right,
  semantics: UrlHashDeduplicationSemantics<Left, Right>,
): UrlHashDeduplicationDecision {
  if (!areUrlHashDeduplicationCandidates(left.urlHash, right.urlHash)) {
    return decision(false, false, 'hash_not_candidate');
  }
  if (left.url !== right.url) return decision(true, false, 'url_mismatch');
  if (!urlHashMatches(left.url, left.urlHash) || !urlHashMatches(right.url, right.urlHash)) {
    return decision(true, false, 'hash_not_current');
  }
  if (!semantics.contentMatches(left, right)) return decision(true, false, 'content_mismatch');
  if (!semantics.collectionMatches(left, right)) {
    return decision(true, false, 'collection_mismatch');
  }
  return decision(true, true, 'semantic_match');
}

export type UrlHashIdentityDecision = Readonly<{
  hashCandidate: boolean;
  sameObject: boolean;
}>;

/** Compare the independent hash-candidate and global-identity decisions side by side. */
export function compareUrlHashCandidateIdentity(
  leftHash: unknown,
  rightHash: unknown,
  leftIdentity: GlobalResourceIdentity,
  rightIdentity: GlobalResourceIdentity,
): UrlHashIdentityDecision {
  return Object.freeze({
    hashCandidate: areUrlHashDeduplicationCandidates(leftHash, rightHash),
    sameObject: sameGlobalResourceIdentity(leftIdentity, rightIdentity),
  });
}

function decision(
  hashCandidate: boolean,
  semanticMatch: boolean,
  reason: UrlHashDeduplicationDecision['reason'],
): UrlHashDeduplicationDecision {
  return Object.freeze({ hashCandidate, semanticMatch, reason });
}

export function isUrlHash(value: unknown): value is UrlHash {
  return (
    typeof value === 'string' &&
    value.length === URL_HASH_LENGTH &&
    URL_HASH_PATTERN.test(value)
  );
}
