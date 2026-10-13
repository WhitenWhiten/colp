import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { ExecutionPolicy } from '@know-n/colp/automation';
import type { ExecutionPolicyStore } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { touchAutomationConfiguration } from './configuration-epoch.js';

interface PolicyRow { id: string; revision: string; configuration: ExecutionPolicy['configuration']; created_at: string }
export function createExecutionPolicyStore(tx: DatabaseTransaction, ownerId: string): ExecutionPolicyStore {
  const view = (row: PolicyRow): ExecutionPolicy => ({ id: row.id, revision: String(row.revision), configuration: row.configuration });
  const select = sql`SELECT p.id,v.revision::text,v.configuration_json AS configuration,
    to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
    FROM automation_execution_policies p JOIN automation_execution_policy_revisions v ON v.policy_id=p.id WHERE p.owner_id=${ownerId}`;
  return {
    async load(id, revision) {
      const row = (await sql<PolicyRow>`${select} AND p.id=${id} AND v.revision=${revision ? sql`${revision}::bigint` : sql`p.current_revision`}`.execute(tx)).rows[0];
      return row ? view(row) : null;
    },
    async list(after, limit) {
      const cursor = after ? sql`AND (p.created_at,p.id)<(${after.createdAt}::timestamptz,${after.id})` : sql``;
      return (await sql<PolicyRow>`${select} AND v.revision=p.current_revision ${cursor} ORDER BY p.created_at DESC,p.id DESC LIMIT ${limit}`.execute(tx)).rows
        .map(row => ({ view: view(row), createdAt: row.created_at }));
    },
    async save(configuration, id) {
      const key = id ?? randomUUID();
      const row = (await sql<{ revision: string }>`INSERT INTO automation_execution_policies(id,owner_id,current_revision) VALUES(${key},${ownerId},1)
        ON CONFLICT(id) DO UPDATE SET current_revision=automation_execution_policies.current_revision+1
          WHERE automation_execution_policies.owner_id=${ownerId} RETURNING current_revision::text AS revision`.execute(tx)).rows[0]!;
      await sql`INSERT INTO automation_execution_policy_revisions(policy_id,revision,configuration_json)
        VALUES(${key},${row.revision}::bigint,${JSON.stringify(configuration)}::jsonb)`.execute(tx);
      await touchAutomationConfiguration(tx, ownerId);
      return { id: key, revision: row.revision, configuration };
    },
  };
}
