import { LIBRARY_REQUIRED_FOLDER_ROLES } from '../../modules/collections/index.js';
import { sql, type Kysely } from 'kysely';
import { createCanonicalMutationApplication } from '../../modules/collections/index.js';
import type { LibraryCollectionUnitOfWork } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { createPostgresAccessPolicyWritePort } from '../access-policy/index.js';
import { createPostgresCanonicalMutationPorts } from './canonical-mutation-postgres-ports.js';
import {
  createPostgresCollectionsClock, createPostgresIdLedgerPort, createPostgresCollectionWritePort,
  createPostgresNodeWritePort, createPostgresRevisionWritePort, createPostgresBootstrapOperationPort,
  createPostgresBootstrapAuditPort, createPostgresBootstrapOutboxPort,
} from './repositories.js';

export function createPostgresLibraryCollectionUnitOfWork(db: Kysely<DatabaseSchema>): LibraryCollectionUnitOfWork {
  const unitOfWork = createUnitOfWork(db);
  return {
    execute(owner, work) {
      return unitOfWork.execute(async ({ transaction }) => {
        // Same owner, same lock across workers. The partial unique index is the
        // storage authority even for writers outside this application path.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${owner.subjectId}, 13))`.execute(transaction);
        const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(transaction));
        return work({
          bootstrap: {
            clock: createPostgresCollectionsClock(transaction),
            idLedger: createPostgresIdLedgerPort(transaction),
            collections: createPostgresCollectionWritePort(transaction),
            nodes: createPostgresNodeWritePort(transaction),
            revisions: createPostgresRevisionWritePort(transaction),
            operations: createPostgresBootstrapOperationPort(transaction),
            audit: createPostgresBootstrapAuditPort(transaction),
            outbox: createPostgresBootstrapOutboxPort(transaction),
            accessPolicy: createPostgresAccessPolicyWritePort(transaction),
          },
          mutate: input => canonical.execute({ transaction }, input),
          async find(subjectId) {
            const row = await transaction.selectFrom('collections').select(['id', 'title', 'root_node_id'])
              .where('owner_subject_id', '=', subjectId).where('is_library', '=', true)
              .where('deleted_at', 'is', null).executeTakeFirst();
            if (!row) return null;
            const folders = await transaction.selectFrom('nodes').select(['id', 'folder_role'])
              .where('collection_id', '=', row.id).where('deleted_at', 'is', null)
              .where('folder_role', 'in', [...LIBRARY_REQUIRED_FOLDER_ROLES]).execute();
            const bookmarksBarId = folders.find(folder => folder.folder_role === 'bookmarks-bar')?.id;
            const otherBookmarksId = folders.find(folder => folder.folder_role === 'other-bookmarks')?.id;
            if (!bookmarksBarId || !otherBookmarksId) throw new Error('Library browser folders are missing.');
            return { id: row.id, title: row.title, rootNodeId: row.root_node_id,
              library: true, bookmarksBarId, otherBookmarksId };
          },
        });
      });
    },
  };
}
