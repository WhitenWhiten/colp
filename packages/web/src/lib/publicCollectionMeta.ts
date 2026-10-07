import { normalizePageMetaText } from './pageMetaText'

/** Mirrors the public-shell summary/fallback fields for SPA navigations. */
export function publicCollectionDescription(collection: {
  summary: string | null
  owner?: { displayName: string } | null
}): string {
  const summary = normalizePageMetaText(collection.summary ?? '')
  if (summary) return summary
  const curator = normalizePageMetaText(collection.owner?.displayName ?? '') || 'Know-N'
  return normalizePageMetaText(`A public collection on Know-N by ${curator}`)
}
