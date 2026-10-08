import { types as nodeTypes } from 'node:util';

/** Recognizable raw-credential value prefixes used by {@link containsRawSecretMarker}. */
export const RAW_SECRET_PREFIXES: readonly string[] = Object.freeze([
  'Bearer ',
  'Basic ',
  'sk-',
  'pk-live-',
  'pk-test-',
  'colp_live_',
  'colp_test_',
  'ghp_',
  'gho_',
  'glpat-',
  'xoxb-',
  'xoxp-',
  'AKIA',
  'ya29.',
  'eyJ',
] as const);

/** Own-key names treated as raw-credential carriers by {@link containsRawSecretMarker}. */
export const RAW_SECRET_KEY_NAMES: readonly string[] = Object.freeze([
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'secret',
  'clientSecret',
  'client_secret',
  'apiKey',
  'api_key',
  'apikey',
  'password',
  'authorization',
  'Authorization',
  'rawToken',
  'raw_token',
] as const);

/**
 * Heuristic scanner for recognizable raw credential material (tokens, client
 * secrets, API Key values). Used by the strict validators as a defense-in-depth
 * marker check; hosts may also call it on evidence before mapping. Cycle-safe
 * and proxy-safe: Proxies are treated as clean (never trap), and no accessor is
 * ever invoked.
 */
export function containsRawSecretMarker(value: unknown): boolean {
  return scanSecretMarkers(value, new WeakSet<object>(), (text) =>
    RAW_SECRET_PREFIXES.some((prefix) => text.startsWith(prefix)));
}

function scanSecretMarkers(
  value: unknown, seen: WeakSet<object>, isSecret: (text: string) => boolean,
): boolean {
  if (typeof value === 'string') {
    return isSecret(value);
  }
  if (typeof value !== 'object' || value === null || nodeTypes.isProxy(value)) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key !== 'string' || !RAW_SECRET_KEY_NAMES.includes(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor !== undefined
        && 'value' in descriptor
        && descriptor.value !== ''
        && descriptor.value !== null
        && descriptor.value !== undefined
      ) {
        return true;
      }
    }
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor !== undefined
        && 'value' in descriptor
        && scanSecretMarkers(descriptor.value, seen, isSecret)
      ) {
        return true;
      }
    }
    return false;
  } finally {
    seen.delete(value);
  }
}

/** Output strings require credential syntax; business text and opaque cursors are allowed. */
export function containsOutputSecretMarker(value: unknown): boolean {
  return scanSecretMarkers(value, new WeakSet<object>(), isCredentialString);
}

function isCredentialString(value: string): boolean {
  if (/^Bearer [A-Za-z0-9._~+/-]+=*$/iu.test(value)) return true;
  const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/iu.exec(value);
  if (basic !== null) {
    const encoded = basic[1]!;
    const decoded = Buffer.from(encoded, 'base64');
    return decoded.includes(0x3a)
      && decoded.toString('base64').replace(/=+$/u, '') === encoded.replace(/=+$/u, '');
  }
  if (/^AKIA[A-Z0-9]{16}$/u.test(value)) return true;
  if (/^colp_(?:live|test)_[A-Za-z0-9_+\-./~=]+$/u.test(value)) return true;
  if (/^(?:sk-|pk-live-|pk-test-|ghp_|gho_|glpat-|xoxb-|xoxp-|ya29\.)[A-Za-z0-9_+\-./~=]{16,}$/u.test(value)) {
    return true;
  }
  // A base64url JSON cursor is not a JWT/JWE. Require the complete compact
  // serialization and an algorithm-bearing JOSE header before withholding it.
  const parts = value.split('.');
  if ((parts.length !== 3 && parts.length !== 5)
    || !parts.every((part) => /^[A-Za-z0-9_-]*$/u.test(part))
    || !parts[0]?.startsWith('eyJ')) return false;
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return typeof header === 'object' && header !== null && !Array.isArray(header)
      && typeof Object.getOwnPropertyDescriptor(header, 'alg')?.value === 'string';
  } catch {
    return false;
  }
}
