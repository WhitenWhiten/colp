import {
  canonicalJson,
  decodeCanonicalBase64Url,
  hmacSha256Base64Url,
  parseCursorTimestamp,
  recordWithExactKeys,
  timingSafeEqualText,
} from '../../../commands/index.js';
import { AccountCredentialCursorError } from './errors.js';
import { ACCOUNT_CREDENTIAL_CURSOR_TTL_MS } from './types.js';

const PAYLOAD_KEYS = [
  'afterCreatedAt', 'afterId', 'credentialId', 'endpoint', 'expiresAt', 'issuedAt', 'mac', 'v', 'viewer',
] as const;
const UNSIGNED_KEYS = [
  'afterCreatedAt', 'afterId', 'credentialId', 'endpoint', 'expiresAt', 'issuedAt', 'v', 'viewer',
] as const;

export interface CredentialGrantCursorPayload {
  readonly v: 1;
  readonly endpoint: 'listCredentialGrants';
  readonly viewer: string;
  readonly credentialId: string | null;
  readonly afterCreatedAt: string;
  readonly afterId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface CredentialGrantCursorBinding {
  readonly viewer: string;
  readonly credentialId?: string;
}

export interface CredentialGrantCursorCodec {
  sign(payload: {
    readonly viewer: string;
    readonly credentialId: string | null;
    readonly afterCreatedAt: string;
    readonly afterId: string;
    readonly issuedAt: string;
  }, now: Date): string;
  verify(token: string, now: Date, binding: CredentialGrantCursorBinding): CredentialGrantCursorPayload;
  destroy(): void;
}

export function createCredentialGrantCursorCodec(hmacKeyBase64Url: string): CredentialGrantCursorCodec {
  const key = Buffer.from(hmacKeyBase64Url, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== hmacKeyBase64Url) {
    throw new Error('AUTOMATION_CURSOR_HMAC_KEY must be canonical base64url 32-byte secret');
  }
  let destroyed = false;
  const assertLive = (): Buffer => {
    if (destroyed) throw new AccountCredentialCursorError('invalid_cursor');
    return key;
  };
  return {
    sign(payload, now) {
      const secret = assertLive();
      const unsigned = {
        v: 1 as const,
        endpoint: 'listCredentialGrants' as const,
        viewer: payload.viewer,
        credentialId: payload.credentialId,
        afterCreatedAt: payload.afterCreatedAt,
        afterId: payload.afterId,
        issuedAt: payload.issuedAt,
        expiresAt: new Date(now.getTime() + ACCOUNT_CREDENTIAL_CURSOR_TTL_MS).toISOString(),
      };
      const mac = hmacSha256Base64Url(secret, canonicalJson(unsigned));
      const token = Buffer.from(canonicalJson({ ...unsigned, mac }), 'utf8').toString('base64url');
      if (token.length < 1 || token.length > 2048) throw new AccountCredentialCursorError('invalid_cursor');
      return token;
    },
    verify(token, now, binding) {
      const secret = assertLive();
      if (typeof token !== 'string' || token.length < 1 || token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) {
        throw new AccountCredentialCursorError('invalid_cursor');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(decodeCanonicalBase64Url(token).toString('utf8')) as unknown;
      } catch {
        throw new AccountCredentialCursorError('invalid_cursor');
      }
      if (!recordWithExactKeys(parsed, [...PAYLOAD_KEYS]) || typeof parsed.mac !== 'string') {
        throw new AccountCredentialCursorError('invalid_cursor');
      }
      const { mac, ...unsigned } = parsed;
      const expected = hmacSha256Base64Url(secret, canonicalJson(unsigned));
      if (!timingSafeEqualText(mac, expected)) throw new AccountCredentialCursorError('invalid_cursor');
      if (!recordWithExactKeys(unsigned, [...UNSIGNED_KEYS]) || unsigned.v !== 1
        || unsigned.endpoint !== 'listCredentialGrants'
        || typeof unsigned.viewer !== 'string' || unsigned.viewer !== binding.viewer
        || unsigned.credentialId !== (binding.credentialId ?? null)
        || typeof unsigned.afterCreatedAt !== 'string' || typeof unsigned.afterId !== 'string'
        || typeof unsigned.issuedAt !== 'string' || typeof unsigned.expiresAt !== 'string') {
        throw new AccountCredentialCursorError('invalid_cursor');
      }
      parseCursorTimestamp(unsigned.afterCreatedAt, 'rfc3339-millis');
      parseCursorTimestamp(unsigned.issuedAt, 'rfc3339-millis');
      const expiresAt = parseCursorTimestamp(unsigned.expiresAt, 'rfc3339-millis');
      if (now.getTime() >= expiresAt) throw new AccountCredentialCursorError('snapshot_expired');
      return unsigned as unknown as CredentialGrantCursorPayload;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      key.fill(0);
    },
  };
}
