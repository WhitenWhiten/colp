import { isProxy } from 'node:util/types';

import { isHttpsNamespaceUri } from '../schema/uri.js';
import type { WebSubHub } from '../types/index.js';

export type WebSubDeclareResult =
  | { readonly ok: true; readonly hubs: readonly WebSubHub[] }
  | { readonly ok: false; readonly code: 'malformed_hub' | 'unsafe_hub_url' | 'duplicate_hub' };

/**
 * Declares WebSub Hub entries for a Feed document (FEED-0007).
 *
 * Hubs must be HTTPS URLs without userinfo. Notification semantics remain
 * host-owned: subscribers still perform conditional GET on the Feed.
 */
export function declareWebSubHubs(hubUrls: readonly string[]): WebSubDeclareResult {
  if (!Array.isArray(hubUrls) || isProxy(hubUrls)) {
    throw new TypeError('hubUrls must be an ordinary array.');
  }

  const hubs: WebSubHub[] = [];
  const seen = new Set<string>();
  for (const url of hubUrls) {
    if (typeof url !== 'string' || url.length === 0) {
      return Object.freeze({ ok: false, code: 'malformed_hub' });
    }
    // WebSub hubs require HTTPS (schema $defs.httpsUrl / isHttpsNamespaceUri host).
    if (!isHttpsHubUrl(url)) {
      return Object.freeze({ ok: false, code: 'unsafe_hub_url' });
    }
    if (seen.has(url)) {
      return Object.freeze({ ok: false, code: 'duplicate_hub' });
    }
    seen.add(url);
    hubs.push(Object.freeze({ type: 'WebSub' as const, url: url as WebSubHub['url'] }));
  }

  return Object.freeze({ ok: true, hubs: Object.freeze(hubs) });
}

/**
 * Attaches declared hubs onto a Feed-shaped object without mutating the input.
 * Does not perform network delivery.
 */
export function withWebSubHubs<T extends { readonly hubs?: readonly WebSubHub[] }>(
  feed: T,
  hubUrls: readonly string[],
): { readonly ok: true; readonly feed: T & { readonly hubs: readonly WebSubHub[] } }
  | WebSubDeclareResult {
  const declared = declareWebSubHubs(hubUrls);
  if (!declared.ok) return declared;
  return Object.freeze({
    ok: true as const,
    feed: Object.freeze({
      ...feed,
      hubs: declared.hubs,
    }) as T & { readonly hubs: readonly WebSubHub[] },
  });
}

function isHttpsHubUrl(url: string): boolean {
  // Reuse HTTPS namespace/host rules: absolute https, host present, no userinfo.
  if (!isHttpsNamespaceUri(url) && !looksLikeHttpsUrl(url)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:'
      && parsed.hostname.length > 0
      && parsed.username === ''
      && parsed.password === ''
    );
  } catch {
    return false;
  }
}

function looksLikeHttpsUrl(url: string): boolean {
  return /^https:\/\//iu.test(url);
}
