const RESERVED = new Set(['new', 'health', 'demo'])

export function isLibraryDeskPath(pathname: string): boolean {
  if (pathname === '/library') return true
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'library') return false
  return !RESERVED.has(parts[1]!)
}

export function libraryDeskKey(pathname: string): string {
  return isLibraryDeskPath(pathname) ? '/library' : pathname
}

export function isLibraryDeskToDesk(fromPathname: string, toHref: string): boolean {
  return isLibraryDeskPath(fromPathname) && isLibraryDeskPath(pathnameOf(toHref))
}

/** `/library/:id/edit` lands on the desk. A `?node=` deep link opens the
    node drawer; otherwise the collection settings sheet. */
export function collectionEditorRedirectPath(
  collectionId: string,
  node: string | null,
): string {
  const params = new URLSearchParams()
  if (node) params.set('node', node)
  else params.set('collection', 'edit')
  return `/library/${encodeURIComponent(collectionId)}?${params.toString()}`
}

function pathnameOf(href: string): string {
  const query = href.indexOf('?')
  const hash = href.indexOf('#')
  const end = Math.min(
    query === -1 ? href.length : query,
    hash === -1 ? href.length : hash,
  )
  return href.slice(0, end) || '/'
}
