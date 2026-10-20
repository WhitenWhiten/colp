import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadManifestCloud, manifestCloudIsOn, resetManifestCloudCache } from '../src/cloud-capability.js';
import { readPublicServerManifest } from '../src/public-server-manifest.js';
import { fetchEditionVersion, readEditionVersion } from '../src/server-edition.js';

const origin = 'https://colp.example';
const manifest = (version = '0.1.0', cloud = false) => ({ mounts: [
  { 'https://know-n.com/colp/extensions/server': { cloud, edition: { version } } },
] });
afterEach(() => { resetManifestCloudCache(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('public manifest readers share only the current immutable document', () => {
  test('capability, edition and a second reader consume one actual response without sharing a body stream', async () => {
    let respond!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { respond = resolve; }));
    const cloud = loadManifestCloud(origin, fetcher), edition = fetchEditionVersion(origin, fetcher);
    const document = readPublicServerManifest(`${origin}/ignored-path`, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(`${origin}/.well-known/collection-protocol`, expect.objectContaining({
      credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/vnd.collection-protocol.manifest+json;version=0.2', 'Collection-Protocol-Version': '0.2' },
    }));
    const response = Response.json(manifest()); respond(response);
    expect(await cloud).toBe(false); expect(await edition).toBe('0.1.0');
    const body = await document as { mounts: Array<Record<string, { cloud: boolean }>> };
    expect(response.bodyUsed).toBe(true); expect(Object.isFrozen(body)).toBe(true);
    expect(Object.isFrozen(body.mounts)).toBe(true);
    expect(Object.isFrozen(body.mounts[0]!['https://know-n.com/colp/extensions/server'])).toBe(true);
    expect(() => { body.mounts[0]!['https://know-n.com/colp/extensions/server']!.cloud = true; }).toThrow(TypeError);
    expect(manifestCloudIsOn()).toBe(false);
  });

  test('different origins and different fetch contexts never share an in-flight result', async () => {
    const replies = new Map<string, (response: Response) => void>();
    const fetcher = vi.fn<typeof fetch>(url => new Promise(resolve => { replies.set(String(url), resolve); }));
    const first = fetchEditionVersion(origin, fetcher), second = fetchEditionVersion('https://other.example', fetcher);
    const otherFetcher = vi.fn<typeof fetch>(async () => Response.json(manifest('0.3.0')));
    expect(await fetchEditionVersion(origin, otherFetcher)).toBe('0.3.0');
    replies.get('https://other.example/.well-known/collection-protocol')!(Response.json(manifest('0.2.0')));
    expect(await second).toBe('0.2.0');
    replies.get(`${origin}/.well-known/collection-protocol`)!(Response.json(manifest('0.1.0')));
    expect(await first).toBe('0.1.0'); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('cancelling one reader does not abort another reader or consume its response', async () => {
    let respond!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { respond = resolve; }));
    const controller = new AbortController();
    const abandoned = readPublicServerManifest(origin, fetcher, controller.signal);
    const edition = fetchEditionVersion(origin, fetcher);
    controller.abort(); expect(await abandoned).toBeUndefined();
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    respond(Response.json(manifest('0.2.0')));
    expect(await edition).toBe('0.2.0'); expect(fetcher).toHaveBeenCalledOnce();
    expect(await readPublicServerManifest(origin, fetcher, controller.signal)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test('completed reads do not hide an edition upgrade or a capability change after cache reset', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(manifest('0.1.0', false)))
      .mockResolvedValueOnce(Response.json(manifest('0.2.0', true)));
    expect(await Promise.all([fetchEditionVersion(origin, fetcher), loadManifestCloud(origin, fetcher)]))
      .toEqual(['0.1.0', false]);
    resetManifestCloudCache();
    expect(await Promise.all([fetchEditionVersion(origin, fetcher), loadManifestCloud(origin, fetcher)]))
      .toEqual(['0.2.0', true]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test.each(['network', 'status', 'json', 'size', 'empty'])(
    'an unreadable %s result remains unknown and is retried on the next capability read', async failure => {
      const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
        if (failure === 'network') throw new TypeError('offline');
        if (failure === 'status') return new Response('unavailable', { status: 503 });
        if (failure === 'json') return new Response('{broken');
        if (failure === 'size') return new Response('{}', { headers: { 'content-length': '524289' } });
        return new Response(null);
      }).mockResolvedValueOnce(Response.json(manifest()));
      expect(await loadManifestCloud(origin, fetcher)).toBe(true);
      expect(manifestCloudIsOn()).toBe(true);
      expect(await loadManifestCloud(origin, fetcher)).toBe(false);
      expect(await loadManifestCloud(origin, fetcher)).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  test('the shared HTTP request has its own bounded deadline and a timed-out read can retry', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    })).mockResolvedValueOnce(Response.json(manifest()));
    const pending = fetchEditionVersion(origin, fetcher);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toBeUndefined();
    expect(await fetchEditionVersion(origin, fetcher)).toBe('0.1.0');
    expect(vi.getTimerCount()).toBe(0);
  });

  test('invalid origins do not perform HTTP and malformed optional edition rows are ignored', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const invalid of ['', ':bad', 'file:///private', 'chrome-extension://profile']) {
      expect(await fetchEditionVersion(invalid, fetcher)).toBeUndefined();
    }
    expect(await loadManifestCloud('', fetcher)).toBe(true); expect(fetcher).not.toHaveBeenCalled();
    expect(readEditionVersion({ features: { edition: { version: '' } } })).toBeUndefined();
    expect(readEditionVersion({ mounts: [null, [], { features: { edition: { version: 2 } } },
      { features: { edition: { version: '0.2.0' } } }] })).toBe('0.2.0');
  });
});
