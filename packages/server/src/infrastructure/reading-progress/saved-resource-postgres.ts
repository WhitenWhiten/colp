import { sql, type Kysely } from 'kysely';
import type { SavedResourceCommandPorts, SavedResourceRecord,
  SavedResourceType } from '../../modules/reading-progress/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import { createUnitOfWork, type DatabaseTransaction, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import {
  buildPublicationBookmarkPublicAccessSql,
  buildPublicationCollectionPublicAccessSql,
} from '../publication/target-access-facts.js';
import type { DatabaseSchema } from '../database/runtime.js';

export type SavedResourceWritePhase = 'receipt' | 'resource' | 'audit' | 'complete';
export interface SavedResourceFaultContext { readonly phase: SavedResourceWritePhase; }
export interface SavedResourceFaultInjector {
  afterPhase?(context: SavedResourceFaultContext): void | Promise<void>;
}
export interface PostgresSavedResourceUnitOfWorkOptions {
  readonly faultInjector?: SavedResourceFaultInjector;
  readonly cancelBackend?: UnitOfWorkOptions['cancelBackend'];
}
export interface PostgresSavedResourceUnitOfWork {
  execute<Result>(
    work: (ports: SavedResourceCommandPorts) => Promise<Result>,
    request?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

function mapRow(row: { id: bigint; account_id: string; resource_type: string; resource_id: string;
  saved_at: Date; updated_at: Date; deleted_at: Date | null }): SavedResourceRecord {
  return { id: String(row.id), accountId: row.account_id, resourceType: row.resource_type as SavedResourceType,
    resourceId: row.resource_id, savedAt: row.saved_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
}

function portsFor(transaction: DatabaseTransaction, fault?: SavedResourceFaultInjector): SavedResourceCommandPorts {
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
          select c.id resource_id, c.id collection_id,
            (c.owner_subject_id=${input.actorSubjectId} or m.subject_id is not null
             or (${sql.raw(buildPublicationCollectionPublicAccessSql('c'))})) visible
          from collections c left join collection_members m
            on m.collection_id=c.id and m.subject_id=${input.actorSubjectId}
          where c.id=${input.resourceId} and c.deleted_at is null for share of c`.execute(transaction)
        : await sql<{ resource_id: string; collection_id: string; visible: boolean }>`
          select n.id resource_id, c.id collection_id,
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
    savedResources: {
      async findLive(input) {
        const row = await transaction.selectFrom('saved_resources').selectAll()
          .where('account_id', '=', input.accountId).where('resource_type', '=', input.resourceType)
          .where('resource_id', '=', input.resourceId).where('deleted_at', 'is', null).executeTakeFirst();
        return row ? mapRow(row) : null;
      },
      async insertLive(input) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const inserted = await transaction.insertInto('saved_resources').values({ account_id: input.accountId,
            resource_type: input.resourceType, resource_id: input.resourceId, saved_at: input.at,
            updated_at: input.at, deleted_at: null }).onConflict((oc) => oc.columns([
            'account_id','resource_type','resource_id',
          ]).where('deleted_at', 'is', null).doNothing()).returningAll().executeTakeFirst();
          const row = inserted ?? await transaction.selectFrom('saved_resources').selectAll()
            .where('account_id', '=', input.accountId).where('resource_type', '=', input.resourceType)
            .where('resource_id', '=', input.resourceId).where('deleted_at', 'is', null).executeTakeFirst();
          if (row) {
            await fault?.afterPhase?.({ phase: 'resource' });
            return { record: mapRow(row), inserted: inserted !== undefined };
          }
        }
        throw new Error('saved resource live-key contention did not converge');
      },
      async softDelete(input) {
        const row = await transaction.updateTable('saved_resources').set({ updated_at: input.at, deleted_at: input.at })
          .where('account_id', '=', input.accountId).where('resource_type', '=', input.resourceType)
          .where('resource_id', '=', input.resourceId).where('deleted_at', 'is', null)
          .returningAll().executeTakeFirst();
        await fault?.afterPhase?.({ phase: 'resource' });
        return row ? mapRow(row) : null;
      },
    },
    audit: { async append(event) {
      await appendAuditEvent(transaction, { operationId: null, collectionId: null,
        principalId: event.principalId, eventType: event.eventType,
        details: { accountId: event.accountId, resourceType: event.resourceType, changed: event.changed },
        createdAt: event.createdAt });
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

export function createPostgresSavedResourceUnitOfWork(db: Kysely<DatabaseSchema>,
  options: PostgresSavedResourceUnitOfWorkOptions = {}): PostgresSavedResourceUnitOfWork {
  return { execute: (work, request) => createUnitOfWork(db, {
    ...(request?.signal ? { signal: request.signal } : {}),
    ...(options.cancelBackend ? { cancelBackend: options.cancelBackend } : {}),
  }).execute(({ transaction }) => work(portsFor(transaction, options.faultInjector))) };
}
