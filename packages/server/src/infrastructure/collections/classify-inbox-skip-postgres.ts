import { type Kysely } from 'kysely';
import type {
  ClassifyInboxNodeKind,
  ClassifyInboxSkipInsertResult,
  ClassifyInboxSkipSnapshot,
  ClassifyInboxSkipWritePort,
  SkipClassifyInboxItemPorts,
} from '../../modules/collections/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createPostgresCollectionsClock } from './repositories.js';

function nodeKind(kind: string, isRoot: boolean): ClassifyInboxNodeKind {
  if (kind === 'bookmark') return 'bookmark';
  if (isRoot) return 'root';
  return 'folder';
}

export function createPostgresClassifyInboxSkipWritePort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): ClassifyInboxSkipWritePort {
  return {
    async loadEligibilitySnapshot(input) {
      const row = await transaction.selectFrom('nodes as n')
        .innerJoin('collections as c', 'c.id', 'n.collection_id')
        .leftJoin('nodes as parent', 'parent.id', 'n.parent_id')
        .leftJoin('collection_classify_inbox_decision as d', 'd.node_id', 'n.id')
        .select([
          'n.id as node_id',
          'n.collection_id',
          'n.kind as node_kind',
          'n.is_root as node_is_root',
          'n.url',
          'n.deleted_at as node_deleted_at',
          'parent.kind as parent_kind',
          'parent.is_root as parent_is_root',
          'd.status as sidecar_status',
        ])
        .where('c.deleted_at', 'is', null)
        .where('c.owner_subject_id', '=', input.ownerSubjectId)
        .where('n.id', '=', input.nodeId)
        .executeTakeFirst();
      if (!row) return null;
      const snapshot: ClassifyInboxSkipSnapshot = {
        nodeId: row.node_id,
        collectionId: row.collection_id,
        isOwner: true,
        kind: nodeKind(row.node_kind, row.node_is_root),
        softDeleted: row.node_deleted_at !== null,
        url: row.url ?? '',
        parentKind: row.parent_is_root === true
          ? 'root'
          : nodeKind(row.parent_kind ?? 'folder', false),
        sidecarStatus: row.sidecar_status === 'skipped' || row.sidecar_status === 'accepted'
          ? row.sidecar_status
          : null,
      };
      return snapshot;
    },
    async insertSkipped(input) {
      const inserted = await transaction.insertInto('collection_classify_inbox_decision')
        .values({
          node_id: input.nodeId,
          collection_id: input.collectionId,
          account_subject_id: input.accountSubjectId,
          status: 'skipped',
          suggestion_id: null,
          decided_at: input.decidedAt,
        })
        .onConflict((oc) => oc.column('node_id').doNothing())
        .returning('node_id')
        .executeTakeFirst();
      if (inserted) return 'inserted' satisfies ClassifyInboxSkipInsertResult;
      const existing = await transaction.selectFrom('collection_classify_inbox_decision')
        .select('status')
        .where('node_id', '=', input.nodeId)
        .executeTakeFirst();
      if (existing?.status === 'skipped') return 'already_skipped';
      return 'blocked';
    },
  };
}

export function createPostgresClassifyInboxSkipUnitOfWork(
  db: Kysely<DatabaseSchema>,
): {
  execute<Result>(
    work: (ports: SkipClassifyInboxItemPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
} {
  return Object.freeze({
    execute<Result>(
      work: (ports: SkipClassifyInboxItemPorts) => Promise<Result>,
    ): Promise<Result> {
      return createUnitOfWork(db, { isolationLevel: 'read committed' })
        .execute(({ transaction }) => work({
          receipts: createPostgresProductCommandReceiptPort(transaction),
          inbox: createPostgresClassifyInboxSkipWritePort(transaction),
          clock: createPostgresCollectionsClock(transaction),
        }));
    },
  });
}
