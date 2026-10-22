import { createHash } from 'node:crypto';
import { encodeThrowingCanonicalJson } from '../../canonical-json/index.js';
import { createValidatorRegistry } from '@know-n/colp/schema';
import type { ProblemCode } from '@know-n/colp/server';
import type { SyncAckRequest, SyncAckResult } from '@know-n/colp/types';
import type { VerifiedExtensionCredential } from '../../identity/index.js';

export type SyncAckErrorCode = Extract<ProblemCode,
  'invalid_document' | 'invalid_cursor_scope' | 'sync_cursor_expired' | 'stale_replica'
  | 'replica_retired' | 'idempotency_key_reused' | 'idempotency_in_progress'
  | 'insufficient_scope' | 'resource_not_found' | 'internal_error' | 'unsupported_version'>;

export class SyncAckError extends Error {
  constructor(readonly code: SyncAckErrorCode) {
    super(`Sync Ack denied: ${code}`); this.name = 'SyncAckError';
  }
}

export interface SyncAckApplicationInput {
  readonly credential: VerifiedExtensionCredential;
  readonly idempotencyKey: string;
  readonly requestFingerprint?: string;
  readonly origin: string;
  readonly mediaType: 'application/json';
  readonly endpointIdentity: string;
  readonly request: SyncAckRequest;
}

export interface SyncAckApplication {
  acknowledge(input: SyncAckApplicationInput): Promise<SyncAckResult>;
}

const validators = createValidatorRegistry();

export function validateSyncAckInput(input: SyncAckApplicationInput): SyncAckApplicationInput {
  if (!input || typeof input !== 'object' || !validators.validate('syncAckRequest', input.request).valid
      || !/^[A-Za-z0-9._~-]{1,512}$/u.test(input.idempotencyKey)
      || input.mediaType !== 'application/json' || typeof input.origin !== 'string'
      || typeof input.endpointIdentity !== 'string' || input.endpointIdentity.length < 1
      || input.endpointIdentity.length > 512) throw new SyncAckError('invalid_document');
  return input;
}

export function canonicalSyncAckDigest(input: SyncAckApplicationInput): string {
  return createHash('sha256').update(stableJson({ request: input.request,
    origin: input.origin, mediaType: input.mediaType, endpointIdentity: input.endpointIdentity }), 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  return encodeThrowingCanonicalJson(value, {
    keyOrder: 'utf16',
    onInvalid: () => { throw new SyncAckError('invalid_document'); },
  });
}
