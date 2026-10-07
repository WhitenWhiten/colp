import type { AuditPayloadColdSource } from '../../database/audit-event-payload.js';
import type { PostgresSyncConflictFaultPhase, SyncConflictPayloadEncryption } from '../sync-conflict-postgres.js';
import type { SyncOperationEffectFaultPhase } from '../sync-operation-effects-postgres.js';
import type { ReportSourceInvalidationOutboxPort } from '../../outbox/report-source-invalidation-producer.js';
import type { Metrics } from '../../telemetry/index.js';

export type PostgresSyncNodeRestoreFaultPhase =
  | 'recovered_create'
  | 'recovered_effect'
  | 'restore'
  | 'history'
  | 'receipt'
  | 'audit'
  | 'outbox';

export type PostgresSyncNodeCreateFaultPhase =
  | 'ledger'
  | 'node'
  | 'operation'
  | PostgresSyncNodeRestoreFaultPhase
  | SyncOperationEffectFaultPhase
  | 'before_receipt_finalize';

export type PostgresSyncNodeUpdateFaultPhase =
  | 'current_history_loaded'
  | 'node'
  | 'operation'
  | SyncOperationEffectFaultPhase
  | 'before_receipt_finalize';

export type PostgresSyncNodeMoveFaultPhase =
  | 'move_facts_loaded'
  | 'node'
  | 'operation'
  | SyncOperationEffectFaultPhase
  | 'before_receipt_finalize';

export type PostgresSyncNodeDeleteFaultPhase =
  | 'delete_facts_loaded'
  | 'node'
  | 'operation'
  | 'tombstone'
  | SyncOperationEffectFaultPhase
  | 'before_receipt_finalize';

export type PostgresSyncPushFaultPhase = 'sequence_before_commit' | 'sequence_after_commit';

export type { PostgresSyncConflictFaultPhase };

export interface PostgresSyncNodeCreateOptions {
  readonly nodeId?: () => string;
  readonly managedBookmarkWrites?: boolean;
  /** Sync tombstones retain their payload for the configured protocol window. */
  readonly tombstoneRetentionSeconds?: number;
  readonly conflictPayloadEncryption?: SyncConflictPayloadEncryption;
  readonly effectPageAuthority?: string;
  readonly effectPageTemplate?: string;
  readonly auditPayloadColdSource?: AuditPayloadColdSource;
  /** Optional report cache/source-fence fan-out, enabled by API composition. */
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
  readonly metrics?: Metrics;
  readonly faultInjector?: {
    afterPhase?(
      phase: PostgresSyncNodeCreateFaultPhase | PostgresSyncNodeUpdateFaultPhase
        | PostgresSyncNodeMoveFaultPhase | PostgresSyncNodeDeleteFaultPhase
        | PostgresSyncPushFaultPhase | PostgresSyncConflictFaultPhase,
    ): void | Promise<void>;
  };
}
