import assert from 'node:assert/strict';
import { afterAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import type { PublishingInsights } from '../../../src/modules/publication/index.js';
import { SESSION_IDLE_TTL_MS, SESSION_TOUCH_MIN_INTERVAL_MS } from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';

const ORIGIN = 'https://known.example';
const INSTANT = '2026-08-18T12:00:00.000Z';
const EMPTY: PublishingInsights = {
  window: { days: 30 },
  funnel: [
    { label: 'Collection views', value: 0 },
    { label: 'Preview opens', value: 0 },
  ],
  weekly: [
    { w: 'W1', views: 0 },
    { w: 'W2', views: 0 },
    { w: 'W3', views: 0 },
    { w: 'W4', views: 0 },
  ],
  topResources: [],
};

const SAMPLE: PublishingInsights = {
  window: { days: 30 },
  funnel: [
    { label: 'Collection views', value: 12 },
    { label: 'Preview opens', value: 4 },
  ],
  weekly: [
    { w: 'W1', views: 1 },
    { w: 'W2', views: 2 },
    { w: 'W3', views: 3 },
    { w: 'W4', views: 6 },
  ],
  topResources: [{
    id: 'node-1',
    collectionId: 'col-live',
    title: 'Example bookmark',
    opens: 8,
  }],
};

const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(INSTANT));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  PRODUCT_ORIGIN: ORIGIN,
  PUBLICATION_ORIGIN: ORIGIN,
  LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});

let stub: PublishingInsights = EMPTY;
const app = buildApiApp({
  config,
  identityUnitOfWork,
  browserSessionAuthority: factory.authority,
  productPublishingInsights: {
    identityUnitOfWork,
    getInsights: async () => stub,
    now: () => new Date(INSTANT),
  },
});

afterAll(async () => {
  await app.close();
});

test('unauthenticated GET publishing insights is 401', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/me/publishing-insights',
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'authentication_required');
  assert.equal(response.headers['cache-control'], 'private, no-store');
});

test('invalid session cookie is 401', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/me/publishing-insights',
    headers: { cookie: '__Host-known_session=not-a-session' },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'authentication_required');
});

test('unknown query parameter is 400 invalid_query', async () => {
  const owner = await issueTestSession({ factory, subject: 'insights-query', handle: 'insights-query' });
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/me/publishing-insights?x=1',
    headers: { cookie: owner.cookie },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'invalid_query');
});

test('authenticated GET sets Cache-Control private, no-store', async () => {
  stub = EMPTY;
  const owner = await issueTestSession({ factory, subject: 'insights-cache', handle: 'insights-cache' });
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/me/publishing-insights',
    headers: { cookie: owner.cookie },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
});

test('authenticated GET returns the frozen dashboard schema shape', async () => {
  stub = SAMPLE;
  const owner = await issueTestSession({ factory, subject: 'insights-shape', handle: 'insights-shape' });
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/me/publishing-insights',
    headers: { cookie: owner.cookie },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as PublishingInsights & Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['funnel', 'topResources', 'weekly', 'window']);
  assert.deepEqual(body.window, { days: 30 });
  assert.deepEqual(Object.keys(body.window).sort(), ['days']);
  assert.equal(body.funnel.length, 2);
  assert.deepEqual(body.funnel.map((item) => item.label), ['Collection views', 'Preview opens']);
  assert.deepEqual(body.funnel.map((item) => Object.keys(item).sort()), [['label', 'value'], ['label', 'value']]);
  assert.equal(body.weekly.length, 4);
  assert.deepEqual(body.weekly.map((item) => item.w), ['W1', 'W2', 'W3', 'W4']);
  assert.deepEqual(body.weekly.map((item) => Object.keys(item).sort()), [
    ['views', 'w'], ['views', 'w'], ['views', 'w'], ['views', 'w'],
  ]);
  assert.ok(body.topResources.length <= 3);
  assert.deepEqual(Object.keys(body.topResources[0] ?? {}).sort(), ['collectionId', 'id', 'opens', 'title']);
  assert.equal(body.topResources[0]?.collectionId, 'col-live');
  assert.equal('slug' in body, false);
  assert.equal('email' in body, false);
});

test('authenticated owner with no data is 200 with zeros, never 404', async () => {
  stub = EMPTY;
  const owner = await issueTestSession({ factory, subject: 'insights-empty', handle: 'insights-empty' });
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/me/publishing-insights',
    headers: { cookie: owner.cookie },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), EMPTY);
});

test('authenticated GET over the principal budget is 429 rate_limited', async () => {
  const tight = buildApiApp({
    config,
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
    productPublishingInsights: {
      identityUnitOfWork,
      getInsights: async () => EMPTY,
      now: () => new Date(INSTANT),
      rateLimiter: createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    },
  });
  try {
    const owner = await issueTestSession({ factory, subject: 'insights-rl', handle: 'insights-rl' });
    const first = await tight.inject({
      method: 'GET',
      url: '/api/v1/me/publishing-insights',
      headers: { cookie: owner.cookie },
    });
    assert.equal(first.statusCode, 200);
    const denied = await tight.inject({
      method: 'GET',
      url: '/api/v1/me/publishing-insights',
      headers: { cookie: owner.cookie },
    });
    assert.equal(denied.statusCode, 429);
    assert.equal(denied.json().error.code, 'rate_limited');
    assert.ok(denied.headers['retry-after']);
    assert.equal(typeof denied.json().error.retryAfterSeconds, 'number');
    const anonymous = await tight.inject({
      method: 'GET',
      url: '/api/v1/me/publishing-insights',
    });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.json().error.code, 'authentication_required');
  } finally {
    await tight.close();
  }
});

test('insights-only past idle TTL expires; GET /me after touchMinInterval slides idle', async () => {
  const t0 = new Date(INSTANT);
  const identityState = createIdentityMemoryState(t0);
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(identityState);
  const clockFactory = createInMemoryBetterAuthTestFactory({
    identityUnitOfWork,
    sessionExpiresInSeconds: 30 * 24 * 60 * 60,
  });
  const clockApp = buildApiApp({
    config,
    identityUnitOfWork,
    browserSessionAuthority: clockFactory.authority,
    productPublishingInsights: {
      identityUnitOfWork,
      getInsights: async () => EMPTY,
      now: () => new Date(identityState.now),
    },
  });
  try {
    const polling = await issueTestSession({
      factory: clockFactory, subject: 'insights-idle-poll', handle: 'insights_idle_poll',
    });
    const heartbeat = await issueTestSession({
      factory: clockFactory, subject: 'insights-idle-me', handle: 'insights_idle_me',
    });

    identityState.now = new Date(t0.getTime() + SESSION_TOUCH_MIN_INTERVAL_MS);
    const pollAtInterval = await clockApp.inject({
      method: 'GET',
      url: '/api/v1/me/publishing-insights',
      headers: { cookie: polling.cookie },
    });
    assert.equal(pollAtInterval.statusCode, 200, pollAtInterval.body);
    const pollingMeta = [...clockFactory.state.metadata.values()].find((row) => row.accountId === polling.accountId);
    assert.ok(pollingMeta);
    assert.equal(pollingMeta.lastSeenAt.getTime(), t0.getTime(), 'insights GET must not slide last_seen');

    const me = await clockApp.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: heartbeat.cookie },
    });
    assert.equal(me.statusCode, 200, me.body);
    const heartbeatMeta = [...clockFactory.state.metadata.values()].find((row) => row.accountId === heartbeat.accountId);
    assert.ok(heartbeatMeta);
    assert.equal(heartbeatMeta.lastSeenAt.getTime(), identityState.now.getTime());
    assert.equal(heartbeatMeta.idleExpiresAt.getTime(), identityState.now.getTime() + SESSION_IDLE_TTL_MS);

    identityState.now = new Date(t0.getTime() + SESSION_IDLE_TTL_MS + 1);
    const pollExpired = await clockApp.inject({
      method: 'GET',
      url: '/api/v1/me/publishing-insights',
      headers: { cookie: polling.cookie },
    });
    assert.equal(pollExpired.statusCode, 401, 'insights-only past idle TTL must expire');
    assert.equal(pollExpired.json().error.code, 'authentication_required');

    const stillLive = await clockApp.inject({
      method: 'GET',
      url: '/api/v1/me/publishing-insights',
      headers: { cookie: heartbeat.cookie },
    });
    assert.equal(stillLive.statusCode, 200, 'GET /me must have slid idle past the original TTL');
  } finally {
    await clockApp.close();
  }
});
