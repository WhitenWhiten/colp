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
import type { AccountCredentialKind } from './secret.js';
import type { AccountCredentialState } from './types.js';

export { AccountCredentialCursorError } from './errors.js';

const PAYLOAD_KEYS = [
  'afterCreatedAt', 'afterId', 'endpoint', 'expiresAt', 'issuedAt', 'kind', 'mac', 'state', 'v', 'viewer',
] as const;
const UNSIGNED_KEYS = [
  'afterCreatedAt', 'afterId', 'endpoint', 'expiresAt', 'issuedAt', 'kind', 'state', 'v', 'viewer',
] as const;

export type AccountCredentialCursorEndpoint = 'listMyCredentials' | 'listChildrenWithParentKey';

export interface AccountCredentialCursorPayload {
  readonly v: 1;
  readonly endpoint: AccountCredentialCursorEndpoint;
  readonly viewer: string;
  readonly kind: AccountCredentialKind | null;
  readonly state: AccountCredentialState | null;
  readonly afterCreatedAt: string;
  readonly afterId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface UnsignedAccountCredentialCursorPayload {
  readonly endpoint: AccountCredentialCursorEndpoint;
  readonly viewer: string;
  readonly kind: AccountCredentialKind | null;
  readonly state: AccountCredentialState | null;
  readonly afterCreatedAt: string;
  readonly afterId: string;
  readonly issuedAt: string;
}

export interface AccountCredentialCursorBinding {
  readonly endpoint: AccountCredentialCursorEndpoint;
  readonly viewer: string;
  readonly kind?: AccountCredentialKind;
  readonly state?: AccountCredentialState;
}

export interface AccountCredentialCursorCodec {
  sign(payload: UnsignedAccountCredentialCursorPayload, now: Date): string;
  verify(token: string, now: Date, binding: AccountCredentialCursorBinding): AccountCredentialCursorPayload;
  destroy(): void;
}

export function createAccountCredentialCursorCodec(hmacKeyBase64Url: string): AccountCredentialCursorCodec {
  const key = decodeCursorHmacKey(hmacKeyBase64Url);
  let destroyed = false;
  const assertLive = (): Buffer => {
    if (destroyed) throw new AccountCredentialCursorError('invalid_cursor');
    return key;
  };
  return {
    sign(payload, now) {
      const secret = assertLive();
      const issuedAt = now.toISOString();
      const unsigned = {
        v: 1 as const,
        endpoint: payload.endpoint,
        viewer: payload.viewer,
        kind: payload.kind,
        state: payload.state,
        afterCreatedAt: payload.afterCreatedAt,
        afterId: payload.afterId,
        issuedAt,
        expiresAt: new Date(now.getTime() + ACCOUNT_CREDENTIAL_CURSOR_TTL_MS).toISOString(),
      };
      validateUnsigned(unsigned);
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
        const decoded = decodeCanonicalBase64Url(token);
        parsed = JSON.parse(decoded.toString('utf8')) as unknown;
      } catch {
        throw new AccountCredentialCursorError('invalid_cursor');
      }
      if (!recordWithExactKeys(parsed, [...PAYLOAD_KEYS]) || typeof parsed.mac !== 'string') {
        throw new AccountCredentialCursorError('invalid_cursor');
      }
      const { mac, ...unsigned } = parsed;
      const expected = hmacSha256Base64Url(secret, canonicalJson(unsigned));
      if (!timingSafeEqualText(mac, expected)) throw new AccountCredentialCursorError('invalid_cursor');
      const payload = validateUnsigned(unsigned);
      if (
        payload.endpoint !== binding.endpoint
        || payload.viewer !== binding.viewer
        || payload.kind !== (binding.kind ?? null)
        || payload.state !== (binding.state ?? null)
      ) {
        throw new AccountCredentialCursorError('invalid_cursor');
      }
      const nowMs = now.getTime();
      const expiresAt = parseCursorTimestamp(payload.expiresAt, 'rfc3339-millis');
      if (nowMs >= expiresAt) throw new AccountCredentialCursorError('snapshot_expired');
      return payload;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      key.fill(0);
    },
  };
}

function decodeCursorHmacKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== value) {
    throw new Error('AUTOMATION_CURSOR_HMAC_KEY must be canonical base64url 32-byte secret');
  }
  return key;
}

function validateUnsigned(value: unknown): AccountCredentialCursorPayload {
  if (!recordWithExactKeys(value, [...UNSIGNED_KEYS])) throw new AccountCredentialCursorError('invalid_cursor');
  if (value.v !== 1 || (value.endpoint !== 'listMyCredentials' && value.endpoint !== 'listChildrenWithParentKey')) {
    throw new AccountCredentialCursorError('invalid_cursor');
  }
  if (typeof value.viewer !== 'string' || value.viewer.length < 1 || value.viewer.length > 128) {
    throw new AccountCredentialCursorError('invalid_cursor');
  }
  if (value.kind !== null && value.kind !== 'parent' && value.kind !== 'child') {
    throw new AccountCredentialCursorError('invalid_cursor');
  }
  if (value.state !== null && value.state !== 'active' && value.state !== 'revoked' && value.state !== 'expired') {
    throw new AccountCredentialCursorError('invalid_cursor');
  }
  if (typeof value.afterId !== 'string' || value.afterId.length < 1) {
    throw new AccountCredentialCursorError('invalid_cursor');
  }
  if (typeof value.afterCreatedAt !== 'string' || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') {
    throw new AccountCredentialCursorError('invalid_cursor');
  }
  parseCursorTimestamp(value.afterCreatedAt, 'rfc3339-millis');
  parseCursorTimestamp(value.issuedAt, 'rfc3339-millis');
  parseCursorTimestamp(value.expiresAt, 'rfc3339-millis');
  return value as unknown as AccountCredentialCursorPayload;
}
