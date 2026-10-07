import { sql, type Kysely } from 'kysely';
import type { ReadingProgressCursorSignerPort, ReadingProgressReadPorts, ReadingProgressReadUnitOfWork,
  ReadingProgressRecord, ReadingProgressResourceType, ReadingProgressStatus,
  ReadingProgressTargetSummaryRow } from '../../modules/reading-progress/index.js';
import { createUnitOfWork, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import {
  buildPublicationBookmarkPublicAccessSql,
  buildPublicationCollectionPublicAccessSql,
} from '../publication/target-access-facts.js';
import type { DatabaseSchema } from '../database/runtime.js';

interface Row { account_id: string; resource_type: ReadingProgressResourceType; resource_id: string;
  status: ReadingProgressStatus; progress: string; revision: number; completed_at: Date | null; created_at: Date; updated_at: Date }
function map(row: Row): ReadingProgressRecord { return { accountId: row.account_id, resourceType: row.resource_type,
  resourceId: row.resource_id, status: row.status, progress: Number(row.progress), revision: row.revision,
  completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at }; }

export function createPostgresReadingProgressReadUnitOfWork(db: Kysely<DatabaseSchema>, options: {
  cursorSigner: ReadingProgressCursorSignerPort; cursorTtlMs?: number;
  cancelBackend?: UnitOfWorkOptions['cancelBackend'];
}): ReadingProgressReadUnitOfWork {
  return { execute: (work, request) => createUnitOfWork(db, {
    ...(request?.signal ? { signal: request.signal } : {}),
    ...(options.cancelBackend ? { cancelBackend: options.cancelBackend } : {}),
  }).execute(async ({ transaction }) => work({
    cursorSigner: options.cursorSigner, ...(options.cursorTtlMs ? { cursorTtlMs: options.cursorTtlMs } : {}),
    clock: { async now() { return (await sql<{ now: Date }>`select current_timestamp now`.execute(transaction)).rows[0]!.now; } },
    reads: {
      async get(input) { const result = await sql<Row>`select account_id,resource_type,resource_id,status,
          progress::text progress,revision,completed_at,created_at,updated_at from reading_progress
          where account_id=${input.accountId} and resource_type=${input.resourceType} and resource_id=${input.resourceId}`.execute(transaction);
        return result.rows[0] ? map(result.rows[0]) : null; },
      async list(input) { const result = await sql<Row>`select account_id,resource_type,resource_id,status,
          progress::text progress,revision,completed_at,created_at,updated_at from reading_progress
          where account_id=${input.accountId}
            and (${input.status ?? null}::text is null or status=${input.status ?? null})
            and (${input.after?.updatedAt ?? null}::timestamptz is null
              or updated_at<${input.after?.updatedAt ?? null}::timestamptz
              or (updated_at=${input.after?.updatedAt ?? null}::timestamptz and
                (resource_type>${input.after?.resourceType ?? null}::text
                  or (resource_type=${input.after?.resourceType ?? null}::text and resource_id>${input.after?.resourceId ?? null}::text))))
          order by updated_at desc,resource_type asc,resource_id asc limit ${input.limit + 1}`.execute(transaction);
        return result.rows.map(map); },
      async hydrateAccessible(input) { if (input.targets.length === 0) return [];
        const requested = JSON.stringify(input.targets);
        const result = await sql<{ resource_type: ReadingProgressResourceType; resource_id: string; collection_id: string; title: string; url: string | null }>`
          with requested as (select * from jsonb_to_recordset(${requested}::jsonb) as x("resourceType" text,"resourceId" text)),
          hydrated as (
            select 'collection'::text resource_type,c.id resource_id,c.id collection_id,c.title,null::text url,
              (c.owner_subject_id=${input.actorSubjectId} or cm.subject_id is not null
                or (${sql.raw(buildPublicationCollectionPublicAccessSql('c'))})) visible
            from requested r join collections c on r."resourceType"='collection' and c.id=r."resourceId" and c.deleted_at is null
            left join collection_members cm on cm.collection_id=c.id and cm.subject_id=${input.actorSubjectId}
            union all
            select 'node'::text,n.id,c.id,n.title,n.url,
              (c.owner_subject_id=${input.actorSubjectId} or cm.subject_id is not null
                or (${sql.raw(buildPublicationBookmarkPublicAccessSql('n', 'c'))})) visible
            from requested r join nodes n on r."resourceType"='node' and n.id=r."resourceId" and n.deleted_at is null
            join collections c on c.id=n.collection_id and c.deleted_at is null
            left join collection_members cm on cm.collection_id=c.id and cm.subject_id=${input.actorSubjectId})
          select resource_type,resource_id,collection_id,title,url from hydrated where visible`.execute(transaction);
        return result.rows.map((row): ReadingProgressTargetSummaryRow => ({ resourceType: row.resource_type,
          resourceId: row.resource_id, collectionId: row.collection_id, title: row.title, url: row.url })); },
    },
  } as ReadingProgressReadPorts)) };
}
