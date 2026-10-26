import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema, DatabaseTransaction } from '../database/index.js';
import { createUnitOfWork, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { createPostgresCollectionWritePort } from './repositories.js';
import { createDatabaseImageStore } from './image-database-store.js';
import { createPostgresImagePublicAccess } from './image-public-access.js';
import type { CoverMode, NodeCoverPreference, NodeCoverCommandUnitOfWork, NodeCoverStore } from '../../modules/collections/index.js';

export async function readNodeCoverPreferences(
  db: Kysely<DatabaseSchema> | DatabaseTransaction, ids: readonly string[],
): Promise<ReadonlyMap<string, NodeCoverPreference>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ node_id: string; mode: CoverMode; revision: string;
    object_id: string | null; width: number | null; height: number | null }>`
    SELECT p.node_id, p.mode, p.revision::text, a.object_id, a.width, a.height
      FROM node_cover_prefs p
      JOIN nodes n ON n.id = p.node_id AND n.collection_id = p.collection_id
      LEFT JOIN image_assets a ON a.object_id = p.asset_id AND a.collection_id = p.collection_id
     WHERE p.node_id = ANY(${[...ids]}::text[])
  `.execute(db);
  return new Map(rows.rows.map(row => [row.node_id, { mode: row.mode, revision: row.revision,
    image: row.object_id === null ? null : { objectId: row.object_id, width: row.width!, height: row.height! } }]));
}

function createStore(transaction: DatabaseTransaction): NodeCoverStore {
  return {
    async upload(input) {
      await sql`INSERT INTO image_assets (object_id, collection_id, created_by_subject_id, storage_backend,
        storage_key, mime, width, height, byte_size, digest)
        VALUES (${input.objectId}::uuid, ${input.collectionId}, ${input.subjectId}, 'database',
          ${input.objectId}, ${input.mime}, ${input.width}, ${input.height}, ${input.body.byteLength}, ${input.digest})
      `.execute(transaction);
      await createDatabaseImageStore(transaction).put(input.objectId, input.body, input.mime);
    },
    async findAsset(collectionId, assetId) {
      const result = await sql<{ object_id: string; width: number; height: number }>`
        SELECT object_id, width, height FROM image_assets
         WHERE object_id = ${assetId}::uuid AND collection_id = ${collectionId}
      `.execute(transaction);
      const row = result.rows[0];
      return row ? { objectId: row.object_id, width: row.width, height: row.height } : null;
    },
    async findNode(collectionId, nodeId) {
      const result = await transaction.selectFrom('nodes').select('id')
        .where('id', '=', nodeId).where('collection_id', '=', collectionId)
        .where('deleted_at', 'is', null).where('kind', 'in', ['bookmark', 'folder']).executeTakeFirst();
      return result !== undefined;
    },
    async read(nodeId) {
      return (await readNodeCoverPreferences(transaction, [nodeId])).get(nodeId)
        ?? { mode: 'auto', revision: '0', image: null };
    },
    async write(input) {
      await sql`INSERT INTO node_cover_prefs (node_id, collection_id, mode, asset_id)
        VALUES (${input.nodeId}, ${input.collectionId}, ${input.mode}, ${input.assetId}::uuid)
        ON CONFLICT (node_id) DO UPDATE SET mode = EXCLUDED.mode, asset_id = EXCLUDED.asset_id,
          collection_id = EXCLUDED.collection_id, revision = node_cover_prefs.revision + 1,
          updated_at = clock_timestamp()
      `.execute(transaction);
      return (await readNodeCoverPreferences(transaction, [input.nodeId])).get(input.nodeId)!;
    },
  };
}

export function createPostgresNodeCoverCommandUnitOfWork(db: Kysely<DatabaseSchema>): NodeCoverCommandUnitOfWork {
  return { execute: work => createUnitOfWork(db).execute(({ transaction }) => work({
    accessPolicy: createPostgresAccessPolicyFactsPort(transaction),
    collections: createPostgresCollectionWritePort(transaction),
    receipts: createPostgresProductCommandReceiptPort(transaction), covers: createStore(transaction),
  })) };
}

export function createPostgresCoverImages(db: Kysely<DatabaseSchema>, options: Pick<UnitOfWorkOptions, 'cancelBackend'> = {}) {
  return { store: createDatabaseImageStore(db), publicAccess: createPostgresImagePublicAccess(db, options),
    commands: createPostgresNodeCoverCommandUnitOfWork(db) };
}
