import { validateBookmarkUrlHashSemantics } from '@know-n/colp/semantic';
import { deepEqualSyncMergeValue } from '@know-n/colp/sync';
import { invalidateOmittedBookmarkUrlMetadata, isEquivalentBookmarkUrlRewrite } from '../collections/index.js';

/** Validate a hash the client actually authored against its original URL bytes.
 * A hash supplied only by Current during the merge is not an incoming edit. */
export function validIncomingBookmarkUrlHash(base: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>, originalUrl: unknown): boolean {
  if (!Object.hasOwn(incoming, 'urlHash') || incoming.urlHash === null) return true;
  if (validateBookmarkUrlHashSemantics({
    url: Object.hasOwn(incoming, 'url') ? incoming.url : originalUrl,
    urlHash: incoming.urlHash,
  }).valid) return true;
  // An unchanged valid digest may accompany an equivalent spelling. Never
  // accept an unchanged but invalid digest merely because Base also had it.
  return deepEqualSyncMergeValue(base.urlHash ?? null, incoming.urlHash)
    && typeof originalUrl === 'string' && typeof incoming.url === 'string'
    && isEquivalentBookmarkUrlRewrite(originalUrl, incoming.url)
    && validateBookmarkUrlHashSemantics({ url: originalUrl, urlHash: incoming.urlHash }).valid;
}

export function hasIncomingBookmarkUrlMetadata(incoming: Readonly<Record<string, unknown>>): boolean {
  return ['urlHash', 'canonicalUrl'].some(field => incoming[field] !== undefined && incoming[field] !== null);
}

/** A metadata refresh does not author its source URL. If Current independently
 * changed that URL, the old derived value is no longer an incoming edit in the
 * current URL's domain. Revert that field to Base for the three-way merge so
 * Current's new enrichment survives. Explicit null clears remain edits. */
export function incomingBookmarkMetadataForCurrent(current: Readonly<Record<string, unknown>>,
  base: Readonly<Record<string, unknown>>, incoming: Readonly<Record<string, unknown>>,
  originalUrl: unknown): Readonly<Record<string, unknown>> {
  if ((Object.hasOwn(incoming, 'url') && incoming.url !== originalUrl)
    || typeof current.url !== 'string' || typeof originalUrl !== 'string') return incoming;
  const equivalent = current.url === originalUrl || isEquivalentBookmarkUrlRewrite(current.url, originalUrl);
  const next = { ...incoming };
  for (const field of ['urlHash', 'canonicalUrl']) {
    if (incoming[field] === undefined || incoming[field] === null) continue;
    if (!equivalent || (field === 'urlHash'
      && !validateBookmarkUrlHashSemantics({ url: current.url, urlHash: incoming.urlHash }).valid)) {
      next[field] = base[field] ?? null;
    }
  }
  return next;
}

/** Metadata supplied only by Current still belongs to Current's URL. Keep
 * its provenance until after the spelling pin so a real URL edit can clear
 * it, while an equivalent rewrite preserves the independently added value. */
export function reconcileSyncBookmarkMetadata(
  current: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, unknown>>,
  base: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>,
  originalUrl: unknown = base.url,
): Readonly<Record<string, unknown>> {
  const pinned = pinEquivalentSyncBookmarkMetadata(current, fields);
  const selected = { ...pinned };
  const selectedUrl = selected.url ?? current.url;
  const incomingUrl = incoming.url ?? originalUrl;
  // Selection can choose Current's URL while retaining a field from Incoming.
  // Keep metadata from Current itself; discard only the non-null value that
  // belongs to the unchosen incoming URL (including metadata-only refreshes).
  if (typeof selectedUrl === 'string' && typeof incomingUrl === 'string') {
    const equivalent = selectedUrl === incomingUrl || isEquivalentBookmarkUrlRewrite(selectedUrl, incomingUrl);
    for (const field of ['urlHash', 'canonicalUrl']) {
      if (selected[field] === undefined || selected[field] === null
        || !deepEqualSyncMergeValue(selected[field], incoming[field])) continue;
      if (!equivalent || (field === 'urlHash'
        && !validateBookmarkUrlHashSemantics({ url: selectedUrl, urlHash: selected[field] }).valid)) {
        selected[field] = selectedUrl === current.url ? current[field] ?? null : null;
      }
    }
  }
  if (typeof pinned.url !== 'string' || pinned.url === current.url) return selected;
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
