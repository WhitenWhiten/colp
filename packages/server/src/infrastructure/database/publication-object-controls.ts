import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from './runtime.js';
import {
  accountRestrictPublicationExistsSql,
  buildPublicationTargetAncestorRestrictionSql,
} from './collection-control-sql.js';

const UUID_OBJECT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** restrict_publication still blocks avatar objects after the governance module is gone. */
export async function isAvatarPublicationRestricted(
  db: Kysely<DatabaseSchema>,
  objectId: string,
): Promise<boolean> {
  if (!UUID_OBJECT_PATTERN.test(objectId)) return false;
  const result = await sql<{ hidden: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM profiles p
        JOIN moderation_actions ma
          ON ma.target_kind = 'account'
         AND ma.target_id = p.account_id
         AND ma.state = 'active'
         AND ma.action = 'restrict_publication'
       WHERE p.avatar_url IS NOT NULL
         AND lower(p.avatar_url) LIKE '%/api/v1/avatar/' || lower(${objectId})
      UNION
      SELECT 1
        FROM avatar_objects ao
        JOIN moderation_actions ma
          ON ma.target_kind = 'account'
         AND ma.target_id = ao.account_id
         AND ma.state = 'active'
         AND ma.action = 'restrict_publication'
       WHERE ao.object_id = ${objectId}::uuid
    ) AS hidden
  `.execute(db);
  return result.rows[0]?.hidden === true;
}
