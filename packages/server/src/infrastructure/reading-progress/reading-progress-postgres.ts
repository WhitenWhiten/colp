import { sql, type Kysely } from 'kysely';
import type { ReadingProgressCommandPorts, ReadingProgressRecord,
  ReadingProgressResourceType, ReadingProgressStatus } from '../../modules/reading-progress/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import { createUnitOfWork, type DatabaseTransaction, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import {
  buildPublicationBookmarkPublicAccessSql,
  buildPublicationCollectionPublicAccessSql,
} from '../publication/target-access-facts.js';
import type { DatabaseSchema } from '../database/runtime.js';

export type ReadingProgressWritePhase = 'receipt' | 'resource' | 'audit' | 'complete';
export interface ReadingProgressFaultContext { readonly phase: ReadingProgressWritePhase }
export interface ReadingProgressFaultInjector {
  afterPhase?(context: ReadingProgressFaultContext): void | Promise<void>;
}
export interface PostgresReadingProgressUnitOfWorkOptions {
  readonly faultInjector?: ReadingProgressFaultInjector;
  readonly cancelBackend?: UnitOfWorkOptions['cancelBackend'];
}
export interface PostgresReadingProgressUnitOfWork {
  execute<Result>(
    work: (ports: ReadingProgressCommandPorts) => Promise<Result>,
    request?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

interface ReadingProgressRow {
  account_id: string; resource_type: string; resource_id: string; status: string; progress: string;
  revision: number; completed_at: Date | null; created_at: Date; updated_at: Date;
}
function mapRow(row: ReadingProgressRow): ReadingProgressRecord {
  return { accountId: row.account_id, resourceType: row.resource_type as ReadingProgressResourceType,
    resourceId: row.resource_id, status: row.status as ReadingProgressStatus, progress: Number(row.progress),
    revision: row.revision, completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

function portsFor(transaction: DatabaseTransaction,
  fault?: ReadingProgressFaultInjector): ReadingProgressCommandPorts {
  const receipts = createPostgresProductCommandReceiptPort(transaction);
  return {
    receipts: {
      async claim(binding, fingerprint) {
        const result = await receipts.claim(binding, fingerprint);
        if (result.kind === 'claimed') await fault?.afterPhase?.({ phase: 'receipt' });
        return result;
      },
      async complete(binding, fingerprint, result) {
        await receipts.complete(binding, fingerprint, result);
        await fault?.afterPhase?.({ phase: 'complete' });
      },
      purgeExpired: receipts.purgeExpired.bind(receipts),
      deletePrincipalReceipts: receipts.deletePrincipalReceipts.bind(receipts),
    },
    targets: { async resolveAccessible(input) {
      const result = input.resourceType === 'collection'
        ? await sql<{ resource_id: string; collection_id: string; visible: boolean }>`
          select c.id resource_id,c.id collection_id,
            (c.owner_subject_id=${input.actorSubjectId} or m.subject_id is not null
             or (${sql.raw(buildPublicationCollectionPublicAccessSql('c'))})) visible
          from collections c left join collection_members m
            on m.collection_id=c.id and m.subject_id=${input.actorSubjectId}
          where c.id=${input.resourceId} and c.deleted_at is null for share of c`.execute(transaction)
        : await sql<{ resource_id: string; collection_id: string; visible: boolean }>`
          select n.id resource_id,c.id collection_id,
            ((c.owner_subject_id=${input.actorSubjectId} or m.subject_id is not null)
             or (${sql.raw(buildPublicationBookmarkPublicAccessSql('n', 'c'))})) visible
          from nodes n join collections c on c.id=n.collection_id
          left join collection_members m on m.collection_id=c.id and m.subject_id=${input.actorSubjectId}
          where n.id=${input.resourceId} and n.deleted_at is null and c.deleted_at is null
          for share of n,c`.execute(transaction);
      const row = result.rows[0];
      return row?.visible ? { resourceType: input.resourceType, resourceId: row.resource_id,
        collectionId: row.collection_id } : null;
    } },
    progress: {
      async findForUpdate(input) {
        const result = await sql<ReadingProgressRow>`select account_id,resource_type,resource_id,status,
          progress::text progress,revision,completed_at,created_at,updated_at from reading_progress
          where account_id=${input.accountId} and resource_type=${input.resourceType} and resource_id=${input.resourceId}
          for update`.execute(transaction);
        return result.rows[0] ? mapRow(result.rows[0]) : null;
      },
      async insertOnly(input) {
        const result = await sql<ReadingProgressRow>`insert into reading_progress(account_id,resource_type,resource_id,
          status,progress,revision,completed_at,created_at,updated_at)
          values (${input.accountId},${input.resourceType},${input.resourceId},${input.status},${input.progress.toFixed(5)}::numeric,1,
            case when ${input.status}='completed' then ${input.at}::timestamptz else null end,${input.at},${input.at})
          on conflict (account_id,resource_type,resource_id) do nothing
          returning account_id,resource_type,resource_id,status,progress::text progress,revision,completed_at,created_at,updated_at`.execute(transaction);
        if (result.rows[0]) await fault?.afterPhase?.({ phase: 'resource' });
        return result.rows[0] ? mapRow(result.rows[0]) : null;
      },
      async upsert(input) {
        const result = await sql<ReadingProgressRow & { inserted: boolean }>`
          insert into reading_progress(account_id,resource_type,resource_id,status,progress,revision,
            completed_at,created_at,updated_at)
          values (${input.accountId},${input.resourceType},${input.resourceId},${input.status},
            ${input.progress.toFixed(5)}::numeric,1,
            case when ${input.status}='completed' then ${input.at}::timestamptz else null end,
            ${input.at},${input.at})
          on conflict (account_id,resource_type,resource_id) do update set
            status=excluded.status,
            progress=excluded.progress,
            revision=reading_progress.revision+1,
            completed_at=case when excluded.status='completed'
              then coalesce(reading_progress.completed_at,excluded.completed_at) else null end,
            updated_at=excluded.updated_at
          returning account_id,resource_type,resource_id,status,progress::text progress,revision,
            completed_at,created_at,updated_at,(xmax=0) inserted`.execute(transaction);
        const row = result.rows[0];
        if (!row) throw new Error('reading progress upsert did not return authority facts');
        await fault?.afterPhase?.({ phase: 'resource' });
        return { record: mapRow(row), inserted: row.inserted };
      },
      async reset(input) {
        const result = await sql<ReadingProgressRow>`delete from reading_progress
          where account_id=${input.accountId} and resource_type=${input.resourceType}
            and resource_id=${input.resourceId}
          returning account_id,resource_type,resource_id,status,progress::text progress,revision,
            completed_at,created_at,updated_at`.execute(transaction);
        await fault?.afterPhase?.({ phase: 'resource' });
        return result.rows[0] ? mapRow(result.rows[0]) : null;
      },
    },
    audit: { async append(event) {
      await appendAuditEvent(transaction, { operationId: null, collectionId: null,
        principalId: event.principalId, eventType: event.eventType,
        details: { accountId: event.accountId, resourceType: event.resourceType,
          ...(event.status ? { status: event.status } : {}) }, createdAt: event.createdAt });
      await fault?.afterPhase?.({ phase: 'audit' });
    } },
    clock: { async now() {
      // Padded to the millisecond the API serializes. The pagination cursor
      // carries milliseconds only, so a sub-millisecond timestamp can never be
      // addressed by a later page: `saved_at < cursor` and `saved_at = cursor`
      // are both false for it, and the row is skipped forever.
      return (await sql<{ now: Date }>`select date_trunc('milliseconds', current_timestamp) now`
        .execute(transaction)).rows[0]!.now;
    } },
  };
}

export function createPostgresReadingProgressUnitOfWork(db: Kysely<DatabaseSchema>,
  options: PostgresReadingProgressUnitOfWorkOptions = {}): PostgresReadingProgressUnitOfWork {
  return { execute: (work, request) => createUnitOfWork(db, {
    ...(request?.signal ? { signal: request.signal } : {}),
    ...(options.cancelBackend ? { cancelBackend: options.cancelBackend } : {}),
  }).execute(({ transaction }) => work(portsFor(transaction, options.faultInjector))) };
}
