import { BOOKMARK_FAVICON_MAX_BYTES, sniffBookmarkFaviconCanonicalMime,
  type BookmarkFaviconCanonicalMime } from './favicon-sniff.js';

export const FAVICON_CAPTURE_TIMEOUT_MS = 3_000;

export interface CapturedFavicon {
  readonly contentType: BookmarkFaviconCanonicalMime;
  readonly bytes: Uint8Array;
}

export function isCapturableFaviconUrl(favIconUrl: string, tabUrl: string): boolean {
  try {
    const icon = new URL(favIconUrl);
    const tab = new URL(tabUrl);
    if (icon.protocol !== 'http:' && icon.protocol !== 'https:') return false;
    if (tab.protocol !== 'http:' && tab.protocol !== 'https:') return false;
    return icon.origin === tab.origin;
  } catch {
    return false;
  }
}

/** User-gesture fetch of tab.favIconUrl. Never uses canvas or no-cors. */
export async function captureTabFavicon(input: {
  readonly favIconUrl: string; readonly tabUrl: string; readonly fetch?: typeof fetch;
  readonly timeoutMs?: number; readonly maxBytes?: number;
}): Promise<CapturedFavicon | null> {
  if (!isCapturableFaviconUrl(input.favIconUrl, input.tabUrl)) return null;
  const maxBytes = input.maxBytes ?? BOOKMARK_FAVICON_MAX_BYTES;
  const timeoutMs = input.timeoutMs ?? FAVICON_CAPTURE_TIMEOUT_MS;
  const fetcher = input.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(input.favIconUrl, {
      method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit',
      signal: abortSignal(timeoutMs),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await cancelBody(response);
    return null;
  }
  const bytes = await readBodyCapped(response, maxBytes);
  if (!bytes) return null;
  const contentType = sniffBookmarkFaviconCanonicalMime(bytes);
  if (!contentType) return null;
  return { contentType, bytes };
}

function abortSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await cancelBody(response);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    try {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) return null;
      return new Uint8Array(buffer);
    } catch {
      return null;
    }
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  if (size === 0) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
