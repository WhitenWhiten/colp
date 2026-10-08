import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createCachingJwksClient,
  createPostgresOidcLoginTransactionRepository,
  createTestOidcProvider,
  createOidcProvider,
  mintTestAuthorizationCode,
  mintTestAuthorizationCodeFromChallenge,
  mapIdTokenVerificationError,
  mapTokenEndpointFailure,
  pkceS256Challenge,
  verifyOidcDiscoveryMetadata,
  OidcExchangeError,
  type OidcProviderPort,
} from '../../../src/infrastructure/auth/legacy-oidc-boundary.js';
// Direct legacy-source imports must keep working (deprecated symbols remain
// compilable and importable) — the boundary re-exports the very same symbols.
import {
  createOidcProvider as directCreateOidcProvider,
  createTestOidcProvider as directCreateTestOidcProvider,
  mintTestAuthorizationCode as directMintTestAuthorizationCode,
  OidcExchangeError as DirectOidcExchangeError,
} from '../../../src/transport/auth/oidc-provider.js';

const checkImportsScript = fileURLToPath(
  new URL('../../../scripts/check-import-boundaries.mjs', import.meta.url),
);

const testEnvironment = {
  DATABASE_URL: 'postgres://localhost/known_test',
  NODE_ENV: 'test',
  PRODUCT_ORIGIN: 'http://localhost:5190',
  OIDC_ISSUER: 'http://localhost:3310/__test__/oidc',
  OIDC_CLIENT_ID: 'known-web-real-stack',
  OIDC_AUDIENCE: 'known-web-real-stack',
  OIDC_REDIRECT_URI: 'http://localhost:5190/api/v1/auth/oidc/callback',
  OIDC_AUTHORIZATION_ENDPOINT: 'http://localhost:3310/__test__/oidc/authorize',
  OIDC_TOKEN_ENDPOINT: 'http://localhost:3310/__test__/oidc/token',
  // Public client + PKCE (no secret): explicit mode must stay legal.
  OIDC_CLIENT_AUTH_MODE: 'none',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
} as const;

function withNodeEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    fn();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

async function withNodeEnvAsync(value: string | undefined, fn: () => void | Promise<void>): Promise<void> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    await fn();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

function createFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-oidc-boundary-'));
  for (const [relative, content] of Object.entries(files)) {
    const path = resolve(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return dir;
}

function runCheckImports(fixtureDir: string): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [checkImportsScript, '--root', fixtureDir], {
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('legacy OIDC deprecated symbols remain importable and the boundary re-exports the same symbols', () => {
  // Deprecated source retention: every legacy symbol still resolves at runtime.
  assert.equal(typeof verifyOidcDiscoveryMetadata, 'function');
  assert.equal(typeof pkceS256Challenge, 'function');
  assert.equal(typeof createTestOidcProvider, 'function');
  assert.equal(typeof mintTestAuthorizationCode, 'function');
  assert.equal(typeof mintTestAuthorizationCodeFromChallenge, 'function');
  assert.equal(typeof mapTokenEndpointFailure, 'function');
  assert.equal(typeof mapIdTokenVerificationError, 'function');
  assert.equal(typeof createCachingJwksClient, 'function');
  assert.equal(typeof createPostgresOidcLoginTransactionRepository, 'function');
  assert.equal(typeof createOidcProvider, 'function');
  assert.equal(typeof OidcExchangeError, 'function'); // class declaration

  // The boundary is a real re-export exit: identical function identities.
  assert.equal(createOidcProvider, directCreateOidcProvider);
  assert.equal(createTestOidcProvider, directCreateTestOidcProvider);
  assert.equal(mintTestAuthorizationCode, directMintTestAuthorizationCode);
  assert.equal(OidcExchangeError, DirectOidcExchangeError);

  // Type-only exports resolve through the boundary (compile-time proof that
  // the re-export list is real; this file type-checks against it).
  const typedPort: OidcProviderPort | undefined = undefined;
  assert.equal(typedPort, undefined);
});

test('legacy OIDC test provider is refused outside NODE_ENV=test', () => {
  const config = loadConfig({
    ...testEnvironment,
    KNOWN_ENABLE_E2E_TEST_IDENTITY: 'true',
  });
  assert.equal(config.oidc.allowTestProvider, true);

  withNodeEnv('production', () => {
    // known_test.* code minting must refuse to run in production.
    assert.throws(
      () => mintTestAuthorizationCode({
        subject: 'subject-1',
        nonce: 'nonce-1',
        codeVerifier: 'code-verifier-1',
        hmacSecret: config.oidc.testProviderHmacSecret,
        issuer: config.oidc.issuer,
        audience: config.oidc.audience,
      }),
      /NODE_ENV=test/,
    );
    assert.throws(
      () => mintTestAuthorizationCodeFromChallenge({
        subject: 'subject-1',
        nonce: 'nonce-1',
        codeChallenge: 'a'.repeat(43),
        hmacSecret: config.oidc.testProviderHmacSecret,
        issuer: config.oidc.issuer,
        audience: config.oidc.audience,
      }),
      /NODE_ENV=test/,
    );
    // The in-process test provider itself must refuse construction.
    assert.throws(
      () => createTestOidcProvider(config.oidc, config.oidc.testProviderHmacSecret),
      /NODE_ENV=test/,
    );
    // A provider built with allowTestProvider must refuse construction too
    // (code-level gate in addition to the loadConfig gate).
    assert.throws(() => createOidcProvider(config.oidc), /NODE_ENV=test/);
  });

  withNodeEnv('development', () => {
    assert.throws(
      () => createTestOidcProvider(config.oidc, config.oidc.testProviderHmacSecret),
      /NODE_ENV=test/,
    );
  });
});

test('legacy OIDC test provider and known_test.* minting work under NODE_ENV=test', async () => {
  const config = loadConfig({
    ...testEnvironment,
    KNOWN_ENABLE_E2E_TEST_IDENTITY: 'true',
  });

  await withNodeEnvAsync('test', async () => {
    const provider = createTestOidcProvider(config.oidc, config.oidc.testProviderHmacSecret);
    const code = mintTestAuthorizationCode({
      subject: 'subject-1',
      nonce: 'nonce-1',
      codeVerifier: 'code-verifier-1',
      email: 'phase1-real-stack@example.test',
      emailVerified: true,
      name: 'Phase 1 Real Stack',
      hmacSecret: config.oidc.testProviderHmacSecret,
      issuer: config.oidc.issuer,
      audience: config.oidc.audience,
    });
    assert.match(code, /^known_test\./);
    const exchanged = await provider.exchangeAuthorizationCode({
      code,
      codeVerifier: 'code-verifier-1',
      expectedNonce: 'nonce-1',
    });
    assert.equal(exchanged.claims.subject, 'subject-1');
    assert.equal(exchanged.claims.issuer, config.oidc.issuer);

    // Provider construction with allowTestProvider stays legal under test env.
    const composed = createOidcProvider(config.oidc);
    assert.equal(typeof composed.buildAuthorizationUrl, 'function');
  });
});

test('check:imports rejects direct legacy OIDC provider imports from a module layer', () => {
  const fixture = createFixture({
    'transport/auth/oidc-provider.ts': 'export function createOidcProvider(): void {}\n',
    'modules/auth/better-auth-config.ts':
      "import { createOidcProvider } from '../../transport/auth/oidc-provider.js';\n"
      + 'export const legacyProvider = createOidcProvider;\n',
  });
  try {
    const result = runCheckImports(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /violates dependency graph/);
    assert.match(result.stderr, /modules\/auth\/better-auth-config\.ts/);
    assert.match(result.stderr, /transport\/auth\/oidc-provider\.ts/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('check:imports accepts the legacy OIDC boundary re-export layout', () => {
  const fixture = createFixture({
    'transport/auth/oidc-provider.ts': 'export function createOidcProvider(): void {}\n',
    'infrastructure/identity/index.ts': 'export function createCachingJwksClient(): void {}\n',
    'modules/identity/index.ts': 'export function ensureAccountFromOidcIdentity(): void {}\n',
    // Relative paths mirror the real boundary layout (infrastructure/auth ->
    // transport + identity), so every re-export edge is genuinely resolved
    // and checked against the allowed()/edge registrations.
    'infrastructure/auth/legacy-oidc-boundary.ts':
      "export { createOidcProvider } from '../../transport/auth/oidc-provider.js';\n"
      + "export { createCachingJwksClient } from '../identity/index.js';\n"
      + "export { ensureAccountFromOidcIdentity } from '../../modules/identity/index.js';\n",
  });
  try {
    const result = runCheckImports(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /import boundaries: ok/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('check:imports keeps the legacy OIDC boundary exit file-precise (no second auth exit)', () => {
  const fixture = createFixture({
    'transport/auth/oidc-provider.ts': 'export function createOidcProvider(): void {}\n',
    'infrastructure/auth/legacy-oidc-boundary.ts':
      "export { createOidcProvider } from '../transport/auth/oidc-provider.js';\n",
    'infrastructure/auth/other-legacy-exit.ts':
      "import { createOidcProvider } from '../../transport/auth/oidc-provider.js';\n"
      + 'export const bypass = createOidcProvider;\n',
  });
  try {
    const result = runCheckImports(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /infrastructure\/auth\/other-legacy-exit\.ts/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
