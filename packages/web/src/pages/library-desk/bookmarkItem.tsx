import type { CollectionKind } from '../../api'
import { BookmarkIcon } from '../../components/BookmarkIcon'
import type { ResourceListItem } from '../../components/ResourceList'
import { bookmarkIconSrc } from '../../lib/bookmarkIcon'
import { formatDate } from '../../lib/formatDate'
import { hostInitial, hostOf, type BookmarkNode } from '../../lib/libraryTree'
import {
  resourceDetailPath,
  resourcePrimaryTarget,
  type ResourceWorkspaceQuery,
} from '../../lib/useResourceNode'

export const KIND_LABEL: Record<CollectionKind, string> = {
  bookmarks: 'Bookmarks',
  reading_path: 'Reading path',
  knowledge_collection: 'Knowledge collection',
  mixed: 'Mixed',
}

export function libraryBookmarkItem(
  node: BookmarkNode,
  folder: string,
  collectionId: string,
  publicationSlug: string | null,
  publicOnly = false,
): ResourceListItem {
  const host = hostOf(node.url)
  const query: ResourceWorkspaceQuery = {
    ...(!publicOnly ? { collectionId } : {}),
    subjectType: 'node',
    slug: publicationSlug,
  }
  const primary = resourcePrimaryTarget(node.id, node.url, query)
  return {
    id: node.id,
    title: node.title,
    host,
    mid: folder || undefined,
    // Followed collections come from the public snapshot, which carries no
    // per-node timestamps; the row simply renders without a date.
    ...(node.updatedAt ? { date: formatDate(node.updatedAt), dateTime: node.updatedAt } : {}),
    description: node.description,
    ...(node.pinned ? { pinned: true } : {}),
    ...(primary.kind === 'internal' ? { to: primary.to } : { href: primary.href }),
    detailTo: resourceDetailPath(node.id, query),
    mark: (
      <BookmarkIcon
        icon={bookmarkIconSrc({
          iconUrl: node.iconUrl,
          pageUrl: node.url,
          // The private library never hotlinks third-party favicon CDNs:
          // the tree is account-private and a CDN request would leak its
          // hosts. Public collection pages opt in per collection's own
          // faviconCdnAllowed. Pinned by LibraryDesk.bookmark-icon.test.
          faviconCdnAllowed: false,
        })}
        className="library-host-favicon"
        letter={<span className="library-host-letter" data-testid="library-host-letter" aria-hidden>{hostInitial(host)}</span>}
      />
    ),
  }
}
