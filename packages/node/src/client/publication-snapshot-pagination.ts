import LinkHeader from 'http-link-header';

import type { ValidatorRegistry } from '../schema/index.js';
import { parseProtocolQuery } from '../shared/query.js';

export interface PublicationSnapshotNextLinkInput {
  readonly currentUrl: URL;
  readonly initialUrl: URL;
  readonly linkHeader: string | null;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly validators: ValidatorRegistry;
}

export const MAX_PUBLICATION_LINK_HEADER_BYTES = 64 * 1024;

/**
 * Count UTF-8 bytes without allocating an encoded copy.  The early return is
 * intentional: an untrusted header that is already over the limit must not be
 * scanned or materialized in full before it is rejected.  Lone UTF-16
 * surrogates follow TextEncoder's replacement-character (three-byte) rule.
 */
function utf8ByteLength(value: string, limit: number): number {
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

/** Selects and scope-checks the sole server-provided Publication Snapshot continuation. */
export function publicationSnapshotNextUrl(input: PublicationSnapshotNextLinkInput): URL | undefined {
  if (input.linkHeader !== null
    && utf8ByteLength(input.linkHeader, MAX_PUBLICATION_LINK_HEADER_BYTES) > MAX_PUBLICATION_LINK_HEADER_BYTES) {
    throw new TypeError('Snapshot Link header exceeds the supported byte limit.');
  }
  const nextLinks = input.linkHeader === null ? [] : LinkHeader.parse(input.linkHeader).rel('next');
  if (!input.hasMore) {
    if (nextLinks.length > 0) throw new TypeError('Final Snapshot page unexpectedly supplies rel=next.');
    return undefined;
  }
  if (nextLinks.length !== 1 || nextLinks[0]?.uri === undefined) {
    throw new TypeError('Paginated Snapshot response must supply exactly one rel=next URL.');
  }

  const next = new URL(nextLinks[0].uri, input.currentUrl);
  if (next.hash !== '') throw new TypeError('Snapshot rel=next URL must not contain a fragment.');
  assertPublicationContinuationTransport(next);

  const cursors = next.searchParams.getAll('pageCursor');
  if (cursors.length !== 1 || cursors[0] !== input.nextCursor) {
    throw new TypeError('Snapshot rel=next pageCursor does not match page.nextCursor.');
  }

  const initialQuery = parseProtocolQuery('snapshotQuery', input.initialUrl.searchParams, input.validators);
  const nextQuery = parseProtocolQuery('snapshotQuery', next.searchParams, input.validators);
  if (!initialQuery.valid) {
    throw new TypeError(`Snapshot rel=next query is invalid: ${initialQuery.errors[0]}`);
  }
  if (!nextQuery.valid) {
    throw new TypeError(`Snapshot rel=next query is invalid: ${nextQuery.errors[0]}`);
  }

  assertSameScalar(initialQuery.value, nextQuery.value, 'root');
  assertSameScalar(initialQuery.value, nextQuery.value, 'depth');
  assertSameScalar(initialQuery.value, nextQuery.value, 'limit');
  assertSameIncludeSet(initialQuery.value.include, nextQuery.value.include);
  return next;
}

/**
 * Keep the exported Link parser safe on its own. ColpClient applies the same
 * check again immediately before fetch, but callers may use this helper to
 * inspect a server response without going through the client transport layer.
 */
function assertPublicationContinuationTransport(url: URL): void {
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('Snapshot rel=next URL must not contain user information.');
  }
  if (url.protocol === 'https:') return;
  if (
    url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
  ) return;
  throw new TypeError('Snapshot rel=next URL violates the Publication transport policy.');
}

function assertSameScalar(
  initial: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
  name: 'root' | 'depth' | 'limit',
): void {
  if (initial[name] !== next[name]) {
    throw new TypeError(`Snapshot rel=next changes the original ${name} query context.`);
  }
}

function assertSameIncludeSet(initial: unknown, next: unknown): void {
  const initialValues = Array.isArray(initial) ? initial : [];
  const nextValues = Array.isArray(next) ? next : [];
  if (
    initialValues.length !== nextValues.length
    || initialValues.some((value) => !nextValues.includes(value))
  ) {
    throw new TypeError('Snapshot rel=next changes the original include query context.');
  }
}
