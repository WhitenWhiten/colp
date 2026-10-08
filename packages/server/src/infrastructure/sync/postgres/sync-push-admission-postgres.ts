import type { SequenceCoordinatorResult } from '@know-n/colp/sync';
import type { SyncPushResult } from '@know-n/colp/types';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../../database/runtime.js';
import {
  SyncSessionIssueError,
  SyncPushHttpError,
  type SyncPushHttpApplicationInput,
} from '../../../modules/sync/index.js';
import { SyncSequencePersistenceError } from '../sync-sequence-postgres.js';

export function singleOperation(
  input: SyncPushHttpApplicationInput,
): SyncPushHttpApplicationInput['request']['operations'][number] {
  if (input.request.operations.length !== 1) throw new SyncPushHttpError('invalid_document');
  const operation = input.request.operations[0]!;
  if (input.request.sessionId.length < 1 || operation.collectionId === undefined
      || operation.replicaId.length < 1 || operation.opId.length < 1
      || !Number.isSafeInteger(operation.sequence) || operation.sequence < 1) {
    throw new SyncPushHttpError('invalid_document');
  }
  return operation;
}

export async function coarseConcealment(
  db: Kysely<DatabaseSchema>,
  input: SyncPushHttpApplicationInput,
): Promise<void> {
  const operation = input.request.operations[0]!;
  const identity = await db.selectFrom('account_identities as identity')
    .innerJoin('accounts as account', 'account.id', 'identity.account_id')
    .select(['account.id as account_id', 'account.subject_id', 'account.status'])
    .where('identity.issuer', '=', input.credential.issuer)
    .where('identity.subject', '=', input.credential.subject).executeTakeFirst();
  if (!identity || identity.status !== 'active') throw new SyncPushHttpError('authentication_required');
  const collection = await db.selectFrom('collections').select(['id', 'owner_subject_id', 'deleted_at'])
    .where('id', '=', operation.collectionId!).executeTakeFirst();
  if (!collection || collection.deleted_at !== null) throw new SyncPushHttpError('resource_not_found');
  const member = collection.owner_subject_id === identity.subject_id
    ? 'owner'
    : (await db.selectFrom('collection_members').select('role')
      .where('collection_id', '=', collection.id)
      .where('subject_id', '=', identity.subject_id).executeTakeFirst())?.role;
  if (member !== 'owner' && member !== 'editor') throw new SyncPushHttpError('resource_not_found');
}

/**
 * FIX-L-032: advisory pre-read only. The Sequence owner transaction re-reads
 * the Session/Replica generation from locked rows and classifies the outcome
 * (stale_replica / replica_retired / session_expired / not_found); this read
 * must never decide an external error, so a missing row falls back to the
 * minimum generation instead of surfacing resource_not_found.
 */
export async function sessionLeaseGeneration(db: Kysely<DatabaseSchema>, sessionId: string): Promise<string> {
  const row = await db.selectFrom('sync_sessions').select('lease_generation')
    .where('session_id', '=', sessionId).executeTakeFirst();
  return row ? BigInt(row.lease_generation).toString() : '1';
}

export function mapSessionError(error: unknown): SyncPushHttpError {
  if (!(error instanceof SyncSessionIssueError)) {
    // Preserve the unrecognized cause for the route-level error log; the
    // stable internal_error Problem still hides it from the client.
    return new SyncPushHttpError('internal_error', undefined, undefined, { cause: error });
  }
  switch (error.code) {
    case 'credential_invalid':
    case 'session_expired':
    case 'session_revoked': return new SyncPushHttpError('authentication_required');
    case 'not_found': return new SyncPushHttpError('resource_not_found');
    case 'replica_retired': return new SyncPushHttpError('replica_retired');
    case 'stale_replica':
    case 'replica_expired':
    case 'replica_recovery_required': return new SyncPushHttpError('stale_replica');
    case 'idempotency_key_reuse': return new SyncPushHttpError('idempotency_key_reused');
    case 'integrity_failure': return new SyncPushHttpError('internal_error');
  }
}

export function mapSequenceError(error: SyncSequencePersistenceError): SyncPushHttpError {
  switch (error.code) {
    case 'not_found': return new SyncPushHttpError('resource_not_found');
    case 'idempotency_key_reused': return new SyncPushHttpError('idempotency_key_reused');
    case 'authorization_denied':
    case 'session_expired': return new SyncPushHttpError('authentication_required');
    case 'stale_replica': return new SyncPushHttpError('stale_replica');
    case 'replica_retired': return new SyncPushHttpError('replica_retired');
    case 'receipt_missing':
    case 'integrity_failure': return new SyncPushHttpError('internal_error');
  }
}

export function unwrapCoordinatedResult(
  result: SequenceCoordinatorResult<SyncPushResult>,
): SyncPushResult {
  switch (result.kind) {
    case 'executed':
    case 'replayed': return result.receipt.result;
    case 'sequence_gap': return fail('sequence_gap', result.expectedSequence);
    case 'sequence_blocked': return fail('sequence_blocked', result.expectedSequence);
    case 'sequence_reuse': return fail('sequence_reuse');
    case 'op_id_reused': return fail('op_id_reused');
    default: throw new SyncPushHttpError('internal_error');
  }
}

/** HTTP attempt wrapper only. Does not persist over the stored receipt result. */
export function wrapPushAttemptResult(result: SyncPushResult, serverBatchId: string): SyncPushResult {
  if (result.batchId === serverBatchId) return result;
  return { ...result, batchId: serverBatchId };
}

export function fail(
  code: 'sequence_gap' | 'sequence_blocked' | 'sequence_reuse' | 'op_id_reused',
  expectedSequence?: number,
): never {
  throw new SyncPushHttpError(code, undefined, expectedSequence);
}
