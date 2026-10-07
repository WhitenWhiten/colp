import { sql, type Kysely } from 'kysely';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import type {
  ModerationAuditPort,
  ModerationRole,
  ModerationRolePorts,
  ModerationRoleStore,
} from '../../modules/governance/index.js';

type Executor = Kysely<DatabaseSchema> | DatabaseTransaction;

export function createPostgresModerationRoleStore(executor: Executor): ModerationRoleStore {
  return {
    async getRoles(accountId) {
      const result = await sql<{ reviewer: boolean; moderator: boolean }>`
        SELECT reviewer, moderator FROM moderation_roles WHERE account_id = ${accountId} LIMIT 1
      `.execute(executor);
      const row = result.rows[0];
      const roles = new Set<ModerationRole>();
      if (row?.reviewer) roles.add('reviewer');
      if (row?.moderator) roles.add('moderator');
      return roles;
    },
    async grant(accountId, role) {
      const now = await databaseNow(executor);
      if (role === 'reviewer') {
        const result = await sql`
          INSERT INTO moderation_roles (account_id, reviewer, moderator, updated_at)
          VALUES (${accountId}, true, false, ${now})
          ON CONFLICT (account_id) DO UPDATE
            SET reviewer = true, updated_at = EXCLUDED.updated_at
          WHERE moderation_roles.reviewer IS NOT TRUE
        `.execute(executor);
        return Number(result.numAffectedRows ?? 0) === 1;
      }
      const result = await sql`
        INSERT INTO moderation_roles (account_id, reviewer, moderator, updated_at)
        VALUES (${accountId}, false, true, ${now})
        ON CONFLICT (account_id) DO UPDATE
          SET moderator = true, updated_at = EXCLUDED.updated_at
        WHERE moderation_roles.moderator IS NOT TRUE
      `.execute(executor);
      return Number(result.numAffectedRows ?? 0) === 1;
    },
    async revoke(accountId, role) {
      const current = await sql<{ reviewer: boolean; moderator: boolean }>`
        SELECT reviewer, moderator FROM moderation_roles WHERE account_id = ${accountId} LIMIT 1
      `.execute(executor);
      const row = current.rows[0];
      if (!row) return false;
      const reviewer = role === 'reviewer' ? false : row.reviewer;
      const moderator = role === 'moderator' ? false : row.moderator;
      if (role === 'reviewer' && !row.reviewer) return false;
      if (role === 'moderator' && !row.moderator) return false;
      if (!reviewer && !moderator) {
        await sql`DELETE FROM moderation_roles WHERE account_id = ${accountId}`.execute(executor);
        return true;
      }
      await sql`
        UPDATE moderation_roles
           SET reviewer = ${reviewer}, moderator = ${moderator}, updated_at = ${await databaseNow(executor)}
         WHERE account_id = ${accountId}
      `.execute(executor);
      return true;
    },
    async accountExists(accountId) {
      const result = await sql<{ id: string }>`
        SELECT id FROM accounts WHERE id = ${accountId} AND deleted_at IS NULL LIMIT 1
      `.execute(executor);
      return result.rows[0] !== undefined;
    },
  };
}

export async function findAccountBySubject(
  executor: Executor,
  subjectId: string,
): Promise<{ accountId: string; subjectId: string } | null> {
  const result = await sql<{ id: string; subject_id: string }>`
    SELECT id, subject_id FROM accounts
     WHERE subject_id = ${subjectId} AND deleted_at IS NULL
     LIMIT 1
  `.execute(executor);
  const row = result.rows[0];
  return row ? { accountId: row.id, subjectId: row.subject_id } : null;
}

export function createPostgresModerationAudit(transaction: DatabaseTransaction): ModerationAuditPort {
  return {
    async append(input) {
      const id = await appendAuditEvent(transaction, {
        operationId: null,
        collectionId: null,
        principalId: input.principalId,
        eventType: input.eventType,
        details: input.details,
      });
      return String(id);
    },
  };
}

export function createPostgresModerationRoleUnitOfWork(
  db: Kysely<DatabaseSchema>,
): { execute<Result>(work: (ports: ModerationRolePorts) => Promise<Result>): Promise<Result> } {
  const base = createUnitOfWork(db);
  return {
    execute: (work) => base.execute(async ({ transaction }) => work({
      roles: createPostgresModerationRoleStore(transaction),
      audit: createPostgresModerationAudit(transaction),
    })),
  };
}
