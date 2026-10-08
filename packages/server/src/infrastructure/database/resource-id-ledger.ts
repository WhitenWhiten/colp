import type { DatabaseTransaction } from './unit-of-work.js';

/**
 * Database-neutral shape of the shared immutable identity ledger.  The
 * collections application owns the public alias, while infrastructure
 * adapters depend on this structural contract to avoid a database -> domain
 * facade edge (and the cycle that would create).
 */
export type ResourceLedgerType =
  | 'collection'
  | 'node'
  | 'annotation'
  | 'relation'
  | 'digest_series'
  | 'digest_edition'
  | 'operation'
  | 'domain-event'
  | 'outbox';

export interface ResourceIdLedgerReserveEntry {
  readonly resourceId: string;
  readonly resourceType: ResourceLedgerType;
}

export interface ResourceIdLedgerPort {
  readonly reserve: (entries: readonly ResourceIdLedgerReserveEntry[]) => Promise<void>;
}

/**
 * The single PostgreSQL adapter for the immutable resource_id_ledger.
 *
 * Report, Collection and outbox code must use this port rather than carrying a
 * private INSERT/ON CONFLICT implementation. Re-reserving an ID with the same
 * namespace is idempotent; a cross-namespace collision fails closed.
 */
export function createPostgresResourceIdLedgerPort(transaction: DatabaseTransaction): ResourceIdLedgerPort {
  return {
    async reserve(entries: readonly ResourceIdLedgerReserveEntry[]): Promise<void> {
      for (const entry of entries) {
        const inserted = await transaction
          .insertInto('resource_id_ledger')
          .values({
            resource_id: entry.resourceId,
            resource_type: entry.resourceType,
            committed_at: null,
          })
          .onConflict((conflict) => conflict.column('resource_id').doNothing())
          .returning('resource_type')
          .executeTakeFirst();
        if (inserted !== undefined) continue;

        const existing = await transaction
          .selectFrom('resource_id_ledger')
          .select('resource_type')
          .where('resource_id', '=', entry.resourceId)
          .executeTakeFirst();
        if (existing?.resource_type !== entry.resourceType) {
          throw new Error(`resource_id_ledger collision for ${entry.resourceId}`);
        }
      }
    },
  };
}
