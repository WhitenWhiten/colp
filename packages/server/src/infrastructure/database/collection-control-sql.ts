/** Discovery (Explore/search/directory/sitemap/profile): delist or hide_public. */
export const COLLECTION_DISCOVERY_CONTROL_SQL = `not exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'collection'
     and ma.target_id = c.id
     and ma.state = 'active'
     and ma.action in ('delist', 'hide_public')
)`;

/** Explore discovery delist exclusion on `c.id`. After #21 Explore keeps a
    hide_public row as an inert tombstone (flagged with the hide_public
    exists helper) instead of excluding it, so only delist still filters. */
export const COLLECTION_DELIST_CONTROL_SQL = `not exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'collection'
     and ma.target_id = c.id
     and ma.state = 'active'
     and ma.action = 'delist'
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
 * Displayed public node count (`collections` alias): raw `live_node_count`
 * minus distinct live bookmark nodes that have an active hide_public.
 * Duplicate moderation rows stay audit facts and are not counted twice.
 * Soft-deleted nodes are already out of `live_node_count` and are not
 * subtracted again. The root stays in `live_node_count`; this expression
 * does not remove it. Links ordering must keep using raw `live_node_count`,
 * not this display count.
 */
export function collectionVisibleNodeCountSql(alias = 'collection'): string {
  return `(${alias}.live_node_count - coalesce((
    select count(*)::int
      from nodes n
     where n.collection_id = ${alias}.id
       and n.deleted_at is null
       and n.is_root = false
       and n.kind = 'bookmark'
       and exists (
         select 1 from moderation_actions ma
          where ma.target_kind = 'bookmark'
            and ma.target_id = n.id
            and ma.parent_id = ${alias}.id
            and ma.state = 'active'
            and ma.action = 'hide_public'
       )
  ), 0))`;
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

/** Public digest directory/sitemap: delist or hide_public on the series. */
export const DIGEST_SERIES_DISCOVERY_CONTROL_SQL = `not exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'digest_series'
     and ma.target_id = digest_series.id
     and ma.state = 'active'
     and ma.action in ('delist', 'hide_public')
)`;

/** Follower-derived digest rows that stay listed: hide_public on the series
    selected as a flag instead of filtered out, so the row can render as an
    inert tombstone (#21). */
export function digestSeriesHidePublicExistsSql(seriesIdSql: string): string {
  return `exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'digest_series'
     and ma.target_id = ${seriesIdSql}
     and ma.state = 'active'
     and ma.action = 'hide_public'
)`;
}

/** Follower/public derived digest output: hide_public on this edition. */
export function digestEditionHidePublicExistsSql(editionIdSql: string, seriesIdSql: string): string {
  return `exists (
  select 1 from moderation_actions ma
   where ma.target_kind = 'digest_edition'
     and ma.target_id = ${editionIdSql}
     and ma.parent_id = ${seriesIdSql}
     and ma.state = 'active'
     and ma.action = 'hide_public'
)`;
}

/** Official account restrict_interaction — compose with account status on the same write lock. */
export function accountRestrictInteractionExistsSql(accountIdSql: string): string {
  return accountRestrictExistsSql(accountIdSql, 'restrict_interaction');
}

/** Official account restrict_publication — public profile/avatar/feed/directory. */
export function accountRestrictPublicationExistsSql(accountIdSql: string): string {
  return accountRestrictExistsSql(accountIdSql, 'restrict_publication');
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
