import { readBoundedJson } from './json-response.js';

const inFlight = new WeakMap<typeof fetch, Map<string, Promise<unknown>>>();

/** Concurrent public readers share one bounded, immutable document. Settled reads
 * are discarded so a later explicit refresh can observe a changed server. A
 * caller's deadline only stops that caller; it cannot abort another reader. */
export function readPublicServerManifest(origin: string, fetcher: typeof fetch = fetch,
  signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) return Promise.resolve(undefined);
  let url: string;
  try {
    const base = new URL(origin);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') return Promise.resolve(undefined);
    url = new URL('/.well-known/collection-protocol', base.origin).href;
  } catch { return Promise.resolve(undefined); }
  const reads = inFlight.get(fetcher) ?? new Map<string, Promise<unknown>>();
  inFlight.set(fetcher, reads);
  let operation = reads.get(url);
  if (!operation) {
    operation = fetchManifest(url, fetcher).finally(() => { reads.delete(url); });
    reads.set(url, operation);
  }
  return waitForManifest(operation, signal);
}

async function fetchManifest(url: string, fetcher: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetcher(url, {
      redirect: 'error', cache: 'no-store', signal: controller.signal, credentials: 'omit',
      headers: { Accept: 'application/vnd.collection-protocol.manifest+json;version=0.2', 'Collection-Protocol-Version': '0.2' },
    });
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); return undefined; }
    const body = await readBoundedJson(response, 512 * 1_024, 'manifest_invalid', { signal: controller.signal });
    const objects = [body];
    while (objects.length > 0) {
      const value = objects.pop();
      if (value && typeof value === 'object') {
        Object.freeze(value);
        for (const child of Object.values(value)) objects.push(child);
      }
    }
    return body;
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

function waitForManifest(operation: Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.resolve(undefined);
  let abort!: () => void;
  const stopped = new Promise<undefined>(resolve => {
    abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([operation, stopped]).finally(() => { signal.removeEventListener('abort', abort); });
}
