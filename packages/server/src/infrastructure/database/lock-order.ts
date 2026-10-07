import { sql } from 'kysely';
import type { DatabaseTransaction } from './unit-of-work.js';

/**
 * T-10 / U-9 single-transaction lock order.
 *
 * Every backend transaction that writes or locks more than one of the
 * Sync-owned tables must acquire locks in this order:
 *
 *   1. `sync_sessions`
 *   2. `accounts`
 *   3. `sync_extension_credentials`
 *   4. command and sync receipt rows (and their bigint advisory keys)
 *   5. collection replica gate ({@link lockCollectionReplicaGate})
 *   6. `sync_replicas`
 *   7. `collections`
 *   8. `collection_members`
 *   9. `nodes` / `sync_node_tombstones` / `sync_conflicts`
 *  10. `resource_id_ledger`, `operations`, effect pages, outbox, audit
 *
 * The gate is the serialization prefix for product changes, replica
 * register/activate, and Push, session, and recovery state changes on one
 * collection. It is held until commit, so a replica that is not active at the
 * prelock — or that does not exist yet — cannot commit between that scan and
 * the later read-committed invalidation. `lock_timeout` aborts the whole
 * transaction; it is not a partial commit. Deadlock retry stays a recovery
 * net, not the fix. A `hashtext` collision only shares a gate between
 * collections. The two-int key space does not overlap bigint advisory locks.
 *
 * Full table and the accepted exceptions live in
 * `Known-Backend/docs/adr/0027-sync-transaction-lock-order.md`.
 */

/**
 * Dedicated two-int advisory class (`pg_advisory_xact_lock(int, int)`).
 * Kept out of the bigint advisory space used by command receipts and
 * registration locks.
 */
const COLLECTION_REPLICA_GATE_CLASS = 1_263_675_657;

/**
 * Serialize product writes with replica register/activate and with Push,
 * session, and recovery state changes on this collection.
 *
 * Callers that also lock sessions, accounts, credentials, or receipts must
 * take those first. Replica and collection row locks come after this gate.
 */
export async function lockCollectionReplicaGate(
  transaction: DatabaseTransaction,
  collectionId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(${COLLECTION_REPLICA_GATE_CLASS}::int, hashtext(${collectionId}))`
    .execute(transaction);
}

/**
 * Lock this Collection's active Replica rows in a deterministic order.
 *
 * Callers that will later mark replicas `recovery_required` (or otherwise
 * touch `sync_replicas`) must call this before locking `collections`, so two
 * transactions never take the `collections`/`sync_replicas` pair in opposite
 * orders. Ordering by `replica_id` also keeps multi-row lock acquisition
 * stable between concurrent callers.
 */
export async function lockActiveSyncReplicasForCollection(
  transaction: DatabaseTransaction,
  collectionId: string,
): Promise<void> {
  // The active filter stays. Rows that are not active yet, and rows that do
  // not exist yet, are excluded by the gate above, not by a wider prelock.
  await lockCollectionReplicaGate(transaction, collectionId);
  await transaction.selectFrom('sync_replicas').select('replica_id')
    .where('collection_id', '=', collectionId)
    .where('status', '=', 'active')
    .orderBy('replica_id')
    .forUpdate()
    .execute();
}

/**
 * Lock a single Replica row before its Collection row.
 *
 * Used by session/credential/retire/ack paths that authorise against one
 * Replica rather than the whole Collection.
 */
export async function lockSyncReplicaBeforeCollection(
  transaction: DatabaseTransaction,
  replicaId: string,
): Promise<void> {
  const located = await transaction.selectFrom('sync_replicas').select('collection_id')
    .where('replica_id', '=', replicaId)
    .executeTakeFirst();
  if (located) await lockCollectionReplicaGate(transaction, located.collection_id);
  await transaction.selectFrom('sync_replicas').select('replica_id')
    .where('replica_id', '=', replicaId)
    .forUpdate()
    .execute();
}

/**
 * Collection-first command entry points that later mark active replicas
 * `recovery_required` must acquire the Collection lock through this helper
 * instead of locking `collections` directly.
 */
export async function lockCollectionForReplicaInvalidation<Result>(
  transaction: DatabaseTransaction,
  collectionId: string,
  lockCollection: () => Promise<Result>,
): Promise<Result> {
  await lockActiveSyncReplicasForCollection(transaction, collectionId);
  return lockCollection();
}
