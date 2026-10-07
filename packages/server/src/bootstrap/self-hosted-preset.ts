/**
 * Translate the small COLP Server environment contract into the environment
 * variables consumed by the extracted Known backend.
 *
 * This module deliberately mutates the supplied environment object rather
 * than returning a second configuration object.  The existing backend reads
 * process.env in a number of independent composition modules, so applying a
 * preset once, before loadConfig(), keeps those modules on one source of
 * truth.  Values supplied by an operator are always left untouched.
 *
 * Self-hosted relaxations (compared with the hosted configuration) are:
 * - the publication cache purge endpoint is optional;
 * - object storage and Redis are not required when their features are off;
 * - KNOWN_CACHE_REQUIRED is false and the in-process cache is used.
 * The readiness implementation must gate these relaxations on
 * KNOWN_EDITION === "self-hosted"; this preset only establishes that marker.
 */

import { createHash, hkdfSync } from 'node:crypto';

const DEFAULT_EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const KEY_ID = 'self-hosted-v1';
const HKDF_SALT = Buffer.from('colp-server', 'utf8');

/** All feature switches known to the self-hosted edition. */
const FEATURE_NAMES = [
  'ACCOUNT_CREDENTIALS',
  'AI_ORGANIZE',
  'BOOKMARK_SUBSCRIPTIONS',
  'CLASSIFICATION',
  'CLASSIFICATION_AI',
  'CLASSIFICATION_AUTO',
  'CLASSIFICATION_EMBEDDINGS',
  'CLASSIFICATION_LLM',
  'CLASSIFICATION_RULES',
  'CLASSIFICATION_SETTINGS',
  'CLASSIFY',
  'COLLECTION_FOLLOW',
  'COLLECTION_HISTORY',
  'COMMUNITY',
  'CONTENT_GOVERNANCE',
  'EMAIL',
  'EXPORT_JOBS',
  'FAVICON_POLICY',
  'FEED',
  'FOLLOW',
  'INDEXNOW',
  'LINK_HEALTH',
  'LINK_PREVIEW',
  'MCP_COMPAT',
  'MCP_READ',
  'MCP_WRITE',
  'NOTIFICATIONS',
  'PUBLIC_PROFILE_SHELL',
  'PUBLIC_SHELL_META',
  'READABLE_REPLICA',
  'REPORTS',
  'REPORTS_AI',
  'REPORTS_DIGESTS',
  'REPORTS_EXPORT',
  'REPORTS_INSIGHTS',
] as const;

/**
 * Known key families in current Known deployments.  The dynamic pass below
 * also catches a newly added key family when it is present in the process
 * environment, so an extraction does not silently use a missing key.
 */
const KEY_FAMILIES = [
  'AUTH',
  'SESSION',
  'MCP',
  'SYNC',
  'PUBLICATION',
  'OAUTH',
  'CSRF',
] as const;

type Environment = NodeJS.ProcessEnv;

function setIfMissing(env: Environment, name: string, value: string): void {
  // An explicitly supplied value, including an empty value, belongs to the
  // operator.  The backend's own validation will report an invalid empty
  // value; silently replacing it here would make that diagnosis impossible.
  if (env[name] === undefined) env[name] = value;
}

function decodeSecret(raw: string): Buffer {
  // Buffer.from(..., "base64") silently ignores malformed characters.  The
  // canonical round-trip check makes a typo fail at startup instead of
  // creating keys that cannot be reproduced after a restart.
  const compact = raw.trim().replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error('COLP_SERVER_SECRET must be base64 encoded and at least 32 bytes');
  }
  const decoded = Buffer.from(compact, 'base64');
  const canonical = decoded.toString('base64').replace(/=+$/, '');
  if (canonical !== compact.replace(/=+$/, '')) {
    throw new Error('COLP_SERVER_SECRET must be base64 encoded and at least 32 bytes');
  }
  if (decoded.byteLength < 32) {
    throw new Error('COLP_SERVER_SECRET must be at least 32 bytes');
  }
  return decoded;
}

function loopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function requireOrigin(env: Environment): URL {
  const raw = env.COLP_SERVER_ORIGIN?.trim();
  if (!raw) throw new Error('COLP_SERVER_ORIGIN is required');
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new Error('COLP_SERVER_ORIGIN must be an absolute http(s) origin');
  }
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') {
    throw new Error('COLP_SERVER_ORIGIN must be an absolute http(s) origin');
  }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('COLP_SERVER_ORIGIN must contain only an origin');
  }
  if (origin.protocol === 'http:' && !loopback(origin.hostname) && env.COLP_INSECURE_HTTP !== 'true') {
    throw new Error('COLP_INSECURE_HTTP=true is required for a non-loopback http:// origin');
  }
  return origin;
}

function uuid5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const digest = createHash('sha1')
    .update(namespaceBytes)
    .update(Buffer.from(name, 'utf8'))
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deriveKey(secret: Buffer, envName: string): string {
  const key = hkdfSync('sha256', secret, HKDF_SALT, Buffer.from(`${envName}/v1`, 'utf8'), 32);
  return Buffer.from(key).toString('base64');
}

function deriveKeyFamily(env: Environment, secret: Buffer, family: string): void {
  setIfMissing(env, `${family}_HMAC_KEY`, deriveKey(secret, `${family}_HMAC_KEY`));
  setIfMissing(env, `${family}_SECRET`, deriveKey(secret, `${family}_SECRET`));
  setIfMissing(env, `${family}_KEY_ID`, KEY_ID);
}

function deriveExistingKeyNames(env: Environment, secret: Buffer): void {
  for (const name of Object.keys(env)) {
    if (!/(?:_HMAC_KEY|_SECRET|_KEY_ID)$/.test(name) || name === 'COLP_SERVER_SECRET') continue;
    if (name.endsWith('_KEY_ID')) setIfMissing(env, name, KEY_ID);
    else setIfMissing(env, name, deriveKey(secret, name));
  }
}

/**
 * Apply the COLP Server contract to an environment before the backend's
 * loadConfig() call.  The same function is safe to call more than once.
 */
export function applySelfHostedPreset(env: Environment = process.env): void {
  const origin = requireOrigin(env);
  const secret = decodeSecret(env.COLP_SERVER_SECRET ?? '');
  const extensionIds = (env.COLP_ALLOWED_EXTENSION_IDS ?? DEFAULT_EXTENSION_ID)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (extensionIds.length === 0) {
    throw new Error('COLP_ALLOWED_EXTENSION_IDS must contain at least one extension id');
  }

  const allowedOrigins = [origin.origin, ...extensionIds.map((id) => `chrome-extension://${id}`)];
  setIfMissing(env, 'PUBLICATION_ORIGIN', origin.origin);
  setIfMissing(env, 'PRODUCT_ORIGIN', origin.origin);
  setIfMissing(env, 'ALLOWED_ORIGINS', allowedOrigins.join(','));
  setIfMissing(env, 'PUBLICATION_SERVER_UUID', uuid5(origin.origin, UUID_NAMESPACE));

  for (const family of KEY_FAMILIES) deriveKeyFamily(env, secret, family);
  deriveExistingKeyNames(env, secret);

  for (const feature of FEATURE_NAMES) {
    const enabled = feature === 'ACCOUNT_CREDENTIALS'
      || feature === 'COLLECTION_HISTORY'
      || feature === 'LINK_HEALTH'
      || feature === 'MCP_COMPAT'
      || feature === 'MCP_READ'
      || feature === 'MCP_WRITE';
    setIfMissing(env, `KNOWN_FEATURE_${feature}`, enabled ? 'true' : 'false');
  }
  setIfMissing(env, 'BETTER_AUTH_OAUTH_ISSUER_ENABLED', 'true');
  setIfMissing(env, 'MCP_OAUTH_AUDIENCE', `${origin.origin}/collections/-/mcp`);
  setIfMissing(env, 'KNOWN_CACHE_MODE', 'off');
  setIfMissing(env, 'KNOWN_CACHE_REQUIRED', 'false');
  setIfMissing(env, 'KNOWN_EDITION', 'self-hosted');
}

export const selfHostedDefaults = Object.freeze({
  extensionId: DEFAULT_EXTENSION_ID,
  keyId: KEY_ID,
  uuidNamespace: UUID_NAMESPACE,
});

