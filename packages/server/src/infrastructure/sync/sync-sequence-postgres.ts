import {
  collectionSequenceScopeKey,
  createSyncHost,
  type SequenceCoordinatorResult,
  type SequenceCoordinatorTransaction,
  type SequenceEvaluation,
  type SequenceEvaluationContext,
  type SequenceLaneKey,
  type SequenceLaneState,
  type SequenceOperationRequest,
  type SequenceReceiptWriteCondition,
  type SyncOperationClaim,
  type SyncOperationReuseAudit,
  type VerifiedSyncSession,
} from '@know-n/colp/sync';
import { sql, type Kysely } from 'kysely';
import {
  canonicalSyncSequenceDigest,
  canonicalSyncSequenceResultDigest,
  presentSequenceReceiptDigestFromStored,
  SYNC_RESOLUTION_LANE_RECEIPT_BINDING,
  SYNC_SEQUENCE_DIGEST_LOGICAL_V2,
  validateSyncResolutionLaneClaim,
  validateSyncSequenceAdmissionInput,
  type SyncResolutionLaneClaim,
  type SyncSequenceAdmissionInput,
} from '../../modules/sync/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  appendAuditEvent,
  AuditPayloadReadError,
  createPostgresAuditPayloadReader,
  type AuditPayloadColdSource,
} from '../database/audit-event-payload.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import {
  assertAuthorityUnexpired,
  lockAuthority,
  lockLane,
  type SequenceAuthority,
} from './sync-sequence-authority-lock.js';
import {
  persistenceError,
  SyncSequencePersistenceError,
  type SyncSequencePersistenceErrorCode,
} from './sync-sequence-persistence-error.js';

export { SyncSequencePersistenceError, type SyncSequencePersistenceErrorCode };
export type { SequenceAuthority };

export type PostgresSyncSequenceFaultPhase =
  | 'locked'
  | 'before_receipt_finalize'
  | 'before_commit'
  | 'after_commit';

export interface PostgresSyncSequenceFaultInjector {
  afterPhase?(phase: PostgresSyncSequenceFaultPhase): void | Promise<void>;
}

export interface PostgresSyncSequencePortOptions {
  readonly faultInjector?: PostgresSyncSequenceFaultInjector;
  readonly auditPayloadColdSource?: AuditPayloadColdSource;
}

export interface StoredSyncSequenceReceipt<Result> {
  readonly operationId: string;
  readonly replicaId: string;
  readonly sequenceScope: string;
  readonly sequence: number;
  readonly digest: string;
  readonly status: 'applied' | 'rebased' | 'noop' | 'conflicted' | 'rejected' | 'deferred';
  readonly result: Result;
}

export interface PostgresSyncSequenceTransaction<Result>
  extends SequenceCoordinatorTransaction<Result> {
  readonly databaseTransaction: DatabaseTransaction;
  readonly authority: Readonly<SequenceAuthority>;
  /** Transaction-local read used by the COLP coordinator and later P3-11 evaluator composition. */
  readReceipt(lane: SequenceLaneKey, sequence: number): Promise<StoredSyncSequenceReceipt<Result> | undefined>;
  /** Inserts only after the shared server-ID ledger reserved the lifecycle Operation ID. */
  claimOperation(claim: SyncOperationClaim): Promise<void>;
  /** Conditional absent/deferred finalization; binding columns are never caller-updatable. */
  finalizeReceipt(
    receipt: StoredSyncSequenceReceipt<Result>,
    condition: SequenceReceiptWriteCondition,
  ): Promise<void>;
}

export interface PostgresSyncSequencePort {
  readonly operationIdReservationOwner: 'sequence';
  coordinate<Result>(
    input: SyncSequenceAdmissionInput,
    evaluate: (
      context: SequenceEvaluationContext<Result>,
      transaction: PostgresSyncSequenceTransaction<Result>,
    ) => Promise<SequenceEvaluation<Result>>,
  ): Promise<{
    readonly session: VerifiedSyncSession;
    readonly result: SequenceCoordinatorResult<Result>;
  }>;
  coordinateAuthorized<Result>(
    input: SyncSequenceAdmissionInput & Required<Pick<SyncSequenceAdmissionInput, 'transactionalAuthority'>>,
    evaluate: (
      context: SequenceEvaluationContext<Result>,
      transaction: PostgresSyncSequenceTransaction<Result>,
    ) => Promise<SequenceEvaluation<Result>>,
  ): Promise<{
    readonly session: VerifiedSyncSession;
    readonly result: SequenceCoordinatorResult<Result>;
  }>;
}

function asSafeSequence(value: unknown, label: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) persistenceError('integrity_failure');
  void label;
  return numeric;
}

function parseClaim(row: Record<string, unknown>): SyncOperationClaim {
  return {
    operationId: String(row.operation_id), digest: String(row.canonical_digest),
    replicaId: String(row.replica_id), sequenceScope: String(row.sequence_scope),
    sequence: asSafeSequence(row.sequence_number, 'claim Sequence'),
  };
}

function parseReuseAudit(value: unknown): SyncOperationReuseAudit | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if ((record.code !== 'sequence_reuse' && record.code !== 'op_id_reused')
      || typeof record.attempted !== 'object' || record.attempted === null
      || typeof record.stored !== 'object' || record.stored === null) return undefined;
  return {
    code: record.code,
    attempted: record.attempted as SyncOperationClaim,
    stored: record.stored as SyncOperationClaim,
  };
}

function createTransactionAdapter<Result>(
  transaction: DatabaseTransaction,
  input: Readonly<SyncSequenceAdmissionInput>,
  authority: SequenceAuthority,
  options: Readonly<PostgresSyncSequencePortOptions>,
): PostgresSyncSequenceTransaction<Result> {
  const requestDigest = canonicalSyncSequenceDigest(input);

  async function readReceipt(
    lane: SequenceLaneKey,
    sequence: number,
  ): Promise<StoredSyncSequenceReceipt<Result> | undefined> {
    const result = await sql<Record<string, unknown>>`
      select replica_id,collection_id,sequence_scope,sequence_number,operation_id,
        canonical_digest,digest_algorithm,session_id,lease_generation,server_batch_id,media_type,
        endpoint_identity,status,result_json,result_digest,retention_policy,
        retained_through_retirement
      from sync_sequence_receipts
      where replica_id=${lane.replicaId} and sequence_scope=${lane.sequenceScope}
        and sequence_number=${sequence}
    `.execute(transaction);
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.collection_id !== authority.collectionId
        || row.retention_policy !== 'replica_lifetime'
        || row.retained_through_retirement !== true
        || canonicalSyncSequenceResultDigest(row.result_json) !== row.result_digest) {
      persistenceError('integrity_failure');
    }
    return {
      operationId: String(row.operation_id),
      replicaId: String(row.replica_id),
      sequenceScope: String(row.sequence_scope),
      sequence: asSafeSequence(row.sequence_number, 'receipt Sequence'),
      digest: presentSequenceReceiptDigestFromStored(row, input),
      status: row.status as StoredSyncSequenceReceipt<Result>['status'],
      result: row.result_json as Result,
    };
  }

  async function claimOperation(claim: SyncOperationClaim): Promise<void> {
    if (claim.replicaId !== input.replicaId || claim.sequenceScope !== input.sequenceScope
        || claim.sequence !== input.sequence || claim.digest !== requestDigest
        || claim.operationId !== input.operationId) persistenceError('integrity_failure');
    await sql`
      insert into sync_sequence_operation_claims (
        operation_id,replica_id,collection_id,sequence_scope,sequence_number,canonical_digest,
        digest_algorithm
      ) values (
        ${claim.operationId},${claim.replicaId},${authority.collectionId},
        ${claim.sequenceScope},${claim.sequence},${claim.digest},
        ${SYNC_SEQUENCE_DIGEST_LOGICAL_V2}
      )
    `.execute(transaction);
  }

  async function finalizeReceipt(
    receipt: StoredSyncSequenceReceipt<Result>,
    condition: SequenceReceiptWriteCondition,
  ): Promise<void> {
    if (receipt.operationId !== input.operationId || receipt.replicaId !== input.replicaId
        || receipt.sequenceScope !== input.sequenceScope || receipt.sequence !== input.sequence
        || receipt.digest !== requestDigest) persistenceError('integrity_failure');
    await options.faultInjector?.afterPhase?.('before_receipt_finalize');
    const resultDigest = canonicalSyncSequenceResultDigest(receipt.result);
    if (condition.kind === 'absent') {
      await sql`
        insert into sync_sequence_receipts (
          replica_id,collection_id,sequence_scope,sequence_number,operation_id,canonical_digest,
          digest_algorithm,session_id,lease_generation,server_batch_id,media_type,endpoint_identity,
          status,result_json,result_digest,finalized_at
        ) values (
          ${receipt.replicaId},${authority.collectionId},${receipt.sequenceScope},${receipt.sequence},
          ${receipt.operationId},${receipt.digest},${SYNC_SEQUENCE_DIGEST_LOGICAL_V2},
          ${input.session.sessionId},
          ${input.leaseGeneration}::bigint,${input.serverBatchId},${input.mediaType},
          ${input.endpointIdentity},${receipt.status},${JSON.stringify(receipt.result)}::jsonb,
          ${resultDigest},case when ${receipt.status}='deferred' then null else current_timestamp end
        )
      `.execute(transaction);
      return;
    }
    if (condition.digest !== requestDigest) persistenceError('integrity_failure');
    const updated = await sql`
      update sync_sequence_receipts set
        status=${receipt.status},result_json=${JSON.stringify(receipt.result)}::jsonb,
        result_digest=${resultDigest},
        finalized_at=case when ${receipt.status}='deferred' then null else current_timestamp end
      where replica_id=${receipt.replicaId} and sequence_scope=${receipt.sequenceScope}
        and sequence_number=${receipt.sequence} and status='deferred'
    `.execute(transaction);
    if (updated.numAffectedRows !== 1n) persistenceError('integrity_failure');
  }

  const adapter: PostgresSyncSequenceTransaction<Result> = {
    databaseTransaction: transaction,
    authority,
    readReceipt,
    claimOperation,
    finalizeReceipt,
    idReservations: {
      async reserveAll(reservations) {
        for (const reservation of reservations) {
          const inserted = await sql<Record<string, unknown>>`
            insert into resource_id_ledger(resource_id,resource_type)
            values (${reservation.id},${reservation.resourceType})
            on conflict (resource_id) do nothing returning resource_id
          `.execute(transaction);
          if (inserted.rows.length === 0) {
            const existing = await sql<Record<string, unknown>>`
              select resource_id,resource_type from resource_id_ledger
              where resource_id=${reservation.id}
            `.execute(transaction);
            const row = existing.rows[0];
            if (!row) persistenceError('integrity_failure');
            return {
              state: 'conflict' as const,
              conflict: {
                requested: reservation,
                existing: {
                  id: String(row.resource_id),
                  resourceType: row.resource_type as typeof reservation.resourceType,
                },
              },
            };
          }
        }
        return { state: 'reserved' as const };
      },
    },
    operationClaims: {
      async load(operationId) {
        const result = await sql<Record<string, unknown>>`
          select operation_id,replica_id,sequence_scope,sequence_number,canonical_digest
          from sync_sequence_operation_claims where operation_id=${operationId}`.execute(transaction);
        if (!result.rows[0]) return undefined;
        const claim = parseClaim(result.rows[0]);
        const receipt = await readReceipt(claim, claim.sequence);
        return receipt ? { ...claim, digest: receipt.digest } : claim;
      },
      save: claimOperation,
    },
    reuseAudits: {
      async append(audit) {
        return String(await appendAuditEvent(transaction, {
          operationId: null, collectionId: null, principalId: authority.accountId,
          eventType: 'sync.sequence.operation_reuse', details: audit as unknown as Record<string, unknown>,
        }));
      },
      async load(key) {
        try {
          const result = await createPostgresAuditPayloadReader(
            transaction, options.auditPayloadColdSource,
          ).read(BigInt(key));
          if (result.eventType !== 'sync.sequence.operation_reuse') return undefined;
          return parseReuseAudit(result.details);
        } catch (error) {
          if (error instanceof AuditPayloadReadError && error.code === 'not_found') return undefined;
          if (error instanceof AuditPayloadReadError) persistenceError('integrity_failure');
          throw error;
        }
      },
    },
    receipts: { load: readReceipt, save: finalizeReceipt },
    async loadLaneState(lane: SequenceLaneKey): Promise<SequenceLaneState | undefined> {
      const result = await sql<Record<string, unknown>>`
        select next_sequence,collection_id,retention_policy,retained_through_retirement
        from sync_sequence_lanes where replica_id=${lane.replicaId}
          and sequence_scope=${lane.sequenceScope}
      `.execute(transaction);
      const row = result.rows[0];
      if (!row) return undefined;
      if (row.collection_id !== authority.collectionId || row.retention_policy !== 'replica_lifetime'
          || row.retained_through_retirement !== true) persistenceError('integrity_failure');
      const nextSequence = asSafeSequence(row.next_sequence, 'next Sequence');
      if (nextSequence > 1) {
        const predecessor = await sql<Record<string, unknown>>`
          select terminal from sync_sequence_receipts where replica_id=${lane.replicaId}
            and sequence_scope=${lane.sequenceScope} and sequence_number=${nextSequence - 1}
        `.execute(transaction);
        if (predecessor.rows[0]?.terminal !== true) persistenceError('receipt_missing');
      }
      return { nextSequence };
    },
    async saveLaneState(lane: SequenceLaneKey, state: SequenceLaneState): Promise<void> {
      const updated = await sql`
        update sync_sequence_lanes set next_sequence=${state.nextSequence}
        where replica_id=${lane.replicaId} and sequence_scope=${lane.sequenceScope}
      `.execute(transaction);
      if (updated.numAffectedRows !== 1n) persistenceError('integrity_failure');
    },
  };
  return adapter;
}

/** Resolver lane claim; Collection is locked before the lane (global lock order). */
export async function claimSyncResolutionLaneSlot(
  transaction: DatabaseTransaction,
  rawClaim: SyncResolutionLaneClaim,
): Promise<number> {
  const claim = validateSyncResolutionLaneClaim(rawClaim);
  const sequenceScope = collectionSequenceScopeKey(claim.collectionId);
  // Lock the Collection before the lane so the global lock order (Collection -> lane ->
  // nodes) matches the Sequence coordinator's own push path and cannot invert against it.
  const collection = await sql<Record<string, unknown>>`
    select id from collections where id=${claim.collectionId} for update
  `.execute(transaction);
  if (!collection.rows[0]) persistenceError('integrity_failure');
  await sql`
    insert into sync_sequence_lanes (replica_id, collection_id, sequence_scope)
    values (${claim.replicaId}, ${claim.collectionId}, ${sequenceScope})
    on conflict (replica_id, sequence_scope) do nothing
  `.execute(transaction);
  const locked = await sql<Record<string, unknown>>`
    select replica_id, collection_id, sequence_scope, next_sequence
    from sync_sequence_lanes
    where replica_id=${claim.replicaId} and sequence_scope=${sequenceScope}
    for update
  `.execute(transaction);
  const lane = locked.rows[0];
  if (!lane || lane.collection_id !== claim.collectionId) persistenceError('integrity_failure');
  const sequence = asSafeSequence(lane.next_sequence, 'resolution lane next Sequence');
  const reserved = await sql<Record<string, unknown>>`
    select resource_id from resource_id_ledger where resource_id=${claim.operationId}
  `.execute(transaction);
  if (!reserved.rows[0]) persistenceError('integrity_failure');
  const session = await sql<Record<string, unknown>>`
    select lease_generation from sync_sessions
    where session_id=${claim.sessionId} and collection_id=${claim.collectionId}
      and replica_id=${claim.replicaId}
  `.execute(transaction);
  const leaseGeneration = session.rows[0]?.lease_generation;
  if (leaseGeneration === undefined) persistenceError('integrity_failure');
  await sql`
    insert into sync_sequence_operation_claims (
      operation_id, replica_id, collection_id, sequence_scope, sequence_number, canonical_digest,
      digest_algorithm
    ) values (
      ${claim.operationId}, ${claim.replicaId}, ${claim.collectionId}, ${sequenceScope},
      ${sequence}, ${claim.canonicalDigest}, ${SYNC_SEQUENCE_DIGEST_LOGICAL_V2}
    )
  `.execute(transaction);
  const resultDigest = canonicalSyncSequenceResultDigest(claim.result);
  await sql`
    insert into sync_sequence_receipts (
      replica_id, collection_id, sequence_scope, sequence_number, operation_id, canonical_digest,
      digest_algorithm, session_id, lease_generation, server_batch_id, media_type, endpoint_identity,
      status, result_json, result_digest, finalized_at
    ) values (
      ${claim.replicaId}, ${claim.collectionId}, ${sequenceScope}, ${sequence},
      ${claim.operationId}, ${claim.canonicalDigest}, ${SYNC_SEQUENCE_DIGEST_LOGICAL_V2},
      ${claim.sessionId}, ${leaseGeneration}::bigint,
      ${`${claim.sessionId}.${SYNC_RESOLUTION_LANE_RECEIPT_BINDING.serverBatchSuffix}`},
      ${SYNC_RESOLUTION_LANE_RECEIPT_BINDING.mediaType},
      ${SYNC_RESOLUTION_LANE_RECEIPT_BINDING.endpointIdentity},
      ${SYNC_RESOLUTION_LANE_RECEIPT_BINDING.status}, ${JSON.stringify(claim.result)}::jsonb,
      ${resultDigest}, current_timestamp
    )
  `.execute(transaction);
  const advanced = await sql`
    update sync_sequence_lanes set next_sequence=${sequence + 1}
    where replica_id=${claim.replicaId} and sequence_scope=${sequenceScope}
  `.execute(transaction);
  if (advanced.numAffectedRows !== 1n) persistenceError('integrity_failure');
  return sequence;
}

export function createPostgresSyncSequencePort(
  db: Kysely<DatabaseSchema>,
  options: PostgresSyncSequencePortOptions = {},
): PostgresSyncSequencePort {
  const coordinate = <Result>(rawInput: SyncSequenceAdmissionInput, evaluate: (
      context: SequenceEvaluationContext<Result>,
      transaction: PostgresSyncSequenceTransaction<Result>,
    ) => Promise<SequenceEvaluation<Result>>, requireAuthority: boolean) => {
      const input = validateSyncSequenceAdmissionInput(rawInput);
      if (requireAuthority && input.transactionalAuthority === undefined) {
        throw new TypeError('Production Sync Sequence admission requires transactional authority');
      }
      const request: SequenceOperationRequest = {
        operationId: input.operationId,
        replicaId: input.replicaId,
        sequenceScope: input.sequenceScope,
        sequence: input.sequence,
        digest: canonicalSyncSequenceDigest(input),
        ...(input.reevaluateDeferred === undefined
          ? {} : { reevaluateDeferred: input.reevaluateDeferred }),
      };
      const unitOfWork = {
        operationIdReservationOwner: 'sequence' as const,
        async execute<Value>(lane: SequenceLaneKey, work: (
          transaction: PostgresSyncSequenceTransaction<Result>,
        ) => Promise<Value>): Promise<Value> {
          return createUnitOfWork(db, {
            faultInjector: {
              async afterCallbackBeforeCommit() {
                await options.faultInjector?.afterPhase?.('before_commit');
              },
              async afterCommitAcknowledged() {
                await options.faultInjector?.afterPhase?.('after_commit');
              },
            },
          }).execute(async ({ transaction }) => {
            if (lane.replicaId !== input.replicaId || lane.sequenceScope !== input.sequenceScope) {
              persistenceError('integrity_failure');
            }
            const locked = await lockAuthority(transaction, input);
            const { authority } = locked;
            await lockLane(transaction, input, authority);
            if (requireAuthority) {
              const priorBatch = await transaction.selectFrom('sync_sequence_receipts')
                .select(['canonical_digest', 'digest_algorithm', 'session_id', 'lease_generation',
                  'server_batch_id', 'media_type', 'endpoint_identity'])
                .where('session_id', '=', input.session.sessionId)
                .where('server_batch_id', '=', input.serverBatchId)
                .forUpdate().executeTakeFirst();
              if (priorBatch
                  && presentSequenceReceiptDigestFromStored(priorBatch, input) !== request.digest) {
                persistenceError('idempotency_key_reused');
              }
            }
            await options.faultInjector?.afterPhase?.('locked');
            await assertAuthorityUnexpired(transaction, locked);
            return work(createTransactionAdapter<Result>(transaction, input, authority, options));
          });
        },
      };
      const host = createSyncHost({ owner: 'sequence', session: input.session });
      return host.sequence(unitOfWork, request, evaluate);
    };
  return {
    operationIdReservationOwner: 'sequence',
    coordinate<Result>(input: SyncSequenceAdmissionInput, evaluate: (
      context: SequenceEvaluationContext<Result>,
      transaction: PostgresSyncSequenceTransaction<Result>,
    ) => Promise<SequenceEvaluation<Result>>) {
      return coordinate(input, evaluate, false);
    },
    coordinateAuthorized<Result>(input: SyncSequenceAdmissionInput
      & Required<Pick<SyncSequenceAdmissionInput, 'transactionalAuthority'>>, evaluate: (
      context: SequenceEvaluationContext<Result>,
      transaction: PostgresSyncSequenceTransaction<Result>,
    ) => Promise<SequenceEvaluation<Result>>) {
      return coordinate(input, evaluate, true);
    },
  };
}
