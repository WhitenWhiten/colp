import type { ProblemCode } from '@know-n/colp/server';
import type { SyncTransportBudget } from '@know-n/colp/sync';
import type {
  SyncSessionRequest, SyncSessionRequestV02, SyncSessionResult, SyncSessionResultV02,
} from '@know-n/colp/types';
import type { VerifiedExtensionCredential } from '../identity/index.js';

export interface SyncSessionHttpApplicationInput {
  readonly credential: VerifiedExtensionCredential;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly origin: string;
  readonly request: SyncSessionRequest | SyncSessionRequestV02;
}

export interface SyncSessionHttpApplication {
  issue(input: SyncSessionHttpApplicationInput): Promise<{
    readonly state: 'issued' | 'replayed';
    readonly response: SyncSessionResult | SyncSessionResultV02;
    readonly transportBudget?: SyncTransportBudget;
  }>;
}

/** Stable, message-free denial passed from the application adapter to COLP transport mapping. */
export class SyncSessionHttpError extends Error {
  constructor(
    public readonly code: ProblemCode,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Sync Session HTTP request denied: ${code}`);
    this.name = 'SyncSessionHttpError';
  }
}
