import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { VerifiedSyncSession } from '@know-n/colp/sync';
import type { SyncPushResult } from '@know-n/colp/types';
import type { DatabaseSchema } from '../../database/runtime.js';
import { SyncPushHttpError, type SyncPushHttpApplicationInput } from '../../../modules/sync/index.js';
import type { PostgresSyncSessionIssuer } from '../sync-session-postgres.js';
import { coarseConcealment, mapSessionError } from './sync-push-admission-postgres.js';

/**
 * Non-atomic transport batching keeps each Operation's existing transaction.
 * Batch members use opId as their individual idempotency key, so a lost batch
 * response can be recovered with the original singleton attempts. The outer
 * key is separately bound to the complete ordered array before any mutation.
 */
export async function admitPushBatch(
  db: Kysely<DatabaseSchema>, issuer: PostgresSyncSessionIssuer,
  input: SyncPushHttpApplicationInput,
  admitSingle: (input: SyncPushHttpApplicationInput, session: VerifiedSyncSession) => Promise<SyncPushResult>,
): Promise<SyncPushResult> {
  const operations = input.request.operations;
  const first = operations[0];
  if (!first || operations.length > 50 || !first.collectionId
      || (operations.length > 1 && input.request.atomic)
      || new Set(operations.map((op) => op.opId)).size !== operations.length
      || operations.some((op, index) => op.collectionId !== first.collectionId
        || op.replicaId !== first.replicaId || op.sequence !== first.sequence + index)) {
    throw new SyncPushHttpError('invalid_document');
  }
  await coarseConcealment(db, input);
  let session: VerifiedSyncSession;
  try {
    session = await issuer.verify({ credential: input.credential, sessionId: input.request.sessionId,
      collectionId: first.collectionId, replicaId: first.replicaId });
  } catch (error) { throw mapSessionError(error); }
  if (operations.length > 1) {
    const replica = await db.selectFrom('sync_replicas').select('capabilities_json')
      .where('replica_id', '=', first.replicaId).executeTakeFirst();
    if (!replica || operations.length > Number(replica.capabilities_json.maxBatchOperations)) {
      throw new SyncPushHttpError('invalid_document');
    }
  }
  // Exclude the Session/batch wrapper, just as the existing Sequence digest
  // does. Credential renewal may rewrap identical Operation bytes.
  const digest = createHash('sha256').update(canonicalJson({
    atomic: input.request.atomic, operations,
  })).digest('base64url');
  const binding = await sql`insert into sync_push_request_bindings
      (session_id, endpoint_identity, idempotency_key, request_digest)
    values (${input.request.sessionId}, ${input.endpointIdentity}, ${input.idempotencyKey}, ${digest})
    on conflict (session_id, endpoint_identity, idempotency_key) do update
      set request_digest = excluded.request_digest
      where sync_push_request_bindings.request_digest = excluded.request_digest
    returning session_id`.execute(db);
  if (binding.rows.length !== 1) throw new SyncPushHttpError('idempotency_key_reused');
  if (operations.length === 1) return admitSingle(input, session);

  const results: SyncPushResult['results'] = [];
  let serverCursor = 'sync-unchanged';
  for (const operation of operations) {
    // Errors leave the committed prefix intact. No later operation is tried;
    // callers replay singleton receipts to discover that prefix safely.
    const result = await admitSingle({ ...input, idempotencyKey: operation.opId,
      request: { ...input.request, operations: [operation] } }, session);
    results.push(...result.results);
    if (result.serverCursor !== 'sync-unchanged') serverCursor = result.serverCursor;
  }
  return { batchId: input.request.batchId, results, serverCursor };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
