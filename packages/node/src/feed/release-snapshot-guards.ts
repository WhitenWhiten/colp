import { isPrivateOrLocalLiteralHostname } from '../shared/private-or-local-literal-host.js';
import { isHttpUrl } from '../schema/uri.js';

/** Structured Field style digest: `sha-256=:<standard-base64>:` (32-byte SHA-256). */
export const RELEASE_SNAPSHOT_DIGEST_PATTERN = /^sha-256=:[A-Za-z0-9+/]{43}=:$/u;

export interface ReleaseSnapshotPathIds {
  readonly collectionId: string;
  readonly releaseId: string;
}

/**
 * Transport/host policy for Snapshot and expired-cursor recovery URLs.
 *
 * Requires an absolute HTTPS URL without credentials whose literal host is
 * not localhost, a private/local address, or a cloud-metadata endpoint
 * (`169.254.169.254`). This is the same pure literal-host policy the Sync
 * effect-page guard applies; it performs no DNS resolution, so non-literal
 * hostnames remain the fetching host's responsibility.
 */
export function isSafeSnapshotHttpsUrl(url: unknown): url is string {
  if (!isHttpUrl(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:'
    && parsed.username === ''
    && parsed.password === ''
    && !isPrivateOrLocalLiteralHostname(parsed.hostname);
}

/**
 * Parses an immutable release snapshot path without allowing WHATWG URL
 * dot-segment normalization to hide the original path. Query strings are
 * intentionally ignored; fragments are never valid for HTTPS snapshots.
 * Cleartext `http:` and local/private/metadata hosts are rejected.
 */
export function parseImmutableReleaseSnapshotPath(
  url: unknown,
): ReleaseSnapshotPathIds | undefined {
  if (!isSafeSnapshotHttpsUrl(url)) return undefined;

  const value = url;
  // A fragment is never part of the resource identity and is rejected even
  // when it is empty (`#`).
  const fragmentIndex = value.indexOf('#');
  if (fragmentIndex >= 0) return undefined;
  const queryIndex = value.indexOf('?');
  const pathEnd = queryIndex >= 0 ? queryIndex : value.length;

  // Preserve the escaped path from the caller before WHATWG URL processing.
  const authority = /^https:\/\/[^/?#]*/iu.exec(value);
  if (authority === null) return undefined;
  const rawPath = value.slice(authority[0].length, pathEnd);
  if (rawPath.length === 0 || !rawPath.startsWith('/')) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    return undefined;
  }
  // URL.pathname is normalized by WHATWG (notably for literal dot segments).
  // A byte-for-byte match proves that no such normalization occurred.
  if (parsed.pathname !== rawPath) return undefined;

  const segments = rawPath.split('/');
  if (
    segments.length < 6
    || segments.some((segment, index) => index > 0 && segment.length === 0)
  ) {
    return undefined;
  }

  // Decode every segment once to reject encoded separators and dot segments.
  const decoded: string[] = [];
  for (const segment of segments) {
    let valueDecoded: string;
    try {
      valueDecoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (valueDecoded.includes('/') || valueDecoded.includes('\\')) return undefined;
    if (valueDecoded === '.' || valueDecoded === '..') return undefined;
    decoded.push(valueDecoded);
  }

  const tail = segments.length - 5;
  if (
    segments[tail] !== 'c'
    || segments[tail + 2] !== 'releases'
    || segments[tail + 4] !== 'snapshot'
  ) {
    return undefined;
  }

  const collectionId = decoded[tail + 1];
  const releaseId = decoded[tail + 3];
  if (
    collectionId === undefined
    || releaseId === undefined
    || collectionId.length === 0
    || releaseId.length === 0
  ) {
    return undefined;
  }

  // IDs are opaque protocol identifiers. Re-encoding after one decode must
  // reproduce the original escaped spelling, preventing ambiguous aliases
  // such as `%2E`, `%2F`, or non-canonical percent escapes.
  try {
    if (encodeURIComponent(collectionId) !== segments[tail + 1]) return undefined;
    if (encodeURIComponent(releaseId) !== segments[tail + 3]) return undefined;
  } catch {
    return undefined;
  }

  return Object.freeze({ collectionId, releaseId });
}

/**
 * Validates an absolute HTTPS URL targeting an immutable release snapshot
 * whose literal host is not local/private/metadata. Query parameters are
 * allowed but never participate in path identity.
 */
export function isImmutableReleaseSnapshotUrl(url: unknown): boolean {
  return parseImmutableReleaseSnapshotPath(url) !== undefined;
}

/** True when digest matches the wire `sha-256=:<base64>:` shape (FEED-0004). */
export function isReleaseSnapshotDigest(digest: unknown): boolean {
  return typeof digest === 'string' && RELEASE_SNAPSHOT_DIGEST_PATTERN.test(digest);
}
