import { isProductApiError, type PublicProfileCollectionSummary, type PublicProfilePage } from '../../api'
import { formatDate } from '../../lib/formatDate'
import { readRouteCache } from '../../lib/routeCache'
import type {
  ActivityListState,
  FollowListState,
  ProfileMode,
  ProfileState,
  PublicProfileActivityItem,
} from './types'

export function profileCacheKey(handle: string) {
  return `public-profile:${handle}`
}

export function restoredProfile(handle: string): ProfileState {
  const value = readRouteCache<PublicProfilePage>(profileCacheKey(handle))
  return value === undefined ? { status: 'loading' } : { status: 'ready', value }
}

export function loadProfileMode(): ProfileMode {
  try {
    return window.localStorage.getItem('known.profileMode') === 'journal' ? 'journal' : 'profile'
  } catch {
    return 'profile'
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function isNotFound(error: unknown): boolean {
  return isProductApiError(error)
    && (error.status === 404 || error.code === 'resource_not_found')
}

/* R9-31: the monogram algorithm lives in lib/initials (the hover card shared
   an identical copy); re-exported so existing profile imports keep working. */
export { profileInitials } from '../../lib/initials'

export function kindLabel(kind: PublicProfileCollectionSummary['kind']): string {
  switch (kind) {
    case 'bookmarks': return 'Bookmarks'
    case 'reading_path': return 'Reading path'
    case 'knowledge_collection': return 'Knowledge collection'
    case 'mixed': return 'Mixed collection'
  }
}

export function formatProfileDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return formatDate(value)
}

export function followCountLabel(list: FollowListState): string | null {
  if (list.status !== 'ready' || list.nextCursor) return null
  return String(list.items.length)
}

export function emptyFollowList(status: FollowListState['status']): FollowListState {
  return { status, items: [], nextCursor: null, pagination: 'idle' }
}

export function emptyActivityList(status: ActivityListState['status']): ActivityListState {
  return { status, items: [], nextCursor: null, pagination: 'idle' }
}

export function nonEmptyString(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

export function activityItemHref(item: PublicProfileActivityItem): string | null {
  return nonEmptyString(item.publicationSlug)
    ? `/c/${encodeURIComponent(item.publicationSlug)}`
    : null
}

export function activityItemTitle(item: PublicProfileActivityItem): string {
  return nonEmptyString(item.collectionTitle)
    ? item.collectionTitle
    : 'Updated a public collection'
}

export function activityProfileState(
  list: ActivityListState,
): 'loading-activity' | 'empty-activity' | 'activity-error' | 'activity' {
  if (list.status === 'error') return 'activity-error'
  if (list.status === 'ready' && list.items.length === 0) return 'empty-activity'
  if (list.status === 'ready') return 'activity'
  return 'loading-activity'
}

export function collectionCountLabel(
  collectionsLength: number,
  hasMore: boolean,
): string | null {
  return hasMore ? null : String(collectionsLength)
}
