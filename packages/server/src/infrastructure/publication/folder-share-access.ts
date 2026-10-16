import { accountRestrictPublicationExistsSql, collectionHidePublicControlSql,
  collectionOwnerLiveSql } from '../database/collection-control-sql.js';

/** Both link management and anonymous reads use the same publication controls. */
export function folderSharePublicationAllowedSql(collectionAlias: string): string {
  return `(${collectionOwnerLiveSql(`${collectionAlias}.owner_subject_id`)}
    AND ${collectionHidePublicControlSql(collectionAlias)}
    AND NOT EXISTS (SELECT 1 FROM accounts share_owner
      WHERE share_owner.subject_id = ${collectionAlias}.owner_subject_id
        AND ${accountRestrictPublicationExistsSql('share_owner.id')}))`;
}
