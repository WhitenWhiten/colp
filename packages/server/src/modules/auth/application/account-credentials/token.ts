import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { importJWK, SignJWT, type JWK } from 'jose';
import { ACCOUNT_CREDENTIAL_SECRET_PATTERN } from './secret.js';
import {
  AccountKeyOAuthError,
  invalidGrant,
  invalidRequest,
  invalidScope,
} from './oauth-error.js';

export interface AccountKeyEs256PrivateJwk {
  readonly kid: string;
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
  readonly d: string;
}

export const ACCOUNT_KEY_GRANT_TYPE = 'urn:known:params:oauth:grant-type:account-key' as const;
export const PRODUCT_READ_SCOPE = 'product:read' as const;
export const PRODUCT_WRITE_SCOPE = 'product:write' as const;
export const ACCOUNT_KEY_TOKEN_TTL_SECONDS = 300;
export const ACCOUNT_KEY_CLOCK_SKEW_SECONDS = 30;
export const ACCOUNT_KEY_MAX_SCOPES = 32;

export type AccountKeyAudienceSelector = 'product' | 'mcp_strict' | 'mcp_compat';

export interface AccountKeyAudienceConfig {
  readonly productOrigin: string;
  readonly mcpStrictAudience?: string;
}

export interface AccountKeyTokenRequest {
  readonly grant_type: typeof ACCOUNT_KEY_GRANT_TYPE;
  readonly credential: string;
  readonly audience: AccountKeyAudienceSelector;
  readonly scopes: readonly string[];
}

export interface AccountCredentialsEs256PublicJwk {
  readonly kid: string;
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
  readonly use: 'sig';
  readonly alg: 'ES256';
}

export function canonicalOrigin(origin: string): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin;
}

export function mcpCompatAudienceFromStrict(strictAudience: string): string {
  return `${new URL(strictAudience).origin}/collections/-/mcp-compat`;
}

export function resolveAccountKeyAudience(
  selector: string,
  config: AccountKeyAudienceConfig,
): string {
  if (selector === 'product') return canonicalOrigin(config.productOrigin);
  if (selector === 'mcp_strict') {
    if (!config.mcpStrictAudience) throw invalidScope('The requested audience is not supported.');
    return config.mcpStrictAudience;
  }
  if (selector === 'mcp_compat') {
    if (!config.mcpStrictAudience) throw invalidScope('The requested audience is not supported.');
    return mcpCompatAudienceFromStrict(config.mcpStrictAudience);
  }
  throw invalidScope('The requested audience is not supported.');
}

export function supportedAccountKeyScopes(existing: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  for (const scope of existing) {
    if (scope !== 'offline_access') unique.add(scope);
  }
  unique.add(PRODUCT_READ_SCOPE);
  unique.add(PRODUCT_WRITE_SCOPE);
  return Object.freeze([...unique].sort());
}

export function sortScopeTokens(scopes: readonly string[]): string {
  return [...scopes].sort().join(' ');
}

export function ancestorEpochDigest(
  ancestorsRootFirst: readonly { readonly id: string; readonly epoch: bigint }[],
): string {
  const payload = ancestorsRootFirst.map((entry) => `${entry.id}:${entry.epoch.toString(10)}`).join('\0');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function machineCredentialBindingId(input: {
  readonly iss: string;
  readonly clientId: string;
  readonly credentialId: string;
  readonly resourceAudience: string;
  readonly accountEpoch: string;
  readonly credentialEpoch: string;
  readonly ancestorEpochDigest: string;
  readonly serverSecurityEpoch: string;
}): string {
  return createHash('sha256').update([
    'known-machine-v1',
    input.iss,
    input.clientId,
    input.credentialId,
    input.resourceAudience,
    input.accountEpoch,
    input.credentialEpoch,
    input.ancestorEpochDigest,
    input.serverSecurityEpoch,
  ].join('\0'), 'utf8').digest('base64url');
}

export function publicJwkFromPrivate(jwk: AccountKeyEs256PrivateJwk): AccountCredentialsEs256PublicJwk {
  return Object.freeze({
    kid: jwk.kid,
    kty: 'EC',
    crv: 'P-256',
    x: jwk.x,
    y: jwk.y,
    use: 'sig',
    alg: 'ES256',
  });
}

export function parseAccountKeyTokenRequest(
  body: unknown,
  supportedScopes: readonly string[],
): AccountKeyTokenRequest | AccountKeyOAuthError {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return invalidRequest('The request body is invalid.');
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(['grant_type', 'credential', 'audience', 'scope']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return invalidRequest('The request body is invalid.');
  }
  if (record.grant_type !== ACCOUNT_KEY_GRANT_TYPE) {
    return invalidRequest('The grant_type is invalid.');
  }
  if (typeof record.credential !== 'string' || !ACCOUNT_CREDENTIAL_SECRET_PATTERN.test(record.credential)) {
    return invalidRequest('The credential is invalid.');
  }
  if (record.credential.startsWith('kn_p_')) return invalidGrant();
  if (record.audience !== 'product' && record.audience !== 'mcp_strict' && record.audience !== 'mcp_compat') {
    return invalidScope('The requested audience is not supported.');
  }
  if (typeof record.scope !== 'string') return invalidRequest('The scope is invalid.');
  const scopes = parseScopeString(record.scope, supportedScopes);
  if (scopes instanceof AccountKeyOAuthError) return scopes;
  return {
    grant_type: ACCOUNT_KEY_GRANT_TYPE,
    credential: record.credential,
    audience: record.audience,
    scopes,
  };
}

function parseScopeString(
  raw: string,
  supportedScopes: readonly string[],
): readonly string[] | AccountKeyOAuthError {
  if (raw.length < 1 || raw.length > 2048) {
    return invalidRequest('The scope is invalid.');
  }
  if (!/^[a-z][a-z0-9._:-]{0,127}(?: [a-z][a-z0-9._:-]{0,127})*$/u.test(raw)) {
    return invalidRequest('The scope is invalid.');
  }
  const tokens = raw.split(' ');
  if (tokens.length < 1 || tokens.length > ACCOUNT_KEY_MAX_SCOPES) {
    return invalidRequest('The scope is invalid.');
  }
  if (new Set(tokens).size !== tokens.length) return invalidRequest('The scope is invalid.');
  const supported = new Set(supportedScopes);
  if (tokens.includes('offline_access') || tokens.some((scope) => !supported.has(scope))) {
    return invalidScope('The requested scope is not supported.');
  }
  return Object.freeze([...tokens].sort());
}

export async function signAccountKeyAccessToken(input: {
  readonly privateJwk: AccountKeyEs256PrivateJwk;
  readonly issuer: string;
  readonly audienceUrl: string;
  readonly subjectId: string;
  readonly scopes: readonly string[];
  readonly credentialId: string;
  readonly accountEpoch: string;
  readonly credentialEpoch: string;
  readonly ancestorEpoch: string;
  readonly clientId: string;
  readonly now: Date;
  readonly ttlSeconds: number;
}): Promise<string> {
  const iat = Math.floor(input.now.getTime() / 1000);
  const key = await importJWK(input.privateJwk as JWK, 'ES256');
  return new SignJWT({
    scope: sortScopeTokens(input.scopes),
    known_credential_id: input.credentialId,
    known_account_epoch: input.accountEpoch,
    known_credential_epoch: input.credentialEpoch,
    known_ancestor_epoch: input.ancestorEpoch,
    client_id: input.clientId,
  })
    .setProtectedHeader({ alg: 'ES256', kid: input.privateJwk.kid, typ: 'JWT' })
    .setIssuer(input.issuer)
    .setSubject(input.subjectId)
    .setAudience(input.audienceUrl)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(iat + input.ttlSeconds)
    .setJti(randomUUID())
    .sign(key);
}

export function mergeAutomationJwks(
  existing: { readonly keys?: readonly Record<string, unknown>[] } | null,
  current: AccountCredentialsEs256PublicJwk | null,
  previous: readonly AccountCredentialsEs256PublicJwk[],
): { readonly keys: readonly Record<string, unknown>[] } {
  const keys: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const push = (key: Record<string, unknown>): void => {
    const kid = typeof key.kid === 'string' ? key.kid : '';
    const identity = kid || JSON.stringify(key);
    if (seen.has(identity)) return;
    seen.add(identity);
    keys.push(key);
  };
  if (current) push({ ...current });
  for (const key of previous) push({ ...key });
  for (const key of existing?.keys ?? []) {
    if (!key || typeof key !== 'object') continue;
    push({ ...key });
  }
  return { keys: Object.freeze(keys) };
}

export function composeAccountKeyRuntime(input: {
  readonly productOrigin: string;
  readonly betterAuthBasePath: string;
  readonly mcpIssuer?: string;
  readonly mcpStrictAudience?: string;
  readonly mcpScopes?: readonly string[];
  readonly privateJwk: AccountKeyEs256PrivateJwk | null;
  readonly previousPublicJwks: readonly AccountCredentialsEs256PublicJwk[];
}): {
  readonly issuer: string;
  readonly productOrigin: string;
  readonly audienceConfig: AccountKeyAudienceConfig;
  readonly supportedScopes: readonly string[];
  readonly publicKeys: readonly AccountCredentialsEs256PublicJwk[];
  readonly machineKids: ReadonlySet<string>;
} {
  const productOrigin = canonicalOrigin(input.productOrigin);
  const issuer = input.mcpIssuer ?? `${productOrigin}${input.betterAuthBasePath}`;
  const current = input.privateJwk ? publicJwkFromPrivate(input.privateJwk) : null;
  const publicKeys = Object.freeze([
    ...(current ? [current] : []),
    ...input.previousPublicJwks,
  ]);
  return {
    issuer,
    productOrigin,
    audienceConfig: {
      productOrigin,
      ...(input.mcpStrictAudience ? { mcpStrictAudience: input.mcpStrictAudience } : {}),
    },
    supportedScopes: supportedAccountKeyScopes(input.mcpScopes ?? []),
    publicKeys,
    machineKids: new Set(publicKeys.map((key) => key.kid)),
  };
}

export function asPublicEs256Jwk(value: unknown): AccountCredentialsEs256PublicJwk | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.kty !== 'EC'
    || record.crv !== 'P-256'
    || typeof record.kid !== 'string'
    || record.kid.length < 1
    || typeof record.x !== 'string'
    || typeof record.y !== 'string'
    || record.d !== undefined
  ) {
    return null;
  }
  try {
    createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: record.x, y: record.y }, format: 'jwk' });
  } catch {
    return null;
  }
  return Object.freeze({
    kid: record.kid,
    kty: 'EC',
    crv: 'P-256',
    x: record.x,
    y: record.y,
    use: 'sig',
    alg: 'ES256',
  });
}
