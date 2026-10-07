import { COLLECTION_DISCOVERY_CONTROL_SQL, accountRestrictPublicationExistsSql } from '../database/collection-control-sql.js';

/** Shared public discovery eligibility for recall and authoritative recheck.
 * Private owner/member access is evaluated separately by each caller.
 *
 * `collections.owner_subject_id` is intentionally NOT a foreign key to
 * `accounts.subject_id` (phase1 schema; documented again in
 * 202609250100_library_sidebar_orders), so a missing owner row is a legal state
 * and is not evidence that the owner was deactivated. A mandatory `exists` on an
 * active account silently dropped legitimate public content from anonymous
 * discovery. An owner row that DOES exist and is non-active, soft-deleted or
 * publication-restricted still delists the collection. */
export function searchCollectionDiscoverySql(alias: string): string {
  return `(${COLLECTION_DISCOVERY_CONTROL_SQL.replaceAll('c.id', `${alias}.id`)}
    and not exists (select 1 from accounts discovery_owner
      where discovery_owner.subject_id=${alias}.owner_subject_id
        and (discovery_owner.status<>'active' or discovery_owner.deleted_at is not null
          or ${accountRestrictPublicationExistsSql('discovery_owner.id')})))`;
}
