import { createPrivateKey, createPublicKey } from 'node:crypto';
import { parsePositiveInt } from './config-parse-helpers.js';

export interface AccountCredentialsEs256PrivateJwk {
  readonly kid: string;
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
  readonly d: string;
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

export interface AccountCredentialsTokenRateConfig {
  readonly credential: { readonly maxRequests: number; readonly windowMs: number };
  readonly client: { readonly maxRequests: number; readonly windowMs: number };
}

export interface AccountCredentialsFeatureConfig {
  readonly enabled: boolean;
  readonly exposeAutomationIdentity: boolean;
  readonly cursorHmacKey: Buffer | null;
  readonly es256PrivateJwk: AccountCredentialsEs256PrivateJwk | null;
  readonly es256PreviousPublicJwks: readonly AccountCredentialsEs256PublicJwk[];
  readonly issuanceRate: { readonly maxRequests: number; readonly windowMs: number };
  readonly tokenRate: AccountCredentialsTokenRateConfig;
  readonly tokenTtlSeconds: number;
  readonly clockSkewSeconds: number;
  readonly timeoutMs: number;
}

export function loadAccountCredentialsFeatureConfig(env: NodeJS.ProcessEnv): AccountCredentialsFeatureConfig {
  const enabled = parseTrueFalse(env.KNOWN_FEATURE_ACCOUNT_CREDENTIALS, 'KNOWN_FEATURE_ACCOUNT_CREDENTIALS', false);
  const exposeAutomationIdentity = parseTrueFalse(env.EXPOSE_AUTOMATION_IDENTITY, 'EXPOSE_AUTOMATION_IDENTITY', false);
  const issuanceRate = Object.freeze({
    maxRequests: 20,
    windowMs: 3_600_000,
  });
  const tokenRate = Object.freeze({
    credential: Object.freeze({ maxRequests: 30, windowMs: 60_000 }),
    client: Object.freeze({ maxRequests: 120, windowMs: 60_000 }),
  });
  const tokenTtlSeconds = 300;
  const clockSkewSeconds = 30;
  const timeoutMs = parsePositiveInt(env.ACCOUNT_CREDENTIALS_HTTP_TIMEOUT_MS, 2_000, 'ACCOUNT_CREDENTIALS_HTTP_TIMEOUT_MS', { max: 30_000 });
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      exposeAutomationIdentity,
      cursorHmacKey: null,
      es256PrivateJwk: null,
      es256PreviousPublicJwks: Object.freeze([]),
      issuanceRate,
      tokenRate,
      tokenTtlSeconds,
      clockSkewSeconds,
      timeoutMs,
    });
  }
  const cursorHmacKey = parseCursorHmacKey(env.AUTOMATION_CURSOR_HMAC_KEY);
  const es256PrivateJwk = parseEs256PrivateJwk(env.AUTOMATION_ES256_PRIVATE_JWK);
  const es256PreviousPublicJwks = parsePreviousPublicJwks(env.AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS);
  return Object.freeze({
    enabled: true,
    exposeAutomationIdentity,
    cursorHmacKey,
    es256PrivateJwk,
    es256PreviousPublicJwks,
    issuanceRate,
    tokenRate,
    tokenTtlSeconds,
    clockSkewSeconds,
    timeoutMs,
  });
}

function parseTrueFalse(raw: string | undefined, name: string, defaultValue: boolean): boolean {
  const value = (raw ?? (defaultValue ? 'true' : 'false')).trim().toLowerCase();
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
  return value === 'true';
}

function parseCursorHmacKey(raw: string | undefined): Buffer {
  const value = raw?.trim();
  if (!value) throw new Error('AUTOMATION_CURSOR_HMAC_KEY is required when KNOWN_FEATURE_ACCOUNT_CREDENTIALS=true');
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== value) {
    throw new Error('AUTOMATION_CURSOR_HMAC_KEY must be a canonical base64url 32-byte secret');
  }
  return key;
}

function parseEs256PrivateJwk(raw: string | undefined): AccountCredentialsEs256PrivateJwk {
  const value = raw?.trim();
  if (!value) throw new Error('AUTOMATION_ES256_PRIVATE_JWK is required when KNOWN_FEATURE_ACCOUNT_CREDENTIALS=true');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('AUTOMATION_ES256_PRIVATE_JWK must be ES256 private JWK JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AUTOMATION_ES256_PRIVATE_JWK must be ES256 private JWK JSON');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.kty !== 'EC'
    || record.crv !== 'P-256'
    || typeof record.kid !== 'string'
    || record.kid.length < 1
    || typeof record.x !== 'string'
    || typeof record.y !== 'string'
    || typeof record.d !== 'string'
  ) {
    throw new Error('AUTOMATION_ES256_PRIVATE_JWK must include kid, kty=EC, crv=P-256, x, y, and d');
  }
  try {
    createPrivateKey({ key: record, format: 'jwk' });
  } catch {
    throw new Error('AUTOMATION_ES256_PRIVATE_JWK must be a valid ES256 private JWK');
  }
  return Object.freeze({
    kid: record.kid,
    kty: 'EC',
    crv: 'P-256',
    x: record.x,
    y: record.y,
    d: record.d,
  });
}

function parsePreviousPublicJwks(raw: string | undefined): readonly AccountCredentialsEs256PublicJwk[] {
  const value = (raw ?? '{"keys":[]}').trim() || '{"keys":[]}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS must be public JWKS JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray((parsed as { keys?: unknown }).keys)) {
    throw new Error('AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS must be public JWKS JSON');
  }
  const keys: AccountCredentialsEs256PublicJwk[] = [];
  for (const entry of (parsed as { keys: unknown[] }).keys) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS must contain previous public keys only');
    }
    const record = entry as Record<string, unknown>;
    if (record.d !== undefined) {
      throw new Error('AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS must contain previous public keys only');
    }
    if (
      record.kty !== 'EC'
      || record.crv !== 'P-256'
      || typeof record.kid !== 'string'
      || record.kid.length < 1
      || typeof record.x !== 'string'
      || typeof record.y !== 'string'
    ) {
      throw new Error('AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS must contain previous public keys only');
    }
    try {
      createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: record.x, y: record.y }, format: 'jwk' });
    } catch {
      throw new Error('AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS must contain previous public keys only');
    }
    keys.push(Object.freeze({
      kid: record.kid,
      kty: 'EC',
      crv: 'P-256',
      x: record.x,
      y: record.y,
      use: 'sig',
      alg: 'ES256',
    }));
  }
  return Object.freeze(keys);
}
