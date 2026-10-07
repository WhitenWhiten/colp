import type { FeedItem } from '../api/types'

function nonEmptyString(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

export function feedItemCanonicalPath(item: FeedItem): string {
  if (item.kind === 'collection_change' && nonEmptyString(item.publicationSlug)) {
    return `/c/${encodeURIComponent(item.publicationSlug)}`
  }
  return `/u/${encodeURIComponent(item.actor.handle)}`
}

export function itemTitle(item: FeedItem): string {
  if (item.kind === 'collection_change') {
    return nonEmptyString(item.collectionTitle)
      ? `${item.actor.displayName} updated ${item.collectionTitle}`
      : `${item.actor.displayName} updated a public collection`
  }
  // A follow_activity row is delivered to the followed profile: the actor followed you.
  return `${item.actor.displayName} followed your work`
}

export function itemBody(item: FeedItem): string | null {
  return item.kind === 'collection_change' && item.summary === 'public_collection_updated'
    ? 'Resources or path order changed in this public collection.'
    : null
}
