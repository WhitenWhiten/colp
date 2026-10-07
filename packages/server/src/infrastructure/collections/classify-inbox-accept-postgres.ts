import { createClassificationEvidencePort } from './classification-evidence-postgres.js';
import { createClassificationVocabularyPort } from './classification-confirmation-postgres.js';
import { type Kysely } from 'kysely';
import {
  moveCollectionNode,
  type AcceptClassifyInboxItemPorts,
  type ClassifyInboxAcceptInsertResult,
  type ClassifyInboxAcceptSnapshot,
  type ClassifyInboxAcceptWritePort,
  type ClassifyInboxNodeKind,
} from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import { createClassificationCanonicalPorts } from './classification-canonical-ports.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';

function nodeKind(kind: string, isRoot: boolean): ClassifyInboxNodeKind {
  if (kind === 'bookmark') return 'bookmark';
  if (isRoot) return 'root';
  return 'folder';
}

export function createPostgresClassifyInboxAcceptWritePort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): ClassifyInboxAcceptWritePort {
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
          'n.parent_id',
          'n.resource_revision',
          'parent.kind as parent_kind',
          'parent.is_root as parent_is_root',
          'd.status as sidecar_status',
        ])
        .where('c.deleted_at', 'is', null)
        .where('c.owner_subject_id', '=', input.ownerSubjectId)
        .where('n.id', '=', input.nodeId)
        .executeTakeFirst();
      if (!row) return null;
      const snapshot: ClassifyInboxAcceptSnapshot = {
        nodeId: row.node_id,
        collectionId: row.collection_id,
        isOwner: true,
        kind: nodeKind(row.node_kind, row.node_is_root),
        softDeleted: row.node_deleted_at !== null,
        url: row.url ?? '',
        parentKind: row.parent_is_root === true
          ? 'root'
          : nodeKind(row.parent_kind ?? 'folder', false),
        parentId: row.parent_id,
        resourceRevision: row.resource_revision,
        sidecarStatus: row.sidecar_status === 'skipped' || row.sidecar_status === 'accepted'
          ? row.sidecar_status
          : null,
      };
      return snapshot;
    },
    async insertAccepted(input) {
      const inserted = await transaction.insertInto('collection_classify_inbox_decision')
        .values({
          node_id: input.nodeId,
          collection_id: input.collectionId,
          account_subject_id: input.accountSubjectId,
          status: 'accepted',
          suggestion_id: input.suggestionId,
          decided_at: input.decidedAt,
        })
        .onConflict((oc) => oc.column('node_id').doNothing())
        .returning('node_id')
        .executeTakeFirst();
      if (inserted) return 'inserted' satisfies ClassifyInboxAcceptInsertResult;
      const existing = await transaction.selectFrom('collection_classify_inbox_decision')
        .select('status')
        .where('node_id', '=', input.nodeId)
        .executeTakeFirst();
      if (existing?.status === 'accepted') return 'already_accepted';
      return 'blocked';
    },
  };
}

export function createPostgresClassifyInboxAcceptUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: { readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort } = {},
): {
  execute<Result>(
    work: (ports: AcceptClassifyInboxItemPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
} {
  return Object.freeze({
    execute<Result>(
      work: (ports: AcceptClassifyInboxItemPorts) => Promise<Result>,
    ): Promise<Result> {
      return createUnitOfWork(db, { isolationLevel: 'read committed' })
        .execute(({ transaction }) => {
          const collection = createClassificationCanonicalPorts(transaction, options);
          return work({
            evidence:createClassificationEvidencePort(transaction),receipts: collection.receipts,
            inbox: createPostgresClassifyInboxAcceptWritePort(transaction),
            clock: collection.clock,
            collection,
            move: moveCollectionNode,
            vocabulary: createClassificationVocabularyPort(transaction),
          });
        });
    },
  });
}
