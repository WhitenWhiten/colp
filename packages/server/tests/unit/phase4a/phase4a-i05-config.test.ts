/**
 * P4A-I05 configuration surface tests (plan §6 P4A-I05).
 *
 * Every fixture goes through the REAL production config loader (`loadConfig`),
 * never a directly constructed typed object. Each negative fixture breaks
 * exactly one variable/value and must fail inside the loader, i.e. BEFORE any
 * composition, S3 client, or route could be constructed.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES,
  ATTACHMENTS_GRANT_TTL_MAX_SECONDS,
  ATTACHMENTS_VERIFICATION_LEASE_MARGIN_MS,
} from '../../../src/modules/attachments/index.js';

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  PRODUCT_ORIGIN: 'https://app.known.example',
};

const ACCOUNT_ENDPOINT = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';

function attachmentEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ATTACHMENTS_ENABLED: 'true',
    ATTACHMENTS_R2_ENDPOINT: ACCOUNT_ENDPOINT,
    ATTACHMENTS_R2_REGION: 'auto',
    ATTACHMENTS_R2_BUCKET: 'known-private-attachments',
    ATTACHMENTS_R2_LIVE_PREFIX: 'attachments/live/',
    ATTACHMENTS_R2_PROBE_PREFIX: 'attachments/probe/',
    ATTACHMENTS_R2_RW_SECRET_REF: 'known/r2/rw/primary',
    ATTACHMENTS_R2_RO_SECRET_REF: 'known/r2/ro/primary',
    ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://delivery.known.test',
    ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF: 'known/delivery/hmac/primary',
    ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS: '60',
    ATTACHMENTS_ALLOWED_MEDIA: 'image/jpeg, image/png, image/webp, image/gif, application/pdf, text/plain',
    ATTACHMENTS_GRANT_TTL_SECONDS: '60',
    ATTACHMENTS_SINGLE_PUT_MAX_BYTES: '5242880',
    ATTACHMENTS_VERIFICATION_LEASE_MS: '60000',
    ATTACHMENTS_VERIFICATION_TIMEOUT_MS: '15000',
    ATTACHMENTS_VERIFICATION_RETRY_COUNT: '2',
    ATTACHMENTS_INTENT_RETENTION_HOURS: '24',
    ATTACHMENTS_STORED_RETENTION_DAYS: '30',
    ATTACHMENTS_RETIRED_RETENTION_DAYS: '90',
    ATTACHMENTS_CLEANUP_BATCH_SIZE: '100',
    ATTACHMENTS_CLEANUP_LEASE_MS: '60000',
    ATTACHMENTS_CLEANUP_RETRY_COUNT: '2',
    ...overrides,
  };
}

function loadAttachments(overrides: Record<string, string> = {}, env: Record<string, string> = baseEnv) {
  return loadConfig({ ...env, ...attachmentEnv(overrides) }).attachments;
}

/**
 * Production-legal base env (mirrors cache-worker-readiness.test.ts): production
 * requires explicit OIDC/cursor secrets before the attachments assertions are
 * reached. Delivery origin uses a registrable domain distinct from the app.
 */
function productionEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'production',
    PRODUCT_ORIGIN: 'https://app.known.example',
    ALLOWED_ORIGINS: 'https://app.known.example',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.known.example/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    OIDC_ALLOW_TEST_PROVIDER: 'false',
    OIDC_TRANSACTION_HMAC_SECRET: 'prod-oidc-transaction-hmac-secret-not-dev-default',
    OIDC_TRANSACTION_ENCRYPTION_KEYS: `1:oidc-pkce-prod:${Buffer.alloc(32, 5).toString('base64')}`,
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'prod-product-editor-cursor-hmac-key-not-dev-default',
    PRODUCT_EDITOR_CURSOR_KEY_ID: 'prod-editor-v1',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'prod-owned-collections-cursor-key-not-dev-default',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: 'prod-owned-v1',
    PRODUCT_LINK_HEALTH_CURSOR_HMAC_KEY: 'prod-link-health-cursor-hmac-key-not-dev-default',
    PRODUCT_LINK_HEALTH_CURSOR_KEY_ID: 'prod-link-health-v1',
    PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-classify-inbox-cursor-hmac-key-not-dev-default',
    PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-collection-versions-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
    PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'prod-publishing-insights-visitor-hmac-key-32b',
    PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: 'prod-publishing-insights-ratelimit-hmac-key-32b',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'prod-collaboration-invite-rate-limit-hmac',
    PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: 'keyed',
    PUBLICATION_SERVER_UUID: '019f9031-c541-74d0-bc83-15a5526fbb54',
    PUBLICATION_CURSOR_ACTIVE_KEY_ID: 'prod-publication-v1',
    PUBLICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 17).toString('base64'),
    FOLLOW_CURSOR_ACTIVE_KEY_ID: 'prod-follow-v1',
    FOLLOW_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 19).toString('base64'),
    FEED_CURSOR_ACTIVE_KEY_ID: 'prod-feed-v1',
    FEED_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 21).toString('base64'),
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_KEY_ID: 'prod-public-activity-v1',
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 27).toString('base64'),
    NOTIFICATION_CURSOR_ACTIVE_KEY_ID: 'prod-notification-v1',
    NOTIFICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 23).toString('base64'),
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 37).toString('base64'),
    COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 43).toString('base64'),
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

test('disabled default: no attachment variables are parsed and the section is absent', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.attachments, undefined);
  assert.equal(config.nodeEnv, 'test');
});

test('disabled mode ignores every attachment variable, including malformed ones', () => {
  const config = loadConfig({
    ...baseEnv,
    ATTACHMENTS_ENABLED: 'false',
    ATTACHMENTS_R2_ENDPOINT: 'http://not-an-endpoint',
    ATTACHMENTS_R2_BUCKET: 'Bad Bucket!',
    ATTACHMENTS_R2_RW_SECRET_REF: '',
    ATTACHMENTS_GRANT_TTL_SECONDS: 'not-a-number',
    ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'javascript:alert(1)',
  });
  assert.equal(config.attachments, undefined, 'disabled mode must never parse or validate attachment vars');
});

test('ATTACHMENTS_ENABLED must be exactly true or false', () => {
  for (const value of ['yes', '1', 'on', '']) {
    assert.throws(
      () => loadConfig({ ...baseEnv, ...attachmentEnv({ ATTACHMENTS_ENABLED: value }) }),
      /ATTACHMENTS_ENABLED must be true or false/u,
      `flag ${JSON.stringify(value)} must be rejected`,
    );
  }
});

test('development/test explicit fixture parses every configured value', () => {
  const attachments = loadAttachments();
  assert.ok(attachments, 'enabled fixture must produce the attachments section');
  assert.equal(attachments.enabled, true);
  assert.equal(attachments.r2.endpoint, ACCOUNT_ENDPOINT);
  assert.equal(attachments.r2.region, 'auto');
  assert.equal(attachments.r2.bucket, 'known-private-attachments');
  assert.equal(attachments.r2.livePrefix, 'attachments/live/');
  assert.equal(attachments.r2.probePrefix, 'attachments/probe/');
  assert.equal(attachments.r2.rwSecretRef, 'known/r2/rw/primary');
  assert.equal(attachments.r2.roSecretRef, 'known/r2/ro/primary');
  assert.equal(attachments.grantTtlSeconds, 60);
  assert.equal(attachments.singlePutMaxBytes, 5_242_880);
  assert.deepEqual(attachments.allowedMedia, ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain']);
  assert.equal(attachments.verification.leaseMs, 60_000);
  assert.equal(attachments.verification.timeoutMs, 15_000);
  assert.equal(attachments.verification.retryCount, 2);
  assert.equal(attachments.retention.intentRetentionHours, 24);
  assert.equal(attachments.retention.storedRetentionDays, 30);
  assert.equal(attachments.retention.retiredRetentionDays, 90);
  assert.equal(attachments.cleanupBatchSize, 100);
  assert.equal(attachments.cleanup.leaseMs, 60_000);
  assert.equal(attachments.cleanup.retryCount, 2);
  assert.equal(attachments.isolatedDeliveryOrigin, 'https://delivery.known.test');
  assert.equal(attachments.deliveryCapabilitySecretRef, 'known/delivery/hmac/primary');
  assert.equal(attachments.deliveryCapabilityTtlSeconds, 60);
});

test('numeric budgets apply development/test defaults when absent', () => {
  const attachments = loadAttachments({
    ATTACHMENTS_GRANT_TTL_SECONDS: '',
    ATTACHMENTS_SINGLE_PUT_MAX_BYTES: '',
    ATTACHMENTS_VERIFICATION_LEASE_MS: '',
    ATTACHMENTS_VERIFICATION_TIMEOUT_MS: '',
    ATTACHMENTS_VERIFICATION_RETRY_COUNT: '',
    ATTACHMENTS_INTENT_RETENTION_HOURS: '',
    ATTACHMENTS_STORED_RETENTION_DAYS: '',
    ATTACHMENTS_RETIRED_RETENTION_DAYS: '',
    ATTACHMENTS_CLEANUP_BATCH_SIZE: '',
    ATTACHMENTS_CLEANUP_LEASE_MS: '',
    ATTACHMENTS_CLEANUP_RETRY_COUNT: '',
    ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS: '',
    ATTACHMENTS_ALLOWED_MEDIA: '',
    ATTACHMENTS_R2_REGION: '',
  });
  assert.ok(attachments);
  assert.equal(attachments.grantTtlSeconds, 60);
  assert.equal(attachments.singlePutMaxBytes, 5 * 1024 * 1024);
  assert.equal(attachments.verification.leaseMs, 60_000);
  assert.equal(attachments.verification.timeoutMs, 15_000);
  assert.equal(attachments.verification.retryCount, 2);
  assert.equal(attachments.retention.intentRetentionHours, 24);
  assert.equal(attachments.retention.storedRetentionDays, 30);
  assert.equal(attachments.retention.retiredRetentionDays, 90);
  assert.equal(attachments.cleanupBatchSize, 100);
  assert.equal(attachments.cleanup.leaseMs, 60_000);
  assert.equal(attachments.cleanup.retryCount, 2);
  assert.deepEqual(attachments.allowedMedia, ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain']);
  assert.equal(attachments.r2.region, 'auto');
  assert.equal(attachments.deliveryCapabilityTtlSeconds, 60);
});

test('production mode requires every attachment variable when enabled (no safe defaults)', () => {
  const productionBase = productionEnv();
  for (const key of [
    'ATTACHMENTS_R2_ENDPOINT',
    'ATTACHMENTS_R2_REGION',
    'ATTACHMENTS_R2_BUCKET',
    'ATTACHMENTS_R2_LIVE_PREFIX',
    'ATTACHMENTS_R2_PROBE_PREFIX',
    'ATTACHMENTS_R2_RW_SECRET_REF',
    'ATTACHMENTS_R2_RO_SECRET_REF',
    'ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN',
    'ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF',
    'ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS',
    'ATTACHMENTS_GRANT_TTL_SECONDS',
    'ATTACHMENTS_SINGLE_PUT_MAX_BYTES',
    'ATTACHMENTS_VERIFICATION_LEASE_MS',
    'ATTACHMENTS_VERIFICATION_TIMEOUT_MS',
    'ATTACHMENTS_VERIFICATION_RETRY_COUNT',
    'ATTACHMENTS_INTENT_RETENTION_HOURS',
    'ATTACHMENTS_STORED_RETENTION_DAYS',
    'ATTACHMENTS_RETIRED_RETENTION_DAYS',
    'ATTACHMENTS_CLEANUP_BATCH_SIZE',
    'ATTACHMENTS_CLEANUP_LEASE_MS',
    'ATTACHMENTS_CLEANUP_RETRY_COUNT',
    'ATTACHMENTS_ALLOWED_MEDIA',
  ]) {
    const broken = { ...attachmentEnv(), [key]: '' };
    assert.throws(
      () => loadConfig({ ...productionBase, ...broken }),
      new RegExp(`${key} is required when ATTACHMENTS_ENABLED=true`, 'u'),
      `production must reject a missing ${key}`,
    );
  }
});

test('development/test may default numeric budgets while production never may', () => {
  const devConfig = loadConfig({ ...baseEnv, ...attachmentEnv({ ATTACHMENTS_GRANT_TTL_SECONDS: '', ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS: '' }) });
  assert.equal(devConfig.attachments?.grantTtlSeconds, 60, 'dev/test may default numeric budgets');
  assert.equal(devConfig.attachments?.deliveryCapabilityTtlSeconds, 60, 'delivery TTL may default in dev/test');
  assert.throws(
    () => loadConfig({ ...productionEnv(), ...attachmentEnv({ ATTACHMENTS_GRANT_TTL_SECONDS: '' }) }),
    /ATTACHMENTS_GRANT_TTL_SECONDS is required when ATTACHMENTS_ENABLED=true/u,
  );
});

test('production valid fixture loads through the real loader with production values', () => {
  const attachments = loadConfig({
    ...productionEnv(),
    ...attachmentEnv({ ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://delivery.known.test' }),
  }).attachments;
  assert.ok(attachments, 'production enabled fixture must parse');
  assert.equal(attachments.r2.endpoint, ACCOUNT_ENDPOINT);
  assert.equal(attachments.grantTtlSeconds, 60);
  assert.equal(attachments.isolatedDeliveryOrigin, 'https://delivery.known.test');
  assert.equal(attachments.deliveryCapabilityTtlSeconds, 60);
  assert.equal(attachments.deliveryCapabilitySecretRef, 'known/delivery/hmac/primary');
});

test('endpoint must be an https account R2 direct endpoint without query/userinfo/path', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['http scheme', ACCOUNT_ENDPOINT.replace(/^https:/u, 'http:')],
    ['userinfo', `https://user:pass@${new URL(ACCOUNT_ENDPOINT).host}`],
    ['query', `${ACCOUNT_ENDPOINT}?x=1`],
    ['fragment', `${ACCOUNT_ENDPOINT}#frag`],
    ['path', `${ACCOUNT_ENDPOINT}/bucket`],
    ['double slash path', `${ACCOUNT_ENDPOINT}//`],
    ['non-account host', 'https://storage.example.com'],
    ['wrong account shape', 'https://nothex.r2.cloudflarestorage.com'],
    ['not a URL', 'not-a-url'],
    ['whitespace only', '   '],
  ];
  for (const [label, value] of cases) {
    assert.throws(
      () => loadAttachments({ ATTACHMENTS_R2_ENDPOINT: value }),
      /ATTACHMENTS_R2_ENDPOINT/u,
      `endpoint case "${label}" must be rejected`,
    );
  }
  // A trailing-slash account endpoint (pathname '/') is equivalent and stored as given.
  const withSlash = loadAttachments({ ATTACHMENTS_R2_ENDPOINT: `${ACCOUNT_ENDPOINT}/` });
  assert.equal(withSlash?.r2.endpoint, `${ACCOUNT_ENDPOINT}/`);
});

test('region must be a bounded lowercase ASCII token', () => {
  for (const region of ['cn-hangzhou!', 'AUTO', 'us-east-1/x', 'x'.repeat(65)]) {
    assert.throws(
      () => loadAttachments({ ATTACHMENTS_R2_REGION: region }),
      /ATTACHMENTS_R2_REGION/u,
      `region ${JSON.stringify(region)} must be rejected`,
    );
  }
  assert.equal(loadAttachments({ ATTACHMENTS_R2_REGION: 'us-east-1' })?.r2.region, 'us-east-1');
});

test('bucket must match R2 bucket format and not be IP-formatted', () => {
  for (const bucket of ['UPPER', 'ab', 'a'.repeat(64), 'known..private', 'known-private.', '.known-private', '192.168.0.1', 'known-private!', '-known-private', 'known-private-']) {
    assert.throws(
      () => loadAttachments({ ATTACHMENTS_R2_BUCKET: bucket }),
      /ATTACHMENTS_R2_BUCKET/u,
      `bucket ${JSON.stringify(bucket)} must be rejected`,
    );
  }
  assert.equal(loadAttachments({ ATTACHMENTS_R2_BUCKET: 'known.private-attachments' })?.r2.bucket, 'known.private-attachments');
});

test('prefixes must be well-formed and may not use reserved segments', () => {
  for (const prefix of ['attachments/live', 'attachments/live//', '/attachments/live/', 'attachments/../live/', 'attachments/quarantine/', 'attachments/live!/', 'x'.repeat(513)]) {
    assert.throws(
      () => loadAttachments({ ATTACHMENTS_R2_LIVE_PREFIX: prefix }),
      /ATTACHMENTS_R2_LIVE_PREFIX/u,
      `live prefix ${JSON.stringify(prefix)} must be rejected`,
    );
  }
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_R2_PROBE_PREFIX: 'attachments/probe/quarantine/' }),
    /ATTACHMENTS_R2_PROBE_PREFIX/u,
    'probe prefix must not use the reserved quarantine segment',
  );
  assert.equal(loadAttachments({ ATTACHMENTS_R2_LIVE_PREFIX: 'a/b-c.d_e/' })?.r2.livePrefix, 'a/b-c.d_e/');
});

test('live and probe prefixes must not overlap', () => {
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_R2_LIVE_PREFIX: 'attachments/live/', ATTACHMENTS_R2_PROBE_PREFIX: 'attachments/live/' }),
    /ATTACHMENTS_R2_LIVE_PREFIX and ATTACHMENTS_R2_PROBE_PREFIX must not overlap/u,
  );
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_R2_LIVE_PREFIX: 'attachments/', ATTACHMENTS_R2_PROBE_PREFIX: 'attachments/probe/' }),
    /ATTACHMENTS_R2_LIVE_PREFIX and ATTACHMENTS_R2_PROBE_PREFIX must not overlap/u,
    'live prefix that is a path-prefix of the probe prefix must be rejected',
  );
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_R2_LIVE_PREFIX: 'attachments/live/', ATTACHMENTS_R2_PROBE_PREFIX: 'attachments/' }),
    /ATTACHMENTS_R2_LIVE_PREFIX and ATTACHMENTS_R2_PROBE_PREFIX must not overlap/u,
    'probe prefix that is a path-prefix of the live prefix must be rejected',
  );
  const ok = loadAttachments({ ATTACHMENTS_R2_LIVE_PREFIX: 'attachments/live/', ATTACHMENTS_R2_PROBE_PREFIX: 'attachments/probe/' });
  assert.equal(ok?.r2.livePrefix, 'attachments/live/');
  assert.equal(ok?.r2.probePrefix, 'attachments/probe/');
});

test('RW/RO secret references must be distinct and well-formed', () => {
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_R2_RO_SECRET_REF: 'known/r2/rw/primary' }),
    /ATTACHMENTS_R2_RW_SECRET_REF and ATTACHMENTS_R2_RO_SECRET_REF must be distinct/u,
  );
  for (const [key, value] of [
    ['ATTACHMENTS_R2_RW_SECRET_REF', ''],
    ['ATTACHMENTS_R2_RW_SECRET_REF', 'bad ref!'],
    ['ATTACHMENTS_R2_RW_SECRET_REF', 'x'.repeat(257)],
    ['ATTACHMENTS_R2_RO_SECRET_REF', '   '],
    ['ATTACHMENTS_R2_RO_SECRET_REF', 'known/r2/ro/ref#frag'],
  ] as const) {
    assert.throws(
      () => loadAttachments({ [key]: value }),
      new RegExp(`${key}`, 'u'),
      `${key}=${JSON.stringify(value)} must be rejected`,
    );
  }
});

test('allowed media policy is a fixed allowlist subset', () => {
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_ALLOWED_MEDIA: 'image/jpeg,application/x-msdownload' }),
    /ATTACHMENTS_ALLOWED_MEDIA/u,
  );
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_ALLOWED_MEDIA: 'image/jpeg,image/jpeg' }),
    /ATTACHMENTS_ALLOWED_MEDIA must not contain duplicates/u,
  );
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_ALLOWED_MEDIA: 'image/jpeg; charset=utf-8' }),
    /ATTACHMENTS_ALLOWED_MEDIA/u,
  );
  assert.deepEqual(loadAttachments({ ATTACHMENTS_ALLOWED_MEDIA: 'application/pdf,text/plain' })?.allowedMedia,
    ['application/pdf', 'text/plain']);
  assert.deepEqual(loadAttachments({ ATTACHMENTS_ALLOWED_MEDIA: '  Image/JPEG , image/png ' })?.allowedMedia,
    ['image/jpeg', 'image/png']);
});

test('TTL/single-PUT/verification/cleanup budgets are bounded with compile ceilings', () => {
  assert.equal(loadAttachments({ ATTACHMENTS_GRANT_TTL_SECONDS: '1' })?.grantTtlSeconds, 1);
  assert.equal(loadAttachments({ ATTACHMENTS_GRANT_TTL_SECONDS: '300' })?.grantTtlSeconds, 300);
  assert.throws(() => loadAttachments({ ATTACHMENTS_GRANT_TTL_SECONDS: '0' }), /ATTACHMENTS_GRANT_TTL_SECONDS/u);
  assert.throws(() => loadAttachments({ ATTACHMENTS_GRANT_TTL_SECONDS: '301' }), /ATTACHMENTS_GRANT_TTL_SECONDS/u);
  assert.equal(ATTACHMENTS_GRANT_TTL_MAX_SECONDS, 300);

  const ceiling = ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES;
  assert.equal(ceiling, 64 * 1024 * 1024);
  assert.equal(loadAttachments({ ATTACHMENTS_SINGLE_PUT_MAX_BYTES: String(ceiling) })?.singlePutMaxBytes, ceiling);
  assert.throws(() => loadAttachments({ ATTACHMENTS_SINGLE_PUT_MAX_BYTES: String(ceiling + 1) }), /ATTACHMENTS_SINGLE_PUT_MAX_BYTES/u);
  assert.throws(() => loadAttachments({ ATTACHMENTS_SINGLE_PUT_MAX_BYTES: '0' }), /ATTACHMENTS_SINGLE_PUT_MAX_BYTES/u);

  assert.equal(loadAttachments({ ATTACHMENTS_VERIFICATION_RETRY_COUNT: '0' })?.verification.retryCount, 0);
  // retry=10 with the default timeout 15000 needs lease >= 15000 * 11 + 5000 = 170000.
  assert.equal(loadAttachments({ ATTACHMENTS_VERIFICATION_RETRY_COUNT: '10', ATTACHMENTS_VERIFICATION_LEASE_MS: '170000' })?.verification.retryCount, 10);
  assert.throws(() => loadAttachments({ ATTACHMENTS_VERIFICATION_RETRY_COUNT: '11' }), /ATTACHMENTS_VERIFICATION_RETRY_COUNT/u);
  assert.throws(() => loadAttachments({ ATTACHMENTS_VERIFICATION_LEASE_MS: '0' }), /ATTACHMENTS_VERIFICATION_LEASE_MS/u);
  assert.throws(() => loadAttachments({ ATTACHMENTS_VERIFICATION_TIMEOUT_MS: '600001' }), /ATTACHMENTS_VERIFICATION_TIMEOUT_MS/u);
  assert.throws(() => loadAttachments({ ATTACHMENTS_CLEANUP_BATCH_SIZE: '1001' }), /ATTACHMENTS_CLEANUP_BATCH_SIZE/u);
  assert.throws(() => loadAttachments({ ATTACHMENTS_CLEANUP_BATCH_SIZE: '0' }), /ATTACHMENTS_CLEANUP_BATCH_SIZE/u);
});

test('verification lease must cover timeout * (retry + 1) plus a safety margin', () => {
  const margin = ATTACHMENTS_VERIFICATION_LEASE_MARGIN_MS;
  assert.equal(margin, 5_000);
  // timeout 10_000, retry 0 -> worst case 10_000 + margin 5_000 = 15_000.
  assert.equal(
    loadAttachments({ ATTACHMENTS_VERIFICATION_TIMEOUT_MS: '10000', ATTACHMENTS_VERIFICATION_RETRY_COUNT: '0', ATTACHMENTS_VERIFICATION_LEASE_MS: '15000' })?.verification.leaseMs,
    15_000,
  );
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_VERIFICATION_TIMEOUT_MS: '10000', ATTACHMENTS_VERIFICATION_RETRY_COUNT: '0', ATTACHMENTS_VERIFICATION_LEASE_MS: '14999' }),
    /ATTACHMENTS_VERIFICATION_LEASE_MS/u,
  );
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_VERIFICATION_LEASE_MS: '49999' }),
    /ATTACHMENTS_VERIFICATION_LEASE_MS must cover/u,
    'default fixture lease 60000 must cover 15000 * (2 + 1) + 5000 = 50000',
  );
});

test('retention relationships must be sane (intent < stored; retired >= stored)', () => {
  assert.equal(
    loadAttachments({ ATTACHMENTS_INTENT_RETENTION_HOURS: '719', ATTACHMENTS_STORED_RETENTION_DAYS: '30' })?.retention.intentRetentionHours,
    719,
  );
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_INTENT_RETENTION_HOURS: '720', ATTACHMENTS_STORED_RETENTION_DAYS: '30' }),
    /ATTACHMENTS_INTENT_RETENTION_HOURS must be shorter than ATTACHMENTS_STORED_RETENTION_DAYS/u,
  );
  assert.equal(
    loadAttachments({ ATTACHMENTS_RETIRED_RETENTION_DAYS: '30', ATTACHMENTS_STORED_RETENTION_DAYS: '30' })?.retention.retiredRetentionDays,
    30,
  );
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_RETIRED_RETENTION_DAYS: '29', ATTACHMENTS_STORED_RETENTION_DAYS: '30' }),
    /ATTACHMENTS_RETIRED_RETENTION_DAYS must be at least ATTACHMENTS_STORED_RETENTION_DAYS/u,
  );
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_INTENT_RETENTION_HOURS: '7201' }),
    /ATTACHMENTS_INTENT_RETENTION_HOURS/u,
  );
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_STORED_RETENTION_DAYS: '3651' }),
    /ATTACHMENTS_STORED_RETENTION_DAYS/u,
  );
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_RETIRED_RETENTION_DAYS: '3651' }),
    /ATTACHMENTS_RETIRED_RETENTION_DAYS/u,
  );
});

test('integer overflow, non-integers, and unsafe integers are rejected', () => {
  for (const [key, value] of [
    ['ATTACHMENTS_GRANT_TTL_SECONDS', '9007199254740992'],
    ['ATTACHMENTS_SINGLE_PUT_MAX_BYTES', '1e100'],
    ['ATTACHMENTS_SINGLE_PUT_MAX_BYTES', '1048576.5'],
    ['ATTACHMENTS_VERIFICATION_LEASE_MS', '-1'],
    ['ATTACHMENTS_VERIFICATION_TIMEOUT_MS', 'Infinity'],
    ['ATTACHMENTS_VERIFICATION_RETRY_COUNT', '2.5'],
    ['ATTACHMENTS_CLEANUP_BATCH_SIZE', 'NaN'],
    ['ATTACHMENTS_GRANT_TTL_SECONDS', 'abc'],
  ] as const) {
    assert.throws(
      () => loadAttachments({ [key]: value }),
      new RegExp(`${key}`, 'u'),
      `${key}=${JSON.stringify(value)} must be rejected`,
    );
  }
});

test('isolated delivery origin must be an exact https origin, no query/path/userinfo', () => {
  for (const origin of ['http://delivery.known.example', 'https://delivery.known.example/path', 'https://delivery.known.example?x=1', 'https://user:pass@delivery.known.example', 'not-a-url']) {
    assert.throws(
      () => loadAttachments({ ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: origin }),
      /ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN/u,
      `delivery origin ${JSON.stringify(origin)} must be rejected`,
    );
  }
  // A trailing slash is normalized to the exact origin form.
  assert.equal(loadAttachments({ ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://cdn.known.test/' })?.isolatedDeliveryOrigin, 'https://cdn.known.test');
});

test('isolated delivery origin must not be same-site with the application origin', () => {
  // app.known.example and delivery.known.example share the registrable domain known.example.
  assert.throws(
    () => loadAttachments({ ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://files.known.example' }),
    /ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN must not be same-site with the Known application origin/u,
  );
  // The apex and a subdomain of the same registrable domain are also same-site.
  assert.throws(
    () => loadConfig({ ...baseEnv, PRODUCT_ORIGIN: 'https://known.example', ...attachmentEnv({ ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://cdn.known.example' }) }),
    /must not be same-site/u,
  );
  // A different registrable domain is accepted.
  assert.equal(
    loadAttachments({ ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://files.example.net' })?.isolatedDeliveryOrigin,
    'https://files.example.net',
  );
});

test('credential rotation is reference-only: swapping the RO reference reloads without secret material', () => {
  const rotated = loadAttachments({ ATTACHMENTS_R2_RO_SECRET_REF: 'known/r2/ro/rotated-2026-08' });
  assert.equal(rotated?.r2.roSecretRef, 'known/r2/ro/rotated-2026-08');
  assert.equal(rotated?.r2.rwSecretRef, 'known/r2/rw/primary');
  const serialized = JSON.stringify(rotated);
  assert.ok(!serialized.includes('AKIA'), 'no access-key-like material may be stored');
  assert.ok(!serialized.includes('secretAccessKey'), 'no secret key field may exist');
});

test('table-driven single-break matrix: each fixture breaks exactly one value and fails in the loader', () => {
  const matrix: ReadonlyArray<readonly [string, Record<string, string>]> = [
    ['endpoint http', { ATTACHMENTS_R2_ENDPOINT: 'http://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com' }],
    ['endpoint query', { ATTACHMENTS_R2_ENDPOINT: `${ACCOUNT_ENDPOINT}?foo=bar` }],
    ['endpoint path', { ATTACHMENTS_R2_ENDPOINT: `${ACCOUNT_ENDPOINT}/bucket` }],
    ['endpoint non-account host', { ATTACHMENTS_R2_ENDPOINT: 'https://s3.amazonaws.com' }],
    ['bucket uppercase', { ATTACHMENTS_R2_BUCKET: 'KnownPrivate' }],
    ['bucket consecutive dots', { ATTACHMENTS_R2_BUCKET: 'known..private' }],
    ['bucket ip-formatted', { ATTACHMENTS_R2_BUCKET: '10.0.0.1' }],
    ['live prefix no trailing slash', { ATTACHMENTS_R2_LIVE_PREFIX: 'attachments/live' }],
    ['live prefix reserved quarantine segment', { ATTACHMENTS_R2_LIVE_PREFIX: 'attachments/quarantine/' }],
    ['probe prefix empty segment', { ATTACHMENTS_R2_PROBE_PREFIX: 'attachments//probe/' }],
    ['live/probe overlap', { ATTACHMENTS_R2_LIVE_PREFIX: 'attachments/', ATTACHMENTS_R2_PROBE_PREFIX: 'attachments/probe/' }],
    ['rw/ro same reference', { ATTACHMENTS_R2_RO_SECRET_REF: 'known/r2/rw/primary' }],
    ['grant ttl below range', { ATTACHMENTS_GRANT_TTL_SECONDS: '0' }],
    ['grant ttl above range', { ATTACHMENTS_GRANT_TTL_SECONDS: '301' }],
    ['single put above ceiling', { ATTACHMENTS_SINGLE_PUT_MAX_BYTES: '67108865' }],
    ['verification lease below worst case', { ATTACHMENTS_VERIFICATION_LEASE_MS: '49999' }],
    ['verification retry above bound', { ATTACHMENTS_VERIFICATION_RETRY_COUNT: '11' }],
    ['intent retention not shorter than stored', { ATTACHMENTS_INTENT_RETENTION_HOURS: '720' }],
    ['retired retention below stored', { ATTACHMENTS_RETIRED_RETENTION_DAYS: '29' }],
    ['cleanup batch above bound', { ATTACHMENTS_CLEANUP_BATCH_SIZE: '1001' }],
    ['unsafe integer', { ATTACHMENTS_GRANT_TTL_SECONDS: '9007199254740992' }],
    ['same-site delivery origin', { ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://files.known.example' }],
    ['http delivery origin', { ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'http://files.example.net' }],
    ['delivery capability ttl zero', { ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS: '0' }],
    ['delivery capability ttl above bound', { ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS: '121' }],
    ['delivery capability secret ref empty', { ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF: '' }],
    ['delivery capability secret ref equals rw', { ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF: 'known/r2/rw/primary' }],
    ['delivery capability secret ref equals ro', { ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF: 'known/r2/ro/primary' }],
    ['unsupported media', { ATTACHMENTS_ALLOWED_MEDIA: 'application/octet-stream' }],
  ];
  for (const [label, overrides] of matrix) {
    assert.throws(
      () => loadConfig({ ...baseEnv, ...attachmentEnv(overrides) }),
      Error,
      `matrix case "${label}" must fail inside loadConfig (before any network/client/route construction)`,
    );
  }
});



