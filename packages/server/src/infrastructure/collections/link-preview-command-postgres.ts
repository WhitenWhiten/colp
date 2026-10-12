/**
 * LP-05 link preview command unit of work: access facts, command receipts and
 * the bookmark/enqueue store share one transaction.
 */
import { CompiledQuery, sql, type Kysely } from 'kysely';
import type {
  BookmarkPreviewMode,
  LinkPreviewCommandPorts,
  LinkPreviewCommandStore,
  LinkPreviewCommandUnitOfWork,
} from '../../modules/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/repositories.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import { LINK_PREVIEW_ENQUEUE_SQL, linkPreviewEnqueueParams } from './link-preview-postgres.js';

function createStore(transaction: DatabaseTransaction): LinkPreviewCommandStore {
  return {
    async loadBookmarks(collectionId, nodeIds) {
      if (nodeIds.length === 0) return [];
      const result = await sql<{ id: string; url: string; mode: BookmarkPreviewMode | null }>`
        SELECT n.id, n.url, p.mode
          FROM nodes n
          LEFT JOIN bookmark_preview_prefs p ON p.node_id = n.id
         WHERE n.collection_id = ${collectionId} AND n.id = ANY(${[...nodeIds]}::text[])
           AND n.kind = 'bookmark' AND n.deleted_at IS NULL AND n.url IS NOT NULL
      `.execute(transaction);
      return result.rows.map((row) => ({ nodeId: row.id, url: row.url, mode: row.mode ?? 'auto' }));
    },
    async enqueue(identities) {
      const params = linkPreviewEnqueueParams(identities);
      if (params === null) return 0;
      const result = await transaction.executeQuery(CompiledQuery.raw(LINK_PREVIEW_ENQUEUE_SQL, params));
      return Number(result.numAffectedRows ?? 0n);
    },
  };
}

export function createPostgresLinkPreviewCommandUnitOfWork(db: Kysely<DatabaseSchema>): LinkPreviewCommandUnitOfWork {
  return Object.freeze({
    execute<Result>(work: (ports: LinkPreviewCommandPorts) => Promise<Result>): Promise<Result> {
      return createUnitOfWork(db, { isolationLevel: 'read committed' }).execute(({ transaction }) => work({
        accessPolicy: createPostgresAccessPolicyFactsPort(transaction),
        receipts: createPostgresProductCommandReceiptPort(transaction),
        previews: createStore(transaction),
      }));
    },
  });
}
