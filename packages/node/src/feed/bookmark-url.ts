import { isProxy } from 'node:util/types';

import { isHttpUrl } from '../schema/uri.js';
import { immutableJsonSnapshot } from '../shared/immutable-json.js';
import type { FeedNode } from '../types/index.js';

export type FeedBookmarkProjection =
  | { readonly outcome: 'keep'; readonly url: string }
  | { readonly outcome: 'omit' }
  | { readonly outcome: 'redact'; readonly redacted: true };

const REDACTED_BOOKMARK_TARGET_FIELDS = Object.freeze([
  'url',
  'canonicalUrl',
  'urlHash',
] as const);

/**
 * Projects a Bookmark navigation URL for Feed wire (FEED-0010).
 *
 * Safe absolute HTTP(S) URLs without Authority userinfo are kept verbatim.
 * Unsafe targets are omitted or replaced with a redacted summary that does not
 * carry the original target URL.
 */
export function projectFeedBookmarkUrl(
  url: unknown,
  options: { readonly mode?: 'omit' | 'redact' } = {},
): FeedBookmarkProjection {
  const mode = options.mode ?? 'omit';
  if (isHttpUrl(url)) {
    return Object.freeze({ outcome: 'keep', url });
  }
  if (mode === 'redact') {
    return Object.freeze({ outcome: 'redact', redacted: true as const });
  }
  return Object.freeze({ outcome: 'omit' });
}

/**
 * Projects a `feedNode` Bookmark field for outbound Feed events.
 *
 * Non-bookmark kinds are returned unchanged (deep-cloned plain data). Bookmark
 * nodes with unsafe URLs lose the target URL (omit) or set `redacted: true`
 * without embedding the unsafe target.
 */
export function projectFeedNodeBookmark(
  node: unknown,
  options: { readonly mode?: 'omit' | 'redact' } = {},
): FeedNode {
  if (!isPlainObject(node)) {
    throw new TypeError('Feed node must be a plain object.');
  }
  if (Reflect.ownKeys(node).some((key) => typeof key === 'symbol')) {
    throw new TypeError('Feed node must not contain symbol keys.');
  }

  const kind = node.kind;
  if (kind !== 'bookmark') {
    // The caller may supply an accessor-bearing plain object.  structuredClone
    // would invoke those getters; the bounded protocol snapshot already gives
    // us a detached, immutable graph without executing caller code.
    return immutableJsonSnapshot(node, 'Feed node projection') as unknown as FeedNode;
  }

  // FeedNode projection deliberately omits authoritative visibility fields.
  // Reject a restricted source before that omission can turn a private
  // Bookmark into an apparently public summary (including redacted ones).
  const sourceVisibility = (node as Record<string, unknown>).visibility;
  if (sourceVisibility === 'private' || sourceVisibility === 'protected' || sourceVisibility === 'unlisted') {
    throw new TypeError('Restricted Feed Bookmark cannot be projected anonymously.');
  }

  const projected: Record<string, unknown> = {
    id: node.id,
    kind: 'bookmark',
  };
  if (typeof node.title === 'string') projected.title = node.title;
  if (node.redacted === true) {
    return createRedactedFeedBookmark(projected);
  }

  if (node.url === undefined) {
    return Object.freeze(projected) as unknown as FeedNode;
  }

  const decision = projectFeedBookmarkUrl(node.url, options);
  if (decision.outcome === 'keep') {
    projected.url = decision.url;
    return Object.freeze(projected) as unknown as FeedNode;
  }
  if (decision.outcome === 'redact') {
    return createRedactedFeedBookmark(projected);
  }
  // omit: drop url, do not invent redacted unless caller asked
  return Object.freeze(projected) as unknown as FeedNode;
}

/** Asserts a non-redacted Feed Bookmark has only a publication-safe navigation URL. */
export function assertNonRedactedFeedBookmarkUrl(node: unknown): void {
  if (!isPlainObject(node) || node.kind !== 'bookmark' || node.redacted === true) return;
  if (node.url !== undefined && !isHttpUrl(node.url)) {
    throw new TypeError('Feed Bookmark navigation URL is unsafe.');
  }
}

/** Asserts a redacted Feed Bookmark contains no target or target-derived fields. */
export function assertRedactedFeedBookmarkShape(node: unknown): void {
  if (!isPlainObject(node) || node.kind !== 'bookmark' || node.redacted !== true) return;
  for (const field of REDACTED_BOOKMARK_TARGET_FIELDS) {
    if (Object.hasOwn(node, field)) {
      throw new TypeError(`Redacted Feed Bookmark must not contain ${field}.`);
    }
  }
}

/** Asserts every Bookmark target shape in a Feed event data payload is safe. */
export function assertFeedEventBookmarkUrls(eventData: unknown): void {
  if (!isPlainObject(eventData)) return;
  const node = eventData.node;
  assertRedactedFeedBookmarkShape(node);
  assertNonRedactedFeedBookmarkUrl(node);
}

function createRedactedFeedBookmark(projected: Record<string, unknown>): FeedNode {
  const redacted = { ...projected, redacted: true as const };
  assertRedactedFeedBookmarkShape(redacted);
  return Object.freeze(redacted) as unknown as FeedNode;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
