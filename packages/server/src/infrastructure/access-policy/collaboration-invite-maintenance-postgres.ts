import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type {
  CollaborationInviteMaintenancePort,
  CollaborationInviteMaintenancePortFactory,
} from '../../modules/access-policy/index.js';
import { COLLABORATION_INVITE_CLEANUP_BATCH_MAX } from '../../modules/access-policy/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { suppressUnsentInviteDeliveries } from './collaboration-store.js';

function clampInviteCleanupLimit(limit: number): number {
  if (!Number.isSafeInteger(limit)) return 5_000;
  return Math.max(1, Math.min(limit, COLLABORATION_INVITE_CLEANUP_BATCH_MAX));
}

export async function expireOverdueInvitesBatch(
  transaction: DatabaseTransaction,
  now: Date,
  limit: number,
): Promise<number> {
  const batch = clampInviteCleanupLimit(limit);
  const expired = await sql<{ id: string }>`
    WITH candidates AS (
      SELECT id
      FROM collection_invites
      WHERE status = 'pending'
        AND expires_at <= ${now}
      ORDER BY expires_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batch}
    )
    UPDATE collection_invites AS invites
    SET status = 'expired',
        resolved_at = ${now}
    FROM candidates
    WHERE invites.id = candidates.id
      AND invites.status = 'pending'
    RETURNING invites.id
  `.execute(transaction);
  await suppressUnsentInviteDeliveries(transaction, expired.rows.map((row) => row.id), now);
  return expired.rows.length;
}

/** Worker-owned UoW factory; list GETs never compose this port. */
export function createPostgresCollaborationInviteMaintenancePortFactory(
  db: Kysely<DatabaseSchema>,
): CollaborationInviteMaintenancePortFactory {
  return async (): Promise<CollaborationInviteMaintenancePort> => ({
    expireOverdue: (options = {}) => createUnitOfWork(db).execute(({ transaction }) => (
      expireOverdueInvitesBatch(
        transaction,
        options.now ?? new Date(),
        options.limit ?? 5_000,
      )
    )),
  });
}
