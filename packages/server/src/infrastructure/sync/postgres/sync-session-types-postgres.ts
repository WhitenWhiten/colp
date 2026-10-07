import type {
  ActiveSyncSessionRecord,
  VerifiedSyncSession,
} from '@know-n/colp/sync';
import type { Selectable } from 'kysely';
import type { VerifiedExtensionCredential } from '../../../modules/identity/index.js';
import type {
  SyncPullCursorKeyring,
  SyncSessionIssueInput,
  SyncSessionIssueResult,
  SyncSessionVerifyInput,
} from '../../../modules/sync/index.js';
import type {
  SyncReplicaTable,
} from '../../database/runtime.js';
import type { DatabaseTransaction } from '../../database/unit-of-work.js';
import type { ReplicaRetentionWindowPort } from '../replica-lifecycle-postgres.js';

export type SyncSessionIssueFaultPhase =
  | 'receipt' | 'generation' | 'session' | 'binding' | 'lease' | 'audit' | 'finalize';

export interface SyncSessionIssueFaultInjector {
  afterPhase?(phase: SyncSessionIssueFaultPhase): void | Promise<void>;
}

export interface SyncSessionIdGenerator {
  sessionId(): string;
  batchBindingSecret(): string;
  endpointCapability(): string;
}

export interface PostgresSyncSessionIssuerOptions {
  readonly issuer: string;
  /** Closed issuer set emitted by the configured composite credential verifier. */
  readonly acceptedIssuers?: readonly string[];
  readonly audience: string;
  readonly clientId: string;
  readonly replayEncryptionKey: Buffer;
  readonly replayEncryptionKeyVersion: number;
  readonly sessionDurationSeconds: number;
  readonly replicaLeaseExtensionSeconds: number;
  readonly tombstoneRetentionSeconds: number;
  readonly maxBatchOperations: 1;
  readonly endpointCapabilities: readonly string[];
  readonly retentionWindow?: ReplicaRetentionWindowPort;
  readonly pullCursorKeyring?: SyncPullCursorKeyring;
  readonly recoveryProofRetentionMs?: number;
  readonly resumedLeaseId?: () => string;
  readonly ids?: SyncSessionIdGenerator;
  readonly faultInjector?: SyncSessionIssueFaultInjector;
}

export interface PostgresSyncSessionIssuer {
  issue(input: SyncSessionIssueInput): Promise<SyncSessionIssueResult>;
  issueInTransaction(
    transaction: DatabaseTransaction,
    input: SyncSessionIssueInput,
  ): Promise<PostgresSyncSessionIssueTransactionOutcome>;
  completeIssue(outcome: PostgresSyncSessionIssueTransactionOutcome): SyncSessionIssueResult;
  verify(input: SyncSessionVerifyInput): Promise<VerifiedSyncSession>;
}

export interface ValidatedOptions extends PostgresSyncSessionIssuerOptions {
  readonly acceptedIssuers: readonly string[];
  readonly ids: SyncSessionIdGenerator;
  readonly faultInjector: SyncSessionIssueFaultInjector;
  readonly endpointCapabilities: readonly string[];
  readonly resumedLeaseId: () => string;
}

export interface Authority {
  readonly accountId: string;
  readonly subjectId: string;
  readonly securityEpoch: bigint;
  readonly role: 'owner' | 'editor' | 'viewer';
  readonly policyRevision: string;
  readonly contentRevision: string;
  readonly commitOrdinal: bigint;
  readonly replica: Selectable<SyncReplicaTable>;
  readonly now: Date;
}

export interface SessionAuthority {
  readonly accountId: string;
  readonly principalSubjectId: string;
  readonly credential: VerifiedExtensionCredential;
  readonly origin: string;
  readonly collectionId: string;
  readonly replica: Selectable<SyncReplicaTable>;
  readonly lifecycleRevision: bigint;
  readonly policyRevision: string;
  readonly accountSecurityEpoch: bigint;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly secretDigest: string;
  readonly capabilityDigest: string;
  readonly faultInjector: SyncSessionIssueFaultInjector;
}

export interface EncryptedEnvelope {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly digest: string;
}

export interface PostgresSyncSessionCommittedDenial {
  readonly state: 'denied_after_commit';
  readonly code: 'replica_recovery_required' | 'credential_invalid' | 'session_expired' | 'session_revoked';
  readonly snapshotUrl: string | null;
}

export type PostgresSyncSessionIssueTransactionOutcome =
  SyncSessionIssueResult | PostgresSyncSessionCommittedDenial;
export type IssueTransactionOutcome = PostgresSyncSessionIssueTransactionOutcome;
export type VerifyTransactionOutcome = VerifiedSyncSession | PostgresSyncSessionCommittedDenial;

export type SyncAuthorizationScope = ActiveSyncSessionRecord['authorizationScopes'][number];

export function isCommittedIssueDenial(value: unknown): value is PostgresSyncSessionCommittedDenial {
  return typeof value === 'object' && value !== null
    && (value as { readonly state?: unknown }).state === 'denied_after_commit';
}
