import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type {
  ModerationAppealRecord,
  ModerationAppealStatus,
  ModerationExpiredEvidence,
  ModerationPageRead,
} from '../../modules/governance/index.js';

type Executor = Kysely<DatabaseSchema> | DatabaseTransaction;

interface AppealRow {
  id: string;
  action_id: string;
  appellant_account_id: string;
  description: string;
  status: string;
  resolution: string | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
  decided_by_account_id: string | null;
}

export function createPostgresModerationAppealMethods(executor: Executor): {
  isAffectedOwner(accountId: string, actionId: string): Promise<boolean>;
  insertAppeal(record: ModerationAppealRecord): Promise<'inserted' | 'duplicate_open'>;
  findOpenAppeal(actionId: string): Promise<ModerationAppealRecord | null>;
  getAppeal(appealId: string): Promise<ModerationAppealRecord | null>;
  updateAppeal(record: ModerationAppealRecord, expectedRevision: string): Promise<boolean>;
  listAppellantAppeals(
    appellantAccountId: string,
    read: ModerationPageRead,
  ): Promise<readonly ModerationAppealRecord[]>;
  listOfficialAppeals(read: {
    readonly after?: { readonly createdAt: string; readonly id: string };
    readonly status?: ModerationAppealStatus;
    readonly limit: number;
  }): Promise<readonly ModerationAppealRecord[]>;
  listExpiredEvidence(now: Date, limit: number): Promise<readonly ModerationExpiredEvidence[]>;
  recycleExpiredEvidence(now: Date, limit: number): Promise<number>;
} {
  return {
    async isAffectedOwner(accountId, actionId) {
      // Bind to the action's owner snapshot (stable, captured at create time):
      // deleting or transferring the parent resource must not move or revoke
      // the original owner's appeal/self-service right.
      const result = await sql<{ owned: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM moderation_actions a
           WHERE a.id = ${actionId}
             AND (
               a.owner_account_id = ${accountId}
               OR (a.target_kind = 'account' AND a.target_id = ${accountId})
             )
        ) AS owned
      `.execute(executor);
      return result.rows[0]?.owned === true;
    },
    async insertAppeal(record) {
      try {
        await sql`
          INSERT INTO moderation_appeals (
            id, action_id, appellant_account_id, description, status, resolution,
            revision, created_at, updated_at, decided_by_account_id
          ) VALUES (
            ${record.id},
            ${record.actionId},
            ${record.appellantAccountId},
            ${record.description},
            ${record.status},
            ${record.resolution},
            ${record.revision},
            ${new Date(record.createdAt)},
            ${new Date(record.updatedAt)},
            ${record.decidedByAccountId}
          )
        `.execute(executor);
        return 'inserted';
      } catch (error: unknown) {
        const code = (error as { code?: string }).code
          ?? (error as { cause?: { code?: string } }).cause?.code;
        if (code === '23505') return 'duplicate_open';
        throw error;
      }
    },
    async findOpenAppeal(actionId) {
      const result = await sql<AppealRow>`
        SELECT * FROM moderation_appeals
         WHERE action_id = ${actionId} AND status = 'submitted'
         LIMIT 1
      `.execute(executor);
      const row = result.rows[0];
      return row ? mapAppeal(row) : null;
    },
    async getAppeal(appealId) {
      const result = await sql<AppealRow>`
        SELECT * FROM moderation_appeals WHERE id = ${appealId} LIMIT 1
      `.execute(executor);
      const row = result.rows[0];
      return row ? mapAppeal(row) : null;
    },
    async updateAppeal(record, expectedRevision) {
      const result = await sql`
        UPDATE moderation_appeals
           SET status = ${record.status},
               resolution = ${record.resolution},
               revision = ${record.revision},
               updated_at = ${new Date(record.updatedAt)},
               decided_by_account_id = ${record.decidedByAccountId}
         WHERE id = ${record.id} AND revision = ${expectedRevision}
      `.execute(executor);
      return Number(result.numAffectedRows ?? 0) === 1;
    },
    async listAppellantAppeals(appellantAccountId, read) {
      return listAppeals(executor, read, appellantAccountId);
    },
    async listOfficialAppeals(read) {
      return listAppeals(executor, read, null);
    },
    async listExpiredEvidence(now, limit) {
      const result = await sql<{ id: string; case_id: string; retain_until: Date }>`
        SELECT id, case_id, retain_until
          FROM moderation_evidence
         WHERE retain_until <= ${now}
         ORDER BY retain_until ASC, id ASC
         LIMIT ${limit}
      `.execute(executor);
      return Object.freeze(result.rows.map((row) => Object.freeze({
        id: row.id,
        caseId: row.case_id,
        retainUntil: row.retain_until.toISOString(),
      })));
    },
    async recycleExpiredEvidence(now, limit) {
      const result = await sql<{ id: string }>`
        DELETE FROM moderation_evidence
         WHERE id IN (
           SELECT id FROM moderation_evidence
            WHERE retain_until <= ${now}
            ORDER BY retain_until ASC, id ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
         )
         RETURNING id
      `.execute(executor);
      return result.rows.length;
    },
  };
}

async function listAppeals(
  executor: Executor,
  read: {
    readonly after?: { readonly createdAt: string; readonly id: string };
    readonly status?: string;
    readonly limit: number;
  },
  appellantAccountId: string | null,
): Promise<readonly ModerationAppealRecord[]> {
  const result = await sql<AppealRow>`
    SELECT * FROM moderation_appeals
     WHERE (${appellantAccountId}::text IS NULL OR appellant_account_id = ${appellantAccountId})
       AND (${read.status ?? null}::text IS NULL OR status = ${read.status ?? null})
       AND (
         ${read.after?.createdAt ?? null}::timestamptz IS NULL
         OR (created_at, id) < (${read.after?.createdAt ?? null}::timestamptz, ${read.after?.id ?? ''})
       )
     ORDER BY created_at DESC, id DESC
     LIMIT ${read.limit}
  `.execute(executor);
  return Object.freeze(result.rows.map(mapAppeal));
}

function mapAppeal(row: AppealRow): ModerationAppealRecord {
  return Object.freeze({
    id: row.id,
    actionId: row.action_id,
    appellantAccountId: row.appellant_account_id,
    description: row.description,
    status: row.status as ModerationAppealStatus,
    resolution: row.resolution,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    decidedByAccountId: row.decided_by_account_id,
  });
}
