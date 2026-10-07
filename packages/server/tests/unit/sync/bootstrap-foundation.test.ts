import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { buildApiApp } from '../../../src/transport/app.js';
import { loadConfig } from '../../support/test-config.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { composeModules } from '../../../src/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';

const backendRoot = resolve(import.meta.dirname, '../../..');

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(backendRoot, relativePath), 'utf8')) as T;
}

function readTypeScriptTree(relativePath: string): string {
  const root = join(backendRoot, relativePath);
  if (!existsSync(root)) return '';

  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
}

test('Phase 0 runtime skeleton exposes the required ownership directories', () => {
  for (const relativePath of [
    'src/bootstrap',
    'src/modules',
    'src/infrastructure',
    'src/transport',
  ]) {
    assert.equal(existsSync(join(backendRoot, relativePath)), true, relativePath);
  }
});

test('runtime dependencies remain on the Phase 0 technology baseline', () => {
  const packageJson = readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>('package.json');
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  for (const dependency of ['fastify', 'kysely', 'pg']) {
    assert.ok(dependencies[dependency], `${dependency} must be declared`);
  }
  for (const forbidden of ['@nestjs/core', '@nestjs/platform-fastify', 'pg-boss', 'kafkajs', 'redis']) {
    assert.equal(forbidden in dependencies, false, `${forbidden} is not a Phase 0 runtime dependency`);
  }
});

test('COLP is consumed through the public workspace package dependency', () => {
  const packageJson = readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>('package.json');
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  const colp = Object.entries(dependencies).find(([name]) => name === '@know-n/colp');
  assert.ok(colp, 'a COLP public package dependency is required');
  assert.equal(colp[1], '0.1.0');

  const sourceFiles = [
    ...['src', 'worker'].flatMap((directory) => {
      const marker = join(backendRoot, directory);
      return existsSync(marker) ? [marker] : [];
    }),
  ];
  assert.ok(sourceFiles.length > 0, 'runtime source must exist');

});

test('API and Worker startup paths stay explicit while current business modules remain owned', () => {
  const sourceText = ['src/bootstrap', 'worker'].map(readTypeScriptTree).join('\n');

  // The bootstrap contract is intentionally structural: startup wiring may be
  // split across files, but both runtimes must have explicit entrypoint names.
  assert.match(sourceText, /(?:start|create|build)(?:Api|App|Server)/i, 'API startup entrypoint is missing');
  assert.match(sourceText, /(?:start|create|build)(?:Worker|worker)/i, 'Worker startup entrypoint is missing');

  assert.equal(existsSync(join(backendRoot, 'src/modules/sync')), true,
    'P3-05 must own the production Replica facts module');
  assert.equal(existsSync(join(backendRoot, 'src/modules/sync/sync-session.ts')), true,
    'P3-07 must own the production Sync Session application use case');
  assert.equal(existsSync(join(backendRoot, 'src/transport/colp-sync/sync-session-routes.ts')), true,
    'P3-08 must own the production Sync Session HTTP route');
  assert.equal(existsSync(join(backendRoot, 'src/modules/sync/sync-push.ts')), true,
    'P3-11 must own the production single-operation Push admission');
  assert.equal(existsSync(join(backendRoot, 'src/infrastructure/sync/sync-push-postgres.ts')), true,
    'P3-11 must own the production PostgreSQL Push admission adapter');
  assert.equal(existsSync(join(backendRoot, 'src/modules/sync/application/sync-pull.ts')), true,
    'P3-20 must own the production Sync Pull cursor contract');
  assert.equal(existsSync(join(backendRoot, 'src/infrastructure/sync/postgres/sync-pull-postgres.ts')), true,
    'P3-20 must own the production PostgreSQL Pull read adapter');
  for (const futurePath of [
    'src/modules/sync/sync-snapshot.ts',
    'src/infrastructure/sync/sync-snapshot-postgres.ts',
  ]) {
    assert.equal(existsSync(join(backendRoot, futurePath)), false,
      `${futurePath} belongs to P3-08 or later`);
  }

  assert.equal(existsSync(join(backendRoot, 'src/modules/notifications/index.ts')), true,
    'Phase 5 must own the production Notification module');
  // P4A-I05 creates the production attachments module (config + readiness);
  // subscriptions remains a future module with no scaffold.
  for (const futureModule of ['subscriptions']) {
    assert.equal(existsSync(join(backendRoot, 'src/modules', futureModule)), false, `${futureModule} must not be scaffolded in Phase 0`);
  }
});

test('module source does not import framework or database adapters', () => {
  const moduleSource = readTypeScriptTree('src/modules');
  assert.doesNotMatch(moduleSource, /from\s+['"](?:fastify|kysely|pg)(?:['"]|\/)/);

  const allSource = readTypeScriptTree('src');
  assert.doesNotMatch(
    allSource,
    /(?:from|import\()\s*['"](?:@know-n\/colp\/src\/|(?:\.\.\/)*colp\/src\/)/,
  );

  const packageJson = readJson<{ scripts?: Record<string, string> }>('package.json');
  assert.ok(packageJson.scripts?.['check:imports'], 'CI-addressable import-boundary check is required');
});

test('configuration fails closed when DATABASE_URL is absent', () => {
  assert.throws(
    () => loadConfig({ PORT: '3000' }),
    /DATABASE_URL is required/,
  );
});

test('configuration validates the TCP port and supplies deterministic defaults', () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/known',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.ok(config.oidcTransactionSecrets.hmacSecret.length > 0);
  assert.ok(config.oidcTransactionSecrets.encryptionKeys.length >= 1);
  assert.equal(
    config.publishingInsights.visitorHmacKey.toString('utf8'),
    'dev-publishing-insights-visitor-hmac-key-change-me',
  );
  assert.equal(
    config.publishingInsights.rateLimitHmacKey.toString('utf8'),
    'dev-publishing-insights-ratelimit-hmac-key-change-me',
  );
  assert.equal(config.publishingInsights.rateLimitShared.enabled, false);
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'postgres://localhost/known', PORT: '70000' }),
    /PORT must be a valid TCP port/,
  );
});

test('configuration requires OIDC transaction secrets in production', () => {
  const prodKey = Buffer.alloc(32, 5).toString('base64');
  const prodBase = {
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'production',
    PRODUCT_ORIGIN: 'https://app.example.test',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_JWKS_URI: 'https://issuer.example/jwks',
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
    OIDC_ALLOW_TEST_PROVIDER: 'false',
  } as const;
  assert.throws(
    () => loadConfig({ ...prodBase, PUBLICATION_SERVER_UUID: undefined }),
    /PUBLICATION_SERVER_UUID is required/,
  );
  assert.throws(
    () => loadConfig({ ...prodBase }),
    /OIDC_TRANSACTION_HMAC_SECRET/,
  );
  assert.throws(
    () => loadConfig({
      ...prodBase,
      OIDC_TRANSACTION_HMAC_SECRET: 'prod-hmac-secret-not-dev-default',
    }),
    /OIDC_TRANSACTION_ENCRYPTION_KEYS/,
  );
  const ok = loadConfig({
    ...prodBase,
    OIDC_TRANSACTION_HMAC_SECRET: 'prod-hmac-secret-not-dev-default',
    OIDC_TRANSACTION_ENCRYPTION_KEYS: `1:oidc-pkce-prod:${prodKey}`,
  });
  assert.equal(ok.oidcTransactionSecrets.hmacSecret, 'prod-hmac-secret-not-dev-default');
  assert.equal(ok.oidcTransactionSecrets.encryptionKeys[0]?.id, 'oidc-pkce-prod');
  assert.equal(ok.httpSecurity.enableHsts, true);
  assert.equal(ok.httpSecurity.trustedProxyHops, 0);
  const completeProd = {
    ...prodBase,
    OIDC_TRANSACTION_HMAC_SECRET: 'prod-hmac-secret-not-dev-default',
    OIDC_TRANSACTION_ENCRYPTION_KEYS: `1:oidc-pkce-prod:${prodKey}`,
  };
  assert.throws(
    () => loadConfig({ ...completeProd, PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: undefined }),
    /ISSUANCE_FORMAT is required in production/,
  );
  assert.throws(
    () => loadConfig({ ...completeProd, PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: 'legacy' }),
    /LEGACY_ACCEPT_UNTIL is required/,
  );
  const phaseA = loadConfig({
    ...completeProd,
    PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: 'legacy',
    PRODUCT_EDITOR_CURSOR_LEGACY_ACCEPT_UNTIL: '2026-07-23T00:30:00.000Z',
  });
  assert.equal(phaseA.productEditorCursor.issuanceFormat, 'legacy');
  assert.equal(phaseA.productEditorCursor.legacyAcceptUntil, '2026-07-23T00:30:00.000Z');
  assert.throws(
    () => loadConfig({ ...completeProd, PRODUCT_EDITOR_CURSOR_KEY_ID: '' }),
    /PRODUCT_EDITOR_CURSOR_KEY_ID is required/,
  );
  assert.throws(
    () => loadConfig({ ...completeProd, PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: '' }),
    /PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID is required/,
  );
  assert.throws(
    () => loadConfig({ ...completeProd, PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'short' }),
    /at least 32 bytes in production/,
  );
  assert.throws(
    () => loadConfig({ ...completeProd, PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'dev-product-editor-cursor-hmac-key-change-me' }),
    /must not use the development default/,
  );
  for (const previous of [
    {
      id: 'dev-editor-v1',
      key: 'previous-product-editor-cursor-key-long-enough',
      lastIssuedAt: '2026-07-23T00:00:00.000Z',
      retainUntil: '2026-07-23T00:15:00.000Z',
    },
    {
      id: 'prod-editor-v0',
      key: 'dev-product-editor-cursor-hmac-key-change-me',
      lastIssuedAt: '2026-07-23T00:00:00.000Z',
      retainUntil: '2026-07-23T00:15:00.000Z',
    },
  ]) {
    assert.throws(
      () => loadConfig({
        ...completeProd,
        PRODUCT_EDITOR_CURSOR_PREVIOUS_KEYS: JSON.stringify([previous]),
      }),
      /must not use development defaults/,
    );
  }
  assert.throws(
    () => loadConfig({ ...completeProd, PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: '' }),
    /PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY is required/,
  );
  assert.throws(
    () => loadConfig({ ...completeProd, PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: '' }),
    /PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY is required/,
  );
  assert.throws(
    () => loadConfig({
      ...completeProd,
      PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'dev-publishing-insights-visitor-hmac-key-change-me',
    }),
    /must not use the development default/,
  );
  assert.throws(
    () => loadConfig({
      ...completeProd,
      PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: 'dev-publishing-insights-ratelimit-hmac-key-change-me',
    }),
    /must not use the development default/,
  );
  assert.throws(
    () => loadConfig({ ...completeProd, PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'short-insight-visitor-key' }),
    /at least 32 bytes in production/,
  );
  assert.throws(
    () => loadConfig({
      ...completeProd,
      PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'prod-publishing-insights-shared-hmac-key-32bxx',
      PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: 'prod-publishing-insights-shared-hmac-key-32bxx',
    }),
    /must be independent from the visitor HMAC key/,
  );
  assert.throws(
    () => loadConfig({
      ...completeProd,
      PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: completeProd.PRODUCT_EDITOR_CURSOR_HMAC_KEY,
    }),
    /must not reuse search, auth, or cursor secrets/,
  );
  const insights = loadConfig(completeProd).publishingInsights;
  assert.equal(insights.visitorHmacKey.toString('utf8'), 'prod-publishing-insights-visitor-hmac-key-32b');
  assert.equal(insights.rateLimitHmacKey.toString('utf8'), 'prod-publishing-insights-ratelimit-hmac-key-32b');
  assert.equal(insights.rateLimitShared.enabled, false);
  assert.equal(insights.rateLimitShared.redisUrl, null);
});

test('owned Collections cursor rotation is independent and retains keys for the full TTL', () => {
  const previous = JSON.stringify([{ id: 'owned-v1', key: 'owned-previous-secret-material',
    lastIssuedAt: '2026-07-26T00:00:00.000Z', retainUntil: '2026-07-26T00:15:00.000Z' }]);
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/known',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'owned-current-secret-material',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: 'owned-v2',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_PREVIOUS_KEYS: previous });
  assert.equal(config.productOwnedCollectionsCursor.current.id, 'owned-v2');
  assert.equal(config.productOwnedCollectionsCursor.previous[0]?.id, 'owned-v1');
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://localhost/known',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'owned-current-secret-material',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: 'owned-v1',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_PREVIOUS_KEYS: previous }), /IDs and material must be unique/);
});

test('editor cursor rotation configuration fails closed on unsafe production keys', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost/known',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'current-secret',
    PRODUCT_EDITOR_CURSOR_KEY_ID: 'editor-v2',
  };
  const previous = JSON.stringify([{
    id: 'editor-v1',
    key: 'previous-secret',
    lastIssuedAt: '2026-07-23T00:00:00.000Z',
    retainUntil: '2026-07-23T00:15:00.000Z',
  }]);
  const config = loadConfig({ ...base, PRODUCT_EDITOR_CURSOR_PREVIOUS_KEYS: previous });
  assert.equal(config.productEditorCursor.current.id, 'editor-v2');
  assert.equal(config.productEditorCursor.previous[0]?.id, 'editor-v1');

  assert.throws(
    () => loadConfig({
      ...base,
      PRODUCT_EDITOR_CURSOR_PREVIOUS_KEYS: JSON.stringify([{
        id: 'editor-v1', key: 'previous-secret',
        lastIssuedAt: '2026-07-23T00:00:00.000Z', retainUntil: '2026-07-23T00:14:59.999Z',
      }]),
    }),
    /retention must cover cursor TTL/,
  );
  assert.throws(
    () => loadConfig({ ...base, PRODUCT_EDITOR_CURSOR_KEY_ID: 'editor-v1', PRODUCT_EDITOR_CURSOR_PREVIOUS_KEYS: previous }),
    /key IDs must be unique/,
  );
  assert.throws(
    () => loadConfig({ ...base, PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'previous-secret', PRODUCT_EDITOR_CURSOR_PREVIOUS_KEYS: previous }),
    /key material must not be reused/,
  );

  for (const timestamp of [
    '0',
    '2026-07-23',
    '2026-07-23T00:00:00.000',
    '2026-07-23T08:00:00.000+08:00',
    '2026-02-30T00:00:00.000Z',
  ]) {
    assert.throws(
      () => loadConfig({
        ...base,
        PRODUCT_EDITOR_CURSOR_PREVIOUS_KEYS: JSON.stringify([{
          id: 'editor-v1', key: 'previous-secret',
          lastIssuedAt: timestamp, retainUntil: '2026-07-23T00:15:00.000Z',
        }]),
      }),
      /canonical RFC 3339 UTC|real canonical RFC 3339 UTC/,
    );
  }
  assert.throws(() => loadConfig({
    ...base,
    PRODUCT_EDITOR_CURSOR_PREVIOUS_KEYS: JSON.stringify(Array.from(
      { length: 9 },
      (_, index) => ({
        id: `editor-v${index}`,
        key: `independent-previous-secret-${index}`,
        lastIssuedAt: '2026-07-23T00:00:00.000Z',
        retainUntil: '2026-07-23T00:15:00.000Z',
      }),
    )),
  }), /at most 8 entries/);
});

test('minimal API and Worker composition can be constructed without business modules', async () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/known',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' });
  const metrics = new InMemoryMetrics();
  const app = buildApiApp({ config, metrics });
  const worker = buildWorker(config);
  assert.equal(typeof app.ready, 'function');
  assert.equal(typeof worker.start, 'function');
  assert.equal(typeof worker.stop, 'function');
  assert.equal((app as unknown as { metrics: InMemoryMetrics }).metrics, metrics);

  const health = await app.inject({ method: 'GET', url: '/health' });
  const readiness = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: 'ok' });
  assert.equal(readiness.statusCode, 200);
  assert.deepEqual(readiness.json(), { status: 'ready' });

  await worker.start();
  await worker.stop();
  await app.close();
});

test('module composition is explicit and has no implicit future registrations', async () => {
  const composition = composeModules([]);
  assert.deepEqual(composition.modules, []);
  assert.equal(typeof composition.start, 'function');
  assert.equal(typeof composition.stop, 'function');
  await composition.start();
  await composition.stop();
});

test('module composition rejects duplicate owners and stops in reverse order', async () => {
  const lifecycle: string[] = [];
  const first = {
    name: 'first',
    async start() { lifecycle.push('start:first'); },
    async stop() { lifecycle.push('stop:first'); },
  };
  const second = {
    name: 'second',
    async start() { lifecycle.push('start:second'); },
    async stop() { lifecycle.push('stop:second'); },
  };

  assert.throws(() => composeModules([first, { ...first }]), /duplicate module name/);
  const composition = composeModules([first, second]);
  await composition.start();
  await composition.stop();
  assert.deepEqual(lifecycle, ['start:first', 'start:second', 'stop:second', 'stop:first']);
});

test('module composition rolls back started modules in reverse order after startup failure', async () => {
  const lifecycle: string[] = [];
  const composition = composeModules([
    { name: 'first', async start() { lifecycle.push('start:first'); }, async stop() { lifecycle.push('stop:first'); } },
    { name: 'second', async start() { lifecycle.push('start:second'); }, async stop() { lifecycle.push('stop:second'); } },
    { name: 'failed', async start() { lifecycle.push('start:failed'); throw new Error('startup failed'); }, async stop() { lifecycle.push('stop:failed'); } },
  ]);

  await assert.rejects(composition.start(), /startup failed/);
  assert.deepEqual(lifecycle, [
    'start:first', 'start:second', 'start:failed', 'stop:second', 'stop:first',
  ]);
});

test('module composition attempts every stop when one module stop fails', async () => {
  const lifecycle: string[] = [];
  const composition = composeModules([
    { name: 'first', async start() {}, async stop() { lifecycle.push('stop:first'); } },
    { name: 'second', async start() {}, async stop() { lifecycle.push('stop:second'); throw new Error('stop failed'); } },
  ]);
  await composition.start();
  await assert.rejects(composition.stop(), /modules failed to stop/);
  assert.deepEqual(lifecycle, ['stop:second', 'stop:first']);
});
