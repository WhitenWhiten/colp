import { createHash, randomBytes } from 'node:crypto';
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';

export const EXTENSION_AUTH_FLOW = 'authorization_code_pkce' as const;
export const EXTENSION_AUTH_ALLOWED_ALGORITHMS = ['RS256', 'ES256', 'PS256', 'ES384'] as const;
const EXTENSION_AUTH_CONFIG_KEYS = new Set([
  'issuer', 'clientId', 'audience', 'authorizationEndpoint', 'tokenEndpoint',
  'jwksUri', 'redirectUri', 'extensionIds',
  'redirectOrigins', 'scopes', 'algorithms', 'clockSkewSeconds', 'evidenceTtlSeconds',
]);

export type ExtensionAuthFailureReason =
  | 'invalid_config'
  | 'client_secret_forbidden'
  | 'redirect_not_allowed'
  | 'transaction_not_found'
  | 'transaction_consumed'
  | 'state_mismatch'
  | 'redirect_mismatch'
  | 'invalid_callback'
  | 'login_cancelled'
  | 'invalid_authorization_header'
  | 'invalid_token'
  | 'disallowed_algorithm'
  | 'invalid_signature'
  | 'unknown_kid'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'wrong_client'
  | 'wrong_nonce'
  | 'missing_scope'
  | 'expired'
  | 'revoked'
  | 'device_code_expired'
  | 'device_authorization_denied'
  | 'device_poll_failed';

export class ExtensionAuthError extends Error {
  readonly reason: ExtensionAuthFailureReason;

  constructor(reason: ExtensionAuthFailureReason, message?: string) {
    super(message ?? `Extension authentication failed: ${reason}`);
    this.name = 'ExtensionAuthError';
    this.reason = reason;
  }
}

export type ExtensionAuthAlgorithm = (typeof EXTENSION_AUTH_ALLOWED_ALGORITHMS)[number];

export interface ExtensionAuthConfig {
  readonly flow: typeof EXTENSION_AUTH_FLOW;
  readonly issuer: string;
  readonly clientId: string;
  readonly audience: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly redirectUri: string;
  readonly allowedExtensionIds: readonly string[];
  readonly allowedRedirectOrigins: readonly string[];
  readonly scopes: readonly string[];
  readonly allowedAlgorithms: readonly ExtensionAuthAlgorithm[];
  readonly clockSkewSeconds: number;
  readonly evidenceTtlSeconds: number;
}

interface RawExtensionAuthConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly audience: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly redirectUri: string;
  readonly extensionIds: readonly string[];
  readonly redirectOrigins: readonly string[];
  readonly scopes: readonly string[];
  readonly algorithms: readonly string[];
  readonly clockSkewSeconds: number;
  readonly evidenceTtlSeconds: number;
}

export function parseExtensionAuthConfig(input: unknown): ExtensionAuthConfig {
  if (!isRecord(input)) throw new ExtensionAuthError('invalid_config', 'Extension auth config must be an object');
  if (hasNonEmpty(input.clientSecret) || hasNonEmpty(input.client_secret)) {
    throw new ExtensionAuthError('client_secret_forbidden', 'A browser extension is a public client');
  }
  const unknownKeys = Object.keys(input).filter((key) => !EXTENSION_AUTH_CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new ExtensionAuthError('invalid_config', `Unknown extension auth config field: ${unknownKeys[0]}`);
  }

  const raw: RawExtensionAuthConfig = {
    issuer: requireString(input, 'issuer'),
    clientId: requireString(input, 'clientId'),
    audience: requireString(input, 'audience'),
    authorizationEndpoint: requireString(input, 'authorizationEndpoint'),
    tokenEndpoint: requireString(input, 'tokenEndpoint'),
    jwksUri: requireString(input, 'jwksUri'),
    redirectUri: requireString(input, 'redirectUri'),
    extensionIds: requireStringArray(input, 'extensionIds'),
    redirectOrigins: requireStringArray(input, 'redirectOrigins'),
    scopes: requireStringArray(input, 'scopes'),
    algorithms: requireStringArray(input, 'algorithms'),
    clockSkewSeconds: requireBoundedInteger(input, 'clockSkewSeconds', 0, 300),
    evidenceTtlSeconds: requireBoundedInteger(input, 'evidenceTtlSeconds', 1, 60),
  };

  const issuer = requireHttpsUrl(raw.issuer, 'issuer', { allowPath: true }).toString();
  const authorizationEndpoint = requireHttpsUrl(raw.authorizationEndpoint, 'authorizationEndpoint').toString();
  const tokenEndpoint = requireHttpsUrl(raw.tokenEndpoint, 'tokenEndpoint').toString();
  const jwksUri = requireHttpsUrl(raw.jwksUri, 'jwksUri').toString();
  for (const endpoint of [authorizationEndpoint, tokenEndpoint, jwksUri]) {
    if (new URL(endpoint).origin !== new URL(issuer).origin) {
      throw new ExtensionAuthError('invalid_config', 'OAuth endpoints must be issuer-origin in the P3-01 profile');
    }
  }

  const extensionIds = unique(raw.extensionIds);
  if (extensionIds.length === 0 || extensionIds.some((id) => !/^[a-p]{32}$/.test(id))) {
    throw new ExtensionAuthError('invalid_config', 'extensionIds must contain exact Chromium extension IDs');
  }
  const redirectOrigins = unique(raw.redirectOrigins).map((origin) => requireOrigin(origin));
  const redirect = requireHttpsUrl(raw.redirectUri, 'redirectUri');
  if (redirect.search !== '' || redirect.hash !== '') {
    throw new ExtensionAuthError('invalid_config', 'redirectUri cannot contain query or fragment');
  }
  if (!redirectOrigins.includes(redirect.origin)) {
    throw new ExtensionAuthError('redirect_not_allowed', 'redirectUri origin is not allowlisted');
  }
  const redirectExtensionId = redirect.hostname.match(/^([a-p]{32})\.chromiumapp\.org$/)?.[1];
  if (!redirectExtensionId || !extensionIds.includes(redirectExtensionId)) {
    throw new ExtensionAuthError('redirect_not_allowed', 'redirectUri is not bound to an allowlisted extension ID');
  }

  const scopes = unique(raw.scopes).sort();
  if (!scopes.includes('openid') || !scopes.includes('known.sync')) {
    throw new ExtensionAuthError('invalid_config', 'scopes must include openid and known.sync');
  }
  const algorithms = unique(raw.algorithms);
  if (algorithms.length === 0 || algorithms.some((algorithm) => !isAllowedAlgorithm(algorithm))) {
    throw new ExtensionAuthError('invalid_config', 'algorithms must use the asymmetric allowlist');
  }

  return Object.freeze({
    flow: EXTENSION_AUTH_FLOW,
    issuer,
    clientId: raw.clientId,
    audience: raw.audience,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    redirectUri: redirect.toString(),
    allowedExtensionIds: Object.freeze(extensionIds),
    allowedRedirectOrigins: Object.freeze(redirectOrigins),
    scopes: Object.freeze(scopes),
    allowedAlgorithms: Object.freeze(algorithms as ExtensionAuthAlgorithm[]),
    clockSkewSeconds: raw.clockSkewSeconds,
    evidenceTtlSeconds: raw.evidenceTtlSeconds,
  });
}

export interface PkceAuthorizationStart {
  readonly transactionId: string;
  readonly authorizationUrl: URL;
  readonly state: string;
  readonly nonce: string;
}

export interface PkceAuthorizationCompletion {
  readonly authorizationCode: string;
  readonly codeVerifier: string;
  readonly expectedNonce: string;
  readonly redirectUri: string;
}

interface PkceTransaction {
  readonly codeVerifier: string;
  readonly state: string;
  readonly nonce: string;
  status: 'pending' | 'consumed' | 'cancelled';
}

export interface PkceAuthorizationFlow {
  begin(): Promise<PkceAuthorizationStart>;
  complete(input: { readonly transactionId: string; readonly redirectUrl: string }): Promise<PkceAuthorizationCompletion>;
  cancel(transactionId: string): void;
}

export function createPkceAuthorizationFlow(config: ExtensionAuthConfig): PkceAuthorizationFlow {
  const transactions = new Map<string, PkceTransaction>();
  return {
    async begin(): Promise<PkceAuthorizationStart> {
      const transactionId = randomOpaque(18);
      const codeVerifier = randomOpaque(64);
      const state = randomOpaque(32);
      const nonce = randomOpaque(32);
      transactions.set(transactionId, { codeVerifier, state, nonce, status: 'pending' });
      const authorizationUrl = new URL(config.authorizationEndpoint);
      authorizationUrl.searchParams.set('response_type', 'code');
      authorizationUrl.searchParams.set('client_id', config.clientId);
      authorizationUrl.searchParams.set('redirect_uri', config.redirectUri);
      authorizationUrl.searchParams.set('scope', config.scopes.join(' '));
      authorizationUrl.searchParams.set('state', state);
      authorizationUrl.searchParams.set('nonce', nonce);
      authorizationUrl.searchParams.set('code_challenge', sha256Base64Url(codeVerifier));
      authorizationUrl.searchParams.set('code_challenge_method', 'S256');
      return { transactionId, authorizationUrl, state, nonce };
    },

    async complete(input): Promise<PkceAuthorizationCompletion> {
      const transaction = transactions.get(input.transactionId);
      if (!transaction) throw new ExtensionAuthError('transaction_not_found');
      if (transaction.status === 'cancelled') throw new ExtensionAuthError('login_cancelled');
      if (transaction.status === 'consumed') throw new ExtensionAuthError('transaction_consumed');
      transaction.status = 'consumed';

      let redirect: URL;
      try {
        redirect = new URL(input.redirectUrl);
      } catch {
        throw new ExtensionAuthError('redirect_mismatch', 'Callback redirect is not a URL');
      }
      const expected = new URL(config.redirectUri);
      if (redirect.origin !== expected.origin || redirect.pathname !== expected.pathname || redirect.hash !== '') {
        throw new ExtensionAuthError('redirect_mismatch', 'Callback redirect URI does not match exactly');
      }
      const states = redirect.searchParams.getAll('state');
      const codes = redirect.searchParams.getAll('code');
      if (states.length !== 1 || states[0] !== transaction.state) {
        throw new ExtensionAuthError('state_mismatch');
      }
      if (redirect.searchParams.has('error')) {
        throw new ExtensionAuthError('login_cancelled', 'Authorization server denied or cancelled login');
      }
      if (codes.length !== 1 || !hasNonEmpty(codes[0])) {
        throw new ExtensionAuthError('invalid_callback', 'Callback must contain exactly one authorization code');
      }
      return {
        authorizationCode: codes[0]!,
        codeVerifier: transaction.codeVerifier,
        expectedNonce: transaction.nonce,
        redirectUri: config.redirectUri,
      };
    },

    cancel(transactionId: string): void {
      const transaction = transactions.get(transactionId);
      if (transaction?.status === 'pending') transaction.status = 'cancelled';
    },
  };
}

const BEARER_CREDENTIAL = /^[A-Za-z0-9\-._~+/]+=*$/;
const SESSION_COOKIE_PREFIX = /^(?:__Host-known_session|known_session)=/u;
const MAX_BEARER_CREDENTIAL_CHARS = 4_096;

export function parseSingleBearerAuthorization(header: string | readonly string[] | undefined): string {
  if (header === undefined || Array.isArray(header) || typeof header !== 'string' || header.includes(',')) {
    throw new ExtensionAuthError('invalid_authorization_header', 'Exactly one Authorization field is required');
  }
  const match = /^Bearer (\S+)$/.exec(header.trim());
  if (!match) throw new ExtensionAuthError('invalid_authorization_header', 'Authorization must contain one Bearer credential');
  let token = match[1]!;
  if (token.includes('%')) {
    try {
      token = decodeURIComponent(token);
    } catch {
      throw new ExtensionAuthError('invalid_authorization_header', 'Authorization must contain one Bearer credential');
    }
  }
  token = token.replace(SESSION_COOKIE_PREFIX, '');
  if (
    token.length < 1
    || token.length > MAX_BEARER_CREDENTIAL_CHARS
    || !BEARER_CREDENTIAL.test(token)
  ) {
    throw new ExtensionAuthError('invalid_authorization_header', 'Authorization must contain one Bearer credential');
  }
  return token;
}

/** True for compact JWS (three non-empty segments). Better Auth cookie values are two segments. */
export function isJoseCompactToken(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

/**
 * Product-session actor the Better Auth extension verifier needs.
 * Structurally compatible with BrowserSessionAuthority.authenticate results
 * without importing the auth module (identity stays a leaf).
 */
export interface ExtensionSessionActor {
  readonly accountId: string;
  readonly subjectId: string;
  readonly sessionId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface ExtensionBrowserSessionPort {
  authenticate(cookieHeader: string): Promise<ExtensionSessionActor | null>;
}

export interface ExtensionIdentityBinding {
  readonly issuer: string;
  readonly subject: string;
}

export interface ExtensionIdentityBindingPort {
  /**
   * Bind or reuse the single account_identities row for this account.
   * Returns the issuer/subject loadAuthority must look up (existing OIDC
   * bindings are reused so migrated accounts keep syncing).
   */
  ensure(input: {
    readonly accountId: string;
    readonly subjectId: string;
    readonly issuer: string;
  }): Promise<ExtensionIdentityBinding>;
}

/**
 * Resolves the account owner subject for a verified extension credential.
 * Credential subjects are identity subjects (account_identities), which only
 * coincide with accounts.subject_id for natively provisioned identities; the
 * sync session layer resolves through account_identities and consumers (e.g.
 * the extension collections list) must use the same authority, otherwise
 * legacy/OIDC identities see an empty owned-collections list.
 */
export interface ExtensionOwnerSubjectPort {
  resolveOwnerSubject(identity: { readonly issuer: string; readonly subject: string }): Promise<string | null>;
}

export interface SessionBackedExtensionCredentialVerifierOptions {
  readonly config: ExtensionAuthConfig;
  /** Issuer written onto VerifiedExtensionCredential and account_identities (product origin). */
  readonly identityIssuer: string;
  readonly sessions: ExtensionBrowserSessionPort;
  readonly identities: ExtensionIdentityBindingPort;
  readonly now?: () => Date;
}

/**
 * Verify a Better Auth browser session presented as a Bearer cookie value
 * (the signed `__Host-known_session` value, not a JOSE access token).
 */
export function createSessionBackedExtensionCredentialVerifier(
  options: SessionBackedExtensionCredentialVerifierOptions,
): ExtensionCredentialEvidencePort {
  const identityIssuer = options.identityIssuer;
  if (typeof identityIssuer !== 'string' || identityIssuer.length === 0) {
    throw new ExtensionAuthError('invalid_config', 'Better Auth extension identity issuer is required');
  }
  return {
    async verify(input): Promise<VerifiedExtensionCredential> {
      const token = parseSingleBearerAuthorization(input.authorization);
      if (isJoseCompactToken(token)) throw new ExtensionAuthError('invalid_token');
      const now = options.now?.() ?? new Date();
      const actor = await options.sessions.authenticate(browserSessionCookieHeader(token));
      if (!actor) throw new ExtensionAuthError('invalid_token');
      if (actor.expiresAt.getTime() <= now.getTime()) throw new ExtensionAuthError('expired');
      const binding = await options.identities.ensure({
        accountId: actor.accountId,
        subjectId: actor.subjectId,
        issuer: identityIssuer,
      });
      const expiresAtMs = actor.expiresAt.getTime();
      return mintVerifiedExtensionCredential({
        kind: 'verified_extension_credential',
        issuer: binding.issuer,
        subject: binding.subject,
        audience: options.config.audience,
        clientId: options.config.clientId,
        scopes: Object.freeze(['known.sync']),
        credentialId: actor.sessionId,
        credentialDigest: sha256Base64Url(token),
        credentialIssuedAt: actor.issuedAt,
        credentialExpiresAt: actor.expiresAt,
        verifiedAt: new Date(now),
        evidenceExpiresAt: new Date(Math.min(expiresAtMs, now.getTime() + options.config.evidenceTtlSeconds * 1_000)),
      });
    },
  };
}

/**
 * JOSE access tokens first (P3-01 / existing tests); otherwise Better Auth
 * session cookie values. A compact JWS is never retried as a session cookie.
 */
export function createCompositeExtensionCredentialVerifier(
  jose: ExtensionCredentialEvidencePort,
  session: ExtensionCredentialEvidencePort,
): ExtensionCredentialEvidencePort {
  return {
    async verify(input): Promise<VerifiedExtensionCredential> {
      const token = parseSingleBearerAuthorization(input.authorization);
      if (isJoseCompactToken(token)) return jose.verify(input);
      return session.verify(input);
    },
  };
}

function browserSessionCookieHeader(cookieValue: string): string {
  const name = process.env.COLP_INSECURE_HTTP === 'true' ? 'known_session' : '__Host-known_session';
  return `${name}=${encodeURIComponent(cookieValue)}`;
}

export interface ExtensionJwksProvider {
  getKeySet(options?: { readonly forceRefresh?: boolean }): Promise<JSONWebKeySet>;
}

const verifiedExtensionCredentialBrand: unique symbol = Symbol('VerifiedExtensionCredential');

export interface VerifiedExtensionCredential {
  readonly [verifiedExtensionCredentialBrand]: true;
  readonly kind: 'verified_extension_credential';
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string | readonly string[];
  readonly clientId: string;
  readonly scopes: readonly string[];
  /** Stable non-secret JWT ID used for durable Session credential binding. */
  readonly credentialId: string;
  /** One-way digest of the credential value; the bearer value is never retained. */
  readonly credentialDigest: string;
  readonly credentialIssuedAt: Date;
  readonly credentialExpiresAt: Date;
  readonly verifiedAt: Date;
  readonly evidenceExpiresAt: Date;
}

/** Runtime proof that credential evidence came from the JOSE verifier in this process. */
export function isVerifiedExtensionCredential(value: unknown): value is VerifiedExtensionCredential {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { readonly [verifiedExtensionCredentialBrand]?: unknown })
    [verifiedExtensionCredentialBrand] === true;
}

function mintVerifiedExtensionCredential(
  value: Omit<VerifiedExtensionCredential, typeof verifiedExtensionCredentialBrand>,
): VerifiedExtensionCredential {
  Object.defineProperty(value, verifiedExtensionCredentialBrand, {
    value: true, enumerable: false, configurable: false, writable: false,
  });
  return Object.freeze(value) as VerifiedExtensionCredential;
}

export interface ExtensionCredentialEvidencePort {
  verify(input: { readonly authorization: string | readonly string[] | undefined }): Promise<VerifiedExtensionCredential>;
}

export interface VerifiedPkceIdToken {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string | readonly string[];
  readonly nonce: string;
  readonly expiresAt: Date;
}

export async function verifyPkceIdToken(input: {
  readonly token: string;
  readonly config: ExtensionAuthConfig;
  readonly expectedNonce: string;
  readonly jwks: ExtensionJwksProvider;
  readonly now?: Date;
}): Promise<VerifiedPkceIdToken> {
  const payload = await verifySignedToken({
    token: input.token,
    config: input.config,
    jwks: input.jwks,
    audience: input.config.clientId,
    now: input.now ?? new Date(),
    requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce'],
  });
  if (payload.nonce !== input.expectedNonce) throw new ExtensionAuthError('wrong_nonce');
  const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud ?? [];
  if (audiences.length > 1 && payload.azp !== input.config.clientId) {
    throw new ExtensionAuthError('wrong_client', 'Multi-audience ID token requires matching azp');
  }
  if (typeof payload.azp === 'string' && payload.azp !== input.config.clientId) {
    throw new ExtensionAuthError('wrong_client');
  }
  return Object.freeze({
    issuer: payload.iss!,
    subject: requireClaimString(payload, 'sub'),
    audience: Array.isArray(payload.aud) ? Object.freeze([...payload.aud]) : payload.aud!,
    nonce: input.expectedNonce,
    expiresAt: new Date(payload.exp! * 1_000),
  });
}

export interface ExtensionCredentialEvidenceVerifierOptions {
  readonly config: ExtensionAuthConfig;
  readonly jwks: ExtensionJwksProvider;
  readonly requiredScopes: readonly string[];
  readonly isRevoked: (input: {
    readonly issuer: string; readonly subject: string;
    readonly tokenId: string; readonly tokenDigest: string;
    readonly issuedAtSeconds: number; readonly clockSkewSeconds: number;
  }) => Promise<boolean>;
  readonly now?: () => Date;
}

export function createExtensionCredentialEvidenceVerifier(
  options: ExtensionCredentialEvidenceVerifierOptions,
): ExtensionCredentialEvidencePort {
  const requestedRequiredScopes = unique(options.requiredScopes);
  if (requestedRequiredScopes.some((scope) => !options.config.scopes.includes(scope))) {
    throw new ExtensionAuthError('invalid_config', 'Required credential scopes must be configured extension scopes');
  }
  const requiredScopes = unique(['known.sync', ...requestedRequiredScopes]);
  return {
    async verify(input): Promise<VerifiedExtensionCredential> {
      const token = parseSingleBearerAuthorization(input.authorization);
      const now = options.now?.() ?? new Date();
      const payload = await verifyAccessToken(token, options.config, options.jwks, now);
      const subject = requireClaimString(payload, 'sub');
      const tokenId = requireClaimString(payload, 'jti');
      const clientId = requireClaimString(payload, 'client_id');
      if (clientId !== options.config.clientId) throw new ExtensionAuthError('wrong_client');
      const scopes = parseScopeClaim(payload.scope);
      if (requiredScopes.some((scope) => !scopes.includes(scope))) {
        throw new ExtensionAuthError('missing_scope');
      }
      if (scopes.some((scope) => !options.config.scopes.includes(scope))) {
        throw new ExtensionAuthError('invalid_token', 'Credential contains an unconfigured scope');
      }
      const expiresAtMs = payload.exp! * 1_000;
      if (expiresAtMs <= now.getTime()) throw new ExtensionAuthError('expired');
      const credentialDigest = sha256Base64Url(token);
      const revoked = await options.isRevoked({
        issuer: options.config.issuer, subject, tokenId,
        tokenDigest: credentialDigest,
        issuedAtSeconds: payload.iat!, clockSkewSeconds: options.config.clockSkewSeconds,
      });
      if (revoked) throw new ExtensionAuthError('revoked');
      return mintVerifiedExtensionCredential({
        kind: 'verified_extension_credential',
        issuer: payload.iss!,
        subject,
        audience: Array.isArray(payload.aud) ? Object.freeze([...payload.aud]) : payload.aud!,
        clientId,
        scopes: Object.freeze(scopes),
        credentialId: tokenId,
        credentialDigest,
        credentialIssuedAt: new Date(payload.iat! * 1_000),
        credentialExpiresAt: new Date(expiresAtMs),
        verifiedAt: new Date(now),
        evidenceExpiresAt: new Date(Math.min(expiresAtMs, now.getTime() + options.config.evidenceTtlSeconds * 1_000)),
      });
    },
  };
}

async function verifyAccessToken(
  token: string,
  config: ExtensionAuthConfig,
  jwks: ExtensionJwksProvider,
  now: Date,
): Promise<JWTPayload> {
  return verifySignedToken({
    token,
    config,
    jwks,
    audience: config.audience,
    now,
    requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti'],
  });
}

async function verifySignedToken(input: {
  readonly token: string;
  readonly config: ExtensionAuthConfig;
  readonly jwks: ExtensionJwksProvider;
  readonly audience: string;
  readonly now: Date;
  readonly requiredClaims: readonly string[];
}): Promise<JWTPayload> {
  let header: { readonly alg?: string };
  try {
    header = decodeProtectedHeader(input.token);
  } catch {
    throw new ExtensionAuthError('invalid_token');
  }
  if (!header.alg || !input.config.allowedAlgorithms.includes(header.alg as ExtensionAuthAlgorithm)) {
    throw new ExtensionAuthError('disallowed_algorithm');
  }
  const attempt = async (forceRefresh: boolean): Promise<JWTPayload> => {
    const document = await input.jwks.getKeySet({ forceRefresh });
    if (!document || !Array.isArray(document.keys)) throw new ExtensionAuthError('invalid_token');
    const result = await jwtVerify(input.token, createLocalJWKSet(document), {
      issuer: input.config.issuer,
      audience: input.audience,
      algorithms: [...input.config.allowedAlgorithms],
      clockTolerance: input.config.clockSkewSeconds,
      currentDate: input.now,
      requiredClaims: [...input.requiredClaims],
    });
    const issuedAt = result.payload.iat;
    const expiresAt = result.payload.exp;
    const nowSeconds = Math.floor(input.now.getTime() / 1_000);
    if (
      typeof issuedAt !== 'number'
      || typeof expiresAt !== 'number'
      || !Number.isSafeInteger(issuedAt)
      || !Number.isSafeInteger(expiresAt)
      || issuedAt > nowSeconds + input.config.clockSkewSeconds
      || expiresAt <= issuedAt
    ) {
      throw new ExtensionAuthError('invalid_token', 'Token time claims are invalid');
    }
    return result.payload;
  };
  try {
    try {
      return await attempt(false);
    } catch (error: unknown) {
      if (!isUnknownKid(error)) throw error;
      return await attempt(true);
    }
  } catch (error: unknown) {
    throw mapJwtError(error);
  }
}

export interface DeviceTokenSuccess {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly scope?: string;
}

export type DevicePollResponse = DeviceTokenSuccess | {
  readonly error: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | string;
};

export interface DeviceAuthorizationPollOptions {
  readonly deviceCode: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
  readonly poll: (deviceCode: string) => Promise<DevicePollResponse>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

export async function pollDeviceAuthorizationGrant(
  options: DeviceAuthorizationPollOptions,
): Promise<DeviceTokenSuccess> {
  const intervalSeconds = boundedPositiveInteger(options.intervalSeconds, 'intervalSeconds', 300);
  const expiresInSeconds = boundedPositiveInteger(options.expiresInSeconds, 'expiresInSeconds', 3_600);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + expiresInSeconds * 1_000;
  let delaySeconds = intervalSeconds;
  let polls = 0;
  const maxPolls = Math.ceil(expiresInSeconds / intervalSeconds);

  while (polls < maxPolls) {
    assertNotCancelled(options.signal);
    if (now() >= deadline) throw new ExtensionAuthError('device_code_expired');
    await sleep(delaySeconds * 1_000);
    assertNotCancelled(options.signal);
    if (now() >= deadline) throw new ExtensionAuthError('device_code_expired');
    const response = await options.poll(options.deviceCode);
    polls += 1;
    if ('access_token' in response) {
      if (!isValidDeviceTokenSuccess(response)) throw new ExtensionAuthError('device_poll_failed');
      return response;
    }
    if (response.error === 'authorization_pending') continue;
    if (response.error === 'slow_down') {
      delaySeconds = Math.min(delaySeconds + 5, 300);
      continue;
    }
    if (response.error === 'access_denied') throw new ExtensionAuthError('device_authorization_denied');
    if (response.error === 'expired_token') throw new ExtensionAuthError('device_code_expired');
    throw new ExtensionAuthError('device_poll_failed');
  }
  throw new ExtensionAuthError('device_code_expired');
}

function mapJwtError(error: unknown): ExtensionAuthError {
  if (error instanceof ExtensionAuthError) return error;
  if (error instanceof joseErrors.JWTExpired) return new ExtensionAuthError('expired');
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') return new ExtensionAuthError('wrong_issuer');
    if (error.claim === 'aud') return new ExtensionAuthError('wrong_audience');
    if (error.claim === 'exp') return new ExtensionAuthError('expired');
    return new ExtensionAuthError('invalid_token');
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed || error instanceof joseErrors.JWSInvalid) {
    return new ExtensionAuthError('invalid_signature');
  }
  if (isUnknownKid(error)) return new ExtensionAuthError('unknown_kid');
  return new ExtensionAuthError('invalid_token');
}

function isUnknownKid(error: unknown): boolean {
  return error instanceof joseErrors.JWKSNoMatchingKey
    || error instanceof joseErrors.JWKSInvalid
    || (error instanceof Error && /no applicable key|JWKSNoMatchingKey/i.test(error.message));
}

function parseScopeClaim(value: unknown): string[] {
  if (typeof value !== 'string') throw new ExtensionAuthError('missing_scope');
  const scopes = unique(value.split(' ').filter(Boolean)).sort();
  if (scopes.length === 0) throw new ExtensionAuthError('missing_scope');
  return scopes;
}

function isValidDeviceTokenSuccess(value: DeviceTokenSuccess): boolean {
  return hasNonEmpty(value.access_token)
    && value.token_type === 'Bearer'
    && Number.isSafeInteger(value.expires_in)
    && value.expires_in > 0
    && value.expires_in <= 86_400
    && (value.refresh_token === undefined || hasNonEmpty(value.refresh_token))
    && (value.id_token === undefined || hasNonEmpty(value.id_token))
    && (value.scope === undefined || hasNonEmpty(value.scope));
}

function requireClaimString(payload: JWTPayload, key: 'sub' | 'jti' | 'client_id'): string {
  const value = payload[key];
  if (!hasNonEmpty(value)) throw new ExtensionAuthError('invalid_token', `Token claim ${key} is required`);
  return value;
}

function requireHttpsUrl(value: string, label: string, options: { readonly allowPath?: boolean } = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ExtensionAuthError('invalid_config', `${label} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new ExtensionAuthError('invalid_config', `${label} must be a clean HTTPS URL`);
  }
  if (!options.allowPath && parsed.pathname === '/') {
    throw new ExtensionAuthError('invalid_config', `${label} must include an endpoint path`);
  }
  return parsed;
}

function requireOrigin(value: string): string {
  if (value === '*' || value.includes('*')) throw new ExtensionAuthError('invalid_config', 'Wildcard redirect origins are forbidden');
  const parsed = requireHttpsUrl(value, 'redirectOrigin', { allowPath: true });
  if (parsed.pathname !== '/') throw new ExtensionAuthError('invalid_config', 'redirectOrigins must be origins only');
  return parsed.origin;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (!hasNonEmpty(value)) throw new ExtensionAuthError('invalid_config', `${key} is required`);
  return value;
}

function requireStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => !hasNonEmpty(item))) {
    throw new ExtensionAuthError('invalid_config', `${key} must be a non-empty string array`);
  }
  return value.map((item) => item.trim());
}

function requireBoundedInteger(record: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ExtensionAuthError('invalid_config', `${key} must be a safe integer from ${min} through ${max}`);
  }
  return value;
}

function boundedPositiveInteger(value: number, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ExtensionAuthError('invalid_config', `${label} must be a positive bounded integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isAllowedAlgorithm(value: string): value is ExtensionAuthAlgorithm {
  return (EXTENSION_AUTH_ALLOWED_ALGORITHMS as readonly string[]).includes(value);
}

function randomOpaque(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExtensionAuthError('login_cancelled');
}
