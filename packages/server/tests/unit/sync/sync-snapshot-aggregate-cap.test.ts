import assert from 'node:assert/strict';
import { beforeEach, describe, test, vi } from 'vitest';

// B-02 (sync resilience audit): production wiring used to pass a 2 MiB aggregate
// byte cap into Snapshot materialization, so every library above roughly 5,000
// bookmarks answered 413 on onboarding, Snapshot recovery and Reset. The cap is
// now an explicit operator quota; per-page budgets still bound every response.
const captured = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));

vi.mock('../../../src/infrastructure/sync/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/infrastructure/sync/index.js')>();
  return {
    ...actual,
    createPostgresSyncBootstrapSnapshotApplication: (_runtime: unknown, options: Record<string, unknown>) => {
      captured.options.push(options);
      return Object.freeze({
        async query() { throw new Error('not invoked'); },
      });
    },
  };
});

const { createSyncSessionRuntime } = await import('../../../src/bootstrap/sync-session-runtime.js');
const { loadConfig } = await import('../../support/test-config.js');
const { InMemoryMetrics } = await import('../../../src/infrastructure/telemetry/index.js');

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

function database(): Parameters<typeof createSyncSessionRuntime>[0] {
  return {
    db: Object.freeze({}),
    pool: Object.freeze({}),
    async cancelBackend() { return false; },
    async verifyReady() {},
    async close() {},
  } as unknown as Parameters<typeof createSyncSessionRuntime>[0];
}

const credentialVerifier = Object.freeze({
  async verify(): Promise<never> { throw new Error('not invoked'); },
});
const attachmentExposure = Object.freeze({ async assertAttachmentsDenied() {} });

function compose(overrides: Record<string, string> = {}): void {
  const config = loadConfig(syncEnv(overrides)).syncSession!;
  const runtime = createSyncSessionRuntime(database(), config, new InMemoryMetrics(), undefined,
    { credentialVerifier, attachmentExposure }, []);
  runtime.destroy();
}

describe('Sync Snapshot aggregate byte cap (B-02)', () => {
  beforeEach(() => { captured.options.length = 0; });

  test('is unset by default: no aggregate cap reaches Snapshot materialization', () => {
    assert.equal(loadConfig(syncEnv()).syncSession!.snapshot.maxBytes, undefined);
    compose();
    assert.equal(captured.options.length, 1);
    assert.equal('maxSnapshotBytes' in captured.options[0]!, false);
    // The old default (2 MiB) must not come back through any other key either.
    assert.equal(JSON.stringify(captured.options[0], (_key, value) =>
      typeof value === 'function' ? undefined : value).includes('2097152'), false);
  });

  test('a blank value is the same as unset', () => {
    assert.equal(loadConfig(syncEnv({ SYNC_SNAPSHOT_MAX_BYTES: '  ' })).syncSession!.snapshot.maxBytes, undefined);
  });

  test('an explicit operator quota is parsed and passed through unchanged', () => {
    assert.equal(loadConfig(syncEnv({ SYNC_SNAPSHOT_MAX_BYTES: '4194304' })).syncSession!.snapshot.maxBytes, 4_194_304);
    compose({ SYNC_SNAPSHOT_MAX_BYTES: '4194304' });
    assert.equal(captured.options[0]!.maxSnapshotBytes, 4_194_304);
  });

  test('an explicit quota keeps its bounds', () => {
    assert.throws(() => loadConfig(syncEnv({ SYNC_SNAPSHOT_MAX_BYTES: '0' })),
      /SYNC_SNAPSHOT_MAX_BYTES must be a safe integer >= 1/u);
    assert.throws(() => loadConfig(syncEnv({ SYNC_SNAPSHOT_MAX_BYTES: '16777217' })),
      /SYNC_SNAPSHOT_MAX_BYTES must be <= 16777216/u);
    assert.throws(() => loadConfig(syncEnv({ SYNC_SNAPSHOT_MAX_BYTES: 'big' })),
      /SYNC_SNAPSHOT_MAX_BYTES must be a safe integer/u);
  });
});
