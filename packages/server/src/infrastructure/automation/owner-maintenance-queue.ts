import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';

export interface OwnerMaintenanceClaim { readonly ownerId: string; readonly generation: string }
export interface OwnerMaintenanceQueue {
  claim(): Promise<OwnerMaintenanceClaim | null>;
  finish(claim: OwnerMaintenanceClaim, succeeded: boolean): Promise<void>;
}

/** Distributed owner leases keep replicas from repeatedly scanning the same accounts. */
export function createPostgresOwnerMaintenanceQueue(db: Kysely<DatabaseSchema>): OwnerMaintenanceQueue {
  return {
    async claim() {
      const result = await sql<{ owner_id: string; lease_generation: string }>`
        WITH candidate AS (
          SELECT owner_id FROM automation_owner_maintenance
          WHERE next_due_at <= clock_timestamp() AND (lease_until IS NULL OR lease_until <= clock_timestamp())
          ORDER BY next_due_at,owner_id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE automation_owner_maintenance queue SET lease_until=clock_timestamp()+interval '5 minutes',
          lease_generation=queue.lease_generation+1 FROM candidate
        WHERE queue.owner_id=candidate.owner_id RETURNING queue.owner_id,queue.lease_generation::text
      `.execute(db);
      const row = result.rows[0];
      return row ? { ownerId: row.owner_id, generation: row.lease_generation } : null;
    },
    async finish(claim, succeeded) {
      await sql`UPDATE automation_owner_maintenance SET lease_until=NULL,
        next_due_at=clock_timestamp()+(${succeeded ? 60 : 5} * interval '1 second')
        WHERE owner_id=${claim.ownerId} AND lease_generation=${BigInt(claim.generation)}`.execute(db);
    },
  };
}

/** A bounded sweep uses independent owner slots; one failure cannot starve the batch. */
export function createOwnerMaintenanceBatch(options: {
  queue: OwnerMaintenanceQueue;
  maintainOwner(ownerId: string): Promise<void>;
  onError(error: unknown): void;
  concurrency?: number;
  batchSize?: number;
}): () => Promise<void> {
  const concurrency = options.concurrency ?? 4;
  const batchSize = options.batchSize ?? 128;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32
      || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1024) {
    throw new RangeError('Invalid owner maintenance capacity');
  }
  return async () => {
    let attempts = 0;
    const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, batchSize) }, async () => {
      while (attempts < batchSize) {
        attempts += 1;
        const claim = await options.queue.claim();
        if (!claim) return;
        let succeeded = false;
        try {
          await options.maintainOwner(claim.ownerId);
          succeeded = true;
        } catch (error) { options.onError(error); }
        finally { await options.queue.finish(claim, succeeded); }
      }
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  };
}
