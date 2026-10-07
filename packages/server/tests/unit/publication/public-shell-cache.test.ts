import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createInternalOriginFetch,
  createWebShellCache,
  WEB_SHELL_CACHE_TTL_MS,
  WEB_SHELL_MAX_STALE_MS,
} from '../../../src/infrastructure/http/index.js';

test('caches the shell for 60s and revalidates with If-None-Match', async () => {
  let now = 1_000;
  const calls: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
  const cache = createWebShellCache({
    origin: 'http://web:80',
    now: () => now,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers });
      if (init.headers['If-None-Match'] === '"v1"') {
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      }
      return new Response('<html>v1</html>', { status: 200, headers: { etag: '"v1"' } });
    },
  });
  const first = await cache.load();
  assert.deepEqual(first, { kind: 'ok', body: '<html>v1</html>' });
  now += WEB_SHELL_CACHE_TTL_MS - 1;
  const cached = await cache.load();
  assert.deepEqual(cached, { kind: 'ok', body: '<html>v1</html>' });
  assert.equal(calls.length, 1);
  now += 2;
  const revalidated = await cache.load();
  assert.deepEqual(revalidated, { kind: 'ok', body: '<html>v1</html>' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.headers['If-None-Match'], '"v1"');
});

test('concurrent cold loads share one origin fetch', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fetches = 0;
  const cache = createWebShellCache({
    origin: 'http://web:80',
    fetch: async () => {
      fetches += 1;
      await gate;
      return new Response('<html>shared</html>', { status: 200 });
    },
  });
  const first = cache.load();
  const second = cache.load();
  release!();
  assert.deepEqual(await first, { kind: 'ok', body: '<html>shared</html>' });
  assert.deepEqual(await second, { kind: 'ok', body: '<html>shared</html>' });
  assert.equal(fetches, 1);
});

test('returns unavailable when the shell is missing and the cache is empty', async () => {
  const cache = createWebShellCache({
    origin: 'http://web:80',
    fetch: async () => new Response('nope', { status: 502 }),
  });
  assert.deepEqual(await cache.load(), { kind: 'unavailable' });
});

test('keeps the cached body when a later fetch fails', async () => {
  let fail = false;
  let now = 0;
  const cache = createWebShellCache({
    origin: 'http://web:80',
    now: () => now,
    fetch: async () => {
      if (fail) throw new Error('down');
      return new Response('<html>ok</html>', { status: 200, headers: { etag: '"a"' } });
    },
  });
  assert.deepEqual(await cache.load(), { kind: 'ok', body: '<html>ok</html>' });
  fail = true;
  now += WEB_SHELL_CACHE_TTL_MS + 1;
  assert.deepEqual(await cache.load(), { kind: 'ok', body: '<html>ok</html>' });
});

test('repeated refresh failures cannot extend stale shells indefinitely; recovery loads the new build', async () => {
  for (const failure of ['throw', '503'] as const) {
    let now = 0;
    let state = 'old';
    const cache = createWebShellCache({
      origin: 'http://web:80', now: () => now,
      fetch: async () => {
        if (state === 'failed') {
          if (failure === 'throw') throw new Error('origin down');
          return new Response(null, { status: 503 });
        }
        return new Response(`<html>${state}</html>`);
      },
    });
    assert.equal((await cache.load()).body, '<html>old</html>');
    state = 'failed';
    now = WEB_SHELL_CACHE_TTL_MS + 1;
    assert.equal((await cache.load()).body, '<html>old</html>');
    now = WEB_SHELL_CACHE_TTL_MS + WEB_SHELL_MAX_STALE_MS;
    assert.deepEqual(await cache.load(), { kind: 'unavailable' });
    now += 1_000;
    assert.deepEqual(await cache.load(), { kind: 'unavailable' });
    state = 'new';
    assert.equal((await cache.load()).body, '<html>new</html>');
  }
});

test('internal fetch refuses URLs outside the configured origin path', async () => {
  const fetchImpl = createInternalOriginFetch('http://web:80', async () => new Response('ok'));
  await assert.rejects(
    () => fetchImpl('http://web:80/other.html', { headers: {}, signal: AbortSignal.timeout(10) }),
    /outside WEB_SHELL_ORIGIN/u,
  );
  await assert.rejects(
    () => fetchImpl('https://evil.example/index.html', { headers: {}, signal: AbortSignal.timeout(10) }),
    /outside WEB_SHELL_ORIGIN/u,
  );
});
