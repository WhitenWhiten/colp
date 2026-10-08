/**
 * Bookmark URL normalization for readable-replica staleness.
 * Same rules as Known-Backend `normalizeBookmarkUrl`: lowercase host, strip
 * hash and default ports, strip a trailing slash only when the path is longer
 * than one character. Invalid URLs return null. Advisory only; stored bookmark
 * URLs and Extension sync identity keep the original string.
 */
export function normalizeBookmarkUrl(value: string): string | null {
  if (typeof value !== 'string' || value.length < 1) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  if (parsed.hostname.length < 1) return null
  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  parsed.hostname = parsed.hostname.toLowerCase()
  if (
    (parsed.protocol === 'http:' && parsed.port === '80')
    || (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = ''
  }
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1)
  }
  return parsed.href
}

export function replicaSourceMatchesNodeUrl(sourceUrl: string, nodeUrl: string | null): boolean {
  // A bookmark can carry no URL at all (folder rows, cleared links), and a
  // replica extracted from somewhere cannot match one.
  if (nodeUrl === null) return false
  const left = normalizeBookmarkUrl(sourceUrl)
  const right = normalizeBookmarkUrl(nodeUrl)
  if (left === null || right === null) return sourceUrl === nodeUrl
  return left === right
}
