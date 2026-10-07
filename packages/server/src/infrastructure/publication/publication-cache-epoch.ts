/** Strict epoch parsing: corruption bypasses cache under the existing origin bulkhead. */
import { CACHE_ERROR_CATEGORY, CacheStoreError, type CacheStore } from '../cache/index.js';

/** Canonical non-negative decimal integer string: `0`, or digits without a leading zero. */
const CANONICAL_EPOCH_RE = /^(?:0|[1-9][0-9]*)$/u;

export type PublicationCacheEpochParse =
  | { readonly epoch: number; readonly corrupt: false }
  | { readonly epoch: null; readonly corrupt: true };

/** Parses one raw epoch value; missing is initial epoch zero; corruption has no usable generation. */
export function parsePublicationCacheEpoch(raw: string | null): PublicationCacheEpochParse {
  if (raw === null) return { epoch: 0, corrupt: false };
  if (!CANONICAL_EPOCH_RE.test(raw) || !Number.isSafeInteger(Number(raw))) {
    return { epoch: null, corrupt: true };
  }
  return { epoch: Number(raw), corrupt: false };
}

/** Reads a trusted generation or triggers the shared bounded origin fallback. */
export async function readPublicationCacheEpoch(
  store: CacheStore,
  epochKey: string,
  signal: AbortSignal,
  onCorrupt?: () => void,
): Promise<number> {
  const parsed = parsePublicationCacheEpoch(await store.get(epochKey, signal));
  if (parsed.corrupt) {
    onCorrupt?.();
    throw new CacheStoreError(CACHE_ERROR_CATEGORY.DECODE_ERROR, 'publication cache epoch is corrupt');
  }
  return parsed.epoch;
}
