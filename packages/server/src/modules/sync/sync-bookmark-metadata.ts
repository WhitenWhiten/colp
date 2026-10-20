import { validateBookmarkUrlHashSemantics } from '@know-n/colp/semantic';
import { deepEqualSyncMergeValue } from '@know-n/colp/sync';
import { invalidateOmittedBookmarkUrlMetadata, isEquivalentBookmarkUrlRewrite } from '../collections/index.js';

/** Validate a hash the client actually authored against its original URL bytes.
 * A hash supplied only by Current during the merge is not an incoming edit. */
export function validIncomingBookmarkUrlHash(base: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>, originalUrl: unknown): boolean {
  if (!Object.hasOwn(incoming, 'urlHash') || incoming.urlHash === null) return true;
  if (deepEqualSyncMergeValue(base.urlHash ?? null, incoming.urlHash)
      && (!Object.hasOwn(incoming, 'url') || incoming.url === originalUrl
        || (typeof originalUrl === 'string' && typeof incoming.url === 'string'
          && isEquivalentBookmarkUrlRewrite(originalUrl, incoming.url)))) return true;
  return validateBookmarkUrlHashSemantics({
    url: Object.hasOwn(incoming, 'url') ? incoming.url : originalUrl,
    urlHash: incoming.urlHash,
  }).valid;
}

/** Metadata supplied only by Current still belongs to Current's URL. Keep
 * its provenance until after the spelling pin so a real URL edit can clear
 * it, while an equivalent rewrite preserves the independently added value. */
export function reconcileSyncBookmarkMetadata(
  current: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, unknown>>,
  base: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const pinned = pinEquivalentSyncBookmarkMetadata(current, fields);
  if (typeof pinned.url !== 'string' || pinned.url === current.url) return pinned;
  const selected = { ...pinned };
  for (const field of ['urlHash', 'canonicalUrl']) {
    const baseValue = base[field] ?? null, incomingValue = incoming[field] ?? null;
    const currentValue = current[field] ?? null;
    if (Object.hasOwn(selected, field)
      && deepEqualSyncMergeValue(baseValue, incomingValue)
      && !deepEqualSyncMergeValue(baseValue, currentValue)
      && deepEqualSyncMergeValue(selected[field] ?? null, currentValue)) delete selected[field];
  }
  return invalidateOmittedBookmarkUrlMetadata(selected, current);
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
