import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, test, vi } from 'vitest';
import {
  createHardenedEgressFetch,
  createProductionEgressConnector,
  HardenedEgressError,
  planHardenedEgressTarget,
  type HardenedEgressConnector,
} from '../../../src/infrastructure/egress/index.js';

const PUBLIC_IP = '93.184.216.34';

afterEach(() => {
  vi.restoreAllMocks();
});

function countingConnect(): { readonly connect: HardenedEgressConnector; readonly calls: () => number } {
  let calls = 0;
  return {
    connect: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: 'http://public.example.test/plain' } });
    },
    calls: () => calls,
  };
}

function isDenied(reason: 'denied' | 'denied_address') {
  return (error: unknown) => error instanceof HardenedEgressError && error.reason === reason;
}

describe('default hardened egress stays HTTPS-only', () => {
  test('a plain HTTP target is denied before DNS or connection', async () => {
    let resolves = 0;
    const { connect, calls } = countingConnect();
    const fetchImpl = createHardenedEgressFetch({
      resolve: async () => { resolves += 1; return [PUBLIC_IP]; },
      connect,
    });
    await assert.rejects(fetchImpl('http://public.example.test/plain'), isDenied('denied'));
    assert.equal(resolves, 0);
    assert.equal(calls(), 0);
  });

  test('an HTTPS hop redirecting to plain HTTP is denied without connecting again', async () => {
    const { connect, calls } = countingConnect();
    const fetchImpl = createHardenedEgressFetch({ resolve: async () => [PUBLIC_IP], connect });
    await assert.rejects(fetchImpl('https://public.example.test/secure'), isDenied('denied'));
    assert.equal(calls(), 1);
  });

  test('the planner without an explicit opt-in rejects HTTP', async () => {
    await assert.rejects(
      planHardenedEgressTarget('egress target', 'http://public.example.test/', async () => [PUBLIC_IP]),
      isDenied('denied'),
    );
  });
});

describe('explicit public-HTTP planning keeps every non-scheme rule', () => {
  const optIn = { allowPublicHttp: true } as const;
  const plan = (url: string, addresses: readonly string[] = [PUBLIC_IP]) =>
    planHardenedEgressTarget('link-health', url, async () => addresses, undefined, optIn);

  test('a public HTTP host is pinned to its validated address with the URL preserved', async () => {
    const target = await plan('http://public.example.test:8080/path?q=1');
    assert.equal(target.url.href, 'http://public.example.test:8080/path?q=1');
    assert.equal(target.ip, PUBLIC_IP);
    assert.equal(target.family, 4);
  });

  test('private, mixed and loopback DNS answers are still denied', async () => {
    await assert.rejects(plan('http://internal.example.test/', ['10.0.0.1']), isDenied('denied_address'));
    await assert.rejects(plan('http://mixed.example.test/', [PUBLIC_IP, '127.0.0.1']), isDenied('denied_address'));
  });

  test('private literals, metadata hosts, userinfo and other schemes are still denied before DNS', async () => {
    let resolves = 0;
    const planCounting = (url: string) => planHardenedEgressTarget(
      'link-health', url, async () => { resolves += 1; return [PUBLIC_IP]; }, undefined, optIn,
    );
    for (const url of [
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://[::1]/',
      'http://localhost/',
      'http://169.254.169.254/latest/meta-data',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://user:secret@public.example.test/',
      'ftp://public.example.test/file',
    ]) {
      await assert.rejects(planCounting(url), isDenied('denied'), url);
    }
    assert.equal(resolves, 0);
  });
});

describe('production connector transport selection', () => {
  test('an approved http: target uses node:http on the pinned address and keeps the URL host', async () => {
    const seen: Array<{ method?: string; host?: string; url?: string }> = [];
    const server = http.createServer((request, response) => {
      seen.push({ method: request.method, host: request.headers.host, url: request.url });
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(request.method === 'HEAD' ? undefined : 'plain http body');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const httpRequest = vi.spyOn(http, 'request');
    const httpsRequest = vi.spyOn(https, 'request');
    try {
      const { port } = server.address() as AddressInfo;
      const connect = createProductionEgressConnector();
      // The hostname does not resolve anywhere: only the pinned lookup can reach the server.
      const url = new URL(`http://bookmarks.invalid:${port}/probe?x=1`);
      const head = await connect({ url, ip: '127.0.0.1', family: 4 }, { method: 'HEAD', headers: { accept: '*/*' } });
      assert.equal(head.status, 200);
      await head.body?.cancel();
      const get = await connect({ url, ip: '127.0.0.1', family: 4 }, { method: 'GET' });
      assert.equal(await get.text(), 'plain http body');
      assert.deepEqual(seen, [
        { method: 'HEAD', host: `bookmarks.invalid:${port}`, url: '/probe?x=1' },
        { method: 'GET', host: `bookmarks.invalid:${port}`, url: '/probe?x=1' },
      ]);
      assert.equal(httpRequest.mock.calls.length, 2);
      assert.equal(httpsRequest.mock.calls.length, 0);
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  test('a target with any other scheme is rejected before a request is opened', async () => {
    const httpRequest = vi.spyOn(http, 'request');
    const httpsRequest = vi.spyOn(https, 'request');
    await assert.rejects(
      createProductionEgressConnector()({ url: new URL('ftp://files.example.test/x'), ip: PUBLIC_IP, family: 4 }, {}),
      isDenied('denied'),
    );
    assert.equal(httpRequest.mock.calls.length, 0);
    assert.equal(httpsRequest.mock.calls.length, 0);
  });
});
