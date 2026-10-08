import { readFileSync } from 'node:fs';

/**
 * Shared env parsers used by `loadConfig` and the split config-* loaders.
 * Keep fail-closed messages identical to the pre-split helpers.
 */

export const DEV_EDITOR_CURSOR_KEY = 'dev-product-editor-cursor-hmac-key-change-me';
export const DEV_PUBLICATION_CURSOR_SECRET = Buffer.alloc(32, 17).toString('base64');

export function parseCanonicalUtcTimestamp(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error(`${label} must use canonical RFC 3339 UTC (YYYY-MM-DDTHH:mm:ss[.sss]Z)`);
  }
  const parsed = Date.parse(value);
  const canonicalMillis = Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
  const canonicalSeconds = canonicalMillis.replace(/\.000Z$/, 'Z');
  if (!Number.isFinite(parsed) || (value !== canonicalMillis && value !== canonicalSeconds)) {
    throw new Error(`${label} must be a real canonical RFC 3339 UTC instant`);
  }
  return parsed;
}

export function requireNonEmpty(env: NodeJS.ProcessEnv, key: string, fallback?: string): string {
  const value = env[key]?.trim() || fallback;
  if (!value) throw new Error(`${key} is required`);
  return value;
}

/** Inline env or `KEY_FILE` (absolute path). Never both. File errors omit the path. */
export function requireSecret(env: NodeJS.ProcessEnv, key: string): string {
  const fileKey = `${key}_FILE`;
  const filePath = env[fileKey]?.trim();
  const inline = env[key]?.trim();
  if (filePath && inline) throw new Error(`${key} and ${fileKey} cannot both be set`);
  if (!filePath) {
    if (!inline) throw new Error(`${key} is required`);
    return inline;
  }
  if (!filePath.startsWith('/')) throw new Error(`${fileKey} must be an absolute path`);
  try {
    const value = readFileSync(filePath, 'utf8').replace(/\r?\n$/u, '').trim();
    if (!value) throw new Error(`${key} is required`);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === `${key} is required`) throw error;
    throw new Error(`${fileKey} cannot be read`);
  }
}

export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  label: string,
  options: { readonly allowZero?: boolean; readonly min?: number; readonly max?: number } = {},
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  const min = options.min ?? (options.allowZero ? 0 : 1);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${label} must be a safe integer >= ${min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${label} must be <= ${options.max}`);
  }
  return value;
}

/**
 * Exact origin (scheme + host + optional port). Default ports may be written
 * explicitly (`http://web:80`) so compose-internal URLs stay stable.
 */
export function parseExactOrigin(raw: string, label: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute origin URL`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${label} must be an exact origin`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new Error(`${label} must be an exact origin`);
  }
  const normalized = value.endsWith('/') ? value.slice(0, -1) : value;
  const accepted = new Set<string>([
    `${url.protocol}//${url.host}`,
    `${url.protocol}//${url.hostname}${url.port === '' ? '' : `:${url.port}`}`,
  ]);
  if (url.protocol === 'http:') {
    accepted.add(`http://${url.hostname}`);
    accepted.add(`http://${url.hostname}:80`);
  }
  if (url.protocol === 'https:') {
    accepted.add(`https://${url.hostname}`);
    accepted.add(`https://${url.hostname}:443`);
  }
  if (!accepted.has(normalized)) {
    throw new Error(`${label} must be an exact origin`);
  }
  return normalized;
}

export function parseOrigins(raw: string | undefined, productOrigin: string): readonly string[] {
  if (!raw || raw.trim() === '') return [productOrigin];
  const origins = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (origins.length === 0) return [productOrigin];
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (url.origin !== origin) throw new Error('origin must be exact');
    } catch {
      throw new Error(`ALLOWED_ORIGINS entry is not a valid origin: ${origin}`);
    }
  }
  return Object.freeze(origins);
}

/**
 * Optional chrome-extension origins derived from SYNC_EXTENSION_IDS so the
 * Better Auth Origin/trustedOrigins allowlist can accept the MV3 client.
 * Invalid IDs fail closed with the same message as the sync-session parser.
 */
export function parseChromeExtensionTrustedOrigins(raw: string | undefined): readonly string[] {
  if (!raw || raw.trim() === '') return [];
  const extensionIds = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (extensionIds.some((id) => !/^[a-p]{32}$/u.test(id))) {
    throw new Error('SYNC_EXTENSION_IDS must contain exact Chromium extension IDs');
  }
  return Object.freeze(extensionIds.map((id) => `chrome-extension://${id}`));
}

export function parseCacheBooleanEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = (env[key] ?? (fallback ? 'true' : 'false')).trim().toLowerCase();
  if (raw !== 'true' && raw !== 'false') throw new Error(`${key} must be true or false`);
  return raw === 'true';
}

export function assertRedisUrlScheme(raw: string, label = 'REDIS_URL'): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Never interpolate the raw URL or its credentials into the error.
    throw new Error(`${label} must use redis:// or rediss:// scheme`);
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`${label} must use redis:// or rediss:// scheme`);
  }
  return raw;
}
