import { digestJson } from './bookmark-event-codec.js';
import type { JsonObject } from './sync-state-store.js';

/** Compare browser serialization only; never rewrite the synchronized URL. */
export function nativeBookmarkUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : url;
  } catch { return url; }
}

/**
 * Whether Chrome's `native` value for a bookmark field is the `stored` one. Chrome serialises an address its own way
 * (a bare host gains a "/"), while the server keeps a URL exactly as it was sent, so one address has two spellings
 * and comparing them as plain strings read the browser's own form as a local edit (B-11). Titles compare exactly.
 */
export function sameNativeContentValue(key: string, native: unknown, stored: unknown): boolean {
  if (native === stored) return true;
  return key === 'url' && typeof native === 'string' && typeof stored === 'string'
    && nativeBookmarkUrl(native) === nativeBookmarkUrl(stored);
}

export function nativeEventCorrelation(kind: string, nativeId: string, details: JsonObject): string {
  const node = details.node;
  const correlated = kind === 'create' && node && typeof node === 'object' && !Array.isArray(node)
    && typeof node.url === 'string'
    ? { ...details, node: { ...node, url: nativeBookmarkUrl(node.url) } } : details;
  return digestJson({ kind, nativeId: kind === 'create' ? '' : nativeId, details: correlated });
}
