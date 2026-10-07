import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { startPublicationServer } from '../../node/examples/publication-server.mjs';
import { CHECKS, formatReport, resolveManifestUrl, runConformance, sanitizeTerminalText } from '../src/index.mjs';
import { createHttpClient, createPinnedFetch, ResponseTooLargeError } from '../src/http.mjs';

const exec = promisify(execFile);
const cli = new URL('../bin/colp-conformance.mjs', import.meta.url);

function statusOf(report, id) {
  return report.results.find((result) => result.id === id).status;
}

/**
 * Forwards to the example server and breaks selected rules, so each kind of
 * violation can be shown to be caught.
 */
async function startMisbehavingProxy(upstream, faults) {
  let origin;
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const url = new URL(incoming.url, upstream.origin);
      if (faults.acceptUnknownQuery && url.searchParams.has('colpConformanceUnknown')) url.search = '';
      const headers = Object.fromEntries(Object.entries(incoming.headers)
        .filter(([name]) => !['host', 'connection'].includes(name)));
      const response = await fetch(url, { headers });
      const responseHeaders = Object.fromEntries(response.headers);
      delete responseHeaders['content-length'];
      if (faults.stripEtag) delete responseHeaders.etag;
      let body = (await response.text()).replaceAll(upstream.origin, origin);
      if (responseHeaders.link) responseHeaders.link = responseHeaders.link.replaceAll(upstream.origin, origin);
      if (faults.bareNotFound && response.status === 404) {
        responseHeaders['content-type'] = 'text/plain';
        body = 'not found';
      }
      if (faults.duplicateManifestMember && url.pathname === '/.well-known/collection-protocol') {
        body = body.replace('{', '{"title":"duplicate",');
      }
      if (faults.claimMorePages && url.pathname.endsWith('/snapshot')) {
        body = body.replace('"nextCursor":null,"hasMore":false', '"nextCursor":"page-two","hasMore":true');
      }
      outgoing.writeHead(response.status, responseHeaders);
      outgoing.end(response.status === 304 ? undefined : body);
    })().catch((error) => {
      outgoing.writeHead(502);
      outgoing.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

test('passes every observed check against the reference example server', async () => {
  const server = await startPublicationServer();
  try {
    const report = await runConformance(server.origin);
    assert.equal(report.target, server.manifestUrl);
    assert.equal(report.summary.fail, 0, formatReport(report));
    assert.equal(report.summary.warn, 0, formatReport(report));
    for (const id of ['PUB-0011', 'PUB-0018', 'CORE-0001', 'PUB-0010', 'PUB-0008', 'PUB-0022', 'PUB-0040']) {
      assert.equal(statusOf(report, id), 'pass', id);
    }
    // The example serves single-page Snapshots, so pagination is not observable.
    assert.equal(statusOf(report, 'PUB-0034'), 'skip');
  } finally {
    await server.close();
  }
});

test('reports protocol violations as failures and warnings', async () => {
  const upstream = await startPublicationServer();
  const proxy = await startMisbehavingProxy(upstream, {
    acceptUnknownQuery: true,
    bareNotFound: true,
    stripEtag: true,
    claimMorePages: true,
  });
  try {
    const report = await runConformance(proxy.origin);
    assert.equal(statusOf(report, 'PUB-0010'), 'fail');
    assert.equal(statusOf(report, 'PUB-0008'), 'fail');
    assert.equal(statusOf(report, 'PUB-0021'), 'warn');
    assert.equal(statusOf(report, 'PUB-0027'), 'warn');
    assert.equal(statusOf(report, 'PUB-0034'), 'warn');
    assert.equal(statusOf(report, 'PUB-0022'), 'skip');
    assert.match(formatReport(report), /colpConformanceUnknown=1 returned 200/u);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('rejects a Manifest that is not I-JSON and skips what depends on it', async () => {
  const upstream = await startPublicationServer();
  const proxy = await startMisbehavingProxy(upstream, { duplicateManifestMember: true });
  try {
    const report = await runConformance(`${proxy.origin}/.well-known/collection-protocol`);
    assert.equal(statusOf(report, 'PUB-0017'), 'fail');
    assert.equal(statusOf(report, 'PUB-0001'), 'skip');
    assert.deepEqual(report.results.find((result) => result.id === 'PUB-0001').details, ['no valid Manifest to start from']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('reports an unreachable server instead of throwing', async () => {
  const report = await runConformance('http://127.0.0.1:9', { timeoutMs: 2_000 });
  assert.equal(statusOf(report, 'PUB-0011'), 'fail');
  assert.equal(report.summary.pass, 0);
});

test('stops at the request budget and says so', async () => {
  const server = await startPublicationServer();
  try {
    const report = await runConformance(server.origin, { maxRequests: 3 });
    assert.equal(report.requestCount, 3);
    assert.match(report.notes[0], /request budget of 3/iu);
  } finally {
    await server.close();
  }
});

test('resolves a server origin to its well-known Manifest URL', () => {
  assert.equal(resolveManifestUrl('https://alice.example/some/page'), 'https://alice.example/.well-known/collection-protocol');
  assert.equal(
    resolveManifestUrl('https://alice.example/.well-known/collection-protocol'),
    'https://alice.example/.well-known/collection-protocol',
  );
  assert.throws(() => resolveManifestUrl('ftp://alice.example/'), /http\(s\)/u);
});

test('cites requirement IDs and levels exactly as the registry defines them', async () => {
  const registry = await readFile(new URL('../../../protocol/requirements.yaml', import.meta.url), 'utf8');
  const levels = new Map();
  for (const match of registry.matchAll(/- id: (\S+)\s+level: (\S+)/gu)) levels.set(match[1], match[2]);
  for (const check of CHECKS) assert.equal(levels.get(check.id), check.level, check.id);
});

test('the CLI prints JSON and exits 0 when no MUST check fails', async () => {
  const server = await startPublicationServer();
  try {
    const { stdout } = await exec(process.execPath, [cli.pathname, '--json', server.origin]);
    const report = JSON.parse(stdout);
    assert.equal(report.summary.fail, 0);
  } finally {
    await server.close();
  }
});

test('the CLI exits 1 on a failing server and 2 on a usage error', async () => {
  await assert.rejects(exec(process.execPath, [cli.pathname, '--timeout', '2000', 'http://127.0.0.1:9']), { code: 1 });
  await assert.rejects(exec(process.execPath, [cli.pathname]), { code: 2 });
  await assert.rejects(exec(process.execPath, [cli.pathname, '--max-pages', '0', 'http://127.0.0.1:9']), { code: 2 });
});

test('checks a DNS answer before the first conformance request', async () => {
  const calls = [];
  const http = createHttpClient({
    initialOrigin: 'https://public.example',
    resolveHost: async () => ['10.0.0.7'],
    fetch: async (url) => {
      calls.push(String(url));
      return new Response('{}');
    },
  });

  await assert.rejects(
    http.request('https://public.example/.well-known/collection-protocol'),
    /DNS-resolved private or local target/u,
  );
  assert.deepEqual(calls, []);
});

test('charges DNS resolution to the request budget and applies the request deadline', async (t) => {
  // AbortSignal.timeout deliberately does not keep the event loop alive.
  // This simulated resolver has no DNS socket, so give the test a handle until
  // its deadline fires, then release it even if an assertion fails.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  let resolveStarted = false;
  let fetchCalled = false;
  const http = createHttpClient({
    timeoutMs: 20,
    maxRequests: 1,
    resolveHost: async () => {
      resolveStarted = true;
      await new Promise(() => {});
    },
    fetch: async () => {
      fetchCalled = true;
      return new Response('{}');
    },
  });

  await assert.rejects(
    http.request('https://public.example/.well-known/collection-protocol'),
    /could not resolve the target host/u,
  );
  assert.equal(resolveStarted, true);
  assert.equal(fetchCalled, false);
  assert.equal(http.requestCount, 1);
  await assert.rejects(
    http.request('https://public.example/.well-known/collection-protocol'),
    /Request budget of 1 exhausted/u,
  );
  assert.equal(http.requestCount, 1);
});

test('pinned transport connects to the approved address while preserving the URL Host', async () => {
  let observedHost;
  const server = createServer((request, response) => {
    observedHost = request.headers.host;
    response.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const response = await createPinnedFetch()(
      new URL(`http://virtual.example:${port}/health`),
      { method: 'GET', headers: new Headers() },
      '127.0.0.1',
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
    assert.equal(observedHost, `virtual.example:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the default resolver accepts a public IPv6 URL hostname', async () => {
  const calls = [];
  const http = createHttpClient({
    fetch: async (url) => {
      calls.push(String(url));
      return new Response('{}');
    },
  });
  const url = 'https://[2606:4700:4700::1111]/manifest';
  assert.equal((await http.request(url)).status, 200);
  assert.deepEqual(calls, [url]);
});

test('uses manual redirects and rejects a private Location before the next request', async () => {
  const calls = [];
  const http = createHttpClient({
    initialOrigin: 'https://public.example',
    resolveHost: async () => ['93.184.216.34'],
    fetch: async (url, init) => {
      calls.push({ url: String(url), redirect: init.redirect });
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1:9/internal' },
      });
    },
  });

  await assert.rejects(
    http.request('https://public.example/start'),
    /private or local target/u,
  );
  assert.deepEqual(calls, [{ url: 'https://public.example/start', redirect: 'manual' }]);
});

test('applies a smaller per-request cap for cumulative Snapshot budgets', async () => {
  const http = createHttpClient({
    maxBytes: 16,
    initialOrigin: 'https://public.example',
    resolveHost: async () => ['93.184.216.34'],
    fetch: async () => new Response('0123456789'),
  });
  await assert.rejects(
    http.request('https://public.example/snapshot', { maxBytes: 5 }),
    ResponseTooLargeError,
  );
});

test('sanitizes ANSI and control sequences in terminal reports', () => {
  const unsafe = '\u001b[31mred\u001b[0m\nforged\u0000';
  assert.equal(sanitizeTerminalText(unsafe), 'red\\nforged\\x00');
  const output = formatReport({
    target: `https://example.test/${unsafe}`,
    results: [{
      status: 'fail', id: 'PUB-0011', level: 'MUST', title: 'Manifest', details: [unsafe],
    }],
    notes: [unsafe],
    summary: { pass: 0, fail: 1, warn: 0, skip: 0 },
    requestCount: 1,
  });
  assert.doesNotMatch(output, /\u001b/u);
  assert.match(output, /red\\nforged\\x00/u);
});
