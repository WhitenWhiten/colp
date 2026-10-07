import { sql, type Kysely } from 'kysely';
import type { SavedResourceCursorSignerPort, SavedResourceReadPorts, SavedResourceReadUnitOfWork,
  SavedResourceTargetSummaryRow } from '../../modules/reading-progress/index.js';
import { createUnitOfWork, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import {
  buildPublicationBookmarkPublicAccessSql,
  buildPublicationCollectionPublicAccessSql,
} from '../publication/target-access-facts.js';
import type { DatabaseSchema } from '../database/runtime.js';

export function createPostgresSavedResourceReadUnitOfWork(db: Kysely<DatabaseSchema>, options: {
  cursorSigner: SavedResourceCursorSignerPort; cursorTtlMs?: number;
  cancelBackend?: UnitOfWorkOptions['cancelBackend'];
}): SavedResourceReadUnitOfWork {
  return { execute: (work, request) => createUnitOfWork(db, {
    ...(request?.signal ? { signal: request.signal } : {}),
    ...(options.cancelBackend ? { cancelBackend: options.cancelBackend } : {}),
  }).execute(async ({ transaction }) => work({
    cursorSigner: options.cursorSigner, ...(options.cursorTtlMs ? { cursorTtlMs: options.cursorTtlMs } : {}),
    clock: { async now() { return (await sql<{ now: Date }>`select current_timestamp now`.execute(transaction)).rows[0]!.now; } },
    reads: {
      async listLive(input) {
        const result = await sql<{ resource_type: 'collection' | 'node'; resource_id: string; saved_at: Date }>`
          select sr.resource_type,sr.resource_id,sr.saved_at from saved_resources sr
          where sr.account_id=${input.accountId} and sr.deleted_at is null
            and (${input.resourceType ?? null}::text is null or sr.resource_type=${input.resourceType ?? null})
            and (${input.createdAfter ?? null}::timestamptz is null or sr.saved_at >= ${input.createdAfter ?? null})
            and (${input.createdBefore ?? null}::timestamptz is null or sr.saved_at < ${input.createdBefore ?? null})
            and (${input.collectionId ?? null}::text is null or
              (sr.resource_type='collection' and sr.resource_id=${input.collectionId ?? null}) or
              (sr.resource_type='node' and exists(select 1 from nodes fn where fn.id=sr.resource_id and fn.collection_id=${input.collectionId ?? null})))
            and (${input.after?.savedAt ?? null}::timestamptz is null or sr.saved_at < ${input.after?.savedAt ?? null}::timestamptz
              or (sr.saved_at=${input.after?.savedAt ?? null}::timestamptz and
                (sr.resource_type > ${input.after?.resourceType ?? null}::text
                  or (sr.resource_type=${input.after?.resourceType ?? null}::text and sr.resource_id > ${input.after?.resourceId ?? null}::text))))
          order by sr.saved_at desc,sr.resource_type asc,sr.resource_id asc limit ${input.limit + 1}`.execute(transaction);
        return result.rows.map((row) => ({ resourceType: row.resource_type, resourceId: row.resource_id, savedAt: row.saved_at }));
      },
      async hydrateAccessible(input) {
        if (input.targets.length === 0) return [];
        const targets = JSON.stringify(input.targets);
        const result = await sql<{ resource_type: 'collection' | 'node'; resource_id: string; collection_id: string; title: string; url: string | null }>`
          with requested as (select * from jsonb_to_recordset(${targets}::jsonb) as x("resourceType" text,"resourceId" text)),
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
        return result.rows.map((row): SavedResourceTargetSummaryRow => ({ resourceType: row.resource_type,
          resourceId: row.resource_id, collectionId: row.collection_id, title: row.title, url: row.url }));
      },
    },
  } as SavedResourceReadPorts)) };
}
