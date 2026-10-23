import { digestJson } from './bookmark-event-codec.js';
import type { JsonObject } from './sync-state-store.js';

/** Compare browser serialization only; never rewrite the synchronized URL. */
export function nativeBookmarkUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : url;
  } catch { return url; }
}

export function nativeEventCorrelation(kind: string, nativeId: string, details: JsonObject): string {
  const node = details.node;
  const correlated = kind === 'create' && node && typeof node === 'object' && !Array.isArray(node)
    && typeof node.url === 'string'
    ? { ...details, node: { ...node, url: nativeBookmarkUrl(node.url) } } : details;
  return digestJson({ kind, nativeId: kind === 'create' ? '' : nativeId, details: correlated });
}
