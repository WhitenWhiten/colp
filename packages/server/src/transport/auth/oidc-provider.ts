/**
 * LEGACY OIDC/Logto provider — DEPRECATED SOURCE (legacy quarantine, Task F1).
 *
 * Status: retained as deprecated source/archive for audit and the legacy
 * migration window; source retention is NOT runtime enablement. This file is
 * not part of the Better Auth runtime — see
 * docs/development/known-backend/better-auth/better-auth-migration-development-plan.md
 * §12 Task F1 and the G1 ADR §11 legacy isolation rules.
 *
 * Ownership: Better Auth migration lane F. New code must not import this file
 * directly; use `src/infrastructure/auth/legacy-oidc-boundary.ts` as the
 * single controlled re-export exit. Runtime composition changes are owned by
 * Task F2 — keep all behavior unchanged.
 *
 * @deprecated Legacy OIDC/Logto provider; superseded by Better Auth
 *   (better-auth-migration-development-plan.md). Retained for archive only.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { OidcConfig } from '../../bootstrap/config.js';
import { settleBestEffort } from '../../infrastructure/async/best-effort.js';
import { createHardenedEgressFetch, HardenedEgressError } from '../../infrastructure/egress/index.js';
import { createCachingJwksClient } from '../../infrastructure/identity/index.js';
import {
  createIdTokenVerifier,
  IdTokenVerificationError,
  type IdTokenVerifier,
  type JwksProvider,
} from '../../modules/identity/index.js';

/**
 * @deprecated Legacy OIDC token claims (Task F1 quarantine).
 */
export interface OidcTokenClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string | readonly string[];
  readonly nonce: string;
  readonly email?: string | null;
  readonly emailVerified?: boolean;
  readonly name?: string;
  /** OIDC standard picture claim when present. */
  readonly picture?: string;
}

/**
 * @deprecated Legacy OIDC token exchange result (Task F1 quarantine).
 */
export interface OidcTokenExchangeResult {
  readonly claims: OidcTokenClaims;
}

/**
 * @deprecated Legacy OIDC provider port (Task F1 quarantine); superseded by
 *   the Better Auth runtime.
 */
export interface OidcProviderPort {
  buildAuthorizationUrl(input: {
    readonly state: string;
    readonly nonce: string;
    readonly codeChallenge: string;
    readonly codeChallengeMethod: 'S256';
  }): string;
  exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    /**
     * Exact nonce when recoverable (legacy plaintext rows).
     * Prefer matchesExpectedNonce for protected digest rows.
     */
    readonly expectedNonce?: string;
    /**
     * Constant-time digest (or other) comparison for protected transactions
     * where the raw nonce is not stored at rest.
     */
    readonly matchesExpectedNonce?: (tokenNonce: string) => boolean;
  }): Promise<OidcTokenExchangeResult>;
}

/**
 * Optional wiring for production HTTP OIDC and tests.
 * Callers must never supply token-embedded issuer/JWKS URLs — only config-backed endpoints.
 *
 * @deprecated Legacy OIDC provider options (Task F1 quarantine).
 */
export type OidcEgressFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const defaultOidcEgressFetch: OidcEgressFetch = createHardenedEgressFetch({ label: 'legacy OIDC' });

export interface CreateOidcProviderOptions {
  /** Inject for tests; defaults to hardened egress fetch (token endpoint + JWKS client). */
  readonly fetchImpl?: OidcEgressFetch;
  /** Pre-built verifier (tests). When omitted, built from config.jwksUri. */
  readonly idTokenVerifier?: IdTokenVerifier;
  /** Pre-built JWKS provider (tests). Ignored when idTokenVerifier is set. */
  readonly jwks?: JwksProvider;
  /** Clock for ID token verification (tests). */
  readonly now?: () => Date;
  /** Bounded token endpoint request deadline; test override only. */
  readonly tokenEndpointTimeoutMs?: number;
  /** Bounded token endpoint response body; test override only. */
  readonly tokenEndpointMaxResponseBytes?: number;
}

/**
 * @deprecated Legacy OIDC discovery verification options (Task F1 quarantine).
 */
export interface VerifyOidcDiscoveryOptions {
  readonly fetchImpl?: OidcEgressFetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const OIDC_HTTP_TIMEOUT_MS = 5_000;
const OIDC_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Fetch provider metadata at startup and require exact agreement with the
 * config-backed endpoint set. Metadata is evidence, never endpoint authority.
 *
 * @deprecated Legacy OIDC discovery (Task F1 quarantine); superseded by
 *   Better Auth.
 */
export async function verifyOidcDiscoveryMetadata(
  config: OidcConfig,
  options: VerifyOidcDiscoveryOptions = {},
): Promise<void> {
  if (config.allowTestProvider) return;

  const discoveryUrl = `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetchWithDeadline(
      options.fetchImpl ?? defaultOidcEgressFetch,
      discoveryUrl,
      { method: 'GET', headers: { accept: 'application/json' } },
      options.timeoutMs ?? OIDC_HTTP_TIMEOUT_MS,
    );
  } catch (error: unknown) {
    if (error instanceof HardenedEgressError) throw error;
    throw new Error('OIDC discovery request failed');
  }
  if (!response.ok) {
    throw new Error(`OIDC discovery request failed with status ${response.status}`);
  }

  let metadata: unknown;
  try {
    metadata = await readBoundedJson(
      response,
      options.maxResponseBytes ?? OIDC_MAX_RESPONSE_BYTES,
    );
  } catch {
    throw new Error('OIDC discovery response is invalid or exceeds the size limit');
  }
  if (!isJsonRecord(metadata)) {
    throw new Error('OIDC discovery response must be a JSON object');
  }

  const expected = {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    jwks_uri: config.jwksUri,
  } as const;
  for (const [field, value] of Object.entries(expected)) {
    if (typeof value !== 'string' || metadata[field] !== value) {
      throw new Error(`OIDC discovery ${field} does not match configured value`);
    }
  }
}

/**
 * @deprecated Legacy OIDC PKCE S256 challenge helper (Task F1 quarantine).
 */
export function pkceS256Challenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
}

/**
 * In-process OIDC test double for CI and local development.
 * Authorization codes are HMAC-signed payloads: known_test.<payload>.<sig>.
 * The HMAC secret must be injected explicitly (never defaulted) and this
 * provider must never be constructed outside NODE_ENV=test deployments.
 *
 * @deprecated Legacy OIDC test provider (Task F1 quarantine). Refused outside
 *   NODE_ENV=test; superseded by the Better Auth test seam (Task E1).
 */
export function createTestOidcProvider(config: OidcConfig, hmacSecret: string): OidcProviderPort {
  assertTestProviderEnvironment('OIDC test provider');
  if (!hmacSecret) {
    throw new Error('OIDC test provider requires a non-empty HMAC secret');
  }
  return {
    buildAuthorizationUrl(input) {
      const url = new URL(config.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', input.state);
      url.searchParams.set('nonce', input.nonce);
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      // Test helper: encode expected subject in authorize URL for demos (not used by callback).
      return url.toString();
    },
    async exchangeAuthorizationCode(input) {
      const claims = parseTestCode(
        input.code,
        hmacSecret,
        config,
        input.codeVerifier,
        input.expectedNonce,
        input.matchesExpectedNonce,
      );
      return { claims };
    },
  };
}

/**
 * Mint a test authorization code (`known_test.*`).
 *
 * @deprecated Legacy OIDC test code minting (Task F1 quarantine); refused
 *   outside NODE_ENV=test.
 */
export function mintTestAuthorizationCode(input: {
  readonly subject: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
  readonly picture?: string;
  readonly hmacSecret: string;
  readonly issuer: string;
  readonly audience: string;
}): string {
  assertTestProviderEnvironment('OIDC test code minting');
  if (!input.hmacSecret) {
    throw new Error('OIDC test code minting requires a non-empty HMAC secret');
  }
  const secret = input.hmacSecret;
  const payload = Buffer.from(JSON.stringify({
    sub: input.subject,
    nonce: input.nonce,
    email: input.email ?? null,
    email_verified: input.emailVerified ?? true,
    name: input.name ?? null,
    picture: input.picture ?? null,
    iss: input.issuer,
    aud: input.audience,
    cv: createHash('sha256').update(input.codeVerifier, 'utf8').digest('hex'),
  }), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `known_test.${payload}.${sig}`;
}

/**
 * Mint a test code from the authorize request's S256 challenge. This is only
 * used by the explicitly enabled in-process browser-test authorization route.
 *
 * @deprecated Legacy OIDC test code minting (Task F1 quarantine); refused
 *   outside NODE_ENV=test.
 */
export function mintTestAuthorizationCodeFromChallenge(input: {
  readonly subject: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
  readonly hmacSecret: string;
  readonly issuer: string;
  readonly audience: string;
}): string {
  assertTestProviderEnvironment('OIDC test code minting');
  if (!input.hmacSecret) {
    throw new Error('OIDC test code minting requires a non-empty HMAC secret');
  }
  const secret = input.hmacSecret;
  const payload = Buffer.from(JSON.stringify({
    sub: input.subject,
    nonce: input.nonce,
    email: input.email ?? null,
    email_verified: input.emailVerified ?? true,
    name: input.name ?? null,
    picture: null,
    iss: input.issuer,
    aud: input.audience,
    cc: input.codeChallenge,
  }), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `known_test.${payload}.${sig}`;
}

function parseTestCode(
  code: string,
  hmacSecret: string,
  config: OidcConfig,
  codeVerifier: string,
  expectedNonce: string | undefined,
  matchesExpectedNonce: ((tokenNonce: string) => boolean) | undefined,
): OidcTokenClaims {
  const parts = code.split('.');
  if (parts.length !== 3 || parts[0] !== 'known_test') {
    throw new OidcExchangeError('invalid_code');
  }
  const [, payload, sig] = parts;
  const expectedSig = createHmac('sha256', hmacSecret).update(payload!).digest('base64url');
  if (!safeEqual(sig!, expectedSig)) throw new OidcExchangeError('invalid_code');
  let body: {
    sub?: string;
    nonce?: string;
    email?: string | null;
    email_verified?: boolean;
    name?: string | null;
    picture?: string | null;
    iss?: string;
    aud?: string;
    cv?: string;
    cc?: string;
  };
  try {
    body = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as typeof body;
  } catch {
    throw new OidcExchangeError('invalid_code');
  }
  if (!body.sub || !body.nonce || !body.iss || !body.aud || (!body.cv && !body.cc)) {
    throw new OidcExchangeError('invalid_code');
  }
  if (body.iss !== config.issuer) throw new OidcExchangeError('invalid_issuer');
  if (body.aud !== config.audience && body.aud !== config.clientId) {
    throw new OidcExchangeError('invalid_audience');
  }
  if (!nonceMatches(body.nonce, expectedNonce, matchesExpectedNonce)) {
    throw new OidcExchangeError('invalid_nonce');
  }
  const cvHash = createHash('sha256').update(codeVerifier, 'utf8').digest('hex');
  const pkceMatches = body.cv
    ? safeEqual(body.cv, cvHash)
    : safeEqual(body.cc!, pkceS256Challenge(codeVerifier));
  if (!pkceMatches) throw new OidcExchangeError('invalid_pkce');
  return {
    issuer: body.iss,
    subject: body.sub,
    audience: body.aud,
    nonce: body.nonce,
    email: body.email ?? null,
    emailVerified: body.email_verified === true,
    name: body.name ?? undefined,
    picture: typeof body.picture === 'string' ? body.picture : undefined,
  };
}

function nonceMatches(
  tokenNonce: string,
  expectedNonce: string | undefined,
  matchesExpectedNonce: ((tokenNonce: string) => boolean) | undefined,
): boolean {
  if (matchesExpectedNonce) {
    try {
      return matchesExpectedNonce(tokenNonce) === true;
    } catch {
      return false;
    }
  }
  if (expectedNonce === undefined) return false;
  return safeEqual(tokenNonce, expectedNonce);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * F1 legacy quarantine gate: the in-process OIDC test provider and the
 * `known_test.*` code minting capability exist only for test deployments.
 * Any call outside NODE_ENV=test must fail closed, independent of the
 * loadConfig gate in `src/bootstrap/config.ts`.
 */
function assertTestProviderEnvironment(capability: string): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `${capability} is only allowed in NODE_ENV=test deployments (legacy OIDC test provider quarantine)`,
    );
  }
}

/**
 * @deprecated Legacy OIDC exchange error (Task F1 quarantine).
 */
export class OidcExchangeError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`OIDC exchange failed: ${reason}`);
    this.name = 'OidcExchangeError';
    this.reason = reason;
  }
}

/**
 * Production HTTP OIDC provider: exchanges the authorization code at the
 * configured token endpoint, then cryptographically verifies the ID token via
 * the standards-compliant verifier + config-backed JWKS (never token-supplied
 * discovery URLs). There is no decode-only success path for real JWTs.
 *
 * The in-process `known_test.*` code path is available only when
 * `config.allowTestProvider` is true and is never a fallback for real JWTs.
 *
 * @deprecated Legacy OIDC provider (Task F1 quarantine); superseded by
 *   Better Auth. Runtime composition changes are owned by Task F2.
 */
export function createOidcProvider(
  config: OidcConfig,
  options: CreateOidcProviderOptions = {},
): OidcProviderPort {
  if (!config.jwksUri && !config.allowTestProvider) {
    throw new Error('OIDC jwksUri is required when the test OIDC provider is disabled');
  }
  // F1 code-level gate (defense in depth over the loadConfig gate): the
  // in-process `known_test.*` test provider must never be constructible
  // outside NODE_ENV=test, even when a caller passes a test-provider config.
  if (config.allowTestProvider) {
    assertTestProviderEnvironment('OIDC test provider');
  }
  // FIX-L-001: the explicit client auth mode decides the token request; a
  // mode/secret conflict must never silently pick public or confidential.
  if (config.clientAuthMode === 'none' && config.clientSecret !== '') {
    throw new Error('OIDC client auth mode none forbids a client secret');
  }
  if (config.clientAuthMode === 'client_secret_post' && config.clientSecret === '') {
    throw new Error('OIDC client auth mode client_secret_post requires a non-empty client secret');
  }

  const fetchImpl = options.fetchImpl ?? defaultOidcEgressFetch;
  const test = config.allowTestProvider
    ? createTestOidcProvider(config, config.testProviderHmacSecret)
    : null;
  const verifier = resolveIdTokenVerifier(config, options, fetchImpl);

  return {
    buildAuthorizationUrl(input) {
      const url = new URL(config.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', input.state);
      url.searchParams.set('nonce', input.nonce);
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },
    async exchangeAuthorizationCode(input) {
      if (test && input.code.startsWith('known_test.')) {
        return test.exchangeAuthorizationCode(input);
      }

      if (!verifier) {
        // Test-only mode without JWKS: real JWT exchange is unavailable.
        throw new OidcExchangeError('jwks_required');
      }

      // Network token exchange — never call while holding a DB lock.
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        code_verifier: input.codeVerifier,
      });
      // FIX-L-001: only the explicit client_secret_post mode authenticates the
      // client with the secret; `none` stays a pure public-client + PKCE request.
      if (config.clientAuthMode === 'client_secret_post') {
        body.set('client_secret', config.clientSecret);
      }

      let response: Response;
      try {
        response = await fetchWithDeadline(fetchImpl, config.tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        }, options.tokenEndpointTimeoutMs ?? OIDC_HTTP_TIMEOUT_MS);
      } catch (error: unknown) {
        if (error instanceof HardenedEgressError) throw error;
        throw new OidcExchangeError('token_endpoint_error');
      }
      if (!response.ok) {
        // Map only stable OAuth error codes; never surface provider text/secrets.
        throw await mapTokenEndpointFailure(
          response,
          options.tokenEndpointMaxResponseBytes ?? OIDC_MAX_RESPONSE_BYTES,
        );
      }
      let json: unknown;
      try {
        json = await readBoundedJson(
          response,
          options.tokenEndpointMaxResponseBytes ?? OIDC_MAX_RESPONSE_BYTES,
        );
      } catch {
        throw new OidcExchangeError('token_endpoint_error');
      }
      if (!isJsonRecord(json)) {
        throw new OidcExchangeError('token_endpoint_error');
      }
      if (!json.id_token || typeof json.id_token !== 'string') {
        throw new OidcExchangeError('missing_id_token');
      }

      let verified;
      try {
        // When only a digest matcher is available, verify signature/claims without
        // exact nonce equality, then apply matchesExpectedNonce (keyed digest path).
        verified = await verifier.verify({
          token: json.id_token,
          expectedIssuer: config.issuer,
          expectedAudience: config.audience,
          clientId: config.clientId,
          expectedNonce: input.matchesExpectedNonce ? undefined : input.expectedNonce,
          now: options.now?.(),
        });
      } catch (error: unknown) {
        throw mapIdTokenVerificationError(error);
      }

      const tokenNonce = verified.nonce ?? '';
      if (!nonceMatches(tokenNonce, input.expectedNonce, input.matchesExpectedNonce)) {
        throw new OidcExchangeError('invalid_nonce');
      }

      return {
        claims: {
          issuer: verified.issuer,
          subject: verified.subject,
          audience: verified.audience,
          nonce: verified.nonce ?? input.expectedNonce ?? tokenNonce,
          email: verified.email ?? null,
          emailVerified: verified.emailVerified,
          name: verified.name,
          picture: verified.picture,
        },
      };
    },
  };
}

function resolveIdTokenVerifier(
  config: OidcConfig,
  options: CreateOidcProviderOptions,
  fetchImpl: OidcEgressFetch,
): IdTokenVerifier | null {
  if (options.idTokenVerifier) return options.idTokenVerifier;
  if (options.jwks) return createIdTokenVerifier({ jwks: options.jwks });
  if (!config.jwksUri) return null;
  const jwks = createCachingJwksClient({
    jwksUri: config.jwksUri,
    fetchImpl,
  });
  return createIdTokenVerifier({ jwks });
}

/**
 * Maps non-OK token-endpoint responses to stable exchange reasons.
 * Body text / error_description must never escape into redirects or client-visible output.
 *
 * @deprecated Legacy OIDC token-endpoint failure mapping (Task F1 quarantine).
 */
export async function mapTokenEndpointFailure(
  response: Response,
  maxResponseBytes = OIDC_MAX_RESPONSE_BYTES,
): Promise<OidcExchangeError> {
  try {
    const json = await readBoundedJson(response, maxResponseBytes);
    if (isJsonRecord(json) && typeof json.error === 'string') {
      if (json.error === 'invalid_grant') {
        return new OidcExchangeError('invalid_grant');
      }
      if (json.error === 'invalid_client' || json.error === 'unauthorized_client') {
        return new OidcExchangeError('token_endpoint_error');
      }
    }
  } catch {
    // Non-JSON or empty body — treat as generic endpoint failure.
  }
  return new OidcExchangeError('token_endpoint_error');
}

async function fetchWithDeadline(
  fetchImpl: OidcEgressFetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('response body exceeds limit');
  }
  if (!response.body) throw new Error('response body is empty');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await settleBestEffort(reader.cancel(),
          'the oversized OIDC response is authoritative and stream teardown is secondary');
        throw new Error('response body exceeds limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Maps domain verification failures onto transport exchange errors so callback
 * logging keeps a stable reason vocabulary without leaking verification internals.
 *
 * @deprecated Legacy OIDC verification-error mapping (Task F1 quarantine).
 */
export function mapIdTokenVerificationError(error: unknown): OidcExchangeError {
  if (error instanceof OidcExchangeError) return error;
  if (error instanceof IdTokenVerificationError) {
    switch (error.reason) {
      case 'wrong_issuer':
        return new OidcExchangeError('invalid_issuer');
      case 'wrong_audience':
        return new OidcExchangeError('invalid_audience');
      case 'wrong_nonce':
        return new OidcExchangeError('invalid_nonce');
      case 'missing_subject':
        return new OidcExchangeError('missing_subject');
      case 'invalid_token':
        return new OidcExchangeError('invalid_id_token');
      default:
        return new OidcExchangeError(error.reason);
    }
  }
  if (error instanceof Error) {
    return new OidcExchangeError('id_token_verification_failed');
  }
  return new OidcExchangeError('id_token_verification_failed');
}
