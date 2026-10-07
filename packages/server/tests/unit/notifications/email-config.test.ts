import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig, sanitizeEmailFeatureConfig } from '../../support/test-config.js';
import { redactDirectMailEvidence } from '../../../src/infrastructure/email/aliyun-directmail-contract.js';
import { redactSensitiveText } from '../../../src/infrastructure/telemetry/index.js';

const env = { DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known', NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default' };

test('Email exposure defaults off with bounded defaults and no required account', () => {
  const email = loadConfig(env).email;
  assert.ok(email, 'email section must be present (closed defaults)');
  assert.equal(email.enabled, false);
  assert.equal(email.endpoint, 'https://dm.aliyuncs.com/');
  assert.equal(email.regionId, 'cn-hangzhou');
  assert.equal(email.timeoutMs, 10_000);
  assert.equal(email.accountName, null);
  assert.equal(email.tagPrefix, 'known-delivery-');
  assert.equal(email.maxTagChars, 128);
  assert.equal(email.callback.hmacSecret, null);
  assert.equal(email.callback.timestampReplayWindowMs, 300_000);
});

test('flag on requires EMAIL_DM_ACCOUNT_NAME (fail closed)', () => {
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_EMAIL: 'true' }),
    /EMAIL_DM_ACCOUNT_NAME is required/u,
  );
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_EMAIL: 'true', EMAIL_DM_ACCOUNT_NAME: '   ' }),
    /EMAIL_DM_ACCOUNT_NAME is required/u,
  );
});

test('flag on accepts explicit bounded production settings', () => {
  const config = loadConfig({
    ...env,
    KNOWN_FEATURE_EMAIL: 'true',
    EMAIL_DM_ACCOUNT_NAME: 'no-reply@example.invalid',
    EMAIL_DM_ENDPOINT: 'https://dm.aliyuncs.com/',
    EMAIL_DM_REGION_ID: 'ap-southeast-1',
    EMAIL_DM_TIMEOUT_MS: '500',
    EMAIL_DM_TAG_PREFIX: 'known-track-',
    EMAIL_DM_MAX_TAG_CHARS: '64',
    EMAIL_DM_CALLBACK_TIMESTAMP_WINDOW_MS: '60000',
    EMAIL_DM_CALLBACK_HMAC_SECRET: `p528_hmac_${'s'.repeat(12)}`,
  }).email!;
  assert.equal(config.enabled, true);
  assert.equal(config.accountName, 'no-reply@example.invalid');
  assert.equal(config.endpoint, 'https://dm.aliyuncs.com/');
  assert.equal(config.regionId, 'ap-southeast-1');
  assert.equal(config.timeoutMs, 500);
  assert.equal(config.tagPrefix, 'known-track-');
  assert.equal(config.maxTagChars, 64);
  assert.equal(config.callback.timestampReplayWindowMs, 60_000);
  assert.match(config.callback.hmacSecret ?? '', /^p528_hmac_/u);
});

test('email rejects ambiguous flags and out-of-bounds values', () => {
  assert.throws(() => loadConfig({ ...env, KNOWN_FEATURE_EMAIL: 'yes' }), /KNOWN_FEATURE_EMAIL must be true or false/u);
  const on = { ...env, KNOWN_FEATURE_EMAIL: 'true', EMAIL_DM_ACCOUNT_NAME: 'no-reply@example.invalid' };
  assert.throws(() => loadConfig({ ...on, EMAIL_DM_TIMEOUT_MS: '499' }), /EMAIL_DM_TIMEOUT_MS must be a safe integer >= 500/u);
  assert.throws(() => loadConfig({ ...on, EMAIL_DM_TIMEOUT_MS: '60001' }), /EMAIL_DM_TIMEOUT_MS must be <= 60000/u);
  assert.throws(() => loadConfig({ ...on, EMAIL_DM_TIMEOUT_MS: 'abc' }), /EMAIL_DM_TIMEOUT_MS/u);
  assert.throws(() => loadConfig({ ...on, EMAIL_DM_MAX_TAG_CHARS: '15' }), /EMAIL_DM_MAX_TAG_CHARS/u);
  assert.throws(() => loadConfig({ ...on, EMAIL_DM_MAX_TAG_CHARS: '129' }), /EMAIL_DM_MAX_TAG_CHARS/u);
  assert.throws(() => loadConfig({ ...on, EMAIL_DM_TAG_PREFIX: 'bad prefix!' }), /EMAIL_DM_TAG_PREFIX/u);
  assert.throws(() => loadConfig({ ...on, EMAIL_DM_TAG_PREFIX: '' }), /EMAIL_DM_TAG_PREFIX/u);
  assert.throws(() => loadConfig({ ...on, EMAIL_DM_CALLBACK_TIMESTAMP_WINDOW_MS: '999' }),
    /EMAIL_DM_CALLBACK_TIMESTAMP_WINDOW_MS/u);
  assert.throws(() => loadConfig({ ...on, EMAIL_DM_CALLBACK_TIMESTAMP_WINDOW_MS: '600001' }),
    /EMAIL_DM_CALLBACK_TIMESTAMP_WINDOW_MS/u);
});

test('email rejects invalid region ids and endpoints', () => {
  const on = { ...env, KNOWN_FEATURE_EMAIL: 'true', EMAIL_DM_ACCOUNT_NAME: 'no-reply@example.invalid' };
  for (const region of ['hangzhou', 'cn_hangzhou', 'CN-HANGZHOU', 'cn-hangzhou-', 'cn']) {
    assert.throws(() => loadConfig({ ...on, EMAIL_DM_REGION_ID: region }),
      /EMAIL_DM_REGION_ID/u, `region ${region} must be rejected`);
  }
  for (const endpoint of [
    'http://dm.aliyuncs.com/',
    'not-a-url',
    'https://user:pass@dm.aliyuncs.com/',
    'https://dm.aliyuncs.com/?Action=SingleSendMail',
    'https://dm.aliyuncs.com/#frag',
    '',
  ]) {
    assert.throws(() => loadConfig({ ...on, EMAIL_DM_ENDPOINT: endpoint }),
      /EMAIL_DM_ENDPOINT/u, `endpoint ${endpoint} must be rejected`);
  }
});

test('email callback HMAC secret is optional but trimmed and never whitespace-only', () => {
  const off = loadConfig({ ...env, EMAIL_DM_CALLBACK_HMAC_SECRET: '  ' }).email!;
  assert.equal(off.callback.hmacSecret, null);
  const on = loadConfig({ ...env, KNOWN_FEATURE_EMAIL: 'true', EMAIL_DM_ACCOUNT_NAME: 'no-reply@example.invalid',
    EMAIL_DM_CALLBACK_HMAC_SECRET: '  p528_hmac_x  ' }).email!;
  assert.equal(on.callback.hmacSecret, 'p528_hmac_x');
});

test('email secret values never appear in sanitized or loggable output', () => {
  const hmacSecret = `P528_HMAC_${'s'.repeat(24)}`;
  const config = loadConfig({
    ...env,
    KNOWN_FEATURE_EMAIL: 'true',
    EMAIL_DM_ACCOUNT_NAME: 'p528-sender@example.invalid',
    EMAIL_DM_CALLBACK_HMAC_SECRET: hmacSecret,
  }).email!;

  const sanitized = JSON.stringify(sanitizeEmailFeatureConfig(config));
  assert.doesNotMatch(sanitized, /P528_HMAC/u, 'hmac secret must not appear in sanitized config');
  assert.doesNotMatch(sanitized, /p528-sender@example\.invalid/u, 'account name must not appear in sanitized config');

  const redactedJson = redactDirectMailEvidence(config);
  assert.doesNotMatch(redactedJson, /P528_HMAC/u);
  assert.doesNotMatch(redactedJson, /p528-sender@example\.invalid/u);
  assert.match(redactedJson, /\[CREDENTIAL REDACTED\]/u);

  // Defense-in-depth: generic secret-keyed log lines are scrubbed by the shared redactors
  // exactly as the adapter's redactEvidence() chains them.
  const logLine = redactDirectMailEvidence(
    redactSensitiveText(`email callback_secret=${hmacSecret} account=p528-sender@example.invalid`),
  );
  assert.doesNotMatch(logLine, /P528_HMAC/u);
  assert.doesNotMatch(logLine, /p528-sender@example\.invalid/u);
});

test('B2: ops suppression rate limit has bounded defaults and is config-driven', () => {
  const defaults = loadConfig(env).email!;
  assert.equal(defaults.opsRateLimit.maxRequests, 60);
  assert.equal(defaults.opsRateLimit.windowMs, 60_000);
  const configured = loadConfig({ ...env, EMAIL_OPS_RATE_LIMIT_MAX: '10',
    EMAIL_OPS_RATE_LIMIT_WINDOW_MS: '5000' }).email!;
  assert.equal(configured.opsRateLimit.maxRequests, 10);
  assert.equal(configured.opsRateLimit.windowMs, 5_000);
  assert.throws(() => loadConfig({ ...env, EMAIL_OPS_RATE_LIMIT_MAX: '0' }),
    /EMAIL_OPS_RATE_LIMIT_MAX/u);
  assert.throws(() => loadConfig({ ...env, EMAIL_OPS_RATE_LIMIT_MAX: '10001' }),
    /EMAIL_OPS_RATE_LIMIT_MAX/u);
  assert.throws(() => loadConfig({ ...env, EMAIL_OPS_RATE_LIMIT_WINDOW_MS: '3600001' }),
    /EMAIL_OPS_RATE_LIMIT_WINDOW_MS/u);
});

test('FIX-L-061: callback ingress rate limit has bounded defaults, is config-driven, and the shared Redis adapter is opt-in', () => {
  const defaults = loadConfig(env).email!;
  assert.equal(defaults.callbackRateLimit.maxRequests, 600,
    'the default IP budget leaves legitimate provider retries ample headroom');
  assert.equal(defaults.callbackRateLimit.windowMs, 60_000);
  assert.equal(defaults.callbackRateLimitShared.enabled, false,
    'multi-instance sharing is opt-in (zero Redis connections by default)');
  assert.equal(defaults.callbackRateLimitShared.redisUrl, null);
  assert.equal(defaults.callbackRateLimitShared.keySecret, null);
  const configured = loadConfig({ ...env, EMAIL_CALLBACK_RATE_LIMIT_MAX: '20',
    EMAIL_CALLBACK_RATE_LIMIT_WINDOW_MS: '5000' }).email!;
  assert.equal(configured.callbackRateLimit.maxRequests, 20);
  assert.equal(configured.callbackRateLimit.windowMs, 5_000);
  assert.throws(() => loadConfig({ ...env, EMAIL_CALLBACK_RATE_LIMIT_MAX: '0' }),
    /EMAIL_CALLBACK_RATE_LIMIT_MAX/u);
  assert.throws(() => loadConfig({ ...env, EMAIL_CALLBACK_RATE_LIMIT_MAX: '10001' }),
    /EMAIL_CALLBACK_RATE_LIMIT_MAX/u);
  assert.throws(() => loadConfig({ ...env, EMAIL_CALLBACK_RATE_LIMIT_WINDOW_MS: '3600001' }),
    /EMAIL_CALLBACK_RATE_LIMIT_WINDOW_MS/u);
  // Shared mode requires the URL + key secret (fail closed, mirroring MCP).
  assert.throws(() => loadConfig({ ...env, EMAIL_CALLBACK_RATE_LIMIT_SHARED: 'true' }),
    /EMAIL_CALLBACK_RATE_LIMIT_REDIS_URL is required/u);
  assert.throws(() => loadConfig({ ...env, EMAIL_CALLBACK_RATE_LIMIT_SHARED: 'true',
    EMAIL_CALLBACK_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379' }),
    /EMAIL_CALLBACK_RATE_LIMIT_KEY_SECRET is required/u);
  const shared = loadConfig({ ...env, EMAIL_CALLBACK_RATE_LIMIT_SHARED: 'true',
    EMAIL_CALLBACK_RATE_LIMIT_REDIS_URL: 'rediss://127.0.0.1:6379',
    EMAIL_CALLBACK_RATE_LIMIT_KEY_SECRET: 'l061-shared-secret-0123456789abcdef',
    EMAIL_CALLBACK_RATE_LIMIT_KEY_PREFIX: 'known-ecb' }).email!.callbackRateLimitShared;
  assert.equal(shared.enabled, true);
  assert.equal(shared.redisUrl, 'rediss://127.0.0.1:6379');
  assert.equal(shared.keyPrefix, 'known-ecb');
  assert.ok(shared.keySecret !== null && shared.keySecret.length >= 16);
  assert.throws(() => loadConfig({ ...env, EMAIL_CALLBACK_RATE_LIMIT_SHARED: 'true',
    EMAIL_CALLBACK_RATE_LIMIT_REDIS_URL: 'http://127.0.0.1:6379',
    EMAIL_CALLBACK_RATE_LIMIT_KEY_SECRET: 'l061-shared-secret-0123456789abcdef' }),
    /EMAIL_CALLBACK_RATE_LIMIT_REDIS_URL/u);
});

test('C2: plain-text camelCase secret pairs are redacted without over-redacting normal words', () => {
  const marker = 'P528_CAMELCASE_MARKER_';
  const redacted = redactSensitiveText(
    `accessKeySecret=${marker}1 callbackHmacSecret=${marker}2 accessKey=${marker}3`
    + ` myToken=${marker}4 userPassword=${marker}5`
    + ` monkey=${marker}6 secretion=${marker}7 tokenizer=${marker}8 tokens=${marker}9`);
  for (const secretValue of [1, 2, 3, 4, 5].map((n) => `${marker}${n}`)) {
    assert.doesNotMatch(redacted, new RegExp(secretValue.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      `camelCase secret value ${secretValue} must be redacted (C2)`);
  }
  for (const ordinaryValue of [6, 7, 8, 9].map((n) => `${marker}${n}`)) {
    assert.match(redacted, new RegExp(ordinaryValue.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      `ordinary word ${ordinaryValue} must NOT be over-redacted (C2)`);
  }
  assert.match(redacted, /accessKeySecret=\[REDACTED\]/u);
  assert.match(redacted, /callbackHmacSecret=\[REDACTED\]/u);
  assert.match(redacted, /accessKey=\[REDACTED\]/u);
  assert.match(redacted, /myToken=\[REDACTED\]/u);
  assert.match(redacted, /userPassword=\[REDACTED\]/u);
  // Existing bare-word redaction behavior is untouched.
  assert.equal(redactSensitiveText('secret=hunter2 api_key=abcd password=pw'),
    'secret=[REDACTED] api_key=[REDACTED] password=[REDACTED]');
});

test('N2: EMAIL_DELIVERY_* worker bounds accept boundaries and reject out-of-range values', () => {
  const on = { ...env, KNOWN_FEATURE_EMAIL: 'true', EMAIL_DM_ACCOUNT_NAME: 'no-reply@example.invalid' };
  const workerFor = (overrides: Record<string, string>) =>
    loadConfig({ ...on, ...overrides }).email!.worker;

  // max attempts: 2..20 (both boundary values accepted).
  assert.equal(workerFor({ EMAIL_DELIVERY_MAX_ATTEMPTS: '2' }).maxAttempts, 2);
  assert.equal(workerFor({ EMAIL_DELIVERY_MAX_ATTEMPTS: '20' }).maxAttempts, 20);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_MAX_ATTEMPTS: '1' }), /EMAIL_DELIVERY_MAX_ATTEMPTS/u);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_MAX_ATTEMPTS: '21' }), /EMAIL_DELIVERY_MAX_ATTEMPTS/u);

  // base backoff: 1000..3600000.
  assert.equal(workerFor({ EMAIL_DELIVERY_BASE_BACKOFF_MS: '1000' }).baseBackoffMs, 1_000);
  assert.equal(workerFor({ EMAIL_DELIVERY_BASE_BACKOFF_MS: '3600000' }).baseBackoffMs, 3_600_000);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_BASE_BACKOFF_MS: '999' }), /EMAIL_DELIVERY_BASE_BACKOFF_MS/u);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_BASE_BACKOFF_MS: '3600001' }), /EMAIL_DELIVERY_BASE_BACKOFF_MS/u);

  // max backoff: >= base (base lowered to its 1000 boundary here) and <= 86400000.
  assert.equal(workerFor({ EMAIL_DELIVERY_BASE_BACKOFF_MS: '1000',
    EMAIL_DELIVERY_MAX_BACKOFF_MS: '1000' }).maxBackoffMs, 1_000);
  assert.equal(workerFor({ EMAIL_DELIVERY_MAX_BACKOFF_MS: '86400000' }).maxBackoffMs, 86_400_000);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_BASE_BACKOFF_MS: '1000',
    EMAIL_DELIVERY_MAX_BACKOFF_MS: '999' }), /EMAIL_DELIVERY_MAX_BACKOFF_MS/u);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_MAX_BACKOFF_MS: '86400001' }), /EMAIL_DELIVERY_MAX_BACKOFF_MS/u);

  // poll interval: 100..60000.
  assert.equal(workerFor({ EMAIL_DELIVERY_POLL_INTERVAL_MS: '100' }).pollIntervalMs, 100);
  assert.equal(workerFor({ EMAIL_DELIVERY_POLL_INTERVAL_MS: '60000' }).pollIntervalMs, 60_000);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_POLL_INTERVAL_MS: '99' }), /EMAIL_DELIVERY_POLL_INTERVAL_MS/u);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_POLL_INTERVAL_MS: '60001' }), /EMAIL_DELIVERY_POLL_INTERVAL_MS/u);

  // lease duration: 1000..600000 (heartbeat lowered so the cross-field rule holds).
  assert.equal(workerFor({ EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS: '100',
    EMAIL_DELIVERY_LEASE_DURATION_MS: '1000' }).leaseDurationMs, 1_000);
  assert.equal(workerFor({ EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS: '100',
    EMAIL_DELIVERY_LEASE_DURATION_MS: '600000' }).leaseDurationMs, 600_000);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS: '100',
    EMAIL_DELIVERY_LEASE_DURATION_MS: '999' }), /EMAIL_DELIVERY_LEASE_DURATION_MS/u);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS: '100',
    EMAIL_DELIVERY_LEASE_DURATION_MS: '600001' }), /EMAIL_DELIVERY_LEASE_DURATION_MS/u);

  // heartbeat interval: 100..300000 (lease raised so the cross-field rule holds).
  assert.equal(workerFor({ EMAIL_DELIVERY_LEASE_DURATION_MS: '600000',
    EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS: '100' }).heartbeatIntervalMs, 100);
  assert.equal(workerFor({ EMAIL_DELIVERY_LEASE_DURATION_MS: '600000',
    EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS: '300000' }).heartbeatIntervalMs, 300_000);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_LEASE_DURATION_MS: '600000',
    EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS: '99' }), /EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS/u);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_LEASE_DURATION_MS: '600000',
    EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS: '300001' }), /EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS/u);

  // batch size: 1..64.
  assert.equal(workerFor({ EMAIL_DELIVERY_BATCH_SIZE: '1' }).batchSize, 1);
  assert.equal(workerFor({ EMAIL_DELIVERY_BATCH_SIZE: '64' }).batchSize, 64);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_BATCH_SIZE: '0' }), /EMAIL_DELIVERY_BATCH_SIZE/u);
  assert.throws(() => workerFor({ EMAIL_DELIVERY_BATCH_SIZE: '65' }), /EMAIL_DELIVERY_BATCH_SIZE/u);

  // Cross-field rule: heartbeat must be strictly smaller than the lease.
  assert.throws(
    () => workerFor({ EMAIL_DELIVERY_LEASE_DURATION_MS: '1000', EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS: '1000' }),
    /EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS must be smaller than EMAIL_DELIVERY_LEASE_DURATION_MS/u,
  );
  assert.throws(
    () => workerFor({ EMAIL_DELIVERY_LEASE_DURATION_MS: '1000', EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS: '2000' }),
    /EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS must be smaller than EMAIL_DELIVERY_LEASE_DURATION_MS/u,
  );
  const adjacent = workerFor({ EMAIL_DELIVERY_LEASE_DURATION_MS: '1000', EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS: '999' });
  assert.equal(adjacent.leaseDurationMs, 1_000);
  assert.equal(adjacent.heartbeatIntervalMs, 999);
});

test('email flag off still validates well-formed settings but never demands account/credentials', () => {
  const config = loadConfig({
    ...env,
    EMAIL_DM_ENDPOINT: 'https://dm.aliyuncs.com/',
    EMAIL_DM_REGION_ID: 'cn-beijing',
    EMAIL_DM_TIMEOUT_MS: '8000',
    EMAIL_DM_TAG_PREFIX: 'off-',
    EMAIL_DM_MAX_TAG_CHARS: '100',
  }).email!;
  assert.equal(config.enabled, false);
  assert.equal(config.regionId, 'cn-beijing');
  assert.equal(config.timeoutMs, 8000);
  assert.equal(config.maxTagChars, 100);
  assert.equal(config.accountName, null);
});
