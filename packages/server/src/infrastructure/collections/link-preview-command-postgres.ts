/**
 * LP-05 link preview command unit of work: access facts, command receipts,
 * the bookmark/mode store and the preview read port share one transaction.
 */
import { CompiledQuery, sql, type Kysely } from 'kysely';
import type {
  BookmarkPreviewMode,
  LinkPreviewCommandPorts,
  LinkPreviewCommandStore,
  LinkPreviewCommandUnitOfWork,
} from '../../modules/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import { LINK_PREVIEW_ENQUEUE_SQL, linkPreviewEnqueueParams } from './link-preview-postgres.js';
import { createPostgresLinkPreviewReadPort } from './link-preview-read-postgres.js';

function createStore(transaction: DatabaseTransaction): LinkPreviewCommandStore {
  return {
    async loadBookmarks(collectionId, nodeIds) {
      if (nodeIds.length === 0) return [];
      const result = await sql<{ id: string; url: string; mode: BookmarkPreviewMode | null; revision: string | null }>`
        SELECT n.id, n.url, p.mode, p.revision::text AS revision
          FROM nodes n
          LEFT JOIN bookmark_preview_prefs p ON p.node_id = n.id
         WHERE n.collection_id = ${collectionId} AND n.id = ANY(${[...nodeIds]}::text[])
           AND n.kind = 'bookmark' AND n.deleted_at IS NULL AND n.url IS NOT NULL
      `.execute(transaction);
      return result.rows.map((row) => ({
        nodeId: row.id,
        url: row.url,
        mode: row.mode ?? 'auto',
        revision: BigInt(row.revision ?? '1'),
      }));
    },
    async enqueue(identities) {
      const params = linkPreviewEnqueueParams(identities);
      if (params === null) return 0;
      const result = await transaction.executeQuery(CompiledQuery.raw(LINK_PREVIEW_ENQUEUE_SQL, params));
      return Number(result.numAffectedRows ?? 0n);
    },
    async writeMode({ collectionId, nodeId, mode, expectedRevision }) {
      // No row is the virtual revision 1: the first write inserts revision 2;
      // later writes are a compare-and-set on the stored revision.
      const written = expectedRevision === 1n
        ? await sql<{ revision: string }>`
            INSERT INTO bookmark_preview_prefs (node_id, collection_id, mode, revision, updated_at)
            VALUES (${nodeId}, ${collectionId}, ${mode}, 2, clock_timestamp())
            ON CONFLICT (node_id) DO NOTHING
            RETURNING revision::text AS revision
          `.execute(transaction)
        : await sql<{ revision: string }>`
            UPDATE bookmark_preview_prefs
               SET mode = ${mode}, revision = revision + 1, updated_at = clock_timestamp()
             WHERE node_id = ${nodeId} AND revision = ${expectedRevision.toString()}::bigint
            RETURNING revision::text AS revision
          `.execute(transaction);
      const revision = written.rows[0]?.revision;
      if (revision !== undefined) return { kind: 'written', revision: BigInt(revision) };
      const current = await sql<{ revision: string }>`
        SELECT revision::text AS revision FROM bookmark_preview_prefs WHERE node_id = ${nodeId}
      `.execute(transaction);
      return { kind: 'stale', currentRevision: BigInt(current.rows[0]?.revision ?? '1') };
    },
  };
}

export function createPostgresLinkPreviewCommandUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: { readonly productOrigin?: string } = {},
): LinkPreviewCommandUnitOfWork {
  return Object.freeze({
    execute<Result>(work: (ports: LinkPreviewCommandPorts) => Promise<Result>): Promise<Result> {
      return createUnitOfWork(db, { isolationLevel: 'read committed' }).execute(({ transaction }) => work({
        accessPolicy: createPostgresAccessPolicyFactsPort(transaction),
        receipts: createPostgresProductCommandReceiptPort(transaction),
        previews: createStore(transaction),
        reads: createPostgresLinkPreviewReadPort(transaction),
        ...(options.productOrigin === undefined ? {} : { productOrigin: options.productOrigin }),
      }));
    },
  });
}
