import type { ProblemCode } from '@know-n/colp/server';
import type { VerifiedExtensionCredential } from '../identity/index.js';

export type SyncRetireProblemCode = Extract<ProblemCode,
  'replica_retired' | 'stale_replica' | 'idempotency_key_reused' | 'resource_not_found'
  | 'insufficient_scope' | 'service_unavailable' | 'internal_error'>;

export class SyncRetireError extends Error {
  constructor(readonly code: SyncRetireProblemCode) {
    super(`Sync Replica retirement denied: ${code}`);
    this.name = 'SyncRetireError';
  }
}

export interface SyncRetireApplicationInput {
  readonly credential: VerifiedExtensionCredential;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface SyncRetireApplication {
  retireExtension(input: SyncRetireApplicationInput): Promise<void>;
}
