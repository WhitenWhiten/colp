/** Discovery (Explore/search/directory/sitemap/profile): delist or hide_public. */
export const COLLECTION_DISCOVERY_CONTROL_SQL = `not exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'collection'
     and ma.target_id = c.id
     and ma.state = 'active'
     and ma.action in ('delist', 'hide_public')
)`;

/** hide_public on this collection id. */
export function collectionHidePublicExistsSql(collectionIdSql: string): string {
  return `exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'collection'
     and ma.target_id = ${collectionIdSql}
     and ma.state = 'active'
     and ma.action = 'hide_public'
)`;
}

/** Follower/public derived output: hide_public only. `alias` is the collections table alias. */
export function collectionHidePublicControlSql(alias = 'collection'): string {
  return `not ${collectionHidePublicExistsSql(`${alias}.id`)}`;
}

/**
 * Count only nodes that can actually appear in an anonymous public
 * projection.  `live_node_count` is maintained for private owner views and
 * therefore includes private/protected descendants and nodes below a
 * restricted ancestor.  Reusing it in a public directory or cursor leaks
 * the size of unpublished parts of a collection.
 */
export function collectionPublicVisibleNodeCountSql(alias = 'collection'): string {
  const ancestorRestriction = buildPublicationTargetAncestorRestrictionSql('n');
  return `(select count(*)::int
             from nodes n
            where n.collection_id = ${alias}.id
              and n.deleted_at is null
              and n.visibility = 'inherit'
              and not ${ancestorRestriction}
              and not ${collectionHidePublicExistsSql(`${alias}.id`)}
              and not ${bookmarkHidePublicExistsSql('n.id', 'n.collection_id')})`;
}

/** Public snapshot/Reader/COLP: hide_public on this bookmark node. */
export function bookmarkHidePublicExistsSql(nodeIdSql: string, collectionIdSql: string): string {
  return `exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'bookmark'
     and ma.target_id = ${nodeIdSql}
     and ma.parent_id = ${collectionIdSql}
     and ma.state = 'active'
     and ma.action = 'hide_public'
)`;
}

/** Discovery (search): delist or hide_public on this bookmark node. */
export function bookmarkDiscoveryExistsSql(nodeIdSql: string, collectionIdSql: string): string {
  return `exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'bookmark'
     and ma.target_id = ${nodeIdSql}
     and ma.parent_id = ${collectionIdSql}
     and ma.state = 'active'
     and ma.action in ('delist', 'hide_public')
)`;
}

/** Official account restrict_publication — public profile/avatar/feed/directory. */
export function accountRestrictPublicationExistsSql(accountIdSql: string): string {
  return accountRestrictExistsSql(accountIdSql, 'restrict_publication');
}

/**
 * Owner lifecycle fence for every anonymous publication surface.
 *
 * `collections.owner_subject_id` is intentionally NOT a foreign key to
 * `accounts.subject_id` (phase1 schema; see also
 * 202609250100_library_sidebar_orders and search/collection-discovery-sql.ts),
 * so a missing owner row is a legal state and must not hide a collection. An
 * owner row that DOES exist and is disabled or soft-deleted ends publication:
 * the collection leaves Directory, Explore, Sitemap, Metadata and Snapshot.
 *
 * The predicate is a correlated scalar subquery on purpose. An `exists` /
 * `not exists` form is rewritten by the planner into a (hash) anti join, which
 * replaced the LIMIT-bounded ordered scan over
 * `collections_publication_directory_order_idx` with a sequential scan plus
 * Sort. A scalar SubPlan is evaluated per candidate row through the
 * `accounts.subject_id` unique index and keeps the page plan intact.
 * `accounts.subject_id` is UNIQUE, so the subquery yields at most one row and
 * `coalesce(..., true)` is the missing-owner default.
 */
export function collectionOwnerLiveSql(ownerSubjectIdSql: string): string {
  return `coalesce((
  select owner_account.status = 'active' and owner_account.deleted_at is null
    from accounts owner_account
   where owner_account.subject_id = ${ownerSubjectIdSql}
), true)`;
}

/** Owner lifecycle fence bound to the conventional `c` collection alias. */
export const COLLECTION_OWNER_LIVE_SQL = collectionOwnerLiveSql('c.owner_subject_id');

/** Shared account and collection controls for anonymous published objects. */
export function collectionPublicationAllowedSql(collectionAlias = 'c'): string {
  return `(${collectionOwnerLiveSql(`${collectionAlias}.owner_subject_id`)}
    AND ${collectionHidePublicControlSql(collectionAlias)}
    AND NOT EXISTS (SELECT 1 FROM accounts publication_owner
      WHERE publication_owner.subject_id = ${collectionAlias}.owner_subject_id
        AND ${accountRestrictPublicationExistsSql('publication_owner.id')}))`;
}

/**
 * Maximum parent walk used by every anonymous publication projection.  Keep
 * this SQL fragment in the database layer so low-level object and collection
 * readers do not import the higher publication infrastructure package.
 */
export const PUBLICATION_TARGET_ACCESS_MAX_DEPTH = 256;

/**
 * Effective public visibility for a node requires a complete, live ancestor
 * chain. The target row itself is included so callers can use the same guard
 * for bookmarks and folders; callers that require inherited visibility should
 * additionally constrain the target's `visibility = 'inherit'`.
 */
export function buildPublicationTargetAncestorRestrictionSql(nodeAlias: string): string {
  return `exists (
    with recursive target_ancestors(collection_id,id,parent_id,visibility,deleted_at,path,depth,cycle) as (
      select ${nodeAlias}.collection_id,${nodeAlias}.id,${nodeAlias}.parent_id,
             ${nodeAlias}.visibility,${nodeAlias}.deleted_at,array[${nodeAlias}.id],1,false
      union all
      select parent.collection_id,parent.id,parent.parent_id,parent.visibility,parent.deleted_at,
             child.path || parent.id,child.depth+1,parent.id = any(child.path)
        from nodes parent join target_ancestors child on parent.id = child.parent_id
       where parent.collection_id = child.collection_id
         and not child.cycle and child.depth < ${PUBLICATION_TARGET_ACCESS_MAX_DEPTH}
    )
    select 1 from target_ancestors
     where deleted_at is not null
        or visibility in ('private','protected')
        or cycle
        or (depth = ${PUBLICATION_TARGET_ACCESS_MAX_DEPTH} and parent_id is not null)
        or (parent_id is not null and not exists (
              select 1 from nodes target_ancestor_parent
               where target_ancestor_parent.collection_id = target_ancestors.collection_id
                 and target_ancestor_parent.id = target_ancestors.parent_id
            ))
  )`;
}

function accountRestrictExistsSql(
  accountIdSql: string,
  action: 'restrict_interaction' | 'restrict_publication',
): string {
  return `exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'account'
     and ma.target_id = ${accountIdSql}
     and ma.state = 'active'
     and ma.action = '${action}'
)`;
}
