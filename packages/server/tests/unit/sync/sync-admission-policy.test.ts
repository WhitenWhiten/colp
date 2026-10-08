/**
 * SYNC-Q-014: unified SyncAdmissionPolicy purposes, lanes, and HMAC privacy.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  SYNC_ADMISSION_PURPOSES,
  buildSyncAdmissionKey,
  createMemorySyncAdmissionPolicy,
  type SyncAdmissionPolicy,
} from '../../../src/infrastructure/rate-limit/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySyncColpRateLimiter } from '../../../src/transport/http-security.js';
import { syncRateLimitSharedEnv, testEnv } from '../../support/http-security-config-env.js';

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const BUDGET = Object.freeze({ maxRequests: 2, windowMs: 60_000 });

function syncSessionEnv(overrides: Record<string, string> = {}) {
  return {
    SYNC_SESSION_ENABLED: 'true',
    SYNC_EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop',
    SYNC_OAUTH_ISSUER: 'https://issuer.example.test',
    SYNC_OAUTH_CLIENT_ID: 'known-extension',
    SYNC_OAUTH_AUDIENCE: 'known-sync-api',
    SYNC_OAUTH_AUTHORIZATION_ENDPOINT: 'https://issuer.example.test/oauth2/authorize',
    SYNC_OAUTH_TOKEN_ENDPOINT: 'https://issuer.example.test/oauth2/token',
    SYNC_OAUTH_JWKS_URI: 'https://issuer.example.test/.well-known/jwks.json',
    SYNC_OAUTH_REDIRECT_URI: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/callback',
    SYNC_OAUTH_SCOPES: 'openid known.sync',
    SYNC_OAUTH_ALGORITHMS: 'RS256',
    SYNC_SESSION_REPLAY_KEY: Buffer.alloc(32, 23).toString('base64'),
    SYNC_SNAPSHOT_CURSOR_KEY: Buffer.alloc(32, 29).toString('base64'),
    SYNC_SNAPSHOT_CURSOR_KEY_ID: 'test-sync-snapshot-v1',
    SYNC_PULL_CURSOR_KEY_ID: 'test-sync-pull-v1',
    SYNC_PULL_CURSOR_KEY: Buffer.alloc(32, 41).toString('base64'),
    SYNC_RECOVERY_CAPABILITY_KEY_ID: 'recovery-v1',
    SYNC_RECOVERY_CAPABILITY_KEY: Buffer.alloc(32, 44).toString('base64'),
    SYNC_PULL_LINEAGE_KEY_ID: 'lineage-v1',
    SYNC_PULL_LINEAGE_KEY: Buffer.alloc(32, 47).toString('base64'),
    ...overrides,
  };
}

describe('SYNC-Q-014 SyncAdmissionPolicy', () => {
  test('closes exactly eight purposes and keeps pre-auth independent from subject', async () => {
    assert.deepEqual([...SYNC_ADMISSION_PURPOSES], [
      'session', 'snapshot', 'push', 'pull', 'conflict', 'effect-page', 'ack', 'retire',
    ]);
    const policy = createMemorySyncAdmissionPolicy({
      budgets: { conflict: BUDGET, session: BUDGET },
    });
    assert.equal((await policy.admitPreAuth({ purpose: 'conflict', clientKey: 'ip-a' })).kind, 'allowed');
    assert.equal((await policy.admitPreAuth({ purpose: 'conflict', clientKey: 'ip-a' })).kind, 'allowed');
    assert.equal((await policy.admitPreAuth({ purpose: 'conflict', clientKey: 'ip-a' })).kind, 'denied');
    assert.equal((await policy.admitPreAuth({ purpose: 'conflict', clientKey: 'ip-b' })).kind, 'allowed');
    assert.equal((await policy.admitSubject({ purpose: 'conflict', subjectKey: 'account-a' })).kind, 'allowed');
    assert.equal((await policy.admitPreAuth({ purpose: 'session', clientKey: 'ip-a' })).kind, 'allowed');
    assert.equal((await policy.admitPreAuth({ purpose: 'push', clientKey: 'ip-a' })).kind, 'failed');
    await policy.close();
  });

  test('HMAC keys never contain raw IP or account identity', () => {
    const rawIp = '2001:db8::10';
    const rawAccount = 'account-raw-id-014';
    const key = buildSyncAdmissionKey({
      environment: 'test',
      keySecret: Buffer.from('sync-admission-hmac-secret-014', 'utf8'),
      purpose: 'conflict',
      subject: `preauth:${rawIp}`,
      windowStartEpochMs: 1_750_000_000_000,
    });
    assert.match(key, /^known-sync:test:admit:v1:\{sync:[A-Za-z0-9_-]{32}\}:conflict:1750000000000$/u);
    assert.doesNotMatch(key, /2001:db8/u);
    assert.doesNotMatch(key, /account-raw/u);
    const subject = buildSyncAdmissionKey({
      environment: 'test',
      keySecret: Buffer.from('sync-admission-hmac-secret-014', 'utf8'),
      purpose: 'ack',
      subject: `subject:${rawAccount}`,
      windowStartEpochMs: 0,
    });
    assert.doesNotMatch(subject, new RegExp(rawAccount, 'u'));
    assert.notEqual(key, subject);
  });

  test('shared Sync composition refuses a missing admission policy even when COLP limiter is present', () => {
    const config = loadConfig(testEnv(syncRateLimitSharedEnv(syncSessionEnv())));
    const syncColpRateLimiter = createMemorySyncColpRateLimiter({
      pushMaxRequests: 10, pushWindowMs: 60_000, pullMaxRequests: 10, pullWindowMs: 60_000,
    });
    assert.throws(
      () => buildApiApp({ config, syncColpRateLimiter }),
      /injected syncAdmissionPolicy.*SYNC_RATE_LIMIT_SHARED=true/s,
    );
  });

  test('in-process limiter probe stays ready when admission is memory-only', async () => {
    const deny: SyncAdmissionPolicy = {
      admitPreAuth: async () => ({ kind: 'denied', retryAfterSeconds: 1 }),
      admitSubject: async () => ({ kind: 'denied', retryAfterSeconds: 1 }),
      readiness: () => ({ status: 'healthy', reason: 'none' }),
      close: async () => undefined,
    };
    const app = buildApiApp({
      config: loadConfig(testEnv()),
      syncAdmissionPolicy: deny,
    });
    apps.push(app);
    const capability = await app.inject({ method: 'GET', url: '/ready/features/limiter' });
    assert.equal(capability.statusCode, 200);
    assert.equal(capability.json().mode, 'in-process');
  });
});
