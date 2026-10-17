/**
 * Image URLs this page has already painted. Windowed lists unmount rows that
 * scroll out of view, so a row scrolled back in mounts a fresh <img>; lazy
 * loading plus an async decode left its icon or cover empty until both caught
 * up, even with the bytes in cache. A URL seen before loads eagerly and
 * decodes in the frame it mounts.
 */
const shown = new Set<string>()

export function imageLoadHints(src: string): { loading: 'eager' | 'lazy'; decoding: 'sync' | 'async' } {
  return shown.has(src) ? { loading: 'eager', decoding: 'sync' } : { loading: 'lazy', decoding: 'async' }
}

export function markImageShown(src: string): void {
  shown.add(src)
}
