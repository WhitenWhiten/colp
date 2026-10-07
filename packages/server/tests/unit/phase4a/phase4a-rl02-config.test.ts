/**
 * P4A-RL02 distributed rate-limit CONFIG contract (plan §2.3 suggested
 * config contract + §8 RL02 test scope).
 *
 * Every value of the suggested contract is parsed through the REAL production
 * parser (`parseAttachmentRateLimitConfig`) with compile-time hard ceilings
 * and safe-integer validation, and every invalid/tampered input fails closed
 * at load time — before any client/route initialization. The URL is only
 * checked for scheme/userinfo and validation errors NEVER echo the raw URL or
 * the secret. The multi-replica production gate
 * (`assertProductionRateLimitProfile`) rejects any profile that is not
 * `enforce + required` when attachments are enabled on a multi-replica
 * production profile (plan §2.2.6), while single-instance acceptance may
 * record `off` explicitly.
 *
 * Synthetic markers prove the redaction scan really covers the sanitize view
 * and every parse error path: a marker that would appear in the sanitize
 * view, a log view or an error message fails this suite.
 *
 * No Redis, no PostgreSQL, no browser.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ATTACHMENTS_COMPLETE_EMERGENCY_RATE_MAX_DEFAULT,
  ATTACHMENTS_COMPLETE_EMERGENCY_RATE_WINDOW_MS_DEFAULT,
  ATTACHMENTS_DOWNLOAD_RATE_MAX_DEFAULT,
  ATTACHMENTS_DOWNLOAD_RATE_WINDOW_MS_DEFAULT,
  ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_DEFAULT_MS,
  ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_MAX_MS,
  ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_DEFAULT_MS,
  ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_MAX_MS,
  ATTACHMENTS_RATE_LIMIT_EMERGENCY_RATE_MAX_HARD_CEILING,
  ATTACHMENTS_RATE_LIMIT_KEY_PREFIX_DEFAULT,
  ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST_DEFAULT,
  ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST_MAX,
  ATTACHMENTS_RATE_LIMIT_MODE_DEFAULT,
  ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING,
  ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS,
  ATTACHMENTS_RATE_LIMIT_REQUIRED_DEFAULT,
  ATTACHMENTS_STATUS_RATE_MAX_DEFAULT,
  ATTACHMENTS_STATUS_RATE_WINDOW_MS_DEFAULT,
  ATTACHMENTS_UPLOAD_COMPLETE_RATE_MAX_DEFAULT,
  ATTACHMENTS_UPLOAD_COMPLETE_RATE_WINDOW_MS_DEFAULT,
  ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX_DEFAULT,
  ATTACHMENTS_UPLOAD_ISSUE_RATE_WINDOW_MS_DEFAULT,
  assertAttachmentRateLimitConfig,
  assertProductionRateLimitProfile,
  parseAttachmentRateLimitConfig,
  productionRateLimitProfileViolation,
  sanitizeAttachmentRateLimitConfig,
  type AttachmentRateLimitConfig,
  type AttachmentRateLimitProductionGate,
} from '../../../src/modules/attachments/index.js';

/** A fully valid enforce+required config (the production candidate profile). */
function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ATTACHMENTS_RATE_LIMIT_MODE: 'enforce',
    ATTACHMENTS_RATE_LIMIT_REQUIRED: 'true',
    ATTACHMENTS_RATE_LIMIT_REDIS_URL: 'rediss://redis.internal:6379',
    ATTACHMENTS_RATE_LIMIT_KEY_SECRET: 'known/rl02/key/hmac',
    ATTACHMENTS_RATE_LIMIT_KEY_PREFIX: 'known',
    ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_MS: '75',
    ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_MS: '1000',
    ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST: '1',
    ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX: '30',
    ATTACHMENTS_UPLOAD_ISSUE_RATE_WINDOW_MS: '60000',
    ATTACHMENTS_UPLOAD_COMPLETE_RATE_MAX: '60',
    ATTACHMENTS_UPLOAD_COMPLETE_RATE_WINDOW_MS: '60000',
    ATTACHMENTS_DOWNLOAD_RATE_MAX: '30',
    ATTACHMENTS_DOWNLOAD_RATE_WINDOW_MS: '60000',
    ATTACHMENTS_STATUS_RATE_MAX: '60',
    ATTACHMENTS_STATUS_RATE_WINDOW_MS: '60000',
    ATTACHMENTS_COMPLETE_EMERGENCY_RATE_MAX: '15',
    ATTACHMENTS_COMPLETE_EMERGENCY_RATE_WINDOW_MS: '60000',
    ...overrides,
  };
}

/** A structurally valid config literal (for tamper tests that bypass parsing). */
function makeConfig(overrides: Partial<AttachmentRateLimitConfig> = {}): AttachmentRateLimitConfig {
  const base: AttachmentRateLimitConfig = {
    mode: 'off',
    required: false,
    redisUrl: null,
    keySecretRef: null,
    keyPrefix: 'known',
    commandTimeoutMs: 75,
    connectTimeoutMs: 1000,
    maxRetriesPerRequest: 1,
    routes: Object.freeze({
      issue: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }),
    completeEmergency: Object.freeze({ rateMax: 15, rateWindowMs: 60000 }),
  };
  return Object.freeze({ ...base, ...overrides }) as AttachmentRateLimitConfig;
}

function gate(overrides: Partial<AttachmentRateLimitProductionGate> = {}): AttachmentRateLimitProductionGate {
  return { attachmentsEnabled: true, production: true, multiReplica: true, mode: 'enforce', required: true, ...overrides };
}

function assertErrorHides(execute: () => unknown, marker: string, pattern: RegExp): void {
  assert.throws(execute, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(!message.includes(marker), `error message must never echo the secret/URL marker: ${message}`);
    assert.match(message, pattern);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Plan §2.3 suggested defaults are pinned compile-time constants
// ---------------------------------------------------------------------------

test('the plan §2.3 suggested defaults are pinned as compile-time constants', () => {
  assert.equal(ATTACHMENTS_RATE_LIMIT_MODE_DEFAULT, 'off');
  assert.equal(ATTACHMENTS_RATE_LIMIT_REQUIRED_DEFAULT, false);
  assert.equal(ATTACHMENTS_RATE_LIMIT_KEY_PREFIX_DEFAULT, 'known');
  assert.equal(ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_DEFAULT_MS, 75);
  assert.equal(ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_DEFAULT_MS, 1000);
  assert.equal(ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST_DEFAULT, 1);
  assert.equal(ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX_DEFAULT, 30);
  assert.equal(ATTACHMENTS_UPLOAD_ISSUE_RATE_WINDOW_MS_DEFAULT, 60000);
  assert.equal(ATTACHMENTS_UPLOAD_COMPLETE_RATE_MAX_DEFAULT, 60);
  assert.equal(ATTACHMENTS_UPLOAD_COMPLETE_RATE_WINDOW_MS_DEFAULT, 60000);
  assert.equal(ATTACHMENTS_DOWNLOAD_RATE_MAX_DEFAULT, 30);
  assert.equal(ATTACHMENTS_DOWNLOAD_RATE_WINDOW_MS_DEFAULT, 60000);
  // FIX-L-051: the owner-private status read budget (KA-P4-AM-16).
  assert.equal(ATTACHMENTS_STATUS_RATE_MAX_DEFAULT, 60);
  assert.equal(ATTACHMENTS_STATUS_RATE_WINDOW_MS_DEFAULT, 60000);
  assert.equal(ATTACHMENTS_COMPLETE_EMERGENCY_RATE_MAX_DEFAULT, 15);
  assert.equal(ATTACHMENTS_COMPLETE_EMERGENCY_RATE_WINDOW_MS_DEFAULT, 60000);
  // Compile-time hard ceilings (bounded request budget, bounded startup).
  assert.equal(ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_MAX_MS, 5000);
  assert.equal(ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_MAX_MS, 30000);
  assert.equal(ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST_MAX, 10);
  assert.equal(ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING, 10000);
  assert.equal(ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS, 3600000);
  assert.equal(ATTACHMENTS_RATE_LIMIT_EMERGENCY_RATE_MAX_HARD_CEILING, 1000);
});

// ---------------------------------------------------------------------------
// Valid configs
// ---------------------------------------------------------------------------

test('an empty environment parses to the safe off profile with the suggested defaults', () => {
  const config = parseAttachmentRateLimitConfig({});
  assert.equal(config.mode, 'off');
  assert.equal(config.required, false);
  assert.equal(config.redisUrl, null);
  assert.equal(config.keySecretRef, null);
  assert.equal(config.keyPrefix, 'known');
  assert.equal(config.commandTimeoutMs, 75);
  assert.equal(config.connectTimeoutMs, 1000);
  assert.equal(config.maxRetriesPerRequest, 1);
  assert.deepEqual(config.routes.issue, { rateMax: 30, rateWindowMs: 60000 });
  assert.deepEqual(config.routes.complete, { rateMax: 60, rateWindowMs: 60000 });
  assert.deepEqual(config.routes.download, { rateMax: 30, rateWindowMs: 60000 });
  assert.deepEqual(config.routes.status, { rateMax: 60, rateWindowMs: 60000 });
  assert.deepEqual(config.completeEmergency, { rateMax: 15, rateWindowMs: 60000 });
});

test('enforce and shadow profiles parse when URL and key secret are present', () => {
  const enforce = parseAttachmentRateLimitConfig(validEnv());
  assert.equal(enforce.mode, 'enforce');
  assert.equal(enforce.required, true);
  assert.equal(enforce.redisUrl, 'rediss://redis.internal:6379');
  assert.equal(enforce.keySecretRef, 'known/rl02/key/hmac');
  assert.deepEqual(enforce.routes.issue, { rateMax: 30, rateWindowMs: 60000 });
  assert.deepEqual(enforce.routes.complete, { rateMax: 60, rateWindowMs: 60000 });
  assert.deepEqual(enforce.routes.download, { rateMax: 30, rateWindowMs: 60000 });
  assert.deepEqual(enforce.routes.status, { rateMax: 60, rateWindowMs: 60000 });
  assert.deepEqual(enforce.completeEmergency, { rateMax: 15, rateWindowMs: 60000 });

  const shadow = parseAttachmentRateLimitConfig(validEnv({
    ATTACHMENTS_RATE_LIMIT_MODE: 'shadow',
    ATTACHMENTS_RATE_LIMIT_REQUIRED: 'false',
  }));
  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.required, false);
  assert.equal(shadow.redisUrl, 'rediss://redis.internal:6379');
  assert.equal(shadow.keySecretRef, 'known/rl02/key/hmac');
});

test('mode is trimmed and case-insensitive; retries may be zero', () => {
  const config = parseAttachmentRateLimitConfig(validEnv({
    ATTACHMENTS_RATE_LIMIT_MODE: ' ENFORCE ',
    ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST: '0',
  }));
  assert.equal(config.mode, 'enforce');
  assert.equal(config.maxRetriesPerRequest, 0);
});

// ---------------------------------------------------------------------------
// Tamper one value -> fail closed, without echoing secrets
// ---------------------------------------------------------------------------

test('an invalid mode value fails closed and never echoes the raw value', () => {
  const marker = 'rl02-mode-marker';
  assertErrorHides(
    () => parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_MODE: marker })),
    marker,
    /ATTACHMENTS_RATE_LIMIT_MODE must be one of off, shadow or enforce/,
  );
  assert.throws(() => parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_MODE: '' })), /off, shadow or enforce/);
});

test('a URL without a redis scheme fails closed and never echoes the URL', () => {
  const marker = 'rl02-url-marker';
  // A raw host:port is not a URL at all.
  assertErrorHides(
    () => parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_REDIS_URL: 'redis.internal:6379' })),
    'redis.internal:6379',
    /redis:\/\/ or rediss:\/\//,
  );
  // An http URL is a URL but the wrong scheme.
  assertErrorHides(
    () => parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_REDIS_URL: `http://${marker}.internal:6379` })),
    marker,
    /redis:\/\/ or rediss:\/\//,
  );
});

test('a URL carrying userinfo secrets fails closed and never echoes the secret', () => {
  const marker = 'rl02-userinfo-secret-marker';
  assertErrorHides(
    () => parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_REDIS_URL: `rediss://rl-user:${marker}@redis.internal:6379` })),
    marker,
    /userinfo/,
  );
  assertErrorHides(
    () => parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_REDIS_URL: `redis://:${marker}@redis.internal:6379` })),
    marker,
    /userinfo/,
  );
});

test('shadow/enforce require the URL and the key secret; deleting either fails closed', () => {
  for (const mode of ['shadow', 'enforce'] as const) {
    assert.throws(
      () => parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_MODE: mode, ATTACHMENTS_RATE_LIMIT_REDIS_URL: undefined })),
      /ATTACHMENTS_RATE_LIMIT_REDIS_URL is required/,
    );
    assert.throws(
      () => parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_MODE: mode, ATTACHMENTS_RATE_LIMIT_KEY_SECRET: undefined })),
      /ATTACHMENTS_RATE_LIMIT_KEY_SECRET is required/,
    );
  }
});

test('an invalid key secret reference fails closed and never echoes the value', () => {
  const marker = 'rl02 secret ref marker with spaces';
  assertErrorHides(
    () => parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_KEY_SECRET: marker })),
    marker,
    /secret reference/,
  );
});

test('timeouts and retries outside their bounded ranges fail closed', () => {
  for (const [key, value] of [
    ['ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_MS', '0'],
    ['ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_MS', '5001'],
    ['ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_MS', '75.5'],
    ['ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_MS', 'abc'],
    ['ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_MS', '0'],
    ['ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_MS', '30001'],
    ['ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST', '-1'],
    ['ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST', '11'],
    ['ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST', '1.5'],
  ] as const) {
    assert.throws(() => parseAttachmentRateLimitConfig(validEnv({ [key]: value })), /safe integer|<=|>=/, `${key}=${value} must fail closed`);
  }
});

test('route budgets that are not safe integers or exceed ceilings fail closed', () => {
  for (const [key, value] of [
    ['ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX', '0'],
    ['ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX', '-1'],
    ['ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX', '10001'],
    ['ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX', '30.5'],
    ['ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX', 'abc'],
    ['ATTACHMENTS_UPLOAD_ISSUE_RATE_WINDOW_MS', '0'],
    ['ATTACHMENTS_UPLOAD_ISSUE_RATE_WINDOW_MS', '3600001'],
    ['ATTACHMENTS_UPLOAD_ISSUE_RATE_WINDOW_MS', '60000.5'],
    ['ATTACHMENTS_UPLOAD_COMPLETE_RATE_MAX', '10001'],
    ['ATTACHMENTS_DOWNLOAD_RATE_MAX', '10001'],
    ['ATTACHMENTS_DOWNLOAD_RATE_WINDOW_MS', '3600001'],
    ['ATTACHMENTS_STATUS_RATE_MAX', '0'],
    ['ATTACHMENTS_STATUS_RATE_MAX', '10001'],
    ['ATTACHMENTS_STATUS_RATE_WINDOW_MS', '3600001'],
    ['ATTACHMENTS_COMPLETE_EMERGENCY_RATE_MAX', '1001'],
    ['ATTACHMENTS_COMPLETE_EMERGENCY_RATE_MAX', '0'],
    ['ATTACHMENTS_COMPLETE_EMERGENCY_RATE_WINDOW_MS', '3600001'],
  ] as const) {
    assert.throws(() => parseAttachmentRateLimitConfig(validEnv({ [key]: value })), /safe integer|<=/, `${key}=${value} must fail closed`);
  }
});

test('required=true with mode=off is a contradictory combination and fails closed', () => {
  assert.throws(
    () => parseAttachmentRateLimitConfig({ ATTACHMENTS_RATE_LIMIT_REQUIRED: 'true' }),
    /ATTACHMENTS_RATE_LIMIT_REQUIRED=true requires/,
  );
  // The cross-field re-assertion catches the same combination on a literal config.
  assert.throws(
    () => assertAttachmentRateLimitConfig(makeConfig({ mode: 'off', required: true })),
    /ATTACHMENTS_RATE_LIMIT_REQUIRED=true requires/,
  );
  // A tampered literal budget is caught by the re-assertion too.
  assert.throws(
    () => assertAttachmentRateLimitConfig(makeConfig({
      mode: 'enforce',
      required: true,
      redisUrl: 'rediss://redis.internal:6379',
      keySecretRef: 'known/rl02/key/hmac',
      routes: { ...makeConfig().routes, issue: { rateMax: 10001, rateWindowMs: 60000 } },
    })),
    /rateMax/,
  );
});

test('deleting the mode from an enforce+required config fails closed (off+required)', () => {
  assert.throws(
    () => parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_MODE: undefined })),
    /ATTACHMENTS_RATE_LIMIT_REQUIRED=true requires/,
  );
});

test('deleting required keeps the staging-valid enforce profile', () => {
  const config = parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_REQUIRED: undefined }));
  assert.equal(config.mode, 'enforce');
  assert.equal(config.required, false);
});

test('deleting an optional budget falls back to the suggested default', () => {
  const config = parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_UPLOAD_COMPLETE_RATE_MAX: undefined }));
  assert.equal(config.routes.complete.rateMax, 60);
  assert.equal(config.routes.complete.rateWindowMs, 60000);
});

// ---------------------------------------------------------------------------
// Production multi-replica profile gate (plan §2.2.6)
// ---------------------------------------------------------------------------

test('enforce+required passes the production multi-replica gate', () => {
  assert.equal(productionRateLimitProfileViolation(gate()), null);
  assert.doesNotThrow(() => assertProductionRateLimitProfile(gate()));
});

test('off/shadow or required=false rejects the production multi-replica profile', () => {
  for (const mode of ['off', 'shadow'] as const) {
    const violation = productionRateLimitProfileViolation(gate({ mode }));
    assert.ok(violation !== null, `${mode} must be rejected`);
    assert.match(violation!, /enforce/);
    assert.throws(() => assertProductionRateLimitProfile(gate({ mode })), /enforce/);
  }
  const violation = productionRateLimitProfileViolation(gate({ required: false }));
  assert.ok(violation !== null);
  assert.throws(() => assertProductionRateLimitProfile(gate({ required: false })), /enforce/);
});

test('single-instance acceptance may explicitly record off', () => {
  assert.doesNotThrow(() => assertProductionRateLimitProfile(gate({ multiReplica: false, mode: 'off', required: false })));
  assert.doesNotThrow(() => assertProductionRateLimitProfile(gate({ production: false, mode: 'off', required: false })));
  assert.doesNotThrow(() => assertProductionRateLimitProfile(gate({ attachmentsEnabled: false, mode: 'off', required: false })));
});

// ---------------------------------------------------------------------------
// Startup redaction: the sanitize view and every error message hide secrets
// ---------------------------------------------------------------------------

test('the sanitize view never exposes the URL or the key secret reference', () => {
  const config = parseAttachmentRateLimitConfig(validEnv());
  const sanitized = sanitizeAttachmentRateLimitConfig(config);
  assert.equal(sanitized.mode, 'enforce');
  assert.equal(sanitized.required, true);
  assert.equal(sanitized.keyPrefix, 'known');
  assert.equal(sanitized.commandTimeoutMs, 75);
  assert.equal(sanitized.connectTimeoutMs, 1000);
  assert.equal(sanitized.maxRetriesPerRequest, 1);
  assert.deepEqual(sanitized.routes.issue, { rateMax: 30, rateWindowMs: 60000 });
  assert.deepEqual(sanitized.routes.status, { rateMax: 60, rateWindowMs: 60000 });
  assert.deepEqual(sanitized.completeEmergency, { rateMax: 15, rateWindowMs: 60000 });
  assert.equal(sanitized.redisConfigured, true);
  assert.equal(sanitized.keySecretConfigured, true);
  const serialized = JSON.stringify(sanitized);
  assert.ok(!serialized.includes('redis.internal'), 'the URL host must not leak into the sanitize view');
  assert.ok(!serialized.includes('known/rl02/key/hmac'), 'the secret reference must not leak into the sanitize view');
});

test('a synthetic marker planted in the URL/secret is absent from the sanitize view', () => {
  const marker = `rl02-redaction-marker-${Date.now()}`;
  const config = makeConfig({
    mode: 'enforce',
    required: true,
    redisUrl: `rediss://:${marker}@redis.internal:6379`,
    keySecretRef: `known/${marker}`,
  });
  const sanitized = sanitizeAttachmentRateLimitConfig(config);
  const serialized = JSON.stringify(sanitized);
  assert.ok(!serialized.includes(marker), 'the synthetic marker reached the sanitize view');
  assert.equal(sanitized.redisConfigured, true);
  assert.equal(sanitized.keySecretConfigured, true);
});

test('a synthetic marker planted in invalid input never appears in any error message', () => {
  const marker = `rl02-error-marker-${Date.now()}`;
  assertErrorHides(
    () => parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_REDIS_URL: `rediss://rl:${marker}@host:6379` })),
    marker,
    /userinfo/,
  );
  assertErrorHides(
    () => parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_MODE: marker })),
    marker,
    /off, shadow or enforce/,
  );
  assertErrorHides(
    () => parseAttachmentRateLimitConfig(validEnv({ ATTACHMENTS_RATE_LIMIT_KEY_SECRET: `known/${marker} with spaces` })),
    marker,
    /secret reference/,
  );
});
