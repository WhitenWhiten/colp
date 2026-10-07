import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from 'vitest';
import {
  fetchReadableReplicaHtml,
  READABLE_REPLICA_ACCEPT,
  READABLE_REPLICA_ACCEPT_ENCODING,
  READABLE_REPLICA_ACCEPT_LANGUAGE,
  READABLE_REPLICA_USER_AGENT,
  type FetchReadableReplicaHtmlOptions,
} from '../../../src/infrastructure/collections/index.js';

const PUBLIC_PIN = '1.1.1.1';
const START = 'https://readable.test/from';
const FINAL = 'https://readable.test/to';
const HTML = '<html><body><p>ok</p></body></html>';

function fetchWith(connect: NonNullable<FetchReadableReplicaHtmlOptions['connect']>, url = START) {
  return fetchReadableReplicaHtml({
    url,
    timeoutMs: 8_000,
    connectTimeoutMs: 3_000,
    maxBodyBytes: 65_536,
    resolve: async () => [PUBLIC_PIN],
    connect,
  });
}

function headerValue(headers: RequestInit['headers'], name: string): string | undefined {
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name)?.[1];
  const record = headers as Record<string, string>;
  return record[name] ?? record[Object.keys(record).find((key) => key.toLowerCase() === name) ?? ''];
}

test('request identifies as a browser-compatible bot and negotiates language and compression', async () => {
  let seen: RequestInit['headers'];
  const result = await fetchWith(async (_target, init) => {
    seen = init.headers;
    return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
  });
  assert.equal(result.kind, 'html');
  assert.equal(READABLE_REPLICA_USER_AGENT.startsWith('Mozilla/5.0 (compatible; Known-ReadableReplica/1'), true);
  assert.equal(headerValue(seen, 'user-agent'), READABLE_REPLICA_USER_AGENT);
  assert.equal(headerValue(seen, 'accept'), READABLE_REPLICA_ACCEPT);
  assert.equal(headerValue(seen, 'accept-language'), READABLE_REPLICA_ACCEPT_LANGUAGE);
  assert.equal(headerValue(seen, 'accept-encoding'), READABLE_REPLICA_ACCEPT_ENCODING);
  assert.equal(READABLE_REPLICA_ACCEPT_LANGUAGE, 'en,zh;q=0.8,*;q=0.5');
});

test('gzip-encoded bodies are inflated and non-utf8 charsets are honoured', async () => {
  const gz = await fetchWith(async () => new Response(gzipSync(HTML), {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' },
  }));
  assert.equal(gz.kind, 'html');
  if (gz.kind !== 'html') throw new Error('expected html');
  assert.equal(gz.html, HTML);

  const latin1 = await fetchWith(async () => new Response(Uint8Array.from([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]), {
    status: 200, headers: { 'content-type': 'text/html; charset=ISO-8859-1' },
  }));
  assert.equal(latin1.kind, 'html');
  if (latin1.kind !== 'html') throw new Error('expected html');
  assert.equal(latin1.html, '<p>café</p>');

  const metaGbk = await fetchWith(async () => new Response(Uint8Array.from([
    ...new TextEncoder().encode('<meta charset="gbk"><p>'), 0xd6, 0xd0, 0xce, 0xc4, ...new TextEncoder().encode('</p>'),
  ]), { status: 200, headers: { 'content-type': 'text/html' } }));
  assert.equal(metaGbk.kind, 'html');
  if (metaGbk.kind !== 'html') throw new Error('expected html');
  let gbkSupported = true;
  try {
    new TextDecoder('gbk');
  } catch {
    gbkSupported = false;
  }
  if (gbkSupported) assert.equal(metaGbk.html.endsWith('<p>中文</p>'), true);
});

test('oversized inflated bodies map to too_large and undecodable encodings to http', async () => {
  const tooLarge = await fetchWith(async () => new Response(gzipSync('<p>' + 'a'.repeat(200_000) + '</p>'), {
    status: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
  }));
  assert.deepEqual(tooLarge, { kind: 'failure', failureCode: 'too_large', hopUrls: [START] });

  const corrupt = await fetchWith(async () => new Response('definitely not gzip', {
    status: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
  }));
  assert.deepEqual(corrupt, { kind: 'failure', failureCode: 'http', hopUrls: [START] });

  const unsupported = await fetchWith(async () => new Response(HTML, {
    status: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'zstd' },
  }));
  assert.deepEqual(unsupported, { kind: 'failure', failureCode: 'http', hopUrls: [START] });
});

test('every 3xx variant is followed through the facade to the final HTML, and the cap maps to http', async () => {
  const chain: Record<string, number> = {
    '/from': 308, '/hop1': 302, '/hop2': 303, '/hop3': 307, '/hop4': 301,
  };
  const next: Record<string, string> = {
    '/from': '/hop1', '/hop1': '/hop2', '/hop2': '/hop3', '/hop3': '/hop4', '/hop4': '/final',
  };
  const followed = await fetchWith(async (target) => {
    const status = chain[target.url.pathname];
    if (status !== undefined) {
      return new Response(null, { status, headers: { location: next[target.url.pathname] ?? '/' } });
    }
    return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
  });
  assert.equal(followed.kind, 'html');
  if (followed.kind !== 'html') throw new Error('expected html');
  assert.equal(followed.hopUrls.length, 6);
  assert.equal(followed.hopUrls[5], 'https://readable.test/final');

  let hops = 0;
  const looping = await fetchWith(async (target) => {
    hops += 1;
    return new Response(null, { status: 302, headers: { location: `${target.url.pathname}x` } });
  });
  assert.equal(looping.kind, 'failure');
  if (looping.kind !== 'failure') throw new Error('expected failure');
  assert.equal(looping.failureCode, 'http');
  assert.equal(hops, 6); // start + 5 redirects, then the redirect cap trips
});

test('fetch returns recorded redirect hops on html and failure results', async () => {
  const html = await fetchReadableReplicaHtml({
    url: START,
    timeoutMs: 8_000,
    connectTimeoutMs: 3_000,
    maxBodyBytes: 65_536,
    resolve: async () => [PUBLIC_PIN],
    connect: async (target) => {
      if (target.url.pathname === '/from') {
        return new Response(null, { status: 301, headers: { location: FINAL } });
      }
      return new Response('<html><body><p>ok</p></body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    },
  });
  assert.equal(html.kind, 'html');
  if (html.kind !== 'html') throw new Error('expected html');
  assert.equal(html.hopUrls.includes(START), true);
  assert.equal(html.hopUrls[html.hopUrls.length - 1], FINAL);

  const failed = await fetchReadableReplicaHtml({
    url: START,
    timeoutMs: 8_000,
    connectTimeoutMs: 3_000,
    maxBodyBytes: 65_536,
    resolve: async () => [PUBLIC_PIN],
    connect: async (target) => {
      if (target.url.pathname === '/from') {
        return new Response(null, { status: 301, headers: { location: FINAL } });
      }
      return new Response('%PDF', {
        status: 200, headers: { 'content-type': 'application/pdf' },
      });
    },
  });
  assert.equal(failed.kind, 'failure');
  if (failed.kind !== 'failure') throw new Error('expected failure');
  assert.equal(failed.failureCode, 'not_html');
  assert.equal(failed.hopUrls[failed.hopUrls.length - 1], FINAL);
});

test('invalid bookmark URL returns empty hopUrls', async () => {
  const result = await fetchReadableReplicaHtml({
    url: 'not-a-url',
    timeoutMs: 8_000,
    connectTimeoutMs: 3_000,
    maxBodyBytes: 65_536,
  });
  assert.deepEqual(result, { kind: 'failure', failureCode: 'invalid_url', hopUrls: [] });
});

test('LP-03: head-only callers keep the prefix of an unencoded body and override identity headers', async () => {
  const head = '<html><head><meta property="og:image" content="/card.png"></head><body>';
  const huge = `${head}${'x'.repeat(200_000)}</body></html>`;
  let seen: RequestInit['headers'];
  const options = {
    url: START,
    timeoutMs: 8_000,
    connectTimeoutMs: 3_000,
    maxBodyBytes: 65_536,
    resolve: async () => [PUBLIC_PIN],
    userAgent: 'Known-LinkPreview-test',
    acceptEncoding: 'identity',
    truncateUnencodedBody: true,
  } satisfies Partial<FetchReadableReplicaHtmlOptions>;
  const truncated = await fetchReadableReplicaHtml({
    ...options,
    connect: async (_target, init) => {
      seen = init.headers;
      return new Response(huge, { status: 200, headers: { 'content-type': 'text/html' } });
    },
  });
  assert.equal(truncated.kind, 'html');
  if (truncated.kind !== 'html') throw new Error('expected html');
  assert.equal(truncated.html.length, 65_536);
  assert.ok(truncated.html.startsWith(head));
  assert.equal(headerValue(seen, 'user-agent'), 'Known-LinkPreview-test');
  assert.equal(headerValue(seen, 'accept-encoding'), 'identity');

  // An encoded body cannot be cut safely: it keeps the too_large failure.
  const encoded = await fetchReadableReplicaHtml({
    ...options,
    connect: async () => new Response(gzipSync(huge), {
      status: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
    }),
  });
  assert.equal(encoded.kind, 'failure');

  // Without the opt-in, the reader contract is unchanged.
  const reader = await fetchWith(async () => new Response(huge, { status: 200, headers: { 'content-type': 'text/html' } }));
  assert.deepEqual(reader, { kind: 'failure', failureCode: 'too_large', hopUrls: [START] });
});
