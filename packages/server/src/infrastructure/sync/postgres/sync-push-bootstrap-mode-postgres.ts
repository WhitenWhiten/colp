import type { Operation } from '@know-n/colp/types';
import { SyncPushHttpError } from '../../../modules/sync/index.js';
import type { PushSequenceTransaction } from './sync-push-repository-postgres.js';

/** Bootstrap mode constrains initial writes until the replica has acknowledged
 * server authority. It does not make later ordinary synchronization read-only. */
export async function assertBootstrapPushMode(transaction: PushSequenceTransaction, sessionId: string,
  operation: Operation): Promise<void> {
  const row = await transaction.databaseTransaction.selectFrom('sync_sessions as session')
    .innerJoin('sync_replicas as replica', 'replica.replica_id', 'session.replica_id')
    .select(['session.binding_json', 'replica.checkpoint_cursor']).where('session.session_id', '=', sessionId).executeTakeFirst();
  if (!row) throw new SyncPushHttpError('resource_not_found');
  const mode = row.binding_json.bootstrapMode ?? 'merge';
  if (typeof mode !== 'string' || !['download', 'upload', 'merge', 'mirror'].includes(mode)) throw new SyncPushHttpError('internal_error');
  if (row.checkpoint_cursor !== null) return;
  if (mode === 'download' || mode === 'mirror') throw new SyncPushHttpError('insufficient_scope');
  if (mode === 'upload' && operation.type !== 'create_node') throw new SyncPushHttpError('invalid_document');
}
