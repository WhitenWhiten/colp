import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  mapLinkHealthProbeObservation,
  normalizeBookmarkUrl,
} from '../../../src/modules/collections/index.js';
import {
  createLinkHealthHostGate,
  probeBookmarkUrl,
} from '../../../src/infrastructure/collections/index.js';
import {
  HardenedEgressError,
  type HardenedEgressConnector,
  type HardenedEgressTarget,
} from '../../../src/infrastructure/egress/index.js';

const PUBLIC_PIN = '1.1.1.1';
const START = 'https://bookmarks.test/from';
const FINAL = 'https://bookmarks.test/to';

afterEach(() => {
  vi.useRealTimers();
});

function fakeResolve(addresses: readonly string[] = [PUBLIC_PIN]) {
  const calls: string[] = [];
  const resolve = async (hostname: string) => {
    calls.push(hostname);
    return addresses;
  };
  return { resolve, calls };
}

function recordingConnect(
  handler: (target: HardenedEgressTarget, init: RequestInit) => Promise<Response>,
): { connect: HardenedEgressConnector; hops: string[]; connectCalls: number } {
  const hops: string[] = [];
  let connectCalls = 0;
  const connect: HardenedEgressConnector = async (target, init) => {
    connectCalls += 1;
    hops.push(target.url.href);
    return handler(target, init);
  };
  return { connect, hops, get connectCalls() { return connectCalls; } };
}

test('mapLinkHealthProbeObservation maps egress classes without touching the network', () => {
  assert.deepEqual(mapLinkHealthProbeObservation({ kind: 'invalid_url' }), {
    status: 'broken', httpStatus: null, finalUrl: null, errorClass: 'invalid_url',
  });
  assert.deepEqual(mapLinkHealthProbeObservation({ kind: 'timeout' }), {
    status: 'broken', httpStatus: null, finalUrl: null, errorClass: 'timeout',
  });
  assert.deepEqual(mapLinkHealthProbeObservation({ kind: 'denied' }), {
    status: 'broken', httpStatus: null, finalUrl: null, errorClass: 'denied',
  });
  assert.deepEqual(mapLinkHealthProbeObservation({ kind: 'dns' }), {
    status: 'broken', httpStatus: null, finalUrl: null, errorClass: 'dns',
  });
  assert.deepEqual(mapLinkHealthProbeObservation({ kind: 'http', httpStatus: 404 }), {
    status: 'broken', httpStatus: 404, finalUrl: null, errorClass: 'http',
  });
  assert.deepEqual(mapLinkHealthProbeObservation({
    kind: 'completed', httpStatus: 200, startUrl: START, finalUrl: START,
  }), {
    status: 'healthy', httpStatus: 200, finalUrl: null, errorClass: null,
  });
  assert.equal(normalizeBookmarkUrl('https://BOOKMARKS.test/from/'), normalizeBookmarkUrl(START));
  assert.deepEqual(mapLinkHealthProbeObservation({
    kind: 'completed', httpStatus: 200, startUrl: START, finalUrl: FINAL,
  }), {
    status: 'redirect', httpStatus: 200, finalUrl: FINAL, errorClass: null,
  });
  assert.deepEqual(mapLinkHealthProbeObservation({
    kind: 'completed', httpStatus: 200,
    startUrl: 'http://bookmarks.test/x', finalUrl: 'https://bookmarks.test/x',
  }), {
    status: 'redirect', httpStatus: 200, finalUrl: 'https://bookmarks.test/x', errorClass: null,
  });
  assert.deepEqual(mapLinkHealthProbeObservation({
    kind: 'completed', httpStatus: 403, startUrl: START, finalUrl: START,
  }), {
    status: 'broken', httpStatus: 403, finalUrl: null, errorClass: 'http',
  });
  assert.deepEqual(mapLinkHealthProbeObservation({
    kind: 'completed', httpStatus: 503, startUrl: START, finalUrl: START,
  }), {
    status: 'broken', httpStatus: 503, finalUrl: null, errorClass: 'http',
  });
});

test('probe records the last wrapped-connect hop and never reads response.url', async () => {
  const { resolve, calls } = fakeResolve();
  const connector = recordingConnect(async (target) => {
    if (target.url.pathname === '/from') {
      return new Response(null, { status: 301, headers: { location: FINAL } });
    }
    return new Response(null, { status: 200 });
  });
  const result = await probeBookmarkUrl({
    url: START, timeoutMs: 8_000, connectTimeoutMs: 3_000,
    resolve, connect: connector.connect,
  });
  assert.equal(result.fact.status, 'redirect');
  assert.equal(result.fact.finalUrl, FINAL);
  assert.equal(result.hopUrls[result.hopUrls.length - 1], FINAL);
  assert.equal(calls.length > 0, true);
  assert.equal(result.hopUrls.includes(''), false);
});

test('probe maps a same-URL 200 to healthy', async () => {
  const { resolve } = fakeResolve();
  const result = await probeBookmarkUrl({
    url: START, timeoutMs: 8_000, connectTimeoutMs: 3_000, resolve,
    connect: async () => new Response(null, { status: 200 }),
  });
  assert.equal(result.fact.status, 'healthy');
  assert.equal(result.fact.finalUrl, null);
  assert.equal(result.fact.errorClass, null);
});

test('denied_address from connect is broken/denied and resolve was called', async () => {
  const { resolve, calls } = fakeResolve();
  let connectCalls = 0;
  const result = await probeBookmarkUrl({
    url: START, timeoutMs: 8_000, connectTimeoutMs: 3_000, resolve,
    connect: async (target) => {
      connectCalls += 1;
      assert.equal(target.ip, PUBLIC_PIN);
      throw new HardenedEgressError('denied_address', 'link-health resolves to a disallowed address');
    },
  });
  assert.equal(result.fact.status, 'broken');
  assert.equal(result.fact.errorClass, 'denied');
  assert.equal(calls.length > 0, true);
  assert.equal(connectCalls, 1);
});

test('policy-denied private resolve does not connect', async () => {
  const { resolve, calls } = fakeResolve(['10.0.0.1']);
  let connectCalls = 0;
  const result = await probeBookmarkUrl({
    url: START, timeoutMs: 8_000, connectTimeoutMs: 3_000, resolve,
    connect: async () => {
      connectCalls += 1;
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(result.fact.status, 'broken');
  assert.equal(result.fact.errorClass, 'denied');
  assert.equal(calls.length > 0, true);
  assert.equal(connectCalls, 0);
});

test('invalid bookmark URLs are broken without connecting', async () => {
  let connectCalls = 0;
  const result = await probeBookmarkUrl({
    url: 'https://user:pass@bookmarks.test/secret',
    timeoutMs: 8_000, connectTimeoutMs: 3_000,
    resolve: async () => [PUBLIC_PIN],
    connect: async () => {
      connectCalls += 1;
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(result.fact.errorClass, 'invalid_url');
  assert.equal(connectCalls, 0);
});

test('TLS handshake failures are http without a status so they are not 4xx broken', async () => {
  const { resolve } = fakeResolve();
  const tls = Object.assign(new Error('unable to verify the first certificate'), {
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  });
  const result = await probeBookmarkUrl({
    url: START, timeoutMs: 8_000, connectTimeoutMs: 3_000, resolve,
    connect: async () => { throw tls; },
  });
  assert.equal(result.fact.status, 'broken');
  assert.equal(result.fact.errorClass, 'http');
  assert.equal(result.fact.httpStatus, null);
});

test('HEAD 405 falls back to GET and still discards the body', async () => {
  const { resolve } = fakeResolve();
  const methods: string[] = [];
  const result = await probeBookmarkUrl({
    url: START, timeoutMs: 8_000, connectTimeoutMs: 3_000, resolve,
    connect: async (_target, init) => {
      methods.push(String(init.method));
      if (init.method === 'HEAD') return new Response(null, { status: 405 });
      return new Response('x'.repeat(20_000), { status: 200 });
    },
  });
  assert.deepEqual(methods, ['HEAD', 'GET']);
  assert.equal(result.fact.status, 'healthy');
});

test('same-host gate serializes one host and waits the configured gap', async () => {
  const events: string[] = [];
  let now = 0;
  const sleeps: number[] = [];
  const gate = createLinkHealthHostGate(1_000, () => now, async (ms) => {
    sleeps.push(ms);
    now += ms;
  });
  await Promise.all([
    gate.run('bookmarks.test', async () => { events.push('a-start'); now += 10; events.push('a-end'); }),
    gate.run('bookmarks.test', async () => { events.push('b-start'); events.push('b-end'); }),
    gate.run('other.test', async () => { events.push('c-start'); events.push('c-end'); }),
  ]);
  assert.equal(events[0] === 'a-start' || events[0] === 'c-start', true);
  const a = events.indexOf('a-end');
  const b = events.indexOf('b-start');
  assert.equal(a < b, true);
  assert.equal(sleeps.includes(1_000) || sleeps.some((ms) => ms >= 990), true);
  assert.equal(gate.pendingHostCount(), 0);
});

test('same-host gate releases its host queue after failed work', async () => {
  const gate = createLinkHealthHostGate(0);
  await assert.rejects(
    gate.run('bookmarks.test', async () => { throw new Error('probe failed'); }),
    /probe failed/u,
  );
  let continued = false;
  await gate.run('bookmarks.test', async () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(gate.pendingHostCount(), 0);
  assert.equal(gate.trackedHostCount(), 0);
});

test('same-host gate expires idle gap state instead of retaining hostnames', async () => {
  vi.useFakeTimers();
  const gate = createLinkHealthHostGate(1_000);
  await gate.run('ephemeral.test', async () => undefined);
  assert.equal(gate.pendingHostCount(), 0);
  assert.equal(gate.trackedHostCount(), 1);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(gate.trackedHostCount(), 0);
});
