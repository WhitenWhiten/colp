/**
 * Phase 4B MCP Read route-scoped OAuth verifier (P4B-R03).
 * Emits token-free evidence. Raw credentials are never retained.
 */
import { createHash } from 'node:crypto';
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';
import {
  mapOAuthEvidenceToAuthenticatedBinding,
  type McpAuthenticatedAuthorizationBinding,
  type McpOAuthCredentialEvidence,
} from '@know-n/colp/mcp';
import {
  resolveMachineOauthBinding,
  type McpMachineOauthBinding,
} from './machine-oauth-binding.js';
import { grantsScope } from './scope-implications.js';
import { mcpAccountSecurityBoundaryVerdict, type McpAccountSecurityBoundaryReader } from './account-security-boundary.js';
import {
  IdTokenVerificationError,
  type JwksProvider,
} from '../identity/index.js';

export {
  MCP_OAUTH_SCOPE_READ_PUBLIC,
  MCP_OAUTH_SCOPE_READ_OWN,
  MCP_OAUTH_SCOPE_REPORTS_READ,
  MCP_OAUTH_SCOPE_REPORTS_WRITE,
  requiredScopesForMcpReadOperation,
} from './scope-requirements.js';

/** Algorithms accepted for MCP OAuth bearer signatures (asymmetric only). */
export const MCP_OAUTH_ALLOWED_ALGORITHMS = ['RS256', 'ES256', 'PS256', 'ES384'] as const;

export type McpOauthAllowedAlgorithm = (typeof MCP_OAUTH_ALLOWED_ALGORITHMS)[number];

export type McpOauthVerificationFailureReason =
  | 'invalid_authorization_header'
  | 'invalid_token'
  | 'disallowed_algorithm'
  | 'invalid_signature'
  | 'unknown_kid'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'missing_scope'
  | 'expired'
  | 'not_yet_valid'
  | 'revoked'
  | 'jwks_timeout'
  | 'jwks_fetch_failed'
  | 'jwks_malformed';

export class McpOauthVerificationError extends Error {
  readonly reason: McpOauthVerificationFailureReason;

  constructor(reason: McpOauthVerificationFailureReason, message?: string) {
    super(message ?? `MCP OAuth verification failed: ${reason}`);
    this.name = 'McpOauthVerificationError';
    this.reason = reason;
  }
}

/**
 * Authorization-server-only refresh scope. Better Auth mints `refresh_token`
 * only when this value is granted. It is not an MCP capability and never
 * satisfies `requiredScopes` for read/write operations.
 */
export const MCP_OAUTH_SCOPE_OFFLINE_ACCESS = 'offline_access' as const;

/**
 * Capability scopes plus the reserved refresh scope. Env `MCP_OAUTH_SCOPES`
 * stays the capability set; this union is what the verifier and PRM accept.
 */
export function withMcpOauthAcceptedScopes(
  scopes: readonly string[],
): readonly string[] {
  if (scopes.includes(MCP_OAUTH_SCOPE_OFFLINE_ACCESS)) return Object.freeze([...scopes]);
  return Object.freeze([...scopes, MCP_OAUTH_SCOPE_OFFLINE_ACCESS]);
}

export interface McpOauthVerificationInput {
  readonly authorization: string | readonly string[] | undefined;
  /** Operation-required subset of the configured support set (ADR D5). */
  readonly requiredScopes?: readonly string[];
}

export interface McpOauthRevocationInput {
  readonly issuer: string;
  readonly subject: string;
  readonly clientId: string;
  readonly tokenId: string;
  readonly credentialDigest: string;
  /** Signed token iat in epoch seconds; revocation stores use it for epoch boundaries. */
  readonly issuedAtSeconds: number;
}

export interface McpOauthResolvedAccount {
  readonly id: string;
  readonly subjectId: string;
  readonly status: string;
  readonly securityEpoch?: string;
}

export type McpOauthAccountResolver = (
  sub: string,
) => Promise<McpOauthResolvedAccount | readonly McpOauthResolvedAccount[] | null | undefined>;

export interface McpOauthVerifierOptions {
  readonly issuer: string;
  /** Strict audience, or the dual strict+compat set both surfaces accept. */
  readonly audience: string | readonly string[];
  readonly allowedScopes: readonly string[];
  readonly jwks: JwksProvider;
  readonly isRevoked: (input: McpOauthRevocationInput) => Promise<boolean>;
  readonly securityEpoch: () => string | Promise<string>;
  /**
   * Resolves JWT `sub` to the unique active Known account. Required; missing
   * rows, inactive status, or lookup ambiguity fail closed as `invalid_token`.
   */
  readonly resolveAccountBySubject: McpOauthAccountResolver;
  /** Built-in issuer tokens carry the account epoch, independent of iat resolution. */
  readonly requireAccountEpoch?: boolean;
  /** Present only when a revocation store can read the resolved account. Absent means external credentials are not revoked by account events. */
  readonly readAccountSecurityBoundary?: McpAccountSecurityBoundaryReader;
  /** Injectable wall clock; defaults to new Date(). */
  readonly now?: () => Date;
  /** Clock skew for exp/nbf/iat checks in seconds. Default 60. */
  readonly clockToleranceSeconds?: number;
  readonly machine?: McpMachineOauthBinding;
}

const mcpOauthVerificationResultBrand: unique symbol = Symbol('McpOauthVerificationResult');

export interface McpOauthVerificationResult {
  readonly [mcpOauthVerificationResultBrand]: true;
  readonly evidence: McpOAuthCredentialEvidence;
  readonly binding: McpAuthenticatedAuthorizationBinding;
  /** `accounts.subject_id` for the resolved active account (never a raw unmapped `sub`). */
  readonly accountSubjectId: string;
  readonly credentialDigest: string;
  readonly verifiedAt: Date;
  readonly expiresAt: Date;
  /** Token scopes after support-set and operation-subset checks. */
  readonly scopes: readonly string[];
}

export interface McpOauthVerifier {
  verify(input: McpOauthVerificationInput): Promise<McpOauthVerificationResult>;
}

/** Runtime proof that OAuth evidence came from this verifier in this process. */
export function isMcpOauthVerificationResult(value: unknown): value is McpOauthVerificationResult {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { readonly [mcpOauthVerificationResultBrand]?: unknown })
    [mcpOauthVerificationResultBrand] === true;
}

function mintMcpOauthVerificationResult(
  value: Omit<McpOauthVerificationResult, typeof mcpOauthVerificationResultBrand>,
): McpOauthVerificationResult {
  Object.defineProperty(value, mcpOauthVerificationResultBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(value) as McpOauthVerificationResult;
}


export function parseSingleMcpOauthBearerAuthorization(
  header: string | readonly string[] | undefined,
): string {
  if (
    header === undefined
    || Array.isArray(header)
    || typeof header !== 'string'
    || header.includes(',')
  ) {
    throw new McpOauthVerificationError(
      'invalid_authorization_header',
      'Exactly one MCP OAuth Authorization field is required',
    );
  }
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(header);
  if (!match) {
    throw new McpOauthVerificationError(
      'invalid_authorization_header',
      'MCP OAuth Authorization must contain one Bearer credential',
    );
  }
  return match[1]!;
}

export function createMcpOauthVerifier(options: McpOauthVerifierOptions): McpOauthVerifier {
  const allowedScopes = unique(withMcpOauthAcceptedScopes(options.allowedScopes));
  const allowedAlgorithms = new Set<string>(MCP_OAUTH_ALLOWED_ALGORITHMS);
  const clockTolerance = options.clockToleranceSeconds ?? 60;
  const acceptedAudiences = unique(
    Array.isArray(options.audience) ? options.audience : [options.audience],
  );
  if (acceptedAudiences.length === 0 || acceptedAudiences.some((entry) => entry.trim() === '')) {
    throw new TypeError('MCP OAuth verifier requires at least one audience.');
  }

  return {
    async verify(input): Promise<McpOauthVerificationResult> {
      const token = parseSingleMcpOauthBearerAuthorization(input.authorization);
      const now = options.now?.() ?? new Date();
      const payload = await verifySignedToken({
        token,
        issuer: options.issuer,
        audience: acceptedAudiences,
        jwks: options.jwks,
        allowedAlgorithms,
        clockTolerance,
        now,
      });

      const subject = requireClaimString(payload, 'sub');
      const tokenId = requireClaimString(payload, 'jti');
      const clientId = requireClaimString(payload, 'client_id');

      const scopes = parseScopeClaim(payload.scope);
      if (scopes.some((scope) => !allowedScopes.includes(scope))) {
        throw new McpOauthVerificationError('invalid_token');
      }
      const requiredScopes = unique(input.requiredScopes ?? []);
      if (requiredScopes.some((scope) => !grantsScope(scopes, scope))) {
        throw new McpOauthVerificationError('missing_scope');
      }

      const expiresAtValue = payload.exp;
      if (typeof expiresAtValue !== 'number' || !Number.isFinite(expiresAtValue)) {
        throw new McpOauthVerificationError('invalid_token');
      }

      const credentialDigest = sha256Base64Url(token);
      const issuedAtValue = payload.iat;
      if (typeof issuedAtValue !== 'number' || !Number.isFinite(issuedAtValue)) {
        throw new McpOauthVerificationError('invalid_token');
      }
      let revoked: boolean;
      try {
        revoked = await options.isRevoked({
          issuer: options.issuer,
          subject,
          clientId,
          tokenId,
          credentialDigest,
          issuedAtSeconds: issuedAtValue,
          ...(typeof payload.known_incident_epoch === 'string' ? { issuedSecurityEpoch: payload.known_incident_epoch } : {}),
        });
      } catch {
        // FIX-L-042: revocation store query failures fail closed as revoked;
        // a credential that could not be checked is never accepted.
        throw new McpOauthVerificationError('revoked');
      }
      if (revoked) throw new McpOauthVerificationError('revoked');

      let securityEpoch: string;
      try {
        securityEpoch = await options.securityEpoch();
      } catch {
        // FIX-L-042: an unreadable security epoch fails closed as revoked.
        throw new McpOauthVerificationError('revoked');
      }
      if (typeof securityEpoch !== 'string' || securityEpoch.trim() === '') {
        throw new McpOauthVerificationError('invalid_token');
      }

      const account = await resolveActiveAccountBySubject(options.resolveAccountBySubject, subject);
      if (await mcpAccountSecurityBoundaryVerdict({
        requireAccountEpoch: options.requireAccountEpoch === true,
        ...(options.readAccountSecurityBoundary === undefined
          ? {}
          : { readAccountSecurityBoundary: options.readAccountSecurityBoundary }),
        account,
        knownAccountEpoch: payload.known_account_epoch,
        issuedAtSeconds: issuedAtValue,
      }) === 'revoked') throw new McpOauthVerificationError('revoked');

      const resourceAudience = matchedResourceAudience(payload.aud, acceptedAudiences);
      const machineBound = await resolveMachineOauthBinding({
        token, payload, issuer: options.issuer, resourceAudience, securityEpoch,
        ...(options.machine ? { machine: options.machine } : {}),
      });
      if (machineBound.kind === 'disallowed_algorithm' || machineBound.kind === 'invalid_token') {
        throw new McpOauthVerificationError(machineBound.kind);
      }
      const credentialBindingId = machineBound.kind === 'bound' ? machineBound.credentialBindingId
        : sha256Base64Url(`oauth\0${options.issuer}\0${tokenId}`);
      const evidence: McpOAuthCredentialEvidence = Object.freeze({
        credentialKind: 'oauth',
        principalId: account.id,
        clientId,
        credentialBindingId,
        resourceAudience,
        securityEpoch,
      });
      const binding = mapOAuthEvidenceToAuthenticatedBinding(evidence);

      return mintMcpOauthVerificationResult({
        evidence,
        binding,
        accountSubjectId: account.subjectId,
        credentialDigest,
        verifiedAt: new Date(now.getTime()),
        expiresAt: new Date(expiresAtValue * 1_000),
        scopes: Object.freeze([...scopes]),
      });
    },
  };
}

async function resolveActiveAccountBySubject(
  resolver: McpOauthAccountResolver,
  subject: string,
): Promise<McpOauthResolvedAccount> {
  let resolved: McpOauthResolvedAccount | readonly McpOauthResolvedAccount[] | null | undefined;
  try {
    resolved = await resolver(subject);
  } catch {
    throw new McpOauthVerificationError('invalid_token');
  }
  const accounts = resolved == null
    ? []
    : Array.isArray(resolved)
      ? resolved
      : [resolved];
  if (accounts.length !== 1) {
    throw new McpOauthVerificationError('invalid_token');
  }
  const account = accounts[0]!;
  if (
    typeof account.id !== 'string'
    || account.id.trim() === ''
    || typeof account.subjectId !== 'string'
    || account.subjectId !== subject
    || account.status !== 'active'
  ) {
    throw new McpOauthVerificationError('invalid_token');
  }
  return account;
}

async function verifySignedToken(input: {
  readonly token: string;
  readonly issuer: string;
  readonly audience: readonly string[];
  readonly jwks: JwksProvider;
  readonly allowedAlgorithms: ReadonlySet<string>;
  readonly clockTolerance: number;
  readonly now: Date;
}): Promise<JWTPayload> {
  let header: { readonly alg?: string };
  try {
    header = decodeProtectedHeader(input.token);
  } catch {
    throw new McpOauthVerificationError('invalid_token');
  }
  if (!header.alg || !input.allowedAlgorithms.has(header.alg)) {
    throw new McpOauthVerificationError('disallowed_algorithm');
  }

  const attempt = async (forceRefresh: boolean): Promise<JWTPayload> => {
    let document: JSONWebKeySet;
    try {
      document = await input.jwks.getKeySet({ forceRefresh });
    } catch (error: unknown) {
      throw mapJwksProviderError(error);
    }
    if (
      document === null
      || typeof document !== 'object'
      || !Array.isArray(document.keys)
    ) {
      throw new McpOauthVerificationError('jwks_malformed');
    }
    const result = await jwtVerify(input.token, createLocalJWKSet(document), {
      issuer: input.issuer,
      audience: [...input.audience],
      algorithms: [...input.allowedAlgorithms] as McpOauthAllowedAlgorithm[],
      clockTolerance: input.clockTolerance,
      currentDate: input.now,
      requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat'],
    });
    return result.payload;
  };

  try {
    return await attempt(false);
  } catch (error: unknown) {
    if (isUnknownKeyError(error)) {
      try {
        return await attempt(true);
      } catch (retryError: unknown) {
        if (isUnknownKeyError(retryError)) {
          throw new McpOauthVerificationError('unknown_kid');
        }
        throw retryError;
      }
    }
    throw mapVerificationError(error);
  }
}

function mapJwksProviderError(error: unknown): McpOauthVerificationError {
  if (error instanceof IdTokenVerificationError) {
    switch (error.reason) {
      case 'jwks_timeout':
        return new McpOauthVerificationError('jwks_timeout');
      case 'jwks_malformed':
        return new McpOauthVerificationError('jwks_malformed');
      case 'jwks_fetch_failed':
      default:
        return new McpOauthVerificationError('jwks_fetch_failed');
    }
  }
  return new McpOauthVerificationError('jwks_fetch_failed');
}

function mapVerificationError(error: unknown): McpOauthVerificationError {
  if (error instanceof McpOauthVerificationError) return error;
  if (error instanceof IdTokenVerificationError) {
    switch (error.reason) {
      case 'disallowed_algorithm':
        return new McpOauthVerificationError('disallowed_algorithm');
      case 'invalid_signature':
        return new McpOauthVerificationError('invalid_signature');
      case 'unknown_kid':
        return new McpOauthVerificationError('unknown_kid');
      case 'wrong_issuer':
        return new McpOauthVerificationError('wrong_issuer');
      case 'wrong_audience':
        return new McpOauthVerificationError('wrong_audience');
      case 'expired':
        return new McpOauthVerificationError('expired');
      case 'not_yet_valid':
        return new McpOauthVerificationError('not_yet_valid');
      case 'jwks_timeout':
        return new McpOauthVerificationError('jwks_timeout');
      case 'jwks_fetch_failed':
        return new McpOauthVerificationError('jwks_fetch_failed');
      case 'jwks_malformed':
        return new McpOauthVerificationError('jwks_malformed');
      default:
        return new McpOauthVerificationError('invalid_token');
    }
  }
  if (error instanceof joseErrors.JWTExpired) {
    return new McpOauthVerificationError('expired');
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') return new McpOauthVerificationError('wrong_issuer');
    if (error.claim === 'aud') return new McpOauthVerificationError('wrong_audience');
    if (error.claim === 'nbf') return new McpOauthVerificationError('not_yet_valid');
    if (error.claim === 'exp') return new McpOauthVerificationError('expired');
    return new McpOauthVerificationError('invalid_token');
  }
  if (
    error instanceof joseErrors.JWSSignatureVerificationFailed
    || error instanceof joseErrors.JWSInvalid
  ) {
    return new McpOauthVerificationError('invalid_signature');
  }
  if (error instanceof joseErrors.JWKSNoMatchingKey || error instanceof joseErrors.JWKSInvalid) {
    return new McpOauthVerificationError('unknown_kid');
  }
  if (error instanceof joseErrors.JWKSTimeout) {
    return new McpOauthVerificationError('jwks_timeout');
  }
  if (
    error instanceof joseErrors.JOSEError
    || error instanceof SyntaxError
    || error instanceof TypeError
  ) {
    return new McpOauthVerificationError('invalid_token');
  }
  if (error instanceof Error) {
    return new McpOauthVerificationError('invalid_token');
  }
  return new McpOauthVerificationError('invalid_token');
}

function isUnknownKeyError(error: unknown): boolean {
  return error instanceof joseErrors.JWKSNoMatchingKey
    || error instanceof joseErrors.JWKSInvalid
    || (error instanceof Error && /no applicable key|JWKSNoMatchingKey/i.test(error.message));
}

function parseScopeClaim(value: unknown): string[] {
  if (typeof value !== 'string') throw new McpOauthVerificationError('missing_scope');
  const scopes = unique(value.split(' ').filter(Boolean)).sort();
  if (scopes.length === 0) throw new McpOauthVerificationError('missing_scope');
  return scopes;
}

function requireClaimString(payload: JWTPayload, key: 'sub' | 'jti' | 'client_id'): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new McpOauthVerificationError('invalid_token');
  }
  return value;
}

const SENSITIVE_LOG_KEYS = new Set([
  'authorization',
  'Authorization',
  'rawToken',
  'raw_token',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'secret',
  'clientSecret',
  'client_secret',
  'subject',
  'principalId',
  'accountSubjectId',
  'subjectId',
  'clientId',
  'tokenId',
  'credentialDigest',
  'credentialBindingId',
  'issuer',
  'audience',
  'resourceAudience',
]);

/** Redacts bearer values, JWT-like strings and identity fields from log context. */
export function redactMcpOauthLogContext(
  context: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    redacted[key] = redactLogValue(key, value);
  }
  return Object.freeze(redacted);
}

function redactLogValue(key: string, value: unknown): unknown {
  if (SENSITIVE_LOG_KEYS.has(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (looksLikeRawCredential(value)) return '[REDACTED]';
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactLogValue(String(index), item));
  }
  if (value !== null && typeof value === 'object' && !isDate(value)) {
    const nested: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      nested[nestedKey] = redactLogValue(nestedKey, nestedValue);
    }
    return nested;
  }
  return value;
}

function looksLikeRawCredential(value: string): boolean {
  return value.startsWith('Bearer ')
    || value.startsWith('Basic ')
    || value.startsWith('eyJ')
    || value.startsWith('sk-')
    || value.startsWith('AKIA');
}

function isDate(value: unknown): boolean {
  return value instanceof Date;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function matchedResourceAudience(
  aud: JWTPayload['aud'],
  accepted: readonly string[],
): string {
  const tokenAudiences = Array.isArray(aud) ? aud : [aud];
  for (const candidate of tokenAudiences) {
    if (typeof candidate === 'string' && accepted.includes(candidate)) return candidate;
  }
  throw new McpOauthVerificationError('wrong_audience');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}
