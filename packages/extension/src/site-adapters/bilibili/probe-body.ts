import { favoriteEndpoint, favoriteRequest } from './probe-wire.js';
/** Clone before fetch starts consuming a Request. Never read or change the site's original body. */
export function favoriteFetchRequest(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (!favoriteEndpoint(url, method)) return null;
  if (init?.body !== undefined && init.body !== null) return Promise.resolve(favoriteRequest(url, method, init.body));
  if (!(input instanceof Request) || !input.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return null;
  try {
    const reader = input.clone().body?.getReader(); if (!reader) return null;
    return (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined, bytes = 0;
      const chunks: Uint8Array[] = [];
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 1000); });
      try {
        for (;;) {
          const result = await Promise.race([reader.read(), timeout]); if (result.done) break;
          bytes += result.value.byteLength; if (bytes > 8192) return null; chunks.push(result.value);
        }
        const data = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        return favoriteRequest(url, method, new TextDecoder('utf-8', { fatal: true }).decode(data));
      } catch { return null; }
      finally { clearTimeout(timer); void reader.cancel().catch(() => undefined); }
    })();
  } catch { return null; }
}
