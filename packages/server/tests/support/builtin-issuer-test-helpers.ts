/**
 * T-04 built-in issuer test helpers.
 *
 * Builds a `JwksProvider` from the real Better Auth `/api/v1/auth/jwks`
 * response and wraps `POST /oauth2/token` so later T-09 injects can exchange
 * a real authorization code. Unit tests may still mint JWTs with jose;
 * this module is for injects that need the issuer's live key set or token
 * endpoint.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { JSONWebKeySet } from 'jose';
import type { JwksProvider } from '../../src/modules/identity/index.js';

export const BUILTIN_ISSUER_TEST_AUDIENCE = 'https://app.example.test/collections/-/mcp' as const;
export const BUILTIN_ISSUER_TEST_SCOPES = 'mcp:read:public,mcp:read:own' as const;
export const BUILTIN_ISSUER_TEST_ISSUER = 'https://app.example.test/api/v1/auth' as const;
export const BUILTIN_ISSUER_TEST_JWKS_URI = `${BUILTIN_ISSUER_TEST_ISSUER}/jwks` as const;
export const BUILTIN_ISSUER_TEST_AS_METADATA_URL =
  'https://app.example.test/.well-known/oauth-authorization-server/api/v1/auth' as const;
export const BUILTIN_ISSUER_TEST_SCOPE_LIST = 'mcp:read:public mcp:read:own' as const;

export interface BuiltinIssuerInjectResponse {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly body: string;
  json(): unknown;
}

export interface BuiltinIssuerInjectApp {
  inject(opts: {
    readonly method: string;
    readonly url: string;
    readonly headers?: Record<string, string>;
    readonly payload?: string;
  }): Promise<BuiltinIssuerInjectResponse>;
}

export function builtinIssuerTestEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    BETTER_AUTH_OAUTH_ISSUER_ENABLED: 'true',
    MCP_OAUTH_AUDIENCE: BUILTIN_ISSUER_TEST_AUDIENCE,
    MCP_OAUTH_SCOPES: BUILTIN_ISSUER_TEST_SCOPES,
    ...overrides,
  };
}

/** Wrap a JWKS document as the verifier `JwksProvider` port (no HTTP). */
export function createJwksProviderFromKeySet(keySet: JSONWebKeySet): JwksProvider {
  return {
    async getKeySet() {
      return keySet;
    },
  };
}

/** GET the live Better Auth JWKS and return it as a `JwksProvider`. */
export async function createJwksProviderFromBetterAuthApp(
  app: BuiltinIssuerInjectApp,
  basePath = '/api/v1/auth',
): Promise<JwksProvider> {
  return createJwksProviderFromKeySet(await fetchBetterAuthJwks(app, basePath));
}

export async function fetchBetterAuthJwks(
  app: BuiltinIssuerInjectApp,
  basePath = '/api/v1/auth',
): Promise<JSONWebKeySet> {
  const response = await app.inject({ method: 'GET', url: `${basePath}/jwks` });
  if (response.statusCode !== 200) {
    throw new Error(`Better Auth JWKS request failed: ${response.statusCode} ${response.body}`);
  }
  const parsed = response.json() as JSONWebKeySet;
  if (!parsed || !Array.isArray(parsed.keys)) {
    throw new Error('Better Auth JWKS response is not a JSON Web Key Set');
  }
  return parsed;
}

/** Exchange an authorization code (or other grant) at the real `/oauth2/token`. */
export async function exchangeBuiltinIssuerToken(
  app: BuiltinIssuerInjectApp,
  body: Readonly<Record<string, string>>,
  basePath = '/api/v1/auth',
): Promise<BuiltinIssuerInjectResponse> {
  return app.inject({
    method: 'POST',
    url: `${basePath}/oauth2/token`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(body).toString(),
  });
}

export function createBuiltinIssuerPkce(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Official BA consent endpoint (session cookie + Origin, as the SPA posts). */
export async function submitBuiltinIssuerConsent(
  app: BuiltinIssuerInjectApp,
  body: Readonly<{
    readonly accept: boolean;
    readonly scope?: string;
    readonly oauth_query?: string;
    readonly claims?: string | Record<string, unknown>;
  }>,
  headers: Readonly<Record<string, string>>,
  basePath = '/api/v1/auth',
): Promise<BuiltinIssuerInjectResponse> {
  return app.inject({
    method: 'POST',
    url: `${basePath}/oauth2/consent`,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...headers,
    },
    payload: JSON.stringify(body),
  });
}
