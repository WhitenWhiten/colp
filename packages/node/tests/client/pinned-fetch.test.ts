import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type RequestListener } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { defaultPinnedNodeFetch } from '../../src/client/host-resolution.js';
import { ColpClient, type ClientCacheEntry } from '../../src/client/index.js';

async function withServer(handler: RequestListener, run: (url: URL) => Promise<void>) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing port');
    await run(new URL(`http://unresolvable.invalid:${address.port}/path?query=1`));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('Pinned Node fetch over real sockets', () => {
  const fetch = defaultPinnedNodeFetch()!;

  it('pins the address and preserves Host, path, headers, and write bodies', async () => {
    await withServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ host: request.headers.host, url: request.url, method: request.method, body }));
      });
    }, async url => {
      const response = await fetch(url, { method: 'POST', body: '{"ok":true}' }, '127.0.0.1');
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toEqual({ host: url.host, url: '/path?query=1', method: 'POST', body: '{"ok":true}' });
    });
  });

  it.each([204, 205, 304])('handles bodyless status %s without an uncaught error', async status => {
    await withServer((_request, response) => {
      response.writeHead(status, { ETag: '"cached"' });
      response.end();
    }, async url => {
      const response = await fetch(url, {}, '127.0.0.1');
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(response.headers.get('etag')).toBe('"cached"');
    });
  });

  it('returns no body for HEAD requests', async () => {
    await withServer((_request, response) => response.end('ignored'), async url => {
      expect((await fetch(url, { method: 'HEAD' }, '127.0.0.1')).body).toBeNull();
    });
  });

  it('rejects an aborted request before headers arrive', async () => {
    const controller = new AbortController();
    await withServer(() => controller.abort(new Error('deadline')), async url => {
      await expect(fetch(url, { signal: controller.signal }, '127.0.0.1')).rejects.toThrow('deadline');
    });
  });

  it('rejects a truncated response stream', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': '100' });
      response.write('partial');
      setImmediate(() => response.destroy());
    }, async url => {
      const response = await fetch(url, {}, '127.0.0.1');
      await expect(response.text()).rejects.toThrow();
    });
  });

  it('cancels the socket when a response body is discarded', async () => {
    let closed: Promise<unknown>;
    await withServer((_request, response) => {
      closed = once(response, 'close');
      response.write('first chunk');
    }, async url => {
      const response = await fetch(url, {}, '127.0.0.1');
      await response.body!.cancel();
      await closed;
    });
  });

  it('aborts a response body after headers arrive', async () => {
    const controller = new AbortController();
    await withServer((_request, response) => response.write('partial'), async url => {
      const response = await fetch(url, { signal: controller.signal }, '127.0.0.1');
      const pending = response.text();
      controller.abort(new Error('body deadline'));
      await expect(pending).rejects.toThrow();
    });
  });

  it('rejects a signal already aborted without sending a request', async () => {
    const handler = vi.fn<RequestListener>();
    await withServer(handler, async url => {
      const signal = AbortSignal.abort(new Error('already expired'));
      await expect(fetch(url, { signal }, '127.0.0.1')).rejects.toThrow('already expired');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it('uses the policy-approved address for discovery and cached 304 responses', async () => {
    const manifest = await readFile(new URL('../../fixtures/protocol/examples/public-manifest.json', import.meta.url), 'utf8');
    const approvedAddresses: unknown[] = [];
    const builtin = process.getBuiltinModule.bind(process);
    const spy = vi.spyOn(process, 'getBuiltinModule').mockImplementation((specifier: string) => {
      if (specifier !== 'node:http' && specifier !== 'node:https') return builtin(specifier);
      return { request: (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
        approvedAddresses.push(options.hostname);
        return httpRequest({ ...options, hostname: '127.0.0.1' }, callback);
      } };
    });
    try {
      await withServer((request, response) => {
        response.setHeader('ETag', '"manifest"');
        response.setHeader('Content-Type', 'application/json');
        if (request.headers['if-none-match'] === '"manifest"') response.writeHead(304).end();
        else response.end(manifest);
      }, async url => {
        url.protocol = 'https:';
        const entries = new Map<string, ClientCacheEntry>();
        const client = new ColpClient({
          manifestUrl: url.href, resolveHost: async () => ['93.184.216.34'],
          cache: { get: key => entries.get(key), set: (key, value) => { entries.set(key, value); }, delete: key => { entries.delete(key); } },
        });
        expect(await client.discover(true)).toEqual(await client.discover(true));
        expect(approvedAddresses).toEqual(['93.184.216.34', '93.184.216.34']);
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Pinned transport capability and stream boundaries', () => {
  it('fails closed when a resolver is paired with an unpinned custom fetch', () => {
    expect(() => new ColpClient({
      manifestUrl: 'https://public.example/.well-known/collection-protocol',
      fetch: (async () => new Response('{}')) as typeof globalThis.fetch,
      resolveHost: async () => ['93.184.216.34'],
    })).toThrow(/cannot be combined with a custom fetch/u);
  });

  it('fails closed when a resolver is supplied without a runtime pinning transport', () => {
    const spy = vi.spyOn(process, 'getBuiltinModule').mockImplementation(() => undefined);
    try {
      expect(() => new ColpClient({
        manifestUrl: 'https://public.example/.well-known/collection-protocol',
        resolveHost: async () => ['93.184.216.34'],
      })).toThrow(/requires a transport that enforces address pinning/u);
    } finally {
      spy.mockRestore();
    }
  });

  it('passes the original URL and approved address to an explicit pinned transport', async () => {
    const manifest = await readFile(new URL('../../fixtures/protocol/examples/public-manifest.json', import.meta.url), 'utf8');
    const observed: Array<{ url: string; address: string | undefined; host: string | null }> = [];
    const fallback = vi.fn(async () => new Response('{}')) as typeof globalThis.fetch;
    const pinned = vi.fn(async (url: URL, init: RequestInit, address?: string) => {
      observed.push({ url: url.href, address, host: new Headers(init.headers).get('host') });
      return new Response(manifest, { headers: { 'content-type': 'application/json', etag: '"manifest"' } });
    });
    const client = new ColpClient({
      manifestUrl: 'https://public.example/.well-known/collection-protocol',
      fetch: fallback,
      pinnedFetch: pinned,
      resolveHost: async () => ['93.184.216.34'],
    });
    await client.discover(true);
    expect(fallback).not.toHaveBeenCalled();
    expect(observed).toEqual([{
      url: 'https://public.example/.well-known/collection-protocol',
      address: '93.184.216.34',
      host: null,
    }]);
  });

  it.each(['node:http', 'node:https', 'node:stream'])('falls back when %s is unavailable', missing => {
    const builtin = process.getBuiltinModule.bind(process);
    const spy = vi.spyOn(process, 'getBuiltinModule').mockImplementation((specifier: string) => specifier === missing ? undefined : builtin(specifier));
    try { expect(defaultPinnedNodeFetch()).toBeUndefined(); } finally { spy.mockRestore(); }
  });

  function simulatedResponse(response: Readable & { headers: object; statusCode?: number; statusMessage?: string }) {
    const request = Object.assign(new EventEmitter(), {
      write: vi.fn(), destroy: vi.fn(), end: () => callback(response),
    });
    let callback: (response: object) => void;
    const requestFn = vi.fn((_options, cb) => { callback = cb; return request; });
    const builtin = process.getBuiltinModule.bind(process);
    const spy = vi.spyOn(process, 'getBuiltinModule').mockImplementation((specifier: string) =>
      specifier === 'node:stream' ? builtin(specifier) : { request: requestFn });
    let transport;
    try { transport = defaultPinnedNodeFetch()!; } finally { spy.mockRestore(); }
    return { transport, requestFn, request };
  }

  it('preserves HTTPS SNI and Host while writing a byte body to the pinned address', async () => {
    const incoming = Object.assign(new PassThrough(), { headers: { 'x-values': ['first', 'second'], ignored: undefined } });
    const { transport, requestFn, request } = simulatedResponse(incoming);
    const body = new Uint8Array([1, 2, 3]);
    const response = await transport(new URL('https://virtual.example/path'), { body, headers: { Host: 'explicit.example' } }, '2606:4700::1111');
    incoming.end('ok');
    expect(await response.text()).toBe('ok');
    expect(response.status).toBe(500);
    expect(response.headers.get('x-values')).toBe('first, second');
    expect(requestFn.mock.calls[0]?.[0]).toMatchObject({ hostname: '2606:4700::1111', servername: 'virtual.example', headers: { host: 'explicit.example' } });
    expect(request.write).toHaveBeenCalledWith(body);
  });

  it('rejects an unrepresentable HTTP response instead of throwing from the socket callback', async () => {
    const incoming = Object.assign(new PassThrough(), { headers: {}, statusCode: 199 });
    const { transport } = simulatedResponse(incoming);
    await expect(transport(new URL('http://[::1]/'), {})).rejects.toThrow();
    expect(incoming.destroyed).toBe(true);
  });

  it('bounds queued bytes while the caller has not consumed the body', async () => {
    let produced = 0;
    const incoming = Object.assign(new Readable({
      highWaterMark: 1024,
      read() { produced += 1024; this.push(Buffer.alloc(1024)); },
    }), { headers: {}, statusCode: 200 });
    const { transport } = simulatedResponse(incoming);
    const response = await transport(new URL('http://virtual.example/'), {});
    await new Promise(resolve => setImmediate(resolve));
    expect(produced).toBeLessThanOrEqual(66 * 1024);
    await response.body!.cancel();
    expect(incoming.destroyed).toBe(true);
  });
});
