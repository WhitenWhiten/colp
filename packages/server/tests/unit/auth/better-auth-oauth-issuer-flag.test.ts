/**
 * T-04 built-in issuer surface (flag on).
 *
 * Endpoint existence is printRoutes + real inject only (never a source grep).
 * DCR is on: POST /oauth2/register is mounted (not 404); GET is 405.
 * /oauth2/token remains the 200/400 positive control. jwt plugin GET /token
 * and set-auth-jwt stay absent (OAuth Provider Mode).
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  BETTER_AUTH_OAUTH_ISSUER_GRANT_TYPES,
  buildBetterAuthOptions,
  createBetterAuthRuntime,
  type BetterAuthRuntimeConfig,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { BETTER_AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS, buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  BUILTIN_ISSUER_TEST_AUDIENCE,
  builtinIssuerTestEnv,
  createJwksProviderFromBetterAuthApp,
  exchangeBuiltinIssuerToken,
} from '../../support/builtin-issuer-test-helpers.js';
import {
  openBetterAuthPostgres,
  type BetterAuthPostgresFixture,
} from '../../support/better-auth-postgres.js';

const TRUSTED_ORIGIN = 'https://app.example.test';
const BASE_PATH = '/api/v1/auth';

function issuerOnEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: TRUSTED_ORIGIN,
    ALLOWED_ORIGINS: TRUSTED_ORIGIN,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef1',
    BETTER_AUTH_BODY_LIMIT_BYTES: '1024',
    ...builtinIssuerTestEnv(),
    ...overrides,
  };
}

function issuerRuntimeConfig(built: NonNullable<ReturnType<typeof buildBetterAuthConfig>>): BetterAuthRuntimeConfig {
  return built;
}

function pluginIds(options: ReturnType<typeof buildBetterAuthOptions>): string[] {
  return (options.plugins ?? []).map((plugin) => plugin.id);
}

function inertDatabase(): never {
  return {} as never;
}

test('issuer-on options pin jwt RS256 OAuth Provider Mode, mcp consent, and cimd (no second oauthProvider)', () => {
  const config = loadConfig(issuerOnEnv());
  const built = buildBetterAuthConfig(config.betterAuth);
  assert.ok(built);
  assert.equal(built.oauthIssuer?.accessTokenExpiresInSeconds, BETTER_AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS);
  assert.equal(built.oauthIssuer?.resource, BUILTIN_ISSUER_TEST_AUDIENCE);
  const options = buildBetterAuthOptions({
    enabled: true,
    config: issuerRuntimeConfig(built),
    database: { db: inertDatabase(), type: 'postgres', transaction: true },
  });
  const ids = pluginIds(options);
  assert.equal(ids.includes('jwt'), true);
  assert.equal(ids.includes('oauth-provider'), true);
  assert.equal(ids.includes('cimd'), true);
  assert.equal(ids.includes('known-opaque-client-id-guidance'), true, 'MCP-U-05 guidance plugin must ride with cimd');
  assert.equal(ids.includes('known-oauth-consent-transaction'), true, 'consent-transaction plugin must ride with the issuer');
  assert.equal(ids.filter((id) => id === 'oauth-provider').length, 1, 'mcp() is the provider; do not also register oauthProvider()');
  const jwtPlugin = (options.plugins ?? []).find((plugin) => plugin.id === 'jwt') as {
    readonly options?: {
      readonly disableSettingJwtHeader?: boolean;
      readonly disabledPaths?: readonly string[];
      readonly jwks?: { readonly keyPairConfig?: { readonly alg?: string } };
    };
  } | undefined;
  assert.equal(jwtPlugin?.options?.disableSettingJwtHeader, true);
  assert.deepEqual(jwtPlugin?.options?.disabledPaths, ['/token']);
  assert.equal(jwtPlugin?.options?.jwks?.keyPairConfig?.alg, 'RS256');
  const mcpPlugin = (options.plugins ?? []).find((plugin) => plugin.id === 'oauth-provider') as {
    readonly options?: {
      readonly loginPage?: string;
      readonly consentPage?: string;
      readonly resources?: ReadonlyArray<string | { readonly identifier?: string }>;
      readonly enforcePerClientResources?: boolean;
      readonly accessTokenExpiresIn?: number;
      readonly allowDynamicClientRegistration?: boolean;
      readonly allowUnauthenticatedClientRegistration?: boolean;
      readonly grantTypes?: readonly string[];
      readonly scopes?: readonly string[];
    };
  } | undefined;
  assert.equal(mcpPlugin?.options?.loginPage, '/login');
  assert.equal(mcpPlugin?.options?.consentPage, '/consent');
  assert.deepEqual(mcpPlugin?.options?.grantTypes, [...BETTER_AUTH_OAUTH_ISSUER_GRANT_TYPES]);
  // mcp() strips `resource` and appends it onto oauthProvider `resources`.
  const resourceIds = (mcpPlugin?.options?.resources ?? []).map((item) => (
    typeof item === 'string' ? item : item.identifier
  ));
  assert.equal(resourceIds.includes(BUILTIN_ISSUER_TEST_AUDIENCE), true);
  assert.equal(
    resourceIds.includes(`${new URL(BUILTIN_ISSUER_TEST_AUDIENCE).origin}/collections/-/mcp-compat`),
    true,
  );
  assert.equal(mcpPlugin?.options?.enforcePerClientResources, false);
  assert.equal(mcpPlugin?.options?.accessTokenExpiresIn, BETTER_AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS);
  assert.equal(BETTER_AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS, 3_600);
  assert.deepEqual(mcpPlugin?.options?.scopes, [
    'mcp:read:public',
    'mcp:read:own',
    'product:read',
    'product:write',
    'offline_access',
  ]);
  assert.equal(mcpPlugin?.options?.allowDynamicClientRegistration, true);
  assert.equal(mcpPlugin?.options?.allowUnauthenticatedClientRegistration, true);
});

let fixture: BetterAuthPostgresFixture;
let app: ReturnType<typeof buildApiApp>;

beforeAll(async () => {
  const config = loadConfig(issuerOnEnv());
  const built = buildBetterAuthConfig(config.betterAuth);
  assert.ok(built, 'issuer-on config must produce Better Auth settings');
  fixture = await openBetterAuthPostgres(built);
  const runtime = createBetterAuthRuntime({
    enabled: true,
    config: built,
    database: { db: fixture.db, type: 'postgres', transaction: true },
  });
  assert.ok(runtime, 'issuer-on runtime must construct');
  app = buildApiApp({ config, betterAuthRuntime: runtime });
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await fixture?.close();
});

test('issuer on printRoutes + inject expose authorize/token/userinfo/jwks/consent/public-client/register', async () => {
  const routes = app.printRoutes({ commonPrefix: false });
  assert.match(routes, /authorize/u);
  assert.match(routes, /token/u);
  assert.match(routes, /userinfo/u);
  assert.match(routes, /jwks/u);
  assert.match(routes, /consent/u);
  assert.match(routes, /public-client/u);
  // Fastify printRoutes tree-compresses GET /oauth2/consent-transaction as
  // `-transaction` under `/oauth2/consent` (same as email-otp's `-otp`).
  assert.match(routes, /-transaction \(GET, HEAD\)/u);
  assert.match(routes, /oauth2\/register/u);
  assert.doesNotMatch(routes, /\/api\/v1\/auth\/token \(/u);

  const authorize = await app.inject({ method: 'GET', url: `${BASE_PATH}/oauth2/authorize` });
  assert.notEqual(authorize.statusCode, 404, 'GET /oauth2/authorize must be mounted');
  const authorizePost = await app.inject({
    method: 'POST',
    url: `${BASE_PATH}/oauth2/authorize`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: '',
  });
  assert.notEqual(authorizePost.statusCode, 404, 'POST /oauth2/authorize must be mounted');

  const token = await exchangeBuiltinIssuerToken(app, { grant_type: 'authorization_code' });
  assert.notEqual(token.statusCode, 404, 'POST /oauth2/token must be mounted');
  assert.ok(token.statusCode === 200 || token.statusCode === 400, `token positive control must be 200/400, got ${token.statusCode}`);

  const userinfo = await app.inject({ method: 'GET', url: `${BASE_PATH}/oauth2/userinfo` });
  assert.notEqual(userinfo.statusCode, 404, 'GET /oauth2/userinfo must be mounted');
  const userinfoPost = await app.inject({
    method: 'POST',
    url: `${BASE_PATH}/oauth2/userinfo`,
    headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
    payload: JSON.stringify({}),
  });
  assert.notEqual(userinfoPost.statusCode, 404, 'POST /oauth2/userinfo must be mounted');

  const jwks = await app.inject({ method: 'GET', url: `${BASE_PATH}/jwks` });
  assert.equal(jwks.statusCode, 200, 'GET /jwks must serve the issuer key set');
  const keySet = jwks.json() as { keys?: unknown[] };
  assert.ok(Array.isArray(keySet.keys) && keySet.keys.length > 0, 'JWKS must include at least one key');
  const provider = await createJwksProviderFromBetterAuthApp(app);
  const fromProvider = await provider.getKeySet();
  assert.equal(fromProvider.keys.length, keySet.keys.length);

  const consent = await app.inject({
    method: 'POST',
    url: `${BASE_PATH}/oauth2/consent`,
    headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
    payload: JSON.stringify({ accept: false }),
  });
  assert.notEqual(consent.statusCode, 404, 'POST /oauth2/consent must be mounted');

  const publicClient = await app.inject({ method: 'GET', url: `${BASE_PATH}/oauth2/public-client?client_id=missing` });
  assert.notEqual(publicClient.statusCode, 404, 'GET /oauth2/public-client must be mounted');

  const consentTransaction = await app.inject({
    method: 'GET',
    url: `${BASE_PATH}/oauth2/consent-transaction?oauth_query=missing`,
  });
  assert.notEqual(consentTransaction.statusCode, 404, 'GET /oauth2/consent-transaction must be mounted');
});

test('an opaque client_id gets CIMD guidance instead of a misleading error (MCP-U-05)', async () => {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: 'cursor',
    redirect_uri: 'http://127.0.0.1:8943/callback',
    code_challenge: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    code_challenge_method: 'S256',
    scope: 'openid',
    state: 'mcp-u-05',
  });
  const response = await app.inject({
    method: 'GET',
    url: `${BASE_PATH}/oauth2/authorize?${query.toString()}`,
  });
  const wire = `${response.headers.location ?? ''} ${response.body}`;
  assert.equal(wire.includes('code='), false, `opaque client_id must not issue a code: ${wire}`);
  assert.match(wire, /Client(?:%20|\+| )ID(?:%20|\+| )Metadata(?:%20|\+| )Document/iu, `expected CIMD guidance, got ${response.statusCode} ${wire}`);
  assert.match(wire, /oauth2(?:%2F|\/)register/iu, `expected DCR register guidance, got ${response.statusCode} ${wire}`);
  assert.match(wire, /know-n\.com(?:%2F|\/)mcp/iu, 'the guidance must link the /mcp walkthrough');
  assert.doesNotMatch(wire, /client_id(?:%20|\+| )is(?:%20|\+| )required/iu, 'the misleading message must be gone');
});

test('POST /oauth2/register is mounted; GET is 405; token remains the 200/400 control', async () => {
  const token = await exchangeBuiltinIssuerToken(app, { grant_type: 'authorization_code' });
  assert.notEqual(token.statusCode, 404);
  assert.ok(token.statusCode === 200 || token.statusCode === 400);

  const getRegister = await app.inject({
    method: 'GET',
    url: `${BASE_PATH}/oauth2/register`,
  });
  assert.equal(getRegister.statusCode, 405, 'GET /oauth2/register must be 405 (RFC 7591 is POST-only)');
  assert.match(String(getRegister.headers.allow ?? ''), /POST/u);

  const register = await app.inject({
    method: 'POST',
    url: `${BASE_PATH}/oauth2/register`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      client_name: 'dcr-flag-client',
      redirect_uris: ['http://127.0.0.1:8943/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      application_type: 'native',
    }),
  });
  assert.notEqual(register.statusCode, 404, `POST /oauth2/register must be mounted: ${register.body}`);
  assert.ok(
    register.statusCode === 200 || register.statusCode === 201,
    `DCR must succeed, got ${register.statusCode} ${register.body}`,
  );
  const body = register.json() as { client_id?: unknown };
  assert.equal(typeof body.client_id, 'string');
  assert.ok(String(body.client_id).length > 0);

  const backchannel = await app.inject({
    method: 'POST',
    url: `${BASE_PATH}/oauth2/register`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      client_name: 'dcr-backchannel-client',
      redirect_uris: ['http://127.0.0.1:8943/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      application_type: 'native',
      backchannel_logout_uri: 'https://rp.example.test/logout',
      backchannel_logout_session_required: true,
    }),
  });
  assert.equal(backchannel.statusCode, 400, 'backchannel logout callbacks must be rejected');
  assert.match(backchannel.body, /backchannel_logout_disabled/u);
});

test('testFetchClientMetadataResource is refused when NODE_ENV is not test', () => {
  const config = loadConfig(issuerOnEnv());
  const built = buildBetterAuthConfig(config.betterAuth);
  assert.ok(built);
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(
      () => buildBetterAuthOptions({
        enabled: true,
        config: issuerRuntimeConfig(built),
        database: { db: inertDatabase(), type: 'postgres', transaction: true },
        testFetchClientMetadataResource: async () => new Response('{}'),
      }),
      (error: unknown) => error instanceof Error
        && error.message.includes('testFetchClientMetadataResource')
        && error.message.includes('NODE_ENV=test'),
    );
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('jwt plugin GET /token is absent and get-session does not set set-auth-jwt', async () => {
  const token = await app.inject({ method: 'GET', url: `${BASE_PATH}/token` });
  assert.equal(token.statusCode, 404, 'jwt plugin /token must not be mounted');

  const session = await app.inject({ method: 'GET', url: `${BASE_PATH}/get-session` });
  assert.equal(session.statusCode, 200);
  const headerNames = Object.keys(session.headers).map((name) => name.toLowerCase());
  assert.equal(headerNames.includes('set-auth-jwt'), false, 'disableSettingJwtHeader must keep set-auth-jwt off the wire');
});
