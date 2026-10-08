import { normalizePageMetaText } from './pageMetaText'
import { productName } from './edition'

/** Mirrors the public-shell summary/fallback fields for SPA navigations. */
export function publicCollectionDescription(collection: {
  summary: string | null
  owner?: { displayName: string } | null
}): string {
  const summary = normalizePageMetaText(collection.summary ?? '')
  if (summary) return summary
  const curator = normalizePageMetaText(collection.owner?.displayName ?? '') || productName()
  return normalizePageMetaText(`A public collection on ${productName()} by ${curator}`)
}
