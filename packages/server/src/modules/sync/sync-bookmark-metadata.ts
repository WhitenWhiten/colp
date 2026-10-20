import { validateBookmarkUrlHashSemantics } from '@know-n/colp/semantic';
import { deepEqualSyncMergeValue } from '@know-n/colp/sync';
import { isEquivalentBookmarkUrlRewrite } from '../collections/index.js';

/** Validate a hash the client actually authored against its original URL bytes.
 * A hash supplied only by Current during the merge is not an incoming edit. */
export function validIncomingBookmarkUrlHash(base: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>, originalUrl: unknown): boolean {
  if (!Object.hasOwn(incoming, 'urlHash') || incoming.urlHash === null
      || deepEqualSyncMergeValue(base.urlHash ?? null, incoming.urlHash)) return true;
  return validateBookmarkUrlHashSemantics({
    url: Object.hasOwn(incoming, 'url') ? incoming.url : originalUrl,
    urlHash: incoming.urlHash,
  }).valid;
}

/** Preserve the server's spelling of an equivalent URL and its valid digest.
 * Explicit null clears remain clears. Invalid digests are left for strict
 * result validation, never silently repaired by the spelling pin. */
export function pinEquivalentSyncBookmarkMetadata(current: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (typeof current.url !== 'string' || typeof fields.url !== 'string'
      || !isEquivalentBookmarkUrlRewrite(current.url, fields.url)) return fields;
  const pinned: Record<string, unknown> = { ...fields, url: current.url };
  if (typeof fields.urlHash === 'string'
      && !validateBookmarkUrlHashSemantics({ url: current.url, urlHash: fields.urlHash }).valid
      && validateBookmarkUrlHashSemantics({ url: fields.url, urlHash: fields.urlHash }).valid) {
    if (typeof current.urlHash === 'string') pinned.urlHash = current.urlHash;
    else delete pinned.urlHash;
  }
  return Object.freeze(pinned);
}
