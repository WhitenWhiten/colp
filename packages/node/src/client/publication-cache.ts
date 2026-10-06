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
  const rawEtag = headers.get('etag');
  const etag = rawEtag === null ? undefined : validatePublicationIfNoneMatchEtag(rawEtag);
  if (cache === undefined || key === undefined) return;

  // Keep quoted directive values intact: an extension value can contain commas.
  const directives = headers.get('cache-control')?.match(/(?:[^",]|"(?:[^"\\]|\\.)*")+/gu) ?? [];
  const noStore = directives.some((directive) => directive.split('=', 1)[0]!.trim().toLowerCase() === 'no-store');
  if (noStore) {
    // Also discard a prior representation when a 200 or 304 changes its policy.
    await cache.delete(key);
  } else if (etag !== undefined && representation !== undefined) {
    // no-cache permits storage: this client revalidates every use with the server.
    await cache.set(key, Object.freeze({ etag, representation }));
  }
}
