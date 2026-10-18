import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { colpCredentialHeaders } from './auth-client.js';
import { SyncFailureError } from './sync-failure-class.js';
import type { SyncAckRequest } from '@know-n/colp/types';
import type { AckIntentRecord } from './sync-state-store.js';
import type { StoredCredential, StoredSession } from './types.js';

export function ackEnvelope(kind: AckIntentRecord['kind'], sessionId: string, cursor: string,
  recoveryCapability?: string, warnings: SyncAckRequest['warnings'] = []) {
  const document: SyncAckRequest = { sessionId, cursor, warnings: [...warnings],
    ...(recoveryCapability === undefined ? {} : { recoveryCapability }) }; const body = canonicalJson(document);
  const intentId = `ack-${digest(warnings.length ? [kind, sessionId, cursor, warnings] : [kind, sessionId, cursor])}`;
  return { intentId, kind, sessionId, cursor, idempotencyKey: intentId, endpointIdentity: 'syncAck' as const,
    mediaType: 'application/json' as const, body, bodyDigest: digestBytes(body) };
}

export function headers(authority: { readonly credential: Pick<StoredCredential, 'accessToken'>; readonly session: StoredSession },
  origin?: string) {
  return { Accept: 'application/json', ...colpCredentialHeaders(authority.credential.accessToken),
    'Known-Sync-Session': authority.session.sessionId, 'Collection-Protocol-Version': '0.2',
    ...(origin ? { Origin: origin } : {}) };
}
export function digest(value: unknown) { return digestBytes(canonicalJson(value)); }
export function digestBytes(value: string) { return bytesToHex(sha256(new TextEncoder().encode(value))); }
export function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new SyncFailureError('canonical_json_invalid'); return encoded; }
export function jsonContentType(response: Response) { return /^application\/json(?:\s*;|$)/iu.test(response.headers.get('Content-Type') ?? ''); }
export function problemContentType(response: Response) { return /^application\/problem\+json(?:\s*;|$)/iu.test(
  response.headers.get('Content-Type') ?? ''); }
