import { sql, type Kysely } from 'kysely';
import type { ClassificationConfirmationUnitOfWork, ClassificationVocabularyPort } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import { createClassificationCanonicalPorts } from './classification-canonical-ports.js';

export function createClassificationVocabularyPort(tx: DatabaseTransaction): ClassificationVocabularyPort {
  return {async existingTags(collectionId,tags) {
    if (!tags.length) return [];
    const rows=await sql<{tag:string}>`SELECT DISTINCT t.tag FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(n.tags,'[]'::jsonb)) AS t(tag)
      WHERE n.collection_id=${collectionId} AND n.deleted_at IS NULL AND n.kind='bookmark' AND NOT n.is_root
        AND t.tag IN (${sql.join(tags.map(tag=>sql`${tag}`))})`.execute(tx);
    return rows.rows.map(row=>row.tag);
  }};
}
export function createPostgresClassificationConfirmationUnitOfWork(db:Kysely<DatabaseSchema>,
  options: Pick<UnitOfWorkOptions,'faultInjector'> & {readonly reportSourceInvalidation?:ReportSourceInvalidationOutboxPort} = {}):ClassificationConfirmationUnitOfWork {
  return {execute:work=>createUnitOfWork(db,{isolationLevel:'read committed',faultInjector:options.faultInjector}).execute(({transaction})=>
    work({collection:createClassificationCanonicalPorts(transaction,options),vocabulary:createClassificationVocabularyPort(transaction)}))};
}
