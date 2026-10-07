import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createSyncSessionRuntime,
  destroySyncSessionRuntimeKeys,
} from '../../../src/bootstrap/sync-session-runtime.js';
import { loadConfig } from '../../support/test-config.js';
import type { createDatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';

function syncEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused/known',
    LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    PRODUCT_ORIGIN: 'https://known.example',
    PUBLICATION_ORIGIN: 'https://known.example',
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
    SYNC_PULL_LINEAGE_KEY: Buffer.alloc(32, 46).toString('base64'),
    ...overrides,
  };
}

function database(): ReturnType<typeof createDatabaseRuntime> {
  return {
    db: Object.freeze({}),
    pool: Object.freeze({}),
    async cancelBackend() { return false; },
    async verifyReady() {},
    async close() {},
  } as unknown as ReturnType<typeof createDatabaseRuntime>;
}

const credentialVerifier = Object.freeze({
  async verify(): Promise<never> { throw new Error('not invoked'); },
});

const attachmentExposure = Object.freeze({
  async assertAttachmentsDenied() {},
});

describe('Sync session runtime composition', () => {
  test('disabled configuration owns no runtime', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused/known',
      NODE_ENV: 'test',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    });
    assert.equal(config.syncSession, undefined);
  });

  test('enabled runtime composes every route and destroys its keyrings idempotently', () => {
    const config = loadConfig(syncEnv()).syncSession!;
    const telemetryLogger = { info() {}, error() {} };
    const runtime = createSyncSessionRuntime(
      database(),
      config,
      new InMemoryMetrics(),
      'https://known.example/api/v1/sync/snapshot',
      { credentialVerifier, attachmentExposure, telemetryLogger },
      ['127.0.0.1'],
    );
    assert.equal(runtime.session.path, config.path);
    assert.equal(runtime.snapshot.path, config.snapshot.path);
    assert.equal(runtime.push.path, config.push.path);
    assert.equal(runtime.pull.path, config.pull.path);
    assert.equal(runtime.ack.path, config.ack.path);
    assert.equal(runtime.retire.path, config.retire.path);
    assert.equal(runtime.pull.snapshotUrl, 'https://known.example/api/v1/sync/snapshot');
    assert.deepEqual(runtime.session.trustedIngress, ['127.0.0.1']);
    // The injected structured logger reaches the push route so unexpected
    // failures are recorded, not just mapped to a stable Problem.
    assert.equal(runtime.push.logger, telemetryLogger);
    runtime.destroy();
    runtime.destroy();
  });

  test('missing attachment exposure fails closed before any runtime is returned', () => {
    const config = loadConfig(syncEnv()).syncSession!;
    assert.throws(
      () => createSyncSessionRuntime(
        database(), config, new InMemoryMetrics(), undefined,
        { credentialVerifier } as never,
        [],
      ),
      /requires an attachment exposure policy/u,
    );
  });

  test('lineage key cleanup still runs when pull cursor cleanup throws', () => {
    const calls: string[] = [];
    assert.throws(
      () => destroySyncSessionRuntimeKeys(
        { destroy() { calls.push('pull'); throw new Error('pull cleanup failed'); } },
        { destroy() { calls.push('lineage'); } },
      ),
      /pull cleanup failed/u,
    );
    assert.deepEqual(calls, ['pull', 'lineage']);
  });
});
