import { folderSharePublicationAllowedSql } from './folder-share-access.js';
import { buildPublicationTargetAncestorRestrictionSql } from '../database/collection-control-sql.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { FolderShareError, type FolderShareUnitOfWork, type FolderShareView } from '../../modules/publication/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { appendAuditEvent } from '../database/audit-event-payload.js';

export function createPostgresFolderShareUnitOfWork(db: Kysely<DatabaseSchema>, options: { newSlug?: () => string } = {}): FolderShareUnitOfWork {
  return { execute(work) { return createUnitOfWork(db).execute(async ({ transaction: tx }) => {
    let principalId: string | null = null;
    return work({
      receipts: createPostgresProductCommandReceiptPort(tx),
      async assertOwnerFolder(collectionId, nodeId, ownerSubjectId) {
        const collection = await tx.selectFrom('collections').select(['id', 'owner_subject_id', 'is_library', 'root_node_id'])
          .where('id', '=', collectionId).where('deleted_at', 'is', null).forUpdate().executeTakeFirst();
        if (!collection || collection.owner_subject_id !== ownerSubjectId) throw new FolderShareError('resource_not_found', 'Folder not found.');
        const account = await tx.selectFrom('accounts').select('id').where('subject_id', '=', ownerSubjectId)
          .where('status', '=', 'active').where('deleted_at', 'is', null).executeTakeFirst();
        if (!account) throw new FolderShareError('resource_not_found', 'Folder not found.');
        principalId = account.id;
        const node = await tx.selectFrom('nodes').select(['kind', 'is_root']).where('collection_id', '=', collectionId)
          .where('id', '=', nodeId).where('deleted_at', 'is', null).forUpdate().executeTakeFirst();
        if (!node) throw new FolderShareError('resource_not_found', 'Folder not found.');
        if (!collection.is_library || node.kind !== 'folder' || node.is_root) {
          throw new FolderShareError('invalid_document', 'Choose a folder inside your bookmark library to share.');
        }
        const visibility = await sql<{ folder_restricted: boolean; publication_allowed: boolean }>`
          SELECT ${sql.raw(buildPublicationTargetAncestorRestrictionSql('folder'))} AS folder_restricted,
            ${sql.raw(folderSharePublicationAllowedSql('c'))} AS publication_allowed
          FROM nodes folder JOIN collections c ON c.id = folder.collection_id
          WHERE folder.id = ${nodeId} AND c.id = ${collectionId}`.execute(tx);
        const facts = visibility.rows[0]!;
        return facts.folder_restricted ? 'folder_restricted' : facts.publication_allowed ? null : 'publication_restricted';
      },
      async findLive(collectionId, nodeId) {
        const result = await sql<ShareRow>`SELECT * FROM folder_shares
          WHERE collection_id = ${collectionId} AND node_id = ${nodeId} AND revoked_at IS NULL`.execute(tx);
        return result.rows[0] ? view(result.rows[0]) : null;
      },
      async create(collectionId, nodeId) {
        const id = randomUUID(), slug = options.newSlug?.() ?? `folder-${randomBytes(16).toString('hex')}`;
        try {
          const result = await sql<ShareRow>`INSERT INTO folder_shares(id, collection_id, node_id, slug)
            VALUES (${id}, ${collectionId}, ${nodeId}, ${slug}) RETURNING *`.execute(tx);
          await appendAuditEvent(tx, { operationId: null, collectionId: null, principalId, eventType: 'folder.share.created',
            details: { collectionId, nodeId, shareId: id }, createdAt: result.rows[0]!.created_at });
          return view(result.rows[0]!);
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
            throw new FolderShareError('publication_slug_conflict', 'That link address is already in use. Try again.');
          }
          throw error;
        }
      },
      async revoke(collectionId, nodeId) {
        const result = await sql<{ id: string; revoked_at: Date }>`UPDATE folder_shares SET revoked_at = now()
          WHERE collection_id = ${collectionId} AND node_id = ${nodeId} AND revoked_at IS NULL RETURNING id, revoked_at`.execute(tx);
        if (result.rows[0]) await appendAuditEvent(tx, { operationId: null, collectionId: null, principalId,
          eventType: 'folder.share.revoked', details: { collectionId, nodeId, shareId: result.rows[0].id }, createdAt: result.rows[0].revoked_at });
      },
    });
  }); } };
}
interface ShareRow { id: string; collection_id: string; node_id: string; slug: string; created_at: Date }
function view(row: ShareRow): FolderShareView {
  return { id: row.id, collectionId: row.collection_id, nodeId: row.node_id, slug: row.slug, createdAt: row.created_at.toISOString() };
}
