import { createECDH, createHash, hkdfSync } from 'node:crypto';

/**
 * Self-hosted preset (G1).
 *
 * Secret length: COLP_SERVER_SECRET is base64 when the text round-trips as
 * base64; the decoded byte length must be at least 32. Otherwise the UTF-8
 * byte length must be at least 32.
 *
 * Rules relaxed when KNOWN_EDITION is self-hosted, verified by loadConfig()
 * with NODE_ENV=production:
 * - PUBLICATION_CACHE_PURGE_ENDPOINT stays unset. loadConfig already treats a
 *   missing endpoint as "no purge". Worker start skips the production
 *   cache-purge durability refusal when KNOWN_EDITION is self-hosted
 *   (bootstrap/worker.ts). Every other edition still refuses.
 * - KNOWN_CACHE_REQUIRED is forced false and KNOWN_CACHE_MODE is off, so the
 *   cache readiness probe does not require Redis.
 * - Object storage is not configured. Flag-off features that would require a
 *   bucket stay off, so loadConfig does not demand R2 credentials.
 * - KNOWN_FEATURE flags other than MCP read/write/compat, account credentials,
 *   collection history, and link health are false, which skips their
 *   production credential checks.
 * - Sync Sessions are on. SYNC_OAUTH_JWKS_URI is checked with the relaxed
 *   endpoint policy, and the SYNC_OAUTH_* URLs may be loopback http where the
 *   origin may be (bootstrap/config-sync.ts).
 */

export const SECRET_NAMES = [
  'AUTH_RATE_LIMIT_KEY_SECRET',
  'AUTOMATION_CURSOR_HMAC_KEY',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_SESSION_TOKEN_KEYS',
  'BETTER_AUTH_SESSION_TOKEN_LEGACY_READ_UNTIL',
  'COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET',
  'COLLECTION_FOLLOW_RATE_LIMIT_KEY_SECRET',
  'COMMUNITY_CURSOR_HMAC_KEY',
  'EMAIL_CALLBACK_RATE_LIMIT_KEY_SECRET',
  'EMAIL_DM_CALLBACK_HMAC_SECRET',
  'EMAIL_OPS_TOKEN',
  'EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET',
  'EXPORT_R2_READ_SECRET_ACCESS_KEY',
  'EXPORT_R2_SECRET_ACCESS_KEY',
  'FAVICON_CURSOR_HMAC_KEY',
  'FEED_CURSOR_ACTIVE_SECRET',
  'FEED_RATE_LIMIT_KEY_SECRET',
  'FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET',
  'FOLLOW_CURSOR_ACTIVE_SECRET',
  'FOLLOW_RATE_LIMIT_KEY_SECRET',
  'GOVERNANCE_CURSOR_HMAC_KEY',
  'KNOWN_AUTH_MAILBOX_HTTP_TOKEN',
  'KNOWN_INDEXNOW_KEY',
  'LEDGER_ARCHIVE_S3_READER_SECRET_ACCESS_KEY',
  'MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_SECRET',
  'MCP_RATE_LIMIT_KEY_SECRET',
  'MCP_WRITE_REQUEST_STATE_KEY',
  'NOTIFICATION_CURSOR_ACTIVE_SECRET',
  'NOTIFICATION_RATE_LIMIT_KEY_SECRET',
  'OIDC_TEST_PROVIDER_HMAC_SECRET',
  'OIDC_TRANSACTION_HMAC_SECRET',
  'PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY',
  'PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY',
  'PRODUCT_EDITOR_CURSOR_HMAC_KEY',
  'PRODUCT_LINK_HEALTH_CURSOR_HMAC_KEY',
  'PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY',
  'PRODUCT_ROUTE_RATE_LIMIT_KEY_SECRET',
  'PUBLICATION_CACHE_PURGE_BEARER_TOKEN',
  'PUBLICATION_CURSOR_ACTIVE_SECRET',
  'PUBLIC_ACTIVITY_CURSOR_ACTIVE_SECRET',
  'PUBLIC_ACTIVITY_RATE_LIMIT_KEY_SECRET',
  'PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY',
  'PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY',
  'REPORTS_CURSOR_ACTIVE_SECRET',
  'SEARCH_RATE_LIMIT_KEY_SECRET',
  'SYNC_EFFECT_PAGE_RATE_LIMIT_KEY_SECRET',
  'SYNC_PULL_CURSOR_KEY',
  'SYNC_PULL_LINEAGE_KEY',
  'SYNC_RATE_LIMIT_KEY_SECRET',
  'SYNC_RECOVERY_CAPABILITY_KEY',
  'SYNC_SESSION_REPLAY_KEY',
  'SYNC_SNAPSHOT_CURSOR_KEY',
] as const;

export const KEY_ID_NAMES = [
  'EXPORT_R2_ACCESS_KEY_ID',
  'EXPORT_R2_READ_ACCESS_KEY_ID',
  'FEED_CURSOR_ACTIVE_KEY_ID',
  'FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID',
  'FOLLOW_CURSOR_ACTIVE_KEY_ID',
  'LEDGER_ARCHIVE_KMS_KEY_ID',
  'LEDGER_ARCHIVE_S3_READER_ACCESS_KEY_ID',
  'MCP_COLLECTION_RESOURCE_CURSOR_ACTIVE_KEY_ID',
  'NOTIFICATION_CURSOR_ACTIVE_KEY_ID',
  'PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID',
  'PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID',
  'PRODUCT_EDITOR_CURSOR_KEY_ID',
  'PRODUCT_LINK_HEALTH_CURSOR_KEY_ID',
  'PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID',
  'PUBLICATION_CURSOR_ACTIVE_KEY_ID',
  'PUBLIC_ACTIVITY_CURSOR_ACTIVE_KEY_ID',
  'REPORTS_CURSOR_ACTIVE_KEY_ID',
  'SYNC_PULL_CURSOR_KEY_ID',
  'SYNC_PULL_LINEAGE_KEY_ID',
  'SYNC_RECOVERY_CAPABILITY_KEY_ID',
  'SYNC_SNAPSHOT_CURSOR_KEY_ID',
] as const;

export const FEATURE_NAMES = [
  'KNOWN_FEATURE_ACCOUNT_CREDENTIALS',
  'KNOWN_FEATURE_AI_ORGANIZE',
  'KNOWN_FEATURE_BOOKMARK_SUBSCRIPTIONS',
  'KNOWN_FEATURE_CLASSIFICATION',
  'KNOWN_FEATURE_CLASSIFICATION_AUTO_TAGS',
  'KNOWN_FEATURE_CLASSIFICATION_BATCH',
  'KNOWN_FEATURE_CLASSIFICATION_BYOK',
  'KNOWN_FEATURE_CLASSIFICATION_CREDITS',
  'KNOWN_FEATURE_CLASSIFICATION_HOSTNAME_PRIOR',
  'KNOWN_FEATURE_CLASSIFICATION_MANAGED_ADMISSION',
  'KNOWN_FEATURE_CLASSIFICATION_TAGS',
  'KNOWN_FEATURE_CLASSIFY',
  'KNOWN_FEATURE_COLLECTION_FOLLOW',
  'KNOWN_FEATURE_COLLECTION_HISTORY',
  'KNOWN_FEATURE_COMMUNITY',
  'KNOWN_FEATURE_CONTENT_GOVERNANCE',
  'KNOWN_FEATURE_EMAIL',
  'KNOWN_FEATURE_EXPORT_JOBS',
  'KNOWN_FEATURE_FAVICON_POLICY',
  'KNOWN_FEATURE_FEED',
  'KNOWN_FEATURE_FOLLOW',
  'KNOWN_FEATURE_INDEXNOW',
  'KNOWN_FEATURE_LINK_HEALTH',
  'KNOWN_FEATURE_LINK_PREVIEW',
  'KNOWN_FEATURE_MCP_COMPAT',
  'KNOWN_FEATURE_MCP_READ',
  'KNOWN_FEATURE_MCP_WRITE',
  'KNOWN_FEATURE_NOTIFICATIONS',
  'KNOWN_FEATURE_PUBLIC_PROFILE_SHELL',
  'KNOWN_FEATURE_PUBLIC_SHELL_META',
  'KNOWN_FEATURE_READABLE_REPLICA',
  'KNOWN_FEATURE_REPORTS',
  'KNOWN_FEATURE_REPORTS_MCP',
  'KNOWN_FEATURE_REPORTS_MCP_WRITE',
  'KNOWN_FEATURE_REPORTS_PUBLIC',
  'KNOWN_FEATURE_REPORTS_SCHEDULER',
] as const;

export const FEATURES_ON = new Set<string>([
  'KNOWN_FEATURE_MCP_READ',
  'KNOWN_FEATURE_MCP_WRITE',
  'KNOWN_FEATURE_MCP_COMPAT',
  'KNOWN_FEATURE_ACCOUNT_CREDENTIALS',
  'KNOWN_FEATURE_COLLECTION_HISTORY',
  'KNOWN_FEATURE_LINK_HEALTH',
]);

const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const DEFAULT_EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';

export function applySelfHostedPreset(env: NodeJS.ProcessEnv): void {
  const origin = required(env, 'COLP_SERVER_ORIGIN');
  const secretText = required(env, 'COLP_SERVER_SECRET');
  const secret = secretBytes(secretText);
  if (secret.length < 32) {
    throw new Error('COLP_SERVER_SECRET must be at least 32 bytes');
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('COLP_SERVER_ORIGIN must be an absolute origin');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('COLP_SERVER_ORIGIN must be an exact origin');
  }
  // URL.hostname keeps the brackets of an IPv6 literal.
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  // COLP endpoints must be HTTPS; the protocol allows http only on loopback
  // (protocol/docs/02, D26). A LAN without a domain uses tls-internal.
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('COLP_SERVER_ORIGIN may use http:// only on 127.0.0.1, localhost, or [::1]; on a LAN use https:// with the tls-internal profile');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('COLP_SERVER_ORIGIN must be http or https');
  }
  // D4/D27: more accounts open only through invite codes, which arrive in
  // 0.3.0. Until then the switch would open public sign-up, so it is refused.
  if (env.COLP_MULTI_USER?.trim() === 'true') {
    throw new Error('COLP_MULTI_USER=true needs invite codes, which arrive in 0.3.0; set it to false');
  }

  const canonical = url.origin;
  set(env, 'PUBLICATION_ORIGIN', canonical);
  set(env, 'PRODUCT_ORIGIN', canonical);
  const extensionIds = (env.COLP_ALLOWED_EXTENSION_IDS?.trim() || DEFAULT_EXTENSION_ID)
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  // ALLOWED_ORIGINS rejects the chrome-extension scheme. Extension ids go to
  // SYNC_EXTENSION_IDS, which the auth allowlist turns into those origins.
  set(env, 'ALLOWED_ORIGINS', canonical);
  set(env, 'SYNC_EXTENSION_IDS', extensionIds.join(','));
  const serverUuid = uuidV5(canonical, URL_NAMESPACE);
  set(env, 'PUBLICATION_SERVER_UUID', serverUuid);
  set(env, 'MCP_SERVER_UUID', serverUuid);
  set(env, 'MCP_ALLOWED_ORIGINS', canonical);
  set(env, 'MCP_OAUTH_ISSUER', `${canonical}/api/v1/auth`);
  set(env, 'MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL', `${canonical}/.well-known/oauth-authorization-server/api/v1/auth`);
  set(env, 'MCP_OAUTH_JWKS_URI', `${canonical}/api/v1/auth/jwks`);
  set(env, 'MCP_OAUTH_REVOCATION_STORE', 'postgres');
  set(env, 'KNOWN_EDITION', 'self-hosted');
  set(env, 'BETTER_AUTH_ENABLED', 'true');
  set(env, 'BETTER_AUTH_OAUTH_ISSUER_ENABLED', 'true');
  set(env, 'MCP_OAUTH_AUDIENCE', `${canonical}/collections/-/mcp`);
  set(env, 'MCP_OAUTH_SCOPES', 'mcp:read:public,mcp:read:own,collections:read,collections:write,nodes:read,nodes:write,annotations:read,annotations:write,access:write,changes:commit,changes:cancel');
  set(env, 'OIDC_ISSUER', `${canonical}/`);
  set(env, 'OIDC_AUTHORIZATION_ENDPOINT', `${canonical}/api/v1/auth/oauth2/authorize`);
  set(env, 'OIDC_TOKEN_ENDPOINT', `${canonical}/api/v1/auth/oauth2/token`);
  set(env, 'OIDC_JWKS_URI', `${canonical}/api/v1/auth/jwks`);
  // Browser sync (P1). The extension presents its browser session as the
  // Bearer, so the session verifier admits it; JWT access tokens would come
  // from Better Auth. Client id and audience are the extension's build pins.
  // SYNC_SESSION_ENABLED=false turns sync off.
  set(env, 'SYNC_SESSION_ENABLED', 'true');
  set(env, 'SYNC_OAUTH_ISSUER', `${canonical}/api/v1/auth`);
  set(env, 'SYNC_OAUTH_CLIENT_ID', 'known-chromium-extension');
  set(env, 'SYNC_OAUTH_AUDIENCE', 'known-sync-api');
  set(env, 'SYNC_OAUTH_AUTHORIZATION_ENDPOINT', `${canonical}/api/v1/auth/oauth2/authorize`);
  set(env, 'SYNC_OAUTH_TOKEN_ENDPOINT', `${canonical}/api/v1/auth/oauth2/token`);
  set(env, 'SYNC_OAUTH_JWKS_URI', `${canonical}/api/v1/auth/jwks`);
  set(env, 'SYNC_OAUTH_REDIRECT_URI', `https://${extensionIds[0] ?? DEFAULT_EXTENSION_ID}.chromiumapp.org/oauth2`);
  set(env, 'PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT', 'keyed');
  set(env, 'MCP_REQUEST_RATE_LIMIT_MAX', '120');
  set(env, 'MCP_REQUEST_RATE_LIMIT_WINDOW_MS', '60000');
  set(env, 'MCP_WRITE_COMMIT_RATE_LIMIT_MAX', '60');
  set(env, 'MCP_WRITE_COMMIT_RATE_LIMIT_WINDOW_MS', '60000');
  set(env, 'KNOWN_CACHE_MODE', 'off');
  set(env, 'KNOWN_CACHE_REQUIRED', 'false');
  // The bundled Postgres has no TLS. Operators set DATABASE_SSL_MODE=require
  // when the database is external and speaks TLS.
  set(env, 'DATABASE_SSL_MODE', 'disable');
  // Caddy is the only published ingress. Production /ready stays 503 until
  // TRUSTED_INGRESS is declared. RFC1918 covers the compose network; a public
  // client cannot connect to the server container directly. An explicit empty
  // value stays empty and means peer-only.
  if (env.TRUSTED_INGRESS === undefined) {
    env.TRUSTED_INGRESS = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16';
  }
  if (env.COLP_LOG_LEVEL && !env.LOG_LEVEL) set(env, 'LOG_LEVEL', env.COLP_LOG_LEVEL);

  for (const name of FEATURE_NAMES) {
    set(env, name, FEATURES_ON.has(name) ? 'true' : 'false');
  }
  for (const name of KEY_ID_NAMES) set(env, name, 'self-hosted-v1');
  set(env, 'BETTER_AUTH_SESSION_TOKEN_KEYS', `1:${derive(secret, 'BETTER_AUTH_SESSION_TOKEN_KEYS')}`);
  set(env, 'BETTER_AUTH_SESSION_TOKEN_LEGACY_READ_UNTIL', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
  set(env, 'AUTOMATION_ES256_PRIVATE_JWK', automationEs256PrivateJwk(secret));
  // D27: the first sign-up must present this token. It is derived, so the log
  // line and `colp-server setup-token` agree without storage.
  set(env, 'COLP_SETUP_TOKEN', deriveUrl(secret, 'COLP_SETUP_TOKEN'));
  const base64urlSecrets = new Set([
    'GOVERNANCE_CURSOR_HMAC_KEY',
    'AUTOMATION_CURSOR_HMAC_KEY',
    'FAVICON_CURSOR_HMAC_KEY',
  ]);
  for (const name of SECRET_NAMES) {
    set(env, name, base64urlSecrets.has(name) ? deriveUrl(secret, name) : derive(secret, name));
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? '';
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function set(env: NodeJS.ProcessEnv, name: string, value: string): void {
  if (env[name] === undefined || env[name] === '') env[name] = value;
}

function secretBytes(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9+/]+={0,2}$/u.test(trimmed) && trimmed.length % 4 === 0) {
    const decoded = Buffer.from(trimmed, 'base64');
    const again = decoded.toString('base64').replace(/=+$/u, '');
    if (again === trimmed.replace(/=+$/u, '') && decoded.length > 0) return decoded;
  }
  return Buffer.from(trimmed, 'utf8');
}

function derive(secret: Buffer, info: string): string {
  return Buffer.from(deriveBytes(secret, info)).toString('base64');
}

function deriveUrl(secret: Buffer, info: string): string {
  return Buffer.from(deriveBytes(secret, info)).toString('base64url');
}

/**
 * The API-key token signer is derived from the secret, so a restart or an
 * upgrade keeps the same key under the same kid and live tokens stay valid.
 * A derived scalar outside the P-256 range is skipped with a counter.
 */
function automationEs256PrivateJwk(secret: Buffer): string {
  for (let counter = 0; counter < 16; counter += 1) {
    const d = Buffer.from(deriveBytes(secret, `AUTOMATION_ES256_PRIVATE_JWK/${counter}`));
    const ecdh = createECDH('prime256v1');
    try {
      ecdh.setPrivateKey(d);
    } catch {
      continue;
    }
    const point = ecdh.getPublicKey();
    return JSON.stringify({
      kid: 'self-hosted-v1',
      kty: 'EC',
      crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
      d: d.toString('base64url'),
    });
  }
  throw new Error('COLP_SERVER_SECRET did not derive a P-256 key');
}

function deriveBytes(secret: Buffer, info: string): ArrayBuffer {
  return hkdfSync('sha256', secret, Buffer.from('colp-server'), Buffer.from(`${info}/v1`), 32);
}

function uuidV5(name: string, namespace: string): string {
  const hash = createHash('sha1');
  hash.update(uuidBytes(namespace));
  hash.update(name);
  const bytes = Buffer.from(hash.digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/u.test(hex)) throw new Error('fixed UUID namespace is invalid');
  return Buffer.from(hex, 'hex');
}

