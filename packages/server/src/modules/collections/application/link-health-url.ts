export { normalizeBookmarkUrl } from '../domain/bookmark-url.js';

/**
 * Hostname extraction for link-health grouping. Pure: no I/O. Invalid URLs
 * return undefined.
 */
export function hostnameFromBookmarkUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.hostname.length < 1) return undefined;
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
