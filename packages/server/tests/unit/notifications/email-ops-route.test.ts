import assert from 'node:assert/strict';
import { test } from 'vitest';
import Fastify from 'fastify';
import {
  registerEmailOpsRoutes,
  EMAIL_OPS_SUPPRESSIONS_PATH,
} from '../../../src/transport/product/email-ops-routes.js';
import { verifyEmailOpsToken } from '../../../src/modules/notifications/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { loadConfig } from '../../support/test-config.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import type {
  EmailSuppressionOpsRepository,
  EmailSuppressionFactRecord,
} from '../../../src/modules/notifications/index.js';

const OPS_TOKEN = 'p531-ops-token';
const records: readonly EmailSuppressionFactRecord[] = Object.freeze([
  Object.freeze({
    recipientAccountId: 'account-11111111',
    source: 'bounce' as const,
    occurredAt: new Date('2026-08-02T00:00:00.000Z'),
    createdAt: new Date('2026-08-02T00:00:00.000Z'),
  }),
]);

function repository(overrides: Partial<EmailSuppressionOpsRepository> = {}): EmailSuppressionOpsRepository {
  return {
    listSuppressionFacts: async () => records,
    countSuppressionFacts: async () => records.length,
    clearSuppressionFact: async (recipientAccountId) =>
      records.some((record) => record.recipientAccountId === recipientAccountId),
    ...overrides,
  };
}

async function buildApp(options: {
  enabled: boolean;
  opsToken: string | null;
  repository?: EmailSuppressionOpsRepository;
}) {
  const app = Fastify({ logger: false });
  registerEmailOpsRoutes(app, {
    enabled: options.enabled,
    opsToken: options.opsToken,
    repository: options.repository ?? repository(),
  });
  return app;
}

test('P5-31 ops suppression surface is disabled (404) when the email feature is off', async () => {
  const app = await buildApp({ enabled: false, opsToken: OPS_TOKEN });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`${address}${EMAIL_OPS_SUPPRESSIONS_PATH}`, {
      headers: { authorization: `Bearer ${OPS_TOKEN}` },
    });
    assert.equal(response.status, 404);
  } finally { await app.close(); }
});

test('P5-31 ops suppression surface is disabled (404) when EMAIL_OPS_TOKEN is unset', async () => {
  const app = await buildApp({ enabled: true, opsToken: null });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`${address}${EMAIL_OPS_SUPPRESSIONS_PATH}`);
    assert.equal(response.status, 404);
  } finally { await app.close(); }
});

const emailOpsLoadConfigEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
} as const;

test('SEC-T-08 EMAIL_OPS_TOKEN shorter than 32 characters refuses startup', () => {
  assert.throws(
    () => loadConfig({ ...emailOpsLoadConfigEnv, EMAIL_OPS_TOKEN: 'shorttok' }),
    /EMAIL_OPS_TOKEN must be at least 32 characters/u,
  );
});

test('SEC-T-08 unset EMAIL_OPS_TOKEN stays null and does not refuse startup', () => {
  const config = loadConfig(emailOpsLoadConfigEnv);
  assert.equal(config.email.opsToken, null);
});

test('SEC-T-08 a 32-character EMAIL_OPS_TOKEN is accepted', () => {
  const token = 'email-ops-token-32-chars-minimum'; // secret-scan: allow 'email-ops-token-32-chars-minimum'
  assert.equal(token.length, 32);
  const config = loadConfig({ ...emailOpsLoadConfigEnv, EMAIL_OPS_TOKEN: token });
  assert.equal(config.email.opsToken, token);
});

test('P5-31 ops suppression surface denies (401) a wrong or missing bearer token', async () => {
  const app = await buildApp({ enabled: true, opsToken: OPS_TOKEN });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const missing = await fetch(`${address}${EMAIL_OPS_SUPPRESSIONS_PATH}`);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer',
      '401 must advertise the Bearer challenge (repo convention) (N12)');
    const wrong = await fetch(`${address}${EMAIL_OPS_SUPPRESSIONS_PATH}`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('www-authenticate'), 'Bearer',
      'every 401 must carry WWW-Authenticate: Bearer (N12)');
    const clearedWrong = await fetch(`${address}${EMAIL_OPS_SUPPRESSIONS_PATH}/account-11111111`, {
      method: 'DELETE', headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(clearedWrong.status, 401);
    assert.equal(clearedWrong.headers.get('www-authenticate'), 'Bearer',
      'DELETE 401s must carry the same challenge (N12)');
  } finally { await app.close(); }
});

test('P5-31 verifyEmailOpsToken compares constant-time across equal and mixed lengths (N12)', () => {
  // Equal length, equal content -> valid.
  assert.equal(verifyEmailOpsToken('p531-ops-token', 'p531-ops-token'), true);
  // Equal length, different content -> invalid (timingSafeEqual path).
  assert.equal(verifyEmailOpsToken('p531-ops-token', 'p531-ops-Token'), false);
  // Mixed lengths (both directions) -> invalid without early-exit: the
  // implementation burns comparable time on a dummy timingSafeEqual for length
  // mismatches, so an attacker cannot distinguish a wrong-length guess from a
  // wrong-content guess by timing. Asserted here as a correctness contract (no
  // flaky wall-clock assertions).
  assert.equal(verifyEmailOpsToken('p531-ops-token', 'short'), false);
  assert.equal(verifyEmailOpsToken('short', 'p531-ops-token'), false);
  assert.equal(verifyEmailOpsToken('p531-ops-token', ''), false);
  assert.equal(verifyEmailOpsToken('p531-ops-token', 'p531-ops-token-longer'), false);
  // Multi-byte UTF-8: character length may match while byte length differs;
  // the comparison is over BUFFER bytes, so these must still be invalid.
  assert.equal(verifyEmailOpsToken('p531-ops-token', 'p531-ops-tokén'), false);
  // Absent/empty expected token is never valid (the ops surface is disabled).
  assert.equal(verifyEmailOpsToken(null, 'anything'), false);
  assert.equal(verifyEmailOpsToken('', 'anything'), false);
});

test('P5-31 ops list returns scrubbed facts (account ids only, never emails) and clear reports resubscribe', async () => {
  const app = await buildApp({ enabled: true, opsToken: OPS_TOKEN });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const list = await fetch(`${address}${EMAIL_OPS_SUPPRESSIONS_PATH}`, {
      headers: { authorization: `Bearer ${OPS_TOKEN}` },
    });
    assert.equal(list.status, 200);
    const body = JSON.parse(await list.text()) as { facts: Array<Record<string, unknown>> };
    assert.equal(body.facts.length, 1);
    assert.deepEqual(Object.keys(body.facts[0]!).sort(), ['createdAt', 'occurredAt', 'recipientAccountId', 'source']);
    assert.equal(JSON.stringify(body).includes('@'), false);
    assert.equal(JSON.stringify(body).includes('credential'), false);
    const cleared = await fetch(`${address}${EMAIL_OPS_SUPPRESSIONS_PATH}/account-11111111`, {
      method: 'DELETE', headers: { authorization: `Bearer ${OPS_TOKEN}` },
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(JSON.parse(await cleared.text()), { cleared: true, recipientAccountId: 'account-11111111' });
    const missing = await fetch(`${address}${EMAIL_OPS_SUPPRESSIONS_PATH}/account-99999999`, {
      method: 'DELETE', headers: { authorization: `Bearer ${OPS_TOKEN}` },
    });
    assert.equal(missing.status, 404);
  } finally { await app.close(); }
});

test('B2: the ops suppression surface is rate limited per IP within the bound and returns 429 beyond it', async () => {
  const limiter = createFixedWindowRateLimiter({ maxRequests: 3, windowMs: 60_000, now: () => 0 });
  const config = loadConfig({ DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default' });
  const app = buildApiApp({
    config,
    collectionMetadataMutationRoutes: 'disabled',
    emailOpsRoutes: { enabled: true, opsToken: OPS_TOKEN, repository: repository(),
      rateLimiter: limiter },
  });
  await app.ready();
  try {
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({ method: 'GET', url: EMAIL_OPS_SUPPRESSIONS_PATH,
        headers: { authorization: `Bearer ${OPS_TOKEN}` } });
      statuses.push(response.statusCode);
      if (index === 3) {
        assert.equal(response.statusCode, 429);
        assert.equal(response.json().error.code, 'rate_limited');
        assert.ok(response.headers['retry-after'], '429 must carry Retry-After (B2)');
        assert.equal(typeof response.json().error.retryAfterSeconds, 'number');
      }
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429],
      'requests within the bound succeed; beyond it they are rejected 429 (B2)');
  } finally { await app.close(); }
});

test('B2: the rate limit covers DELETE and burns capacity on 401s (brute-force protection)', async () => {
  const limiter = createFixedWindowRateLimiter({ maxRequests: 2, windowMs: 60_000, now: () => 0 });
  const config = loadConfig({ DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default' });
  const app = buildApiApp({
    config,
    collectionMetadataMutationRoutes: 'disabled',
    emailOpsRoutes: { enabled: true, opsToken: OPS_TOKEN, repository: repository(),
      rateLimiter: limiter },
  });
  await app.ready();
  try {
    const denied = await app.inject({ method: 'DELETE', url: `${EMAIL_OPS_SUPPRESSIONS_PATH}/account-11111111`,
      headers: { authorization: 'Bearer wrong-token' } });
    assert.equal(denied.statusCode, 401, 'wrong tokens stay 401 while burning capacity');
    const allowed = await app.inject({ method: 'GET', url: EMAIL_OPS_SUPPRESSIONS_PATH,
      headers: { authorization: `Bearer ${OPS_TOKEN}` } });
    assert.equal(allowed.statusCode, 200);
    const third = await app.inject({ method: 'DELETE', url: `${EMAIL_OPS_SUPPRESSIONS_PATH}/account-11111111`,
      headers: { authorization: `Bearer ${OPS_TOKEN}` } });
    assert.equal(third.statusCode, 429, 'the third request must exceed the bound (B2)');
  } finally { await app.close(); }
});

test('B2: rate limiting is disabled when the surface is off or no limiter is wired', async () => {
  const config = loadConfig({ DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default' });
  // Feature off: always 404, never 429 even beyond any bound.
  const limiter = createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 0 });
  const disabled = buildApiApp({
    config,
    collectionMetadataMutationRoutes: 'disabled',
    emailOpsRoutes: { enabled: false, opsToken: OPS_TOKEN, repository: repository(),
      rateLimiter: limiter },
  });
  await disabled.ready();
  try {
    for (let index = 0; index < 3; index += 1) {
      const response = await disabled.inject({ method: 'GET', url: EMAIL_OPS_SUPPRESSIONS_PATH });
      assert.equal(response.statusCode, 404, 'a disabled surface keeps answering 404 (B2)');
    }
  } finally { await disabled.close(); }
  // No limiter wired: never 429.
  const noLimiter = buildApiApp({
    config,
    collectionMetadataMutationRoutes: 'disabled',
    emailOpsRoutes: { enabled: true, opsToken: OPS_TOKEN, repository: repository() },
  });
  await noLimiter.ready();
  try {
    for (let index = 0; index < 3; index += 1) {
      const response = await noLimiter.inject({ method: 'GET', url: EMAIL_OPS_SUPPRESSIONS_PATH,
        headers: { authorization: `Bearer ${OPS_TOKEN}` } });
      assert.equal(response.statusCode, 200, 'no limiter means no 429 (B2)');
    }
  } finally { await noLimiter.close(); }
});

test('P5-31 ops clear rejects an invalid recipient account id (400)', async () => {
  const app = await buildApp({ enabled: true, opsToken: OPS_TOKEN });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`${address}${EMAIL_OPS_SUPPRESSIONS_PATH}/bad%20id%2Fslash`, {
      method: 'DELETE', headers: { authorization: `Bearer ${OPS_TOKEN}` },
    });
    assert.equal(response.status, 400);
  } finally { await app.close(); }
});
