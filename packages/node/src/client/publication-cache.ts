import { validatePublicationIfNoneMatchEtag } from './publication-conditional.js';

export interface ClientCacheEntry {
  readonly etag: string;
  readonly representation: unknown;
}

export interface ClientCache {
  delete(key: string): void | Promise<void>;
  get(key: string): ClientCacheEntry | undefined | Promise<ClientCacheEntry | undefined>;
  set(key: string, value: ClientCacheEntry): void | Promise<void>;
}

/** HTTP policy and validator are consumed together at the cache storage boundary. */
export async function updatePublicationResponseCache(
  cache: ClientCache | undefined,
  key: string | undefined,
  headers: Headers,
  representation?: unknown,
): Promise<void> {
  // Only a cached write consumes the validator. Clients without a cache must
  // not reject an RFC-legal weak or non-canonical response ETag.
  if (cache === undefined || key === undefined) return;

  // Keep quoted directive values intact: an extension value can contain commas.
  const directives = headers.get('cache-control')?.match(/(?:[^",]|"(?:[^"\\]|\\.)*")+/gu) ?? [];
  const noStore = directives.some((directive) => directive.split('=', 1)[0]!.trim().toLowerCase() === 'no-store');
  if (noStore) {
    // Also discard a prior representation when a 200 or 304 changes its policy.
    await cache.delete(key);
    return;
  }

  const rawEtag = headers.get('etag');
  if (rawEtag === null || representation === undefined) return;
  // no-cache permits storage: this client revalidates every use with the server.
  await cache.set(key, Object.freeze({ etag: validatePublicationIfNoneMatchEtag(rawEtag), representation }));
}
