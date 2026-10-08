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
  buildPublicationTargetAncestorRestrictionSql,
  bookmarkHidePublicExistsSql,
  collectionHidePublicExistsSql,
} from '../database/collection-control-sql.js';

export { buildPublicationTargetAncestorRestrictionSql } from '../database/collection-control-sql.js';

export { PUBLICATION_TARGET_ACCESS_MAX_DEPTH } from '../database/collection-control-sql.js';

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
