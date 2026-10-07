import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'vitest';
import Fastify from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import {
  BETTER_AUTH_COOKIE_NAME,
  INSECURE_HTTP_COOKIE_NAME,
  buildBetterAuthConfig,
} from '../../../src/modules/auth/better-auth-config.js';
import { parseSessionCookieField } from '../../../src/transport/session-cookie.js';
import {
  INSECURE_HTTP_TRANSPORT_WARNING,
  installHttpSecurity,
} from '../../../src/transport/http-security.js';
import {
  acceptSyncTransportEvidence,
  classifySyncTransportEvidence,
  createSyncTransportSecurity,
} from '../../../src/transport/colp-sync/sync-transport-security.js';
import { registerPublicationManifestRoutes } from '../../../src/transport/product/publication-manifest-routes.js';
import { createCaptureRuntime } from '../../../src/infrastructure/collections/capture-runtime.js';
import {
  BETTER_AUTH_PROD_SECRET,
  betterAuthTestEnv,
} from '../../support/better-auth-config-test-helpers.js';
import { testEnv } from '../../support/http-security-config-env.js';
import {
  EXTENSION_ORIGIN,
  SECRET_TOKEN,
  closeSyncSessionApps,
  request as syncRequest,
  start as startSyncSession,
} from '../../support/sync-session-http-harness.js';

const SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
).version as string;

const publicationConfig = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example',
  LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});

afterEach(() => {
  delete process.env.COLP_INSECURE_HTTP;
  delete process.env.KNOWN_EDITION;
  return closeSyncSessionApps();
});

function plaintextRequest(remoteAddress = '10.1.1.1') {
  return {
    raw: { socket: { encrypted: false, remoteAddress } },
    headers: { 'x-forwarded-proto': 'https' },
  } as Parameters<typeof classifySyncTransportEvidence>[0];
}

test('cookie name stays frozen unless insecure HTTP is opted in', () => {
  assert.throws(
    () => loadConfig(betterAuthTestEnv({ BETTER_AUTH_COOKIE_NAME: 'known_session' })),
    /BETTER_AUTH_COOKIE_NAME is frozen to __Host-known_session/u,
  );
  assert.throws(
    () => loadConfig(betterAuthTestEnv({
      COLP_INSECURE_HTTP: 'true',
      BETTER_AUTH_COOKIE_NAME: '__Host-other_session',
    })),
    /frozen to known_session when COLP_INSECURE_HTTP=true/u,
  );

  const tls = loadConfig(betterAuthTestEnv({
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
  }));
  assert.equal(tls.betterAuth.cookieName, BETTER_AUTH_COOKIE_NAME);
  assert.equal(buildBetterAuthConfig(tls.betterAuth)?.cookieName, BETTER_AUTH_COOKIE_NAME);

  process.env.COLP_INSECURE_HTTP = 'true';
  const insecure = loadConfig(betterAuthTestEnv({
    COLP_INSECURE_HTTP: 'true',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
    BETTER_AUTH_COOKIE_NAME: BETTER_AUTH_COOKIE_NAME,
  }));
  assert.equal(insecure.betterAuth.cookieName, INSECURE_HTTP_COOKIE_NAME);
  assert.equal(buildBetterAuthConfig(insecure.betterAuth)?.cookieName, INSECURE_HTTP_COOKIE_NAME);
  assert.equal(parseSessionCookieField('known_session=token.sig').kind, 'present');
  delete process.env.COLP_INSECURE_HTTP;
  assert.equal(parseSessionCookieField('known_session=token.sig').kind, 'absent');
  assert.equal(
    parseSessionCookieField('__Host-known_session=token.sig').kind,
    'present',
  );
});

test('tls mode rejects insecure-acknowledged evidence', () => {
  assert.equal(acceptSyncTransportEvidence('tls', 'insecure-acknowledged'), false);
  assert.equal(acceptSyncTransportEvidence('tls', 'tls'), true);
  assert.equal(acceptSyncTransportEvidence('tls', 'trusted-forwarded-https'), true);
  assert.equal(acceptSyncTransportEvidence('insecure-http', 'insecure-acknowledged'), true);

  const request = plaintextRequest();
  assert.equal(
    classifySyncTransportEvidence(request, { allowInsecureLoopback: false }),
    'insecure-acknowledged',
  );
  const security = createSyncTransportSecurity({ allowInsecureLoopback: false });
  assert.equal(security.isSecure(request), false);
  process.env.COLP_INSECURE_HTTP = 'true';
  assert.equal(security.isSecure(request), true);
  const tlsRequest = {
    raw: { socket: { encrypted: true, remoteAddress: '10.1.1.1' } },
    headers: {},
  } as Parameters<typeof classifySyncTransportEvidence>[0];
  delete process.env.COLP_INSECURE_HTTP;
  assert.equal(classifySyncTransportEvidence(tlsRequest, { allowInsecureLoopback: false }), 'tls');
  assert.equal(security.isSecure(tlsRequest), true);
});

test('sync session route accepts plaintext only in insecure HTTP mode', async () => {
  const tls = await startSyncSession({ allowInsecureLoopback: false });
  const rejected = await fetch(`${tls.origin}/private-entry/session-negotiation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SECRET_TOKEN}`,
      'Idempotency-Key': 'tls-rejects-insecure',
      Origin: EXTENSION_ORIGIN,
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
    },
    body: JSON.stringify(syncRequest()),
  });
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json() as { code: string }).code, 'authentication_required');
  assert.deepEqual(tls.calls, []);

  const ignoredCookie = await fetch(`${tls.origin}/private-entry/session-negotiation`, {
    method: 'POST',
    headers: {
      Cookie: 'known_session=baSessionToken.sig',
      'Idempotency-Key': 'tls-ignores-known-session',
      Origin: EXTENSION_ORIGIN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(syncRequest()),
  });
  assert.equal(ignoredCookie.status, 401);
  assert.deepEqual(tls.calls, []);

  process.env.COLP_INSECURE_HTTP = 'true';
  const insecure = await startSyncSession({ allowInsecureLoopback: false });
  const accepted = await fetch(`${insecure.origin}/private-entry/session-negotiation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SECRET_TOKEN}`,
      'Idempotency-Key': 'insecure-acknowledged',
      Origin: EXTENSION_ORIGIN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(syncRequest()),
  });
  assert.equal(accepted.status, 201);
  assert.deepEqual(insecure.calls, ['authenticate', 'issue']);

  const cookie = await fetch(`${insecure.origin}/private-entry/session-negotiation`, {
    method: 'POST',
    headers: {
      Cookie: 'known_session=baSessionToken.sig',
      'Idempotency-Key': 'insecure-cookie',
      Origin: EXTENSION_ORIGIN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(syncRequest()),
  });
  assert.equal(cookie.status, 201);
});

test('manifest advertises transport, cloud, and edition only for the self-hosted edition', async () => {
  const app = Fastify({ logger: false });
  registerPublicationManifestRoutes(app, publicationConfig.publication);
  const hosted = await app.inject({ method: 'GET', url: '/.well-known/collection-protocol' });
  assert.equal(hosted.statusCode, 200);
  assert.equal(hosted.json().mounts[0].features.transport, undefined);
  assert.equal(hosted.json().mounts[0].features.cloud, undefined);
  assert.equal(hosted.json().mounts[0].features.edition, undefined);

  process.env.KNOWN_EDITION = 'self-hosted';
  const httpsMode = await app.inject({ method: 'GET', url: '/.well-known/collection-protocol' });
  assert.equal(httpsMode.json().mounts[0].features.transport, 'https');
  assert.equal(httpsMode.json().mounts[0].features.cloud, false);
  assert.deepEqual(httpsMode.json().mounts[0].features.edition, {
    name: 'colp-server',
    version: SERVER_VERSION,
  });

  process.env.COLP_INSECURE_HTTP = 'true';
  const insecureMode = await app.inject({ method: 'GET', url: '/.well-known/collection-protocol' });
  assert.equal(insecureMode.json().mounts[0].features.transport, 'insecure-http');
  assert.equal(insecureMode.json().mounts[0].features.cloud, false);
  assert.equal(insecureMode.json().mounts[0].features.edition.version, SERVER_VERSION);
  await app.close();
});

test('startup in insecure HTTP mode logs the exact warning and skips HSTS', async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    const security = {
      ...loadConfig(testEnv()).httpSecurity,
      enableHsts: true,
    };
    const quiet = Fastify({ logger: false });
    installHttpSecurity(quiet, { security });
    quiet.get('/health', async () => ({ status: 'ok' }));
    const tls = await quiet.inject({ method: 'GET', url: '/health' });
    assert.equal(tls.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
    assert.equal(warnings.includes(INSECURE_HTTP_TRANSPORT_WARNING), false);
    await quiet.close();

    process.env.COLP_INSECURE_HTTP = 'true';
    const app = Fastify({ logger: false });
    installHttpSecurity(app, { security });
    app.get('/health', async () => ({ status: 'ok' }));
    const insecure = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(insecure.headers['strict-transport-security'], undefined);
    assert.equal(warnings.filter((line) => line === INSECURE_HTTP_TRANSPORT_WARNING).length, 1);
    await app.close();
  } finally {
    console.warn = original;
  }
});

test('capture-capabilities reports cloud features off for the self-hosted edition', () => {
  const runtime = createCaptureRuntime({} as never, {} as never, {
    enabled: true,
    tagsEnabled: true,
    autoTagsEnabled: true,
  });
  assert.equal(runtime.capabilities().automaticFolderAvailable, true);
  process.env.KNOWN_EDITION = 'self-hosted';
  const selfHosted = runtime.capabilities();
  assert.equal(selfHosted.automaticFolderAvailable, false);
  assert.equal(selfHosted.automaticTagsAvailable, false);
});
