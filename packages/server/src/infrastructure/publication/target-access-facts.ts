/**
 * Publication target access facts shared by the Reading Progress / Saved
 * Resource write and hydrate paths (PUB-R02).
 *
 * The node ancestor restriction below is the same recursive fact the
 * Publication Snapshot projection computes (`ancestor_restricted` in
 * postgres-snapshot-read.ts), hardened with the guards the Search authority
 * walk applies (postgres-search-authority.ts): a non-member is concealed from
 * any target whose ancestor chain contains a private/protected or deleted
 * ancestor, dangles, cycles, or exceeds the maximum walk depth. Owner/member
 * access is decided by the caller's own collection predicates and is
 * unaffected by this fact.
 *
 * The fragment is a correlated subquery over the outer node row (referenced
 * through `nodeAlias`), so it must be embedded in a query scope where that
 * alias resolves to the `nodes` row of the target.
 */
import {
  bookmarkHidePublicExistsSql,
  collectionHidePublicExistsSql,
} from '../database/collection-control-sql.js';

export const PUBLICATION_TARGET_ACCESS_MAX_DEPTH = 256;

/**
 * Public collection access is separate from owner/member management access.
 * Callers must keep their owner/member branch ahead of this fragment so an
 * active hide_public action never removes management access.
 */
export function buildPublicationCollectionPublicAccessSql(collectionAlias = 'c'): string {
  return `${collectionAlias}.visibility in ('public','unlisted')
    and not ${collectionHidePublicExistsSql(`${collectionAlias}.id`)}`;
}

/**
 * Public bookmark access is gated by both its collection and its own active
 * hide_public actions. The ancestor restriction is shared here as well so
 * write and hydrate paths cannot drift apart.
 */
export function buildPublicationBookmarkPublicAccessSql(
  nodeAlias = 'n',
  collectionAlias = 'c',
): string {
  return `${buildPublicationCollectionPublicAccessSql(collectionAlias)}
    and ${nodeAlias}.visibility = 'inherit'
    and not ${bookmarkHidePublicExistsSql(`${nodeAlias}.id`, `${collectionAlias}.id`)}
    and not ${buildPublicationTargetAncestorRestrictionSql(nodeAlias)}`;
}

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
