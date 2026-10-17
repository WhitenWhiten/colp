import { sql, type Kysely } from 'kysely';
import type { FaviconJobActivityRecord } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { JOB_COLUMNS, mapJob, type JobRow } from './favicon-job-postgres.js';

export async function findActiveFaviconJobs(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
  accountId: string,
): Promise<FaviconJobActivityRecord> {
  const { rows } = await sql<JobRow & { active_jobs: number }>`
    SELECT ${JOB_COLUMNS}, count(*) OVER ()::int AS active_jobs
    FROM favicon_jobs
    WHERE account_id = ${accountId} AND status IN ('pending', 'running')
    ORDER BY (operation = 'refresh_one'), created_at, id
    LIMIT 1
  `.execute(transaction);
  const row = rows[0];
  return row ? { activeJobs: row.active_jobs, job: mapJob(row) } : { activeJobs: 0, job: null };
}
