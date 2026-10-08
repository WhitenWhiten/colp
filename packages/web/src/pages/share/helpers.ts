import { canonicalSiteOrigin } from '../../lib/chrome'

export function shareUrl(slug: string) {
  return `${canonicalSiteOrigin()}/share/${slug}`
}

/** Escape a value interpolated into a double-quoted HTML attribute of the
   copy-paste embed snippet. */
export function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
