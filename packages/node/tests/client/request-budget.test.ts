import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ColpClient, ColpClientLimitError, defaultClientRequestLimits,
  type ClientCache, type ClientRequestOptions, type ColpClientOptions,
} from '../../src/client/index.js';
import type { CollectionDirectory, Manifest, Snapshot } from '../../src/types/index.js';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL('../../fixtures/protocol/examples/' + name, import.meta.url), 'utf8')) as T;
}
const manifest = fixture<Manifest>('public-manifest.json');
const snapshot = fixture<Snapshot>('collection-snapshot.json');
const directory = fixture<CollectionDirectory>('collection-directory.json');
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const pending = <Value>(): Promise<Value> => new Promise(() => undefined);
const collectionId = snapshot.collection.id;
const operations: Array<[string, (client: ColpClient, options: ClientRequestOptions) => Promise<unknown>]> = [
  ['discover', (client, options) => client.discover(true, options)],
  ['directory', (client, options) => client.getDirectory({}, options)],
  ['collection', (client, options) => client.getCollection(collectionId, options)],
  ['snapshot', (client, options) => client.getSnapshot(collectionId, {}, options)],
  ['refresh', (client, options) => client.refreshSnapshot(collectionId, {}, options)],
  ['create', (client, options) => client.createNode(collectionId, {
    parentId: snapshot.collection.rootNodeId,
    node: { kind: 'bookmark', title: 'Created', url: 'https://example.test/created' },
  }, { idempotencyKey: 'stable-create-key', ...options })],
  ['move', (client, options) => client.moveNode(collectionId, snapshot.nodes[1]!.id, {
    newParentId: snapshot.collection.rootNodeId,
    baseSourceParentRevision: 'r1', baseTargetParentRevision: 'r1',
  }, { idempotencyKey: 'stable-move-key', ifMatch: '"v1"', ...options })],
];

describe('HTTP request budgets', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(operations)('bounds %s from before discovery even when fetch ignores cancellation', async (_name, invoke) => {
    const fetch = vi.fn(() => pending<Response>());
    const client = new ColpClient({ manifestUrl, fetch });
    const result = invoke(client, {}).catch(error => error);
    await vi.advanceTimersByTimeAsync(defaultClientRequestLimits.timeoutMs);
    expect(await result).toBeInstanceOf(ColpClientLimitError);
    expect(fetch).toHaveBeenCalledOnce();
    expect(client.currentSnapshot).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(operations)('rejects an already cancelled %s without invoking any ports', async (_name, invoke) => {
    const reason = new Error('cancelled by caller');
    const fetch = vi.fn(() => pending<Response>());
    const credentials = vi.fn(() => undefined);
    const client = new ColpClient({ manifestUrl, fetch, credentialProvider: credentials });
    await expect(invoke(client, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(operations.filter(([name]) => name !== 'discover'))('cancels a pending %s endpoint after discovery without retrying writes', async (_name, invoke) => {
    const calls: Array<{ method: string | undefined; signal: AbortSignal | null | undefined; headers: Headers }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === manifestUrl) return Response.json(manifest);
      calls.push({ method: init?.method, signal: init?.signal, headers: new Headers(init?.headers) });
      return pending<Response>();
    });
    const client = new ColpClient({ manifestUrl, fetch });
    const controller = new AbortController();
    const result = invoke(client, { signal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    const reason = new Error('stop endpoint');
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(calls[0]!.signal!.aborted).toBe(true);
    if (calls[0]!.method === 'POST') expect(calls[0]!.headers.has('idempotency-key')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['egress', 'credentials', 'identity', 'partition', 'cache-get', 'cache-set', 'cache-delete'] as const)(
    'includes a stalled %s hook in the deadline', async stage => {
      const hook = vi.fn(() => pending<never>());
      const cache: ClientCache = {
        get: stage === 'cache-get' ? hook : () => undefined,
        set: stage === 'cache-set' ? hook : () => undefined,
        delete: stage === 'cache-delete' ? hook : () => undefined,
      };
      const options: ColpClientOptions = {
        manifestUrl, cache, requestLimits: { timeoutMs: 20 },
        ...(stage === 'egress' ? { egressPolicy: hook } : {}),
        ...(stage === 'credentials' ? { credentialProvider: hook } : {}),
        ...(stage === 'identity' ? { requestIdentityProvider: hook } : {}),
        ...(stage === 'partition' ? { cachePartition: hook } : {}),
        fetch: async () => Response.json(manifest, { headers: { ETag: '"manifest"',
          ...(stage === 'cache-delete' ? { 'Cache-Control': 'no-store' } : {}),
        } }),
      };
      const result = new ColpClient(options).discover().catch(error => error);
      await vi.advanceTimersByTimeAsync(20);
      expect(await result).toBeInstanceOf(ColpClientLimitError);
      expect(hook).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('uses one deadline across discovery, redirects and the final request', async () => {
    const signals = new Set<AbortSignal>();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      signals.add(init!.signal!);
      if (String(input).endsWith('/final')) return pending<Response>();
      await new Promise(resolve => setTimeout(resolve, 8));
      return String(input) === manifestUrl ? Response.json(manifest)
        : new Response(null, { status: 302, headers: { Location: '/final' } });
    });
    const result = new ColpClient({ manifestUrl, fetch }).getDirectory({}, { timeoutMs: 20 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toBeInstanceOf(ColpClientLimitError);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(signals.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 503])('cancels oversized HTTP %s bodies with or without Content-Length', async status => {
    for (const declared of [true, false]) {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(65)); }, cancel,
      });
      const client = new ColpClient({ manifestUrl, requestLimits: { maxBytes: 64 },
        fetch: async () => new Response(stream, { status, headers: {
          'Content-Type': status === 200 ? 'application/json' : 'application/problem+json',
          ...(declared ? { 'Content-Length': '65' } : {}),
        } }),
      });
      await expect(client.discover()).rejects.toThrow('byte limit');
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('cancels a stalled reader and cleans up the caller abort listener', async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const stream = new ReadableStream<Uint8Array>({ pull: () => pending(), cancel });
    const client = new ColpClient({ manifestUrl, fetch: async () => new Response(stream, {
      headers: { 'Content-Type': 'application/json' },
    }) });
    const result = client.discover(false, { timeoutMs: 20, signal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toBeInstanceOf(ColpClientLimitError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(operations.filter(([name]) => name !== 'discover'))('bounds the %s response after cached discovery', async (name, invoke) => {
    const cancel = vi.fn();
    const client = new ColpClient({ manifestUrl, fetch: async input => String(input) === manifestUrl
      ? Response.json(manifest)
      : new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(33)); }, cancel,
      }), { status: name === 'create' ? 201 : 200, headers: {
        'Content-Type': 'application/json', ETag: '"bounded"', Location: '/created',
      } }),
    });
    await client.discover();
    await expect(invoke(client, { maxBytes: 32 })).rejects.toThrow('byte limit');
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a late response from an uncooperative fetch after the call has expired', async () => {
    let release!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const client = new ColpClient({ manifestUrl, fetch });
    const result = client.discover(false, { timeoutMs: 20 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toBeInstanceOf(ColpClientLimitError);
    const cancel = vi.fn();
    release(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not send a write when a timed out credential provider eventually resolves', async () => {
    let release!: (value: Record<string, string>) => void;
    const fetch = vi.fn(async () => Response.json(manifest));
    const client = new ColpClient({ manifestUrl, fetch, credentialProvider: () => new Promise(resolve => { release = resolve; }) });
    const result = operations.find(([name]) => name === 'create')![1](client, { timeoutMs: 20 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toBeInstanceOf(ColpClientLimitError);
    release({ Authorization: 'Bearer late' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enforces a per-call byte limit when HTTP 304 reuses a representation', async () => {
    const cache: ClientCache = {
      get: key => key.includes('.well-known') ? undefined : { etag: '"directory"', representation: directory },
      set: () => undefined, delete: () => undefined,
    };
    const client = new ColpClient({ manifestUrl, cache, fetch: async input => String(input) === manifestUrl
      ? Response.json(manifest) : new Response(null, { status: 304, headers: { ETag: '"directory"' } }) });
    await client.discover();
    await expect(client.getDirectory({}, { maxBytes: 32 })).rejects.toThrow('byte limit');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates simultaneous calls and cleans up after a successful override', async () => {
    let release!: (value: Response) => void;
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementationOnce(() => pending<Response>())
      .mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const client = new ColpClient({ manifestUrl, fetch, requestLimits: { timeoutMs: 10, maxBytes: 1 } });
    const first = client.discover(true, { signal: controller.signal, maxBytes: 100_000 }).catch(error => error);
    const second = client.discover(true, { timeoutMs: 40, maxBytes: 100_000 });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('first only'));
    expect(await first).toMatchObject({ message: 'first only' });
    await vi.advanceTimersByTimeAsync(20);
    release(Response.json(manifest));
    expect(await second).toEqual(manifest);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the independent Snapshot timeout ceiling', async () => {
    const client = new ColpClient({ manifestUrl, fetch: () => pending<Response>(), snapshotLimits: { timeoutMs: 10 } });
    const result = client.getSnapshot(collectionId, {}, { timeoutMs: 40 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({ message: 'Request exceeded the timeout of 10 ms.' });
  });

  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid budget %s before I/O', async value => {
    const fetch = vi.fn(() => pending<Response>());
    expect(() => new ColpClient({ manifestUrl, fetch, requestLimits: { timeoutMs: value } })).toThrow(RangeError);
    expect(() => new ColpClient({ manifestUrl, fetch, requestLimits: { maxBytes: value } })).toThrow(RangeError);
    const client = new ColpClient({ manifestUrl, fetch });
    await expect(client.discover(false, { timeoutMs: value })).rejects.toThrow(RangeError);
    await expect(client.discover(false, { maxBytes: value })).rejects.toThrow(RangeError);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not truncate a long timeout to the Node one millisecond fallback', async () => {
    const controller = new AbortController();
    const client = new ColpClient({ manifestUrl, fetch: () => pending<Response>() });
    const result = client.discover(false, { signal: controller.signal, timeoutMs: 2_147_483_648 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_147_483_646);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(ColpClientLimitError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
