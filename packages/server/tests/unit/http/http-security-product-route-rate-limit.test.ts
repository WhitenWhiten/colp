import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { composeApiSurfaceRateLimiters } from '../../../src/bootstrap/api-rate-limit-composition.js';
import { loadConfig } from '../../support/test-config.js';
import {
  type ProductSurfaceRateLimiter,
  type ProductSurfaceRateLimitPurpose,
} from '../../../src/infrastructure/rate-limit/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import type { AppDependencies } from '../../../src/transport/app-dependencies.js';
import {
  productRouteRateLimitSharedEnv,
  productionEnv,
  publicActivityRateLimitSharedEnv,
  testEnv,
} from '../../support/http-security-config-env.js';

const PURPOSES = [
  'library-order',
  'link-health',
  'classify-inbox',
  'classification-profile', 'classification-run', 'classification-settings',
  'classification-preview',
  'classification-confirmation',
  'export-job',
  'organize-plan',
  'collection-version',
  'readable-replica',
  'public-object',
  'reports',
  // CS contract COMMUNITY_RATE_LIMITS: four sealed product-surface purposes.
  'community-vote',
  'community-comment',
  'community-curation',
  'community-public-reads',
  'governance-report',
  'governance-action',
  'governance-appeal',
] as const satisfies readonly ProductSurfaceRateLimitPurpose[];
const ALL_SHARED_PURPOSES = [...PURPOSES.slice(0, 13), 'credits-read', ...PURPOSES.slice(13)];

const apps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fakeSharedLimiter(
  purpose: ProductSurfaceRateLimitPurpose,
  status: 'healthy' | 'degraded' = 'healthy',
): ProductSurfaceRateLimiter {
  return {
    purpose,
    async consume() {
      return { kind: 'allowed', decision: { allowed: true, retryAfterSeconds: 0 } };
    },
    readiness() {
      return {
        status,
        reason: status === 'healthy' ? 'none' : 'last_command_failed',
        lastCheckedAtEpochMs: 0,
      };
    },
    async close() {},
  };
}

function sharedDependencies(
  statusByPurpose: Partial<Record<ProductSurfaceRateLimitPurpose, 'healthy' | 'degraded'>> = {},
): Pick<AppDependencies,
  | 'libraryOrderRateLimiter'
  | 'linkHealthRateLimiter'
  | 'classifyInboxRateLimiter'
  | 'classificationProfilesRateLimiter'
  | 'classificationRunsRateLimiter'
  | 'classificationSettingsRateLimiter'
  | 'classificationPreviewRateLimiter'
  | 'classificationConfirmationRateLimiter'
  | 'exportJobRateLimiter'
  | 'organizePlanRateLimiter'
  | 'collectionVersionRateLimiter'
  | 'readableReplicaRateLimiter'
  | 'publicObjectRateLimiter'
  | 'creditsReadRateLimiter'
  | 'reportsRateLimiter'
  | 'faviconPolicyRateLimiter'
  | 'communityRateLimiters'
  | 'governanceReportRateLimiter'
  | 'governanceActionRateLimiter'
  | 'governanceAppealRateLimiter'> {
  const limiter = (purpose: ProductSurfaceRateLimitPurpose) =>
    fakeSharedLimiter(purpose, statusByPurpose[purpose]);
  return {
    libraryOrderRateLimiter: limiter('library-order'),
    linkHealthRateLimiter: limiter('link-health'),
    classifyInboxRateLimiter: limiter('classify-inbox'),
    classificationProfilesRateLimiter: limiter('classification-profile'),
    classificationRunsRateLimiter: limiter('classification-run'),
    classificationSettingsRateLimiter: limiter('classification-settings'),
    classificationPreviewRateLimiter: limiter('classification-preview'),
    classificationConfirmationRateLimiter: limiter('classification-confirmation'),
    exportJobRateLimiter: limiter('export-job'),
    organizePlanRateLimiter: limiter('organize-plan'),
    collectionVersionRateLimiter: limiter('collection-version'),
    readableReplicaRateLimiter: limiter('readable-replica'),
    publicObjectRateLimiter: limiter('public-object'),
    creditsReadRateLimiter: limiter('credits-read'),
    reportsRateLimiter: limiter('reports'),
    faviconPolicyRateLimiter: limiter('favicon-policy'),
    communityRateLimiters: {
      vote: limiter('community-vote'),
      comment: limiter('community-comment'),
      curation: limiter('community-curation'),
      publicReads: limiter('community-public-reads'),
    },
    governanceReportRateLimiter: limiter('governance-report'),
    governanceActionRateLimiter: limiter('governance-action'),
    governanceAppealRateLimiter: limiter('governance-appeal'),
  };
}

function productionReplicaPrerequisites(overrides: Record<string, string> = {}) {
  return {
    AUTH_API_REPLICAS: '2',
    AUTH_RATE_LIMIT_SHARED: 'true',
    AUTH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    AUTH_RATE_LIMIT_KEY_SECRET: 'auth-rate-limit-hmac-secret-001',
    SEARCH_RATE_LIMIT_SHARED: 'true',
    SEARCH_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    SEARCH_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
    PUBLISHING_INSIGHTS_RATE_LIMIT_SHARED: 'true',
    PUBLISHING_INSIGHTS_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    COLLABORATION_INVITE_RATE_LIMIT_SHARED: 'true',
    COLLABORATION_INVITE_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'collaboration-invite-rate-limit-hmac-secret',
    EXPLORE_DIRECTORY_RATE_LIMIT_SHARED: 'true',
    EXPLORE_DIRECTORY_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET: 'explore-directory-rate-limit-hmac-secret',
    ...publicActivityRateLimitSharedEnv(),
    ...overrides,
  };
}

describe('shared product-route rate-limit families', () => {
  test('defaults remain process-local with an independent umbrella prefix', () => {
    const config = loadConfig(testEnv());
    assert.equal(config.productRouteRateLimitShared.enabled, false);
    assert.equal(config.productRouteRateLimitShared.keyPrefix, 'known-product-route');
    assert.doesNotThrow(() => loadConfig(productionEnv({ AUTH_API_REPLICAS: '1' })));
    assert.doesNotThrow(() => loadConfig(testEnv({ AUTH_API_REPLICAS: '2' })));
  });

  test('single-replica composition supplies a bounded memory limiter for every family', async () => {
    const composed = composeApiSurfaceRateLimiters(loadConfig(testEnv()));
    const limiters = [
      composed.libraryOrderRateLimiter,
      composed.linkHealthRateLimiter,
      composed.classifyInboxRateLimiter,
      composed.classificationProfilesRateLimiter,
      composed.classificationRunsRateLimiter,
      composed.classificationSettingsRateLimiter,
      composed.classificationPreviewRateLimiter,
      composed.classificationConfirmationRateLimiter,
      composed.exportJobRateLimiter,
      composed.organizePlanRateLimiter,
      composed.collectionVersionRateLimiter,
      composed.readableReplicaRateLimiter,
      composed.publicObjectRateLimiter,
      composed.reportsRateLimiter,
      composed.communityRateLimiters.vote,
      composed.communityRateLimiters.comment,
      composed.communityRateLimiters.curation,
      composed.communityRateLimiters.publicReads,
      composed.governanceReportRateLimiter,
      composed.governanceActionRateLimiter,
      composed.governanceAppealRateLimiter,
    ];
    assert.equal(limiters.length, PURPOSES.length);
    for (const limiter of limiters) {
      assert.equal('readiness' in limiter, false);
      assert.equal(typeof (limiter as { size?: unknown }).size, 'function');
    }
    const creditLimiter = composed.creditsReadRateLimiter;
    assert.equal('readiness' in creditLimiter, true);
    for (let index = 0; index < 10; index += 1) {
      assert.deepEqual(await creditLimiter.consume('credits-read-test'), {
        kind: 'allowed', decision: { allowed: true, retryAfterSeconds: 0 },
      });
    }
    const burstDenied = await creditLimiter.consume('credits-read-test');
    assert.equal(burstDenied.kind, 'denied');
    await creditLimiter.close();
  });

  test('shared configuration validates its Redis URL, secret, prefix and boolean', () => {
    assert.throws(
      () => loadConfig(testEnv({ PRODUCT_ROUTE_RATE_LIMIT_SHARED: 'true' })),
      /PRODUCT_ROUTE_RATE_LIMIT_REDIS_URL is required/,
    );
    assert.throws(
      () => loadConfig(testEnv(productRouteRateLimitSharedEnv({
        PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET: '',
      }))),
      /PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET is required/,
    );
    assert.throws(
      () => loadConfig(testEnv({ PRODUCT_ROUTE_RATE_LIMIT_SHARED: 'sometimes' })),
      /PRODUCT_ROUTE_RATE_LIMIT_SHARED must be true or false/,
    );
    assert.throws(
      () => loadConfig(testEnv(productRouteRateLimitSharedEnv({
        PRODUCT_ROUTE_RATE_LIMIT_KEY_PREFIX: 'known',
      }))),
      /PRODUCT_ROUTE_RATE_LIMIT_KEY_PREFIX must be independent from SEARCH_RATE_LIMIT_KEY_PREFIX/,
    );
    assert.throws(
      () => loadConfig(testEnv(productRouteRateLimitSharedEnv({
        PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
        SEARCH_RATE_LIMIT_KEY_SECRET: 'search-rate-limit-hmac-secret-006',
      }))),
      /PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET must not reuse/,
    );
  });

  test('production multi-replica startup requires the umbrella shared adapter', () => {
    assert.throws(
      () => loadConfig(productionEnv(productionReplicaPrerequisites())),
      /AUTH_API_REPLICAS > 1.*PRODUCT_ROUTE_RATE_LIMIT_SHARED=true/s,
    );
    assert.doesNotThrow(() => loadConfig(productionEnv(productionReplicaPrerequisites(
      productRouteRateLimitSharedEnv(),
    ))));
  });

  test('composition refuses missing, local, or purpose-mismatched adapters', () => {
    const config = loadConfig(testEnv(productRouteRateLimitSharedEnv()));
    assert.throws(
      () => buildApiApp({ config }),
      new RegExp(`missing or invalid: ${ALL_SHARED_PURPOSES.join(', ')}`),
    );
    assert.throws(
      () => buildApiApp({
        config,
        ...sharedDependencies(),
        publicObjectRateLimiter: fakeSharedLimiter('library-order'),
      }),
      /missing or invalid: public-object/,
    );
  });

  test('purpose-matched adapters start and readiness fails closed on any degraded family', async () => {
    const config = loadConfig(testEnv(productRouteRateLimitSharedEnv()));
    const healthy = buildApiApp({ config, ...sharedDependencies() });
    apps.push(healthy);
    await healthy.ready();
    const ready = await healthy.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 200, ready.body);

    const degraded = buildApiApp({
      config,
      ...sharedDependencies({ 'organize-plan': 'degraded' }),
    });
    apps.push(degraded);
    await degraded.ready();
    const notReady = await degraded.inject({ method: 'GET', url: '/ready' });
    assert.equal(notReady.statusCode, 503, notReady.body);
  });
});


test('exported shared composition requires all enabled credential and token limiters', async () => {
  const base = loadConfig(testEnv(productRouteRateLimitSharedEnv()));
  const config = { ...base, accountCredentials: { ...base.accountCredentials, enabled: true } };
  const credentialLimiters = {
    credentialsRateLimiter: fakeSharedLimiter('credentials'),
    credentialIssuanceRateLimiter: fakeSharedLimiter('credential-issuance'),
    automationTokenCredentialRateLimiter: fakeSharedLimiter('automation-token-credential'),
    automationTokenClientRateLimiter: fakeSharedLimiter('automation-token-client'),
  };
  for (const [key, limiter] of Object.entries(credentialLimiters)) {
    for (const invalid of [undefined, fakeSharedLimiter('library-order')]) {
      assert.throws(() => buildApiApp({ config, ...sharedDependencies(), ...credentialLimiters, [key]: invalid }),
        new RegExp(`missing or invalid: ${limiter.purpose}`));
    }
  }
  const app = buildApiApp({ config, ...sharedDependencies(), ...credentialLimiters });
  apps.push(app);
  await app.ready();
});
