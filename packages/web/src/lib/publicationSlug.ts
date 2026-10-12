/** A public address (`/c/:slug`): lowercase letters, digits, and inner hyphens, 3–63 characters, as the server requires. */
export const PUBLICATION_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/

/**
 * The address a collection is offered when it is first shared, taken from its
 * title ("Reading list" → "reading-list"). Empty when the title has too few
 * Latin letters or digits to make one; the owner then types it.
 */
export function suggestPublicationSlug(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .slice(0, 63)
    .replace(/-+$/u, '')
  return PUBLICATION_SLUG.test(slug) ? slug : ''
}
