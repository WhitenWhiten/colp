import assert from 'node:assert/strict';
import http from 'node:http';
import { afterAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createVisitorHashPort } from '../../../src/infrastructure/publication/index.js';
import { createMemoryPublishingInsightsIngestRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import {
  recordInsightEvent,
  type PublicationInsightCollectionFacts,
  type PublicationInsightFactsPort,
  type PublicationInsightStore,
  type RecordInsightEventPorts,
  type VisitorHashPort,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';

const ORIGIN = 'https://known.example';
const INSTANT = '2026-08-18T12:00:00.000Z';
const PEPPER = Buffer.alloc(32, 19);
const RATE_PEPPER = Buffer.alloc(32, 23);
const HASH = Uint8Array.from({ length: 32 }, (_, index) => index + 3);
const SUBJECT_HASH = Uint8Array.from({ length: 32 }, (_, index) => 220 - index);

const PUBLIC_FACTS: {
  collectionId: string;
  ownerSubjectId: string;
  visibility: 'public';
  publicationSlug: string;
  deletedAt: Date | null;
} = {
  collectionId: 'col-public',
  ownerSubjectId: 'owner-subject',
  visibility: 'public',
  publicationSlug: 'public-notes',
  deletedAt: null,
};

const UNLISTED_FACTS: {
  collectionId: string;
  ownerSubjectId: string;
  visibility: 'unlisted';
  publicationSlug: string;
  deletedAt: Date | null;
} = {
  collectionId: 'col-unlisted',
  ownerSubjectId: 'owner-subject',
  visibility: 'unlisted',
  publicationSlug: 'unlisted-notes',
  deletedAt: null,
};

const PRIVATE_FACTS: {
  collectionId: string;
  ownerSubjectId: string;
  visibility: 'private';
  publicationSlug: string;
  deletedAt: Date | null;
} = {
  collectionId: 'col-private',
  ownerSubjectId: 'owner-subject',
  visibility: 'private',
  publicationSlug: 'private-notes',
  deletedAt: null,
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

const memory = createMemoryInsight();
const limiter = createMemoryPublishingInsightsIngestRateLimiter({
  keySecret: RATE_PEPPER,
  viewPreviewMaxRequests: 10_000,
  resourceOpenMaxRequests: 10_000,
});
const visitorHash = createVisitorHashPort(PEPPER);
const app = buildApiApp({
  config,
  identityUnitOfWork,
  browserSessionAuthority: factory.authority,
  productPublicInsight: {
    allowedOrigins: config.allowedOrigins,
    identityUnitOfWork,
    visitorHash,
    rateLimiter: limiter,
    rateLimitKeySecret: RATE_PEPPER,
    insightCookieSigningKey: PEPPER,
    record: (input) => recordInsightEvent(memory.ports, input),
    now: () => new Date(INSTANT),
  },
});

afterAll(async () => {
  await app.close();
});

test('anonymous public and unlisted ingest writes and returns 204', async () => {
  const publicResponse = await ingest({ eventType: 'collection_view' }, { slug: 'public-notes' });
  assert.equal(publicResponse.statusCode, 204);
  assert.equal(publicResponse.body, '');
  const unlisted = await ingest({ eventType: 'preview_open' }, { slug: 'unlisted-notes' });
  assert.equal(unlisted.statusCode, 204);
  assert.equal(memory.store.events.length, 2);
  assert.deepEqual(memory.store.events.map((event) => event.eventType).sort(), [
    'collection_view',
    'preview_open',
  ]);
});

test('owner self-view returns 204 and does not write', async () => {
  const owner = await issueTestSession({ factory, subject: 'owner-subject', handle: 'insight-owner' });
  PUBLIC_FACTS.ownerSubjectId = owner.subjectId;
  UNLISTED_FACTS.ownerSubjectId = owner.subjectId;
  PRIVATE_FACTS.ownerSubjectId = owner.subjectId;
  const before = memory.store.events.length;
  const response = await ingest({ eventType: 'collection_view' }, {
    slug: 'public-notes',
    cookie: owner.cookie,
    csrf: owner.csrfToken,
  });
  assert.equal(response.statusCode, 204);
  assert.equal(memory.store.events.length, before);
});

test('editor and viewer (non-owner) writes', async () => {
  const editor = await issueTestSession({ factory, subject: 'editor-subject', handle: 'insight-editor' });
  const before = memory.store.events.length;
  const response = await ingest({ eventType: 'collection_view' }, {
    slug: 'public-notes',
    cookie: editor.cookie,
    csrf: editor.csrfToken,
  });
  assert.equal(response.statusCode, 204);
  assert.equal(memory.store.events.length, before + 1);
});

test('unknown slug and private collection conceal as 404 with the same shape', async () => {
  const unknown = await ingest({ eventType: 'collection_view' }, { slug: 'missing-notes' });
  const privateCollection = await ingest({ eventType: 'collection_view' }, { slug: 'private-notes' });
  assert.equal(unknown.statusCode, 404);
  assert.equal(privateCollection.statusCode, 404);
  assert.equal(unknown.json().error.code, 'resource_not_found');
  assert.equal(privateCollection.json().error.code, 'resource_not_found');
  assert.deepEqual(
    Object.keys(unknown.json().error).sort(),
    Object.keys(privateCollection.json().error).sort(),
  );
});

test('session present without CSRF is 403 csrf_failed', async () => {
  const visitor = await issueTestSession({ factory, subject: 'csrf-visitor', handle: 'insight-csrf' });
  const before = memory.store.events.length;
  const response = await ingest({ eventType: 'collection_view' }, {
    slug: 'public-notes',
    cookie: visitor.cookie,
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'csrf_failed');
  assert.equal(memory.store.events.length, before);
});

test('expired session cookie without CSRF is 204 anonymous write', async () => {
  const owner = await issueTestSession({ factory, subject: 'stale-owner', handle: 'insight-stale-owner' });
  PUBLIC_FACTS.ownerSubjectId = owner.subjectId;
  expireFactorySessions();
  const before = memory.store.events.length;
  const response = await ingest({ eventType: 'collection_view' }, {
    slug: 'public-notes',
    cookie: owner.cookie,
  });
  assert.equal(response.statusCode, 204);
  assert.equal(memory.store.events.length, before + 1);
  assert.deepEqual(memory.store.events.at(-1)?.visitorHash, HASH);
  assertDidNotClearSessionCookie(response);
});

test('unusable session cookie without CSRF is 204 anonymous write', async () => {
  const before = memory.store.events.length;
  const response = await ingest({ eventType: 'collection_view' }, {
    cookie: '__Host-known_session=invalid',
  });
  assert.equal(response.statusCode, 204);
  assert.equal(memory.store.events.length, before + 1);
  assert.deepEqual(memory.store.events.at(-1)?.visitorHash, HASH);
  assertDidNotClearSessionCookie(response);
});

test('unverified occupancy cookie without CSRF is 204 anonymous write, not owner skip', async () => {
  const occupancy = await issueTestSession({
    factory,
    subject: 'occupancy-owner',
    handle: 'insight-occupancy-owner',
    emailVerified: false,
  });
  PUBLIC_FACTS.ownerSubjectId = occupancy.subjectId;
  const isolated = createMemoryInsight();
  const isolatedApp = buildApiApp({
    config,
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
    productPublicInsight: {
      allowedOrigins: config.allowedOrigins,
      identityUnitOfWork,
      visitorHash,
      rateLimiter: createMemoryPublishingInsightsIngestRateLimiter({
        keySecret: RATE_PEPPER,
        viewPreviewMaxRequests: 10_000,
        resourceOpenMaxRequests: 10_000,
      }),
      rateLimitKeySecret: RATE_PEPPER,
      insightCookieSigningKey: PEPPER,
      record: (input) => recordInsightEvent(isolated.ports, input),
      now: () => new Date(INSTANT),
    },
  });
  try {
    const response = await isolatedApp.inject({
      method: 'POST',
      url: '/api/v1/public-collections/public-notes/insight-events',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: occupancy.cookie,
      },
      payload: { eventType: 'collection_view' },
    });
    assert.equal(response.statusCode, 204);
    assert.equal(isolated.store.events.length, 1);
    assert.deepEqual(isolated.store.events[0]?.visitorHash, HASH);
    assertDidNotClearSessionCookie(response);
  } finally {
    await isolatedApp.close();
  }
});

test('anonymous ingest without CSRF and with a valid Origin is 204', async () => {
  const before = memory.store.events.length;
  const response = await ingest({ eventType: 'preview_open' }, { slug: 'public-notes' });
  assert.equal(response.statusCode, 204);
  assert.equal(memory.store.events.length, before + 1);
});

test('oneOf extra nodeId on view/preview is 400 invalid_request', async () => {
  for (const eventType of ['collection_view', 'preview_open'] as const) {
    const response = await ingest({ eventType, nodeId: 'bm-live' });
    assert.equal(response.statusCode, 400, eventType);
    assert.equal(response.json().error.code, 'invalid_request', eventType);
  }
});

test('resource_open missing nodeId is 400 invalid_request', async () => {
  const response = await ingest({ eventType: 'resource_open' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'invalid_request');
});

test('GET on the ingest path is 405', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/public-collections/public-notes/insight-events',
    headers: { origin: ORIGIN },
  });
  assert.equal(response.statusCode, 405);
  assert.equal(response.json().error.code, 'method_not_allowed');
});

test('duplicate Origin is 400 invalid_request', async () => {
  const isolated = createMemoryInsight();
  const isolatedApp = buildApiApp({
    config,
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
    productPublicInsight: {
      allowedOrigins: config.allowedOrigins,
      identityUnitOfWork,
      visitorHash,
      rateLimiter: createMemoryPublishingInsightsIngestRateLimiter({
        keySecret: RATE_PEPPER,
        viewPreviewMaxRequests: 10_000,
        resourceOpenMaxRequests: 10_000,
      }),
      rateLimitKeySecret: RATE_PEPPER,
      insightCookieSigningKey: PEPPER,
      record: (input) => recordInsightEvent(isolated.ports, input),
      now: () => new Date(INSTANT),
    },
  });
  const origin = await isolatedApp.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await rawPost(origin, {
      Origin: [ORIGIN, ORIGIN],
      'Content-Type': 'application/json',
    }, JSON.stringify({ eventType: 'collection_view' }));
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error.code, 'invalid_request');
  } finally {
    await isolatedApp.close();
  }
});

test('anonymous ingest sets __Host-known_insight with Host-prefix attributes and hides the value from the body', async () => {
  const isolated = createMemoryInsight();
  const isolatedApp = buildApiApp({
    config,
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
    productPublicInsight: {
      allowedOrigins: config.allowedOrigins,
      identityUnitOfWork,
      visitorHash,
      rateLimiter: createMemoryPublishingInsightsIngestRateLimiter({
        keySecret: RATE_PEPPER,
        viewPreviewMaxRequests: 10_000,
        resourceOpenMaxRequests: 10_000,
      }),
      rateLimitKeySecret: RATE_PEPPER,
      insightCookieSigningKey: PEPPER,
      record: (input) => recordInsightEvent(isolated.ports, input),
      now: () => new Date(INSTANT),
    },
  });
  try {
    const response = await isolatedApp.inject({
      method: 'POST',
      url: '/api/v1/public-collections/public-notes/insight-events',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { eventType: 'collection_view' },
    });
    assert.equal(response.statusCode, 204);
    const setCookie = cookieHeader(response.headers['set-cookie']);
    assert.match(setCookie, /^__Host-known_insight=/u);
    assert.match(setCookie, /HttpOnly/u);
    assert.match(setCookie, /Secure/u);
    assert.match(setCookie, /SameSite=Lax/u);
    assert.match(setCookie, /Path=\//u);
    assert.match(setCookie, /Max-Age=15552000/u);
    assert.doesNotMatch(setCookie, /Domain=/iu);
    const value = cookieValue(setCookie);
    assert.match(value, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{32}$/u);
    assert.ok(value.length > 0);
    assert.equal(response.body.includes(value), false);
    assert.equal(response.body, '');
    try {
      assert.equal(JSON.stringify(response.json()).includes(value), false);
    } catch (error: unknown) {
      assert.ok(error instanceof Error);
    }
  } finally {
    await isolatedApp.close();
  }
});

test('illegal resource_open node is 204 with no write', async () => {
  const before = memory.store.events.length;
  const response = await ingest({ eventType: 'resource_open', nodeId: 'folder-1' });
  assert.equal(response.statusCode, 204);
  assert.equal(memory.store.events.length, before);
});

async function ingest(
  payload: Record<string, unknown>,
  options: {
    readonly slug?: string;
    readonly cookie?: string;
    readonly csrf?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    'content-type': 'application/json',
  };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.csrf !== undefined) headers['x-csrf-token'] = options.csrf;
  return app.inject({
    method: 'POST',
    url: `/api/v1/public-collections/${options.slug ?? 'public-notes'}/insight-events`,
    headers,
    payload,
  });
}

function cookieHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    const match = value.find((item) => item.startsWith('__Host-known_insight='));
    assert.ok(match);
    return match;
  }
  assert.ok(typeof value === 'string');
  return value;
}

function cookieValue(setCookie: string): string {
  const match = /^__Host-known_insight=([^;]+)/u.exec(setCookie);
  assert.ok(match);
  return decodeURIComponent(match[1]!);
}

function rawPost(
  origin: string,
  headers: Record<string, string | string[]>,
  body: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}/api/v1/public-collections/public-notes/insight-events`, {
      method: 'POST',
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function createMemoryInsight(): {
  readonly ports: RecordInsightEventPorts;
  readonly store: { events: Array<{ eventType: string; nodeId: string | null; visitorHash: Uint8Array }> };
} {
  const collections: Record<string, PublicationInsightCollectionFacts> = {
    'public-notes': PUBLIC_FACTS,
    'unlisted-notes': UNLISTED_FACTS,
    'private-notes': PRIVATE_FACTS,
  };
  const liveBookmarks = new Set(['col-public\0bm-live']);
  const events: Array<{ eventType: string; nodeId: string | null; visitorHash: Uint8Array }> = [];
  const facts: PublicationInsightFactsPort = {
    async loadBySlug(slug) {
      return collections[slug] ?? null;
    },
    async liveBookmarkExists(collectionId, nodeId) {
      return liveBookmarks.has(`${collectionId}\0${nodeId}`);
    },
  };
  const store: PublicationInsightStore = {
    async insertEvent(event) {
      events.push({
        eventType: event.eventType,
        nodeId: event.nodeId,
        visitorHash: event.visitorHash,
      });
    },
    async incrementDaily() {},
    async purgeExpired() { return { events: 0, daily: 0 }; },
  };
  const hash: VisitorHashPort = {
    hashAnonymous() { return HASH; },
    hashSubject() { return SUBJECT_HASH; },
  };
  return {
    ports: { facts, store, visitorHash: hash },
    store: { events },
  };
}

function expireFactorySessions(): void {
  const past = new Date(0);
  for (const row of factory.state.sessions.values()) {
    row.expiresAt = past;
  }
}

function assertDidNotClearSessionCookie(response: { headers: { 'set-cookie'?: string | string[] } }): void {
  const header = response.headers['set-cookie'];
  const cookies = header === undefined ? [] : Array.isArray(header) ? header : [header];
  for (const cookie of cookies) {
    assert.equal(/^__Host-known_session=(?:;|$)/u.test(cookie), false);
  }
}


test('unknown collection and bookmark IDs never reach quota admission', async () => {
  const targets: string[] = [];
  const admitTarget = async (target: { collectionId: string }) => { targets.push(target.collectionId); };
  for (let index = 0; index < 20; index++) {
    await assert.rejects(() => recordInsightEvent(memory.ports, {
      slug: `missing-${index}`, eventType: 'collection_view', visitor: { kind: 'anonymous', cookie: 'cookie' },
      occurredAt: new Date(INSTANT), admitTarget,
    }));
    await recordInsightEvent(memory.ports, { slug: 'public-notes', eventType: 'resource_open',
      nodeId: `missing-${index}`, visitor: { kind: 'anonymous', cookie: 'cookie' }, occurredAt: new Date(INSTANT), admitTarget });
  }
  assert.deepEqual(targets, []);
  await recordInsightEvent(memory.ports, { slug: 'public-notes', eventType: 'collection_view',
    visitor: { kind: 'anonymous', cookie: 'cookie' }, occurredAt: new Date(INSTANT), admitTarget });
  assert.deepEqual(targets, ['col-public']);
});
